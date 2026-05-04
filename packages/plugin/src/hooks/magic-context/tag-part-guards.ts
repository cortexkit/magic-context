import { stripTagPrefix } from "./tag-content-primitives";

export { stripTagPrefix };

export interface ValidTextPart {
    type: string;
    text: string;
}

export interface ValidToolPart {
    type: string;
    callID: string;
    state: { output: string; input?: Record<string, unknown> };
}

interface ValidFilePart {
    type: string;
    url: string;
}

export function isTextPart(part: unknown): part is ValidTextPart {
    if (part === null || typeof part !== "object") return false;
    const p = part as Record<string, unknown>;
    return p.type === "text" && typeof p.text === "string";
}

export function isToolPartWithOutput(part: unknown): part is ValidToolPart {
    if (part === null || typeof part !== "object") return false;
    const p = part as Record<string, unknown>;
    if (p.type !== "tool" || typeof p.callID !== "string") return false;
    if (p.state === null || typeof p.state !== "object") return false;
    return typeof (p.state as Record<string, unknown>).output === "string";
}

export function isFilePart(part: unknown): part is ValidFilePart {
    if (part === null || typeof part !== "object") return false;
    const p = part as Record<string, unknown>;
    return p.type === "file" && typeof p.url === "string";
}

export function buildFileSourceContent(parts: unknown[]): string | null {
    const content = parts
        .filter(isTextPart)
        .map((part) => stripTagPrefix(part.text))
        .join("\n")
        .trim();

    return content.length > 0 ? content : null;
}
