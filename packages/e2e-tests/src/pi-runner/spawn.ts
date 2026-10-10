import { createE2ETempDir } from "../temp-dir";
/** Shared Pi e2e process configuration helpers. */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { __test as subagentRunnerTest } from "../../../pi-plugin/src/subagent-runner";
import { hostExtractCache } from '../host-extract-cache';
import { assertMockEndpoint, pinMockAgents } from "../mock-routing";

export const REPO_ROOT = resolve(import.meta.dir, "../../../..");
export const PI_PLUGIN_ROOT = join(REPO_ROOT, "packages/pi-plugin");
const require_ = createRequire(import.meta.url);

function compareSemver(a: string, b: string): number {
  const left = a.split(".").map((part) => Number(part));
  const right = b.split(".").map((part) => Number(part));
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export type PiRunnerHost = "pi" | "omp";

const HOST_PACKAGES: Record<PiRunnerHost, string> = {
  pi: "@earendil-works/pi-coding-agent",
  omp: "@oh-my-pi/pi-coding-agent",
};

export function resolvePiPackageJson(host: PiRunnerHost = "pi"): string {
  const packageName = HOST_PACKAGES[host];
  // Host-version comparisons (for example a control run on an older Pi) pin
  // the host explicitly: either an absolute package.json from a separate
  // install, or an exact version already present in the repository's bun store.
  const explicitPackageJson = host === "pi"
    ? process.env.MC_E2E_PI_PACKAGE_JSON
    : process.env.MC_E2E_OMP_PACKAGE_JSON;
  if (explicitPackageJson) return explicitPackageJson;
  if (host === "pi") {
    const pinnedVersion = process.env.MC_E2E_PI_VERSION;
    if (pinnedVersion) {
      const bunModules = join(REPO_ROOT, "node_modules/.bun");
      const prefix = `${packageName.replace("/", "+")}@${pinnedVersion}+`;
      const match = readdirSync(bunModules).find((name) => name.startsWith(prefix));
      if (match === undefined) {
        throw new Error(`MC_E2E_PI_VERSION=${pinnedVersion} is not installed under ${bunModules}`);
      }
      return join(bunModules, match, "node_modules", packageName, "package.json");
    }
  }
  try {
    return require_.resolve(`${packageName}/package.json`);
  } catch {
    const bunModules = join(REPO_ROOT, "node_modules/.bun");
    const prefix = `${packageName.replace("/", "+")}@`;
    const candidates = readdirSync(bunModules, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => {
        const version = entry.name.slice(prefix.length).split("+")[0] ?? "0.0.0";
        return { name: entry.name, version };
      })
      .sort((a, b) => compareSemver(b.version, a.version));
    const best = candidates[0];
    if (best === undefined) throw new Error(`Could not locate ${packageName} under ${bunModules}`);
    return join(bunModules, best.name, "node_modules", packageName, "package.json");
  }
}

function packageCli(packageJson: string, host: PiRunnerHost): string {
  const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[host];
  if (!bin) throw new Error(`${packageJson} does not declare the ${host} CLI`);
  return join(dirname(packageJson), bin);
}

export function resolvePiHostInvocation(host: PiRunnerHost = "pi") {
  const packageJson = resolvePiPackageJson(host);
  const cli = packageCli(packageJson, host);
  const invocation = subagentRunnerTest.resolvePiInvocation({
    execPath: process.execPath,
    argv1: cli,
    resolvePackageJson: () => packageJson,
  });
  if (invocation.targetHarness !== host) {
    throw new Error(`Resolved ${HOST_PACKAGES[host]} as ${invocation.targetHarness}`);
  }
  return { ...invocation, cli, packageJson };
}

export const PI_PACKAGE_JSON = resolvePiPackageJson("pi");
export const PI_CLI = packageCli(PI_PACKAGE_JSON, "pi");
export const PI_RELOAD_EXTENSION = join(import.meta.dir, "reload-extension.mjs");

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

export interface PiRunnerOptions {
  host?: PiRunnerHost;
  mockProviderURL: string;
  env?: PiIsolatedEnv;
  magicContextConfig?: Record<string, unknown>;
  piSettingsExtra?: Record<string, unknown>;
  modelContextLimit?: number;
  extensionsBeforeMagicContext?: string[];
  extensionsAfterMagicContext?: string[];
  /** Compatibility option from the old spawn-per-turn runner. RPC sessions persist naturally. */
  continueSession?: boolean;
}

export type PiSpawnOptions = PiRunnerOptions;

export function createPiIsolatedEnv(
  sharedDataDir?: string,
  host: PiRunnerHost = "pi",
): PiIsolatedEnv {
  const baseDirRaw = createE2ETempDir(`${host}-e2e-`);
  mkdirSync(baseDirRaw, { recursive: true });
  const baseDir = realpathSync(baseDirRaw);
  const configDir = join(baseDir, "config");
  const dataDir = sharedDataDir ? realpathSync(sharedDataDir) : join(baseDir, "data");
  const cacheDir = join(baseDir, "cache");
  const workdir = join(baseDir, "work");
  const agentDir = join(baseDir, host === "omp" ? ".omp" : ".pi", "agent");
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
    // OMP standardizeMacOSPath removes /private before exposing ctx.cwd.
    workdir: host === "omp" && process.platform === "darwin"
      ? realpathSync(workdir).replace(/^\/private(?=\/var\/)/, "")
      : realpathSync(workdir),
    agentDir: realpathSync(agentDir),
    pluginDir,
  };
}

