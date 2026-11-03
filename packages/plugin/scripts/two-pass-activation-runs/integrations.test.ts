import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "../../src/features/magic-context/storage-db";
import { Database } from "../../src/shared/sqlite";
import { disposableEnvironment, verifyIsolation, type Isolation } from "../two-pass-live-replay/host-drivers";
import { assertObservedPluginStore, PostGateBudgetStop, type CallMeter } from "./activation-driver";
import { meteredDispatch, mockMeteringProxy, providerUsage, sumProviderSteps } from "./provider-meter";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const parent = join(realpathSync(tmpdir()), "magic-context");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, "adapter-test-"));
    roots.push(root);
    const env = disposableEnvironment(root);
    mkdirSync(env.MAGIC_CONTEXT_STORAGE_DIR, { recursive: true });
    const storePath = join(env.MAGIC_CONTEXT_STORAGE_DIR, "context.db");
    const db = new Database(storePath); initializeDatabase(db); db.close();
    const isolation: Isolation = { root, env, proof: { pid: 42, tool: "fixture", output: storePath, paths: [storePath] } };
    return { root, env, storePath, isolation };
}

test("every dispatch reserves before sending, including check, retry and grader", async () => {
    const events: string[] = [];
    const meter: CallMeter = {
        beforeSend(bound) { events.push(`reserve:${bound.kind}`); return events.length; },
        settle(id, steps) { events.push(`settle:${id}:${steps?.[0].inputTokens}`); },
    };
    for (const kind of ["turn_one", "turn_two", "check", "grader", "turn_one"] as const) {
        await meteredDispatch({
            meter, bound: { kind, inputTokens: 100, outputCeiling: 20, maxSteps: 1, hostRetries: 0 },
            async dispatch() {
                expect(events.at(-1)).toBe(`reserve:${kind}`);
                events.push("dispatch");
                return { status: 200, body: JSON.stringify({ usage: { prompt_tokens: 73, completion_tokens: 9 } }), contentType: "application/json" };
            },
        });
    }
    expect(events.filter((event) => event === "dispatch")).toHaveLength(5);
    expect(events.filter((event) => event.startsWith("settle:"))).toHaveLength(5);
});

test("OpenCode 2 usage sums every provider step rather than the final step", () => {
    const bodies = [
        { usage: { input_tokens: 101, output_tokens: 11 } },
        { usage: { input_tokens: 307, output_tokens: 17 } },
        { usage: { input_tokens: 509, output_tokens: 23 } },
    ];
    const steps = bodies.flatMap((body) => providerUsage(JSON.stringify(body), "application/json") ?? []);
    expect(steps).toHaveLength(3);
    expect(sumProviderSteps(steps)).toEqual({ inputTokens: 917, outputTokens: 51 });
});

