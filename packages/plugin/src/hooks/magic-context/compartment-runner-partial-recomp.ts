import type {
    Compartment,
    CompartmentInput,
} from "../../features/magic-context/compartment-storage";
import {
    clearRecompStaging,
    getCompartments,
    getRecompPartialRange,
    getRecompStaging,
    getSessionFacts,
    promoteRecompStaging,
    saveRecompStagingPass,
    setRecompPartialRange,
} from "../../features/magic-context/compartment-storage";
import { clearCompressionDepthRange } from "../../features/magic-context/compression-depth-storage";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { getMemoriesByProject } from "../../features/magic-context/memory/storage-memory";
import {
    clearPendingCompactionMarkerStateIf,
    getPendingCompactionMarkerState,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import { normalizeSDKResponse } from "../../shared";
import { getErrorMessage } from "../../shared/error-message";
import { log } from "../../shared/logger";
import { updateCompactionMarkerAfterPublication } from "./compaction-marker-manager";
import { buildCompartmentAgentPrompt } from "./compartment-prompt";
import { runValidatedHistorianPass } from "./compartment-runner-historian";
import { buildExistingStateXml } from "./compartment-runner-state-xml";
import type { CandidateCompartment, CompartmentRunnerDeps } from "./compartment-runner-types";
import {
    getReducedRecompTokenBudget,
    validateChunkCoverage,
    validateStoredCompartments,
} from "./compartment-runner-validation";
import { clearInjectionCache } from "./inject-compartments";
import { getProtectedTailStartOrdinal, readSessionChunk } from "./read-session-chunk";
import { sendIgnoredMessage } from "./send-session-notification";

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
    updateSessionMeta(db, sessionId, { compartmentInProgress: true });

    try {
        const protectedTailStart = getProtectedTailStartOrdinal(sessionId);

        // ── Snap to compartment boundaries ─────────────────────────────────
        const existingCompartments = getCompartments(db, sessionId);
        const snapResult = snapRangeToCompartments(existingCompartments, range);
        if ("error" in snapResult) {
            return `## Magic Recomp — Failed\n\n${snapResult.error}`;
        }
        const { snapStart, snapEnd, priorCompartments, tailCompartments } = snapResult;

        // Refuse to recomp into the protected tail — validation would fail anyway
        // but checking here produces a clearer user-facing error.
        if (snapEnd >= protectedTailStart) {
            return `## Magic Recomp — Failed\n\nSnapped range ${snapStart}-${snapEnd} would cross into the protected tail (starting at ${protectedTailStart}). Partial recomp cannot rebuild recent messages. Try an earlier range.`;
        }

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

        // ── Snapshot current facts so we can restore them on promotion ─────
        // Partial recomp must not re-extract facts. Facts are session-wide and
        // the partial range does not see enough history to produce a complete
        // set. We carry existing facts through staging unchanged.
        const currentFacts = getSessionFacts(db, sessionId).map((f) => ({
            category: f.category,
            content: f.content,
        }));

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

        const projectPath = directory ? resolveProjectIdentity(directory) : undefined;
        const memories = projectPath
            ? getMemoriesByProject(db, projectPath, ["active", "permanent"])
            : [];
        const memoryBlockForExistingState = memories.length > 0 ? undefined : undefined; // unused in partial
        void memoryBlockForExistingState; // linter — facts/memories rendering reused below

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
            saveRecompStagingPass(db, sessionId, 0, candidateCompartments, currentFacts);
            setRecompPartialRange(db, sessionId, { start: snapStart, end: snapEnd });
        }

        let currentTokenBudget = historianChunkTokens;
        let passAttempt = 1;

        await sendIgnoredMessage(
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
            saveRecompStagingPass(db, sessionId, passCount + 1, merged, currentFacts);
            const promoted = promoteRecompStaging(db, sessionId);
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

            const lastEnd = merged[merged.length - 1]?.endMessage ?? snapEnd;
            // Plan v6 §6: partial recomp is explicit (eager cache clear). Apply
            // the marker directly here AND CAS-clear any stale pending blob a
            // prior in-flight incremental publish may have left behind — partial
            // recomp now owns the boundary up to lastEnd.
            if (deps.experimentalCompactionMarkers && lastEnd > 0) {
                updateCompactionMarkerAfterPublication(db, sessionId, lastEnd, deps.directory);
                const stalePending = getPendingCompactionMarkerState(db, sessionId);
                if (stalePending) {
                    clearPendingCompactionMarkerStateIf(db, sessionId, stalePending);
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
                return `## Magic Recomp — Failed\n\nPartial recomp stopped because the raw chunk could not be represented safely: ${chunkCoverageError}\n\nOriginal state preserved (staging kept for retry).`;
            }

            // Build existing-state XML: prior-only + new-built-so-far, plus facts
            // snapshot. Historian uses this to avoid re-emitting prior compartments
            // and to dedup fact candidates against existing facts/memories.
            const existingState = buildExistingStateXml(
                candidateCompartments,
                currentFacts,
                undefined,
            );

            const prompt = buildCompartmentAgentPrompt(
                existingState,
                `Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunk.text}`,
            );

            await sendIgnoredMessage(
                client,
                sessionId,
                `## Magic Recomp — Partial\n\nHistorian pass ${passCount + 1}, attempt ${passAttempt} started for messages ${chunk.startIndex}-${chunk.endIndex}.`,
                notifParams(),
            );

            const validatedPass = await runValidatedHistorianPass({
                client,
                parentSessionId: sessionId,
                sessionDirectory,
                prompt,
                chunk,
                priorCompartments: candidateCompartments,
                sequenceOffset: candidateCompartments.length,
                dumpLabelBase: `partial-recomp-${sessionId}-${chunk.startIndex}-${chunk.endIndex}-pass-${passCount + 1}`,
                timeoutMs: historianTimeoutMs,
                fallbackModelId: deps.fallbackModelId,
                fallbackModels: deps.fallbackModels,
                twoPass: deps.historianTwoPass,
                callbacks: {
                    onRepairRetry: async (error) => {
                        await sendIgnoredMessage(
                            client,
                            sessionId,
                            `## Magic Recomp — Partial\n\nHistorian pass ${passCount + 1}, attempt ${passAttempt} is continuing with a repair retry for messages ${chunk.startIndex}-${chunk.endIndex}.\n\nThe previous output did not validate: ${error}`,
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
                        await sendIgnoredMessage(
                            client,
                            sessionId,
                            `## Magic Recomp — Partial\n\nHistorian pass ${passCount + 1}, attempt ${passAttempt} is continuing with a smaller chunk ending at ${smallerChunk.endIndex} because messages ${chunk.startIndex}-${chunk.endIndex} could not be validated.\n\nValidator result: ${validatedPass.error}`,
                            notifParams(),
                        );
                        currentTokenBudget = reducedBudget;
                        passAttempt += 1;
                        continue;
                    }
                }
                return `## Magic Recomp — Failed\n\nPartial recomp failed while rebuilding messages ${chunk.startIndex}-${chunk.endIndex}: ${validatedPass.error}\n\nOriginal state preserved (staging kept for retry).`;
            }

            candidateCompartments = [
                ...candidateCompartments,
                ...(validatedPass.compartments ?? []),
            ];
            // Intentional: partial recomp ignores historian's fact output entirely.
            // Facts are session-wide and cannot be reliably re-derived from a partial
            // message range. currentFacts remains the untouched snapshot.

            passCount += 1;
            currentTokenBudget = historianChunkTokens;
            passAttempt = 1;

            saveRecompStagingPass(db, sessionId, passCount, candidateCompartments, currentFacts);

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
            `Facts unchanged (${currentFacts.length} entr${currentFacts.length === 1 ? "y" : "ies"}).`,
            `Total compartments: ${finalResult.compartmentCount}.`,
        ].join("\n");
    } catch (error: unknown) {
        const message = getErrorMessage(error);
        return `## Magic Recomp — Failed\n\nPartial recomp failed unexpectedly: ${message}\n\nStaging preserved for resume on next attempt.`;
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
