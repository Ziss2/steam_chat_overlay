/**
 * Overlay server: static files + REST config API + WebSocket fan-out.
 *
 *   http://127.0.0.1:PORT/overlay  -> put this in OBS as a Browser Source
 *   http://127.0.0.1:PORT/config   -> control panel (theme editing, live)
 */
import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import express from "express"
import multer from "multer"
import { WebSocketServer } from "ws"
import { config, DEFAULT_CONFIG, ROOT_DIR } from "./config.js"
import { Hub } from "./hub.js"
import { TwitchSource } from "./twitch/index.js"
import { YouTubeSource } from "./youtube/index.js"
import { KickSource } from "./kick/index.js"
import { TikTokSource } from "./tiktok/index.js"
import { createEvent, createMessage, emoteFragment, textFragment } from "./message.js"
import { twitchAvatar } from "./avatars.js"
import { logger } from "./util.js"
import { isAutoRunEnabled, setAutoRun } from "./autostart.js"
import { translate } from "./translate.js"

const log = logger("server")
const hub = new Hub()
const twitch = new TwitchSource({ hub, config })
const youtube = new YouTubeSource({ hub, config })
const kick = new KickSource({ hub, config })
const tiktok = new TikTokSource({ hub, config })

const app = express()
app.disable("x-powered-by")
app.use(express.json({ limit: "256kb" }))
app.use((req, res, next) => {
	res.setHeader("cache-control", "no-store")
	next()
})

const SOUNDS_DIR = path.join(ROOT_DIR, "sounds")
if (!fs.existsSync(SOUNDS_DIR)) fs.mkdirSync(SOUNDS_DIR, { recursive: true })

const upload = multer({
	dest: SOUNDS_DIR,
	limits: { fileSize: 2 * 1024 * 1024 },
	fileFilter: (req, file, cb) => {
		const ok = /audio\/(mpeg|mp4|ogg|wav|webm)/.test(file.mimetype)
			|| /\.(mp3|wav|ogg|m4a|webm)$/i.test(file.originalname)
		cb(ok ? null : new Error("ชนิดไฟล์ไม่รองรับ"), ok)
	},
})

app.use(express.static(path.join(ROOT_DIR, "public"), { extensions: ["html"], cacheControl: false }))
app.use("/sounds", express.static(SOUNDS_DIR))

app.get("/", (_req, res) => res.redirect("/config"))
app.get("/overlay", (_req, res) => res.sendFile(path.join(ROOT_DIR, "public", "overlay.html")))
app.get("/translation-overlay", (_req, res) => res.sendFile(path.join(ROOT_DIR, "public", "translation-overlay.html")))
app.get("/config", (_req, res) => res.sendFile(path.join(ROOT_DIR, "public", "config.html")))

app.get("/api/config", (_req, res) => {
	res.json({ config: config.forClient(), defaults: DEFAULT_CONFIG, status: hub.getStatus() })
})

app.put("/api/config", (req, res) => {
	try {
		const { changed } = config.patch(req.body || {})
		res.json({ ok: true, changed, config: config.forClient() })
		log.debug("patch config", changed)
	} catch (error) {
		log.error("patch config ล้มเหลว:", error.message)
		res.status(400).json({ ok: false, error: error.message })
	}
})

app.get("/api/status", (_req, res) => res.json({ status: hub.getStatus() }))

/** Avatar proxy: keeps third-party lookups server-side (cached) so the overlay has no CORS worries. */
app.get("/api/avatar", async (req, res) => {
	const platform = String(req.query.platform || "twitch")
	const login = String(req.query.login || "")
	if (platform !== "twitch") return res.json({ url: "" })
	try {
		const url = await twitchAvatar(login)
		res.setHeader("cache-control", "public, max-age=1800")
		res.json({ url })
	} catch (error) {
		log.debug("avatar lookup ล้มเหลว:", error.message)
		res.json({ url: "" })
	}
})

app.post("/api/reconnect", async (req, res) => {
	const platform = req.body?.platform
	if (!platform || platform === "twitch") await twitch.start()
	if (!platform || platform === "youtube") await youtube.start()
	if (!platform || platform === "kick") await kick.start()
	if (!platform || platform === "tiktok") await tiktok.start()
	res.json({ ok: true })
})

app.post("/api/clear", (req, res) => {
	hub.clear(req.body?.platform || null)
	res.json({ ok: true })
})

app.get("/api/autostart", (_req, res) => {
	res.json({ enabled: isAutoRunEnabled() })
})

app.post("/api/autostart", (req, res) => {
	try {
		const { enabled, minimized } = req.body || {}
		setAutoRun(Boolean(enabled), Boolean(minimized))
		res.json({ ok: true })
	} catch (error) {
		res.status(400).json({ ok: false, error: error.message })
	}
})

