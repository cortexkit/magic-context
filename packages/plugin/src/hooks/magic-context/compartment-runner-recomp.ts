import {
    clearRecompStaging,
    getRecompStaging,
    promoteRecompStaging,
    replaceAllCompartmentState,
    saveRecompStagingPass,
} from "../../features/magic-context/compartment-storage";
import { clearCompressionDepth } from "../../features/magic-context/compression-depth-storage";
import { promoteSessionFactsToMemory } from "../../features/magic-context/memory";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { getMemoriesByProject } from "../../features/magic-context/memory/storage-memory";
import { updateSessionMeta } from "../../features/magic-context/storage-meta";
import { normalizeSDKResponse } from "../../shared";
import { getErrorMessage } from "../../shared/error-message";
import { updateCompactionMarkerAfterPublication } from "./compaction-marker-manager";
import { buildCompartmentAgentPrompt } from "./compartment-prompt";
import { runCompressionPassIfNeeded } from "./compartment-runner-compressor";
import { queueDropsForCompartmentalizedMessages } from "./compartment-runner-drop-queue";
import { runValidatedHistorianPass } from "./compartment-runner-historian";
import {
    cleanupHistorianStateFile,
    maybeWriteHistorianStateFile,
} from "./compartment-runner-incremental";
import { buildExistingStateXml } from "./compartment-runner-state-xml";
import type { CandidateCompartment, CompartmentRunnerDeps } from "./compartment-runner-types";
import {
    getReducedRecompTokenBudget,
    validateChunkCoverage,
    validateStoredCompartments,
} from "./compartment-runner-validation";
import { clearInjectionCache, renderMemoryBlock } from "./inject-compartments";
import {
    getProtectedTailStartOrdinal,
    getRawSessionMessageCount,
    readSessionChunk,
} from "./read-session-chunk";
import { sendIgnoredMessage } from "./send-session-notification";

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
    // State file for the current pass — hoisted to be accessible in finally{}
    let currentStateFilePath: string | undefined;
    updateSessionMeta(db, sessionId, { compartmentInProgress: true });

    try {
        const protectedTailStart = getProtectedTailStartOrdinal(sessionId);
        if (protectedTailStart <= 1) {
            return "## Magic Recomp\n\nNo eligible raw history exists before the protected tail, so nothing was rebuilt.";
        }

        const rawMessageCount = getRawSessionMessageCount(sessionId);
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

        // Render project memories once as read-only reference for fact dedup across all passes
        const projectPath = directory ? resolveProjectIdentity(directory) : undefined;
        const memories = projectPath
            ? getMemoriesByProject(db, projectPath, ["active", "permanent"])
            : [];
        const memoryBlock = renderMemoryBlock(memories) ?? undefined;

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

        /** Promote staging → real tables and run post-processing.
         *  Returns formatted status lines on success, or null if validation fails or there's nothing to promote. */
        function promoteAndFinalize(reason: string): string | null {
            if (passCount === 0 || candidateCompartments.length === 0) return null;

            const mergedError = validateStoredCompartments(candidateCompartments);
            if (mergedError) return null;

            // Ensure latest candidates are saved to staging before promoting
            saveRecompStagingPass(db, sessionId, passCount, candidateCompartments, candidateFacts);

            const promoted = promoteRecompStaging(db, sessionId);
            if (!promoted) return null;

            // Full recomp rebuilds every compartment from message 1 onward, so
            // all pre-existing compression-depth rows are stale — the compressor
            // would otherwise skip or wrongly tier the fresh compartments. Wipe
            // per-session depth state so the rebuilt compartments start at depth
            // 0, matching what partial recomp does for its rebuilt range.
            clearCompressionDepth(db, sessionId);

            // Invalidate injection cache after recomp promotion
            clearInjectionCache(sessionId);
            // Signal the caller that the next transform MUST treat itself as
            // cache-busting. See council Finding #9.
            deps.onInjectionCacheCleared?.(sessionId);

            // Issue #44: respect memory.enabled and memory.auto_promote.
            if (deps.directory && deps.memoryEnabled !== false && deps.autoPromote !== false) {
                promoteSessionFactsToMemory(
                    db,
                    sessionId,
                    resolveProjectIdentity(deps.directory),
                    promoted.facts,
                );
            }

            const lastCompartmentEnd =
                promoted.compartments[promoted.compartments.length - 1]?.endMessage ?? 0;
            if (lastCompartmentEnd > 0) {
                queueDropsForCompartmentalizedMessages(db, sessionId, lastCompartmentEnd);
            }

            // Update compaction marker after recomp if experimental flag is enabled
            if (deps.experimentalCompactionMarkers && lastCompartmentEnd > 0) {
                updateCompactionMarkerAfterPublication(
                    db,
                    sessionId,
                    lastCompartmentEnd,
                    deps.directory,
                );
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
                const promoted = promoteAndFinalize(
                    `remaining messages ${offset}-${protectedTailStart - 1} were too few or all noise to form a historian chunk`,
                );
                if (promoted) {
                    return `## Magic Recomp — Complete\n\n${promoted}`;
                }
                return `## Magic Recomp — Failed\n\nRecomp stopped because raw history ${offset}-${protectedTailStart - 1} could not be turned into a valid historian chunk. Nothing was written.`;
            }

            const chunkCoverageError = validateChunkCoverage(chunk);
            if (chunkCoverageError) {
                const partial = promoteAndFinalize(
                    `chunk could not be represented safely: ${chunkCoverageError}`,
                );
                if (partial) {
                    return `## Magic Recomp — Partial\n\n${partial}`;
                }
                return `## Magic Recomp — Failed\n\nRecomp stopped because the raw chunk could not be represented safely: ${chunkCoverageError}\n\nNothing was written.`;
            }

            const existingState =
                candidateCompartments.length > 0 || candidateFacts.length > 0
                    ? buildExistingStateXml(candidateCompartments, candidateFacts, memoryBlock)
                    : memoryBlock
                      ? `${memoryBlock}\n\nThis is your first run. No existing compartments or facts.`
                      : "This is your first run. No existing state.";

            // Clean up previous pass's state file before writing the new one
            cleanupHistorianStateFile(currentStateFilePath);
            currentStateFilePath = maybeWriteHistorianStateFile(sessionId, existingState);

            const prompt = buildCompartmentAgentPrompt(
                existingState,
                `Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunk.text}`,
                { stateFilePath: currentStateFilePath },
            );

            await sendIgnoredMessage(
                client,
                sessionId,
                `## Magic Recomp\n\nHistorian pass ${passCount + 1}, attempt ${passAttempt} started for messages ${chunk.startIndex}-${chunk.endIndex}.`,
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
                dumpLabelBase: `recomp-${sessionId}-${chunk.startIndex}-${chunk.endIndex}-pass-${passCount + 1}`,
                timeoutMs: historianTimeoutMs,
                fallbackModelId: deps.fallbackModelId,
                twoPass: deps.historianTwoPass,
                callbacks: {
                    onRepairRetry: async (error) => {
                        await sendIgnoredMessage(
                            client,
                            sessionId,
                            `## Magic Recomp\n\nHistorian pass ${passCount + 1}, attempt ${passAttempt} is continuing with a repair retry for messages ${chunk.startIndex}-${chunk.endIndex}.\n\nThe previous output did not validate: ${error}`,
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

                const partial = promoteAndFinalize(
                    `historian failed to validate messages ${chunk.startIndex}-${chunk.endIndex}: ${validatedPass.error}`,
                );
                if (partial) {
                    return `## Magic Recomp — Partial\n\n${partial}`;
                }
                return `## Magic Recomp — Failed\n\nRecomp failed while rebuilding messages ${chunk.startIndex}-${chunk.endIndex}: ${validatedPass.error}\n\nNothing was written.`;
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
                const partial = promoteAndFinalize(
                    `historian made no forward progress after messages ${chunk.startIndex}-${chunk.endIndex}`,
                );
                if (partial) {
                    return `## Magic Recomp — Partial\n\n${partial}`;
                }
                return `## Magic Recomp — Failed\n\nRecomp made no forward progress after messages ${chunk.startIndex}-${chunk.endIndex}. Nothing was written.`;
            }
            offset = nextOffset;
        }

        const mergedValidationError = validateStoredCompartments(candidateCompartments);
        if (mergedValidationError) {
            // Clean up staging on final validation failure
            clearRecompStaging(db, sessionId);
            return `## Magic Recomp — Failed\n\nRecomp completed ${passCount} pass${passCount === 1 ? "" : "es"} but produced an invalid final compartment set: ${mergedValidationError}\n\nNothing was written.`;
        }

        // Final success: promote staging → real tables
        saveRecompStagingPass(db, sessionId, passCount, candidateCompartments, candidateFacts);
        const promoted = promoteRecompStaging(db, sessionId);
        if (!promoted) {
            // Fallback: direct write if promotion somehow fails
            replaceAllCompartmentState(db, sessionId, candidateCompartments, candidateFacts);
            clearRecompStaging(db, sessionId);
        }
        // Full recomp rebuilds every compartment, so all pre-existing depth
        // rows are stale. Matches partial recomp's behavior for rebuilt ranges.
        clearCompressionDepth(db, sessionId);
        // Invalidate injection cache after final recomp promotion
        clearInjectionCache(sessionId);
        // Signal the caller that the next transform MUST treat itself as
        // cache-busting. See council Finding #9.
        deps.onInjectionCacheCleared?.(sessionId);

        const finalCompartments = promoted?.compartments ?? candidateCompartments;
        const finalFacts = promoted?.facts ?? candidateFacts;

        // Issue #44: respect memory.enabled and memory.auto_promote.
        if (deps.directory && deps.memoryEnabled !== false && deps.autoPromote !== false) {
            promoteSessionFactsToMemory(
                db,
                sessionId,
                resolveProjectIdentity(deps.directory),
                finalFacts,
            );
        }

        const lastCompartmentEnd = finalCompartments[finalCompartments.length - 1]?.endMessage ?? 0;
        if (lastCompartmentEnd > 0) {
            queueDropsForCompartmentalizedMessages(db, sessionId, lastCompartmentEnd);
        }

        // Run compression pass if history block exceeds budget
        let compressed = false;
        if (deps.historyBudgetTokens && deps.historyBudgetTokens > 0) {
            compressed = await runCompressionPassIfNeeded({
                client,
                db,
                sessionId,
                directory: sessionDirectory,
                historyBudgetTokens: deps.historyBudgetTokens,
                historianTimeoutMs,
                minCompartmentRatio: deps.compressorMinCompartmentRatio,
                maxMergeDepth: deps.compressorMaxMergeDepth,
            });
        }

        return [
            "## Magic Recomp — Complete",
            "",
            ...(resumed ? ["Resumed from previous interrupted run."] : []),
            `Rebuilt ${finalCompartments.length} compartment${finalCompartments.length === 1 ? "" : "s"} across ${passCount} historian pass${passCount === 1 ? "" : "es"}.`,
            `Covered raw history 1-${lastCompartmentEnd} out of ${rawMessageCount} total messages, stopping before protected tail at ${protectedTailStart}.`,
            `Replaced facts with ${finalFacts.length} current entr${finalFacts.length === 1 ? "y" : "ies"}.`,
            ...(compressed ? ["Compression pass ran to fit within history budget."] : []),
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
