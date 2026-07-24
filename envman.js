// envman.js — ambiente Python compartilhado (uv) + modelos IA instaláveis aos poucos
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execSync, spawnSync } = require('child_process');

const IS_MAC = process.platform === 'darwin';
// venv compartilhado por padrão ('pyenv'); modelos com ownVenv usam um próprio (ex: 'pyenv_faceanything')
// pra não conflitarem de versão de torch — o FaceAnything exige torch 2.9 e o TripoSplat exige 2.6.
const PY_DIR = (sub) => path.join(app.getPath('userData'), sub || 'pyenv');
const venvSubFor = (key, m) => (m && m.ownVenv) ? ('pyenv_' + key) : 'pyenv';
const UV_EXE = () => path.join(app.getPath('userData'), 'tools', IS_MAC ? 'uv' : 'uv.exe');
const UV_URL = () => IS_MAC
  ? `https://github.com/astral-sh/uv/releases/latest/download/uv-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin.tar.gz`
  : 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip';
const MODELS_SRC_DIR = () => path.join(app.getPath('userData'), 'models_src');

// Manifesto de cada modelo: instalação incremental
const MODELS = {
  sharp: {
    name: 'SHARP (Foto → 3DGS)',
    pip: ['git+https://github.com/apple/ml-sharp.git'],
    script: 'models/sharp_run.py',
    sizeHint: '~2 GB (torch + pesos na 1ª execução)'
  },
  triposplat: {
    name: 'TripoSplat (Imagem → Asset 3D 360°)',
    // TripoSR não é instalável via pip (o repo não tem pyproject.toml/setup.py) — só dá pra clonar e
    // rodar de dentro dele, com o pacote "tsr" importado via sys.path (ver models/triposplat_run.py)
    repo: 'https://github.com/VAST-AI-Research/TripoSR.git',
    repoDirName: 'TripoSR',
    // ambiente próprio: o TripoSplat precisa de torch 2.6 (o torchmcubes é compilado contra ele) e não pode
    // dividir venv com o FaceAnything (torch 2.9) — senão a troca de torch quebra o torchmcubes (DLL load failed).
    ownVenv: true,
    pip: ['torch', 'torchvision', 'transformers', 'diffusers', 'rembg', 'onnxruntime'],
    // torchmcubes (dependência do requirements.txt do TripoSR) compila na hora e precisa achar o Torch
    // já instalado via CMake — ver comentário em installModel()
    noBuildIsolation: ['torchmcubes'],
    buildDeps: ['scikit-build-core', 'cmake', 'ninja', 'pybind11'],
    script: 'models/triposplat_run.py',
    sizeHint: '~4 GB'
  },
  faceanything: {
    name: 'FaceAnything (Vídeo → Rosto 4D)',
    // este modelo não é um pacote pip comum: é um repositório clonado + checkpoint de 15GB do Hugging Face
    // (baseado nos notebooks Bruxos_VFX_FaceAnything.ipynb / Bruxos_VFX_FaceAnything4D.ipynb)
    repo: 'https://github.com/kocasariumut/FaceAnything.git',
    repoDirName: 'FaceAnything',
    checkpointUrl: 'https://huggingface.co/UmutKocasari/FaceAnything/resolve/main/checkpoint.pt?download=true',
    checkpointRelPath: 'checkpoints/checkpoint.pt',
    checkpointMinBytes: 15e9,
    // FaceAnything exige torch 2.9 (CUDA 12.8) — incompatível com o torch 2.6 do TripoSplat. Por isso vai
    // num ambiente Python próprio (ownVenv) e o torch/torchvision/xformers vêm do índice cu128 (a versão
    // do PyPI no Windows é CPU-only, o que fazia cair pra CPU). Ordem: instala esses 3 antes do requirements.
    ownVenv: true,
    cudaTorch: { index: 'https://download.pytorch.org/whl/cu128', pkgs: ['torch==2.9.0', 'torchvision==0.24.0', 'xformers==0.0.33.post1'] },
    // moviepy<2: o código do FaceAnything importa "moviepy.editor", que foi removido no moviepy 2.x
    // (só existe na linha 1.x). Sem fixar, o pip pega o 2.x e dá ModuleNotFoundError em runtime.
    // addict: o depth_anything_3 (usado pelo FaceAnything) importa "from addict import Dict" mas isso
    // não está no requirements.txt dele. moviepy<2: o código usa "moviepy.editor", removido no moviepy 2.x.
    pip: ['plyfile', 'moviepy<2', 'addict', 'pycolmap', 'evo'],
    script: 'models/faceanything_run.py',
    sizeHint: '~15 GB (checkpoint) — requer GPU NVIDIA (o próprio repositório do FaceAnything pode não suportar Apple Silicon/MPS) e Git instalado. Licença CC BY-NC (uso não-comercial)'
  }
};

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'BruxoSplat' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) return download(res.headers.location, dest, onProgress).then(resolve, reject);
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const f = fs.createWriteStream(dest);
      res.pipe(f); f.on('finish', () => f.close(resolve));
    }).on('error', reject);
  });
}

