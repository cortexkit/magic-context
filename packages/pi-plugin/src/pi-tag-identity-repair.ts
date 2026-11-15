import {
	decodePiContentDecision,
	encodePiContentDecision,
	freezePiContentDecision,
	getPiContentDecisions,
} from "@magic-context/core/features/magic-context/pi-content-decisions";
import {
	PI_IDENTITY_FOLD_GUARD_LIMIT,
	readPiIdentityFoldGuards,
	writePiIdentityFoldGuards,
} from "@magic-context/core/features/magic-context/pi-identity-fold-guards";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
	PiContextDeadlineError,
	PiContextSupersededError,
} from "./pi-context-budget";

export const PI_TAG_IDENTITY_REPAIR_ONCE_GUARD = "pi-tag-identity-repair-once";
export const PI_TAG_IDENTITY_REPAIR_REASON = "tag_identity_repair";
export interface PiIdentityRebuild {
	key: string;
	kept: number;
	removed: number[];
	kind: "tool" | "message";
}

/**
 * Outcome of asking for the one unproven repair an identity may receive.
 * - `claimed`: this identity had no repair yet; the caller may keep the newest
 *   number and declare one `tag_identity_repair` rebuild.
 * - `recurring`: the identity was already repaired once (under `key` or one of
 *   `legacyKeys`). The caller must not repair it again and must not refuse
 *   the turn either: it leaves the rows unmerged and serves the identity the
 *   way tagging would without any repair.
 * - `unpersisted`: the guard could not be read or written (a full guard
 *   store, a damaged decision ledger or guard row, a rejected write). Without
 *   a durable guard a repair could repeat on every pass, so the caller treats
 *   it like `recurring`.
 */
export type PiIdentityRepairClaim = "claimed" | "recurring" | "unpersisted";

const unreadableLedgerLogged = new Set<string>();

/**
 * Errors that end the whole pass: its deadline passed, a newer pass took the
 * session over, or the host cancelled the run. Identity repair contains every
 * other failure by serving duplicates unmerged, but it must let these through:
 * containing one kept a large repair running long past the pass deadline, and
 * the pass was then refused with all of its work rolled back.
 */
export function isPiPassEndingError(error: unknown): boolean {
	return (
		error instanceof PiContextDeadlineError ||
		error instanceof PiContextSupersededError ||
		(error instanceof Error && error.name === "AbortError")
	);
}

/**
 * The session's Pi content-decision ledger for identity decisions, or null
 * when the stored field cannot be read (not JSON, not an array, a non-string
 * member). An unreadable ledger is logged once per session and treated as "no
 * identity decision can be read or written": callers serve duplicates
 * unmerged and never write the field, so the damaged value, which may still
 * hold other kinds of decisions, is left exactly as it is. The reminder-strip
 * and seam replays read through this too, so a damaged field degrades those
 * replays instead of refusing every turn.
 */
