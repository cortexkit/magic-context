import { sessionLog } from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { configureContextDatabasePragmas } from "../../shared/sqlite-context-pragmas";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { getDatabasePath } from "./storage-db";

export type TransformDecisionHarness = "opencode" | "opencode2" | "pi";
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
    | "user_flush"
    | "fit_retry"
    | "pending_materialization"
    | "variant_change"
    | "recomp"
    | "boundary_repair"
    | "host_history_change"
    | "thinking_hold"
    | "mutation_drift"
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
    | "host_compaction"
    | "tag_identity_repair"
    // The provider rejected the latest assistant turn's thinking and the pass
    // removed that thinking: bytes change from that turn on, nothing before it.
    | "latest_turn_thinking_removed";

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
    /** Why the host stopped serving its frozen last-known-good replay, persisted in materialize_reason without a schema change. */
    lkgFrozenReleaseReason?: string;
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
    "user_flush",
    "fit_retry",
    "pending_materialization",
    "variant_change",
    "recomp",
    "boundary_repair",
    "host_history_change",
    "thinking_hold",
    "mutation_drift",
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
    "tag_identity_repair",
    "latest_turn_thinking_removed",
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
const scheduledWriteWaitersBySession = new Map<string, Set<() => void>>();

/**
 * A changed system prompt rewrites the provider's whole prompt cache on the
 * first request that carries it, whatever Magic Context did to the messages.
 * The pass that served that request may not have changed any message bytes
 * itself (a deferred pass in the middle of a tool loop, or a Rust raw
 * pass-through), so it would stage no decision, or one naming an unrelated
 * reason. The system hook marks the session here and the decision bound to
 * that request's assistant names `system_hash`, unless the provider cache had
 * already expired from idle time on that request. In-memory only: nothing is
 * written to the database until a decision is bound to an assistant message.
 */
const systemHashChangedSessions = new Set<string>();
const piSystemHashChangedSessions = new Set<string>();
/**
 * The latest OpenCode TypeScript pass that changed no message bytes. It stages
 * no row by itself; it only supplies the scheduler decision when a system
 * prompt change needs a row for that pass. Cleared when a pass starts.
 */
const unbustedPassBySession = new Map<string, PendingTransformDecision>();
/**
 * Newest assistant id in the input of the latest OpenCode 1 messages pass. Only
 * a reply newer than this can answer that pass's request, so a late completion
 * event for an earlier reply never takes a system prompt change's cause.
 * OpenCode message ids sort by creation time.
 */
const newestInputAssistantBySession = new Map<string, string>();
/**
 * OpenCode 2 has no per-message completion event. A pass's decision is kept
 * with the store sequence captured before the request was sent, and the next
 * context pass binds it to the first assistant written after that sequence.
 */
const stagedV2DecisionBySession = new Map<
    string,
    { decision: PendingTransformDecision; responseAfterSequence: number }
>();

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
    lkgFrozenReleaseReason?: string;
}): void {
    const rawDecision = args.decision.trim();
    const decisionUpper = rawDecision.toUpperCase();
    const scheduled =
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
    // Removing the latest turn's thinking after a provider rejection changes
    // bytes on whatever the module decided; the scheduler decision stays as is.
    const mapped =
        args.materializeReason === "latest_turn_thinking_removed"
            ? { ...scheduled, bustedThisPass: true }
            : scheduled;
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
        lkgFrozenReleaseReason: args.lkgFrozenReleaseReason,
    });
}

export function clearOpenCodePendingTransformDecision(
    sessionId: string,
    inputMessages?: readonly { info?: { id?: unknown; role?: unknown } }[],
): void {
    pendingDecisionBySession.delete(sessionId);
    unbustedPassBySession.delete(sessionId);
    if (!inputMessages) return;
    let newestAssistant = "";
    for (const message of inputMessages) {
        const id = message.info?.id;
        if (message.info?.role !== "assistant" || typeof id !== "string") continue;
        if (id > newestAssistant) newestAssistant = id;
    }
    newestInputAssistantBySession.set(sessionId, newestAssistant);
}

export function clearTransformDecisionSession(sessionId: string): void {
    pendingDecisionBySession.delete(sessionId);
    pendingPiDecisionBySession.delete(sessionId);
    lastBoundMessageIdBySession.delete(sessionId);
    scheduledWriteTokensBySession.delete(sessionId);
    for (const resolve of scheduledWriteWaitersBySession.get(sessionId) ?? []) resolve();
    scheduledWriteWaitersBySession.delete(sessionId);
    systemHashChangedSessions.delete(sessionId);
    piSystemHashChangedSessions.delete(sessionId);
    unbustedPassBySession.delete(sessionId);
    newestInputAssistantBySession.delete(sessionId);
    stagedV2DecisionBySession.delete(sessionId);
}

/**
 * Called by the OpenCode system hook (OpenCode 1 and 2) when the system prompt
 * hash differs from the stored one. The decision for the request that carries
 * the new prompt then names `system_hash`, whether or not its pass busted.
 */
export function noteSystemPromptHashChange(sessionId: string): void {
    systemHashChangedSessions.add(sessionId);
}

