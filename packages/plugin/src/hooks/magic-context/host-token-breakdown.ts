import { createHash } from "node:crypto";
import { getHostTokenBreakdownMemo } from "../../features/magic-context/host-token-breakdown-state";
import type { Database } from "../../shared/sqlite";
import type { M0BlockTokens } from "./m0-token-breakdown";
import { estimateFixedPromptTokens, hasTokenizerForFit } from "./read-session-formatting";
import {
    type AttributionPrefix,
    readAttributionBlocks,
    type TokenAttribution,
    tokenAttributionParts,
} from "./session-token-attribution";

export const HOST_BREAKDOWN_KEY = "host_token_breakdown";
export const HOST_BREAKDOWN_VERSION = 2;
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

export interface HostTokenPass extends AttributionPrefix {
    measuredAt: number;
    /** An executed fold or m[1] refresh, not merely a scheduler request to rebuild. */
    prefixChanged: boolean;
    /** Invoked off the transform path, with prefix counts reused until the next prefix write. */
    readAttribution: (blocks: M0BlockTokens) => TokenAttribution;
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
        memo.blocks = readAttributionBlocks(
            db,
            sessionId,
            {
                cached_m0_bytes: text("cached_m0_bytes"),
                cached_m1_bytes: text("cached_m1_bytes"),
            },
            pass,
        );
        memo.prefixDirty = false;
    }
    const next: HostTokenBreakdown = {
        version: HOST_BREAKDOWN_VERSION,
        measured_at: pass.measuredAt,
        tolerance: HOST_BREAKDOWN_TOLERANCE,
        last_user_message_in_history_raw: true,
        parts: tokenAttributionParts(pass.readAttribution(memo.blocks)),
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
            persistHostTokenBreakdown(db, sessionId, pass);
        } catch {
            // Ignore deferred-write failures, including a session database that has already closed.
        }
    }, 0);
    memo.pending = timer;
    timer.unref();
}
