/**
 * Twitch chat source: IRC -> normalized messages on the hub.
 */
import { TwitchIrcClient, loginFromPrefix } from "./irc.js"
import { TwitchAssets } from "./assets.js"
import { createEvent, createMessage, emoteFragment, textFragment } from "../message.js"
import { logger } from "../util.js"

const log = logger("twitch")

const DEFAULT_COLORS = [
	"#ff4a80", "#ff7f50", "#ffb400", "#9acd32", "#00d68f", "#1e90ff",
	"#8a2be2", "#ff69b4", "#00ced1", "#daa520", "#5f9ea0", "#d2691e",
]

/** Twitch users without a colour get a stable colour derived from their login. */
function fallbackColor(login) {
	let hash = 0
	for (let i = 0; i < login.length; i += 1) hash = (hash * 31 + login.charCodeAt(i)) % 100000
	return DEFAULT_COLORS[hash % DEFAULT_COLORS.length]
}

const BADGE_LABELS = {
	broadcaster: "เจ้าของช่อง",
	moderator: "Moderator",
	vip: "VIP",
	subscriber: "Subscriber",
	founder: "Founder",
	premium: "Prime",
	partner: "Partner",
	staff: "Staff",
	"sub-gifter": "Sub Gifter",
	"bits-leader": "Bits Leader",
	turbo: "Turbo",
}

/** `emotes` tag positions are code-point based, so operate on an array of code points. */
function parseEmoteTag(tag) {
	const ranges = []
	if (!tag) return ranges
	for (const chunk of tag.split("/")) {
		const [id, positions] = chunk.split(":")
		if (!id || !positions) continue
		for (const range of positions.split(",")) {
			const [start, end] = range.split("-").map(Number)
			if (Number.isFinite(start) && Number.isFinite(end)) ranges.push({ id, start, end })
		}
	}
	return ranges.sort((a, b) => a.start - b.start)
}

function splitThirdParty(text, assets, fragments) {
	if (!assets.hasEmotes()) {
		if (text) fragments.push(textFragment(text))
		return
	}
	let pending = ""
	// Keep whitespace so the message renders exactly as typed.
	for (const token of text.split(/(\s+)/)) {
		const emote = /\S/.test(token) ? assets.emote(token) : null
		if (emote) {
			if (pending) {
				fragments.push(textFragment(pending))
				pending = ""
			}
			fragments.push(emoteFragment(emote.name, emote.url, emote.provider, emote.zeroWidth))
		} else {
			pending += token
		}
	}
	if (pending) fragments.push(textFragment(pending))
}

function buildFragments(rawText, emoteTag, assets, showEmotes) {
	const codePoints = Array.from(rawText)
	const fragments = []
	if (!showEmotes) {
		fragments.push(textFragment(rawText))
		return fragments
	}
	let cursor = 0
	for (const range of parseEmoteTag(emoteTag)) {
		if (range.start < cursor) continue
		if (range.start > cursor) splitThirdParty(codePoints.slice(cursor, range.start).join(""), assets, fragments)
		const name = codePoints.slice(range.start, range.end + 1).join("")
		fragments.push(emoteFragment(name, TwitchAssets.nativeEmoteUrl(range.id), "twitch"))
		cursor = range.end + 1
	}
	if (cursor < codePoints.length) splitThirdParty(codePoints.slice(cursor).join(""), assets, fragments)
	return fragments
}

function buildBadges(badgeTag, badgeInfoTag, assets) {
	const badges = []
	const roles = { owner: false, mod: false, vip: false, sub: false, verified: false }
	if (!badgeTag) return { badges, roles }
	const info = {}
	for (const pair of (badgeInfoTag || "").split(",")) {
		const [key, value] = pair.split("/")
		if (key) info[key] = value
	}
	for (const entry of badgeTag.split(",")) {
		const [setId, version = "1"] = entry.split("/")
		if (!setId) continue
		if (setId === "broadcaster") roles.owner = true
		if (setId === "moderator") roles.mod = true
		if (setId === "vip") roles.vip = true
		if (setId === "subscriber" || setId === "founder") roles.sub = true
		if (setId === "partner") roles.verified = true
		const asset = assets.badge(setId, version)
		const label = BADGE_LABELS[setId] || setId
		badges.push({
			id: setId,
			label,
			image: asset?.image || "",
		})
	}
	return { badges, roles }
}

const USERNOTICE_LABELS = {
	sub: "สมัครซับใหม่",
	resub: "ต่อซับ",
	subgift: "ให้ซับเป็นของขวัญ",
	submysterygift: "แจกซับ",
	giftpaidupgrade: "อัปเกรดซับ",
	anongiftpaidupgrade: "อัปเกรดซับ",
	raid: "Raid เข้ามา",
	announcement: "ประกาศ",
	bitsbadgetier: "อัปเกรด Bits badge",
	viewermilestone: "Milestone",
}

export class TwitchSource {
	constructor({ hub, config }) {
		this.hub = hub
		this.configStore = config
		this.client = null
		this.assets = new TwitchAssets()
		this.refreshTimer = null
	}

	get settings() {
		return this.configStore.get().twitch
	}