app.get("/api/sounds", (_req, res) => {
	try {
		const files = fs.readdirSync(SOUNDS_DIR).filter((name) => /\.(mp3|wav|ogg|m4a|webm)$/i.test(name))
		res.json({ files: files.map((name) => ({ name, url: `/sounds/${name}` })) })
	} catch (error) {
		res.json({ files: [] })
	}
})

app.post("/api/sounds/upload", upload.single("sound"), (req, res) => {
	if (!req.file) return res.status(400).json({ ok: false, error: "ไม่ได้อัปโหลดไฟล์" })
	const safeName = `${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_")}`
	const target = path.join(SOUNDS_DIR, safeName)
	fs.renameSync(req.file.path, target)
	res.json({ ok: true, file: { name: safeName, url: `/sounds/${safeName}` } })
})

app.delete("/api/sounds/:file", (req, res) => {
	const file = path.basename(req.params.file)
	const target = path.join(SOUNDS_DIR, file)
	if (!fs.existsSync(target)) return res.status(404).json({ ok: false, error: "ไม่พบไฟล์" })
	fs.unlinkSync(target)
	res.json({ ok: true })
})

app.post("/api/test", (req, res) => {
	const platform = ["twitch", "youtube", "kick", "tiktok"].includes(req.body?.platform) ? req.body.platform : "twitch"
	const kind = req.body?.kind || "chat"
	hub.publish(buildTestMessage(platform, kind))
	res.json({ ok: true })
})

/** Sample messages so the overlay can be styled without a live stream. */
function buildTestMessage(platform, kind) {
	const isTwitch = platform === "twitch"
	const isKick = platform === "kick"
	const isTikTok = platform === "tiktok"
	const isYouTube = platform === "youtube"
	// Use the configured channel for Twitch samples so the real avatar/badges show up.
	const login = config.get().twitch.channel || "kaoruko_dev"
	let author
	if (isTwitch) {
		author = {
			id: "t-demo",
			name: login,
			display: login,
			color: "#00d68f",
			badges: [
				{ id: "moderator", label: "Moderator", image: "" },
				{ id: "subscriber", label: "Subscriber", image: "" },
			],
			roles: { mod: true, sub: true },
		}
	} else if (isKick) {
		author = {
			id: "k-demo",
			name: "kickuser",
			display: "KickUser",
			color: "#53fc18",
			avatar: "",
			badges: [{ id: "moderator", label: "Moderator", image: "" }],
			roles: { mod: true },
		}
	} else if (isTikTok) {
		author = {
			id: "tt-demo",
			name: "tiktokuser",
			display: "TikTokUser",
			color: "",
			avatar: "",
			badges: [],
			roles: { member: true },
		}
	} else {
		author = {
			id: "y-demo",
			name: "somchai",
			display: "สมชาย ดูสตรีม",
			color: "",
			badges: [{ id: "member", label: "สมาชิก", image: "" }],
			roles: { member: true },
		}
	}

	if (kind === "money") {
		const text =
			isTwitch ? "ส่งบิตให้กำลังใจครับ!"
				: isKick ? "ส่งของขวัญให้กำลังใจครับ!"
					: isTikTok ? "ส่งเพชรให้กำลังใจครับ!" : "สู้ๆ นะครับ ชอบคอนเทนต์มาก"
		let event
		if (isTwitch) event = createEvent({ type: "cheer", label: "Cheer", amount: "1,000 Bits", bg: "rgba(145,70,255,0.85)", fg: "#e3d4ff" })
		else if (isKick) event = createEvent({ type: "gift", label: "Gift", amount: "100 Kick", bg: "rgba(83,252,24,0.85)", fg: "#eaffe0" })
		else if (isTikTok) event = createEvent({ type: "gift", label: "Gift", amount: "100 เพชร", bg: "rgba(254,44,85,0.85)", fg: "#ffe3ea" })
		else event = createEvent({ type: "superchat", label: "Super Chat", amount: "THB 100.00", bg: "rgba(245,124,0,0.9)", fg: "#ffffff" })
		return createMessage({
			platform,
			kind: "event",
			author,
			fragments: [textFragment(text)],
			event,
		})
	}
	if (kind === "sub") {
		let event
		if (isTwitch) event = createEvent({ type: "sub", label: "ต่อซับ", amount: "12 เดือน", bg: "rgba(145,70,255,0.85)", fg: "#e6d9ff" })
		else if (isKick) event = createEvent({ type: "sub", label: "ติดซับ Kick", amount: "12 เดือน", bg: "rgba(83,252,24,0.85)", fg: "#eaffe0" })
		else if (isTikTok) event = createEvent({ type: "member", label: "สมาชิกใหม่", amount: "ระดับ Fan", bg: "rgba(254,44,85,0.85)", fg: "#ffe3ea" })
		else event = createEvent({ type: "membership", label: "สมาชิกใหม่", amount: "ระดับ Fan", bg: "rgba(15,157,88,0.85)", fg: "#ffffff" })
		return createMessage({
			platform,
			kind: "event",
			author,
			fragments: [],
			event,
			system: isTwitch ? "KaorukoDev ต่อซับเป็นเดือนที่ 12!" : isKick ? "KickUser ติดซับเป็นเดือนที่ 12!" : isTikTok ? "TikTokUser สมาชิกใหม่!" : "",
		})
	}
	const fragments = [textFragment("ทดสอบข้อความยาว ๆ ดูการตัดบรรทัดของโอเวอร์เลย์ 🎉 ")]
	if (config.get().theme.showEmotes) {
		fragments.push(
			emoteFragment(
				"Kappa",
				"https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0",
				isTwitch ? "twitch" : isKick ? "kick" : isTikTok ? "tiktok" : "youtube",
			),
			textFragment(" "),
		)
	}
	fragments.push(textFragment("สวัสดีครับ"))
	return createMessage({ platform, kind: "chat", author, fragments })
}

