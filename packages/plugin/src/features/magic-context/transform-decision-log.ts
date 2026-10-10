import { sessionLog } from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { configureContextDatabasePragmas } from "../../shared/sqlite-context-pragmas";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { getDatabasePath } from "./storage-db";

export type TransformDecisionHarness = "opencode" | "pi";
export type TransformSchedulerDecision =
    | "execute"
    | "defer"
    | "error"
    | "need_full_sync"
    | "parked"
    | "passthrough"
    | "unknown";

/**
 * Max transform_decisions rows kept per (session_id, harness). Pruned newest-first
 * after every insert so a long session's cache-affecting passes never grow this
 * telemetry table without bound (the dashboard loads all matching rows for cause
 * attribution).
 */
export const TRANSFORM_DECISIONS_RETENTION = 2000;

export type CanonicalMaterializeReason =
    | "system_hash"
    | "model_change"
    | "project_memory_epoch"
    | "ttl_idle"
    | "explicit_flush"
    | "max_mutation_id"
    | "first_render"
    | "pressure_refold"
    | "upgrade_state"
    | "cached_m1_missing"
    | "project_change"
    | "compartment_render_epoch"
    | "m1_delta"
    | "ttl_expiry"
    | "epoch_change"
    | "coverage_fold"
    | "profile_transition"
    | "host_compaction";

export interface PendingTransformDecision {
    tsMs: number;
    decision: TransformSchedulerDecision;
    materialized: boolean;
    materializeReason: CanonicalMaterializeReason | null;
    /**
     * `transform_decisions.system_hash_prev`: cached operand from a system-hash
     * comparison. NULL means this pass made no system-hash comparison; an empty
     * string is a real compared cached value and must remain distinct from NULL.
     */
    systemHashPrev: string | null;
    /**
     * `transform_decisions.system_hash_new`: live operand from a system-hash
     * comparison. NULL means this pass made no system-hash comparison.
     */
    systemHashNew: string | null;
    /**
     * `transform_decisions.m0_model_key_prev`: cached canonical model-key operand.
     * NULL means this pass made no model-key comparison; an empty string is a real
     * compared cached value and must remain distinct from NULL.
     */
    m0ModelKeyPrev: string | null;
    /**
     * `transform_decisions.m0_model_key_new`: live canonical model-key operand.
     * NULL means this pass made no model-key comparison.
     */
    m0ModelKeyNew: string | null;
    /**
     * `transform_decisions.m0_tool_set_hash_prev`: cached tool-set operand from
     * an observed comparison. NULL means this pass made no tool-set comparison;
     * an empty string is a real compared cached value.
     */
    m0ToolSetHashPrev?: string | null;
    /**
     * `transform_decisions.m0_tool_set_hash_new`: live tool-set operand from an
     * observed comparison. NULL means this pass made no tool-set comparison.
     */
    m0ToolSetHashNew?: string | null;
    emergency: boolean;
    /**
     * Nonnegative estimate persisted as `transform_decisions.dropped_tokens` for
     * diagnostics only. It does not drive budgeting or scheduler decisions.
     */
    droppedTokens: number;
    droppedCount: number;
    inputTokens: number;
    bustedThisPass: boolean;
}

interface TransformDecisionRow extends PendingTransformDecision {
    sessionId: string;
    harness: TransformDecisionHarness;
    messageId: string;
}

interface PendingPiTransformDecision extends PendingTransformDecision {
    snapshotNewestAssistantEntryId: string | null;
    publicationGuard?: () => void;
}

type TransformDecisionWriter = (dbPath: string, row: TransformDecisionRow) => void;

const canonicalReasons = new Set<string>([
    "system_hash",
    "model_change",
    "project_memory_epoch",
    "ttl_idle",
    "explicit_flush",
    "max_mutation_id",
    "first_render",
    "pressure_refold",
    "upgrade_state",
    "cached_m1_missing",
    "project_change",
    "compartment_render_epoch",
    "m1_delta",
    "ttl_expiry",
    "epoch_change",
    "coverage_fold",
    "profile_transition",
    "host_compaction",
]);

