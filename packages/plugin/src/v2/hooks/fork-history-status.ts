import { validateStoredCompartments } from "../../hooks/magic-context/compartment-runner-validation";
import { nonNarrativeStoredGapRanges } from "../../hooks/magic-context/stored-compartment-gaps";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { sessionLog } from "../../shared/logger";
import { isTuiConnected, pushNotification } from "../../shared/rpc-notifications";
import type { Database } from "../../shared/sqlite";
import { renderUserFacingFailure } from "../../shared/user-facing-codes";
import type { V2StoreReader } from "../store-reader";
import { readV2MessageRange } from "./store";

const logged = new Set<string>();
const toasted = new Set<string>();
const isGap = (error: string | null) => error?.startsWith("gap before message ") === true;
const diagnoses = new WeakMap<Database, BoundedSessionMap<{ key: string; gap: boolean }>>();

/** Display only. Reuse the diagnosis until the saved summary ranges change. */
export function readForkHistoryGap(
    db: Database,
    openReader: () => V2StoreReader,
    sessionID: string,
): boolean {
    const rows = db
        .prepare(`SELECT sequence, start_message AS startMessage, end_message AS endMessage,
        rebase_status AS rebaseStatus FROM compartments WHERE session_id = ? ORDER BY sequence`)
        .all(sessionID) as {
        sequence: number;
        startMessage: number;
        endMessage: number;
        rebaseStatus: string;
    }[];
    // The historian can still repair an unresolved row itself. Only diagnose
    // a missing range, and don't open the host store for ordinary histories.
    if (
        !isGap(validateStoredCompartments(rows)) ||
        rows.some(({ rebaseStatus }) => rebaseStatus === "unresolved")
    ) {
        diagnoses.get(db)?.delete(sessionID);
        return false;
    }
    let cache = diagnoses.get(db);
    if (!cache) {
        cache = new BoundedSessionMap(1000);
        diagnoses.set(db, cache);
    }
    const key = JSON.stringify(rows);
    const cached = cache.get(sessionID);
    let gap = cached?.key === key ? cached.gap : undefined;
    if (gap === undefined) {
        const reader = openReader();
        try {
            gap =
                Boolean(reader.forkOrigin(sessionID)) &&
                isGap(
                    validateStoredCompartments(
                        rows,
                        nonNarrativeStoredGapRanges(db, sessionID, rows, (from, to) =>
                            readV2MessageRange(reader, sessionID, from, to),
                        ),
                    ),
                );
        } finally {
            reader.close();
        }
        cache.set(sessionID, { key, gap });
    }
    if (!gap) return false;
    if (!logged.has(sessionID)) {
        logged.add(sessionID);
        sessionLog(sessionID, "v2 fork saved history has a gap; /ctx-recomp repairs this fork");
    }
    if (!toasted.has(sessionID) && isTuiConnected(sessionID)) {
        toasted.add(sessionID);
        // The status line is authoritative. Don't replay a toast on reconnect
        // after the user may already have repaired the gap.
        pushNotification(
            "toast",
            { message: renderUserFacingFailure("fork_history_gap", "plain"), variant: "warning" },
            sessionID,
            { liveOnly: true },
        );
    }
    return true;
}
