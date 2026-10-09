import {
	detectLatestTurnThinkingMismatch,
	detectOverflow,
	detectThinkingBindingMismatch,
	isPrefixBoundThinkingModel,
} from "@magic-context/core/features/magic-context/overflow-detection";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	addMergedReasoningStrippedIds,
	getMergedReasoningStrippedIds,
	getThinkingBindingRecoveryTarget,
	recordOverflowDetected,
	THINKING_BINDING_RECOVERY_FROZEN_PREFIX,
	THINKING_BINDING_STRIP_ORDER_END_MARKER,
	thinkingBindingRecoveryFrozenId,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { latestAssistantTurnMessages } from "@magic-context/core/hooks/magic-context/latest-assistant-turn";
import {
	armBindingRecoverySafely,
	armLatestThinkingRecovery,
	LATEST_THINKING_RESTORE,
	latestThinkingRecoveryCoversActiveTurn,
} from "@magic-context/core/hooks/magic-context/latest-thinking-recovery";
import { dropSlot } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { isAnthropicFamilyRoute } from "@magic-context/core/hooks/magic-context/sentinel";
import { log } from "@magic-context/core/shared/logger";

import { clearPiLkgSessionState } from "./pi-lkg";
import { resolvePiStableId } from "./read-session-pi";

function reportBindingRecovery(
	sessionId: string,
	report: ((message: string) => void) | undefined,
	message: string,
): void {
	if (report) report(message);
	else log(`[magic-context][${sessionId}] ${message}`);
}

export type PiProviderFailureResult =
	| { kind: "none" }
	| { kind: "thinking_binding"; armed: boolean }
	| {
			kind: "overflow";
			reportedLimit?: number;
			reportedLimitProvenance?: string;
			matchedPattern?: string;
	  };

/** Persist recovery state from Pi's assistant `message_end` error payload. */
export function handlePiProviderFailure(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	compactionOff?: boolean;
	thinkingBindingRecoveryEnabled?: boolean;
	report?: (message: string) => void;
}): PiProviderFailureResult {
	if (!args.message || typeof args.message !== "object")
		return { kind: "none" };
	const message = args.message as {
		role?: unknown;
		errorMessage?: unknown;
		provider?: unknown;
		model?: unknown;
	};
	if (
		message.role !== "assistant" ||
		typeof message.errorMessage !== "string" ||
		message.errorMessage.length === 0
	) {
		return { kind: "none" };
	}

	const provider =
		typeof message.provider === "string" ? message.provider : undefined;
	const model = typeof message.model === "string" ? message.model : undefined;
	const binding = detectThinkingBindingMismatch(message.errorMessage);
	if (
		detectLatestTurnThinkingMismatch(message.errorMessage) &&
		!args.compactionOff &&
		isAnthropicFamilyRoute(provider, model)
	) {
		armLatestThinkingRecovery(args.db, args.sessionId);
		clearPiLkgSessionState(args.sessionId);
		dropSlot(args.sessionId, "latest-thinking-recovery-arm");
		return { kind: "thinking_binding", armed: true };
	}
	if (binding.isBindingMismatch) {
		const enabled =
			args.thinkingBindingRecoveryEnabled !== false &&
			!args.compactionOff &&
			isPrefixBoundThinkingModel(provider, model);
		if (enabled) {
			// The 400 names only provider request-array paths. The next context
			// pass maps the flag onto stable branch entry ids and strips thinking
			// from every assistant that still carries it.
			armBindingRecoverySafely(args.db, args.sessionId);
			clearPiLkgSessionState(args.sessionId);
			dropSlot(args.sessionId, "thinking-binding-recovery-arm");
			reportBindingRecovery(
				args.sessionId,
				args.report,
				`thinking-binding recovery armed from message_end (provider paths: failing=${binding.failingBlockPath ?? "?"} firstChanged=${binding.firstChangedPath ?? "?"})`,
			);
		}
		return { kind: "thinking_binding", armed: enabled };
	}

	if (args.compactionOff) return { kind: "none" };
	const overflow = detectOverflow(message.errorMessage);
	if (!overflow.isOverflow) return { kind: "none" };
	const modelKey = provider && model ? `${provider}/${model}` : undefined;
	recordOverflowDetected(
		args.db,
		args.sessionId,
		overflow.reportedLimit,
		modelKey,
		"provider_overflow",
		overflow.reportedLimitProvenance,
		overflow.reportedInputTokens,
	);
	return {
		kind: "overflow",
		...(overflow.reportedLimit !== undefined
			? { reportedLimit: overflow.reportedLimit }
			: {}),
		...(overflow.reportedLimitProvenance !== undefined
			? { reportedLimitProvenance: overflow.reportedLimitProvenance }
			: {}),
		...(overflow.matchedPattern !== undefined
			? { matchedPattern: overflow.matchedPattern }
			: {}),
	};
}

