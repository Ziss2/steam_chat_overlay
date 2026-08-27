/**
 * Overlay client: receives normalized chat messages over WebSocket and renders them.
 *
 * Query params:
 *   ?platform=twitch|youtube   show only one platform
 *   ?debug=1                   show connection errors on screen
 *   ?preview=1                 checkerboard background (used by the config page)
 *   ?fontSize=24&width=380 ... override any theme value for this browser source only
 */
const chat = document.getElementById("chat")
const statusEl = document.getElementById("status")
const params = new URLSearchParams(location.search)
const platformFilter = (params.get("platform") || "").split(",").map((value) => value.trim()).filter(Boolean)
const debug = params.has("debug") || params.has("preview")

const PLATFORM_ICONS = {
	twitch: `<svg class="platform-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4.3 0 1 3.3v17.4h5.7V24l3.4-3.3h2.8L19.6 14V0H4.3Zm13.6 13.1-3.4 3.3H11l-3 2.9v-2.9H4.7V1.9h13.2v11.2ZM14.8 5.4h1.9v5.6h-1.9V5.4Zm-5 0h1.9v5.6H9.8V5.4Z"/></svg>`,
	youtube: `<svg class="platform-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23 7.1a3 3 0 0 0-2.1-2.1C19 4.5 12 4.5 12 4.5s-7 0-8.9.5A3 3 0 0 0 1 7.1C.5 9 .5 12 .5 12s0 3 .5 4.9A3 3 0 0 0 3.1 19c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1c.5-1.9.5-4.9.5-4.9s0-3-.5-4.9ZM9.8 15.5v-7l6 3.5-6 3.5Z"/></svg>`,
}

const THEME_NUMBERS = new Set([
	"fontSize", "fontWeight", "nameWeight", "lineHeight", "width", "avatarSize",
	"radius", "gap", "padding", "emoteSize", "maxMessages", "messageLifetimeSec", "bgOpacity",
])
const THEME_BOOLEANS = new Set([
	"outline", "shadow", "accentBar", "showPlatformIcon", "showBadges", "showEmotes", "showTimestamps",
	"showAvatar", "liveMotion",
])

let theme = null
const timers = new Map()

