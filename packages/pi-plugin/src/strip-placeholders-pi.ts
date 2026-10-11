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
 *
 * A frozen id never removes a message that owns a tool call. Pi sends every
 * `toolResult` whether or not its call is still in the array, so removing the
 * call's owner strands the result, which Responses and Chat Completions
 * endpoints reject. See `ownsToolCall`.
 */

import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	applyStrippedPlaceholderDelta,
	getStrippedPlaceholderIds,
} from "@magic-context/core/features/magic-context/storage";
import { sessionLog } from "@magic-context/core/shared/logger";
import { resolvePiStableId } from "./read-session-pi";

const MARKER_ONLY_PATTERN =
	/^(?:(?:§\d+§|\[dropped(?: §\d+§)?\]|\[cleared\])\s*)+$/;

export function isPiMarkerOnlyText(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.length > 0 && MARKER_ONLY_PATTERN.test(trimmed);
}

function messageIsPlaceholderOnly(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const msg = message as { role?: unknown; content?: unknown };
	// Only assistant messages may be neutralized/removed. User-role messages
	// anchor turn boundaries the AI SDK relies on to avoid merging consecutive
	// assistants — removing one can collapse a boundary. Mirrors OpenCode's
	// strip-content.ts ("Never neutralize user-role messages — they anchor turn
	// boundaries"). In Pi's raw array, tool results carry role "toolResult"
	// (synthetic tool-result user folds live only in the transcript view, never
	// written back to this array), so genuine user prompts are the only user-role
	// entries here — never all-[dropped] — making this a safe parity guard.
	if (msg.role !== "assistant") return false;

	if (typeof msg.content === "string")
		return msg.content.trim().length === 0 || isPiMarkerOnlyText(msg.content);
	if (!Array.isArray(msg.content)) return false;
	if (msg.content.length === 0) return false;

	let sawVisibleContent = false;
	for (const part of msg.content) {
		if (!part || typeof part !== "object") return false;
		const p = part as { type?: unknown; text?: unknown; thinking?: unknown };
		const text =
			p.type === "text" ? p.text : p.type === "thinking" ? p.thinking : null;
		if (typeof text !== "string") return false;
		sawVisibleContent = true;
		if (text.trim().length > 0 && !isPiMarkerOnlyText(text)) return false;
	}
	return sawVisibleContent;
}

/**
 * A frozen id records that its message had nothing left to send when it was
 * discovered. That stops holding when the message carries a tool call on this
 * pass: the tool-drop replay keeps some dropped calls on purpose (a
 * real-argument skeleton, a result that ends the request, a model that needs
 * tool pairs beside its reasoning), and a stored drop mode can change after
 * the id was frozen (a HARD fold converting it to a real-argument skeleton).
 */
