import * as crypto from "node:crypto";
import {
    acquireCompartmentLease,
    COMPARTMENT_LEASE_RENEWAL_MS,
    releaseCompartmentLeaseBestEffort,
    renewCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import {
    getCompartments,
    getLastCompartmentEndMessage,
} from "../../features/magic-context/compartment-storage";
import {
    acquireWrapupInProgress,
    clearEmergencyRecovery,
    getHistorianFailureState,
    getWrapupInProgressState,
    releaseWrapupInProgress,
    updateWrapupInProgress,
} from "../../features/magic-context/storage";
import { sessionLog } from "../../shared/logger";
import { pushNotification } from "../../shared/rpc-notifications";
import {
    getActiveCompartmentRun,
    markActiveCompartmentRunPublished,
    registerActiveCompartmentRun,
} from "./compartment-runner";
import { runCompartmentAgent } from "./compartment-runner-incremental";
import type { RecompProgress } from "./compartment-runner-types";
import {
    describeBoundaryDiagnostics,
    hasRunnableCompartmentWindow,
    resolveWrapupProtectedTailBoundary,
    type WrapupBoundaryPlan,
} from "./protected-tail-boundary";
import type { ManagedRecompContext } from "./recomp-orchestrator";
import { setRecompStarting, setRecompTerminal } from "./recomp-orchestrator";
import { sendStatusNotification } from "./send-session-notification";

export interface ManagedWrapupContext extends ManagedRecompContext {
    contextLimit: number;
    executeThresholdPercentage: number;
    hasPendingNaturalBust?: (sessionId: string) => boolean;
    runCompartmentAgentForWrapup?: typeof runCompartmentAgent;
    wrapupLeaseWaitTimeoutMs?: number;
}

export interface WrapupOptions {
    messagesToKeep: number;
}

const WAIT_FOR_LEASE_MS = 1_000;
const MAX_WRAPUP_LEASE_WAIT_MS = 10 * 60 * 1_000;
type WrapupProgressUpdate = Parameters<typeof updateWrapupInProgress>[3];

type WrapupLeaseAcquireResult =
    | { ok: true; holderId: string }
    | { ok: false; reason: "busy" | "ownership_lost" | "timeout" };

type WrapupIterationResult =
    | { ran: true }
    | { ran: false; reason: "busy" | "ownership_lost" | "timeout" };

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function plural(value: number, word: string): string {
    return `${value} ${word}${value === 1 ? "" : "s"}`;
}

function resolveWrapupLeaseWaitTimeout(ctx: ManagedWrapupContext): number {
    const configured = ctx.wrapupLeaseWaitTimeoutMs ?? MAX_WRAPUP_LEASE_WAIT_MS;
    return Number.isFinite(configured) && configured >= 0 ? configured : MAX_WRAPUP_LEASE_WAIT_MS;
}

async function waitForActiveRunWithin(
    promise: Promise<void>,
    timeoutMs: number,
): Promise<"settled" | "timeout"> {
    if (timeoutMs <= 0) return "timeout";
    // The timer can be armed for the whole lease wait (up to ten minutes). Clear it
    // as soon as the race is decided so a settled wait leaves nothing behind.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
        return await Promise.race([
            promise.then(
                () => "settled" as const,
                () => "settled" as const,
            ),
            timedOut,
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function formatAlreadyRunningMessage(state: ReturnType<typeof getWrapupInProgressState>): string {
    if (!state) return "/ctx-wrapup is already running for this session.";
    const chunk =
        state.expectedChunks > 0 ? ` chunk ${state.chunkIndex}/${state.expectedChunks}` : "";
    const through =
        state.lastCompartmentEnd > 0 ? ` through message ${state.lastCompartmentEnd}` : "";
    return `/ctx-wrapup is already running for this session${chunk}${through}. Wait for it to finish, then run /ctx-wrapup again if more history remains.`;
}

function appendFlushHint(ctx: ManagedWrapupContext, sessionId: string, message: string): string {
    if (ctx.hasPendingNaturalBust?.(sessionId)) return message;
    return `${message} If you want it applied on the very next message, run /ctx-flush first.`;
}

function buildPlan(
    ctx: ManagedWrapupContext,
    sessionId: string,
    messagesToKeep: number,
    anchorRawMessageCount?: number,
): WrapupBoundaryPlan {
    return resolveWrapupProtectedTailBoundary({
        db: ctx.db,
        sessionId,
        mode: "manual-wrapup",
        contextLimit: ctx.contextLimit,
        executeThresholdPercentage: ctx.executeThresholdPercentage,
        usage: null,
        usageSource: "manual-none",
        providerShapeVersion: "opencode-v1",
        cacheNamespace: `opencode:${sessionId}`,
        messagesToKeep,
        anchorRawMessageCount,
    });
}

function emitWrapupProgress(
    ctx: ManagedWrapupContext,
    sessionId: string,
    progress: Partial<RecompProgress> & Pick<RecompProgress, "note">,
): void {
    const current = ctx.liveSessionState.recompProgressBySession.get(sessionId);
    ctx.liveSessionState.recompProgressBySession.set(sessionId, {
        sessionId,
        kind: "wrapup",
        phase: "recomp",
        processedMessages: progress.processedMessages ?? current?.processedMessages ?? 0,
        totalMessages: progress.totalMessages ?? current?.totalMessages ?? 0,
        passCount: progress.passCount ?? current?.passCount ?? 0,
        compartmentsCreated: progress.compartmentsCreated ?? current?.compartmentsCreated ?? 0,
        startedAt: current?.startedAt ?? Date.now(),
        updatedAt: Date.now(),
        note: progress.note,
    });
}

async function waitForExistingIncrementalRun(
    sessionId: string,
    maxWaitMs: number,
): Promise<"ok" | "busy" | "timeout"> {
    const active = getActiveCompartmentRun(sessionId);
    if (!active) return "ok";
    if (active.kind === "recomp" || active.kind === "wrapup") return "busy";
    const outcome = await waitForActiveRunWithin(active.promise, maxWaitMs);
    if (outcome === "timeout") return "timeout";
    // The active runner records its own failure state; wrapup just resumes from
    // the durable compartment boundary after it settles.
    return "ok";
}

async function acquireCompartmentLeaseForWrapup(
    ctx: ManagedWrapupContext,
    sessionId: string,
    renewWrapupMarker: (updates: WrapupProgressUpdate) => boolean,
): Promise<WrapupLeaseAcquireResult> {
    const holderId = crypto.randomUUID();
    const waitStartedAt = Date.now();
    const maxWaitMs = resolveWrapupLeaseWaitTimeout(ctx);
    const remainingMs = (): number => Math.max(0, waitStartedAt + maxWaitMs - Date.now());
    for (;;) {
        if (remainingMs() <= 0) {
            sessionLog(sessionId, "wrapup: timed out waiting for the compartment-state lease");
            return { ok: false, reason: "timeout" };
        }
        const active = getActiveCompartmentRun(sessionId);
        if (active?.kind === "recomp" || active?.kind === "wrapup") {
            return { ok: false, reason: "busy" };
        }
        if (active) {
            emitWrapupProgress(ctx, sessionId, { note: "Waiting for the active historian run…" });
            const outcome = await waitForActiveRunWithin(active.promise, remainingMs());
            if (outcome === "timeout") {
                sessionLog(sessionId, "wrapup: timed out waiting for the active historian run");
                return { ok: false, reason: "timeout" };
            }
            continue;
        }
        const lease = acquireCompartmentLease(ctx.db, sessionId, holderId);
        if (lease) return { ok: true, holderId };
        emitWrapupProgress(ctx, sessionId, { note: "Waiting for the compartment-state lease…" });
        if (!renewWrapupMarker({})) return { ok: false, reason: "ownership_lost" };
        await sleep(Math.min(WAIT_FOR_LEASE_MS, remainingMs()));
    }
}

async function runOneWrapupIteration(args: {
    ctx: ManagedWrapupContext;
    sessionId: string;
    plan: WrapupBoundaryPlan;
    messagesToKeep: number;
    anchorRawMessageCount: number;
    renewWrapupMarker: (updates: WrapupProgressUpdate) => boolean;
}): Promise<WrapupIterationResult> {
    const { ctx, sessionId, plan, messagesToKeep, anchorRawMessageCount } = args;
    const acquired = await acquireCompartmentLeaseForWrapup(ctx, sessionId, args.renewWrapupMarker);
    if (!acquired.ok) return { ran: false, reason: acquired.reason };
    const leaseHolderId = acquired.holderId;
    const renewal = setInterval(() => {
        try {
            if (!renewCompartmentLease(ctx.db, sessionId, leaseHolderId)) {
                sessionLog(sessionId, "wrapup: compartment lease renewal failed");
            }
        } catch (err) {
            // A missed renewal is safe because the compartment lease has a five-minute TTL.
            sessionLog(
                sessionId,
                `wrapup: compartment lease renewal threw; continuing (${err instanceof Error ? err.message : String(err)})`,
            );
        }
    }, COMPARTMENT_LEASE_RENEWAL_MS);
    const runCompartmentAgentForWrapup = ctx.runCompartmentAgentForWrapup ?? runCompartmentAgent;
    const runnerPromise = runCompartmentAgentForWrapup({
        client: ctx.client,
        hiddenCompletionExecutor: ctx.hiddenCompletionExecutor,
        compactionMarkerStrategy: ctx.compactionMarkerStrategy,
        db: ctx.db,
        sessionId,
        historianChunkTokens: ctx.historianChunkTokens,
        historianTimeoutMs: ctx.historianTimeoutMs,
        boundarySnapshot: plan.snapshot,
        currentContextLimit: ctx.contextLimit,
        directory: ctx.directory,
        model: ctx.historianModel,
        fallbackModels: ctx.fallbackModels,
        fallbackModelId: ctx.fallbackModelId,
        language: ctx.language,
        historianTwoPass: ctx.historianTwoPass,
        historianExpandTools: ctx.historianExpandTools,
        memoryEnabled: ctx.memoryEnabled,
        autoPromote: ctx.autoPromote,
        // User-memory collection is forwarded on the same gate as every other
        // historian surface: wrapup chunks persist user observations exactly when
        // the scheduled review-user-memories task enables collection. Dropping the
        // flag here silently suppressed observations that the module lane persists.
        experimentalUserMemories: ctx.userMemoriesEnabled,
        ensureProjectRegistered: ctx.ensureProjectRegistered,
        getNotificationParams: () => ctx.getNotificationParams(sessionId),
        preserveInjectionCacheUntilConsumed: true,
        compartmentLeaseHolderId: leaseHolderId,
        forceDrainQuota: true,
        // The boundary resolver caps each run's window, so chunk.hasMore cannot see
        // beyond that window. Only request weak-lookahead preservation when this
        // window reaches the wrapup's full drain target; the runner still downgrades
        // the hint if its own chunk reader stops early within the window.
        forceKeepLastCompartment: plan.snapshot.eligibleEndOrdinal >= plan.targetEligibleEndOrdinal,
        refreshBoundarySnapshot: () =>
            buildPlan(ctx, sessionId, messagesToKeep, anchorRawMessageCount).snapshot,
        onCompartmentStatePublished: (sid) => {
            markActiveCompartmentRunPublished(sid);
            ctx.liveSessionState.deferredHistoryRefreshSessions.add(sid);
            ctx.liveSessionState.deferredMaterializationSessions.add(sid);
        },
        onDeferredMarkerPending: (sid) => {
            ctx.liveSessionState.deferredHistoryRefreshSessions.add(sid);
        },
    });
    // The registry keeps its own derived copy of the run for other waiters. A runner
    // failure reaches this function through the await below, so the copy must not
    // also surface as an unhandled rejection.
    registerActiveCompartmentRun(sessionId, runnerPromise, "wrapup").promise.catch(() => {});
    try {
        await runnerPromise;
        return { ran: true };
    } finally {
        clearInterval(renewal);
        releaseCompartmentLeaseBestEffort(ctx.db, sessionId, leaseHolderId, sessionLog);
    }
}

export async function runManagedWrapup(
    ctx: ManagedWrapupContext,
    sessionId: string,
    options: WrapupOptions,
): Promise<string> {
    const messagesToKeep = Math.max(1, Math.floor(options.messagesToKeep));
    setRecompStarting(ctx.liveSessionState, sessionId, "Estimating wrapup…", "wrapup");
    try {
        return await runStartedWrapup(ctx, sessionId, messagesToKeep);
    } catch (error) {
        // Every normal exit sets a terminal progress state. A throw (planning, the
        // durable marker, or a historian iteration) would otherwise leave the sidebar
        // and /ctx-status showing a wrapup that is still running.
        const reason = error instanceof Error ? error.message : String(error);
        setRecompTerminal(
            ctx.liveSessionState,
            sessionId,
            "failed",
            `Wrapup stopped: ${reason}. Run /ctx-wrapup again to continue.`,
        );
        throw error;
    }
}

/** The wrapup after its progress entry is set; every return sets a terminal state. */
async function runStartedWrapup(
    ctx: ManagedWrapupContext,
    sessionId: string,
    messagesToKeep: number,
): Promise<string> {
    const existingWrapup = getWrapupInProgressState(ctx.db, sessionId);
    if (existingWrapup) {
        const message = formatAlreadyRunningMessage(existingWrapup);
        setRecompTerminal(ctx.liveSessionState, sessionId, "skipped", message);
        return `## Magic Wrapup — Skipped\n\n${message}`;
    }

    const initialPlan = buildPlan(ctx, sessionId, messagesToKeep);
    if (
        initialPlan.rawMessagesAboveLastCompartment <= messagesToKeep ||
        !hasRunnableCompartmentWindow(initialPlan.snapshot)
    ) {
        const message = `Nothing to wrap up — only ${initialPlan.rawMessagesAboveLastCompartment} messages above the last compartment.`;
        setRecompTerminal(ctx.liveSessionState, sessionId, "done", message);
        return message;
    }

    const expectedChunks = Math.max(
        1,
        Math.ceil(
            initialPlan.snapshot.trueRawEligibleTokens / Math.max(1, ctx.historianChunkTokens),
        ),
    );
    const wrapupHolderId = crypto.randomUUID();
    const acquired = acquireWrapupInProgress(ctx.db, sessionId, {
        holderId: wrapupHolderId,
        messagesToKeep,
        anchorRawMessageCount: initialPlan.anchorRawMessageCount,
        targetEligibleEndOrdinal: initialPlan.targetEligibleEndOrdinal,
        lastCompartmentEnd: getLastCompartmentEndMessage(ctx.db, sessionId),
        chunkIndex: 0,
        expectedChunks,
    });
    if (!acquired.ok) {
        const message = formatAlreadyRunningMessage(acquired.state);
        setRecompTerminal(ctx.liveSessionState, sessionId, "skipped", message);
        return `## Magic Wrapup — Skipped\n\n${message}`;
    }

    const startLastEnd = getLastCompartmentEndMessage(ctx.db, sessionId);
    const startCompartmentCount = getCompartments(ctx.db, sessionId).length;
    let chunkIndex = 0;
    let lastEnd = startLastEnd;
    let stoppedForFailure = false;
    let stoppedReason = "";
    let ownershipLost = false;
    const ownershipLostReason = "another process took over this session's wrapup.";
    const markOwnershipLost = (): void => {
        if (ownershipLost) return;
        ownershipLost = true;
        sessionLog(sessionId, "wrapup: durable marker ownership lost; aborting loop");
    };
    const renewWrapupMarker = (updates: WrapupProgressUpdate): boolean => {
        const updated = updateWrapupInProgress(ctx.db, sessionId, wrapupHolderId, updates);
        if (!updated) {
            markOwnershipLost();
            return false;
        }
        return true;
    };
    const markerRenewal = setInterval(() => {
        try {
            renewWrapupMarker({
                lastCompartmentEnd: getLastCompartmentEndMessage(ctx.db, sessionId),
                chunkIndex,
            });
        } catch (err) {
            // A missed renewal is safe because the wrapup marker has a five-minute TTL.
            sessionLog(
                sessionId,
                `wrapup: marker renewal threw; continuing (${err instanceof Error ? err.message : String(err)})`,
            );
        }
    }, 60_000);
    (markerRenewal as { unref?: () => void }).unref?.();

    try {
        const activeAtStart = await waitForExistingIncrementalRun(
            sessionId,
            resolveWrapupLeaseWaitTimeout(ctx),
        );
        if (activeAtStart === "busy") {
            const message = "Another Magic Context rebuild is already running for this session.";
            setRecompTerminal(ctx.liveSessionState, sessionId, "skipped", message);
            return `## Magic Wrapup — Skipped\n\n${message}`;
        }

        if (activeAtStart === "timeout") {
            stoppedForFailure = true;
            stoppedReason = "Timed out waiting for the active historian run.";
        }

        // The command blocks until the drain finishes and fires no message events,
        // so nothing would indicate the run until completion. Two best-effort
        // surfaces, neither may affect the drain:
        //  - sendStatusNotification: RPC toast, with no user-role chat row.
        //  - wrapup-progress-kick: starts the TUI sidebar's fast progress poll
        //    (the toast above cannot do that).
        if (!stoppedForFailure) {
            try {
                void sendStatusNotification(
                    ctx.client,
                    sessionId,
                    `Magic Wrapup started — compacting about ${plural(expectedChunks, "chunk")} of history. This can take a few minutes; the result posts here when done.`,
                    ctx.getNotificationParams(sessionId),
                );
            } catch {
                // Notification delivery must never affect the drain.
            }
            try {
                pushNotification("action", { action: "wrapup-progress-kick" }, sessionId);
            } catch {
                // Notification delivery must never affect the drain.
            }
        }

        if (!stoppedForFailure && ownershipLost) {
            stoppedForFailure = true;
            stoppedReason = ownershipLostReason;
        } else if (!stoppedForFailure) {
            emitWrapupProgress(ctx, sessionId, {
                processedMessages: Math.max(0, lastEnd),
                totalMessages: Math.max(0, initialPlan.targetEligibleEndOrdinal - 1),
                passCount: 0,
                compartmentsCreated: 0,
                note: `Eligible ${plural(initialPlan.snapshot.trueRawEligibleTokens, "token")} across about ${plural(expectedChunks, "chunk")}.`,
            });

            for (;;) {
                if (ownershipLost) {
                    stoppedForFailure = true;
                    stoppedReason = ownershipLostReason;
                    break;
                }
                if (
                    !renewWrapupMarker({
                        lastCompartmentEnd: getLastCompartmentEndMessage(ctx.db, sessionId),
                        chunkIndex,
                        expectedChunks,
                    })
                ) {
                    stoppedForFailure = true;
                    stoppedReason = ownershipLostReason;
                    break;
                }

                const plan = buildPlan(
                    ctx,
                    sessionId,
                    messagesToKeep,
                    initialPlan.anchorRawMessageCount,
                );
                lastEnd = getLastCompartmentEndMessage(ctx.db, sessionId);
                if (lastEnd + 1 >= plan.targetEligibleEndOrdinal) break;

                chunkIndex += 1;
                // Boundary diagnostics belong in the log; the progress note stays a plain sentence.
                sessionLog(
                    sessionId,
                    `wrapup chunk ${chunkIndex}: ${describeBoundaryDiagnostics(plan.snapshot)}`,
                );
                emitWrapupProgress(ctx, sessionId, {
                    processedMessages: Math.max(0, lastEnd),
                    totalMessages: Math.max(0, plan.targetEligibleEndOrdinal - 1),
                    passCount: chunkIndex - 1,
                    compartmentsCreated: Math.max(
                        0,
                        getCompartments(ctx.db, sessionId).length - startCompartmentCount,
                    ),
                    note: `Chunk ${chunkIndex}/${expectedChunks}: messages ${plan.snapshot.offset}-${plan.snapshot.eligibleEndOrdinal - 1}…`,
                });
                if (
                    !renewWrapupMarker({
                        lastCompartmentEnd: lastEnd,
                        chunkIndex,
                        expectedChunks,
                        targetEligibleEndOrdinal: plan.targetEligibleEndOrdinal,
                    })
                ) {
                    stoppedForFailure = true;
                    stoppedReason = ownershipLostReason;
                    break;
                }

                const beforeEnd = lastEnd;
                const beforeFailures = getHistorianFailureState(ctx.db, sessionId).failureCount;
                const iteration = await runOneWrapupIteration({
                    ctx,
                    sessionId,
                    plan,
                    messagesToKeep,
                    anchorRawMessageCount: initialPlan.anchorRawMessageCount,
                    renewWrapupMarker,
                });
                if (!iteration.ran) {
                    stoppedForFailure = true;
                    stoppedReason =
                        ownershipLost || iteration.reason === "ownership_lost"
                            ? ownershipLostReason
                            : iteration.reason === "timeout"
                              ? "Timed out waiting for another process to release the compartment-state lease."
                              : "Another Magic Context rebuild started while wrapup was waiting.";
                    break;
                }
                const afterEnd = getLastCompartmentEndMessage(ctx.db, sessionId);
                const afterFailures = getHistorianFailureState(ctx.db, sessionId).failureCount;
                if (afterEnd <= beforeEnd) {
                    stoppedForFailure = true;
                    stoppedReason =
                        afterFailures > beforeFailures
                            ? "The historian failed on the current chunk."
                            : "The historian made no forward progress on the current chunk.";
                    break;
                }
                lastEnd = afterEnd;
                emitWrapupProgress(ctx, sessionId, {
                    processedMessages: Math.max(0, lastEnd),
                    totalMessages: Math.max(0, plan.targetEligibleEndOrdinal - 1),
                    passCount: chunkIndex,
                    compartmentsCreated: Math.max(
                        0,
                        getCompartments(ctx.db, sessionId).length - startCompartmentCount,
                    ),
                    note: `Wrapped through message ${lastEnd}.`,
                });
            }
        }
    } finally {
        clearInterval(markerRenewal);
        releaseWrapupInProgress(ctx.db, sessionId, wrapupHolderId);
    }

    const finalEnd = getLastCompartmentEndMessage(ctx.db, sessionId);
    const compartmentsCreated = Math.max(
        0,
        getCompartments(ctx.db, sessionId).length - startCompartmentCount,
    );
    const messagesWrapped = Math.max(0, finalEnd - Math.max(0, startLastEnd));

    if (stoppedForFailure) {
        const message = `Wrapped up through message ${Math.max(0, finalEnd)} (${plural(messagesWrapped, "message")} into ${plural(compartmentsCreated, "compartment")}). ${stoppedReason} Run /ctx-wrapup again to continue.`;
        setRecompTerminal(ctx.liveSessionState, sessionId, "failed", message);
        return `## Magic Wrapup — Partial\n\n${message}`;
    }

    try {
        clearEmergencyRecovery(ctx.db, sessionId);
    } catch {
        // Best-effort: normal historian recovery disarm remains the backstop.
    }
    const base = `Wrapped up ${messagesWrapped} messages into ${compartmentsCreated} compartments. The compacted history is queued and materializes on your next message.`;
    const message = appendFlushHint(ctx, sessionId, base);
    setRecompTerminal(ctx.liveSessionState, sessionId, "done", message);
    return message;
}
