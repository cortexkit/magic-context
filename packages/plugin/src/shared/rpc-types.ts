/**
 * Shared types for RPC between server and TUI plugins.
 * Both sides import these — no SQLite dependency.
 */

import type {
    DreamTaskBacklogMap,
    DreamTaskFailureState,
    DreamTaskName,
    DreamTaskProgress,
} from "../features/magic-context/dreamer/task-registry";
import type { DreamerTickFailure } from "../features/magic-context/dreamer/tick-failure";
import type { SynapseLaneDescriptor } from "../features/magic-context/memory/embedding-synapse";
import type { RunnerRefusalCanonicalCause } from "../hooks/magic-context/historian-no-fire-cause";
import type { ConfigParseFailure } from "./config-diagnostics";
import type { LoggerDiagnostics } from "./logger";
import type { UserFacingFailureKey } from "./user-facing-codes";

export interface TailHygieneStatus {
    /** Tokens in active, non-protected tail content that the agent can reclaim. */
    u: number;
    /** Spent tool outputs contributing positive tokens to U in this baseline. */
    reclaimableToolOutputCount?: number;
    /** Tokens in rendered-tail content eligible for hygiene accounting in the same scan. */
    t: number;
    /** Reclaimable-to-eligible token ratio, clamped to 0–1 and shared by both nudge mechanisms. */
    severity: number;
    /** False until a fresh scan runs after existing tail content changes, preventing stale measurements. */
    evaluable: boolean;
    generationInvalidated: boolean;
    baselineGeneration: number;
    computedAt: number;
}

export interface SidebarSnapshot {
    sessionId: string;
    usagePercentage: number;
    inputTokens: number;
    contextLimit: number;
    /**
     * Raw wire-input pressure against the resolved model window. This is separate
     * from Magic Context's execute threshold so native-compaction UI never shows
     * a threshold-relative fill percentage.
     */
    native_context_usage_percentage?: number;
    /**
     * Magic Context compaction mode is resolved at startup and sent in the
     * status-detail wire payload; snake_case matches that payload's field naming.
     */
    compaction_enabled?: boolean;
    systemPromptTokens: number;
    compartmentCount: number;
    /** Historical compartment rows retained while native compaction owns the window. */
    archivedCompartmentCount?: number;
    memoryCount: number;
    memoryBlockCount: number;
    pendingOpsCount: number;
    historianRunning: boolean;
    compartmentInProgress: boolean;
    sessionNoteCount: number;
    readySmartNoteCount: number;
    cacheTtl: string;
    /** Persistent runtime failure shown directly in the sidebar when non-null. */
    lastTransformError: string | null;
    /** Durable history-compression failure count used to select the stable summary warning. */
    historianFailureCount?: number;
    lastDreamerRunAt: number | null;
    projectIdentity: string | null;
    compartmentTokens: number;
    factTokens: number;
    memoryTokens: number;
    /**
     * Token estimate of the injected <project-docs> block (root ARCHITECTURE.md
     * + STRUCTURE.md) that lives in m[0] in v2. Part of the message stream, not
     * conversation. Display layer shows this as "Docs".
     */
    docsTokens: number;
    /**
     * Token estimate of the injected <user-profile> block (promoted user
     * memories) that lives in m[0] in v2. Part of the message stream, not
     * conversation. Display layer shows this as "Profile".
     */
    profileTokens: number;
    /**
     * Token estimate of real user/assistant discussion (text + reasoning +
     * image parts) inside messages, excluding injected <session-history>,
     * <project-docs>, and <user-profile> blocks. Display layer shows this as
     * "Conversation".
     */
    conversationTokens: number;
    /**
     * Token estimate of tool call I/O inside messages (tool_use, tool_result,
     * tool, tool-invocation parts). Actionable — users can reduce via
     * ctx_reduce. Display layer shows this as "Tool Calls".
     */
    toolCallTokens: number;
    /**
     * Measured token cost of tool schemas (description + JSON-schema
     * parameters) OpenCode sends in the request `tools` parameter. Populated
     * by the `tool.definition` plugin hook, keyed by
     * `{providerID, modelID, agentName}`. Zero until the first turn after
     * plugin startup measures the current agent's tool set. Display layer
     * shows this as "Tool Definitions".
     */
    toolDefinitionTokens: number;
    /**
     * Named capabilities the host this plugin runs in does not have, such as an
     * experimental mode the host cannot carry. These persist for the life of
     * the process rather than describing one failed operation, so the status
     * surfaces keep showing them. Absent on hosts with nothing to report and on
     * older RPC servers.
     */
    hostLimitations?: UserFacingFailureKey[];
    /** Persisted reclaimable (U) and eligible (T) token counts used by both nudge mechanisms. */
    tailHygiene?: TailHygieneStatus;
    /**
     * Effective execute-threshold percentage for this session's active model,
     * after per-model resolution and the tokens→percentage conversion (when
     * `execute_threshold_tokens` applies). Surfaces in the sidebar / status
     * dialog header alongside `usagePercentage` so users can see how close
     * the session is to triggering compaction. Defaults to `65` when no live
     * model is known yet — matches the runtime fallback used by the
     * scheduler and transform paths.
     */
    executeThreshold: number;
    /**
     * True when `executeThreshold` was clamped down from a higher configured value
     * (tokens config above 90% × contextLimit, or a percentage above the 90% cap).
     * The sidebar/status dialog append a small marker so the user knows their
     * configured value was reduced rather than applied verbatim (issue #241).
     * Absent when no clamp occurred.
     */
    executeThresholdClamped?: boolean;
    /** Rust module cache boundary state, when the session uses Rust authority mode. */
    boundaryPresent?: boolean;
    coverageOrdinal?: number | null;
    newWorkTokens?: number | null;
    totalInputTokens?: number | null;
    /**
     * Live recomp progress for this session, or null when no recomp is running
     * (and no recent terminal state is being shown). Drives the sidebar progress
     * bar and the /ctx-status dialog. Mirrors the runtime `RecompProgress` shape
     * from compartment-runner-types.ts.
     */
    /** Read-only per-task candidate counts; populated by the server RPC. */
    dreamerBacklog?: DreamTaskBacklogMap;
    /** Process-local task progress; absent when no Dreamer task is running. */
    dreamerProgress?: DreamTaskProgress | null;
    /** Dreamer tasks whose last scheduled run failed. Empty when all of them are
     *  healthy; absent on a database with no scheduler table yet. */
    dreamerFailures?: DreamTaskFailureState[];
    recompProgress?: {
        /** "recomp" → "Recomp" labels; "upgrade" → "Upgrade" labels. */
        kind?: "recomp" | "upgrade" | "embed" | "wrapup";
        phase: "recomp" | "migration" | "done" | "failed" | "skipped";
        processedMessages: number;
        totalMessages: number;
        passCount: number;
        compartmentsCreated: number;
        message?: string;
        note?: string;
    } | null;
}

