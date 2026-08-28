/**
 * Windows Auto-Run: จัดการ entry ใน HKCU\Software\Microsoft\Windows\CurrentVersion\Run
 * เพื่อให้โปรแกรมเริ่มต้นทำงานอัตโนมัติพร้อมเปิดคอมพิวเตอร์
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execSync } from "node:child_process"
import { ROOT_DIR } from "./config.js"
import { logger } from "./util.js"

const log = logger("autostart")
const REG_PATH = "Software\\Microsoft\\Windows\\CurrentVersion\\Run"
const APP_NAME = "SteamChatOverlay"

export function isAutoRunEnabled() {
	if (os.platform() !== "win32") return false
	try {
		const result = execSync(`reg query "HKCU\\${REG_PATH}" /v "${APP_NAME}" 2>nul`, {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
		})
		return result.includes(APP_NAME)
	} catch {
		return false
	}
}

export function setAutoRun(enabled, minimized = false) {
	if (os.platform() !== "win32") {
		throw new Error("Auto Run ใช้ได้เฉพาะ Windows")
	}
	const batPath = path.join(ROOT_DIR, minimized ? "start-minimized.bat" : "start.bat")
	if (enabled) {
		if (!fs.existsSync(batPath)) {
			throw new Error(`ไม่พบไฟล์ ${path.basename(batPath)}`)
		}
		const cmd = `"${batPath}"`
		execSync(`reg add "HKCU\\${REG_PATH}" /v "${APP_NAME}" /t REG_SZ /d ${JSON.stringify(cmd)} /f`, {
			stdio: "ignore",
		})
		log.info(`เปิด Auto Run: ${path.basename(batPath)}`)
	} else {
		execSync(`reg delete "HKCU\\${REG_PATH}" /v "${APP_NAME}" /f 2>nul`, { stdio: "ignore" })
		log.info("ปิด Auto Run แล้ว")
	}
}
