#!/bin/bash
# BruxoSplat — instalação automática (macOS)
# Dê 2 cliques neste arquivo no Finder. Se pedir permissão na primeira vez, rode no Terminal:
#   chmod +x INSTALAR.command RODAR.command GERAR_APP.command
cd "$(dirname "$0")"

echo ""
echo "============================================"
echo "  🔮 BruxoSplat - Instalação automática (Mac)"
echo "============================================"
echo ""

# --- 1) Homebrew (gerenciador de pacotes do Mac — usado pro Node, Git, ffmpeg, COLMAP) ---
if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew não encontrado. Instalando..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # nos Macs Apple Silicon o brew fica em /opt/homebrew, não em /usr/local
    if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
    if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
fi
if ! command -v brew >/dev/null 2>&1; then
    echo "❌ Não consegui instalar/encontrar o Homebrew. Instale manualmente em https://brew.sh e rode este script de novo."
    read -n 1 -s -r -p "Pressione qualquer tecla para sair..."
    exit 1
fi
echo "✅ Homebrew encontrado."

# --- 2) Node.js ---
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js não encontrado. Instalando via Homebrew..."
    brew install node
fi
if ! command -v node >/dev/null 2>&1; then
    echo "❌ Não consegui instalar o Node automaticamente. Baixe em https://nodejs.org e rode este script de novo."
    read -n 1 -s -r -p "Pressione qualquer tecla para sair..."
    exit 1
fi
echo "✅ Node.js encontrado: $(node -v)"

# --- 2b) Git (opcional — só necessário pros modos de IA SHARP/TripoSplat/FaceAnything) ---
if ! command -v git >/dev/null 2>&1; then
    echo "Git não encontrado (opcional). Instalando via Homebrew..."
    brew install git || echo "⚠ Não consegui instalar o Git automaticamente — os modos de IA vão pedir ele depois."
fi

# --- 3) Instala dependências ---
echo ""
echo "Fechando o BruxoSplat, se estiver aberto..."
# padrões específicos (não usar só "BruxoSplat" — o caminho deste próprio script já contém esse nome
# e um pkill genérico acabaria se matando ou fechando o Terminal que está rodando este instalador)
pkill -f "BruxoSplat.app/Contents/MacOS/BruxoSplat" 2>/dev/null
pkill -f "Electron.app/Contents/MacOS/Electron" 2>/dev/null
sleep 1

echo "Baixando dependências (pode demorar alguns minutos)..."
rm -rf node_modules
npm install
if [ $? -ne 0 ]; then
    echo "❌ Erro no npm install. Verifique sua internet e tente de novo."
    read -n 1 -s -r -p "Pressione qualquer tecla para sair..."
    exit 1
fi

chmod +x RODAR.command GERAR_APP.command 2>/dev/null

echo ""
echo "============================================"
echo "  ✅ Instalação concluída!"
echo "  Use o RODAR.command (nesta pasta) pra abrir o app."
echo "============================================"
echo ""
read -p "Abrir o BruxoSplat agora? [s/N] " resp
if [[ "$resp" =~ ^[sS]$ ]]; then npm start; fi
