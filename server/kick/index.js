/**
 * Kick chat source: reads public chat via Kick's Pusher-compatible websocket.
 * No login or API key required — we only subscribe to the chatroom channel.
 *
 *   1. Resolve the chatroom id from the public channel API.
 *   2. Open wss://ws.kick.com/websocket and subscribe to chatrooms.{id}.v2
 *   3. React to App\Events\ChatMessageEvent (data is a JSON string of one message object).
 */
import { WebSocket } from "ws"
import { createEvent, createMessage, emoteFragment, textFragment } from "../message.js"
import { Backoff, fetchJson, logger, sleep } from "../util.js"

const log = logger("kick")
const WS_URL = "wss://ws.kick.com/websocket"
const CHANNEL_API = "https://kick.com/api/v2/channels/"

/** Kick native emote image (static CDN). */
function emoteUrl(id) {
	return `https://files.kick.com/emotes/${id}/full`
}

/** Kick profile picture by numeric user id. */
function avatarUrl(id) {
	if (!id) return ""
	return `https://files.kick.com/users/${id}/profile-picture`
}

function slugFromChannel(input) {
	return String(input || "")
		.trim()
		.replace(/^@/, "")
		.replace(/^https?:\/\/(www\.)?kick\.com\//i, "")
		.replace(/\/.*$/, "")
		.toLowerCase()
}

/** Kick content is either a plain string or an array of {type:'text'|'emote'} runs. */
function contentToFragments(content, showEmotes) {
	if (typeof content === "string") return [textFragment(content)]
	if (!Array.isArray(content)) return []
	const fragments = []
	for (const run of content) {
		if (!run || typeof run !== "object") continue
		if (run.type === "emote" && run.id) {
			if (showEmotes) fragments.push(emoteFragment(run.name || "emote", emoteUrl(run.id), "kick"))
		} else if (run.type === "link" && run.url) {
			fragments.push(textFragment(run.text || run.url))
		} else if (typeof run.text === "string") {
			fragments.push(textFragment(run.text))
		} else if (typeof run === "string") {
			fragments.push(textFragment(run))
		}
	}
	return fragments
}

function badgesFrom(sender = {}) {
	const badges = []
	const roles = { owner: false, mod: false, vip: false, sub: false, verified: false, member: false }
	const list = sender.identity?.badges || sender.badges || []
	for (const entry of list) {
		const type = String(entry?.type || entry?.id || "").toLowerCase()
		if (!type) continue
		if (type === "broadcaster" || type === "owner" || type === "streamer") roles.owner = true
		if (type === "moderator" || type === "mod") roles.mod = true
		if (type === "vip") roles.vip = true
		if (type === "subscriber" || type === "founder" || type === "sub") roles.sub = true
		if (type === "verified") roles.verified = true
		if (type === "glow" || type === "gear" || type === "leader") roles.member = true
		badges.push({ id: type, label: entry.label || type, image: entry.image || "" })
	}
	return { badges, roles }
}

function messageFromEvent(payload, options = {}) {
	if (!payload || payload.type === "reply") return null
	const sender = payload.sender || {}
	const slug = sender.slug || sender.username || ""
	const display = sender.username || slug || "ผู้ใช้"
	const { badges, roles } = badgesFrom(sender)
	const fragments = contentToFragments(payload.content, options.showEmotes !== false)
	if (!fragments.length) return null
	return createMessage({
		platform: "kick",
		id: payload.id || "",
		kind: "chat",
		author: {
			id: String(sender.id || ""),
			name: slug,
			display,
			color: sender.identity?.color || "",
			avatar: avatarUrl(sender.id),
			badges,
			roles,
		},
		fragments,
		timestamp: Date.parse(payload.created_at) || Date.now(),
	})
}

/** Sub / highlight style events are rarer on Kick; only emit when enabled. */
function eventFromPayload(payload, options = {}) {
	const type = payload.type
	if (type !== "subscription" && type !== "sub" && type !== "highlight") return null
	if (options.showSubEvents === false) return null
	const sender = payload.sender || {}
	const slug = sender.slug || sender.username || ""
	const display = sender.username || slug || "ผู้ใช้"
	const { badges, roles } = badgesFrom(sender)
	const body = typeof payload.content === "string" ? payload.content : ""
	return createMessage({
		platform: "kick",
		id: payload.id || "",
		kind: "event",
		author: {
			id: String(sender.id || ""),
			name: slug,
			display,
			color: sender.identity?.color || "",
			avatar: avatarUrl(sender.id),
			badges,
			roles,
		},
		fragments: body ? [textFragment(body)] : [],
		event: createEvent({
			type: "sub",
			label: type === "highlight" ? "ไฮไลต์" : "ติดซับ Kick",
			amount: payload.subscription?.duration ? `${payload.subscription.duration} เดือน` : "",
			bg: "rgba(83, 252, 24, 0.3)",
			fg: "#eaffe0",
		}),
		timestamp: Date.parse(payload.created_at) || Date.now(),
	})
}

export class KickSource {
	constructor({ hub, config }) {
		this.hub = hub
		this.configStore = config
		this.stopped = true
		this.socket = null
		this.chatroomId = ""
		this.subscribed = false
		this.backoff = new Backoff({ min: 2000, max: 30000 })
		this.heartbeat = null
	}

	get settings() {
		return this.configStore.get().kick
	}

	async start() {
		this.stop()
		this.stopped = false
		const slug = slugFromChannel(this.settings.channel)
		if (!this.settings.enabled) {
			this.hub.setStatus("kick", { state: "disabled", detail: "", channel: "" })
			return
		}
		if (!slug) {
			this.hub.setStatus("kick", { state: "error", detail: "ยังไม่ได้ตั้งชื่อช่อง Kick", channel: "" })
			return
		}
		this.#loop(slug).catch((error) => log.error("loop ตาย:", error))
	}

	async #loop(slug) {
		while (!this.stopped) {
			try {
				this.hub.setStatus("kick", { state: "connecting", detail: `กำลังหาช่อง ${slug}…`, channel: slug })
				const data = await fetchJson(`${CHANNEL_API}${encodeURIComponent(slug)}`, { timeout: 20000 })
				const chatroomId = data?.chatroom?.id
				if (!chatroomId) throw new Error(`ไม่พบช่อง ${slug} หรือช่องถูกปิด`)
				this.chatroomId = chatroomId
				await this.#runSocket(slug)
				this.backoff.reset()
			} catch (error) {
				if (this.stopped) return
				const wait = this.backoff.next()
				this.hub.setStatus("kick", {
					state: "reconnecting",
					detail: `${error.message} — ลองใหม่ใน ${Math.round(wait / 1000)} วิ`,
					channel: slug,
				})
				log.warn(`Kick: ${error.message} — ลองใหม่ใน ${Math.round(wait / 1000)} วิ`)
				await sleep(wait)
			}
		}
	}

	#runSocket(slug) {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(WS_URL)
			this.socket = socket
			this.subscribed = false
			let connected = false

			socket.on("open", () => {
				connected = true
				log.info(`เชื่อมต่อ websocket Kick แล้ว (ช่อง ${slug})`)
				this.#subscribe(slug)
			})

			socket.on("message", (raw) => {
				for (const line of raw.toString().split("\n")) {
					if (line) this.#handleFrame(line)
				}
			})

			socket.on("close", () => {
				clearInterval(this.heartbeat)
				this.heartbeat = null
				this.socket = null
				if (this.stopped) return resolve()
				// Connected before? Loop reconnects immediately. Never connected? Reject so
				// the outer loop applies backoff instead of spinning on a dead socket.
				if (connected) resolve()
				else reject(new Error("ไม่สามารถต่อ WebSocket Kick ได้ (เช็คการเชื่อมต่อเครือข่าย)"))
			})

			socket.on("error", (error) => log.warn("Kick socket error:", error.message))
		})
	}

	#subscribe(slug) {
		if (!this.chatroomId) return
		this.socket?.send(
			JSON.stringify({
				event: "pusher:subscribe",
				data: { auth: "", channel: `chatrooms.${this.chatroomId}.v2` },
			}),
		)
		this.subscribed = true
		this.hub.setStatus("kick", { state: "connected", detail: `#${slug}`, channel: slug })
		// Keep the Pusher connection alive (server pings ~every 30s).
		clearInterval(this.heartbeat)
		this.heartbeat = setInterval(() => {
			if (this.socket?.readyState === WebSocket.OPEN) {
				this.socket.send(JSON.stringify({ event: "pusher:ping", data: {} }))
			}
		}, 20000)
	}

	#handleFrame(line) {
		let frame
		try {
			frame = JSON.parse(line)
		} catch {
			return
		}
		const event = frame.event
		if (event === "pusher:ping") {
			this.socket?.send(JSON.stringify({ event: "pusher:pong", data: {} }))
			return
		}
		if (event === "pusher:error") {
			log.warn("Kick pusher error:", frame.data?.message || frame.data)
			return
		}
		if (event !== "App\\Events\\ChatMessageEvent") return

		let payload = frame.data
		if (typeof payload === "string") {
			try {
				const parsed = JSON.parse(payload)
				payload = Array.isArray(parsed) ? parsed[0] : parsed
			} catch {
				return
			}
		}
		if (!payload || typeof payload !== "object") return

		const options = { showEmotes: this.configStore.get().theme.showEmotes }
		const message = messageFromEvent(payload, options) || eventFromPayload(payload, this.settings)
		if (message) this.hub.publish(message)
	}

	stop() {
		this.stopped = true
		clearInterval(this.heartbeat)
		this.heartbeat = null
		if (this.socket) {
			try {
				this.socket.close()
			} catch {
				/* ignore */
			}
		}
		this.socket = null
		this.subscribed = false
	}
}
