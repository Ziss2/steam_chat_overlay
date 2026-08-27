/**
 * Config panel: generic form binding via data-path, live-saved to the server.
 * Every save triggers a WebSocket broadcast so OBS and the preview update instantly.
 */
const STATE_LABELS = {
	disabled: "ปิดอยู่",
	idle: "รอ",
	connecting: "กำลังต่อ",
	connected: "ต่อแล้ว",
	reconnecting: "กำลังต่อใหม่",
	waiting: "รอไลฟ์",
	error: "ผิดพลาด",
}

const savedHint = document.getElementById("saved-hint")
let currentConfig = null
let applyingRemote = false
let savedTimer = null

function getPath(object, path) {
	return path.split(".").reduce((accumulator, key) => (accumulator == null ? undefined : accumulator[key]), object)
}

function buildPatch(path, value) {
	const keys = path.split(".")
	const patch = {}
	let cursor = patch
	keys.forEach((key, index) => {
		if (index === keys.length - 1) cursor[key] = value
		else {
			cursor[key] = {}
			cursor = cursor[key]
		}
	})
	return patch
}

function readControl(element) {
	if (element.type === "checkbox") return element.checked
	if (element.dataset.list) {
		return element.value
			.split(/[\n,]/)
			.map((item) => item.trim())
			.filter(Boolean)
	}
	if (element.type === "number" || element.type === "range") return Number(element.value)
	return element.value
}

function writeControl(element, value) {
	if (element.type === "checkbox") element.checked = Boolean(value)
	else if (element.dataset.list) element.value = Array.isArray(value) ? value.join("\n") : String(value ?? "")
	else element.value = value ?? ""
	syncOutput(element)
}

function syncOutput(element) {
	const path = element.dataset.path
	if (!path) return
	const output = document.querySelector(`[data-output="${path}"]`)
	if (output) output.textContent = element.value
}

function flashSaved() {
	savedHint.hidden = false
	clearTimeout(savedTimer)
	savedTimer = setTimeout(() => {
		savedHint.hidden = true
	}, 1200)
}

async function saveConfig(patch) {
	const response = await fetch("/api/config", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	})
	if (!response.ok) {
		const error = await response.json().catch(() => ({}))
		alert(`บันทึกไม่สำเร็จ: ${error.error || response.status}`)
		return
	}
	const data = await response.json()
	currentConfig = data.config
	flashSaved()
	updateUrls()
}

const pending = new Map()
function queueSave(path, value) {
	pending.set(path, value)
	clearTimeout(queueSave.timer)
	queueSave.timer = setTimeout(() => {
		const entries = [...pending.entries()]
		pending.clear()
		let patch = {}
		for (const [key, item] of entries) patch = deepMergeLocal(patch, buildPatch(key, item))
		saveConfig(patch)
	}, 220)
}

function deepMergeLocal(base, extra) {
	const out = { ...base }
	for (const [key, value] of Object.entries(extra)) {
		if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object") {
			out[key] = deepMergeLocal(out[key], value)
		} else {
			out[key] = value
		}
	}
	return out
}

function bindControls() {
	for (const element of document.querySelectorAll("[data-path]")) {
		const eventName = element.tagName === "SELECT" || element.type === "checkbox" ? "change" : "input"
		element.addEventListener(eventName, () => {
			syncOutput(element)
			if (applyingRemote) return
			queueSave(element.dataset.path, readControl(element))
		})
	}
}

function populate(config) {
	applyingRemote = true
	currentConfig = config
	for (const element of document.querySelectorAll("[data-path]")) {
		const value = getPath(config, element.dataset.path)
		if (value === undefined) continue
		// Don't stomp what the user is typing right now.
		if (document.activeElement === element) continue
		writeControl(element, value)
	}
	const apiKeyInput = document.querySelector('[data-path="youtube.apiKey"]')
	if (apiKeyInput && config.youtube.apiKeyFromEnv) {
		apiKeyInput.placeholder = "ใช้ค่าจาก .env อยู่"
	}
	applyingRemote = false
	updateUrls()
}

function updateUrls() {
	const base = `${location.origin}/overlay`
	const set = (id, value) => {
		const input = document.getElementById(id)
		if (input) input.value = value
	}
	set("overlay-url", base)
	set("overlay-url-twitch", `${base}?platform=twitch`)
	set("overlay-url-youtube", `${base}?platform=youtube`)
	set("overlay-url-kick", `${base}?platform=kick`)
	set("overlay-url-tiktok", `${base}?platform=tiktok`)
}

function renderStatus(status) {
	const platforms = ["twitch", "youtube", "kick", "tiktok"]
	for (const platform of platforms) {
		const info = status[platform] || {}
		const pill = document.getElementById(`status-${platform}`)
		if (!pill) continue
		pill.dataset.state = info.state || "disabled"
		const detail = info.detail ? ` • ${info.detail}` : ""
		const channel = info.channel ? ` • ${info.channel.startsWith("@") || info.channel.startsWith("#") ? info.channel : (platform === "twitch" ? `#${info.channel}` : `@${info.channel}`)}` : ""
		pill.textContent = `${platform}: ${STATE_LABELS[info.state] || info.state || "—"}${channel}${detail}`
	}
}

document.addEventListener("click", async (event) => {
	const button = event.target.closest("[data-action]")
	if (!button) return
	const { action } = button.dataset
	if (action === "reconnect") {
		button.disabled = true
		await fetch("/api/reconnect", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ platform: button.dataset.platform }),
		})
		button.disabled = false
	}
	if (action === "test") {
		await fetch("/api/test", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ platform: button.dataset.platform, kind: button.dataset.kind }),
		})
	}
	if (action === "clear") {
		await fetch("/api/clear", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
	}
	if (action === "copy") {
		const input = document.getElementById(button.dataset.target)
		if (!input) return
		await navigator.clipboard.writeText(input.value).catch(() => input.select())
		const original = button.textContent
		button.textContent = "คัดลอกแล้ว"
		setTimeout(() => {
			button.textContent = original
		}, 1200)
	}
})

function connectSocket() {
	const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`)
	socket.addEventListener("message", (event) => {
		let payload
		try {
			payload = JSON.parse(event.data)
		} catch {
			return
		}
		if (payload.type === "hello") {
			renderStatus(payload.status)
			if (!currentConfig) populate(payload.config)
		}
		if (payload.type === "status") renderStatus(payload.status)
		if (payload.type === "config" && payload.config) populate(payload.config)
	})
	socket.addEventListener("close", () => setTimeout(connectSocket, 1500))
}

async function init() {
	bindControls()
	const response = await fetch("/api/config")
	const data = await response.json()
	populate(data.config)
	renderStatus(data.status)
	connectSocket()
}

init().catch((error) => {
	console.error(error)
	alert(`โหลดค่าไม่สำเร็จ: ${error.message}`)
})