interface PiThinkingPart {
	type?: unknown;
}

interface PiAssistantMessage {
	role?: unknown;
	content?: unknown;
}

function hasThinkingPart(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const assistant = message as PiAssistantMessage;
	return (
		assistant.role === "assistant" &&
		Array.isArray(assistant.content) &&
		assistant.content.some((part) => {
			if (!part || typeof part !== "object") return false;
			const type = (part as PiThinkingPart).type;
			return (
				type === "thinking" ||
				type === "redactedThinking" ||
				type === "redacted_thinking"
			);
		})
	);
}

function stripThinkingParts(message: unknown): number {
	if (!message || typeof message !== "object") return 0;
	const assistant = message as PiAssistantMessage;
	const content = assistant.content;
	if (assistant.role !== "assistant" || !Array.isArray(content)) return 0;
	const before = content.length;
	const strippedContent = content.filter((part) => {
		if (!part || typeof part !== "object") return true;
		const type = (part as PiThinkingPart).type;
		return (
			type !== "thinking" &&
			type !== "redactedThinking" &&
			type !== "redacted_thinking"
		);
	});
	assistant.content = strippedContent;
	return before - strippedContent.length;
}

export interface PiThinkingBindingApplication {
	/** The flag value read, so the caller clears only that value. */
	flagTarget: string;
	/** Every branch entry whose thinking this pass removes. */
	entryIds: string[];
}

/**
 * Apply an armed thinking-binding recovery and replay earlier ones.
 *
 * An armed flag freezes completed assistant entries that still carry thinking.
 * The entire active assistant turn is excluded across tool results: its signed
 * blocks must stay exactly as returned. The frozen set is persisted before
 * bytes change and replays on every later pass, so a removed block never comes
 * back; thinking in the current tool loop stays until a real user turn ends it.
 */
