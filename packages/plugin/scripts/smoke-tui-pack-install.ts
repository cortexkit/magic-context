import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackedTuiGraph } from "./tui-pack-graph";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@cortexkit/opencode-magic-context";
const runtimeSpecifiers = [
    "@opentui/core",
    "@opentui/core/testing",
    "@opentui/solid",
    "@opentui/solid/components",
    "@opentui/solid/jsx-runtime",
    "@opentui/solid/jsx-dev-runtime",
    "solid-js",
    "solid-js/store",
];

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

function fail(name: string, detail: string): never {
    check(name, false, detail);
    throw new Error(`${name}: ${detail}`);
}

function run(command: string, args: string[], cwd: string): string {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 20 * 1024 * 1024,
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    if (result.status !== 0) {
        fail(
            `${command} ${args.join(" ")}`,
            `exited with ${result.status ?? "unknown status"}`,
        );
    }
    return result.stdout;
}

function parsePackedFilename(stdout: string): string {
    try {
        const packed = JSON.parse(stdout.trim()) as Array<{ filename?: string }>;
        const filename = packed[0]?.filename;
        if (typeof filename === "string" && filename.length > 0) return filename;
    } catch {
        // npm can print warnings around the JSON on some versions; fall back to
        // the last tarball-looking line rather than making the smoke version-fragile.
    }

    const fallback = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.endsWith(".tgz"))
        .at(-1);
    if (fallback) return fallback;
    fail("npm pack reports a tarball", stdout.trim() || "no stdout");
}

const tempRoot = await mkdtemp(join(tmpdir(), "magic-context-tui-pack-"));
const installRoot = join(tempRoot, "install");

try {
    // CI already built and checked drift; pack exactly that output. Standalone
    // smoke runs still generate their own compiled TUI before packing.
    if (!process.argv.includes("--skip-build")) run("bun", ["run", "build:tui"], pluginRoot);

    const packStdout = run("npm", ["pack", "--json", "--pack-destination", tempRoot], pluginRoot);
    const tarball = join(tempRoot, parsePackedFilename(packStdout));
    check("npm pack produced a tarball", existsSync(tarball), tarball);

    const packed = JSON.parse(packStdout.trim()) as Array<{ files: Array<{ path: string }> }>;
    const graphSize = checkPackedTuiGraph(pluginRoot, new Set(packed[0]?.files.map(({ path }) => path)));
    check(`all ${graphSize} TUI-reachable runtime files ship in the tarball`, true);

    await mkdir(installRoot, { recursive: true });
    await writeFile(
        join(installRoot, "package.json"),
        JSON.stringify(
            {
                private: true,
                type: "module",
                dependencies: {
                    [packageName]: `file:${tarball}`,
                },
            },
            null,
            2,
        ),
    );
    run("bun", ["install", "--production"], installRoot);

    for (const dependency of ["@opentui/core", "@opentui/solid", "solid-js"]) {
        check(
            `standalone consumer does not install ${dependency}`,
            !existsSync(join(installRoot, "node_modules", dependency)),
        );
    }

    // These probes emulate a host and bare-Bun development, respectively. The
    // published package must not install a second Solid/OpenTUI runtime; provide
    // the development runtimes explicitly only after checking the consumer graph.
    const manifest = JSON.parse(await readFile(join(pluginRoot, "package.json"), "utf8")) as {
        devDependencies: Record<string, string>;
    };
    run(
        "bun",
        ["add", "--dev", ...["@opentui/core", "@opentui/solid", "solid-js"].map(
            (name) => `${name}@${manifest.devDependencies[name]}`,
        )],
        installRoot,
    );

    const installedPackageRoot = join(
        installRoot,
        "node_modules",
        "@cortexkit",
        "opencode-magic-context",
    );
    const compiledIndex = join(installedPackageRoot, "src/tui-compiled/index.tsx");
    check("compiled TUI index ships in the packed package", existsSync(compiledIndex));

    const compiledIndexText = existsSync(compiledIndex) ? await readFile(compiledIndex, "utf8") : "";
    check(
        "compiled TUI imports the host runtime virtual modules",
        compiledIndexText.includes("opentui:runtime-module:"),
    );

    const stubbedRuntimeProbe = `
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.argv[1];
const runtimeSpecifiers = ${JSON.stringify(runtimeSpecifiers)};
const mid = (specifier) => "opentui:runtime-module:" + encodeURIComponent(specifier);
const resolved = new Map(runtimeSpecifiers.map((specifier) => [specifier, import.meta.resolve(specifier)]));

Bun.plugin({
  name: "opentui-runtime-module-stubs",
  setup(build) {
    for (const specifier of runtimeSpecifiers) {
      const target = resolved.get(specifier);
      build.module(mid(specifier), () => ({
        loader: "js",
        contents: "export * from " + JSON.stringify(target) + ";\\n" +
          "import * as namespace from " + JSON.stringify(target) + ";\\n" +
          "export default ('default' in namespace ? namespace.default : namespace);\\n",
      }));
    }
  },
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const solid = await import(mid("solid-js"));
assert(
  typeof solid.createSignal === "function" && typeof solid.createEffect === "function",
  "stubbed solid-js virtual module exposes reactive primitives",
);

const compiledSidebar = await readFile(
  join(packageRoot, "src/tui-compiled/slots/sidebar-content.tsx"),
  "utf8",
);
const rawSidebar = await readFile(join(packageRoot, "src/tui/slots/sidebar-content.tsx"), "utf8");
assert(
  compiledSidebar.includes("_$effect(") || compiledSidebar.includes("_$insert("),
  "compiled sidebar lacks OpenTUI reactive wrapper calls",
);
assert(
  !rawSidebar.includes("_$effect(") && !rawSidebar.includes("_$insert("),
  "raw sidebar unexpectedly contains compiled wrapper calls",
);

const compiled = await import(pathToFileURL(join(packageRoot, "src/tui-compiled/index.tsx")).href);
assert(
  compiled.default?.id === "opencode-magic-context" && typeof compiled.default?.tui === "function",
  "compiled TUI default export shape is invalid",
);
const entry = await import(pathToFileURL(join(packageRoot, "src/tui/entry.mjs")).href);
assert(
  entry.default?.id === "opencode-magic-context" && typeof entry.default?.tui === "function",
  "loader entry default export shape is invalid",
);
console.log("stubbed runtime probe loaded the compiled TUI path");
`;
    run("bun", ["-e", stubbedRuntimeProbe, installedPackageRoot], installRoot);
    check("stubbed virtual runtime probe imports the compiled TUI entry", true);

    const rawFallbackProbe = `
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.argv[1];
const entry = await import(pathToFileURL(join(packageRoot, "src/tui/entry.mjs")).href);
if (entry.default?.id !== "opencode-magic-context" || typeof entry.default?.tui !== "function") {
  throw new Error("raw TSX fallback default export shape is invalid");
}
console.log("raw TSX fallback probe loaded the TUI entry");
`;
    run("bun", ["-e", rawFallbackProbe, installedPackageRoot], installRoot);
    check("bare Bun probe imports the raw-TSX fallback", true);
} finally {
    if (process.env.KEEP_TUI_PACK_SMOKE !== "1") {
        await rm(tempRoot, { recursive: true, force: true });
    } else {
        console.log(`kept smoke temp dir: ${tempRoot}`);
    }
}

if (failures > 0) {
    console.error(`\nsmoke-tui-pack-install: ${failures} check(s) failed`);
    process.exit(1);
}
console.log("\nsmoke-tui-pack-install: all checks passed");
