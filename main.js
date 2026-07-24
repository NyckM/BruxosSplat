// main.js — processo principal do Electron
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { ensureTools } = require('./downloader');
const { installModel, runModel, ensureSplat4dCli, ensureConvertDeps, MODELS } = require('./envman');
const { prepareDataset, trainSplat } = require('./pipeline');
const { prepareDatasetDPVO } = require('./dpvo');

let win, serverPort = 0, lastPly = null, previewPly = null, previewCams = null, preparedDir = null, trainPly = null;
let lastPlyFormat = 'ply'; // 'ply' | 'splat' | 'ksplat' — formato real do arquivo carregado (server sempre serve como /scene.ply)
let seq4d = []; // sequência 4D atual: [{ path, format }], usada pela timeline

// ordena "frame_2.ply" antes de "frame_10.ply" (ordem numérica, não alfabética)
function naturalSort(a, b) {
  const ax = a.match(/\d+|\D+/g) || [], bx = b.match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const av = ax[i] || '', bv = bx[i] || '';
    const an = parseInt(av, 10), bn = parseInt(bv, 10);
    if (!isNaN(an) && !isNaN(bn) && an !== bn) return an - bn;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

// Servidor local para o viewer (index.html do 3dGS_WebEDIT) carregar o .ply
function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/scene.ply') && lastPly) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/octet-stream');
      const stat = fs.statSync(lastPly);
      const range = req.headers.range;
      if (range) {
        const [s, e] = range.replace('bytes=', '').split('-');
        const start = parseInt(s, 10), end = e ? parseInt(e, 10) : stat.size - 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1
        });
        fs.createReadStream(lastPly, { start, end }).pipe(res);
      } else {
        res.setHeader('Content-Length', stat.size);
        fs.createReadStream(lastPly).pipe(res);
      }
    } else if (req.url.startsWith('/webedit/')) {
      const CT = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.png': 'image/png', '.css': 'text/css' };
      const rel = decodeURIComponent(req.url.slice('/webedit/'.length).split('?')[0]) || 'index.html';
      const file = path.join(WEBEDIT_DIR(), rel || 'index.html');
      if (fs.existsSync(file) && file.startsWith(WEBEDIT_DIR())) {
        res.setHeader('Content-Type', CT[path.extname(file)] || 'application/octet-stream');
        // No index.html o script principal é um <script type="module">, então loadSequence não é global.
        // Injetamos o suporte a ?seq= DENTRO do módulo, ao lado do ?url= que já existe, pra abrir a
        // sequência 4D inteira por link (o WebEDIT do repo só sabe abrir 1 arquivo via ?url=).
        if (path.basename(file).toLowerCase() === 'index.html') {
          let html = fs.readFileSync(file, 'utf8');
          const seqInject = "if (params.has('seq')) {\n"
            + "  const _urls = params.get('seq').split(',').filter(Boolean);\n"
            + "  const _fmts = (params.get('fmt') || '').split(',');\n"
            + "  Promise.all(_urls.map((u, i) => fetch(u).then(r => r.arrayBuffer()).then(b => new File([b], 'frame_' + String(i).padStart(5,'0') + '.' + (_fmts[i] || 'ply'))))).then(fl => loadSequence(fl)).catch(e => showError('Erro na sequência: ' + e));\n"
            + "} else if (params.has('url')) {";
          if (html.includes("if (params.has('url')) {")) html = html.replace("if (params.has('url')) {", seqInject);
          res.end(html);
        } else {
          fs.createReadStream(file).pipe(res);
        }
      } else { res.statusCode = 404; res.end('WebEDIT ainda não baixado — abra o app com internet uma vez.'); }
    } else if (req.url.startsWith('/train.ply') && trainPly) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/octet-stream');
      fs.createReadStream(trainPly).pipe(res);
    } else if (req.url.startsWith('/points.ply') && previewPly) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/octet-stream');
      fs.createReadStream(previewPly).pipe(res);
    } else if (req.url.startsWith('/cameras.json') && previewCams) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(previewCams));
    } else if (req.url.startsWith('/seq4d/')) {
      const i = parseInt(req.url.slice('/seq4d/'.length).split('?')[0], 10);
      const frame = seq4d[i];
      if (!frame || !fs.existsSync(frame.path)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/octet-stream');
      fs.createReadStream(frame.path).pipe(res);
    } else { res.statusCode = 404; res.end(); }
  });
  server.listen(0, '127.0.0.1', () => { serverPort = server.address().port; });
}