export function applyPiThinkingBindingRecovery(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	entryIds: readonly (string | undefined)[];
	provider?: string;
	model?: string;
	report?: (message: string) => void;
	/**
	 * The session strips thinking after the pipeline stages ran (see
	 * resolvePiBindingStripOrder). New entries are then written together with
	 * THINKING_BINDING_STRIP_ORDER_END_MARKER, so later passes keep stripping
	 * after the stages instead of reverting to stripping before them.
	 */
	endOfPassOrder?: boolean;
}): PiThinkingBindingApplication | null {
	const protectedMessages = latestAssistantTurnMessages(args.messages);
	const frozenEntryIds = frozenBindingEntryIds(args.db, args.sessionId);

	const flagTargetCandidate = isPrefixBoundThinkingModel(
		args.provider,
		args.model,
	)
		? getThinkingBindingRecoveryTarget(args.db, args.sessionId)
		: null;
	const flagTarget = flagTargetCandidate?.startsWith(LATEST_THINKING_RESTORE)
		? null
		: flagTargetCandidate;
	let applied: PiThinkingBindingApplication | null = null;
	if (flagTarget) {
		const entryIds = new Set<string>();
		for (let index = 0; index < args.messages.length; index += 1) {
			if (protectedMessages.has(args.messages[index])) continue;
			const entryId = args.entryIds[index];
			if (entryId && hasThinkingPart(args.messages[index]))
				entryIds.add(entryId);
		}
		const newEntryIds = [...entryIds].filter((id) => !frozenEntryIds.has(id));
		if (
			newEntryIds.length === 0 ||
			addMergedReasoningStrippedIds(args.db, args.sessionId, [
				...newEntryIds.map(thinkingBindingRecoveryFrozenId),
				...(args.endOfPassOrder
					? [THINKING_BINDING_STRIP_ORDER_END_MARKER]
					: []),
			])
		) {
			for (const id of newEntryIds) frozenEntryIds.add(id);
			applied = { flagTarget, entryIds: [...entryIds] };
			reportBindingRecovery(
				args.sessionId,
				args.report,
				`thinking-binding recovery consumed on context pass target=${flagTarget} entries=${applied.entryIds.length} [${applied.entryIds.join(",")}]`,
			);
		}
	}

	// A provider rejection of this turn asks for its original thinking back.
	// Replaying the turn's frozen omissions here would delete that original
	// before recovery checks it (start of pass) or after it restored it (end
	// of pass), resending the rejected bytes. Older turns stay omitted.
	const restoringActiveTurn = latestThinkingRecoveryCoversActiveTurn({
		db: args.db,
		sessionId: args.sessionId,
		messages: args.messages,
		id: (message, index) => resolvePiStableId(message, index, args.entryIds),
	});
	for (let index = 0; index < args.messages.length; index += 1) {
		if (restoringActiveTurn && protectedMessages.has(args.messages[index]))
			continue;
		const entryId = args.entryIds[index];
		if (entryId && frozenEntryIds.has(entryId))
			stripThinkingParts(args.messages[index]);
	}
	return applied;
}

/** Thinking removed by a busting pass because the same pass changed bytes before it. */
export interface PiProactiveThinkingStrip {
	/** Branch entries whose thinking this pass froze into the binding-mismatch set. */
	entryIds: string[];
}

/**
 * Remove every thinking block still on the wire on a busting pass of a
 * prefix-bound model (Fable 5.1, Opus 5.5, Sonnet 5.5).
 *
 * On those models a thinking block is valid only while every byte before it is
 * unchanged, and a busting pass is the pass that changes those bytes: older
 * accounts then drop the blocks silently, `drop_block` drops them, and newer
 * accounts reject the request with a 400. The pass therefore removes all of
 * them itself only outside the active assistant turn. All steps in a tool-use
 * loop are part of that turn; none of its thinking blocks may be removed.
 * Callers must defer prefix edits that would require stripping those blocks.
 *
 * `messages` is the final array this pass serves, after binding-mismatch strips
 * were replayed on it at the end of the pass. The entries are persisted into
 * the binding-mismatch set before anything is stripped, the same contract as
 * the reactive recovery; later passes replay the set at the same point of the
 * pass, so they serve identical bytes, and a removed block never comes back.
 * When the write fails, nothing is stripped and nothing is remembered; the
 * reactive recovery remains the fallback. An entry without a stable id cannot
 * be replayed and is left alone. Thinking produced after this pass is kept
 * until the next busting pass.
 *
 * `cacheBustingPass` must be true only on a pass that already busts the cache;
 * a defer pass never originates a strip.
 */
export function applyPiProactiveThinkingStrip(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	entryIds: readonly (string | undefined)[];
	provider?: string;
	model?: string;
	cacheBustingPass: boolean;
	report?: (message: string) => void;
}): PiProactiveThinkingStrip | null {
	if (!args.cacheBustingPass) return null;
	if (!isPrefixBoundThinkingModel(args.provider, args.model)) return null;
	const protectedMessages = latestAssistantTurnMessages(args.messages);
	const entryIds: string[] = [];
	const indices: number[] = [];
	for (let index = 0; index < args.messages.length; index += 1) {
		if (protectedMessages.has(args.messages[index])) continue;
		const entryId = args.entryIds[index];
		if (!entryId || !hasThinkingPart(args.messages[index])) continue;
		entryIds.push(entryId);
		indices.push(index);
	}
	if (entryIds.length === 0) return null;
	let persisted = false;
	try {
		// The strip runs after the pipeline stages, so the end-order marker is
		// persisted with the entries. Later passes then replay the strip after
		// the stages too, instead of moving it earlier and rendering differently.
		persisted = addMergedReasoningStrippedIds(args.db, args.sessionId, [
			...entryIds.map(thinkingBindingRecoveryFrozenId),
			THINKING_BINDING_STRIP_ORDER_END_MARKER,
		]);
	} catch {
		persisted = false;
	}
	if (!persisted) {
		reportBindingRecovery(
			args.sessionId,
			args.report,
			"proactive thinking strip: persistence failed; serving the thinking unchanged",
		);
		return null;
	}
	for (const index of indices) stripThinkingParts(args.messages[index]);
	reportBindingRecovery(
		args.sessionId,
		args.report,
		`proactive thinking strip: busting pass froze thinking of ${entryIds.length} entr${entryIds.length === 1 ? "y" : "ies"} [${entryIds.join(",")}]`,
	);
	return { entryIds };
}

