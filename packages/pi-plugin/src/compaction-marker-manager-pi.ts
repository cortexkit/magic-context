import {
	getCompartmentsByEndMessageId,
	getUncoveredCompartmentEndThrough,
} from "@magic-context/core/features/magic-context/compartment-storage";
import type { PendingPiCompactionMarker } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { BoundedSessionMap } from "@magic-context/core/shared/bounded-session-map";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";
import { resolvePiFirstKeptEntry } from "./pi-historian-runner";
import { resolvePiMarkerKeptEntry } from "./pi-history-cut";
import {
	isPiOrdinalAlignmentUnanchored,
	resolvePiOrdinalAlignment,
} from "./pi-ordinal-alignment";
import { SYNTH_USER_ID_PREFIX } from "./read-session-pi";

export type PiMarkerUpdateOutcome =
	| { kind: "applied"; firstKeptEntryId: string; compactionId: string }
	| { kind: "already-current"; firstKeptEntryId: string; compactionId: string }
	| {
			kind: "stale-skip";
			reason:
				| "compartment-removed"
				| "target-superseded"
				| "entry-removed"
				| "synthetic-kept-entry"
				| "synthetic-boundary-merged"
				| "partial-message-boundary";
	  }
	| { kind: "waiting-for-entry" }
	| { kind: "retryable-failure"; error: Error };

export interface ApplyDeferredPiCompactionMarkerDeps {
	db: Database;
	readBranchEntries: () => unknown[];
	appendCompaction: (
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: unknown,
		fromHook?: boolean,
	) => string | undefined;
}

export type PiCompactionMarkerDrainGate =
	| "drain-not-eligible"
	| "compartment-not-found"
	| "duplicate-compartment-end"
	| "target-superseded"
	| "partial-message-boundary"
	| "ordinal-alignment-unavailable"
	| "no-replay-safe-kept-entry"
	| "kept-entry-not-on-branch"
	| "current-compaction-id-unavailable"
	| "append-compaction-returned-no-id"
	| "manager-threw"
	| "rendered-history-not-covering-marker"
	| "append-compaction-unavailable"
	| "get-branch-unavailable"
	| "folding-system-state-unavailable"
	| "equivalence-refused"
	| "equivalence-unavailable"
	| "cas-clear-lost"
	| "drain-threw";

type PiCompactionMarkerDrainGateFields = {
	firstKeptEntryId?: string | null;
	renderedCoverageOrdinal?: number | null;
	renderedCoverageEndMessageId?: string | null;
	m1CoverageOrdinal?: number | null;
	m1CoverageEndMessageId?: string | null;
	matchCount?: number;
	alignment?: "unanchored" | "unresolved";
	alignmentReason?: "anchor-missing" | "anchors-disagree";
	historyConsumed?: boolean;
	materializationSatisfied?: boolean;
	drainSuppressed?: boolean;
	casLost?: boolean;
	foldingOnlyTools?: readonly string[];
	persistedOnlyTools?: readonly string[];
	changedTools?: readonly string[];
	promptLengthDelta?: number;
	foldingPromptLength?: number;
	persistedPromptLength?: number;
	errorName?: string;
	errorCode?: string;
};

interface LoggedMarkerDrainGates {
	markerIdentity: string;
	gates: Set<PiCompactionMarkerDrainGate>;
}

const loggedMarkerDrainGates = new BoundedSessionMap<LoggedMarkerDrainGates>(
	1000,
);

/**
 * Report a marker gate once per session, marker, and classified gate. Diagnostics
 * contain identifiers, counts, prompt byte lengths, or error class/code only;
 * prompt text and error messages are never included.
 */
