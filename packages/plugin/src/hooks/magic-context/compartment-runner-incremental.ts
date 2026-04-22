import {
    appendCompartments,
    getCompartments,
    getSessionFacts,
    replaceSessionFacts,
} from "../../features/magic-context/compartment-storage";
import { promoteSessionFactsToMemory } from "../../features/magic-context/memory";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { getMemoriesByProject } from "../../features/magic-context/memory/storage-memory";
import {
    clearEmergencyRecovery,
    clearHistorianFailureState,
    incrementHistorianFailure,
} from "../../features/magic-context/storage";
import { updateSessionMeta } from "../../features/magic-context/storage-meta";
import { insertUserMemoryCandidates } from "../../features/magic-context/user-memory/storage-user-memory";
import { normalizeSDKResponse } from "../../shared";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { updateCompactionMarkerAfterPublication } from "./compaction-marker-manager";
import { buildCompartmentAgentPrompt } from "./compartment-prompt";
import { runCompressionPassIfNeeded } from "./compartment-runner-compressor";
import { queueDropsForCompartmentalizedMessages } from "./compartment-runner-drop-queue";
import { runValidatedHistorianPass } from "./compartment-runner-historian";
import { buildExistingStateXml } from "./compartment-runner-state-xml";
import type { CompartmentRunnerDeps } from "./compartment-runner-types";
import { validateChunkCoverage, validateStoredCompartments } from "./compartment-runner-validation";
import { clearInjectionCache, renderMemoryBlock } from "./inject-compartments";
import { onNoteTrigger } from "./note-nudger";
import { getProtectedTailStartOrdinal, readSessionChunk } from "./read-session-chunk";
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
    let issueNotified = false;

    const notifyHistorianIssue = async (message: string): Promise<void> => {
        issueNotified = true;
        if (shouldSuppressHistorianAlert(sessionId)) {
            sessionLog(sessionId, "historian alert suppressed (cooldown):", message.slice(0, 100));
            return;
        }
        await sendIgnoredMessage(client, sessionId, message, getNotificationParams?.() ?? {});
    };

    updateSessionMeta(db, sessionId, { compartmentInProgress: true });

    try {
        const existingCompartments = getCompartments(db, sessionId);
        const existingFacts = getSessionFacts(db, sessionId);

        const priorCompartments = existingCompartments;
        const priorFacts = existingFacts;

        const existingValidationError = validateStoredCompartments(priorCompartments);
        if (existingValidationError) {
            await notifyHistorianIssue(
                `## Historian alert\n\nHistorian skipped this session because existing stored compartments are invalid: ${existingValidationError}\n\nNo new compartments or facts were written. Rebuild or clear the broken compartments before continuing.`,
            );
            return;
        }

        const offset =
            priorCompartments.length > 0
                ? priorCompartments[priorCompartments.length - 1].endMessage + 1
                : 1;

        const protectedTailStart = getProtectedTailStartOrdinal(sessionId);
        if (protectedTailStart <= offset) {
            return;
        }

        const chunk = readSessionChunk(sessionId, historianChunkTokens, offset, protectedTailStart);
        if (!chunk.text || chunk.messageCount === 0) {
            return;
        }

        const chunkCoverageError = validateChunkCoverage(chunk);
        if (chunkCoverageError) {
            await notifyHistorianIssue(
                `## Historian alert\n\nHistorian skipped this session because the raw chunk could not be represented safely: ${chunkCoverageError}\n\nNo new compartments or facts were written.`,
            );
            return;
        }

        // Render project memories as read-only reference so historian can dedup facts against them
        const projectPath = resolveProjectIdentity(directory ?? process.cwd());
        const memories = getMemoriesByProject(db, projectPath, ["active", "permanent"]);
        const memoryBlock = renderMemoryBlock(memories) ?? undefined;

        const existingState =
            priorCompartments.length > 0 || priorFacts.length > 0
                ? buildExistingStateXml(priorCompartments, priorFacts, memoryBlock)
                : memoryBlock
                  ? `${memoryBlock}\n\nThis is your first run. No existing compartments or facts.`
                  : "This is your first run. No existing state.";

        const prompt = buildCompartmentAgentPrompt(
            existingState,
            `Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunk.text}`,
        );

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

        const validatedPass = await runValidatedHistorianPass({
            client,
            parentSessionId: sessionId,
            sessionDirectory,
            prompt,
            chunk,
            priorCompartments,
            sequenceOffset,
            dumpLabelBase: `incremental-${sessionId}-${chunk.startIndex}-${chunk.endIndex}`,
            timeoutMs: historianTimeoutMs,
            fallbackModelId: deps.fallbackModelId,
            twoPass: deps.historianTwoPass,
        });
        if (!validatedPass.ok) {
            // Always track historian failures regardless of usage percentage.
            // The emergency abort path at 95% checks failureCount > 0, so failures
            // at any pressure level must be recorded.
            incrementHistorianFailure(db, sessionId, validatedPass.error);
            await notifyHistorianIssue(
                `## Historian alert\n\n${validatedPass.error}\n\nNo new compartments or facts were written. Check the historian model/output and try again.`,
            );
            return;
        }

        const newCompartments = validatedPass.compartments;

        const lastNewEnd = newCompartments[newCompartments.length - 1]?.endMessage ?? 0;
        if (lastNewEnd + 1 <= offset) {
            await notifyHistorianIssue(
                `## Historian alert\n\nHistorian returned compartments that made no forward progress beyond raw message ${offset - 1}.\n\nNo new compartments or facts were written. Check the historian model/output and try again.`,
            );
            return;
        }

        // Append new compartments (existing stay untouched in DB) and replace facts atomically
        // Intentional: nested transaction — appendCompartments/replaceSessionFacts have their own
        // transactions for standalone safety. SQLite SAVEPOINTs handle nesting correctly in Bun.
        db.transaction(() => {
            appendCompartments(db, sessionId, newCompartments);
            replaceSessionFacts(db, sessionId, validatedPass.facts ?? []);
            clearHistorianFailureState(db, sessionId);
            // Successful historian publication means the overflow recovery is
            // complete for this session. Clear the flag so we don't keep
            // force-bumping percentage on future turns. detectedContextLimit
            // stays — it's the authoritative real limit and remains valuable
            // for pressure math going forward.
            clearEmergencyRecovery(db, sessionId);
        })();
        // Invalidate in-memory injection cache so the next transform rebuilds <session-history>
        // with the new compartments/facts. Without this, cached stale content persists.
        clearInjectionCache(sessionId);
        if (deps.directory) {
            promoteSessionFactsToMemory(
                db,
                sessionId,
                resolveProjectIdentity(deps.directory),
                validatedPass.facts ?? [],
            );
        }

        const lastCompartmentEnd = lastNewEnd;
        queueDropsForCompartmentalizedMessages(db, sessionId, lastCompartmentEnd);

        // Inject compaction marker into OpenCode's DB if experimental flag is enabled
        if (deps.experimentalCompactionMarkers) {
            updateCompactionMarkerAfterPublication(
                db,
                sessionId,
                lastCompartmentEnd,
                sessionDirectory,
            );
        }

        // Run compression pass if history block exceeds budget
        if (deps.historyBudgetTokens && deps.historyBudgetTokens > 0) {
            await runCompressionPassIfNeeded({
                client,
                db,
                sessionId,
                directory: sessionDirectory,
                historyBudgetTokens: deps.historyBudgetTokens,
                historianTimeoutMs,
                minCompartmentRatio: deps.compressorMinCompartmentRatio,
                maxMergeDepth: deps.compressorMaxMergeDepth,
            });
            // No marker update needed after compression — marker uses static placeholder text.
            // Compressor changes compartment content but not the boundary ordinal.
        }

        updateSessionMeta(db, sessionId, { compartmentInProgress: false });
        completedSuccessfully = true;
        onNoteTrigger(db, sessionId, "historian_complete");

        // Store user behavior observations as candidates if user memories are enabled
        if (validatedPass.userObservations && validatedPass.userObservations.length > 0) {
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
    } catch (error: unknown) {
        // Historian runs are fail-closed because they update durable compartment state.
        const msg = getErrorMessage(error);
        if (!issueNotified) {
            await notifyHistorianIssue(
                `## Historian alert\n\nHistorian failed unexpectedly: ${msg}\n\nNo new compartments or facts were written. Check the historian model/output and try again.`,
            );
        }
    } finally {
        if (!completedSuccessfully) {
            updateSessionMeta(db, sessionId, { compartmentInProgress: false });
        }
    }
}
