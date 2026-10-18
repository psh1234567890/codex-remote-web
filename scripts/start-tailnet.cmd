@echo off
setlocal
cd /d "%~dp0.."
rem ExecutionPolicy Bypass applies only to this PowerShell process.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-tailnet.ps1" %*
exit /b %ERRORLEVEL%
