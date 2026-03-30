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

export async function sendIgnoredMessage(
    client: unknown,
    sessionId: string,
    text: string,
    params: NotificationParams,
): Promise<void> {
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