export function ensurePluginAvailable(env: PiIsolatedEnv): void {
  // MC_E2E_PI_PLUGIN_ROOT runs a released plugin package (for example an npm
  // tarball extracted elsewhere) instead of this checkout's build.
  const pluginRoot = process.env.MC_E2E_PI_PLUGIN_ROOT ?? PI_PLUGIN_ROOT;
  const distEntry = join(pluginRoot, "dist", "index.js");
  if (!existsSync(distEntry)) {
    throw new Error(`${distEntry} is missing. Run: cd packages/pi-plugin && bun run build`);
  }
  if (!existsSync(env.pluginDir)) {
    symlinkSync(pluginRoot, env.pluginDir, "dir");
  }
}

export function writeConfigs(env: PiIsolatedEnv, opts: PiRunnerOptions): void {
  ensurePluginAvailable(env);
  const host = opts.host ?? "pi";
  const modelRef = host === "omp" ? "mock/mock-model" : "anthropic/claude-haiku-4-5";

  const settings = {
    packages: [env.pluginDir],
    // Scripted provider replies call tools directly, not through OMP's xd:// transport.
    ...(host === "omp" ? { tools: { xdev: false, intentTracing: false } } : {}),
    defaultProvider: host === "omp" ? "mock" : "anthropic",
    defaultModel: host === "omp" ? "mock-model" : "claude-haiku-4-5",
    enabledModels: [modelRef],
    compaction: { enabled: false },
    retry: { enabled: false },
    quietStartup: true,
    enableInstallTelemetry: false,
    ...(opts.piSettingsExtra ?? {}),
  };
  writeFileSync(join(env.agentDir, host === "omp" ? "config.yml" : "settings.json"), JSON.stringify(settings, null, 2));

  const models: {
    providers: Record<string, { baseUrl: string; [key: string]: unknown }>;
  } = host === "omp"
    ? {
        providers: {
          mock: {
            api: "anthropic-messages",
            baseUrl: opts.mockProviderURL,
            apiKey: "test-key-not-real",
            models: [
              {
                id: "mock-model",
                name: "Mock Model",
                input: ["text"],
                contextWindow: opts.modelContextLimit ?? 200000,
                maxTokens: 8192,
                reasoning: false,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }
    : {
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
  const provider = models.providers[host === "omp" ? "mock" : "anthropic"]!;
  assertMockEndpoint(provider.baseUrl, opts.mockProviderURL);
  writeFileSync(join(env.agentDir, "models.json"), JSON.stringify(models, null, 2));

  const magicContext = {
    $schema:
      "https://raw.githubusercontent.com/cortexkit/opencode-magic-context/master/assets/magic-context.schema.json",
    enabled: true,
    protected_tags: 1,
    execute_threshold_percentage: 40,
    history_budget_percentage: 0.15,
    memory: {
      enabled: true,
      auto_promote: false,
      auto_search: { enabled: false },
      git_commit_indexing: { enabled: false },
    },
    embedding: { provider: "off" },
    historian: { model: modelRef },
    dreamer: { disable: true },
    ...pinMockAgents(opts.magicContextConfig, modelRef, host),
  };
  // Store Magic Context settings under XDG_CONFIG_HOME/cortexkit, the shared
  // user-level location both hosts load instead of Pi's legacy agent directory.
  const userConfigDir = join(env.configDir, "cortexkit");
  mkdirSync(userConfigDir, { recursive: true });
  writeFileSync(join(userConfigDir, "magic-context.jsonc"), JSON.stringify(magicContext, null, 2));
}

export function childEnv(env: PiIsolatedEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "NODE_ENV") continue;
    result[key] = value;
  }
  result.TMPDIR = hostExtractCache();
  result.PI_CODING_AGENT_DIR = env.agentDir;
  result.HOME = env.baseDir;
  // macOS Foundation may create an HTTP-cache database independently of XDG.
  result.CFFIXED_USER_HOME = result.HOME;
  result.XDG_CONFIG_HOME = env.configDir;
  result.XDG_DATA_HOME = env.dataDir;
  result.XDG_CACHE_HOME = env.cacheDir;
  result.XDG_STATE_HOME = join(env.dataDir, "state");
  result.XDG_RUNTIME_DIR = join(env.baseDir, "runtime");
  result.OPENCODE_DB = join(env.dataDir, "opencode", "opencode.db");
  result.MAGIC_CONTEXT_STORAGE_DIR = join(env.dataDir, "cortexkit", "magic-context");
  for (const dir of [result.XDG_STATE_HOME, result.XDG_RUNTIME_DIR, result.MAGIC_CONTEXT_STORAGE_DIR]) mkdirSync(dir, { recursive: true });
  result.ANTHROPIC_API_KEY = "test-key-not-real";
  result.PI_OFFLINE = "1";
  result.PI_SKIP_VERSION_CHECK = "1";
  return result;
}
