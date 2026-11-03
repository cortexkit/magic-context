import { openSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";

export const ANTHROPIC_RETRIES = 2;
export type AnthropicRequest = {
    model: string;
    maxOutputTokens: number;
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    tools: unknown[];
};

// All clients in this process share a queue: routing may use the same granted key.
let serial: Promise<unknown> = Promise.resolve();
export function anthropicClient(key: string, endpoint = "https://api.anthropic.com/v1/messages", options: {
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    onAttempt?: (providerHost: string) => void;
} = {}) {
    let stopped: string | undefined;
    return {
        async send(request: AnthropicRequest) {
            const job = serial.then(async () => {
                if (stopped) throw new Error(stopped);
                try { return await dispatch(request, key, endpoint, options); }
                catch (error) {
                    stopped = error instanceof Error && ["credential_no_credit", "credential_rate_limited"].includes(error.message)
                        ? error.message : "measurement_dispatch_failed";
                    throw new Error(stopped);
                }
            });
            serial = job.then(() => undefined, () => undefined);
            return job;
        },
        close() { key = ""; stopped = "measurement_client_closed"; },
    };
}

export async function anthropicSend(request: AnthropicRequest, key: string, endpoint?: string) {
    const client = anthropicClient(key, endpoint);
    try { return await client.send(request); } finally { client.close(); }
}

async function dispatch(request: AnthropicRequest, key: string, endpoint: string, options: {
    sleep?: (ms: number) => Promise<void>; now?: () => number; onAttempt?: (providerHost: string) => void;
}) {
    if (request.model !== "claude-sonnet-5-5" || request.tools.length)
        throw new Error("measurement_request_contract");
    const wire = {
        model: request.model,
        max_tokens: request.maxOutputTokens,
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        messages: request.messages.map((message, index) => ({
            role: message.role,
            content: [{ type: "text", text: message.content,
                // Keep the first-turn breakpoint identical when appending the actual reply.
                ...(index === 0 ? { cache_control: { type: "ephemeral" } } : {}),
            }],
        })),
    };
    let reply!: Response;
    let attempts = 0;
    for (let attempt = 0; attempt <= ANTHROPIC_RETRIES; attempt++) {
    attempts++;
    options.onAttempt?.(new URL(endpoint).host);
    reply = await fetch(endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": key },
        body: JSON.stringify(wire),
    });
    if (reply.ok) break;
    const error = await reply.text();
    // Billing refusals are terminal even if an upstream labels one as rate-limited.
    if (/credit balance|insufficient.?credit|no.?credit|billing|payment.required/i.test(error) || reply.status === 402)
        throw new Error("credential_no_credit");
    if (reply.status !== 429) throw new Error(`anthropic_http_${reply.status}`);
    if (attempt === ANTHROPIC_RETRIES) throw new Error("credential_rate_limited");
    const retryAfter = reply.headers.get("retry-after");
    const now = (options.now ?? Date.now)();
    const delay = retryAfter === null ? 1000 * 2 ** attempt : /^\d+(\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
    // Do not shorten a provider's requested wait to fit our bounded run.
    if (!Number.isFinite(delay) || delay > 30_000) throw new Error("credential_rate_limited");
    await (options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(Math.max(0, delay));
    }
    const body = await reply.json() as {
        content: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    };
    const usage = body.usage;
    const steps = usage?.input_tokens !== undefined && usage.output_tokens !== undefined ? [{
        inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
    }] : undefined;
    return { text: body.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join(""),
        usage, steps, metadata: { wireRequest: wire, response: body, providerHost: new URL(endpoint).host, attempts } };
}

if (import.meta.main) {
    let key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const witness = process.env.TWO_PASS_WITNESS;
    if (!key || !witness) throw new Error("measurement_worker_environment");
    const fd = openSync(witness, "a", 0o600);
    const endpoint = process.env.TWO_PASS_MOCK_ANTHROPIC_ENDPOINT;
    if (endpoint) {
        const url = new URL(endpoint);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("mock_endpoint_not_loopback");
    }
    const client = anthropicClient(key, endpoint, { onAttempt(providerHost) {
        process.stdout.write(`${JSON.stringify({ providerAttempt: { providerHost } })}\n`);
    } });
    const lines = createInterface({ input: process.stdin });
    process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
    try {
        for await (const line of lines) {
            const input = JSON.parse(line);
            try {
                const result = await client.send(input.request);
                process.stdout.write(`${JSON.stringify({ id: input.id, result }).split(key).join("[REDACTED]")}\n`);
            } catch (error) {
                // Provider errors may echo credentials; the parent needs only a bounded failure.
                const code = error instanceof Error && ["credential_no_credit", "credential_rate_limited"].includes(error.message)
                    ? error.message : "measurement_dispatch_failed";
                process.stdout.write(`${JSON.stringify({ id: input.id, error: code })}\n`);
            }
        }
    } finally { client.close(); key = ""; closeSync(fd); }
}
