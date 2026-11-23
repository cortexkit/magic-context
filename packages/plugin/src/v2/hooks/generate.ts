import { createHash } from "node:crypto";
import { sessionLog } from "../../shared/logger";
import { clonePreservingInstances, clonePreservingInstancesMeasured } from "./payload";
import type { SessionContext, V2Message } from "./types";

interface GenerateReplayAnchor {
    id: string;
    prefixDigest: string;
    tail: V2Message[];
}

// The intrinsic name is the same for a typed array subclass and its structured clone.
const typedArrayName = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    Symbol.toStringTag,
)?.get;

function hostPrefixDigest(messages: V2Message[], end: number): string {
    const hash = createHash("sha256");
    const header = Buffer.allocUnsafe(9);
    const number = Buffer.allocUnsafe(8);
    // Each value starts with its type and either a payload length or a child count.
    const mark = (type: string, length = 0): void => {
        header[0] = type.charCodeAt(0);
        header.writeDoubleLE(length, 1);
        hash.update(header);
    };
    const text = (type: string, value: string): void => {
        mark(type, value.length * 2);
        // Hash the original code units; UTF-8 would equate distinct lone surrogates.
        hash.update(value, "utf16le");
    };
    const visit = (value: unknown): void => {
        if (typeof value === "string") {
            text("s", value);
        } else if (typeof value === "number") {
            mark("n", number.length);
            number.writeDoubleLE(value);
            hash.update(number);
        } else if (typeof value === "boolean") {
            mark(value ? "t" : "f");
        } else if (value === null) {
            mark("0");
        } else if (value === undefined) {
            mark("u");
        } else if (ArrayBuffer.isView(value)) {
            mark("v", value.byteLength);
            text("s", typedArrayName?.call(value) ?? "DataView");
            hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        } else if (value instanceof ArrayBuffer) {
            mark("b", value.byteLength);
            hash.update(new Uint8Array(value));
        } else if (Array.isArray(value)) {
            mark("a", value.length);
            for (let index = 0; index < value.length; index++) {
                if (Object.hasOwn(value, index)) visit(value[index]);
                else mark("h");
            }
        } else if (typeof value === "object") {
            const entries = Object.entries(value);
            mark("o", entries.length);
            for (const [key, child] of entries) {
                text("s", key);
                visit(child);
            }
        } else if (typeof value === "bigint") {
            text("i", value.toString());
        } else {
            // Functions and symbols are not wire content. Record their presence, not their identity.
            mark(typeof value === "function" ? "x" : "y");
        }
    };
    mark("a", end);
    for (let index = 0; index < end; index++) visit(messages[index]);
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
        prefixDigest: hostPrefixDigest(messages, index),
        tail: clonePreservingInstances(messages.slice(index + 1)),
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
        const end = index + 1 + prefix.anchor.tail.length;
        // Count alone can consume a new side question after a checkpoint removed
        // tool results. Match the original host tail, not its managed replacement.
        if (
            JSON.stringify(draft.messages.slice(index + 1, end)) !==
            JSON.stringify(prefix.anchor.tail)
        )
            return skip("anchor-tail-mismatch");
        // Edit and revert events also discard the saved prefix, but a generate
        // request can race a late event or follow an edit whose event never reached us.
        if (hostPrefixDigest(draft.messages, index) !== prefix.anchor.prefixDigest)
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
