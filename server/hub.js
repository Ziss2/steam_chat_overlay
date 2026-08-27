/**
 * Message hub: applies filters, keeps a replay buffer and fans out to WebSocket clients.
 */
import { EventEmitter } from "node:events"
import { config } from "./config.js"
import { logger } from "./util.js"

const log = logger("hub")

export class Hub extends EventEmitter {
	constructor({ bufferSize = 60 } = {}) {
		super()
		this.setMaxListeners(50)
		this.bufferSize = bufferSize
		this.buffer = []
		this.status = {
			twitch: { state: "disabled", detail: "", channel: "" },
			youtube: { state: "disabled", detail: "", videoId: "", mode: "" },
		}
	}

	/** @returns {boolean} true when the message passed the filters and was broadcast. */
	publish(message) {
		if (!message) return false
		if (this.#blockedAuthor(message)) return false
		if (message.kind === "chat" && !this.#allowed(message)) return false
		this.buffer.push(message)
		if (this.buffer.length > this.bufferSize) this.buffer.shift()
		this.emit("chat", message)
		log.debug(`${message.platform} <${message.author.display}> ${message.text}`)
		return true
	}

	/** Blocked users are hidden everywhere, including Super Chat / Bits highlights. */
	#blockedAuthor(message) {
		const login = (message.author.name || "").toLowerCase()
		const display = (message.author.display || "").toLowerCase()
		return config.get().filters.blockedUsers.some((user) => {
			const needle = user.trim().toLowerCase()
			return needle && (needle === login || needle === display)
		})
	}

	#allowed(message) {
		const filters = config.get().filters
		const text = message.text || ""
		if (filters.hideCommands && /^\s*[!/]\w/.test(text)) return false
		if (filters.maxLength > 0 && text.length > filters.maxLength) {
			// Trim instead of dropping so long messages still show up.
			let budget = filters.maxLength
			const kept = []
			for (const fragment of message.fragments) {
				if (budget <= 0) break
				if (fragment.type !== "text") {
					kept.push(fragment)
					continue
				}
				kept.push({ ...fragment, text: fragment.text.slice(0, budget) })
				budget -= fragment.text.length
			}
			message.fragments = kept
			message.text = `${text.slice(0, filters.maxLength)}…`
		}
		const haystack = text.toLowerCase()
		if (filters.blockedWords.some((word) => {
			const needle = word.trim().toLowerCase()
			return needle && haystack.includes(needle)
		})) {
			return false
		}
		return true
	}

	/** Remove messages by id and/or by author (Twitch timeout, YouTube deletion). */
	remove({ platform, ids = [], authorIds = [], authorNames = [] }) {
		const idSet = new Set(ids)
		const authorIdSet = new Set(authorIds)
		const authorNameSet = new Set(authorNames.map((name) => name.toLowerCase()))
		this.buffer = this.buffer.filter((message) => {
			if (platform && message.platform !== platform) return true
			if (idSet.has(message.id) || idSet.has(message.id.split(":").slice(1).join(":"))) return false
			if (message.author.id && authorIdSet.has(message.author.id)) return false
			if (message.author.name && authorNameSet.has(message.author.name.toLowerCase())) return false
			return true
		})
		this.emit("remove", { platform, ids, authorIds, authorNames })
	}

	clear(platform) {
		this.buffer = platform ? this.buffer.filter((message) => message.platform !== platform) : []
		this.emit("clear", { platform: platform || null })
	}

	recent(limit = 25) {
		return this.buffer.slice(-limit)
	}

	setStatus(platform, patch) {
		const next = { ...this.status[platform], ...patch }
		if (JSON.stringify(next) === JSON.stringify(this.status[platform])) return
		this.status[platform] = next
		this.emit("status", this.status)
	}

	getStatus() {
		return this.status
	}
}
