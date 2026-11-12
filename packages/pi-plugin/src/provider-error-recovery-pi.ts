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
import { EmergencyFailClosedError } from "@magic-context/core/hooks/magic-context/emergency-fail-closed";
import { latestAssistantTurnMessages } from "@magic-context/core/hooks/magic-context/latest-assistant-turn";
import {
	armBindingRecoverySafely,
	armLatestThinkingRecovery,
	LATEST_THINKING_RESTORE,
	latestThinkingRestoringTurnMessages,
} from "@magic-context/core/hooks/magic-context/latest-thinking-recovery";
import { dropSlot } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { isAnthropicFamilyRoute } from "@magic-context/core/hooks/magic-context/sentinel";
import { getHarness } from "@magic-context/core/shared/harness";
import { log } from "@magic-context/core/shared/logger";
import { resetPiUpperEstimateReclaim } from "./pi-fit-reclaim";
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
		armLatestThinkingRecovery(args.db, args.sessionId, model);
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
	// Unlike a metadata over-count, a provider rejection proves a capacity issue.
	// Clear the saved repeat-reclaim suppression so recovery can run again after
	// a restart, even when the session's content has not changed.
	if (getHarness() === "pi") {
		try {
			resetPiUpperEstimateReclaim(args.db, args.sessionId);
		} catch (error) {
			args.report?.(`upper-estimate reclaim reset deferred: ${String(error)}`);
		}
	}
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

export class PiThinkingBindingRecoveryRefusal extends EmergencyFailClosedError {
	constructor() {
		super(
			"Pi thinking-binding recovery has no valid new strip shape; this turn was not sent. Send a new message or start a new session.",
			{ code: "pi_thinking_binding_no_valid_shape" },
		);
		this.name = "PiThinkingBindingRecoveryRefusal";
	}
}

/**
 * Apply an armed thinking-binding recovery and replay earlier ones.
 *
 * An armed flag strips every signed block, including the active assistant turn:
 * keeping a later signature after removing older thinking invalidates its prefix.
 * The frozen set is persisted before bytes change and replays on later passes.
 * Once that shape has been rejected there is nothing left to strip; refuse rather
 * than send the same rejected request again. A separate latest-thinking recovery
 * handles providers that require the original thinking in a live tool loop.
 */
