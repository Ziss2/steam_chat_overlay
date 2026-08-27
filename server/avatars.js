/**
 * Avatar lookup for platforms that do not ship a profile picture with each message.
 * Twitch: public GQL (same source as badges) with decapi.me as a fallback.
 * Results are cached in memory, including misses, and concurrent lookups are shared.
 */
import { fetchText, logger, tryFetchJson } from "./util.js"

const log = logger("avatars")
const GQL_URL = "https://gql.twitch.tv/gql"
const GQL_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"
const HIT_TTL = 6 * 60 * 60 * 1000
const MISS_TTL = 10 * 60 * 1000
const LOGIN_RE = /^[a-z0-9_]{1,25}$/

const cache = new Map()
const inflight = new Map()

async function lookupTwitch(login) {
	const gql = await tryFetchJson(GQL_URL, {
		method: "POST",
		headers: { "content-type": "application/json", "client-id": GQL_CLIENT_ID },
		body: JSON.stringify({
			query: "query($login: String!) { user(login: $login) { profileImageURL(width: 300) } }",
			variables: { login },
		}),
		timeout: 12000,
	})
	const fromGql = gql?.data?.user?.profileImageURL
	if (fromGql) return fromGql
	try {
		const text = (await fetchText(`https://decapi.me/twitch/avatar/${encodeURIComponent(login)}`, { timeout: 12000 })).trim()
		if (/^https:\/\//i.test(text)) return text
	} catch (error) {
		log.debug(`decapi ล้มเหลวสำหรับ ${login}: ${error.message}`)
	}
	return ""
}

/** @returns {Promise<string>} url ของรูปโปรไฟล์ หรือ "" ถ้าไม่พบ */
export async function twitchAvatar(rawLogin) {
	const login = String(rawLogin || "").trim().toLowerCase()
	if (!LOGIN_RE.test(login)) return ""

	const cached = cache.get(login)
	if (cached && cached.expires > Date.now()) return cached.url
	if (inflight.has(login)) return inflight.get(login)

	const promise = lookupTwitch(login)
		.then((url) => {
			cache.set(login, { url, expires: Date.now() + (url ? HIT_TTL : MISS_TTL) })
			return url
		})
		.catch((error) => {
			log.warn(`หา avatar ของ ${login} ไม่ได้:`, error.message)
			cache.set(login, { url: "", expires: Date.now() + MISS_TTL })
			return ""
		})
		.finally(() => inflight.delete(login))

	inflight.set(login, promise)
	return promise
}
