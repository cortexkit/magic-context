import { clearEmergencyRecovery } from "../../features/magic-context/storage-meta-persisted";
import type { PluginContext } from "../../plugin/types";
import { sessionLog } from "../../shared/logger";
import type { ModelInput } from "../../shared/model-resolution";
import type { Database } from "../../shared/sqlite";
import { renderUserFacingFailure, userFacingFailureCode } from "../../shared/user-facing-codes";
import { executeContextRecomp, type PartialRecompRange } from "./compartment-runner";
import type {
    CompartmentRunnerDeps,
    HiddenCompletionExecutor,
    RecompProgress,
} from "./compartment-runner-types";
import type { LiveSessionState } from "./live-session-state";
import { dropSlot } from "./lkg-slot";
import type { NotificationParams } from "./send-session-notification";

/** Resolve the live session model as a "provider/modelID" key for the last-ditch
 *  historian fallback. Returns undefined when the session's model isn't known yet. */
function resolveLiveModelKey(
    liveSessionState: LiveSessionState,
    sessionId: string,
): string | undefined {
    const model = liveSessionState.liveModelBySession.get(sessionId);
    return model ? `${model.providerID}/${model.modelID}` : undefined;
}

/**
 * Single source of truth for recomp orchestration.
 *
 * Before this module there were diverged implementations — the RPC `recomp`
 * handler and the hook-side `executeRecomp` closure (used by `/ctx-recomp`).
 * They drifted: the RPC handler had live progress but no model fallback, while
 * the hook path had fallback but no progress, so the same request behaved
 * differently depending on which surface started it.
 *
 * `runManagedRecomp` gives EVERY caller the full set: fallback resilience
 * (config chain + live-session-model last resort), live progress (sidebar /
 * status), and consistent terminal-state + messaging.
 */

/** Config-shape-agnostic context. Callers resolve config values and pass them
 *  in, so this module never couples to the loose RPC config record vs the typed
 *  hook config. */
export interface ManagedRecompContext {
    client: PluginContext["client"];
    /** Optional executor for hosts that cannot issue hidden completions through the v1 SDK. */
    hiddenCompletionExecutor?: HiddenCompletionExecutor;
    /** Host-owned checkpoints must not use OpenCode 1's synthetic marker writer. */
    compactionMarkerStrategy?: CompartmentRunnerDeps["compactionMarkerStrategy"];
    db: Database;
    liveSessionState: LiveSessionState;
    /** Plugin-startup directory — last-resort fallback for session-dir resolution. */
    directory: string;
    historianChunkTokens: number;
    historianTimeoutMs: number;
    memoryEnabled: boolean;
    autoPromote: boolean;
    /** Active OpenCode historian entry, including its outbound request variant. */
    historianModel?: ModelInput;
    historianContextLimit?: number;
    historianMaxOutputTokens?: number;
    /** Resolved historian fallback chain (config `fallback_models` → builtin). */
    fallbackModels: readonly ModelInput[];
    language?: string;
    /** Pre-resolved last-resort model key (the live session model). When omitted,
     *  the orchestrator resolves it from `liveModelBySession`. The hook path passes
     *  this explicitly so it can include its OpenCode-DB fallback (the live map can
     *  be empty when `/ctx-recomp` runs before the first transform pass). */
    fallbackModelId?: string;
    userMemoriesEnabled: boolean;
    /** Two-pass historian (editor cleanup) — config `historian.two_pass`. */
    historianTwoPass?: boolean;
    historianExpandTools?: Record<string, string | false>;
    getNotificationParams: (sessionId: string) => NotificationParams;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void>;
}

/** The runner's outcome messages are headed "## Magic Recomp — <Status>".
 *  Failed/Skipped wrote nothing. */
export function isRecompFailure(message: string): boolean {
    return /—\s*(Failed|Skipped)/.test(message);
}

/** A SKIP (vs a true failure): the run no-op'd because the compartment-state
 *  lease was busy (incremental historian comparting the tail, or another process
 *  mutating state). Transient — retrying in a moment succeeds. Matches the
 *  "— Skipped" heading AND the suffix-less lease/already-running no-op text. */
export function isRecompSkip(message: string): boolean {
    return /—\s*Skipped|already mutating compartment state|already running/i.test(message);
}

