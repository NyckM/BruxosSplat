@echo off
setlocal
chcp 65001 >nul
title BruxoSplat - Backup dos modelos

rem ============================================================================
rem  Cria UM arquivo unico com TODOS os modelos ja baixados (venv Python, torch,
rem  ferramentas, repositorios clonados, checkpoints e os pesos do HuggingFace).
rem  Guarde o .tar gerado. Se os modelos sairem do ar, use instalar_modelos.bat
rem  pra reinstalar tudo sem internet.
rem ============================================================================

set "APP=%APPDATA%\BruxoSplat"
set "HFROOT=%USERPROFILE%\.cache"
set "OUT=%~dp0BruxoSplat_modelos_backup.tar"

echo.
echo  Origem 1: %APP%
echo  Origem 2: %HFROOT%\huggingface  (pesos SHARP / TripoSR)
echo  Destino : %OUT%
echo.

if not exist "%APP%" (
  echo  [ERRO] Nao achei os modelos em "%APP%".
  echo         Abra o BruxoSplat e instale os modelos na aba IA primeiro.
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

echo  Compactando... pode demorar bastante e o arquivo pode ficar com varios GB.
echo  (nao feche esta janela)
echo.

if exist "%HFROOT%\huggingface" (
  tar -cf "%OUT%" -C "%APPDATA%" BruxoSplat -C "%HFROOT%" huggingface
) else (
  tar -cf "%OUT%" -C "%APPDATA%" BruxoSplat
)

if errorlevel 1 (
  echo.
  echo  [ERRO] Falha ao criar o backup.
  echo.
  pause
  exit /b 1
)

echo.
echo  [OK] Backup criado:
echo       %OUT%
echo.
echo  Guarde esse arquivo num lugar seguro (HD externo, nuvem, etc.).
echo  Pra reinstalar depois, coloque instalar_modelos.bat na MESMA pasta e rode.
echo.
pause