// download com retomada (Range) — essencial pra arquivos grandes (ex: checkpoint de 15GB) numa internet instável.
// Se a conexão cair, rodar de novo continua de onde parou (igual ao "wget -c" que o notebook usa).
function downloadResumable(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const startByte = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const go = (u, bytesAlready) => {
      const opts = { headers: { 'User-Agent': 'BruxoSplat' } };
      if (bytesAlready > 0) opts.headers['Range'] = 'bytes=' + bytesAlready + '-';
      https.get(u, opts, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return go(res.headers.location, bytesAlready);
        if (res.statusCode !== 200 && res.statusCode !== 206) return reject(new Error('HTTP ' + res.statusCode + ' baixando ' + u));
        const resumed = res.statusCode === 206;
        const contentLen = parseInt(res.headers['content-length'] || '0', 10);
        const total = resumed ? bytesAlready + contentLen : contentLen;
        let received = resumed ? bytesAlready : 0;
        const f = fs.createWriteStream(dest, { flags: resumed ? 'a' : 'w' });
        res.on('data', chunk => {
          received += chunk.length;
          if (onProgress && total) onProgress(Math.min(100, Math.floor(received / total * 100)), received, total);
        });
        res.pipe(f);
        f.on('finish', () => f.close(resolve));
        res.on('error', reject);
      }).on('error', reject);
    };
    go(url, startByte);
  });
}

// Alguns modelos (ex: FaceAnything) vêm como repositório git, não só pip — precisa do Git instalado.
function ensureGit() {
  try { execSync('git --version', { stdio: 'ignore' }); }
  catch (e) {
    if (IS_MAC) {
      throw new Error('Git não encontrado. Rode "xcode-select --install" no Terminal (ou "brew install git") e tente de novo.');
    }
    throw new Error('Git não encontrado. Instale o "Git for Windows" (https://git-scm.com/download/win) e rode o INSTALAR.bat de novo.');
  }
}

// acha a pasta bin/ do CUDA Toolkit instalado (onde fica nvcc.exe) — o instalador da NVIDIA seta a env var
// CUDA_PATH, mas ela nem sempre chega até processos filhos do Electron; então também tenta o caminho padrão.
function findCudaBin() {
  if (IS_MAC) return null;
  const candidates = [];
  if (process.env.CUDA_PATH) candidates.push(path.join(process.env.CUDA_PATH, 'bin'));
  const root = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA';
  try {
    for (const v of fs.readdirSync(root).sort().reverse()) candidates.push(path.join(root, v, 'bin'));
  } catch {}
  return candidates.find(c => fs.existsSync(path.join(c, 'nvcc.exe'))) || null;
}