const server = app.listen(config.get().server.port, config.get().server.host, () => {
	const port = config.get().server.port
	const bound = config.get().server.host
	log.info(`overlay:  http://127.0.0.1:${port}/overlay  (ในเครื่อง)`)
	log.info(`config:   http://127.0.0.1:${port}/config`)
	if (bound === "0.0.0.0" || bound === "::") {
		for (const address of Object.values(os.networkInterfaces())) {
			for (const info of address || []) {
				if (info.family === "IPv4" && !info.internal) {
					log.info(`เครือข่าย: http://${info.address}:${port}/overlay  (ใช้ IP นี้เมื่อต่อผ่าน VPN/เครือข่ายอื่น)`)
				}
			}
		}
	} else if (bound !== "127.0.0.1" && bound !== "localhost") {
		log.info(`overlay:  http://${bound}:${port}/overlay`)
	}
})

server.on("error", (error) => {
	if (error.code === "EADDRINUSE") {
		log.error(
			`พอร์ต ${config.get().server.port} ถูกใช้งานอยู่แล้ว — ปิดเซิร์ฟเวอร์ตัวเดิม ` +
				`หรือเปลี่ยน server.port ใน config.json (หรือตั้ง PORT ใน .env)`,
		)
		process.exit(1)
	}
	log.error("เซิร์ฟเวอร์ผิดพลาด:", error.message)
	process.exit(1)
})

const wss = new WebSocketServer({ server })
const clients = new Set()
const translationClients = new Set()

function send(socket, payload) {
	if (socket.readyState !== socket.OPEN) return
	socket.send(JSON.stringify(payload))
}

function broadcast(payload) {
	const data = JSON.stringify(payload)
	for (const socket of clients) {
		if (socket.readyState === socket.OPEN) socket.send(data)
	}
}

function broadcastTranslation(payload) {
	const data = JSON.stringify(payload)
	for (const socket of translationClients) {
		if (socket.readyState === socket.OPEN) socket.send(data)
	}
}

wss.on("connection", (socket, req) => {
	const isTranslation = req.url === "/ws-translations"
	if (isTranslation) {
		translationClients.add(socket)
	} else {
		clients.add(socket)
	}
	socket.isAlive = true
	socket.on("pong", () => {
		socket.isAlive = true
	})
	if (isTranslation) {
		send(socket, {
			type: "hello",
			config: config.forClient(),
		})
	} else {
		send(socket, {
			type: "hello",
			config: config.forClient(),
			status: hub.getStatus(),
			recent: hub.recent(20),
		})
	}
	socket.on("message", (raw) => {
		let payload
		try {
			payload = JSON.parse(raw.toString())
		} catch {
			return
		}
		if (payload?.type === "ping") send(socket, { type: "pong" })
	})
	socket.on("close", () => {
		if (isTranslation) translationClients.delete(socket)
		else clients.delete(socket)
	})
	socket.on("error", () => {
		if (isTranslation) translationClients.delete(socket)
		else clients.delete(socket)
	})
	log.debug(`${isTranslation ? "translation" : "client"} เชื่อมต่อ (${isTranslation ? translationClients.size : clients.size} ตัว)`)
})

const heartbeat = setInterval(() => {
	for (const socket of clients) {
		if (!socket.isAlive) {
			socket.terminate()
			clients.delete(socket)
			continue
		}
		socket.isAlive = false
		socket.ping()
	}
	for (const socket of translationClients) {
		if (!socket.isAlive) {
			socket.terminate()
			translationClients.delete(socket)
			continue
		}
		socket.isAlive = false
		socket.ping()
	}
}, 30000)

