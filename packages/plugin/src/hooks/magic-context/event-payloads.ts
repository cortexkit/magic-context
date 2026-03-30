import { isRecord } from "../../shared/record-type-guard";

export type MagicContextEventType =
    | "session.created"
    | "message.updated"
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
    providerID?: string;
    modelID?: string;
    tokens?: {
        input?: number;
        cache?: {
            read?: number;
            write?: number;
        };
    };
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
        providerID: typeof info.providerID === "string" ? info.providerID : undefined,
        modelID: typeof info.modelID === "string" ? info.modelID : undefined,
        tokens: {
            input: typeof tokens?.input === "number" ? tokens.input : undefined,
            cache: {
                read: typeof cache?.read === "number" ? cache.read : undefined,
                write: typeof cache?.write === "number" ? cache.write : undefined,
            },
        },
    };
}
