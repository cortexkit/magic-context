import { withMessageFtsSessionFilter } from "../../features/magic-context/message-fts-session-filter";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { runSessionWarmupWorker } from "../../hooks/magic-context/raw-ordinal-warmup";
import {
    hasRawMessageProvider,
    rawMessageOffThreadRangeReader,
    rawMessageWorkerSource,
    readRawSessionMessageIdOrdinalsForRange,
} from "../../hooks/magic-context/read-session-chunk";
import { openCodeDbExists, withReadOnlySessionDb } from "../../hooks/magic-context/read-session-db";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { getSqliteDatabasePath } from "../../shared/sqlite";
import { readV2ArchiveOffThread } from "./v2-archive-reader";

interface ArchiveRow {
    ordinal: number;
    id: string;
    role: string;
    content: string;
}

let archiveReadsOnThisThread = 0;

/** @internal Counts every archive render so tests can detect accidental serving-thread reads. */
export function getArchiveReadsOnThisThreadForTest(): number {
    return archiveReadsOnThisThread;
}

/** Recover indexed text when the host no longer holds the cited messages. */
export function renderSearchArchive(
    db: ContextDatabase,
    sessionId: string,
    start: number,
    end: number,
    tokenBudget: number,
    archiveOnly = false,
    readRawIds = () => readRawSessionMessageIdOrdinalsForRange(sessionId, start, end),
): string | null {
    archiveReadsOnThisThread += 1;
    return withMessageFtsSessionFilter(db, sessionId, (sessionFirst) => {
        let rawIds: Map<string, number> | undefined;
        // The sidecar bounds modern stores to this session and ordinal range. A
        // legacy store can still have unmapped FTS rows, so retain a direct read.
        const rows = db.prepare(
            sessionFirst
                ? `SELECT f.message_ordinal AS ordinal, f.message_id AS id, f.role, f.content
                   FROM message_fts_rowid_map AS m
                   JOIN message_history_fts AS f ON f.rowid = m.fts_rowid
                   WHERE m.session_id = ?1 AND m.message_ordinal BETWEEN ?2 AND ?3
                     AND f.session_id = ?1 AND f.message_ordinal BETWEEN ?2 AND ?3
                   ORDER BY m.message_ordinal`
                : `SELECT message_ordinal AS ordinal, message_id AS id, role, content
                   FROM message_history_fts
                   WHERE session_id = ?1 AND message_ordinal BETWEEN ?2 AND ?3
                   ORDER BY CAST(message_ordinal AS INTEGER)`,
        );
        const blocks: string[] = [];
        let tokens = 0;
        let lastOrdinal = start - 1;
        let truncated = false;
        for (const row of rows.iterate(sessionId, start, end) as Iterable<ArchiveRow>) {
            if (!row.content) continue;
            if (!archiveOnly) {
                rawIds ??= readRawIds();
                if (rawIds.get(row.id) === row.ordinal) continue;
            }
            const block = `[${row.ordinal}] ${row.role === "user" ? "U" : "A"}: ${row.content}`;
            const cost = estimateTokens(block);
            if (blocks.length > 0 && tokens + cost > tokenBudget) {
                truncated = true;
                break;
            }
            blocks.push(block);
            tokens += cost;
            lastOrdinal = row.ordinal;
        }
        if (blocks.length === 0) return null;
        const text = [
            "From the search archive: indexed text only; no surrounding messages or tool output.",
            "",
            ...blocks,
        ];
        if (truncated) {
            text.push(
                "",
                `Truncated at message ${lastOrdinal} (budget: ~${tokenBudget} tokens). Call ctx_expand(start=${lastOrdinal + 1}, end=${end}) for more archived text.`,
            );
        }
        return text.join("\n");
    });
}

/** File-backed archive and exact raw-ordinal scans must not run on the serving thread. */
export async function renderSearchArchiveOffThread(
    db: ContextDatabase,
    sessionId: string,
    start: number,
    end: number,
    tokenBudget: number,
    archiveOnly = false,
): Promise<string | null> {
    const path = getSqliteDatabasePath(db);
    const provider = hasRawMessageProvider(sessionId);
    const source = rawMessageWorkerSource(sessionId);
    const offThreadReader = rawMessageOffThreadRangeReader(sessionId);
    let rawIds: Map<string, number> | undefined;
    if (!archiveOnly && !source && offThreadReader) {
        try {
            rawIds = await offThreadReader(start, end);
        } catch (error) {
            throw new Error(`Search archive worker unavailable: ${String(error)}`);
        }
    }
    // Private in-memory archives cannot be reopened. Their archive rows are cheap
    // to read here, but a provider's raw store must still never be scanned here.
    if (!path) {
        return renderSearchArchive(
            db,
            sessionId,
            start,
            end,
            tokenBudget,
            archiveOnly,
            rawIds
                ? () => rawIds
                : provider
                  ? () => {
                        throw new Error(
                            "Search archive worker unavailable: private archive has no off-thread source",
                        );
                    }
                  : undefined,
        );
    }
    if (!archiveOnly && source) {
        return readV2ArchiveOffThread(path, source.path, sessionId, {
            kind: "archive",
            start,
            end,
            tokenBudget,
            archiveOnly,
        });
    }
    if (!archiveOnly && provider && !rawIds) {
        throw new Error(
            "Search archive worker unavailable: raw-message provider has no off-thread source",
        );
    }
    const rawPath =
        !archiveOnly && !provider && openCodeDbExists()
            ? withReadOnlySessionDb(getSqliteDatabasePath)
            : null;
    const result = await runSessionWarmupWorker(
        {
            path,
            sessionId,
            searchArchive: {
                start,
                end,
                tokenBudget,
                archiveOnly,
                rawPath,
                rawIds: rawIds ? [...rawIds] : undefined,
            },
        },
        {},
    );
    if ("searchArchive" in result) return result.searchArchive;
    // Falling back to a synchronous scan on worker failure recreates the stall.
    throw new Error(
        `Search archive worker unavailable: ${"failure" in result ? `${result.failure}: ${result.detail}` : "unexpected reply"}`,
    );
}