/** Pi counterpart of {@link noteSystemPromptHashChange}, set in before_agent_start. */
export function notePiSystemPromptHashChange(sessionId: string): void {
    piSystemHashChangedSessions.add(sessionId);
}

/** True while a Pi system prompt change still waits for its pass's decision. */
export function hasPendingPiSystemPromptHashChange(sessionId: string): boolean {
    return piSystemHashChangedSessions.has(sessionId);
}

/**
 * Remember an OpenCode TypeScript pass that staged no decision, so a system
 * prompt change on the same request can still record that pass's scheduler
 * decision. Memory only.
 */
export function noteOpenCodeUnbustedPass(
    sessionId: string,
    decision: PendingTransformDecision,
): void {
    unbustedPassBySession.set(sessionId, decision);
}

/**
 * Reasons meaning the provider's cached prompt had already expired from idle
 * time before this request was sent. That request rebuilds the provider cache
 * whatever else changed, so a system prompt change arriving on the same request
 * costs nothing extra: the expiry keeps the cause.
 */
const IDLE_EXPIRY_REASONS: ReadonlySet<CanonicalMaterializeReason | null> = new Set([
    "ttl_idle",
    "ttl_expiry",
]);

/**
 * The decision recorded for a request that carried a changed system prompt.
 * `system_hash` becomes the cause unless the pass already named an idle expiry:
 * then the provider cache was dead before the new prompt arrived, and the row
 * keeps a single cause column, so the expiry stays the recorded reason.
 */
function withSystemHashReason(decision: PendingTransformDecision): PendingTransformDecision {
    if (IDLE_EXPIRY_REASONS.has(decision.materializeReason)) return decision;
    return { ...decision, materializeReason: "system_hash" };
}

/** A row for a request whose pass left no decision of its own (for example an early return). */
function unknownPassDecision(): PendingTransformDecision {
    return {
        tsMs: Date.now(),
        decision: "unknown",
        materialized: false,
        materializeReason: null,
        systemHashPrev: null,
        systemHashNew: null,
        m0ModelKeyPrev: null,
        m0ModelKeyNew: null,
        emergency: false,
        droppedTokens: 0,
        droppedCount: 0,
        inputTokens: 0,
        bustedThisPass: false,
    };
}

/**
 * The decision to record for the request now being bound, or undefined when
 * none applies. Without a system prompt change this is exactly the staged
 * busting decision. With one, the request rewrote the provider cache anyway,
 * so it always gets a row, built from the staged decision, else the pass's
 * unbusted decision, else an `unknown` placeholder. The row names `system_hash`
 * unless the pass named an idle expiry (see withSystemHashReason).
 */
function takeOpenCodeDecisionForBinding(
    sessionId: string,
    applySystemHashChange: boolean,
): PendingTransformDecision | undefined {
    const pending = pendingDecisionBySession.get(sessionId);
    const unbusted = unbustedPassBySession.get(sessionId);
    pendingDecisionBySession.delete(sessionId);
    unbustedPassBySession.delete(sessionId);
    if (!applySystemHashChange || !systemHashChangedSessions.has(sessionId)) return pending;
    systemHashChangedSessions.delete(sessionId);
    return withSystemHashReason(pending ?? unbusted ?? unknownPassDecision());
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
    // A system prompt change noted in before_agent_start belongs to the first
    // main context pass after it: that pass serves the request that rewrites the
    // provider's prompt cache, so it records a row whether or not it busted.
    const systemHashChanged = piSystemHashChangedSessions.delete(sessionId);
    if (!decision.bustedThisPass && !systemHashChanged) return;
    pendingPiDecisionBySession.set(sessionId, {
        ...(systemHashChanged ? withSystemHashReason(decision) : decision),
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
    // Message ids sort by creation time. A reply whose id is not newer than the
    // newest assistant id in the latest messages pass's input was already part of
    // that input, so it answers an earlier request; a repeated or late completion
    // event for it must not take the system prompt change.
    const newestInput = newestInputAssistantBySession.get(args.sessionId) ?? "";
    const systemHashChanged =
        args.messageId > newestInput && systemHashChangedSessions.has(args.sessionId);
    if (!pendingDecisionBySession.has(args.sessionId) && !systemHashChanged) return false;
    if (lastBoundMessageIdBySession.get(args.sessionId) === args.messageId) {
        return false;
    }
    const dbPath = getDatabasePath(args.db);
    if (!dbPath) return false;

    const pending = takeOpenCodeDecisionForBinding(args.sessionId, systemHashChanged);
    if (!pending) return false;
    lastBoundMessageIdBySession.set(args.sessionId, args.messageId);
    const token = addScheduledWriteToken(args.sessionId);
    inRootAsyncContext(() =>
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
        }, 0),
    );
    return true;
}

/** The parts of an OpenCode 2 assistant row that the decision binder reads. */
export interface V2DecisionAssistant {
    id: string;
    /** `running` while the reply has neither a failure marker nor a completion. */
    state: "succeeded" | "failed" | "running";
    inputTokens: number;
}

