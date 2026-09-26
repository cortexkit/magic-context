import { HISTORIAN_RECOMP_AGENT } from "../../agents/historian";
import { embedAndStoreCompartmentChunks } from "../../features/magic-context/compartment-embedding";
import type {
    Compartment,
    CompartmentInput,
} from "../../features/magic-context/compartment-storage";
import {
    clearRecompStaging,
    getCompartments,
    getRecompPartialRange,
    getRecompStaging,
    saveRecompStagingPass,
    setRecompPartialRange,
} from "../../features/magic-context/compartment-storage";
import { clearCompressionDepthRange } from "../../features/magic-context/compression-depth-storage";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import {
    clearPendingCompactionMarkerStateIf,
    getPendingCompactionMarkerState,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import { normalizeSDKResponse } from "../../shared";
import { getErrorMessage } from "../../shared/error-message";
import { log } from "../../shared/logger";
import { renderUserFacingFailure, userFacingFailureCode } from "../../shared/user-facing-codes";
import { updateCompactionMarkerAfterPublication } from "./compaction-marker-manager";
import { buildCompartmentAgentPrompt } from "./compartment-prompt";
import { runValidatedHistorianPass } from "./compartment-runner-historian";
import { promoteRecompStagingWithM0Mutation } from "./compartment-runner-recomp";
import type { CandidateCompartment, CompartmentRunnerDeps } from "./compartment-runner-types";
import {
    getReducedRecompTokenBudget,
    validateChunkCoverage,
    validateStoredCompartments,
} from "./compartment-runner-validation";
import { clearInjectionCache } from "./inject-compartments";
import { readSessionChunk } from "./read-session-chunk";
import { buildReferenceBlocks } from "./reference-retrieval";
import { sendStatusNotification } from "./send-session-notification";

export interface PartialRecompRange {
    /** Inclusive raw message ordinal to start rebuilding from. */
    start: number;
    /** Inclusive raw message ordinal to stop rebuilding at. */
    end: number;
}

export interface SnappedPartialRange {
    /** Snapped start = first enclosing compartment's startMessage. */
    snapStart: number;
    /** Snapped end = last enclosing compartment's endMessage. */
    snapEnd: number;
    priorCompartments: Compartment[];
    rangeCompartments: Compartment[];
    tailCompartments: Compartment[];
}

/**
 * Preview-only snap computation. Shown in the first-tap confirmation warning so
 * the user sees which compartments will be replaced before executing.
 *
 * Returns an error string when the requested range cannot be snapped (e.g. no
 * compartments exist yet, or the range is entirely after the last compartment).
 */
export function snapRangeToCompartments(
    compartments: Compartment[],
    range: PartialRecompRange,
): SnappedPartialRange | { error: string } {
    if (compartments.length === 0) {
        return {
            error: "No compartments exist yet for this session. Run `/ctx-recomp` (full) first, then use partial recomp to refine specific ranges.",
        };
    }

    // Compartments come from getCompartments sorted by sequence ASC which is
    // the same as sorted by start_message ASC for any valid (contiguous) state.
    const sorted = compartments.slice().sort((a, b) => a.sequence - b.sequence);

    const { start, end } = range;
    if (start < 1) return { error: `Start must be >= 1 (got ${start}).` };
    if (end < start) return { error: `End must be >= start (got ${start}-${end}).` };

    const firstEnclosingIdx = sorted.findIndex((c) => c.endMessage >= start);
    if (firstEnclosingIdx === -1) {
        const last = sorted[sorted.length - 1];
        return {
            error: `Range ${start}-${end} starts after the last compartment (which ends at message ${last.endMessage}). Nothing to rebuild.`,
        };
    }

    let lastEnclosingIdx = -1;
    for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i].startMessage <= end) {
            lastEnclosingIdx = i;
            break;
        }
    }
    if (lastEnclosingIdx === -1 || lastEnclosingIdx < firstEnclosingIdx) {
        return {
            error: `Range ${start}-${end} does not overlap any compartment.`,
        };
    }

    return {
        snapStart: sorted[firstEnclosingIdx].startMessage,
        snapEnd: sorted[lastEnclosingIdx].endMessage,
        priorCompartments: sorted.slice(0, firstEnclosingIdx),
        rangeCompartments: sorted.slice(firstEnclosingIdx, lastEnclosingIdx + 1),
        tailCompartments: sorted.slice(lastEnclosingIdx + 1),
    };
}

