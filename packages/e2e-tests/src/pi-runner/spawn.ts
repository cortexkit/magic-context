/**
 * Spawn one isolated `pi --print --mode json` turn with Magic Context loaded
 * from the local Pi plugin package.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const PI_PLUGIN_ROOT = join(REPO_ROOT, "packages/pi-plugin");
const PI_CLI = join(
    REPO_ROOT,
    "node_modules/.bun/@mariozechner+pi-coding-agent@0.70.5+e0f88c919211175f/node_modules/@mariozechner/pi-coding-agent/dist/cli.js",
);

export interface PiIsolatedEnv {
    baseDir: string;
    configDir: string;
    dataDir: string;
    cacheDir: string;
    workdir: string;
    agentDir: string;
    pluginDir: string;
}

export interface PiRunResult {
    sessionId: string | null;
    events: Array<Record<string, unknown>>;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
}

export interface PiSpawnOptions {
    mockProviderURL: string;
    env?: PiIsolatedEnv;
    magicContextConfig?: Record<string, unknown>;
    piSettingsExtra?: Record<string, unknown>;
    modelContextLimit?: number;
    timeoutMs?: number;
    continueSession?: boolean;
}

export function createPiIsolatedEnv(sharedDataDir?: string): PiIsolatedEnv {
    const unique = `pi-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const baseDirRaw = join(tmpdir(), unique);
    mkdirSync(baseDirRaw, { recursive: true });
    const baseDir = realpathSync(baseDirRaw);
    const configDir = join(baseDir, "config");
    const dataDir = sharedDataDir ? realpathSync(sharedDataDir) : join(baseDir, "data");
    const cacheDir = join(baseDir, "cache");
    const workdir = join(baseDir, "work");
    const agentDir = join(baseDir, ".pi", "agent");
    const pluginDir = join(agentDir, "extensions", "pi-magic-context");
    for (const d of [configDir, dataDir, cacheDir, workdir, agentDir, join(agentDir, "extensions")]) {
        mkdirSync(d, { recursive: true });
    }

    // Use real paths consistently to avoid /var vs /private/var identity drift on macOS.
    return {
        baseDir: realpathSync(baseDir),
        configDir: realpathSync(configDir),
        dataDir: realpathSync(dataDir),
        cacheDir: realpathSync(cacheDir),
        workdir: realpathSync(workdir),
        agentDir: realpathSync(agentDir),
        pluginDir,
    };
}

function ensurePluginAvailable(env: PiIsolatedEnv): void {
    const distEntry = join(PI_PLUGIN_ROOT, "dist", "index.js");
    if (!existsSync(distEntry)) {
        throw new Error(`${distEntry} is missing. Run: cd packages/pi-plugin && bun run build`);
    }
    if (!existsSync(env.pluginDir)) {
        symlinkSync(PI_PLUGIN_ROOT, env.pluginDir, "dir");
    }
}

function writeConfigs(env: PiIsolatedEnv, opts: PiSpawnOptions): void {
    ensurePluginAvailable(env);

    const settings = {
        packages: [env.pluginDir],
        defaultProvider: "anthropic",
        defaultModel: "claude-haiku-4-5",
        enabledModels: ["anthropic/claude-haiku-4-5"],
        compaction: { enabled: false },
        retry: { enabled: false },
        quietStartup: true,
        enableInstallTelemetry: false,
        ...(opts.piSettingsExtra ?? {}),
    };
    writeFileSync(join(env.agentDir, "settings.json"), JSON.stringify(settings, null, 2));

    const models = {
        providers: {
            anthropic: {
                baseUrl: opts.mockProviderURL,
                apiKey: "test-key-not-real",
                modelOverrides: {
                    "claude-haiku-4-5": {
                        contextWindow: opts.modelContextLimit ?? 200000,
                        maxTokens: 8192,
                        reasoning: false,
                    },
                },
            },
        },
    };
    writeFileSync(join(env.agentDir, "models.json"), JSON.stringify(models, null, 2));

    const magicContext = {
        $schema:
            "https://raw.githubusercontent.com/cortexkit/opencode-magic-context/master/assets/magic-context.schema.json",
        enabled: true,
        ctx_reduce_enabled: true,
        protected_tags: 1,
        execute_threshold_percentage: 40,
        history_budget_percentage: 0.15,
        memory: { enabled: true, auto_promote: false },
        embedding: { provider: "off" },
        historian: { model: "" },
        dreamer: { enabled: false },
        sidekick: { enabled: false },
        experimental: {
            auto_search: { enabled: false },
            git_commit_indexing: { enabled: false },
        },
        ...(opts.magicContextConfig ?? {}),
    };
    writeFileSync(join(env.agentDir, "magic-context.jsonc"), JSON.stringify(magicContext, null, 2));
}

function childEnv(env: PiIsolatedEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (key === "NODE_ENV") continue;
        result[key] = value;
    }
    result.PI_CODING_AGENT_DIR = env.agentDir;
    result.HOME = env.baseDir;
    result.XDG_CONFIG_HOME = env.configDir;
    result.XDG_DATA_HOME = env.dataDir;
    result.XDG_CACHE_HOME = env.cacheDir;
    result.ANTHROPIC_API_KEY = "test-key-not-real";
    result.PI_OFFLINE = "1";
    result.PI_SKIP_VERSION_CHECK = "1";
    return result;
}

function parseJsonEvents(stdout: string): Array<Record<string, unknown>> {
    return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export async function spawnPiTurn(
    prompt: string,
    opts: PiSpawnOptions,
): Promise<{ env: PiIsolatedEnv; result: PiRunResult }> {
    const env = opts.env ?? createPiIsolatedEnv();
    writeConfigs(env, opts);

    const child: ChildProcess = spawn(
        "bun",
        [
            PI_CLI,
            "--print",
            "--mode",
            "json",
            ...(opts.continueSession ? ["--continue"] : []),
            "--no-extensions",
            "--extension",
            env.pluginDir,
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--model",
            "anthropic/claude-haiku-4-5",
            "--api-key",
            "test-key-not-real",
            prompt,
        ],
        { cwd: env.workdir, env: childEnv(env), stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
    });

    const timeoutMs = opts.timeoutMs ?? 30_000;
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolveExit({ code: null, signal: "SIGKILL" });
        }, timeoutMs);
        child.once("exit", (code, signal) => {
            clearTimeout(timer);
            resolveExit({ code, signal });
        });
    });

    let events: Array<Record<string, unknown>> = [];
    try {
        events = parseJsonEvents(stdout);
    } catch (error) {
        throw new Error(
            `Pi JSON output parse failed: ${error instanceof Error ? error.message : String(error)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
    }

    const session = events.find((event) => event.type === "session") as { id?: string } | undefined;
    const result: PiRunResult = {
        sessionId: session?.id ?? null,
        events,
        stdout,
        stderr,
        exitCode: exit.code,
        signalCode: exit.signal,
    };

    if (exit.signal === "SIGKILL") {
        throw new Error(`pi --print timed out after ${timeoutMs}ms\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
    }

    return { env, result };
}
