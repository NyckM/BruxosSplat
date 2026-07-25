// pipeline.js — vídeos → frames (ffmpeg) → alinhamento (COLMAP) → treino 3DGS (Brush) → .ply
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
let processTracker = () => {};
function setProcessTracker(tracker) { processTracker = typeof tracker === 'function' ? tracker : () => {}; }

// Python não consegue abrir arquivos dentro de app.asar. Em builds Electron,
// electron-builder os deixa em resources/app.asar.unpacked/models.
function modelScript(name) {
  const unpacked = process.resourcesPath && path.join(process.resourcesPath, 'app.asar.unpacked', 'models', name);
  return unpacked && fs.existsSync(unpacked) ? unpacked : path.join(__dirname, 'models', name);
}

function run(exe, args, cwd, onLine, env) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    if (process.platform === 'win32' && env && (env.Path || env.PATH)) {
      for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'path') delete childEnv[key];
      childEnv.Path = env.Path || env.PATH;
    }
    const p = spawn(exe, args, { cwd, windowsHide: true, env: childEnv });
    processTracker(p);
    const feed = d => d.toString().split(/\r?\n/).forEach(l => l.trim() && onLine(l.trim()));
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', err => { processTracker(null, p); reject(err); });
    p.on('close', code => { processTracker(null, p); code === 0 ? resolve() : reject(new Error(`${path.basename(exe)} saiu com código ${code}`)); });
  });
}

/**
 * Etapa 1+2: frames + alinhamento de câmeras.
 * opts: { videos:[{path,start,end,fps,projection?}], workDir, maxSize }
 */
