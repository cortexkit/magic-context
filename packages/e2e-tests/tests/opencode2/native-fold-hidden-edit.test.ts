import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { CHECKPOINT_NOTE } from "../../../plugin/src/v2/fold/summary";
import { CLI, isolation, inspectOpenFiles, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

test("a hidden row edited in place expires cold fold provenance and rebuilds once through the shared gate", async () => {
    const fixture = isolation();
    fixture.env.MC_OC2_HOST_FOLD_ROWS = "999999";
    const options = { existingIsolation: fixture, compactionAuto: false, modelContextLimit: 100000, modelOutputLimit: 1024,
        magicContextConfig: { cache_ttl: "never", protected_tokens: 4000, historian: { disable: true }, dreamer: { disable: true }, memory: { enabled: false } } };
    let host = await spawnOpencode2(options);
    const clientFor = () => OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
    let client = clientFor();
    const samples: unknown[] = [];
    const sample = () => {
        const paths = inspectOpenFiles(host.pid!, fixture.root, host.env).filter(path => /\.db(?:-wal|-shm)?$/.test(path));
        expect(paths.length).toBeGreaterThan(0);
        expect(paths.every(path => path.startsWith(fixture.root + "/"))).toBe(true);
        samples.push({ pid: host.pid, paths });
    };
    try {
        await waitForPluginActive(client, fixture.cwd);
        const session = await client.session.create({ title: "hidden-row edit", location: { directory: fixture.cwd }, model: { providerID: "openai", id: "mock-model" } });
        const turn = async (text: string) => {
            const count = host.mock.requests().length;
            await client.session.prompt({ sessionID: session.id, text });
            await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60000) });
            const request = host.mock.requests().slice(count).at(-1)!;
            expect(request).toBeDefined();
            return request;
        };
        for (let i = 0; i < 9; i++) await turn(`BEFORE_EDIT_${i}: ${"history ".repeat(150)}`);
        await client.session.compact({ sessionID: session.id });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60000) });
        const previous = await turn("warm compacted history");
        expect(JSON.stringify(previous.body.input)).toContain("BEFORE_EDIT_0");
        sample();
        await host.stopHost();
        host = await spawnOpencode2(options);
        client = clientFor();
        await waitForPluginActive(client, fixture.cwd);
        sample();
        const source = new Database(join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!));
        let changed: { id: string; data: string };
        try {
            changed = source.prepare("SELECT id, data FROM session_message WHERE session_id=? AND type='user' ORDER BY seq LIMIT 1").get(session.id) as typeof changed;
            const data = JSON.parse(changed.data); data.text = "AFTER_HIDDEN_EDIT";
            source.prepare("UPDATE session_message SET data=?, time_updated=time_updated+1 WHERE id=?").run(JSON.stringify(data), changed.id);
        } finally { source.close(); }
        const offset = host.pluginLog().length;
        const edited = await turn("first continuation after in-place edit");
        expect(JSON.stringify(edited.body.input)).toContain("AFTER_HIDDEN_EDIT");
        expect(JSON.stringify(edited.body.input)).not.toContain("BEFORE_EDIT_0");
        // The plugin buffers log writes for up to half a second, so the fold
        // decision logged during the turn just awaited may not be on disk yet.
        const foldDecision = /m\[0\] HARD fold decision:.*executed=true bustsServedPrefix=true/;
        const logDeadline = Date.now() + 5_000;
        while (!foldDecision.test(host.pluginLog().slice(offset)) && Date.now() < logDeadline) await Bun.sleep(100);
        expect(host.pluginLog().slice(offset)).toMatch(foldDecision);
        const defer = await turn("defer after edited history rebuild");
        expect(JSON.stringify((defer.body.input as unknown[]).slice(0, (edited.body.input as unknown[]).length))).toBe(JSON.stringify(edited.body.input));
        await host.stopHost();
        host = await spawnOpencode2(options);
        client = clientFor();
        await waitForPluginActive(client, fixture.cwd);
        sample();
        const restarted = await turn("restart after edited history rebuild");
        expect(JSON.stringify((restarted.body.input as unknown[]).slice(0, (defer.body.input as unknown[]).length))).toBe(JSON.stringify(defer.body.input));
        console.log("HIDDEN_EDIT_EVIDENCE_GZIP " + gzipSync(JSON.stringify({ version: process.env.MC_E2E_OPENCODE2_VERSION, root: fixture.root, changed, previous: previous.rawBody, edited: edited.rawBody, defer: defer.rawBody, restarted: restarted.rawBody, samples, log: host.pluginLog().slice(offset) })).toString("base64"));
    } finally { await host.stop(); }
}, 180000);

