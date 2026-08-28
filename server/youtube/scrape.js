/**
 * YouTube live chat via the same internal (innertube) endpoint the live_chat page uses.
 * No API key and no quota — the trade-off is that YouTube can change the payload shape.
 */
import { createEvent, createMessage, emoteFragment, textFragment } from "../message.js"
import { argbToCss, extractJsonAt, fetchJson, fetchText, logger, sleep } from "../util.js"

const log = logger("youtube-scrape")

export class ChatUnavailableError extends Error {
	constructor(message) {
		super(message)
		this.name = "ChatUnavailableError"
	}
}

const HTML_HEADERS = {
	"accept-language": "en-US,en;q=0.9",
	accept: "text/html,application/xhtml+xml",
}

function absolute(url) {
	if (!url) return ""
	return url.startsWith("//") ? `https:${url}` : url
}

function bestThumbnail(thumbnails = []) {
	if (!thumbnails.length) return ""
	const sorted = [...thumbnails].sort((a, b) => (a.width || 0) - (b.width || 0))
	return absolute(sorted[sorted.length - 1]?.url || "")
}

function runsToText(runs = []) {
	return runs
		.map((run) => run.text || run.emoji?.shortcuts?.[0] || run.emoji?.emojiId || "")
		.join("")
}

/** innertube message runs -> overlay fragments (text + custom emoji images). */
function runsToFragments(runs = [], showEmotes = true) {
	const fragments = []
	for (const run of runs) {
		if (typeof run.text === "string") {
			fragments.push(textFragment(run.text))
			continue
		}
		const emoji = run.emoji
		if (!emoji) continue
		const name = emoji.shortcuts?.[0] || emoji.emojiId || ""
		const url = bestThumbnail(emoji.image?.thumbnails)
		if (showEmotes && url && emoji.isCustomEmoji) fragments.push(emoteFragment(name, url, "youtube"))
		else if (showEmotes && url && !/^[\w:\-_]+$/.test(name)) fragments.push(textFragment(name))
		else fragments.push(textFragment(emoji.emojiId && !emoji.isCustomEmoji ? emoji.emojiId : name))
	}
	return fragments
}

function parseAuthorBadges(authorBadges = []) {
	const badges = []
	const roles = { owner: false, mod: false, member: false, verified: false }
	for (const entry of authorBadges) {
		const badge = entry.liveChatAuthorBadgeRenderer
		if (!badge) continue
		const tooltip = badge.tooltip || ""
		const iconType = badge.icon?.iconType || ""
		if (iconType === "OWNER") roles.owner = true
		if (iconType === "MODERATOR") roles.mod = true
		if (iconType === "VERIFIED") roles.verified = true
		if (badge.customThumbnail) roles.member = true
		badges.push({
			id: iconType ? iconType.toLowerCase() : "member",
			label: tooltip || iconType || "Member",
			image: bestThumbnail(badge.customThumbnail?.thumbnails),
		})
	}
	return { badges, roles }
}

function authorFrom(renderer) {
	const { badges, roles } = parseAuthorBadges(renderer.authorBadges)
	return {
		id: renderer.authorExternalChannelId || "",
		name: renderer.authorName?.simpleText || "",
		display: renderer.authorName?.simpleText || "ผู้ชม",
		avatar: bestThumbnail(renderer.authorPhoto?.thumbnails),
		badges,
		roles,
	}
}

function timestampFrom(renderer) {
	const usec = Number(renderer.timestampUsec)
	return Number.isFinite(usec) && usec > 0 ? Math.round(usec / 1000) : Date.now()
}

