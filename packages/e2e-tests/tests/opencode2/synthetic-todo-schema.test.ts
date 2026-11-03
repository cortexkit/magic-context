import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { isolation, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

const todos = [{ content: "Finish the fixture", status: "in_progress", priority: "high" }];

function todoState(path: string, sessionID: string): string {
    const db = openTestDb(path, { readonly: true });
    try {
        return (db.prepare("SELECT last_todo_state AS state FROM session_meta WHERE session_id = ?")
            .get(sessionID) as { state: string } | undefined)?.state ?? "";
    } finally { db.close(); }
}

async function until(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (check()) return;
        await Bun.sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
}

test("a real todowrite call projects a synthetic reminder on priced and cached OC2 passes", async () => {
    const fixture = isolation();
    fixture.env.MAGIC_CONTEXT_LOG_PATH = join(fixture.root, "todo-transform.log");
    const probe = join(fixture.root, "native-todowrite");
    mkdirSync(probe);
    // AFT-like extra tool: OpenCode 2 does not ship its own native todowrite.
    writeFileSync(join(probe, "server.js"), `export default {
        id: "native-todowrite-fixture", async setup(context) {
            await context.tool.transform(editor => editor.add({
                name: "todowrite", description: "Record the current todo list",
                input: { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: {
                    content: { type: "string" }, status: { type: "string" }, priority: { type: "string" }
                }, required: ["content", "status", "priority"] } } }, required: ["todos"] },
                options: { codemode: false }, async execute(input) { return { content: JSON.stringify(input.todos) }; }
            }));
        }
    };`);
    let host: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
    try {
        host = await spawnOpencode2({
            existingIsolation: fixture,
            probePlugin: probe,
            additionalModelIDs: ["mock-model-alt"],
            modelContextLimit: 100_000,
            modelOutputLimit: 1024,
            compactionAuto: false,
            magicContextConfig: { execute_threshold_percentage: 20, historian: { disable: true },
                dreamer: { disable: true }, memory: { enabled: false } },
        });
        const mock = host.mock;
        mock.setDefault({ text: "ok", usage: { input_tokens: 1000, output_tokens: 20 } });
        let issued = false;
        mock.addMatcher((body) => {
            const wire = JSON.stringify(body);
            if (issued || !wire.includes("record the todo state") || !wire.includes('"name":"todowrite"')) return null;
            issued = true;
            return { openaiOutput: [{ type: "function_call", id: "fc_todo_fixture", call_id: "call_todo_fixture",
                name: "todowrite", arguments: JSON.stringify({ todos }) }],
                usage: { input_tokens: 1000, output_tokens: 20 } };
        });
        const client = OpenCode.make({ baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        const session = await client.session.create({ location: { directory: fixture.cwd },
            model: { providerID: "openai", id: "mock-model" } });
        await waitForPluginActive(client, fixture.cwd);
        await client.session.prompt({ sessionID: session.id, text: "record the todo state" });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
        expect(issued).toBe(true);
        const contextPath = join(fixture.env.XDG_DATA_HOME!, "cortexkit", "magic-context", "context.db");
        await until(() => todoState(contextPath, session.id).includes("Finish the fixture"), "persisted todowrite state");
        // The priced pass must be one that really loses the provider's cached
        // prefix. Switching the model does: the provider cache is per model, so
        // the next pass runs a HARD fold for model_change and every mutation
        // lane, the synthetic todo included, may ride it. A fold that only
        // re-renders the prefix byte-identically (for example a render-config
        // marker change with nothing new to render) keeps the cache alive and
        // correctly withholds the synthetic todo, so it cannot serve as the
        // priced pass here.
        await client.session.switchModel({ sessionID: session.id,
            model: { providerID: "openai", id: "mock-model-alt" } });
        await client.session.prompt({ sessionID: session.id, text: "use the todo reminder" });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
        let callID = "";
        await until(() => {
            const pricedDb = openTestDb(contextPath, { readonly: true });
            try {
                callID = (pricedDb.prepare("SELECT todo_synthetic_call_id AS callId FROM session_meta WHERE session_id = ?")
                    .get(session.id) as { callId: string } | undefined)?.callId ?? "";
                return /^mc_synthetic_todo_[0-9a-f]{16}$/.test(callID);
            } finally { pricedDb.close(); }
        }, "persisted synthetic todo anchor on the priced pass");
        // The log is flushed asynchronously, so wait for the priced pass's fold
        // decision rather than reading the file once. The model switch also
        // changes the system prompt hash, so either cache-losing reason may be
        // the one the fold reports.
        const pricedFold = /HARD fold decision: reason=(model_change|system_hash) executed=true bustsServedPrefix=true/;
        let pricedLog = "";
        await until(() => pricedFold.test(pricedLog = readFileSync(fixture.env.MAGIC_CONTEXT_LOG_PATH, "utf8")),
            "a HARD fold that busts the served prefix on the priced pass");
        await client.session.prompt({ sessionID: session.id, text: "replay the todo reminder" });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
        const replayed = host.mock.requests().filter((request) =>
            JSON.stringify(request.body).includes(callID));
        expect(replayed.length).toBeGreaterThanOrEqual(2);
        // Every request that carries the anchor carries the same synthetic
        // reminder bytes: the priced pass projects it once, later passes replay it.
        const anchorItems = replayed.map((request) => {
            const body = request.body as { input?: unknown[]; messages?: unknown[] };
            const items = body.input ?? body.messages ?? [];
            return JSON.stringify(items.filter((item) => JSON.stringify(item).includes(callID)));
        });
        expect(anchorItems[0]).not.toBe("[]");
        expect(new Set(anchorItems).size).toBe(1);
        // The replay pass after the priced pass must be served from cache.
        await until(() => readFileSync(fixture.env.MAGIC_CONTEXT_LOG_PATH, "utf8").slice(pricedLog.length)
            .includes("rematerialized=false, reason=cache_hit"), "a cache-hit replay pass after the priced pass");
        const schemaTrace = readFileSync(join(fixture.root, "llm-schema-guard.jsonl"), "utf8");
        expect(schemaTrace.split("\n").filter((line) => line.startsWith(`PASS ${session.id} `)).length).toBeGreaterThanOrEqual(3);
    } finally {
        if (host) await host.stopHost();
    }
}, 180_000);