async function prepareDataset(tools, opts, report, onPreview) {
  const work = opts.workDir;
  const imagesDir = path.join(work, 'images');
  const sparseDir = path.join(work, 'sparse');
  const dbPath = path.join(work, 'database.db');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.mkdirSync(sparseDir, { recursive: true });

  // 1) Frames de cada vídeo. O equiretangular não é enviado diretamente ao
  // COLMAP: ele vira quatro câmeras virtuais planas com sobreposição.
  let vi = 0;
  let hasEquirect = false;
  let hasFlat = false;
  for (const v of opts.videos) {
    vi++;
    report('frames', `Extraindo frames (${vi}/${opts.videos.length}): ${path.basename(v.path)}…`);
    const args = [];
    if (v.start) args.push('-ss', v.start);
    if (v.end) args.push('-to', v.end);
    // fps é mais direto para quem grava vídeo. Mantém interval como fallback
    // para projetos salvos por versões anteriores do app.
    const fps = Math.max(0.1, parseFloat(v.fps) || (v.interval ? 1 / parseFloat(v.interval) : 2));
    if (v.projection === 'equirect') {
      hasEquirect = true;
      const faceDirs = [];
      const faces = [['front', 0], ['right', 90], ['back', 180], ['left', 270]];
      const side = Math.max(512, Math.round(opts.maxSize || 1600));
      for (const [name, yaw] of faces) {
        const faceDir = path.join(work, `equirect_v${vi}_${name}`);
        faceDirs.push([name, faceDir]);
        fs.mkdirSync(faceDir, { recursive: true });
        const faceArgs = [...args, '-i', v.path,
          '-vf', `fps=${fps},v360=input=equirect:output=flat:yaw=${yaw}:pitch=0:h_fov=100:v_fov=100:w=${side}:h=${side}`,
          '-q:v', '2', path.join(faceDir, '%05d.jpg')];
        try { await run(tools.ffmpeg, faceArgs, work, l => report('frames', l)); }
        catch (err) { throw new Error('Não foi possível converter o vídeo 360. Este FFmpeg precisa do filtro v360. ' + err.message); }
      }
      const sourceFrames = fs.readdirSync(faceDirs[0][1]).filter(f => /\.jpe?g$/i.test(f)).sort();
      for (const frame of sourceFrames) for (const [name, faceDir] of faceDirs) {
        const from = path.join(faceDir, frame);
        if (fs.existsSync(from)) fs.renameSync(from, path.join(imagesDir, `v${vi}_${path.parse(frame).name}_${name}.jpg`));
      }
      for (const [, faceDir] of faceDirs) fs.rmSync(faceDir, { recursive: true, force: true });
      report('frames', `Vídeo 360 convertido: ${sourceFrames.length} frames × 4 câmeras virtuais (100°).`);
    } else {
      hasFlat = true;
      args.push('-i', v.path,
        '-vf', `fps=${fps},scale='min(${opts.maxSize},iw)':-2`,
        '-q:v', '2', path.join(imagesDir, `v${vi}_%05d.jpg`));
      await run(tools.ffmpeg, args, work, l => report('frames', l));
    }
  }
  const nFrames = fs.readdirSync(imagesDir).length;
  if (nFrames < 10) throw new Error('Poucos frames extraídos (' + nFrames + '). Aumente o FPS ou use vídeos mais longos.');
  report('frames', `${nFrames} frames extraídos no total.`);

  // 2) Alinhamento de câmeras (COLMAP automatic_reconstructor: mais robusto p/ vídeo)
  report('colmap', 'Alinhando câmeras (COLMAP, modo vídeo)…');
  await run(tools.colmap, ['automatic_reconstructor',
    '--workspace_path', work,
    '--image_path', imagesDir,
    '--data_type', 'video',
    '--quality', 'high',
    '--single_camera', (hasEquirect && hasFlat) ? '0' : '1',
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

/** Frames + poses MASt3R, exportados como modelo COLMAP para os motores existentes. */
async function prepareDatasetMast3r(tools, opts, report, onPreview) {
  if (!tools.mast3rPython || !tools.mast3rRepo) throw new Error('Ambiente MASt3R não foi preparado.');
  const work = opts.workDir, imagesDir = path.join(work, 'images');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(imagesDir, { recursive: true });
  let vi = 0;
  for (const v of opts.videos || []) {
    vi++;
    if (v.projection === 'equirect') throw new Error('MASt3R ainda não suporta vídeo 360/equiretangular neste app.');
    report('frames', `Extraindo frames (${vi}/${opts.videos.length}): ${path.basename(v.path)}…`);
    const args = [];
    if (v.start) args.push('-ss', v.start);
    if (v.end) args.push('-to', v.end);
    const fps = Math.max(0.1, parseFloat(v.fps) || (v.interval ? 1 / parseFloat(v.interval) : 2));
    args.push('-i', v.path, '-vf', `fps=${fps},scale='min(${opts.maxSize || 1600},iw)':-2`, '-q:v', '2', path.join(imagesDir, `v${vi}_%05d.jpg`));
    await run(tools.ffmpeg, args, work, l => report('frames', l));
  }
  const nFrames = fs.readdirSync(imagesDir).filter(f => /\.jpe?g$/i.test(f)).length;
  if (nFrames < 5) throw new Error(`Poucos frames extraídos (${nFrames}). Aumente o FPS ou use um vídeo mais longo.`);
  report('frames', `${nFrames} frames extraídos. MASt3R redimensionará internamente para a reconstrução.`);
  report('colmap', 'Estimando poses e geometria com MASt3R (experimental)…');
  const script = modelScript('mast3r_to_colmap.py');
  // The app script is outside the MASt3R checkout, so Python's default
  // module path contains models/ rather than the checkout used as cwd.
  const oldPythonPath = process.env.PYTHONPATH || '';
  await run(tools.mast3rPython, [script, '--images', imagesDir, '--output', work], tools.mast3rRepo,
    l => report('colmap', l), { PYTHONPATH: tools.mast3rRepo + path.delimiter + oldPythonPath });
  const sparseTxt = path.join(work, 'sparse_txt');
  const sparse0 = path.join(work, 'sparse', '0');
  if (!fs.existsSync(path.join(sparseTxt, 'images.txt'))) throw new Error('MASt3R terminou sem exportar poses em formato COLMAP.');
  fs.mkdirSync(sparse0, { recursive: true });
  await run(tools.colmap, ['model_converter', '--input_path', sparseTxt, '--output_path', sparse0, '--output_type', 'BIN'], work, l => report('colmap', l));
  const pointsPly = path.join(work, 'points.ply');
  if (onPreview) onPreview({ pointsPly, imagesTxt: path.join(sparseTxt, 'images.txt') });
  report('colmap', 'MASt3R concluiu poses e nuvem inicial. O PLY está aberto no editor.');
  return work;
}

/** MegaSam portátil: vídeo -> RGB-D/poses -> COLMAP/PLY para os motores existentes. */
async function prepareDatasetMegaSam(tools, opts, report, onPreview) {
  if (!tools.megasamPython || !tools.megasamRepo) throw new Error('MegaSam portátil não foi encontrado. Escolha ou instale o pacote local do MegaSam primeiro.');
  const video = (opts.videos || [])[0];
  if (!video) throw new Error('Selecione um vídeo para o MegaSam.');
  if (video.projection === 'equirect') throw new Error('MegaSam não suporta vídeo 360/equiretangular neste modo. Use COLMAP.');
  if ((opts.videos || []).length > 1) report('frames', '⚠️ MegaSam processa somente o primeiro vídeo por vez.');
  const work = opts.workDir, imagesDir = path.join(work, 'images');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(imagesDir, { recursive: true });
  const scene = 'bruxosplat_' + Date.now();
  const portableDir = path.dirname(tools.megasamPython);
  const pathEnv = portableDir + path.delimiter + (process.env.Path || process.env.PATH || '');
  report('setup', 'Preparando MegaSam portátil (DROID + profundidade + câmera)…');
  report('colmap', 'Estimando movimento, profundidade e poses com MegaSam…');
  await run(tools.megasamPython, [modelScript('megasam_run.py'), '--repo', tools.megasamRepo,
    '--video', video.path, '--scene', scene, '--output-root', path.join(work, 'megasam_frames'), '--width', '540'],
    tools.megasamRepo, l => report('colmap', l), { Path: pathEnv });
  const npz = path.join(tools.megasamRepo, 'outputs_cvd', scene + '_sgd_cvd_hr.npz');
  if (!fs.existsSync(npz)) throw new Error('MegaSam terminou sem o arquivo NPZ de poses/profundidade. Confira o log acima.');
  const sourceFrames = path.join(work, 'megasam_frames', scene);
  if (!fs.existsSync(sourceFrames)) throw new Error('MegaSam terminou sem os frames usados na reconstrução.');
  const frames = fs.readdirSync(sourceFrames).filter(f => /\.(jpe?g|png)$/i.test(f)).sort();
  if (frames.length < 2) throw new Error('MegaSam gerou poucos frames para a reconstrução.');
  for (let i = 0; i < frames.length; i++) {
    const ext = path.extname(frames[i]).toLowerCase();
    fs.copyFileSync(path.join(sourceFrames, frames[i]), path.join(imagesDir, `mega_${String(i + 1).padStart(5, '0')}${ext}`));
  }
  report('frames', `${frames.length} frames MegaSam preparados para treino.`);
  await run(tools.megasamPython, [modelScript('megasam_to_colmap.py'), '--npz', npz,
    '--images', imagesDir, '--output', work], tools.megasamRepo, l => report('colmap', l), { Path: pathEnv });
  const sparseTxt = path.join(work, 'sparse_txt');
  if (!fs.existsSync(path.join(sparseTxt, 'images.txt'))) throw new Error('MegaSam não exportou poses em formato COLMAP.');
  const sparse0 = path.join(work, 'sparse', '0');
  fs.mkdirSync(sparse0, { recursive: true });
  await run(tools.colmap, ['model_converter', '--input_path', sparseTxt, '--output_path', sparse0, '--output_type', 'BIN'], work, l => report('colmap', l));
  const pointsPly = path.join(work, 'points.ply');
  if (onPreview) onPreview({ pointsPly, imagesTxt: path.join(sparseTxt, 'images.txt') });
  report('colmap', 'MegaSam concluiu poses e nuvem inicial. O PLY está aberto no editor.');
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

/** Etapa 3 alternativa: gsplat + PPISP (CUDA/NVIDIA). */
async function trainPpisp(tools, opts, report, onSnapshot) {
  if (!tools.ppispPython) throw new Error('Backend PPISP não foi preparado.');
  const work = opts.workDir;
  const modelDir = path.join(work, 'sparse', '0');
  if (!fs.existsSync(modelDir)) throw new Error('PPISP precisa do modelo COLMAP em sparse/0. Use o alinhamento COLMAP.');
  const exportDir = path.join(work, 'export');
  fs.mkdirSync(exportDir, { recursive: true });
  const every = Math.max(500, Math.round(opts.steps / 20));
  const script = modelScript('ppisp_train.py');
  const args = [script, '--colmap', modelDir, '--images', path.join(work, 'images'),
    '--output', exportDir, '--steps', String(opts.steps), '--export-every', String(every),
    '--max-resolution', String(opts.maxSize || 1600)];
  report('train', 'Treinando GSplat + PPISP (NVIDIA/CUDA)…');
  const t0 = Date.now(); let lastSeen = '';
  const mon = setInterval(() => {
    const min = ((Date.now() - t0) / 60000).toFixed(1);
    let plys = [];
    try { plys = fs.readdirSync(exportDir).filter(f => /^passo_\d+\.ply$/i.test(f)); } catch {}
    if (!plys.length) return report('train', `⏱ ${min} min — preparando GSplat + PPISP…`);
    plys.sort((a, b) => fs.statSync(path.join(exportDir, b)).mtimeMs - fs.statSync(path.join(exportDir, a)).mtimeMs);
    const latest = plys[0], m = latest.match(/(\d+)/), step = m ? parseInt(m[1]) : 0;
    const prog = Math.min(0.99, step / opts.steps);
    report('train', `⏱ ${min} min — passo ~${step}/${opts.steps} (${(prog * 100).toFixed(0)}%)`, prog);
    if (latest !== lastSeen && onSnapshot) { lastSeen = latest; try { onSnapshot(path.join(exportDir, latest), prog); } catch {} }
  }, 5000);
  try { await run(tools.ppispPython, args, work, l => report('train', l), tools.ppispEnv); }
  finally { clearInterval(mon); }
  const final = path.join(exportDir, 'final.ply');
  if (fs.existsSync(final)) return final;
  throw new Error('Treino PPISP terminou mas não gerou final.ply.');
}

async function train3dgrut(tools, opts, report, onSnapshot) {
  const work = opts.workDir, exportDir = path.join(work, '3dgrut_export');
  if (!tools.grutPython || !tools.grutRepo) throw new Error('Backend 3DGRUT não foi preparado.');
  if (!fs.existsSync(path.join(work, 'sparse', '0'))) throw new Error('3DGRUT requer o projeto COLMAP em sparse/0.');
  fs.mkdirSync(exportDir, { recursive: true });
  report('train', 'Treinando 3DGRT / Ray Tracing NVIDIA (experimental)…');
  // 3DGRT é o backend de ray tracing do 3DGRUT. export_ingp produz o PLY
  // compatível com o editor e export_usd guarda a cena USDZ para Omniverse/Isaac.
  await run(tools.grutPython, ['train.py', '--config-name', 'apps/colmap_3dgrt.yaml',
    `path=${work}`, `out_dir=${exportDir}`, 'experiment_name=bruxosplat',
    'export_ingp.enabled=true', 'export_usd.enabled=true'],
    tools.grutRepo, l => report('train', l));
  const found = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.ply$/i.test(e.name)) found.push(p); } })(exportDir);
  if (!found.length) throw new Error('3DGRUT terminou sem PLY exportado; os checkpoints/USD permanecem em ' + exportDir);
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const usd = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.usd[azc]?$/i.test(e.name)) usd.push(p); } })(exportDir);
  usd.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!usd.length) throw new Error('3DGRUT terminou sem USD/USDZ exportado; o PLY e os checkpoints permanecem em ' + exportDir);
  return { ply: found[0], usd: usd[0] || null };
}

module.exports = { prepareDataset, prepareDatasetMast3r, prepareDatasetMegaSam, trainSplat, trainPpisp, train3dgrut, setProcessTracker };