const piReasonAliases: Record<string, CanonicalMaterializeReason> = {
    project_memory_change: "project_memory_epoch",
    pending_mutations: "max_mutation_id",
    renderer_upgrade: "upgrade_state",
    cache_invalid: "cached_m1_missing",
    drift: "pressure_refold",
};

const sharedReasonAliases: Record<string, CanonicalMaterializeReason> = {
    model_key: "model_change",
    pressure: "pressure_refold",
};

const pendingDecisionBySession = new Map<string, PendingTransformDecision>();
const pendingPiDecisionBySession = new Map<string, PendingPiTransformDecision>();
const lastBoundMessageIdBySession = new Map<string, string>();
const scheduledWriteTokensBySession = new Map<string, Set<symbol>>();

let writerOverrideForTests: TransformDecisionWriter | null = null;

// Tests override the retention cap so the prune can be exercised with a handful
// of rows instead of writing TRANSFORM_DECISIONS_RETENTION+ rows (each opening a
// fresh DB connection), which timed out under CI load. The prune SQL is
// cap-agnostic (LIMIT ?), so a small cap verifies identical behavior.
let retentionOverrideForTests: number | null = null;

export function normalizeMaterializeReason(
    harness: TransformDecisionHarness,
    reason: string | null | undefined,
    rematerialized: boolean,
): CanonicalMaterializeReason | null {
    const raw = typeof reason === "string" ? reason.trim() : "";
    if (raw.length > 0) {
        const alias =
            sharedReasonAliases[raw] ??
            (harness === "pi" ? piReasonAliases[raw] : undefined) ??
            undefined;
        if (alias) return alias;
        if (canonicalReasons.has(raw)) return raw as CanonicalMaterializeReason;
        return null;
    }

    // OpenCode's pressure refold flips rematerialized=true without changing
    // mustMaterialize().reason. Pi records the same path as "drift" above, but
    // keep this fallback for cross-harness parity and future callers.
    return rematerialized ? "pressure_refold" : null;
}

/**
 * Stage one Rust pass for the assistant message that will receive its provider usage row.
 * The transform runs before that assistant exists, so binding to the newest input message
 * attributes a multi-step pass to the previous step. The ordinary OpenCode event path binds
 * this pending record to the next completed assistant id.
 */
export function writeRustTransformDecision(args: {
    sessionId: string;
    decision: string;
    materializeReason: string | null;
    inputTokens: number;
    tsMs?: number;
}): void {
    const rawDecision = args.decision.trim();
    const decisionUpper = rawDecision.toUpperCase();
    const mapped =
        decisionUpper === "HARD" || decisionUpper === "MIGRATE_HARD"
            ? { decision: "execute" as const, materialized: true, bustedThisPass: true }
            : decisionUpper === "SOFT" ||
                decisionUpper === "EXECUTE" ||
                args.materializeReason === "ttl_idle"
              ? { decision: "execute" as const, materialized: false, bustedThisPass: true }
              : decisionUpper === "SOFT+"
                ? { decision: "defer" as const, materialized: false, bustedThisPass: false }
                : {
                      decision: (rawDecision.toLowerCase() ||
                          "unknown") as TransformSchedulerDecision,
                      materialized: false,
                      bustedThisPass: false,
                  };
    pendingDecisionBySession.set(args.sessionId, {
        tsMs: args.tsMs ?? Date.now(),
        decision: mapped.decision,
        materialized: mapped.materialized,
        materializeReason: args.materializeReason as CanonicalMaterializeReason | null,
        systemHashPrev: null,
        systemHashNew: null,
        m0ModelKeyPrev: null,
        m0ModelKeyNew: null,
        m0ToolSetHashPrev: null,
        m0ToolSetHashNew: null,
        emergency: false,
        droppedTokens: 0,
        droppedCount: 0,
        inputTokens: args.inputTokens,
        bustedThisPass: mapped.bustedThisPass,
    });
}

