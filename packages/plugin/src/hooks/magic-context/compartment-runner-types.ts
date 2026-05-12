import type { PluginContext } from "../../plugin/types";
import type { Database } from "../../shared/sqlite";
import type { NotificationParams } from "./send-session-notification";

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
    /** Resolved fallback chain for historian-family calls (historian + compressor). */
    fallbackModels?: readonly string[];
    directory: string;
    historyBudgetTokens?: number;
    fallbackModelId?: string;
    getNotificationParams?: () => NotificationParams;
    /** When true, inject compaction markers into OpenCode's DB after publication */
    experimentalCompactionMarkers?: boolean;
    /** When true, extract user behavior observations from historian output */
    experimentalUserMemories?: boolean;
    /** When true, inject wall-clock dates on compartments in <session-history>. */
    experimentalTemporalAwareness?: boolean;
    /** When true, run an editor pass after successful historian output to clean
     *  low-signal U: lines and cross-compartment duplicates. */
    historianTwoPass?: boolean;
    /** Compressor floor ratio: floor = ceil(lastEndMessage / minCompartmentRatio). */
    compressorMinCompartmentRatio?: number;
    /** Compressor max merge depth (1-5). Compartments at or above this depth are skipped. */
    compressorMaxMergeDepth?: number;
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
    /**
     * When true, publication preserves the in-memory injection cache until a
     * later materializing pass consumes the deferred refresh.
     */
    preserveInjectionCacheUntilConsumed?: boolean;
}

export interface CandidateCompartment {
    sequence: number;
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
    title: string;
    content: string;
}

export interface HistorianRunResult {
    ok: boolean;
    result?: string;
    error?: string;
    dumpPath?: string;
}

export type ValidatedHistorianPassResult =
    | {
          ok: true;
          compartments: CandidateCompartment[];
          facts: Array<{ category: string; content: string }>;
          userObservations?: string[];
      }
    | { ok: false; error: string };

export interface StoredCompartmentRange {
    startMessage: number;
    endMessage: number;
}

export interface HistorianProgressCallbacks {
    onRepairRetry?: (error: string) => Promise<void>;
}
