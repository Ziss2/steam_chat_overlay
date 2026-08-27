/**
 * Config store: defaults + config.json + .env overrides, with live patching.
 * The config file is the single source of truth that the /config UI edits.
 */
import fs from "node:fs"
import path from "node:path"
import { EventEmitter } from "node:events"
import { fileURLToPath } from "node:url"
import { logger } from "./util.js"

const log = logger("config")
const here = path.dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = path.resolve(here, "..")
const CONFIG_PATH = path.join(ROOT_DIR, "config.json")
const ENV_PATH = path.join(ROOT_DIR, ".env")

export const DEFAULT_CONFIG = {
	server: { port: 4700, host: "0.0.0.0" },
	twitch: { enabled: false, channel: "", showSubEvents: true },
	youtube: {
		enabled: false,
		mode: "auto", // auto | api | scrape
		apiKey: "",
		channelId: "",
		videoId: "",
		pollIntervalMs: 4000,
		showSuperChat: true,
		showMemberEvents: true,
	},
	kick: {
		enabled: false,
		channel: "", // ชื่อช่องบน kick.com (slug เช่น xqc)
		showSubEvents: true, // อีเวนต์ติดซับ / ไฮไลต์
	},
	tiktok: {
		enabled: false,
		channel: "", // ชื่อผู้ใช้ TikTok (@ ไม่บังคับ เช่น nasa)
		showGiftEvents: true,
		showMemberEvents: true,
	},
	emotes: { bttv: true, sevenTv: true, ffz: true },
	filters: { hideCommands: true, maxLength: 300, blockedUsers: [], blockedWords: [] },
	theme: {
		fontFamily: "Kanit, Noto Sans Thai, Segoe UI, sans-serif",
		fontSize: 20,
		fontWeight: 500,
		nameWeight: 700,
		lineHeight: 1.35,
		width: 420,
		align: "left", // left | right
		direction: "bottom", // bottom = newest at bottom, top = newest at top
		layout: "card", // card | compact | bubble
		textColor: "#ffffff",
		bgColor: "#000000",
		bgOpacity: 0.55,
		radius: 12,
		gap: 8,
		padding: 10,
		outline: true,
		shadow: true,
		colorMode: "platform", // platform | chat | fixed
		twitchColor: "#a970ff",
		youtubeColor: "#ff4e45",
		kickColor: "#53fc18",
		tiktokColor: "#fe2c55",
		accentBar: true,
		showPlatformIcon: true,
		showBadges: true,
		showEmotes: true,
		showTimestamps: false,
		showAvatar: false,
		avatarSize: 56,
		bubbleColor: "#fff6da",
		bubbleTextColor: "#1b1b1b",
		liveMotion: true, // ป้ายชื่อขยับ + ฟองข้อความลอย (โหมดฟองข้อความ)
		emoteSize: 28,
		animation: "slide", // slide | fade | pop | none
		maxMessages: 25,
		messageLifetimeSec: 0, // 0 = keep until pushed out
		background: "transparent", // transparent | any CSS color (chroma key)
	},
}

/** Minimal .env loader so no dotenv dependency is required. */
function loadEnvFile() {
	if (!fs.existsSync(ENV_PATH)) return
	const content = fs.readFileSync(ENV_PATH, "utf8")
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith("#")) continue
		const eq = line.indexOf("=")
		if (eq < 0) continue
		const key = line.slice(0, eq).trim()
		let value = line.slice(eq + 1).trim()
		if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
		if (value && process.env[key] === undefined) process.env[key] = value
	}
}

function isPlainObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value)
}

export function deepMerge(base, patch) {
	if (!isPlainObject(patch)) return structuredClone(base)
	const out = structuredClone(base)
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue
		if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value)
		else out[key] = structuredClone(value)
	}
	return out
}

