import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { isolation, inspectOpenFiles, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

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
