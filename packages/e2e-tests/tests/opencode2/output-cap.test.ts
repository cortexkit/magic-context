import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { writeJsonAtomically } from "../../src/write-json-atomically";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { historianReasoningBudgetDiagnostic } from "../../../plugin/src/hooks/magic-context/compartment-runner-historian";
import { assertOpenPaths, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

async function waitFile(path: string) {
    const deadline = Date.now() + 20000;
    while (!Bun.file(path).size) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${path}`);
        await Bun.sleep(25);
    }
}

const caps = (body: Record<string, unknown>) => ({ max_tokens: body.max_tokens, max_completion_tokens: body.max_completion_tokens, max_output_tokens: body.max_output_tokens });

test("OpenCode 2 ordinary and hidden historian omit caps; a provider default exhausts reasoning until configured", async () => {
    const root = join(tmpdir(), "magic-context", "issue-551");
    mkdirSync(root, { recursive: true });
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = realpathSync(root);
    const bundle = mkdtempSync(join(root, "probe-"));
    let host: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
    try {
        const build = await Bun.build({ entrypoints: [join(import.meta.dir, "output-cap-probe.ts")], outdir: bundle, naming: "index.js", target: "node", format: "esm", define: { "process.env.NODE_ENV": '"production"' }, external: ["bun:sqlite", "node:sqlite"] });
        if (!build.success) throw new Error(build.logs.join("\n"));
        host = await spawnOpencode2({ probePlugin: bundle, includeMagicContext: false, defaultModelID: "mock-model-user", additionalModelIDs: ["mock-model-cheap"], modelContextLimit: 200000, modelOutputLimit: 4096 });
        const client = OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        await waitForPluginActive(client, host.cwd, "mc-hidden-output-cap-proof");
        await waitFile(join(host.cwd, "hidden-child-ready"));
        const open = execFileSync("lsof", ["-p", String(host.pid), "-Fn"], { encoding: "utf8" });
        const dbPaths = open.split("\n").filter((line) => /^n.*\.db(?:-(?:wal|shm))?$/.test(line)).map((line) => line.slice(1));
        expect(dbPaths.length).toBeGreaterThan(0);
        expect(dbPaths.every((path) => path.startsWith(host!.root))).toBe(true);
        assertOpenPaths(dbPaths, host.root);
        const user = await client.session.create({ title: "user session", location: { directory: host.cwd }, model: { providerID: "openai", id: "mock-model-user" } });
        await client.session.prompt({ sessionID: user.id, text: "ORDINARY_551" });
        const deadline = Date.now() + 20000;
        while (!host.mock.requests().some((request) => JSON.stringify(request.body).includes("ORDINARY_551"))) {
            if (Date.now() > deadline) throw new Error("Ordinary prompt never reached provider");
            await Bun.sleep(25);
        }
        const ordinary = host.mock.requests().find((request) => JSON.stringify(request.body).includes("ORDINARY_551"));
        expect(ordinary).toBeDefined();
        console.log("STEP1 OpenCode2 ordinary", caps(ordinary!.body));
        host.mock.addMatcher((body) => {
            if (!JSON.stringify(body).includes("EXACT_HISTORIAN_CHUNK_")) return null;
            if (body.max_output_tokens === undefined) return {
                openaiIncomplete: true,
                openaiOutput: [{ type: "reasoning", summary: [{ type: "summary_text", text: "budget spent reasoning" }] }],
                usage: { input_tokens: 101, output_tokens: 64 },
            };
            return { text: "successful historian", usage: { input_tokens: 101, output_tokens: 21 } };
        });
        writeJsonAtomically(join(host.cwd, "hidden-child-command.json"), { seq: 1, parentSessionID: user.id });
        await waitFile(join(host.cwd, "hidden-child-result-1.json"));
        const hidden = host.mock.requests().find((request) => JSON.stringify(request.body).includes("EXACT_HISTORIAN_CHUNK_1"));
        expect(hidden).toBeDefined();
        expect(hidden!.body.model).toBe("mock-model-cheap");
        console.log("STEP1 OpenCode2 hidden", caps(hidden!.body));
        expect(caps(hidden!.body)).toEqual(caps(ordinary!.body));
        const first = JSON.parse(readFileSync(join(host.cwd, "hidden-child-result-1.json"), "utf8"));
        expect(first.completion).toMatchObject({ text: null, lengthCapped: true, usage: { output: 64 } });
        expect(first.completion.reasoning).toBeTruthy();
        const diagnostic = historianReasoningBudgetDiagnostic(first.completion.usage.output);
        expect(diagnostic).toContain("ran out of output budget while reasoning");
        expect(diagnostic).toContain("historian.maxTokens");
        expect(diagnostic).not.toContain("no assistant output");
        writeJsonAtomically(join(host.cwd, "hidden-child-command.json"), { seq: 2, parentSessionID: user.id, maxOutputTokens: 4096 });
        await waitFile(join(host.cwd, "hidden-child-result-2.json"));
        const second = JSON.parse(readFileSync(join(host.cwd, "hidden-child-result-2.json"), "utf8"));
        expect(second.completion).toMatchObject({ text: "successful historian", lengthCapped: false });
        const configured = host.mock.requests().find((request) => JSON.stringify(request.body).includes("EXACT_HISTORIAN_CHUNK_2"));
        expect(configured?.body.max_output_tokens).toBe(4096);
        expect((await client.session.get({ sessionID: user.id })).model?.id).toBe("mock-model-user");
    } catch (error) {
        if (host) console.error(host.stderr(), host.stdout());
        throw error;
    } finally {
        if (host) await host.stop();
        rmSync(bundle, { recursive: true, force: true });
        process.env.TMPDIR = previousTmp;
    }
}, 120000);