const WEBEDIT_BASE = 'https://raw.githubusercontent.com/NyckM/3dGS_WebEDIT/main/';
const WEBEDIT_FILES = ['index.html', 'support.js', 'Bruxos.png', 'criar.html', 'player4d.html'];
const WEBEDIT_DIR = () => path.join(app.getPath('userData'), 'webedit');
let webEditReady = null;

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const https2 = require('https');
    const get = u => https2.get(u, { headers: { 'User-Agent': 'BruxoSplat' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return get(res.headers.location);
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' em ' + u));
      const f = fs.createWriteStream(dest);
      res.pipe(f); f.on('finish', () => f.close(resolve));
    }).on('error', reject);
    get(url);
  });
}

async function ensureWebEdit(report) {
  const dir = WEBEDIT_DIR();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of WEBEDIT_FILES) {
    const dest = path.join(dir, name);
    if (fs.existsSync(dest)) continue;
    report && report('Baixando WebEDIT (seu site): ' + name + '…');
    try { await downloadFile(WEBEDIT_BASE + name, dest); }
    catch (e) { report && report('Aviso: falhou baixar ' + name + ' (' + e.message + ')'); }
  }
}

async function syncWebEdit(report) {
  try { fs.rmSync(WEBEDIT_DIR(), { recursive: true, force: true }); } catch {}
  await ensureWebEdit(report);
}

const LOGO_URL = 'https://nyckm.github.io/3dGS_WebEDIT/Bruxos.png';
const LOGO_PATH = () => path.join(app.getPath('userData'), 'Bruxos.png');
function ensureLogo(cb) {
  if (fs.existsSync(LOGO_PATH())) return cb(LOGO_PATH());
  const https2 = require('https');
  const get = url => https2.get(url, { headers: { 'User-Agent': 'BruxoSplat' } }, res => {
    if (res.statusCode >= 300 && res.statusCode < 400) return get(res.headers.location);
    if (res.statusCode !== 200) return cb(null);
    const f = fs.createWriteStream(LOGO_PATH());
    res.pipe(f); f.on('finish', () => f.close(() => cb(LOGO_PATH())));
  }).on('error', () => cb(null));
  get(LOGO_URL);
}

// ── Idioma (persistido em settings.json) ──
const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8')); } catch (e) { return {}; }
}
function saveSettings(s) {
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(s)); } catch (e) {}
}
let currentLang = (loadSettings().lang === 'en') ? 'en' : 'pt';

