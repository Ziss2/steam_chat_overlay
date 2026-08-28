/**
 * Resolve "which video should we read chat from?" for YouTube.
 * Channel -> current live video is resolved by scraping /live (free, no API key),
 * with the Data API search endpoint as a fallback when a key is available.
 */
import { fetchJson, fetchText, logger, parseYouTubeChannelRef, parseYouTubeVideoId } from "../util.js"

const log = logger("youtube-resolve")

async function scrapeLiveVideoId(channelRef) {
	const path = channelRef.type === "id" ? `channel/${channelRef.value}` : channelRef.value
	const url = `https://www.youtube.com/${path}/live`
	let html
	try {
		html = await fetchText(url, { headers: { "accept-language": "en-US,en;q=0.9" }, timeout: 20000 })
	} catch (error) {
		log.warn(`เปิด ${url} ไม่ได้:`, error.message)
		return ""
	}
	const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)
	const fromCanonical = canonical ? parseYouTubeVideoId(canonical[1]) : ""
	if (fromCanonical) return fromCanonical
	// Fallback: watch payload embedded in the page — only trust it when it really is live,
	// otherwise an offline channel page would hand us a random VOD id.
	if (!/"isLive":\s*true/.test(html)) return ""
	const embedded = html.match(/"videoDetails":\{"videoId":"([\w-]{11})"/)
	return embedded ? embedded[1] : ""
}

async function searchLiveVideoId(channelId, apiKey) {
	const url = new URL("https://www.googleapis.com/youtube/v3/search")
	url.searchParams.set("part", "id")
	url.searchParams.set("channelId", channelId)
	url.searchParams.set("eventType", "live")
	url.searchParams.set("type", "video")
	url.searchParams.set("maxResults", "1")
	url.searchParams.set("key", apiKey)
	const data = await fetchJson(url.toString())
	return data?.items?.[0]?.id?.videoId || ""
}

/**
 * @returns {Promise<{videoId:string, source:string}>} empty videoId = ไม่มีไลฟ์อยู่
 */
export async function resolveVideoId({ videoId, channelId, apiKey }) {
	const direct = parseYouTubeVideoId(videoId)
	if (direct) return { videoId: direct, source: "config" }

	const channelRef = parseYouTubeChannelRef(channelId)
	if (!channelRef) return { videoId: "", source: "none" }

	const scraped = await scrapeLiveVideoId(channelRef)
	if (scraped) return { videoId: scraped, source: "channel-live-page" }

	if (apiKey && channelRef.type === "id") {
		try {
			const found = await searchLiveVideoId(channelRef.value, apiKey)
			if (found) return { videoId: found, source: "data-api-search" }
		} catch (error) {
			log.warn("search API ไม่สำเร็จ:", error.message)
		}
	}
	return { videoId: "", source: "not-live" }
}