function hexToRgba(hex, opacity) {
	const value = String(hex || "#000000").trim()
	const alpha = Math.max(0, Math.min(Number(opacity ?? 1), 1))
	const match = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(value)
	if (!match) return value // already rgba()/named color
	let digits = match[1]
	if (digits.length === 3) digits = digits.split("").map((char) => char + char).join("")
	const num = Number.parseInt(digits, 16)
	return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`
}

/** Theme from server + per-browser-source overrides from the query string. */
function withOverrides(base) {
	const merged = { ...base }
	for (const [key, raw] of params.entries()) {
		if (!(key in merged)) continue
		if (THEME_NUMBERS.has(key)) merged[key] = Number(raw)
		else if (THEME_BOOLEANS.has(key)) merged[key] = raw !== "0" && raw !== "false"
		else merged[key] = raw
	}
	return merged
}

function applyTheme(next) {
	theme = withOverrides(next)
	const style = document.documentElement.style
	style.setProperty("--font-family", theme.fontFamily)
	style.setProperty("--font-size", `${theme.fontSize}px`)
	style.setProperty("--font-weight", String(theme.fontWeight))
	style.setProperty("--name-weight", String(theme.nameWeight))
	style.setProperty("--line-height", String(theme.lineHeight))
	style.setProperty("--width", `${theme.width}px`)
	style.setProperty("--radius", `${theme.radius}px`)
	style.setProperty("--gap", `${theme.gap}px`)
	style.setProperty("--padding", `${theme.padding}px`)
	style.setProperty("--emote-size", `${theme.emoteSize}px`)
	style.setProperty("--avatar-size", `${theme.avatarSize}px`)
	style.setProperty("--bubble-bg", theme.bubbleColor)
	style.setProperty("--bubble-fg", theme.bubbleTextColor)
	style.setProperty("--msg-bg", hexToRgba(theme.bgColor, theme.bgOpacity))
	style.setProperty("--text-color", theme.textColor)
	style.setProperty("--twitch-color", theme.twitchColor)
	style.setProperty("--youtube-color", theme.youtubeColor)

	const layout = ["card", "compact", "bubble"].includes(theme.layout) ? theme.layout : "card"
	chat.className = [
		"chat",
		`dir-${theme.direction === "top" ? "top" : "bottom"}`,
		`align-${theme.align === "right" ? "right" : "left"}`,
		`layout-${layout}`,
		`anim-${theme.animation}`,
		theme.outline ? "outline" : "",
		theme.shadow ? "shadow" : "",
		theme.liveMotion ? "motion" : "",
	]
		.filter(Boolean)
		.join(" ")

	const solid = theme.background && theme.background !== "transparent"
	document.body.classList.toggle("bg-solid", Boolean(solid))
	document.body.style.setProperty("--page-bg", solid ? theme.background : "transparent")
	if (params.has("preview") && !solid) {
		document.body.style.background =
			"repeating-conic-gradient(#2a2f3a 0% 25%, #222732 0% 50%) 50% / 20px 20px"
	}
	trim()
}

function nameColor(message) {
	if (!theme) return ""
	if (theme.colorMode === "fixed") return theme.textColor
	if (theme.colorMode === "chat" && message.author.color) return message.author.color
	return message.platform === "youtube" ? theme.youtubeColor : theme.twitchColor
}

function renderBadges(message) {
	const BADGE_SYMBOLS = {
		broadcaster: "💜",
		owner: "💜",
		moderator: "🛡️",
		mod: "🛡️",
		vip: "💎",
		subscriber: "⭐",
		founder: "🎖️",
		premium: "🔰",
		turbo: "⚡",
		partner: "🟣",
		staff: "🏢",
		"sub-gifter": "🎁",
		"bits-leader": "🏆",
		member: "⭐",
		verified: "✔️",
		artist: "🎨",
	}
	if (!theme.showBadges || !message.author.badges?.length) return ""
	return `<span class="badges">${message.author.badges
		.map((badge) => {
			const title = escapeAttr(badge.label)
			if (badge.image) {
				return `<img class="badge-img" src="${escapeAttr(badge.image)}" alt="${title}" title="${title}" />`
			}
			const symbol = BADGE_SYMBOLS[badge.id] || BADGE_SYMBOLS[String(badge.id).toLowerCase()] || "🔰"
			return `<span class="badge-pill" data-badge="${escapeAttr(badge.id)}" title="${title}">${symbol}</span>`
		})
		.join("")}</span>`
}

function escapeHtml(value) {
	return String(value ?? "").replace(/[&<>"']/g, (char) =>
		({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
	)
}

function escapeAttr(value) {
	return escapeHtml(value)
}

function renderFragments(message) {
	return message.fragments
		.map((fragment) => {
			if (fragment.type === "emote") {
				return `<img class="emote" src="${escapeAttr(fragment.url)}" alt="${escapeAttr(fragment.name)}" title="${escapeAttr(fragment.name)}" data-provider="${escapeAttr(fragment.provider || "")}" data-zero-width="${fragment.zeroWidth ? "true" : "false"}" loading="lazy" />`
			}
			return escapeHtml(fragment.text)
		})
		.join("")
}

function timeLabel(timestamp) {
	const date = new Date(timestamp || Date.now())
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

/* ===== Avatar (Twitch ต้องถามเซิร์ฟเวอร์, YouTube มาพร้อมข้อความแล้ว) ===== */
const avatarCache = new Map()
const avatarInflight = new Map()

function rememberAvatar(login, url) {
	if (avatarCache.size > 500) avatarCache.clear()
	avatarCache.set(login, url)
	return url
}

function lookupAvatar(message) {
	if (message.author.avatar) return Promise.resolve(message.author.avatar)
	if (message.platform !== "twitch") return Promise.resolve("")
	const login = (message.author.name || "").toLowerCase()
	if (!login) return Promise.resolve("")
	if (avatarCache.has(login)) return Promise.resolve(avatarCache.get(login))
	if (!avatarInflight.has(login)) {
		const request = fetch(`/api/avatar?platform=twitch&login=${encodeURIComponent(login)}`)
			.then((response) => (response.ok ? response.json() : { url: "" }))
			.then((data) => rememberAvatar(login, data.url || ""))
			.catch(() => rememberAvatar(login, ""))
			.finally(() => avatarInflight.delete(login))
		avatarInflight.set(login, request)
	}
	return avatarInflight.get(login)
}

function attachAvatar(element, message) {
	const holder = element.querySelector(".avatar")
	if (!holder) return
	lookupAvatar(message).then((url) => {
		if (!url || !holder.isConnected) return
		const image = new Image()
		image.alt = ""
		image.addEventListener("load", () => {
			holder.textContent = ""
			holder.append(image)
		})
		image.src = url
	})
}

function avatarInitial(message) {
	const name = (message.author.display || message.author.name || "?").replace(/^@/, "")
	return (Array.from(name)[0] || "?").toUpperCase()
}

function headHtml(message) {
	const icon = theme.showPlatformIcon ? PLATFORM_ICONS[message.platform] || "" : ""
	const time = theme.showTimestamps ? `<span class="time">${timeLabel(message.timestamp)}</span>` : ""
	const separator = theme.layout === "compact" && message.kind === "chat" ? `<span class="colon">:</span>` : ""
	return `${icon}${renderBadges(message)}<span class="name">${escapeHtml(message.author.display)}</span>${separator}${time}`
}

function buildMessageElement(message) {
	const element = document.createElement("article")
	const withAvatar = Boolean(theme.showAvatar)
	element.className = [
		"msg",
		message.kind === "event" ? "event" : "",
		message.system === "action" ? "action" : "",
		withAvatar ? "has-avatar" : "",
	]
		.filter(Boolean)
		.join(" ")
	element.dataset.id = message.id
	element.dataset.platform = message.platform
	element.style.setProperty("--name-color", nameColor(message))
	if (message.event?.bg) element.style.setProperty("--event-bg", message.event.bg)
	if (message.event?.fg) element.style.setProperty("--event-fg", message.event.fg)

	const chip = message.event
		? `<span class="event-chip">${escapeHtml(message.event.label)}${message.event.amount ? `<b class="event-amount">${escapeHtml(message.event.amount)}</b>` : ""}</span>`
		: ""
	const systemLine =
		message.system && message.system !== "action"
			? `<span class="system-msg">${escapeHtml(message.system)}</span>`
			: ""
	const avatar = withAvatar ? `<div class="avatar">${escapeHtml(avatarInitial(message))}</div>` : ""
	const body = `${chip}${systemLine}<span class="text">${renderFragments(message)}</span>`

	element.innerHTML =
		theme.layout === "bubble"
			? `
		${avatar}
		<div class="bubble">
			<span class="name-pill">${headHtml(message)}</span>
			${body}
		</div>`
			: `
		${theme.accentBar ? '<span class="accent"></span>' : ""}
		${avatar}
		<div class="content">
			<span class="head">${headHtml(message)}</span>
			${body}
		</div>`

	if (withAvatar) attachAvatar(element, message)
	return element
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

function addMessage(message) {
	if (!theme) return
	if (platformFilter.length && !platformFilter.includes(message.platform)) return
	if (chat.querySelector(`[data-id="${CSS.escape(message.id)}"]`)) return
	const element = buildMessageElement(message)
	if (theme.direction === "top") chat.prepend(element)
	else chat.append(element)
	const lifetime = Number(theme.messageLifetimeSec) || 0
	if (lifetime > 0) timers.set(element, setTimeout(() => removeElement(element), lifetime * 1000))
	trim()
}

function removeMessages({ ids = [], authorIds = [], authorNames = [], platform }) {
	const idSet = new Set(ids)
	const authorIdSet = new Set(authorIds)
	const nameSet = new Set(authorNames.map((name) => String(name).toLowerCase()))
	for (const node of [...chat.children]) {
		if (platform && node.dataset.platform !== platform) continue
		if (idSet.has(node.dataset.id)) removeElement(node)
	}
	if (!authorIdSet.size && !nameSet.size) return
	// Author info is not in the DOM, so rely on the server clearing the buffer and
	// match on the rendered display name as a best effort.
	for (const node of [...chat.children]) {
		const name = node.querySelector(".name")?.textContent?.toLowerCase() || ""
		if (nameSet.has(name)) removeElement(node)
	}
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
	const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`
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
				applyTheme(payload.config.theme)
				chat.replaceChildren()
				for (const message of payload.recent || []) addMessage(message)
				break
			case "config":
				applyTheme(payload.config.theme)
				break
			case "chat":
				addMessage(payload.message)
				break
			case "remove":
				removeMessages(payload)
				break
			case "clear":
				if (!payload.platform) chat.replaceChildren()
				else {
					for (const node of [...chat.children]) {
						if (node.dataset.platform === payload.platform) removeElement(node)
					}
				}
				break
			default:
				break
		}
	})

	socket.addEventListener("close", () => {
		setStatusMessage("ไม่ได้เชื่อมต่อเซิร์ฟเวอร์ overlay — กำลังลองใหม่")
		setTimeout(connect, retryDelay)
		retryDelay = Math.min(retryDelay * 1.6, 5000)
	})

	socket.addEventListener("error", () => socket?.close())
}

connect()
