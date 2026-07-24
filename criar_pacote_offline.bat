@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title BruxoSplat - Criar pacote OFFLINE (portatil)

rem ============================================================================
rem  Cria a pasta BruxoSplat_offline com TUDO que os modelos precisam, de um jeito
rem  PORTATIL: leva o interpretador Python, TODOS os ambientes (o compartilhado e os
rem  isolados do TripoSplat e do FaceAnything) com as bibliotecas ja compiladas,
rem  as ferramentas, os repositorios, o checkpoint do FaceAnything e os pesos do
rem  HuggingFace. Com isso da pra instalar em OUTRO PC, sem internet, com o
rem  instalar_offline.bat.
rem
rem  Rode DEPOIS de instalar os modelos no app (com internet).
rem ============================================================================

set "APP=%APPDATA%\BruxoSplat"
set "UV=%APP%\tools\uv.exe"
set "HF=%USERPROFILE%\.cache\huggingface"
set "OUT=%~dp0BruxoSplat_offline"

echo.
echo  Origem : %APP%
echo  Saida  : %OUT%
echo.

if not exist "%APP%\tools\uv.exe" (
  echo  [ERRO] App nao inicializado em "%APP%". Instale os modelos no app primeiro.
  echo.
  pause & exit /b 1
)

if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%"
mkdir "%OUT%\venvs"

echo  [1/6] Ambientes Python (site-packages ja compilados de cada modelo)...
for /d %%V in ("%APP%\pyenv*") do (
  echo        - %%~nxV
  robocopy "%%V\Lib\site-packages" "%OUT%\venvs\%%~nxV\site-packages" /E /NFL /NDL /NJH /NJS /NP >nul
  copy /y "%%V\.installed_*" "%OUT%\venvs\%%~nxV\" >nul 2>nul
)

echo  [2/6] Interpretador Python (do uv)...
for /d %%D in ("%APPDATA%\uv\python\cpython-3.11-*") do robocopy "%%D" "%OUT%\python" /E /NFL /NDL /NJH /NJS /NP >nul

echo  [3/6] Ferramentas (uv, ffmpeg, COLMAP, Brush)...
robocopy "%APP%\tools" "%OUT%\tools" /E /NFL /NDL /NJH /NJS /NP >nul

echo  [4/6] Repositorios + checkpoint do FaceAnything...
robocopy "%APP%\models_src" "%OUT%\models_src" /E /NFL /NDL /NJH /NJS /NP >nul

echo  [5/6] Pesos do HuggingFace (SHARP / TripoSR / etc.)...
if exist "%HF%" robocopy "%HF%" "%OUT%\huggingface" /E /NFL /NDL /NJH /NJS /NP >nul

echo  [6/6] Wheels dos CLIs (splat4d / sharp) p/ recriar atalhos no destino...
mkdir "%OUT%\cli_wheels" 2>nul
"%UV%" pip install --python "%APP%\pyenv\Scripts\python.exe" pip >nul 2>nul
"%APP%\pyenv\Scripts\python.exe" -m pip wheel --no-deps -w "%OUT%\cli_wheels" splats4d "sharp @ git+https://github.com/apple/ml-sharp.git" >nul 2>nul

echo.
echo  [OK] Pacote pronto em:
echo       %OUT%
echo.
echo  Copie a pasta inteira para o outro PC e rode instalar_offline.bat de dentro dela.
echo.
pause
