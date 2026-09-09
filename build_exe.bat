@echo off
rem ============================================================
rem  OsuSkinMaker (Tauri) 一键打包 - 双击运行或用 cmd 调用
rem  等价于：powershell -ExecutionPolicy Bypass -File .\build_exe.ps1
rem ============================================================
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0build_exe.ps1" %*
echo.
pause