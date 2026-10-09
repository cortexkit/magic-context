import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { estimateTokens } from "../../plugin/src/hooks/magic-context/read-session-formatting";
import { TestHarness } from "../src/harness";

const contentBytes = (value: unknown) => JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item);

test("OpenCode 1 reasoning budget rides rebuilds and replays the frozen thinking prefix on defer", async () => {
    const taskRoot = join(tmpdir(), "magic-context", "bg_1aa2a2de119894ed", "reasoning-budget-host");
    mkdirSync(taskRoot, { recursive: true });
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = taskRoot;
    let h: TestHarness;
    try {
        h = await TestHarness.create({
            mockProviderID: "anthropic",
            magicContextConfig: { keep_reasoning_tokens: 300, execute_threshold_percentage: 90, historian: { disable: true }, dreamer: { disable: true }, memory: { enabled: false } },
            mockDefault: { content: [{ type: "thinking", thinking: "budget thought ".repeat(60), signature: "mock-signed-budget" }, { type: "text", text: "A completed answer." }], usage: { input_tokens: 2000, output_tokens: 150, cache_read_input_tokens: 1500 } },
        });
    } finally {
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
    }
    const root = dirname(h.opencode.env.dataDir);
    const logPath = join(h.dataDir, "cortexkit", "magic-context-e2e.log");
    try {
        expect(realpathSync(root).startsWith(realpathSync(taskRoot) + "/")).toBe(true);
        const health = await fetch(`${h.serverUrl}/global/health`).then(r => r.json()) as { version: string };
        expect(health.version).toMatch(/^1\./);
        const containment = () => {
            const result = spawnSync("lsof", ["-p", String(h.opencode.pid), "-Fn"], { encoding: "utf8" });
            expect(result.status).toBe(0);
            writeFileSync(join(taskRoot, `lsof-${h.opencode.pid}.txt`), result.stdout);
            const databases = result.stdout.split("\n").filter(line => /^n.*\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(line)).map(line => line.slice(1));
            expect(databases.length).toBeGreaterThan(0);
            expect(databases.filter(path => !path.startsWith(root + "/"))).toEqual([]);
        };
        containment();
        const session = await h.createSession();
        const watermark = () => (h.contextDb().query("SELECT cleared_reasoning_through_tag AS n FROM session_meta WHERE session_id = ?").get(session) as { n: number }).n;
        const request = () => h.requests().filter(r => contentBytes(r.body.messages).includes("budget-seed")).at(-1)!;
        const reasoning = (body: { messages?: unknown[] }) => (body.messages ?? []).flatMap(message => {
            const content = (message as { content?: unknown }).content;
            return Array.isArray(content) ? content.filter(part => part.type === "thinking") as { thinking: string; signature?: string }[] : [];
        });
        for (let turn = 0; turn < 8; turn++) await h.sendPrompt(session, `budget-seed turn ${turn}`);
        const before = request();
        const beforeThinking = reasoning(before.body);
        expect(beforeThinking.length).toBeGreaterThan(2);
        expect(beforeThinking.reduce((sum, part) => sum + estimateTokens(part.thinking), 0)).toBeGreaterThan(300);
        expect(watermark()).toBe(0);
        const priorMessages = contentBytes(before.body.messages);
        await h.sendPrompt(session, "budget-seed over-budget defer");
        const deferred = request();
        expect(contentBytes(deferred.body.messages?.slice(0, before.body.messages?.length))).toBe(priorMessages);
        expect(watermark()).toBe(0);
        const offset = readFileSync(logPath, "utf8").length;
        const response = await fetch(`${h.serverUrl}/session/${session}/command?directory=${encodeURIComponent(h.workdir)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "ctx-flush", arguments: "" }) });
        expect(response.ok).toBe(true);
        await h.sendPrompt(session, "budget-seed rebuilding pass");
        const rebuilt = request();
        const kept = reasoning(rebuilt.body);
        expect(kept.length).toBeGreaterThan(0);
        expect(kept.length).toBeLessThan(beforeThinking.length);
        expect(kept.reduce((sum, part) => sum + estimateTokens(part.thinking), 0)).toBeLessThanOrEqual(300);
        expect(watermark()).toBeGreaterThan(0);
        expect(JSON.stringify(rebuilt.body)).not.toContain("[cleared]");
        expect(readFileSync(logPath, "utf8").slice(offset)).toContain("reasoning cleanup:");
        const frozen = watermark();
        await h.sendPrompt(session, "budget-seed replay after rebuild");
        const replay = request();
        expect(contentBytes(replay.body.messages?.slice(0, rebuilt.body.messages?.length))).toBe(contentBytes(rebuilt.body.messages));
        expect(watermark()).toBe(frozen);
        containment();
        writeFileSync(join(taskRoot, `result-${h.opencode.pid}.json`), JSON.stringify({ version: health.version, pid: h.opencode.pid, root, beforeTokens: beforeThinking.reduce((sum, p) => sum + estimateTokens(p.thinking), 0), keptTokens: kept.reduce((sum, p) => sum + estimateTokens(p.thinking), 0), frozen }, null, 2));
        console.log(`OpenCode ${health.version}: over-budget defers preserved bytes; rebuilding pass kept ${kept.length} steps at <=300 tokens; PID ${h.opencode.pid} stores contained in ${root}`);
    } finally { await h.dispose(); }
}, 120_000);
