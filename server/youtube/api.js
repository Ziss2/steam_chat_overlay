/**
 * YouTube live chat via the official Data API v3.
 * Needs an API key. Costs ~5 quota units per poll, so the interval is configurable.
 */
import { createEvent, createMessage, textFragment } from "../message.js"
import { fetchJson, logger, sleep } from "../util.js"
import { ChatUnavailableError } from "./scrape.js"

const log = logger("youtube-api")
const API = "https://www.googleapis.com/youtube/v3"

export class QuotaError extends Error {
	constructor(message) {
		super(message)
		this.name = "QuotaError"
	}
}

const TIER_COLORS = [
	"rgba(30, 136, 229, 0.85)",
	"rgba(0, 229, 255, 0.85)",
	"rgba(29, 233, 182, 0.85)",
	"rgba(255, 202, 40, 0.9)",
	"rgba(245, 124, 0, 0.9)",
	"rgba(233, 30, 99, 0.9)",
	"rgba(230, 33, 23, 0.9)",
]

function tierColor(tier) {
	const index = Math.max(1, Math.min(Number(tier) || 1, TIER_COLORS.length)) - 1
	return TIER_COLORS[index]
}

function authorFrom(details = {}) {
	const badges = []
	if (details.isChatOwner) badges.push({ id: "owner", label: "เจ้าของช่อง", image: "" })
	if (details.isChatModerator) badges.push({ id: "moderator", label: "Moderator", image: "" })
	if (details.isChatSponsor) badges.push({ id: "member", label: "สมาชิก", image: "" })
	if (details.isVerified) badges.push({ id: "verified", label: "Verified", image: "" })
	return {
		id: details.channelId || "",
		name: details.displayName || "",
		display: details.displayName || "ผู้ชม",
		avatar: details.profileImageUrl || "",
		badges,
		roles: {
			owner: Boolean(details.isChatOwner),
			mod: Boolean(details.isChatModerator),
			member: Boolean(details.isChatSponsor),
			verified: Boolean(details.isVerified),
		},
	}
}

/** One Data API item -> normalized message (null when the event is not renderable). */
function apiItemToMessage(item, options = {}) {
	const snippet = item.snippet || {}
	const author = authorFrom(item.authorDetails)
	const timestamp = Date.parse(snippet.publishedAt || "") || Date.now()
	const base = { platform: "youtube", id: item.id, author, timestamp }

	switch (snippet.type) {
		case "textMessageEvent": {
			const text = snippet.textMessageDetails?.messageText || snippet.displayMessage || ""
			if (!text) return null
			return createMessage({ ...base, kind: "chat", fragments: [textFragment(text)] })
		}
		case "superChatEvent": {
			if (options.showSuperChat === false) return null
			const details = snippet.superChatDetails || {}
			return createMessage({
				...base,
				kind: "event",
				fragments: details.userComment ? [textFragment(details.userComment)] : [],
				event: createEvent({
					type: "superchat",
					label: "Super Chat",
					amount: details.amountDisplayString || "",
					tier: Number(details.tier) || 0,
					bg: tierColor(details.tier),
					fg: "#ffffff",
				}),
			})
		}
		case "superStickerEvent": {
			if (options.showSuperChat === false) return null
			const details = snippet.superStickerDetails || {}
			return createMessage({
				...base,
				kind: "event",
				fragments: details.superStickerMetadata?.altText
					? [textFragment(details.superStickerMetadata.altText)]
					: [],
				event: createEvent({
					type: "supersticker",
					label: "Super Sticker",
					amount: details.amountDisplayString || "",
					tier: Number(details.tier) || 0,
					bg: tierColor(details.tier),
					fg: "#ffffff",
				}),
			})
		}
		case "newSponsorEvent": {
			if (options.showMemberEvents === false) return null
			const details = snippet.newSponsorDetails || {}
			return createMessage({
				...base,
				kind: "event",
				fragments: [],
				event: createEvent({
					type: "membership",
					label: details.isUpgrade ? "อัปเกรดสมาชิก" : "สมาชิกใหม่",
					amount: details.memberLevelName || "",
					bg: "rgba(15, 157, 88, 0.85)",
					fg: "#ffffff",
				}),
			})
		}
		case "memberMilestoneChatEvent": {
			if (options.showMemberEvents === false) return null
			const details = snippet.memberMilestoneChatDetails || {}
			return createMessage({
				...base,
				kind: "event",
				fragments: details.userComment ? [textFragment(details.userComment)] : [],
				event: createEvent({
					type: "membership",
					label: "Member Milestone",
					amount: `${details.memberMonth || "?"} เดือน • ${details.memberLevelName || ""}`.trim(),
					bg: "rgba(15, 157, 88, 0.85)",
					fg: "#ffffff",
				}),
			})
		}
		case "membershipGiftingEvent": {
			if (options.showMemberEvents === false) return null
			const details = snippet.membershipGiftingDetails || {}
			return createMessage({
				...base,
				kind: "event",
				fragments: [],
				event: createEvent({
					type: "membergift",
					label: "แจกสมาชิก",
					amount: `${details.giftMembershipsCount || 1} สิทธิ์`,
					bg: "rgba(15, 157, 88, 0.85)",
					fg: "#ffffff",
				}),
			})
		}
		case "messageDeletedEvent":
			return { __delete: `youtube:${snippet.messageDeletedDetails?.deletedMessageId}` }
		case "userBannedEvent":
			return { __banAuthor: snippet.userBannedDetails?.bannedUserDetails?.channelId }
		case "chatEndedEvent":
			return { __ended: true }
		default:
			return null
	}
}

