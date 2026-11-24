import { createHash } from "node:crypto";
import { sessionLog } from "../../shared/logger";
import { clonePreservingInstances, clonePreservingInstancesMeasured } from "./payload";
import type { SessionContext, V2Message } from "./types";

interface GenerateReplayAnchor {
    id: string;
    prefixDigest: string;
    tailCount: number;
}

// The built-in typed-array tag getter gives a typed-array subclass and its structured
// clone the same name (for example "Uint8Array"), so a host class and its clone match.
const typedArrayName = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    Symbol.toStringTag,
)?.get;

function hostPrefixDigest(messages: V2Message[], end: number): string {
    const hash = createHash("sha256");
    const chunks: string[] = [];
    let pendingCodeUnits = 0;
    const batchCodeUnits = 16 * 1024 * 1024;
    const flush = () => {
        if (chunks.length === 0) return;
        // Hash the original code units; UTF-8 merges distinct lone surrogates.
        hash.update(chunks.join(""), "utf16le");
        chunks.length = 0;
        pendingCodeUnits = 0;
    };
    const append = (chunk: string): void => {
        if (pendingCodeUnits + chunk.length > batchCodeUnits) flush();
        if (chunk.length > batchCodeUnits) hash.update(chunk, "utf16le");
        else {
            chunks.push(chunk);
            pendingCodeUnits += chunk.length;
        }
    };
    const text = (type: string, value: string): void => {
        append(`${type}${value.length}:`);
        append(value);
    };
    const binary = (value: Uint8Array): void => {
        append(`b${value.byteLength}:`);
        flush();
        hash.update(value);
    };
    const visit = (value: unknown): void => {
        if (typeof value === "string") {
            text("s", value);
        } else if (typeof value === "number") {
            text("n", Object.is(value, -0) ? "-0" : String(value));
        } else if (typeof value === "boolean") {
            append(value ? "t" : "f");
        } else if (value === null) {
            append("0");
        } else if (value === undefined) {
            append("u");
        } else if (ArrayBuffer.isView(value)) {
            text("v", typedArrayName?.call(value) ?? "DataView");
            binary(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        } else if (value instanceof ArrayBuffer) {
            binary(new Uint8Array(value));
        } else if (Array.isArray(value)) {
            append("[");
            for (let index = 0; index < value.length; index++) {
                if (Object.hasOwn(value, index)) visit(value[index]);
                else append("h");
            }
            append("]");
        } else if (typeof value === "object") {
            append("{");
            for (const key in value) {
                if (!Object.hasOwn(value, key)) continue;
                text("s", key);
                visit((value as Record<string, unknown>)[key]);
            }
            append("}");
        } else if (typeof value === "bigint") {
            text("i", value.toString());
        } else {
            // Functions and symbols are not wire content. Record their presence, not their identity.
            append(typeof value === "function" ? "x" : "y");
        }
    };
    for (let index = 0; index < end; index++) {
        if (Object.hasOwn(messages, index)) visit(messages[index]);
        else append("h");
    }
    // Batch one length-framed serialization, passing binary data directly and
    // bounding the temporary string even for very large histories.
    flush();
    return hash.digest("hex");
}

/** Preserve the host boundary before Magic Context tags or drops tool results. */
export function generateReplayAnchor(messages: V2Message[]): GenerateReplayAnchor | undefined {
    let index = messages.length - 1;
    while (index >= 0 && !messages[index]?.id) index--;
    if (index < 0) return undefined;
    const id = messages.at(index)?.id;
    if (!id) return undefined;
    return {
        id,
        prefixDigest: hostPrefixDigest(messages, messages.length),
        tailCount: messages.length - index - 1,
    };
}

interface ServedPrefix {
    anchor: GenerateReplayAnchor;
    model: string;
    agent: string;
    system: SessionContext["system"];
    messages: V2Message[];
    tools: SessionContext["tools"];
    /** Estimated heap this copy keeps alive; see {@link clonePreservingInstancesMeasured}. */
    bytes: number;
}

export interface GenerateReplayLimits {
    /** Most sessions kept; the least recently captured or replayed one goes first. */
    maxSessions: number;
    /** A session whose served request is estimated above this is not kept at all. */
    sessionMaxBytes: number;
    /** Ceiling on the estimate summed over every kept session. */
    totalMaxBytes: number;
}

/**
 * Each kept session holds a copy of its whole served request. Measured on a synthetic
 * 6,000-message session with about 10 MB of text, the estimate is about 21 MiB and the
 * heap actually kept about 12 MiB (the runtime stores most text one byte per character).
 * The per-session cap fits sessions several times that size, and the total fits two
 * sessions at the cap or around ten sessions of that measured size, so a few long
 * sessions in use together do not evict each other on every turn. The figures match the
 * shared last-good-request entry cache (`LKG_ENTRY_CACHE_*`).
 */
export const DEFAULT_GENERATE_REPLAY_LIMITS: Readonly<GenerateReplayLimits> = Object.freeze({
    maxSessions: 16,
    sessionMaxBytes: 128 * 1024 * 1024,
    totalMaxBytes: 256 * 1024 * 1024,
});

/** OpenCode's /btw requests reuse the last main request's system and history.
 * They never run the turn transform, which executes drops and advances counters.
 *
 * Kept requests are bounded by {@link GenerateReplayLimits}. A session without a kept
 * request (evicted, over the per-session cap, or never captured since the process
 * started) gets no replay: `apply` leaves the host's request exactly as the host built
 * it, the same as on a cold start, rather than reusing an older served request. */
export class V2GenerateReplay {
    /** In least-recently-used order: the first entry is evicted first. */
    private readonly prefixes = new Map<string, ServedPrefix>();
    private totalBytes = 0;
    private readonly limits: Readonly<GenerateReplayLimits>;

    constructor(limits: GenerateReplayLimits = DEFAULT_GENERATE_REPLAY_LIMITS) {
        if (
            !Number.isSafeInteger(limits.maxSessions) ||
            limits.maxSessions < 1 ||
            !Number.isSafeInteger(limits.sessionMaxBytes) ||
            limits.sessionMaxBytes < 1 ||
            !Number.isSafeInteger(limits.totalMaxBytes) ||
            limits.totalMaxBytes < 1
        )
            throw new Error("Generate replay limits must be positive integers");
        this.limits = { ...limits };
    }

    capture(draft: SessionContext, anchor: GenerateReplayAnchor | undefined): void {
        // Drop the previous request first: if this one is not kept, a later replay
        // must find nothing rather than the older request.
        this.forget(draft.sessionID);
        if (!anchor) {
            sessionLog(draft.sessionID, "generate replay capture skipped: no-anchor");
            return;
        }
        const parts = {
            anchor: clonePreservingInstancesMeasured(anchor),
            system: clonePreservingInstancesMeasured(draft.system),
            messages: clonePreservingInstancesMeasured(draft.messages),
            tools: clonePreservingInstancesMeasured(draft.tools),
        };
        const bytes =
            256 +
            parts.anchor.bytes +
            parts.system.bytes +
            parts.messages.bytes +
            parts.tools.bytes;
        if (bytes > this.limits.sessionMaxBytes || bytes > this.limits.totalMaxBytes) {
            sessionLog(
                draft.sessionID,
                `generate replay capture skipped: over-session-cap (${bytes} > ${Math.min(this.limits.sessionMaxBytes, this.limits.totalMaxBytes)} bytes)`,
            );
            return;
        }
        while (
            this.prefixes.size > 0 &&
            (this.prefixes.size >= this.limits.maxSessions ||
                this.totalBytes + bytes > this.limits.totalMaxBytes)
        ) {
            const oldest = this.prefixes.keys().next().value;
            if (oldest === undefined) break;
            this.forget(oldest);
        }
        this.prefixes.set(draft.sessionID, {
            anchor: parts.anchor.copy,
            model: `${draft.model.providerID}/${draft.model.id}`,
            agent: draft.agent,
            system: parts.system.copy,
            messages: parts.messages.copy,
            tools: parts.tools.copy,
            bytes,
        });
        this.totalBytes += bytes;
    }

    forget(sessionID: string): void {
        const prefix = this.prefixes.get(sessionID);
        if (!prefix) return;
        this.prefixes.delete(sessionID);
        this.totalBytes -= prefix.bytes;
    }

    /** Kept sessions and their estimated bytes, for debug memory diagnostics. */
    stats(): { totalBytes: number; sessions: Array<{ sessionId: string; bytes: number }> } {
        return {
            totalBytes: this.totalBytes,
            sessions: [...this.prefixes].map(([sessionId, prefix]) => ({
                sessionId,
                bytes: prefix.bytes,
            })),
        };
    }

    apply(draft: SessionContext): boolean {
        const prefix = this.prefixes.get(draft.sessionID);
        const skip = (reason: string): false => {
            sessionLog(draft.sessionID, `generate replay apply skipped: ${reason}`);
            return false;
        };
        if (!prefix) return skip("no-prefix");
        // A replayed session is in use again; keep it over idle sessions.
        this.prefixes.delete(draft.sessionID);
        this.prefixes.set(draft.sessionID, prefix);
        if (prefix.model !== `${draft.model.providerID}/${draft.model.id}`)
            return skip("model-mismatch");
        if (prefix.agent !== draft.agent) return skip("agent-mismatch");
        // Host checkpoints can remove the anchor. Without it we cannot distinguish
        // already-served history from the live tail, so leave the request alone.
        const index = draft.messages.findIndex((message) => message.id === prefix.anchor.id);
        if (index < 0) return skip("anchor-not-found");
        const end = index + 1 + prefix.anchor.tailCount;
        // Count alone can consume a new side question after a checkpoint removed
        // tool results. Match the original host tail, not its managed replacement.
        if (draft.messages.length < end) return skip("anchor-tail-mismatch");
        // Edit and revert events also discard the saved prefix, but a generate
        // request can race a late event or follow an edit whose event never reached us.
        if (hostPrefixDigest(draft.messages, end) !== prefix.anchor.prefixDigest)
            return skip("history-mismatch");
        const tail = draft.messages.slice(end);
        draft.messages.splice(
            0,
            draft.messages.length,
            ...clonePreservingInstances(prefix.messages),
            ...tail,
        );
        draft.system.splice(0, draft.system.length, ...clonePreservingInstances(prefix.system));
        // Tool definitions precede history in some provider cache keys. Reuse the
        // descriptions served by the main hook rather than the host's raw tools.
        draft.tools = clonePreservingInstances(prefix.tools);
        return true;
    }
}