test("Anthropic SSE sums cache input and output without counting initial output twice", () => {
    const sse = [
        { type: "message_start", message: { usage: { input_tokens: 20, cache_creation_input_tokens: 70, cache_read_input_tokens: 10, output_tokens: 1 } } },
        { type: "message_delta", usage: { output_tokens: 31 } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    expect(providerUsage(sse, "text/event-stream")).toEqual([{ inputTokens: 100, outputTokens: 31 }]);
    expect(providerUsage("{}", "application/json")).toBeUndefined();
});

test("budget rejection prevents the provider from seeing a request", async () => {
    let dispatches = 0;
    await expect(meteredDispatch({
        meter: { beforeSend() { throw new Error("cap"); }, settle() { throw new Error("unreachable"); } },
        bound: { kind: "check", inputTokens: 10, outputCeiling: 5, maxSteps: 1, hostRetries: 0 },
        async dispatch() { dispatches++; return { status: 200, body: "{}", contentType: "application/json" }; },
    })).rejects.toThrow("cap");
    expect(dispatches).toBe(0);
});

test("adapter rejects a fabricated plugin store even when its schema is plausible", () => {
    const { env, storePath, isolation } = fixture();
    expect(assertObservedPluginStore(isolation, storePath)).toBe(storePath);
    const fabricated = join(env.MAGIC_CONTEXT_STORAGE_DIR, "fabricated.db");
    const db = new Database(fabricated); initializeDatabase(db); db.close();
    expect(() => assertObservedPluginStore(isolation, fabricated)).toThrow("plugin_store_not_open_by_host");
});

test("isolation rejects every non-throwaway database, not only known live names", () => {
    const { isolation } = fixture();
    isolation.proof.paths.push("/var/lib/unrelated-host.db");
    expect(() => verifyIsolation(isolation)).toThrow("database_outside_disposable_root");
});

test("mock proxy captures every send and meters host retries separately", async () => {
    const requests: string[] = [];
    const attemptedHosts: string[] = [];
    const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        requests.push(await request.text());
        return Response.json({ usage: { prompt_tokens: 13, completion_tokens: 7 }, choices: [] });
    } });
    let reservations = 0;
    const settlements: unknown[] = [];
    const proxy = await mockMeteringProxy({ upstream: mock.url.href, outputCeiling: 20, classify: () => "check",
        onProviderAttempt: (host) => attemptedHosts.push(host), meter: {
        beforeSend() { reservations++; return reservations; }, settle(id, steps) { settlements.push({ id, steps }); },
    } });
    try {
        for (const body of ["first", "retry", "grade"]) {
            const reply = await fetch(`${proxy.url}/v1/chat/completions`, { method: "POST", body });
            expect(reply.status).toBe(200);
            await reply.text();
        }
        expect(requests).toEqual(["first", "retry", "grade"]);
        expect(reservations).toBe(3);
        expect(settlements).toHaveLength(3);
        expect(proxy.receipts).toHaveLength(requests.length);
        expect(attemptedHosts).toEqual([mock.url.host, mock.url.host, mock.url.host]);
        expect(proxy.receipts.map((receipt) => receipt.request.providerHost)).toEqual(attemptedHosts);
        expect(proxy.failures).toEqual([]);
    } finally { await proxy.close(); mock.stop(true); }
});

test("proxy reserves the wire output ceiling and never changes the request", async () => {
    const bodies: string[] = [];
    const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        bodies.push(await request.text());
        return Response.json({ usage: { prompt_tokens: 3, completion_tokens: 2 } });
    } });
    const ceilings: number[] = [];
    const proxy = await mockMeteringProxy({ upstream: mock.url.href, outputCeiling: 20, classify: () => "grader", meter: {
        beforeSend(bound) { ceilings.push(bound.outputCeiling); return 1; }, settle() {},
    } });
    const body = JSON.stringify({ model: "mock", max_tokens: 70, messages: [] });
    try {
        const response = await fetch(proxy.url, { method: "POST", body });
        expect(response.status).toBe(200);
        await response.text();
        expect(ceilings).toEqual([70]);
        expect(bodies).toEqual([body]);
    } finally { await proxy.close(); mock.stop(true); }
});

test("proxy latches a budget stop before any dispatch or host retry", async () => {
    let dispatches = 0;
    let reservations = 0;
    const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { dispatches++; return Response.json({}); } });
    const proxy = await mockMeteringProxy({ upstream: mock.url.href, outputCeiling: 20, classify: () => "check", meter: {
        beforeSend() { reservations++; throw new PostGateBudgetStop("cost_cap"); }, settle() { throw new Error("no_dispatch"); },
    } });
    try {
        for (let i = 0; i < 2; i++) {
            const response = await fetch(proxy.url, { method: "POST", body: "{}" });
            expect(response.status).toBe(402);
            await response.text();
        }
        expect(reservations).toBe(1);
        expect(dispatches).toBe(0);
        expect(proxy.budgetStop?.requiresOwnerDecision).toBe(true);
    } finally { await proxy.close(); mock.stop(true); }
});
