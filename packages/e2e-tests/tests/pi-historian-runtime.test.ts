/// <reference types="bun-types" />
import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PiSubagentRunner } from "../../pi-plugin/src/subagent-runner";
import { buildMockHistorianPayload, findHistorianOrdinalRange } from "../src/mock-historian";
import { PiTestHarness } from "../src/pi-harness";
import { childEnv, PI_PLUGIN_ROOT, resolvePiHostInvocation } from "../src/pi-runner/spawn";
import { forEachHost } from "../src/scenario-hosts";
import { createE2ETempDir } from "../src/temp-dir";

function assertIsolated(pid: number, root: string, requireStore = true): void {
    const opened = execFileSync("lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8" });
    const paths = opened.split("\n").filter((line) => line.startsWith("n/")).map((line) => line.slice(1));
    expect(paths.length).toBeGreaterThan(0);
    const stores = paths.filter((path) => /\.db(?:-wal|-shm)?$/.test(path) || /\/\.(?:config|pi|omp)\//.test(path));
    if (requireStore) expect(stores.length).toBeGreaterThan(0);
    expect(stores.every((path) => path.startsWith(`${root}/`))).toBe(true);
    console.log(`runtime lsof pid=${pid} stores=${JSON.stringify(stores)}`);
}

async function inThrowawayRoot(run: (root: string) => Promise<void>): Promise<void> {
    const parent = realpathSync(tmpdir());
    const directory = /\/magic-context\/[^/]+(?:\/.*)?$/.test(parent)
        ? parent : join(parent, "magic-context", "pi-historian-runtime");
    mkdirSync(directory, { recursive: true });
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = realpathSync(directory);
    try { await run(process.env.TMPDIR); } finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
    }
}

