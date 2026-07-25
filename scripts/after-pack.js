/*
 * Electron contém frameworks, helpers e binários internos. Sem uma conta Apple
 * Developer, electron-builder não cria uma assinatura Developer ID/notarizada.
 * Ainda assim, uma assinatura ad-hoc coerente em todo o .app evita o estado
 * inconsistente que o macOS reporta como “app danificado”.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (!fs.existsSync(appPath)) throw new Error(`Pacote macOS não encontrado: ${appPath}`);

  const run = args => execFileSync('codesign', args, { stdio: 'inherit' });
  run(['--force', '--deep', '--sign', '-', '--timestamp=none', appPath]);
  run(['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  console.log(`Assinatura ad-hoc verificada: ${appPath}`);
};
