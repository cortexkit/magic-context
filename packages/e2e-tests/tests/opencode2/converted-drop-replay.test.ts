import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { estimateTokens } from "../../../plugin/src/hooks/magic-context/read-session-formatting";
import { MockProvider } from "../../src/mock-provider/server";
import {
    conversionFixture,
    SHARED_MOCK_MODEL_ID,
    SHARED_MOCK_PROVIDER_ID,
    spawnOpencode1,
} from "../../src/opencode2-runner/conversion-lane";
import { spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

const MODEL = { providerID: SHARED_MOCK_PROVIDER_ID, modelID: SHARED_MOCK_MODEL_ID };

function toolTags(path: string, sessionId: string): Array<{ tag_number: number; status: string }> {
    const db = openTestDb(path, { readonly: true, fileMustExist: true }, Database);
    try {
        return db.prepare("SELECT tag_number, status FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number")
            .all(sessionId) as Array<{ tag_number: number; status: string }>;
    } finally { db.close(); }
}

function seedRecentConvertedArcs(path: string, sessionId: string): void {
    const db = new Database(path);
    try {
        const rows = db.prepare("SELECT id,type,data FROM session_message WHERE session_id = ? ORDER BY seq")
            .all(sessionId) as Array<{ id: string; type: string; data: string }>;
        const user = rows.find((row) => row.type === "user");
        const tool = rows.find((row) => row.type === "assistant" && row.data.includes("toolu_replay_source"));
        if (!user || !tool) throw new Error("converted store has no user/tool arc to extend");
        const next = db.prepare("SELECT MAX(seq) AS last FROM session_message WHERE session_id = ?").get(sessionId) as { last: number };
        const insert = db.prepare(`INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data)
            SELECT ?,session_id,type,?,time_created,time_updated,? FROM session_message WHERE id = ?`);
        db.transaction(() => {
            const original = JSON.parse(tool.data) as { content: Array<{ type: string }> };
            original.content.unshift({ type: "reasoning", text: "thinking immediately before the converted call" } as { type: string });
            db.prepare("UPDATE session_message SET data = ? WHERE id = ?").run(JSON.stringify(original), tool.id);
            let seq = next.last;
            for (let i = 0; i < 24; i++) {
                const u = JSON.parse(user.data) as { text: string };
                u.text = `newer converted prompt ${i}`;
                insert.run(`msg_replay_newer_u_${i}`, ++seq, JSON.stringify(u), user.id);
                const a = JSON.parse(tool.data) as { content: Array<{ id: string; state: { input: Record<string, unknown>; content: unknown[] } }> };
                const part = a.content.find((entry) => entry.id === "toolu_replay_source");
                if (!part) throw new Error("missing converted source part");
                part.id = `toolu_replay_newer_${i}`;
                part.state.input.filePath = `fixture-newer-${i}.txt`;
                part.state.content = [{ type: "text", text: `newer output ${i} `.repeat(450) }];
                insert.run(`msg_replay_newer_a_${i}`, ++seq, JSON.stringify(a), tool.id);
            }
            db.prepare("UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?").run(seq, sessionId);
        })();
    } finally { db.close(); }
}

async function until(check: () => boolean, description: string): Promise<void> {
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
        if (check()) return;
        await Bun.sleep(100);
    }
    throw new Error(`timed out waiting for ${description}`);
}