export interface MemoryImportanceHistogram {
    total: number;
    unclassified: number;
    bands: {
        "0-19": number;
        "20-39": number;
        "40-59": number;
        "60-79": number;
        "80-100": number;
    };
}

/**
 * Which side ran (or would run) a Rust-mode completion, and why: `configured`
 * when the user set the runner, `default_for_harness` when the harness chose it.
 * `observed` is `last_completion` for a completion that actually ran in the
 * module's current process, `resolved_for_route` when none has yet.
 */
export interface RunnerStatus {
    runner: "host" | "broca";
    source: "configured" | "default_for_harness";
    harness: string;
    observed: "last_completion" | "resolved_for_route";
}

export interface StatusDetail extends SidebarSnapshot {
    /** OpenCode 2 hidden-run model variants dropped because the host catalog did not declare them. */
    hiddenVariantWarnings?: string[];
    /** Runner refusal provenance reported by the Rust historian, including received text. */
    historianRefusal?: {
        stage: "credential" | "provider" | "model" | "resolution";
        canonicalCause: RunnerRefusalCanonicalCause;
        detail: string;
    };
    /** Which runner the Rust historian used for this session, and why. Rust mode only. */
    historianRunner?: RunnerStatus;
    /** Which runner the Rust module's dreamer completions resolve to, and why. Rust mode only. */
    dreamerRunner?: RunnerStatus;
    /** ACTIVE-memory importance distribution; unclassified is a subset of total. */
    memoryImportanceHistogram: MemoryImportanceHistogram;
    /**
     * Dreamer tasks this host cannot run because it has no tool loop, named so a
     * user can see which maintenance is unavailable instead of inferring it from
     * a backlog that never falls. Absent on a host that runs every task.
     */
    dreamerUnsupportedTasks?: DreamTaskName[];
    /**
     * The stage that stopped the last background maintenance pass, when one did.
     * Absent while the maintenance timer is completing its passes.
     */
    dreamerTickFailure?: DreamerTickFailure | null;
    /** True when Rust authority has rerouted host tool and historian paths to the module. */
    hostBackendsModuleSide?: boolean;
    /** Host cursor compared with the module changefeed frontier. */
    memoryMirror?: {
        cursor: number;
        cursorUpdatedAt: number | null;
        cursorAgeMs: number | null;
        liveRows: number;
        feedHead: number | null;
        pendingRows: number | null;
        stalled: boolean;
        code: "MC-M01" | null;
    };
    /** Health of the pending OpenCode history-boundary marker repair. */
    compactionMarker?: {
        code: "MC-C11" | null;
        attempts: number;
        lastError: string | null;
        pendingSinceMs: number | null;
    };
    /** A durable host marker whose live module status no longer reports module ownership. */
    memoryAuthorityMismatch?: boolean;
    /** User-owned model profile selected for this project, or null for the base config. */
    activeProfile: string | null;
    configGeneration?: number;
    configAdoptedAt?: number;
    configReloadFailure?: { path: string; message: string };
    tagCounter: number;
    activeTags: number;
    droppedTags: number;
    totalTags: number;
    /** False when Rust authority supplies only the exact total; active/dropped host-mirror
     *  counts are not presented as module truth. Omitted by older RPC servers means true. */
    tagCountsAuthoritative?: boolean;
    activeBytes: number;
    lastResponseTime: number;
    lastNudgeTokens: number;
    lastTransformError: string | null;
    isSubagent: boolean;
    pendingOps: Array<{ tagId: number; operation: string }>;
    contextLimit: number;
    windowGeometry?: {
        usableSoft: number;
        usableHard: number;
        geometry: "shared_upfront" | "shared_truncating" | "separate";
        derivation: {
            window: number;
            reserve: number;
            reserveSource: "output_catalog" | "output_config" | "wall_margin" | "none";
            geometry: "shared_upfront" | "shared_truncating" | "separate";
            windowSource: "catalog" | "overlay" | "provider" | "detected";
            absoluteWall: number;
        };
    };
    /**
     * Parsed cache TTL in ms. -1 = never expires (cacheTtl "never"; Infinity
     * cannot ride JSON-RPC and 0 would be indistinguishable from unset). The
     * values discriminate without the cacheNeverExpires flag: -1 never /
     * N live. Falsy-value contract: see storage_versions for the precedent.
     */
    cacheTtlMs: number;
    /** Remaining ms in the idle-TTL window. -1 = never expires; 0 = expired
     *  (only meaningful when lastResponseTime > 0); N = live countdown. */
    cacheRemainingMs: number;
    cacheExpired: boolean;
    /** Reports whether the displayed TTL came from config, persisted session metadata,
     *  or the default; cache scheduling still uses the TTL stored in session metadata. */
    cacheTtlSource?: "config" | "session" | "default";
    cacheTtlModelKey?: string;
    configParseFailures?: ConfigParseFailure[];
    /** True when cacheTtl is "never" — the idle-TTL heuristic is disabled on
     *  this lane. Redundant with cacheTtlMs === -1; kept as the readable form. */
    cacheNeverExpires?: boolean;
    executeThreshold: number;
    /**
     * Which config source produced `executeThreshold`. "tokens" means
     * execute_threshold_tokens matched for this session's model and was
     * converted to a percentage. "percentage" means percentage config was used.
     */
    executeThresholdMode: "percentage" | "tokens";
    /**
     * When `executeThresholdMode === "tokens"`, the absolute clamped token value
     * (≤ 80% × contextLimit) that will trigger execute. Undefined in percentage mode.
     */
    executeThresholdTokens?: number;
    protectedTagCount: number;
    historyBudgetPercentage: number;
    historyBlockTokens: number;
    compressionBudget: number | null;
    compressionUsage: string | null;
    /** Effective configured toast duration in ms after config resolution. */
    toastDurationMs: number;
    /** One-line status data for the experimental memory mural. */
    mural?: { present: boolean; ageMs: number | null };
    /** Runtime logger write failures observed by this plugin process. */
    loggerDiagnostics: LoggerDiagnostics;
    /**
     * Stable storage-version probe: "which schema is the DB at, which fence does
     * this binary carry". Field names are deliberately snake_case, mirroring the
     * `storage_versions` block of the mc-module status envelope, so fleet probes
     * parse one shape across both surfaces. The module cannot read context.db
     * (the plugin owns it), so this surface supplies the live DB value; the module
     * surface supplies the module-store value instead.
     */
    /** Search-indexing coverage and current command state for the default status summary. */
    embedding?: {
        state: "off" | "running" | "paused" | "stopped" | "ready" | "waiting";
        indexed: number;
        total: number;
    };
    storage_versions: {
        /**
         * Persisted schema version of context.db (MAX of schema_migrations).
         * null = the version probe FAILED (read threw — broken/unreachable store);
         * 0 = probe succeeded on a fresh DB without a migrations table. Distinct so
         * readers never conflate broken-with-empty (fleet status-surface contract).
         */
        context_db_schema_version: number | null;
        /** Highest context.db schema version this plugin build supports. */
        plugin_supported_version: number;
    };
}