const MENU_I18N = {
  pt: {
    file: 'Arquivo', new: 'Novo', open: 'Abrir .ply/.splat/.ksplat…', open4d: 'Abrir sequência 4D (pasta)…', save: 'Salvar .ply', saveCompact: 'Salvar compacto',
    import: 'Importar vídeos…', quit: 'Sair',
    edit: 'Editar', undo: 'Desfazer', redo: 'Refazer', delete: 'Excluir seleção',
    crop: 'Crop (manter seleção)', center: 'Centralizar', clean: 'Limpeza (floaters)',
    window: 'Janela', fullscreen: 'Tela cheia', devtools: 'DevTools',
    help: 'Ajuda', github: 'GitHub — 3dGS_WebEDIT', syncWebEdit: 'Sincronizar WebEDIT (buscar versão mais nova)',
    syncDone: '✅ WebEDIT sincronizado com o GitHub.',
    about: 'Sobre o BruxoSplat', aboutTitle: 'Sobre o BruxoSplat',
    aboutDetail: 'App gratuito de 3DGS\nCriado por Nyck Maftum da Bruxos do VFX\n\ngithub.com/NyckM/3dGS_WebEDIT'
  },
  en: {
    file: 'File', new: 'New', open: 'Open .ply/.splat/.ksplat…', open4d: 'Open 4D sequence (folder)…', save: 'Save .ply', saveCompact: 'Save compact',
    import: 'Import videos…', quit: 'Quit',
    edit: 'Edit', undo: 'Undo', redo: 'Redo', delete: 'Delete selection',
    crop: 'Crop (keep selection)', center: 'Center', clean: 'Cleanup (floaters)',
    window: 'Window', fullscreen: 'Fullscreen', devtools: 'DevTools',
    help: 'Help', github: 'GitHub — 3dGS_WebEDIT', syncWebEdit: 'Sync WebEDIT (fetch latest version)',
    syncDone: '✅ WebEDIT synced from GitHub.',
    about: 'About BruxoSplat', aboutTitle: 'About BruxoSplat',
    aboutDetail: 'Free 3DGS app\nCreated by Nyck Maftum from Bruxos do VFX\n\ngithub.com/NyckM/3dGS_WebEDIT'
  }
};

function buildMenu(lang) {
  const t = MENU_I18N[lang] || MENU_I18N.pt;
  const send2 = (a) => win.webContents.send('menu', a);
  const isMac = process.platform === 'darwin';
  const quitAccel = isMac ? 'Command+Q' : 'Alt+F4';
  const template = [
    // no macOS, o 1º menu precisa ser o nome do app (About/Services/Hide/Quit) — sem isso o app parece "quebrado"
    ...(isMac ? [{
      label: 'BruxoSplat',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    { label: t.file, submenu: [
      { label: t.new, accelerator: 'CommandOrControl+N', click: () => send2('new') },
      { label: t.open, accelerator: 'CommandOrControl+O', click: () => send2('open') },
      { label: t.open4d, click: () => send2('open4d') },
      { type: 'separator' },
      { label: t.save, accelerator: 'CommandOrControl+S', click: () => send2('save') },
      { label: t.saveCompact, accelerator: 'CommandOrControl+Shift+S', click: () => send2('savecompact') },
      { type: 'separator' },
      { label: t.import, accelerator: 'CommandOrControl+I', click: () => send2('import') },
      { type: 'separator' },
      { label: t.quit, accelerator: quitAccel, role: 'quit' }
    ]},
    { label: t.edit, submenu: [
      { label: t.undo, accelerator: 'CommandOrControl+Z', click: () => send2('undo') },
      { label: t.redo, accelerator: 'CommandOrControl+Shift+Z', click: () => send2('redo') },
      { type: 'separator' },
      { label: t.delete, accelerator: 'Delete', click: () => send2('delete') },
      { label: t.crop, click: () => send2('crop') },
      { label: t.center, click: () => send2('center') },
      { label: t.clean, click: () => send2('clean') }
    ]},
    { label: t.window, submenu: [
      { label: t.fullscreen, accelerator: isMac ? 'Control+Command+F' : 'F11', click: () => win.setFullScreen(!win.isFullScreen()) },
      { label: t.devtools, accelerator: isMac ? 'Alt+Command+I' : 'F12', click: () => win.webContents.toggleDevTools() }
    ]},
    { label: t.help, submenu: [
      { label: t.github, click: () => shell.openExternal('https://github.com/NyckM/3dGS_WebEDIT') },
      { label: t.syncWebEdit, click: () => {
          webEditReady = syncWebEdit(l => send('status', { stage: 'setup', line: l }));
          webEditReady.then(() => send('status', { stage: 'setup', line: t.syncDone }));
        } },
      { type: 'separator' },
      { label: t.about, click: () => ensureLogo(p2 => dialog.showMessageBox(win, {
          type: 'none',
          icon: p2 ? nativeImage.createFromPath(p2) : undefined,
          title: t.aboutTitle,
          message: 'BruxoSplat',
          detail: t.aboutDetail
        })) }
    ]}
  ];
  return Menu.buildFromTemplate(template);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820,
    title: 'BruxoSplat — Bruxos do VFX',
    backgroundColor: '#0d0b14',
    // backgroundThrottling:false — sem isso o Chromium do Electron congela timers/rAF/WebGL quando a
    // janela fica minimizada ou atrás de outra, e o carregamento da sequência 4D trava em segundo plano.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false }
  });
  Menu.setApplicationMenu(buildMenu(currentLang));
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

ipcMain.handle('get-lang', () => currentLang);
ipcMain.handle('set-lang', (_e, lang) => {
  currentLang = (lang === 'en') ? 'en' : 'pt';
  saveSettings({ ...loadSettings(), lang: currentLang });
  Menu.setApplicationMenu(buildMenu(currentLang));
  return currentLang;
});

app.whenReady().then(() => {
  startServer();
  createWindow();
  webEditReady = ensureWebEdit(l => send('status', { stage: 'setup', line: l }));
});
// no macOS o padrão é o app continuar rodando (no Dock) com todas as janelas fechadas, até Cmd+Q;
// clicar no ícone do Dock sem janelas abertas deve reabrir uma.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

const send = (ch, data) => win && win.webContents.send(ch, data);

ipcMain.handle('pick-video', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Escolha o vídeo',
    filters: [{ name: 'Vídeos', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'] }],
    properties: ['openFile', 'multiSelections']
  });
  return r.canceled ? null : r.filePaths;
});

async function getTools() {
  send('status', { stage: 'setup', line: 'Verificando ferramentas…' });
  return ensureTools((line, prog) => send('status', { stage: 'setup', line, prog }));
}

function nextSplatName(dir) {
  let max = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^BruxoSplat_(\d{4,})\.ply$/i);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch {}
  return 'BruxoSplat_' + String(max + 1).padStart(4, '0') + '.ply';
}

