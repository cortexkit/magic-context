import type { openDatabase } from "../../features/magic-context/storage";
import type { PluginContext } from "../types";

type TagLookupRow = { message_id?: string; type?: string } | null;
type SessionPart = {
    type?: string;
    text?: string;
    callID?: string;
    state?: { output?: string };
};
type SessionMessageData = { info?: { id?: string }; parts?: SessionPart[] };

function parseMessagePartTag(messageId: string): { messageId: string; partIndex: number | null } {
    const match = /^(.*):(?:p|file)(\d+)$/.exec(messageId);
    if (!match) {
        return { messageId, partIndex: null };
    }

    return { messageId: match[1], partIndex: Number.parseInt(match[2], 10) };
}

function getTextFromMessage(message: SessionMessageData, partIndex: number | null): string | null {
    if (!message.parts) return null;

    if (partIndex !== null) {
        const part = message.parts[partIndex];
        if (part?.type === "text" && typeof part.text === "string") {
            const text = part.text.trim();
            return text.length > 0 ? text : null;
        }
    }

    const text = message.parts
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n")
        .trim();

    return text.length > 0 ? text : null;
}

export function createTagContentResolver(ctx: PluginContext, db: ReturnType<typeof openDatabase>) {
    const messageCache = new Map<string, { messages: SessionMessageData[]; updatedAt: number }>();
    const CACHE_TTL_MS = 30_000;

    const clearCache = (sessionId?: string): void => {
        if (sessionId) {
            messageCache.delete(sessionId);
            return;
        }
        messageCache.clear();
    };

    const getSessionMessages = async (
        sessionId: string,
        skipCache = false,
    ): Promise<SessionMessageData[]> => {
        const cached = messageCache.get(sessionId);
        if (!skipCache && cached && Date.now() - cached.updatedAt <= CACHE_TTL_MS) {
            return cached.messages;
        }

        const response = await ctx.client.session
            .messages({
                path: { id: sessionId },
                query: { directory: ctx.directory },
            })
            .catch(() => null);

        const normalized =
            response && typeof response === "object" && "data" in response
                ? (response as { data?: unknown }).data
                : response;
        const messages = Array.isArray(normalized) ? (normalized as SessionMessageData[]) : [];
        messageCache.set(sessionId, { messages, updatedAt: Date.now() });
        return messages;
    };

    const resolveTagContent = async (
        sessionId: string,
        tagId: number,
        skipCache = false,
    ): Promise<string | null> => {
        const tagRow = db
            .prepare("SELECT message_id, type FROM tags WHERE session_id = ? AND tag_number = ?")
            .get(sessionId, tagId) as TagLookupRow;
        if (!tagRow?.message_id || !tagRow.type) {
            return null;
        }

        const messages = await getSessionMessages(sessionId, skipCache);

        if (tagRow.type === "tool") {
            for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
                const parts = messages[messageIndex]?.parts ?? [];
                for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
                    const part = parts[partIndex];
                    if (
                        part?.type === "tool" &&
                        part.callID === tagRow.message_id &&
                        typeof part.state?.output === "string"
                    ) {
                        const output = part.state.output.trim();
                        return output.length > 0 ? output : null;
                    }
                }
            }
            return null;
        }

        const parsed = parseMessagePartTag(tagRow.message_id);
        const message = messages.find((entry) => entry.info?.id === parsed.messageId);
        return message ? getTextFromMessage(message, parsed.partIndex) : null;
    };

    return { resolveTagContent, clearCache };
}
