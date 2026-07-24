// Baixa a logo e prepara os ícones do instalador:
//  - build/icon.png  (Windows — o electron-builder converte pra .ico sozinho)
//  - build/icon.icns (macOS — gerado aqui com sips/iconutil, que já vêm com todo Mac)
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

fs.mkdirSync('build', { recursive: true });

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = u => https.get(u, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return get(res.headers.location);
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(resolve));
    }).on('error', reject);
    get(url);
  });
}

function buildIcns(pngPath) {
  // só roda no macOS — sips e iconutil são ferramentas de linha de comando que já vêm com o sistema
  const iconset = path.join('build', 'icon.iconset');
  fs.mkdirSync(iconset, { recursive: true });
  // tamanhos exatos que o formato .iconset da Apple espera (cada um + sua variante @2x)
  const sizes = [16, 32, 128, 256, 512];
  for (const s of sizes) {
    execFileSync('sips', ['-z', String(s), String(s), pngPath, '--out', path.join(iconset, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
    execFileSync('sips', ['-z', String(s * 2), String(s * 2), pngPath, '--out', path.join(iconset, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join('build', 'icon.icns')]);
  fs.rmSync(iconset, { recursive: true, force: true });
  console.log('build/icon.icns ok');
}

(async () => {
  await download('https://nyckm.github.io/3dGS_WebEDIT/Bruxos.png', 'build/icon.png');
  console.log('build/icon.png ok');
  if (process.platform === 'darwin') {
    try { buildIcns('build/icon.png'); }
    catch (e) { console.warn('Aviso: não deu pra gerar o icon.icns (' + e.message + ') — o electron-builder vai tentar converter o PNG sozinho.'); }
  }
})();
