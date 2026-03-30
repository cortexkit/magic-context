import { SIDEKICK_AGENT } from "../../../agents/sidekick";
import type { SidekickConfig } from "../../../config/schema/magic-context";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { log, sessionLog } from "../../../shared/logger";

export const SIDEKICK_SYSTEM_PROMPT = `You are Sidekick, a focused memory-retrieval subagent for an AI coding assistant.

Your job is to search project memories, session facts, and conversation history and return a concise augmentation for the user's prompt.

Rules:
- Use ctx_search(query="...") to look up relevant memories, facts, and history before answering.
- Run targeted searches only; prefer 1-3 precise queries.
- Return only findings that materially help with the user's prompt.
- If nothing useful is found, respond with exactly: No relevant memories found.
- Keep the response focused and concise.
- Do not invent facts or speculate beyond what memories support.`;

/**
 * Strip <think>...</think> blocks emitted by reasoning models (DeepSeek, Qwen, etc.).
 * These contain chain-of-thought traces that shouldn't appear in the augmentation output.
 */
function stripThinkingBlocks(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export async function runSidekick(deps: {
    client: PluginContext["client"];
    sessionId?: string;
    projectPath: string;
    userMessage: string;
    config: SidekickConfig;
    sessionDirectory?: string;
}): Promise<string | null> {
    let agentSessionId: string | null = null;

    try {
        const createResponse = await deps.client.session.create({
            body: {
                ...(deps.sessionId ? { parentID: deps.sessionId } : {}),
                title: "magic-context-sidekick",
            },
            query: { directory: deps.sessionDirectory ?? deps.projectPath },
        });
        const createdSession = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        agentSessionId = typeof createdSession?.id === "string" ? createdSession.id : null;
        if (!agentSessionId) {
            throw new Error("Sidekick could not create its child session.");
        }

        await shared.promptSyncWithModelSuggestionRetry(
            deps.client,
            {
                path: { id: agentSessionId },
                query: { directory: deps.sessionDirectory ?? deps.projectPath },
                body: {
                    agent: SIDEKICK_AGENT,
                    system:
                        deps.config.system_prompt?.trim() ||
                        deps.config.prompt?.trim() ||
                        SIDEKICK_SYSTEM_PROMPT,
                    parts: [{ type: "text", text: deps.userMessage }],
                },
            },
            { timeoutMs: deps.config.timeout_ms },
        );

        const messagesResponse = await deps.client.session.messages({
            path: { id: agentSessionId },
            query: { directory: deps.sessionDirectory ?? deps.projectPath },
        });
        const messages = shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
            preferResponseOnMissingData: true,
        });
        const taskResult = extractLatestAssistantText(messages);
        if (!taskResult) {
            return null;
        }

        const finalText = stripThinkingBlocks(taskResult);
        return finalText.length > 0 ? finalText : null;
    } catch (error) {
        if (deps.sessionId) {
            sessionLog(deps.sessionId, "sidekick failed:", error);
        } else {
            log("[magic-context] sidekick failed:", error);
        }
        return null;
    } finally {
        if (agentSessionId) {
            await deps.client.session
                .delete({
                    path: { id: agentSessionId },
                    query: { directory: deps.sessionDirectory ?? deps.projectPath },
                })
                .catch((error: unknown) => {
                    log("[magic-context] failed to delete sidekick child session:", error);
                });
        }
    }
}