export function logPiCompactionMarkerDrainGateOnce(
	sessionId: string,
	pending: PendingPiCompactionMarker,
	gate: PiCompactionMarkerDrainGate,
	fields: PiCompactionMarkerDrainGateFields = {},
): void {
	const markerIdentity = `${pending.endMessageId}\u0000${pending.ordinal}\u0000${pending.publishedAt}`;
	let state = loggedMarkerDrainGates.get(sessionId);
	if (!state || state.markerIdentity !== markerIdentity) {
		state = { markerIdentity, gates: new Set() };
	}
	if (state.gates.has(gate)) return;
	state.gates.add(gate);
	loggedMarkerDrainGates.set(sessionId, state);
	const firstKeptEntryId = Object.hasOwn(fields, "firstKeptEntryId")
		? fields.firstKeptEntryId
		: pending.firstKeptEntryId;
	const parts = [
		`gate=${gate}`,
		`endMessageId=${pending.endMessageId}`,
		`ordinal=${pending.ordinal}`,
		`firstKeptEntryId=${firstKeptEntryId ?? "<none>"}`,
		`boundaryKind=${pending.endMessageId.startsWith(SYNTH_USER_ID_PREFIX) ? "folded-tool-result" : "session-entry"}`,
		`renderedCoverageOrdinal=${fields.renderedCoverageOrdinal ?? "<none>"}`,
	];
	if (fields.renderedCoverageEndMessageId !== undefined)
		parts.push(
			`renderedCoverageEndMessageId=${fields.renderedCoverageEndMessageId ?? "<none>"}`,
		);
	if (fields.m1CoverageOrdinal !== undefined)
		parts.push(`m1CoverageOrdinal=${fields.m1CoverageOrdinal ?? "<none>"}`);
	if (fields.m1CoverageEndMessageId !== undefined)
		parts.push(
			`m1CoverageEndMessageId=${fields.m1CoverageEndMessageId ?? "<none>"}`,
		);
	if (fields.matchCount !== undefined)
		parts.push(`matchCount=${fields.matchCount}`);
	if (fields.alignment !== undefined)
		parts.push(`alignment=${fields.alignment}`);
	if (fields.alignmentReason !== undefined)
		parts.push(`alignmentReason=${fields.alignmentReason}`);
	for (const key of [
		"historyConsumed",
		"materializationSatisfied",
		"drainSuppressed",
		"casLost",
	] as const) {
		if (fields[key] !== undefined) parts.push(`${key}=${fields[key]}`);
	}
	if (fields.foldingOnlyTools !== undefined)
		parts.push(`foldingOnlyTools=${JSON.stringify(fields.foldingOnlyTools)}`);
	if (fields.persistedOnlyTools !== undefined)
		parts.push(
			`persistedOnlyTools=${JSON.stringify(fields.persistedOnlyTools)}`,
		);
	if (fields.changedTools !== undefined)
		parts.push(`changedTools=${JSON.stringify(fields.changedTools)}`);
	if (fields.promptLengthDelta !== undefined)
		parts.push(`promptLengthDelta=${fields.promptLengthDelta}`);
	if (fields.foldingPromptLength !== undefined)
		parts.push(`foldingPromptLength=${fields.foldingPromptLength}`);
	if (fields.persistedPromptLength !== undefined)
		parts.push(`persistedPromptLength=${fields.persistedPromptLength}`);
	if (fields.errorName !== undefined)
		parts.push(`errorName=${JSON.stringify(fields.errorName)}`);
	if (fields.errorCode !== undefined)
		parts.push(`errorCode=${JSON.stringify(fields.errorCode)}`);
	sessionLog(sessionId, `Pi compaction-marker drain ${parts.join(" ")}`);
}

export function clearPiCompactionMarkerDrainLogState(sessionId: string): void {
	loggedMarkerDrainGates.delete(sessionId);
}

export function getPiCompactionMarkerDrainErrorFields(error: unknown): {
	errorName: string;
	errorCode?: string;
} {
	const candidate =
		error !== null && typeof error === "object"
			? (error as { name?: unknown; code?: unknown })
			: undefined;
	const errorName =
		typeof candidate?.name === "string"
			? candidate.name
			: error instanceof Error
				? error.name
				: "Error";
	return {
		errorName,
		...(typeof candidate?.code === "string"
			? { errorCode: candidate.code }
			: {}),
	};
}

