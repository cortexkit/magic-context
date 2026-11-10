/**
 * Spawn an isolated `opencode serve` process with:
 * - its own config/data directories (no pollution of the user's real setup)
 * - a custom mock-anthropic provider pointed at our mock server
 * - the magic-context plugin loaded from local source via `file://` spec
 *
 * Returns the server URL and a handle with `kill()` for test cleanup.
 */

import { createE2ETempDir, cleanupE2ETempDir } from "../temp-dir";

import { type ChildProcess, spawn } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hostExtractCache } from '../host-extract-cache';
import { seedModelsCatalog } from "../models-catalog";
import { prepareContextDatabase } from "../prepare-context-db";
import { assertMockEndpoint, assertMockProviders, pinMockAgents } from "../mock-routing";
import {
    buildHermeticBinaries,
    detectRustModePrereqs,
    HermeticSubcStack,
} from "../rust-runner/hermetic-subc";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const PLUGIN_SRC_ROOT = join(REPO_ROOT, "packages/plugin/src");
const PLUGIN_DIST_ENTRY = join(REPO_ROOT, "packages/plugin/dist/index.js");
const PLUGIN_SRC_ENTRY = join(PLUGIN_SRC_ROOT, "index.ts");

function newestSourceMtime(directory: string): number {
    let newest = 0;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        newest = Math.max(
            newest,
            entry.isDirectory() ? newestSourceMtime(path) : statSync(path).mtimeMs,
        );
    }
    return newest;
}

// A fresh bundle is the closest production representation and avoids slow source
// loading on CI. Ignored dist files can survive a local checkout, though, so never
// let an older bundle silently test different code from the current source tree.
export const PLUGIN_ENTRY =
    existsSync(PLUGIN_DIST_ENTRY) &&
    statSync(PLUGIN_DIST_ENTRY).mtimeMs >= newestSourceMtime(PLUGIN_SRC_ROOT)
        ? PLUGIN_DIST_ENTRY
        : PLUGIN_SRC_ENTRY;

export interface IsolatedEnv {
    configDir: string;
    dataDir: string;
    cacheDir: string;
    workdir: string;
}

export interface SpawnedOpencode {
    url: string;
    port: number;
    pid: number;
    env: IsolatedEnv;
    /**
     * Stop the host. `root` decides the throwaway root: "keep" for a restart that
     * reuses it, "remove" when the test is done with it, and the default removes it
     * only when this spawn created it (not when it was given an existing env).
     */
    kill: (options?: { root?: "keep" | "remove" }) => Promise<void>;
    stdout: () => string;
    stderr: () => string;
    /** The hermetic Rust stack is provisioned only when MC_E2E_MODE is set to "rust"; this property exposes it when available. */
    rustStack?: HermeticSubcStack;
}