/** Embedding coverage for `/ctx-embed` status (mirrors getEmbeddingCoverageStatus). */
export interface EmbedDetail {
    enabled: boolean;
    model: string;
    provider: string;
    synapseDescriptor?: SynapseLaneDescriptor;
    session: { embedded: number; total: number };
    memories: { embedded: number; total: number };
    commits: { embedded: number; total: number; gitEnabled: boolean };
    statusText: string;
}

export interface DebugProcessMemoryUsage {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
}

export interface DebugSessionHolderCount {
    sessionId: string;
    lkgBytes: number;
    taggerAssignments: number;
    taggerToolAccounting: number;
    wireRawMessages: number;
    wireMessages: number;
    wireContentSnapshots: number;
    wireEstimatedBytes: number;
}

export interface DebugMemoryHolders {
    lkgSlots: {
        count: number;
        totalBytes: number;
    };
    taggerCache: {
        sessionCount: number;
        assignmentEntries: number;
        toolAccountingEntries: number;
        loadSignatureEntries: number;
    };
    wireCache: {
        snapshots: number;
        rawContentSnapshots: number;
        estimatedBytes: number;
    };
    compartmentMirrors: {
        entries: number;
    };
    messageIndexQueue: {
        queueLength: number;
        reconciliationScheduled: number;
        incrementalTimers: number;
        pendingIncremental: number;
        activeSessionLocks: number;
        completedIncrementalKeys: number;
        activeBufferMessages: number;
        activeBufferBytes: number;
    };
    sessions: DebugSessionHolderCount[];
}

