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
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanupTestTempDir, createTestTempDir, createTestTempDirFromPath } from "../src/shared/test-temp-dir";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "../src/features/magic-context/smart-notes/sandbox-runner.ts");
const { dir: outDir, cleanup } = createTestTempDir("mc-smartnote-wasm-smoke-");
let distProbeDir: string | undefined;

function builtSandboxProbe(entryPath: string): string {
    const scanner = new Bun.Transpiler({ loader: "js" });
    const entryFile = resolve(entryPath);
    const pending = [entryFile];
    const seen = new Set<string>();
    const sources = new Map<string, { source: string; imports: ReturnType<Bun.Transpiler["scanImports"]> }>();
    let sandboxFile: string | undefined;
    while (pending.length) {
        const file = pending.shift()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const source = readFileSync(file, "utf8");
        const imports = scanner.scanImports(source);
        sources.set(file, { source, imports });
        if (/\basync function runCompiledSmartNoteCheck\(/.test(source)) sandboxFile = file;
        for (const dependency of imports) {
            if (dependency.path.startsWith(".") && /\.m?js$/.test(dependency.path)) {
                pending.push(resolve(dirname(file), dependency.path));
            }
        }
    }
    if (process.argv.includes("--require-lazy-wasm")) {
        const payloads = [...sources].filter(([, info]) => /["']AGFzbQEAAA[A-Za-z0-9+/=]{1000}/.test(info.source)).map(([file]) => file);
        const staticFiles = new Set<string>();
        const staticPending = [entryFile];
        while (staticPending.length) {
            const file = staticPending.shift()!;
            if (staticFiles.has(file)) continue;
            staticFiles.add(file);
            for (const dependency of sources.get(file)?.imports ?? []) {
                if (dependency.kind === "import-statement" && dependency.path.startsWith(".") && /\.m?js$/.test(dependency.path)) {
                    staticPending.push(resolve(dirname(file), dependency.path));
                }
            }
        }
        check("built entry reaches the embedded WASM bytecode", payloads.length > 0, entryFile);
        check("built entry keeps WASM bytecode outside its static import graph", payloads.length > 0 && payloads.every((file) => !staticFiles.has(file)), payloads.join(", "));
        console.log(`  lazy bytecode: ${payloads.join(", ")}; ${staticFiles.size} static modules`);
    }
    if (sandboxFile) {
        const file = sandboxFile;
        const { source, imports } = sources.get(file)!;
            // The emitted sandbox is private to its shared chunk. Expose that
            // exact compiled function for this probe, without rebuilding source.
            // Keep each import pointed at the original built distribution.
            let probe = source;
            for (const dependency of imports) {
                if (!dependency.path.startsWith(".")) continue;
                const target = pathToFileURL(resolve(dirname(file), dependency.path)).href;
                probe = probe.replaceAll(JSON.stringify(dependency.path), JSON.stringify(target));
                probe = probe.replaceAll(`'${dependency.path}'`, JSON.stringify(target));
            }
            distProbeDir = createTestTempDirFromPath(join(dirname(file), "mc-smartnote-dist-probe-"));
            const probePath = join(distProbeDir, "sandbox-probe.js");
            writeFileSync(probePath, `${probe}\nexport { runCompiledSmartNoteCheck as __distSandboxProbe };\n`);
            console.log(`  built sandbox: ${file}`);
            return probePath;
    }
    throw new Error(`No emitted sandbox reachable from ${entryPath}`);
}

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
    if (process.argv[2] === "--built-dist" && !process.argv[3]) {
        throw new Error("--built-dist requires the built bundle entry path");
    }
    // Bundle with the SAME flags the package build uses (esm, node target), so
    // the QuickJS variant goes through the identical bundling transform.
    const builtEntry = process.argv[2] === "--built-dist" ? process.argv[3] : undefined;
    const result = builtEntry ? undefined : await Bun.build({
        entrypoints: [entry],
        outdir: outDir,
        target: "node",
        format: "esm",
    });
    if (result) {
        check("sandbox-runner bundles cleanly", result.success, result.logs.map(String).join("; "));
        if (!result.success) throw new Error("bundle failed");
        check("bundle needs no external wasm asset", !result.outputs.some((output) => output.path.endsWith(".wasm")));
    }

    const bundlePath = builtEntry ? builtSandboxProbe(builtEntry) : result?.outputs.find((o) => o.path.endsWith(".js"))?.path;
    check("bundle emitted a js file", Boolean(bundlePath));
    if (!bundlePath) throw new Error("no bundle output");

    // The whole point: importing + running the BUNDLE must not ENOENT on a
    // sibling .wasm. The bytecode must come from the bundle itself.
    const mod = (await import(bundlePath)) as {
        runCompiledSmartNoteCheck: (opts: unknown) => Promise<{ ok: boolean; result?: unknown }>;
        __distSandboxProbe?: (opts: unknown) => Promise<{ ok: boolean; result?: unknown }>;
    };
    const runCheck = mod.__distSandboxProbe ?? mod.runCompiledSmartNoteCheck;
    check("runCompiledSmartNoteCheck is exported from bundle", typeof runCheck === "function");

    const fakeCap = {
        readFile: async (path: string) => (path === "ready.txt" ? "ready" : null),
        gitHeadSha: async () => "abc123",
        gitTag: async () => "v1.2.3",
        gitLog: async () => [],
        httpGet: async () => ({ status: 200, body: "ok" }),
    };
    const res = await runCheck({
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
        const mod = await import(pathToFileURL(process.argv[1]).href);
        const runCompiledSmartNoteCheck = mod.__distSandboxProbe ?? mod.runCompiledSmartNoteCheck;
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
    if (distProbeDir) cleanupTestTempDir(distProbeDir);
    cleanup();
}

if (failures > 0) {
    console.error(`\n${failures} smoke check(s) failed`);
    process.exit(1);
}
console.log("\nAll smart-note wasm bundle-path smoke checks passed.");
