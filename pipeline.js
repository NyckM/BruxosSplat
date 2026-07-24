// pipeline.js — vídeos → frames (ffmpeg) → alinhamento (COLMAP) → treino 3DGS (Brush) → .ply
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(exe, args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { cwd, windowsHide: true });
    const feed = d => d.toString().split(/\r?\n/).forEach(l => l.trim() && onLine(l.trim()));
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(exe)} saiu com código ${code}`)));
  });
}

/**
 * Etapa 1+2: frames + alinhamento de câmeras.
 * opts: { videos:[{path,start,end,interval}], workDir, maxSize }
 */
async function prepareDataset(tools, opts, report, onPreview) {
  const work = opts.workDir;
  const imagesDir = path.join(work, 'images');
  const sparseDir = path.join(work, 'sparse');
  const dbPath = path.join(work, 'database.db');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.mkdirSync(sparseDir, { recursive: true });

  // 1) Frames de cada vídeo
  let vi = 0;
  for (const v of opts.videos) {
    vi++;
    report('frames', `Extraindo frames (${vi}/${opts.videos.length}): ${path.basename(v.path)}…`);
    const args = [];
    if (v.start) args.push('-ss', v.start);
    if (v.end) args.push('-to', v.end);
    const interval = Math.max(0.05, parseFloat(v.interval) || 0.5);
    args.push('-i', v.path,
      '-vf', `fps=1/${interval},scale='min(${opts.maxSize},iw)':-2`,
      '-q:v', '2',
      path.join(imagesDir, `v${vi}_%05d.jpg`));
    await run(tools.ffmpeg, args, work, l => report('frames', l));
  }
  const nFrames = fs.readdirSync(imagesDir).length;
  if (nFrames < 10) throw new Error('Poucos frames extraídos (' + nFrames + '). Diminua o intervalo de tempo ou use vídeos mais longos.');
  report('frames', `${nFrames} frames extraídos no total.`);

  // 2) Alinhamento de câmeras (COLMAP automatic_reconstructor: mais robusto p/ vídeo)
  report('colmap', 'Alinhando câmeras (COLMAP, modo vídeo)…');
  await run(tools.colmap, ['automatic_reconstructor',
    '--workspace_path', work,
    '--image_path', imagesDir,
    '--data_type', 'video',
    '--quality', 'high',
    '--single_camera', '1',
    '--camera_model', 'OPENCV',
    '--sparse', '1',
    '--dense', '0'
  ], work, l => report('colmap', l));
  if (!fs.existsSync(path.join(sparseDir, '0'))) throw new Error('COLMAP não conseguiu alinhar as câmeras. Grave mais devagar, com boa luz e sobreposição entre os vídeos.');

  // Preview: nuvem esparsa + poses
  try {
    const model = path.join(sparseDir, '0');
    const pointsPly = path.join(work, 'points.ply');
    const txtDir = path.join(work, 'sparse_txt');
    fs.mkdirSync(txtDir, { recursive: true });
    await run(tools.colmap, ['model_converter', '--input_path', model, '--output_path', pointsPly, '--output_type', 'PLY'], work, () => {});
    await run(tools.colmap, ['model_converter', '--input_path', model, '--output_path', txtDir, '--output_type', 'TXT'], work, () => {});
    if (onPreview) onPreview({ pointsPly, imagesTxt: path.join(txtDir, 'images.txt') });
  } catch (e) { report('colmap', 'Preview indisponível: ' + e.message); }

  return work;
}

/** Etapa 3: treino Brush. opts: { workDir, steps } */
async function trainSplat(tools, opts, report, onSnapshot) {
  const work = opts.workDir;
  report('train', 'Treinando Gaussian Splatting (Brush)…');
  const exportDir = path.join(work, 'export');
  fs.mkdirSync(exportDir, { recursive: true });
  const every = Math.max(500, Math.round(opts.steps / 20)); // ~20 snapshots
  const args = [ work,
    '--total-steps', String(opts.steps),
    '--export-every', String(every),
    '--export-path', exportDir,
    '--export-name', 'passo_{iter}.ply'
  ];
  // monitor: relógio + snapshots parciais → nunca parece travado
  const t0 = Date.now();
  let lastSeen = '';
  const mon = setInterval(() => {
    const min = ((Date.now() - t0) / 60000).toFixed(1);
    let plys = [];
    try { plys = fs.readdirSync(exportDir).filter(f => /\.ply$/i.test(f)); } catch {}
    if (plys.length) {
      plys.sort((a, b) => fs.statSync(path.join(exportDir, b)).mtimeMs - fs.statSync(path.join(exportDir, a)).mtimeMs);
      const latest = plys[0];
      const m = latest.match(/(\d+)/);
      const step = m ? parseInt(m[1]) : 0;
      const prog = Math.min(0.99, step / opts.steps);
      report('train', `⏱ ${min} min — passo ~${step}/${opts.steps} (${(prog*100).toFixed(0)}%)`, prog);
      if (latest !== lastSeen && onSnapshot) {
        lastSeen = latest;
        try { onSnapshot(path.join(exportDir, latest), prog); } catch {}
      }
    } else {
      report('train', `⏱ ${min} min — treinando (primeiro snapshot em ~${every} passos)…`);
    }
  }, 5000);
  try {
    await run(tools.brush, args, work, l => report('train', l));
  } catch (e) {
    report('train', 'Aviso: flags rejeitadas, tentando modo padrão do Brush… (' + e.message + ')');
    await run(tools.brush, [work, '--export-path', exportDir], work, l => report('train', l));
  } finally { clearInterval(mon); }
  const plys = [];
  (function walk(d){ for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.ply$/i.test(e.name) && e.name !== 'points.ply') plys.push(p);
  }})(work);
  if (!plys.length) throw new Error('Treino terminou mas nenhum .ply foi encontrado em ' + work);
  plys.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return plys[0];
}

module.exports = { prepareDataset, trainSplat };
