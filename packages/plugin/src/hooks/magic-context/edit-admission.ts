import { isRecord } from "../../shared/record-type-guard";

export type EditCoord =
    | { kind: "prefix" }
    | { kind: "message"; id: string | undefined; block: number | "whole" }
    | { kind: "append"; afterId: string | undefined };

export type Frame =
    | { kind: "none" }
    | {
          kind: "boundary";
          messageId: string | undefined;
          anchor: string | undefined;
          tail: ReadonlySet<string>;
      };

export interface EditAdmission {
    readonly frame: Frame;
    /** Pure query: a hold neither spends a trigger nor creates a release obligation. */
    admit(coord: EditCoord): boolean;
}

/** Positional Pi fallbacks and transcript carriers are not stable served-message coordinates. */
export function admissionStableId(id: string | undefined): string | undefined {
    return id && !id.startsWith("pi-msg-") && !id.startsWith("synth-user-") ? id : undefined;
}

/** Normalize the signed and redacted representations without reading redacted bytes as text. */
export function thinkingAnchor(part: unknown): string | undefined {
    if (!isRecord(part)) return undefined;
    const anthropic =
        isRecord(part.metadata) && isRecord(part.metadata.anthropic) ? part.metadata.anthropic : {};
    const redacted =
        part.redacted === true ||
        ["redacted_thinking", "redacted_reasoning"].includes(String(part.type));
    const value = redacted
        ? (part.data ?? anthropic.redactedData ?? part.thinkingSignature ?? part.thinking)
        : (anthropic.signature ?? part.signature ?? part.thinkingSignature);
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The real-user rule shared with active-turn protection, evaluated on one message, not a rescan. */
export function isAdmissionUser(message: unknown): boolean {
    if (!isRecord(message)) return false;
    const info = isRecord(message.info) ? message.info : message;
    if (info.role !== "user" || info.synthetic === true || message.synthetic === true) return false;
    if (String(info.id ?? "").startsWith("synth-user-")) return false;
    const parts = Array.isArray(message.parts)
        ? message.parts
        : Array.isArray(message.content)
          ? message.content
          : [];
    return (
        !parts.length ||
        !parts.every(
            (p) =>
                isRecord(p) &&
                (p.synthetic === true ||
                    p.ignored === true ||
                    ["tool_result", "toolResult", "tool-result"].includes(String(p.type))),
        )
    );
}

/**
 * Build once on the host's replay view. The caller reproduces persisted omissions on copies
 * and supplies the existing retained-thinking predicate; admission does not move replay.
 */
export function createEditAdmission<M>(args: {
    messages: readonly M[];
    stableId: (message: M, index: number) => string | undefined;
    partsOf: (message: M) => readonly unknown[];
    isRealUser: (message: M) => boolean;
    prefixBound: boolean;
    isRetainedThinking: (message: M, part: unknown) => boolean;
    anchorOf: (part: unknown) => string | undefined;
    onUnresolved?: (reason: "message-id" | "anchor") => void;
}): EditAdmission {
    let frame: Frame = { kind: "none" };
    let boundaryParts: readonly unknown[] = [];
    const tail = new Set<string>();
    for (let i = args.messages.length - 1; i >= 0; i--) {
        const message = args.messages[i];
        if (args.isRealUser(message)) break;
        const parts = args.partsOf(message);
        let last = -1;
        for (let p = parts.length - 1; p >= 0; p--) {
            if (args.isRetainedThinking(message, parts[p])) {
                last = p;
                break;
            }
        }
        const id = admissionStableId(args.stableId(message, i));
        if (last >= 0) {
            const anchor = args.anchorOf(parts[last]);
            frame = { kind: "boundary", messageId: id, anchor, tail };
            boundaryParts = parts;
            if (!id) args.onUnresolved?.("message-id");
            if (!anchor) args.onUnresolved?.("anchor");
            break;
        }
        if (id) tail.add(id);
    }
    return {
        frame,
        admit(coord) {
            if (!args.prefixBound || frame.kind === "none") return true;
            if (coord.kind === "prefix") return false;
            const id = admissionStableId(coord.kind === "append" ? coord.afterId : coord.id);
            if (!id) return false;
            if (frame.tail.has(id)) return true;
            if (id !== frame.messageId) return false;
            if (coord.kind === "append") return true;
            if (coord.block === "whole" || !frame.anchor) return false;
            for (let p = boundaryParts.length - 1; p >= 0; p--) {
                if (args.anchorOf(boundaryParts[p]) === frame.anchor) return coord.block > p;
            }
            return false;
        },
    };
}

/** Folded transcript rows and parallel tool batches touch all sources, never the result alone. */
export function admitCompound(admission: EditAdmission, sources: readonly EditCoord[]): boolean {
    return sources.length > 0 && sources.every((coord) => admission.admit(coord));
}
