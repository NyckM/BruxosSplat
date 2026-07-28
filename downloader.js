// downloader.js — baixa e extrai as ferramentas (ffmpeg, COLMAP, Brush) no primeiro uso.
// Windows: baixa binários prontos (zip) direto. macOS: ffmpeg/COLMAP não têm zip oficial confiável
// pra baixar sozinho — usa Homebrew (padrão do ecossistema Mac); Brush continua vindo da API do GitHub
// (mesma lógica nos dois SOs, só muda o filtro do nome do arquivo).
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, execFileSync, spawnSync } = require('child_process');
const extract = require('extract-zip');

const IS_MAC = process.platform === 'darwin';
const TOOLS_DIR = () => path.join(app.getPath('userData'), 'tools');

const URLS = {
  ffmpeg: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  colmapCuda: 'https://github.com/colmap/colmap/releases/latest/download/colmap-x64-windows-cuda.zip',
  colmapNoCuda: 'https://github.com/colmap/colmap/releases/latest/download/colmap-x64-windows-nocuda.zip',
  // A release do Brush é resolvida via API do GitHub (nome do asset muda por versão e por SO)
  brushApi: 'https://api.github.com/repos/ArthurBrussee/brush/releases/latest'
};

function hasNvidiaGpu() {
  try { execSync('nvidia-smi', { stdio: 'ignore' }); return true; } catch { return false; }
}

function which(cmd) {
  try {
    const out = execFileSync(IS_MAC ? 'which' : 'where', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return out.split('\n')[0].trim() || null;
  } catch { return null; }
}

function hasBrew() { return !!which('brew'); }

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'BruxoSplat' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location, dest, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} em ${url}`));
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0, lastT = Date.now(), lastGot = 0;
      const file = fs.createWriteStream(dest);
      res.on('data', c => {
        got += c.length;
        const now = Date.now();
        if (onProgress && now - lastT >= 1000) { // no máx. 1 update/segundo
          const speed = (got - lastGot) / ((now - lastT) / 1000) / 1048576; // MB/s
          onProgress(total ? got / total : 0, got / 1048576, total / 1048576, speed);
          lastT = now; lastGot = got;
        }
      });
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', reject);
  });
}

// extrai .tar.xz/.tar.gz usando o `tar` do sistema (presente por padrão no macOS/Linux — evita depender
// de mais uma lib npm nativa só pra isso)
function extractTar(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('Falha ao extrair ' + archivePath + ' (tar saiu com código ' + r.status + ')');
}

function findExe(dir, names) {
  const list = Array.isArray(names) ? names : [names];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { const r = findExe(p, list); if (r) return r; }
    else if (list.some(n => entry.name.toLowerCase() === n.toLowerCase())) return p;
  }
  return null;
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'BruxoSplat' } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/** Garante ffmpeg/COLMAP no macOS via Homebrew (instala sozinho se o Homebrew já estiver presente). */
function ensureBrewPackage(pkg, binName, sendStatus) {
  const found = which(binName);
  if (found) return found;
  if (!hasBrew()) {
    throw new Error(
      `${binName} não encontrado e o Homebrew não está instalado. ` +
      `Instale o Homebrew (https://brew.sh) e depois rode: brew install ${pkg} — ou rode o INSTALAR.command de novo.`
    );
  }
  sendStatus(`Instalando ${pkg} via Homebrew (brew install ${pkg})…`, 0);
  const r = spawnSync('brew', ['install', pkg], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`"brew install ${pkg}" falhou (código ${r.status}). Tente rodar manualmente no Terminal.`);
  const bin = which(binName);
  if (!bin) throw new Error(`${binName} ainda não foi encontrado no PATH depois do brew install — abra um novo terminal/reinicie o app.`);
  return bin;
}

