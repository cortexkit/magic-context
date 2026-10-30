import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { MockProvider } from "../../src/mock-provider/server";
import {
    conversionFixture, SHARED_MOCK_MODEL_ID, SHARED_MOCK_PROVIDER_ID, spawnOpencode1,
} from "../../src/opencode2-runner/conversion-lane";
import { spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";
import { sessionMetaFieldSelect, writeSessionMetaField } from "../../src/session-meta-fields";
import { rpcPortDir } from "../../../plugin/src/shared/rpc-utils";

const TOOL_COUNT = 155;
const CONTEXT_LIMIT = 750_000;
const RESULT_TEXT = "payload ".repeat(2_300);

function seedConvertedTail(path: string, sessionID: string): void {
    const db = new Database(path);
    try {
        const rows = db.prepare("SELECT id, type, data FROM session_message WHERE session_id = ? ORDER BY seq")
            .all(sessionID) as Array<{ id: string; type: string; data: string }>;
        const user = rows.find((row) => row.type === "user");
        const tool = rows.find((row) => row.type === "assistant" && row.data.includes('"type":"tool"'));
        const warmup = [...rows].reverse().find((row) => row.type === "assistant" && row.data.includes('"text":"warmup"'));
        if (!user || !tool || !warmup) throw new Error("conversion did not produce tool and provider-proven warmup rows");
        const warmupTokens = (JSON.parse(warmup.data) as { tokens: unknown }).tokens;
        const add = db.prepare(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
            SELECT ?, session_id, type, ?, time_created, time_updated, ? FROM session_message WHERE id = ?`);
        const max = db.prepare("SELECT MAX(seq) AS seq FROM session_message WHERE session_id = ?").get(sessionID) as { seq: number };
        let seq = max.seq;
        db.transaction(() => {
            for (let index = 0; index < TOOL_COUNT; index++) {
                const prompt = JSON.parse(user.data) as { text: string };
                prompt.text = index < 5
                    ? `<system-reminder>fixture injected reminder ${index}</system-reminder>`
                    : `fixture converted turn ${index}`;
                add.run(`msg_fixture_user_${String(index).padStart(4, "0")}`, ++seq, JSON.stringify(prompt), user.id);
                const assistant = JSON.parse(tool.data) as {
                    tokens?: unknown;
                    content: Array<{ type: string; id: string; state: { input: Record<string, unknown>; content: unknown[] } }>;
                };
                delete assistant.tokens;
                if (index === TOOL_COUNT - 1) assistant.tokens = warmupTokens;
                const part = assistant.content.find((entry) => entry.type === "tool");
                if (!part) throw new Error("converted tool disappeared");
                part.id = `toolu_fixture_${String(index).padStart(4, "0")}`;
                part.state.input = { filePath: `fixture-${index}.txt` };
                part.state.content = [{ type: "text", text: RESULT_TEXT }];
                if (index === 0 || index === TOOL_COUNT - 2) {
                    assistant.content.unshift({ type: "reasoning", text: "reasoning adjacent to converted call" } as unknown as typeof part);
                }
                add.run(`msg_fixture_tool_${String(index).padStart(4, "0")}`, ++seq, JSON.stringify(assistant), tool.id);
            }
            db.prepare("UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?")
                .run(seq, sessionID);
        })();
    } finally {
        db.close();
    }
}

async function flush(host: Awaited<ReturnType<typeof spawnOpencode2>>, sessionID: string): Promise<string> {
    const directory = rpcPortDir(join(host.env.XDG_DATA_HOME!, "cortexkit", "magic-context"), host.cwd);
    let discovery: { port: number; token: string } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
        const files = existsSync(directory) ? readdirSync(directory)
            .filter((name) => name.startsWith("port-") && name.endsWith(".json"))
            .sort((a, b) => statSync(join(directory, b)).mtimeMs - statSync(join(directory, a)).mtimeMs) : [];
        const file = files[0];
        if (file) {
            discovery = JSON.parse(readFileSync(join(directory, file), "utf8"));
            break;
        }
        await Bun.sleep(50);
    }
    if (!discovery) throw new Error("no private flush RPC discovered");
    const response = await fetch(`http://127.0.0.1:${discovery.port}/rpc/flush`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${discovery.token}` },
        body: JSON.stringify({ sessionId: sessionID, directory: host.cwd }),
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { ok?: unknown; message?: unknown };
    expect(result.ok).toBe(true);
    return typeof result.message === "string" ? result.message : "";
}

test("converted 750k session explicit flush exercises reporter emergency drop path", async () => {
    const fixture = conversionFixture("reporter-emergency-drop-e2e");
    const mock = new MockProvider();
    const provider = await mock.start();
    mock.setDefault({ text: "ok", usage: { input_tokens: 1_200, output_tokens: 20 } });
    const magicContextConfig = {
        execute_threshold_percentage: 65,
        memory: { enabled: false }, historian: { disable: true }, dreamer: { disable: true },
    };
    let v1: Awaited<ReturnType<typeof spawnOpencode1>> | undefined;
    let v2: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
    try {
        v1 = await spawnOpencode1({
            fixture, mock, mockBaseURL: provider.baseURL, magicContextConfig,
            modelContextLimit: CONTEXT_LIMIT, modelOutputLimit: 1_024,
            logLabel: "v1-reporter",
        });
        const sdk = await import("@opencode-ai/sdk");
        const client1 = sdk.createOpencodeClient({ baseUrl: v1.url });
        const session = await client1.session.create({ query: { directory: fixture.cwd } });
        const sessionID = session.data?.id;
        if (!sessionID) throw new Error("v1 session create failed");
        const file = join(fixture.cwd, "seed.txt");
        writeFileSync(file, "converted fixture output\n".repeat(200));
        let issueTool = true;
        mock.addMatcher((body) => {
            const request = JSON.stringify(body);
            if (!issueTool || !request.includes("seed one converted tool") || !request.includes('"name":"read"')) return null;
            issueTool = false;
            return { content: [{ type: "tool_use", id: "toolu_fixture_original", name: "read", input: { filePath: file } }],
                stop_reason: "tool_use" as const, usage: { input_tokens: 1_200, output_tokens: 20 } };
        });
        const result = await client1.session.prompt({ path: { id: sessionID }, body: {
            model: { providerID: SHARED_MOCK_PROVIDER_ID, modelID: SHARED_MOCK_MODEL_ID },
            parts: [{ type: "text", text: "seed one converted tool" }],
        } });
        expect(result.data?.info?.error).toBeFalsy();
        expect(issueTool).toBe(false);
        const settle = await client1.session.prompt({ path: { id: sessionID }, body: {
            model: { providerID: SHARED_MOCK_PROVIDER_ID, modelID: SHARED_MOCK_MODEL_ID },
            parts: [{ type: "text", text: "settle converted tool" }],
        } });
        expect(settle.data?.info?.error).toBeFalsy();
        await v1.stop();
        v1 = undefined;
        fixture.env.MAGIC_CONTEXT_LOG_PATH = fixture.logPath("v2-reporter");
        v2 = await spawnOpencode2({ existingIsolation: fixture,
            existingMock: { mock, baseURL: provider.baseURL }, magicContextConfig,
            modelContextLimit: CONTEXT_LIMIT, modelOutputLimit: 1_024, compactionAuto: false });
        let client2 = OpenCode.make({ baseUrl: v2.url,
            headers: { authorization: `Basic ${btoa(`opencode:${v2.password}`)}` } });
        await waitForPluginActive(client2, fixture.cwd);
        mock.setDefault({ text: "warmup", usage: { input_tokens: 820_000, output_tokens: 20 } });
        await client2.session.prompt({ sessionID, text: "record provider-proven usage" });
        await client2.session.wait({ sessionID }, { signal: AbortSignal.timeout(30_000) });
        mock.setDefault({ text: "ok", usage: { input_tokens: 1_200, output_tokens: 20 } });
        await v2.stopHost();
        v2 = undefined;
        seedConvertedTail(fixture.openCodeDbPath, sessionID);
        const contextDb = openTestDb(fixture.contextDbPath, undefined, Database);
        try {
            const row = contextDb.prepare(`SELECT ${sessionMetaFieldSelect("cached_m0_upgrade_state", "upgrade")} FROM session_meta WHERE session_id = ?`)
                .get(sessionID) as { upgrade: string | null } | undefined;
            if (!row?.upgrade) throw new Error("warmup did not materialize m0 upgrade state");
            writeSessionMetaField(contextDb, sessionID, "cached_m0_upgrade_state", row.upgrade.replace(/\|render-budgets:[^|]+/, "|render-budgets:m9999-h99999"));
            contextDb.prepare("UPDATE session_meta SET cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?")
                .run("msg_absent_fixture_boundary", sessionID);
            contextDb.prepare(`INSERT INTO compartments
                (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at, harness)
                VALUES (?, 1, 0, 1, 'msg_absent_fixture_start', 'msg_absent_fixture_boundary', 'fixture', 'fixture', ?, 'opencode2')`)
                .run(sessionID, Date.now());
        } finally { contextDb.close(); }
        // The copied tool row retains its original (pre-warmup) completion time.
        // The stale-reading guard correctly refuses to record its copied 820k
        // usage again. Check the provider-proven reading saved before the
        // restart, before the host starts again.
        const usageDb = openTestDb(fixture.contextDbPath, { readonly: true }, Database);
        try {
            const usage = usageDb.prepare(`SELECT last_input_tokens AS inputTokens,
                last_usage_context_limit AS contextLimit, last_context_percentage AS percentage
                FROM session_meta WHERE session_id = ?`).get(sessionID) as {
                inputTokens: number; contextLimit: number; percentage: number;
            };
            expect(usage.inputTokens).toBe(820_000);
            // The configured window reserves the 1024 output tokens; there is
            // no declared input cap or overflow-learned limit in this fixture.
            expect(usage.contextLimit).toBe(748_976);
            expect(usage.percentage).toBeCloseTo(109.48281386853517, 8);
            console.log("REPORTER_PROVIDER_USAGE", JSON.stringify(usage));
        } finally { usageDb.close(); }
        v2 = await spawnOpencode2({ existingIsolation: fixture,
            existingMock: { mock, baseURL: provider.baseURL }, magicContextConfig,
            modelContextLimit: CONTEXT_LIMIT, modelOutputLimit: 1_024, compactionAuto: false });
        client2 = OpenCode.make({ baseUrl: v2.url,
            headers: { authorization: `Basic ${btoa(`opencode:${v2.password}`)}` } });
        await waitForPluginActive(client2, fixture.cwd);
        const usageLogPath = fixture.logPath("v2-reporter");
        const previousUsageEvents = (existsSync(usageLogPath)
            ? readFileSync(usageLogPath, "utf8").match(/v2 usage: inputTokens=820000/g) ?? []
            : []).length;
        const usageBeforeDb = openTestDb(fixture.contextDbPath, { readonly: true }, Database);
        let responseTimeBefore: number;
        try {
            const row = usageBeforeDb.prepare(
                "SELECT last_response_time AS responseTime FROM session_meta WHERE session_id = ?",
            ).get(sessionID) as { responseTime: number | null } | undefined;
            responseTimeBefore = row?.responseTime ?? 0;
        } finally { usageBeforeDb.close(); }
        // The restarted host begins with an empty in-memory usage window. Prime
        // it again with provider-reported pressure before the reporter pass.
        mock.setDefault({ text: "re-prime reporter usage", usage: { input_tokens: 820_000, output_tokens: 20 } });
        await client2.session.prompt({ sessionID, text: "re-establish provider usage" });
        await client2.session.wait({ sessionID }, { signal: AbortSignal.timeout(30_000) });
        const usageDeadline = Date.now() + 15_000;
        let recordedFreshUsage = false;
        while (!recordedFreshUsage && Date.now() < usageDeadline) {
            const usageDb = openTestDb(fixture.contextDbPath, { readonly: true }, Database);
            try {
                const row = usageDb.prepare(`SELECT last_response_time AS responseTime,
                    last_input_tokens AS inputTokens, last_context_percentage AS percentage
                    FROM session_meta WHERE session_id = ?`).get(sessionID) as {
                    responseTime: number | null; inputTokens: number; percentage: number;
                } | undefined;
                recordedFreshUsage = !!row &&
                    row.responseTime !== null &&
                    row.responseTime > responseTimeBefore &&
                    row.inputTokens === 820_000 &&
                    row.percentage > 100;
            } finally { usageDb.close(); }
            if (!recordedFreshUsage) await Bun.sleep(50);
        }
        expect(recordedFreshUsage).toBe(true);
        // Provider usage arrives on a host event after the reply. Wait until it is
        // logged so the next transform uses the fresh usage, not the prior low value.
        const usageLogDeadline = Date.now() + 15_000;
        let loggedFreshUsage = false;
        while (!loggedFreshUsage && Date.now() < usageLogDeadline) {
            const currentLog = existsSync(usageLogPath) ? readFileSync(usageLogPath, "utf8") : "";
            loggedFreshUsage =
                (currentLog.match(/v2 usage: inputTokens=820000/g) ?? []).length >
                previousUsageEvents;
            if (!loggedFreshUsage) await Bun.sleep(50);
        }
        expect(loggedFreshUsage).toBe(true);
        mock.setDefault({ text: "ok", usage: { input_tokens: 1_200, output_tokens: 20 } });
        const pendingDb = openTestDb(fixture.contextDbPath, undefined, Database);
        try {
            pendingDb.exec("PRAGMA busy_timeout=5000");
            const tag = pendingDb.prepare("SELECT tag_number FROM tags WHERE session_id = ? AND status = 'active' ORDER BY tag_number LIMIT 1")
                .get(sessionID) as { tag_number: number } | undefined;
            if (!tag) throw new Error("warmup did not create an active tag");
            const queued = pendingDb.prepare("INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', ?, 'opencode2')");
            // Repeated intent tests queue depth without removing extra converted arcs
            // before the emergency selector sees the 155 completed tool calls.
            pendingDb.transaction(() => {
                for (let i = 0; i < 46; i++) queued.run(sessionID, tag.tag_number, Date.now() + i);
            }).immediate();
        } finally { pendingDb.close(); }
        const flushMessage = await flush(v2, sessionID);
        expect(flushMessage).toMatch(/^(?:Flushed: \d+ dropped|No pending operations to flush)\./);
        await client2.session.prompt({ sessionID, text: "reporter explicit flush" });
        await client2.session.wait({ sessionID }, { signal: AbortSignal.timeout(120_000) });
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            const current = existsSync(fixture.logPath("v2-reporter")) ? readFileSync(fixture.logPath("v2-reporter"), "utf8") : "";
            if (current.includes("transform completed") || current.includes("v2 refusal:")) break;
            await Bun.sleep(100);
        }
        await v2.stopHost();
        v2 = undefined;
        const log = readFileSync(fixture.logPath("v2-reporter"), "utf8");
        const schemaPasses = readFileSync(join(fixture.root, "llm-schema-guard.jsonl"), "utf8")
            .split("\n").filter((line) => line.startsWith(`PASS ${sessionID} `));
        expect(schemaPasses.length).toBeGreaterThanOrEqual(2);
        const milestones = log.split("\n").filter((line) => /v2 usage:|emergency tiered drop:|heuristic cleanup:|pending ops WILL APPLY|prefix trim:|rematerialized=true/.test(line));
        console.log("REPORTER_V2_USAGE", milestones.filter((line) => line.includes("v2 usage:")).join("\n"));
        const drained = openTestDb(fixture.contextDbPath, { readonly: true }, Database);
        try {
            expect(drained.prepare("SELECT tag_id FROM pending_ops WHERE session_id = ?").all(sessionID)).toHaveLength(0);
        } finally { drained.close(); }
        // The reporter pass is the first priced pass after the restart. Its
        // reading is the provider's own, saved by the re-prime request above
        // (same model and limit, cache still warm), so that 820k reading, above
        // the usable window, is what puts the pass in the emergency band. The
        // pass still counts the converted wire, but only to check whether the
        // request grew past the saved reading: counted with calibrated ratios
        // it reads about half the window, so it does not override the reading.
        // Only the doubled fit envelope, which pressure sizing no longer uses,
        // priced that wire above the window.
        const pricedReadings = [...log.matchAll(
            /using saved provider reading for priced pass inputTokens=(\d+) percentage=([\d.]+)/g,
        )].map((match) => ({ inputTokens: Number(match[1]), percentage: Number(match[2]) }));
        expect(Math.max(...pricedReadings.map((reading) => reading.inputTokens))).toBeGreaterThan(CONTEXT_LIMIT - 1_024);
        expect(Math.max(...pricedReadings.map((reading) => reading.percentage))).toBeGreaterThan(100);
        // Private paths and tool definitions can move the final selected tag across
        // the reclaim boundary. Assert the reclaimed budget, not an exact tag count.
        const v1Log = readFileSync(fixture.logPath("v1-reporter"), "utf8");
        expect(v1Log).toMatch(/final-wire telemetry estimate=\d+ .*toolDefinitions=\d+ /);
        const emergencyDrop = log.match(/emergency tiered drop: tiered drop: (\d+) tags, reclaim≈(\d+)\/(\d+) tokens/);
        expect(emergencyDrop).not.toBeNull();
        expect(Number(emergencyDrop![1])).toBeGreaterThanOrEqual(TOOL_COUNT - 10);
        expect(Number(emergencyDrop![1])).toBeLessThanOrEqual(TOOL_COUNT);
        expect(Number(emergencyDrop![2])).toBeGreaterThanOrEqual(Number(emergencyDrop![3]));
        expect(milestones.some((line) => /heuristic cleanup: dropped \d+ tool tags, deduplicated \d+ tool calls, dropped 5 system injections/.test(line))).toBe(true);
        expect(milestones.some((line) => /prefix trim: boundary .*; pass=priced; no in-pass trim applied \(boundary absent from immutable source order\)/.test(line))).toBe(true);
        expect(milestones.some((line) => line.includes("rematerialized=true, reason=render_config"))).toBe(true);
    } finally {
        if (v2) await v2.stopHost();
        if (v1) await v1.stop();
        await mock.stop();
    }
}, 600_000);
