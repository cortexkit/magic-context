import { FailClosedBlockingError } from "../../features/magic-context/fail-closed-block";
import { isRustMarkerAdmissionFenced } from "../../features/magic-context/storage-replay-document";
import { type Database, withSqliteTransformPass } from "../../shared/sqlite";
import { saveLkgSlotToDb } from "./lkg-persist";
import { getInMemorySlot } from "./lkg-slot";

export interface ServedMarker {
    servedCaptureId: number;
    fullCoverage: boolean;
    slotState: string;
}

/** A marker failure must not enter the ordinary replay/raw-fallback ladder. */
export class ServedMarkerWriteError extends FailClosedBlockingError {
    constructor(cause: unknown) {
        const message =
            "Magic Context could not durably record the served capture. This turn was not sent; retry.";
        super(message, { kind: "storage_failure", cause: String(cause) }, { cause });
    }
}

export function readServedMarker(db: Database, sessionId: string): ServedMarker | undefined {
    const row = db
        .prepare(`SELECT served_capture_id, full_coverage, slot_state
        FROM lkg_served_markers WHERE session_id = ?`)
        .get(sessionId) as
        | { served_capture_id: number; full_coverage: number; slot_state: string }
        | undefined;
    return row
        ? {
              servedCaptureId: row.served_capture_id,
              fullCoverage: row.full_coverage === 1,
              slotState: row.slot_state,
          }
        : undefined;
}

/**
 * Allocate in context.db, not from row_version or a process-local cancel counter.
 * The SQLite wrapper bounds/retries writer acquisition; an exhausted acquisition
 * or any other failure escapes as a visible refusal before the request is emitted.
 */
export function recordServedCapture(
    db: Database,
    sessionId: string,
    fullCoverage: boolean,
): number {
    try {
        return withSqliteTransformPass(() =>
            db
                .transaction(() => {
                    const previous = readServedMarker(db, sessionId)?.servedCaptureId ?? 0;
                    const id = previous + 1;
                    if (!Number.isSafeInteger(id))
                        throw new Error("served capture counter exhausted");
                    db.prepare(`INSERT INTO lkg_served_markers
                (session_id, served_capture_id, full_coverage, slot_state) VALUES (?, ?, ?, 'captured')
                ON CONFLICT(session_id) DO UPDATE SET served_capture_id=excluded.served_capture_id,
                full_coverage=excluded.full_coverage, slot_state=excluded.slot_state`).run(
                        sessionId,
                        id,
                        fullCoverage ? 1 : 0,
                    );
                    return id;
                })
                .immediate(),
        );
    } catch (error) {
        throw new ServedMarkerWriteError(error);
    }
}

/** Call inside the same transaction that hides or deletes the slot. */
export function recordServedSlotState(db: Database, sessionId: string, reason: string): void {
    db.prepare(`INSERT INTO lkg_served_markers
        (session_id, served_capture_id, full_coverage, slot_state) VALUES (?, 1, 0, ?)
        ON CONFLICT(session_id) DO UPDATE SET slot_state=excluded.slot_state`).run(
        sessionId,
        reason,
    );
}

export type LkgDurability =
    | { durable: true; servedCaptureId: number | null }
    | { durable: true; servedCaptureId: null; certified: false }
    | { durable: false; reason: "no_frontier"; slotState: string }
    | { durable: false; reason: "lkg_not_durable" };

/** The draining caller checks this before freezing or reading the frontier. */
export function checkLkgDurability(
    db: Database,
    sessionId: string,
    options: { compactionOff?: boolean } = {},
): LkgDurability {
    // Native compaction owns the prompt, so no MC prefix guarantee is available,
    // even if an older managed pass left a marker in this session's history.
    if (options.compactionOff) return { durable: true, servedCaptureId: null, certified: false };
    return db
        .transaction(() => {
            const marker = readServedMarker(db, sessionId);
            const slot = db
                .prepare("SELECT served_capture_id FROM lkg_slots WHERE session_id=?")
                .get(sessionId) as { served_capture_id: number | null } | undefined;
            if (!marker && !slot) return { durable: true, servedCaptureId: null } as const;
            if (marker?.slotState !== undefined && marker.slotState !== "captured")
                return {
                    durable: false,
                    reason: "no_frontier",
                    slotState: marker.slotState,
                } as const;
            if (marker && !marker.fullCoverage)
                return {
                    durable: false,
                    reason: "no_frontier",
                    slotState: "partial_capture",
                } as const;
            if (marker && slot?.served_capture_id === marker.servedCaptureId)
                return { durable: true, servedCaptureId: marker.servedCaptureId } as const;
            return { durable: false, reason: "lkg_not_durable" } as const;
        })
        .deferred();
}

/** Repair only the latest served in-memory slot; never hydrate/export an older one. */
export function repairLkgDurability(db: Database, sessionId: string): LkgDurability {
    const status = checkLkgDurability(db, sessionId);
    if (status.durable || status.reason !== "lkg_not_durable") return status;
    const marker = readServedMarker(db, sessionId);
    const slot = getInMemorySlot(sessionId);
    if (
        slot &&
        marker &&
        slot.servedCaptureId === marker.servedCaptureId &&
        !isRustMarkerAdmissionFenced(db, sessionId)
    ) {
        saveLkgSlotToDb(db, sessionId, slot, { force: true });
    }
    return checkLkgDurability(db, sessionId);
}

/**
 * Move-fence ownership stays with the caller: return only its open sessions in
 * draining, never frozen/import-gated sessions. Stop on host disposal. Polling
 * repairs without rewriting the marker or starting a new capture.
 */
export function startLkgDurabilityPoll(
    db: Database,
    drainingSessionIds: () => readonly string[],
    onError: (error: unknown) => void,
): () => void {
    const timer = setInterval(() => {
        try {
            for (const sessionId of drainingSessionIds()) repairLkgDurability(db, sessionId);
        } catch (error) {
            onError(error);
        }
    }, 1000);
    timer.unref();
    return () => clearInterval(timer);
}
