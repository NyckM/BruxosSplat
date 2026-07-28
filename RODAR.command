#!/bin/bash
# BruxoSplat — abre o app a partir do código-fonte (macOS)
cd "$(dirname "$0")"

ELECTRON_BIN="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -x "$ELECTRON_BIN" ]; then
    echo "❌ Não encontrei o Electron instalado. Rode o INSTALAR.command primeiro."
    read -n 1 -s -r -p "Pressione qualquer tecla para sair..."
    exit 1
fi

# roda em segundo plano e fecha este terminal logo em seguida
nohup "$ELECTRON_BIN" . >/tmp/bruxosplat.log 2>&1 &
disown
sleep 1
exit 0
