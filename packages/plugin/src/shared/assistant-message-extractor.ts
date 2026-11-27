type MessageTime = { created?: number };

type MessageInfo = {
    role?: string;
    time?: MessageTime;
    error?: unknown;
    finish?: string;
};

type MessagePart = {
    type?: string;
    text?: string;
};

type SessionMessage = {
    info?: MessageInfo;
    parts?: unknown;
};

export interface AssistantFailure {
    error: unknown;
    finish: string | null;
}

import { isRecord } from "./record-type-guard";

function asSessionMessage(value: unknown): SessionMessage | null {
    if (!isRecord(value)) return null;
    const info = value.info;
    const parts = value.parts;
    return {
        info: isRecord(info)
            ? {
                  role: typeof info.role === "string" ? info.role : undefined,
                  time: isRecord(info.time)
                      ? {
                            created:
                                typeof info.time.created === "number"
                                    ? info.time.created
                                    : undefined,
                        }
                      : undefined,
                  error: info.error,
                  finish:
                      typeof info.finish === "string"
                          ? info.finish
                          : typeof info.finish_reason === "string"
                            ? info.finish_reason
                            : typeof info.finishReason === "string"
                              ? info.finishReason
                              : undefined,
              }
            : undefined,
        parts,
    };
}

function getCreatedTime(message: SessionMessage): number {
    return message.info?.time?.created ?? 0;
}

function getTextParts(message: SessionMessage): MessagePart[] {
    if (!Array.isArray(message.parts)) return [];
    return message.parts
        .filter((part): part is Record<string, unknown> => isRecord(part))
        .map((part) => ({
            type: typeof part.type === "string" ? part.type : undefined,
            text: typeof part.text === "string" ? part.text : undefined,
        }))
        .filter((part) => part.type === "text" && Boolean(part.text));
}

function getLatestAssistantMessage(messages: unknown): SessionMessage | null {
    if (!Array.isArray(messages) || messages.length === 0) return null;

    return (
        messages
            .map(asSessionMessage)
            .filter((message): message is SessionMessage => message !== null)
            .filter((message) => message.info?.role === "assistant")
            .sort((a, b) => getCreatedTime(b) - getCreatedTime(a))[0] ?? null
    );
}

export function extractLatestAssistantText(messages: unknown): string | null {
    const latest = getLatestAssistantMessage(messages);
    if (!latest) return null;

    return (
        getTextParts(latest)
            .map((part) => part.text)
            .join("\n") || null
    );
}

/** Return an error persisted on the newest assistant row, including its settlement reason. */
export function extractLatestAssistantFailure(messages: unknown): AssistantFailure | null {
    const latest = getLatestAssistantMessage(messages);
    if (!latest || latest.info?.error === undefined || latest.info.error === null) return null;
    return {
        error: latest.info.error,
        finish: latest.info.finish ?? null,
    };
}

export function hasLengthCappedOutput(value: unknown): boolean {
    if (Array.isArray(value)) return value.some((item) => hasLengthCappedOutput(item));
    if (!isRecord(value)) return false;

    if (value.length_capped === true || value.lengthCapped === true) return true;
    const finishReason =
        value.finish_reason ??
        value.finishReason ??
        value.finish ??
        (value.type === "step-finish" ? value.reason : undefined) ??
        value.stopReason;
    if (typeof finishReason === "string") {
        const normalized = finishReason.toLowerCase();
        if (
            normalized === "length" ||
            normalized === "max_tokens" ||
            normalized === "max_output_tokens"
        ) {
            return true;
        }
    }

    return Object.values(value).some((item) => hasLengthCappedOutput(item));
}

/** A reused child may still have a capped answer from an earlier turn or model. */
export function isLatestAssistantLengthCapped(messages: unknown): boolean {
    const latest = getLatestAssistantMessage(messages);
    return (
        hasLengthCappedOutput(latest?.info?.finish ? { finish: latest.info.finish } : null) ||
        (Array.isArray(latest?.parts) &&
            latest.parts.some(
                (part) =>
                    isRecord(part) && part.type === "step-finish" && hasLengthCappedOutput(part),
            ))
    );
}

/** Settlement metadata for diagnostics, never private reasoning as task output. */
export function describeAssistantSettlement(output: unknown): string {
    if (isRecord(output) && isRecord(output.tokenLog)) {
        return `finish=${String(output.tokenLog.finish_reason ?? "unknown")}, reasoning=${typeof output.reasoning === "string" && output.reasoning.length > 0}`;
    }
    const latest = getLatestAssistantMessage(output);
    const parts = Array.isArray(latest?.parts) ? latest.parts.filter(isRecord) : [];
    return `finish=${latest?.info?.finish ?? "unknown"}, reasoning=${parts.some((part) => part.type === "reasoning")}, tools=${parts.filter((part) => part.type === "tool").length}`;
}

/** Describe persisted host/provider errors without losing structured status or message fields. */
export function describeAssistantError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (!isRecord(error)) return String(error);
    const data = isRecord(error.data) ? error.data : error;
    const message = typeof data.message === "string" ? data.message : undefined;
    const status = data.statusCode ?? data.status;
    const name =
        typeof error.name === "string"
            ? error.name
            : typeof error.type === "string"
              ? error.type
              : undefined;
    const description = [name, message].filter(Boolean).join(": ") || JSON.stringify(error);
    return status === undefined ? description : `${description} (status=${String(status)})`;
}
