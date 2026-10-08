import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@cortexkit/opencode-magic-context";

function run(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
    printOutput = true,
): { stdout: string; stderr: string } {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 20 * 1024 * 1024,
    });

    if (printOutput && result.stdout) process.stdout.write(result.stdout);
    if (printOutput && result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "unknown status"}`);
    }
    return { stdout: result.stdout, stderr: result.stderr };
}

function parsePackedFilename(stdout: string): string {
    try {
        const packed = JSON.parse(stdout.trim()) as Array<{ filename?: string }>;
        const filename = packed[0]?.filename;
        if (typeof filename === "string" && filename.length > 0) return filename;
    } catch {
        // npm can print warnings around JSON on some versions. Fall back to the
        // last tarball-looking line so the smoke is not tied to one npm version.
    }

    const fallback = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.endsWith(".tgz"))
        .at(-1);
    if (fallback) return fallback;
    throw new Error(`npm pack did not report a tarball: ${stdout.trim() || "no stdout"}`);
}

const tempRoot = await mkdtemp(join(tmpdir(), "magic-context-tokenizer-pack-"));
const cacheRoot = join(tempRoot, "cache");
const installRoot = join(cacheRoot, "opencode");
const projectRoot = join(tempRoot, "project");
const dataRoot = join(tempRoot, "data");
const hostSource = join(installRoot, "tokenizer-host.mjs");
const hostExecutable = join(tempRoot, process.platform === "win32" ? "opencode-host.exe" : "opencode-host");
// The tokenizer fallback warning is a diagnostic, so the plugin writes it to its
// log file rather than the host's stderr (OpenCode shows plugin stderr in the
// operator's terminal). Each probe gets its own log file so the count below
// belongs to exactly one run.
const resolvedLogPath = join(tempRoot, "resolved.log");
const fallbackLogPath = join(tempRoot, "fallback.log");
const fallbackWarning = "ai-tokenizer is unavailable";

async function readLog(logPath: string): Promise<string> {
    // The plugin creates its log only when it has something to write, so a run
    // that logged nothing leaves no file behind.
    return existsSync(logPath) ? readFile(logPath, "utf8") : "";
}

try {
    // Reuse the build whose freshness CI checked instead of replacing it before
    // the packaged-install probe. Standalone runs keep their build prerequisite.
    if (!process.argv.includes("--skip-build")) run("bun", ["run", "build"], pluginRoot);

    const packStdout = run(
        "npm",
        ["pack", "--json", "--pack-destination", tempRoot],
        pluginRoot,
        process.env,
        false,
    ).stdout;
    const tarball = join(tempRoot, parsePackedFilename(packStdout));
    if (!existsSync(tarball)) throw new Error(`npm pack did not create ${tarball}`);

    await mkdir(join(projectRoot, ".cortexkit"), { recursive: true });
    await writeFile(join(projectRoot, ".cortexkit", "magic-context.jsonc"), '{ "enabled": false }\n');
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
    run("npm", ["install", "--omit=dev", "--ignore-scripts"], installRoot);
    const canonicalCacheRoot = await realpath(cacheRoot);

    await writeFile(
        hostSource,
        `import plugin from ${JSON.stringify(packageName)};

const projectRoot = process.argv[2];
if (!projectRoot) throw new Error("missing project root");
console.log("compiled host import.meta.url=" + JSON.stringify(import.meta.url));
const hooks = await plugin.server({ directory: projectRoot, worktree: projectRoot, client: {} });
await hooks["chat.message"]?.({
  model: { providerID: "smoke-provider", modelID: "smoke-model" },
  agent: "smoke-agent",
}, {});
await hooks["tool.definition"]?.(
  { toolID: "smoke-tool" },
  { description: "Exercise lazy tokenizer resolution", parameters: { type: "object" } },
);
await hooks["tool.definition"]?.(
  { toolID: "smoke-tool-second" },
  { description: "Exercise the tokenizer a second time", parameters: { type: "object" } },
);
console.log("packed tokenizer estimates completed");
`,
    );

    // OpenCode runs as a Bun standalone executable. Re-bundling the installed
    // plugin into this host reproduces the virtual /$bunfs/root module base that
    // made createRequire(import.meta.url) unusable in the v0.36.0 Windows report.
    run("bun", ["build", "--compile", hostSource, "--outfile", hostExecutable], installRoot);
    const resolvedOutput = run(hostExecutable, [projectRoot], projectRoot, {
        ...process.env,
        XDG_CACHE_HOME: canonicalCacheRoot,
        MAGIC_CONTEXT_TEST_DATA_DIR: dataRoot,
        MAGIC_CONTEXT_LOG_PATH: resolvedLogPath,
    });
    if (!resolvedOutput.stdout.includes("packed tokenizer estimates completed")) {
        throw new Error("compiled packed-install probe did not exercise tokenizer estimates");
    }
    // The fallback probe below proves the warning reaches this log channel, so
    // its absence here means the packed tokenizer really resolved.
    if (`${resolvedOutput.stderr}${await readLog(resolvedLogPath)}`.includes(fallbackWarning)) {
        throw new Error("packed tokenizer resolved only through the approximate fallback");
    }

    const emptyCacheRoot = join(tempRoot, "empty-cache");
    await mkdir(emptyCacheRoot, { recursive: true });
    const fallbackOutput = run(hostExecutable, [projectRoot], projectRoot, {
        ...process.env,
        XDG_CACHE_HOME: emptyCacheRoot,
        MAGIC_CONTEXT_TEST_DATA_DIR: dataRoot,
        MAGIC_CONTEXT_LOG_PATH: fallbackLogPath,
    });
    if (!fallbackOutput.stdout.includes("packed tokenizer estimates completed")) {
        throw new Error("tokenizer resolution failure did not degrade to approximate estimates");
    }
    // Two estimates ran, so exactly one warning proves the once-per-process
    // guard; the warning must also stay off the operator's terminal.
    const fallbackWarnings = (await readLog(fallbackLogPath)).split(fallbackWarning).length - 1;
    if (fallbackWarnings !== 1) {
        throw new Error(`expected one tokenizer fallback warning in the plugin log, got ${fallbackWarnings}`);
    }
    if (fallbackOutput.stderr.includes(fallbackWarning)) {
        throw new Error("tokenizer fallback warning was written to the host's stderr");
    }
} finally {
    if (process.env.KEEP_TOKENIZER_PACK_SMOKE !== "1") {
        await rm(tempRoot, { recursive: true, force: true });
    } else {
        console.log(`kept smoke temp dir: ${tempRoot}`);
    }
}

console.log("smoke-tokenizer-pack-install: all checks passed");