/** Garante que todas as ferramentas existem. Retorna {ffmpeg, colmap, brush} (caminhos dos binários). */
async function ensureTools(sendStatus) {
  const dir = TOOLS_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const state = {};

  if (IS_MAC) {
    // ffmpeg e COLMAP não têm build Mac oficial pra baixar direto — usa Homebrew (padrão do ecossistema)
    sendStatus('Verificando ffmpeg (Homebrew)…', 0);
    state.ffmpeg = ensureBrewPackage('ffmpeg', 'ffmpeg', sendStatus);
    sendStatus('Verificando COLMAP (Homebrew)…', 0);
    state.colmap = ensureBrewPackage('colmap', 'colmap', sendStatus);
  } else {
    // ffmpeg (Windows)
    state.ffmpeg = findExe(dir, 'ffmpeg.exe');
    if (!state.ffmpeg) {
      sendStatus('Baixando ffmpeg…', 0);
      const zip = path.join(dir, 'ffmpeg.zip');
      await download(URLS.ffmpeg, zip, (p, mb, tot, sp) => sendStatus(`Baixando ffmpeg… ${(p*100).toFixed(0)}% (${mb.toFixed(0)}/${tot.toFixed(0)} MB · ${sp.toFixed(1)} MB/s)`, p));
      await extract(zip, { dir: path.join(dir, 'ffmpeg') });
      fs.unlinkSync(zip);
      state.ffmpeg = findExe(dir, 'ffmpeg.exe');
    }

    // COLMAP (Windows)
    state.colmap = findExe(dir, ['colmap.exe', 'colmap.bat']);
    if (!state.colmap) {
      const url = hasNvidiaGpu() ? URLS.colmapCuda : URLS.colmapNoCuda;
      sendStatus('Baixando COLMAP…', 0);
      const zip = path.join(dir, 'colmap.zip');
      await download(url, zip, (p, mb, tot, sp) => sendStatus(`Baixando COLMAP… ${(p*100).toFixed(0)}% (${mb.toFixed(0)}/${tot.toFixed(0)} MB · ${sp.toFixed(1)} MB/s)`, p));
      await extract(zip, { dir: path.join(dir, 'colmap') });
      fs.unlinkSync(zip);
      state.colmap = findExe(dir, ['colmap.exe', 'colmap.bat']);
    }
  }

  // Brush — mesma lógica nos dois SOs: busca a última release na API do GitHub e filtra pelo nome do asset
  state.brush = findExe(dir, ['brush.exe', 'brush_app.exe', 'brush', 'brush_app']);
  if (!state.brush) {
    sendStatus('Procurando última versão do Brush…', 0);
    const rel = await fetchJson(URLS.brushApi);
    const namePattern = IS_MAC ? /darwin|macos|mac[-_]/i : /windows|win/i;
    const extPattern = IS_MAC ? /\.(tar\.xz|tar\.gz|tgz|zip)$/i : /\.(zip|exe)$/i;
    const assets = rel.assets || [];
    let asset = assets.find(a => namePattern.test(a.name) && extPattern.test(a.name));
    // no Apple Silicon prioriza aarch64/arm64; se não achar, aceita qualquer build mac (roda via Rosetta se for x64)
    if (IS_MAC && process.arch === 'arm64') {
      const arm = assets.find(a => /darwin|macos/i.test(a.name) && /aarch64|arm64/i.test(a.name));
      if (arm) asset = arm;
    }
    if (!asset) {
      const osName = IS_MAC ? 'macOS' : 'Windows';
      throw new Error(`Não achei o binário ${osName} do Brush na última release. Baixe manualmente de github.com/ArthurBrussee/brush/releases e coloque em: ${dir}`);
    }
    const dest = path.join(dir, asset.name);
    sendStatus('Baixando Brush…', 0);
    await download(asset.browser_download_url, dest, (p, mb, tot, sp) => sendStatus(`Baixando Brush… ${(p*100).toFixed(0)}% (${mb.toFixed(0)}/${tot.toFixed(0)} MB · ${sp.toFixed(1)} MB/s)`, p));
    if (/\.zip$/i.test(asset.name)) { await extract(dest, { dir: path.join(dir, 'brush') }); fs.unlinkSync(dest); }
    else if (/\.(tar\.xz|tar\.gz|tgz)$/i.test(asset.name)) { extractTar(dest, path.join(dir, 'brush')); fs.unlinkSync(dest); }
    state.brush = findExe(dir, ['brush.exe', 'brush_app.exe', 'brush', 'brush_app']);
    if (state.brush && IS_MAC) { try { fs.chmodSync(state.brush, 0o755); } catch {} } // garante que o binário extraído é executável
  }

  if (!state.ffmpeg || !state.colmap || !state.brush)
    throw new Error('Ferramentas incompletas em ' + dir + ' — verifique sua conexão e tente de novo.');
  return state;
}

/**
 * Baixa (uma única vez) a vocabulary tree pré-treinada do COLMAP, necessária para
 * loop detection no sequential_matcher e para o vocab_tree_matcher.
 *
 * Sem esse arquivo o COLMAP não consegue fazer detecção de laço: num vídeo que dá
 * a volta e retorna ao ponto de partida, o matching sequencial sozinho nunca liga
 * o fim ao começo, e o erro de pose acumulado aparece como deriva (a cena "não
 * fecha"). Usamos a árvore de 32K palavras (~250 MB) — as de 256K/1M são bem
 * maiores e o ganho não compensa para vídeo de cena única.
 *
 * Devolve o caminho do arquivo, ou null se não deu para baixar (o chamador
 * simplesmente segue sem loop detection em vez de abortar o alinhamento).
 */
async function ensureVocabTree(sendStatus) {
  const dir = TOOLS_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'vocab_tree_flickr100K_words32K.bin');
  // ~250 MB: se o arquivo existe mas está absurdamente pequeno, foi download
  // interrompido — melhor refazer do que passar um arquivo corrompido ao COLMAP.
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100e6) return dest;
  try {
    if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
    sendStatus && sendStatus('Baixando vocabulary tree do COLMAP (~250 MB, só na primeira vez)…');
    await download('https://demuc.de/colmap/vocab_tree_flickr100K_words32K.bin', dest);
    if (!fs.existsSync(dest) || fs.statSync(dest).size < 100e6) throw new Error('arquivo incompleto');
    return dest;
  } catch (e) {
    try { fs.rmSync(dest, { force: true }); } catch {}
    sendStatus && sendStatus('Não foi possível baixar a vocabulary tree (' + e.message + ') — seguindo sem loop detection.');
    return null;
  }
}

module.exports = { ensureTools, ensureVocabTree, TOOLS_DIR, IS_MAC, hasNvidiaGpu };
