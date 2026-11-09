import { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { estimateTokens } from "../../../plugin/src/hooks/magic-context/read-session-formatting";
import { MockProvider } from "../../src/mock-provider/server";
import { buildMockHistorianPayload, historianRangeInRequest } from "../../src/mock-historian";
import { inspectOpenFiles, isolation, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

// models.dev opencode catalog, 2026-11-09: GLM 5.3 is 1M/131072,
// DeepSeek V4.1 Flash Free is 200k/32000 (context/output).
const LARGE = 1_000_000;
const SMALL = 200_000;
const OLD_MODEL = "glm-5.3";
const NEW_MODEL = "deepseek-v4.1-flash-free";
type Observation = { model: string; tokens: number; limit: number; rejected: boolean; historian: boolean; hasCheckpoint: boolean; hasHistory: boolean; inputItems: number };
let evidence: { requests: Observation[]; compactions: unknown[]; events: string; log: string };
let manualControl: { rows: Array<{ data: string }>; providerCalls: number };

beforeAll(async () => {
    const fixture = isolation();
    fixture.env.MC_OC2_HOST_FOLD_ROWS = "999999";
    const probe = join(fixture.root, "switch-probe");
    const events = join(fixture.root, "events.jsonl");
    mkdirSync(probe);
    writeFileSync(events, "");
    writeFileSync(join(probe, "server.js"), `
import { appendFileSync } from 'node:fs';
export default { id: 'model-switch-observer', async setup(context) {
    (async () => { for await (const event of context.event.subscribe({})) {
        if (event.type.includes('compaction') || event.type.includes('failed'))
            appendFileSync(${JSON.stringify(events)}, JSON.stringify(event) + '\\n');
    } })().catch(() => {});
}};
`);
    const mock = new MockProvider();
    const upstream = await mock.start();
    mock.addMatcher(body => {
        if (!JSON.stringify(body).includes("<new_messages>")) return null;
        const range = historianRangeInRequest(body);
        if (!range) return null;
        return { text: buildMockHistorianPayload({ start: range.start, end: range.end, title: "Earlier work", body: "The earlier fixture work is complete." }), usage: { input_tokens: 1000, output_tokens: 100 } };
    });
    const requests: Observation[] = [];
    const proxy = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            if (request.method !== "POST") return new Response(null, { status: 404 });
            const body = await request.json() as Record<string, unknown>;
            // Estimate tokens from serialized input, instructions and tools,
            // separately from Magic Context's own request-token estimate.
            const tokens = estimateTokens(JSON.stringify({ input: body.input ?? body.messages, instructions: body.instructions, tools: body.tools }));
            const model = String(body.model);
            const limit = model === NEW_MODEL ? SMALL : LARGE;
            const rejected = tokens > limit;
            const wire = JSON.stringify(body);
            const input = body.input ?? body.messages;
            requests.push({ model, tokens, limit, rejected, historian: !!historianRangeInRequest(body),
                hasCheckpoint: wire.includes("<conversation-checkpoint>"), hasHistory: wire.includes("<session-history>"),
                inputItems: Array.isArray(input) ? input.length : 0 });
            if (rejected) return Response.json({ error: {
                message: "Your input exceeds the context window of this model",
                type: "invalid_request_error", param: null, code: "context_length_exceeded",
            } }, { status: 400 });
            mock.setDefault({ text: "accepted fixture turn", usage: { input_tokens: tokens, output_tokens: 10 } });
            const url = new URL(request.url);
            return fetch(`${upstream.baseURL}${url.pathname}`, {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
            });
        },
    });
    const host = await spawnOpencode2({
        existingIsolation: fixture, existingMock: { mock, baseURL: `http://127.0.0.1:${proxy.port}` },
        // Keep the real model names/limits but route through the mock OpenAI
        // transport: older hosts do not override the built-in opencode endpoint.
        prePlugin: probe, compactionAuto: false, providerID: "openai",
        defaultModelID: OLD_MODEL, additionalModelIDs: [NEW_MODEL],
        modelContextLimit: LARGE, modelOutputLimit: 131_072,
        magicContextConfig: {
            execute_threshold_percentage: 80, cache_ttl: "never",
            historian: { two_pass: false }, dreamer: { disable: true }, memory: { enabled: false },
        },
    });
    try {
        const configPath = join(host.cwd, "opencode.json");
        const hostConfig = JSON.parse(readFileSync(configPath, "utf8"));
        hostConfig.providers.openai.models[NEW_MODEL].limit = { context: SMALL, output: 32_000 };
        writeFileSync(configPath, JSON.stringify(hostConfig));
        const client = OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        await waitForPluginActive(client, fixture.cwd);
        const session = await client.session.create({ title: "issue 889 switch", location: { directory: fixture.cwd }, model: { providerID: "openai", id: OLD_MODEL } });
        const send = async (text: string) => {
            await client.session.prompt({ sessionID: session.id, text });
            await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) });
        };
        for (let turn = 0; turn < 6; turn++) await send(`Turn ${turn}: ${"earlier work detail ".repeat(33_000)}`);
        await client.session.switchModel({ sessionID: session.id, model: { providerID: "openai", id: NEW_MODEL } });
        await send("Continue on the smaller model.");
        for (let retry = 0; retry < 12 && !requests.some(request => request.model === NEW_MODEL && !request.historian && !request.rejected); retry++)
            await send(`Retry ${retry} after the rejected request.`);
        const paths = inspectOpenFiles(host.pid!, fixture.root, host.env).filter(path => /\.db(?:-wal|-shm)?$/.test(path));
        expect(paths.length).toBeGreaterThan(0);
        expect(paths.every(path => path.startsWith(`${fixture.root}/`))).toBe(true);
        const db = new Database(join(host.env.XDG_DATA_HOME!, "opencode", host.env.OPENCODE_DB!), { readonly: true });
        let compactions: unknown[];
        try {
            compactions = db.query("SELECT type, data FROM session_message WHERE session_id = ? AND type = 'compaction' ORDER BY seq").all(session.id);
        } finally { db.close(); }
        evidence = { requests, compactions, events: readFileSync(events, "utf8"), log: host.pluginLog() };
        console.log("ISSUE889_EVIDENCE " + JSON.stringify({ version: process.env.MC_E2E_OPENCODE2_VERSION, root: fixture.root, paths, ...evidence }));
        // Explicit host compaction still works with auto disabled. Its stored
        // summary need not come from an OpenCode summarizer model call.
        const beforeManual = requests.length;
        await client.session.compact({ sessionID: session.id });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) });
        const controlDb = new Database(join(host.env.XDG_DATA_HOME!, "opencode", host.env.OPENCODE_DB!), { readonly: true });
        try {
            manualControl = { rows: controlDb.query("SELECT json_object('status', json_extract(data, '$.status'), 'reason', json_extract(data, '$.reason'), 'summary', json_extract(data, '$.summary')) AS data FROM session_message WHERE session_id = ? AND type = 'compaction' ORDER BY seq").all(session.id) as Array<{ data: string }>, providerCalls: requests.length - beforeManual };
        } finally { controlDb.close(); }
        console.log("ISSUE889_MANUAL_CONTROL " + JSON.stringify(manualControl));
    } finally {
        try { await host.stop(); } finally { proxy.stop(true); }
    }
}, 180_000);

