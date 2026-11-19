/**
 * Keeps Pi's raw-message numbering in the coordinate space the session's
 * stored state was written in.
 *
 * Every ordinal Magic Context stores for a Pi session (compartment ranges,
 * the search-index watermark, note anchors, compression depth, pending
 * compaction markers) is a position in the raw-message list numbered by
 * walking `sessionManager.getBranch()` from its first entry. That list can
 * lose entries in front of everything stored: `getBranch()` walks parent
 * links from the leaf and stops at the first parent it cannot find, so when
 * Pi's loader drops an unparseable JSONL line (it skips malformed lines),
 * every entry before the break disappears from the walk. The stored ordinals
 * then run ahead of the branch numbering. The newest compartment's end sits
 * past the branch's last ordinal, so the historian sees "no new raw history"
 * on every pass and never runs again.
 *
 * The stored rows also name their boundary messages by id, so the offset is
 * measured rather than guessed. Locate the newest compartment's end message on
 * the branch; offset = stored ordinal - branch ordinal. Readers then number
 * the branch from offset + 1, behind empty slots for the ordinals the walk no
 * longer reaches, and every stored coordinate keeps its meaning without a
 * single row being rewritten.
 *
 * The offset is derived from the stored rows and the branch on every pass
 * rather than saved: a saved copy is a second source of truth that could
 * disagree with the rows it was derived from. Appending to the branch never
 * changes it. A `/tree` jump to a point before the anchor removes the anchor
 * from the branch, and a chain that heals makes the offset 0 again; both are
 * picked up by the next derivation.
 *
 * Safety rules:
 * - The newest compartment's end message missing from the branch, or a second
 *   stored anchor that implies a different offset, means the stored ordinals
 *   cannot be placed: the session is `unanchored`. The historian and the
 *   native compaction marker stay paused for it, and readers keep plain branch
 *   numbering, which is what they did before this module existed.
 * - When the stored anchors cannot even be read (a failed query), the session
 *   is `unresolved`: the same pauses apply, because a failed read proves
 *   nothing about where the stored ordinals sit.
 * - Stored ordinals behind the branch numbering (`behind`) cannot be expressed
 *   as empty slots. Readers keep plain branch numbering, as they always have,
 *   and the condition is logged.
 * - Every change of the result is logged once, with the numbers.
 */

import { sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";
import { locatePiRawOrdinals } from "./read-session-pi";

interface AnchorRow {
	sequence: number;
	start_message: number;
	end_message: number;
	start_message_id: string | null;
	end_message_id: string;
}

export type PiOrdinalAlignment =
	/** No compartments, or the branch numbers the anchor where it was stored. */
	| { kind: "aligned"; offset: 0 }
	/** The branch walk lost `offset` ordinals in front of the stored anchor. */
	| {
			kind: "shifted";
			offset: number;
			anchorId: string;
			storedOrdinal: number;
			branchOrdinal: number;
	  }
	/** The branch numbers the anchor later than it was stored; left as is. */
	| {
			kind: "behind";
			offset: 0;
			anchorId: string;
			storedOrdinal: number;
			branchOrdinal: number;
	  }
	/** Stored ordinals cannot be placed on this branch; historian paused. */
	| {
			kind: "unanchored";
			offset: 0;
			reason: "anchor-missing" | "anchors-disagree";
			detail: string;
	  }
	/** The stored anchors could not be read; historian paused until they can. */
	| { kind: "unresolved"; offset: 0; detail: string };

const ALIGNED: PiOrdinalAlignment = { kind: "aligned", offset: 0 };

interface CachedAlignment {
	key: string;
	alignment: PiOrdinalAlignment;
	prefixComplete: boolean;
}

/** Cache direct reads, and carry proven results to verified appends. */
const resolvedByEntries = new WeakMap<
	readonly unknown[],
	Map<string, CachedAlignment>
>();

export function inheritPiOrdinalAlignment(
	sessionId: string,
	previous: readonly unknown[],
	appended: readonly unknown[],
): void {
	// The caller proved that the entire previous branch is the unchanged prefix.
	// An anchor synthesized from trailing tool results is not proof: a new user
	// message can prevent the synthetic entry from being emitted at all.
	const cached = resolvedByEntries.get(previous)?.get(sessionId);
	if (cached?.prefixComplete)
		resolvedByEntries.set(appended, new Map([[sessionId, cached]]));
}

/** The last alignment logged per session, so each change is logged once. */
const loggedSignatureBySession = new Map<string, string>();

function readAnchorRows(db: Database, sessionId: string): AnchorRow[] {
	const rows = db
		.prepare(
			"SELECT sequence, start_message, end_message, start_message_id, end_message_id FROM compartments WHERE session_id = ? AND rebase_status != 'unresolved' AND end_message_id IS NOT NULL AND end_message_id != '' ORDER BY sequence DESC LIMIT 2",
		)
		.all(sessionId) as unknown[];
	return rows.filter((row): row is AnchorRow => {
		if (row === null || typeof row !== "object") return false;
		const r = row as Record<string, unknown>;
		return (
			typeof r.sequence === "number" &&
			typeof r.start_message === "number" &&
			typeof r.end_message === "number" &&
			typeof r.end_message_id === "string" &&
			r.end_message_id.length > 0
		);
	});
}

function deriveAlignment(
	rows: readonly AnchorRow[],
	entries: readonly unknown[],
	onLocatedInPrefix: () => void,
): PiOrdinalAlignment {
	const [newest, previous] = rows;
	if (!newest) return ALIGNED;
	// The newest compartment's end is the anchor. Its own start and the previous
	// compartment's end were written in the same numbering, so wherever they are
	// also on the branch they must imply the same offset.
	const checks: Array<{ label: string; id: string; stored: number }> = [];
	if (newest.start_message_id && newest.start_message_id.length > 0) {
		checks.push({
			label: `compartment ${newest.sequence} start`,
			id: newest.start_message_id,
			stored: newest.start_message,
		});
	}
	if (previous) {
		checks.push({
			label: `compartment ${previous.sequence} end`,
			id: previous.end_message_id,
			stored: previous.end_message,
		});
	}
	const located = locatePiRawOrdinals(
		entries,
		new Set([newest.end_message_id, ...checks.map((check) => check.id)]),
		onLocatedInPrefix,
	);
	const branchOrdinal = located.get(newest.end_message_id);
	if (branchOrdinal === undefined) {
		return {
			kind: "unanchored",
			offset: 0,
			reason: "anchor-missing",
			detail: `newest compartment ${newest.sequence} ends at stored ordinal ${newest.end_message} on message ${newest.end_message_id}, which the current branch (${entries.length} entries) does not contain`,
		};
	}
	const offset = newest.end_message - branchOrdinal;
	for (const check of checks) {
		const ordinal = located.get(check.id);
		if (ordinal === undefined) continue;
		if (check.stored - ordinal !== offset) {
			return {
				kind: "unanchored",
				offset: 0,
				reason: "anchors-disagree",
				detail: `newest compartment ${newest.sequence} end ${newest.end_message_id} implies offset ${offset} (stored ${newest.end_message}, branch ${branchOrdinal}) but ${check.label} ${check.id} implies offset ${check.stored - ordinal} (stored ${check.stored}, branch ${ordinal})`,
			};
		}
	}
	if (offset === 0) return ALIGNED;
	const anchor = {
		anchorId: newest.end_message_id,
		storedOrdinal: newest.end_message,
		branchOrdinal,
	};
	return offset > 0
		? { kind: "shifted", offset, ...anchor }
		: { kind: "behind", offset: 0, ...anchor };
}

function signature(alignment: PiOrdinalAlignment): string {
	switch (alignment.kind) {
		case "aligned":
			return "aligned";
		case "shifted":
		case "behind":
			return `${alignment.kind}:${alignment.anchorId}:${alignment.storedOrdinal}:${alignment.branchOrdinal}`;
		case "unanchored":
			return `unanchored:${alignment.detail}`;
		case "unresolved":
			return "unresolved";
	}
}

function describe(alignment: PiOrdinalAlignment): string {
	switch (alignment.kind) {
		case "aligned":
			return "pi ordinal alignment: stored ordinals match the branch numbering again";
		case "shifted":
			return `pi ordinal alignment: stored ordinals run ${alignment.offset} ahead of the branch walk (newest compartment end ${alignment.anchorId} stored at ${alignment.storedOrdinal}, branch ordinal ${alignment.branchOrdinal}); numbering the branch from ${alignment.offset + 1} so stored coordinates keep their meaning`;
		case "behind":
			return `pi ordinal alignment: stored ordinals run ${alignment.branchOrdinal - alignment.storedOrdinal} behind the branch walk (newest compartment end ${alignment.anchorId} stored at ${alignment.storedOrdinal}, branch ordinal ${alignment.branchOrdinal}); keeping plain branch numbering`;
		case "unanchored":
			return `pi ordinal alignment: ${alignment.reason}: ${alignment.detail}; historian and native compaction marker paused for this session`;
		case "unresolved":
			return `pi ordinal alignment: unresolved: ${alignment.detail}; historian and native compaction marker paused for this session until the anchors can be read`;
	}
}

function report(sessionId: string, alignment: PiOrdinalAlignment): void {
	const current = signature(alignment);
	const previous = loggedSignatureBySession.get(sessionId);
	if (previous === current) return;
	// A session that has always been aligned logs nothing.
	if (previous === undefined && alignment.kind === "aligned") return;
	loggedSignatureBySession.set(sessionId, current);
	sessionLog(sessionId, describe(alignment));
}

/**
 * Where the session's stored ordinals sit relative to this branch walk.
 * Derived from the stored compartment rows and `entries` (the branch the
 * caller is about to number); see the module comment for the rules.
 */
export function resolvePiOrdinalAlignment(
	db: Database,
	sessionId: string,
	entries: readonly unknown[],
): PiOrdinalAlignment {
	let rows: AnchorRow[];
	try {
		rows = readAnchorRows(db, sessionId);
	} catch (error) {
		// Without the rows nothing can be placed, and nothing proves the session
		// is aligned either. Not cached: the next call reads the rows again.
		const unresolved: PiOrdinalAlignment = {
			kind: "unresolved",
			offset: 0,
			detail: `compartment anchor read failed (${error instanceof Error ? error.message : String(error)})`,
		};
		report(sessionId, unresolved);
		return unresolved;
	}
	const key = JSON.stringify(
		rows.map((row) => [
			row.sequence,
			row.start_message,
			row.end_message,
			row.start_message_id,
			row.end_message_id,
		]),
	);
	let bySession = resolvedByEntries.get(entries);
	const cached = bySession?.get(sessionId);
	if (cached && cached.key === key) return cached.alignment;
	let prefixComplete = false;
	const alignment = deriveAlignment(rows, entries, () => {
		prefixComplete = true;
	});
	if (!bySession) {
		bySession = new Map();
		resolvedByEntries.set(entries, bySession);
	}
	bySession.set(sessionId, { key, alignment, prefixComplete });
	report(sessionId, alignment);
	return alignment;
}

/** The ordinal offset readers apply for this session and branch. */
export function resolvePiRawOrdinalOffset(
	db: Database,
	sessionId: string,
	entries: readonly unknown[],
): number {
	return resolvePiOrdinalAlignment(db, sessionId, entries).offset;
}

/**
 * An offset source for readers that load the branch themselves
 * (`readPiSessionMessages` and friends): the offset is derived from the
 * same entries they number.
 */
export function piRawOrdinalOffsetSource(
	db: Database,
	sessionId: string,
): (entries: readonly unknown[]) => number {
	return (entries) => resolvePiRawOrdinalOffset(db, sessionId, entries);
}

/** Read the live branch and derive the alignment for it. */
export function resolvePiOrdinalAlignmentForContext(
	db: Database,
	sessionId: string,
	ctx: unknown,
): PiOrdinalAlignment {
	const sm = (ctx as { sessionManager?: unknown } | undefined)
		?.sessionManager as { getBranch?: () => unknown } | undefined;
	if (typeof sm?.getBranch !== "function") return ALIGNED;
	let entries: unknown;
	try {
		entries = sm.getBranch.call(sm);
	} catch {
		return ALIGNED;
	}
	return Array.isArray(entries)
		? resolvePiOrdinalAlignment(db, sessionId, entries)
		: ALIGNED;
}

/**
 * True when the stored ordinals cannot be placed on the branch, either because
 * the anchors do not fit it (`unanchored`) or because they could not be read
 * (`unresolved`). Every caller that addresses stored ordinals pauses on it.
 */
export function isPiOrdinalAlignmentUnanchored(
	alignment: PiOrdinalAlignment,
): alignment is Extract<
	PiOrdinalAlignment,
	{ kind: "unanchored" } | { kind: "unresolved" }
> {
	return alignment.kind === "unanchored" || alignment.kind === "unresolved";
}

/** Forget the per-session log state (session shutdown or switch). */
export function clearPiOrdinalAlignmentSession(sessionId: string): void {
	loggedSignatureBySession.delete(sessionId);
}
