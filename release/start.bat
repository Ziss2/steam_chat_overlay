@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

REM ตรวจสอบ Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [ผิดพลาด] ไม่พบ Node.js โปรดติดตั้ง Node.js 20 ขึ้นไปจาก https://nodejs.org
  pause
  exit /b 1
)

REM ติดตั้ง dependencies เฉพาะครั้งแรก
if not exist node_modules (
  echo กำลังติดตั้ง dependencies ครั้งแรก
  call npm install
  if errorlevel 1 (
    echo [ผิดพลาด] npm install ล้มเหลว
    pause
    exit /b 1
  )
)

echo เริ่มรัน Steam Chat Overlay  กด Ctrl+C เพื่อหยุด
echo หน้าตั้งค่า  http://127.0.0.1:4700/config
echo URL สำหรับ OBS  http://127.0.0.1:4700/overlay
echo ถ้าต่อผ่าน VPN ให้ใช้ IP ที่ขึ้นใน log แทน 127.0.0.1
echo เริ่มซ่อน console: start-minimized.bat

REM เปิดหน้าตั้งค่าหลังเซิร์ฟเวอร์บูตครบประมาณ 4 วินาที
start "" cmd /c "timeout /t 4 /nobreak >nul && start http://127.0.0.1:4700/config"

call npm start