/** Convert one innertube chat item into a normalized message (or null to skip). */
function itemToMessage(item, options = {}) {
	const showEmotes = options.showEmotes !== false
	const showSuperChat = options.showSuperChat !== false
	const showMemberEvents = options.showMemberEvents !== false

	const text = item.liveChatTextMessageRenderer
	if (text) {
		return createMessage({
			platform: "youtube",
			id: text.id,
			kind: "chat",
			author: authorFrom(text),
			fragments: runsToFragments(text.message?.runs, showEmotes),
			timestamp: timestampFrom(text),
		})
	}

	const paid = item.liveChatPaidMessageRenderer
	if (paid) {
		if (!showSuperChat) return null
		return createMessage({
			platform: "youtube",
			id: paid.id,
			kind: "event",
			author: authorFrom(paid),
			fragments: runsToFragments(paid.message?.runs, showEmotes),
			event: createEvent({
				type: "superchat",
				label: "Super Chat",
				amount: paid.purchaseAmountText?.simpleText || "",
				bg: argbToCss(paid.bodyBackgroundColor, 0.85) || "rgba(30, 136, 229, 0.85)",
				fg: argbToCss(paid.bodyTextColor, 1) || "#ffffff",
			}),
			timestamp: timestampFrom(paid),
		})
	}

	const sticker = item.liveChatPaidStickerRenderer
	if (sticker) {
		if (!showSuperChat) return null
		const stickerUrl = bestThumbnail(sticker.sticker?.thumbnails)
		return createMessage({
			platform: "youtube",
			id: sticker.id,
			kind: "event",
			author: authorFrom(sticker),
			fragments: stickerUrl ? [emoteFragment("sticker", stickerUrl, "youtube-sticker")] : [],
			event: createEvent({
				type: "supersticker",
				label: "Super Sticker",
				amount: sticker.purchaseAmountText?.simpleText || "",
				bg: argbToCss(sticker.backgroundColor, 0.85) || "rgba(0, 184, 212, 0.85)",
				fg: "#ffffff",
			}),
			timestamp: timestampFrom(sticker),
		})
	}

	const membership = item.liveChatMembershipItemRenderer
	if (membership) {
		if (!showMemberEvents) return null
		const headline = runsToText(membership.headerPrimaryText?.runs) || membership.headerSubtext?.simpleText || runsToText(membership.headerSubtext?.runs)
		return createMessage({
			platform: "youtube",
			id: membership.id,
			kind: "event",
			author: authorFrom(membership),
			fragments: runsToFragments(membership.message?.runs, showEmotes),
			event: createEvent({
				type: "membership",
				label: "สมาชิกใหม่",
				amount: headline || "",
				bg: "rgba(15, 157, 88, 0.85)",
				fg: "#ffffff",
			}),
			timestamp: timestampFrom(membership),
		})
	}

	const gift = item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer
	if (gift) {
		if (!showMemberEvents) return null
		const header = gift.header?.liveChatSponsorshipsHeaderRenderer
		if (!header) return null
		return createMessage({
			platform: "youtube",
			id: gift.id,
			kind: "event",
			author: authorFrom({ ...header, authorExternalChannelId: gift.authorExternalChannelId }),
			fragments: [],
			event: createEvent({
				type: "membergift",
				label: "แจกสมาชิก",
				amount: runsToText(header.primaryText?.runs),
				bg: "rgba(15, 157, 88, 0.85)",
				fg: "#ffffff",
			}),
			timestamp: timestampFrom(gift),
		})
	}

	return null
}

function findContinuation(initialData) {
	const renderer = initialData?.contents?.liveChatRenderer
	if (!renderer) return ""
	// Prefer the unfiltered "Live chat" view instead of "Top chat".
	const subMenuItems = renderer.header?.liveChatHeaderRenderer?.viewSelector?.sortFilterSubMenuRenderer?.subMenuItems || []
	const liveItem = subMenuItems.find((item) => /live chat/i.test(item.title || "")) || subMenuItems[1]
	const fromMenu = liveItem?.continuation?.reloadContinuationData?.continuation
	if (fromMenu) return fromMenu
	for (const entry of renderer.continuations || []) {
		const data =
			entry.invalidationContinuationData ||
			entry.timedContinuationData ||
			entry.reloadContinuationData ||
			entry.liveChatReplayContinuationData
		if (data?.continuation) return data.continuation
	}
	return ""
}

export class YouTubeScrapePoller {
	constructor({ videoId, onMessage, onRemove, onStatus, getOptions }) {
		this.videoId = videoId
		this.onMessage = onMessage
		this.onRemove = onRemove
		this.onStatus = onStatus || (() => {})
		this.getOptions = getOptions || (() => ({}))
		this.stopped = false
		this.seen = new Set()
		this.continuation = ""
		this.apiKey = ""
		this.context = null
	}

