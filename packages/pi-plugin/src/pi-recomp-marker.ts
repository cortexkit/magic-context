import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	type ContextDatabase,
	clearPendingPiCompactionMarkerStateIf,
	setPendingPiCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage";
import {
	adaptPiAppendCompaction,
	applyDeferredPiCompactionMarker,
} from "./compaction-marker-manager-pi";
import { signalPiDeferredHistoryRefresh } from "./context-handler";
import {
	buildPiCompactionSummary,
	findFirstKeptEntryId,
} from "./pi-historian-runner";
import {
	isPiOrdinalAlignmentUnanchored,
	resolvePiOrdinalAlignment,
} from "./pi-ordinal-alignment";

/**
 * The first kept entry after stored ordinal `lastCompactedOrdinal`, or null
 * (stage nothing) while the stored ordinals cannot be placed on this branch.
 */
function placeFirstKeptEntryId(
	db: ContextDatabase,
	sessionId: string,
	branchEntries: readonly unknown[],
	lastCompactedOrdinal: number,
): string | null {
	const alignment = resolvePiOrdinalAlignment(db, sessionId, branchEntries);
	if (isPiOrdinalAlignmentUnanchored(alignment)) return null;
	return findFirstKeptEntryId(
		branchEntries,
		lastCompactedOrdinal,
		alignment.offset,
	);
}

/**
 * Advance the Pi native compaction marker to the latest compartment boundary
 * after a recomp republish, so `getBranch()` returns only the kept tail and the
 * JSONL branch actually trims.
 *
 * A full recomp rebuilds every compartment; without this call it republished
 * compartments but never moved the native marker, so the entire pre-recomp
 * branch stayed visible and grew unbounded until a later incremental historian
 * pass happened to advance it. (The m[0]/m[1] materialization signals a recomp
 * already fires drive the synthetic `<session-history>` render — NOT the native
 * marker that trims `getBranch()`; those are separate mechanisms.)
 *
 * No-ops safely when the Pi session manager exposes neither appendCompaction nor
 * getBranch, when there is no compartment yet, or when no real replay-safe
 * entry exists at or after the boundary (so we never stage an unmatchable
 * synthetic marker).
 */
/**
 * Stage the Pi compaction marker WITHOUT applying it, then signal a deferred
 * history refresh so the next cache-busting transform pass drains and applies it
 * via the pipeline's deferred-marker path.
 *
 * Used by detached recomp and upgrade runs: applying the marker eagerly
 * (`appendCompaction`) mutates `getBranch()` immediately and could alter a
 * cache-stable pass. Staging + deferred drain mirrors the background historian's
 * `onPublished` signals so the marker rides the next genuine bust. No-ops safely
 * when the boundary has no
 * replay-safe entry at or after it (same guards as the eager path).
 */
export function stagePiRecompMarker(args: {
	db: ContextDatabase;
	sessionId: string;
	branchEntries: readonly unknown[];
}): void {
	const compartments = getCompartments(args.db, args.sessionId);
	const last = compartments[compartments.length - 1];
	if (!last) return;

	let firstKeptEntryId: string | null = null;
	try {
		firstKeptEntryId = placeFirstKeptEntryId(
			args.db,
			args.sessionId,
			args.branchEntries,
			last.endMessage,
		);
	} catch {
		firstKeptEntryId = null;
	}
	if (!firstKeptEntryId || last.endMessageId.length === 0) return;

	setPendingPiCompactionMarkerState(args.db, args.sessionId, {
		firstKeptEntryId,
		endMessageId: last.endMessageId,
		ordinal: last.endMessage,
		tokensBefore: 0,
		summary: buildPiCompactionSummary(compartments),
		publishedAt: Date.now(),
	});
	signalPiDeferredHistoryRefresh(args.sessionId);
}

/**
 * EAGER marker apply — bypasses the rendered-coverage gate that the pipeline's
 * deferred drain enforces (pendingPiMarkerCoveredByRenderedBoundary). Safe ONLY
 * in a context where a recomp has JUST republished the compartments:
 * recomp writes the m[0] mutation log, so the next transform pass HARD-folds
 * m[0] over the republished compartments and the model is shown everything the
 * marker trims in that same busting pass. Calling this without that same-pass
 * rendered coverage could trim getBranch() beyond content the model has seen.
 * The live background command (/ctx-recomp) therefore uses the DEFERRED
 * stagePiRecompMarker instead; this eager path is kept for a same-turn caller
 * that owns the rendered-coverage precondition itself.
 */
export function queueAndApplyPiRecompMarker(args: {
	db: ContextDatabase;
	sessionId: string;
	ctx: unknown;
}): void {
	const appendCompaction = resolvePiAppendCompaction(args.ctx);
	const readBranchEntries = resolvePiReadBranchEntries(args.ctx);
	if (!appendCompaction || !readBranchEntries) return;

	const compartments = getCompartments(args.db, args.sessionId);
	const last = compartments[compartments.length - 1];
	if (!last) return;

	let firstKeptEntryId: string | null = null;
	try {
		firstKeptEntryId = placeFirstKeptEntryId(
			args.db,
			args.sessionId,
			readBranchEntries(),
			last.endMessage,
		);
	} catch {
		firstKeptEntryId = null;
	}
	if (!firstKeptEntryId || last.endMessageId.length === 0) return;

	const pending = {
		firstKeptEntryId,
		endMessageId: last.endMessageId,
		ordinal: last.endMessage,
		tokensBefore: 0,
		summary: buildPiCompactionSummary(compartments),
		publishedAt: Date.now(),
	};

	setPendingPiCompactionMarkerState(args.db, args.sessionId, pending);
	const outcome = applyDeferredPiCompactionMarker(
		{ db: args.db, appendCompaction, readBranchEntries },
		args.sessionId,
		pending,
	);
	if (outcome.kind === "retryable-failure") {
		signalPiDeferredHistoryRefresh(args.sessionId);
		return;
	}
	if (
		!clearPendingPiCompactionMarkerStateIf(
			args.db,
			args.sessionId,
			pending,
			outcome.kind === "stale-skip" ? outcome.reason : outcome.kind,
		)
	) {
		signalPiDeferredHistoryRefresh(args.sessionId);
	}
}

function resolvePiAppendCompaction(
	ctx: unknown,
):
	| ((
			summary: string,
			firstKeptEntryId: string,
			tokensBefore: number,
			details?: unknown,
			fromHook?: boolean,
	  ) => string | undefined)
	| undefined {
	const sm = (ctx as { sessionManager?: unknown })?.sessionManager as
		| {
				appendCompaction?: (
					summary: string,
					firstKeptEntryId: string,
					tokensBefore: number,
					details?: unknown,
					fromHook?: boolean,
				) => string | undefined;
		  }
		| undefined;
	if (typeof sm?.appendCompaction !== "function") return undefined;
	return adaptPiAppendCompaction(sm.appendCompaction.bind(sm));
}

function resolvePiReadBranchEntries(
	ctx: unknown,
): (() => unknown[]) | undefined {
	const sm = (ctx as { sessionManager?: unknown })?.sessionManager as
		| { getBranch?: () => unknown[] }
		| undefined;
	if (typeof sm?.getBranch !== "function") return undefined;
	return () => {
		try {
			const entries = sm.getBranch?.call(sm);
			return Array.isArray(entries) ? entries : [];
		} catch {
			return [];
		}
	};
}