// procura um executável (ex: cl.exe) nas pastas de um PATH; usado pra achar o cl.exe do MSVC depois do vcvars.
function findInPath(exe, pathStr) {
  for (const dir of (pathStr || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  return null;
}

// Com o gerador "Visual Studio", o CMake monta o projeto MSBuild e resolve sozinho onde estão o cl.exe,
// os headers do Windows SDK etc. Já com o gerador Ninja (usado pra fugir do problema de integração
// CUDA↔MSVC), o CMake espera que esse ambiente (INCLUDE/LIB/PATH do MSVC) já esteja carregado no processo
// — exatamente o que o "Developer Command Prompt" faz rodando o vcvarsall.bat. Sem isso, o nvcc até é
// achado, mas ele chama o cl.exe como compilador auxiliar e o teste de compilação falha, e o CMake reporta
// isso genericamente como "No CUDA toolset found". Aqui a gente localiza o Visual Studio via vswhere,
// roda o vcvarsall.bat x64 numa subshell e captura as variáveis de ambiente resultantes.
let _vcVarsCache;
function getVcVarsEnv(log) {
  if (IS_MAC) return null;
  if (_vcVarsCache !== undefined) return _vcVarsCache;
  try {
    const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
    if (!fs.existsSync(vswhere)) { _vcVarsCache = null; return null; }
    const installPath = execSync(`"${vswhere}" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`).toString().trim();
    const vcvarsall = path.join(installPath, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
    if (!installPath || !fs.existsSync(vcvarsall)) { _vcVarsCache = null; return null; }
    const out = execSync(`"${vcvarsall}" x64 && set`, { shell: 'cmd.exe' }).toString();
    const env = {};
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^([^=]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
    if (log) log('Ambiente MSVC (vcvarsall) carregado: ' + installPath);
    _vcVarsCache = env;
  } catch (e) {
    if (log) log('⚠️ Não consegui carregar o ambiente do Visual Studio (vcvarsall): ' + e.message);
    _vcVarsCache = null;
  }
  return _vcVarsCache;
}

function run(exe, args, onLine, env) {
  return new Promise((resolve, reject) => {
    // No Windows, spawn() sem shell:true não resolve alguns instaladores de "git"/etc que só deixam um
    // .cmd/.bat no PATH (em vez de .exe direto) — dá "spawn git ENOENT" mesmo com o git funcionando
    // normalmente no terminal (que passa pelo cmd.exe). shell:true replica esse comportamento.
    // Porém, com shell:true o Node NÃO cita os argumentos sozinho — então caminhos com espaços (ex: uma
    // imagem "Image 11 de jun.png") são re-quebrados pelo cmd.exe. Aqui a gente cita manualmente os que
    // têm espaço/caractere especial antes de montar a linha de comando.
    const useShell = process.platform === 'win32';
    const q = a => (useShell && /[\s&|<>^()%!]/.test(String(a)) && !/^".*"$/.test(String(a))) ? '"' + a + '"' : a;
    const p = spawn(useShell ? q(exe) : exe, useShell ? args.map(q) : args,
      { windowsHide: true, shell: useShell, env: { ...process.env, ...env } });
    const feed = d => d.toString().split(/\r?\n/).forEach(l => l.trim() && onLine(l.trim()));
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('close', c => c === 0 ? resolve() : reject(new Error(path.basename(exe) + ' saiu com código ' + c)));
  });
}

async function ensureUv(log) {
  if (fs.existsSync(UV_EXE())) return UV_EXE();
  fs.mkdirSync(path.dirname(UV_EXE()), { recursive: true });
  log('Baixando uv (gerenciador Python)…');
  if (IS_MAC) {
    const tgz = UV_EXE() + '.tar.gz';
    await download(UV_URL(), tgz);
    const r = spawnSync('tar', ['-xzf', tgz, '-C', path.dirname(UV_EXE())], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('Falha ao extrair o uv (tar saiu com código ' + r.status + ')');
    fs.unlinkSync(tgz);
    // o tar.gz do uv costuma extrair dentro de uma subpasta "uv-<target>/"; acha o binário e move pra UV_EXE()
    if (!fs.existsSync(UV_EXE())) {
      const dir = path.dirname(UV_EXE());
      const found = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => path.join(dir, e.name, 'uv'))
        .find(p => fs.existsSync(p));
      if (found) fs.renameSync(found, UV_EXE());
    }
    try { fs.chmodSync(UV_EXE(), 0o755); } catch {}
  } else {
    const extract = require('extract-zip');
    const zip = UV_EXE() + '.zip';
    await download(UV_URL(), zip);
    await extract(zip, { dir: path.dirname(UV_EXE()) });
    fs.unlinkSync(zip);
  }
  if (!fs.existsSync(UV_EXE())) throw new Error('Não encontrei o executável do uv depois de extrair — baixe manualmente de github.com/astral-sh/uv/releases.');
  return UV_EXE();
}

async function ensureVenv(log, sub) {
  const uv = await ensureUv(log);
  const dir = PY_DIR(sub);
  const py = IS_MAC ? path.join(dir, 'bin', 'python3') : path.join(dir, 'Scripts', 'python.exe');
  if (!fs.existsSync(py)) {
    log('Criando ambiente Python 3.11…');
    await run(uv, ['venv', dir, '--python', '3.11'], log);
  }
  return { uv, py };
}

/** Instala um modelo (incremental — cada um só na primeira vez). */
async function installModel(key, log) {
  const m = MODELS[key];
  if (!m) throw new Error('Modelo desconhecido: ' + key);
  const sub = venvSubFor(key, m);
  const { uv, py } = await ensureVenv(log, sub);
  const marker = path.join(PY_DIR(sub), '.installed_' + key);
  if (fs.existsSync(marker)) {
    // já instalado — mas garante que dependências pip "leves" continuem presentes (ex: se a gente
    // adicionar uma nova, tipo o moviepy que faltava no FaceAnything). NÃO mexe em torch/checkpoint/
    // compilação: instala só os extras não-torch, que o uv resolve instantâneo se já estiverem lá.
    const extra = (m.pip || []).filter(p => !/^torch(vision)?([=<>! ]|$)/.test(p));
    if (extra.length) {
      const idx = ['--index-url', 'https://pypi.org/simple'];
      if (!IS_MAC) idx.push('--extra-index-url', 'https://download.pytorch.org/whl/cu124', '--index-strategy', 'unsafe-best-match');
      try { await run(uv, ['pip', 'install', '--python', py, ...idx, ...extra], log); }
      catch (e) { log('Aviso ao revisar dependências: ' + e.message); }
    }
    log(m.name + ' já instalado.');
    return;
  }

  if (m.repo) {
    // modelo baseado em repositório git (ex: FaceAnything) + checkpoint grande, não só pip
    ensureGit();
    fs.mkdirSync(MODELS_SRC_DIR(), { recursive: true });
    const repoDir = path.join(MODELS_SRC_DIR(), m.repoDirName);
    if (!fs.existsSync(repoDir)) {
      log('Baixando ' + m.name + ' (git clone)…');
      await run('git', ['clone', '--depth', '1', m.repo, repoDir], log);
    } else {
      log(m.name + ': repositório já clonado.');
    }
    log('Instalando dependências de ' + m.name + ' (' + m.sizeHint + ')…');
    const idxArgs = ['--index-url', 'https://pypi.org/simple'];
    // no mac não existe CUDA (usa MPS) — o índice extra do PyTorch cu124 é só pra Windows/Linux com NVIDIA
    if (!IS_MAC) {
      idxArgs.push('--extra-index-url', 'https://download.pytorch.org/whl/cu124');
      // por padrão o uv só considera o 1º índice onde acha um pacote. Se um requirements.txt pedir uma
      // versão de torch que não existe no cu124 (ex: FaceAnything pede torch==2.9.0), o uv trava em vez
      // de olhar o PyPI. unsafe-best-match deixa ele escolher a melhor versão entre os dois índices
      // (ambos confiáveis: PyPI oficial + índice oficial do PyTorch).
      idxArgs.push('--index-strategy', 'unsafe-best-match');
    }

    // torch com CUDA de um índice específico (ex: FaceAnything → cu128 pro torch 2.9). Instala ANTES do
    // requirements pra fixar a build CUDA certa (o requirements pede torch==2.9.0 e isso já satisfaz).
    if (m.cudaTorch && !IS_MAC) {
      log('Instalando torch com CUDA (' + m.cudaTorch.pkgs.join(', ') + ')…');
      await run(uv, ['pip', 'install', '--python', py, '--index-url', m.cudaTorch.index, ...m.cudaTorch.pkgs], log);
    }

    // alguns pacotes (ex: torchmcubes, do TripoSR) compilam na hora e o build precisa achar o Torch já
    // instalado via CMake (torch.utils.cmake_prefix_path) — em build isolado (padrão) o Torch não está
    // visível nesse ambiente temporário e o CMake falha com "Could not find TorchConfig.cmake".
    const needsNativeBuild = m.noBuildIsolation && m.noBuildIsolation.length;
    const needsTorchFirst = needsNativeBuild && m.pip && m.pip.includes('torch');
    // Versão do torch usada pra COMPILAR e depois rodar. Fixa de propósito:
    //  - torch 2.6.0 compila com C++17 (as versões novas, 2.13+, exigem C++20, mas o torchmcubes fixa
    //    C++17 no CMakeLists → erro C7555/C7582 "requer /std:c++20"). 2.6.0 evita isso.
    //  - a MESMA versão existe em CPU (whl/cpu) e CUDA (whl/cu124), com ABI idêntico — então dá pra
    //    compilar contra a CPU e trocar pela CUDA no runtime sem invalidar a extensão compilada.
    const TORCH_PIN = ['torch==2.6.0', 'torchvision==0.21.0'];
    if (needsTorchFirst) {
      // compila contra o torch CPU: assim o CMake do Caffe2 NÃO tenta habilitar a linguagem CUDA
      // (que no Windows exige a integração CUDA↔Visual Studio e dá "No CUDA toolset found"). O
      // torchmcubes só faz marching cubes — compilar a versão CPU dele não afeta a GPU no uso real.
      log('Instalando torch (CPU, 2.6.0) pra compilar ' + m.noBuildIsolation.join(', ') + '…');
      await run(uv, ['pip', 'install', '--python', py, '--index-url', 'https://download.pytorch.org/whl/cpu',
        '--reinstall-package', 'torch', '--reinstall-package', 'torchvision', ...TORCH_PIN], log);
      if (m.buildDeps && m.buildDeps.length) {
        log('Instalando dependências de build (' + m.buildDeps.join(', ') + ')…');
        await run(uv, ['pip', 'install', '--python', py, ...idxArgs, ...m.buildDeps], log);
      }
    }

    if (needsNativeBuild) {
      // deixa o CMake usar o gerador padrão do Windows (Visual Studio), que acha o MSVC sozinho e compila
      // o caminho CPU do torchmcubes sem precisar de toolchain CUDA nenhum. --no-cache garante um checkout
      // git limpo (uma build dir cacheada de tentativa anterior travaria o gerador/config do CMake).
      const a = ['pip', 'install', '--python', py, ...idxArgs, '--no-cache'];
      for (const pkg of m.noBuildIsolation || []) a.push('--no-build-isolation-package', pkg);
      const reqFile = path.join(repoDir, 'requirements.txt');
      if (fs.existsSync(reqFile)) a.push('-r', reqFile);
      const isPipPackage = fs.existsSync(path.join(repoDir, 'setup.py')) || fs.existsSync(path.join(repoDir, 'pyproject.toml'));
      if (isPipPackage) a.push('-e', repoDir);
      // torch/torchvision já estão pinados/instalados — não relista pra não puxar outra versão
      a.push(...(m.pip || []).filter(p => p !== 'torch' && p !== 'torchvision'));
      await run(uv, a, log);
      if (needsTorchFirst) {
        // troca o torch CPU pela versão CUDA (mesma 2.6.0 → ABI compatível com a extensão recém-compilada)
        log('Instalando torch com CUDA (2.6.0+cu124) pra rodar na GPU…');
        await run(uv, ['pip', 'install', '--python', py, ...idxArgs,
          '--reinstall-package', 'torch', '--reinstall-package', 'torchvision', ...TORCH_PIN], log);
      }
    } else {
      const a = ['pip', 'install', '--python', py, ...idxArgs];
      const reqFile = path.join(repoDir, 'requirements.txt');
      if (fs.existsSync(reqFile)) a.push('-r', reqFile);
      const isPipPackage = fs.existsSync(path.join(repoDir, 'setup.py')) || fs.existsSync(path.join(repoDir, 'pyproject.toml'));
      if (isPipPackage) a.push('-e', repoDir);
      a.push(...(m.pip || []));
      await run(uv, a, log);
    }

    if (m.checkpointUrl) {
      const ckptPath = path.join(repoDir, m.checkpointRelPath);
      fs.mkdirSync(path.dirname(ckptPath), { recursive: true });
      const minBytes = m.checkpointMinBytes || 1e9;
      if (!fs.existsSync(ckptPath) || fs.statSync(ckptPath).size < minBytes) {
        log('Baixando checkpoint de ' + m.name + ' (' + m.sizeHint + ') — se cair, rode de novo que continua de onde parou…');
        let lastPct = -10;
        await downloadResumable(m.checkpointUrl, ckptPath, pct => {
          if (pct - lastPct >= 5) { lastPct = pct; log('Checkpoint: ' + pct + '%'); }
        });
        if (fs.statSync(ckptPath).size < minBytes) throw new Error('Checkpoint baixado incompleto — rode a instalação de novo.');
      } else {
        log('Checkpoint já baixado.');
      }
    }
  } else {
    log('Instalando ' + m.name + ' (' + m.sizeHint + ')…');
    const pipArgs = ['pip', 'install', '--python', py, '--index-url', 'https://pypi.org/simple'];
    if (!IS_MAC) pipArgs.push('--extra-index-url', 'https://download.pytorch.org/whl/cu124');
    await run(uv, [...pipArgs, ...m.pip], log);
  }
  fs.writeFileSync(marker, new Date().toISOString());
  log('✅ ' + m.name + ' instalado.');
}

/** Garante o CLI `splat4d` (pacote PyPI `splats4d` — github.com/adamraudonis/splats4D) instalado
 *  no mesmo venv compartilhado, e devolve o caminho do executável. Usado pra empacotar uma
 *  sequência de frames .splat numa cena .splat4d única (streaming, bem mais leve que os arquivos soltos). */
async function ensureSplat4dCli(log) {
  const { uv, py } = await ensureVenv(log);
  const exe = IS_MAC ? path.join(PY_DIR(), 'bin', 'splat4d') : path.join(PY_DIR(), 'Scripts', 'splat4d.exe');
  const marker = path.join(PY_DIR(), '.installed_splat4d');
  if (fs.existsSync(marker) && fs.existsSync(exe)) return exe;
  log('Instalando o conversor .splat4d (pacote splats4d)…');
  await run(uv, ['pip', 'install', '--python', py, 'splats4d'], log);
  if (!fs.existsSync(exe)) throw new Error('splat4d instalado mas o executável não apareceu em ' + exe);
  fs.writeFileSync(marker, new Date().toISOString());
  return exe;
}

/** Garante numpy no venv compartilhado (usado pelo conversor .ply→.splat). Devolve o python do venv. */
async function ensureConvertDeps(log) {
  const { uv, py } = await ensureVenv(log);
  const marker = path.join(PY_DIR(), '.installed_convert');
  if (!fs.existsSync(marker)) {
    log('Preparando o conversor (numpy)…');
    await run(uv, ['pip', 'install', '--python', py, 'numpy'], log);
    fs.writeFileSync(marker, new Date().toISOString());
  }
  return py;
}

/** Roda o script do modelo. args: {input, outDir, maxFrames?} */
async function runModel(key, args, log) {
  const m = MODELS[key];
  const { py } = await ensureVenv(log, venvSubFor(key, m));
  const script = path.join(__dirname, m.script);
  const cliArgs = [script, '--input', args.input, '--output', args.outDir];
  if (args.maxFrames) cliArgs.push('--max-frames', String(args.maxFrames));
  const env = {};
  if (m.repoDirName) env.MODEL_REPO_DIR = path.join(MODELS_SRC_DIR(), m.repoDirName);
  await run(py, cliArgs, log, env);
}

module.exports = { installModel, runModel, ensureSplat4dCli, ensureConvertDeps, MODELS, IS_MAC };
