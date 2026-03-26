import type { Database } from "bun:sqlite";
import { DEFAULT_HISTORIAN_TIMEOUT_MS } from "../../config/schema/magic-context";
import type { Compartment } from "../../features/magic-context/compartment-storage";
import {
    getCompartments,
    getSessionFacts,
    replaceAllCompartmentState,
} from "../../features/magic-context/compartment-storage";
import type { PluginContext } from "../../plugin/types";
import { normalizeSDKResponse, promptSyncWithModelSuggestionRetry } from "../../shared";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { extractLatestAssistantText } from "../../shared/assistant-message-extractor";
import { parseCompartmentOutput } from "./compartment-parser";
import { buildCompressorPrompt } from "./compartment-prompt";
import { estimateTokens } from "./read-session-formatting";

const HISTORIAN_AGENT = "historian";

export interface CompressorDeps {
    client: PluginContext["client"];
    db: Database;
    sessionId: string;
    directory: string;
    historyBudgetTokens: number;
    historianTimeoutMs?: number;
}

/**
 * Check if the compartment block exceeds the history budget and run a compression pass if needed.
 * Returns true if compression ran successfully, false otherwise.
 */
export async function runCompressionPassIfNeeded(deps: CompressorDeps): Promise<boolean> {
    const { db, sessionId, historyBudgetTokens } = deps;

    const compartments = getCompartments(db, sessionId);
    if (compartments.length <= 1) return false;

    const facts = getSessionFacts(db, sessionId);

    // Estimate the current block size (compartments + facts, excluding memory block which is cached separately)
    let totalTokens = 0;
    for (const c of compartments) {
        // Rough estimate: title + content + XML overhead
        totalTokens += estimateTokens(
            `<compartment start="${c.startMessage}" end="${c.endMessage}" title="${c.title}">\n${c.content}\n</compartment>\n`,
        );
    }
    for (const f of facts) {
        totalTokens += estimateTokens(`* ${f.content}\n`);
    }

    if (totalTokens <= historyBudgetTokens) {
        sessionLog(
            sessionId,
            `compressor: history block ~${totalTokens} tokens within budget ${historyBudgetTokens}, skipping`,
        );
        return false;
    }

    const overage = totalTokens - historyBudgetTokens;
    sessionLog(
        sessionId,
        `compressor: history block ~${totalTokens} tokens exceeds budget ${historyBudgetTokens} by ~${overage} tokens`,
    );

    // Select oldest N compartments whose combined tokens are ~2× the overage
    // (so compressing them to ~50% gets us back under budget)
    const targetSelectionTokens = overage * 2;
    let selectedTokens = 0;
    let selectedCount = 0;

    for (const c of compartments) {
        if (selectedTokens >= targetSelectionTokens) break;
        selectedTokens += estimateTokens(
            `<compartment start="${c.startMessage}" end="${c.endMessage}" title="${c.title}">\n${c.content}\n</compartment>\n`,
        );
        selectedCount++;
    }

    // Need at least 2 compartments to compress (merging 1 is pointless)
    if (selectedCount < 2) {
        sessionLog(sessionId, "compressor: not enough compartments to compress, skipping");
        return false;
    }

    const selectedCompartments = compartments.slice(0, selectedCount);
    const targetTokens = Math.floor(selectedTokens / 2);

    sessionLog(
        sessionId,
        `compressor: selected ${selectedCount} oldest compartments (~${selectedTokens} tokens), target ~${targetTokens} tokens`,
    );

    try {
        const compressed = await runCompressorPass({
            ...deps,
            compartments: selectedCompartments,
            currentTokens: selectedTokens,
            targetTokens,
        });

        if (!compressed) {
            sessionLog(
                sessionId,
                "compressor: compression pass failed, keeping existing compartments",
            );
            return false;
        }

        // Replace the selected compartments with compressed ones, keep the rest unchanged
        const remainingCompartments = compartments.slice(selectedCount);
        const allCompartments = [
            ...compressed.map((c, i) => ({
                sequence: i,
                startMessage: c.startMessage,
                endMessage: c.endMessage,
                startMessageId: c.startMessageId,
                endMessageId: c.endMessageId,
                title: c.title,
                content: c.content,
            })),
            ...remainingCompartments.map((c, i) => ({
                sequence: compressed.length + i,
                startMessage: c.startMessage,
                endMessage: c.endMessage,
                startMessageId: c.startMessageId,
                endMessageId: c.endMessageId,
                title: c.title,
                content: c.content,
            })),
        ];

        // Validate: compressed compartments must cover same range as originals
        const originalStart = selectedCompartments[0].startMessage;
        const originalEnd = selectedCompartments[selectedCompartments.length - 1].endMessage;
        const compressedStart = compressed[0].startMessage;
        const compressedEnd = compressed[compressed.length - 1].endMessage;

        if (compressedStart !== originalStart || compressedEnd !== originalEnd) {
            sessionLog(
                sessionId,
                `compressor: compressed range ${compressedStart}-${compressedEnd} doesn't match original ${originalStart}-${originalEnd}, aborting`,
            );
            return false;
        }

        // Validate internal contiguity: no gaps or overlaps between compressed compartments
        for (let i = 1; i < compressed.length; i++) {
            const prev = compressed[i - 1];
            const curr = compressed[i];
            if (curr.startMessage <= prev.endMessage) {
                sessionLog(
                    sessionId,
                    `compressor: overlap at compartment ${i}: prev ends ${prev.endMessage}, curr starts ${curr.startMessage}, aborting`,
                );
                return false;
            }
            if (curr.startMessage > prev.endMessage + 1) {
                sessionLog(
                    sessionId,
                    `compressor: gap at compartment ${i}: prev ends ${prev.endMessage}, curr starts ${curr.startMessage}, aborting`,
                );
                return false;
            }
        }

        // Persist: replace compartments only, keep facts as-is
        replaceAllCompartmentState(
            db,
            sessionId,
            allCompartments,
            facts.map((f) => ({ category: f.category, content: f.content })),
        );

        sessionLog(
            sessionId,
            `compressor: replaced ${selectedCount} compartments with ${compressed.length} compressed compartments`,
        );
        return true;
    } catch (error: unknown) {
        sessionLog(sessionId, "compressor: unexpected error:", getErrorMessage(error));
        return false;
    }
}

