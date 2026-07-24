@echo off
setlocal
chcp 65001 >nul
title BruxoSplat - Instalar modelos (offline, a partir do backup)

rem ============================================================================
rem  Reinstala TODOS os modelos a partir do BruxoSplat_modelos_backup.tar
rem  (gerado pelo backup_modelos.bat). Funciona 100%% offline - nao precisa que
rem  os modelos ainda estejam no ar. O .tar tem que estar NESTA mesma pasta.
rem ============================================================================

set "ARC=%~dp0BruxoSplat_modelos_backup.tar"
set "APP=%APPDATA%\BruxoSplat"
set "HFROOT=%USERPROFILE%\.cache"

echo.
echo  Backup : %ARC%
echo  Destino: %APP%
echo           %HFROOT%\huggingface
echo.

if not exist "%ARC%" (
  echo  [ERRO] Nao achei o backup:
  echo         %ARC%
  echo         Coloque o BruxoSplat_modelos_backup.tar nesta pasta e rode de novo.
  echo.
  pause
  exit /b 1
)

where tar >nul 2>nul
if errorlevel 1 (
  echo  [ERRO] Comando "tar" nao encontrado. Precisa do Windows 10 1803+ ou Windows 11.
  echo.
  pause
  exit /b 1
)

echo  ATENCAO: o backup so funciona no MESMO usuario do Windows onde foi criado
echo  (o ambiente Python guarda caminhos como "%APPDATA%"). Em outro PC/usuario,
echo  reinstale pela aba IA do app com internet.
echo.
echo  Restaurando... (nao feche esta janela)
echo.

if not exist "%APPDATA%" mkdir "%APPDATA%"
tar -xf "%ARC%" -C "%APPDATA%" BruxoSplat
if errorlevel 1 (
  echo  [ERRO] Falha ao restaurar a pasta do app.
  echo.
  pause
  exit /b 1
)

if not exist "%HFROOT%" mkdir "%HFROOT%"
tar -xf "%ARC%" -C "%HFROOT%" huggingface 2>nul

echo.
echo  [OK] Modelos restaurados. Abra o BruxoSplat normalmente - eles ja aparecem
echo       instalados na aba IA.
echo.
pause
