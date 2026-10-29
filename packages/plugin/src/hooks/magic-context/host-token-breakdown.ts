import { createHash } from "node:crypto";
import { getHostTokenBreakdownMemo } from "../../features/magic-context/host-token-breakdown-state";
import { getSessionToolDefinitionTokens } from "../../features/magic-context/tool-definition-tokens";
import type { Database } from "../../shared/sqlite";
import { extractM0Block } from "./decay-render";
import { estimateFixedPromptTokens, hasTokenizerForFit } from "./read-session-formatting";

export const HOST_BREAKDOWN_KEY = "host_token_breakdown";
export const HOST_BREAKDOWN_VERSION = 1;
export const HOST_BREAKDOWN_TOLERANCE = { ratio: 0.01, tokens: 500 } as const;

/** Hash-keyed measurements shared with sidebar/status reads; no prompt bytes are retained. */
export class HostTokenMeasurementCache {
    private readonly counts = new Map<string, number>();
    // Probe on first measurement so imports cannot preempt the prompt's async tokenizer preload.
    private tokenizerAvailable: boolean | undefined;

    constructor(private readonly estimate = estimateFixedPromptTokens) {}

    text(text: string): number {
        return this.measure(createHash("sha256").update(text).digest("hex"), () =>
            this.estimate(text),
        );
    }

    tools(tools: readonly string[]): number {
        const hash = createHash("sha256").update(JSON.stringify(tools)).digest("hex");
        return this.measure(`tools:${hash}`, () =>
            tools.reduce((total, text) => total + this.text(text), 0),
        );
    }

    private measure(hash: string, count: () => number): number {
        const available = hasTokenizerForFit();
        if (available !== this.tokenizerAvailable) {
            this.counts.clear();
            this.tokenizerAvailable = available;
        }
        const cached = this.counts.get(hash);
        if (cached !== undefined) return cached;
        const tokens = count();
        // A tokenizer failure switches subsequent counts to the fallback estimator.
        const afterCount = hasTokenizerForFit();
        if (afterCount !== this.tokenizerAvailable) this.counts.clear();
        this.tokenizerAvailable = afterCount;
        // Bound process-wide metadata across sessions without retaining large rendered blocks.
        const oldest = this.counts.keys().next().value;
        if (this.counts.size >= 4096 && oldest !== undefined) this.counts.delete(oldest);
        this.counts.set(hash, tokens);
        return tokens;
    }
}

const measurements = new HostTokenMeasurementCache();
export const measureHostTokenText = (text: string): number => measurements.text(text);
export const measureHostToolDefinitions = (tools: readonly string[]): number =>
    measurements.tools(tools);

export interface HostTokenBreakdown {
    version: number;
    measured_at: number;
    tolerance: typeof HOST_BREAKDOWN_TOLERANCE;
    last_user_message_in_history_raw: true;
    parts: Record<string, number | null>;
}

export interface HostTokenPass {
    measuredAt: number;
    /** An executed fold or m[1] refresh, not merely a scheduler request to rebuild. */
    prefixChanged: boolean;
    conversationTokens: number;
    toolCallTokens: number;
    /** Existing OpenCode measurement: OC2's exact request set or OC1's recent route activity. */
    toolDefinitionTokens?: number;
    /** Pi reads schemas only in the deferred task, after returning its messages. */
    readToolSchemas?: () => readonly string[];
}

/** Compare to the last persisted value, not the previous pass, so small changes accumulate. */
export function hostBreakdownChanged(
    previous: HostTokenBreakdown | undefined,
    next: HostTokenBreakdown,
): boolean {
    if (previous?.version !== HOST_BREAKDOWN_VERSION) return true;
    return Object.entries(next.parts).some(([key, value]) => {
        const before = previous.parts[key];
        if (value === null || before == null) return value !== before;
        const delta = Math.abs(value - before);
        return (
            delta >
            Math.min(
                HOST_BREAKDOWN_TOLERANCE.tokens,
                Math.abs(before) * HOST_BREAKDOWN_TOLERANCE.ratio,
            )
        );
    });
}

