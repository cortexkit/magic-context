import type { PluginContext } from "../../plugin/types";
import type { Database } from "../../shared/sqlite";
import type { ParsedEvent } from "./compartment-parser";
import type { ProtectedTailBoundarySnapshot } from "./protected-tail-boundary";
import type { NotificationParams } from "./send-session-notification";

/**
 * Live progress for a running recomp / session-upgrade, surfaced in the TUI
 * sidebar + /ctx-status so users can watch a long rebuild instead of staring at
 * a single "started" toast. Lives in `LiveSessionState.recompProgressBySession`
 * (process-local, in-memory — if the process restarts mid-recomp the recomp
 * itself is interrupted, so losing the progress entry is correct).
 *
 *  - phase "recomp"    → rebuilding compartments; `processedMessages/totalMessages` drives the bar.
 *  - phase "migration" → recomp done, re-organizing project memories (indeterminate).
 *  - phase "done"      → finished successfully; `message` holds the summary. Auto-cleared after a grace period.
 *  - phase "failed"    → stopped without publishing; `message` holds the reason. Retained until next run.
 */
export interface RecompProgress {
    sessionId: string;
    /** Which user-facing flow this progress belongs to. `/ctx-recomp` rebuilds
     *  compartments and is labeled "Recomp"; `/ctx-session-upgrade` (legacy→v2 +
     *  memory migration) is labeled "Upgrade". Without this the sidebar/status
     *  hardcoded "Upgrade" wording for BOTH, so a plain recomp showed
     *  "Recomp / ✗ Upgrade failed" — a self-contradiction (dogfood 2026-06-04,
     *  a 0-compartment session in a project whose other sessions had them).
     *  Optional + defaults to "recomp" so runner-emitted per-pass entries (which
     *  don't know the flow) inherit the kind set by setRecompStarting. */
    kind?: "recomp" | "upgrade";
    /** "skipped" is a TRANSIENT non-failure outcome: the incremental historian
     *  briefly held the compartment-state lease (or another process is mutating
     *  it), so the run no-op'd. It renders neutrally with retry guidance and
     *  auto-clears, unlike red "failed" which persists. */
    phase: "recomp" | "migration" | "done" | "failed" | "skipped";
    /** Raw messages processed so far (the recomp loop's `offset`). */
    processedMessages: number;
    /** Total raw messages to reprocess (protected-tail start − 1). */
    totalMessages: number;
    /** Successful historian passes completed. */
    passCount: number;
    /** Compartments rebuilt so far this run. */
    compartmentsCreated: number;
    startedAt: number;
    updatedAt: number;
    /** Terminal summary/reason (done | failed). */
    message?: string;
    /** Transient status line for the active phase — e.g. "Starting…", "Running
     *  historian…", "Primary returned nothing — trying fallback sonnet-4.6…",
     *  "Repair retry…". Surfaced under the progress bar so a long/retrying pass
     *  shows live activity instead of a frozen bar. */
    note?: string;
}