function compartmentToInput(c: Compartment, newSequence: number): CompartmentInput {
    return {
        sequence: newSequence,
        startMessage: c.startMessage,
        endMessage: c.endMessage,
        startMessageId: c.startMessageId,
        endMessageId: c.endMessageId,
        title: c.title,
        content: c.content,
        // v2: preserve paraphrase tiers + scoring on prior/tail compartments that
        // a partial recomp keeps UNCHANGED. Dropping these would re-write them as
        // flat (NULL-tier, legacy=0) rows and break decay rendering.
        p1: c.p1,
        p2: c.p2,
        p3: c.p3,
        p4: c.p4,
        importance: c.importance,
        episodeType: c.episodeType,
    };
}

export async function executePartialRecompInternal(
    deps: CompartmentRunnerDeps,
    range: PartialRecompRange,
): Promise<string> {
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
        return "## Magic Recomp — Failed\n\nCould not acquire the compartment-state lease for this session.";
    }
    const leaseHolderId = holderId;
    updateSessionMeta(db, sessionId, { compartmentInProgress: true });

    try {
        // ── Snap to compartment boundaries ─────────────────────────────────
        const existingCompartments = getCompartments(db, sessionId);
        const snapResult = snapRangeToCompartments(existingCompartments, range);
        if ("error" in snapResult) {
            return `## Magic Recomp — Failed\n\n${snapResult.error}`;
        }
        const { snapStart, snapEnd, priorCompartments, tailCompartments } = snapResult;

        // ── Resume detection: check existing staging range ─────────────────
        const storedRange = getRecompPartialRange(db, sessionId);
        const existingStaging = getRecompStaging(db, sessionId);

        if (
            existingStaging &&
            storedRange &&
            (storedRange.start !== snapStart || storedRange.end !== snapEnd)
        ) {
            return [
                "## Magic Recomp — Failed",
                "",
                `An unfinished partial recomp is already staged for range ${storedRange.start}-${storedRange.end}, which does not match the requested range ${snapStart}-${snapEnd}.`,
                "",
                "Resume that range by running `/ctx-recomp` with the same original arguments,",
                "or cancel it by running `/ctx-flush` before starting a new partial recomp.",
            ].join("\n");
        }
        if (existingStaging && !storedRange) {
            return [
                "## Magic Recomp — Failed",
                "",
                "An unfinished full recomp is already staged for this session.",
                "Resume it by running `/ctx-recomp` without arguments,",
                "or cancel it before starting a partial recomp.",
            ].join("\n");
        }

        // v2: facts are RETIRED as a render source (facts = promoted memories,
        // surfaced via <project-memory>) and the recomp promote path deletes
        // session_facts and never re-inserts. So partial recomp neither snapshots
        // nor carries facts — staging passes get an empty fact list. (Earlier code
        // snapshotted session_facts and reported "Facts unchanged (N)", but the
        // promote dropped them regardless, so the snapshot was dead work and the
        // claim was misleading.)
        const stagedFacts: { category: string; content: string }[] = [];

        // ── Resolve project memories for historian fact dedup context ─────
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

        // v2: partial-recomp keeps existing facts untouched (no promote, no
        // dedup block) — reference blocks (seeds + recency) carry calibration.

        // ── Resume state ───────────────────────────────────────────────────
        //
        // Staging layout for partial recomp: [priorCompartments, ...newBuiltSoFar]
        //   - priorCompartments always carried through unchanged
        //   - newBuiltSoFar is what historian has produced for the range so far
        //   - tailCompartments are NOT in staging — they are appended at promote time
        //
        // Resume: if staging exists and range matches, `candidateCompartments`
        // already includes prior + any new-built-so-far. `offset` resumes from the
        // last built compartment's endMessage + 1, or snapStart if nothing new yet.
        let candidateCompartments: CandidateCompartment[];
        let passCount: number;
        let offset: number;
        const resumed = existingStaging !== null && storedRange !== null;

        if (resumed && existingStaging) {
            candidateCompartments = existingStaging.compartments;
            passCount = existingStaging.passCount;
            // Resume from last built compartment's end + 1; if only prior is staged
            // (passCount 0) we start at snapStart.
            const lastInStaging = existingStaging.lastEndMessage;
            offset = lastInStaging >= snapStart ? lastInStaging + 1 : snapStart;
        } else {
            // Fresh partial recomp: seed staging with prior compartments, record range.
            // Sequences are 0-indexed to match the invariant MAX(sequence) = count - 1.
            // Any gap or off-by-one here propagates into incremental historian's
            // sequenceOffset math and triggers UNIQUE constraint failures on the next run.
            candidateCompartments = priorCompartments.map((c, idx) => compartmentToInput(c, idx));
            passCount = 0;
            offset = snapStart;
            // Save initial staging (prior only, pass_number 0) so a crash right after
            // this point still leaves discoverable staging with the correct range.
            saveRecompStagingPass(db, sessionId, 0, candidateCompartments, stagedFacts);
            setRecompPartialRange(db, sessionId, { start: snapStart, end: snapEnd });
        }

        let currentTokenBudget = historianChunkTokens;
        let passAttempt = 1;

        await sendStatusNotification(
            client,
            sessionId,
            resumed
                ? `## Magic Recomp — Resumed (Partial)\n\nFound ${candidateCompartments.length - priorCompartments.length} newly built compartment(s) from ${passCount} previous pass(es), covering messages ${snapStart}-${offset - 1}. Resuming from message ${offset} toward ${snapEnd}.`
                : `## Magic Recomp — Partial\n\nSnapped to compartment boundaries: rebuilding messages ${snapStart}-${snapEnd} (${tailCompartments.length} tail compartment(s) preserved).`,
            notifParams(),
        );

        /** Final promote path: merge prior + new + tail into one coherent set and
         *  swap atomically. Clears compression depth for the rebuilt range so the
         *  new compartments start fresh at depth 0. */
        function promoteFinal(): { compartmentCount: number; lastEndMessage: number } | null {
            // Validate the new-built range before committing.
            const newBuilt = candidateCompartments.slice(priorCompartments.length);
            if (newBuilt.length === 0) return null;

            // Check that new-built range covers exactly [snapStart..snapEnd]
            // contiguously.
            const newBuiltError = (() => {
                let expected = snapStart;
                for (const c of newBuilt) {
                    if (c.startMessage !== expected) {
                        return c.startMessage < expected
                            ? `overlap in rebuilt range near ${expected}`
                            : `gap in rebuilt range before ${c.startMessage} (expected ${expected})`;
                    }
                    if (c.endMessage < c.startMessage) {
                        return `invalid range ${c.startMessage}-${c.endMessage}`;
                    }
                    expected = c.endMessage + 1;
                }
                if (expected - 1 !== snapEnd) {
                    return `rebuilt range ends at ${expected - 1} but snapped end is ${snapEnd}`;
                }
                return null;
            })();
            if (newBuiltError) {
                log(`[magic-context] partial recomp validation failed: ${newBuiltError}`);
                return null;
            }

            // Append tail with renumbered sequences so the final staging includes
            // prior + new + tail. `validateStoredCompartments` then passes because
            // the full set is contiguous from message 1.
            // Sequences are 0-indexed (continuing from candidateCompartments.length).
            // The `+ 1` off-by-one here previously created a gap between "prior + new"
            // and "tail" that broke the invariant MAX(sequence) = count - 1 and
            // caused incremental historian's sequenceOffset to collide with an
            // existing sequence — producing UNIQUE constraint failures.
            const merged: CompartmentInput[] = [
                ...candidateCompartments,
                ...tailCompartments.map((c, idx) =>
                    compartmentToInput(c, candidateCompartments.length + idx),
                ),
            ];

            const mergedError = validateStoredCompartments(merged);
            if (mergedError) {
                log(`[magic-context] partial recomp merged validation failed: ${mergedError}`);
                return null;
            }

            // Save a final staging pass containing prior + new + tail. Promote
            // replaces the real tables atomically with this set.
            saveRecompStagingPass(db, sessionId, passCount + 1, merged, stagedFacts);
            const promoted = promoteRecompStagingWithM0Mutation(db, sessionId, leaseHolderId);
            if (!promoted) {
                log("[magic-context] partial recomp promote returned null");
                return null;
            }

            // Clear partial-range marker — staging is now empty.
            setRecompPartialRange(db, sessionId, null);
            // Reset depth counters for rebuilt range so fresh compartments start
            // at depth 0. Prior/tail depth is preserved.
            clearCompressionDepthRange(db, sessionId, snapStart, snapEnd);
            if (deps.preserveInjectionCacheUntilConsumed !== true) {
                clearInjectionCache(sessionId);
            }
            deps.onCompartmentStatePublished?.(sessionId);

            // v2: recompute raw chunk embeddings for the rebuilt compartments.
            // Partial recomp deletes + reinserts compartments, so their chunk
            // embeddings must be regenerated or the rebuilt rows vanish from
            // ctx_search semantic results. Gated only by the embedding provider
            // (not `memory.enabled`), distinct from fact promotion (which recomp
            // skips). Fire-and-forget, best-effort.
            {
                const projectIdentity = resolveProjectIdentity(sessionDirectory);
                const liveCompartments = getCompartments(db, sessionId);
                const chunksToEmbed = liveCompartments.map((c) => ({
                    id: c.id,
                    startMessage: c.startMessage,
                    endMessage: c.endMessage,
                }));
                // Register the embedding provider FIRST; embedBatchForProject
                // silently no-ops for unregistered projects, leaving the rebuilt
                // rows without chunk embeddings. This block is sync, so chain
                // register→embed as fire-and-forget.
                void Promise.resolve(deps.ensureProjectRegistered?.(sessionDirectory, db)).then(
                    () =>
                        embedAndStoreCompartmentChunks(
                            db,
                            sessionId,
                            projectIdentity,
                            chunksToEmbed,
                        ),
                );
            }

            const lastEnd = merged[merged.length - 1]?.endMessage ?? snapEnd;
            // Plan v6 §6: partial recomp is explicit (eager cache clear). Apply
            // the marker directly here AND CAS-clear any stale pending blob a
            // prior in-flight incremental publish may have left behind — partial
            // recomp now owns the boundary up to lastEnd.
            if (lastEnd > 0) {
                const markerUpdated = updateCompactionMarkerAfterPublication(
                    db,
                    sessionId,
                    lastEnd,
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
            return { compartmentCount: merged.length, lastEndMessage: lastEnd };
        }

        // ── Main loop: rebuild snapStart..snapEnd in historian chunks ──────
        while (offset <= snapEnd) {
            const chunk = readSessionChunk(
                sessionId,
                currentTokenBudget,
                offset,
                snapEnd + 1, // exclusive upper bound — readSessionChunk stops before this ordinal
            );
            if (!chunk.text || chunk.messageCount === 0 || chunk.endIndex < offset) {
                return `## Magic Recomp — Failed\n\nRecomp stopped because raw history ${offset}-${snapEnd} could not be turned into a valid historian chunk. Partial recomp preserved original state (staging kept for retry).`;
            }

            const chunkCoverageError = validateChunkCoverage(chunk);
            if (chunkCoverageError) {
                log(
                    `[magic-context] partial recomp failed session=${sessionId} code=${userFacingFailureCode("recomp_unavailable")} reason="${chunkCoverageError}"`,
                );
                return `## Magic Recomp — Failed\n\n${renderUserFacingFailure("recomp_unavailable")}`;
            }

            // v2 bounded reference model: 4 rotating seeds + last-6 recency
            // (the compartments rebuilt so far in this partial-recomp run provide
            // continuity). Structural rebuild → no <project-memory> dedup block.
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
                // Partial recomp is structural-only — never emit facts (locked
                // rule: no re-promotion into the curated memory store).
                memoryEnabled: false,
                extractionFree: true,
            });

            await sendStatusNotification(
                client,
                sessionId,
                `## Magic Recomp — Partial\n\nHistorian pass ${passCount + 1}, attempt ${passAttempt} started for messages ${chunk.startIndex}-${chunk.endIndex}.`,
                notifParams(),
            );

            const validatedPass = await runValidatedHistorianPass({
                client,
                db,
                parentSessionId: sessionId,
                sessionDirectory,
                prompt,
                chunk,
                priorCompartments: candidateCompartments,
                sequenceOffset: candidateCompartments.length,
                dumpLabelBase: `partial-recomp-${sessionId}-${chunk.startIndex}-${chunk.endIndex}-pass-${passCount + 1}`,
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
                        log(
                            `[magic-context] partial recomp retry session=${sessionId} code=${userFacingFailureCode("recomp_unavailable")} reason="${error}"`,
                        );
                        await sendStatusNotification(
                            client,
                            sessionId,
                            `## Magic Recomp — Partial\n\nHistory compression is retrying this pass. ${renderUserFacingFailure("recomp_unavailable")}`,
                            notifParams(),
                        );
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
                        snapEnd + 1,
                    );
                    if (smallerChunk.messageCount > 0 && smallerChunk.endIndex < chunk.endIndex) {
                        await sendStatusNotification(
                            client,
                            sessionId,
                            `## Magic Recomp — Partial\n\nHistory compression is retrying with a smaller set of messages. ${renderUserFacingFailure("recomp_unavailable")}`,
                            notifParams(),
                        );
                        currentTokenBudget = reducedBudget;
                        passAttempt += 1;
                        continue;
                    }
                }
                log(
                    `[magic-context] partial recomp failed session=${sessionId} code=${userFacingFailureCode("recomp_unavailable")} reason="${validatedPass.error}" messageRange=${chunk.startIndex}-${chunk.endIndex}`,
                );
                return `## Magic Recomp — Failed\n\n${renderUserFacingFailure("recomp_unavailable")}`;
            }

            candidateCompartments = [
                ...candidateCompartments,
                ...(validatedPass.compartments ?? []),
            ];
            // Intentional: partial recomp ignores historian's fact output entirely.
            // Facts are retired as a render source in v2 (= promoted memories), so
            // staging always carries the empty stagedFacts list.

            passCount += 1;
            currentTokenBudget = historianChunkTokens;
            passAttempt = 1;

            saveRecompStagingPass(db, sessionId, passCount, candidateCompartments, stagedFacts);

            const nextOffset =
                (validatedPass.compartments?.[validatedPass.compartments.length - 1]?.endMessage ??
                    chunk.endIndex) + 1;
            if (nextOffset <= offset) {
                return `## Magic Recomp — Failed\n\nPartial recomp made no forward progress after messages ${chunk.startIndex}-${chunk.endIndex}. Staging kept for retry.`;
            }
            offset = nextOffset;
        }

        // ── Final promote ──────────────────────────────────────────────────
        const finalResult = promoteFinal();
        if (!finalResult) {
            return `## Magic Recomp — Failed\n\nPartial recomp completed historian passes but the final compartment set failed validation. Original state preserved (staging kept for inspection).`;
        }

        return [
            "## Magic Recomp — Partial Complete",
            "",
            ...(resumed ? ["Resumed from previous interrupted partial run."] : []),
            `Rebuilt compartments covering messages ${snapStart}-${snapEnd} using ${passCount} historian pass${passCount === 1 ? "" : "es"}.`,
            `Preserved ${priorCompartments.length} prior compartment(s) and ${tailCompartments.length} tail compartment(s) unchanged.`,
            `Total compartments: ${finalResult.compartmentCount}.`,
        ].join("\n");
    } catch (error: unknown) {
        const message = getErrorMessage(error);
        log(
            `[magic-context] partial recomp failed session=${sessionId} code=${userFacingFailureCode("recomp_unavailable")} reason="${message}"`,
        );
        return `## Magic Recomp — Failed\n\n${renderUserFacingFailure("recomp_unavailable")}`;
    } finally {
        updateSessionMeta(db, sessionId, { compartmentInProgress: false });
        // Best-effort cleanup: if staging is somehow left over without a matching
        // range marker, clear it. Normal success already cleared via promoteFinal.
        const leftoverStaging = getRecompStaging(db, sessionId);
        const leftoverRange = getRecompPartialRange(db, sessionId);
        if (leftoverStaging && leftoverRange) {
            // Intentional: staging intentionally kept on failure paths above so the
            // user can re-run with the same args and resume. Do NOT clear here.
        } else if (leftoverStaging && !leftoverRange) {
            // Unexpected: staging without range marker in a partial-recomp context.
            // Clear to avoid a future full recomp resuming into partial state.
            log(
                `[magic-context] partial recomp cleanup: clearing orphaned staging without range marker for session ${sessionId}`,
            );
            clearRecompStaging(db, sessionId);
        }
    }
}
