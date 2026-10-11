import type { Database } from "../../shared/sqlite";
import { ensureSessionMetaRow } from "./storage-meta-shared";

const PREFIX = "pi-content-replay-v1:";
export const PI_CONTENT_DECISION_LIMIT = 4096;
export type PiContentDecisionKind = "reminder-strip" | "seam-temporal-strip";

export function encodePiContentDecision(kind: PiContentDecisionKind, messageId: string): string {
    return PREFIX + JSON.stringify([kind, messageId]);
}

export function decodePiContentDecision(value: string): [PiContentDecisionKind, string] | null {
    if (!value.startsWith(PREFIX)) return null;
    try {
        const pair: unknown = JSON.parse(value.slice(PREFIX.length));
        if (
            Array.isArray(pair) &&
            pair.length === 2 &&
            (pair[0] === "reminder-strip" || pair[0] === "seam-temporal-strip") &&
            typeof pair[1] === "string" &&
            pair[1].length > 0
        )
            return [pair[0], pair[1]];
    } catch {
        // Malformed records are never instructions to strip text.
    }
    return null;
}

function readEntries(raw: string | null): string[] {
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
        throw new Error("Invalid persisted Pi content decision set");
    }
    return parsed;
}

export function getPiContentDecisions(db: Database, sessionId: string): Set<string> {
    const row = db
        .prepare(
            "SELECT merged_reasoning_stripped_ids AS decisions FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as { decisions: string | null } | undefined;
    return new Set(
        readEntries(row?.decisions ?? null).filter(
            (value) => decodePiContentDecision(value) !== null,
        ),
    );
}

/** Persist before changing bytes. A full ledger declines new cleanup rather than evicting live replay choices. */
export function freezePiContentDecision(
    db: Database,
    sessionId: string,
    kind: PiContentDecisionKind,
    messageId: string,
): boolean {
    try {
        ensureSessionMetaRow(db, sessionId);
        const entry = encodePiContentDecision(kind, messageId);
        return db
            .transaction(() => {
                for (let attempt = 0; attempt < 5; attempt++) {
                    const row = db
                        .prepare(
                            "SELECT merged_reasoning_stripped_ids AS decisions FROM session_meta WHERE session_id = ?",
                        )
                        .get(sessionId) as { decisions: string | null };
                    const current = readEntries(row.decisions);
                    if (current.includes(entry)) return true;
                    // Tags survive compartment projection; only actual deletion invalidates a choice.
                    const ownsTag = db.prepare(
                        "SELECT 1 FROM tags WHERE session_id = ? AND message_id = ? LIMIT 1",
                    );
                    const ownsMessage = db.prepare(
                        "SELECT 1 FROM tags WHERE session_id = ? AND message_id >= ? AND message_id < ? LIMIT 1",
                    );
                    const kept = current.filter((value) => {
                        const decision = decodePiContentDecision(value);
                        return (
                            !decision ||
                            !!(decision[0] === "seam-temporal-strip"
                                ? ownsMessage.get(sessionId, `${decision[1]}:p`, `${decision[1]}:q`)
                                : ownsTag.get(sessionId, decision[1]))
                        );
                    });
                    if (
                        kept.filter((value) => decodePiContentDecision(value) !== null).length >=
                        PI_CONTENT_DECISION_LIMIT
                    )
                        return false;
                    kept.push(entry);
                    const result = db
                        .prepare(
                            "UPDATE session_meta SET merged_reasoning_stripped_ids = ? WHERE session_id = ? AND merged_reasoning_stripped_ids IS ?",
                        )
                        .run(JSON.stringify(kept), sessionId, row.decisions);
                    if (result.changes > 0) return true;
                }
                return false;
            })
            .immediate();
    } catch (error) {
        // No caller changes served bytes until this durable decision succeeds.
        if (/database (?:table )?is locked|sqlite_(busy|locked)/i.test(String(error))) return false;
        throw error;
    }
}

/**
 * Remove one stored content decision (for example a `reminder-strip`) whose text edit was
 * refused after the decision was recorded. Replay applies every stored decision on later
 * passes, so a leftover one would change text that was sent unchanged. Returns false when
 * another writer kept changing the stored list across all retries.
 */
export function withdrawPiContentDecision(
    db: Database,
    sessionId: string,
    kind: PiContentDecisionKind,
    messageId: string,
): boolean {
    const entry = encodePiContentDecision(kind, messageId);
    return db
        .transaction(() => {
            for (let attempt = 0; attempt < 5; attempt++) {
                const row = db
                    .prepare(
                        "SELECT merged_reasoning_stripped_ids AS decisions FROM session_meta WHERE session_id = ?",
                    )
                    .get(sessionId) as { decisions: string | null } | undefined;
                if (!row) return true;
                const current = readEntries(row.decisions);
                if (!current.includes(entry)) return true;
                const result = db
                    .prepare(
                        "UPDATE session_meta SET merged_reasoning_stripped_ids = ? WHERE session_id = ? AND merged_reasoning_stripped_ids IS ?",
                    )
                    .run(
                        JSON.stringify(current.filter((value) => value !== entry)),
                        sessionId,
                        row.decisions,
                    );
                if (result.changes > 0) return true;
            }
            return false;
        })
        .immediate();
}
