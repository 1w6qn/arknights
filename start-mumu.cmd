@echo off
rem ============================================================================
rem  DoctorateTs - MuMu one-click start (Windows double-click entry)
rem
rem  Chain: MuMu emulator -> adb device -> 4 Windows-side relays -> WSL private
rem         server -> frida hook build -> cold start game -> ARM64 gadget +
rem         il2cpp injection.
rem
rem  Real logic (readable / runnable on its own):
rem    scripts/mumu-boot.mjs   Windows side: emulator / adb / relay / hand off
rem    scripts/mumu-start.sh   WSL side: private server / hook build / inject
rem    scripts/mumu-relay.mjs  Windows side: the 4-port relay group
rem
rem  Common args (passed through):
rem    --dry-run          self-check only, start nothing
rem    --no-frida         infra only (emulator + server + relay + adb + hook)
rem    --duration 120     injection seconds (default 600)
rem    --no-restart       attach to the running process instead of cold start
rem    --pubkey-mode ours swap pubkey AND inject the Lua payload (default: oursonly)
rem ============================================================================
setlocal
chcp 65001 >nul
title MuMu One-Click (DoctorateTs)
cd /d "%~dp0"

echo ============================================
echo   DoctorateTs - MuMu one-click start
echo ============================================
echo.

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE=%ProgramFiles%\nodejs\node.exe"
  ) else (
    echo [error] node not found: install Node.js or add it to PATH
    pause
    exit /b 1
  )
)

if not exist node_modules (
  echo [first run] installing dependencies...
  call pnpm install
  if errorlevel 1 goto :err
)

"%NODE%" scripts\mumu-boot.mjs %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo [warn] exit code %RC% - check the output above and tmp\mumu\*.log
) else (
  echo [ok] MuMu one-click chain finished
)
echo.
echo logs: tmp\mumu\server.log ^(private server^), tmp\mumu\frida.log ^(injection^)
pause
exit /b %RC%

:err
echo.
echo [error] dependency install failed - see output above
pause
exit /b 1
