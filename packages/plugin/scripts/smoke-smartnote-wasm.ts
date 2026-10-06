// Bundle-path smoke test for the smart-note QuickJS sandbox.
//
// Source tests resolve WASM through node_modules, so they cannot catch a bundle
// that accidentally tries to load an omitted sibling emscripten-module.wasm.
// Bundle the same node/esm target as the package and run a real capability check.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestTempDir } from "../src/shared/test-temp-dir";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "../src/features/magic-context/smart-notes/sandbox-runner.ts");
const { dir: outDir, cleanup } = createTestTempDir("mc-smartnote-wasm-smoke-");
let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
    if (cond) console.log(`  ok  ${name}`);
    else {
        failures++;
        console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
}
try {
    const result = await Bun.build({ entrypoints: [entry], outdir: outDir, target: "node", format: "esm" });
    check("sandbox-runner bundles cleanly", result.success, result.logs.map(String).join("; "));
    if (!result.success) throw new Error("bundle failed");
    const bundlePath = result.outputs.find((output) => output.path.endsWith(".js"))?.path;
    check("bundle emitted a js file", Boolean(bundlePath));
    if (!bundlePath) throw new Error("no bundle output");
    const mod = (await import(bundlePath)) as {
        runCompiledSmartNoteCheck: (opts: unknown) => Promise<{ ok: boolean; result?: unknown }>;
    };
    check("runCompiledSmartNoteCheck is exported from bundle", typeof mod.runCompiledSmartNoteCheck === "function");
    const res = await mod.runCompiledSmartNoteCheck({
        compiledCheck: 'function check(cap) { return { met: cap.readFile("ready.txt") === "ready" }; }',
        capabilities: {
            readFile: async (path: string) => path === "ready.txt" ? "ready" : null,
            gitHeadSha: async () => "abc123", gitTag: async () => "v1.2.3", gitLog: async () => [],
            httpGet: async () => ({ status: 200, body: "ok" }),
        },
    });
    check("bundled sandbox runs a check (wasm loads from the bundle, no ENOENT)",
        res.ok === true && JSON.stringify(res.result) === JSON.stringify({ met: true }), JSON.stringify(res));
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
