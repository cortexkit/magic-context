import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { assertOpenPaths, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";
import { providerSystemText } from "../../src/provider-system-text";

async function waitFile(path: string) {
    const deadline = Date.now() + 90_000;
    while (!existsSync(path)) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
        await Bun.sleep(30);
    }
}

test("OpenCode 2 dreamer tool loop reaching its cap records step_limit, not provider_error", async () => {
    const root = join(tmpdir(), "magic-context", "issue-550-step-limit");
    mkdirSync(root, { recursive: true });
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = realpathSync(root);
    const bundle = mkdtempSync(join(root, "probe-"));
    let host: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
    try {
        const build = await Bun.build({
            entrypoints: [join(import.meta.dir, "dream-loop-probe.ts")],
            outdir: bundle,
            naming: "index.js",
            target: "node",
            format: "esm",
            define: { "process.env.NODE_ENV": '"production"' },
            external: ["bun:sqlite", "node:sqlite"],
        });
        if (!build.success) throw new Error(build.logs.join("\n"));
        host = await spawnOpencode2({ probePlugin: bundle, includeMagicContext: false, serviceMode: true });
        const client = OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        await waitForPluginActive(client, host.cwd, "mc-dream-loop-probe");
        await waitFile(join(host.cwd, "dream-loop-ready"));
        const open = execFileSync("lsof", ["-p", String(host.pid), "-Fn"], { encoding: "utf8" });
        const dbPaths = open.split("\n").filter((line) => /^n.*\.db(?:-(?:wal|shm))?$/.test(line)).map((line) => line.slice(1));
        expect(dbPaths.length).toBeGreaterThan(0);
        expect(dbPaths.every((path) => path.startsWith(host!.root))).toBe(true);
        assertOpenPaths(dbPaths, host.root);
        const user = await client.session.create({ title: "user", location: { directory: host.cwd }, model: { providerID: "openai", id: "mock-model" } });
        let calls = 0;
        host.mock.addMatcher((body) => {
            if (!providerSystemText(body).includes("curate")) return null;
            calls++;
            if (calls === 1) return { error: { status: 500, type: "server_error", message: "one retried step" } };
            return { openaiOutput: [{ type: "function_call", id: `fc_cap_${calls}`, call_id: `call_cap_${calls}`, name: "ctx_memory", arguments: JSON.stringify({ action: "list", value: "fixture" }) }], usage: { input_tokens: 100, output_tokens: 10 } };
        });
        const resultPath = join(host.cwd, "dream-loop-result-550.json");
        writeFileSync(join(host.cwd, "dream-loop-command.json"), JSON.stringify({ parent: user.id, seq: 550, agent: "step-cap-runner" }));
        await waitFile(resultPath);
        const result = JSON.parse(readFileSync(resultPath, "utf8"));
        expect(calls).toBeGreaterThanOrEqual(150);
        expect(result.result.status).toBe("failed");
        const task = JSON.parse(result.runs.at(-1).tasks_json)[0];
        expect(task.failure.failure_class).toBe("step_limit");
        expect(task.failure.provider_error).toBeNull();
        expect(task.error).toContain("HiddenAgentStepLimit");
    } catch (error) {
        if (host) console.error(host.stdout(), host.stderr());
        throw error;
    } finally {
        await host?.stop();
        rmSync(bundle, { recursive: true, force: true });
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
    }
}, 180_000);
