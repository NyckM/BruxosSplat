#!/bin/bash
# BruxoSplat — gera o .app/.dmg pra publicar (macOS). Precisa rodar num Mac de verdade.
cd "$(dirname "$0")"

echo "Gerando o app do Mac (pasta dist/)..."
node make_icon.js
npm run dist:mac
status=$?

if [ $status -eq 0 ]; then
    echo ""
    echo "✅ Pronto! O .dmg/.zip está na pasta dist/"
    echo "   São esses arquivos que você publica nas Releases do GitHub."
    echo ""
    echo "⚠ Lembrete: sem um certificado de desenvolvedor Apple (Apple Developer ID),"
    echo "   o app não é assinado/notarizado — quem baixar vai precisar clicar com o"
    echo "   botão direito → Abrir na primeira vez (o Gatekeeper do macOS avisa que é"
    echo "   de \"desenvolvedor não identificado\"). Isso é normal pra apps distribuídos"
    echo "   fora da Mac App Store sem certificado pago."
    open dist
else
    echo "❌ Falhou (código $status). Veja o erro acima."
fi
read -n 1 -s -r -p "Pressione qualquer tecla para sair..."