export function applyDeferredPiCompactionMarker(
	deps: ApplyDeferredPiCompactionMarkerDeps,
	sessionId: string,
	pending: PendingPiCompactionMarker,
): PiMarkerUpdateOutcome {
	try {
		const matches = getCompartmentsByEndMessageId(
			deps.db,
			sessionId,
			pending.endMessageId,
		);
		if (matches.length === 0 || matches.length > 1) {
			logPiCompactionMarkerDrainGateOnce(
				sessionId,
				pending,
				matches.length === 0
					? "compartment-not-found"
					: "duplicate-compartment-end",
				{ matchCount: matches.length },
			);
			return { kind: "stale-skip", reason: "compartment-removed" };
		}
		if (matches[0]?.endMessage !== pending.ordinal) {
			logPiCompactionMarkerDrainGateOnce(
				sessionId,
				pending,
				"target-superseded",
			);
			return { kind: "stale-skip", reason: "target-superseded" };
		}

		// Pi keeps the first entry after the summarized range, not OpenCode's
		// earlier user turn. A summary ending within a message could hide its
		// remaining parts. Require the next summary to continue it at a later block
		// or start at the next message ordinal, even if publication already chose
		// which entry to keep.
		if (
			getUncoveredCompartmentEndThrough(deps.db, sessionId, pending.ordinal)
		) {
			logPiCompactionMarkerDrainGateOnce(
				sessionId,
				pending,
				"partial-message-boundary",
			);
			return { kind: "stale-skip", reason: "partial-message-boundary" };
		}

		const branchEntries = deps.readBranchEntries();
		// The marker starts at the first message the request's history cut keeps,
		// decided from the branch now rather than when the summary was published:
		// a summary that ends inside a turn keeps that turn's prompt, and a marker
		// starting after it would hide the prompt from every later request. While
		// the stored ordinals cannot be placed on the branch, or the boundary is
		// not on it, the marker is placed as before: by the kept entry chosen at
		// publication, else by stored ordinal.
		let firstKeptEntryId: string | null | undefined = pending.firstKeptEntryId;
		let placedByCut = false;
		const kept = resolvePiMarkerKeptEntry(branchEntries, pending.endMessageId);
		if (
			kept.kind !== "boundary-not-on-branch" &&
			!isPiOrdinalAlignmentUnanchored(
				resolvePiOrdinalAlignment(deps.db, sessionId, branchEntries),
			)
		) {
			placedByCut = true;
			firstKeptEntryId = kept.kind === "resolved" ? kept.entryId : null;
		}
		if (!placedByCut && !firstKeptEntryId) {
			// The pending ordinal is a stored coordinate. Place it on this branch
			// the same way every raw reader does, and keep the marker waiting while
			// the stored coordinates cannot be placed at all: trimming the branch
			// at a guessed position could hide content no summary covers.
			const alignment = resolvePiOrdinalAlignment(
				deps.db,
				sessionId,
				branchEntries,
			);
			if (isPiOrdinalAlignmentUnanchored(alignment)) {
				if (
					alignment.kind === "unanchored" &&
					alignment.reason === "anchor-missing" &&
					hasMergedSyntheticBoundary(branchEntries, pending.endMessageId)
				) {
					return { kind: "stale-skip", reason: "synthetic-boundary-merged" };
				}
				logPiCompactionMarkerDrainGateOnce(
					sessionId,
					pending,
					"ordinal-alignment-unavailable",
					{
						alignment: alignment.kind,
						...(alignment.kind === "unanchored"
							? { alignmentReason: alignment.reason }
							: {}),
					},
				);
				return { kind: "waiting-for-entry" };
			}
			const boundary = resolvePiFirstKeptEntry(
				branchEntries,
				pending.ordinal,
				alignment.offset,
			);
			if (boundary.kind === "unplaceable") {
				return { kind: "stale-skip", reason: "synthetic-kept-entry" };
			}
			firstKeptEntryId = boundary.kind === "resolved" ? boundary.entryId : null;
		}
		if (!firstKeptEntryId) {
			logPiCompactionMarkerDrainGateOnce(
				sessionId,
				pending,
				"no-replay-safe-kept-entry",
				{ firstKeptEntryId: null },
			);
			return { kind: "waiting-for-entry" };
		}
		const pendingFirstKeptIndex = findEntryIndex(
			branchEntries,
			firstKeptEntryId,
		);
		if (pendingFirstKeptIndex < 0) {
			logPiCompactionMarkerDrainGateOnce(
				sessionId,
				pending,
				"kept-entry-not-on-branch",
				{ firstKeptEntryId },
			);
			return { kind: "stale-skip", reason: "entry-removed" };
		}

		const latestCompaction = findLatestCompaction(branchEntries);
		if (latestCompaction !== null) {
			const latestFirstKeptIndex = findEntryIndex(
				branchEntries,
				latestCompaction.firstKeptEntryId,
			);
			if (latestFirstKeptIndex >= pendingFirstKeptIndex) {
				if (latestCompaction.id === null) {
					const error = new Error("Pi compaction entry has no id");
					logPiCompactionMarkerDrainGateOnce(
						sessionId,
						pending,
						"current-compaction-id-unavailable",
						{
							firstKeptEntryId: latestCompaction.firstKeptEntryId,
							errorName: error.name,
						},
					);
					return {
						kind: "retryable-failure",
						error,
					};
				}
				return {
					kind: "already-current",
					firstKeptEntryId: latestCompaction.firstKeptEntryId,
					compactionId: latestCompaction.id,
				};
			}
		}

		const compactionId = deps.appendCompaction(
			pending.summary,
			firstKeptEntryId,
			pending.tokensBefore,
			{
				source: "magic-context",
				lastCompactedOrdinal: pending.ordinal,
			},
			true,
		);
		if (typeof compactionId !== "string" || compactionId.length === 0) {
			const error = new Error("Pi appendCompaction returned no compaction id");
			logPiCompactionMarkerDrainGateOnce(
				sessionId,
				pending,
				"append-compaction-returned-no-id",
				{ errorName: error.name },
			);
			return {
				kind: "retryable-failure",
				error,
			};
		}
		sessionLog(
			sessionId,
			`Pi compaction-marker drain: persisted compactionId=${compactionId} firstKept=${firstKeptEntryId} endMessageId=${pending.endMessageId} ordinal=${pending.ordinal} tokensBefore=${pending.tokensBefore}`,
		);
		return { kind: "applied", firstKeptEntryId, compactionId };
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		logPiCompactionMarkerDrainGateOnce(sessionId, pending, "manager-threw", {
			...getPiCompactionMarkerDrainErrorFields(err),
		});
		return { kind: "retryable-failure", error };
	}
}

