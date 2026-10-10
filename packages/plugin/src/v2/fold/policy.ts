import { randomUUID } from "node:crypto";
import type { V2Context } from "../hooks/types";
import type { StoreRow, V2StoreReader } from "../store-reader";
import type { NativeFoldCache } from "./memory-cache";
import { isLocalCheckpoint } from "./native-replay";
import { foldDigest } from "./owner";

interface Attempt {
    after: number;
    watermark: number;
    attempt: number;
    id: string;
    before: number;
    started: number;
}

/** Process-local queue admissions. Only the claimant in this plugin instance can
 * dispatch or report settlement. If the host substitutes another pending request,
 * this instance must not report that other request's checkpoint as its own fold.
 */
export class HostFoldPolicy {
    private readonly active = new Set<string>();
    private readonly owner = randomUUID();
    constructor(
        private readonly deps: {
            session: Pick<V2Context["session"], "compact" | "wait">;
            storage: NativeFoldCache;
            openReader(): V2StoreReader;
            canReplay(sessionID: string, reader: V2StoreReader): Promise<boolean>;
            threshold: number;
            log(sessionID: string, line: string): void;
            now?: () => number;
        },
    ) {}
    private owned(sessionID: string, cut: StoreRow<"compaction">, id: string): boolean {
        const row = this.deps.storage.admission(sessionID, id);
        if (
            !isLocalCheckpoint(cut) ||
            cut.id !== id ||
            !row?.payload ||
            row.digest !== foldDigest(row.payload)
        )
            return false;
        const snapshot = JSON.parse(row.payload) as {
            summary: string;
            source: string;
            sessionID: string;
            admissionID: string;
        };
        return (
            snapshot.summary === cut.data.summary &&
            snapshot.source === this.deps.storage.sourceID &&
            snapshot.sessionID === sessionID &&
            snapshot.admissionID === id
        );
    }
    async idle(sessionID: string): Promise<void> {
        const { storage, session, threshold } = this.deps;
        if (
            !Number.isSafeInteger(threshold) ||
            threshold <= 0 ||
            typeof session.compact !== "function" ||
            this.active.has(sessionID)
        )
            return;
        this.active.add(sessionID);
        const now = this.deps.now ?? Date.now;
        let attempt: Attempt | undefined;
        let claimed = false;
        try {
            const reader = this.deps.openReader();
            try {
                const cut = reader.latestCompaction(sessionID);
                const previous = storage.latestAttempt(sessionID);
                const old = previous ? (JSON.parse(previous.data) as Attempt) : undefined;
                // A cut is the session's latest completed compaction checkpoint in
                // the host store. If it is the one a still-pending attempt asked for,
                // settle that attempt here, before the row-threshold test: a
                // completed cut leaves too few rows after it to nominate again
                // (request another fold with session.compact), so the threshold
                // test would return early and the attempt would never be settled.
                if (
                    cut &&
                    previous?.status === "pending" &&
                    old &&
                    this.owned(sessionID, cut, old.id)
                ) {
                    if (
                        (await storage.claim(
                            sessionID,
                            old.id,
                            previous.data,
                            this.owner,
                            now(),
                        )) &&
                        (await storage.finish(sessionID, old.id, this.owner, "completed", now()))
                    )
                        this.deps.log(
                            sessionID,
                            `v2 host fold: rows_before=${old.before} rows_after=${reader.storedRowsAfter(sessionID, cut.seq)} duration_ms=${now() - old.started} reason=row_threshold id=${cut.id} status=completed`,
                        );
                    return;
                }
                const after = cut?.seq ?? -1;
                const before = reader.storedRowsAfter(sessionID, after);
                if (before < threshold || !(await this.deps.canReplay(sessionID, reader))) return;
                const retry =
                    old?.after === after
                        ? old.attempt +
                          (previous?.status === "failed" || previous?.status === "coalesced"
                              ? 1
                              : 0)
                        : 0;
                const id =
                    old?.after === after && previous?.status === "pending"
                        ? old.id
                        : `msg_mc_fold_${foldDigest(`${storage.sourceID}/${sessionID}/${after}/${retry}`).slice(0, 24)}`;
                attempt = {
                    after,
                    before,
                    watermark: reader.latestSequence(sessionID),
                    attempt: retry,
                    id,
                    started: now(),
                };
                claimed = await storage.claim(
                    sessionID,
                    id,
                    JSON.stringify(attempt),
                    this.owner,
                    now(),
                );
                if (!claimed) return;
            } finally {
                reader.close();
            }
            const admitted = (await session.compact({
                sessionID,
                id: attempt.id,
                delivery: "queue",
            })) as { id?: string } | undefined;
            await session.wait({ sessionID });
            const settled = this.deps.openReader();
            try {
                const cut = settled.latestCompaction(sessionID);
                if (
                    admitted?.id !== attempt.id ||
                    !cut ||
                    cut.seq <= attempt.after ||
                    !this.owned(sessionID, cut, attempt.id)
                ) {
                    if (await storage.finish(sessionID, attempt.id, this.owner, "coalesced", now()))
                        this.deps.log(
                            sessionID,
                            `v2 host fold: rows_before=${attempt.before} rows_after=unknown duration_ms=${now() - attempt.started} reason=row_threshold id=${attempt.id} actual_id=${cut?.id ?? admitted?.id ?? "unknown"} status=coalesced`,
                        );
                    return;
                }
                const after = settled.storedRowsAfter(sessionID, cut.seq);
                if (await storage.finish(sessionID, attempt.id, this.owner, "completed", now()))
                    this.deps.log(
                        sessionID,
                        `v2 host fold: rows_before=${attempt.before} rows_after=${after} duration_ms=${now() - attempt.started} reason=row_threshold id=${cut.id} status=completed`,
                    );
            } finally {
                settled.close();
            }
        } catch (error) {
            if (claimed && attempt) {
                let finished = false;
                try {
                    finished = await storage.finish(
                        sessionID,
                        attempt.id,
                        this.owner,
                        "failed",
                        now(),
                    );
                } catch {
                    finished = true;
                }
                if (finished)
                    this.deps.log(
                        sessionID,
                        `v2 host fold: rows_before=${attempt.before} rows_after=unknown duration_ms=${now() - attempt.started} reason=row_threshold id=${attempt.id} status=failed error=${JSON.stringify(String(error))}`,
                    );
            } else
                this.deps.log(
                    sessionID,
                    `v2 host fold: rows_before=unknown rows_after=unknown duration_ms=0 reason=row_threshold status=failed error=${JSON.stringify(String(error))} cache_error=${JSON.stringify(String(error))}`,
                );
        } finally {
            this.active.delete(sessionID);
        }
    }
}
