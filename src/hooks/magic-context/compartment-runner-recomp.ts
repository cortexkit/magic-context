import { replaceAllCompartmentState } from "../../features/magic-context/compartment-storage";
import { promoteSessionFactsToMemory } from "../../features/magic-context/memory";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { getSessionNotes } from "../../features/magic-context/storage";
import { updateSessionMeta } from "../../features/magic-context/storage-meta";
import { normalizeSDKResponse } from "../../shared";
import { buildCompartmentAgentPrompt } from "./compartment-prompt";
import { queueDropsForCompartmentalizedMessages } from "./compartment-runner-drop-queue";
import { runValidatedHistorianPass } from "./compartment-runner-historian";
import { buildExistingStateXml, resolveNotesToPersist } from "./compartment-runner-state-xml";
import type { CandidateCompartment, CompartmentRunnerDeps } from "./compartment-runner-types";
import {
    getReducedRecompTokenBudget,
    validateChunkCoverage,
    validateStoredCompartments,
} from "./compartment-runner-validation";
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
        tokenBudget,
        directory,
        historianTimeoutMs,
        getNotificationParams,
    } = deps;
    const notifParams = () => getNotificationParams?.() ?? {};
    updateSessionMeta(db, sessionId, { compartmentInProgress: true });

    try {
        const existingNotes = getSessionNotes(db, sessionId);
        const protectedTailStart = getProtectedTailStartOrdinal(sessionId);
        if (protectedTailStart <= 1) {
            return "## Magic Recomp\n\nNo eligible raw history exists before the protected tail, so nothing was rebuilt.";
        }

        const rawMessageCount = getRawSessionMessageCount(sessionId);
        const parentSessionResponse = await client.session
            .get({ path: { id: sessionId } })
            .catch(() => null);
        const parentSession = normalizeSDKResponse(
            parentSessionResponse,
            null as { directory?: string } | null,
            { preferResponseOnMissingData: true },
        );
        const sessionDirectory = parentSession?.directory ?? directory;

        let candidateCompartments: CandidateCompartment[] = [];
        let candidateFacts: Array<{ category: string; content: string }> = [];
        let candidateNotes: string[] = existingNotes.map((note) => note.content);
        let offset = 1;
        let passCount = 0;
        let currentTokenBudget = tokenBudget;
        let passAttempt = 1;

        while (offset < protectedTailStart) {
            const chunk = readSessionChunk(
                sessionId,
                currentTokenBudget,
                offset,
                protectedTailStart,
            );
            if (!chunk.text || chunk.messageCount === 0 || chunk.endIndex < offset) {
                return `## Magic Recomp\n\nRecomp stopped because raw history ${offset}-${protectedTailStart - 1} could not be turned into a valid historian chunk. Nothing was written.`;
            }

            const chunkCoverageError = validateChunkCoverage(chunk);
            if (chunkCoverageError) {
                return `## Magic Recomp\n\nRecomp stopped because the raw chunk could not be represented safely: ${chunkCoverageError}\n\nNothing was written.`;
            }

            const existingState =
                candidateCompartments.length > 0 ||
                candidateFacts.length > 0 ||
                candidateNotes.length > 0
                    ? buildExistingStateXml(candidateCompartments, candidateFacts, candidateNotes)
                    : "This is your first run. No existing state.";

            const prompt = buildCompartmentAgentPrompt(
                existingState,
                `Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunk.text}`,
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

                return `## Magic Recomp\n\nRecomp failed while rebuilding messages ${chunk.startIndex}-${chunk.endIndex}: ${validatedPass.error}\n\nNothing was written.`;
            }

            candidateCompartments =
                validatedPass.mode === "full"
                    ? (validatedPass.compartments ?? [])
                    : [...candidateCompartments, ...(validatedPass.compartments ?? [])];
            candidateFacts = validatedPass.facts ?? [];
            candidateNotes = validatedPass.notes ?? [];
            passCount += 1;
            currentTokenBudget = tokenBudget;
            passAttempt = 1;

            const nextOffset =
                (validatedPass.compartments?.[validatedPass.compartments.length - 1]?.endMessage ??
                    chunk.endIndex) + 1;
            if (nextOffset <= offset) {
                return `## Magic Recomp\n\nRecomp made no forward progress after messages ${chunk.startIndex}-${chunk.endIndex}. Nothing was written.`;
            }
            offset = nextOffset;
        }

        const mergedValidationError = validateStoredCompartments(candidateCompartments);
        if (mergedValidationError) {
            return `## Magic Recomp\n\nRecomp produced an invalid final compartment set: ${mergedValidationError}\n\nNothing was written.`;
        }

        const notesToPersist = resolveNotesToPersist(
            db,
            sessionId,
            existingNotes.map((note) => note.content),
            candidateNotes,
        );

        replaceAllCompartmentState(
            db,
            sessionId,
            candidateCompartments,
            candidateFacts,
            notesToPersist,
        );
        promoteSessionFactsToMemory(
            db,
            sessionId,
            resolveProjectIdentity(deps.directory ?? process.cwd()),
            candidateFacts,
        );

        const lastCompartmentEnd =
            candidateCompartments[candidateCompartments.length - 1]?.endMessage ?? 0;
        if (lastCompartmentEnd > 0) {
            queueDropsForCompartmentalizedMessages(db, sessionId, lastCompartmentEnd);
        }

        return [
            "## Magic Recomp",
            "",
            `Rebuilt ${candidateCompartments.length} compartments across ${passCount} historian pass${passCount === 1 ? "" : "es"}.`,
            `Covered raw history 1-${lastCompartmentEnd} out of ${rawMessageCount} total messages, stopping before protected tail at ${protectedTailStart}.`,
            `Replaced facts with ${candidateFacts.length} current entr${candidateFacts.length === 1 ? "y" : "ies"}.`,
            `Replaced session notes with ${notesToPersist.length} current entr${notesToPersist.length === 1 ? "y" : "ies"}.`,
        ].join("\n");
    } catch (error: unknown) {
        // Recomp replaces durable state atomically, so unexpected failures must leave state untouched.
        const message = error instanceof Error ? error.message : String(error);
        return `## Magic Recomp\n\nRecomp failed unexpectedly: ${message}\n\nNothing was written.`;
    } finally {
        updateSessionMeta(db, sessionId, { compartmentInProgress: false });
    }
}
