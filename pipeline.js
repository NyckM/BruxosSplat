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

// Extrai uma porcentagem de progresso de uma linha de log, quando dá. Cobre
// barras estilo tqdm ("100%|##########| 784/784 [01:18<00:00, 9.99it/s]", usadas
// pelo MegaSam/MASt3R/DROID-SLAM) e contadores tipo "[123/784]" (usados pelo
// COLMAP em "Processed file [123/784]"). Sem isso, etapas longas como alinhamento
// de câmeras ficavam com a barra de progresso travada em 0% o tempo todo — mesmo
// com o log mostrando "100%" no texto — dando a impressão de que o app travou.
function parseLineProgress(line) {
  let m = /(\d{1,3}(?:\.\d+)?)\s*%\s*\|/.exec(line);
  if (m) { const p = parseFloat(m[1]) / 100; if (isFinite(p)) return Math.min(1, Math.max(0, p)); }
  m = /\[(\d+)\s*\/\s*(\d+)\]/.exec(line) || /\b(\d+)\s*\/\s*(\d+)\b/.exec(line);
  if (m) { const cur = parseFloat(m[1]), tot = parseFloat(m[2]); if (tot > 0 && isFinite(cur)) return Math.min(1, Math.max(0, cur / tot)); }
  return null;
}
function reportP(report, stage, line) { report(stage, line, parseLineProgress(line)); }

