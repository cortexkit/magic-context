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
 * The same persisted IDs also track dropped tool results whose calls are absent
 * from the outgoing messages. Responses/Anthropic request validation rejects
 * Oh My Pi's conversion of those results into user text, so remove them before
 * conversion. Chat validation accepts the exact placeholder note; defer its
 * removal until another change already invalidates the provider's cached prefix.
 *
 * A frozen id never removes a message that owns a tool call or its paired
 * result, nor a real result explicitly restored by ctx_expand. Pi sends every
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
import { isMarkerOnlyText as isPiMarkerOnlyText } from "@magic-context/core/shared/marker-only-text";
import { resolvePiStableId } from "./read-session-pi";

export { isMarkerOnlyText as isPiMarkerOnlyText } from "@magic-context/core/shared/marker-only-text";

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

function toolCallIds(messages: readonly unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		const msg = message as { role?: unknown; content?: unknown } | undefined;
		if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (part?.type === "toolCall" && typeof part.id === "string") {
				ids.add(part.id);
				// Responses may store the same call with or without its item-id suffix.
				ids.add(part.id.split("|")[0]);
			}
		}
	}
	return ids;
}

function isPairedResult(message: unknown, calls: ReadonlySet<string>): boolean {
	const msg = message as { role?: unknown; toolCallId?: unknown } | undefined;
	return (
		msg?.role === "toolResult" &&
		typeof msg.toolCallId === "string" &&
		(calls.has(msg.toolCallId) || calls.has(msg.toolCallId.split("|")[0]))
	);
}

function isDroppedResult(message: unknown): boolean {
	const msg = message as
		| { role?: unknown; toolCallId?: unknown; content?: unknown }
		| undefined;
	if (
		msg?.role !== "toolResult" ||
		typeof msg.toolCallId !== "string" ||
		!Array.isArray(msg.content) ||
		msg.content.length !== 1
	)
		return false;
	const part = msg.content[0];
	return (
		part?.type === "text" &&
		typeof part.text === "string" &&
		/^(?:§\d+§ )?\[dropped §\d+§\]$/.test(part.text)
	);
}

export interface StripPiDroppedPlaceholderResult {
	removed: number;
	discovered: number;
}

export interface PiOrphanToolDropFacts {
	active: boolean;
	legacyDroppedTag?: number;
}

