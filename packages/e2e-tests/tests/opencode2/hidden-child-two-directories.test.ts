import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeJsonAtomically } from "../../src/write-json-atomically";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { isolation, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

async function waitForFile(path: string): Promise<void> {
    const until = Date.now() + 60_000;
    while (!existsSync(path)) {
        if (Date.now() > until) throw new Error(`Timed out waiting for ${path}`);
        await Bun.sleep(20);
    }
}

test("OpenCode 2 dispatches each worktree's hidden run to its own hook", async () => {
    const fixture = isolation();
    Bun.spawnSync(["git", "init", "-q", fixture.cwd]);
    Bun.spawnSync(["git", "-C", fixture.cwd, "-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "fixture"]);
    const other = join(fixture.root, "other-worktree");
    const linked = Bun.spawnSync(["git", "-C", fixture.cwd, "worktree", "add", "-q", "-b", "other", other]);
    if (linked.exitCode !== 0) throw new Error(linked.stderr.toString());
    const bundle = mkdtempSync(join(tmpdir(), "mc-hidden-two-directories-"));
    const build = await Bun.build({
        entrypoints: [join(import.meta.dir, "hidden-child-two-directories-probe.ts")],
        outdir: bundle,
        naming: "index.js",
        target: "node",
        format: "esm",
        define: { "process.env.NODE_ENV": '"production"' },
        external: ["bun:sqlite", "node:sqlite"],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const host = await spawnOpencode2({
        existingIsolation: fixture,
        probePlugin: bundle,
        includeMagicContext: false,
        serviceMode: true,
        defaultModelID: "mock-model-user",
        additionalModelIDs: ["mock-model-cheap"],
    });
    try {
        copyFileSync(join(fixture.cwd, "opencode.json"), join(other, "opencode.json"));
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        for (const directory of [fixture.cwd, other]) {
            await waitForPluginActive(client, directory, "mc-hidden-child-two-directories-proof");
            await waitForFile(join(directory, "hidden-child-ready"));
        }
        const results: Array<{ ok: boolean; childID: string; error?: string }> = [];
        for (const [seq, directory] of [fixture.cwd, other].entries()) {
            const user = await client.session.create({
                title: "user session", location: { directory },
                model: { providerID: "openai", id: "mock-model-user" },
            });
            writeJsonAtomically(join(directory, "hidden-child-command.json"), { seq, parentSessionID: user.id });
            const resultPath = join(directory, `hidden-child-result-${seq}.json`);
            await waitForFile(resultPath);
            results.push(JSON.parse(readFileSync(resultPath, "utf8")));
        }
        expect(results[0]?.ok).toBe(true);
        expect(results[1]?.ok).toBe(true);
        expect(results[1]?.childID).not.toBe(results[0]?.childID);
        expect(`${host.stdout()}\n${host.stderr()}`).not.toContain("hidden_prompt_unrecognized");
    } catch (error) {
        console.error(host.stdout(), host.stderr());
        throw error;
    } finally {
        await host.stop();
        rmSync(bundle, { recursive: true, force: true });
    }
}, 180_000);