// Filtro de escala do ffmpeg limitando o LADO MAIOR (não a largura).
// A versão antiga era `scale='min(MAX,iw)':-2`, que limita sempre a LARGURA — em
// vídeo retrato (ex.: 2160x3840) isso deixava passar um lado maior bem acima do
// pedido (1600 de largura => 2844 de altura), gastando VRAM à toa. Agora o limite
// vale pro lado maior de verdade, em retrato e paisagem, e nunca faz upscale.
function scaleFilter(maxSize) {
  const m = Math.max(256, Math.round(maxSize || 1600));
  return `scale=w='if(gte(iw,ih),min(${m},iw),-2)':h='if(lt(iw,ih),min(${m},ih),-2)'`;
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

// Lê o `-h` de um subcomando do COLMAP pra descobrir os nomes de flag que a build
// instalada aceita. Necessário porque o COLMAP 4.x renomeou várias opções: o que
// era `--SiftMatching.guided_matching` virou `--FeatureMatching.guided_matching`,
// e `--SiftExtraction.use_gpu`/`max_image_size` viraram `--FeatureExtraction.*`.
// Chutar nome de flag quebraria o alinhamento inteiro — foi exatamente assim que
// o `--total-steps` do Brush passou batido por tanto tempo.
const _cmHelpCache = new Map();
function colmapHelp(exe, cmd) {
  const key = exe + '|' + cmd;
  if (_cmHelpCache.has(key)) return _cmHelpCache.get(key);
  const p = new Promise(resolve => {
    let out = '';
    try {
      const proc = spawn(exe, [cmd, '-h'], { windowsHide: true });
      const t = setTimeout(() => { try { proc.kill(); } catch {} resolve(out); }, 15000);
      proc.stdout.on('data', d => out += d.toString());
      proc.stderr.on('data', d => out += d.toString());
      proc.on('error', () => { clearTimeout(t); resolve(''); });
      proc.on('close', () => { clearTimeout(t); resolve(out); });
    } catch { resolve(''); }
  });
  _cmHelpCache.set(key, p);
  return p;
}
// Devolve o primeiro nome de flag que existe nesse help, ou null (então é ignorada).
function pickFlag(help, ...candidates) {
  for (const c of candidates) if (help.includes(c)) return c;
  return null;
}

/**
 * Alinhamento COLMAP em etapas (feature_extractor → matcher → mapper), com os
 * parâmetros de qualidade que o `automatic_reconstructor` não expõe.
 * Só roda quando o usuário escolhe um preset diferente de "Automático".
 */
async function colmapStaged(tools, cfg, ctx, report) {
  const { work, imagesDir, dbPath, sparseDir, singleCamera } = ctx;
  const exe = tools.colmap;
  const push = (args, flag, value) => { if (flag) args.push(flag, String(value)); };

  // ── 1) Extração de features ────────────────────────────────────────────────
  const hExt = await colmapHelp(exe, 'feature_extractor');
  const ext = ['feature_extractor', '--database_path', dbPath, '--image_path', imagesDir,
    '--ImageReader.camera_model', 'OPENCV', '--ImageReader.single_camera', singleCamera];
  push(ext, pickFlag(hExt, '--SiftExtraction.max_num_features'), cfg.features);
  push(ext, pickFlag(hExt, '--SiftExtraction.peak_threshold'), cfg.peak);
  push(ext, pickFlag(hExt, '--SiftExtraction.edge_threshold'), 10);
  // first_octave já é -1 por padrão no COLMAP; passamos explícito só pra não
  // depender de o padrão continuar o mesmo entre versões.
  push(ext, pickFlag(hExt, '--SiftExtraction.first_octave'), -1);
  if (cfg.affine) push(ext, pickFlag(hExt, '--SiftExtraction.estimate_affine_shape'), 1);
  if (cfg.dsp) push(ext, pickFlag(hExt, '--SiftExtraction.domain_size_pooling'), 1);
  if (cfg.affine || cfg.dsp) {
    // Nenhum dos dois tem kernel CUDA no COLMAP — ligando qualquer um, a extração
    // cai pra implementação de CPU. Avisamos porque a diferença de tempo é grande.
    report('colmap', '⚠️ Affine shape / DSP-SIFT não rodam em GPU no COLMAP — esta etapa vai usar CPU e demorar bem mais.');
  }
  report('colmap', `Extraindo features (máx. ${cfg.features}/imagem, peak ${cfg.peak})…`);
  await run(exe, ext, work, l => reportP(report, 'colmap', l));

  // ── 2) Matching ────────────────────────────────────────────────────────────
  // vocab_tree é o matcher indicado quando há centenas de imagens sem ordem
  // conhecida; sequential é o certo para vídeo; exhaustive só para poucas fotos.
  const matcherCmd = cfg.matcher === 'exhaustive' ? 'exhaustive_matcher'
                   : cfg.matcher === 'vocabtree' ? 'vocab_tree_matcher'
                   : 'sequential_matcher';
  const hMat = await colmapHelp(exe, matcherCmd);
  const mat = [matcherCmd, '--database_path', dbPath];
  if (cfg.guided) push(mat, pickFlag(hMat, '--FeatureMatching.guided_matching', '--SiftMatching.guided_matching'), 1);

  // Loop detection: num vídeo que dá a volta e volta ao ponto inicial, o matching
  // sequencial sozinho nunca liga o fim ao começo — o erro de pose acumula e a
  // cena "não fecha". A detecção de laço resolve isso, mas o COLMAP exige uma
  // vocabulary tree pré-treinada para fazê-la. Se o arquivo não estiver
  // disponível, seguimos sem (avisando), em vez de derrubar o alinhamento.
  if ((cfg.loop || cfg.matcher === 'vocabtree') && ctx.vocabTree) {
    if (cfg.matcher === 'vocabtree') {
      push(mat, pickFlag(hMat, '--VocabTreeMatching.vocab_tree_path'), ctx.vocabTree);
    } else {
      const loopFlag = pickFlag(hMat, '--SequentialMatching.loop_detection');
      const vocabFlag = pickFlag(hMat, '--SequentialMatching.vocab_tree_path');
      if (loopFlag && vocabFlag) {
        mat.push(loopFlag, '1', vocabFlag, ctx.vocabTree);
        report('colmap', '🔁 Loop detection ativado (fecha o laço quando o vídeo retorna ao ponto de partida).');
      } else {
        report('colmap', '⚠️ Esta build do COLMAP não expõe loop detection no matcher sequencial; seguindo sem.');
      }
    }
  } else if (cfg.loop && !ctx.vocabTree) {
    report('colmap', '⚠️ Loop detection pedido, mas a vocabulary tree não está disponível — seguindo sem.');
  }

  report('colmap', `Matching (${cfg.matcher}${cfg.guided ? ' + guided' : ''}${cfg.loop ? ' + loop' : ''})…`);
  await run(exe, mat, work, l => reportP(report, 'colmap', l));

  // ── 3) Mapper (reconstrução esparsa) ───────────────────────────────────────
  const hMap = await colmapHelp(exe, 'mapper');
  fs.mkdirSync(sparseDir, { recursive: true });
  const map = ['mapper', '--database_path', dbPath, '--image_path', imagesDir, '--output_path', sparseDir];
  push(map, pickFlag(hMap, '--Mapper.min_num_matches'), cfg.minMatches);
  push(map, pickFlag(hMap, '--Mapper.tri_min_angle'), cfg.triAngle);
  if (cfg.ba) {
    push(map, pickFlag(hMap, '--Mapper.ba_refine_focal_length'), 1);
    push(map, pickFlag(hMap, '--Mapper.ba_refine_principal_point'), 1);
    push(map, pickFlag(hMap, '--Mapper.ba_refine_extra_params'), 1);
  }
  report('colmap', 'Reconstruindo câmeras (mapper)…');
  await run(exe, map, work, l => reportP(report, 'colmap', l));
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
        '-vf', `fps=${fps},${scaleFilter(opts.maxSize)}`,
        '-q:v', '2', path.join(imagesDir, `v${vi}_%05d.jpg`));
      await run(tools.ffmpeg, args, work, l => report('frames', l));
    }
  }
  const nFrames = fs.readdirSync(imagesDir).length;
  if (nFrames < 10) throw new Error('Poucos frames extraídos (' + nFrames + '). Aumente o FPS ou use vídeos mais longos.');
  report('frames', `${nFrames} frames extraídos no total.`);

  // 2) Alinhamento de câmeras. Dois caminhos:
  //    - opts.colmap == null  → automatic_reconstructor (comportamento histórico,
  //      robusto e sem regressão para quem não mexeu em nada);
  //    - opts.colmap != null  → pipeline em etapas, que é o único jeito de expor
  //      max_num_features, peak_threshold, guided matching, DSP-SIFT, affine shape
  //      e os refinamentos de bundle adjustment (o automatic_reconstructor não
  //      aceita nenhuma dessas opções).
  const singleCamera = (hasEquirect && hasFlat) ? '0' : '1';
  if (opts.colmap) {
    const cfg = opts.colmap;
    report('colmap', `Alinhando câmeras (COLMAP em etapas — preset "${cfg.preset}")…`);
    try {
      await colmapStaged(tools, cfg, { work, imagesDir, dbPath, sparseDir, singleCamera, vocabTree: tools.vocabTree || null }, report);
    } catch (e) {
      // Se algo der errado no caminho ajustado, o alinhamento inteiro seria perdido.
      // Voltar pro automático custa tempo mas salva a execução — e o aviso deixa
      // claro que os parâmetros escolhidos não foram os aplicados.
      report('colmap', '⚠️ O alinhamento ajustado falhou: ' + e.message);
      report('colmap', '⚠️ Refazendo no modo Automático — os parâmetros de qualidade do COLMAP NÃO foram aplicados.');
      fs.rmSync(dbPath, { force: true });
      await run(tools.colmap, ['automatic_reconstructor',
        '--workspace_path', work, '--image_path', imagesDir, '--data_type', 'video',
        '--quality', 'high', '--single_camera', singleCamera, '--camera_model', 'OPENCV',
        '--sparse', '1', '--dense', '0'], work, l => reportP(report, 'colmap', l));
    }
  } else {
    report('colmap', 'Alinhando câmeras (COLMAP, modo vídeo)…');
    await run(tools.colmap, ['automatic_reconstructor',
      '--workspace_path', work,
      '--image_path', imagesDir,
      '--data_type', 'video',
      '--quality', 'high',
      '--single_camera', singleCamera,
      '--camera_model', 'OPENCV',
      '--sparse', '1',
      '--dense', '0'
    ], work, l => reportP(report, 'colmap', l));
  }
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
    args.push('-i', v.path, '-vf', `fps=${fps},${scaleFilter(opts.maxSize)}`, '-q:v', '2', path.join(imagesDir, `v${vi}_%05d.jpg`));
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
    l => reportP(report, 'colmap', l), { PYTHONPATH: tools.mast3rRepo + path.delimiter + oldPythonPath });
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
  // O DROID-SLAM de dentro do MegaSam aloca um buffer fixo (padrão 1024, veja
  // camera_tracking_scripts/test_demo.py) pra guardar TODOS os frames durante o
  // passo de reconstrução completa (traj_filler/terminate), não só os keyframes.
  // Vídeos com mais frames que esse buffer quebram com
  // "RuntimeError: The expanded size of the tensor (1024) must match the existing
  // size (N) at non-singleton dimension 0" — foi exatamente o que aconteceu com um
  // vídeo de 2484 frames. Nosso próprio megasam_run.py já sabe encaminhar
  // --batch-size pro run_pipeline.py (que processa em lotes, como mostra o log
  // "PROCESSING BATCH"), só que a chamada nunca informava um valor — então ele
  // tratava o vídeo inteiro como um lote só. Aqui fixamos um teto seguro,
  // bem abaixo dos 1024 do buffer do DROID, pra qualquer vídeo longo ser
  // automaticamente dividido em lotes menores.
  const megasamBatchSize = 800;
  await run(tools.megasamPython, [modelScript('megasam_run.py'), '--repo', tools.megasamRepo,
    '--video', video.path, '--scene', scene, '--output-root', path.join(work, 'megasam_frames'), '--width', '540',
    '--batch-size', String(megasamBatchSize)],
    tools.megasamRepo, l => reportP(report, 'colmap', l), { Path: pathEnv });
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
    '--images', imagesDir, '--output', work], tools.megasamRepo, l => reportP(report, 'colmap', l), { Path: pathEnv });
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

