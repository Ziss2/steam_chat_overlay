/**
 * Overlay server: static files + REST config API + WebSocket fan-out.
 *
 *   http://127.0.0.1:PORT/overlay  -> put this in OBS as a Browser Source
 *   http://127.0.0.1:PORT/config   -> control panel (theme editing, live)
 */
import path from "node:path"
import os from "node:os"
import express from "express"
import { WebSocketServer } from "ws"
import { config, DEFAULT_CONFIG, ROOT_DIR } from "./config.js"
import { Hub } from "./hub.js"
import { TwitchSource } from "./twitch/index.js"
import { YouTubeSource } from "./youtube/index.js"
import { createEvent, createMessage, emoteFragment, textFragment } from "./message.js"
import { twitchAvatar } from "./avatars.js"
import { logger } from "./util.js"

const log = logger("server")
const hub = new Hub()
const twitch = new TwitchSource({ hub, config })
const youtube = new YouTubeSource({ hub, config })

const app = express()
app.disable("x-powered-by")
app.use(express.json({ limit: "256kb" }))
app.use((req, res, next) => {
	res.setHeader("cache-control", "no-store")
	next()
})
app.use(express.static(path.join(ROOT_DIR, "public"), { extensions: ["html"], cacheControl: false }))

app.get("/", (_req, res) => res.redirect("/config"))
app.get("/overlay", (_req, res) => res.sendFile(path.join(ROOT_DIR, "public", "overlay.html")))
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
	res.json({ ok: true })
})

app.post("/api/clear", (req, res) => {
	hub.clear(req.body?.platform || null)
	res.json({ ok: true })
})

app.post("/api/test", (req, res) => {
	const platform = req.body?.platform === "youtube" ? "youtube" : "twitch"
	const kind = req.body?.kind || "chat"
	hub.publish(buildTestMessage(platform, kind))
	res.json({ ok: true })
})

/** Sample messages so the overlay can be styled without a live stream. */
function buildTestMessage(platform, kind) {
	const isTwitch = platform === "twitch"
	// Use the configured channel for Twitch samples so the real avatar/badges show up.
	const login = config.get().twitch.channel || "kaoruko_dev"
	const author = isTwitch
		? {
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
		: {
				id: "y-demo",
				name: "somchai",
				display: "สมชาย ดูสตรีม",
				color: "",
				badges: [{ id: "member", label: "สมาชิก", image: "" }],
				roles: { member: true },
			}

	if (kind === "money") {
		return createMessage({
			platform,
			kind: "event",
			author,
			fragments: [textFragment(isTwitch ? "ส่งบิตให้กำลังใจครับ!" : "สู้ๆ นะครับ ชอบคอนเทนต์มาก")],
			event: isTwitch
				? createEvent({ type: "cheer", label: "Cheer", amount: "1,000 Bits", bg: "rgba(145,70,255,0.35)", fg: "#e3d4ff" })
				: createEvent({ type: "superchat", label: "Super Chat", amount: "THB 100.00", bg: "rgba(245,124,0,0.9)", fg: "#ffffff" }),
		})
	}
	if (kind === "sub") {
		return createMessage({
			platform,
			kind: "event",
			author,
			fragments: [],
			event: isTwitch
				? createEvent({ type: "sub", label: "ต่อซับ", amount: "12 เดือน", bg: "rgba(145,70,255,0.32)", fg: "#e6d9ff" })
				: createEvent({ type: "membership", label: "สมาชิกใหม่", amount: "ระดับ Fan", bg: "rgba(15,157,88,0.85)", fg: "#ffffff" }),
			system: isTwitch ? "KaorukoDev ต่อซับเป็นเดือนที่ 12!" : "",
		})
	}
	const fragments = [textFragment("ทดสอบข้อความยาว ๆ ดูการตัดบรรทัดของโอเวอร์เลย์ 🎉 ")]
	if (config.get().theme.showEmotes) {
		fragments.push(
			emoteFragment(
				"Kappa",
				"https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0",
				isTwitch ? "twitch" : "youtube",
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

const wss = new WebSocketServer({ server, path: "/ws" })
const clients = new Set()

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

wss.on("connection", (socket) => {
	clients.add(socket)
	socket.isAlive = true
	socket.on("pong", () => {
		socket.isAlive = true
	})
	send(socket, {
		type: "hello",
		config: config.forClient(),
		status: hub.getStatus(),
		recent: hub.recent(20),
	})
	socket.on("message", (raw) => {
		let payload
		try {
			payload = JSON.parse(raw.toString())
		} catch {
			return
		}
		if (payload?.type === "ping") send(socket, { type: "pong" })
	})
	socket.on("close", () => clients.delete(socket))
	socket.on("error", () => clients.delete(socket))
	log.debug(`client เชื่อมต่อ (${clients.size} ตัว)`)
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
}, 30000)

hub.on("chat", (message) => broadcast({ type: "chat", message }))
hub.on("remove", (payload) => broadcast({ type: "remove", ...payload }))
hub.on("clear", (payload) => broadcast({ type: "clear", ...payload }))
hub.on("status", (status) => broadcast({ type: "status", status }))

config.on("change", async ({ changed }) => {
	if (changed.includes("theme") || changed.includes("filters")) {
		broadcast({ type: "config", config: config.forClient() })
	}
	try {
		if (changed.includes("twitch") || changed.includes("emotes")) await twitch.start()
		if (changed.includes("youtube")) await youtube.start()
	} catch (error) {
		log.error("เริ่มแหล่งข้อมูลล้มเหลว:", error.message)
	}
	if (changed.includes("server")) log.warn("เปลี่ยนพอร์ต/host แล้ว — ต้องรีสตาร์ตเซิร์ฟเวอร์เอง")
})

await twitch.start()
await youtube.start()

let shuttingDown = false
function shutdown(signal) {
	if (shuttingDown) return
	shuttingDown = true
	log.info(`ปิดโปรแกรม (${signal})`)
	clearInterval(heartbeat)
	twitch.stop()
	youtube.stop()
	for (const socket of clients) socket.close()
	wss.close()
	server.close(() => process.exit(0))
	setTimeout(() => process.exit(0), 3000).unref()
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("unhandledRejection", (reason) => log.error("unhandledRejection:", reason))