test("real instruction catalogs without wire ids retire only on a rebuilding pass", async () => {
    const fixture = isolation();
    fixture.env.MC_OC2_HOST_FOLD_ROWS = "999999";
    const control = join(fixture.root, "catalog-description.txt");
    const observed = join(fixture.root, "instruction-wire.json");
    writeFileSync(control, "CATALOG_INITIAL");
    const plugin = join(fixture.root, "catalog-producer");
    mkdirSync(plugin);
    writeFileSync(join(plugin, "server.js"), `
        import { readFileSync, writeFileSync } from "node:fs";
        export default { id: "catalog-producer", async setup(context) {
            await context.tool.transform(editor => {
                editor.namespace({ name: "catalog879", description: readFileSync(${JSON.stringify(control)}, "utf8") });
                editor.add({ name: "catalog879_probe", description: "Inspect the fixture catalog",
                    input: { type: "object", properties: {} }, options: { namespace: "catalog879", codemode: true },
                    async execute() { return { content: "fixture" }; }
                });
            });
            await context.session.hook("prompt", async () => { await context.tool.reload(); });
            await context.session.hook("context", draft => {
                writeFileSync(${JSON.stringify(observed)}, JSON.stringify(draft.messages.filter(message => message.role === "system")));
            });
        }};
    `);
    const host = await spawnOpencode2({ existingIsolation: fixture, prePlugin: plugin,
        compactionAuto: false, modelContextLimit: 302000, modelOutputLimit: 1024,
        additionalModelIDs: ["catalog-rebuild"],
        magicContextConfig: { cache_ttl: "never", protected_tokens: 4000,
            historian: { disable: true }, dreamer: { disable: true }, memory: { enabled: false } },
    });
    const client = OpenCode.make({ baseUrl: host.url,
        headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
    const source = new Database(join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!));
    const db = new Database(join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
    try {
        await waitForPluginActive(client, fixture.cwd);
        const session = await client.session.create({ location: { directory: fixture.cwd },
            model: { providerID: "openai", id: "mock-model" } });
        const turn = async (text: string) => {
            const start = host.mock.requests().length;
            await client.session.prompt({ sessionID: session.id, text });
            await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60000) });
            const requests = host.mock.requests().slice(start);
            const request = requests.at(-1);
            expect(request).toBeDefined();
            return request!;
        };
        await turn("Establish the cache.");
        writeFileSync(control, "CATALOG_FIRST_REPLACEMENT");
        await turn("Observe the first catalog.");
        writeFileSync(control, "CATALOG_SECOND_REPLACEMENT");
        const held = await turn("Observe another catalog without rebuilding.");
        const wire = (value: unknown) => JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item);
        expect(wire(held.body.input)).toContain("CATALOG_FIRST_REPLACEMENT");
        expect(wire(held.body.input)).toContain("CATALOG_SECOND_REPLACEMENT");
        const rows = source.prepare("SELECT id, data FROM session_message WHERE session_id=? AND type='system' ORDER BY seq").all(session.id) as Array<{ id: string; data: string }>;
        const catalogs = rows.filter(row => JSON.parse(row.data).metadata?.instructionSources?.includes("core/codemode"));
        expect(catalogs).toHaveLength(2);
        for (const row of catalogs) expect(JSON.parse(row.data).text).toStartWith("The Code Mode tool catalog has changed. This catalog supersedes the previous Code Mode tool catalog.");
        const incoming = JSON.parse(readFileSync(observed, "utf8")) as Array<{ id?: string; content: unknown }>;
        const incomingCatalogs = incoming.filter(message => wire(message.content).includes("CATALOG_"));
        expect(incomingCatalogs).toHaveLength(2);
        expect(incomingCatalogs.every(message => message.id === undefined)).toBe(true);
        const unchanged = await turn("Keep the same prefix.");
        expect(wire((unchanged.body.input as unknown[]).slice(0, (held.body.input as unknown[]).length))).toBe(wire(held.body.input));
        await client.session.switchModel({ sessionID: session.id, model: { providerID: "openai", id: "catalog-rebuild" } });
        const rebuilt = await turn("A model switch already rebuilds the prefix.");
        expect(wire(rebuilt.body.input)).not.toContain("CATALOG_FIRST_REPLACEMENT");
        expect(wire(rebuilt.body.input)).toContain("CATALOG_SECOND_REPLACEMENT");
        const lane = db.prepare("SELECT json_extract(trailing_blank_decisions, '$.instructionSupersession') AS ids FROM session_meta WHERE session_id=?").get(session.id) as { ids: string };
        expect(JSON.parse(lane.ids)).toEqual([catalogs[0]!.id]);
        const replay = await turn("Replay the retired catalog choice.");
        expect(wire((replay.body.input as unknown[]).slice(0, (rebuilt.body.input as unknown[]).length))).toBe(wire(rebuilt.body.input));
        const paths = inspectOpenFiles(host.pid!, fixture.root, host.env).filter(path => /\.db(?:-wal|-shm)?$/.test(path));
        expect(paths.length).toBeGreaterThan(0);
        expect(paths.every(path => path.startsWith(fixture.root + "/"))).toBe(true);
        console.log("INSTRUCTION_SUPERSESSION_HOST_EVIDENCE", JSON.stringify({
            version: process.env.MC_E2E_OPENCODE2_VERSION, root: fixture.root,
            storedIDs: catalogs.map(row => row.id), incomingIDsAbsent: incomingCatalogs.every(message => message.id === undefined),
            retiredIDs: JSON.parse(lane.ids), heldBoth: true, deferredPrefixIdentical: true,
            rebuildingKeptNewestOnly: true, replayPrefixIdentical: true, paths,
        }));
    } finally { source.close(); db.close(); await host.stop(); }
}, 180000);

