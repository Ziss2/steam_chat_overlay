@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ผิดพลาด] ไม่พบ Node.js โปรดติดตั้ง Node.js 20 ขึ้นไปจาก https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo กำลังติดตั้ง dependencies ครั้งแรก
  call npm install
  if errorlevel 1 (
    echo [ผิดพลาด] npm install ล้มเหลว
    pause
    exit /b 1
  )
)

start "" /min cmd /c npm start