function sendPreview() {
  send('preview', {
    points: `http://127.0.0.1:${serverPort}/points.ply`,
    cameras: `http://127.0.0.1:${serverPort}/cameras.json`
  });
}

async function doAlign(opts) {
  const tools = await getTools();
  const workDir = path.join(app.getPath('userData'), 'projects', 'proj_' + Date.now());
  const prepare = opts.alignMethod === 'dpvo' ? prepareDatasetDPVO : prepareDataset;
  await prepare(tools, { ...opts, workDir },
    (stage, line) => send('status', { stage, line }),
    prev => {
      previewPly = prev.pointsPly;
      previewCams = parseImagesTxt(prev.imagesTxt);
      try {
        const nImgs = fs.readdirSync(path.join(workDir, 'images')).length;
        const pct = Math.round(100 * previewCams.length / nImgs);
        send('status', { stage: 'colmap', line: `Câmeras alinhadas: ${previewCams.length}/${nImgs} (${pct}%)` });
        if (pct < 70) send('status', { stage: 'colmap',
          line: `⚠️ Só ${pct}% das imagens foram alinhadas — a qualidade vai sofrer. Diminua o intervalo (ex.: 0.25s) para mais sobreposição, ou grave mais devagar.` });
      } catch {}
      sendPreview();
    });
  preparedDir = workDir;
  return tools;
}

ipcMain.handle('align', async (_e, opts) => {
  try {
    await doAlign(opts);
    send('aligned', {});
    return { ok: true };
  } catch (err) { send('error', { message: err.message }); return { ok: false }; }
});