// A minimal MCP server over stdio (newline-delimited JSON-RPC): it answers the
// initialize handshake with server instructions and lists fixed tools. The
// "stable" server lists enough tools with long descriptions to make OpenCode's
// Code Mode catalog partial, so every change to the connected servers restates
// the whole catalog, as it does for users with large MCP tool sets.
const TOY_MCP_SERVER = `
const name = process.argv[2];
const tools = name === "stable"
    ? Array.from({ length: 60 }, (_, i) => ({
        name: "lookup_" + String(i).padStart(2, "0"),
        description: "Look up stable fixture record " + i + " " + "with a deliberately long description ".repeat(4),
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
    }))
    : [{ name: "probe", description: "Probe the toggling fixture server", inputSchema: { type: "object", properties: {} } }];
const instructions = name.toUpperCase() + "_SERVER_GUIDANCE: use the " + name + " fixture tools.";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const results = {
    initialize: (params) => ({
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: { name, version: "1.0.0" },
        instructions,
    }),
    "tools/list": () => ({ tools }),
    "tools/call": () => ({ content: [{ type: "text", text: "fixture" }] }),
    "prompts/list": () => ({ prompts: [] }),
    "resources/list": () => ({ resources: [] }),
    "resources/templates/list": () => ({ resourceTemplates: [] }),
    ping: () => ({}),
};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\\n"); end >= 0; end = buffer.indexOf("\\n")) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === undefined) continue;
        const result = results[message.method];
        send(result
            ? { id: message.id, result: result(message.params) }
            : { id: message.id, error: { code: -32601, message: "Method not found" } });
    }
});
`;

