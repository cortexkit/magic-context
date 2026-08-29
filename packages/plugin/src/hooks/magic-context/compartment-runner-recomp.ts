import { HISTORIAN_RECOMP_AGENT } from "../../agents/historian";
import { embedAndStoreCompartmentChunks } from "../../features/magic-context/compartment-embedding";
import { isCompartmentLeaseHeld } from "../../features/magic-context/compartment-lease";
import {
    clearRecompStaging,
    getCompartments,
    getRecompStaging,
    saveRecompStagingPass,
} from "../../features/magic-context/compartment-storage";
import { clearCompressionDepth } from "../../features/magic-context/compression-depth-storage";
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
import type { Database } from "../../shared/sqlite";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";
import { updateCompactionMarkerAfterPublication } from "./compaction-marker-manager";
import { buildCompartmentAgentPrompt } from "./compartment-prompt";
import { queueDropsForCompartmentalizedMessages } from "./compartment-runner-drop-queue";
import { runValidatedHistorianPass } from "./compartment-runner-historian";
import { cleanupHistorianStateFile } from "./compartment-runner-incremental";
import type { CandidateCompartment, CompartmentRunnerDeps } from "./compartment-runner-types";
import {
    getReducedRecompTokenBudget,
    validateChunkCoverage,
    validateStoredCompartments,
} from "./compartment-runner-validation";
import { clearInjectionCache } from "./inject-compartments";
import {
    createDefaultBoundarySnapshotForTests,
    resolveOpenCodeProtectedTailBoundary,
} from "./protected-tail-boundary";
import { getRawSessionMessageCount, readSessionChunk } from "./read-session-chunk";
import { buildReferenceBlocks } from "./reference-retrieval";
import { sendIgnoredMessage } from "./send-session-notification";

function insertRecompCompartmentRows(
    db: Database,
    sessionId: string,
    compartments: CandidateCompartment[],
    now: number,
): void {
    // v2: carry paraphrase tiers + importance/episode_type through the recomp
    // promote path. Must match compartment-storage.ts insertCompartmentRows column
    // order. legacy=0 when P1 present, else 1 (flat).
    const stmt = db.prepare(
        "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance, episode_type, legacy, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of compartments) {
        const hasTiers = typeof c.p1 === "string" && c.p1.length > 0;
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
            hasTiers ? 0 : 1,
            now,
            getHarness(),
        );
    }
}