export interface SpawnOptions {
    /** URL of the mock Anthropic server, e.g. "http://127.0.0.1:12345" */
    mockProviderURL: string;
    /** Provider id registered for the mock. Defaults to "mock-anthropic". */
    mockProviderID?: string;
    /** AI SDK provider package used by the mock. Defaults to "@ai-sdk/anthropic". */
    mockProviderAPI?: "@ai-sdk/anthropic" | "@ai-sdk/openai";
    /** Model id exposed by the mock provider. Defaults to "mock-sonnet". */
    mockModelID?: string;
    additionalModelIDs?: string[];
    /** Port for opencode serve. Default: random available */
    port?: number;
    /** magic-context.jsonc overrides. Defaults keep most features on. */
    magicContextConfig?: Record<string, unknown>;
    /** Extra opencode.json provider/model config, merged with defaults. */
    openCodeConfigExtra?: Record<string, unknown>;
    /**
     * Extra config written to OpenCode's GLOBAL config directory
     * (`$XDG_CONFIG_HOME/opencode/opencode.json`) instead of the
     * `$OPENCODE_CONFIG_DIR` layer everything else uses.
     *
     * The harness points both env vars at the same isolated tree but at
     * DIFFERENT directories, so this reproduces the real-user shape where a
     * launcher exports `OPENCODE_CONFIG_DIR` and the user's own settings still
     * live in the global directory. OpenCode reads both and lets the
     * `$OPENCODE_CONFIG_DIR` layer win ties. Default: nothing extra.
     */
    openCodeGlobalConfigExtra?: Record<string, unknown>;
    /**
     * Drop the harness's default `compaction` block from the
     * `$OPENCODE_CONFIG_DIR` layer, leaving `openCodeGlobalConfigExtra` as the
     * only place compaction is configured. Default: keep it.
     */
    omitConfigDirCompaction?: boolean;
    /** Override the mock model's context token limit. Default 200000. */
    modelContextLimit?: number;
    /**
     * Register a second model on the mock provider and pin the historian to it,
     * so a scenario can keep a small window on the session model while the
     * historian gets a window large enough to hold its prompt, as it does for
     * real users. Default: the historian uses the session model.
     */
    historianMockModel?: { id: string; contextLimit: number };
    /** Pre-create the isolated Magic Context DB unless the test expects the plugin to stay disabled. */
    prepareContextDatabase?: boolean;
    /** Expected Magic Context state after startup; readiness waits for this state. Defaults to enabled. */
    expectedMagicContextState?: "enabled" | "configured-disabled" | "conflict-disabled";
    /**
     * Reuse a pre-created isolated env instead of allocating a fresh one. The
     * Rust-mode harness creates the env first so a hermetic subc daemon can
     * write its connection file into `${dataDir}/cortexkit/run/` BEFORE opencode
     * boots, and so a serve restart can re-attach to the same data dir (keeping
     * opencode.db + context.db across the restart). Default: allocate a new env.
     */
    existingEnv?: IsolatedEnv;
    /**
     * When set, add `subc: { connection_file }` to the USER-tier magic-context
     * config. This is the only tier that gates `userTierHasSubc` (project-tier
     * `subc` is stripped by project-security), so Rust mode needs it here to
     * activate. Default: no user-tier subc block (TS mode).
     */
    userSubcConnectionFile?: string;
    /**
     * When set, ALSO write `<workdir>/.cortexkit/magic-context.jsonc` (the
     * project-tier config). Rust mode is opted in per-project via
     * `transform_mode: "rust"` here, mirroring production where a repo selects
     * the runtime while the user supplies daemon credentials. Default: no
     * project-tier config file.
     */
    projectMagicContextConfig?: Record<string, unknown>;
    /**
     * Extra environment variables for the opencode child (e.g.
     * MAGIC_CONTEXT_LOG_PATH to redirect the plugin diagnostic log to a
     * per-suite file). Merged last, overriding inherited values.
     */
    extraEnv?: Record<string, string>;
    /**
     * models.dev catalogue copied into the host cache before boot. Fetching is then
     * disabled so the host's model metadata comes from this file alone.
     */
    modelsCatalog?: string;
    /**
     * Register this provider/model on the mock (Anthropic wire) next to the session
     * model and pin the historian to it, so the historian can use a real provider id
     * while the session keeps the default mock model.
     */
    historianProviderModel?: { providerID: string; modelID: string };
}

/**
 * Orphan containment. Three layers, each covering a failure mode the previous
 * one cannot reach:
 *
 * 1. Children spawn DETACHED into their own process group, and `kill()` signals
 *    the whole group — so helpers the serve itself forks die with it.
 * 2. Runner-exit safety net: every live group is tracked module-wide and killed
 *    synchronously from process exit/signal handlers, covering suites that die
 *    without running their teardown (thrown errors, SIGINT/SIGTERM).
 * 3. Startup sweep: a SIGKILLed runner can hook nothing, so the NEXT run reaps
 *    any `opencode serve` that has reparented to ppid 1 and whose cwd sits under
 *    an opencode-e2e fixture dir — stale by construction (live runs always have
 *    a live parent). Without this, each crashed run permanently leaks servers
 *    (observed: 28 orphans / ~15GB RSS nearly halting the shared host).
 */
const liveChildGroups = new Set<number>();
let exitReapersInstalled = false;

function killGroup(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pid, signal);
    } catch {
        // Group already gone — fall back to the lone pid in case the child
        // never became a group leader (spawn raced its own setsid).
        try {
            process.kill(pid, signal);
        } catch {
            // Already dead: containment goal reached.
        }
    }
}

function installExitReapers(): void {
    if (exitReapersInstalled) return;
    exitReapersInstalled = true;
    // `exit` handlers must stay synchronous; process.kill is.
    process.prependOnceListener("exit", () => {
        for (const pid of liveChildGroups) killGroup(pid, "SIGKILL");
    });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.once(signal, () => {
            for (const pid of liveChildGroups) killGroup(pid, "SIGKILL");
            process.exit(1);
        });
    }
}

// Canonicalize the temp base: macOS tmpdir() returns /var/folders/... but
// lsof reports process cwds under the resolved /private/var/folders/... —
// comparing un-canonicalized prefixes silently matches nothing (the Bug #20
// symlink-lineage class), turning the sweep into a lying instrument.
const E2E_FIXTURE_PREFIX = join(realpathSync(tmpdir()), "opencode-e2e-");
let orphanSweepDone = false;

