import { redactedLines, secretForms } from "../two-pass-activation-runs/credential-protocol";

export interface Prices {
    hit: number;
    miss: number;
    output: number;
}
export interface Usage {
    prompt_tokens: number;
    prompt_cache_hit_tokens: number;
    prompt_cache_miss_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}
export interface Message {
    role: "system" | "user" | "assistant";
    content: string;
}
export interface Request {
    model: "deepseek-flash";
    messages: Message[];
    temperature: 0.1;
    max_tokens: 32000 | 64000;
    thinking: { type: "disabled" | "enabled" };
    stream: false;
}
export interface Attempt {
    caseId: number;
    turn: number;
    attempt: number;
    reservedUSD: number;
    costCeilingUSD?: number;
    usage?: Usage;
    latencyMs?: number;
    status?: number;
    raw?: string;
    error?: string;
}
export function parseUsage(value: unknown): Usage {
    const usage = value as Usage;
    for (const key of [
        "prompt_tokens",
        "prompt_cache_hit_tokens",
        "prompt_cache_miss_tokens",
        "completion_tokens",
        "total_tokens",
    ] as const) {
        if (!Number.isSafeInteger(usage?.[key]) || usage[key] < 0) throw new Error("invalid_usage");
    }
    if (
        usage.prompt_tokens !== usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens ||
        usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens
    )
        throw new Error("invalid_usage_sum");
    return usage;
}
export function cost(usage: Usage, prices: Prices) {
    return (
        (usage.prompt_cache_hit_tokens * prices.hit +
            usage.prompt_cache_miss_tokens * prices.miss +
            usage.completion_tokens * prices.output) /
        1_000_000
    );
}

export class Ledger {
    readonly rows: Attempt[] = [];
    constructor(
        readonly cap: number,
        readonly prices: Prices,
        readonly save: () => void,
    ) {
        if (
            !(cap > 0 && cap <= 2) ||
            Object.values(prices).some((p) => !Number.isFinite(p) || p <= 0)
        )
            throw new Error("invalid_budget");
    }
    get committedUSD() {
        return this.rows.reduce((sum, r) => sum + (r.costCeilingUSD ?? r.reservedUSD), 0);
    }
    reserve(request: Request, caseId: number, turn: number, attempt: number) {
        // UTF-8 bytes overbound text tokens; padding also covers chat framing. Cache savings are never assumed.
        const inputBound = Buffer.byteLength(JSON.stringify(request)) + 4096;
        const reservedUSD =
            (inputBound * Math.max(this.prices.hit, this.prices.miss) +
                request.max_tokens * this.prices.output) /
            1_000_000;
        if (this.committedUSD + reservedUSD > this.cap) throw new Error("spend_cap_refused");
        const row: Attempt = { caseId, turn, attempt, reservedUSD };
        this.rows.push(row);
        this.save();
        return row;
    }
    settle(row: Attempt, usage: Usage) {
        const charged = cost(usage, this.prices);
        if (charged > row.reservedUSD) throw new Error("usage_exceeds_reservation");
        row.usage = usage;
        row.costCeilingUSD = charged;
        this.save();
    }
}

export function sanitizer(material: string) {
    return (text: string) =>
        secretForms(material).reduce((out, form) => out.split(form).join("[REDACTED]"), text);
}
export function logger(material: string, emit: (text: string) => void) {
    const lines = redactedLines([material], emit);
    return (text: string) => lines.write(`${text}\n`);
}
export function retryDelay(header: string | null, now = Date.now()): number {
    if (header === null) return 1000;
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    if (!Number.isFinite(ms) || ms < 0) return 1000;
    if (ms > 120_000) throw new Error("credential_rate_limited");
    return ms;
}
function noCredit(status: number, body: string) {
    return (
        status === 402 ||
        /insufficient[_ -]?(balance|credit|quota)|no[_ -]?credit|billing|balance.*(low|insufficient)|credit.*exhaust/i.test(
            body,
        )
    );
}

export class DeepSeek {
    private stopped = false;
    private busy = false;
    constructor(
        private readonly input: {
            endpoint: string;
            material: string;
            ledger: Ledger;
            save(): void;
            log(text: string): void;
            sleep?: (ms: number) => Promise<void>;
        },
    ) {}
    async send(request: Request, caseId: number, turn: number): Promise<string> {
        if (this.stopped) throw new Error("client_stopped");
        if (this.busy) throw new Error("concurrent_request_refused");
        this.busy = true;
        try {
            for (let attempt = 0; attempt <= 2; attempt++) {
                const row = this.input.ledger.reserve(request, caseId, turn, attempt);
                const started = performance.now();
                try {
                    const response = await fetch(this.input.endpoint, {
                        method: "POST",
                        redirect: "error",
                        signal: AbortSignal.timeout(300_000),
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${this.input.material}`,
                        },
                        body: JSON.stringify(request),
                    });
                    row.status = response.status;
                    row.raw = sanitizer(this.input.material)(await response.text());
                    row.latencyMs = performance.now() - started;
                    this.input.save();
                    if (!response.ok) {
                        if (noCredit(response.status, row.raw))
                            throw new Error("credential_no_credit");
                        if (response.status === 429 && attempt < 2) {
                            // Refusals have no trustworthy usage: retain their full reservations before retrying.
                            const delay = retryDelay(response.headers.get("retry-after"));
                            row.error = "retry_429";
                            this.input.save();
                            this.input.log(`case=${caseId} turn=${turn} retry=429 waitMs=${delay}`);
                            await (this.input.sleep ?? Bun.sleep)(delay);
                            continue;
                        }
                        throw new Error(
                            response.status === 429
                                ? "credential_rate_limited"
                                : "provider_http_error",
                        );
                    }
                    const parsed = JSON.parse(row.raw);
                    this.input.ledger.settle(row, parseUsage(parsed.usage));
                    const choice = parsed.choices?.[0];
                    if (
                        choice?.finish_reason !== "stop" ||
                        choice.message?.role !== "assistant" ||
                        typeof choice.message.content !== "string" ||
                        choice.message.tool_calls?.length
                    )
                        throw new Error("incomplete_response");
                    return choice.message.content;
                } catch (error) {
                    row.latencyMs ??= performance.now() - started;
                    const code =
                        error instanceof Error &&
                        /^(credential_|invalid_usage|usage_exceeds|incomplete_response|provider_http_error)/.test(
                            error.message,
                        )
                            ? error.message
                            : "transport_or_response_error";
                    row.error = code;
                    this.input.save();
                    throw new Error(code);
                }
            }
            throw new Error("credential_rate_limited");
        } catch (error) {
            // A reply cut off at the output cap is one case's result, not a reason to
            // stop the run. Credential, spend and transport failures still stop it.
            if (!(error instanceof Error && error.message === "incomplete_response"))
                this.stopped = true;
            throw error;
        } finally {
            this.busy = false;
        }
    }
}