test("MCP servers that connect and disconnect leave only the newest catalog row on every rebuild, including a post-compaction pass that rebuilds", async () => {
    const fixture = isolation();
    fixture.env.MC_OC2_HOST_FOLD_ROWS = "999999";
    const script = join(fixture.root, "toy-mcp.mjs");
    writeFileSync(script, TOY_MCP_SERVER);
    const server = (name: string) => ({ type: "local", command: [process.execPath, script, name] });
    const host = await spawnOpencode2({ existingIsolation: fixture,
        compactionAuto: false, modelContextLimit: 302000, modelOutputLimit: 1024,
        additionalModelIDs: ["catalog-rebuild"],
        extraConfig: { mcp: { servers: { stable: server("stable"), toggle: server("toggle") } } },
        magicContextConfig: { cache_ttl: "never", protected_tokens: 4000,
            historian: { two_pass: false }, dreamer: { disable: true }, memory: { enabled: false } },
    });
    // The historian publishes one compartment when /ctx-wrapup asks for it.
    const historianRequest = (body: unknown) => /Messages (\d+)-(\d+):/.test(JSON.stringify(body));
    host.mock.addMatcher((body: unknown) => {
        const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
        if (!range) return null;
        return { text: `<compartment start="${range[1]}" end="${range[2]}" title="Retained history"><p1>HIST_SUMMARY preserves the earlier work.</p1></compartment>`, usage: { input_tokens: 100, output_tokens: 40 } };
    });
    const client = OpenCode.make({ baseUrl: host.url,
        headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
    const location = { directory: fixture.cwd };
    const source = new Database(join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!));
    try {
        await waitForPluginActive(client, fixture.cwd);
        const status = async (name: string, want: string) => {
            const deadline = Date.now() + 30_000;
            for (;;) {
                const { data } = await client.mcp.list({ location });
                const found = data.find(entry => entry.name === name) as { status?: { status?: string } } | undefined;
                if (found?.status?.status === want) return;
                if (Date.now() > deadline) throw new Error(`MCP server ${name} never reached ${want}: ${JSON.stringify(data)}`);
                await Bun.sleep(100);
            }
        };
        await status("stable", "connected");
        await status("toggle", "connected");
        const session = await client.session.create({ location, model: { providerID: "openai", id: "mock-model" } });
        const turn = async (text: string) => {
            const start = host.mock.requests().length;
            await client.session.prompt({ sessionID: session.id, text });
            await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60000) });
            const request = host.mock.requests().slice(start).filter(candidate => !historianRequest(candidate.body)).at(-1);
            expect(request).toBeDefined();
            return request!;
        };
        const toggle = async (connect: boolean) => {
            if (connect) await client.mcp.connect({ server: "toggle", location });
            else await client.mcp.disconnect({ server: "toggle", location });
            await status("toggle", connect ? "connected" : "disabled");
            // OpenCode reloads its tool registry 100 ms after a server's tools
            // change; a prompt sent sooner still sees the previous catalog.
            await Bun.sleep(1000);
        };
        const wire = (value: unknown) => JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item);
        const replacement = "The Code Mode tool catalog has changed. This catalog supersedes the previous Code Mode tool catalog.";
        const copies = (request: { body: { input?: unknown } }) => wire(request.body.input).split(replacement).length - 1;
        const served: Record<string, number> = {};
        await turn("Establish the cache.");
        let connected = true;
        for (let i = 0; i < 6; i++) {
            connected = !connected;
            await toggle(connected);
            served[`toggle ${i}`] = copies(await turn(`Toggle ${i}: toggle server ${connected ? "connected" : "disconnected"}.`));
        }
        const rows = (source.prepare("SELECT id, data FROM session_message WHERE session_id=? AND type='system' ORDER BY seq").all(session.id) as Array<{ id: string; data: string }>)
            .map(row => ({ id: row.id, ...(JSON.parse(row.data) as { text: string; metadata?: { instructionSources?: string[] } }) }));
        await client.session.switchModel({ sessionID: session.id, model: { providerID: "openai", id: "catalog-rebuild" } });
        served["model switch rebuild"] = copies(await turn("A model switch already rebuilds the prefix."));
        for (let i = 6; i < 8; i++) {
            connected = !connected;
            await toggle(connected);
            served[`toggle ${i}`] = copies(await turn(`Toggle ${i}: toggle server ${connected ? "connected" : "disconnected"}.`));
        }
        // Publish history before compacting. With history to move into the
        // frozen head, a manual /compact rebuilds that head on every version, so
        // the pass after it is a rebuild that the catalog retirement can ride.
        for (let i = 0; i < 4; i++) await turn(`HISTORY_${i}: ${"durable history ".repeat(50)}`);
        await client.session.command({ sessionID: session.id, name: "ctx-wrapup", text: "2" });
        const historyDeadline = Date.now() + 60_000;
        for (;;) {
            const context = new Database(join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
            try {
                const { n } = context.prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id=?").get(session.id) as { n: number };
                const { state } = context.prepare("SELECT wrapup_in_progress_state AS state FROM session_meta WHERE session_id=?").get(session.id) as { state: string | null };
                if (n > 0 && !state) break;
            } finally { context.close(); }
            if (Date.now() > historyDeadline) throw new Error("the historian published no history");
            await Bun.sleep(100);
        }
        await client.session.command({ sessionID: session.id, name: "ctx-flush", text: "" });
        served["after flush"] = copies(await turn("Continue after publishing history."));
        for (let i = 8; i < 10; i++) {
            connected = !connected;
            await toggle(connected);
            served[`toggle ${i}`] = copies(await turn(`Toggle ${i}: toggle server ${connected ? "connected" : "disconnected"}.`));
        }
        await client.session.compact({ sessionID: session.id });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60000) });
        const compactLogStart = host.pluginLog().length;
        const afterFold = await turn("Continue after the host fold.");
        served["after host fold"] = copies(afterFold);
        // The plugin buffers its log for up to half a second.
        const permissionLine = /rewrite permission: allowed=(\w+) ride=(\S+)/;
        const logDeadline = Date.now() + 5_000;
        while (!permissionLine.test(host.pluginLog().slice(compactLogStart)) && Date.now() < logDeadline) await Bun.sleep(100);
        const compactLog = host.pluginLog().slice(compactLogStart);
        const permission = permissionLine.exec(compactLog);
        const postCompact = { rebuilt: permission?.[1] === "true", ride: permission?.[2] ?? "not logged",
            foldReason: /HARD fold decision: reason=(\S+)/.exec(compactLog)?.[1] ?? "none",
            headChanged: /host checkpoint head: changed=(\w+)/.exec(compactLog)?.[1] ?? "not logged" };
        const compaction = source.prepare("SELECT data FROM session_message WHERE session_id=? AND type='compaction' ORDER BY seq DESC LIMIT 1").get(session.id) as { data: string };
        const storedSummary = (JSON.parse(compaction.data) as { summary?: string }).summary;
        await client.session.switchModel({ sessionID: session.id, model: { providerID: "openai", id: "mock-model" } });
        served["rebuild after fold"] = copies(await turn("Switching back rebuilds the prefix again."));
        const hostVersion = spawnSync(CLI, ["--version"], { encoding: "utf8", env: fixture.env }).stdout.trim();
        console.log("ISSUE886_MCP_TOGGLE_EVIDENCE", JSON.stringify({
            version: hostVersion, root: fixture.root,
            rows: rows.map(row => ({ id: row.id, sources: row.metadata?.instructionSources,
                chars: row.text.length, mcp: row.text.slice(row.text.lastIndexOf("\n\n") + 2, row.text.lastIndexOf("\n\n") + 120) })),
            catalogCopiesServed: served, postCompact,
        }));
        expect(rows).toHaveLength(6);
        for (const [index, row] of rows.entries()) {
            expect(row.metadata?.instructionSources).toEqual(["core/codemode", "core/mcp-guidance"]);
            expect(row.text).toStartWith(`${replacement}\n\n# Code Mode\n`);
            expect(row.text.slice(row.text.lastIndexOf("\n\n") + 2)).toStartWith(index % 2 === 0
                ? "Instructions for the following MCP servers are no longer available: toggle."
                : "New MCP server instructions are available in addition to those previously listed:\n  <server name=\"toggle\">");
        }
        // Before the rebuild every row is served, so each change adds a copy.
        expect([0, 1, 2, 3, 4, 5].map(i => served[`toggle ${i}`])).toEqual([1, 2, 3, 4, 5, 6]);
        // A rebuild keeps only the newest restatement; later changes append until the next one.
        expect(served["model switch rebuild"]).toBe(1);
        expect([served["toggle 6"], served["toggle 7"]]).toEqual([2, 3]);
        // Publishing history is a flush, which rebuilds; later changes append again.
        expect(served["after flush"]).toBe(1);
        expect([served["toggle 8"], served["toggle 9"]]).toEqual([2, 3]);
        // The manual /compact moved the published history into the frozen head,
        // so the pass after it serves a new head on every version. That rebuild
        // is the ride the catalog retirement lands on. It does not depend on
        // whether OpenCode also changed its system prompt after compacting
        // (fold reason system_hash on some 2.0.22 and 2.1.0 runs).
        expect(postCompact).toMatchObject({ rebuilt: true, ride: "hardFold", headChanged: "true" });
        expect(served["after host fold"]).toBe(1);
        // The host stores Magic Context's fixed note as the checkpoint summary; the
        // request serves Magic Context's own history instead of that note.
        expect(storedSummary).toBe(CHECKPOINT_NOTE);
        expect(wire(afterFold.body.input)).not.toContain(CHECKPOINT_NOTE);
        expect(wire(afterFold.body.input)).toContain("HIST_SUMMARY");
        // On every version the next rebuild keeps only the newest catalog row.
        expect(served["rebuild after fold"]).toBe(1);
    } finally { source.close(); await host.stop(); }
}, 240000);