ipcMain.handle('train', async (_e, opts) => {
  try {
    let tools;
    if (!preparedDir || opts.forceAlign) tools = await doAlign(opts);
    else tools = await getTools();
    const ply = await trainSplat(tools, { workDir: preparedDir, steps: opts.steps },
      (stage, line, prog) => send('status', { stage, line, prog }),
      (snapPath, prog) => {
        trainPly = snapPath;
        send('trainsnap', { url: `http://127.0.0.1:${serverPort}/train.ply?t=` + Date.now(), prog });
      });
    const outDir = opts.outDir || path.join(app.getPath('documents'), 'BruxoSplat');
    fs.mkdirSync(outDir, { recursive: true });
    const outPly = path.join(outDir, nextSplatName(outDir));
    fs.copyFileSync(ply, outPly);
    lastPly = outPly;
    await webEditReady;
    send('done', { ply: outPly, viewerUrl: `http://127.0.0.1:${serverPort}/webedit/index.html?url=http://127.0.0.1:${serverPort}/scene.ply` });
    return { ok: true, ply: outPly };
  } catch (err) { send('error', { message: err.message }); return { ok: false }; }
});

// Converte images.txt do COLMAP em lista de centros/orientações de câmera
function parseImagesTxt(file) {
  const cams = [];
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l || l.startsWith('#')) continue;
      const f = l.split(/\s+/);
      if (f.length >= 10 && /^\d+$/.test(f[0])) {
        const [qw, qx, qy, qz, tx, ty, tz] = f.slice(1, 8).map(Number);
        // Centro da câmera no mundo: C = -R^T t
        const R = [
          [1-2*(qy*qy+qz*qz), 2*(qx*qy-qw*qz),   2*(qx*qz+qw*qy)],
          [2*(qx*qy+qw*qz),   1-2*(qx*qx+qz*qz), 2*(qy*qz-qw*qx)],
          [2*(qx*qz-qw*qy),   2*(qy*qz+qw*qx),   1-2*(qx*qx+qy*qy)]
        ];
        cams.push({
          name: f[9],
          pos: [
            -(R[0][0]*tx + R[1][0]*ty + R[2][0]*tz),
            -(R[0][1]*tx + R[1][1]*ty + R[2][1]*tz),
            -(R[0][2]*tx + R[1][2]*ty + R[2][2]*tz)
          ],
          dir: [R[2][0], R[2][1], R[2][2]] // eixo +Z da câmera no mundo
        });
        i++; // pula a linha de points2D
      }
    }
    cams.sort((a, b) => a.name.localeCompare(b.name));
  } catch {}
  return cams;
}

ipcMain.handle('open-ply', async () => {
  const r = await dialog.showOpenDialog(win, {
    filters: [
      { name: 'Splats (.ply, .splat, .ksplat)', extensions: ['ply', 'splat', 'ksplat'] },
      { name: 'Splat PLY', extensions: ['ply'] },
      { name: 'Splat (antimatter15)', extensions: ['splat'] },
      { name: 'KSplat (GaussianSplats3D)', extensions: ['ksplat'] }
    ],
    properties: ['openFile']
  });
  if (r.canceled) return null;
  lastPly = r.filePaths[0];
  lastPlyFormat = path.extname(lastPly).slice(1).toLowerCase() || 'ply';
  await webEditReady;
  return {
    path: lastPly,
    format: lastPlyFormat, // 'ply' | 'splat' | 'ksplat' — o editor de pontos (gizmo) só entende 'ply'
    viewerUrl: `http://127.0.0.1:${serverPort}/webedit/index.html?url=http://127.0.0.1:${serverPort}/scene.ply`
  };
});

// pasta com uma sequência de frames (.ply/.splat/.ksplat) — vídeo 4D / rosto 4D / qualquer splat animado
ipcMain.handle('pick-4d-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled) return null;
  const dir = r.filePaths[0];
  const exts = ['.ply', '.splat', '.ksplat'];
  const files = fs.readdirSync(dir)
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .sort(naturalSort);
  if (!files.length) return { error: 'Nenhum .ply/.splat/.ksplat encontrado nessa pasta.' };
  seq4d = files.map(f => ({ path: path.join(dir, f), format: path.extname(f).slice(1).toLowerCase() }));
  return { count: seq4d.length, names: files, formats: seq4d.map(f => f.format), dir, base: `http://127.0.0.1:${serverPort}` };
});

