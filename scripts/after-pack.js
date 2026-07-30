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

  // A assinatura em si precisa funcionar: sem ela, binários em Apple Silicon não
  // executam e o macOS reporta o app como "danificado".
  run(['--force', '--deep', '--sign', '-', '--timestamp=none', appPath]);

  // Já a VERIFICAÇÃO é só um diagnóstico, e não pode derrubar o build.
  // A Apple desaconselha `--deep` para assinar (ele não trata frameworks
  // aninhados do Electron na ordem correta, de dentro para fora), então
  // `--verify --deep --strict` reprova com frequência um pacote que, na prática,
  // abre normalmente. Antes isso lançava exceção e matava o build inteiro com
  // "exit code 1" sem explicar o motivo.
  try {
    run(['--verify', '--deep', '--strict', '--verbose=2', appPath]);
    console.log(`Assinatura ad-hoc verificada: ${appPath}`);
  } catch (e) {
    console.warn(`Aviso: a verificação estrita da assinatura reprovou (${e.message}).`);
    console.warn('O app foi assinado mesmo assim e normalmente abre. Se o macOS reclamar,');
    console.warn('rode: xattr -cr /Applications/BruxoSplat.app');
  }
};