// Roda `<exe> --help` e devolve o texto (stdout+stderr). Usado pra descobrir quais
// flags a build do Brush instalada nesta máquina realmente aceita, em vez de chutar.
// O clap sai com código != 0 em --help dependendo da versão, então resolvemos sempre.
const _helpCache = new Map();
function captureHelp(exe) {
  if (_helpCache.has(exe)) return _helpCache.get(exe);
  const p = new Promise(resolve => {
    let out = '';
    try {
      const proc = spawn(exe, ['--help'], { windowsHide: true });
      const t = setTimeout(() => { try { proc.kill(); } catch {} resolve(out); }, 15000);
      proc.stdout.on('data', d => out += d.toString());
      proc.stderr.on('data', d => out += d.toString());
      proc.on('error', () => { clearTimeout(t); resolve(''); });
      proc.on('close', () => { clearTimeout(t); resolve(out); });
    } catch { resolve(''); }
  });
  _helpCache.set(exe, p);
  return p;
}

/** Etapa 3: treino Brush. opts: { workDir, steps } */
async function trainSplat(tools, opts, report, onSnapshot) {
  const work = opts.workDir;
  report('train', 'Treinando Gaussian Splatting (Brush)…');
  const exportDir = path.join(work, 'export');
  fs.mkdirSync(exportDir, { recursive: true });
  const every = Math.max(500, Math.round(opts.steps / 20)); // ~20 snapshots

  // ─────────────────────────────────────────────────────────────────────────────
  // Descoberta de flags. Historicamente este código passava `--total-steps`, que
  // NÃO existe no Brush (o nome real é `--total-train-iters`). Como o clap aborta
  // com erro em flag desconhecida, a chamada inteira falhava e caía no fallback
  // "modo padrão" — que roda o Brush SEM contagem de passos. Resultado: o preset
  // de qualidade escolhido pelo usuário (50k/75k/100k) era silenciosamente
  // ignorado e o treino sempre rodava o padrão do Brush (30k). Era a maior causa
  // de "a qualidade não melhora mesmo aumentando os passos".
  // Agora lemos o --help da build instalada e usamos os nomes que ela aceita.
  const help = await captureHelp(tools.brush);
  const has = flag => help.includes(flag);
  const knowsFlags = has('--export-path'); // sanity: o --help foi lido mesmo?
  const stepsFlag = has('--total-train-iters') ? '--total-train-iters'
                  : has('--total-steps') ? '--total-steps' : null;

  const args = [work];
  if (stepsFlag) args.push(stepsFlag, String(opts.steps));
  else if (knowsFlags) report('train', '⚠️ Esta build do Brush não expõe a flag de número de passos; ela vai usar o padrão dela.');
  args.push('--export-every', String(every), '--export-path', exportDir, '--export-name', 'passo_{iter}.ply');

  // Mip-Splatting: o Brush já traz isso embutido (`--render-mode mip`), mas o app
  // nunca ativava — treinava sempre no modo Default. O modo Mip aplica o filtro
  // passa-baixa dependente do footprint do splat na tela, que é justamente o que
  // remove o "shimmering" ao mover a câmera e melhora nitidez ao afastar/zoom.
  if (has('--render-mode')) {
    args.push('--render-mode', 'mip');
    report('train', '✨ Mip-Splatting ativado (anti-aliasing por footprint) — menos shimmering e mais nitidez a distância.');
  }

  // TETO DE RESOLUÇÃO ESCONDIDO: o Brush tem `--max-resolution` com padrão 1920 e
  // reduz qualquer imagem acima disso ao CARREGAR o dataset. Como o app nunca
  // passava essa flag, extrair frames em 4K não adiantava nada — o Brush
  // silenciosamente treinava a 1920 mesmo assim. Agora informamos a resolução
  // escolhida pelo usuário, então 2.5K/4K realmente chegam ao treino.
  if (has('--max-resolution')) {
    const maxRes = Math.max(256, Math.round(opts.maxSize || 1600));
    args.push('--max-resolution', String(maxRes));
    if (maxRes > 1920) report('train', `🔍 Treinando em alta resolução (${maxRes}px no lado maior). Isso usa bem mais VRAM e tempo — se faltar memória, reduza o FPS de extração ou a resolução.`);
  }

  // Nitidez extra (LPIPS): perda perceptual baseada numa VGG — compara as imagens
  // pelo que o olho percebe em vez de pixel a pixel. O Brush traz isso embutido
  // (crate `lpips`, sem download em runtime) mas com peso padrão 0.0, ou seja,
  // desligado. Só entra se o usuário escolher explicitamente, porque encarece o
  // treino e muda a métrica (atrapalha comparações A/B).
  // Obs.: no Brush o LPIPS só roda em desktop — em WASM ele é ignorado.
  const lpips = Number(opts.lpips) || 0;
  if (lpips > 0 && has('--lpips-loss-weight')) {
    args.push('--lpips-loss-weight', String(lpips));
    report('train', `🔎 Nitidez extra (LPIPS ${lpips}) ativada — treino mais lento, textura fina mais definida.`);
  } else if (lpips > 0) {
    report('train', '⚠️ Esta build do Brush não suporta a nitidez extra (LPIPS); seguindo sem ela.');
  }

  // O padrão de `growth_stop_iter` do Brush é 15000 e NÃO acompanha o total de
  // passos: num treino de 100k, a densificação parava com 15% do caminho andado e
  // os outros 85k passos só refinavam um conjunto de Gaussians que já tinha
  // parado de crescer. Escalar com o total é o que faz "mais passos" virar de
  // fato "mais qualidade".
  if (has('--growth-stop-iter')) {
    const growthStop = Math.max(15000, Math.round(opts.steps * 0.5));
    args.push('--growth-stop-iter', String(growthStop));
    report('train', `📈 Densificação ativa até o passo ${growthStop} (escalada com o total de ${opts.steps}).`);
  }
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
  // Registra a linha de comando final no log. Sem isso não dá pra saber, olhando
  // o log de um treino, se os parâmetros de qualidade realmente foram aplicados ou
  // se caiu no fallback — que foi exatamente como o bug do `--total-steps` passou
  // despercebido por tanto tempo.
  report('train', '▶ Brush: ' + args.slice(1).join(' '));

  try {
    await run(tools.brush, args, work, l => reportP(report, 'train', l));
  } catch (e) {
    // Este fallback roda o Brush sem NENHUM ajuste — inclusive sem o número de
    // passos escolhido. Antes ele era silencioso e mascarava exatamente o bug do
    // `--total-steps`; agora avisa em alto e bom som que a qualidade vai ser a
    // padrão do Brush, não a que o usuário pediu.
    report('train', '⚠️ O Brush recusou os parâmetros de qualidade: ' + e.message);
    report('train', '⚠️ Rodando no modo padrão do Brush — o preset de qualidade escolhido NÃO será aplicado. Atualize o Brush para a versão mais recente.');
    await run(tools.brush, [work, '--export-path', exportDir], work, l => reportP(report, 'train', l));
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

/**
 * Etapa 3 alternativa: Triangle Splatting (malha de triângulos em vez de Gaussians).
 *
 * Consome o MESMO projeto COLMAP dos outros motores, então não exige refazer o
 * alinhamento. A saída, porém, é diferente: uma malha .off (COFF) com cor por face,
 * não um .ply de Gaussians. Isso significa que ela abre em Blender/Unity/Unreal e
 * pode ser carregada como geometria comum no navegador — mas NÃO abre nos
 * visualizadores de splat, incluindo o modo padrão do WebEDIT.
 */
async function trainTriangleSplat(tools, opts, report) {
  if (!tools.trianglePython || !tools.triangleRepo) throw new Error('Ambiente do Triangle Splatting não foi preparado.');
  const work = opts.workDir;
  if (!fs.existsSync(path.join(work, 'sparse', '0'))) {
    throw new Error('Triangle Splatting precisa do modelo COLMAP em sparse/0. Use o alinhamento COLMAP.');
  }
  const exportDir = path.join(work, 'triangle_export');
  fs.mkdirSync(exportDir, { recursive: true });

  report('train', 'Treinando Triangle Splatting (malha de triângulos)…');
  report('train', 'ℹ️ A saída é uma malha .off, não um .ply de Gaussians — abre em Blender/Unity/Unreal.');

  const t0 = Date.now();
  const mon = setInterval(() => {
    report('train', `⏱ ${((Date.now() - t0) / 60000).toFixed(1)} min — treinando triângulos…`);
  }, 15000);

  const args = [modelScript('trianglesplat_train.py'),
    '--repo', tools.triangleRepo,
    '--source', work,
    '--output', exportDir,
    '--iterations', String(opts.steps || 30000),
    '--mesh-name', 'malha.off'];
  // Cenas externas usam hiperparâmetros próprios no repositório oficial.
  if (opts.outdoor) args.push('--outdoor');

  try { await run(tools.trianglePython, args, work, l => reportP(report, 'train', l)); }
  finally { clearInterval(mon); }

  const mesh = path.join(exportDir, 'malha.off');
  if (!fs.existsSync(mesh)) throw new Error('Triangle Splatting terminou sem gerar a malha .off. Confira o log acima.');
  return mesh;
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

module.exports = { prepareDataset, prepareDatasetMast3r, prepareDatasetMegaSam, trainSplat, trainPpisp, trainTriangleSplat, train3dgrut, setProcessTracker, parseLineProgress, reportP };
