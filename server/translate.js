const cache = new Map()
const CACHE_TTL = 1000 * 60 * 60

function detectLang(text) {
	const th = /[\u0E00-\u0E7F]/
	const ja = /[\u3040-\u30FF\u31F0-\u31FF]/
	const ko = /[\uAC00-\uD7AF\u1100-\u11FF]/
	const zh = /[\u4E00-\u9FFF]/
	if (th.test(text)) return "th"
	if (ja.test(text)) return "ja"
	if (ko.test(text)) return "ko"
	if (zh.test(text)) return "zh-CN"
	return "en"
}

const LINGVA_INSTANCES = [
	"https://lingva.garudalinux.org",
	"https://lingva.lunar.icu",
	"https://translate.plausibility.cloud",
	"https://lingva.ml",
]

async function tryMyMemory(text, source, target) {
	const url = new URL("https://api.mymemory.translated.net/get")
	url.searchParams.set("q", text)
	url.searchParams.set("langpair", `${source}|${target}`)
	const response = await fetch(url.toString())
	if (!response.ok) throw new Error(`HTTP ${response.status}`)
	const data = await response.json()
	if (data.responseStatus === 200 && data.responseData?.translatedText) {
		return data.responseData.translatedText
	}
	throw new Error(data.responseDetails || "MyMemory error")
}

async function tryLingva(text, source, target) {
	for (const base of LINGVA_INSTANCES) {
		try {
			const url = `${base}/api/v1/${encodeURIComponent(source)}/${encodeURIComponent(target)}/${encodeURIComponent(text)}`
			const response = await fetch(url, { headers: { Accept: "application/json" } })
			if (!response.ok) continue
			const data = await response.json()
			if (data.translation) return data.translation
		} catch {
			// try next instance
		}
	}
	throw new Error("Lingva unavailable")
}

const PROVIDERS = {
	mymemory: tryMyMemory,
	lingva: tryLingva,
}

export async function translate(text, from = "auto", to = "th", provider = "auto") {
	if (!text || !text.trim()) return text
	const source = from === "auto" ? detectLang(text) : from
	const key = `${source}|${to}|${text.trim()}`
	const cached = cache.get(key)
	if (cached && Date.now() - cached.time < CACHE_TTL) return cached.text

	const providers = provider === "auto" ? [tryMyMemory, tryLingva] : [PROVIDERS[provider]].filter(Boolean)
	for (const fn of providers) {
		try {
			const translated = await fn(text, source, to)
			if (translated && translated !== text) {
				cache.set(key, { text: translated, time: Date.now() })
				return translated
			}
		} catch {
			// continue to next provider
		}
	}
	return text
}
