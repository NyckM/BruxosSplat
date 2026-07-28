#!/bin/bash
# BruxoSplat — libera o app no macOS quando o Gatekeeper bloqueia/considera "ameaça".
# Isso acontece porque o app não é assinado/notarizado por uma conta Apple Developer paga.
# Este script remove a quarentena e refaz uma assinatura ad-hoc local completa.
# Ele não substitui notarização, mas corrige uma cópia estruturalmente inconsistente.

APP="/Applications/BruxoSplat.app"

echo ""
echo "  Liberando o BruxoSplat no macOS..."
echo ""

if [ ! -d "$APP" ]; then
  echo "  [!] Não achei o app em: $APP"
  echo "      Arraste o BruxoSplat.app pra pasta Aplicativos primeiro (a partir do .dmg),"
  echo "      depois rode este script de novo."
  echo ""
  read -n 1 -s -r -p "  Pressione qualquer tecla para sair..."
  exit 1
fi

# 1) remove a marca de quarentena (o que faz o macOS avisar/apagar)
xattr -cr "$APP" 2>/dev/null
xattr -dr com.apple.quarantine "$APP" 2>/dev/null

# 2) assinatura ad-hoc local e verificação explícita
if ! codesign --force --deep --sign - --timestamp=none "$APP"; then
  echo "  [ERRO] O codesign não conseguiu assinar o pacote."
  read -n 1 -s -r -p "  Pressione qualquer tecla para sair..."
  exit 1
fi

if ! codesign --verify --deep --strict --verbose=2 "$APP"; then
  echo "  [ERRO] A assinatura foi criada, mas a verificação falhou."
  read -n 1 -s -r -p "  Pressione qualquer tecla para sair..."
  exit 1
fi

echo "  ✅ Assinatura local verificada. Abra o BruxoSplat pela pasta Aplicativos."
echo ""
echo "  Se ainda assim o macOS reclamar, vá em Ajustes do Sistema → Privacidade e"
echo "  Segurança, role até o aviso do BruxoSplat e clique em 'Abrir Mesmo Assim'."
echo ""
read -n 1 -s -r -p "  Pressione qualquer tecla para sair..."
