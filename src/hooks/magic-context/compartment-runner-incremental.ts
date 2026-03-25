import {
    appendCompartments,
    getCompartments,
    getSessionFacts,
    replaceSessionFacts,
} from "../../features/magic-context/compartment-storage";
import { promoteSessionFactsToMemory } from "../../features/magic-context/memory";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { getMemoriesByProject } from "../../features/magic-context/memory/storage-memory";
import { updateSessionMeta } from "../../features/magic-context/storage-meta";
import { normalizeSDKResponse } from "../../shared";
import { getErrorMessage } from "../../shared/error-message";
import { buildCompartmentAgentPrompt } from "./compartment-prompt";
import { runCompressionPassIfNeeded } from "./compartment-runner-compressor";
import { queueDropsForCompartmentalizedMessages } from "./compartment-runner-drop-queue";
import { runValidatedHistorianPass } from "./compartment-runner-historian";
import { buildExistingStateXml } from "./compartment-runner-state-xml";
import type { CompartmentRunnerDeps } from "./compartment-runner-types";
import { validateChunkCoverage, validateStoredCompartments } from "./compartment-runner-validation";
import { renderMemoryBlock } from "./inject-compartments";
import { onNoteTrigger } from "./note-nudger";
import { getProtectedTailStartOrdinal, readSessionChunk } from "./read-session-chunk";
import { sendIgnoredMessage } from "./send-session-notification";

export async function runCompartmentAgent(deps: CompartmentRunnerDeps): Promise<void> {
    const {
        client,
        db,
        sessionId,
        tokenBudget,
        directory,
        historianTimeoutMs,
        getNotificationParams,
    } = deps;
    let completedSuccessfully = false;
    let issueNotified = false;

    const notifyHistorianIssue = async (message: string): Promise<void> => {
        issueNotified = true;
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

        const chunk = readSessionChunk(sessionId, tokenBudget, offset, protectedTailStart);
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

        const validatedPass = await runValidatedHistorianPass({
            client,
            parentSessionId: sessionId,
            sessionDirectory,
            prompt,
            chunk,
            priorCompartments,
            sequenceOffset: priorCompartments.length,
            dumpLabelBase: `incremental-${sessionId}-${chunk.startIndex}-${chunk.endIndex}`,
            timeoutMs: historianTimeoutMs,
        });
        if (!validatedPass.ok) {
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
        db.transaction(() => {
            appendCompartments(db, sessionId, newCompartments);
            replaceSessionFacts(db, sessionId, validatedPass.facts ?? []);
        })();
        promoteSessionFactsToMemory(
            db,
            sessionId,
            resolveProjectIdentity(deps.directory ?? process.cwd()),
            validatedPass.facts ?? [],
        );

        const lastCompartmentEnd = lastNewEnd;
        queueDropsForCompartmentalizedMessages(db, sessionId, lastCompartmentEnd);

        // Run compression pass if history block exceeds budget
        if (deps.historyBudgetTokens && deps.historyBudgetTokens > 0) {
            await runCompressionPassIfNeeded({
                client,
                db,
                sessionId,
                directory: sessionDirectory,
                historyBudgetTokens: deps.historyBudgetTokens,
                historianTimeoutMs,
            });
        }

        updateSessionMeta(db, sessionId, { compartmentInProgress: false });
        completedSuccessfully = true;
        onNoteTrigger(sessionId, "historian_complete");
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
