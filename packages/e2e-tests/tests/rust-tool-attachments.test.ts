import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createIsolatedEnv, PLUGIN_ENTRY } from "../src/opencode-runner/spawn";
import { RustTestHarness, stableSerialize } from "../src/rust-harness";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n").toString("base64");
type Block = { type?: string; tool_use_id?: string; text?: string; content?: unknown; source?: { media_type?: string; data?: string } };

function result(request: { messages?: Array<{ content: unknown }> }, id: string): Block | undefined {
    return request.messages?.flatMap(message => Array.isArray(message.content) ? message.content as Block[] : []).find(block => block.type === "tool_result" && block.tool_use_id === id);
}

// This is a real OpenCode 1 host, plugin, daemon and module. The provider only records
// requests and scripts tool calls; it never fabricates the tool's resulting media.
test("Rust OpenCode 1 preserves tagged mock and read image/PDF attachments on first sight and defer replays", async () => {
    const taskRoot = join(tmpdir(), "magic-context", "rust-tool-attachments");
    mkdirSync(taskRoot, { recursive: true });
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = taskRoot;
    const env = createIsolatedEnv();
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    const root = dirname(env.dataDir);
    expect(realpathSync(root).startsWith(realpathSync(taskRoot) + "/")).toBe(true);
    const fixture = join(root, "attachment-tool.ts");
    const toolModule = resolve(import.meta.dir, "../../plugin/node_modules/@opencode-ai/plugin/dist/tool.js");
    writeFileSync(fixture, `import { tool } from ${JSON.stringify(toolModule)};
        export default async () => ({ tool: { attachment_probe: tool({ description: "Return a deterministic screenshot", args: {}, async execute() { return { output: "ATTACHMENT_PROBE screenshot", attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,${PNG}", filename: "probe.png" }] }; } }) } });`);
    const png = join(env.workdir, "pixel.png");
    const pdf = join(env.workdir, "read.pdf");
    writeFileSync(png, Buffer.from(PNG, "base64"));
    writeFileSync(pdf, Buffer.from(PDF, "base64"));
    const version = execFileSync("timeout", ["10s", "opencode", "--version"], { encoding: "utf8" }).trim();
    expect(version).toMatch(/^1\.\d+\.\d+$/);
    console.log(`OpenCode ${version}, Bun ${Bun.version}`);
    expect(RustTestHarness.detectPrereqs().ok).toBe(true);
    let h: RustTestHarness | undefined;
    try {
        h = await RustTestHarness.create({
            existingEnv: env, startHistorianProducer: false, modelContextLimit: 100_000,
            openCodeConfigExtra: { plugin: [`file://${PLUGIN_ENTRY}`, `file://${fixture}`] },
            magicContextConfig: { execute_threshold_percentage: 80, output_reserve: 0,
                historian: { disable: true }, dreamer: { disable: true }, memory: { enabled: false }, embedding: { provider: "off" } },
        });
        const containment = () => {
            const inventory = execFileSync("timeout", ["10s", "lsof", "-nP", "-p", String(h!.opencode.pid), "-Fn"], { encoding: "utf8" });
            const paths = inventory.split("\n").filter(line => /^n.*\.(db|sqlite)(-(wal|shm))?$/.test(line)).map(line => line.slice(1));
            expect(paths.length).toBeGreaterThan(0);
            expect(paths.every(path => path.startsWith(root + "/"))).toBe(true);
            writeFileSync(join(taskRoot, "tool-attachments-lsof.txt"), inventory);
            console.log(`tool attachments host ${h!.opencode.pid} lsof: ${JSON.stringify(paths)}`);
        };
        containment();
        let issued = false;
        h.mock.addMatcher(body => {
            if (JSON.stringify(body.system).includes("title generator")) return { text: "Tool attachments", usage: { input_tokens: 100, output_tokens: 5 } };
            if (!issued && JSON.stringify(body.messages).includes("ATTACHMENT_FIRST")) {
                issued = true;
                return { content: [
                    { type: "tool_use", id: "mock-image", name: "attachment_probe", input: {} },
                    { type: "tool_use", id: "read-image", name: "read", input: { filePath: png } },
                    { type: "tool_use", id: "read-pdf", name: "read", input: { filePath: pdf } },
                ], stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 100 } };
            }
            return { text: "Inspected", usage: { input_tokens: 1000, output_tokens: 20 } };
        });
        const id = await h.createSession();
        await h.sendPrompt(id, "ATTACHMENT_FIRST use the screenshot and read files");
        expect(issued).toBe(true);
        const first = h.mainRequests().find(request => result(request.body, "mock-image"));
        expect(first).toBeDefined();
        const frozen = new Map<string, string>();
        for (const [call, type, mime, data] of [
            ["mock-image", "image", "image/png", PNG],
            ["read-image", "image", "image/png", PNG],
            ["read-pdf", "document", "application/pdf", PDF],
        ]) {
            const output = result(first!.body, call)!;
            expect(Array.isArray(output.content)).toBe(true);
            const content = output.content as Block[];
            expect(content.some(block => block.type === "text" && /^§\d+§ /.test(block.text ?? ""))).toBe(true);
            expect(content.find(block => block.type === type)?.source).toMatchObject({ media_type: mime, data });
            // OpenCode moves Anthropic's ephemeral cache breakpoint as the tail grows.
            // Compare the complete logical result, excluding only that host bookkeeping.
            frozen.set(call, stableSerialize(output));
        }
        for (let pass = 0; pass < 3; pass++) {
            await h.sendPrompt(id, `ATTACHMENT_DEFER_${pass} keep inspecting`);
            for (const [call, bytes] of frozen) expect(stableSerialize(result(h.mainRequests().at(-1)!.body, call))).toBe(bytes);
        }
        const passes = await h.waitForRustPasses(5);
        console.log(`tool attachment Rust passes: ${passes.map(pass => pass.raw).join("\n")}`);
        // New tail tags can commit a SOFT+ fold while the scheduler defers reduction.
        // Check the scheduler, not the fold verdict, to prove these are defer passes.
        expect(passes.slice(-3).every(pass => / scheduler=defer(?: |$)/.test(pass.raw))).toBe(true);
        expect(passes.every(pass => pass.decision !== "error" && pass.decision !== "parked")).toBe(true);
        containment();
    } finally { await h?.dispose(); }
}, 600_000);
