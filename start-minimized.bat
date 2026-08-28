@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

powershell -WindowStyle Hidden -Command "Set-Location '%~dp0'; npm start"
