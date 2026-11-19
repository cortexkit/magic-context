import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	type ContextDatabase,
	clearPendingPiCompactionMarkerStateIf,
	setPendingPiCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage";
import { applyDeferredPiCompactionMarker } from "./compaction-marker-manager-pi";
import { signalPiDeferredHistoryRefresh } from "./context-handler";
import {
	adaptPiAppendCompaction,
	type PiAppendCompaction,
} from "./pi-append-compaction";
import {
	buildPiCompactionSummary,
	placePiMarkerKeptEntry,
} from "./pi-historian-runner";

/**
 * The first entry a marker for the newest compartment keeps, or null while
 * there is none yet; see placePiMarkerKeptEntry.
 */
function placeFirstKeptEntryId(
	db: ContextDatabase,
	sessionId: string,
	branchEntries: readonly unknown[],
	last: { endMessageId: string; endMessage: number },
): string | null {
	return placePiMarkerKeptEntry(
		db,
		sessionId,
		branchEntries,
		last.endMessageId,
		last.endMessage,
	);
}

/**
 * Stage the Pi compaction marker for the newest compartment WITHOUT applying
 * it, then signal a deferred history refresh so the next cache-busting
 * transform pass drains and applies it via the pipeline's deferred-marker path.
 *
 * A full recomp rebuilds every compartment; without a marker for the rebuilt
 * history the native marker never moves, so `getBranch()` keeps returning the
 * whole pre-recomp branch. (The m[0]/m[1] materialization signals a recomp
 * already fires drive the synthetic `<session-history>` render, not the native
 * marker that trims `getBranch()`; those are separate mechanisms.)
 *
 * Used by detached recomp and upgrade runs: applying the marker eagerly
 * (`appendCompaction`) mutates `getBranch()` immediately and could alter a
 * cache-stable pass. Staging + deferred drain mirrors the background historian's
 * `onPublished` signals so the marker rides the next genuine bust.
 *
 * The staged marker replaces any marker still pending for the compartments the
 * recomp replaced: the drain could only discard that one, since its summary no
 * longer exists. Its kept entry is the first message the request's history cut
 * keeps, which is the prompt of the turn when the recomp ran during one (Pi
 * runs commands while a reply streams). When the cut keeps no message yet (a
 * full recomp of a session with no unsummarized tail ends on the snapshot's
 * newest message), or the stored ordinals cannot be placed on the branch, the
 * marker is staged without a kept entry, as the historian stages it; the drain
 * places it once the next message arrives, and keeps it waiting until then.
 */
export function stagePiRecompMarker(args: {
	db: ContextDatabase;
	sessionId: string;
	branchEntries: readonly unknown[];
}): void {
	const compartments = getCompartments(args.db, args.sessionId);
	const last = compartments[compartments.length - 1];
	if (!last || last.endMessageId.length === 0) return;

	let firstKeptEntryId: string | null = null;
	try {
		firstKeptEntryId = placeFirstKeptEntryId(
			args.db,
			args.sessionId,
			args.branchEntries,
			last,
		);
	} catch {
		firstKeptEntryId = null;
	}

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
			last,
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
): PiAppendCompaction | undefined {
	return adaptPiAppendCompaction(
		(ctx as { sessionManager?: unknown })?.sessionManager,
	);
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