/** cwd of a pid via lsof; null when unreadable (gone or not ours to see). */
function processCwd(pid: number): string | null {
    const res = Bun.spawnSync(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], { windowsHide: true });
    if (res.exitCode !== 0) return null;
    const line = res.stdout
        .toString()
        .split("\n")
        .find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
}

/**
 * Reap ppid-1 `opencode serve` orphans left under our fixture prefix by a
 * previously killed runner. Runs once per test process, before the first spawn.
 */
export function sweepOrphanedServes(): number {
    // Best-effort hygiene: minimal container images (the Docker e2e host) ship
    // no `ps`, and a fresh PID-namespaced container has no orphans to reap by
    // construction. Missing tooling must degrade to "nothing swept", never
    // throw ENOENT into the first spawn of every test file.
    if (!Bun.which("ps")) return 0;
    let ps: ReturnType<typeof Bun.spawnSync>;
    try {
        ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="], { windowsHide: true });
    } catch {
        return 0;
    }
    if (ps.exitCode !== 0 || !ps.stdout) return 0;
    let reaped = 0;
    for (const line of ps.stdout.toString().split("\n")) {
        const m = line.match(/^\s*(\d+)\s+1\s+(.*opencode serve .*)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const rawCwd = processCwd(pid);
        if (!rawCwd) continue;
        let cwd = rawCwd;
        try {
            cwd = realpathSync(rawCwd);
        } catch {
            // cwd already deleted — an orphan whose fixture dir is gone is still
            // stale by construction, but without a resolvable path we cannot
            // prove it is OURS; leave it rather than kill on a guess.
            continue;
        }
        if (!cwd.startsWith(E2E_FIXTURE_PREFIX)) continue;
        killGroup(pid, "SIGKILL");
        reaped += 1;
    }
    return reaped;
}


/**
 * Create isolated config/data/cache dirs under a unique temp subdir.
 *
 * Exported so the Rust-mode harness can allocate the env up front: it needs the
 * concrete `dataDir` before opencode boots to place a hermetic subc daemon's
 * connection file at `${dataDir}/cortexkit/run/subc-connection.json` (the path
 * the plugin's Rust module client reads), and it reuses the same env across a
 * serve restart so opencode.db + context.db survive the restart.
 */
export function createIsolatedEnv(): IsolatedEnv {
    const base = createE2ETempDir("opencode-e2e-");
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
 * - opencode.json: registers our plugin via file:// spec and defines a configurable
 *   mock provider/model whose baseURL points to the local mock server.
 * - magic-context.jsonc: starts with small thresholds so tests trigger historian
 *   deterministically with modest scripted token counts.
 */
export function writeConfigs(
    env: IsolatedEnv,
    mockProviderURL: string,
    opts: SpawnOptions,
): void {
    const pluginSpec = `file://${process.env.MC_E2E_PLUGIN_ENTRY ?? PLUGIN_ENTRY}`;
    const mockProviderID = opts.mockProviderID ?? "mock-anthropic";
    const mockProviderAPI = opts.mockProviderAPI ?? "@ai-sdk/anthropic";
    const mockModelID = opts.mockModelID ?? "mock-sonnet";
    const mockModel = (modelID: string, contextLimit: number): Record<string, unknown> => ({
        id: modelID,
        name: `Mock ${modelID}`,
        cost: { input: 0, output: 0 },
        limit: { context: contextLimit, output: 8192 },
        modalities: {
            input: ["text", "image", "pdf"],
            output: ["text"],
        },
        options: {},
    });
    const historianModel = opts.historianMockModel;
    const providerConfig = (
        api: "@ai-sdk/anthropic" | "@ai-sdk/openai",
        modelID: string,
        withHistorianModel = false,
    ): Record<string, unknown> => ({
        api,
        name: api === "@ai-sdk/openai" ? "Mock OpenAI Responses" : "Mock Anthropic",
        npm: api,
        env: [],
        options: {
            apiKey: "test-key-not-real",
            baseURL: mockProviderURL,
        },
        models: {
            [modelID]: mockModel(modelID, opts.modelContextLimit ?? 200000),
            ...Object.fromEntries((opts.additionalModelIDs ?? []).map((id) =>
                [id, mockModel(id, opts.modelContextLimit ?? 200000)])),
            ...(withHistorianModel && historianModel
                ? { [historianModel.id]: mockModel(historianModel.id, historianModel.contextLimit) }
                : {}),
        },
    });

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
            [mockProviderID]: providerConfig(mockProviderAPI, mockModelID, true),
            ...(opts.historianProviderModel
                ? {
                      [opts.historianProviderModel.providerID]: providerConfig(
                          "@ai-sdk/anthropic",
                          opts.historianProviderModel.modelID,
                      ),
                  }
                : {}),
            ...(mockProviderAPI === "@ai-sdk/openai"
                ? {
                      "mock-anthropic-setup": providerConfig(
                          "@ai-sdk/anthropic",
                          "mock-sonnet",
                      ),
                  }
                : {}),
        },
        ...(opts.openCodeConfigExtra ?? {}),
    };

    const registeredProviders = opencodeConfig.provider as Record<string, { options?: { baseURL?: string } }>;
    assertMockEndpoint(registeredProviders[mockProviderID]?.options?.baseURL, mockProviderURL);
    for (const provider of Object.values(registeredProviders)) {
        assertMockEndpoint(provider.options?.baseURL, mockProviderURL);
    }
    // Prevent environment credentials and the built-in catalog from enabling
    // providers absent from the fixture, including automatic small-model calls.
    opencodeConfig.enabled_providers = Object.keys(registeredProviders);
    opencodeConfig.model = `${mockProviderID}/${mockModelID}`;
    opencodeConfig.small_model = `${mockProviderID}/${mockModelID}`;

    // magic-context defaults tuned for fast triggering in tests. This is the
    // USER-tier config: thresholds live here because project-tier thresholds are
    // security-clamped raise-only, so a small/fast threshold must come from the
    // trusted user tier. Rust mode's `subc.connection_file` is also user-tier —
    // it is the only tier that flips `userTierHasSubc`, which the transform-mode
    // resolver requires before Rust can activate (project-tier `subc` is stripped
    // by project-security hardening).
    const magicContext: Record<string, unknown> = {
        $schema:
            "https://raw.githubusercontent.com/cortexkit/opencode-magic-context/master/assets/magic-context.schema.json",
        execute_threshold_percentage: 40,
        history_budget_percentage: 0.15,
        dreamer: { disable: true },
        ...pinMockAgents(
            opts.magicContextConfig,
            `${mockProviderID}/${mockModelID}`,
            "opencode",
            opts.historianProviderModel
                ? {
                      historian: `${opts.historianProviderModel.providerID}/${opts.historianProviderModel.modelID}`,
                  }
                : historianModel
                  ? { historian: `${mockProviderID}/${historianModel.id}` }
                  : {},
        ),
    };
    if (opts.userSubcConnectionFile) {
        magicContext.subc = { connection_file: opts.userSubcConnectionFile };
    }

    if (opts.omitConfigDirCompaction) delete opencodeConfig.compaction;

    writeFileSync(join(env.configDir, "opencode.json"), JSON.stringify(opencodeConfig, null, 2));
    if (process.env.MC_E2E_TRACE_PROVIDER === "1") {
        console.error(`[mock-config] ${JSON.stringify({ configDir: env.configDir, mockProviderURL, opencodeConfig, magicContext })}`);
    }

    // Write the authoritative shared user config on every boot, including restarts.
    // A legacy OpenCode file is ignored once startup migration has created the
    // CortexKit file, so rewriting that legacy path would leave old settings live.
    const userConfigDir = join(env.configDir, "cortexkit");
    mkdirSync(userConfigDir, { recursive: true });
    writeFileSync(
        join(userConfigDir, "magic-context.jsonc"),
        JSON.stringify(magicContext, null, 2),
    );

    // OpenCode's own global config stays in its host-specific directory — the layer
    // a launcher's OPENCODE_CONFIG_DIR sits on top of rather than replacing.
    if (opts.openCodeGlobalConfigExtra) {
        const openCodeConfigDir = join(env.configDir, "opencode");
        mkdirSync(openCodeConfigDir, { recursive: true });
        writeFileSync(
            join(openCodeConfigDir, "opencode.json"),
            JSON.stringify(
                { $schema: "https://opencode.ai/config.json", ...opts.openCodeGlobalConfigExtra },
                null,
                2,
            ),
        );
    }

    // Project-tier config: written to the hard-cutover location the loader reads,
    // `<workdir>/.cortexkit/magic-context.jsonc`. Rust mode is opted in here via
    // `transform_mode: "rust"`, matching production where a repository selects the
    // runtime while the user supplies the daemon credentials above. This file is
    // (re)written on every spawn so a serve restart can flip the mode in place
    // (the cold-start-drop-seed scenario switches ts→rust across a restart).
    if (opts.projectMagicContextConfig) {
        const projectConfigDir = join(env.workdir, ".cortexkit");
        mkdirSync(projectConfigDir, { recursive: true });
        writeFileSync(
            join(projectConfigDir, "magic-context.jsonc"),
            JSON.stringify(
                {
                    $schema:
                        "https://raw.githubusercontent.com/cortexkit/opencode-magic-context/master/assets/magic-context.schema.json",
                    ...opts.projectMagicContextConfig,
                },
                null,
                2,
            ),
        );
    }

    // tui.json: not needed for headless serve, but harmless to emit nothing for now.
}