function hasMergedSyntheticBoundary(
	entries: readonly unknown[],
	endMessageId: string,
): boolean {
	if (!endMessageId.startsWith(SYNTH_USER_ID_PREFIX)) return false;
	const resultId = endMessageId.slice(SYNTH_USER_ID_PREFIX.length);
	let foundResult = false;
	for (const entry of entries) {
		const row = entry as {
			type?: unknown;
			id?: unknown;
			message?: { role?: unknown; toolCallId?: unknown };
		} | null;
		if (row?.type !== "message") continue;
		const message = row.message;
		if (!foundResult) {
			foundResult =
				row.id === resultId &&
				message?.role === "toolResult" &&
				typeof message.toolCallId === "string" &&
				message.toolCallId.length > 0;
			continue;
		}
		// iterateEntriesToRawMessageRange puts these results in the next real
		// user's RawMessage instead of emitting synth-user-<id>. Appending entries
		// cannot restore that old id. Guessing the next ordinal could trim the
		// user's new, unsummarized request instead.
		if (message?.role === "user") return true;
		if (message?.role === "assistant") return false;
	}
	return false;
}

function findLatestCompaction(
	branchEntries: unknown[],
): { id: string | null; firstKeptEntryId: string } | null {
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i];
		if (entry === null || typeof entry !== "object") continue;
		const record = entry as {
			type?: unknown;
			id?: unknown;
			firstKeptEntryId?: unknown;
		};
		if (
			record.type === "compaction" &&
			typeof record.firstKeptEntryId === "string"
		) {
			return {
				id: typeof record.id === "string" ? record.id : null,
				firstKeptEntryId: record.firstKeptEntryId,
			};
		}
	}
	return null;
}

export function findLatestCompactionFirstKept(
	branchEntries: unknown[],
): string | null {
	return findLatestCompaction(branchEntries)?.firstKeptEntryId ?? null;
}

function getEntryId(entry: unknown): string | null {
	if (entry === null || typeof entry !== "object") return null;
	const id = (entry as { id?: unknown }).id;
	return typeof id === "string" ? id : null;
}

function findEntryIndex(branchEntries: unknown[], entryId: string): number {
	return branchEntries.findIndex((entry) => getEntryId(entry) === entryId);
}
