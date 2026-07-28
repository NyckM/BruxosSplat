// dpvo.js — alinhamento alternativo DPVO direto, em venv uv isolado.
// Não usa Docker: as extensões CUDA são instaladas como wheels pré-compiladas.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
let processTracker = () => {};
function setProcessTracker(tracker) { processTracker = typeof tracker === 'function' ? tracker : () => {}; }

// Mesma extração de progresso do pipeline.js (tqdm "NN%|" ou "[cur/total]"),
// duplicada aqui porque dpvo.js não compartilha módulo com pipeline.js. Sem
// isso o passo "Alinhando câmeras (DPVO direto / CUDA)" ficava minutos com a
// barra parada em 0% mesmo mostrando progresso real no log.
function parseLineProgress(line) {
  let m = /(\d{1,3}(?:\.\d+)?)\s*%\s*\|/.exec(line);
  if (m) { const p = parseFloat(m[1]) / 100; if (isFinite(p)) return Math.min(1, Math.max(0, p)); }
  m = /\[(\d+)\s*\/\s*(\d+)\]/.exec(line) || /\b(\d+)\s*\/\s*(\d+)\b/.exec(line);
  if (m) { const cur = parseFloat(m[1]), tot = parseFloat(m[2]); if (tot > 0 && isFinite(cur)) return Math.min(1, Math.max(0, cur / tot)); }
  return null;
}
function reportP(report, stage, line) { report(stage, line, parseLineProgress(line)); }

function run(exe, args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    // Sem isso, os prints do Python ficam no buffer quando o app captura o
    // log; uma exceção parecia surgir “do nada” depois de vários minutos.
    // No Windows o Process() do DPVO reinicia o interpretador. Força o
    // checkout oficial antes de site-packages: o wheel dpvo-cuda fornece as
    // extensões CUDA, mas também traz um pacote Python incompleto que não pode
    // substituir os módulos do repositório oficial no processo filho.
    const oldPythonPath = process.env.PYTHONPATH || '';
    const p = spawn(exe, args, {
      cwd, windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONPATH: cwd + path.delimiter + oldPythonPath }
    });
    processTracker(p);
    const feed = d => d.toString().split(/\r?\n/).forEach(l => l.trim() && onLine(l.trim()));
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('error', err => { processTracker(null, p); reject(err); });
    // O demo oficial cria um Process() leitor. No Windows esse filho pode
    // herdar stdout/stderr; então o evento `close` do Node nunca chega caso
    // o processo principal falhe. `exit` acompanha o processo que lançamos
    // e evita deixar a interface eternamente em “Alinhando câmeras”.
    let settled = false;
    p.on('exit', code => {
      if (settled) return;
      settled = true;
      processTracker(null, p);
      code === 0 ? resolve() : reject(new Error(`${path.basename(exe)} saiu com código ${code}`));
    });
  });
}

function getVideoResolution(ffmpegPath, videoPath) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-i', videoPath], { windowsHide: true }); let out = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('error', reject); p.on('close', () => {
      const m = out.match(/,\s*(\d{2,5})x(\d{2,5})(?:\s|,|\[)/);
      if (!m) return reject(new Error('Não foi possível detectar a resolução do vídeo.'));
      resolve({ width: +m[1], height: +m[2] });
    });
  });
}

function generateCalib(width, height, fovDeg = 60) {
  const fx = width / (2 * Math.tan((fovDeg * Math.PI / 180) / 2));
  return { fx, fy: fx, cx: width / 2, cy: height / 2 };
}

function scaledSize(width, height, maxSize) {
  const s = Math.min(1, maxSize / Math.max(width, height));
  // A rede do DPVO faz downsampling sucessivo. Dimensões somente pares não
  // bastam: por exemplo 960×410 vira uma feature map com 103 linhas, enquanto
  // o buffer interno foi alocado para 102. Alinhar ambos os lados a 8 evita
  // esse erro e também o encerramento nativo que o processo leitor mascarava.
  const aligned = n => Math.max(8, Math.floor(n / 8) * 8);
  return { width: aligned(width * s), height: aligned(height * s) };
}

