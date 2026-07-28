@echo off
chcp 65001 >nul
title BruxoSplat - Instalação
echo.
echo  ============================================
echo   🔮 BruxoSplat - Instalação automática
echo  ============================================
echo.

REM --- 0) Se estiver numa pasta protegida (AppData do Claude), copia para C:\BruxoSplat ---
echo %~dp0 | findstr /i "AppData\\Local\\Packages AppData\\Roaming\\Claude" >nul
if %errorlevel%==0 (
    echo  Esta pasta é temporária/protegida. Copiando para C:\BruxoSplat ...
    robocopy "%~dp0." "C:\BruxoSplat" /E /XD node_modules dist >nul
    echo  ✅ Copiado! Continuando a instalação em C:\BruxoSplat ...
    echo.
    start "" cmd /c "C:\BruxoSplat\INSTALAR.bat"
    exit /b 0
)

REM --- 1) Verifica Node.js ---
where node >nul 2>nul
if %errorlevel%==0 goto :temnode

echo  Node.js não encontrado. Instalando via winget...
winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if %errorlevel% neq 0 (
    echo.
    echo  ❌ Não consegui instalar o Node automaticamente.
    echo     Baixe manualmente em: https://nodejs.org
    echo     Depois rode este INSTALAR.bat de novo.
    pause
    exit /b 1
)
echo.
echo  ✅ Node instalado. FECHE esta janela e rode o INSTALAR.bat
echo     de novo (para o Windows reconhecer o Node no PATH).
pause
exit /b 0

:temnode
echo  ✅ Node.js encontrado:
node -v

REM --- 1b) Git (opcional — só é usado pelos modos de IA "SHARP", "TripoSplat" e "FaceAnything") ---
where git >nul 2>nul
if %errorlevel%==0 (
    echo  ✅ Git encontrado.
) else (
    echo  Git não encontrado ^(opcional, só necessário pra instalar os modos de IA^). Tentando instalar via winget...
    winget install Git.Git --accept-source-agreements --accept-package-agreements >nul 2>nul
    if %errorlevel%==0 (
        echo  ✅ Git instalado. ^(pode precisar reabrir o app pro PATH atualizar^)
    ) else (
        echo  ⚠ Não consegui instalar o Git automaticamente. Isso é OK — o app funciona normalmente,
        echo    só os modos de IA ^(SHARP/TripoSplat/FaceAnything^) vão precisar dele depois.
        echo    Se quiser usá-los, baixe em: https://git-scm.com/download/win
    )
)

REM --- 2) Instala dependências ---
echo.
echo  Fechando o BruxoSplat, se estiver aberto...
taskkill /f /im electron.exe >nul 2>nul
taskkill /f /im BruxoSplat.exe >nul 2>nul
timeout /t 2 /nobreak >nul

echo  Baixando dependências (pode demorar alguns minutos)...
cd /d "%~dp0"
if exist node_modules rmdir /s /q node_modules
call npm install
if %errorlevel% neq 0 (
    echo  ❌ Erro no npm install. Verifique sua internet e tente de novo.
    pause
    exit /b 1
)

echo.
echo  ============================================
echo   ✅ Instalação concluída!
echo   Use o RODAR.bat (nesta pasta) para abrir o app.
echo  ============================================
echo.
choice /c SN /m "Abrir o BruxoSplat agora? [S/N]"
if %errorlevel%==1 call npm start
exit /b 0
