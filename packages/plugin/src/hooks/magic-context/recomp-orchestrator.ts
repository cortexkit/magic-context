import {
    clearRecompStaging,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import {
    isMemoryMigrationDone,
    runMemoryMigration,
} from "../../features/magic-context/memory/memory-migration";
import { resolveProjectIdentity } from "../../features/magic-context/project-identity";
import {
    clearEmergencyRecovery,
    isWrapupInProgress,
} from "../../features/magic-context/storage-meta-persisted";
import type { PluginContext } from "../../plugin/types";
import { sessionLog } from "../../shared/logger";
import type { ModelInput } from "../../shared/model-resolution";
import type { Database } from "../../shared/sqlite";
import { renderUserFacingFailure, userFacingFailureCode } from "../../shared/user-facing-codes";
import {
    executeContextRecomp,
    executeContextRecompWithResult,
    type PartialRecompRange,
} from "./compartment-runner";
import type { HiddenCompletionExecutor, RecompProgress } from "./compartment-runner-types";
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
 * Single source of truth for recomp + session-upgrade orchestration.
 *
 * Before this module there were THREE diverged implementations — the RPC
 * `recomp` handler, the RPC `upgrade` handler, and the hook-side `executeRecomp`
 * closure (used by `/ctx-recomp` and `/ctx-session-upgrade`). They drifted: the
 * RPC handlers had live progress but no model fallback, while the hook path had
 * fallback but no progress. The dogfood failure on 2026-05-30 was exactly this —
 * the dialog "Run upgrade now" button (RPC, no fallback) failed when the primary
 * historian model returned empty, while `/ctx-session-upgrade` (hook, with
 * fallback) succeeded via the kimi fallback, leaving the sidebar stuck on a
 * stale "failed" because the command path never updated progress.
 *
 * `runManagedRecomp` / `runManagedUpgrade` give EVERY caller the full set:
 * fallback resilience (config chain + live-session-model last resort), live
 * progress (sidebar / status), and consistent terminal-state + messaging.
 */

/** Config-shape-agnostic context. Callers resolve config values and pass them
 *  in, so this module never couples to the loose RPC config record vs the typed
 *  hook config. */
export interface ManagedRecompContext {
    client: PluginContext["client"];
    /**
     * Executor seam for hosts without an SDK client (OpenCode 2): the recomp /
     * historian runner uses it instead of building the v1 client-backed executor.
     */
    hiddenCompletionExecutor?: HiddenCompletionExecutor;
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
    /** Gate the upgrade's memory-migration step (memory enabled + historian model set). */
    runMigration: boolean;
    userMemoriesEnabled: boolean;
    /** Two-pass historian (editor cleanup) — config `historian.two_pass`. */
    historianTwoPass?: boolean;
    getNotificationParams: (sessionId: string) => NotificationParams;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void>;
}

/** The runner's outcome messages are headed "## Magic Recomp — <Status>" /
 *  "## Session Upgrade — <Status>". Failed/Skipped wrote nothing. */
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

/** Positive full-success predicate: the recomp rebuilt the ENTIRE requested
 *  range, headed "## Magic Recomp — Complete". This is stricter than
 *  `!isRecompFailure(...)`: a "— Partial" outcome publishes a valid prefix
 *  (`published===true`) but did NOT cover the full range, and a lease-busy
 *  no-op returns a heading with no status suffix at all. Gating the upgrade on
 *  this — not on `!isRecompFailure` — prevents declaring "Complete" + running
 *  the project-wide memory migration when compartments were only partially
 *  rebuilt (tierless legacy rows would remain while memories migrated). A
 *  Partial is reported as Incomplete; re-running the upgrade continues the
 *  rebuild (the upgrade gate still sees the un-rebuilt legacy/tierless rows). */
export function isRecompComplete(message: string): boolean {
    return /—\s*Complete/.test(message);
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

/**
 * Rewrite a recomp-flow reason string for the UPGRADE flow surface. The shared
 * recomp runner emits lease/active-run skip text that names `/ctx-recomp` — but
 * a user in the upgrade flow must be told to retry `/ctx-session-upgrade`, not
 * `/ctx-recomp` (they are different commands). The dominant skip cause on an
 * active session is the incremental historian briefly holding the
 * compartment-state lease while it comparts the live tail, which is transient,
 * so reframe the guidance as "retry in a moment" rather than a hard failure.
 */
export function contextualizeUpgradeReason(reason: string): string {
    const rewritten = reason.replace(/\/ctx-recomp\b/g, "/ctx-session-upgrade");
    if (/already mutating compartment state|lease|already running/i.test(rewritten)) {
        return "The history comparter is currently updating this session's tail. This is temporary — wait a few seconds, then run `/ctx-session-upgrade` again (or just send another message and re-run it). No changes were made.";
    }
    if (/missing the tiered paraphrase structure \(p1\.\.p4\)/i.test(rewritten)) {
        return `Your configured \`historian.model\` could not produce the required tiered (p1..p4) compartment output. Choose a historian model that can follow the XML format in magic-context.jsonc, then run \`/ctx-session-upgrade\` again. No compartments were rewritten. Validation error: ${rewritten}`;
    }
    return rewritten;
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
function buildRecompDeps(ctx: ManagedRecompContext, sessionId: string) {
    return {
        client: ctx.client,
        hiddenCompletionExecutor: ctx.hiddenCompletionExecutor,
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

/** Resolve the SESSION's real directory (not the plugin-startup cwd) so memory
 *  migration rewrites the correct project. Mirrors the cache+SDK fallback used
 *  elsewhere; never throws. */
async function resolveSessionDirectory(
    ctx: ManagedRecompContext,
    sessionId: string,
): Promise<string> {
    const cached = ctx.liveSessionState.sessionDirectoryBySession.get(sessionId);
    if (cached) return cached;
    try {
        const info = await (
            ctx.client as {
                session?: {
                    get?: (a: unknown) => Promise<{ data?: { directory?: string } }>;
                };
            }
        )?.session?.get?.({ path: { id: sessionId } });
        const dir = info?.data?.directory;
        if (typeof dir === "string" && dir.length > 0) {
            ctx.liveSessionState.sessionDirectoryBySession.set(sessionId, dir);
            return dir;
        }
    } catch {
        // non-fatal — fall through to plugin directory
    }
    return ctx.directory;
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

export async function runManagedUpgrade(
    ctx: ManagedRecompContext,
    sessionId: string,
): Promise<string> {
    if (isWrapupInProgress(ctx.db, sessionId)) {
        const message =
            "/ctx-wrapup is already compacting this session. Wait for it to finish, then try `/ctx-session-upgrade` again.";
        setRecompTerminal(ctx.liveSessionState, sessionId, "skipped", message);
        return `## Session Upgrade — Skipped\n\n${message}`;
    }
    // Immediate sidebar feedback before any async work (see setRecompStarting).
    setRecompStarting(ctx.liveSessionState, sessionId, "Starting upgrade…", "upgrade");
    try {
        // ── Guard: don't recomp an already-upgraded session ──────────────────
        // Re-running the full recomp on a session whose compartments are all v2
        // already is wasteful (rebuilds the whole tail) and risky (overwrites
        // good v2 work). It also confuses the historian — asked to rebuild
        // compartments that already exist, weaker models reply conversationally
        // ("these already exist, want me to continue?") and the run fails. So:
        //   • upgradable compartments present     → full upgrade (recomp + migration)
        //   • none + migration still pending      → migration only (skip recomp)
        //   • none + migration already done       → no-op "already upgraded"
        //
        // "Upgradable" = lacks usable v2 tiers: a pre-v2 `legacy=1` row OR a
        // malformed `legacy=0` row with no `p1` (interrupted recomp / older
        // partial-v2 build). Matching ONLY `legacy=1` would trap a session whose
        // rows are tierless-but-not-flagged-legacy — the gate would say "already
        // upgraded" and refuse to rebuild (dogfood 2026-05-30, AFT session).
        const compartments = getCompartments(ctx.db, sessionId);
        const legacyCount = compartments.filter(
            (c) => c.legacy === 1 || !c.p1 || c.p1.trim() === "",
        ).length;

        if (legacyCount === 0) {
            // Every compartment is already v2. Garbage-collect any orphan recomp
            // staging so a superseded/interrupted-then-completed run can't leave
            // rows that later trigger a false "resume the interrupted upgrade"
            // prompt (the staging is dead once all compartments are promoted).
            try {
                clearRecompStaging(ctx.db, sessionId);
            } catch {
                /* best-effort GC */
            }
            const migrationDirectory = await resolveSessionDirectory(ctx, sessionId);
            const projectPath = resolveProjectIdentity(migrationDirectory);
            const migrationPending =
                ctx.runMigration && !isMemoryMigrationDone(ctx.db, projectPath);

            if (!migrationPending) {
                // Fully upgraded already — nothing to do.
                setRecompTerminal(ctx.liveSessionState, sessionId, "done", "Already upgraded");
                return [
                    "## Session Upgrade — Already Up To Date",
                    "",
                    compartments.length === 0
                        ? "This session has no compartment history to upgrade yet."
                        : "This session's compartments are already in the current format.",
                ].join("\n");
            }

            // Compartments are current, but this project's memories were never
            // migrated — run migration only, skip the pointless recomp.
            const summary = await runUpgradeMemoryMigration(ctx, sessionId, migrationDirectory);
            setRecompTerminal(ctx.liveSessionState, sessionId, "done", "Memories migrated");
            return ["## Session Upgrade — Complete", "", summary].join("\n");
        }

        // ── Full upgrade: compartment recomp (NO facts) → memory migration ───
        // Gate the migration on `published` — the GROUND TRUTH that the recomp
        // actually wrote rebuilt compartments — NOT just on the message text.
        // A recomp can no-op WITHOUT a "— Failed/Skipped" heading: the lease
        // guard / `activeRuns` guard return "## Magic Recomp\n\nHistorian is
        // already running…" (no status suffix), which `isRecompFailure` misses.
        // The old code then ran the migration and declared the upgrade COMPLETE
        // even though zero compartments were rebuilt — leaving tierless rows but
        // migrated memories + a false "Complete" (dogfood 2026-05-30, AFT: a
        // concurrent opencode process for the same project still held the lease,
        // so the resume's recomp was skipped while migration ran anyway).
        const recompResult = await executeContextRecompWithResult(buildRecompDeps(ctx, sessionId));

        // Require a POSITIVE full-success ("— Complete"), not merely the absence
        // of a Failed/Skipped heading. A published "— Partial" rebuilt only a
        // prefix (published===true, not a failure heading) — running migration +
        // declaring Complete on it would migrate memories while leaving tierless
        // legacy rows. A lease-busy no-op has no status suffix at all.
        if (!recompResult.published || !isRecompComplete(recompResult.message)) {
            // Recomp did not fully rebuild (failure, skip/lease-busy, OR partial).
            // Do NOT run the project-wide migration or declare the upgrade complete.
            const reason = contextualizeUpgradeReason(
                isRecompFailure(recompResult.message)
                    ? extractRecompReason(recompResult.message)
                    : `Compartments were not fully rebuilt: ${extractRecompReason(recompResult.message)}`,
            );
            setRecompTerminal(ctx.liveSessionState, sessionId, "failed", reason);
            return `## Session Upgrade — Incomplete\n\n${reason}`;
        }

        // Step 2 — once-per-project memory migration (idempotent, project-scoped).
        let migrationSummary = "";
        if (ctx.runMigration) {
            const migrationDirectory = await resolveSessionDirectory(ctx, sessionId);
            migrationSummary = await runUpgradeMemoryMigration(ctx, sessionId, migrationDirectory);
        }

        setRecompTerminal(ctx.liveSessionState, sessionId, "done", "Upgrade complete");
        return [
            "## Session Upgrade — Complete",
            "",
            recompResult.message,
            migrationSummary ? `\n${migrationSummary}` : "",
        ].join("\n");
    } catch (error) {
        const failure = renderUserFacingFailure("recomp_unavailable");
        sessionLog(
            sessionId,
            `session upgrade failed code=${userFacingFailureCode("recomp_unavailable")}`,
            error,
        );
        setRecompTerminal(ctx.liveSessionState, sessionId, "failed", failure);
        return `## Session Upgrade — Failed\n\n${failure}`;
    }
}

/** Run the once-per-project memory migration with the progress bar in its
 *  indeterminate "migration" phase. Returns the summary line (or an error note
 *  on failure — migration failure must not fail the whole upgrade). */
async function runUpgradeMemoryMigration(
    ctx: ManagedRecompContext,
    sessionId: string,
    migrationDirectory: string,
): Promise<string> {
    const prev = ctx.liveSessionState.recompProgressBySession.get(sessionId);
    ctx.liveSessionState.recompProgressBySession.set(sessionId, {
        sessionId,
        // Memory migration only runs inside the upgrade flow.
        kind: prev?.kind ?? "upgrade",
        phase: "migration",
        processedMessages: prev?.processedMessages ?? 0,
        totalMessages: prev?.totalMessages ?? 0,
        passCount: prev?.passCount ?? 0,
        compartmentsCreated: prev?.compartmentsCreated ?? 0,
        startedAt: prev?.startedAt ?? Date.now(),
        updatedAt: Date.now(),
        note: "Re-organizing project memories…",
    });
    try {
        const outcome = await runMemoryMigration({
            client: ctx.client as Parameters<typeof runMemoryMigration>[0]["client"],
            db: ctx.db,
            directory: migrationDirectory,
            parentSessionId: sessionId,
            // Run the migration on the session's live MAIN model (the user's
            // working interactive model — typically stronger and guaranteed
            // present, vs a possibly-misconfigured historian model). Historian
            // fallbacks remain the safety net behind it.
            primaryModelId:
                ctx.fallbackModelId ?? resolveLiveModelKey(ctx.liveSessionState, sessionId),
            fallbackModels: ctx.fallbackModels.map((entry) =>
                typeof entry === "string" ? entry : entry.model,
            ),
            timeoutMs: ctx.historianTimeoutMs,
            userMemoriesEnabled: ctx.userMemoriesEnabled,
            language: ctx.language,
        });
        return outcome.summary;
    } catch (error) {
        sessionLog(
            sessionId,
            `memory migration failed code=${userFacingFailureCode("dream_unknown")}`,
            error,
        );
        return renderUserFacingFailure("dream_unknown");
    }
}