export function clearOpenCodePendingTransformDecision(sessionId: string): void {
    pendingDecisionBySession.delete(sessionId);
}

export function clearTransformDecisionSession(sessionId: string): void {
    pendingDecisionBySession.delete(sessionId);
    pendingPiDecisionBySession.delete(sessionId);
    lastBoundMessageIdBySession.delete(sessionId);
    scheduledWriteTokensBySession.delete(sessionId);
}

export function recordPendingTransformDecision(
    sessionId: string,
    decision: PendingTransformDecision,
): void {
    if (!decision.bustedThisPass) {
        pendingDecisionBySession.delete(sessionId);
        return;
    }
    pendingDecisionBySession.set(sessionId, decision);
}

export function recordPendingPiTransformDecision(
    sessionId: string,
    decision: PendingTransformDecision,
    snapshotNewestAssistantEntryId: string | null,
    publicationGuard?: () => void,
): void {
    publicationGuard?.();
    if (!decision.bustedThisPass) return;
    pendingPiDecisionBySession.set(sessionId, {
        ...decision,
        snapshotNewestAssistantEntryId,
        publicationGuard,
    });
}

export function scheduleOpenCodeTransformDecisionWrite(args: {
    db: Database;
    sessionId: string;
    messageId: string;
    inputTokens: number;
}): boolean {
    const pending = pendingDecisionBySession.get(args.sessionId);
    if (!pending) return false;
    if (lastBoundMessageIdBySession.get(args.sessionId) === args.messageId) {
        return false;
    }
    const dbPath = getDatabasePath(args.db);
    if (!dbPath) return false;

    lastBoundMessageIdBySession.set(args.sessionId, args.messageId);
    pendingDecisionBySession.delete(args.sessionId);
    const token = addScheduledWriteToken(args.sessionId);
    setTimeout(() => {
        try {
            if (!hasScheduledWriteToken(args.sessionId, token)) return;
            writeTransformDecisionBestEffort(dbPath, {
                ...pending,
                sessionId: args.sessionId,
                harness: "opencode",
                messageId: args.messageId,
                inputTokens: args.inputTokens,
            });
        } finally {
            deleteScheduledWriteToken(args.sessionId, token);
        }
    }, 0);
    return true;
}

export function findNewestPiAssistantEntryId(
    entries: readonly unknown[] | null | undefined,
): string | null {
    if (!Array.isArray(entries)) return null;
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!entry || typeof entry !== "object") continue;
        const row = entry as { id?: unknown; type?: unknown; message?: unknown };
        if (row.type !== "message" || typeof row.id !== "string" || row.id.length === 0) {
            continue;
        }
        const message = row.message;
        if (
            message &&
            typeof message === "object" &&
            (message as { role?: unknown }).role === "assistant"
        ) {
            return row.id;
        }
    }
    return null;
}

export function schedulePiTransformDecisionResolve(args: {
    db: Database;
    sessionId: string;
    branchEntries: readonly unknown[] | null;
    assertCurrentPass?: () => void;
}): boolean {
    const pending = pendingPiDecisionBySession.get(args.sessionId);
    if (!pending) return false;
    try {
        pending.publicationGuard?.();
        args.assertCurrentPass?.();
    } catch {
        pendingPiDecisionBySession.delete(args.sessionId);
        sessionLog(args.sessionId, "DISCARDED CONTEXT RESULT: pending Pi transform decision");
        return false;
    }
    const targetMessageId = findNewestPiAssistantEntryIdAfter(
        args.branchEntries,
        pending.snapshotNewestAssistantEntryId,
    );
    if (!targetMessageId) return false;
    const dbPath = getDatabasePath(args.db);
    if (!dbPath) return false;

    pendingPiDecisionBySession.delete(args.sessionId);
    const token = addScheduledWriteToken(args.sessionId);
    setTimeout(() => {
        try {
            if (!hasScheduledWriteToken(args.sessionId, token)) return;
            try {
                pending.publicationGuard?.();
                args.assertCurrentPass?.();
            } catch {
                sessionLog(
                    args.sessionId,
                    "DISCARDED CONTEXT RESULT: queued Pi transform decision",
                );
                return;
            }
            writeTransformDecisionBestEffort(dbPath, {
                ...pending,
                sessionId: args.sessionId,
                harness: "pi",
                messageId: targetMessageId,
            });
        } finally {
            deleteScheduledWriteToken(args.sessionId, token);
        }
    }, 0);
    return true;
}