	async start() {
		this.stop()
		const { enabled, channel } = this.settings
		if (!enabled || !channel) {
			this.hub.setStatus("twitch", {
				state: enabled ? "error" : "disabled",
				detail: enabled ? "ยังไม่ได้ตั้งชื่อช่อง Twitch" : "",
				channel: channel || "",
			})
			return
		}
		this.hub.setStatus("twitch", { channel, state: "connecting", detail: "" })
		// Fresh cache per start so switching channels never keeps the old channel's emotes.
		this.assets = new TwitchAssets()
		// Global assets first so early messages already have badges/emotes.
		await this.assets.load({ login: channel }, this.configStore.get().emotes)

		const client = new TwitchIrcClient({ channel })
		this.client = client
		client.on("status", ({ state, detail }) => this.hub.setStatus("twitch", { state, detail, channel }))
		client.on("privmsg", (parsed) => this.#onPrivmsg(parsed))
		client.on("usernotice", (parsed) => this.#onUsernotice(parsed))
		client.on("clearmsg", (parsed) => {
			const id = parsed.tags["target-msg-id"]
			if (id) this.hub.remove({ platform: "twitch", ids: [`twitch:${id}`] })
		})
		client.on("clearchat", (parsed) => {
			const login = parsed.trailing
			if (login) this.hub.remove({ platform: "twitch", authorNames: [login] })
			else this.hub.clear("twitch")
		})
		client.on("roomstate", async (parsed) => {
			const roomId = parsed.tags["room-id"]
			if (!roomId || roomId === this.assets.roomId) return
			await this.assets.load({ roomId, login: channel }, this.configStore.get().emotes)
		})
		client.connect()

		// Refresh cosmetics every 30 minutes (new sub emotes, 7TV changes, ...).
		this.refreshTimer = setInterval(() => {
			this.assets.load({}, this.configStore.get().emotes).catch(() => {})
		}, 30 * 60 * 1000)
	}

	#onPrivmsg(parsed) {
		const tags = parsed.tags
		const login = loginFromPrefix(parsed.prefix)
		let text = parsed.trailing || ""
		let action = false
		const actionMatch = text.match(/^\u0001ACTION (.*)\u0001$/)
		if (actionMatch) {
			action = true
			text = actionMatch[1]
		}
		const theme = this.configStore.get().theme
		const fragments = buildFragments(text, tags.emotes, this.assets, theme.showEmotes)
		const { badges, roles } = buildBadges(tags.badges, tags["badge-info"], this.assets)
		const bits = Number(tags.bits || 0)

		let event = null
		if (bits > 0) {
			event = createEvent({
				type: "cheer",
				label: "Cheer",
				amount: `${bits.toLocaleString("en-US")} Bits`,
				bg: "rgba(145, 70, 255, 0.85)",
				fg: "#e3d4ff",
			})
		} else if (tags["msg-id"] === "highlighted-message") {
			event = createEvent({ type: "highlight", label: "Highlighted", bg: "rgba(117, 94, 188, 0.85)" })
		}

		this.hub.publish(
			createMessage({
				platform: "twitch",
				id: tags.id,
				kind: "chat",
				author: {
					id: tags["user-id"] || "",
					name: login,
					display: tags["display-name"] || login,
					color: tags.color || fallbackColor(login),
					badges,
					roles,
				},
				fragments,
				event,
				system: action ? "action" : null,
				timestamp: Number(tags["tmi-sent-ts"]) || Date.now(),
			}),
		)
	}

	#onUsernotice(parsed) {
		if (!this.settings.showSubEvents) return
		const tags = parsed.tags
		const msgId = tags["msg-id"] || ""
		const login = tags.login || loginFromPrefix(parsed.prefix)
		const systemMsg = (tags["system-msg"] || "").trim()
		const label = USERNOTICE_LABELS[msgId]
		if (!label && !systemMsg) return

		const theme = this.configStore.get().theme
		const body = parsed.trailing || ""
		const fragments = body ? buildFragments(body, tags.emotes, this.assets, theme.showEmotes) : []
		const { badges, roles } = buildBadges(tags.badges, tags["badge-info"], this.assets)
		const months = tags["msg-param-cumulative-months"] || tags["msg-param-months"]
		const viewers = tags["msg-param-viewerCount"]
		const amount = msgId === "raid" && viewers ? `${viewers} คน` : months ? `${months} เดือน` : ""

		log.debug("usernotice", msgId, systemMsg)
		this.hub.publish(
			createMessage({
				platform: "twitch",
				id: tags.id,
				kind: "event",
				author: {
					id: tags["user-id"] || "",
					name: login,
					display: tags["display-name"] || login,
					color: tags.color || fallbackColor(login),
					badges,
					roles,
				},
				fragments,
				event: createEvent({
					type: msgId === "raid" ? "raid" : "sub",
					label: label || msgId,
					amount,
					bg: "rgba(145, 70, 255, 0.85)",
					fg: "#e6d9ff",
				}),
				system: systemMsg,
				timestamp: Number(tags["tmi-sent-ts"]) || Date.now(),
			}),
		)
	}

	stop() {
		clearInterval(this.refreshTimer)
		this.refreshTimer = null
		this.client?.stop()
		this.client = null
	}
}