export interface DebugSqliteConnectionMemoryStats {
    sequence: number;
    filename: string;
    readonly: boolean;
    pageSize: number | null;
    pageCount: number | null;
    freelistCount: number | null;
    cacheSize: number | null;
    cacheSizeUnit: "pages" | "kib" | null;
    cacheUpperBoundBytes: number | null;
    mmapSizeBytes: number | null;
    walFileBytes: number | null;
    shmFileBytes: number | null;
    fts5TableCount: number | null;
    journalMode: string | null;
}

export interface DebugNativeMemoryUsage {
    sqlite: {
        connectionCount: number;
        cacheUpperBoundBytes: number;
        mmapUpperBoundBytes: number;
        walFileBytes: number;
        shmFileBytes: number;
        sqliteStatusApi: "unavailable";
        connections: DebugSqliteConnectionMemoryStats[];
    };
    tokenizer: {
        loaded: boolean;
        loadAttempted: boolean;
        tableBytes: number | null;
        tablePath: string | null;
    };
    localEmbedding: {
        loaded: boolean;
        providerCount: number;
        models: string[];
        runtimes: Array<"native" | "wasm">;
        modelCacheBytes: number | null;
        rssDeltaAtLoad: number;
        externalDeltaAtLoad: number;
        arrayBuffersDeltaAtLoad: number;
    };
    quickJs: {
        loadAttempted: boolean;
        loaded: boolean;
    };
}

export interface DebugMemoryUsageResponse {
    pid: number;
    bunVersion: string;
    memoryUsage: DebugProcessMemoryUsage;
    native: DebugNativeMemoryUsage;
    holders: DebugMemoryHolders;
}

export interface DebugHeapSnapshotResponse extends DebugMemoryUsageResponse {
    path: string;
    format: "jsc" | "v8";
    snapshotVersion?: number;
}

export interface RpcNotificationMessage {
    id: number;
    type: string;
    payload: Record<string, unknown>;
    sessionId?: string;
}