export interface ReadinessOptions {
    expectedMagicContextState?: "enabled" | "configured-disabled" | "conflict-disabled";
    pluginLogPath?: string;
    pluginLogStartOffset?: number;
    mockProviderID?: string;
    mockModelID?: string;
}

const CONFLICT_DISABLE_VERDICT = "[magic-context] disabled due to conflicts:";

function hasConflictDisableVerdict(logPath: string, startOffset: number): boolean {
    try {
        return readFileSync(logPath)
            .subarray(startOffset)
            .toString("utf8")
            .includes(CONFLICT_DISABLE_VERDICT);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

/**
 * Wait until OpenCode can list sessions, Magic Context reaches its expected boot
 * state, and the configured mock model is available. The `/doc` and `/session`
 * endpoints can respond before provider config and plugin hooks finish loading;
 * returning at that intermediate state lets the first prompt race startup. Polls
 * for up to `timeoutMs`.
 *
 * Implementation note — Bun fetch timeout flake:
 *   Bun's default `fetch()` has a hardcoded ~5 minute timeout that ignores
 *   AbortSignal.timeout values longer than the limit
 *   (https://github.com/oven-sh/bun/issues/16682). If we don't bound each
 *   fetch attempt explicitly, a single hung request can hold the loop for
 *   the entire ~5 minute window, blowing past our overall deadline before
 *   we get any chance to retry. Pass a short AbortSignal.timeout on every
 *   attempt so one bad fetch can't starve the deadline.
 */
// Default bumped from 30s → 300s. GitHub-hosted runners can take much longer
// than 30s for `opencode serve` to bind its port + finish plugin init + complete
// opencode's own one-time SQLite migration (which opencode itself warns "may
// take a few minutes" on first boot per fresh CI XDG_DATA_HOME). Local hardware
// finishes in <2s. The bump to 300s covers CI cold-start without papering over
// genuine readiness failures — 5 minutes is still far above any realistic boot.
export async function waitForReady(
    url: string,
    directory: string,
    timeoutMs = 300_000,
    options: ReadinessOptions = {},
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const FETCH_TIMEOUT_MS = 2_000;
    const expectedMagicContextState = options.expectedMagicContextState ?? "enabled";
    const mockProviderID = options.mockProviderID ?? "mock-anthropic";
    const mockModelID = options.mockModelID ?? "mock-sonnet";
    if (expectedMagicContextState === "conflict-disabled" && !options.pluginLogPath) {
        throw new Error("conflict-disabled readiness requires a plugin log path");
    }

    const sessionUrl = new URL("/session", url);
    const toolsUrl = new URL("/experimental/tool/ids", url);
    const providersUrl = new URL("/config/providers", url);
    for (const readinessUrl of [sessionUrl, toolsUrl, providersUrl]) {
        readinessUrl.searchParams.set("directory", directory);
    }

    const attempts = { session: 0, magicContext: 0, provider: 0 };
    let lastReadinessError: unknown = null;
    const fetchJson = async (readinessUrl: URL, label: string): Promise<unknown> => {
        const res = await fetch(readinessUrl, {
            method: "GET",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`${label} readiness returned HTTP ${res.status}`);
        return res.json().catch(() => null);
    };
    const waitForStage = async (
        stage: keyof typeof attempts,
        probe: () => Promise<void> | void,
    ): Promise<void> => {
        while (Date.now() < deadline) {
            attempts[stage] += 1;
            try {
                await probe();
                return;
            } catch (error) {
                lastReadinessError = error;
            }
            await Bun.sleep(200);
        }
        throw new Error(
            `opencode serve did not become ready in ${timeoutMs}ms.\n` +
                `  expectedMagicContextState=${expectedMagicContextState}\n` +
                `  failedStage=${stage}\n` +
                `  sessionUrl=${sessionUrl.toString()}\n` +
                `  toolsUrl=${toolsUrl.toString()}\n` +
                `  providersUrl=${providersUrl.toString()}\n` +
                `  pluginLogPath=${options.pluginLogPath ?? "unused"}\n` +
                `  attempts=${JSON.stringify(attempts)}\n` +
                `  readinessLastErr=${String(lastReadinessError)}`,
        );
    };

    await waitForStage("session", async () => {
        const sessions = await fetchJson(sessionUrl, "session API");
        if (!Array.isArray(sessions)) {
            throw new Error("session readiness response was not an array");
        }
    });

    // Probe plugin state only after the application route is live. A conflict-disabled
    // plugin intentionally has no Magic Context tools, so its explicit boot log is the
    // positive verdict; treating a missing tool as disabled would recreate the race.
    if (expectedMagicContextState === "conflict-disabled") {
        await waitForStage("magicContext", () => {
            if (
                !hasConflictDisableVerdict(
                    options.pluginLogPath!,
                    options.pluginLogStartOffset ?? 0,
                )
            ) {
                throw new Error("Magic Context conflict-disable verdict is not ready");
            }
        });
    } else if (expectedMagicContextState === "enabled") {
        await waitForStage("magicContext", async () => {
            const toolIds = await fetchJson(toolsUrl, "plugin tools");
            if (!Array.isArray(toolIds) || !toolIds.includes("ctx_search")) {
                throw new Error("Magic Context tool registry is not ready");
            }
        });
    }

    await waitForStage("provider", async () => {
        const providerConfig = await fetchJson(providersUrl, "provider config");
        const providers =
            providerConfig && typeof providerConfig === "object"
                ? (providerConfig as { providers?: unknown }).providers
                : null;
        const mockProvider = Array.isArray(providers)
            ? providers.find(
                  (provider) =>
                      provider &&
                      typeof provider === "object" &&
                      (provider as { id?: unknown }).id === mockProviderID,
              )
            : null;
        const models =
            mockProvider && typeof mockProvider === "object"
                ? (mockProvider as { models?: unknown }).models
                : null;
        if (!models || typeof models !== "object" || !(mockModelID in models)) {
            throw new Error(`${mockProviderID}/${mockModelID} provider config is not ready`);
        }
    });
}

interface RustSpawnResources {
    env: IsolatedEnv;
    connectionFile: string;
    stack: HermeticSubcStack;
}

/**
 * Provision the Rust stack at the shared OpenCode spawn seam. Keeping this
 * decision here means a suite body never needs a mode branch: the same harness
 * creates either a regular isolated process or the real ck-subc + ck-mc path.
 */
async function provisionRustMode(existingEnv?: IsolatedEnv): Promise<RustSpawnResources> {
    const prereqs = detectRustModePrereqs();
    if (!prereqs.ok) {
        throw new Error(
            `MC_E2E_MODE=rust prerequisite failure: ${prereqs.skipReason ?? "unknown prerequisite"}`,
        );
    }
    const { ckMcBin, ckSubcBin } = await buildHermeticBinaries(prereqs.subconsciousRoot);
    // A host restart must reconnect to the same isolated databases and session.
    // The daemon/module are new processes, not a reason to allocate a new root.
    const env = existingEnv ?? createIsolatedEnv();
    try {
        const stack = await HermeticSubcStack.start({ dataDir: env.dataDir, ckMcBin, ckSubcBin });
        return { env, connectionFile: stack.connectionFile, stack };
    } catch (error) {
        throw new Error(`MC_E2E_MODE=rust failed to start the hermetic stack: ${String(error)}`);
    }
}

export async function spawnOpencode(opts: SpawnOptions): Promise<SpawnedOpencode> {
    // MC_E2E_MODE is intentionally read only at this shared spawn seam. Rust
    // suites that already supplied a daemon connection keep their existing
    // stack; ordinary suites get one provisioned here for the rust invocation.
    const rustMode = process.env.MC_E2E_MODE === "rust";
    const resources = rustMode && !opts.userSubcConnectionFile
        ? await provisionRustMode(opts.existingEnv)
        : null;
    const resolvedOpts: SpawnOptions = resources
        ? {
              ...opts,
              existingEnv: resources.env,
              userSubcConnectionFile: resources.connectionFile,
              magicContextConfig: {
                  historian: { opencode: { model: "mock-anthropic/mock-sonnet" } },
                  ...(opts.magicContextConfig ?? {}),
              },
              projectMagicContextConfig: {
                  ...(opts.projectMagicContextConfig ?? {}),
                  transform_mode: "rust",
              },
          }
        : opts;

    // Reuse a caller-provided env for the Rust-mode harness (connection file
    // pre-placed, data dir shared across a serve restart); otherwise allocate.
    const env = resolvedOpts.existingEnv ?? createIsolatedEnv();
    try {
        // Let OpenCode keep the listening socket it obtains from port 0. Selecting a
        // free port in a separate process creates a release/rebind race with sibling
        // test workers, which surfaces as an opaque ServeError under full-leg load.
        let port = resolvedOpts.port ?? 0;

        if (resolvedOpts.prepareContextDatabase !== false) prepareContextDatabase(env.dataDir);
        writeConfigs(env, resolvedOpts.mockProviderURL, resolvedOpts);
        if (resolvedOpts.modelsCatalog) seedModelsCatalog(env.cacheDir, resolvedOpts.modelsCatalog);

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
            // Plugin unit-test preload sets this so bare openDatabase() cannot touch
            // the developer's real DB. The OpenCode child must use the harness data
            // dir instead; leaking the preload path makes the plugin look at a
            // throwaway tree that is not the isolated session under test.
            if (key === "MAGIC_CONTEXT_TEST_DATA_DIR") continue;
            // Strip any inherited subc supervised-launch identity. When the test
            // process is itself launched under a subc supervisor (e.g. an AFT/Alfonso
            // worktree sets SUBC_MODULE_ID=aft), the plugin's Rust module client would
            // present THAT supervised identity to our hermetic daemon, which rejects it
            // ("consumer_identity for module_id 'aft' did not match a supervised launch
            // nonce"). A real opencode install is never launched under a supervised subc
            // identity, so clearing these matches production and lets the plugin connect
            // as an ordinary client. Harmless for TS-mode suites, which never touch subc.
            if (key === "SUBC_MODULE_ID") continue;
            if (key === "SUBC_LAUNCH_NONCE") continue;
            childEnv[key] = value;
        }
        // OpenCode also scans ~/.opencode outside the XDG config tree. Keep that
        // lookup in the fixture, not in the operator's home directory.
        childEnv.HOME = dirname(env.dataDir);
        // Foundation's HTTP cache on macOS ignores HOME/XDG unless its user home
        // is overridden too. Keep that SQLite cache in the same private fixture.
        childEnv.CFFIXED_USER_HOME = childEnv.HOME;
        childEnv.OPENCODE_CONFIG_DIR = env.configDir;
        childEnv.XDG_CONFIG_HOME = env.configDir;
        childEnv.XDG_DATA_HOME = env.dataDir;
        childEnv.XDG_CACHE_HOME = env.cacheDir;
        childEnv.XDG_STATE_HOME = join(env.dataDir, "state");
        childEnv.XDG_RUNTIME_DIR = join(env.dataDir, "runtime");
        childEnv.OPENCODE_DB = join(env.dataDir, "opencode", "opencode.db");
        // The child must not inherit a storage override pointing outside its per-test data home.
        childEnv.MAGIC_CONTEXT_STORAGE_DIR = join(env.dataDir, "cortexkit", "magic-context");
        // Ensure anthropic doesn't bail for missing env vars — we use a fake key.
        childEnv.ANTHROPIC_API_KEY = "test-key-not-real";
        // Caller overrides (e.g. MAGIC_CONTEXT_LOG_PATH pointing the plugin log at a
        // per-suite file so Rust-mode scenarios can assert on transform decisions).
        // Merged last so an explicit override wins over the inherited value.
        if (resolvedOpts.modelsCatalog) childEnv.OPENCODE_DISABLE_MODELS_FETCH = "1";
        for (const [key, value] of Object.entries(resolvedOpts.extraEnv ?? {})) {
            childEnv[key] = value;
        }
        childEnv.MAGIC_CONTEXT_LOG_SYNC = "1";
        childEnv.TMPDIR = hostExtractCache();
        const pluginLogPath =
            childEnv.MAGIC_CONTEXT_LOG_PATH?.trim() ||
            join(env.dataDir, "cortexkit", "magic-context-e2e.log");
        childEnv.MAGIC_CONTEXT_LOG_PATH = pluginLogPath;
        const pluginLogStartOffset = existsSync(pluginLogPath) ? statSync(pluginLogPath).size : 0;

        installExitReapers();
        if (!orphanSweepDone) {
            orphanSweepDone = true;
            sweepOrphanedServes();
        }

        // Hostname: 0.0.0.0 only on CI — empirically on GitHub-hosted runners,
        // opencode binding to 127.0.0.1 sometimes results in Bun's `fetch()` timing
        // out even though `curl` succeeds; binding all interfaces removes the
        // loopback-specific stack-resolution edge case (IPv4-only AF_INET vs
        // IPv4-mapped IPv6, AF_UNSPEC name resolution, etc.). Locally we keep the
        // loopback bind so a leaked process never listens on external interfaces.
        // Clients always connect to `127.0.0.1:${port}` either way.
        const listenHost = process.env.CI ? "0.0.0.0" : "127.0.0.1";
        // `detached: true` gives the child its own process group so kill()/reapers
        // can signal the entire tree (serve + anything it forks) as one unit.
        const child: ChildProcess = spawn(
            "opencode",
            ["serve", "--port", String(port), "--hostname", listenHost],
            {
                cwd: env.workdir,
                env: childEnv,
                stdio: ["ignore", "pipe", "pipe"],
                detached: true,
                windowsHide: true,
            },
        );
        const exited = new Promise<void>((resolveExit) => child.once("close", resolveExit));
        if (child.pid) {
            liveChildGroups.add(child.pid);
            child.once("exit", () => {
                if (child.pid) liveChildGroups.delete(child.pid);
            });
        }

        let stdoutBuf = "";
        let stderrBuf = "";
        child.once("error", (error) => { stderrBuf += String(error); });
        child.stdout?.on("data", (chunk: Buffer) => {
            stdoutBuf += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            stderrBuf += chunk.toString();
        });

        let url = "";
        try {
            if (port === 0) {
                const portDeadline = Date.now() + 30_000;
                while (Date.now() < portDeadline) {
                    const match = stdoutBuf.match(/opencode server listening on https?:\/\/[^:\s]+:(\d+)/);
                    if (match) {
                        port = Number(match[1]);
                        break;
                    }
                    if (child.exitCode !== null || child.signalCode !== null) {
                        throw new Error(`opencode serve exited before reporting its bound port`);
                    }
                    await Bun.sleep(20);
                }
                if (port === 0) {
                    throw new Error(`opencode serve did not report its bound port within 30000ms`);
                }
            }
            url = `http://127.0.0.1:${port}`;
            await waitForReady(url, env.workdir, 300_000, {
                expectedMagicContextState: resolvedOpts.expectedMagicContextState,
                pluginLogPath,
                pluginLogStartOffset,
                mockProviderID: resolvedOpts.mockProviderID,
                mockModelID: resolvedOpts.mockModelID,
            });
            const providers = await fetch(`${url}/config/providers`).then((response) => response.json());
            assertMockProviders(providers, resolvedOpts.mockProviderURL);
            if (process.env.MC_E2E_TRACE_PROVIDER === "1") {
                const endpoints = (providers as { providers: Array<{ id: string; options?: { baseURL?: string } }> }).providers
                    .map((provider) => ({ id: provider.id, baseURL: provider.options?.baseURL }));
                console.error(`[mock-effective-providers] ${JSON.stringify({ url, endpoints })}`);
            }
        } catch (err) {
            // Surface captured output on boot failure to help debugging.
            if (child.pid) killGroup(child.pid, "SIGKILL");
            await exited;
            await resources?.stack.stop();
            throw new Error(
                `opencode serve failed to start.\n--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}\n\n${String(err)}`,
            );
        }

        let rustStackStopped = false;
        const stopProvisionedRustStack = async (): Promise<void> => {
            if (!resources || rustStackStopped) return;
            rustStackStopped = true;
            await resources.stack.stop();
        };

        return {
            url,
            port,
            pid: child.pid!,
            env,
            stdout: () => stdoutBuf,
            stderr: () => stderrBuf,
            rustStack: resources?.stack,
            kill: async (options?: { root?: "keep" | "remove" }) => {
                try {
                    if (child.exitCode === null && child.signalCode === null && child.pid) {
                        killGroup(child.pid, "SIGTERM");
                        await new Promise<void>((resolveKill) => {
                            const timer = setTimeout(() => {
                                if (child.pid) killGroup(child.pid, "SIGKILL");
                            }, 3000);
                            child.once("exit", () => {
                                clearTimeout(timer);
                                resolveKill();
                            });
                        });
                    }
                } finally {
                    if (child.pid) liveChildGroups.delete(child.pid);
                    try { await stopProvisionedRustStack(); } finally {
                        const removeRoot =
                            options?.root === "remove" ||
                            (options?.root !== "keep" && !opts.existingEnv);
                        if (removeRoot) cleanupE2ETempDir(dirname(env.configDir));
                    }
                }
            },
        };
    } catch (error) {
        if (!opts.existingEnv) cleanupE2ETempDir(dirname(env.configDir));
        throw error;
    }
}