test("records the switch and whether the host wrote a compaction", () => {
    expect(evidence.requests.some(request => request.model === OLD_MODEL)).toBe(true);
    expect(evidence.log).toContain(NEW_MODEL);
    expect(evidence.log).toContain("arming overflow recovery proactively for the shrinking switch");
    expect(evidence.log).toContain("historian publish completed: compartments=1");
    expect(evidence.compactions).toEqual([]);
    expect(evidence.events).not.toContain("session.compaction.");
    const oldPrimary = evidence.requests.filter(request => request.model === OLD_MODEL && !request.historian).at(-1)!;
    expect(oldPrimary.tokens / LARGE).toBeGreaterThan(0.55);
    expect(oldPrimary.tokens / LARGE).toBeLessThan(0.65);
    const final = evidence.requests.filter(request => request.model === NEW_MODEL && !request.historian).at(-1)!;
    expect(final.rejected).toBe(false);
    expect(final.tokens).toBeLessThan(SMALL);
    expect(final.hasHistory).toBe(true);
    expect(final.hasCheckpoint).toBe(false);
});

test("a manual host checkpoint uses Magic Context's history without calling a summarizer", () => {
    expect(manualControl.rows).toHaveLength(1);
    const row = JSON.parse(manualControl.rows[0]!.data);
    expect(row.status).toBe("completed");
    expect(row.summary).toContain("<session-history>");
    expect(row.summary).toContain("The earlier fixture work is complete.");
    expect(manualControl.providerCalls).toBe(0);
});

// Keep the isolated-host and recovery checks above in their own tests, so a
// broken fixture cannot pass for a recovery that never sent anything.
test("a smaller-model switch never sends a request beyond the new provider window", () => {
    const primary = evidence.requests.filter(request => request.model === NEW_MODEL && !request.historian);
    expect(evidence.requests.filter(request => request.model === NEW_MODEL && request.rejected)).toEqual([]);
    // The session reaches a fitting request on the smaller model.
    expect(primary.length).toBeGreaterThan(0);
    expect(primary.every(request => request.tokens <= SMALL)).toBe(true);
});