function addScheduledWriteToken(sessionId: string): symbol {
    const token = Symbol(sessionId);
    let tokens = scheduledWriteTokensBySession.get(sessionId);
    if (!tokens) {
        tokens = new Set();
        scheduledWriteTokensBySession.set(sessionId, tokens);
    }
    tokens.add(token);
    return token;
}

function hasScheduledWriteToken(sessionId: string, token: symbol): boolean {
    return scheduledWriteTokensBySession.get(sessionId)?.has(token) === true;
}

function deleteScheduledWriteToken(sessionId: string, token: symbol): void {
    const tokens = scheduledWriteTokensBySession.get(sessionId);
    if (!tokens) return;
    tokens.delete(token);
    if (tokens.size === 0) scheduledWriteTokensBySession.delete(sessionId);
}

function findNewestPiAssistantEntryIdAfter(
    entries: readonly unknown[] | null,
    snapshotNewestAssistantEntryId: string | null,
): string | null {
    if (!Array.isArray(entries)) return null;

    // Bind only to an assistant entry positioned AFTER the snapshot. A pure
    // value-skip backward scan misattributes when NO new assistant has arrived
    // yet (the branch still ends at the snapshot): it would skip the snapshot by
    // value and fall back to an OLDER assistant, recording THIS pass's cache
    // decision against the wrong message. Resolve the snapshot's INDEX first, then
    // return the first assistant after it. If the snapshot id is absent (compacted
    // away / reordered), refuse to bind (return null) — the pending row stays for
    // a later pass (at most one per session; overwritten by the next bust), never
    // attaching to an older entry.
    let startIndex = 0;
    if (snapshotNewestAssistantEntryId !== null) {
        let snapshotIndex = -1;
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (
                entry &&
                typeof entry === "object" &&
                (entry as { id?: unknown }).id === snapshotNewestAssistantEntryId
            ) {
                snapshotIndex = i;
                break;
            }
        }
        if (snapshotIndex === -1) return null;
        startIndex = snapshotIndex + 1;
    }

    for (let i = startIndex; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry || typeof entry !== "object") continue;
        const row = entry as { id?: unknown; type?: unknown; message?: unknown };
        if (row.type !== "message" || typeof row.id !== "string" || row.id.length === 0) {
            continue;
        }
        const message = row.message;
        if (
            message &&
            typeof message === "object" &&
            (message as { role?: unknown }).role === "assistant"
        ) {
            return row.id;
        }
    }
    return null;
}

function writeTransformDecisionBestEffort(dbPath: string, row: TransformDecisionRow): void {
    try {
        const writer = writerOverrideForTests ?? writeTransformDecisionRow;
        writer(dbPath, row);
    } catch {
        // Best-effort telemetry only. Never throw into OpenCode/Pi event or
        // context hooks; a locked/missing DB just drops this attribution row.
    }
}

function writeTransformDecisionRow(dbPath: string, row: TransformDecisionRow): void {
    const db = new Database(dbPath);
    try {
        db.exec("PRAGMA busy_timeout=0");
        configureContextDatabasePragmas(db);
        writeTransformDecisionRowOnDatabase(db, row, true);
    } finally {
        closeQuietly(db);
    }
}