/** Strip markdown headings + blank lines from a runner outcome message, leaving
 *  the human reason for compact sidebar/status display. Fixes the dogfood
 *  2026-05-30 cosmetic bug where a raw "## Magic Recomp — Failed" heading leaked
 *  into the sidebar line. */
export function extractRecompReason(raw: string): string {
    const meaningful = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
    return meaningful.join(" ").trim() || "Recomp finished";
}

const RECOMP_DONE_GRACE_MS = 30_000;

/** Emit an IMMEDIATE "recomp" progress entry the instant an upgrade/recomp is
 *  requested — before any async work (session-dir resolution, child-session
 *  creation, the first slow historian attempt + fallback). Without this the
 *  sidebar stays blank until the first per-pass emit, which can be 60-90s into a
 *  fallback-heavy run (dogfood 2026-05-30). `totalMessages: 0` renders an
 *  indeterminate "Starting…" state until the loop knows the real range. */
export function setRecompStarting(
    liveSessionState: LiveSessionState,
    sessionId: string,
    note: string,
    kind: "recomp" | "upgrade" | "embed" | "wrapup" = "recomp",
): void {
    dropSlot(sessionId, "recomp-start");
    liveSessionState.recompProgressBySession.set(sessionId, {
        sessionId,
        kind,
        phase: "recomp",
        processedMessages: 0,
        totalMessages: 0,
        passCount: 0,
        compartmentsCreated: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        note,
    });
}

/** Update only the transient `note` on the active recomp progress entry (e.g.
 *  "trying fallback sonnet-4.6…") without disturbing the bar's counters. No-op
 *  if there's no active non-terminal entry. */
export function setRecompNote(
    liveSessionState: LiveSessionState,
    sessionId: string,
    note: string,
): void {
    const cur = liveSessionState.recompProgressBySession.get(sessionId);
    if (!cur || cur.phase === "done" || cur.phase === "failed") return;
    liveSessionState.recompProgressBySession.set(sessionId, {
        ...cur,
        note,
        updatedAt: Date.now(),
    });
}

/** Record a terminal recomp/upgrade phase ("done"/"failed") so the TUI shows the
 *  OUTCOME (not a missed toast). "done" auto-clears after a grace period; "failed"
 *  persists until the next run so the reason stays visible. */
export function setRecompTerminal(
    liveSessionState: LiveSessionState,
    sessionId: string,
    phase: "done" | "failed" | "skipped",
    message: string,
): void {
    const existing = liveSessionState.recompProgressBySession.get(sessionId);
    liveSessionState.recompProgressBySession.set(sessionId, {
        sessionId,
        // Preserve the flow kind set by setRecompStarting so the terminal entry
        // keeps "Recomp" vs "Upgrade" labeling.
        kind: existing?.kind ?? "recomp",
        phase,
        processedMessages: existing?.processedMessages ?? 0,
        totalMessages: existing?.totalMessages ?? 0,
        passCount: existing?.passCount ?? 0,
        compartmentsCreated: existing?.compartmentsCreated ?? 0,
        startedAt: existing?.startedAt ?? Date.now(),
        updatedAt: Date.now(),
        message,
    });
    // "done" and the transient "skipped" both auto-clear after a grace period;
    // "failed" persists until the next run so the reason stays visible.
    if (phase === "done" || phase === "skipped") {
        const t = setTimeout(() => {
            const cur = liveSessionState.recompProgressBySession.get(sessionId);
            if (cur?.phase === phase) liveSessionState.recompProgressBySession.delete(sessionId);
        }, RECOMP_DONE_GRACE_MS);
        (t as { unref?: () => void }).unref?.();
    }
}

/** Build the common executeContextRecomp deps shared by recomp + upgrade:
 *  fallback resilience + live progress + cache-bust signalling. */