interface CompressorPassArgs {
    client: PluginContext["client"];
    sessionId: string;
    directory: string;
    compartments: Compartment[];
    currentTokens: number;
    targetTokens: number;
    historianTimeoutMs?: number;
}

async function runCompressorPass(args: CompressorPassArgs): Promise<Array<{
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
    title: string;
    content: string;
}> | null> {
    const {
        client,
        sessionId,
        directory,
        compartments,
        currentTokens,
        targetTokens,
        historianTimeoutMs,
    } = args;

    const prompt = buildCompressorPrompt(compartments, currentTokens, targetTokens);

    let agentSessionId: string | null = null;
    try {
        const createResponse = await client.session.create({
            body: {
                parentID: sessionId,
                title: "magic-context-compressor",
            },
            query: { directory },
        });

        const createdSession = normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        agentSessionId = typeof createdSession?.id === "string" ? createdSession.id : null;

        if (!agentSessionId) {
            sessionLog(sessionId, "compressor: could not create child session");
            return null;
        }

        await promptSyncWithModelSuggestionRetry(
            client,
            {
                path: { id: agentSessionId },
                query: { directory },
                body: {
                    agent: HISTORIAN_AGENT,
                    parts: [{ type: "text", text: prompt }],
                },
            },
            { timeoutMs: historianTimeoutMs ?? DEFAULT_HISTORIAN_TIMEOUT_MS },
        );

        const messagesResponse = await client.session.messages({
            path: { id: agentSessionId },
            query: { directory },
        });
        const messages = normalizeSDKResponse(messagesResponse, [] as unknown[], {
            preferResponseOnMissingData: true,
        });
        const result = extractLatestAssistantText(messages);
        if (!result) {
            sessionLog(sessionId, "compressor: historian returned no output");
            return null;
        }

        const parsed = parseCompartmentOutput(result);
        if (parsed.compartments.length === 0) {
            sessionLog(sessionId, "compressor: historian returned no compartments");
            return null;
        }

        // Build a lookup for message IDs from original compartments
        const messageIdMap = new Map<number, string>();
        for (const c of compartments) {
            messageIdMap.set(c.startMessage, c.startMessageId);
            messageIdMap.set(c.endMessage, c.endMessageId);
        }

        // Map parsed compartments to stored format with message IDs
        const mapped = parsed.compartments.map((pc) => {
            const startId = messageIdMap.get(pc.startMessage) ?? "";
            const endId = messageIdMap.get(pc.endMessage) ?? "";
            if (!startId || !endId) {
                sessionLog(
                    sessionId,
                    `compressor: messageId miss for ordinals ${pc.startMessage}→${pc.endMessage} (startId=${startId || "MISSING"}, endId=${endId || "MISSING"})`,
                );
            }
            return {
                startMessage: pc.startMessage,
                endMessage: pc.endMessage,
                startMessageId: startId,
                endMessageId: endId,
                title: pc.title,
                content: pc.content,
            };
        });

        // Reject if any compartment has empty messageIds — the compressor introduced
        // boundaries we can't anchor. Empty interior IDs cause silent data degradation,
        // and an empty final endMessageId breaks visible-prefix trimming.
        const hasEmptyIds = mapped.some((c) => !c.startMessageId || !c.endMessageId);
        if (hasEmptyIds) {
            sessionLog(
                sessionId,
                "compressor: rejecting — one or more compartments have empty messageIds",
            );
            return null;
        }

        return mapped;
    } catch (error: unknown) {
        sessionLog(sessionId, "compressor: historian call failed:", getErrorMessage(error));
        return null;
    } finally {
        if (agentSessionId) {
            await client.session
                .delete({ path: { id: agentSessionId }, query: { directory } })
                .catch((e: unknown) => {
                    sessionLog(
                        sessionId,
                        "compressor: session cleanup failed:",
                        getErrorMessage(e),
                    );
                });
        }
    }
}