forEachHost(import.meta.url, "historian extension runtime", (host) => {
    it(host === "pi" ? "publishes history after a loader-only extension evaluation without binding that runtime" : "initialized OMP filters disabled built-ins and publishes history", () => inThrowawayRoot(async (root) => {
        if (host !== "pi" && host !== "omp") throw new Error(`Unsupported host ${host}`);
        // All host state, including the native extraction cache, belongs to this task's throwaway root.
        expect(root).toMatch(/\/magic-context\/[^/]+(?:\/.*)?$/);
        const fixture = createE2ETempDir("runtime-extension-");
        const snapshot = join(fixture, "registry.json");
        const unbound = join(fixture, "unbound.json");
        const invocation = resolvePiHostInvocation(host);
        const version = JSON.parse(readFileSync(invocation.packageJson, "utf8")).version;
        console.log(`${host} real host version ${version}`);
        const extension = join(fixture, "probe.mjs");
        writeFileSync(extension, `
import { writeFileSync } from "node:fs";
export default function(pi) {
    pi.on("session_start", () => writeFileSync(${JSON.stringify(snapshot)}, JSON.stringify(pi.getAllTools().map(t => t.name))));
    pi.registerCommand("e2e-loader-only", { description: "Evaluate an independent unbound extension runtime", async handler(_args, ctx) {
        const { loadExtensionsCached } = await import(${JSON.stringify(join(dirname(invocation.packageJson), "dist/core/extensions/loader.js"))});
        const loaded = await loadExtensionsCached([${JSON.stringify(join(PI_PLUGIN_ROOT, "dist/index.js"))}], ctx.cwd);
        if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
        let error;
        try { loaded.runtime.getAllTools(); } catch (e) { error = e.message; }
        writeFileSync(${JSON.stringify(unbound)}, JSON.stringify({ error, extensions: loaded.extensions.length, servingTools: pi.getAllTools().map(t => t.name) }));
    }});
}
`);
        const h = await PiTestHarness.create({
            host,
            extensionsBeforeMagicContext: [extension],
            piSettingsExtra: host === "omp" ? { grep: { enabled: false }, glob: { enabled: false } } : {},
        });
        try {
            await h.getState();
            const env = childEnv(h.env);
            for (const key of ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "MAGIC_CONTEXT_STORAGE_DIR", "PI_CODING_AGENT_DIR"]) {
                expect(realpathSync(env[key]!).startsWith(`${root}/`)).toBe(true);
            }
            assertIsolated(h.hostPid!, root);
            const registered = JSON.parse(readFileSync(snapshot, "utf8")) as string[];
            expect(registered).toContain("read");
            if (host === "pi") {
                // A real second loader (as used by SDK hosts) gets new, never-bound
                // action stubs. Before the fix its factory replaces the singleton
                // supplier used by the *serving* historian with this unbound API.
                await h.invokeExtensionCommand("e2e-loader-only");
                const evidence = JSON.parse(readFileSync(unbound, "utf8"));
                expect(evidence.error).toBe("Extension runtime not initialized. Action methods cannot be called during extension loading.");
                expect(evidence.extensions).toBe(1);
                expect(evidence.servingTools).toContain("ctx_reduce");
            } else {
                expect(registered).not.toContain("grep");
                expect(registered).not.toContain("glob");
                // Exercise the production mapper runner against OMP's actual live
                // registry and disabled-built-in settings, not a fabricated list.
                const runner = new PiSubagentRunner({ invocation, getHostToolNames: () => JSON.parse(readFileSync(snapshot, "utf8")) });
                const before = h.mock.requests().length;
                let childPid: number | undefined;
                let childIsolationChecked = false;
                h.mock.addMatcher(() => {
                    if (childPid) { assertIsolated(childPid, root, false); childPid = undefined; childIsolationChecked = true; }
                    return null;
                });
                const keys = ["HOME", "CFFIXED_USER_HOME", "TMPDIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "MAGIC_CONTEXT_STORAGE_DIR", "PI_CODING_AGENT_DIR", "ANTHROPIC_API_KEY", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK"];
                const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
                for (const key of keys) process.env[key] = env[key];
                let result;
                try { result = await runner.run({
                    agent: "dreamer-memory-mapper", model: "mock/mock-model",
                    systemPrompt: "Reply once, then stop.", userMessage: "MAPPER_RUNTIME_PROBE",
                    cwd: h.workdir, timeoutMs: 30_000,
                    onProgress: (event) => { if (event.type === "spawned") childPid = event.pid; },
                    // Host subprocesses inherit these isolated settings and models.
                }); } finally {
                    for (const key of keys) {
                        if (saved[key] === undefined) delete process.env[key];
                        else process.env[key] = saved[key];
                    }
                }
                expect(result.ok).toBe(true);
                expect(childIsolationChecked).toBe(true);
                const requests = h.mock.requests().slice(before);
                expect(requests.length).toBeGreaterThan(0);
                const names = requests.flatMap((request) => {
                    const tools = request.body.tools;
                    return Array.isArray(tools) ? tools.map((tool) => tool.name) : [];
                });
                // OMP's provider transport prefixes built-in names with an underscore.
                expect(names).toEqual(["_read"]);
            }
            let historianIsolationChecked = false;
            h.mock.addMatcher((body) => {
                if (!JSON.stringify(body.system).includes("the hippocampus of a long-running coding agent")) return null;
                const children = execFileSync("pgrep", ["-P", String(h.hostPid)], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
                expect(children.length).toBeGreaterThan(0);
                for (const pid of children) assertIsolated(pid, root, false);
                historianIsolationChecked = true;
                const range = findHistorianOrdinalRange(body);
                if (!range) throw new Error("Historian request has no source ordinals");
                return { text: buildMockHistorianPayload({ start: range.start, end: range.end, title: "Runtime history", body: "The real host historian completed after extension loading." }), usage: { input_tokens: 500, output_tokens: 200 } };
            });
            const session = await h.createSession();
            for (let i = 0; i < 10; i++) await h.sendPrompt(session, `Durable turn ${i}. ${h.ballast(3000)}`);
            h.mock.setDefault({ text: "pressure", usage: { input_tokens: 90000, output_tokens: 20, cache_creation_input_tokens: 90000, cache_read_input_tokens: 0 } });
            await h.sendPrompt(session, "Trigger history compression.");
            h.mock.setDefault({ text: "after", usage: { input_tokens: 500, output_tokens: 10 } });
            await h.sendPrompt(session, "Run the historian.");
            await h.waitFor(() => h.countCompartments(session) > 0, { timeoutMs: 15000, label: "real historian publishes a compartment" });
            const requests = h.mock.requests().filter((r) => JSON.stringify(r.body.system).includes("the hippocampus of a long-running coding agent"));
            expect(requests.length).toBeGreaterThan(0);
            expect(historianIsolationChecked).toBe(true);
            for (const request of requests) expect(request.body.tools ?? []).toEqual([]);
            assertIsolated(h.hostPid!, root);
            h.assertHistorianRequestsUseMock();
            console.log(`${host} ${version}: historian requests=${requests.length}, compartments=${h.countCompartments(session)}`);
        } finally {
            await h.dispose();
        }
    }), 120000);
});
