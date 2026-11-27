import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { writeJsonAtomically } from "../../src/write-json-atomically";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { assertOpenPaths, CLI, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";
import { verifyPromptIds } from "../dreamer-timeout-support";

test.skipIf(process.env.MC_E2E_MAPPER_STEP_PROBE !== "1")("real OpenCode 2 verify-broad banks a partial manifest before the mapper step cap", async () => {
    const root = realpathSync(tmpdir());
    expect(root).toContain("/magic-context/mapper-step-cap/");
    console.log(`OpenCode host version ${execFileSync(CLI, ["--version"], { encoding: "utf8" }).trim()}`);
    const bundle = mkdtempSync(join(root, "oc2-probe-"));
    let host: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
    try {
        const build = await Bun.build({ entrypoints: [join(import.meta.dir, "dream-loop-probe.ts")], outdir: bundle, naming: "index.js", target: "node", format: "esm", define: { "process.env.NODE_ENV": '"production"' }, external: ["bun:sqlite", "node:sqlite"] });
        if (!build.success) throw new Error(build.logs.join("\n"));
        // Bun's bundled asynchronous initializers can reference an undefined
        // helper. Repair only the temporary probe, not the built plugin.
        const probe = join(bundle, "index.js");
        writeFileSync(probe, readFileSync(probe, "utf8").replaceAll("__promiseAll(", "Promise.all("));
        host = await spawnOpencode2({ probePlugin: bundle, includeMagicContext: false, serviceMode: true });
        const client = OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        await waitForPluginActive(client, host.cwd, "mc-dream-loop-probe");
        const opened = execFileSync("lsof", ["-p", String(host.pid), "-Fn"], { encoding: "utf8" });
        const paths = opened.split("\n").filter((line) => /^n.*\.db(?:-wal|-shm)?$/.test(line)).map((line) => line.slice(1));
        expect(paths.length).toBeGreaterThan(0);
        assertOpenPaths(paths, host.root);
        console.log(`mapper-step-cap OpenCode2 lsof pid=${host.pid} db=${JSON.stringify(paths)}`);
        const parent = await client.session.create({ title: "verify parent", location: { directory: host.cwd }, model: { providerID: "openai", id: "mock-model" } });
        let calls = 0;
        let finalizes = 0;
        host.mock.addMatcher((body) => {
            const batch = verifyPromptIds({ messages: body.input });
            if (!batch.length) return null;
            // The probe seeds a backlog of twenty memories; each hidden verify session is
            // given five of them.
            expect(batch).toHaveLength(5);
            if (JSON.stringify(body).includes("You're out of token budget")) {
                finalizes++;
                expect(body.tools ?? []).toEqual([]);
                return { text: `<verify>${batch.slice(0, 2).map((id) => `<verified id="${id}"/>`).join("")}</verify>`, usage: { input_tokens: 10, output_tokens: 30 } };
            }
            calls++;
            return { openaiOutput: [{ type: "function_call", id: `fc_lookup_${calls}`, call_id: `lookup_${calls}`, name: "read", arguments: JSON.stringify({ filePath: "fact.txt" }) }], usage: { input_tokens: 10, output_tokens: 10 } };
        });
        writeJsonAtomically(join(host.cwd, "dream-loop-command.json"), { parent: parent.id, seq: 1, agent: "verify-step-runner" });
        const resultPath = join(host.cwd, "dream-loop-result-1.json");
        const deadline = Date.now() + 90000;
        while (!existsSync(resultPath)) {
            if (Date.now() > deadline) throw new Error("OpenCode verify timed out");
            await Bun.sleep(50);
        }
        const result = JSON.parse(readFileSync(resultPath, "utf8"));
        console.log(`mapper-step-cap OpenCode2 ${JSON.stringify({ calls, finalizes, result })}`);
        expect(finalizes).toBe(1);
        expect(calls).toBe(57);
        expect(result.banked).toHaveLength(2);
        expect(result.outcome).toMatchObject({ verified: 2, remaining: 18 });
    } catch (error) {
        if (host) console.error(host.stdout(), host.stderr());
        throw error;
    } finally {
        await host?.stop();
        rmSync(bundle, { recursive: true, force: true });
    }
}, 120000);
