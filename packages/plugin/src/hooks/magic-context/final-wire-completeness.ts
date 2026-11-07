import { sessionLog } from "../../shared/logger";
import type { MessageLike } from "./transform-operations";

/** Field names only: never return the value of an uncounted provider part. */
export function incompleteWirePartFields(part: unknown): string[] {
    if (!part || typeof part !== "object") return ["part"];
    const p = part as Record<string, unknown>;
    if (p.ignored === true) return [];
    const missing = (present: boolean, field: string) => (present ? [] : [field]);
    switch (p.type) {
        case "text":
        case "reasoning":
            return missing(typeof p.text === "string", "text");
        case "thinking":
            return missing(typeof p.thinking === "string", "thinking");
        case "redacted_thinking":
            return missing(typeof p.data === "string", "data");
        case "tool": {
            const state =
                p.state !== null && typeof p.state === "object"
                    ? (p.state as Record<string, unknown>)
                    : undefined;
            const input =
                state?.input !== undefined || p.input !== undefined || p.args !== undefined;
            const result =
                state?.output !== undefined ||
                state?.content !== undefined ||
                state?.error !== undefined ||
                p.output !== undefined ||
                p.result !== undefined ||
                p.content !== undefined;
            return [...missing(input, "input"), ...missing(result, "result")];
        }
        case "tool-call":
        case "tool_use":
            return missing(p.input !== undefined || p.args !== undefined, "input");
        case "tool-invocation":
            return [
                ...missing(p.args !== undefined || p.input !== undefined, "input"),
                ...missing(
                    p.result !== undefined ||
                        p.output !== undefined ||
                        (p.state !== null && typeof p.state === "object"),
                    "result",
                ),
            ];
        case "tool-result":
        case "tool_result":
            return missing(
                p.result !== undefined || p.content !== undefined || p.output !== undefined,
                "result",
            );
        case "step-start":
        case "step-finish":
            return [];
        // Inline images have a bounded pixel-based estimate; other attachments do not.
        case "file":
            return missing(
                typeof p.url === "string" && p.url.startsWith("data:image/"),
                "url (data:image/)",
            );
        default:
            return ["supported type"];
    }
}

function label(value: unknown): string | null {
    return typeof value === "string" ? value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128) : null;
}

export function incompleteWireParts(messages: readonly MessageLike[]) {
    return messages.flatMap((message) =>
        message.parts.flatMap((part, partIndex) => {
            const missingFields = incompleteWirePartFields(part);
            if (!missingFields.length) return [];
            const p =
                part && typeof part === "object" ? (part as Record<string, unknown>) : undefined;
            return [
                {
                    messageId: label(message.info.id),
                    partId: label(p?.id),
                    partIndex,
                    type: label(p?.type) ?? "unknown",
                    missingFields,
                },
            ];
        }),
    );
}

/** A new logger belongs to one transform pass, even when the pass estimates twice. */
export function createFinalWireIncompleteLogger(sessionID: string) {
    let logged = false;
    return (estimate: { trusted: boolean } | undefined, messages: readonly MessageLike[]): void => {
        if (logged || estimate?.trusted) return;
        logged = true;
        sessionLog(
            sessionID,
            `transform: final-wire untrusted incompleteParts=${JSON.stringify(incompleteWireParts(messages))}`,
        );
    };
}