export function applyPiThinkingBindingRecovery(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	entryIds: readonly (string | undefined)[];
	provider?: string;
	model?: string;
	report?: (message: string) => void;
	/** Replay saved omissions without consuming a new provider-rejection flag. */
	replayOnly?: boolean;
	/**
	 * The session strips thinking after the pipeline stages ran (see
	 * resolvePiBindingStripOrder). New entries are then written together with
	 * THINKING_BINDING_STRIP_ORDER_END_MARKER, so later passes keep stripping
	 * after the stages instead of reverting to stripping before them.
	 */
	endOfPassOrder?: boolean;
}): PiThinkingBindingApplication | null {
	const frozenEntryIds = frozenBindingEntryIds(args.db, args.sessionId);

	const flagTargetCandidate =
		!args.replayOnly && isPrefixBoundThinkingModel(args.provider, args.model)
			? getThinkingBindingRecoveryTarget(args.db, args.sessionId)
			: null;
	const flagTarget = flagTargetCandidate?.startsWith(LATEST_THINKING_RESTORE)
		? null
		: flagTargetCandidate;
	let applied: PiThinkingBindingApplication | null = null;
	if (flagTarget) {
		const entryIds = new Set<string>();
		for (let index = 0; index < args.messages.length; index += 1) {
			if (!hasThinkingPart(args.messages[index])) continue;
			const entryId = args.entryIds[index];
			if (!entryId) throw new PiThinkingBindingRecoveryRefusal();
			entryIds.add(entryId);
		}
		const newEntryIds = [...entryIds].filter((id) => !frozenEntryIds.has(id));
		if (newEntryIds.length === 0) throw new PiThinkingBindingRecoveryRefusal();
		if (
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
		} else throw new PiThinkingBindingRecoveryRefusal();
	}

	// A provider rejection whose recovery restores a turn's original thinking
	// asks for that thinking back. Replaying the turn's frozen omissions here
	// would delete the original before recovery checks it (start of pass) or
	// after it restored it (end of pass), resending the rejected bytes. Older
	// turns stay omitted, and so does a turn whose thinking recovery removed.
	const restoringTurn = latestThinkingRestoringTurnMessages({
		db: args.db,
		sessionId: args.sessionId,
		messages: args.messages,
		id: (message, index) => resolvePiStableId(message, index, args.entryIds),
	});
	for (let index = 0; index < args.messages.length; index += 1) {
		if (restoringTurn?.has(args.messages[index])) continue;
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

/** Previously recorded omissions are replay, not a new reason to rewrite a saved request. */
export function hasUnfrozenPiThinking(args: {
	messages: readonly unknown[];
	entryIds: readonly (string | undefined)[];
	frozen: ReadonlySet<string>;
	provider?: string;
	model?: string;
}): boolean {
	return (
		isPrefixBoundThinkingModel(args.provider, args.model) &&
		args.messages.some((message, index) => {
			const entryId = args.entryIds[index];
			return (
				hasThinkingPart(message) && (!entryId || !args.frozen.has(entryId))
			);
		})
	);
}

/**
 * Persist and replay thinking omissions when a prefix-bound model's prompt changes.
 *
 * Fable 5.1, Opus 5.5 and Sonnet 5.5 signatures bind every preceding byte.
 * Changing those bytes can make the provider discard thinking or reject the
 * request. Held passes keep all blocks and defer edits before them. A caller
 * that authorizes such an edit sets `stripActiveTurn` to omit every block,
 * including the active turn, rather than send invalid signatures.
 *
 * Record stable entry IDs before removing parts. Later passes replay the same
 * omissions after transcript commit, so raw history cannot restore a removed
 * block or change the rendered drop shape. `persistOnly` records this decision
 * before the pipeline edits the transcript; otherwise `messages` is its final
 * output. Entries without stable IDs and failed writes leave thinking intact.
 * Provider-error recovery can handle a rejected request separately.
 *
 * `cacheBustingPass` requires the shared prefix-edit permission; neither idle
 * expiry nor a scheduler label alone authorizes edits before kept thinking.
 */
export function applyPiProactiveThinkingStrip(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	entryIds: readonly (string | undefined)[];
	provider?: string;
	model?: string;
	cacheBustingPass: boolean;
	/** Omit the active turn when m[0]/m[1] or preceding transcript bytes must change; idle expiry alone is insufficient. */
	stripActiveTurn?: boolean;
	/** Record omissions now; remove parts after transcript commit so replay uses the same part indices. */
	persistOnly?: boolean;
	/** A declared rebuild must refuse if any thinking omission cannot be persisted. */
	requirePersistence?: boolean;
	report?: (message: string) => void;
}): PiProactiveThinkingStrip | null {
	if (!args.cacheBustingPass) return null;
	if (!isPrefixBoundThinkingModel(args.provider, args.model)) return null;
	const protectedMessages = args.stripActiveTurn
		? new Set()
		: latestAssistantTurnMessages(args.messages);
	const entryIds: string[] = [];
	const indices: number[] = [];
	for (let index = 0; index < args.messages.length; index += 1) {
		if (protectedMessages.has(args.messages[index])) continue;
		const entryId = args.entryIds[index];
		if (!hasThinkingPart(args.messages[index])) continue;
		if (!entryId) {
			if (args.requirePersistence)
				throw new Error(
					"Cannot persist thinking omission without a stable entry id",
				);
			continue;
		}
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
		if (args.requirePersistence)
			throw new Error(
				"Cannot persist thinking omissions before recovery prefix rebuild",
			);
		reportBindingRecovery(
			args.sessionId,
			args.report,
			"proactive thinking strip: persistence failed; serving the thinking unchanged",
		);
		return null;
	}
	if (!args.persistOnly)
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
 * Persist the latest-turn thinking removal (the second remedy of
 * `prepareLatestThinkingRecovery`) into the binding-mismatch set, keeping the
 * point in the pass where this session replays that set (see
 * resolvePiBindingStripOrder). A session with no strips yet, or already in the
 * end order, replays at the end of this pass; the end-order marker is written
 * with the ids, so later passes keep that order. A session still in the start
 * order already ran this pass's start-of-pass replay, so the caller removes
 * the turn's thinking itself (`stripNow`) before any stage runs, where every
 * later pass of that session replays it.
 */
export function persistPiLatestTurnThinkingRemoval(
	db: ContextDatabase,
	sessionId: string,
	entryIds: readonly string[],
): { persisted: boolean; stripNow: boolean } {
	const endOrder =
		getMergedReasoningStrippedIds(db, sessionId).has(
			THINKING_BINDING_STRIP_ORDER_END_MARKER,
		) || frozenBindingEntryIds(db, sessionId).size === 0;
	const persisted = addMergedReasoningStrippedIds(db, sessionId, [
		...entryIds.map(thinkingBindingRecoveryFrozenId),
		...(endOrder ? [THINKING_BINDING_STRIP_ORDER_END_MARKER] : []),
	]);
	return { persisted, stripNow: persisted && !endOrder };
}

/**
 * Whether this session replays its binding-mismatch strips at the start of
 * the context pass, before any stage (strips saved by earlier builds without
 * the end-order marker; see resolvePiBindingStripOrder).
 */
export function piBindingStripsAtStart(
	db: ContextDatabase,
	sessionId: string,
): boolean {
	return (
		!getMergedReasoningStrippedIds(db, sessionId).has(
			THINKING_BINDING_STRIP_ORDER_END_MARKER,
		) && frozenBindingEntryIds(db, sessionId).size > 0
	);
}

/** Remove the thinking of the messages whose stable id is in `ids`. */
export function stripPiThinkingOfIds(
	messages: readonly unknown[],
	ids: ReadonlySet<string>,
	resolveId: (message: unknown, index: number) => string | undefined,
): number {
	let stripped = 0;
	for (let index = 0; index < messages.length; index += 1) {
		const id = resolveId(messages[index], index);
		if (id && ids.has(id)) stripped += stripThinkingParts(messages[index]);
	}
	return stripped;
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
 *
 * A pass that releases every signed block (its request tools changed) is served
 * in the end order without recording the switch here: the caller records it
 * with recordPiBindingStripEndOrder once the pass has succeeded, so a release
 * pass that fails leaves a start-order session in the start order.
 */
export function resolvePiBindingStripOrder(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: readonly unknown[];
	entryIds: readonly (string | undefined)[];
	/** Known before any stage runs: this pass is allowed to change served bytes. */
	bustPermittedAtStart: boolean;
	/**
	 * This pass strips every signed block (its request tools changed), so it
	 * rewrites everything the order could affect and may switch whatever the
	 * branch carries.
	 */
	releasesAllThinking?: boolean;
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
	if (
		onBranch &&
		carriesThinking &&
		args.bustPermittedAtStart &&
		addMergedReasoningStrippedIds(args.db, args.sessionId, [
			THINKING_BINDING_STRIP_ORDER_END_MARKER,
		])
	) {
		return "end";
	}
	return args.releasesAllThinking === true ? "end" : "start";
}

/**
 * Record that the session strips in the end order, after a release pass that
 * resolvePiBindingStripOrder served in that order has succeeded. True when the
 * session already uses the end order or the marker was written; false when the
 * write failed, in which case the caller must not record the release as done,
 * so the next pass releases (and switches) again.
 */
export function recordPiBindingStripEndOrder(
	db: ContextDatabase,
	sessionId: string,
): boolean {
	try {
		const ledger = getMergedReasoningStrippedIds(db, sessionId);
		if (ledger.has(THINKING_BINDING_STRIP_ORDER_END_MARKER)) return true;
		if (frozenBindingEntryIds(db, sessionId).size === 0) return true;
		return addMergedReasoningStrippedIds(db, sessionId, [
			THINKING_BINDING_STRIP_ORDER_END_MARKER,
		]);
	} catch {
		return false;
	}
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
