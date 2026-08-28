/**
 * YouTube chat source coordinator.
 * Picks the transport (Data API v3 or key-less scraping), resolves the live video,
 * and keeps retrying while the channel is offline.
 */
import { YouTubeApiPoller, QuotaError } from "./api.js"
import { ChatUnavailableError, YouTubeScrapePoller } from "./scrape.js"
import { resolveVideoId } from "./resolve.js"
import { Backoff, logger, sleep } from "../util.js"

const log = logger("youtube")
const OFFLINE_RETRY_MS = 30000

export class YouTubeSource {
	constructor({ hub, config }) {
		this.hub = hub
		this.configStore = config
		this.stopped = true
		this.poller = null
		this.forceScrape = false
		this.backoff = new Backoff({ min: 5000, max: 60000 })
	}

	get settings() {
		return this.configStore.get().youtube
	}

	/** Options handed to the pollers on every tick so live config edits apply instantly. */
	#options() {
		const youtube = this.settings
		const theme = this.configStore.get().theme
		return {
			showEmotes: theme.showEmotes,
			showSuperChat: youtube.showSuperChat,
			showMemberEvents: youtube.showMemberEvents,
			pollIntervalMs: youtube.pollIntervalMs,
		}
	}

	async start() {
		this.stop()
		this.stopped = false
		this.forceScrape = false
		const settings = this.settings
		if (!settings.enabled) {
			this.hub.setStatus("youtube", { state: "disabled", detail: "", videoId: "", mode: "" })
			return
		}
		if (!settings.videoId && !settings.channelId) {
			this.hub.setStatus("youtube", {
				state: "error",
				detail: "ต้องใส่ Video ID/ลิงก์ไลฟ์ หรือ Channel ID อย่างน้อยหนึ่งอย่าง",
				videoId: "",
				mode: "",
			})
			return
		}
		this.#loop().catch((error) => log.error("loop ตาย:", error))
	}

	async #loop() {
		while (!this.stopped) {
			const settings = this.settings
			try {
				this.hub.setStatus("youtube", { state: "connecting", detail: "กำลังหาไลฟ์…" })
				const { videoId, source } = await resolveVideoId({
					videoId: settings.videoId,
					channelId: settings.channelId,
					apiKey: settings.apiKey,
				})
				if (!videoId) {
					this.hub.setStatus("youtube", {
						state: "waiting",
						detail: "ยังไม่มีไลฟ์อยู่ — จะลองใหม่อัตโนมัติ",
						videoId: "",
					})
					await sleep(OFFLINE_RETRY_MS)
					continue
				}
				log.info(`เจอวิดีโอไลฟ์ ${videoId} (${source})`)
				await this.#runPoller(videoId)
				this.backoff.reset()
			} catch (error) {
				if (this.stopped) return
				if (error instanceof QuotaError) {
					log.warn(error.message)
					if (this.settings.mode === "auto") {
						this.forceScrape = true
						this.hub.setStatus("youtube", { state: "reconnecting", detail: `${error.message} → สลับเป็นโหมดไม่ใช้ key` })
						continue
					}
					this.hub.setStatus("youtube", { state: "error", detail: error.message })
					await sleep(OFFLINE_RETRY_MS)
					continue
				}
				if (error instanceof ChatUnavailableError) {
					this.hub.setStatus("youtube", { state: "waiting", detail: error.message })
					await sleep(OFFLINE_RETRY_MS)
					continue
				}
				const wait = this.backoff.next()
				log.warn(`ผิดพลาด: ${error.message} — ลองใหม่ใน ${Math.round(wait / 1000)} วิ`)
				this.hub.setStatus("youtube", { state: "reconnecting", detail: error.message })
				await sleep(wait)
			}
		}
	}

	async #runPoller(videoId) {
		const settings = this.settings
		const useApi = !this.forceScrape && Boolean(settings.apiKey) && (settings.mode === "api" || settings.mode === "auto")
		if (settings.mode === "api" && !settings.apiKey) {
			throw new QuotaError("โหมด API ต้องมี YOUTUBE_API_KEY หรือ apiKey ใน config")
		}
		const mode = useApi ? "api" : "scrape"
		this.hub.setStatus("youtube", { videoId, mode, state: "connecting", detail: `โหมด ${mode}` })

		const shared = {
			videoId,
			onMessage: (message) => this.hub.publish(message),
			onRemove: (payload) => this.hub.remove(payload),
			onStatus: (patch) => this.hub.setStatus("youtube", { ...patch, videoId, mode }),
			getOptions: () => this.#options(),
		}
		this.poller = useApi
			? new YouTubeApiPoller({ ...shared, apiKey: settings.apiKey })
			: new YouTubeScrapePoller(shared)
		try {
			await this.poller.run()
		} finally {
			this.poller = null
		}
	}

	stop() {
		this.stopped = true
		this.poller?.stop()
		this.poller = null
	}
}
