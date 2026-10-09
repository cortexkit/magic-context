import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createIsolatedEnv, PLUGIN_ENTRY } from "../src/opencode-runner/spawn";
import { RustTestHarness, stableSerialize } from "../src/rust-harness";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
type Block = { type?: string; tool_use_id?: string; text?: string; content?: Block[] | string; source?: { data?: string } };
function screenshot(body: { messages?: Array<{ content: unknown }> }): Block {
    return body.messages!.flatMap(m => Array.isArray(m.content) ? m.content as Block[] : [])
        .find(b => b.type === "tool_result" && b.tool_use_id === "upgrade-screen")!;
}

test("Rust real-host adapter upgrade defers losslessly then restores once on flush", async () => {
    const taskRoot = join(tmpdir(), "magic-context", "rust-tool-attachment-upgrade");
    mkdirSync(taskRoot, { recursive: true });
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = taskRoot;
    const env = createIsolatedEnv();
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    const root = dirname(env.dataDir);
    expect(realpathSync(root).startsWith(realpathSync(taskRoot) + "/")).toBe(true);
    const pluginRoot = resolve(import.meta.dir, "../../plugin");
    // Compile the real host plugin with only the historical projection expression.
    // This is the old adapter, not a fabricated provider response or edited store.
    const oldEntry = join(root, "old-adapter.js");
    const built = await Bun.build({
        entrypoints: [join(pluginRoot, "src/index.ts")], target: "node", format: "esm",
        external: ["@opencode-ai/plugin", "onnxruntime-node", "onnxruntime-web", "sharp", "bun:sqlite", "node:sqlite"],
        plugins: [{ name: "historical-tool-projection", setup(builder) {
            builder.onLoad({ filter: /module-wire\.ts$/ }, ({ path }) => {
                const source = readFileSync(path, "utf8");
                const call = "output: moduleToolOutput(part, state, output),";
                expect(source.split(call)).toHaveLength(2);
                return { loader: "ts", contents: source.replace(call,
                    'output: { kind: { type: state.status === "error" ? "error_text" : "text", text: output } },') };
            });
        } }],
    });
    expect(built.success).toBe(true);
    writeFileSync(oldEntry, await built.outputs[0]!.text());
    // Bare package imports in the temporary bundle resolve to this worktree's dependencies.
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(pluginRoot, "node_modules"), join(root, "node_modules"), "dir");
    const fixture = join(root, "screenshot-tool.ts");
    const toolModule = join(pluginRoot, "node_modules/@opencode-ai/plugin/dist/tool.js");
    writeFileSync(fixture, `import { tool } from ${JSON.stringify(toolModule)};
        export default async () => ({ tool: { attachment_probe: tool({ description: "Screenshot", args: {}, async execute() {
            return { output: "UPGRADE_SCREEN screenshot", attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,${PNG}", filename: "upgrade.png" }] };
        } }) } });`);
    const config = { execute_threshold_percentage: 80, output_reserve: 0,
        historian: { disable: true }, dreamer: { disable: true }, memory: { enabled: false }, embedding: { provider: "off" } };
    console.log(`OpenCode ${execFileSync("timeout", ["10s", "opencode", "--version"], { encoding: "utf8" }).trim()}, Bun ${Bun.version}`);
    const previousEntry = process.env.MC_E2E_PLUGIN_ENTRY;
    process.env.MC_E2E_PLUGIN_ENTRY = oldEntry;
    let h: RustTestHarness | undefined;
    try {
        h = await RustTestHarness.create({ existingEnv: env, startHistorianProducer: false,
            modelContextLimit: 100_000, magicContextConfig: config,
            openCodeConfigExtra: { plugin: [`file://${oldEntry}`, `file://${fixture}`] } });
        const containment = () => {
            const inventory = execFileSync("timeout", ["10s", "lsof", "-nP", "-p", String(h!.opencode.pid), "-Fn"], { encoding: "utf8" });
            const paths = inventory.split("\n").filter(line => /^n.*\.(db|sqlite)(-(wal|shm))?$/.test(line)).map(line => line.slice(1));
            expect(paths.length).toBeGreaterThan(0);
            expect(paths.every(path => path.startsWith(root + "/"))).toBe(true);
            writeFileSync(join(taskRoot, `upgrade-lsof-${h!.opencode.pid}.txt`), inventory);
            console.log(`upgrade host ${h!.opencode.pid} lsof: ${JSON.stringify(paths)}`);
        };
        containment();
        let issued = false;
        h.mock.addMatcher(body => {
            if (JSON.stringify(body.system).includes("title generator")) return { text: "Upgrade", usage: { input_tokens: 100, output_tokens: 5 } };
            if (!issued && JSON.stringify(body.messages).includes("UPGRADE_FIRST")) {
                issued = true;
                return { content: [{ type: "tool_use", id: "upgrade-screen", name: "attachment_probe", input: {} }],
                    stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 100 } };
            }
            return { text: "Inspected", usage: { input_tokens: 1000, output_tokens: 20 } };
        });
        const id = await h.createSession();
        await h.sendPrompt(id, "UPGRADE_FIRST inspect the screenshot");
        const beforeUpgrade = await h.waitForRustPasses(2);
        expect(beforeUpgrade.at(-1)!.raw).toContain("prefix_bust_permitted=false");
        const old = screenshot(h.mainRequests().at(-1)!.body);
        expect(old).toBeDefined();
        // Anthropic's SDK encodes the old, text-only result as a scalar string.
        expect(typeof old.content).toBe("string");
        expect(old.content).toMatch(/^§\d+§ UPGRADE_SCREEN screenshot/);
        const oldBytes = stableSerialize(old);
        process.env.MC_E2E_PLUGIN_ENTRY = PLUGIN_ENTRY;
        // Keep the tool schema unchanged across restart: removing the fixture
        // would independently authorize a tools-fingerprint rebuild.
        await h.restart({ magicContextConfig: config,
            openCodeConfigExtra: { plugin: [`file://${PLUGIN_ENTRY}`, `file://${fixture}`] } });
        containment();
        for (let pass = 0; pass < 3; pass++) {
            await h.sendPrompt(id, `UPGRADE_DEFER_${pass} continue`);
            const served = await h.waitForRustPasses(beforeUpgrade.length + pass + 1);
            expect(served.at(-1)!.raw).toContain("prefix_bust_permitted=false");
            expect(stableSerialize(screenshot(h.mainRequests().at(-1)!.body))).toBe(oldBytes);
        }
        const deferred = await h.waitForRustPasses(3);
        expect(deferred.slice(-3).every(p => / scheduler=defer(?: |$)/.test(p.raw))).toBe(true);
        // Use the public module management API behind /ctx-flush. Its acknowledged
        // arm is independent bust permission; an HTTP 204 from the host command
        // endpoint only acknowledges asynchronous delivery, not completion.
        const flush = await h.subc.moduleRequest(id, env.workdir, { method: "session.flush" });
        expect(flush).toMatchObject({ ok: true, armed: true });
        await h.sendPrompt(id, "UPGRADE_REBUILD restore on the flush");
        const rebuilt = await h.waitForRustPasses(deferred.length + 1);
        expect(rebuilt.at(-1)!.raw).toContain("prefix_bust_permitted=true");
        const restored = screenshot(h.mainRequests().at(-1)!.body);
        expect(Array.isArray(restored.content)).toBe(true);
        const content = restored.content as Block[];
        expect(content.filter(b => b.type === "image")).toHaveLength(1);
        expect(content.find(b => b.type === "image")!.source!.data).toBe(PNG);
        expect(content.some(b => b.type === "text" && /^§\d+§ /.test(b.text ?? ""))).toBe(true);
        const restoredBytes = stableSerialize(restored);
        for (let pass = 0; pass < 3; pass++) {
            await h.sendPrompt(id, `UPGRADE_REPLAY_${pass} continue`);
            expect(stableSerialize(screenshot(h.mainRequests().at(-1)!.body))).toBe(restoredBytes);
        }
        const replayed = await h.waitForRustPasses(deferred.length + 4);
        expect(replayed.slice(-3).every(p => / scheduler=defer(?: |$)/.test(p.raw))).toBe(true);
        expect(replayed.every(p => p.decision !== "error" && p.decision !== "parked")).toBe(true);
        console.log(`upgrade Rust passes: ${replayed.map(p => p.raw).join("\n")}`);
        containment();
    } catch (error) {
        if (h) {
            console.error(`upgrade failed Rust passes: ${JSON.stringify(h.readRustPasses())}`);
            console.error(h.diagnosticLog());
            console.error(h.opencode.stderr());
        }
        throw error;
    } finally {
        if (previousEntry === undefined) delete process.env.MC_E2E_PLUGIN_ENTRY; else process.env.MC_E2E_PLUGIN_ENTRY = previousEntry;
        await h?.dispose();
    }
}, 600_000);
