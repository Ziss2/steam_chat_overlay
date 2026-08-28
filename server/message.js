/**
 * Normalized chat message factory shared by every platform source.
 * The overlay only ever sees this shape, so adding a platform later is cheap.
 */
import { randomId } from "./util.js"

/**
 * @typedef {{type:'text',text:string}|{type:'emote',name:string,url:string,provider?:string,zeroWidth?:boolean}|{type:'link',text:string,url:string}} Fragment
 */

export function textFragment(text) {
	return { type: "text", text }
}

export function emoteFragment(name, url, provider = "native", zeroWidth = false) {
	return { type: "emote", name, url, provider, zeroWidth }
}

/** Flatten fragments back into plain text (used internally). */
function fragmentsToText(fragments) {
	return fragments
		.map((fragment) => (fragment.type === "emote" ? fragment.name : fragment.text || ""))
		.join("")
		.trim()
}

export function createMessage({
	platform,
	id,
	kind = "chat",
	author = {},
	fragments = [],
	event = null,
	timestamp = Date.now(),
	system = null,
}) {
	const safeFragments = fragments.filter(Boolean)
	return {
		id: id ? `${platform}:${id}` : randomId(platform),
		platform,
		kind,
		author: {
			id: author.id || "",
			name: author.name || "",
			display: author.display || author.name || "",
			color: author.color || "",
			avatar: author.avatar || "",
			badges: author.badges || [],
			roles: {
				owner: Boolean(author.roles?.owner),
				mod: Boolean(author.roles?.mod),
				vip: Boolean(author.roles?.vip),
				sub: Boolean(author.roles?.sub),
				member: Boolean(author.roles?.member),
				verified: Boolean(author.roles?.verified),
			},
		},
		fragments: safeFragments,
		text: fragmentsToText(safeFragments),
		event,
		system,
		timestamp,
	}
}

/**
 * Highlight payload for money / subscription style events.
 * `bg`/`fg` are CSS colors so the overlay does not need platform knowledge.
 */
export function createEvent({ type, label = "", amount = "", tier = 0, bg = "", fg = "" }) {
	return { type, label, amount, tier, bg, fg }
}
