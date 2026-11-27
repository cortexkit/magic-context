import { HISTORIAN_RECOMP_AGENT } from "../../agents/historian";
import { deleteChunkEmbedBackoffForSession } from "../../features/magic-context/compartment-chunk-embedding";
import { embedAndStoreCompartmentChunks } from "../../features/magic-context/compartment-embedding";
import { isCompartmentLeaseHeld } from "../../features/magic-context/compartment-lease";
import {
    clearRecompStaging,
    type Compartment,
    getCompartments,
    getRecompPartialRange,
    getRecompStaging,
    type RecompStaging,
    saveRecompStagingPass,
} from "../../features/magic-context/compartment-storage";
import {
    clearCompressionDepth,
    clearCompressionDepthRange,
} from "../../features/magic-context/compression-depth-storage";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { appendM0Mutation } from "../../features/magic-context/storage";
import {
    recordHistorianRun,
    summarizeImportance,
    tallyFactsByCategory,
} from "../../features/magic-context/storage-historian-runs";
import {
    clearCachedM0M1,
    clearPendingCompactionMarkerStateIf,
    getPendingCompactionMarkerState,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import { normalizeSDKResponse } from "../../shared";
import { getErrorMessage } from "../../shared/error-message";
import { getHarness } from "../../shared/harness";
import { sessionLog } from "../../shared/logger";
import { RECOMP_PAUSED_HEADING } from "../../shared/recomp-outcome";
import type { Database } from "../../shared/sqlite";
import {
    renderUserFacingFailure,
    type UserFacingFailureKey,
    userFacingFailureCode,
} from "../../shared/user-facing-codes";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";
import { updateCompactionMarkerAfterPublication } from "./compaction-marker-manager";
import { buildCompartmentAgentPrompt } from "./compartment-prompt";
import { queueDropsForCompartmentalizedMessages } from "./compartment-runner-drop-queue";
import { runValidatedHistorianPass } from "./compartment-runner-historian";
import { compartmentToInput } from "./compartment-runner-recomp-carry";
import type { CandidateCompartment, CompartmentRunnerDeps } from "./compartment-runner-types";
import {
    getReducedRecompTokenBudget,
    validateChunkCoverage,
    validateStoredCompartments,
} from "./compartment-runner-validation";
import { invalidateAutoEmbedSession } from "./embed-session-state";
import { describeHistorianPromptTrim, fitRecompHistorianPrompt } from "./historian-prompt-fit";
import { clearInjectionCache } from "./inject-compartments";
import {
    createDefaultBoundarySnapshotForTests,
    resolveOpenCodeProtectedTailBoundary,
} from "./protected-tail-boundary";
import {
    getRawSessionMessageCount,
    getRawSessionTagKeysThrough,
    prepareRawSessionOrdinals,
    readRawSessionMessageIdOrdinalsForRange,
    readRawSessionMessageOrdinalById,
    readSessionChunk,
} from "./read-session-chunk";
import { sendStatusNotification } from "./send-session-notification";

type CarriedRowsBySequence = ReadonlyMap<number, Pick<Compartment, "legacy" | "rebaseStatus">>;

function insertRecompCompartmentRows(
    db: Database,
    sessionId: string,
    compartments: CandidateCompartment[],
    now: number,
    carriedRows?: CarriedRowsBySequence,
): void {
    // Carried rows keep their stored payload, boundaries, legacy and rebase status.
    // The replacement gives them a new row id and sequence, and deliberately renews
    // created_at just as range recomp always has. Fresh summaries derive legacy from P1.
    const stmt = db.prepare(
        `INSERT INTO compartments (session_id, sequence, start_message, end_message,
            start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance,
            episode_type, legacy, created_at, harness, start_block_index, end_block_index, rebase_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of compartments) {
        const hasTiers = typeof c.p1 === "string" && c.p1.length > 0;
        const carried = carriedRows?.get(c.sequence);
        stmt.run(
            sessionId,
            c.sequence,
            c.startMessage,
            c.endMessage,
            c.startMessageId,
            c.endMessageId,
            c.title,
            c.content,
            c.p1 ?? null,
            c.p2 ?? null,
            c.p3 ?? null,
            c.p4 ?? null,
            typeof c.importance === "number" ? c.importance : 50,
            c.episodeType ?? null,
            carried?.legacy ?? (hasTiers ? 0 : 1),
            now,
            getHarness(),
            c.startBlockIndex ?? null,
            c.endBlockIndex ?? null,
            carried?.rebaseStatus ?? "ok",
        );
    }
}

export function promoteRecompStagingWithM0Mutation(
    db: Database,
    sessionId: string,
    holderId: string,
    carriedRows?: CarriedRowsBySequence,
): RecompPromotion | null {
    const promoted = promoteRecompStaging(db, sessionId, holderId, undefined, carriedRows);
    return typeof promoted === "string" ? null : promoted;
}

type RecompPromotion = {
    compartments: CandidateCompartment[];
    facts: Array<{ category: string; content: string }>;
    carriedCount: number;
    carriedThrough: number | null;
};

type StoppedRecomp = { allowCarry: boolean; discardIfShort: boolean };
type PromotionResult =
    | RecompPromotion
    | "would-shrink"
    | "discarded"
    | "staging-removed"
    | "lease-lost";

function promoteRecompStaging(
    db: Database,
    sessionId: string,
    holderId: string,
    stopped?: StoppedRecomp,
    carriedRows?: CarriedRowsBySequence,
): PromotionResult {
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    const transactionStartedAt = performance.now();
    let finished = false;
    try {
        if (!isCompartmentLeaseHeld(db, sessionId, holderId)) {
            db.exec("ROLLBACK");
            finished = true;
            return "lease-lost";
        }

        const staging = getRecompStaging(db, sessionId);
        const staged = staging?.compartments.at(-1);
        if (!staging || !staged) {
            db.exec("ROLLBACK");
            finished = true;
            return "staging-removed";
        }

        let carried: ReturnType<typeof readAlignedLiveTail> = null;
        if (stopped) {
            const live = readLiveRanges(db, sessionId);
            const stagedEnd = resolvedOrdinal(sessionId, staged.endMessageId) ?? staged.endMessage;
            if (live.some((row) => row.end > stagedEnd)) {
                if (stopped.allowCarry)
                    carried = readAlignedLiveTail(db, sessionId, live, staging, stagedEnd);
                if (!carried) {
                    if (stopped.discardIfShort) {
                        clearRecompStaging(db, sessionId);
                        db.exec("COMMIT");
                        finished = true;
                        return "discarded";
                    }
                    db.exec("ROLLBACK");
                    finished = true;
                    return "would-shrink";
                }
            }
        }
        const compartments = carried
            ? [...staging.compartments, ...carried.compartments]
            : staging.compartments;

        deleteChunkEmbedBackoffForSession(db, sessionId);
        db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        // v2 faithful facts: recomp does NOT write session_facts. Facts are a
        // promoted-memory concern now, and recomp must not emit facts at all
        // (re-processing curated memories would degrade them — locked rule).
        // The renderer no longer reads session_facts, so we clear any legacy
        // rows for hygiene and never re-insert.
        db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);
        insertRecompCompartmentRows(db, sessionId, compartments, now, carried?.rows ?? carriedRows);
        appendM0Mutation(db, {
            sessionId,
            mutationType: "recomp_boundary_change",
            targetId: null,
            queuedAt: now,
        });
        db.prepare("DELETE FROM recomp_compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM recomp_facts WHERE session_id = ?").run(sessionId);
        clearCachedM0M1(db, sessionId);

        db.exec("COMMIT");
        finished = true;
        invalidateAutoEmbedSession(sessionId);
        logSlowWriteTransaction("historian-publish:recomp", transactionStartedAt);
        return {
            compartments,
            facts: staging.facts,
            carriedCount: carried?.compartments.length ?? 0,
            carriedThrough: carried?.end ?? null,
        };
    } finally {
        if (!finished) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // Transaction may already be closed by SQLite after an error.
            }
        }
    }
}

function resolvedOrdinal(sessionId: string, id: string | null): number | null {
    return id ? readRawSessionMessageOrdinalById(sessionId, id) : null;
}

function readLiveRanges(db: Database, sessionId: string) {
    const rows = db
        .prepare(
            `SELECT sequence, start_message, start_message_id, end_message, end_message_id FROM compartments
         WHERE session_id = ? ORDER BY sequence`,
        )
        .all(sessionId) as Array<{
        sequence: number;
        start_message: number;
        start_message_id: string | null;
        end_message: number;
        end_message_id: string | null;
    }>;
    return rows.map((row) => {
        const resolvedEnd = resolvedOrdinal(sessionId, row.end_message_id);
        return { ...row, end: resolvedEnd ?? row.end_message, resolvedEnd };
    });
}

function readAlignedLiveTail(
    db: Database,
    sessionId: string,
    live: ReturnType<typeof readLiveRanges>,
    staging: RecompStaging,
    stagedEnd: number,
): { compartments: CandidateCompartment[]; rows: CarriedRowsBySequence; end: number } | null {
    let next = 1;
    let seam: number | undefined;
    for (const row of live) {
        const start = resolvedOrdinal(sessionId, row.start_message_id);
        // The resulting union must be the same prefix, not a repaired or expanded one.
        if ((start ?? row.start_message) !== next || row.end < next) return null;
        if (seam !== undefined && (start === null || row.resolvedEnd === null)) return null;
        if (row.end === stagedEnd) seam = row.sequence;
        next = row.end + 1;
    }
    if (seam === undefined) return null;
    const seamSequence = seam;
    const tail = getCompartments(db, sessionId).filter((row) => row.sequence > seamSequence);
    if (!tail.length || tail.length !== live.filter((row) => row.sequence > seamSequence).length)
        return null;
    return {
        compartments: tail.map((row, index) =>
            compartmentToInput(row, staging.compartments.length + index),
        ),
        rows: new Map(tail.map((row, index) => [staging.compartments.length + index, row])),
        end: next - 1,
    };
}

function getResumableFullStaging(
    db: Database,
    sessionId: string,
    rawMessageCount: number,
): RecompStaging | null {
    const staging = getRecompStaging(db, sessionId);
    let reason: string | null = null;
    if (getRecompPartialRange(db, sessionId)) {
        reason = "the staged passes were for a range rebuild";
    } else if (staging) {
        reason = validateStoredCompartments(staging.compartments);
        if (!reason) {
            const ordinals = readRawSessionMessageIdOrdinalsForRange(
                sessionId,
                1,
                Math.min(rawMessageCount, staging.lastEndMessage),
            );
            if (
                staging.compartments.some(
                    ({ startMessage, endMessage, startMessageId, endMessageId }) =>
                        ordinals.get(startMessageId) !== startMessage ||
                        ordinals.get(endMessageId) !== endMessage,
                )
            ) {
                reason = "staged endpoints no longer match the raw history";
            }
        }
    }
    if (!reason) return staging;
    clearRecompStaging(db, sessionId);
    sessionLog(sessionId, `recomp discarded staging: ${reason}`);
    return null;
}

const PUBLISH_LEASE_LOST =
    "## Magic Recomp — Skipped\n\nAnother process acquired the compartment-state lease before recomp could publish. No state was written.";
const STAGING_REMOVED =
    "## Magic Recomp — Failed\n\nThe unfinished rebuild was removed because the session's history changed. Nothing was published.\nRun /ctx-recomp again.";

export async function executeContextRecompInternal(deps: CompartmentRunnerDeps): Promise<string> {
    const {
        client,
        db,
        sessionId,
        historianChunkTokens,
        directory,
        historianTimeoutMs,
        getNotificationParams,
    } = deps;
    const notifParams = () => getNotificationParams?.() ?? {};
    const holderId = deps.compartmentLeaseHolderId;
    if (!holderId) {
        return "## Magic Recomp — Skipped\n\nCould not acquire the compartment-state lease for this session.";
    }
    const leaseHolderId = holderId;
    if (!(await prepareRawSessionOrdinals(sessionId)))
        return "## Magic Recomp — Deferred\n\nSession ordinals are warming in the background. Retry shortly; no history was rebuilt.";
    // Once promotion commits, the rebuilt compartments are the session's history. The
    // steps after it (depth reset, drop queue, publication signal, embedding, compaction
    // marker) can each be repaired later. One failing must not report the committed
    // recomp as failed or skip the steps after it, the publication signal included.
    const logPostPublishFailure = (step: string, error: unknown): void => {
        sessionLog(
            sessionId,
            `recomp post-publish step=${step} failed; publication stands: ${getErrorMessage(error)}`,
        );
    };
    // Synchronous on purpose: wrapping a step must not add a yield point between
    // promotion and the publication signal, where a concurrent transform pass could
    // observe the promoted rows before the drop queue and signal are in place.
    const afterPublish = (step: string, run: () => void): void => {
        try {
            run();
        } catch (error) {
            logPostPublishFailure(step, error);
        }
    };
    const afterPublishAsync = async (step: string, run: () => Promise<void>): Promise<void> => {
        try {
            await run();
        } catch (error) {
            logPostPublishFailure(step, error);
        }
    };
    // State file for the current pass — hoisted to be accessible in finally{}
    updateSessionMeta(db, sessionId, { compartmentInProgress: true });

    try {
        const rawMessageCount = getRawSessionMessageCount(sessionId);
        const existingStaging = getResumableFullStaging(db, sessionId, rawMessageCount);
        if (rawMessageCount <= 0) {
            return "## Magic Recomp\n\nNo raw history exists, so nothing was rebuilt.";
        }
        const boundarySnapshot =
            process.env.NODE_ENV === "test"
                ? createDefaultBoundarySnapshotForTests(sessionId)
                : resolveOpenCodeProtectedTailBoundary({
                      db,
                      sessionId,
                      mode: "manual-full-recomp",
                      contextLimit: 128_000,
                      executeThresholdPercentage: 65,
                      usage: null,
                      usageSource: "provisional-zero",
                  });
        const protectedTailStart = Math.min(
            boundarySnapshot.protectedTailStart,
            rawMessageCount + 1,
        );
        // Intentional: session.get failure is non-fatal — we fall back to deps.directory.
        // OpenCode 2 hands the runner no SDK client, so the lookup is skipped there.
        const parentSessionResponse = await client?.session
            .get({ path: { id: sessionId } })
            .catch(() => null);
        const parentSession = normalizeSDKResponse(
            parentSessionResponse,
            null as { directory?: string } | null,
            { preferResponseOnMissingData: true },
        );
        const sessionDirectory = parentSession?.directory ?? directory;

        // v2: no <project-memory> dedup block for recomp — it emits no facts to
        // memory (structural rebuild only), so there is nothing to dedup against.

        // ── Resume from staging if a previous run paused or was interrupted ──
        let candidateCompartments: CandidateCompartment[] = existingStaging?.compartments ?? [];
        let candidateFacts: Array<{ category: string; content: string }> =
            existingStaging?.facts ?? [];
        let offset = existingStaging ? existingStaging.lastEndMessage + 1 : 1;
        let passCount = existingStaging?.passCount ?? 0;
        let currentTokenBudget = historianChunkTokens;
        let passAttempt = 1;
        const resumed = existingStaging !== null;

        if (resumed) {
            await sendStatusNotification(
                client,
                sessionId,
                `## Magic Recomp — Resumed\n\nFound ${existingStaging.compartments.length} staged compartment(s) from ${existingStaging.passCount} previous pass(es), covering messages 1-${existingStaging.lastEndMessage}. Resuming from message ${offset}.`,
                notifParams(),
            );
        }

        // ── Live progress (sidebar / status) ────────────────────────────────
        // The recomp loop processes raw messages from `offset` up to
        // `protectedTailStart`; `emitProgress` drives the TUI progress bar.
        // (Outcome LOGGING is done once in executeContextRecompWithResult, which
        // wraps every return path — previously only lease-loss logged, making a
        // silently-non-publishing recomp undiagnosable; see dogfood 2026-05-30.)
        const totalMessages = Math.max(0, protectedTailStart - 1);
        const progressStartedAt = Date.now();
        const emitProgress = (note?: string): void => {
            try {
                deps.onRecompProgress?.({
                    sessionId,
                    phase: "recomp",
                    processedMessages: Math.min(offset, totalMessages),
                    totalMessages,
                    passCount,
                    compartmentsCreated: candidateCompartments.length,
                    startedAt: progressStartedAt,
                    updatedAt: Date.now(),
                    note,
                });
            } catch {
                // best-effort — progress must never break the recomp loop
            }
        };
        emitProgress("Preparing…");

        /** Finish a run that stopped before the end, without moving live coverage backwards. */
        async function promoteAndFinalize(
            reason: string,
            heading: "Complete" | "Partial" = "Partial",
            failure: UserFacingFailureKey = "recomp_unavailable",
            sentence?: string,
            repeatsWithSameInput = false,
        ): Promise<string | null> {
            if (passCount === 0 || candidateCompartments.length === 0) return null;

            const mergedError = validateStoredCompartments(candidateCompartments);
            if (mergedError) return null;

            const lastCompartmentEnd =
                candidateCompartments[candidateCompartments.length - 1]?.endMessage ?? 0;
            const compartmentTagKeys =
                lastCompartmentEnd > 0
                    ? await getRawSessionTagKeysThrough(sessionId, lastCompartmentEnd, { db })
                    : null;

            // Check the live boundary under the same transaction and lease as publication:
            // the normal historian could have added summaries while this rebuild was paused.
            const promoted = promoteRecompStaging(db, sessionId, leaseHolderId, {
                allowCarry: heading === "Complete",
                discardIfShort:
                    repeatsWithSameInput && resumed && passCount === existingStaging.passCount,
            });
            if (promoted === "would-shrink" || promoted === "discarded") {
                const detail = renderUserFacingFailure(failure, "markdown", {
                    sentence,
                    ...(failure !== "historian_window_too_small" ? { action: "" } : {}),
                });
                if (promoted === "discarded") {
                    return [
                        "## Magic Recomp — Failed",
                        "",
                        `The rebuild could not get past message ${offset}. ${detail}`,
                        "The unfinished rebuild was discarded.",
                        "Your current history is unchanged.",
                    ].join("\n");
                }
                return [
                    RECOMP_PAUSED_HEADING,
                    "",
                    resumed
                        ? `Messages 1-${lastCompartmentEnd} of ${totalMessages} are rebuilt and kept for the next run. ${detail}`
                        : `Rebuilt messages 1-${lastCompartmentEnd} of ${totalMessages}, then stopped. ${detail}`,
                    "Your current history is unchanged.",
                    `Run /ctx-recomp again to continue from message ${lastCompartmentEnd + 1}.`,
                ].join("\n");
            }
            if (promoted === "lease-lost") return PUBLISH_LEASE_LOST;
            if (promoted === "staging-removed") return STAGING_REMOVED;

            // Rebuilt summaries start again at depth zero. Carried ordinals keep
            // their depth, just as they do outside a range rebuild.
            afterPublish("compression-depth", () => {
                if (promoted.carriedCount > 0)
                    clearCompressionDepthRange(db, sessionId, 1, lastCompartmentEnd);
                else clearCompressionDepth(db, sessionId);
            });

            if (deps.preserveInjectionCacheUntilConsumed !== true) {
                clearInjectionCache(sessionId);
            }

            // v2 locked rule: recomp does NOT promote facts to project memory
            // (see final-success path below for rationale). Structural rebuild only.
            void promoted.facts;

            // v2: recompute raw chunk embeddings for the rebuilt compartments.
            // Recomp deletes + reinserts every compartment, so their chunk
            // embeddings must be regenerated — otherwise the rebuilt rows have no
            // embeddings and vanish from ctx_search semantic results. Embedding is
            // the search substrate (gated only by the embedding provider, not by
            // `memory.enabled`), distinct from fact promotion (which recomp
            // deliberately skips). Fire-and-forget.
            await afterPublishAsync("embedding", async () => {
                const projectIdentity = resolveProjectIdentity(sessionDirectory);
                // Register the project's embedding provider before embedding;
                // embedBatchForProject silently no-ops for unregistered projects,
                // so without this the rebuilt rows get no chunk embeddings.
                await deps.ensureProjectRegistered?.(sessionDirectory, db);
                const liveCompartments = getCompartments(db, sessionId);
                const chunksToEmbed = liveCompartments.map((c) => ({
                    id: c.id,
                    startMessage: c.startMessage,
                    endMessage: c.endMessage,
                }));
                void embedAndStoreCompartmentChunks(db, sessionId, projectIdentity, chunksToEmbed);
            });

            if (lastCompartmentEnd > 0 && compartmentTagKeys) {
                afterPublish("drop-queue", () =>
                    queueDropsForCompartmentalizedMessages(
                        db,
                        sessionId,
                        lastCompartmentEnd,
                        compartmentTagKeys,
                    ),
                );
            }

            // Signal LAST relative to the drop queue — after queueDrops so a
            // concurrent transform pass that consumes the one-shot
            // history/materialize signals finds the drop rows durable (recomp does
            // not promote facts, so the drops are the only signal-visible state).
            // Placed before the embedding await + marker because neither is
            // consumed by those signals, and the await window is exactly where the
            // race fired. Mirrors the incremental path.
            afterPublish("publication-signal", () => deps.onCompartmentStatePublished?.(sessionId));

            // Update compaction marker after recomp.
            // Recomp is explicit (eagerly clears injection cache), so the marker
            // applies directly here. Plan v6 §6: also CAS-clear any stale pending
            // marker that a prior in-flight incremental publish may have left
            // behind — recomp now owns the boundary.
            const publishedEnd = promoted.carriedThrough ?? lastCompartmentEnd;
            if (publishedEnd > 0) {
                afterPublish("compaction-marker", () => {
                    const markerUpdated = (
                        deps.compactionMarkerStrategy?.publish ??
                        updateCompactionMarkerAfterPublication
                    )(db, sessionId, publishedEnd, deps.directory);
                    // Only CAS-clear a stale pending marker blob when the direct
                    // update actually advanced the boundary. If the update failed
                    // (transient OpenCode DB write error on removal/injection), keep
                    // the pending blob so the deferred drain can still retry —
                    // clearing it would drop the only durable retry path.
                    if (markerUpdated) {
                        const stalePending = getPendingCompactionMarkerState(db, sessionId);
                        if (stalePending) {
                            clearPendingCompactionMarkerStateIf(db, sessionId, stalePending);
                        }
                    }
                });
            }

            if (promoted.carriedCount > 0) {
                const rebuilt = promoted.compartments.length - promoted.carriedCount;
                return [
                    "## Magic Recomp — Complete",
                    "",
                    `Rebuilt ${rebuilt} history block${rebuilt === 1 ? "" : "s"} through message ${lastCompartmentEnd}.`,
                    `Kept ${promoted.carriedCount} existing history block${promoted.carriedCount === 1 ? "" : "s"} through message ${publishedEnd}.`,
                ].join("\n");
            }

            sessionLog(
                sessionId,
                `recomp partial code=${userFacingFailureCode("recomp_unavailable")} reason="${reason}"`,
            );
            return [
                `## Magic Recomp — ${heading}`,
                "",
                `Rebuilt ${promoted.compartments.length} history block${promoted.compartments.length === 1 ? "" : "s"} across ${passCount} successful pass${passCount === 1 ? "" : "es"}.`,
                renderUserFacingFailure("recomp_unavailable"),
            ].join("\n");
        }

        while (offset < protectedTailStart) {
            // Size the chunk to the producer window after the fixed prompt parts;
            // the reference blocks below come from the same fit.
            const promptFit = fitRecompHistorianPrompt({
                model: deps.model,
                fallbackModelId: deps.fallbackModelId,
                language: deps.language,
                requestedChunkTokens: currentTokenBudget,
                sessionId,
                chunkStart: offset,
                lastOrdinal: protectedTailStart - 1,
                sessionCompartments: candidateCompartments,
            });
            if (!promptFit.ok) {
                recordHistorianRun(db, {
                    sessionId,
                    harness: getHarness(),
                    subagentInvocationId: null,
                    runKind: "recomp",
                    status: "failed",
                    failureReason: promptFit.reason,
                    chunkStartOrdinal: offset,
                    chunkEndOrdinal: null,
                    compartmentsProduced: 0,
                });
                sessionLog(
                    sessionId,
                    `recomp failed code=${userFacingFailureCode("historian_window_too_small")} reason="${promptFit.reason}"`,
                );
                const partial = await promoteAndFinalize(
                    `the history model's window cannot hold a historian prompt: ${promptFit.reason}`,
                    "Partial",
                    "historian_window_too_small",
                );
                if (partial) return partial;
                return `## Magic Recomp — Failed\n\n${renderUserFacingFailure("historian_window_too_small")}`;
            }
            if (promptFit.trimmed || promptFit.chunkTokens < currentTokenBudget) {
                sessionLog(
                    sessionId,
                    `recomp prompt fit: ${describeHistorianPromptTrim(promptFit)} requestedChunkTokens=${currentTokenBudget}`,
                );
            }
            const chunk = readSessionChunk(
                sessionId,
                promptFit.chunkTokens,
                offset,
                protectedTailStart,
                { expandTools: deps.historianExpandTools },
            );
            if (!chunk.text || chunk.messageCount === 0 || chunk.endIndex < offset) {
                // Remaining messages before the protected tail are too few or all noise.
                // Keep the existing completion outcome if the prefix can be published safely.
                const promoted = await promoteAndFinalize(
                    `remaining messages ${offset}-${protectedTailStart - 1} were too few or all noise to form a historian chunk`,
                    "Complete",
                    "recomp_unavailable",
                    `Raw history ${offset}-${protectedTailStart - 1} could not be turned into a valid historian chunk.`,
                    true,
                );
                if (promoted) return promoted;
                return `## Magic Recomp — Failed\n\nRecomp stopped because raw history ${offset}-${protectedTailStart - 1} could not be turned into a valid historian chunk. Nothing was written.`;
            }

            const chunkCoverageError = validateChunkCoverage(chunk);
            if (chunkCoverageError) {
                const partial = await promoteAndFinalize(
                    `chunk could not be represented safely: ${chunkCoverageError}`,
                    "Partial",
                    "recomp_unavailable",
                    "The next chunk could not be represented safely.",
                    true,
                );
                if (partial) return partial;
                sessionLog(
                    sessionId,
                    `recomp failed code=${userFacingFailureCode("recomp_unavailable")} reason="${chunkCoverageError}"`,
                );
                return `## Magic Recomp — Failed\n\n${renderUserFacingFailure("recomp_unavailable")}`;
            }

            // Bounded calibration: 3 seeds + 3 diverse older + 4 recent examples.
            // Recent scores are hidden to prevent anchoring in one-compartment runs
            // (the compartments built so far in THIS recomp run provide
            // continuity). Recomp is a structural rebuild and emits no durable
            // facts (see below), so <project-memory> is omitted — there's
            // nothing to dedup against.
            const prompt = buildCompartmentAgentPrompt({
                seedExamples: promptFit.seedExamples,
                sessionReferences: promptFit.sessionReferences,
                projectMemory: "",
                inputSource: `Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunk.text}`,
                // Recomp is a structural rebuild only — it must NOT emit facts
                // (locked rule: never re-promote into a user-curated memory store).
                // Suppress the <facts> section so the model doesn't waste output
                // tokens on facts we'd discard anyway.
                memoryEnabled: false,
                extractionFree: true,
            });

            await sendStatusNotification(
                client,
                sessionId,
                `## Magic Recomp\n\nHistorian pass ${passCount + 1}, attempt ${passAttempt} started for messages ${chunk.startIndex}-${chunk.endIndex}.`,
                notifParams(),
            );
            // Live note: a single pass can take 60-90s through the fallback chain;
            // surface "running historian…" so the sidebar bar isn't frozen.
            emitProgress(`Running historian (pass ${passCount + 1})…`);

            const validatedPass = await runValidatedHistorianPass({
                client,
                hiddenCompletionExecutor: deps.hiddenCompletionExecutor,
                db,
                parentSessionId: sessionId,
                sessionDirectory,
                prompt,
                chunk,
                priorCompartments: candidateCompartments,
                sequenceOffset: candidateCompartments.length,
                dumpLabelBase: `recomp-${sessionId}-${chunk.startIndex}-${chunk.endIndex}-pass-${passCount + 1}`,
                timeoutMs: historianTimeoutMs,
                maxOutputTokens: deps.historianMaxOutputTokens,
                model: deps.model,
                fallbackModelId: deps.fallbackModelId,
                fallbackModels: deps.fallbackModels,
                twoPass: deps.historianTwoPass,
                subagentKind: "recomp",
                agentId: HISTORIAN_RECOMP_AGENT,
                language: deps.language,
                callbacks: {
                    onRepairRetry: async (error) => {
                        emitProgress(`Repair retry (pass ${passCount + 1})…`);
                        sessionLog(
                            sessionId,
                            `recomp retry code=${userFacingFailureCode("recomp_unavailable")} reason="${error}"`,
                        );
                        await sendStatusNotification(
                            client,
                            sessionId,
                            `## Magic Recomp\n\nHistory compression is retrying this pass. ${renderUserFacingFailure("recomp_unavailable")}`,
                            notifParams(),
                        );
                    },
                    onModelFallback: (modelId, index, total) => {
                        // Short model label (drop provider prefix) for the sidebar.
                        const short = modelId.includes("/") ? modelId.split("/").pop() : modelId;
                        emitProgress(`Trying fallback ${short} (${index}/${total})…`);
                    },
                },
            });
            if (!validatedPass.ok) {
                const reducedBudget = getReducedRecompTokenBudget(promptFit.chunkTokens);
                if (reducedBudget !== null) {
                    const smallerChunk = readSessionChunk(
                        sessionId,
                        reducedBudget,
                        offset,
                        protectedTailStart,
                        { expandTools: deps.historianExpandTools },
                    );
                    if (smallerChunk.messageCount > 0 && smallerChunk.endIndex < chunk.endIndex) {
                        await sendStatusNotification(
                            client,
                            sessionId,
                            `## Magic Recomp\n\nHistory compression is retrying with a smaller set of messages. ${renderUserFacingFailure("recomp_unavailable")}`,
                            notifParams(),
                        );
                        currentTokenBudget = reducedBudget;
                        passAttempt += 1;
                        continue;
                    }
                }

                // historian_runs telemetry: record the TERMINAL failure for this
                // chunk. The budget-reduction retry above already `continue`d for
                // recoverable cases, so reaching here means every attempt
                // (primary + repair + fallback chain) failed to produce valid
                // output. Recording failures (not just successes) honors the
                // historian_runs design intent: capture whether a run failed and
                // why. The kept failed child session + dump XMLs hold per-attempt
                // detail; this row makes the failure queryable.
                recordHistorianRun(db, {
                    sessionId,
                    harness: getHarness(),
                    subagentInvocationId: validatedPass.invocationId ?? null,
                    runKind: "recomp",
                    status: "failed",
                    failureReason: validatedPass.failureReason ?? validatedPass.error,
                    chunkStartOrdinal: chunk.startIndex,
                    chunkEndOrdinal: chunk.endIndex,
                    compartmentsProduced: 0,
                });

                sessionLog(
                    sessionId,
                    `recomp failed code=${userFacingFailureCode("recomp_unavailable")} reason="${validatedPass.error}" messageRange=${chunk.startIndex}-${chunk.endIndex}`,
                );
                const partial = await promoteAndFinalize(
                    `history model response did not validate for messages ${chunk.startIndex}-${chunk.endIndex}`,
                );
                if (partial) return partial;
                return `## Magic Recomp — Failed\n\n${renderUserFacingFailure("recomp_unavailable")}`;
            }

            // historian_runs telemetry: one row per SUCCESSFUL recomp pass. Failure
            // early-returns above are already captured in subagent_invocations; we
            // keep recomp instrumentation to the clean per-pass success point to
            // avoid destabilizing this delicate multi-pass path.
            {
                const passComps = validatedPass.compartments ?? [];
                const passFacts = validatedPass.facts ?? [];
                const imp = summarizeImportance(passComps.map((c) => c.importance ?? 50));
                recordHistorianRun(db, {
                    sessionId,
                    harness: getHarness(),
                    // Exact FK: the invocation of the attempt that produced this
                    // validated output. A kind-filtered "latest historian" lookup
                    // mislinks here because recomp invocations are recorded under
                    // subagent='recomp', not 'historian'.
                    subagentInvocationId: validatedPass.invocationId ?? null,
                    runKind: "recomp",
                    status: "success",
                    chunkStartOrdinal: chunk.startIndex,
                    chunkEndOrdinal: chunk.endIndex,
                    unprocessedFrom: passComps[passComps.length - 1]?.endMessage ?? null,
                    compartmentsProduced: passComps.length,
                    factsEmitted: passFacts.length,
                    factsByCategory: passFacts.length > 0 ? tallyFactsByCategory(passFacts) : null,
                    eventsEmitted: (validatedPass.events ?? []).length,
                    importanceMin: imp.min,
                    importanceMax: imp.max,
                    importanceAvg: imp.avg,
                });
            }

            const nextOffset =
                (validatedPass.compartments?.[validatedPass.compartments.length - 1]?.endMessage ??
                    chunk.endIndex) + 1;
            if (nextOffset <= offset) {
                // Never replace the last valid staged pass with output that did not advance it.
                const reason = `Recomp made no forward progress after messages ${chunk.startIndex}-${chunk.endIndex}.`;
                const partial = await promoteAndFinalize(
                    reason,
                    "Partial",
                    "recomp_unavailable",
                    reason,
                    true,
                );
                if (partial) return partial;
                return `## Magic Recomp — Failed\n\n${reason} Nothing was written.`;
            }

            const hadStagedPrefix = candidateCompartments.length > 0;
            candidateCompartments = [
                ...candidateCompartments,
                ...(validatedPass.compartments ?? []),
            ];
            // Intentional: facts are replaced each pass (historian returns complete updated set), while compartments accumulate
            candidateFacts = validatedPass.facts ?? [];
            passCount += 1;
            currentTokenBudget = historianChunkTokens;
            passAttempt = 1;

            // ── Persist to staging after each successful pass ────────────────
            const saved = db
                .transaction(() => {
                    // OpenCode 2 clears staging if it finds that the host removed its
                    // history boundary. Don't restore the prefix when the model returns.
                    if (
                        hadStagedPrefix &&
                        !db
                            .prepare(
                                "SELECT 1 FROM recomp_compartments WHERE session_id = ? LIMIT 1",
                            )
                            .get(sessionId)
                    )
                        return false;
                    saveRecompStagingPass(
                        db,
                        sessionId,
                        passCount,
                        candidateCompartments,
                        candidateFacts,
                    );
                    return true;
                })
                .immediate();
            if (!saved) return STAGING_REMOVED;

            offset = nextOffset;
            emitProgress();
        }

        const mergedValidationError = validateStoredCompartments(candidateCompartments);
        if (mergedValidationError) {
            // Clean up staging on final validation failure
            clearRecompStaging(db, sessionId);
            sessionLog(
                sessionId,
                `recomp failed code=${userFacingFailureCode("recomp_unavailable")} reason="${mergedValidationError}"`,
            );
            return `## Magic Recomp — Failed\n\n${renderUserFacingFailure("recomp_unavailable")}`;
        }

        // Final success: promote staging → real tables
        const lastCompartmentEnd =
            candidateCompartments[candidateCompartments.length - 1]?.endMessage ?? 0;
        const compartmentTagKeys =
            lastCompartmentEnd > 0
                ? await getRawSessionTagKeysThrough(sessionId, lastCompartmentEnd, { db })
                : null;
        const promoted = promoteRecompStaging(db, sessionId, leaseHolderId);
        if (promoted === "staging-removed") {
            return candidateCompartments.length > 0 ? STAGING_REMOVED : PUBLISH_LEASE_LOST;
        }
        if (typeof promoted === "string") {
            sessionLog(sessionId, "recomp publish skipped: compartment lease no longer held");
            return PUBLISH_LEASE_LOST;
        }
        // Full recomp rebuilds every compartment, so all pre-existing depth
        // rows are stale. Matches partial recomp's behavior for rebuilt ranges.
        afterPublish("compression-depth", () => clearCompressionDepth(db, sessionId));
        if (deps.preserveInjectionCacheUntilConsumed !== true) {
            clearInjectionCache(sessionId);
        }

        const finalCompartments = promoted?.compartments ?? candidateCompartments;
        const finalFacts = promoted?.facts ?? candidateFacts;

        // v2 locked rule: recomp does NOT promote facts to project memory.
        // Recomp reprocesses already-curated history; the user's memories may be
        // hand-picked, dreamer-consolidated, or self-edited, and re-promoting
        // recomp-emitted facts would degrade that curated store. Recomp is a
        // structural compartment rebuild only. (The historian prompt still emits
        // a <facts> block, but recomp discards it for promotion purposes.)
        void finalFacts;

        if (lastCompartmentEnd > 0 && compartmentTagKeys) {
            afterPublish("drop-queue", () =>
                queueDropsForCompartmentalizedMessages(
                    db,
                    sessionId,
                    lastCompartmentEnd,
                    compartmentTagKeys,
                ),
            );
        }

        // Signal LAST relative to the drop queue (mirrors the incremental +
        // early-publish paths): a concurrent transform pass consuming the one-shot
        // history/materialize signals must find the drop rows durable.
        afterPublish("publication-signal", () => deps.onCompartmentStatePublished?.(sessionId));

        // v2: recompute raw chunk embeddings for the rebuilt compartments. This is
        // the NORMAL full-completion path (distinct from promoteAndFinalize, which
        // handles early-exit/partial cases and already embeds). Without this, a
        // fully-completed recomp leaves the rebuilt rows without chunk embeddings
        // → they vanish from ctx_search semantic results. Gated only by the
        // embedding provider (not `memory.enabled`), distinct from fact
        // promotion (recomp skips).
        await afterPublishAsync("embedding", async () => {
            const projectIdentity = resolveProjectIdentity(sessionDirectory);
            // Register the embedding provider first; embedBatchForProject silently
            // no-ops for unregistered projects, leaving no chunk embeddings.
            await deps.ensureProjectRegistered?.(sessionDirectory, db);
            const liveCompartments = getCompartments(db, sessionId);
            const chunksToEmbed = liveCompartments.map((c) => ({
                id: c.id,
                startMessage: c.startMessage,
                endMessage: c.endMessage,
            }));
            void embedAndStoreCompartmentChunks(db, sessionId, projectIdentity, chunksToEmbed);
        });

        // v2: advance the compaction marker on the full-completion path too (the
        // promoteAndFinalize early-exit path already does this). Without it, the
        // next incremental run may reprocess already-compartmentalized messages.
        if (lastCompartmentEnd > 0) {
            afterPublish("compaction-marker", () => {
                const markerUpdated = (
                    deps.compactionMarkerStrategy?.publish ?? updateCompactionMarkerAfterPublication
                )(db, sessionId, lastCompartmentEnd, deps.directory);
                // Only clear the stale pending blob when the boundary actually
                // advanced — preserve it for the deferred-drain retry on failure.
                if (markerUpdated) {
                    const stalePending = getPendingCompactionMarkerState(db, sessionId);
                    if (stalePending) {
                        clearPendingCompactionMarkerStateIf(db, sessionId, stalePending);
                    }
                }
            });
        }

        // v2: no compressor pass — deterministic decay-tier rendering keeps the
        // rebuilt history within budget at render time.
        return [
            "## Magic Recomp — Complete",
            "",
            ...(resumed ? ["Resumed from previous interrupted run."] : []),
            `Rebuilt ${finalCompartments.length} compartment${finalCompartments.length === 1 ? "" : "s"} across ${passCount} historian pass${passCount === 1 ? "" : "es"}.`,
            `Covered raw history 1-${lastCompartmentEnd} out of ${rawMessageCount} total messages, stopping before protected tail at ${protectedTailStart}.`,
        ].join("\n");
    } catch (error: unknown) {
        // Recomp replaces durable state atomically, so unexpected failures must leave state untouched.
        // Staging is preserved so a retry can resume from where we left off.
        const message = getErrorMessage(error);
        sessionLog(
            sessionId,
            `recomp failed code=${userFacingFailureCode("recomp_unavailable")} reason="${message}"`,
        );
        return `## Magic Recomp — Failed\n\n${renderUserFacingFailure("recomp_unavailable")}`;
    } finally {
        updateSessionMeta(db, sessionId, { compartmentInProgress: false });
    }
}