function ownsToolCall(message: unknown): boolean {
	const content = (message as { content?: unknown } | undefined)?.content;
	return (
		Array.isArray(content) &&
		content.some(
			(part) => (part as { type?: unknown } | undefined)?.type === "toolCall",
		)
	);
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
	/**
	 * Carried stable-id map keyed by message object reference, built by the caller
	 * POST-commit / PRE-injection (see context-handler). This runs AFTER
	 * injectM0M1Pi splices the array, so positional index→id is stale; object
	 * identity survives the splice. Skip-on-miss: the only legitimate misses are
	 * injection's synthetic m[0]/m[1] prepends (never placeholders).
	 */
	stableIdByRef?: ReadonlyMap<object, string>;
	/**
	 * Force placeholder rediscovery regardless of isCacheBusting. Set on the
	 * stable-id-scheme cutover pass so previously-stripped placeholders get
	 * re-keyed under the new scheme (discovery is otherwise history-refresh-gated).
	 */
	forceDiscovery?: boolean;
	/**
	 * True when this pass already changes the served prefix (a HARD fold, first
	 * render, explicit flush, published history or forced materialization).
	 * Frozen ids whose message owns a tool call are dropped from the persisted
	 * set only on such a pass, so the stored set changes only when the request
	 * bytes are changing anyway.
	 */
	canFirstApply?: boolean;
	/** Test seam for exhausting the durable CAS write. */
	applyDelta?: typeof applyStrippedPlaceholderDelta;
	/** Called only for newly persisted removals, before the message is spliced. */
	onFirstApplication?: (message: unknown, index: number) => void;
	/**
	 * Asked before a newly found placeholder-only message is added to the stored
	 * removal list. False keeps the message in the request and off that list, so a
	 * later discovery pass finds it again. Removing messages already on the list
	 * never asks, and neither does re-keying a message that the list already holds
	 * under its id from before a message-id scheme change (see `legacyIdByRef`).
	 */
	admit?: (message: unknown, index: number) => boolean;
	/**
	 * Older sessions stored removed placeholders under positional ids
	 * (`pi-msg-<index>-...`); newer ones use session entry ids. This map gives each
	 * message's positional id, keyed by object reference like `stableIdByRef`. On the
	 * pass that switches a session to entry ids (`forceDiscovery`), a placeholder
	 * whose positional id is already on the stored removal list was removed from
	 * every earlier request, so storing it again under its entry id and removing it
	 * leaves the request as it was sent. Any other placeholder found on that pass
	 * would be a new removal, so it asks `admit`. Without this map the positional id
	 * is computed from the message's current index.
	 */
	legacyIdByRef?: ReadonlyMap<object, string>;
}): StripPiDroppedPlaceholderResult {
	const { db, sessionId, messages, isCacheBusting, stableIdByRef } = args;
	const persistedIds = getStrippedPlaceholderIds(db, sessionId);
	const idsToStrip = new Set(persistedIds);

	const idOf = (msg: unknown, index: number): string | undefined => {
		const m = msg && typeof msg === "object" ? (msg as object) : undefined;
		const carried = m ? stableIdByRef?.get(m) : undefined;
		if (typeof carried === "string" && carried.length > 0) return carried;
		if (stableIdByRef) return undefined;
		return resolvePiStableId(msg, index);
	};

	const canPrune =
		(isCacheBusting || args.forceDiscovery === true) && !!stableIdByRef;
	const presentIds = canPrune ? new Set<string>() : null;
	const legacyIdOf = (msg: unknown, index: number): string | undefined => {
		const m = msg && typeof msg === "object" ? (msg as object) : undefined;
		return (
			(m ? args.legacyIdByRef?.get(m) : undefined) ??
			resolvePiStableId(msg, index)
		);
	};
	const discoveredIds: string[] = [];
	// Placeholders stored again under their entry id were already absent from earlier
	// requests, so removing them is not a new edit and is not reported as one.
	const rekeyedIds = new Set<string>();
	if (isCacheBusting || args.forceDiscovery) {
		for (let i = 0; i < messages.length; i++) {
			const id = idOf(messages[i], i);
			if (!id) continue;
			presentIds?.add(id);
			if (!messageIsPlaceholderOnly(messages[i]) || persistedIds.has(id))
				continue;
			const legacyId = args.forceDiscovery
				? legacyIdOf(messages[i], i)
				: undefined;
			if (
				legacyId !== undefined &&
				legacyId !== id &&
				persistedIds.has(legacyId)
			) {
				discoveredIds.push(id);
				rekeyedIds.add(id);
			} else if (args.admit?.(messages[i], i) ?? true) {
				discoveredIds.push(id);
			}
		}
	}

	const removedIds: string[] = [];
	if (presentIds) {
		for (const id of persistedIds) {
			if (!presentIds.has(id)) removedIds.push(id);
		}
	}

	// Frozen ids whose message owns a tool call on this pass. Replay keeps those
	// messages on every pass. A pass that already busts also removes the ids from
	// the persisted set, so a session holding such ids (stored while the call was
	// absent, before its drop mode changed) stops carrying them.
	const toolOwnerIds = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		const id = idOf(messages[i], i);
		if (id && persistedIds.has(id) && ownsToolCall(messages[i]))
			toolOwnerIds.add(id);
	}
	const mayForgetOwners =
		isCacheBusting ||
		args.forceDiscovery === true ||
		args.canFirstApply === true;
	if (mayForgetOwners) {
		for (const id of toolOwnerIds)
			if (!removedIds.includes(id)) removedIds.push(id);
	}

	let discovered = 0;
	let pruned = 0;
	if (discoveredIds.length > 0 || removedIds.length > 0) {
		const persisted = (args.applyDelta ?? applyStrippedPlaceholderDelta)(
			db,
			sessionId,
			{
				add: discoveredIds,
				remove: removedIds,
			},
		);
		if (persisted) {
			// Bytes ship only after their replay state is durable. If the CAS fails,
			// replay the old frozen set and retry discovery on the next busting pass.
			for (const id of discoveredIds) idsToStrip.add(id);
			for (const id of removedIds) idsToStrip.delete(id);
			discovered = discoveredIds.length;
			pruned = removedIds.length;
		} else {
			sessionLog(
				sessionId,
				"placeholder strip: persistence failed; leaving newly discovered messages intact",
			);
		}
	}

	let removed = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const id = idOf(messages[i], i);
		if (!id || !idsToStrip.has(id)) continue;
		if (toolOwnerIds.has(id)) continue;
		if (discovered > 0 && discoveredIds.includes(id) && !rekeyedIds.has(id))
			args.onFirstApplication?.(messages[i], i);
		messages.splice(i, 1);
		removed++;
	}

	if (removed > 0 || discovered > 0 || pruned > 0) {
		sessionLog(
			sessionId,
			`placeholder strip: removed=${removed} discovered=${discovered} pruned=${pruned} keptToolOwners=${toolOwnerIds.size}`,
		);
	}
	return { removed, discovered };
}