export class YouTubeApiPoller {
	constructor({ videoId, apiKey, onMessage, onRemove, onStatus, getOptions }) {
		this.videoId = videoId
		this.apiKey = apiKey
		this.onMessage = onMessage
		this.onRemove = onRemove
		this.onStatus = onStatus || (() => {})
		this.getOptions = getOptions || (() => ({}))
		this.stopped = false
		this.liveChatId = ""
		this.pageToken = ""
		this.first = true
	}

	async #resolveLiveChatId() {
		const url = new URL(`${API}/videos`)
		url.searchParams.set("part", "liveStreamingDetails,snippet")
		url.searchParams.set("id", this.videoId)
		url.searchParams.set("key", this.apiKey)
		const data = await this.#request(url)
		const item = data?.items?.[0]
		if (!item) throw new ChatUnavailableError(`ไม่พบวิดีโอ ${this.videoId}`)
		const liveChatId = item.liveStreamingDetails?.activeLiveChatId
		if (!liveChatId) throw new ChatUnavailableError("วิดีโอนี้ไม่มีแชทสดที่กำลังทำงาน")
		this.liveChatId = liveChatId
	}

	async #request(url, retry = 0) {
		try {
			return await fetchJson(url.toString(), { timeout: 20000 })
		} catch (error) {
			const reason = error.body?.error?.errors?.[0]?.reason || error.body?.error?.status || ""
			const detail = error.body?.error?.message || error.message
			if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
				throw new QuotaError(`โควตา YouTube API หมด: ${detail}`)
			}
			if (reason === "rateLimitExceeded" && retry < 3) {
				await sleep(3000 * (retry + 1))
				return this.#request(url, retry + 1)
			}
			if (error.status === 403 && /forbidden|liveChatDisabled|liveChatEnded/i.test(`${reason} ${detail}`)) {
				throw new ChatUnavailableError(detail)
			}
			if (error.status === 404) throw new ChatUnavailableError(detail)
			if (error.status === 400 && /API key not valid|keyInvalid/i.test(detail)) {
				throw new QuotaError(`API key ใช้ไม่ได้: ${detail}`)
			}
			throw error
		}
	}

	async #poll() {
		const url = new URL(`${API}/liveChat/messages`)
		url.searchParams.set("liveChatId", this.liveChatId)
		url.searchParams.set("part", "id,snippet,authorDetails")
		url.searchParams.set("maxResults", "200")
		url.searchParams.set("key", this.apiKey)
		if (this.pageToken) url.searchParams.set("pageToken", this.pageToken)
		const data = await this.#request(url)
		this.pageToken = data?.nextPageToken || ""

		const options = this.getOptions()
		const collected = []
		for (const item of data?.items || []) {
			const result = apiItemToMessage(item, options)
			if (!result) continue
			if (result.__ended) throw new ChatUnavailableError("แชทสดจบแล้ว")
			if (result.__delete) {
				this.onRemove?.({ platform: "youtube", ids: [result.__delete] })
				continue
			}
			if (result.__banAuthor) {
				this.onRemove?.({ platform: "youtube", authorIds: [result.__banAuthor] })
				continue
			}
			collected.push(result)
		}

		const fresh = this.first
			? collected.filter((message) => Date.now() - message.timestamp < 60000).slice(-5)
			: collected
		this.first = false
		for (const message of fresh) this.onMessage(message)

		return Number(data?.pollingIntervalMillis) || 0
	}

	async run() {
		await this.#resolveLiveChatId()
		this.onStatus({ state: "connected", detail: `api • ${this.videoId}` })
		log.info(`เริ่มอ่านแชท (API) video=${this.videoId}`)
		let failures = 0
		while (!this.stopped) {
			try {
				const suggested = await this.#poll()
				failures = 0
				const configured = Number(this.getOptions().pollIntervalMs) || 4000
				await sleep(Math.max(configured, suggested, 1500))
			} catch (error) {
				if (error instanceof ChatUnavailableError || error instanceof QuotaError) throw error
				failures += 1
				log.warn(`poll ล้มเหลว (${failures}):`, error.message)
				if (failures >= 5) throw new ChatUnavailableError(`อ่านแชทไม่ได้: ${error.message}`)
				this.onStatus({ state: "reconnecting", detail: error.message })
				await sleep(3000 * failures)
			}
		}
	}

	stop() {
		this.stopped = true
	}
}
