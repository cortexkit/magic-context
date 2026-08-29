import { embedAndStoreCompartmentChunks } from "../../features/magic-context/compartment-embedding";
import { insertCompartmentEvents } from "../../features/magic-context/compartment-events";
import {
    appendCompartments,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
// Re-export the historian-state-file helpers so existing callers
// (compartment-runner-recomp.ts, compartment-runner.ts, tests) keep working
// unchanged. The implementation moved to ./historian-state-file.ts so Pi
// can import it without pulling in the full incremental runner.
import { cleanupHistorianStateFile } from "./historian-state-file";

export {
    cleanupHistorianStateFile,
    HISTORIAN_STATE_INLINE_THRESHOLD,
    maybeWriteHistorianStateFile,
} from "./historian-state-file";

import { isCompartmentLeaseHeld } from "../../features/magic-context/compartment-lease";
import {
    embedPromotedFacts,
    promoteSessionFactsDurable,
} from "../../features/magic-context/memory";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import {
    getMemoriesByProject,
    ModuleMemoryAuthorityError,
} from "../../features/magic-context/memory/storage-memory";
import {
    clearEmergencyDrainLatch,
    clearEmergencyRecovery,
    clearHistorianDrainFailure,
    clearHistorianFailureState,
    getOverflowState,
    incrementHistorianFailure,
    isWrapupInProgress,
    recordHistorianDrainFailure,
    recordProtectedTailPublicationFloor,
    reserveProtectedTailDrainTokens,
    rollbackProtectedTailDrainReservation,
    setPendingCompactionMarkerState,
} from "../../features/magic-context/storage";
import {
    type HistorianRunInput,
    recordHistorianRun,
    summarizeImportance,
    tallyFactsByCategory,
} from "../../features/magic-context/storage-historian-runs";
import { updateSessionMeta } from "../../features/magic-context/storage-meta";
import { insertPrimerCandidates } from "../../features/magic-context/storage-primers";
import { getLatestHistorianInvocationId } from "../../features/magic-context/storage-subagent-invocations";
import { insertUserMemoryCandidates } from "../../features/magic-context/user-memory/storage-user-memory";
import { normalizeSDKResponse } from "../../shared";
import { describeError } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";
import { updateCompactionMarkerAfterPublication } from "./compaction-marker-manager";
import { buildCompartmentAgentPrompt } from "./compartment-prompt";
import { queueDropsForCompartmentalizedMessages } from "./compartment-runner-drop-queue";
import { runValidatedHistorianPass } from "./compartment-runner-historian";
import type { CompartmentRunnerDeps } from "./compartment-runner-types";
import {
    buildHistorianFailureNotice,
    HISTORIAN_BOUNDARY_HEALING_SLACK,
    shouldDiscardLastHistorianCompartment,
    validateChunkCoverage,
    validateStoredCompartments,
} from "./compartment-runner-validation";
import { clearInjectionCache, renderMemoryBlock } from "./inject-compartments";
import { onNoteTrigger } from "./note-nudger";
import {
    createDefaultBoundarySnapshotForTests,
    hasRunnableCompartmentWindow,
    recordHighPressureNoEligibleHead,
    resolveOpenCodeProtectedTailBoundary,
    selectPerRunCap,
    validateBoundarySnapshot,
} from "./protected-tail-boundary";
import { readSessionChunk } from "./read-session-chunk";
import { getMessageTimesFromOpenCodeDb } from "./read-session-db";
import { estimateTokens } from "./read-session-formatting";
import { buildReferenceBlocks } from "./reference-retrieval";
import { sendIgnoredMessage } from "./send-session-notification";

/** Suppress repeated historian failure notifications — at most once per 60 seconds per session */
const HISTORIAN_ALERT_COOLDOWN_MS = 60 * 1000;
const lastHistorianAlertBySession = new Map<string, number>();

function shouldSuppressHistorianAlert(sessionId: string): boolean {
    const lastAlert = lastHistorianAlertBySession.get(sessionId);
    if (lastAlert && Date.now() - lastAlert < HISTORIAN_ALERT_COOLDOWN_MS) {
        return true;
    }
    lastHistorianAlertBySession.set(sessionId, Date.now());
    return false;
}

/** Clean up module-level session state on session deletion. */
export function clearHistorianAlertState(sessionId: string): void {
    lastHistorianAlertBySession.delete(sessionId);
}

export async function runCompartmentAgent(deps: CompartmentRunnerDeps): Promise<void> {
    const {
        client,
        db,
        sessionId,
        historianChunkTokens,
        directory,
        historianTimeoutMs,
        getNotificationParams,
    } = deps;
    let completedSuccessfully = false;
    let retainDrainReservationForRetryThrottle = false;
    let issueNotified = false;
    let stateFilePath: string | undefined;
    let drainReservation: ReturnType<typeof reserveProtectedTailDrainTokens>["reservation"] = null;

    // historian_runs telemetry (migration v24). Captured across the run and
    // recorded ONCE in `finally` so every exit path (no-op, failure, success) is
    // logged. Best-effort: recordHistorianRun never throws into this path.
    const runStartedAt = Date.now();
    const invocationBaseline = getLatestHistorianInvocationId(db, sessionId);
    const telemetry: Partial<HistorianRunInput> = {
        runKind: "incremental",
        status: "failed", // pessimistic default; overwritten on no-op/success
    };
    const recordTelemetry = (): void => {
        // Link the FK only when a NEW historian invocation was recorded during
        // this run (serialized per session, so the newest > baseline is ours).
        const latest = getLatestHistorianInvocationId(db, sessionId);
        const invocationId =
            latest != null && (invocationBaseline == null || latest > invocationBaseline)
                ? latest
                : null;
        recordHistorianRun(db, {
            sessionId,
            harness: "opencode",
            subagentInvocationId: invocationId,
            runKind: telemetry.runKind ?? "incremental",
            status: telemetry.status ?? "failed",
            failureReason: telemetry.failureReason ?? null,
            chunkStartOrdinal: telemetry.chunkStartOrdinal ?? null,
            chunkEndOrdinal: telemetry.chunkEndOrdinal ?? null,
            unprocessedFrom: telemetry.unprocessedFrom ?? null,
            compartmentsProduced: telemetry.compartmentsProduced ?? 0,
            compartmentIdMin: telemetry.compartmentIdMin ?? null,
            compartmentIdMax: telemetry.compartmentIdMax ?? null,
            factsEmitted: telemetry.factsEmitted ?? 0,
            factsByCategory: telemetry.factsByCategory ?? null,
            eventsEmitted: telemetry.eventsEmitted ?? 0,
            importanceMin: telemetry.importanceMin ?? null,
            importanceMax: telemetry.importanceMax ?? null,
            importanceAvg: telemetry.importanceAvg ?? null,
            discardedLast: telemetry.discardedLast ?? false,
            legacy: telemetry.legacy ?? false,
        });
        void runStartedAt; // (kept for future duration column; timing lives on the FK row)
    };

    const notifyHistorianIssue = async (message: string): Promise<void> => {
        issueNotified = true;
        if (shouldSuppressHistorianAlert(sessionId)) {
            sessionLog(sessionId, "historian alert suppressed (cooldown):", message.slice(0, 100));
            return;
        }
        await sendIgnoredMessage(client, sessionId, message, getNotificationParams?.() ?? {});
    };

    const truncateHistorianInputIfNeeded = (text: string, budget: number): string => {
        if (estimateTokens(text) <= budget) return text;
        let lo = 0;
        let hi = text.length;
        let best = 0;
        const marker = "\n[… tokens truncated by Magic Context to fit the historian window …]";
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (estimateTokens(text.slice(0, mid) + marker) <= budget) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return text.slice(0, best) + marker;
    };

    const rollbackDrainReservation = (): void => {
        if (drainReservation) {
            rollbackProtectedTailDrainReservation(db, drainReservation);
            drainReservation = null;
        }
    };

    updateSessionMeta(db, sessionId, { compartmentInProgress: true });

    try {
        const priorCompartments = getCompartments(db, sessionId);
        // v2: session facts are no longer read here — the unbounded existing_state
        // dump is gone. Facts dedup against <project-memory> in the prompt instead.

        const existingValidationError = validateStoredCompartments(priorCompartments);
        if (existingValidationError) {
            sessionLog(
                sessionId,
                `historian failure: source=existing-validation reason="${existingValidationError}"`,
            );
            // This is a real failure (stored compartments are corrupt) — record
            // it so `doctor --issue` and the >=95% abort path can see it.
            const failCount = incrementHistorianFailure(db, sessionId, existingValidationError);
            telemetry.failureReason = `existing-validation: ${existingValidationError}`;
            await notifyHistorianIssue(
                buildHistorianFailureNotice(failCount, existingValidationError),
            );
            return;
        }

        const offset =
            priorCompartments.length > 0
                ? priorCompartments[priorCompartments.length - 1].endMessage + 1
                : 1;

        let boundarySnapshot =
            deps.boundarySnapshot ??
            (process.env.NODE_ENV === "test"
                ? createDefaultBoundarySnapshotForTests(sessionId)
                : null);
        if (!boundarySnapshot) {
            telemetry.failureReason = "missing protected-tail boundary snapshot";
            sessionLog(
                sessionId,
                "historian no-op: missing protected-tail boundary snapshot from trigger decision",
            );
            rollbackDrainReservation();
            return;
        }
        let validation =
            boundarySnapshot.rawRangeFingerprint.length > 0
                ? validateBoundarySnapshot({
                      db,
                      snapshot: boundarySnapshot,
                      currentContextLimit:
                          deps.currentContextLimit ?? boundarySnapshot.contextLimit,
                  })
                : { ok: true };
        // In an active session the protected tail's newest message changes every
        // turn (a fresh user/assistant message lands), so a snapshot captured at
        // trigger time goes stale on the "last ordinal id" check by the time the
        // historian actually runs — even though the ELIGIBLE HEAD (offset →
        // eligibleEnd) it would compact is untouched. Left as-is the runner no-ops
        // forever while the trigger refires each turn, and queued drop ops starve
        // (observed in production: 27 consecutive stale-snapshot no-ops, 179
        // pending drops, zero reduction). Re-resolve the boundary ONCE from the
        // CURRENT session state and adopt the fresh snapshot when it still exposes
        // a runnable head. This does NOT weaken the protected-tail guarantee: the
        // refreshed snapshot recomputes protectedTailStart/eligibleEnd from the
        // live messages, so the head can never include a message that now belongs
        // to the current protected tail.
        if (!validation.ok && validation.reason === "stale_snapshot") {
            const refreshed = deps.refreshBoundarySnapshot
                ? deps.refreshBoundarySnapshot(boundarySnapshot, validation)
                : resolveOpenCodeProtectedTailBoundary({
                      db,
                      sessionId,
                      mode: "incremental-runner",
                      contextLimit: deps.currentContextLimit ?? boundarySnapshot.contextLimit,
                      executeThresholdPercentage: boundarySnapshot.executeThresholdPercentage,
                      usage: {
                          percentage: boundarySnapshot.usagePercentage,
                          inputTokens: boundarySnapshot.usageInputTokens,
                      },
                      usageSource: boundarySnapshot.usageSource,
                      emergencyTailScale: boundarySnapshot.emergencyTailScale,
                  });
            if (refreshed && hasRunnableCompartmentWindow(refreshed)) {
                sessionLog(
                    sessionId,
                    `historian: refreshed stale protected-tail snapshot at run time (was: ${validation.detail ?? "stale"}) — eligible head ${refreshed.offset}-${refreshed.eligibleEndOrdinal - 1}`,
                );
                boundarySnapshot = refreshed;
                validation = { ok: true };
            }
        }
        if (!validation.ok) {
            sessionLog(
                sessionId,
                `historian no-op: stale protected-tail snapshot (${validation.detail ?? validation.reason ?? "unknown"})`,
            );
            telemetry.status = "noop";
            telemetry.failureReason = "stale_snapshot";
            rollbackDrainReservation();
            return;
        }

        const protectedTailStart = Math.min(
            boundarySnapshot.protectedTailStart,
            boundarySnapshot.rawMessageCountAtTrigger + 1,
        );
        const eligibleEndOrdinal = Math.min(
            boundarySnapshot.eligibleEndOrdinal,
            protectedTailStart,
        );
        if (protectedTailStart <= offset || eligibleEndOrdinal <= offset) {
            sessionLog(
                sessionId,
                `historian no-op: protectedTailStart=${protectedTailStart} eligibleEnd=${eligibleEndOrdinal} <= offset=${offset} — nothing to compact`,
            );
            if (boundarySnapshot.usagePercentage < 80 && !boundarySnapshot.emergencyTailScale) {
                if (!isWrapupInProgress(db, sessionId)) clearEmergencyRecovery(db, sessionId);
            } else {
                const count = recordHighPressureNoEligibleHead(db, boundarySnapshot);
                sessionLog(
                    sessionId,
                    `historian high-pressure no-op: recovery remains armed (noEligibleHeadCount=${count})`,
                );
            }
            // Tail is exhausted — nothing left to drain, so the emergency catch-up
            // latch has done its job. Clear it so a high irreducible floor can't keep
            // it armed and later bypass the steady-state throttle for fresh tail.
            clearEmergencyDrainLatch(db, sessionId);
            telemetry.status = "noop";
            telemetry.failureReason = "nothing to compact before protected tail";
            rollbackDrainReservation();
            return;
        }

        const perRunCap = selectPerRunCap(boundarySnapshot);
        const usable = Math.max(
            1,
            Math.round(
                (boundarySnapshot.contextLimit * boundarySnapshot.executeThresholdPercentage) / 100,
            ),
        );
        const reserve = deps.forceDrainQuota
            ? { ok: true as const, reservation: null }
            : reserveProtectedTailDrainTokens({
                  db,
                  sessionId,
                  runId: crypto.randomUUID(),
                  trueRawTokens: boundarySnapshot.trueRawEligibleTokens,
                  usagePercentage: boundarySnapshot.usagePercentage,
                  usable,
                  perRunCap,
                  executeThresholdPercentage: boundarySnapshot.executeThresholdPercentage,
              });
        if (!reserve.ok) {
            sessionLog(
                sessionId,
                `historian rate-limit skip: ${reserve.skippedReason ?? "quota exhausted"}`,
            );
            telemetry.status = "noop";
            telemetry.failureReason = "protected-tail drain quota exhausted";
            return;
        }
        drainReservation = reserve.reservation;

        const chunk = readSessionChunk(sessionId, historianChunkTokens, offset, eligibleEndOrdinal);
        const forceKeepLastCompartmentForChunk =
            deps.forceKeepLastCompartment === true && !chunk.hasMore;
        telemetry.chunkStartOrdinal = chunk.startIndex;
        telemetry.chunkEndOrdinal = chunk.endIndex;
        if (!chunk.text || chunk.messageCount === 0) {
            sessionLog(
                sessionId,
                `historian no-op: chunk empty after filtering (messageCount=${chunk.messageCount}, textLen=${chunk.text?.length ?? 0}) range=${offset}-${eligibleEndOrdinal - 1}`,
            );
            if (boundarySnapshot.usagePercentage < 80 && !boundarySnapshot.emergencyTailScale) {
                if (!isWrapupInProgress(db, sessionId)) clearEmergencyRecovery(db, sessionId);
            } else {
                recordHighPressureNoEligibleHead(db, boundarySnapshot);
            }
            // Eligible head produced no compactable chunk — treat as tail-exhausted
            // and clear the catch-up latch (see the protected-tail no-op above).
            clearEmergencyDrainLatch(db, sessionId);
            telemetry.status = "noop";
            telemetry.failureReason = "chunk empty after filtering";
            rollbackDrainReservation();
            return;
        }
        const chunkText = truncateHistorianInputIfNeeded(chunk.text, historianChunkTokens);
        if (chunkText !== chunk.text) {
            sessionLog(
                sessionId,
                `historian pre-flight: truncated formatted input for ${chunk.startIndex}-${chunk.endIndex} to fit ${historianChunkTokens} tokens`,
            );
        }

        const chunkCoverageError = validateChunkCoverage(chunk);
        if (chunkCoverageError) {
            telemetry.failureReason = `chunk-coverage: ${chunkCoverageError}`;
            sessionLog(
                sessionId,
                `historian failure: source=chunk-coverage reason="${chunkCoverageError}" chunkRange=${chunk.startIndex}-${chunk.endIndex}`,
            );
            // Record this so `doctor --issue` reports it and `>=95%` abort
            // can react. Previously this path was silent (no failure count,
            // recovery flag unchanged), making the loop bug invisible in
            // diagnostics.
            const failCount = incrementHistorianFailure(db, sessionId, chunkCoverageError);
            await notifyHistorianIssue(buildHistorianFailureNotice(failCount, chunkCoverageError));
            rollbackDrainReservation();
            return;
        }

        // Past every synchronous no-op early-return and immediately before the
        // first `await` (client.session.get below): we are now committed to a
        // real historian pass. Signal the caller so startCompartmentAgent keeps
        // the active-run registration; a synchronous no-op above never reaches
        // here, so its lingering registration is cleared instead of blocking the
        // same transform pass's pending-op drain.
        deps.onHistorianRunStarted?.();

        // v2 bounded reference model (replaces the unbounded existing_state dump):
        //   - 4 rotating cross-project seeds + last-6 recency compartments (no
        //     embedding at historian time), built from this session's prior
        //     compartments.
        //   - <project-memory> for fact dedup (consolidation-bounded).
        // No temp-file offload needed — the bounded blocks stay well within
        // serialization limits.
        const projectPath = resolveProjectIdentity(directory ?? process.cwd());
        const memories = getMemoriesByProject(db, projectPath, ["active", "permanent"]);
        const projectMemory = renderMemoryBlock(memories) ?? "";

        const references = buildReferenceBlocks({
            sessionId,
            chunkStart: chunk.startIndex,
            sessionCompartments: priorCompartments,
        });

        const prompt = buildCompartmentAgentPrompt({
            seedExamples: references.seedExamples,
            sessionReferences: references.sessionReferences,
            projectMemory,
            inputSource: `Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunkText}`,
            memoryEnabled: deps.memoryEnabled !== false,
        });

        // Intentional: session.get failure is non-fatal — we fall back to deps.directory
        const parentSessionResponse = await client.session
            .get({ path: { id: sessionId } })
            .catch(() => null);
        const parentSession = normalizeSDKResponse(
            parentSessionResponse,
            null as { directory?: string } | null,
            { preferResponseOnMissingData: true },
        );
        const sessionDirectory = parentSession?.directory ?? directory;

        // Defensive: use MAX(sequence) + 1 rather than .length. These only
        // differ when the current DB state has a gap or non-zero-indexed
        // sequences (e.g., from an older partial recomp that wrote off-by-one
        // sequences). Using .length would pick a sequence that collides with
        // an existing row and trigger "UNIQUE constraint failed:
        // compartments.session_id, compartments.sequence" on insert.
        const maxExistingSequence = priorCompartments.reduce(
            (max, c) => (c.sequence > max ? c.sequence : max),
            -1,
        );
        const sequenceOffset = priorCompartments.length === 0 ? 0 : maxExistingSequence + 1;

        retainDrainReservationForRetryThrottle = true;
        const validatedPass = await runValidatedHistorianPass({
            client,
            db,
            parentSessionId: sessionId,
            sessionDirectory,
            prompt,
            chunk,
            priorCompartments,
            sequenceOffset,
            dumpLabelBase: `incremental-${sessionId}-${chunk.startIndex}-${chunk.endIndex}`,
            timeoutMs: historianTimeoutMs,
            fallbackModelId: deps.fallbackModelId,
            fallbackModels: deps.fallbackModels,
            twoPass: deps.historianTwoPass,
            language: deps.language,
        });
        if (!validatedPass.ok) {
            // Always track historian failures regardless of usage percentage.
            // The emergency abort path at 95% checks failureCount > 0, so failures
            // at any pressure level must be recorded.
            sessionLog(
                sessionId,
                `historian failure: source=validation reason="${validatedPass.error}" chunkRange=${chunk.startIndex}-${chunk.endIndex} fallbackModel=${deps.fallbackModelId ?? "<none>"} twoPass=${deps.historianTwoPass ? "true" : "false"}`,
            );
            const failCount = incrementHistorianFailure(db, sessionId, validatedPass.error);
            telemetry.failureReason = `validation: ${validatedPass.error}`;
            await notifyHistorianIssue(buildHistorianFailureNotice(failCount, validatedPass.error));
            return;
        }
        retainDrainReservationForRetryThrottle = false;

        const emittedCompartments = validatedPass.compartments;

        // Discard-last boundary healing: the LAST compartment of a greedy-consume
        // run was decided WITHOUT lookahead (historian can't see past the chunk),
        // so its boundary is structurally unreliable — unlike every earlier
        // compartment, which the messages that followed it validated. If historian
        // consumed ~the whole chunk (≤ BOUNDARY_HEALING_SLACK messages of lookahead
        // past the last compartment), drop that provisional last compartment so it
        // is re-derived next run with real following context. The existing
        // `offset = lastCompartment.end + 1` logic then re-reads its range at the
        // head — zero extra plumbing. Guards:
        //   - at least two compartments were emitted, so one remains and publication advances.
        //   - the retained boundary cannot split a completed invocation/result pair.
        //   - not emergency: at ≥95% recovery we need maximum relief NOW, so keep
        //     all k and accept the boundary risk (correctness > quality).
        // Self-healing: a wrong discard re-derives the same compartment next run
        // (now non-last → persisted), so erring toward more slack is safe.
        const inEmergency = getOverflowState(db, sessionId).needsEmergencyRecovery;
        let persistedCompartments = emittedCompartments;
        if (
            !inEmergency &&
            !forceKeepLastCompartmentForChunk &&
            shouldDiscardLastHistorianCompartment(emittedCompartments, chunk)
        ) {
            const lastEmitted = emittedCompartments[emittedCompartments.length - 1];
            const lookaheadMargin = chunk.endIndex - lastEmitted.endMessage;
            persistedCompartments = emittedCompartments.slice(0, -1);
            telemetry.discardedLast = true;
            sessionLog(
                sessionId,
                `historian discard-last: dropped provisional compartment ${lastEmitted.startMessage}-${lastEmitted.endMessage} (lookaheadMargin=${lookaheadMargin} <= ${HISTORIAN_BOUNDARY_HEALING_SLACK}); will re-derive from raw next run`,
            );
        }

        const newCompartments = persistedCompartments;

        const lastNewEnd = newCompartments[newCompartments.length - 1]?.endMessage ?? 0;
        if (lastNewEnd + 1 <= offset) {
            telemetry.failureReason = `no forward progress beyond raw message ${offset - 1}`;
            sessionLog(
                sessionId,
                `historian failure: source=no-progress reason="historian returned compartments that did not advance past raw message ${offset - 1}" newCompartmentCount=${newCompartments.length} lastNewEnd=${lastNewEnd} priorEnd=${offset - 1}`,
            );
            const failCount = incrementHistorianFailure(
                db,
                sessionId,
                `no forward progress beyond raw message ${offset - 1}`,
            );
            await notifyHistorianIssue(
                buildHistorianFailureNotice(
                    failCount,
                    `historian made no forward progress beyond raw message ${offset - 1}`,
                ),
            );
            return;
        }

        retainDrainReservationForRetryThrottle = false;

        // Plan v6 §4: when the runner is preserving the injection cache,
        // defer marker movement until a later materializing transform pass.
        // We persist a pending blob INSIDE the same publish transaction so a
        // crash between publish and drain cannot leave the marker out of sync
        // — either both land or neither does. The drain in
        // transform-postprocess-phase consumes the blob via
        // `applyDeferredCompactionMarker`.
        //
        // Direct apply (legacy path) still fires for non-deferring callers
        // (recomp / partial-recomp / explicit flushes), which clear the
        // injection cache eagerly anyway.
        const deferMarkerApplication = deps.preserveInjectionCacheUntilConsumed === true;

        const lastCompartmentEnd = lastNewEnd;
        const lastNewEndMessageId = newCompartments[newCompartments.length - 1]?.endMessageId;

        // Use the RESOLVED session directory for memory project identity, not
        // raw deps.directory. deps.directory can be empty even
        // when the session has a valid directory (resolved via session.get
        // above); using it directly made promotion + embedding silently no-op.
        const promotionDirectory = sessionDirectory || deps.directory;

        // Unanchored promotion (facts/observations/primers) is skipped in two
        // distinct weak-boundary cases:
        //  - discard-last: the provisional tail compartment was dropped, and facts
        //    are unanchored so persisted-range facts cannot be separated from
        //    discarded-tail facts; a reworded re-emission next run would double up.
        //  - forced final keep: a wrapup's actual final chunk persists its
        //    weak-lookahead tail for coverage, but nothing durable is extracted
        //    from a boundary the discard-last heuristic would have distrusted.
        // A wrapup caller may request final weak-lookahead preservation, but the
        // runner is authoritative: a token-capped chunk (`chunk.hasMore`) still has
        // more raw history after it, so it must use normal discard-last healing and
        // promotion.
        const discardedLast = persistedCompartments.length < emittedCompartments.length;
        const weakLookaheadFinalCompartment = forceKeepLastCompartmentForChunk;
        const skipUnanchoredPromotion = discardedLast || weakLookaheadFinalCompartment;

        // Issue #44: gate promotion behind both `memory.enabled` and
        // `memory.auto_promote`. Without this, historian unconditionally
        // wrote project memories (with embeddings) even for users who
        // explicitly disabled the memory feature in config.
        // Two distinct gates:
        //  - embeddingActive: embeddings + project registration fire whenever the
        //    memory FEATURE is enabled. They are the substrate for ctx_search +
        //    future dreamer cross-linking and must NOT depend on auto_promote.
        //  - promotionActive: writing facts as project memories additionally
        //    requires auto_promote (a user who disabled auto-promotion still wants
        //    search/embedding, just not auto-written memories).
        const embeddingActive = !!promotionDirectory && deps.memoryEnabled !== false;
        const promotionActive = embeddingActive && deps.autoPromote !== false;
        const promotionProjectIdentity = promotionDirectory
            ? resolveProjectIdentity(promotionDirectory)
            : "";

        // discard-last: drop events anchored to the discarded provisional
        // compartment (atCompartment is a 1-based index into the EMITTED list;
        // anything > persistedCompartments.length pointed at the dropped tail).
        // They re-emit next run anchored to the persisted range.
        const publishableEvents = (validatedPass.events ?? []).filter((e) => {
            if (typeof e.atCompartment !== "number") return !weakLookaheadFinalCompartment;
            if (e.atCompartment > persistedCompartments.length) return false;
            if (weakLookaheadFinalCompartment && e.atCompartment >= emittedCompartments.length) {
                return false;
            }
            return true;
        });
        let promotedFactRefs: Array<{ memoryId: number; content: string }> = [];
        let persistedIds: number[] = [];

        // Append new compartments (existing stay untouched in DB) and publish all
        // synchronous durable side effects atomically. BEGIN IMMEDIATE ensures the
        // lease holder check and subsequent writes share one fresh write-locked
        // snapshot across sibling processes.
        const holderId = deps.compartmentLeaseHolderId;
        if (!holderId) {
            sessionLog(sessionId, "historian publish skipped: missing compartment lease holder");
            rollbackDrainReservation();
            return;
        }
        let published = false;
        const transactionStartedAt = performance.now();
        db.exec("BEGIN IMMEDIATE");
        try {
            if (!isCompartmentLeaseHeld(db, sessionId, holderId)) {
                db.exec("ROLLBACK");
                rollbackDrainReservation();
                sessionLog(
                    sessionId,
                    "historian publish skipped: compartment lease no longer held",
                );
                return;
            }
            appendCompartments(db, sessionId, persistedCompartments);
            // v2 (E2): resolve durable ids for the compartments we just appended.
            // They are the last `persistedCompartments.length` rows by sequence
            // (appendCompartments inserts at the tail). Used for events anchoring +
            // embedding. Pure DB read — cheap, no message mutation.
            persistedIds = getCompartments(db, sessionId)
                .slice(-persistedCompartments.length)
                .map((c) => c.id);
            // v2 faithful fact lifecycle: facts are NOT a REPLACE-the-whole-list
            // store anymore. The historian emits only THIS chunk's facts (deduped
            // against <project-memory> in the prompt); they flow to project memory
            // via in-transaction durable promotion. session_facts is no longer
            // written/bumped. Promotion is in the SAME transaction as the boundary
            // floor below so a crash cannot advance past facts that never became
            // project memories.
            if (promotionActive && !skipUnanchoredPromotion) {
                try {
                    promotedFactRefs = promoteSessionFactsDurable(
                        db,
                        sessionId,
                        promotionProjectIdentity,
                        validatedPass.facts ?? [],
                    );
                } catch (error) {
                    if (error instanceof ModuleMemoryAuthorityError) {
                        // A project flipped back to the TS transform can still have
                        // MODULE memory authority (authority does not follow the
                        // transform-mode knob). Fact promotion is a side channel;
                        // failing the whole publish here blocks history compaction
                        // entirely, which starves overflow recovery. Skip the facts,
                        // keep the compartments.
                        promotedFactRefs = [];
                        sessionLog(
                            sessionId,
                            "fact promotion skipped: project memory is module-managed; compartments publish without facts",
                        );
                    } else {
                        throw error;
                    }
                }
            }

            // v2 (E2): persist historian-extracted events (stored, NOT rendered).
            // Independent of memory flags — events are a separate corpus for a future
            // dreamer aggregation feature, not project memory. Best-effort and
            // re-derivable, so an event failure logs and does NOT abort facts/boundary.
            if (publishableEvents.length > 0) {
                try {
                    insertCompartmentEvents(db, sessionId, publishableEvents, persistedIds);
                    sessionLog(
                        sessionId,
                        `stored ${publishableEvents.length} compartment event(s)`,
                    );
                } catch (error) {
                    sessionLog(sessionId, "failed to store compartment events:", error);
                }
            }

            queueDropsForCompartmentalizedMessages(db, sessionId, lastCompartmentEnd);

            clearHistorianFailureState(db, sessionId);
            // Healthy historian progress — clear the drain-failure backoff so the
            // emergency catch-up latch can bypass the budget freely again.
            clearHistorianDrainFailure(db, sessionId);
            // Normal historian publication resolves overflow recovery. A manual
            // wrapup can publish several chunks before reaching its keep watermark,
            // so it leaves the recovery flag armed until the orchestrator finishes.
            recordProtectedTailPublicationFloor(db, sessionId, lastCompartmentEnd + 1);
            if (!isWrapupInProgress(db, sessionId)) clearEmergencyRecovery(db, sessionId);
            drainReservation = null;
            if (deferMarkerApplication && lastNewEndMessageId) {
                setPendingCompactionMarkerState(db, sessionId, {
                    ordinal: lastCompartmentEnd,
                    endMessageId: lastNewEndMessageId,
                    publishedAt: Date.now(),
                });
            }
            db.exec("COMMIT");
            published = true;
            logSlowWriteTransaction("historian-publish", transactionStartedAt);
        } finally {
            if (!published) {
                try {
                    db.exec("ROLLBACK");
                } catch {
                    // Transaction may already be closed by an early rollback.
                }
            }
        }
        // Background publication normally preserves the injection cache until
        // a materializing pass can rebuild history and apply queued drops
        // together. Explicit recomp paths leave preserve=false and invalidate
        // immediately.
        if (deps.preserveInjectionCacheUntilConsumed !== true) {
            clearInjectionCache(sessionId);
        }

        // Signal publication immediately after COMMIT. All publish-visible durable
        // state (compartments, boundary floor, promoted facts, event attempts, and
        // drop queue) is already in the transaction above; embedding registration
        // and provider calls below are post-commit best-effort and must never leave
        // a committed publish marked failed or unsignaled.
        deps.onCompartmentStatePublished?.(sessionId);

        // Inject compaction marker into OpenCode's DB.
        // When deferring (plan v6 §4), the pending blob was already written
        // in-transaction and `onDeferredMarkerPending` signals the drain set.
        // When NOT deferring, fall back to the legacy direct-apply path.
        if (deferMarkerApplication) {
            deps.onDeferredMarkerPending?.(sessionId);
        } else {
            updateCompactionMarkerAfterPublication(
                db,
                sessionId,
                lastCompartmentEnd,
                sessionDirectory,
            );
        }

        // v2: the LLM compressor is gone — deterministic decay-tier rendering
        // (decay-render.ts) replaces it. Older compartments demote tiers at
        // render time with no LLM pass.
        updateSessionMeta(db, sessionId, { compartmentInProgress: false });
        completedSuccessfully = true;

        // historian_runs telemetry — full success metrics (recorded in finally).
        {
            const facts = validatedPass.facts ?? [];
            const validIds = persistedIds.filter((id): id is number => typeof id === "number");
            const imp = summarizeImportance(persistedCompartments.map((c) => c.importance ?? 50));
            telemetry.status = "success";
            telemetry.failureReason = null;
            telemetry.unprocessedFrom = lastCompartmentEnd + 1;
            telemetry.compartmentsProduced = persistedCompartments.length;
            telemetry.compartmentIdMin = validIds.length > 0 ? Math.min(...validIds) : null;
            telemetry.compartmentIdMax = validIds.length > 0 ? Math.max(...validIds) : null;
            telemetry.factsEmitted = facts.length;
            telemetry.factsByCategory = facts.length > 0 ? tallyFactsByCategory(facts) : null;
            telemetry.eventsEmitted = publishableEvents.length;
            telemetry.importanceMin = imp.min;
            telemetry.importanceMax = imp.max;
            telemetry.importanceAvg = imp.avg;
            // legacy stays false — incremental publish always produces v2 rows.
        }

        onNoteTrigger(db, sessionId, "historian_complete");

        // v2: compute + store raw chunk embeddings (the ctx_search semantic
        // substrate over session history). Fire-and-forget, best-effort, gated by
        // memory flags so a memory-off user never hits the embedding endpoint.
        if (embeddingActive) {
            const chunksToEmbed = persistedCompartments
                .map((c, i) => ({
                    id: persistedIds[i],
                    startMessage: c.startMessage,
                    endMessage: c.endMessage,
                    sourceChunkText: chunk.text,
                }))
                .filter((c) => typeof c.id === "number");
            void (async () => {
                try {
                    await deps.ensureProjectRegistered?.(promotionDirectory, db);
                } catch (error) {
                    sessionLog(sessionId, "project registration after publish failed:", error);
                }
                try {
                    await embedPromotedFacts(
                        db,
                        sessionId,
                        promotionProjectIdentity,
                        promotedFactRefs,
                    );
                } catch (error) {
                    sessionLog(sessionId, "promoted fact embedding dispatch failed:", error);
                }
                try {
                    await embedAndStoreCompartmentChunks(
                        db,
                        sessionId,
                        promotionProjectIdentity,
                        chunksToEmbed,
                    );
                } catch (error) {
                    sessionLog(sessionId, "compartment embedding dispatch failed:", error);
                }
            })();
        }

        // Store user behavior observations as candidates ONLY when the user-memory
        // feature is enabled. Without this gate we'd persist behavioral candidates
        // for users who opted out of user memories entirely (privacy).
        // Actual final wrapup chunks skip unanchored observations because the kept
        // tail has weak lookahead; token-capped chunks still promote observations
        // so facts from a never-re-read persisted range are not lost.
        if (
            deps.experimentalUserMemories === true &&
            !skipUnanchoredPromotion &&
            validatedPass.userObservations &&
            validatedPass.userObservations.length > 0
        ) {
            try {
                const lastNew = newCompartments[newCompartments.length - 1];
                insertUserMemoryCandidates(
                    db,
                    validatedPass.userObservations.map((obs) => ({
                        content: obs,
                        sessionId,
                        sourceCompartmentStart: newCompartments[0]?.startMessage,
                        sourceCompartmentEnd: lastNew?.endMessage,
                    })),
                );
                sessionLog(
                    sessionId,
                    `stored ${validatedPass.userObservations.length} user memory candidate(s)`,
                );
            } catch (error) {
                sessionLog(sessionId, "failed to store user memory candidates:", error);
            }
        }

        // Primers v1 are recall-only side-table writes (dashboard + ctx_search),
        // never prompt injection. Use the same actual-final weak-lookahead gate as
        // facts and observations.
        if (
            !skipUnanchoredPromotion &&
            promotionProjectIdentity &&
            validatedPass.primerCandidates &&
            validatedPass.primerCandidates.length > 0
        ) {
            try {
                const firstNew = newCompartments[0];
                const lastNew = newCompartments[newCompartments.length - 1];
                // The stable occurrence key intentionally excludes question text;
                // therefore a source chunk stores at most one candidate occurrence
                // (its origin-compartment tag is the single tagged origin).
                const [candidate] = validatedPass.primerCandidates;
                // Origin-tag: narrow the source to the SPECIFIC compartment the
                // question came from (refresh-primers seeds its investigation from
                // that compartment's raw chunk). `originCompartmentIndex` is 1-based
                // into the emitted list — the SAME convention as <events>
                // at_compartment. Fall back to the chunk span when untagged or
                // out of range (loose but non-fatal — never fail the pass).
                const idx = candidate.originCompartmentIndex;
                const origin =
                    typeof idx === "number" && idx >= 1 && idx <= newCompartments.length
                        ? newCompartments[idx - 1]
                        : undefined;
                const startC = origin ?? firstNew;
                const endC = origin ?? lastNew;
                const sourceStartMessageId =
                    startC?.startMessageId || `ordinal:${startC?.startMessage ?? chunk.startIndex}`;
                const sourceEndMessageId =
                    endC?.endMessageId || `ordinal:${endC?.endMessage ?? lastCompartmentEnd}`;
                const times = getMessageTimesFromOpenCodeDb(sessionId, [sourceStartMessageId]);
                const sourceMessageTime = times.get(sourceStartMessageId) ?? Date.now();
                const stored = insertPrimerCandidates(db, [
                    {
                        projectPath: promotionProjectIdentity,
                        harness: "opencode",
                        sessionId,
                        question: candidate.question,
                        sourceCompartmentStart: startC?.startMessage,
                        sourceCompartmentEnd: endC?.endMessage,
                        sourceStartMessageId,
                        sourceEndMessageId,
                        sourceMessageTime,
                    },
                ]);
                sessionLog(
                    sessionId,
                    `stored ${stored.length} primer candidate occurrence(s)${origin ? " (origin-tagged)" : " (chunk-span fallback)"}`,
                );
            } catch (error) {
                sessionLog(sessionId, "failed to store primer candidates:", error);
            }
        }
    } catch (error: unknown) {
        // Historian runs are fail-closed because they update durable compartment state.
        const desc = describeError(error);
        telemetry.failureReason = `exception: ${desc.brief}`;
        sessionLog(
            sessionId,
            `historian failure: source=exception ${desc.brief}${desc.stackHead ? ` stackHead="${desc.stackHead}"` : ""}`,
        );
        if (!issueNotified) {
            const failCount = incrementHistorianFailure(db, sessionId, desc.brief);
            await notifyHistorianIssue(buildHistorianFailureNotice(failCount, desc.brief));
        }
    } finally {
        if (!completedSuccessfully) {
            if (!retainDrainReservationForRetryThrottle) {
                rollbackDrainReservation();
            } else {
                // A genuine historian failure (model error / no output / invalid
                // output) — the same condition that retains the drain reservation as
                // a retry throttle. Record it so the emergency catch-up latch's
                // bypass is suppressed for a short backoff and a broken historian
                // can't retry-thrash every pass under the latch.
                recordHistorianDrainFailure(db, sessionId);
            }
            updateSessionMeta(db, sessionId, { compartmentInProgress: false });
        }
        // Record one historian_runs row for this attempt (every exit path).
        recordTelemetry();
        cleanupHistorianStateFile(stateFilePath);
    }
}