// exporta a sequência 4D atualmente carregada como arquivos soltos numa pasta de destino
ipcMain.handle('export-seq4d', async () => {
  if (!seq4d.length) return { error: 'Nenhuma sequência 4D carregada.' };
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Escolha a pasta de destino' });
  if (r.canceled) return null;
  const destDir = r.filePaths[0];
  const pad = String(seq4d.length).length;
  seq4d.forEach((f, i) => {
    const name = 'frame_' + String(i).padStart(Math.max(4, pad), '0') + '.' + f.format;
    fs.copyFileSync(f.path, path.join(destDir, name));
  });
  return { ok: true, dir: destDir, count: seq4d.length };
});

// empacota a sequência 4D atual num único .splat4d (streaming) via o CLI splat4d (splats4D, adamraudonis)
// só funciona com frames .splat — .ply/.ksplat precisariam de conversão antes, ainda não implementada
ipcMain.handle('export-splat4d', async () => {
  if (!seq4d.length) return { error: 'Nenhuma sequência 4D carregada.' };
  if (seq4d.some(f => f.format !== 'splat')) return { error: 'Exportar .splat4d só funciona com frames .splat (ex: saída do FaceAnything). Essa sequência tem outro formato.' };
  const r = await dialog.showSaveDialog(win, { defaultPath: 'cena.splat4d', filters: [{ name: 'Splat4D', extensions: ['splat4d'] }] });
  if (r.canceled) return null;
  try {
    const exe = await ensureSplat4dCli(l => send('status', { stage: 'setup', line: l }));
    const framesDir = path.dirname(seq4d[0].path);
    const { spawn } = require('child_process');
    await new Promise((resolve, reject) => {
      const p = spawn(exe, ['encode', '-i', framesDir, '-o', r.filePath], { windowsHide: true });
      const feed = d => d.toString().split(/\r?\n/).forEach(l => l.trim() && send('status', { stage: 'train', line: l.trim() }));
      p.stdout.on('data', feed); p.stderr.on('data', feed);
      p.on('error', reject);
      p.on('close', c => c === 0 ? resolve() : reject(new Error('splat4d encode saiu com código ' + c)));
    });
    return { ok: true, path: r.filePath };
  } catch (err) { send('error', { message: err.message }); return { error: err.message }; }
});

// converte a sequência 4D atual (.ply, ex: saída do SHARP) pra .splat compacto (~4x menor, parse bem mais
// rápido) e recarrega ela já convertida. Deixa a sequência muito mais leve pra abrir e tocar.
ipcMain.handle('convert-seq-splat', async () => {
  if (!seq4d.length) return { error: 'Nenhuma sequência 4D carregada.' };
  const plyFrames = seq4d.filter(f => f.format === 'ply');
  if (!plyFrames.length) return { error: 'A sequência já está em .splat/.ksplat — nada pra converter.' };
  try {
    const py = await ensureConvertDeps(l => send('status', { stage: 'setup', line: l }));
    const srcDir = path.dirname(seq4d[0].path);
    const outDir = path.join(app.getPath('userData'), 'seq_splat', 'conv_' + Date.now());
    fs.mkdirSync(outDir, { recursive: true });
    const script = path.join(__dirname, 'models', 'ply2splat.py');
    const { spawn } = require('child_process');
    await new Promise((resolve, reject) => {
      const p = spawn(py, [script, '--input', srcDir, '--output', outDir], { windowsHide: true });
      const feed = d => d.toString().split(/\r?\n/).forEach(l => l.trim() && send('status', { stage: 'train', line: l.trim() }));
      p.stdout.on('data', feed); p.stderr.on('data', feed);
      p.on('error', reject);
      p.on('close', c => c === 0 ? resolve() : reject(new Error('conversão saiu com código ' + c)));
    });
    const files = fs.readdirSync(outDir).filter(f => f.toLowerCase().endsWith('.splat')).sort(naturalSort);
    if (!files.length) return { error: 'Conversão não gerou nenhum .splat.' };
    seq4d = files.map(f => ({ path: path.join(outDir, f), format: 'splat' }));
    return { count: seq4d.length, names: files, formats: seq4d.map(f => f.format), dir: outDir, base: `http://127.0.0.1:${serverPort}` };
  } catch (err) { send('error', { message: err.message }); return { error: err.message }; }
});