function writeTransformDecisionRowOnDatabase(
    db: Database,
    row: TransformDecisionRow,
    configureBusyTimeout: boolean,
): void {
    if (configureBusyTimeout) db.exec("PRAGMA busy_timeout=0");
    // Trigger operands only describe a materialized baseline. Tool-set
    // comparison is different: it is deliberately observational rather than a
    // fold trigger, so its evidence must survive a non-materialized bust.
    const systemHashPrev = row.materialized ? row.systemHashPrev : null;
    const systemHashNew = row.materialized ? row.systemHashNew : null;
    const m0ModelKeyPrev = row.materialized ? row.m0ModelKeyPrev : null;
    const m0ModelKeyNew = row.materialized ? row.m0ModelKeyNew : null;
    const m0ToolSetHashPrev = row.m0ToolSetHashPrev ?? null;
    const m0ToolSetHashNew = row.m0ToolSetHashNew ?? null;
    db.prepare(
        `INSERT OR REPLACE INTO transform_decisions (
                session_id, harness, message_id, ts_ms, decision, materialized,
                materialize_reason, system_hash_prev, system_hash_new,
                m0_tool_set_hash_prev, m0_tool_set_hash_new,
                m0_model_key_prev, m0_model_key_new, emergency, dropped_tokens,
                dropped_count, input_tokens
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        row.sessionId,
        row.harness,
        row.messageId,
        row.tsMs,
        row.decision,
        row.materialized ? 1 : 0,
        row.materializeReason,
        systemHashPrev,
        systemHashNew,
        m0ToolSetHashPrev,
        m0ToolSetHashNew,
        m0ModelKeyPrev,
        m0ModelKeyNew,
        row.emergency ? 1 : 0,
        Math.max(0, Math.floor(row.droppedTokens)),
        Math.max(0, Math.floor(row.droppedCount)),
        Math.max(0, Math.floor(row.inputTokens)),
    );
    // Enforce the per-(session,harness) retention cap so a long session's
    // cache-affecting passes can't grow this telemetry table unbounded (the
    // dashboard loads all matching rows for cause attribution). Keep the
    // newest TRANSFORM_DECISIONS_RETENTION rows by (ts_ms, rowid). Best-effort
    // on the same non-blocking handle; a failure just defers the prune.
    db.prepare(
        `DELETE FROM transform_decisions
             WHERE session_id = ? AND harness = ?
               AND rowid NOT IN (
                 SELECT rowid FROM transform_decisions
                 WHERE session_id = ? AND harness = ?
                 ORDER BY ts_ms DESC, rowid DESC
                 LIMIT ?
               )`,
    ).run(
        row.sessionId,
        row.harness,
        row.sessionId,
        row.harness,
        retentionOverrideForTests ?? TRANSFORM_DECISIONS_RETENTION,
    );
}

export const __test = {
    getPending(sessionId: string): PendingTransformDecision | undefined {
        return pendingDecisionBySession.get(sessionId);
    },
    getPendingPi(sessionId: string): PendingPiTransformDecision | undefined {
        return pendingPiDecisionBySession.get(sessionId);
    },
    reset(): void {
        pendingDecisionBySession.clear();
        pendingPiDecisionBySession.clear();
        lastBoundMessageIdBySession.clear();
        scheduledWriteTokensBySession.clear();
        writerOverrideForTests = null;
        retentionOverrideForTests = null;
    },
    setWriterForTests(writer: TransformDecisionWriter | null): void {
        writerOverrideForTests = writer;
    },
    setRetentionForTests(cap: number | null): void {
        retentionOverrideForTests = cap;
    },
    writeRow(dbPath: string, row: TransformDecisionRow): void {
        writeTransformDecisionRow(dbPath, row);
    },
    findNewestPiAssistantEntryIdAfter,
};
