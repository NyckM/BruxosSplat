@echo off
chcp 65001 >nul
title BruxoSplat - Gerar .exe
cd /d "%~dp0"
echo  Gerando instalador .exe (pasta dist\)...
node make_icon.js
call npm run dist
if %errorlevel%==0 (
    echo.
    echo  ✅ Pronto! O .exe está na pasta dist\
    echo     É esse arquivo que você publica nas Releases do GitHub.
    start "" dist
)
pause