	async #init() {
		const url = `https://www.youtube.com/live_chat?v=${this.videoId}&is_popout=1`
		const html = await fetchText(url, { headers: HTML_HEADERS, timeout: 20000 })
		this.apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] || ""
		const clientVersion =
			html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1] ||
			html.match(/"clientVersion":"([\d.]+)"/)?.[1] ||
			"2.20240101.00.00"
		const initialDataIndex = html.indexOf("ytInitialData")
		const initialData = initialDataIndex >= 0 ? extractJsonAt(html, initialDataIndex) : null
		this.continuation = findContinuation(initialData)
		this.context = { client: { clientName: "WEB", clientVersion, hl: "en", gl: "US" } }

		if (!this.apiKey || !this.continuation) {
			throw new ChatUnavailableError("ไม่พบหน้าแชทสด (ไลฟ์อาจจบแล้วหรือปิดแชท)")
		}
		log.info(`เริ่มอ่านแชท (scrape) video=${this.videoId} client=${clientVersion}`)
	}

	async #poll() {
		const body = JSON.stringify({ context: this.context, continuation: this.continuation })
		const data = await fetchJson(
			`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${this.apiKey}&prettyPrint=false`,
			{
				method: "POST",
				headers: { "content-type": "application/json", "accept-language": "en-US,en;q=0.9" },
				body,
				timeout: 20000,
			},
		)
		const chat = data?.continuationContents?.liveChatContinuation
		if (!chat) throw new ChatUnavailableError("แชทสดปิดแล้ว")

		const next = chat.continuations?.[0] || {}
		const nextData = next.invalidationContinuationData || next.timedContinuationData || next.reloadContinuationData
		if (nextData?.continuation) this.continuation = nextData.continuation
		const timeoutMs = Number(nextData?.timeoutMs) || 0

		const actions = chat.actions || []
		const options = this.getOptions()
		const first = this.seen.size === 0
		const collected = []
		for (const rawAction of actions) {
			const action = rawAction.replayChatItemAction?.actions?.[0] || rawAction
			const item = action.addChatItemAction?.item
			if (item) {
				const message = itemToMessage(item, options)
				if (!message) continue
				const key = message.id
				if (this.seen.has(key)) continue
				this.seen.add(key)
				collected.push(message)
				continue
			}
			const deletedId = action.markChatItemAsDeletedAction?.targetItemId
			if (deletedId) {
				this.onRemove?.({ platform: "youtube", ids: [`youtube:${deletedId}`] })
				continue
			}
			const deletedAuthor = action.markChatItemsByAuthorAsDeletedAction?.externalChannelId
			if (deletedAuthor) this.onRemove?.({ platform: "youtube", authorIds: [deletedAuthor] })
		}

		// Skip the historical backlog that YouTube replays on the first request.
		const fresh = first
			? collected.filter((message) => Date.now() - message.timestamp < 60000).slice(-5)
			: collected
		for (const message of fresh) this.onMessage(message)

		if (this.seen.size > 2000) {
			this.seen = new Set([...this.seen].slice(-800))
		}
		return timeoutMs
	}

	async run() {
		await this.#init()
		this.onStatus({ state: "connected", detail: `scrape • ${this.videoId}` })
		let failures = 0
		while (!this.stopped) {
			try {
				const timeoutMs = await this.#poll()
				failures = 0
				const wait = Math.max(1000, Math.min(timeoutMs || 3000, 10000))
				await sleep(wait)
			} catch (error) {
				if (error instanceof ChatUnavailableError) throw error
				failures += 1
				log.warn(`poll ล้มเหลว (${failures}):`, error.message)
				if (failures >= 5) throw new ChatUnavailableError(`อ่านแชทไม่ได้: ${error.message}`)
				this.onStatus({ state: "reconnecting", detail: error.message })
				await sleep(2000 * failures)
			}
		}
	}

	stop() {
		this.stopped = true
	}
}