export function readPiIdentityDecisions(
	db: Database,
	sessionId: string,
): Set<string> | null {
	try {
		return getPiContentDecisions(db, sessionId);
	} catch (error) {
		if (isPiPassEndingError(error)) throw error;
		if (!unreadableLedgerLogged.has(sessionId)) {
			if (unreadableLedgerLogged.size > 10_000) unreadableLedgerLogged.clear();
			unreadableLedgerLogged.add(sessionId);
			sessionLog(
				sessionId,
				`Pi content-decision ledger unreadable: tag identity duplicates are served unmerged and no stored decision is replayed or written; the stored field is left untouched: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return null;
	}
}

/**
 * Write one identity decision. Any failure other than one that ends the pass
 * (a busy store, a damaged field, a rejected write) returns false instead of
 * throwing: the caller then leaves the duplicate unmerged, which serves the
 * turn. A pass-ending error is rethrown (see isPiPassEndingError).
 */
function freezeIdentityDecision(
	db: Database,
	sessionId: string,
	kind:
		| "tag-identity-repair-pending"
		| "tag-identity-rebuild-failed"
		| "tag-identity-recurring",
	value: string,
): boolean {
	if (readPiIdentityDecisions(db, sessionId) === null) return false;
	try {
		return freezePiContentDecision(db, sessionId, kind, value);
	} catch (error) {
		if (isPiPassEndingError(error)) throw error;
		sessionLog(
			sessionId,
			`tag identity decision ${kind} could not be written; serving duplicates unmerged: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

const unreadableGuardsLogged = new Set<string>();

/** The session's fold guards, or null (logged once per session) when the stored row cannot be read. */
function readFoldGuards(db: Database, sessionId: string): Set<string> | null {
	try {
		return readPiIdentityFoldGuards(db, sessionId);
	} catch (error) {
		if (isPiPassEndingError(error)) throw error;
		if (!unreadableGuardsLogged.has(sessionId)) {
			if (unreadableGuardsLogged.size > 10_000) unreadableGuardsLogged.clear();
			unreadableGuardsLogged.add(sessionId);
			sessionLog(
				sessionId,
				`Pi identity fold guards unreadable: tag identity duplicates are served unmerged and the stored row is left untouched: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return null;
	}
}

/**
 * The identity decisions one writer transaction works with: the shared Pi
 * content-decision ledger and the fold guards, each read once by `load`
 * instead of once per identity. New guards are kept in memory and written
 * together by `flush` inside the same transaction as the folds they guard, so
 * no fold commits without its guard and no guard commits without its fold.
 */
export class PiIdentityRepairBatch {
	private ledger: Set<string> | null = null;
	private guards: Set<string> | null = null;
	private pending = false;
	/**
	 * Set once the guard row could not be written in this pass: every later
	 * claim then answers `unpersisted`, so only the identities that need a guard
	 * stay unmerged and the rest of the adoption work can still commit.
	 */
	refuseNewGuards = false;
	constructor(
		private readonly db: Database,
		private readonly sessionId: string,
	) {}

	/** Read both stores. Call it after taking the writer, in every transaction that claims. */
	load(): void {
		this.pending = false;
		this.ledger = readPiIdentityDecisions(this.db, this.sessionId);
		this.guards = readFoldGuards(this.db, this.sessionId);
	}

	/** The shared content-decision ledger as loaded, or null when it is unreadable. */
	decisions(): Set<string> | null {
		return this.ledger;
	}

	/** What `claim` would answer for this identity, without claiming anything. */
	peek(key: string, legacyKeys: readonly string[] = []): PiIdentityRepairClaim {
		const ledger = this.ledger;
		const guards = this.guards;
		if (ledger === null) return "unpersisted";
		const candidates = [key, ...legacyKeys];
		if (
			candidates.some((candidate) =>
				ledger.has(
					encodePiContentDecision("tag-identity-repair-once", candidate),
				),
			)
		)
			return "recurring";
		if (guards === null) return "unpersisted";
		if (candidates.some((candidate) => guards.has(candidate)))
			return "recurring";
		if (this.refuseNewGuards || guards.size >= PI_IDENTITY_FOLD_GUARD_LIMIT)
			return "unpersisted";
		return "claimed";
	}

	/**
	 * Ask for the one repair of the identity `key` (or of the keys older builds
	 * used for it, `legacyKeys`). A guard found in either store, including a
	 * `tag-identity-repair-once` entry an older build wrote to the shared ledger,
	 * means the repair is spent.
	 */
	claim(
		key: string,
		legacyKeys: readonly string[] = [],
	): PiIdentityRepairClaim {
		const claim = this.peek(key, legacyKeys);
		if (claim !== "claimed") return claim;
		this.guards?.add(key);
		this.pending = true;
		return "claimed";
	}

	/**
	 * Write the guards claimed since `load`. Throws when they cannot be
	 * written; the caller must then roll back the folds made in this
	 * transaction.
	 */
	flush(): void {
		if (!this.pending || !this.guards) return;
		writePiIdentityFoldGuards(this.db, this.sessionId, this.guards);
		this.pending = false;
	}

	/** recordPiIdentityRecurrence against the loaded ledger. */
	recordRecurrence(key: string): boolean {
		return recordPiIdentityRecurrence(
			this.db,
			this.sessionId,
			key,
			this.ledger,
		);
	}
}

/**
 * Claim and persist one identity's repair on its own; see
 * PiIdentityRepairBatch.claim. The read and the write of the guard row share
 * one writer transaction, so a guard another connection stores meanwhile is
 * never overwritten.
 */
export function claimPiIdentityRepair(
	db: Database,
	sessionId: string,
	key: string,
	legacyKeys: readonly string[] = [],
): PiIdentityRepairClaim {
	try {
		return db
			.transaction(() => {
				const batch = new PiIdentityRepairBatch(db, sessionId);
				batch.load();
				const claim = batch.claim(key, legacyKeys);
				if (claim === "claimed") batch.flush();
				return claim;
			})
			.immediate();
	} catch (error) {
		if (isPiPassEndingError(error)) throw error;
		sessionLog(
			sessionId,
			`tag identity fold guard could not be written; serving the duplicate unmerged: ${error instanceof Error ? error.message : String(error)}`,
		);
		return "unpersisted";
	}
}

const unrecordedRecurrenceLogged = new Set<string>();

/**
 * Record, once per identity, that a duplicate was served unmerged because its
 * one repair was spent or could not be recorded. Returns whether the caller
 * should log the event: true when this call wrote the record, or when the
 * record cannot be written and this process has not logged that identity for
 * the session yet (so a full ledger logs once, not on every turn). Throws only
 * a pass-ending error. `decisions`, when given, is the caller's loaded ledger:
 * it answers the already-recorded check and receives the new record.
 */
export function recordPiIdentityRecurrence(
	db: Database,
	sessionId: string,
	key: string,
	decisions?: Set<string> | null,
): boolean {
	const entry = encodePiContentDecision("tag-identity-recurring", key);
	const known =
		decisions === undefined
			? readPiIdentityDecisions(db, sessionId)
			: decisions;
	if (known?.has(entry)) return false;
	if (freezeIdentityDecision(db, sessionId, "tag-identity-recurring", key)) {
		decisions?.add(entry);
		return true;
	}
	const logKey = `${sessionId}\0${key}`;
	if (unrecordedRecurrenceLogged.has(logKey)) return false;
	if (unrecordedRecurrenceLogged.size > 10_000)
		unrecordedRecurrenceLogged.clear();
	unrecordedRecurrenceLogged.add(logKey);
	return true;
}

export function readPiIdentityRecurrences(
	db: Database,
	sessionId: string,
): string[] {
	return [...(readPiIdentityDecisions(db, sessionId) ?? [])].flatMap(
		(entry) => {
			const decoded = decodePiContentDecision(entry);
			return decoded?.[0] === "tag-identity-recurring" ? [decoded[1]] : [];
		},
	);
}

/** Returns false when the rebuild could not be recorded; the caller then skips the repair. Throws only a pass-ending error. */
export function queuePiIdentityRebuild(
	db: Database,
	sessionId: string,
	repair: PiIdentityRebuild,
): boolean {
	return freezeIdentityDecision(
		db,
		sessionId,
		"tag-identity-repair-pending",
		JSON.stringify(repair),
	);
}

/** Refuse only the first durable failure to clear m[0]/m[1] for a tag-identity rebuild; later sends retain the pending repair. */
export function claimPiIdentityRebuildFailure(
	db: Database,
	sessionId: string,
): "first" | "again" | "unpersisted" {
	const decisions = readPiIdentityDecisions(db, sessionId);
	if (!decisions) return "unpersisted";
	const key = encodePiContentDecision(
		"tag-identity-rebuild-failed",
		"m0-m1-clear",
	);
	if (decisions.has(key)) return "again";
	return freezeIdentityDecision(
		db,
		sessionId,
		"tag-identity-rebuild-failed",
		"m0-m1-clear",
	)
		? "first"
		: "unpersisted";
}

export function readPiIdentityRebuilds(
	db: Database,
	sessionId: string,
): PiIdentityRebuild[] {
	const repairs = [...(readPiIdentityDecisions(db, sessionId) ?? [])].flatMap(
		(entry) => {
			const decoded = decodePiContentDecision(entry);
			if (decoded?.[0] !== "tag-identity-repair-pending") return [];
			// A damaged record cannot name a number to protect. Ignoring it costs at
			// most the protection of one already-folded survivor for one pass; it
			// must not refuse the session's turns.
			let repair: PiIdentityRebuild;
			try {
				repair = JSON.parse(decoded[1]) as PiIdentityRebuild;
			} catch {
				return [];
			}
			if (
				typeof repair?.key !== "string" ||
				!Number.isSafeInteger(repair.kept) ||
				!Array.isArray(repair.removed) ||
				!repair.removed.every(Number.isSafeInteger) ||
				!["tool", "message"].includes(repair.kind)
			)
				return [];
			return [repair];
		},
	);
	const byKey = new Map<string, PiIdentityRebuild>();
	for (const repair of repairs) {
		const previous = byKey.get(repair.key);
		byKey.set(repair.key, {
			...repair,
			removed: [...new Set([...(previous?.removed ?? []), ...repair.removed])],
		});
	}
	return [...byKey.values()];
}

/**
 * Clear the pending rebuild records once a repaired array was served. Leaves
 * the field untouched when it holds no pending record or cannot be read (a
 * damaged field may still hold other decisions), and never throws: failing
 * to clear only means the next pass declares the same rebuild once more.
 */
export function acknowledgePiIdentityRebuilds(
	db: Database,
	sessionId: string,
): void {
	try {
		db.transaction(() => {
			const row = db
				.prepare(
					"SELECT merged_reasoning_stripped_ids AS entries FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId) as { entries: string | null } | undefined;
			if (!row?.entries) return;
			const entries: unknown = JSON.parse(row.entries);
			if (
				!Array.isArray(entries) ||
				!entries.every((entry) => typeof entry === "string")
			)
				return;
			const kept = entries.filter(
				(entry) =>
					decodePiContentDecision(entry)?.[0] !== "tag-identity-repair-pending",
			);
			if (kept.length === entries.length) return;
			db.prepare(
				"UPDATE session_meta SET merged_reasoning_stripped_ids = ? WHERE session_id = ? AND merged_reasoning_stripped_ids IS ?",
			).run(JSON.stringify(kept), sessionId, row.entries);
		}).immediate();
	} catch (error) {
		sessionLog(
			sessionId,
			`tag identity rebuild acknowledgement failed; the next pass repeats it: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