export interface CompartmentRunnerDeps {
    client: PluginContext["client"];
    db: Database;
    sessionId: string;
    /**
     * Historian chunk budget — how much raw history historian processes per
     * call. Bounded by the HISTORIAN model's context window, not main's.
     * Derived via `deriveHistorianChunkTokens(historianContextLimit)`.
     */
    historianChunkTokens: number;
    historianTimeoutMs?: number;
    /** Immutable protected-tail boundary resolved by the trigger/force path. Tests may omit it and use the default-snapshot factory. */
    boundarySnapshot?: ProtectedTailBoundarySnapshot;
    /** Current resolved main-model context limit used to reject stale boundary snapshots after model switches. */
    currentContextLimit?: number;
    /** Resolved fallback chain for historian-family calls (historian + compressor). */
    fallbackModels?: readonly string[];
    directory: string;
    historyBudgetTokens?: number;
    fallbackModelId?: string;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void>;
    getNotificationParams?: () => NotificationParams;
    /** When true, extract user behavior observations from historian output */
    experimentalUserMemories?: boolean;
    /** When true, inject wall-clock dates on compartments in <session-history>. */
    experimentalTemporalAwareness?: boolean;
    /** When true, run an editor pass after successful historian output to clean
     *  low-signal U: lines and cross-compartment duplicates. */
    historianTwoPass?: boolean;
    /**
     * Cross-session memory feature gate (`memory.enabled` config). When false,
     * historian/recomp must NOT promote session facts into project memories
     * and must NOT generate or store embeddings. Issue #44.
     */
    memoryEnabled?: boolean;
    /**
     * Automatic-promotion gate (`memory.auto_promote` config). When false (and
     * memory is otherwise enabled), tools and search still work, but historian
     * does not auto-promote session facts to memories. Users can still write
     * memories explicitly via `ctx_memory write`. Issue #44.
     */
    autoPromote?: boolean;
    /**
     * Called after compartment state is published. The runner marks the active
     * run as published before invoking this callback.
     */
    onCompartmentStatePublished?: (sessionId: string) => void;
    /** Live recomp-phase progress callback (sidebar / status). The runner emits
     *  "recomp"-phase updates (start + each pass); the caller owns the migration
     *  and terminal (done/failed) phases. Best-effort, never throws into the loop. */
    onRecompProgress?: (progress: RecompProgress) => void;
    /**
     * When true, publication preserves the in-memory injection cache until a
     * later materializing pass consumes the deferred refresh.
     */
    preserveInjectionCacheUntilConsumed?: boolean;
    /**
     * Plan v6 §4: Called when historian/recomp publication wrote a pending
     * compaction-marker row in-transaction (deferring marker application to a
     * later materializing pass). Consumer (hook.ts) seeds
     * `liveSessionState.deferredHistoryRefreshSessions` so the next consuming
     * postprocess pass drains the pending blob and applies the marker.
     */
    onDeferredMarkerPending?: (sessionId: string) => void;
    /** Holder id for the DB-backed compartment-state lease guarding publish paths. */
    compartmentLeaseHolderId?: string;
    /**
     * Called synchronously the moment the runner commits to a REAL historian
     * pass — after every no-op early-return (stale/empty snapshot, nothing to
     * compact, drain-quota) and immediately before the first `await`. Lets
     * `startCompartmentAgent` distinguish a fire-and-forget run that actually
     * started from one that no-op'd synchronously, so a no-op does not leave
     * the rest of the transform pass believing a historian is in progress
     * (which would defer queued drop ops — the production livelock).
     */
    onHistorianRunStarted?: () => void;
}

export interface CandidateCompartment {
    sequence: number;
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
    title: string;
    /** v2: P1 tier text (mirror). v1/compressor: flat content. */
    content: string;
    /** v2 paraphrase tiers (model B). Null/undefined for v1/flat compartments.
     *  Nullability matches CompartmentInput so candidates and staging rows
     *  round-trip through each other without type friction. */
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    /** v2 decay-rate signal (1-100). Null/undefined for v1/flat. */
    importance?: number | null;
    /** v2 comma-separated activity types. Null/undefined for v1/flat. */
    episodeType?: string | null;
}

export interface HistorianRunResult {
    ok: boolean;
    result?: string;
    error?: string;
    dumpPath?: string;
    invocationId?: number;
}

export type ValidatedHistorianPassResult =
    | {
          ok: true;
          compartments: CandidateCompartment[];
          facts: Array<{ category: string; content: string }>;
          userObservations?: string[];
          /** v2: historian-extracted events (stored, not rendered). */
          events?: ParsedEvent[];
          /**
           * Subagent-invocation id of the model attempt that actually produced
           * this validated output (primary, repair, editor, or fallback). The
           * caller uses it as the exact `historian_runs.subagent_invocation_id`
           * FK so the telemetry row joins to the right tokens/model — a kind-
           * filtered "latest invocation" lookup mislinks recomp passes (recorded
           * under subagent='recomp') to a stale subagent='historian' row.
           */
          invocationId?: number | null;
      }
    | { ok: false; error: string; invocationId?: number | null };

export interface StoredCompartmentRange {
    startMessage: number;
    endMessage: number;
}

export interface HistorianProgressCallbacks {
    onRepairRetry?: (error: string) => Promise<void>;
    /** Fired before each fallback model attempt in `runFallbackHistorianPass`
     *  (after the primary + repair failed). `modelId` is the model about to be
     *  tried; `index`/`total` describe its position in the fallback chain. Lets
     *  the caller surface "trying fallback X…" in live progress. */
    onModelFallback?: (modelId: string, index: number, total: number) => void;
}