function findColmapModel(dir) {
  const names = new Set(['cameras.txt', 'cameras.bin']);
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { const r = walk(p); if (r) return r; }
      else if (names.has(e.name) && (fs.existsSync(path.join(d, 'images.txt')) || fs.existsSync(path.join(d, 'images.bin')))) return d;
    }
    return null;
  };
  return walk(dir);
}

// O exportador CEB salva as poses, mas omite o nome da imagem e escreve uma
// trilha fictícia nos pontos. COLMAP, Brush e pycolmap exigem o formato texto
// completo: pose + nome da imagem + uma linha (vazia, neste caso) de pontos 2D.
function normalizeDpvoColmapModel(modelDir, imagesDir) {
  const names = fs.readdirSync(imagesDir).filter(f => /\.jpe?g$/i.test(f)).sort();
  const imageFile = path.join(modelDir, 'images.txt');
  const poseLines = fs.readFileSync(imageFile, 'utf8').split(/\r?\n/)
    .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (!poseLines.length) throw new Error('DPVO não exportou poses para o modelo COLMAP.');
  if (poseLines.length > names.length) throw new Error(`DPVO exportou ${poseLines.length} poses para apenas ${names.length} frames.`);
  const normalized = poseLines.map((line, index) => {
    const fields = line.split(/\s+/);
    if (fields.length < 9) throw new Error(`Pose DPVO inválida na linha ${index + 1}.`);
    return `${fields.slice(0, 9).join(' ')} ${names[index]}\n\n`;
  }).join('');
  fs.writeFileSync(imageFile, '# Image list with two lines of data per image:\n# IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME\n# POINTS2D[] as (X Y POINT3D_ID)\n' + normalized);

  const pointsFile = path.join(modelDir, 'points3D.txt');
  if (fs.existsSync(pointsFile)) {
    const points = fs.readFileSync(pointsFile, 'utf8').split(/\r?\n/).map(line => {
      const f = line.trim().split(/\s+/);
      return line.trim() && f.length >= 8 ? f.slice(0, 8).join(' ') : '';
    }).filter(Boolean).join('\n');
    fs.writeFileSync(pointsFile, '# 3D point list\n# POINT3D_ID X Y Z R G B ERROR TRACK[]\n' + points + (points ? '\n' : ''));
  }
  const camerasFile = path.join(modelDir, 'cameras.txt');
  if (fs.existsSync(camerasFile)) {
    const cameras = fs.readFileSync(camerasFile, 'utf8').trim();
    fs.writeFileSync(camerasFile, '# Camera list\n# CAMERA_ID MODEL WIDTH HEIGHT PARAMS[]\n' + cameras + '\n');
  }
  return poseLines.length;
}

