import { SIDEKICK_AGENT } from "../../../agents/sidekick";
import type { SidekickConfig } from "../../../config/schema/magic-context";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { log, sessionLog } from "../../../shared/logger";
import { SIDEKICK_SYSTEM_PROMPT, stripThinkingBlocks } from "./core";

// Re-export the system prompt so existing call sites that import from this
// module keep working. The canonical location is now `./core` so the
// pi-plugin can pull it without depending on OpenCode-specific imports.
export { SIDEKICK_SYSTEM_PROMPT };

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
