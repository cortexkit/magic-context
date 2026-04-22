import { isRecord } from "../../shared/record-type-guard";

export type MagicContextEventType =
    | "session.created"
    | "session.error"
    | "message.updated"
    | "message.removed"
    | "session.compacted"
    | "session.deleted";

export type MagicContextEvent = {
    type: MagicContextEventType;
    properties?: unknown;
};

export interface SessionCreatedInfo {
    id: string;
    parentID: string;
    providerID?: string;
    modelID?: string;
}

export interface MessageUpdatedAssistantInfo {
    role: "assistant";
    finish?: string;
    sessionID: string;
    /** OpenCode assistant message id. Undefined only when the event payload
     *  doesn't include one (older SDK versions or malformed events). */
    messageID?: string;
    providerID?: string;
    modelID?: string;
    tokens?: {
        input?: number;
        cache?: {
            read?: number;
            write?: number;
        };
    };
    /** Error attached to the assistant message, if any. OpenCode attaches
     *  context-overflow errors here in addition to emitting session.error. */
    error?: unknown;
}

export interface SessionErrorInfo {
    sessionID: string;
    error: unknown;
}

export interface MessageRemovedInfo {
    sessionID: string;
    messageID: string;
}

export function getSessionProperties(
    properties: unknown,
): { info?: unknown; sessionID?: string } | undefined {
    if (!isRecord(properties)) {
        return undefined;
    }

    const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : undefined;
    return {
        info: properties.info,
        sessionID,
    };
}

export function getSessionCreatedInfo(properties: unknown): SessionCreatedInfo | null {
    const eventProps = getSessionProperties(properties);
    if (!eventProps || !isRecord(eventProps.info)) {
        return null;
    }

    const info = eventProps.info;
    if (typeof info.id !== "string" || typeof info.parentID !== "string") {
        return null;
    }

    return {
        id: info.id,
        parentID: info.parentID,
        providerID: typeof info.providerID === "string" ? info.providerID : undefined,
        modelID: typeof info.modelID === "string" ? info.modelID : undefined,
    };
}

export function getMessageUpdatedAssistantInfo(
    properties: unknown,
): MessageUpdatedAssistantInfo | null {
    const eventProps = getSessionProperties(properties);
    if (!eventProps || !isRecord(eventProps.info)) {
        return null;
    }

    const info = eventProps.info;
    if (info.role !== "assistant" || typeof info.sessionID !== "string") {
        return null;
    }

    const tokens = isRecord(info.tokens) ? info.tokens : undefined;
    const cache = tokens && isRecord(tokens.cache) ? tokens.cache : undefined;

    return {
        role: "assistant",
        finish: typeof info.finish === "string" ? info.finish : undefined,
        sessionID: info.sessionID,
        messageID: typeof info.id === "string" ? info.id : undefined,
        providerID: typeof info.providerID === "string" ? info.providerID : undefined,
        modelID: typeof info.modelID === "string" ? info.modelID : undefined,
        tokens: {
            input: typeof tokens?.input === "number" ? tokens.input : undefined,
            cache: {
                read: typeof cache?.read === "number" ? cache.read : undefined,
                write: typeof cache?.write === "number" ? cache.write : undefined,
            },
        },
        error: info.error !== undefined ? info.error : undefined,
    };
}

/**
 * Extract `session.error` event payload. The event carries `{ sessionID, error }`
 * at the top level (no `info` wrapper). We intentionally keep `error` as
 * `unknown` — the plugin does not depend on OpenCode's NamedError shape, the
 * overflow detector accepts strings, Errors, or objects with `message`.
 */
export function getSessionErrorInfo(properties: unknown): SessionErrorInfo | null {
    if (!isRecord(properties)) return null;
    const sessionID = properties.sessionID;
    if (typeof sessionID !== "string" || sessionID.length === 0) return null;
    // Error may be absent on certain error shapes (SDK variant); treat as unknown.
    return { sessionID, error: properties.error };
}

export function getMessageRemovedInfo(properties: unknown): MessageRemovedInfo | null {
    if (!isRecord(properties)) {
        return null;
    }

    if (typeof properties.sessionID !== "string" || typeof properties.messageID !== "string") {
        return null;
    }

    return {
        sessionID: properties.sessionID,
        messageID: properties.messageID,
    };
}
