/**
 * Translation overlay client: receives translation events over WebSocket and renders them.
 *
 * Query params:
 *   ?platform=twitch|youtube   show only one platform
 *   ?debug=1                   show connection errors on screen
 *   ?fontSize=24&width=380 ... override any theme value for this browser source only
 */
const chat = document.getElementById("chat")
const statusEl = document.getElementById("status")
const params = new URLSearchParams(location.search)
const platformFilter = (params.get("platform") || "").split(",").map((value) => value.trim()).filter(Boolean)
const debug = params.has("debug")

const THEME_NUMBERS = new Set([
	"fontSize", "fontWeight", "lineHeight", "width", "radius", "gap", "padding", "bgOpacity",
])
const THEME_BOOLEANS = new Set([
	"showTimestamps",
])

let theme = null
const timers = new Map()

function applyTheme(next) {
	theme = { ...next }
	const style = document.documentElement.style
	style.setProperty("--font-family", theme.fontFamily)
	style.setProperty("--font-size", `${theme.fontSize}px`)
	style.setProperty("--line-height", String(theme.lineHeight))
	style.setProperty("--width", `${theme.width}px`)
	style.setProperty("--radius", `${theme.radius}px`)
	style.setProperty("--gap", `${theme.gap}px`)
	style.setProperty("--padding", `${theme.padding}px`)
	style.setProperty("--text-color", theme.textColor)
	style.setProperty("--original-color", theme.textColor ? `${theme.textColor}99` : "rgba(255,255,255,0.55)")
	style.setProperty("--twitch-color", theme.twitchColor)
	style.setProperty("--youtube-color", theme.youtubeColor)
	style.setProperty("--kick-color", theme.kickColor)
	style.setProperty("--tiktok-color", theme.tiktokColor)
	style.setProperty("--bg-opacity", String(theme.bgOpacity ?? 0.75))
}

function escapeHtml(value) {
	return String(value ?? "").replace(/[&<>"']/g, (char) =>
		({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
	)
}

function timeLabel(timestamp) {
	const date = new Date(timestamp || Date.now())
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

function addMessage(data) {
	if (!theme) return
	if (platformFilter.length && !platformFilter.includes(data.platform)) return
	const element = document.createElement("article")
	element.className = "msg"
	element.dataset.platform = data.platform
	const time = theme.showTimestamps ? `<span class="time">${timeLabel(data.timestamp)}</span>` : ""
	element.innerHTML = `
		<div class="content">
			<div class="head">
				<span class="name">${escapeHtml(data.author?.display || data.author?.name || "?")}</span>
				${time}
			</div>
			<div class="original">${escapeHtml(data.original)}</div>
			<div class="translated">${escapeHtml(data.translated)}</div>
		</div>
	`
	if (theme.direction === "top") chat.prepend(element)
	else chat.append(element)
	const lifetime = Number(theme.messageLifetimeSec) || 0
	if (lifetime > 0) timers.set(element, setTimeout(() => removeElement(element), lifetime * 1000))
	trim()
}

function removeElement(element) {
	if (!element || element.dataset.leaving === "1") return
	element.dataset.leaving = "1"
	const timer = timers.get(element)
	if (timer) {
		clearTimeout(timer)
		timers.delete(element)
	}
	element.classList.add("leaving")
	setTimeout(() => element.remove(), 400)
}

function trim() {
	if (!theme) return
	const max = Math.max(1, Number(theme.maxMessages) || 25)
	const nodes = [...chat.children].filter((node) => node.dataset.leaving !== "1")
	if (nodes.length <= max) return
	const excess = nodes.length - max
	const oldest = theme.direction === "top" ? nodes.slice(-excess) : nodes.slice(0, excess)
	for (const node of oldest) removeElement(node)
}

function setStatusMessage(text) {
	if (!debug) {
		statusEl.hidden = true
		return
	}
	statusEl.hidden = !text
	statusEl.textContent = text || ""
}

let socket = null
let retryDelay = 800

function connect() {
	const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws-translations`
	socket = new WebSocket(url)

	socket.addEventListener("open", () => {
		retryDelay = 800
		setStatusMessage("")
	})

	socket.addEventListener("message", (event) => {
		let payload
		try {
			payload = JSON.parse(event.data)
		} catch {
			return
		}
		switch (payload.type) {
			case "hello":
				if (payload.config?.theme) applyTheme(payload.config.theme)
				chat.replaceChildren()
				break
			case "config":
				if (payload.config?.theme) applyTheme(payload.config.theme)
				break
			case "translation":
				addMessage(payload)
				break
			default:
				break
		}
	})

	socket.addEventListener("close", () => {
		setStatusMessage("ไม่ได้เชื่อมต่อเซิร์ฟเวอร์ translation overlay — กำลังลองใหม่")
		setTimeout(connect, retryDelay)
		retryDelay = Math.min(retryDelay * 1.6, 5000)
	})

	socket.addEventListener("error", () => socket?.close())
}

connect()
