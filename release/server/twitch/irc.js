/**
 * Anonymous Twitch IRC-over-WebSocket client.
 * No token needed: we log in as justinfan#### which can read any public chat.
 */
import WebSocket from "ws"
import { EventEmitter } from "node:events"
import { Backoff, logger } from "../util.js"

const log = logger("twitch-irc")
const IRC_URL = "wss://irc-ws.chat.twitch.tv:443"
const TAG_UNESCAPE = { "\\s": " ", "\\:": ";", "\\\\": "\\", "\\r": "\r", "\\n": "\n" }

function unescapeTagValue(value) {
	return value.replace(/\\[sn:r\\]/g, (match) => TAG_UNESCAPE[match] ?? match)
}

function parseTags(raw) {
	const tags = {}
	for (const pair of raw.split(";")) {
		if (!pair) continue
		const eq = pair.indexOf("=")
		const key = eq < 0 ? pair : pair.slice(0, eq)
		const value = eq < 0 ? "" : unescapeTagValue(pair.slice(eq + 1))
		tags[key] = value
	}
	return tags
}

/** Parse one IRCv3 line into { tags, prefix, command, params, trailing }. */
function parseIrcLine(line) {
	let rest = line.trim()
	let tags = {}
	if (rest.startsWith("@")) {
		const space = rest.indexOf(" ")
		tags = parseTags(rest.slice(1, space))
		rest = rest.slice(space + 1)
	}
	let prefix = null
	if (rest.startsWith(":")) {
		const space = rest.indexOf(" ")
		prefix = rest.slice(1, space)
		rest = rest.slice(space + 1)
	}
	let trailing = null
	const trailingIndex = rest.indexOf(" :")
	if (trailingIndex >= 0) {
		trailing = rest.slice(trailingIndex + 2)
		rest = rest.slice(0, trailingIndex)
	}
	const parts = rest.split(" ").filter(Boolean)
	const command = (parts.shift() || "").toUpperCase()
	return { tags, prefix, command, params: parts, trailing }
}

export function loginFromPrefix(prefix) {
	if (!prefix) return ""
	const bang = prefix.indexOf("!")
	return (bang > 0 ? prefix.slice(0, bang) : prefix).toLowerCase()
}

/**
 * Emits: 'privmsg', 'usernotice', 'clearmsg', 'clearchat', 'roomstate',
 *        'notice', 'status' ({state, detail}).
 */
export class TwitchIrcClient extends EventEmitter {
	constructor({ channel }) {
		super()
		this.channel = String(channel || "").toLowerCase().replace(/^#/, "")
		this.socket = null
		this.backoff = new Backoff({ min: 2000, max: 30000 })
		this.stopped = false
		this.pingTimer = null
		this.pongTimer = null
		this.reconnectTimer = null
	}

	connect() {
		if (this.stopped || !this.channel) return
		this.#cleanupSocket()
		this.emit("status", { state: "connecting", detail: `กำลังต่อ #${this.channel}` })
		const socket = new WebSocket(IRC_URL)
		this.socket = socket

		socket.on("open", () => {
			log.info(`เชื่อมต่อ IRC แล้ว, join #${this.channel}`)
			const nick = `justinfan${Math.floor(Math.random() * 80000 + 1000)}`
			socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands")
			socket.send("PASS SCHMOOPIIE")
			socket.send(`NICK ${nick}`)
			socket.send(`JOIN #${this.channel}`)
			this.backoff.reset()
			this.emit("status", { state: "connected", detail: `#${this.channel}` })
			this.#startHeartbeat()
		})

		socket.on("message", (data) => {
			for (const line of data.toString("utf8").split("\r\n")) {
				if (line) this.#handleLine(line)
			}
		})

		socket.on("close", (code) => {
			this.#stopHeartbeat()
			if (this.stopped) return
			this.emit("status", { state: "reconnecting", detail: `หลุดการเชื่อมต่อ (${code})` })
			this.#scheduleReconnect()
		})

		socket.on("error", (error) => {
			log.warn("IRC error:", error.message)
			this.emit("status", { state: "error", detail: error.message })
		})
	}

	#handleLine(line) {
		const parsed = parseIrcLine(line)
		switch (parsed.command) {
			case "PING":
				this.socket?.send(`PONG :${parsed.trailing || "tmi.twitch.tv"}`)
				return
			case "PONG":
				clearTimeout(this.pongTimer)
				return
			case "PRIVMSG":
				this.emit("privmsg", parsed)
				return
			case "USERNOTICE":
				this.emit("usernotice", parsed)
				return
			case "CLEARMSG":
				this.emit("clearmsg", parsed)
				return
			case "CLEARCHAT":
				this.emit("clearchat", parsed)
				return
			case "ROOMSTATE":
				if (parsed.tags["room-id"]) this.emit("roomstate", parsed)
				return
			case "NOTICE":
				log.info("NOTICE:", parsed.trailing)
				this.emit("notice", parsed)
				if (/login authentication failed|improperly formatted auth/i.test(parsed.trailing || "")) {
					this.emit("status", { state: "error", detail: parsed.trailing })
				}
				return
			case "RECONNECT":
				log.info("เซิร์ฟเวอร์สั่ง RECONNECT")
				this.socket?.close()
				return
			default:
				return
		}
	}

	#startHeartbeat() {
		this.#stopHeartbeat()
		this.pingTimer = setInterval(() => {
			if (this.socket?.readyState !== WebSocket.OPEN) return
			this.socket.send("PING :keepalive")
			clearTimeout(this.pongTimer)
			this.pongTimer = setTimeout(() => {
				log.warn("ไม่ได้รับ PONG — รีคอนเน็กต์")
				this.socket?.terminate()
			}, 15000)
		}, 60000)
	}

	#stopHeartbeat() {
		clearInterval(this.pingTimer)
		clearTimeout(this.pongTimer)
		this.pingTimer = null
		this.pongTimer = null
	}

	#scheduleReconnect() {
		clearTimeout(this.reconnectTimer)
		const wait = this.backoff.next()
		log.info(`รีคอนเน็กต์ใน ${Math.round(wait / 1000)} วิ`)
		this.reconnectTimer = setTimeout(() => this.connect(), wait)
	}

	#cleanupSocket() {
		if (!this.socket) return
		this.socket.removeAllListeners()
		try {
			this.socket.close()
		} catch {
			/* ignore */
		}
		this.socket = null
	}

	stop() {
		this.stopped = true
		clearTimeout(this.reconnectTimer)
		this.#stopHeartbeat()
		this.#cleanupSocket()
		this.emit("status", { state: "disabled", detail: "" })
	}
}