async function prepareDatasetDPVO(tools, opts, report, onPreview) {
  if (!tools.dpvoOutputDir) throw new Error('Pacote portátil DPVO não foi encontrado. Instale-o em external_engines/DPVO_CEB.');
  if (!tools.dpvoPython || !tools.dpvoRepo) throw new Error('Ambiente DPVO direto não foi preparado.');
  if (!opts.videos || !opts.videos.length) throw new Error('Nenhum vídeo selecionado.');
  if (opts.videos.length > 1) report('colmap', '⚠️ DPVO processa apenas o primeiro vídeo (uma trajetória contínua).');
  const video = opts.videos[0];
  if (video.projection === 'equirect') throw new Error('DPVO direto ainda não suporta vídeo 360. Use COLMAP + modo equiretangular.');
  const work = opts.workDir, imagesDir = path.join(work, 'images'), sparse0 = path.join(work, 'sparse', '0');
  // O demo CEB sempre grava em <repo>/output/<nome>. `--name` não aceita
  // caminho absoluto, pois o próprio DPVO prefixa "output/".
  const runName = `bruxosplat_${Date.now()}`;
  const dpvoOut = path.join(tools.dpvoOutputDir, runName);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(imagesDir, { recursive: true }); fs.mkdirSync(dpvoOut, { recursive: true });

  report('colmap', 'Detectando resolução e calibração aproximada…');
  const original = await getVideoResolution(tools.ffmpeg, video.path);
  // DPVO recebe seu próprio limite porque custo de pose cresce por pixel.
  const requestedMax = Number(opts.dpvoMaxSize) || Math.max(original.width, original.height);
  const size = scaledSize(original.width, original.height, requestedMax);
  if (Math.max(original.width, original.height) > requestedMax) {
    report('frames', `DPVO: frames redimensionados para ${size.width}×${size.height} para acelerar a estimativa de poses.`);
  }
  // DPVO não lê o FOV real do vídeo (containers de vídeo raramente carregam essa
  // info de lente, diferente de fotos JPEG com EXIF) — sem um FOV correto aqui, a
  // distância focal usada pra triangular a cena fica errada, e isso se traduz
  // diretamente em "câmera/trajetória não batem com o vídeo" (escala/proporção
  // erradas), porque toda a reconstrução monocular deriva desse valor. Antes o
  // app assumia 60° pra qualquer câmera; agora a UI deixa escolher (celular normal,
  // ultra-wide, ação/GoPro etc.) — ainda é uma aproximação, mas pelo menos ajustável.
  const fovDeg = Number(opts.dpvoFov) || 60;
  const calib = generateCalib(size.width, size.height, fovDeg);
  const calibPath = path.join(work, 'calib.txt');
  fs.writeFileSync(calibPath, `${calib.fx} ${calib.fy} ${calib.cx} ${calib.cy}\n`);
  report('colmap', `Calibração aproximada: FOV ${fovDeg}° → fx=${calib.fx.toFixed(1)} (ajustável em Alinhamento de câmera > Campo de visão).`);

  report('frames', 'Extraindo frames para DPVO…');
  const args = []; if (video.start) args.push('-ss', video.start); if (video.end) args.push('-to', video.end);
  const fps = Math.max(0.1, parseFloat(video.fps) || (video.interval ? 1 / parseFloat(video.interval) : 2));
  args.push('-i', video.path, '-vf', `fps=${fps},scale=${size.width}:${size.height}`, '-q:v', '2', path.join(imagesDir, '%06d.jpg'));
  await run(tools.ffmpeg, args, work, l => report('frames', l));
  const nFrames = fs.readdirSync(imagesDir).filter(f => /\.jpe?g$/i.test(f)).length;
  if (nFrames < 5) throw new Error(`Poucos frames extraídos do vídeo (${nFrames}).`);
  report('frames', `${nFrames} frames extraídos.`);

  report('colmap', 'Alinhando câmeras (DPVO direto / CUDA)…');
  await run(tools.dpvoPython, ['demo.py', '--imagedir', imagesDir, '--calib', calibPath,
    '--network', 'dpvo.pth', '--stride', '2', '--name', runName, '--save_colmap', '--save_ply'], tools.dpvoRepo, l => reportP(report, 'colmap', l));
  const model = findColmapModel(dpvoOut);
  if (!model) throw new Error('DPVO terminou sem modelo COLMAP. Confira o log acima.');
  const poseCount = normalizeDpvoColmapModel(model, imagesDir);
  fs.mkdirSync(sparse0, { recursive: true });
  for (const f of fs.readdirSync(model)) fs.copyFileSync(path.join(model, f), path.join(sparse0, f));
  report('colmap', `DPVO: ${poseCount}/${nFrames} poses associadas aos frames para o treino.`);
  report('colmap', 'Câmeras alinhadas via DPVO direto (sem Docker).');

  // O DPVO já exporta um PLY e um modelo COLMAP em texto. Usá-los
  // diretamente evita que o model_converter rejeite pontos sem tracks,
  // que são válidos para visualização mas não para nova triangulação.
  const nativePly = path.join(tools.dpvoOutputDir, `${runName}.ply`);
  const pointsPly = path.join(work, 'points.ply');
  if (fs.existsSync(nativePly)) fs.copyFileSync(nativePly, pointsPly);
  if (onPreview && fs.existsSync(pointsPly)) {
    onPreview({ pointsPly, imagesTxt: path.join(sparse0, 'images.txt') });
  } else {
    report('colmap', 'Preview indisponível: o DPVO não gerou o arquivo PLY.');
  }
  return work;
}

module.exports = { prepareDatasetDPVO, generateCalib, getVideoResolution, normalizeDpvoColmapModel, setProcessTracker, parseLineProgress, reportP };
