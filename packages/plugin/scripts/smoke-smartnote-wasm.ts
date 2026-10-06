// Bundle-path smoke test for the smart-note QuickJS sandbox.
//
// `bun test` runs sandbox-runner.ts from SRC, where Bun resolves the QuickJS
// wasm through the real node_modules package path — so it CANNOT catch the
// bundling failure that actually shipped: the default wasmfile variant loads a
// sibling `emscripten-module.wasm` via `new URL(..., import.meta.url)`, which in
// the bundled dist/index.js resolves to a `dist/emscripten-module.wasm` the
// build never emits → every real sandbox run failed with ENOENT.
//
// This script BUNDLES sandbox-runner.ts exactly like the production build
// (esm, node target) into a temp file, then imports that bundle and runs a real
// check. If the wasm bytecode isn't embedded in the bundle, the
// import/run throws — failing the smoke. Run: bun packages/plugin/scripts/smoke-smartnote-wasm.ts
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestTempDir } from "../src/shared/test-temp-dir";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "../src/features/magic-context/smart-notes/sandbox-runner.ts");
const { dir: outDir, cleanup } = createTestTempDir("mc-smartnote-wasm-smoke-");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

try {
    // Bundle with the SAME flags the package build uses (esm, node target), so
    // the QuickJS variant goes through the identical bundling transform.
    const result = await Bun.build({
        entrypoints: [entry],
        outdir: outDir,
        target: "node",
        format: "esm",
    });
    check("sandbox-runner bundles cleanly", result.success, result.logs.map(String).join("; "));
    if (!result.success) throw new Error("bundle failed");
    check("bundle needs no external wasm asset", !result.outputs.some((output) => output.path.endsWith(".wasm")));

    const bundlePath = result.outputs.find((o) => o.path.endsWith(".js"))?.path;
    check("bundle emitted a js file", Boolean(bundlePath));
    if (!bundlePath) throw new Error("no bundle output");

    // The whole point: importing + running the BUNDLE must not ENOENT on a
    // sibling .wasm. The bytecode must come from the bundle itself.
    const mod = (await import(bundlePath)) as {
        runCompiledSmartNoteCheck: (opts: unknown) => Promise<{ ok: boolean; result?: unknown }>;
    };
    check("runCompiledSmartNoteCheck is exported from bundle", typeof mod.runCompiledSmartNoteCheck === "function");

    const fakeCap = {
        readFile: async (path: string) => (path === "ready.txt" ? "ready" : null),
        gitHeadSha: async () => "abc123",
        gitTag: async () => "v1.2.3",
        gitLog: async () => [],
        httpGet: async () => ({ status: 200, body: "ok" }),
    };
    const res = await mod.runCompiledSmartNoteCheck({
        compiledCheck: `function check(cap) { return { met: cap.readFile("ready.txt") === "ready" }; }`,
        capabilities: fakeCap,
    });
    check(
        "bundled sandbox runs a check (wasm loads from the bundle, no ENOENT)",
        res.ok === true && JSON.stringify(res.result) === JSON.stringify({ met: true }),
        JSON.stringify(res),
    );
    const nodeVersion = spawnSync("node", ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    check("Node runtime is available for the bundle probe", nodeVersion.status === 0, String(nodeVersion.error ?? nodeVersion.stderr));
    if (nodeVersion.status !== 0) throw new Error("Node runtime unavailable");
    console.log(`  Node ${nodeVersion.stdout.trim()}`);
    const node = spawnSync("node", ["--input-type=module", "--eval", `
        import { pathToFileURL } from "node:url";
        const { runCompiledSmartNoteCheck } = await import(pathToFileURL(process.argv[1]).href);
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: 'function check(cap) { return {met: cap.readFile("ready.txt") === "ready"}; }',
            capabilities: {
                readFile: async () => "ready", gitHeadSha: async () => null,
                gitTag: async () => null, gitLog: async () => [],
                httpGet: async () => ({status: 200, body: "ok"}),
            },
        });
        console.log(JSON.stringify(result));
        if (!result.ok || result.result.met !== true) process.exit(1);
    `, bundlePath], { cwd: outDir, encoding: "utf8", timeout: 20_000, windowsHide: true });
    check("standalone Node bundle runs a real asyncify capability check", node.status === 0 && node.stdout.includes('"met":true'), `${node.stdout}\n${node.stderr}\n${node.error ?? ""}`);
} catch (error) {
    failures++;
    console.log(`FAIL  bundle-path smoke threw — ${error instanceof Error ? error.message : String(error)}`);
} finally {
    cleanup();
}

if (failures > 0) {
    console.error(`\n${failures} smoke check(s) failed`);
    process.exit(1);
}
console.log("\nAll smart-note wasm bundle-path smoke checks passed.");
