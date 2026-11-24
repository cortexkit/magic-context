import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	type ContextDatabase,
	setPendingPiCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage";
import { signalPiDeferredHistoryRefresh } from "./context-handler";
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
 * Detached /ctx-recomp stages the marker because applying it eagerly
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