/** Keep only keys that exist in DEFAULT_CONFIG so the UI cannot inject junk. */
function pickKnown(defaults, patch) {
	if (!isPlainObject(patch)) return {}
	const out = {}
	for (const [key, value] of Object.entries(patch)) {
		if (!(key in defaults)) continue
		const fallback = defaults[key]
		if (isPlainObject(fallback)) out[key] = pickKnown(fallback, value)
		else if (Array.isArray(fallback)) out[key] = Array.isArray(value) ? value.map((item) => String(item)) : fallback
		else if (typeof fallback === "number") out[key] = Number.isFinite(Number(value)) ? Number(value) : fallback
		else if (typeof fallback === "boolean") out[key] = Boolean(value)
		else out[key] = value === null || value === undefined ? "" : String(value)
	}
	return out
}

class ConfigStore extends EventEmitter {
	constructor() {
		super()
		loadEnvFile()
		this.fileConfig = this.#readFile()
		this.current = this.#resolve()
	}

	#readFile() {
		if (!fs.existsSync(CONFIG_PATH)) {
			log.info("ไม่พบ config.json — สร้างจากค่าเริ่มต้น")
			const seed = structuredClone(DEFAULT_CONFIG)
			fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(seed, null, 2)}\n`, "utf8")
			return seed
		}
		try {
			return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
		} catch (error) {
			log.error("อ่าน config.json ไม่ได้ ใช้ค่าเริ่มต้นแทน:", error.message)
			return {}
		}
	}

	/** File config + env overrides for secrets/port. */
	#resolve() {
		const merged = deepMerge(DEFAULT_CONFIG, pickKnown(DEFAULT_CONFIG, this.fileConfig))
		if (process.env.YOUTUBE_API_KEY) merged.youtube.apiKey = process.env.YOUTUBE_API_KEY
		if (process.env.PORT) merged.server.port = Number(process.env.PORT) || merged.server.port
		if (process.env.HOST) merged.server.host = process.env.HOST
		merged.twitch.channel = String(merged.twitch.channel || "")
			.trim()
			.replace(/^#/, "")
			.toLowerCase()
		merged.youtube.mode = ["auto", "api", "scrape"].includes(merged.youtube.mode) ? merged.youtube.mode : "auto"
		merged.youtube.pollIntervalMs = Math.max(1500, Number(merged.youtube.pollIntervalMs) || 4000)
		return merged
	}

	get() {
		return this.current
	}

	/** Config for the browser: secrets masked. */
	forClient() {
		const clone = structuredClone(this.current)
		clone.youtube.apiKey = clone.youtube.apiKey ? "__set__" : ""
		clone.youtube.apiKeyFromEnv = Boolean(process.env.YOUTUBE_API_KEY)
		return clone
	}

	/**
	 * Apply a partial config patch, persist it and notify listeners.
	 * Returns { config, changed: string[] } with the top-level sections that changed.
	 */
	patch(partial) {
		const safe = pickKnown(DEFAULT_CONFIG, partial)
		// "__set__" means "keep the existing secret" (UI never receives the real key).
		if (safe.youtube && safe.youtube.apiKey === "__set__") delete safe.youtube.apiKey
		const before = this.current
		this.fileConfig = deepMerge(this.fileConfig, safe)
		this.current = this.#resolve()
		this.#save()
		const changed = Object.keys(DEFAULT_CONFIG).filter(
			(section) => JSON.stringify(before[section]) !== JSON.stringify(this.current[section]),
		)
		if (changed.length) {
			log.info("อัปเดต config:", changed.join(", "))
			this.emit("change", { config: this.current, changed })
		}
		return { config: this.current, changed }
	}

	#save() {
		const payload = deepMerge(DEFAULT_CONFIG, this.fileConfig)
		// Never write an env-provided key into config.json.
		if (process.env.YOUTUBE_API_KEY && payload.youtube.apiKey === process.env.YOUTUBE_API_KEY) {
			payload.youtube.apiKey = this.fileConfig?.youtube?.apiKey ?? ""
		}
		const tmp = `${CONFIG_PATH}.tmp`
		fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
		fs.renameSync(tmp, CONFIG_PATH)
	}
}

export const config = new ConfigStore()
export const CONFIG_FILE = CONFIG_PATH
