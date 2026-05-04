import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";

export interface NotificationParams {
    agent?: string;
    variant?: string;
    providerId?: string;
    modelId?: string;
}

interface NotificationClient {
    session?: {
        prompt?: (opts: unknown) => unknown | Promise<unknown>;
        promptAsync?: (opts: unknown) => Promise<unknown>;
    };
}

function hasNotificationSessionClient(client: unknown): client is NotificationClient {
    if (client === null || typeof client !== "object") return false;
    const candidate = client as Record<string, unknown>;
    if (candidate.session === undefined) return true;
    if (candidate.session === null || typeof candidate.session !== "object") return false;
    const session = candidate.session as Record<string, unknown>;
    return (
        (session.prompt === undefined || typeof session.prompt === "function") &&
        (session.promptAsync === undefined || typeof session.promptAsync === "function")
    );
}

/**
 * Map notification text to a TUI toast variant based on content heuristics.
 */
function inferToastVariant(text: string): "success" | "error" | "warning" | "info" {
    const lower = text.toLowerCase();
    if (lower.includes("error") || lower.includes("failed") || lower.includes("alert"))
        return "error";
    if (lower.includes("warning") || lower.includes("⚠")) return "warning";
    if (
        lower.includes("complete") ||
        lower.includes("success") ||
        lower.includes("✓") ||
        lower.includes("finished")
    )
        return "success";
    return "info";
}

/**
 * Extract a short title from notification text (first line or first sentence).
 */
function extractToastTitle(text: string): string {
    // Use first markdown heading if present
    const headingMatch = text.match(/^#+\s+(.+)/m);
    if (headingMatch) return headingMatch[1].trim();
    // Use first line if short enough
    const firstLine = text.split("\n")[0].trim();
    if (firstLine.length <= 80) return firstLine;
    return "Magic Context";
}

export async function sendIgnoredMessage(
    client: unknown,
    sessionId: string,
    text: string,
    params: NotificationParams,
): Promise<void> {
    // In TUI mode, show as toast via RPC instead of ignored message.
    // Cannot use process.env.OPENCODE_CLIENT — it's undefined in the server plugin process.
    const { isTuiConnected: checkTui } = await import("../../shared/rpc-notifications");
    if (checkTui()) {
        try {
            const c = client as Record<string, unknown>;
            const tui = c?.tui as Record<string, unknown> | undefined;
            if (typeof tui?.showToast === "function") {
                // Intentional: call via property access to preserve `this` binding on the SDK client.
                // The tui object is an SDK-generated client where methods live on the prototype.
                const tuiClient = tui as Record<string, (...args: unknown[]) => Promise<unknown>>;
                await tuiClient.showToast({
                    body: {
                        title: extractToastTitle(text),
                        message: text.length > 200 ? `${text.slice(0, 200)}…` : text,
                        variant: inferToastVariant(text),
                        duration: 5000,
                    },
                });
                return;
            }
        } catch {
            // showToast failed or tui client is unavailable — fall through to ignored message.
            sessionLog(sessionId, "TUI showToast failed, falling back to ignored message");
        }
    }
    const agent = params.agent || undefined;
    const variant = params.variant || undefined;
    const model =
        params.providerId && params.modelId
            ? {
                  providerID: params.providerId,
                  modelID: params.modelId,
              }
            : undefined;

    if (!hasNotificationSessionClient(client)) {
        sessionLog(sessionId, "session prompt API unavailable for notification");
        return;
    }
    const c = client;

    const input = {
        path: { id: sessionId },
        body: {
            noReply: true,
            agent,
            model,
            variant,
            parts: [
                {
                    type: "text",
                    text,
                    ignored: true,
                },
            ],
        },
    };

    try {
        if (typeof c.session?.prompt === "function") {
            await Promise.resolve(c.session.prompt(input));
        } else if (typeof c.session?.promptAsync === "function") {
            await c.session.promptAsync(input);
        } else {
            sessionLog(sessionId, "session prompt API unavailable for notification");
        }
    } catch (error: unknown) {
        const msg = getErrorMessage(error);
        sessionLog(sessionId, "failed to send notification:", msg);
    }
}

/**
 * Send a real user prompt that will be processed by the model (not ignored).
 * Used by /ctx-aug to inject the augmented prompt after sidekick completes.
 */
export async function sendUserPrompt(
    client: unknown,
    sessionId: string,
    text: string,
): Promise<void> {
    if (!hasNotificationSessionClient(client)) {
        sessionLog(sessionId, "session prompt API unavailable for user prompt");
        return;
    }
    const c = client as NotificationClient;

    const input = {
        path: { id: sessionId },
        body: {
            parts: [{ type: "text", text }],
        },
    };

    try {
        if (typeof c.session?.promptAsync === "function") {
            await c.session.promptAsync(input);
        } else if (typeof c.session?.prompt === "function") {
            await Promise.resolve(c.session.prompt(input));
        } else {
            sessionLog(sessionId, "session prompt API unavailable for user prompt");
        }
    } catch (error: unknown) {
        const msg = getErrorMessage(error);
        sessionLog(sessionId, "failed to send user prompt:", msg);
    }
}