ipcMain.handle('save-ply', async (_e, buf, name) => {
  const outDir = path.dirname(lastPly || path.join(app.getPath('documents'), 'BruxoSplat', 'x'));
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, name || nextSplatName(outDir));
  fs.writeFileSync(out, Buffer.from(buf));
  lastPly = out;
  await webEditReady;
  return { path: out, viewerUrl: `http://127.0.0.1:${serverPort}/webedit/index.html?url=http://127.0.0.1:${serverPort}/scene.ply` };
});

ipcMain.handle('model-list', () => Object.entries(MODELS).map(([k, m]) => ({ key: k, name: m.name, sizeHint: m.sizeHint })));
ipcMain.handle('model-install', async (_e, key) => {
  try { await installModel(key, l => send('status', { stage: 'setup', line: l })); return { ok: true }; }
  catch (err) { send('error', { message: err.message }); return { ok: false }; }
});
ipcMain.handle('model-run', async (_e, key, input) => {
  try {
    await installModel(key, l => send('status', { stage: 'setup', line: l }));
    const outDir = path.join(app.getPath('documents'), 'BruxoSplat', key + '_' + Date.now());
    send('status', { stage: 'train', line: 'Rodando ' + MODELS[key].name + '…' });
    await runModel(key, { input, outDir }, l => send('status', { stage: 'train', line: l }));
    send('status', { stage: 'train', line: '✅ Saída em: ' + outDir });
    // se gerou .ply, abre no editor
    const plys = fs.readdirSync(outDir).filter(f => /\.ply$/i.test(f));
    if (plys.length) {
      lastPly = path.join(outDir, plys[0]);
      await webEditReady;
      send('done', { ply: lastPly, viewerUrl: `http://127.0.0.1:${serverPort}/webedit/index.html?url=http://127.0.0.1:${serverPort}/scene.ply` });
    } else send('aligned', {});
    return { ok: true, outDir };
  } catch (err) { send('error', { message: err.message }); return { ok: false }; }
});
ipcMain.handle('model-run-sharp4d', async (_e, video, interval) => {
  try {
    const tools = await ensureTools((line, prog) => send('status', { stage: 'setup', line, prog }));
    await installModel('sharp', l => send('status', { stage: 'setup', line: l }));
    const base = path.join(app.getPath('documents'), 'BruxoSplat', 'sharp4d_' + Date.now());
    const framesDir = path.join(base, 'frames');
    const seqDir = path.join(base, 'sequencia');
    fs.mkdirSync(framesDir, { recursive: true });
    fs.mkdirSync(seqDir, { recursive: true });

    // 1) extrai frames
    send('status', { stage: 'frames', line: 'Extraindo frames do vídeo…' });
    const iv = Math.max(1 / 60, parseFloat(interval) || 0.5); // piso de 1/60s — antes travava em 0.05s (20fps no máx)
    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const pr = spawn(tools.ffmpeg, ['-i', video, '-vf', `fps=1/${iv}`, '-q:v', '2',
        path.join(framesDir, 'frame_%04d.jpg')], { windowsHide: true });
      pr.stderr.on('data', d => send('status', { stage: 'frames', line: d.toString().split('\n')[0] }));
      pr.on('close', c => c === 0 ? resolve() : reject(new Error('ffmpeg saiu com código ' + c)));
      pr.on('error', reject);
    });
    const frames = fs.readdirSync(framesDir).filter(f => /\.jpg$/i.test(f)).sort();
    if (!frames.length) throw new Error('Nenhum frame extraído.');

    // 2) SHARP em cada frame
    for (let i = 0; i < frames.length; i++) {
      send('status', { stage: 'train', line: `SHARP frame ${i + 1}/${frames.length}…`, prog: i / frames.length });
      const outI = path.join(base, 'out_' + i);
      await runModel('sharp', { input: path.join(framesDir, frames[i]), outDir: outI },
        l => send('status', { stage: 'train', line: `[${i + 1}/${frames.length}] ` + l }));
      const plys = fs.existsSync(outI) ? fs.readdirSync(outI).filter(f => /\.ply$/i.test(f)) : [];
      if (plys.length) fs.copyFileSync(path.join(outI, plys[0]), path.join(seqDir, 'frame_' + String(i).padStart(4, '0') + '.ply'));
    }
    const seq = fs.readdirSync(seqDir).filter(f => /\.ply$/i.test(f)).sort(naturalSort);
    if (!seq.length) throw new Error('Nenhum frame gerado pelo SHARP.');
    lastPly = path.join(seqDir, seq[0]);
    seq4d = seq.map(f => ({ path: path.join(seqDir, f), format: 'ply' }));
    send('status', { stage: 'train', line: `✅ Sequência 4D pronta: ${seq4d.length} frames em ${seqDir}` });
    // igual ao FaceAnything: abre direto na timeline 4D em vez de só carregar o 1º frame como ponto estático
    send('done4d', { count: seq4d.length, names: seq, formats: seq4d.map(f => f.format), dir: seqDir, base: `http://127.0.0.1:${serverPort}` });
    return { ok: true, seqDir };
  } catch (err) { send('error', { message: err.message }); return { ok: false }; }
});

