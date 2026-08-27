/**
 * Twitch cosmetics: channel/global badges plus third-party emotes (BTTV, 7TV, FFZ).
 * Everything here is optional — failures degrade to plain text, never break chat.
 */
import { logger, tryFetchJson } from "../util.js"

const log = logger("twitch-assets")
// Public web client id used by twitch.tv itself — lets us read badge art without a token.
const GQL_URL = "https://gql.twitch.tv/gql"
const GQL_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"
const BADGE_FIELDS = "setID version title imageURL(size: DOUBLE)"

function absolute(url) {
	if (!url) return ""
	if (url.startsWith("//")) return `https:${url}`
	return url
}

async function gql(query, variables) {
	return tryFetchJson(GQL_URL, {
		method: "POST",
		headers: { "content-type": "application/json", "client-id": GQL_CLIENT_ID },
		body: JSON.stringify({ query, variables }),
		timeout: 15000,
	})
}

export class TwitchAssets {
	constructor() {
		this.badges = new Map() // "setId/version" -> { title, image }
		this.emotes = new Map() // code -> { name, url, provider, zeroWidth }
		this.roomId = ""
		this.login = ""
		this.loadedAt = 0
	}

	/** Native Twitch emote CDN url (from the `emotes` IRC tag). */
	static nativeEmoteUrl(id) {
		return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`
	}

	badge(setId, version) {
		return this.badges.get(`${setId}/${version}`) || this.badges.get(`${setId}/1`) || null
	}

	emote(code) {
		return this.emotes.get(code) || null
	}

	hasEmotes() {
		return this.emotes.size > 0
	}

	/**
	 * @param {{roomId?: string, login?: string}} target channel identity (either is optional)
	 * @param {{bttv?: boolean, sevenTv?: boolean, ffz?: boolean}} options third-party providers to load
	 */
	async load(target = {}, options = {}) {
		this.roomId = target.roomId || this.roomId
		this.login = target.login || this.login
		const jobs = [this.#loadBadges()]
		if (options.bttv) jobs.push(this.#loadBttv(this.roomId))
		if (options.sevenTv) jobs.push(this.#loadSevenTv(this.roomId))
		if (options.ffz) jobs.push(this.#loadFfz(this.roomId))
		await Promise.allSettled(jobs)
		this.loadedAt = Date.now()
		log.info(`โหลด badge ${this.badges.size} ชิ้น, emote เสริม ${this.emotes.size} ตัว`)
	}

	async #loadBadges() {
		const collect = (list) => {
			for (const badge of list || []) {
				if (!badge?.setID) continue
				this.badges.set(`${badge.setID}/${badge.version}`, {
					title: badge.title || badge.setID,
					image: absolute(badge.imageURL),
				})
			}
		}
		const global = await gql(`{ badges { ${BADGE_FIELDS} } }`)
		collect(global?.data?.badges)
		if (!this.login) return
		const channel = await gql(
			`query($login: String!) { user(login: $login) { broadcastBadges { ${BADGE_FIELDS} } } }`,
			{ login: this.login },
		)
		collect(channel?.data?.user?.broadcastBadges)
	}

	#addEmote(name, url, provider, zeroWidth = false) {
		if (!name || !url) return
		this.emotes.set(name, { name, url, provider, zeroWidth })
	}

	async #loadBttv(roomId) {
		const global = await tryFetchJson("https://api.betterttv.net/3/cached/emotes/global")
		for (const emote of global || []) {
			this.#addEmote(emote.code, `https://cdn.betterttv.net/emote/${emote.id}/2x`, "bttv")
		}
		if (!roomId) return
		const channel = await tryFetchJson(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`)
		for (const emote of [...(channel?.channelEmotes || []), ...(channel?.sharedEmotes || [])]) {
			this.#addEmote(emote.code, `https://cdn.betterttv.net/emote/${emote.id}/2x`, "bttv")
		}
	}

	async #loadSevenTv(roomId) {
		const push = (list) => {
			for (const emote of list || []) {
				const id = emote.id || emote.data?.id
				if (!id) continue
				const zeroWidth = Boolean((emote.flags || 0) & 1)
				this.#addEmote(emote.name, `https://cdn.7tv.app/emote/${id}/2x.webp`, "7tv", zeroWidth)
			}
		}
		const global = await tryFetchJson("https://7tv.io/v3/emote-sets/global")
		push(global?.emotes)
		if (!roomId) return
		const user = await tryFetchJson(`https://7tv.io/v3/users/twitch/${roomId}`)
		push(user?.emote_set?.emotes)
	}

	async #loadFfz(roomId) {
		const push = (payload) => {
			for (const set of Object.values(payload?.sets || {})) {
				for (const emote of set.emoticons || []) {
					const url = emote.urls?.["2"] || emote.urls?.["1"] || emote.urls?.["4"]
					this.#addEmote(emote.name, absolute(url), "ffz")
				}
			}
		}
		push(await tryFetchJson("https://api.frankerfacez.com/v1/set/global"))
		if (!roomId) return
		push(await tryFetchJson(`https://api.frankerfacez.com/v1/room/id/${roomId}`))
	}
}
