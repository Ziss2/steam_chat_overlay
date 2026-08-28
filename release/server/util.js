/**
 * Shared helpers: logging, timers, HTTP fetch wrappers, backoff, id helpers.
 */

import path from "node:path"
import fs from "node:fs"

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const activeLevel = LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info

const logFilePath = process.env.LOG_FILE ? path.resolve(process.env.LOG_FILE) : null
if (logFilePath) {
	try {
		fs.mkdirSync(path.dirname(logFilePath), { recursive: true })
	} catch {}
}

function stamp() {
	return new Date().toTimeString().slice(0, 8)
}

export function logger(scope) {
	const emit = (level, method, args) => {
		if (LEVELS[level] < activeLevel) return
		const msg = args.map((a) => String(a)).join(" ")
		const line = `${stamp()} [${scope}] ${msg}`
		console[method](line)
		if (logFilePath) {
			try {
				fs.appendFileSync(logFilePath, line + "\n", "utf8")
			} catch {}
		}
	}
	return {
		debug: (...args) => emit("debug", "log", args),
		info: (...args) => emit("info", "log", args),
		warn: (...args) => emit("warn", "warn", args),
		error: (...args) => emit("error", "error", args),
	}
}

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export function randomId(prefix = "id") {
	return `${prefix}_${Date.now().toString(36)}}_${Math.random().toString(36).slice(2, 8)}`
}

/** Exponential backoff with jitter, used by every reconnect loop. */
export class Backoff {
	constructor({ min = 1000, max = 30000, factor = 1.8 } = {}) {
		this.min = min
		this.max = max
		this.factor = factor
		this.attempt = 0
	}

	next() {
		const base = Math.min(this.max, this.min * this.factor ** this.attempt)
		this.attempt += 1
		return Math.round(base * (0.7 + Math.random() * 0.6))
	}

	reset() {
		this.attempt = 0
	}
}

async function request(url, { method = "GET", headers = {}, body, timeout = 15000 } = {}) {
	const response = await fetch(url, {
		method,
		headers: { "user-agent": BROWSER_UA, ...headers },
		body,
		signal: AbortSignal.timeout(timeout),
	})
	return response
}

export async function fetchJson(url, options = {}) {
	const response = await request(url, {
		...options,
		headers: { accept: "application/json", ...(options.headers || {}) },
	})
	const text = await response.text()
	let data
	try {
		data = text ? JSON.parse(text) : null
	} catch {
		data = null
	}
	if (!response.ok) {
		const error = new Error(`HTTP ${response.status} for ${url}`)
		error.status = response.status
		error.body = data ?? text.slice(0, 500)
		throw error
	}
	return data
}

export async function fetchText(url, options = {}) {
	const response = await request(url, options)
	if (!response.ok) {
		const error = new Error(`HTTP ${response.status} for ${url}`)
		error.status = response.status
		throw error
	}
	return response.text()
}

/** Fetch JSON but resolve to null on any failure (for optional third-party assets). */
export async function tryFetchJson(url, options = {}) {
	try {
		return await fetchJson(url, options)
	} catch {
		return null
	}
}

/**
 * Extract the first balanced JSON object/array that starts at or after `from`.
 * Needed because YouTube embeds JSON inside <script> blobs.
 */
export function extractJsonAt(source, from) {
	const start = source.indexOf("{", from)
	if (start < 0) return null
	let depth = 0
	let inString = false
	let escaped = false
	for (let i = start; i < source.length; i += 1) {
		const char = source[i]
		if (inString) {
			if (escaped) escaped = false
			else if (char === "\\") escaped = true
			else if (char === '"') inString = false
			continue
		}
		if (char === '"') inString = true
		else if (char === "{") depth += 1
		else if (char === "}") {
			depth -= 1
			if (depth === 0) {
				const slice = source.slice(start, i + 1)
				try {
					return JSON.parse(slice)
				} catch {
					return null
				}
			}
		}
	}
	return null
}

const VIDEO_ID = /^[\w-]{11}$/
const VIDEO_PATH_KEYS = new Set(["live", "embed", "shorts", "v", "watch"])

/**
 * Accepts a bare video id, watch URL, youtu.be link, /live/ link, shorts or embed link.
 * Deliberately strict: a channel URL must NOT be mistaken for a video id.
 */
export function parseYouTubeVideoId(input) {
	const raw = String(input || "").trim()
	if (!raw) return ""
	if (VIDEO_ID.test(raw)) return raw
	if (/^https?:\/\//i.test(raw) || /^(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com)\//i.test(raw)) {
		try {
			const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`)
			const v = url.searchParams.get("v")
			if (v && VIDEO_ID.test(v)) return v
			const parts = url.pathname.split("/").filter(Boolean)
			if (/youtu\.be$/i.test(url.hostname) && parts[0] && VIDEO_ID.test(parts[0])) return parts[0]
			for (let index = 1; index < parts.length; index += 1) {
				if (VIDEO_PATH_KEYS.has(parts[index - 1].toLowerCase()) && VIDEO_ID.test(parts[index])) return parts[index]
			}
			return ""
		} catch {
			return ""
		}
	}
	const match = raw.match(/(?:v=|\/live\/|\/embed\/|\/shorts\/|youtu\.be\/)([\w-]{11})/)
	return match ? match[1] : ""
}

/** Accepts a channel id (UC...), channel URL or @handle. */
export function parseYouTubeChannelRef(input) {
	const raw = String(input || "").trim()
	if (!raw) return null
	if (/^UC[\w-]{20,}$/.test(raw)) return { type: "id", value: raw }
	if (raw.startsWith("@")) return { type: "handle", value: raw }
	try {
		const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`)
		const parts = url.pathname.split("/").filter(Boolean)
		const channelIndex = parts.indexOf("channel")
		if (channelIndex >= 0 && parts[channelIndex + 1]) return { type: "id", value: parts[channelIndex + 1] }
		const handle = parts.find((part) => part.startsWith("@"))
		if (handle) return { type: "handle", value: handle }
		if (parts.length) return { type: "handle", value: `@${parts[0]}` }
	} catch {
		/* ignore */
	}
	return { type: "handle", value: `@${raw}` }
}

/** Convert a YouTube ARGB integer (e.g. bodyBackgroundColor) into a CSS color. */
export function argbToCss(value, alphaOverride) {
	const num = Number(value)
	if (!Number.isFinite(num)) return null
	const a = alphaOverride ?? ((num >>> 24) & 0xff) / 255
	const r = (num >>> 16) & 0xff
	const g = (num >>> 8) & 0xff
	const b = num & 0xff
	return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`
}
