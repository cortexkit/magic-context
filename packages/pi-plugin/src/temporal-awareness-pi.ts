/**
 * Pi-side temporal-marker injection — mirrors OpenCode's
 * `injectTemporalMarkers` (packages/plugin/src/hooks/magic-context/temporal-awareness.ts).
 *
 * Behaves identically to OpenCode at the agent-visible layer: when the
 * gap between the previous message's effective end time and the current
 * user message's creation time exceeds TEMPORAL_AWARENESS_THRESHOLD_SECONDS
 * (5 minutes), prepends an HTML-comment marker to the user message's
 * first text content (`<!-- +12m -->\n`, `<!-- +2h 15m -->\n`, etc.).
 *
 * Pi differences:
 *   - Pi messages carry a single `timestamp` (number, ms epoch). Pi has
 *     no separate created/completed fields the way OpenCode does — the
 *     timestamp is when the message was emitted. We use that for both
 *     "previous end time" and "current creation time", which is the
 *     same effective behavior OpenCode falls back to for non-completed
 *     messages (see effectiveEndMs in temporal-awareness.ts).
 *   - Pi user messages have `content: string | (TextContent | ImageContent)[]`.
 *     We mutate the first text content (or convert string → array+text).
 *
 * Idempotent: re-injecting on a later transform pass detects existing
 * markers via the same regex OpenCode uses and skips. Safe to run on
 * every pass (intentional — same as OpenCode, see transform.ts:648).
 */

import {
	TEMPORAL_MARKER_PATTERN,
	temporalMarkerPrefix,
} from "@magic-context/core/hooks/magic-context/temporal-awareness";

type PiTextContent = { type: "text"; text: string; textSignature?: string };
type PiImageContent = { type: "image"; data: string; mimeType: string };
type PiUserMessage = {
	role: "user";
	content: string | (PiTextContent | PiImageContent)[];
	timestamp?: number;
};
type PiOtherMessage = {
	role: "assistant" | "toolResult" | string;
	timestamp?: number;
};
type PiAgentMessage = PiUserMessage | PiOtherMessage;

/**
 * Inject HTML-comment gap markers into Pi user messages. Mirrors
 * OpenCode's `injectTemporalMarkers` 1:1 in agent-visible behavior;
 * differences are limited to the message-shape walking and write
 * back into Pi's content union.
 *
 * Returns the number of user messages that received a new marker.
 */
export function injectPiTemporalMarkers(messages: unknown[]): number {
	let injected = 0;
	let prevTimestampMs: number | undefined;

	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAgentMessage;
		const role = msg.role;

		const currTimestamp = msg.timestamp;
		// Compute gap from previous-any-role message → current user message.
		// Matches OpenCode: any role triggers the "previous time" baseline,
		// only user role receives the marker.
		if (
			prevTimestampMs !== undefined &&
			role === "user" &&
			typeof currTimestamp === "number"
		) {
			const gapSec = (currTimestamp - prevTimestampMs) / 1000;
			const prefix = temporalMarkerPrefix(gapSec);
			if (prefix !== null) {
				const userMsg = msg as PiUserMessage;
				if (typeof userMsg.content === "string") {
					if (!TEMPORAL_MARKER_PATTERN.test(stripTagPrefix(userMsg.content))) {
						const tagMatch = userMsg.content.match(/^(?:§\d+§\s*)+/);
						const tagPrefix = tagMatch ? tagMatch[0] : "";
						const body = userMsg.content.slice(tagPrefix.length);
						(messages as PiAgentMessage[])[i] = {
							...userMsg,
							content: tagPrefix + prefix + body,
						};
						injected++;
					}
				} else if (Array.isArray(userMsg.content)) {
					const firstTextIndex = userMsg.content.findIndex(
						(p) =>
							p &&
							typeof p === "object" &&
							(p as { type?: unknown }).type === "text",
					);
					if (firstTextIndex >= 0) {
						const existing = userMsg.content[firstTextIndex] as PiTextContent;
						const tagMatch = existing.text.match(/^(?:§\d+§\s*)+/);
						const tagPrefix = tagMatch ? tagMatch[0] : "";
						const body = existing.text.slice(tagPrefix.length);
						if (!TEMPORAL_MARKER_PATTERN.test(body)) {
							const newContent = userMsg.content.slice();
							newContent[firstTextIndex] = {
								...existing,
								text: tagPrefix + prefix + body,
							};
							(messages as PiAgentMessage[])[i] = {
								...userMsg,
								content: newContent,
							};
							injected++;
						}
					}
				}
			}
		}

		// Use the current message's timestamp as the baseline for the
		// next iteration. Falls back to keeping the previous value when
		// the current message has no timestamp (e.g. malformed input).
		if (typeof currTimestamp === "number") {
			prevTimestampMs = currTimestamp;
		}
	}

	return injected;
}

/**
 * Strip the leading `§N§` tag prefix(es) so we test the marker pattern
 * against the body, not against the tagged form. Matches OpenCode's
 * approach in `injectTemporalMarkers`.
 */
function stripTagPrefix(text: string): string {
	const match = text.match(/^(?:§\d+§\s*)+/);
	if (!match) return text;
	return text.slice(match[0].length);
}
