import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureSharedOpenCode2 } from "../scripts/ensure-shared-opencode2";
import { ROOT_KEYS, type OpenCode2Isolation } from "../src/opencode2-runner/spawn";

export function createRun(): OpenCode2Isolation {
    const parent = join(realpathSync(tmpdir()), "magic-context", "issue-886-live");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const root = mkdtempSync(join(parent, "run-"));
    const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        OPENCODE_DB: "opencode2.db",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    };
    for (const key of ROOT_KEYS) {
        env[key] = join(root, key);
        mkdirSync(env[key]!, { mode: 0o700 });
    }
    env.CFFIXED_USER_HOME = env.HOME;
    env.TMPDIR = join(root, "tmp");
    mkdirSync(env.TMPDIR!, { mode: 0o700 });
    env.MAGIC_CONTEXT_STORAGE_DIR = join(env.XDG_DATA_HOME!, "cortexkit", "magic-context");
    env.MAGIC_CONTEXT_LOG_PATH = join(root, "magic-context.log");
    const cwd = join(root, "work");
    mkdirSync(cwd, { mode: 0o700 });
    return { root, env, cwd };
}

/** The install helper probes --version; even those probes must use the private home. */
export async function installHost(fixture: OpenCode2Isolation): Promise<{ cli: string; version: string }> {
    const response = await fetch("https://registry.npmjs.org/@opencode%2fcli");
    if (!response.ok) throw new Error(`CLI version lookup failed: ${response.status}`);
    const versions = Object.keys((await response.json() as { versions: Record<string, unknown> }).versions)
        .filter((version) => /^2\.2\.\d+$/.test(version))
        .sort((a, b) => Number(b.split(".")[2]) - Number(a.split(".")[2]));
    const candidates = ["2.2.6", ...versions.filter((version) => version !== "2.2.6")];
    const original = process.env;
    try {
        process.env = { ...fixture.env };
        for (const version of candidates) {
            try {
                const cli = ensureSharedOpenCode2(version, join(fixture.root, "cli"));
                const aiRoot = join(fixture.root, "ai", version);
                mkdirSync(aiRoot, { recursive: true });
                writeFileSync(join(aiRoot, "package.json"), JSON.stringify({
                    private: true, dependencies: { "@opencode/ai": version },
                }));
                const install = spawnSync(process.execPath, ["install", "--linker=hoisted"], {
                    cwd: aiRoot, env: fixture.env, stdio: "inherit",
                });
                if (install.status !== 0) throw new Error("Matching AI schema install failed");
                // The launcher's schema guard requires an exact host/schema pair for 2.2.x.
                original.MC_E2E_OPENCODE2_AI_ROOT = aiRoot;
                return { cli, version };
            } catch {
                console.error(`OpenCode ${version} unavailable; trying the next supported 2.2.x`);
            }
        }
        throw new Error("No installable OpenCode 2.2.x + matching AI schema; refusing an older host");
    } finally {
        process.env = original;
    }
}
