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

// Um app aberto pelo Finder no macOS NÃO herda o PATH do terminal: ele recebe um
// PATH mínimo (/usr/bin:/bin:/usr/sbin:/sbin) que não inclui os diretórios do
// Homebrew. Resultado: `which ffmpeg` falhava mesmo com o ffmpeg instalado, e o app
// dizia que o Homebrew não existia. Por isso, além do PATH, olhamos direto nos
// lugares padrão do Homebrew.
const MAC_EXTRA_BINS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];

function which(cmd) {
  try {
    const out = execFileSync(IS_MAC ? 'which' : 'where', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const hit = out.split('\n')[0].trim();
    if (hit) return hit;
  } catch { /* segue para a busca manual abaixo */ }
  if (IS_MAC) {
    for (const dir of MAC_EXTRA_BINS) {
      const p = path.join(dir, cmd);
      try { if (fs.existsSync(p)) return p; } catch {}
    }
  }
  return null;
}

function hasBrew() { return !!which('brew'); }

/**
 * PATH ampliado para rodar subprocessos no macOS: junta o PATH atual com os
 * diretórios do Homebrew. Necessário porque o `brew install` e o próprio COLMAP
 * chamam outros binários entre si.
 */
function macEnvWithBrew() {
  if (!IS_MAC) return process.env;
  const atual = (process.env.PATH || '').split(':');
  const juntos = [...new Set([...MAC_EXTRA_BINS, ...atual])].filter(Boolean);
  return { ...process.env, PATH: juntos.join(':') };
}

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
/**
 * Verifica de uma vez TUDO que o macOS precisa do Homebrew e, se faltar algo, dá
 * uma única instrução com um comando pronto para copiar.
 *
 * Antes a checagem era pacote a pacote: o usuário instalava o ffmpeg, tentava de
 * novo, e só então descobria que o COLMAP também faltava. Duas rodadas de erro
 * para uma informação que dava para dar de uma vez.
 */
/**
 * Monta o comando que instala tudo que falta no macOS (Homebrew, se preciso, e
 * depois os pacotes). Devolve null quando não há nada a fazer.
 *
 * Por que não instalamos direto de dentro do app: o instalador do Homebrew pede
 * senha de administrador e uma confirmação com Enter. Um app aberto pelo Finder
 * não tem terminal onde digitar isso — ele ficaria travado esperando. Então o app
 * abre o Terminal já com o comando pronto, e a pessoa só confirma.
 */
function macInstallCommand() {
  if (!IS_MAC) return null;
  const precisa = [{ pkg: 'ffmpeg', bin: 'ffmpeg' }, { pkg: 'colmap', bin: 'colmap' }];
  const faltando = precisa.filter(p => !which(p.bin)).map(p => p.pkg);
  const temBrew = hasBrew();
  if (temBrew && !faltando.length) return null;

  const partes = [];
  if (!temBrew) {
    partes.push('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"');
    // O instalador não deixa o brew no PATH da sessão atual; isso resolve para o
    // comando seguinte funcionar na mesma janela, nos dois tipos de Mac.
    partes.push('eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"');
  }
  partes.push('brew install ' + (faltando.length ? faltando.join(' ') : 'ffmpeg colmap'));
  return { comando: partes.join(' && '), faltando, temBrew };
}

function ensureMacTools(sendStatus) {
  const precisa = [{ pkg: 'ffmpeg', bin: 'ffmpeg' }, { pkg: 'colmap', bin: 'colmap' }];
  const faltando = precisa.filter(p => !which(p.bin));
  if (!faltando.length) {
    return { ffmpeg: which('ffmpeg'), colmap: which('colmap') };
  }
  const lista = faltando.map(f => f.pkg).join(' ');

  if (!hasBrew()) {
    throw new Error(
      'Faltam ferramentas que o BruxoSplat usa no macOS: ' + lista + '.\n' +
      '\nElas não têm build oficial para Mac (o COLMAP só publica binário Windows), ' +
      'então a instalação é pelo Homebrew, que é o gerenciador de pacotes padrão do macOS.\n' +
      '\nCole estes dois comandos no Terminal, um de cada vez:\n' +
      '\n1) Instalar o Homebrew:\n' +
      '   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n' +
      '\n2) Instalar as ferramentas:\n' +
      '   brew install ' + lista + '\n' +
      '\nDepois feche e abra o BruxoSplat de novo.'
    );
  }

  sendStatus('Instalando via Homebrew: ' + lista + ' — pode demorar alguns minutos…', 0);
  const brew = which('brew');
  const r = spawnSync(brew, ['install', ...faltando.map(f => f.pkg)], { stdio: 'inherit', env: macEnvWithBrew() });
  if (r.status !== 0) {
    throw new Error('"brew install ' + lista + '" falhou (código ' + r.status + ').\n' +
      '\nRode manualmente no Terminal para ver o erro completo:\n   brew install ' + lista);
  }
  const aindaFalta = precisa.filter(p => !which(p.bin)).map(p => p.bin);
  if (aindaFalta.length) {
    throw new Error('Depois do brew install, ainda não encontrei: ' + aindaFalta.join(', ') + '.\n' +
      '\nFeche e abra o BruxoSplat (o app precisa reler os caminhos). Se persistir, confirme no Terminal com: which ' + aindaFalta.join(' '));
  }
  return { ffmpeg: which('ffmpeg'), colmap: which('colmap') };
}

/** Garante que todas as ferramentas existem. Retorna {ffmpeg, colmap, brush} (caminhos dos binários). */
async function ensureTools(sendStatus) {
  const dir = TOOLS_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const state = {};

  if (IS_MAC) {
    // ffmpeg e COLMAP não têm build Mac oficial pra baixar direto — usa Homebrew.
    // Verificação única: se faltar algo, o usuário recebe tudo numa instrução só.
    sendStatus('Verificando ffmpeg e COLMAP…', 0);
    const macTools = ensureMacTools(sendStatus);
    state.ffmpeg = macTools.ffmpeg;
    state.colmap = macTools.colmap;
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

module.exports = { ensureTools, ensureVocabTree, macInstallCommand, TOOLS_DIR, IS_MAC, hasNvidiaGpu };
