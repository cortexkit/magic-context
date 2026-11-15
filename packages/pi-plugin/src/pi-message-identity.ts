import { createHash } from "node:crypto";
import { stableStringify } from "@magic-context/core/shared/stable-json";
import {
	createPiServedCachedView,
	type PiServedCachedView,
} from "./pi-tool-identity";

export function piMessageEntryFingerprint(message: unknown): string | null {
	if (!message || typeof message !== "object") return null;
	const m = message as Record<string, unknown>;
	if (typeof m.role !== "string") return null;
	const contentHash = createHash("sha256")
		.update(stableStringify(m.content))
		.digest("hex");
	return JSON.stringify([
		typeof m.responseId === "string" ? m.responseId : null,
		typeof m.timestamp === "number" || typeof m.timestamp === "string"
			? m.timestamp
			: null,
		m.role,
		typeof m.toolCallId === "string" ? m.toolCallId : null,
		contentHash,
	]);
}

/** The header part of piMessageEntryFingerprint: everything except the content hash. */
function fingerprintHeader(fingerprint: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(fingerprint);
		return Array.isArray(parsed) && parsed.length === 5
			? JSON.stringify(parsed.slice(0, 4))
			: undefined;
	} catch {
		return undefined;
	}
}

function messageHeader(message: Record<string, unknown>): string {
	return JSON.stringify([
		typeof message.responseId === "string" ? message.responseId : null,
		typeof message.timestamp === "number" ||
		typeof message.timestamp === "string"
			? message.timestamp
			: null,
		message.role,
		typeof message.toolCallId === "string" ? message.toolCallId : null,
	]);
}

function textParts(message: Record<string, unknown>): string[] {
	return typeof message.content === "string"
		? [message.content]
		: Array.isArray(message.content)
			? message.content.flatMap((part) => {
					if (!part || typeof part !== "object") return [];
					const p = part as Record<string, unknown>;
					return p.type === "text" && typeof p.text === "string"
						? [p.text]
						: [];
				})
			: [];
}

/**
 * The candidate number the last returned array shows on this message part.
 *
 * Exactly one candidate must be rendered as a tag anywhere in the array (see
 * piRenderedTagNumbers), and a served message with this entry's header
 * (response id, timestamp, role, tool call id) must carry it on the same text
 * part: as the leading tag when that row is active, or as the whole
 * `[dropped §N§]` placeholder when it is dropped. The served content is not compared with the entry:
 * Magic Context rewrites served text (stripped reminders, reasoning or caveman
 * rewrites, placeholders), so a content comparison would fail for exactly the
 * messages it changed. Matching the header and the rendered number is enough:
 * a tag number is rendered only on the part its row belongs to, and that row
 * is already one of this identity's candidates.
 */
export function piCachedMessageSurvivor(
	sessionId: string,
	fingerprint: string,
	ordinal: number,
	rows: readonly { tagNumber: number; status: string }[],
	view?: PiServedCachedView | null,
): number | undefined {
	const cached =
		view === undefined ? createPiServedCachedView(sessionId) : view;
	if (!cached) return;
	const header = fingerprintHeader(fingerprint);
	if (header === undefined) return;
	const rendered = cached.rendered();
	const present = rows.filter((row) => rendered.has(row.tagNumber));
	const winner = present[0];
	if (present.length !== 1 || !winner) return;
	if (winner.status !== "active" && winner.status !== "dropped") return;
	// Same rule as the tool proof: an active part leads with its tag, a dropped
	// part is exactly its placeholder. A dropped survivor must be accepted, or
	// the fold would keep the other (active) number and put dropped content
	// back on the wire.
	const shows = (text: string | undefined) =>
		winner.status === "dropped"
			? text === `[dropped §${winner.tagNumber}§]`
			: text?.startsWith(`§${winner.tagNumber}§ `) === true;
	const carriers = (
		cached
			.memo("messagesByHeader", () => {
				const byHeader = new Map<string, Record<string, unknown>[]>();
				for (const message of cached.messages) {
					const key = messageHeader(message);
					const list = byHeader.get(key);
					if (list) list.push(message);
					else byHeader.set(key, [message]);
				}
				return byHeader;
			})
			.get(header) ?? []
	).filter((message) => shows(textParts(message)[ordinal]));
	return carriers.length === 1 ? winner.tagNumber : undefined;
}