hub.on("chat", (message) => broadcast({ type: "chat", message }))
hub.on("chat", async (message) => {
	const translation = config.get().translation
	if (!translation?.enabled) return
	if (message.author.name === "__translator_bot__") return
	if (message.kind !== "chat") return
	const text = message.text || ""
	if (!text.trim() || text.length < 2) return
	try {
		const translated = await translate(text, translation.sourceLang || "auto", translation.targetLang || "th", translation.provider || "auto")
		if (!translated || translated === text) return
		const sourceLang = translation.sourceLang === "auto" ? "auto" : translation.sourceLang
		hub.emit("translation", {
			original: text,
			translated,
			sourceLang,
			targetLang: translation.targetLang || "th",
			platform: message.platform,
			author: message.author,
			timestamp: Date.now(),
		})
	} catch (error) {
		log.error("translate error", error.message)
	}
})
hub.on("remove", (payload) => broadcast({ type: "remove", ...payload }))
hub.on("clear", (payload) => broadcast({ type: "clear", ...payload }))
hub.on("status", (status) => broadcast({ type: "status", status }))
hub.on("translation", (data) => broadcastTranslation({ type: "translation", ...data }))

config.on("change", async ({ changed }) => {
	if (changed.includes("theme") || changed.includes("filters")) {
		broadcast({ type: "config", config: config.forClient() })
	}
	try {
		if (changed.includes("twitch") || changed.includes("emotes")) await twitch.start()
		if (changed.includes("youtube")) await youtube.start()
		if (changed.includes("kick")) await kick.start()
		if (changed.includes("tiktok")) await tiktok.start()
	} catch (error) {
		log.error("เริ่มแหล่งข้อมูลล้มเหลว:", error.message)
	}
	if (changed.includes("server")) log.warn("เปลี่ยนพอร์ต/host แล้ว — ต้องรีสตาร์ตเซิร์ฟเวอร์เอง")
	if (changed.includes("app")) {
		await applyAutoRun().catch((error) => log.warn("Auto Run sync ล้มเหลว:", error.message))
		if (config.get().app.autoReconnect && !reconnectMonitor) {
			reconnectMonitor = setInterval(async () => {
				const status = hub.getStatus()
				for (const [platform, source] of [
					["twitch", twitch],
					["youtube", youtube],
					["kick", kick],
					["tiktok", tiktok],
				]) {
					const s = status[platform]
					if (s && s.state === "error" && config.get()[platform].enabled) {
						log.info(`Auto-reconnect ${platform}: ${s.detail || "error"}`)
						await source.start()
					}
				}
			}, 30000)
		} else if (!config.get().app.autoReconnect && reconnectMonitor) {
			clearInterval(reconnectMonitor)
			reconnectMonitor = null
		}
	}
})

async function applyAutoRun() {
	const appConfig = config.get().app
	const current = isAutoRunEnabled()
	if (appConfig.autoRun && !current) {
		await setAutoRun(true, appConfig.startMinimized)
	} else if (!appConfig.autoRun && current) {
		await setAutoRun(false)
	}
}

await twitch.start()
await youtube.start()
await kick.start()
await tiktok.start()

await applyAutoRun().catch((error) => log.warn("Auto Run sync ล้มเหลว:", error.message))

let reconnectMonitor = null
if (config.get().app.autoReconnect) {
	reconnectMonitor = setInterval(async () => {
		const status = hub.getStatus()
		for (const [platform, source] of [
			["twitch", twitch],
			["youtube", youtube],
			["kick", kick],
			["tiktok", tiktok],
		]) {
			const s = status[platform]
			if (s && s.state === "error" && config.get()[platform].enabled) {
				log.info(`Auto-reconnect ${platform}: ${s.detail || "error"}`)
				await source.start()
			}
		}
	}, 30000)
}

let shuttingDown = false
function shutdown(signal) {
	if (shuttingDown) return
	shuttingDown = true
	log.info(`ปิดโปรแกรม (${signal})`)
	clearInterval(heartbeat)
	if (reconnectMonitor) clearInterval(reconnectMonitor)
	twitch.stop()
	youtube.stop()
	kick.stop()
	tiktok.stop()
	for (const socket of clients) socket.close()
	for (const socket of translationClients) socket.close()
	wss.close()
	server.close(() => process.exit(0))
	setTimeout(() => process.exit(0), 3000).unref()
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("unhandledRejection", (reason) => log.error("unhandledRejection:", reason))

app.use((error, req, res, _next) => {
	if (error instanceof multer.MulterError) {
		if (error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ ok: false, error: "ไฟล์ใหญ่เกิน 2MB" })
		return res.status(400).json({ ok: false, error: error.message })
	}
	if (error) return res.status(400).json({ ok: false, error: error.message })
	res.status(404).json({ ok: false, error: "ไม่พบ" })
})