/**
 * OpenCode 2, after a context pass served its request: keep the decision
 * OpenCode 1 would bind to that request's assistant. That is a busting pass's
 * decision, or any pass of a request that carried a system prompt change. A
 * non-busting pass keeps nothing, so ordinary passes never write a row.
 * `responseAfterSequence` is the store's newest sequence captured before the
 * request was sent; the reply is the first assistant written after it.
 */
export function stageOpenCodeV2TransformDecision(args: {
    sessionId: string;
    responseAfterSequence: number | undefined;
}): boolean {
    const systemHashChanged = systemHashChangedSessions.has(args.sessionId);
    const decision = takeOpenCodeDecisionForBinding(args.sessionId, true);
    // A newer pass replaces an unbound decision: that earlier request's reply
    // never completed, and its row is dropped rather than bound to a later reply.
    stagedV2DecisionBySession.delete(args.sessionId);
    if (!decision || args.responseAfterSequence === undefined) return false;
    if (!decision.bustedThisPass && !systemHashChanged) return false;
    stagedV2DecisionBySession.set(args.sessionId, {
        decision,
        responseAfterSequence: args.responseAfterSequence,
    });
    return true;
}

/**
 * OpenCode 2: write the staged decision against the reply to its request.
 * Called when a context pass starts (`passStarting`, so the staged request is
 * over) and after an execution succeeds. Binds only a successful reply; a
 * failed or aborted reply, or no reply by the time the next pass starts, drops
 * the decision so it can never attach to another request's message.
 */
export function bindOpenCodeV2TransformDecision(args: {
    db: Database;
    sessionId: string;
    firstAssistantAfter: (sequence: number) => V2DecisionAssistant | undefined;
    passStarting: boolean;
}): boolean {
    const staged = stagedV2DecisionBySession.get(args.sessionId);
    if (!staged) return false;
    const reply = args.firstAssistantAfter(staged.responseAfterSequence);
    if (!reply || reply.state === "running") {
        if (args.passStarting) stagedV2DecisionBySession.delete(args.sessionId);
        return false;
    }
    stagedV2DecisionBySession.delete(args.sessionId);
    if (reply.state === "failed") return false;
    const dbPath = getDatabasePath(args.db);
    if (!dbPath) return false;
    const token = addScheduledWriteToken(args.sessionId);
    inRootAsyncContext(() =>
        setTimeout(() => {
            try {
                if (!hasScheduledWriteToken(args.sessionId, token)) return;
                writeTransformDecisionBestEffort(dbPath, {
                    ...staged.decision,
                    sessionId: args.sessionId,
                    harness: "opencode2",
                    messageId: reply.id,
                    inputTokens: Number.isFinite(reply.inputTokens)
                        ? reply.inputTokens
                        : staged.decision.inputTokens,
                });
            } finally {
                deleteScheduledWriteToken(args.sessionId, token);
            }
        }, 0),
    );
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
    inRootAsyncContext(() =>
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
        }, 0),
    );
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
    if (tokens.size === 0) {
        scheduledWriteTokensBySession.delete(sessionId);
        for (const resolve of scheduledWriteWaitersBySession.get(sessionId) ?? []) resolve();
        scheduledWriteWaitersBySession.delete(sessionId);
    }
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
    const persistedMaterializeReason = row.lkgFrozenReleaseReason
        ? `lkg_frozen_release:${row.lkgFrozenReleaseReason}` +
          (row.materializeReason ? `;materialize_reason=${row.materializeReason}` : "")
        : row.materializeReason;
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
        persistedMaterializeReason,
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
    /** Resolves after the queued decision callbacks finish, including their database writes. */
    waitForWrites(sessionId: string): Promise<void> {
        if (!scheduledWriteTokensBySession.has(sessionId)) return Promise.resolve();
        return new Promise((resolve) => {
            let waiters = scheduledWriteWaitersBySession.get(sessionId);
            if (!waiters) {
                waiters = new Set();
                scheduledWriteWaitersBySession.set(sessionId, waiters);
            }
            waiters.add(resolve);
        });
    },
    getPending(sessionId: string): PendingTransformDecision | undefined {
        return pendingDecisionBySession.get(sessionId);
    },
    getPendingPi(sessionId: string): PendingPiTransformDecision | undefined {
        return pendingPiDecisionBySession.get(sessionId);
    },
    getStagedV2(sessionId: string): PendingTransformDecision | undefined {
        return stagedV2DecisionBySession.get(sessionId)?.decision;
    },
    hasSystemHashChange(sessionId: string): boolean {
        return systemHashChangedSessions.has(sessionId);
    },
    reset(): void {
        for (const waiters of scheduledWriteWaitersBySession.values())
            for (const resolve of waiters) resolve();
        scheduledWriteWaitersBySession.clear();
        pendingDecisionBySession.clear();
        pendingPiDecisionBySession.clear();
        lastBoundMessageIdBySession.clear();
        scheduledWriteTokensBySession.clear();
        systemHashChangedSessions.clear();
        piSystemHashChangedSessions.clear();
        unbustedPassBySession.clear();
        newestInputAssistantBySession.clear();
        stagedV2DecisionBySession.clear();
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

import { inRootAsyncContext } from "../../shared/sqlite";
