import { isRustMarkerAdmissionFenced } from "../../features/magic-context/storage-replay-document";
import { sessionLog } from "../../shared/logger";
import { type Database, withSqliteBackgroundWriter } from "../../shared/sqlite";
import { saveLkgSlotToDb } from "./lkg-persist";
import { captureSlot, getInMemorySlot } from "./lkg-slot";

export interface ServedMarker {
    servedCaptureId: number;
    fullCoverage: boolean;
    slotState: string;
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
 * Certification is optional: a short writer acquisition or any marker failure
 * returns no id, so the eventual slot row is durably uncertified without changing
 * whether its request can be served.
 */
export function recordServedCapture(
    db: Database,
    sessionId: string,
    fullCoverage: boolean,
): number | undefined {
    try {
        return withSqliteBackgroundWriter(() =>
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
        sessionLog(sessionId, "LKG capture served without move certification:", error);
        return undefined;
    }
}

/** Best-effort marker update inside the transaction that hides or deletes the slot. */
export function recordServedSlotState(db: Database, sessionId: string, reason: string): void {
    try {
        db.prepare(`INSERT INTO lkg_served_markers
            (session_id, served_capture_id, full_coverage, slot_state) VALUES (?, 1, 0, ?)
            ON CONFLICT(session_id) DO UPDATE SET slot_state=excluded.slot_state`).run(
            sessionId,
            reason,
        );
    } catch (error) {
        // The actual replay invalidation still follows its existing strict/best-
        // effort rules; failure of an optional move marker must not change them.
        sessionLog(sessionId, "LKG slot state lost move certification:", error);
    }
}

export type LkgDurability =
    | { durable: true; servedCaptureId: number | null; certified?: true }
    | { durable: true; servedCaptureId: null; certified: false }
    | { durable: false; reason: "no_frontier"; slotState: string };

/** The draining caller checks this before freezing or reading the frontier. */
export function checkLkgDurability(
    db: Database,
    sessionId: string,
    options: { compactionOff?: boolean } = {},
): LkgDurability {
    if (options.compactionOff) return { durable: true, servedCaptureId: null, certified: false };
    return db
        .transaction(() => {
            const marker = readServedMarker(db, sessionId);
            const slot = db
                .prepare("SELECT served_capture_id FROM lkg_slots WHERE session_id=?")
                .get(sessionId) as { served_capture_id: number | null } | undefined;
            if (!marker && !slot) return { durable: true, servedCaptureId: null } as const;
            const matched = marker && slot?.served_capture_id === marker.servedCaptureId;
            // A previous marker cannot describe a newer uncertified slot, including
            // its coverage or drop reason. Null ids never borrow the old certificate.
            if (slot && !matched)
                return { durable: true, servedCaptureId: null, certified: false } as const;
            if (marker?.slotState !== undefined && marker.slotState !== "captured")
                return {
                    durable: false,
                    reason: "no_frontier",
                    slotState: marker.slotState,
                } as const;
            if (matched && !marker.fullCoverage)
                return {
                    durable: false,
                    reason: "no_frontier",
                    slotState: "partial_capture",
                } as const;
            if (matched) return { durable: true, servedCaptureId: marker.servedCaptureId } as const;
            return { durable: true, servedCaptureId: null, certified: false } as const;
        })
        .deferred();
}

/**
 * After passes and queued captures settle, certify only the owner's final in-memory
 * capture. Never hydrate an older disk slot to manufacture a live certificate.
 * A missing marker may be allocated here; failures simply leave the move uncertified.
 */
export function repairLkgDurability(db: Database, sessionId: string): LkgDurability {
    const status = checkLkgDurability(db, sessionId);
    const slot = getInMemorySlot(sessionId);
    if (!slot || isRustMarkerAdmissionFenced(db, sessionId)) return status;
    if (!status.durable && slot.servedCaptureId !== undefined) return status;
    if (
        status.durable &&
        status.certified !== false &&
        status.servedCaptureId === slot.servedCaptureId
    )
        return status;
    const marker = readServedMarker(db, sessionId);
    if (
        slot.servedCaptureId !== undefined &&
        (marker?.servedCaptureId !== slot.servedCaptureId || marker.slotState !== "captured")
    )
        return { durable: true, servedCaptureId: null, certified: false };
    const fullCoverage =
        slot.fullCoverage ??
        (slot.servedCaptureId !== undefined && slot.servedCaptureId === marker?.servedCaptureId
            ? marker.fullCoverage
            : undefined);
    if (fullCoverage === undefined)
        return { durable: true, servedCaptureId: null, certified: false };
    const id = slot.servedCaptureId ?? recordServedCapture(db, sessionId, fullCoverage);
    if (id === undefined) return { durable: true, servedCaptureId: null, certified: false };
    const certifiedSlot = { ...slot, servedCaptureId: id, fullCoverage };
    if (!captureSlot(sessionId, certifiedSlot))
        return { durable: true, servedCaptureId: null, certified: false };
    saveLkgSlotToDb(db, sessionId, certifiedSlot, { force: true });
    return checkLkgDurability(db, sessionId);
}

/**
 * Move-fence ownership stays with the caller: return only its open sessions in
 * draining, never frozen/import-gated sessions, and only after passes and queued
 * capture callbacks settle. Stop on host disposal. Polling can certify an unmarked
 * final capture, but never advances capture_sequence or changes served bytes.
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
