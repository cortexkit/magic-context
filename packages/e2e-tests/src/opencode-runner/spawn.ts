/**
 * Spawn an isolated `opencode serve` process with:
 * - its own config/data directories (no pollution of the user's real setup)
 * - a custom mock-anthropic provider pointed at our mock server
 * - the magic-context plugin loaded from local source via `file://` spec
 *
 * Returns the server URL and a handle with `kill()` for test cleanup.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const PLUGIN_ENTRY = join(REPO_ROOT, "packages/plugin/src/index.ts");

export interface IsolatedEnv {
    configDir: string;
    dataDir: string;
    cacheDir: string;
    workdir: string;
}

export interface SpawnedOpencode {
    url: string;
    port: number;
    env: IsolatedEnv;
    kill: () => Promise<void>;
    stdout: () => string;
    stderr: () => string;
}

export interface SpawnOptions {
    /** URL of the mock Anthropic server, e.g. "http://127.0.0.1:12345" */
    mockProviderURL: string;
    /** Port for opencode serve. Default: random available */
    port?: number;
    /** magic-context.jsonc overrides. Defaults keep most features on. */
    magicContextConfig?: Record<string, unknown>;
    /** Extra opencode.json provider/model config, merged with defaults. */
    openCodeConfigExtra?: Record<string, unknown>;
    /** Override the mock model's context token limit. Default 200000. */
    modelContextLimit?: number;
}

/**
 * Pick a random free port by asking the OS for one. Uses Bun.serve + immediate stop.
 */
async function pickFreePort(): Promise<number> {
    const server = Bun.serve({ port: 0, fetch: () => new Response() });
    const port: number = server.port ?? 0;
    server.stop(true);
    if (!port) throw new Error("could not allocate a free port");
    return port;
}

/**
 * Create isolated config/data/cache dirs under a unique temp subdir.
 */
function createIsolatedEnv(): IsolatedEnv {
    const unique = `opencode-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const base = join(tmpdir(), unique);
    const configDir = join(base, "config");
    const dataDir = join(base, "data");
    const cacheDir = join(base, "cache");
    const workdir = join(base, "work");
    for (const d of [configDir, dataDir, cacheDir, workdir]) {
        mkdirSync(d, { recursive: true });
    }
    return { configDir, dataDir, cacheDir, workdir };
}

/**
 * Write opencode.json + magic-context.jsonc + tui.json into config/workdir.
 *
 * - opencode.json: registers our plugin via file:// spec, defines a mock-anthropic
 *   provider and a mock model, sets provider.mock-anthropic.options.baseURL to the
 *   mock server's URL.
 * - magic-context.jsonc: starts with small thresholds so tests trigger historian
 *   deterministically with modest scripted token counts.
 */
function writeConfigs(
    env: IsolatedEnv,
    mockProviderURL: string,
    opts: SpawnOptions,
): void {
    const pluginSpec = `file://${PLUGIN_ENTRY}`;

    const opencodeConfig: Record<string, unknown> = {
        $schema: "https://opencode.ai/config.json",
        plugin: [pluginSpec],
        // Disable telemetry-style checks that could reach out.
        autoupdate: false,
        // Match what `setup`/`doctor` writes for real users. OpenCode compaction
        // defaults to enabled; if we leave it on, magic-context's conflict
        // detector disables itself and the plugin becomes a no-op.
        compaction: { auto: false, prune: false },
        provider: {
            "mock-anthropic": {
                api: "@ai-sdk/anthropic",
                name: "Mock Anthropic",
                npm: "@ai-sdk/anthropic",
                env: [],
                options: {
                    apiKey: "test-key-not-real",
                    baseURL: mockProviderURL,
                },
                models: {
                    "mock-sonnet": {
                        id: "mock-sonnet",
                        name: "Mock Sonnet",
                        cost: { input: 0, output: 0 },
                        limit: { context: opts.modelContextLimit ?? 200000, output: 8192 },
                        options: {},
                    },
                },
            },
        },
        ...(opts.openCodeConfigExtra ?? {}),
    };

    // magic-context defaults tuned for fast triggering in tests.
    const magicContext = {
        $schema:
            "https://raw.githubusercontent.com/cortexkit/opencode-magic-context/master/assets/magic-context.schema.json",
        execute_threshold_percentage: 40,
        history_budget_percentage: 0.15,
        dreamer: { enabled: false },
        sidekick: { enabled: false },
        ...(opts.magicContextConfig ?? {}),
    };

    writeFileSync(join(env.configDir, "opencode.json"), JSON.stringify(opencodeConfig, null, 2));
    writeFileSync(
        join(env.configDir, "magic-context.jsonc"),
        JSON.stringify(magicContext, null, 2),
    );

    // tui.json: not needed for headless serve, but harmless to emit nothing for now.
}

/**
 * Wait until the opencode server responds to GET /doc (an endpoint that exists in
 * OpenCode's server). Polls for up to `timeoutMs`.
 */
async function waitForReady(url: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${url}/doc`, { method: "GET" });
            if (res.ok || res.status === 404 || res.status === 401) {
                // Server is responding — any HTTP response means it booted.
                return;
            }
        } catch (err) {
            lastErr = err;
        }
        await Bun.sleep(200);
    }
    throw new Error(`opencode serve did not become ready in ${timeoutMs}ms: ${lastErr}`);
}

export async function spawnOpencode(opts: SpawnOptions): Promise<SpawnedOpencode> {
    const env = createIsolatedEnv();
    const port = opts.port ?? (await pickFreePort());

    writeConfigs(env, opts.mockProviderURL, opts);

    // Explicitly strip any inherited OPENCODE_SERVER_PASSWORD from the parent shell —
    // our tests run unsecured on a random localhost port, and inherited auth would
    // force every SDK request to carry Basic auth headers we don't set.
    // Also strip NODE_ENV=test: Bun's test runner sets it automatically and the
    // plugin's logger (src/shared/logger.ts) silences all output when NODE_ENV=test.
    // We want the subprocess to behave like a real install, so the log file gets
    // populated normally for diagnostics.
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (key === "OPENCODE_SERVER_PASSWORD") continue;
        if (key === "OPENCODE_SERVER_USERNAME") continue;
        if (key === "NODE_ENV") continue;
        childEnv[key] = value;
    }
    childEnv.OPENCODE_CONFIG_DIR = env.configDir;
    childEnv.XDG_CONFIG_HOME = env.configDir;
    childEnv.XDG_DATA_HOME = env.dataDir;
    childEnv.XDG_CACHE_HOME = env.cacheDir;
    // Ensure anthropic doesn't bail for missing env vars — we use a fake key.
    childEnv.ANTHROPIC_API_KEY = "test-key-not-real";

    const child: ChildProcess = spawn(
        "opencode",
        ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
        {
            cwd: env.workdir,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
        },
    );

    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
    });

    const url = `http://127.0.0.1:${port}`;
    try {
        await waitForReady(url);
    } catch (err) {
        // Surface captured output on boot failure to help debugging.
        child.kill("SIGTERM");
        throw new Error(
            `opencode serve failed to start.\n--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}\n\n${String(err)}`,
        );
    }

    return {
        url,
        port,
        env,
        stdout: () => stdoutBuf,
        stderr: () => stderrBuf,
        kill: async () => {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGTERM");
                await new Promise<void>((resolveKill) => {
                    const timer = setTimeout(() => {
                        child.kill("SIGKILL");
                        resolveKill();
                    }, 3000);
                    child.once("exit", () => {
                        clearTimeout(timer);
                        resolveKill();
                    });
                });
            }
        },
    };
}