export function promoteRecompStagingWithM0Mutation(
    db: Database,
    sessionId: string,
    holderId: string,
): {
    compartments: CandidateCompartment[];
    facts: Array<{ category: string; content: string }>;
} | null {
    const now = Date.now();
    const transactionStartedAt = performance.now();
    db.exec("BEGIN IMMEDIATE");
    let finished = false;
    try {
        if (!isCompartmentLeaseHeld(db, sessionId, holderId)) {
            db.exec("ROLLBACK");
            finished = true;
            return null;
        }

        const staging = getRecompStaging(db, sessionId);
        if (!staging || staging.compartments.length === 0) {
            db.exec("ROLLBACK");
            finished = true;
            return null;
        }

        db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        // v2 faithful facts: recomp does NOT write session_facts. Facts are a
        // promoted-memory concern now, and recomp must not emit facts at all
        // (re-processing curated memories would degrade them — locked rule).
        // The renderer no longer reads session_facts, so we clear any legacy
        // rows for hygiene and never re-insert.
        db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);
        insertRecompCompartmentRows(db, sessionId, staging.compartments, now);
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
        logSlowWriteTransaction("historian-publish:recomp", transactionStartedAt);
        return { compartments: staging.compartments, facts: staging.facts };
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
    // State file for the current pass — hoisted to be accessible in finally{}
    let currentStateFilePath: string | undefined;
    updateSessionMeta(db, sessionId, { compartmentInProgress: true });

    try {
        const rawMessageCount = getRawSessionMessageCount(sessionId);
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
        if (rawMessageCount <= 0) {
            return "## Magic Recomp\n\nNo raw history exists, so nothing was rebuilt.";
        }
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

        // v2: no <project-memory> dedup block for recomp — it emits no facts to
        // memory (structural rebuild only), so there is nothing to dedup against.

        // ── Resume from staging if a previous run was interrupted ────────────
        const existingStaging = getRecompStaging(db, sessionId);
        let candidateCompartments: CandidateCompartment[] = existingStaging?.compartments ?? [];
        let candidateFacts: Array<{ category: string; content: string }> =
            existingStaging?.facts ?? [];
        let offset = existingStaging ? existingStaging.lastEndMessage + 1 : 1;
        let passCount = existingStaging?.passCount ?? 0;
        let currentTokenBudget = historianChunkTokens;
        let passAttempt = 1;
        const resumed = existingStaging !== null;

        if (resumed) {
            await sendIgnoredMessage(
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

        /** Promote staging → real tables and run post-processing.
         *  Returns formatted status lines on success, or null if validation fails or there's nothing to promote. */
        async function promoteAndFinalize(reason: string): Promise<string | null> {
            if (passCount === 0 || candidateCompartments.length === 0) return null;

            const mergedError = validateStoredCompartments(candidateCompartments);
            if (mergedError) return null;

            // Ensure latest candidates are saved to staging before promoting
            saveRecompStagingPass(db, sessionId, passCount, candidateCompartments, candidateFacts);

            const promoted = promoteRecompStagingWithM0Mutation(db, sessionId, leaseHolderId);
            if (!promoted) return null;

            // Full recomp rebuilds every compartment from message 1 onward, so
            // all pre-existing compression-depth rows are stale — the compressor
            // would otherwise skip or wrongly tier the fresh compartments. Wipe
            // per-session depth state so the rebuilt compartments start at depth
            // 0, matching what partial recomp does for its rebuilt range.
            clearCompressionDepth(db, sessionId);

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
            // the search substrate (gated on memory-enabled), distinct from fact
            // promotion (which recomp deliberately skips). Fire-and-forget.
            if (deps.memoryEnabled !== false) {
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
            }

            const lastCompartmentEnd =
                promoted.compartments[promoted.compartments.length - 1]?.endMessage ?? 0;
            if (lastCompartmentEnd > 0) {
                queueDropsForCompartmentalizedMessages(db, sessionId, lastCompartmentEnd);
            }

            // Signal LAST relative to the drop queue — after queueDrops so a
            // concurrent transform pass that consumes the one-shot
            // history/materialize signals finds the drop rows durable (recomp does
            // not promote facts, so the drops are the only signal-visible state).
            // Placed before the embedding await + marker because neither is
            // consumed by those signals, and the await window is exactly where the
            // race fired. Mirrors the incremental path.
            deps.onCompartmentStatePublished?.(sessionId);

            // Update compaction marker after recomp.
            // Recomp is explicit (eagerly clears injection cache), so the marker
            // applies directly here. Plan v6 §6: also CAS-clear any stale pending
            // marker that a prior in-flight incremental publish may have left
            // behind — recomp now owns the boundary.
            if (lastCompartmentEnd > 0) {
                const markerUpdated = updateCompactionMarkerAfterPublication(
                    db,
                    sessionId,
                    lastCompartmentEnd,
                    deps.directory,
                );
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
            }

            return [
                `Persisted ${promoted.compartments.length} compartment${promoted.compartments.length === 1 ? "" : "s"} from ${passCount} successful pass${passCount === 1 ? "" : "es"}.`,
                `Covered raw history 1-${lastCompartmentEnd} out of ${rawMessageCount} total messages.`,
                `Remaining messages ${lastCompartmentEnd + 1}-${protectedTailStart - 1} were not rebuilt (${reason}).`,
            ].join("\n");
        }

        while (offset < protectedTailStart) {
            const chunk = readSessionChunk(
                sessionId,
                currentTokenBudget,
                offset,
                protectedTailStart,
            );
            if (!chunk.text || chunk.messageCount === 0 || chunk.endIndex < offset) {
                // Remaining messages before the protected tail are too few or all noise.
                // If we already have valid candidates, this is a normal completion — not a partial failure.
                const promoted = await promoteAndFinalize(
                    `remaining messages ${offset}-${protectedTailStart - 1} were too few or all noise to form a historian chunk`,
                );
                if (promoted) {
                    return `## Magic Recomp — Complete\n\n${promoted}`;
                }
                return `## Magic Recomp — Failed\n\nRecomp stopped because raw history ${offset}-${protectedTailStart - 1} could not be turned into a valid historian chunk. Nothing was written.`;
            }

            const chunkCoverageError = validateChunkCoverage(chunk);
            if (chunkCoverageError) {
                const partial = await promoteAndFinalize(
                    `chunk could not be represented safely: ${chunkCoverageError}`,
                );
                if (partial) {
                    return `## Magic Recomp — Partial\n\n${partial}`;
                }
                return `## Magic Recomp — Failed\n\nRecomp stopped because the raw chunk could not be represented safely: ${chunkCoverageError}\n\nNothing was written.`;
            }

            // v2 bounded reference model: 4 rotating seeds + last-6 recency
            // (the compartments built so far in THIS recomp run provide
            // continuity). Recomp is a structural rebuild and emits no durable
            // facts (see below), so <project-memory> is omitted — there's
            // nothing to dedup against.
            const references = buildReferenceBlocks({
                sessionId,
                chunkStart: chunk.startIndex,
                sessionCompartments: candidateCompartments,
            });

            const prompt = buildCompartmentAgentPrompt({
                seedExamples: references.seedExamples,
                sessionReferences: references.sessionReferences,
                projectMemory: "",
                inputSource: `Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunk.text}`,
                // Recomp is a structural rebuild only — it must NOT emit facts
                // (locked rule: never re-promote into a user-curated memory store).
                // Suppress the <facts> section so the model doesn't waste output
                // tokens on facts we'd discard anyway.
                memoryEnabled: false,
                extractionFree: true,
            });

            await sendIgnoredMessage(
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
                db,
                parentSessionId: sessionId,
                sessionDirectory,
                prompt,
                chunk,
                priorCompartments: candidateCompartments,
                sequenceOffset: candidateCompartments.length,
                dumpLabelBase: `recomp-${sessionId}-${chunk.startIndex}-${chunk.endIndex}-pass-${passCount + 1}`,
                timeoutMs: historianTimeoutMs,
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
                        await sendIgnoredMessage(
                            client,
                            sessionId,
                            `## Magic Recomp\n\nHistorian pass ${passCount + 1}, attempt ${passAttempt} is continuing with a repair retry for messages ${chunk.startIndex}-${chunk.endIndex}.\n\nThe previous output did not validate: ${error}`,
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
                const reducedBudget = getReducedRecompTokenBudget(currentTokenBudget);
                if (reducedBudget !== null) {
                    const smallerChunk = readSessionChunk(
                        sessionId,
                        reducedBudget,
                        offset,
                        protectedTailStart,
                    );
                    if (smallerChunk.messageCount > 0 && smallerChunk.endIndex < chunk.endIndex) {
                        await sendIgnoredMessage(
                            client,
                            sessionId,
                            `## Magic Recomp\n\nHistorian pass ${passCount + 1}, attempt ${passAttempt} is continuing with a smaller chunk ending at ${smallerChunk.endIndex} because messages ${chunk.startIndex}-${chunk.endIndex} could not be validated.\n\nValidator result: ${validatedPass.error}`,
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
                    failureReason: validatedPass.error,
                    chunkStartOrdinal: chunk.startIndex,
                    chunkEndOrdinal: chunk.endIndex,
                    compartmentsProduced: 0,
                });

                const partial = await promoteAndFinalize(
                    `historian failed to validate messages ${chunk.startIndex}-${chunk.endIndex}: ${validatedPass.error}`,
                );
                if (partial) {
                    return `## Magic Recomp — Partial\n\n${partial}`;
                }
                return `## Magic Recomp — Failed\n\nRecomp failed while rebuilding messages ${chunk.startIndex}-${chunk.endIndex}: ${validatedPass.error}\n\nNothing was written.`;
            }

            // historian_runs telemetry: one row per SUCCESSFUL recomp pass. Failure
            // early-returns above are already captured in subagent_invocations; we
            // keep recomp instrumentation to the clean per-pass success point to
            // avoid destabilizing this delicate multi-pass path. run_kind="recomp"
            // also covers /ctx-session-upgrade (upgrade = full recomp + migration).
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
            saveRecompStagingPass(db, sessionId, passCount, candidateCompartments, candidateFacts);

            const nextOffset =
                (validatedPass.compartments?.[validatedPass.compartments.length - 1]?.endMessage ??
                    chunk.endIndex) + 1;
            if (nextOffset <= offset) {
                const partial = await promoteAndFinalize(
                    `historian made no forward progress after messages ${chunk.startIndex}-${chunk.endIndex}`,
                );
                if (partial) {
                    return `## Magic Recomp — Partial\n\n${partial}`;
                }
                return `## Magic Recomp — Failed\n\nRecomp made no forward progress after messages ${chunk.startIndex}-${chunk.endIndex}. Nothing was written.`;
            }
            offset = nextOffset;
            emitProgress();
        }

        const mergedValidationError = validateStoredCompartments(candidateCompartments);
        if (mergedValidationError) {
            // Clean up staging on final validation failure
            clearRecompStaging(db, sessionId);
            return `## Magic Recomp — Failed\n\nRecomp completed ${passCount} pass${passCount === 1 ? "" : "es"} but produced an invalid final compartment set: ${mergedValidationError}\n\nNothing was written.`;
        }

        // Final success: promote staging → real tables
        saveRecompStagingPass(db, sessionId, passCount, candidateCompartments, candidateFacts);
        const promoted = promoteRecompStagingWithM0Mutation(db, sessionId, leaseHolderId);
        if (!promoted) {
            sessionLog(sessionId, "recomp publish skipped: compartment lease no longer held");
            return "## Magic Recomp — Skipped\n\nAnother process acquired the compartment-state lease before recomp could publish. No state was written.";
        }
        // Full recomp rebuilds every compartment, so all pre-existing depth
        // rows are stale. Matches partial recomp's behavior for rebuilt ranges.
        clearCompressionDepth(db, sessionId);
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

        const lastCompartmentEnd = finalCompartments[finalCompartments.length - 1]?.endMessage ?? 0;
        if (lastCompartmentEnd > 0) {
            queueDropsForCompartmentalizedMessages(db, sessionId, lastCompartmentEnd);
        }

        // Signal LAST relative to the drop queue (mirrors the incremental +
        // early-publish paths): a concurrent transform pass consuming the one-shot
        // history/materialize signals must find the drop rows durable.
        deps.onCompartmentStatePublished?.(sessionId);

        // v2: recompute raw chunk embeddings for the rebuilt compartments. This is
        // the NORMAL full-completion path (distinct from promoteAndFinalize, which
        // handles early-exit/partial cases and already embeds). Without this, a
        // fully-completed recomp leaves the rebuilt rows without chunk embeddings
        // → they vanish from ctx_search semantic results. Gated on memory-enabled,
        // distinct from fact promotion (recomp skips).
        if (deps.memoryEnabled !== false) {
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
        }

        // v2: advance the compaction marker on the full-completion path too (the
        // promoteAndFinalize early-exit path already does this). Without it, the
        // next incremental run may reprocess already-compartmentalized messages.
        if (lastCompartmentEnd > 0) {
            const markerUpdated = updateCompactionMarkerAfterPublication(
                db,
                sessionId,
                lastCompartmentEnd,
                deps.directory,
            );
            // Only clear the stale pending blob when the boundary actually
            // advanced — preserve it for the deferred-drain retry on failure.
            if (markerUpdated) {
                const stalePending = getPendingCompactionMarkerState(db, sessionId);
                if (stalePending) {
                    clearPendingCompactionMarkerStateIf(db, sessionId, stalePending);
                }
            }
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
        return `## Magic Recomp — Failed\n\nRecomp failed unexpectedly: ${message}\n\nStaging data preserved for resume on next attempt.`;
    } finally {
        updateSessionMeta(db, sessionId, { compartmentInProgress: false });
        cleanupHistorianStateFile(currentStateFilePath);
    }
}