// FaceAnything (kocasariumut/FaceAnything): vídeo do rosto -> sequência de .splat (rosto em 4D).
// Saída NÃO é .ply (é o formato .splat, que o player4d do WebEDIT usa) — por isso não tenta abrir
// no editor interno (que só entende .ply); só abre a pasta pra arrastar no player4d.
ipcMain.handle('model-run-faceanything', async (_e, video, maxFrames) => {
  try {
    await installModel('faceanything', l => send('status', { stage: 'setup', line: l }));
    const outDir = path.join(app.getPath('documents'), 'BruxoSplat', 'faceanything4d_' + Date.now());
    fs.mkdirSync(outDir, { recursive: true });
    send('status', { stage: 'train', line: 'Reconstruindo rosto em 4D (pode demorar bastante)…' });
    await runModel('faceanything', { input: video, outDir, maxFrames: maxFrames || 60 },
      l => send('status', { stage: 'train', line: l }));
    const frames = fs.readdirSync(outDir).filter(f => /\.splat$/i.test(f)).sort(naturalSort);
    if (!frames.length) throw new Error('Nenhum frame gerado.');
    lastPly = path.join(outDir, frames[0]);
    seq4d = frames.map(f => ({ path: path.join(outDir, f), format: 'splat' }));
    send('status', { stage: 'train', line: `✅ ${frames.length} frames (.splat) em: ${outDir}` });
    // avisa a UI pra oferecer carregar direto na timeline 4D (ou exportar) em vez de só abrir a pasta
    send('done4d', { count: seq4d.length, names: frames, formats: seq4d.map(f => f.format), dir: outDir, base: `http://127.0.0.1:${serverPort}` });
    shell.showItemInFolder(lastPly);
    return { ok: true, outDir, frameCount: frames.length };
  } catch (err) { send('error', { message: err.message }); return { ok: false }; }
});

ipcMain.handle('pick-image', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Imagens', extensions: ['jpg','jpeg','png','webp'] }], properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('open-folder', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('pick-outdir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
