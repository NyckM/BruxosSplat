// dpvo.js — alinhamento de câmeras alternativo via DPVO (Deep Patch Visual Odometry),
// rodando dentro do Docker image publicado pelo fork do usuário (ghcr.io/nyckm/dpvo).
// Mais rápido que COLMAP em vídeos longos, mas calibração é aproximada (sem EXIF)
// e a nuvem de pontos inicial é mais esparsa.
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DPVO_IMAGE = 'ghcr.io/nyckm/dpvo:latest';

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

/** Confere se o Docker está instalado e o daemon está rodando. */
function ensureDocker() {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    throw new Error('Docker não encontrado ou não está rodando. Instale o Docker Desktop e garanta que ele está aberto antes de usar o alinhamento DPVO.');
  }
}

/** Puxa a imagem DPVO do GHCR se ainda não existir localmente. */
async function ensureDpvoImage(log) {
  let exists = false;
  try {
    const out = execSync(`docker images -q ${DPVO_IMAGE}`).toString().trim();
    exists = !!out;
  } catch {}
  if (exists) { log(`Imagem ${DPVO_IMAGE} já disponível localmente.`); return; }
  log(`Baixando imagem Docker ${DPVO_IMAGE} (pode levar alguns minutos na primeira vez)…`);
  await run('docker', ['pull', DPVO_IMAGE], null, log);
}

/** Lê a resolução do vídeo (WxH) via ffmpeg -i (parseando o stderr). */
function getVideoResolution(ffmpegPath, videoPath) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-i', videoPath], { windowsHide: true });
    let out = '';
    p.stderr.on('data', d => out += d.toString());
    p.stdout.on('data', d => out += d.toString());
    p.on('error', reject);
    p.on('close', () => {
      const m = out.match(/,\s*(\d{2,5})x(\d{2,5})(?:\s|,|\[)/);
      if (!m) return reject(new Error('Não foi possível detectar a resolução do vídeo.'));
      resolve({ width: parseInt(m[1], 10), height: parseInt(m[2], 10) });
    });
  });
}

/** Heurística de calibração pinhole (sem EXIF): assume FOV horizontal de ~60°. */
function generateCalib(width, height, fovDeg = 60) {
  const fovRad = fovDeg * Math.PI / 180;
  const fx = width / (2 * Math.tan(fovRad / 2));
  const fy = fx;
  const cx = width / 2;
  const cy = height / 2;
  return { fx, fy, cx, cy };
}

/**
 * Etapa 1+2 alternativa (via DPVO): frames + alinhamento de câmeras.
 * opts: { videos:[{path,start,end,interval}], workDir, maxSize }
 * Suporta apenas um vídeo por vez (DPVO estima uma única trajetória de câmera contínua).
 */
async function prepareDatasetDPVO(tools, opts, report, onPreview) {
  if (!opts.videos || !opts.videos.length) throw new Error('Nenhum vídeo selecionado.');
  if (opts.videos.length > 1) report('colmap', '⚠️ DPVO processa só o primeiro vídeo da lista (estima uma trajetória contínua de câmera).');
  const video = opts.videos[0];
  const work = opts.workDir;
  const imagesDir = path.join(work, 'images');
  const sparseDir = path.join(work, 'sparse');
  const dpvoOutDir = path.join(work, 'dpvo_out');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.mkdirSync(sparseDir, { recursive: true });
  fs.mkdirSync(dpvoOutDir, { recursive: true });

  report('colmap', 'Verificando Docker…');
  ensureDocker();
  await ensureDpvoImage(l => report('colmap', l));

  report('colmap', 'Detectando resolução do vídeo…');
  const { width, height } = await getVideoResolution(tools.ffmpeg, video.path);
  const calib = generateCalib(width, height);
  const calibPath = path.join(work, 'calib.txt');
  fs.writeFileSync(calibPath, `${calib.fx} ${calib.fy} ${calib.cx} ${calib.cy}\n`);
  report('colmap', `Calibração estimada (sem EXIF): fx=${calib.fx.toFixed(1)} fy=${calib.fy.toFixed(1)} cx=${calib.cx.toFixed(1)} cy=${calib.cy.toFixed(1)}`);

  // Frames para o treino (Brush precisa das imagens correspondentes às poses do DPVO)
  report('frames', 'Extraindo frames do vídeo…');
  const args = [];
  if (video.start) args.push('-ss', video.start);
  if (video.end) args.push('-to', video.end);
  args.push('-i', video.path,
    '-vf', `scale='min(${opts.maxSize},iw)':-2`,
    '-q:v', '2',
    path.join(imagesDir, '%06d.jpg'));
  await run(tools.ffmpeg, args, work, l => report('frames', l));
  const nFrames = fs.readdirSync(imagesDir).length;
  if (nFrames < 5) throw new Error('Poucos frames extraídos do vídeo (' + nFrames + ').');
  report('frames', `${nFrames} frames extraídos.`);

  // Docker run: DPVO lê o vídeo diretamente e escreve saída COLMAP em /app/outputs/run/colmap
  report('colmap', 'Alinhando câmeras (DPVO)…');
  const videoAbs = path.resolve(video.path);
  const dockerArgs = [
    'run', '--rm', '--gpus', 'all', '--ipc=host',
    '-v', `${videoAbs}:/data/input.mp4:ro`,
    '-v', `${calibPath}:/app/calib/custom.txt:ro`,
    '-v', `${dpvoOutDir}:/app/outputs`,
    DPVO_IMAGE,
    'python', 'run.py',
    '--imagedir=/data/input.mp4',
    '--calib=calib/custom.txt',
    '--stride', '2',
    '--name', 'run',
    '--save_colmap'
  ];
  await run('docker', dockerArgs, work, l => report('colmap', l));

  const dpvoColmapDir = path.join(dpvoOutDir, 'run', 'colmap');
  if (!fs.existsSync(dpvoColmapDir)) throw new Error('DPVO não gerou saída COLMAP (outputs/run/colmap). Confira o log acima.');
  const sparse0 = path.join(sparseDir, '0');
  fs.mkdirSync(sparse0, { recursive: true });
  for (const f of fs.readdirSync(dpvoColmapDir)) {
    fs.copyFileSync(path.join(dpvoColmapDir, f), path.join(sparse0, f));
  }
  report('colmap', 'Câmeras alinhadas via DPVO.');

  // Preview: nuvem esparsa + poses (reaproveita o COLMAP já baixado só pra conversão de formato)
  try {
    const pointsPly = path.join(work, 'points.ply');
    const txtDir = path.join(work, 'sparse_txt');
    fs.mkdirSync(txtDir, { recursive: true });
    await run(tools.colmap, ['model_converter', '--input_path', sparse0, '--output_path', pointsPly, '--output_type', 'PLY'], work, () => {});
    await run(tools.colmap, ['model_converter', '--input_path', sparse0, '--output_path', txtDir, '--output_type', 'TXT'], work, () => {});
    if (onPreview) onPreview({ pointsPly, imagesTxt: path.join(txtDir, 'images.txt') });
  } catch (e) { report('colmap', 'Preview indisponível: ' + e.message); }

  return work;
}

module.exports = { prepareDatasetDPVO, ensureDocker, ensureDpvoImage, generateCalib, getVideoResolution, DPVO_IMAGE };