/** Resolve only this orphan's call ID through the existing session/message index. */
export function readPiOrphanToolDropFacts(
	db: ContextDatabase,
	sessionId: string,
	callId: string,
): PiOrphanToolDropFacts {
	const row = db
		.prepare(
			`SELECT MAX(status = 'active') AS active,
			        MAX(CASE WHEN status = 'dropped' AND drop_mode = 'truncated'
			                 THEN tag_number END) AS legacyTag
			 FROM tags INDEXED BY idx_tags_session_message_id
			 WHERE session_id = ? AND message_id = ? AND type = 'tool'`,
		)
		.get(sessionId, callId) as
		| { active: number | null; legacyTag: number | null }
		| undefined;
	return {
		active: row?.active === 1,
		legacyDroppedTag: row?.legacyTag ?? undefined,
	};
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
	/** Remove dropped results with absent calls before Responses/Anthropic rejects their conversion to user messages. */
	retireOrphansBeforeRefusal?: boolean;
	/** Called only for an orphan call ID, at most once per pass; defaults to indexed storage lookup. */
	getToolDropFacts?: (callId: string) => PiOrphanToolDropFacts;
	/** Transfer the result entry's stable session-entry ID to its replacement object. */
	onLegacyReplay?: (previous: object, next: object) => void;
	/** Test seam for exhausting the durable CAS write. */
	applyDelta?: typeof applyStrippedPlaceholderDelta;
	/** Called only for newly persisted removals, before the message is spliced. */
	onFirstApplication?: (message: unknown, index: number) => void;
}): StripPiDroppedPlaceholderResult {
	const { db, sessionId, messages, isCacheBusting, stableIdByRef } = args;
	const persistedIds = getStrippedPlaceholderIds(db, sessionId);
	const idsToStrip = new Set(persistedIds);
	const calls = toolCallIds(messages);
	let toolFacts: Map<string, PiOrphanToolDropFacts> | undefined;
	const factsFor = (message: unknown): PiOrphanToolDropFacts | undefined => {
		const msg = message as { role?: unknown; toolCallId?: unknown } | undefined;
		if (
			msg?.role !== "toolResult" ||
			typeof msg.toolCallId !== "string" ||
			isPairedResult(msg, calls)
		)
			return undefined;
		// Results with a surviving call need no toolFacts cache or stored drop-status lookup.
		toolFacts ??= new Map();
		let facts = toolFacts.get(msg.toolCallId);
		if (!facts) {
			facts = args.getToolDropFacts
				? args.getToolDropFacts(msg.toolCallId)
				: readPiOrphanToolDropFacts(db, sessionId, msg.toolCallId);
			toolFacts.set(msg.toolCallId, facts);
		}
		return facts;
	};

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
	const discoveredIds: string[] = [];
	const isActiveRealResult = (message: unknown): boolean => {
		const msg = message as { role?: unknown; toolCallId?: unknown } | undefined;
		return (
			msg?.role === "toolResult" &&
			typeof msg.toolCallId === "string" &&
			!isDroppedResult(message) &&
			factsFor(message)?.active === true
		);
	};
	const isRetiredResult = (message: unknown): boolean => {
		const msg = message as { role?: unknown; toolCallId?: unknown } | undefined;
		return (
			msg?.role === "toolResult" &&
			typeof msg.toolCallId === "string" &&
			!isActiveRealResult(message) &&
			(isDroppedResult(message) ||
				factsFor(message)?.legacyDroppedTag !== undefined)
		);
	};
	const discoverOrphans =
		args.canFirstApply === true ||
		isCacheBusting ||
		args.retireOrphansBeforeRefusal === true;
	// The shared tag replay leaves results unchanged when their calls are absent.
	// For Chat, restore their old dropped placeholders so repeated requests keep
	// the same bytes until another change invalidates the provider's cached prefix.
	// Only stored dropped/truncated tags qualify; active results are never replaced.
	if (!discoverOrphans) {
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i] as {
				role?: unknown;
				toolCallId?: unknown;
				content?: unknown;
			};
			if (
				msg?.role !== "toolResult" ||
				typeof msg.toolCallId !== "string" ||
				!Array.isArray(msg.content) ||
				isPairedResult(msg, calls) ||
				isActiveRealResult(msg) ||
				idsToStrip.has(idOf(msg, i) ?? "")
			)
				continue;
			const tag = factsFor(msg)?.legacyDroppedTag;
			if (tag === undefined) continue;
			const text = `[dropped §${tag}§]`;
			messages[i] = {
				...msg,
				content: msg.content.map((part) =>
					part?.type === "text" ? { ...part, text } : { type: "text", text },
				),
			};
			args.onLegacyReplay?.(msg, messages[i] as object);
		}
	}
	if (isCacheBusting || args.forceDiscovery || discoverOrphans) {
		for (let i = 0; i < messages.length; i++) {
			const id = idOf(messages[i], i);
			if (!id) continue;
			presentIds?.add(id);
			if (
				!persistedIds.has(id) &&
				(((isCacheBusting || args.forceDiscovery) &&
					messageIsPlaceholderOnly(messages[i])) ||
					(discoverOrphans &&
						!isPairedResult(messages[i], calls) &&
						isRetiredResult(messages[i])))
			) {
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

	// Keep assistant call owners, results with a surviving call, and real output
	// restored by the ctx_expand tool. Forget their previously persisted removal IDs
	// only when another change already invalidates the provider's cached prefix.
	const protectedIds = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		const id = idOf(messages[i], i);
		if (
			id &&
			persistedIds.has(id) &&
			(ownsToolCall(messages[i]) ||
				isPairedResult(messages[i], calls) ||
				isActiveRealResult(messages[i]))
		)
			protectedIds.add(id);
	}
	const mayForgetOwners =
		isCacheBusting ||
		args.forceDiscovery === true ||
		args.canFirstApply === true;
	if (mayForgetOwners) {
		for (const id of protectedIds)
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
		if (protectedIds.has(id)) continue;
		if (discovered > 0 && discoveredIds.includes(id))
			args.onFirstApplication?.(messages[i], i);
		messages.splice(i, 1);
		removed++;
	}

	if (removed > 0 || discovered > 0 || pruned > 0) {
		sessionLog(
			sessionId,
			`placeholder strip: removed=${removed} discovered=${discovered} pruned=${pruned} keptToolOwners=${protectedIds.size}`,
		);
	}
	return { removed, discovered };
}
