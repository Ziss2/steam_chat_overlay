/**
 * TikTok Live chat source, built on tiktok-live-connector.
 * Reads any live room with just the creator username — no token/signer needed
 * (the library talks to TikTok's sign service for us).
 */
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from "tiktok-live-connector"
import { createEvent, createMessage, textFragment } from "../message.js"
import { Backoff, logger, sleep } from "../util.js"

const log = logger("tiktok")

function normalizeChannel(input) {
	return String(input || "")
		.trim()
		.replace(/^https?:\/\/(www\.)?tiktok\.com\//i, "")
		.replace("/live", "")
		.replace(/^@/, "")
		.toLowerCase()
}

/** tiktok-live-connector surfaces a few "user is special" flags on the chat user. */
function rolesFrom(user = {}) {
	return {
		owner: Boolean(user.isOwner || user.roomRole === "Host"),
		mod: Boolean(user.isModerator),
		vip: false,
		sub: Boolean(user.isSubscriber || user.isMember),
		member: Boolean(user.isSubscriber || user.isMember),
		verified: Boolean(user.verified),
	}
}

export class TikTokSource {
	constructor({ hub, config }) {
		this.hub = hub
		this.configStore = config
		this.stopped = true
		this.connection = null
		this.backoff = new Backoff({ min: 3000, max: 30000 })
		this.ended = null
	}

	get settings() {
		return this.configStore.get().tiktok
	}

	async start() {
		this.stop()
		this.stopped = false
		const channel = normalizeChannel(this.settings.channel)
		if (!this.settings.enabled) {
			this.hub.setStatus("tiktok", { state: "disabled", detail: "", channel: "" })
			return
		}
		if (!channel) {
			this.hub.setStatus("tiktok", { state: "error", detail: "ยังไม่ได้ตั้งชื่อผู้ใช้ TikTok", channel: "" })
			return
		}
		this.#loop(channel).catch((error) => log.error("loop ตาย:", error))
	}

	async #loop(channel) {
		while (!this.stopped) {
			try {
				this.hub.setStatus("tiktok", { state: "connecting", detail: `กำลังต่อ @${channel}…`, channel })
				const connection = new TikTokLiveConnection(channel)
				this.connection = connection
				this.#bind(connection, channel)

				await connection.connect()
				this.hub.setStatus("tiktok", { state: "connected", detail: `@${channel}`, channel })
				this.backoff.reset()
				// Wait until the stream ends / disconnects, then loop to reconnect.
				await new Promise((resolve) => {
					this.ended = resolve
				})
				if (this.stopped) return
			} catch (error) {
				if (this.stopped) return
				const waiting = /UserOffline|not live|offline/i.test(error?.message || "")
				const wait = waiting ? 30000 : this.backoff.next()
				this.hub.setStatus("tiktok", {
					state: waiting ? "waiting" : "reconnecting",
					detail: waiting ? "สตรีมยังไม่เริ่ม — ลองใหม่อัตโนมัติ" : `${error.message} — ลองใหม่ใน ${Math.round(wait / 1000)} วิ`,
					channel,
				})
				log.warn(`TikTok: ${error.message} — ${waiting ? "รอสตรีม" : `ลองใหม่ใน ${Math.round(wait / 1000)} วิ`}`)
				await sleep(wait)
			}
		}
	}

	#bind(connection, channel) {
		connection.on(WebcastEvent.CHAT, (data) => {
			const user = data.user || {}
			const text = data.comment || ""
			if (!text) return
			const message = createMessage({
				platform: "tiktok",
				id: data.msgId || "",
				kind: "chat",
				author: {
					id: String(user.userId || ""),
					name: user.uniqueId || "",
					display: user.nickname || user.uniqueId || "ผู้ใช้",
					color: "",
					avatar: user.profilePictureUrl || "",
					badges: [],
					roles: rolesFrom(user),
				},
				fragments: [textFragment(text)],
				timestamp: Number(data.createTime) * 1000 || Date.now(),
			})
			this.hub.publish(message)
		})

		connection.on(WebcastEvent.GIFT, (data) => {
			if (this.settings.showGiftEvents === false) return
			// TikTok repeats gifts rapidly; only surface the final summary (repeatEnd) unless it's a single gift.
			if (data.repeatCount > 1 && data.repeatEnd !== true) return
			const user = data.user || {}
			const giftName = data.gift?.name || "ของขวัญ"
			const count = data.repeatCount && data.repeatCount > 1 ? ` x${data.repeatCount}` : ""
			const amount = data.diamondCount ? `${data.diamondCount} เพชร` : ""
			const message = createMessage({
				platform: "tiktok",
				id: data.msgId || "",
				kind: "event",
				author: {
					id: String(user.userId || ""),
					name: user.uniqueId || "",
					display: user.nickname || user.uniqueId || "ผู้ใช้",
					color: "",
					avatar: user.profilePictureUrl || "",
					badges: [],
					roles: rolesFrom(user),
				},
				fragments: [textFragment(`ส่ง ${giftName}${count}`)],
				event: createEvent({
					type: "gift",
					label: "Gift",
					amount,
					bg: "rgba(254, 44, 85, 0.4)",
					fg: "#ffe3ea",
				}),
				timestamp: Date.now(),
			})
			this.hub.publish(message)
		})

		connection.on(WebcastEvent.MEMBER, (data) => {
			if (this.settings.showMemberEvents === false) return
			const user = data.user || {}
			const message = createMessage({
				platform: "tiktok",
				id: data.msgId || "",
				kind: "event",
				author: {
					id: String(user.userId || ""),
					name: user.uniqueId || "",
					display: user.nickname || user.uniqueId || "ผู้ใช้",
					color: "",
					avatar: user.profilePictureUrl || "",
					badges: [],
					roles: rolesFrom(user),
				},
				fragments: [],
				event: createEvent({
					type: "member",
					label: "เข้าร่วมสมาชิก",
					amount: "",
					bg: "rgba(254, 44, 85, 0.3)",
					fg: "#ffe3ea",
				}),
				timestamp: Date.now(),
			})
			this.hub.publish(message)
		})

		connection.on(ControlEvent.DISCONNECTED, () => {
			log.info("TikTok หลุดการเชื่อมต่อ")
			const done = this.ended
			this.ended = null
			done?.()
		})
		connection.on(ControlEvent.ERROR, (error) => {
			log.warn("TikTok error:", error?.message || error)
		})
	}

	stop() {
		this.stopped = true
		const done = this.ended
		this.ended = null
		done?.()
		if (this.connection) {
			try {
				this.connection.disconnect()
			} catch {
				/* ignore */
			}
		}
		this.connection = null
	}
}
