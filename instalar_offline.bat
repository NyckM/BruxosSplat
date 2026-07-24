@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title BruxoSplat - Instalar OFFLINE (portatil)

rem ============================================================================
rem  Instala TODOS os modelos a partir da pasta BruxoSplat_offline (feita pelo
rem  criar_pacote_offline.bat). Recria cada ambiente Python (o compartilhado e os
rem  isolados do TripoSplat/FaceAnything) e coloca as bibliotecas ja prontas.
rem  Funciona em outro PC Windows 64-bit, SEM internet. Rode de DENTRO da pasta.
rem ============================================================================

set "SRC=%~dp0"
set "APP=%APPDATA%\BruxoSplat"
set "UV=%SRC%tools\uv.exe"
set "HF=%USERPROFILE%\.cache\huggingface"
set "PYHOME=%APPDATA%\uv\python"
set "PYDST=%PYHOME%\cpython-3.11-windows-x86_64-none"

if not exist "%SRC%venvs" ( echo  [ERRO] Rode este .bat de DENTRO da pasta BruxoSplat_offline. & pause & exit /b 1 )
if not exist "%UV%" ( echo  [ERRO] uv nao encontrado no pacote (tools\uv.exe). & pause & exit /b 1 )

echo.
echo  Instalando os modelos (offline) em: %APP%
echo.

rem 1) Python do pacote onde o uv procura
if exist "%SRC%python" (
  echo  [1/4] Instalando o interpretador Python...
  mkdir "%PYHOME%" 2>nul
  if not exist "%PYDST%" robocopy "%SRC%python" "%PYDST%" /E /NFL /NDL /NJH /NJS /NP >nul
  set "BASEPY=%PYDST%\python.exe"
)

rem 2) recria cada ambiente (venv novo -> caminhos corretos) e copia as libs prontas
echo  [2/4] Recriando ambientes Python...
mkdir "%APP%" 2>nul
for /d %%V in ("%SRC%venvs\*") do (
  echo        - %%~nxV
  if exist "%APP%\%%~nxV" rmdir /s /q "%APP%\%%~nxV"
  if defined BASEPY (
    "%UV%" venv "%APP%\%%~nxV" --python "%BASEPY%" >nul 2>nul
  ) else (
    "%UV%" venv "%APP%\%%~nxV" --python 3.11 >nul 2>nul
  )
  robocopy "%%V\site-packages" "%APP%\%%~nxV\Lib\site-packages" /E /NFL /NDL /NJH /NJS /NP >nul
  copy /y "%%V\.installed_*" "%APP%\%%~nxV\" >nul 2>nul
  rem recria os atalhos de CLI (splat4d/sharp) no ambiente compartilhado
  if /i "%%~nxV"=="pyenv" (
    if exist "%SRC%cli_wheels" for %%W in ("%SRC%cli_wheels\*.whl") do "%UV%" pip install --python "%APP%\pyenv\Scripts\python.exe" --no-index --no-deps --reinstall "%%W" >nul 2>nul
  )
)

rem 3) ferramentas e repositorios/checkpoint
echo  [3/4] Copiando ferramentas e repositorios...
robocopy "%SRC%tools" "%APP%\tools" /E /NFL /NDL /NJH /NJS /NP >nul
robocopy "%SRC%models_src" "%APP%\models_src" /E /NFL /NDL /NJH /NJS /NP >nul

rem 4) pesos do HuggingFace
echo  [4/4] Copiando pesos do HuggingFace...
if exist "%SRC%huggingface" ( mkdir "%HF%" 2>nul & robocopy "%SRC%huggingface" "%HF%" /E /NFL /NDL /NJH /NJS /NP >nul )

echo.
echo  [OK] Modelos instalados offline! Abra o BruxoSplat - eles ja aparecem na aba IA.
echo.
pause
