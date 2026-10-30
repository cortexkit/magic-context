import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { readCachedM0ToolDefinitionsHash, withCachedM0ToolDefinitionsHash } from "../../../plugin/src/hooks/magic-context/compartment-render-epoch";
import {
    inspectOpenFiles,
    isolation,
    readPluginLog,
    spawnOpencode2,
    waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

type Body = { tools?: unknown; system?: unknown; messages: unknown[] };
// The host moves cache breakpoints with the growing tail; compare prompt bytes
// independently of where the next request asks the provider to stop caching.
const wire = (value: unknown) => JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item);
const filler = "alpha bravo charlie delta echo foxtrot golf hotel india juliet ".repeat(400);

test.each([
    ["transient duplicate names", "Café reads files", "Café reads files", true, true],
    ["leading/trailing whitespace", "Café reads files", "  Café reads files  ", false, true],
    ["Unicode normalization", "Café reads files", "Cafe\u0301 reads files", false, true],
    ["line ending normalization", "Café reads\nfiles", "Café reads\r\nfiles", false, true],
    ["unregistered request tool", "Café reads files", "Read the entire file", false, false],
] as const)("OC2 independent tool witness: %s follows provider bytes", async (label, beforeDescription, afterDescription, transient, registered) => {
    const fixture = isolation();
    const control = join(fixture.root, "identity-control.json");
    writeFileSync(control, JSON.stringify({ description: beforeDescription, transient: false }));
    const plugin = join(fixture.root, "identity-review");
    mkdirSync(plugin);
    writeFileSync(join(fixture.cwd, "ARCHITECTURE.md"), "# Frozen normalized tools witness\n".repeat(20));
    writeFileSync(join(plugin, "server.js"), `
        import { readFileSync } from "node:fs";
        export default { id: "identity-review", async setup(context) {
            if (${JSON.stringify(registered)}) await context.tool.transform(editor => editor.add({
                name: "issue819_probe", description: ${JSON.stringify(beforeDescription)},
                input: { type: "object", properties: {} }, options: { codemode: false },
                async execute() { return { content: "probe" }; }
            }));
            await context.session.hook("context", draft => {
                const value = JSON.parse(readFileSync(${JSON.stringify(control)}, "utf8"));
                const definition = { description: value.description, input: { type: "object", properties: {} } };
                draft.tools.issue819_probe = definition;
                if (value.transient) {
                    draft.tools.issue819_probe = { ...definition, description: "Shadowed duplicate" };
                    draft.tools.issue819_probe = definition;
                    draft.tools.issue819_transient = definition;
                    delete draft.tools.issue819_transient;
                }
            });
        }};
    `);
    const host = await spawnOpencode2({ existingIsolation: fixture, prePlugin: plugin,
        providerID: "anthropic", defaultModelID: "claude-sonnet-5-5",
        modelContextLimit: 200_000, modelOutputLimit: 1024, compactionAuto: false,
        magicContextConfig: { cache_ttl: "13h", protected_tokens: 4000,
            historian: { disable: true }, dreamer: { disable: true } },
    });
    const db = new Database(join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
    db.exec("PRAGMA busy_timeout = 10000");
    try {
        const client = OpenCode.make({ baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        const session = await client.session.create({ location: { directory: host.cwd },
            model: { providerID: "anthropic", id: "claude-sonnet-5-5" } });
        await waitForPluginActive(client, host.cwd);
        const turn = async (): Promise<Body> => {
            const before = host.mock.requests().length;
            await client.session.prompt({ sessionID: session.id, text: "Observe the effective tool map." });
            await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
            const requests = host.mock.requests().slice(before).filter(request => request.body.model === "claude-sonnet-5-5");
            expect(requests).toHaveLength(1);
            return requests[0]!.body as Body;
        };
        await turn();
        const previous = await turn();
        if (registered) {
            expect(wire(previous.tools)).toContain("issue819_probe");
            expect((previous.tools as Array<{ name: string; description: string }>).find(tool => tool.name === "issue819_probe")?.description).toBe(beforeDescription);
        } else {
            expect(wire(previous.tools)).not.toContain("issue819_probe");
        }
        expect(wire(previous.messages)).toContain("Frozen normalized tools witness");
        const since = readPluginLog(host.env).length;
        writeFileSync(join(fixture.cwd, "ARCHITECTURE.md"), "# New docs require a genuine tool bust\n".repeat(20));
        writeFileSync(control, JSON.stringify({ description: afterDescription, transient }));
        const changed = await turn();
        const sameTools = wire(changed.tools) === wire(previous.tools);
        const folds = readPluginLog(host.env).slice(since).split("\n").filter(line =>
            line.includes(`[${session.id}]`) && line.includes("m[0] HARD fold decision:") && line.includes("executed=true"));
        const publishedNewDocs = wire(changed.messages).includes("New docs require a genuine tool bust");
        console.log("TOOL_CACHE_DESCRIPTION_WITNESS", JSON.stringify({ label, sameTools, folds, publishedNewDocs }));
        expect(folds).toHaveLength(sameTools ? 0 : 1);
        expect(publishedNewDocs).toBe(!sameTools);
        if (!sameTools) expect(folds[0]).toContain("reason=tool_definitions");
        const replay = await turn();
        expect(wire(replay.tools)).toBe(wire(changed.tools));
        expect(wire(replay.messages.slice(0, changed.messages.length))).toBe(wire(changed.messages));
    } finally {
        db.close();
        await host.stop();
    }
}, 180_000);

test("OC2 session request tools fold once, draining held drops on the changed request without affecting another session", async () => {
    const fixture = isolation();
    fixture.env.TMPDIR = join(fixture.root, "tmp");
    mkdirSync(fixture.env.TMPDIR);
    const control = join(fixture.root, "tools.json");
    writeFileSync(control, "{}");
    const prePlugin = join(fixture.root, "request-tools");
    mkdirSync(prePlugin);
    writeFileSync(join(prePlugin, "server.js"), `
        import { readFileSync, writeFileSync } from "node:fs";
        export default { id: "request-tools", async setup(context) {
            writeFileSync(${JSON.stringify(join(fixture.root, "projection-surface.json"))}, JSON.stringify({
                context: Object.keys(context), model: Object.keys(context.model), session: Object.keys(context.session)
            }));
            await context.session.hook("context", draft => {
                const definitions = JSON.parse(readFileSync(${JSON.stringify(control)}, "utf8"));
                const disabledTool = definitions[draft.sessionID];
                if (disabledTool) delete draft.tools[disabledTool];
            });
        }};
    `);
    writeFileSync(join(fixture.cwd, "ARCHITECTURE.md"), "# Fixture\nOriginal frozen project docs.\n".repeat(20));
    const host = await spawnOpencode2({
        existingIsolation: fixture,
        prePlugin,
        providerID: "anthropic",
        defaultModelID: "claude-sonnet-5-5",
        modelContextLimit: 200_000,
        modelOutputLimit: 1024,
        compactionAuto: false,
        magicContextConfig: {
            cache_ttl: "13h",
            protected_tokens: 4000,
            historian: { disable: true },
            dreamer: { disable: true },
        },
        mockResponse: { text: "fixture reply", usage: { input_tokens: 100, output_tokens: 10 } },
    });
    const db = new Database(join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
    db.exec("PRAGMA busy_timeout = 10000");
    try {
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        const create = () => client.session.create({
            location: { directory: host.cwd }, model: { providerID: "anthropic", id: "claude-sonnet-5-5" },
        });
        const a = await create();
        const b = await create();
        await waitForPluginActive(client, host.cwd);
        expect(db.query("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 95 });
        const databases = inspectOpenFiles(host.pid!, host.root, host.env).filter(path => /\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(path));
        expect(databases.length).toBeGreaterThan(0);
        expect(databases.every(path => path.startsWith(host.root + "/"))).toBe(true);
        console.log("TOOL_CACHE_HOST_DATABASES", JSON.stringify({ pid: host.pid, databases }));
        console.log("TOOL_CACHE_RUNNING_HOST_API", readFileSync(join(fixture.root, "projection-surface.json"), "utf8"));
        const turn = async (id: string, text: string): Promise<Body> => {
            const before = host.mock.requests().length;
            await client.session.prompt({ sessionID: id, text });
            await client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(30_000) });
            const requests = host.mock.requests().slice(before).filter(request => request.body.model === "claude-sonnet-5-5");
            expect(requests).toHaveLength(1);
            return requests[0]!.body as Body;
        };
        const meta = (id: string) => {
            const row = db.query("SELECT cached_m0_materialized_at AS at, cached_m0_upgrade_state AS identity FROM session_meta WHERE session_id = ?").get(id) as { at: number; identity: string | null };
            return { at: row.at, hash: readCachedM0ToolDefinitionsHash(row.identity) };
        };
        const pending = () => db.query("SELECT tag_id FROM pending_ops WHERE session_id = ?").all(a.id);
        const head = (body: Body) => wire(body.messages.flatMap(message => {
            const content = (message as { content?: unknown }).content;
            return Array.isArray(content) ? content.filter(part => typeof part?.text === "string" && /<session-history[>\s-]/.test(part.text)) : [];
        }));
        await turn(a.id, `DROP-819 ${filler}`);
        const baseline = await turn(a.id, `Keep this recent working set: ${filler}`);
        writeFileSync(control, JSON.stringify({ [b.id]: "ctx_expand" }));
        const second = await turn(b.id, "ISOLATION-819");
        const bMarker = meta(b.id);
        expect(wire(second.tools)).not.toBe(wire(baseline.tools));

        // Simulate an upgraded session: it has frozen message bytes but no new
        // comparison marker. The first observation must neither fold nor drain.
        const beforeUpgrade = db.query("SELECT cached_m0_upgrade_state AS identity FROM session_meta WHERE session_id = ?").get(a.id) as { identity: string | null };
        db.query("UPDATE session_meta SET cached_m0_upgrade_state = ? WHERE session_id = ?").run(withCachedM0ToolDefinitionsHash(beforeUpgrade.identity, null), a.id);
        const target = db.query("SELECT tag_id FROM source_contents WHERE session_id = ? AND content LIKE '%DROP-819%' ORDER BY tag_id LIMIT 1").get(a.id) as { tag_id: number };
        expect(target).not.toBeNull();
        db.query("INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', ?, 'opencode2')").run(a.id, target.tag_id, Date.now());
        writeFileSync(join(fixture.cwd, "ARCHITECTURE.md"), "# Fixture\nNew docs ride the next natural hard fold.\n".repeat(20));
        const at = meta(a.id).at;
        const upgraded = await turn(a.id, "UPGRADED-819");
        expect(head(upgraded)).toBe(head(baseline));
        expect(wire(upgraded.tools)).toBe(wire(baseline.tools));
        expect(meta(a.id).at).toBe(at);
        expect(meta(a.id).hash).toBeString();
        expect(pending()).toHaveLength(1);
        expect(wire(upgraded.messages)).toContain("DROP-819 alpha");
        const unchanged = await turn(a.id, "UNCHANGED-819");
        expect(head(unchanged)).toBe(head(baseline));
        expect(meta(a.id).at).toBe(at);
        expect(pending()).toHaveLength(1);
        const beforeChange = readPluginLog(host.env).length;
        writeFileSync(control, JSON.stringify({
            [a.id]: "ctx_search",
            [b.id]: "ctx_expand",
        }));
        const changed = await turn(a.id, "CHANGED-819");
        const changedMarker = meta(a.id);
        expect(wire(changed.tools)).not.toBe(wire(unchanged.tools));
        expect(head(changed)).not.toBe(head(unchanged));
        expect(head(changed)).toContain("New docs ride the next natural hard fold");
        expect(wire(changed.messages)).not.toContain("DROP-819 alpha");
        expect(pending()).toHaveLength(0);
        expect(changedMarker.at).toBeGreaterThan(at);
        const again = await turn(a.id, "AFTER-819-1");
        const last = await turn(a.id, "AFTER-819-2");
        for (const body of [again, last]) {
            expect(head(body)).toBe(head(changed));
            expect(wire(body.tools)).toBe(wire(changed.tools));
            expect(wire(body.system)).toBe(wire(changed.system));
        }
        // Each later request extends exactly the message prefix sent by the
        // previous one. There is no second cache rewrite for the held drop.
        expect(wire(again.messages.slice(0, changed.messages.length))).toBe(wire(changed.messages));
        expect(wire(last.messages.slice(0, again.messages.length))).toBe(wire(again.messages));
        expect(meta(a.id)).toEqual(changedMarker);
        const secondAfter = await turn(b.id, "ISOLATION-819-AFTER");
        expect(head(secondAfter)).toBe(head(second));
        expect(wire(secondAfter.tools)).toBe(wire(second.tools));
        expect(meta(b.id)).toEqual(bMarker);
        const folds = readPluginLog(host.env).slice(beforeChange).split("\n").filter(line => line.includes(`[${a.id}]`) && line.includes("m[0] HARD fold decision:") && line.includes("executed=true"));
        expect(folds).toHaveLength(1);
        expect(folds[0]).toContain("reason=tool_definitions");
        const diagnostic = readPluginLog(host.env).slice(beforeChange).split("\n").filter(line => line.includes(`[${a.id}]`) && line.includes("m[0] request tool definitions changed:"));
        expect(diagnostic).toHaveLength(1);
        expect(diagnostic[0]).toContain("ctx_search");
        console.log("TOOL_CACHE_PREFIX_PROOF", JSON.stringify({
            folds, diagnostic, queuedBefore: 1, queuedAfter: pending().length,
            prefixChanged: head(changed) !== head(unchanged),
            followupsIdentical: head(again) === head(changed) && head(last) === head(changed),
            isolatedSessionUnchanged: meta(b.id).at === bMarker.at,
        }));
    } catch (error) {
        console.error(host.stderr(), readPluginLog(host.env).slice(-12_000));
        throw error;
    } finally {
        db.close();
        await host.stop();
    }
}, 180_000);

test.each(["normalized_schema", "later_plugin"] as const)(
    "OC2 tool identity follows final provider bytes: %s",
    async (scenario) => {
        const fixture = isolation();
        const control = join(fixture.root, "change-tools.json");
        writeFileSync(control, "false");
        const plugin = join(fixture.root, "tool-byte-review");
        mkdirSync(plugin);
        writeFileSync(join(plugin, "server.js"), `
            import { readFileSync } from "node:fs";
            export default { id: "tool-byte-review", async setup(context) {
                await context.session.hook("context", draft => {
                    const changed = JSON.parse(readFileSync(${JSON.stringify(control)}, "utf8"));
                    if (${JSON.stringify(scenario)} === "normalized_schema") {
                        draft.tools.ctx_search.input = changed
                            ? { type: "object", properties: {} }
                            : { properties: {} };
                    } else if (changed) {
                        delete draft.tools.ctx_search;
                    }
                });
            }};
        `);
        writeFileSync(join(fixture.cwd, "ARCHITECTURE.md"), "# Before tool change\n".repeat(20));
        const host = await spawnOpencode2({
            existingIsolation: fixture,
            ...(scenario === "later_plugin" ? { probePlugin: plugin, additionalModelIDs: ["claude-opus-5-5"] } : { prePlugin: plugin }),
            providerID: "anthropic",
            defaultModelID: "claude-sonnet-5-5",
            modelContextLimit: 200_000,
            modelOutputLimit: 1024,
            compactionAuto: false,
            magicContextConfig: {
                cache_ttl: "13h", protected_tokens: 4000,
                historian: { disable: true }, dreamer: { disable: true },
            },
        });
        const db = new Database(join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
        db.exec("PRAGMA busy_timeout = 10000");
        try {
            const client = OpenCode.make({ baseUrl: host.url,
                headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
            const session = await client.session.create({ location: { directory: host.cwd },
                model: { providerID: "anthropic", id: "claude-sonnet-5-5" } });
            await waitForPluginActive(client, host.cwd);
            const turn = async (text: string): Promise<Body> => {
                const before = host.mock.requests().length;
                await client.session.prompt({ sessionID: session.id, text });
                await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
                const requests = host.mock.requests().slice(before).filter(request => request.body.model === "claude-sonnet-5-5");
                expect(requests).toHaveLength(1);
                return requests[0]!.body as Body;
            };
            await turn("Establish the frozen baseline.");
            const baseline = await turn("Keep the baseline steady.");
            const since = readPluginLog(host.env).length;
            writeFileSync(join(fixture.cwd, "ARCHITECTURE.md"), "# New docs must ride a genuine tool bust\n".repeat(20));
            writeFileSync(control, "true");
            const changed = await turn("Observe the tool change.");
            const folds = readPluginLog(host.env).slice(since).split("\n").filter(line =>
                line.includes(`[${session.id}]`) && line.includes("m[0] HARD fold decision:") && line.includes("executed=true"));
            const toolBytesEqual = wire(changed.tools) === wire(baseline.tools);
            console.log("TOOL_CACHE_EXACTNESS_WITNESS", JSON.stringify({ scenario, toolBytesEqual, folds }));
            if (scenario === "normalized_schema") {
                // OpenCode adds the tool schema's missing object root before sending.
                // Identical provider tools cannot justify serving new ARCHITECTURE.md content.
                expect(toolBytesEqual).toBe(true);
                expect(wire(changed.messages)).not.toContain("New docs must ride a genuine tool bust");
                expect(folds).toHaveLength(0);
            } else {
                // The name/description policy accepts this ordering limit:
                // a context plugin after Magic Context is invisible to its trigger.
                // The waiting docs must stay frozen until a natural rebuild.
                expect(toolBytesEqual).toBe(false);
                expect(folds).toHaveLength(0);
                expect(wire(changed.messages)).not.toContain("New docs must ride a genuine tool bust");
                const naturalStart = readPluginLog(host.env).length;
                await client.session.switchModel({ sessionID: session.id,
                    model: { providerID: "anthropic", id: "claude-opus-5-5" } });
                const naturalTurn = async (text: string): Promise<Body> => {
                    const before = host.mock.requests().length;
                    await client.session.prompt({ sessionID: session.id, text });
                    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
                    const requests = host.mock.requests().slice(before).filter(request => request.body.model === "claude-opus-5-5");
                    expect(requests).toHaveLength(1);
                    return requests[0]!.body as Body;
                };
                const rebuilt = await naturalTurn("A model switch supplies the next natural rebuild.");
                expect(wire(rebuilt.messages)).toContain("New docs must ride a genuine tool bust");
                const next = await naturalTurn("Keep the rebuilt prefix steady.");
                expect(wire(next.messages.slice(0, rebuilt.messages.length))).toBe(wire(rebuilt.messages));
                const naturalFolds = readPluginLog(host.env).slice(naturalStart).split("\n").filter(line =>
                    line.includes(`[${session.id}]`) && line.includes("m[0] HARD fold decision:") && line.includes("executed=true"));
                expect(naturalFolds).toHaveLength(1);
                expect(naturalFolds[0]).toContain("reason=model_change");
            }
        } finally {
            db.close();
            await host.stop();
        }
    }, 180_000,
);