test("converted tool drop lands on ordinary pass and remains valid on replay", async () => {
    const fixture = conversionFixture("converted-drop-replay-e2e");
    const mock = new MockProvider();
    const provider = await mock.start();
    let v1: Awaited<ReturnType<typeof spawnOpencode1>> | undefined;
    let v2: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
    try {
        mock.setDefault({ text: "ok", usage: { input_tokens: 1200, output_tokens: 20 } });
        const config = {
            execute_threshold_percentage: 40,
            history_budget_percentage: 0.15,
            protected_tokens: 4000,
            memory: { enabled: false },
            historian: { disable: true },
            dreamer: { disable: true },
        };
        const note = join(fixture.cwd, "converted-tool.txt");
        writeFileSync(note, "tool-output ".repeat(1500));
        let issuedRead = false;
        mock.addMatcher((body) => {
            if (issuedRead || !JSON.stringify(body).includes('"name":"read"')) return null;
            issuedRead = true;
            return {
                content: [{ type: "tool_use", id: "toolu_replay_source", name: "read", input: { filePath: note } }],
                stop_reason: "tool_use" as const,
                usage: { input_tokens: 1200, output_tokens: 20 },
            };
        });
        v1 = await spawnOpencode1({ fixture, mock, mockBaseURL: provider.baseURL,
            magicContextConfig: config, modelContextLimit: 750_000, modelOutputLimit: 1024, logLabel: "v1-drop" });
        const sdk = await import("@opencode-ai/sdk");
        const client1 = sdk.createOpencodeClient({ baseUrl: v1.url });
        const sessionId = (await client1.session.create({ query: { directory: fixture.cwd } })).data!.id;
        const promptV1 = async (text: string) => {
            await client1.session.prompt({ path: { id: sessionId }, body: { model: MODEL, parts: [{ type: "text", text }] } });
        };
        await promptV1("read converted file");
        await until(() => toolTags(fixture.contextDbPath, sessionId).length > 0, "converted source tag");
        await promptV1("close first tool turn");
        await v1.stop();
        v1 = undefined;
        fixture.env.MAGIC_CONTEXT_LOG_PATH = fixture.logPath("v2-bootstrap");
        v2 = await spawnOpencode2({ existingIsolation: fixture, existingMock: { mock, baseURL: provider.baseURL },
            magicContextConfig: config, modelContextLimit: 750_000, modelOutputLimit: 1024, compactionAuto: false });
        let client = OpenCode.make({ baseUrl: v2.url,
            headers: { authorization: `Basic ${btoa(`opencode:${v2.password}`)}` } });
        await waitForPluginActive(client, fixture.cwd);
        await client.session.prompt({ sessionID: sessionId, text: "initialize the converted session" });
        await client.session.wait({ sessionID: sessionId }, { signal: AbortSignal.timeout(30_000) });
        await v2.stopHost();
        v2 = undefined;
        seedRecentConvertedArcs(fixture.openCodeDbPath, sessionId);
        fixture.env.MAGIC_CONTEXT_LOG_PATH = fixture.logPath("v2-drop");
        v2 = await spawnOpencode2({ existingIsolation: fixture, existingMock: { mock, baseURL: provider.baseURL },
            magicContextConfig: config, modelContextLimit: 750_000, modelOutputLimit: 1024, compactionAuto: false });
        client = OpenCode.make({ baseUrl: v2.url,
            headers: { authorization: `Basic ${btoa(`opencode:${v2.password}`)}` } });
        await waitForPluginActive(client, fixture.cwd);
        const tag = toolTags(fixture.contextDbPath, sessionId).find((entry) => entry.status === "active");
        if (!tag) throw new Error("converted tool tag was not active on OpenCode 2");
        let issuedReduce = false;
        mock.addMatcher((body) => {
            if (issuedReduce || !JSON.stringify(body).includes("reduce that converted tool result") || !JSON.stringify(body).includes('"name":"ctx_reduce"')) return null;
            issuedReduce = true;
            return {
                openaiOutput: [{ type: "function_call", id: "fc_replay_reduce", call_id: "call_replay_reduce",
                    name: "ctx_reduce", arguments: JSON.stringify({ drop: String(tag.tag_number) }) }],
                usage: { input_tokens: 1200, output_tokens: 20 },
            };
        });
        await client.session.prompt({ sessionID: sessionId, text: "reduce that converted tool result" });
        await client.session.wait({ sessionID: sessionId }, { signal: AbortSignal.timeout(60_000) });
        const pendingDb = openTestDb(fixture.contextDbPath, { readonly: true, fileMustExist: true }, Database);
        const queued = pendingDb.prepare("SELECT COUNT(*) AS count FROM pending_ops WHERE session_id = ? AND tag_id = ?")
            .get(sessionId, tag.tag_number) as { count: number };
        pendingDb.close();
        expect(issuedReduce).toBe(true);
        expect(queued.count).toBe(1);
        await until(() => readFileSync(fixture.logPath("v2-drop"), "utf8").includes("final-wire telemetry estimate="), "pre-drop priced telemetry");
        await v2.stopHost();
        v2 = undefined;
        fixture.env.MAGIC_CONTEXT_LOG_PATH = fixture.logPath("v2-replay");
        v2 = await spawnOpencode2({ existingIsolation: fixture, existingMock: { mock, baseURL: provider.baseURL },
            magicContextConfig: { ...config, memory: { enabled: true } }, modelContextLimit: 750_000, modelOutputLimit: 1024, compactionAuto: false });
        client = OpenCode.make({ baseUrl: v2.url,
            headers: { authorization: `Basic ${btoa(`opencode:${v2.password}`)}` } });
        await waitForPluginActive(client, fixture.cwd);
        await client.session.prompt({ sessionID: sessionId, text: "replay the dropped tool on the next request" });
        await until(() => toolTags(fixture.contextDbPath, sessionId).some((entry) => entry.tag_number === tag.tag_number && entry.status === "dropped"), "agent tool reduction");
        const verifyDb = openTestDb(fixture.contextDbPath, { readonly: true, fileMustExist: true }, Database);
        const dropped = verifyDb.prepare("SELECT drop_mode AS mode FROM tags WHERE session_id = ? AND tag_number = ?").get(sessionId, tag.tag_number);
        verifyDb.close();
        expect(dropped).toEqual({ mode: "full" });
        await client.session.wait({ sessionID: sessionId }, { signal: AbortSignal.timeout(60_000) });
        await until(() => readFileSync(fixture.logPath("v2-replay"), "utf8").includes("final-wire telemetry estimate="), "priced replay telemetry");
        await client.session.prompt({ sessionID: sessionId, text: "retry with the persisted drop and cached prefix" });
        await client.session.wait({ sessionID: sessionId }, { signal: AbortSignal.timeout(60_000) });
        await until(() => readFileSync(fixture.logPath("v2-replay"), "utf8").includes("reason=cache_hit"), "cached second pass");
        await v2.stopHost();
        v2 = undefined;
        const log = readFileSync(fixture.logPath("v2-replay"), "utf8");
        const schemaPasses = readFileSync(join(fixture.root, "llm-schema-guard.jsonl"), "utf8")
            .split("\n").filter((line) => line.startsWith(`PASS ${sessionId} `));
        expect(schemaPasses.length).toBeGreaterThanOrEqual(3);
        expect(log).toContain("pending ops WILL APPLY");
        expect(log).not.toContain("emergency tiered drop:");
        const mockRequest = mock.requests().filter((request) => JSON.stringify(request.body).includes("retry with the persisted drop and cached prefix")).at(-1);
        if (!mockRequest) throw new Error("the provider never received the replayed converted session");
        const body = mockRequest.body;
        const requestTokens = estimateTokens(JSON.stringify({ input: body.input ?? body.messages,
            instructions: body.instructions ?? body.system, tools: body.tools }));
        const wireEstimates = [...log.matchAll(/final-wire telemetry estimate=(\d+)/g)];
        const finalWireTokens = Number(wireEstimates.at(-1)?.[1]);
        expect(requestTokens).toBeGreaterThan(0);
        expect(finalWireTokens).toBeGreaterThan(0);
        // The provider mock does not tokenize, so this JSON-token proxy is diagnostic,
        // not an assertion that the final-wire estimate matches provider token usage.
        console.log("CONVERTED_WIRE_COMPARISON", { requestTokens, finalWireTokens,
            proxyRatio: Number((finalWireTokens / requestTokens).toFixed(3)) });
    } finally {
        if (v2) await v2.stopHost();
        if (v1) await v1.stop();
        await mock.stop();
    }
}, 180_000);