/** Called only after a pass's existing session_meta token-accounting write succeeded. */
export function persistHostTokenBreakdown(
    db: Database,
    sessionId: string,
    pass: HostTokenPass,
): boolean {
    const memo = getHostTokenBreakdownMemo(db, sessionId);
    if (memo.previous && memo.previous.measured_at > pass.measuredAt) return false;
    memo.prefixDirty ||= pass.prefixChanged;
    if (!memo.blocks || memo.prefixDirty) {
        const cache = db
            .prepare(
                "SELECT cache_key, value FROM session_render_cache WHERE session_id = ? AND cache_key IN ('cached_m0_bytes', 'cached_m1_bytes', 'host_token_breakdown')",
            )
            .all(sessionId) as { cache_key: string; value: unknown }[];
        const text = (key: string): string => {
            const value = cache.find((row) => row.cache_key === key)?.value;
            return value instanceof Uint8Array
                ? Buffer.from(value).toString("utf8")
                : typeof value === "string"
                  ? value
                  : "";
        };
        memo.previous = undefined;
        try {
            const saved = JSON.parse(text(HOST_BREAKDOWN_KEY)) as HostTokenBreakdown;
            if (
                saved.version === HOST_BREAKDOWN_VERSION &&
                saved.parts &&
                Object.values(saved.parts).every(
                    (tokens) => tokens === null || (Number.isSafeInteger(tokens) && tokens >= 0),
                )
            )
                memo.previous = saved;
        } catch {
            /* No usable measurement has been saved yet. */
        }
        if (memo.previous && memo.previous.measured_at > pass.measuredAt) return false;
        const m0 = text("cached_m0_bytes");
        const m1 = text("cached_m1_bytes");
        const block = (source: string, tag: string): number => {
            const rendered = extractM0Block(source, tag);
            return rendered ? measureHostTokenText(rendered) : 0;
        };
        const docs = block(m0, "project-docs");
        const profile = block(m0, "user-profile");
        const memory = block(m0, "project-memory");
        const history = block(m0, "session-history") + block(m1, "new-compartments");
        memo.blocks = { docs, profile, memory, history };
        memo.prefixDirty = false;
    }
    const { docs, profile, memory, history } = memo.blocks;
    const injected = docs + profile + memory + history;
    const tools =
        pass.toolDefinitionTokens ??
        (pass.readToolSchemas ? measureHostToolDefinitions(pass.readToolSchemas()) : undefined);
    const next: HostTokenBreakdown = {
        version: HOST_BREAKDOWN_VERSION,
        measured_at: pass.measuredAt,
        tolerance: HOST_BREAKDOWN_TOLERANCE,
        last_user_message_in_history_raw: true,
        parts: {
            tool_definitions: tools ?? null,
            project_docs: docs,
            user_profile: profile,
            history_raw: Math.max(0, pass.conversationTokens - injected),
            tool_calls_results: pass.toolCallTokens,
            // The existing pass total includes the last user message; do not tokenize it again.
            last_user_message: 0,
        },
    };
    if (!hostBreakdownChanged(memo.previous, next)) return false;
    const written =
        db
            .prepare(`INSERT INTO session_render_cache(session_id, cache_key, value)
        SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM session_meta WHERE session_id = ?)
        ON CONFLICT(session_id, cache_key) DO UPDATE SET value = excluded.value`)
            .run(sessionId, HOST_BREAKDOWN_KEY, JSON.stringify(next), sessionId).changes > 0;
    if (written) memo.previous = next;
    return written;
}

/** Defer block measurements and the small thresholded write until the host has its messages. */
export function scheduleHostTokenBreakdown(
    db: Database,
    sessionId: string,
    pass: HostTokenPass,
): void {
    const memo = getHostTokenBreakdownMemo(db, sessionId);
    // A newer defer can replace a queued fold's task, but must not lose its refresh.
    memo.prefixDirty ||= pass.prefixChanged;
    const old = memo.pending;
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
        memo.pending = undefined;
        try {
            persistHostTokenBreakdown(db, sessionId, {
                ...pass,
                toolDefinitionTokens:
                    pass.toolDefinitionTokens ?? getSessionToolDefinitionTokens(sessionId),
            });
        } catch {
            // Ignore deferred-write failures, including a session database that has already closed.
        }
    }, 0);
    memo.pending = timer;
    timer.unref();
}
