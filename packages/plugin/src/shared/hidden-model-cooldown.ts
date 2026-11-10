import type { ModelInput } from "./model-resolution";
import { isRecord } from "./record-type-guard";
import { toModelEntry } from "./resolve-fallbacks";

const MAX_SKIP_MS = 7 * 24 * 60 * 60 * 1_000;
const MIN_SKIP_MS = 60_000;
// Quota (412), rate limit (429) and overload (503) all arrive as "not before this time",
// so the wording names what the provider said, not why.
const RETRY_LATER_REASON = "provider said to retry later";

export interface HiddenModelCooldown {
    model: string;
    until: number;
    reason: string;
}

/** Process-local provider evidence, shared by hidden agents but never by user requests. */
export class HiddenModelCooldowns {
    private readonly entries = new Map<string, HiddenModelCooldown>();

    constructor(private readonly now: () => number = () => Date.now()) {}

    record(model: string | undefined, error: unknown): void {
        if (!model?.includes("/")) return;
        try {
            const now = this.now();
            const delay = retryDelay(error, now);
            if (delay === undefined || !Number.isFinite(delay) || delay <= MIN_SKIP_MS) return;
            this.entries.set(model, {
                model,
                until: now + Math.min(delay, MAX_SKIP_MS),
                reason: RETRY_LATER_REASON,
            });
        } catch {
            // Provider metadata is optional evidence; unreadable fields must not
            // mask the original failure or interrupt the caller's recovery.
        }
    }

    succeeded(model: string | undefined): void {
        if (model) this.entries.delete(model);
    }

    live(): HiddenModelCooldown[] {
        const now = this.now();
        for (const [model, entry] of this.entries) {
            if (entry.until <= now) this.entries.delete(model);
        }
        return [...this.entries.values()];
    }

    startIndex(models: readonly string[], log: (message: string) => void): number {
        const live = new Map(this.live().map((entry) => [entry.model, entry]));
        let start = models.findIndex((model) => !live.has(model));
        // Even a fully exhausted chain must try a model, rather than suppress work.
        if (start < 0) {
            start = 0;
            for (let i = 1; i < models.length; i++) {
                if (
                    (live.get(models[i])?.until ?? Infinity) <
                    (live.get(models[start])?.until ?? Infinity)
                )
                    start = i;
            }
        }
        const logged = new Set<string>();
        for (const model of models.slice(0, start)) {
            const entry = live.get(model);
            if (entry && !logged.has(model)) {
                log(
                    `skipping ${model} until ${new Date(entry.until).toISOString()}: provider said to retry later`,
                );
                logged.add(model);
            }
        }
        return start;
    }
}

function retryDelay(error: unknown, now: number, depth = 0): number | undefined {
    if (!isRecord(error) || depth > 4) return undefined;
    const data =
        typeof error.statusCode === "number" || typeof error.status === "number"
            ? error
            : isRecord(error.data)
              ? error.data
              : error;
    const status = data.statusCode ?? data.status;
    if (status === 412 || status === 429 || status === 503) {
        // OpenCode 2.2 exposes milliseconds; OpenCode 1 retains the HTTP headers.
        if (typeof data.retryAfterMs === "number") return data.retryAfterMs;
        const headers = data.responseHeaders;
        if (isRecord(headers)) {
            const value = Object.entries(headers).find(
                ([name]) => name.toLowerCase() === "retry-after",
            )?.[1];
            if (typeof value === "string") {
                const text = value.trim();
                if (/^\d+$/.test(text)) return Number(text) * 1_000;
                // Require an HTTP-date shape: Date.parse also accepts bare numbers and prose.
                if (
                    /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.test(
                        text,
                    )
                )
                    return Date.parse(text) - now;
            }
        }
    }
    return retryDelay(error.hostError ?? error.cause, now, depth + 1);
}

export const hiddenModelCooldowns = new HiddenModelCooldowns();

/** Change only the starting point; failures still continue down the configured suffix. */
export function selectHiddenModelStart(
    primary: ModelInput | undefined,
    fallbacks: readonly ModelInput[] = [],
    note: (message: string) => void,
): { primary: ModelInput | undefined; fallbacks: readonly ModelInput[] } {
    if (!primary) return { primary, fallbacks };
    const chain = [primary, ...fallbacks];
    const start = hiddenModelCooldowns.startIndex(
        chain.map((entry) => toModelEntry(entry)?.model ?? ""),
        note,
    );
    return { primary: chain[start], fallbacks: chain.slice(start + 1) };
}
