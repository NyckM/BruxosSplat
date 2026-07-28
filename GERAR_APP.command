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
    echo "ℹ O pacote recebeu assinatura ad-hoc interna e foi verificado durante o build."
    echo "  Sem Apple Developer ID/notarização, quem baixar ainda verá o aviso de"
    echo "  desenvolvedor não identificado e deverá usar botão direito → Abrir uma vez."
    echo "  O app não deve aparecer como ‘danificado’ por assinatura inconsistente."
    open dist
else
    echo "❌ Falhou (código $status). Veja o erro acima."
fi
read -n 1 -s -r -p "Pressione qualquer tecla para sair..."
