@echo off
rem Memory Atlas Alpha-01 — Windows 双击启动入口
rem 前提：desktop\node_modules 已安装（见 README-ALPHA.md 的首次安装步骤）
setlocal
set "ALPHA_ROOT=%~dp0"
set "ELECTRON_EXE=%ALPHA_ROOT%desktop\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON_EXE%" (
  echo [Memory Atlas Alpha] Electron 二进制缺失，尝试补齐（需要网络，仅首次）…
  pushd "%ALPHA_ROOT%desktop"
  call node_modules\.bin\install-electron.cmd
  popd
)
if not exist "%ELECTRON_EXE%" (
  echo [Memory Atlas Alpha] Electron 运行时还没有就绪。
  echo 请先执行一次：
  echo     cd /d "%ALPHA_ROOT%desktop"
  echo     npm install
  echo     node_modules\.bin\install-electron
  echo 之后双击本文件即可启动。
  pause
  exit /b 1
)

start "" "%ELECTRON_EXE%" "%ALPHA_ROOT%desktop" %*
endlocal