export function buildRecompDeps(
    ctx: ManagedRecompContext,
    sessionId: string,
): CompartmentRunnerDeps {
    return {
        client: ctx.client,
        hiddenCompletionExecutor: ctx.hiddenCompletionExecutor,
        compactionMarkerStrategy: ctx.compactionMarkerStrategy,
        db: ctx.db,
        sessionId,
        historianChunkTokens: ctx.historianChunkTokens,
        historianTimeoutMs: ctx.historianTimeoutMs,
        directory: ctx.directory,
        memoryEnabled: ctx.memoryEnabled,
        autoPromote: ctx.autoPromote,
        // Fallback resilience (was missing on the RPC dialog paths):
        //  - fallbackModels: configured chain (e.g. anthropic/claude-sonnet-4-6)
        //  - fallbackModelId: the live session model as a last-ditch retry
        model: ctx.historianModel,
        historianContextLimit: ctx.historianContextLimit,
        historianMaxOutputTokens: ctx.historianMaxOutputTokens,
        fallbackModels: ctx.fallbackModels,
        language: ctx.language,
        fallbackModelId:
            ctx.fallbackModelId ?? resolveLiveModelKey(ctx.liveSessionState, sessionId),
        historianTwoPass: ctx.historianTwoPass,
        historianExpandTools: ctx.historianExpandTools,
        ensureProjectRegistered: ctx.ensureProjectRegistered,
        getNotificationParams: () => ctx.getNotificationParams(sessionId),
        onCompartmentStatePublished: (sid: string) => {
            ctx.liveSessionState.historyRefreshSessions.add(sid);
            ctx.liveSessionState.pendingMaterializationSessions.add(sid);
        },
        // Plan v6: recomp is explicit (applies the marker directly) so this is a
        // no-op for recomp, but the runner type is shared and the callback is
        // always optional — wiring it uniformly keeps incremental publishes correct.
        onDeferredMarkerPending: (sid: string) => {
            ctx.liveSessionState.deferredHistoryRefreshSessions.add(sid);
        },
        // Live progress (was missing on the hook/command path). The runner emits
        // per-pass entries with no `kind` (it doesn't know the user-facing flow);
        // preserve the kind set by setRecompStarting so labels stay consistent.
        onRecompProgress: (p: RecompProgress) => {
            const prevKind =
                ctx.liveSessionState.recompProgressBySession.get(sessionId)?.kind ?? "recomp";
            ctx.liveSessionState.recompProgressBySession.set(sessionId, {
                ...p,
                kind: p.kind ?? prevKind,
            });
        },
    };
}

/**
 * Run a recomp (full or partial), with fallback + live progress + terminal state.
 * Returns the runner's outcome message; the CALLER delivers it (so it can choose
 * force-persist vs toast). Used by `/ctx-recomp` and the RPC `recomp` handler.
 */
export async function runManagedRecomp(
    ctx: ManagedRecompContext,
    sessionId: string,
    options?: { range?: PartialRecompRange },
): Promise<string> {
    // Immediate sidebar feedback before any async work (see setRecompStarting).
    setRecompStarting(ctx.liveSessionState, sessionId, "Starting recomp…", "recomp");
    try {
        const message = await executeContextRecomp(buildRecompDeps(ctx, sessionId), options);
        // A lease/already-running SKIP is transient (the incremental historian is
        // briefly mutating compartment state), NOT a hard failure — surface it as
        // the neutral "skipped" state with retry guidance instead of red "failed".
        const terminalPhase = isRecompSkip(message)
            ? "skipped"
            : isRecompFailure(message)
              ? "failed"
              : "done";
        // A successful recomp IS the user resolving an overflow: it rebuilds
        // compartments from raw history and shrinks the live tail. So clear any
        // stale needs_emergency_recovery — otherwise the flag (armed by the
        // overflow that prompted the recomp) keeps force-bumping pressure to 95%
        // on every later pass even though the session is now small.
        if (terminalPhase === "done") {
            try {
                clearEmergencyRecovery(ctx.db, sessionId);
            } catch {
                // best-effort; the historian-trigger disarm path is the backstop.
            }
        }
        setRecompTerminal(
            ctx.liveSessionState,
            sessionId,
            terminalPhase,
            extractRecompReason(message),
        );
        return message;
    } catch (error) {
        const failure = renderUserFacingFailure("recomp_unavailable");
        sessionLog(
            sessionId,
            `recomp failed code=${userFacingFailureCode("recomp_unavailable")}`,
            error,
        );
        setRecompTerminal(ctx.liveSessionState, sessionId, "failed", failure);
        return `## Magic Recomp — Failed\n\n${failure}`;
    }
}