/** Branch entries whose thinking the binding-mismatch set removes on every pass. */
export function frozenBindingEntryIds(
	db: ContextDatabase,
	sessionId: string,
): Set<string> {
	const ids = new Set<string>();
	for (const entry of getMergedReasoningStrippedIds(db, sessionId)) {
		if (!entry.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX)) continue;
		const entryId = entry.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length);
		if (entryId.length > 0) ids.add(entryId);
	}
	return ids;
}

/**
 * Where this pass replays the binding-mismatch strips.
 *
 * Builds before this one stripped at the start of the context pass, before any
 * stage ran, and a stage's output can depend on whether an assistant carries
 * thinking (a dropped tool arc beside native reasoning renders as a skeleton,
 * without it as a removal). A session that already carries strips therefore
 * keeps the start-of-pass order ("start") until a pass may change served bytes:
 * a pass with a queued explicit flush, which always holds the shared bust
 * permission, writes the end-order marker before it serves and switches. A pass
 * whose stripped entries are all off the branch does not switch: an undo can
 * bring them back on a later defer pass, which must still render them in the
 * start order. A session without strips uses the end order from the start.
 *
 * The proactive strip runs only in the end order, because it is decided on the
 * array the pass serves and must replay at that same point.
 */
export function resolvePiBindingStripOrder(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: readonly unknown[];
	entryIds: readonly (string | undefined)[];
	/** Known before any stage runs: this pass is allowed to change served bytes. */
	bustPermittedAtStart: boolean;
}): "start" | "end" {
	const ledger = getMergedReasoningStrippedIds(args.db, args.sessionId);
	if (ledger.has(THINKING_BINDING_STRIP_ORDER_END_MARKER)) return "end";
	const frozen = frozenBindingEntryIds(args.db, args.sessionId);
	if (frozen.size === 0) return "end";
	let onBranch = false;
	let carriesThinking = false;
	for (let index = 0; index < args.messages.length; index += 1) {
		const entryId = args.entryIds[index];
		if (!entryId || !frozen.has(entryId)) continue;
		onBranch = true;
		if (hasThinkingPart(args.messages[index])) carriesThinking = true;
	}
	// Switch only on a pass that may change bytes and renders the difference
	// itself: stripped entries on the branch that still carry thinking. With
	// them off the branch, or their thinking already gone, both orders render
	// alike now, and switching would move the byte change to a later pass,
	// which could be a defer pass.
	const mayChangeOrder =
		onBranch && carriesThinking && args.bustPermittedAtStart;
	if (
		mayChangeOrder &&
		addMergedReasoningStrippedIds(args.db, args.sessionId, [
			THINKING_BINDING_STRIP_ORDER_END_MARKER,
		])
	) {
		return "end";
	}
	return "start";
}

/**
 * Whether this pass may run the proactive thinking strip. Subagents are
 * included, as in OpenCode: their busting passes invalidate signed blocks
 * exactly as a primary's do.
 */
export function shouldRunPiProactiveThinkingStrip(args: {
	compactionOff: boolean;
	bindingStripOrder: "start" | "end";
	isSubagent: boolean;
}): boolean {
	return !args.compactionOff && args.bindingStripOrder === "end";
}
