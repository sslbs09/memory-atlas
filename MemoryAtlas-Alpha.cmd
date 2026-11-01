@echo off
rem Memory Atlas Alpha-01 - Windows launch entry (double-click friendly).
rem Prerequisite: desktop\node_modules installed once (see README-ALPHA.md).
setlocal
set "ALPHA_ROOT=%~dp0"
set "ELECTRON_EXE=%ALPHA_ROOT%desktop\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON_EXE%" (
  echo [Memory Atlas Alpha] Electron binary missing, trying to fetch it once...
  pushd "%ALPHA_ROOT%desktop"
  call node_modules\.bin\install-electron.cmd
  popd
)
if not exist "%ELECTRON_EXE%" (
  echo [Memory Atlas Alpha] Electron runtime is not ready.
  echo Run once from a terminal:
  echo     cd /d "%ALPHA_ROOT%desktop"
  echo     npm install
  echo     node_modules\.bin\install-electron
  echo Then double-click this file again.
  pause
  exit /b 1
)

start "" "%ELECTRON_EXE%" "%ALPHA_ROOT%desktop" %*
endlocal
