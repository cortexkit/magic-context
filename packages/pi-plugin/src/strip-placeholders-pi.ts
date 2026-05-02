/**
 * Pi dropped-placeholder stripping — mirrors OpenCode's
 * `stripDroppedPlaceholderMessages` plus persisted
 * `session_meta.stripped_placeholder_ids` replay.
 *
 * OpenCode replaces placeholder-only messages with sentinel shells to
 * keep provider-cache array structure stable. Pi rebuilds `AgentMessage[]`
 * from JSONL on every pass, so the Pi-native operation is simpler: remove
 * messages whose only model-visible content is `[dropped §N§]` after
 * `applyFlushedStatuses` has replayed dropped tag state.
 *
 * Replay is persistent and runs on every pass from stable Pi message ids.
 * Discovery of new placeholder-only ids happens only on cache-busting
 * passes, matching OpenCode's "discover on execute, replay everywhere"
 * contract.
 */

import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	getStrippedPlaceholderIds,
	setStrippedPlaceholderIds,
} from "@magic-context/core/features/magic-context/storage";
import { sessionLog } from "@magic-context/core/shared/logger";
import { piMessageStableId } from "./reasoning-replay-pi";

const DROPPED_SEGMENT_PATTERN = /^\[dropped(?: §[^§]+§)?\]$/;

function isDroppedOnlyText(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return true;
	const segments = trimmed
		.split(/(?=\[dropped(?: §[^§]+§)?\])/)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
	return (
		segments.length > 0 &&
		segments.every((s) => DROPPED_SEGMENT_PATTERN.test(s))
	);
}

function messageIsPlaceholderOnly(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const msg = message as { role?: unknown; content?: unknown };
	if (msg.role !== "assistant" && msg.role !== "user") return false;

	if (typeof msg.content === "string") return isDroppedOnlyText(msg.content);
	if (!Array.isArray(msg.content)) return false;
	if (msg.content.length === 0) return false;

	let sawVisibleContent = false;
	for (const part of msg.content) {
		if (!part || typeof part !== "object") return false;
		const p = part as { type?: unknown; text?: unknown };
		if (p.type !== "text") return false;
		if (typeof p.text !== "string") return false;
		sawVisibleContent = true;
		if (!isDroppedOnlyText(p.text)) return false;
	}
	return sawVisibleContent;
}

export interface StripPiDroppedPlaceholderResult {
	removed: number;
	discovered: number;
}

export function stripPiDroppedPlaceholderMessages(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	isCacheBusting: boolean;
}): StripPiDroppedPlaceholderResult {
	const { db, sessionId, messages, isCacheBusting } = args;
	const persistedIds = getStrippedPlaceholderIds(db, sessionId);
	const idsToStrip = new Set(persistedIds);
	let discovered = 0;

	if (isCacheBusting) {
		for (let i = 0; i < messages.length; i++) {
			const id = piMessageStableId(messages[i], i);
			if (!id) continue;
			if (!messageIsPlaceholderOnly(messages[i])) continue;
			if (!idsToStrip.has(id)) {
				idsToStrip.add(id);
				discovered++;
			}
		}
		if (discovered > 0) setStrippedPlaceholderIds(db, sessionId, idsToStrip);
	}

	let removed = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const id = piMessageStableId(messages[i], i);
		if (!id || !idsToStrip.has(id)) continue;
		messages.splice(i, 1);
		removed++;
	}

	if (removed > 0 || discovered > 0) {
		sessionLog(
			sessionId,
			`pi placeholder strip: removed=${removed} discovered=${discovered}`,
		);
	}
	return { removed, discovered };
}
