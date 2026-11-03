import { expect, test } from "bun:test";
import { anthropicClient, type AnthropicRequest } from "./anthropic-worker";

const request: AnthropicRequest = { model: "claude-sonnet-5-5", maxOutputTokens: 10, system: "synthetic test",
    messages: [{ role: "user", content: "mock only" }], tools: [] };
const ok = () => Response.json({ content: [{ type: "text", text: "mock reply" }], usage: { input_tokens: 3, output_tokens: 2 } });

test("Anthropic 429 honors retry-after seconds and date with bounded retries", async () => {
    let calls = 0;
    const waits: number[] = [];
    const now = Date.parse("2026-01-01T00:00:00Z");
    const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
        expect(req.headers.get("x-api-key") === "mock-rate-key").toBe(true);
        calls++;
        return calls < 3 ? Response.json({ error: { type: "rate_limit_error" } }, { status: 429,
            headers: { "retry-after": calls === 1 ? "2" : new Date(now + 3000).toUTCString() } }) : ok();
    } });
    const client = anthropicClient("mock-rate-key", mock.url.href, { now: () => now, sleep: async (ms) => { waits.push(ms); } });
    try {
        const reply = await client.send(request);
        expect(reply.text).toBe("mock reply"); expect(calls).toBe(3); expect(waits).toEqual([2000, 3000]);
        expect(reply.metadata.attempts).toBe(3); expect(reply.metadata.providerHost).toBe(mock.url.host);
    } finally { client.close(); mock.stop(true); }
});

test("Anthropic exhausted 429 stops the run and never shortens a long retry-after", async () => {
    let calls = 0;
    let waits = 0;
    const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("rate", { status: 429 }); } });
    const client = anthropicClient("mock-key", mock.url.href, { sleep: async () => { waits++; } });
    try {
        await expect(client.send(request)).rejects.toThrow("credential_rate_limited");
        await expect(client.send(request)).rejects.toThrow("credential_rate_limited");
        expect(calls).toBe(3); expect(waits).toBe(2);
    } finally { client.close(); mock.stop(true); }
    const long = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("rate", { status: 429, headers: { "retry-after": "3600" } }); } });
    const bounded = anthropicClient("mock-key", long.url.href, { sleep: async () => { throw new Error("must_not_sleep"); } });
    try { await expect(bounded.send(request)).rejects.toThrow("credential_rate_limited"); }
    finally { bounded.close(); long.stop(true); }
});

test("Anthropic no-credit stops immediately without retry or alternate key", async () => {
    const keys: string[] = [];
    let waits = 0;
    const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
        keys.push(req.headers.get("x-api-key") ?? "");
        return Response.json({ error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing." } },
            { status: 429, headers: { "retry-after": "0" } });
    } });
    const client = anthropicClient("mock-no-credit-key", mock.url.href, { sleep: async () => { waits++; } });
    try {
        await expect(client.send(request)).rejects.toThrow("credential_no_credit");
        await expect(client.send(request)).rejects.toThrow("credential_no_credit");
        expect(keys.length).toBe(1); expect(keys.every((key) => key === "mock-no-credit-key")).toBe(true); expect(waits).toBe(0);
    } finally { client.close(); mock.stop(true); }
});

test("Anthropic requests using separate clients never overlap", async () => {
    let active = 0, peak = 0, calls = 0;
    const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
        active++; peak = Math.max(active, peak); calls++; await Bun.sleep(10); active--; return ok();
    } });
    const a = anthropicClient("mock-shared-key", mock.url.href), b = anthropicClient("mock-shared-key", mock.url.href);
    try { await Promise.all([a.send(request), b.send(request)]); expect(peak).toBe(1); expect(calls).toBe(2); }
    finally { a.close(); b.close(); mock.stop(true); }
});
