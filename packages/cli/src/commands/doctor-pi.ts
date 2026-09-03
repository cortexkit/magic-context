import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { resolveCortexKitProjectConfigPath } from "@magic-context/core/config/migrate-config-location";
import {
    dropInheritedEmbeddingKeyOnRedirect,
    stripUnsafeProjectConfigFields,
} from "@magic-context/core/config/project-security";
import { loadRawConfigFile } from "@magic-context/core/config/raw-loader";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { substituteConfigVariables } from "@magic-context/core/config/variable";
import {
    type EmbeddingProbeOutcome,
    probeEmbeddingEndpoint,
} from "@magic-context/core/features/magic-context/memory/embedding-probe";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getLiveMigrationBlockingProcesses } from "@magic-context/core/features/magic-context/storage-db";
import {
    getMagicContextStorageDir,
    getMagicContextStorageResolution,
} from "@magic-context/core/shared/data-path";
import {
    isPrototypePollutionKey,
    sanitizeParsedJson,
} from "@magic-context/core/shared/jsonc-parser";
import { loadPiConfig } from "@magic-context/pi-core/config";
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";

import { writeFileAtomic } from "../lib/atomic-write";
import {
    hasUserConfigLocationMigrationRefusal,
    migrateConfigLocationsForCli,
} from "../lib/config-location-migration";
import {
    openExistingContextDatabase,
    openExistingContextDatabaseForMutation,
    UnsupportedSchemaVersionError,
} from "../lib/database-access";
import { formatDatabaseRepairGuidance } from "../lib/database-repair-guidance";
import { collectDiagnostics } from "../lib/diagnostics-pi";
import {
    checkLocalEmbeddingRuntimeByResolution,
    formatLocalEmbeddingRuntimeDoctorWarning,
    formatLocalEmbeddingRuntimeWasmFallback,
    formatLocalEmbeddingRuntimeWasmSelected,
    isLocalEmbeddingRuntimeBroken,
} from "../lib/embedding-runtime";
import {
    formatGithubIssueFallback,
    type GhCommandResult,
    submitGithubIssue,
} from "../lib/github-issue";
import { bundleIssueReport } from "../lib/logs-pi";
import {
    getMagicContextLogPath,
    getPiAgentConfigDir,
    getPiCacheRoot,
    getPiUserConfigPath,
    getPiUserExtensionsPath,
} from "../lib/paths";
import {
    detectPiBinary,
    getPiVersion,
    PI_PACKAGE_SOURCE,
    type PiBinaryInfo,
} from "../lib/pi-helpers";
import {
    describePiPackageEntry,
    getPiMagicContextPackageSpecifier,
    hasPiMagicContextPackage,
    isPiMagicContextPackageEntry,
} from "../lib/pi-package-entry";
import { type PromptIO, promptIO } from "../lib/prompts";
import { sanitizeDiagnosticEndpoint, sanitizeDiagnosticText } from "../lib/redaction";
import {
    checkStorageVersionFence,
    formatStorageVersions,
    readStorageVersions,
} from "../lib/storage-versions";
import { runV22BackfillCommands, type V22BackfillCommandArgs } from "../lib/v22-backfill-commands";
import { writePiSettingsPackage } from "./setup-pi";

const PACKAGE_NAME = "@cortexkit/pi-magic-context";
// Pi 0.74.0 renamed the npm package scope from `@mariozechner/pi-coding-agent`
// to `@earendil-works/pi-coding-agent`. Magic Context's peerDependency targets
// the new scope, so older Pi installs cannot load this extension.
const MIN_PI_VERSION = "0.74.0";
const ROW_COUNT_TABLES = ["tags", "compartments", "memories", "notes", "dream_runs"];

type CheckStatus = "pass" | "warn" | "fail" | "info";

interface CheckResult {
    status: CheckStatus;
    message: string;
}

interface RepairPlan {
    addPackageEntry: boolean;
    writeUserConfig: boolean;
    clearCachePaths: string[];
}

interface HealthReport {
    results: CheckResult[];
    repairPlan: RepairPlan;
    pass: number;
    warn: number;
    fail: number;
}

interface DoctorDeps {
    prompts: PromptIO;
    collectDiagnostics: typeof collectDiagnostics;
    detectPiBinary: () => PiBinaryInfo | null;
    getPiVersion: (piPath: string) => string | null;
    getLatestNpmVersion: () => string | null;
    selfVersion: () => string;
    probeEmbeddingEndpoint: typeof probeEmbeddingEndpoint;
    openExistingContextDatabase: typeof openExistingContextDatabase;
    now: () => Date;
    execFileSync: typeof execFileSync;
    spawnSync: typeof spawnSync;
}

export interface RunDoctorOptions extends V22BackfillCommandArgs {
    force?: boolean;
    issue?: boolean;
    help?: boolean;
    cwd?: string;
    prompts?: PromptIO;
    deps?: Partial<DoctorDeps>;
}

const DEFAULT_DEPS: DoctorDeps = {
    prompts: promptIO,
    collectDiagnostics,
    detectPiBinary,
    getPiVersion,
    getLatestNpmVersion: () => getLatestNpmVersion(PACKAGE_NAME),
    selfVersion,
    probeEmbeddingEndpoint,
    openExistingContextDatabase,
    now: () => new Date(),
    execFileSync,
    spawnSync,
};

function depsFrom(options: RunDoctorOptions): DoctorDeps {
    return {
        ...DEFAULT_DEPS,
        prompts: options.prompts ?? DEFAULT_DEPS.prompts,
        ...options.deps,
    };
}

function printDoctorHelp(): void {
    console.log("");
    console.log("  Magic Context for Pi doctor");
    console.log("  ───────────────────────────");
    console.log("");
    console.log("  Usage:");
    console.log("    magic-context-pi doctor          Run health checks");
    console.log("    magic-context-pi doctor --force  Repair safe issues, then re-check");
    console.log("    magic-context-pi doctor --issue  Create a sanitized bug report");
    console.log(
        "    magic-context-pi doctor --check-v22-backfill  Show v22 memory backfill status",
    );
    console.log(
        "    magic-context-pi doctor --retry-v22-backfill  Retry failed v22 memory backfill rows",
    );
    console.log(
        "    magic-context-pi doctor --rekey-v22-dir-identity <path>  Re-key legacy dir identity rows",
    );
    console.log("    magic-context-pi doctor --help   Show this help");
    console.log("");
}

function selfVersion(): string {
    const req = createRequire(import.meta.url);
    for (const relPath of ["../../package.json", "../package.json"]) {
        try {
            const pkg = req(relPath) as { version?: unknown };
            if (typeof pkg.version === "string") return pkg.version;
        } catch {
            // Try next layout.
        }
    }
    return "unknown";
}

function getLatestNpmVersion(packageName: string): string | null {
    try {
        return execFileSync("npm", ["view", packageName, "version"], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 10_000,
        }).trim();
    } catch {
        return null;
    }
}

function parseSemver(version: string | null): [number, number, number] | null {
    if (!version) return null;
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: string | null, b: string): number | null {
    const left = parseSemver(a);
    const right = parseSemver(b);
    if (!left || !right) return null;
    for (let i = 0; i < 3; i += 1) {
        if (left[i] < right[i]) return -1;
        if (left[i] > right[i]) return 1;
    }
    return 0;
}

function add(results: CheckResult[], status: CheckStatus, message: string): void {
    results.push({ status, message });
}

function printResult(prompts: PromptIO, result: CheckResult): void {
    const line = `${result.status.toUpperCase()} ${result.message}`;
    if (result.status === "pass") prompts.log.success(line);
    else if (result.status === "info") prompts.log.info(line);
    else if (result.status === "warn") prompts.log.warn(line);
    else prompts.log.error(line);
}

function summarize(results: CheckResult[]): Pick<HealthReport, "pass" | "warn" | "fail"> {
    return {
        pass: results.filter((result) => result.status === "pass").length,
        warn: results.filter((result) => result.status === "warn").length,
        fail: results.filter((result) => result.status === "fail").length,
    };
}

function readJsonc(path: string): {
    value: Record<string, unknown>;
    error?: string;
} {
    try {
        return {
            value: parseJsonc(readFileSync(path, "utf-8")) as Record<string, unknown>,
        };
    } catch (error) {
        return {
            value: {},
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function readMagicContextJsonc(
    path: string,
    tier: "user" | "project",
): {
    value: Record<string, unknown>;
    error?: string;
} {
    try {
        const raw = loadRawConfigFile({ configPath: path, tier });
        if (!raw)
            return { value: {}, error: "config file disappeared while doctor was reading it" };
        return { value: parseJsonc(raw.text) as Record<string, unknown> };
    } catch (error) {
        return {
            value: {},
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function packagesFrom(settings: Record<string, unknown>): unknown[] {
    return Array.isArray(settings.packages) ? settings.packages : [];
}

/**
 * Candidate installed-plugin directories to point the local-embedding-runtime
 * resolver at. Pi's layout varies (verified on disk): a LOCAL DEV-PATH entry in
 * packages[] (e.g. "../../repo/packages/pi-plugin", relative to the agent dir),
 * OR a managed npm install at ~/.pi/agent/npm/node_modules/<pkg> (user) /
 * <cwd>/.pi/npm/node_modules/<pkg> (project). We collect every plausible dir
 * with a package.json; the resolver stays SILENT for any that don't exist.
 */
/** True when the directory's package.json declares the magic-context Pi plugin. */
function isPiMagicContextPackageDir(dir: string): boolean {
    const packageJson = join(dir, "package.json");
    if (!existsSync(packageJson)) return false;
    try {
        const pkg = JSON.parse(readFileSync(packageJson, "utf-8")) as {
            name?: unknown;
        };
        return typeof pkg.name === "string" && pkg.name === PACKAGE_NAME;
    } catch {
        return false;
    }
}

function piPluginDirCandidates(packages: unknown[], cwd: string): string[] {
    const dirs: string[] = [];
    const agentDir = getPiAgentConfigDir();

    // Local dev-path entries: a string spec that is NOT an npm: specifier and
    // resolves to a directory on disk. Relative entries are resolved against the
    // Pi agent dir (Pi's settings.packages base). Only directories whose
    // package.json names the magic-context plugin itself are candidates — other
    // local extensions registered in packages[] must not be probed for the
    // embedding runtime.
    for (const entry of packages) {
        const spec = typeof entry === "string" ? entry.trim() : "";
        if (!spec || spec.startsWith("npm:")) continue;
        const resolved = isAbsolute(spec) ? spec : join(agentDir, spec);
        if (isPiMagicContextPackageDir(resolved)) dirs.push(resolved);
    }

    // Managed npm install roots (hoisted): <root>/node_modules/<pkg>.
    dirs.push(join(agentDir, "npm", "node_modules", PACKAGE_NAME));
    dirs.push(join(cwd, ".pi", "npm", "node_modules", PACKAGE_NAME));

    return dirs.filter((dir) => existsSync(join(dir, "package.json")));
}

function projectConfigPath(cwd: string): string {
    return resolveCortexKitProjectConfigPath(cwd);
}

function readConfigForEmbedding(
    path: string,
    isProjectConfig: boolean,
): Record<string, unknown> | null {
    if (!existsSync(path)) return null;
    try {
        const raw = loadRawConfigFile({
            configPath: path,
            tier: isProjectConfig ? "project" : "user",
        });
        if (!raw) return null;
        // SECURITY: project-level config must NOT expand {env:}/{file:} tokens —
        // a malicious repo could otherwise resolve {env:ANTHROPIC_API_KEY} into a
        // field we then send to a repo-chosen endpoint. Mirror the runtime loader
        // (isProjectConfig leaves tokens literal for project config).
        const substituted = substituteConfigVariables({
            text: raw.text,
            configPath: path,
            isProjectConfig,
        });
        const rejectedKeyPaths: string[] = [];
        const parsed = sanitizeParsedJson(parseJsonc(substituted.text) as Record<string, unknown>, {
            onRejectedKey: (keyPath) => rejectedKeyPaths.push(keyPath.join(".")),
        });
        if (rejectedKeyPaths.length > 0) {
            throw new Error("unsafe prototype-pollution key in config");
        }
        return parsed;
    } catch {
        return null;
    }
}

function classifyEmbeddingOutcome(outcome: EmbeddingProbeOutcome): CheckResult {
    switch (outcome.kind) {
        case "ok":
            return {
                status: "pass",
                message: `Embedding endpoint OK (${outcome.status}, ${outcome.dimensions ?? "?"}-dim vectors)`,
            };
        case "auth_failed":
            return {
                status: "fail",
                message: `Embedding endpoint rejected credentials (${outcome.status})`,
            };
        case "timeout":
            return {
                status: "warn",
                message: `Embedding endpoint timed out after ${outcome.timeoutMs}ms`,
            };
        case "network_error":
            return {
                status: "fail",
                message: `Embedding endpoint network error: ${sanitizeDiagnosticText(outcome.message)}`,
            };
        case "endpoint_unsupported":
            return {
                status: "fail",
                message: `Embedding endpoint does not support embeddings (${outcome.status})`,
            };
        case "http_error":
            return {
                status: "fail",
                message: `Embedding endpoint returned HTTP ${outcome.status}`,
            };
        case "invalid_scheme":
            return {
                status: "fail",
                message: `Embedding endpoint must start with http:// or https://: ${sanitizeDiagnosticEndpoint(outcome.endpoint)}`,
            };
    }
}

function countTable(db: ContextDatabase, table: string): number | null {
    try {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count?: unknown;
        };
        return typeof row?.count === "number" ? row.count : null;
    } catch {
        return null;
    }
}

function pinnedVersionFromPackageSpecifier(specifier: string | null): string | null {
    if (!specifier) return null;
    const normalized = specifier.replace(/^npm:/, "");
    const slash = normalized.indexOf("/");
    const versionAt = normalized.indexOf("@", slash + 1);
    if (versionAt < 0) return null;
    const version = normalized.slice(versionAt + 1);
    return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

function cacheRoots(cwd: string): string[] {
    const home = process.env.HOME?.trim();
    const cacheHome = process.env.XDG_CACHE_HOME || join(home || homedir(), ".cache");
    const piCacheRoot = getPiCacheRoot();
    return [
        join(piCacheRoot, "extensions"),
        join(piCacheRoot, "packages"),
        join(cacheHome, "pi", "extensions"),
        join(cacheHome, "pi", "packages"),
        join(getPiAgentConfigDir(), "cache", "extensions"),
        join(getPiAgentConfigDir(), "npm", "node_modules", PACKAGE_NAME),
        join(cwd, ".pi", "npm", "node_modules", PACKAGE_NAME),
    ];
}

function findPiMagicContextCacheDirs(
    cwd: string,
    expectedVersion: string | null,
    force = false,
): Array<{ path: string; version?: string }> {
    const found = new Map<string, { path: string; version?: string }>();
    const visit = (path: string, depth: number): void => {
        if (depth < 0 || !existsSync(path)) return;
        let stat: ReturnType<typeof statSync>;
        try {
            stat = statSync(path);
        } catch {
            return;
        }
        if (!stat.isDirectory()) return;

        const packageJson = join(path, "package.json");
        if (existsSync(packageJson)) {
            try {
                const pkg = JSON.parse(readFileSync(packageJson, "utf-8")) as {
                    name?: unknown;
                    version?: unknown;
                };
                const name = typeof pkg.name === "string" ? pkg.name : "";
                const version = typeof pkg.version === "string" ? pkg.version : undefined;
                if (name === PACKAGE_NAME) {
                    if (force || !version || (expectedVersion && version !== expectedVersion)) {
                        found.set(path, { path, version });
                    }
                }
            } catch {
                if (path.includes("pi-magic-context")) found.set(path, { path });
            }
        }

        let entries: string[] = [];
        try {
            entries = readdirSync(path);
        } catch {
            return;
        }
        for (const entry of entries) visit(join(path, entry), depth - 1);
    };

    for (const root of cacheRoots(cwd)) visit(root, 5);
    return [...found.values()];
}

async function runHealthChecks(options: {
    cwd: string;
    prompts: PromptIO;
    deps: DoctorDeps;
    quiet?: boolean;
    configMigrationWarnings?: readonly string[];
    force?: boolean;
}): Promise<HealthReport> {
    const results: CheckResult[] = [];
    const userConfigMigrationRefused = hasUserConfigLocationMigrationRefusal(
        options.configMigrationWarnings ?? [],
    );
    const repairPlan: RepairPlan = {
        addPackageEntry: false,
        writeUserConfig: false,
        clearCachePaths: [],
    };
    const self = options.deps.selfVersion();

    const pi = options.deps.detectPiBinary();
    if (!pi) {
        add(results, "fail", "Pi binary not found on PATH or at ~/.pi/bin/pi");
    } else {
        const version = options.deps.getPiVersion(pi.path);
        if (version === null) {
            add(results, "fail", `Pi CLI was found at ${pi.path} but could not be executed`);
        } else {
            add(results, "pass", `Pi ${version} detected at ${pi.path}`);
        }
        const compare = compareSemver(version, MIN_PI_VERSION);
        if (compare !== null && compare < 0) {
            add(
                results,
                "fail",
                `Pi ${version} is older than required ${MIN_PI_VERSION}. Subagents (historian/dreamer/sidekick) use the long-form \`--extension\` flag introduced in Pi 0.71.0; older versions hard-fail with "Unknown option". Run \`pi update\` (or \`npm install -g @earendil-works/pi-coding-agent@latest\`).`,
            );
        } else if (version) {
            add(results, "pass", `Pi version meets minimum ${MIN_PI_VERSION} requirement`);
        }
    }

    const latest = options.deps.getLatestNpmVersion();
    const latestCompare = latest ? compareSemver(self, latest) : null;
    if (latest && latestCompare === -1) {
        add(
            results,
            "warn",
            `Magic Context for Pi CLI v${self} is older than npm latest v${latest}`,
        );
    } else if (latest && latestCompare !== null) {
        add(
            results,
            "pass",
            `Magic Context for Pi CLI v${self} is current (npm latest v${latest})`,
        );
    } else if (latest) {
        add(results, "info", `Magic Context for Pi CLI version unknown; npm latest is v${latest}`);
    } else {
        add(results, "info", `Magic Context for Pi CLI v${self}; npm latest check unavailable`);
    }

    const settingsPath = getPiUserExtensionsPath();
    let packages: unknown[] = [];
    if (!existsSync(settingsPath)) {
        add(results, "fail", `Pi settings not found at ${settingsPath}`);
        repairPlan.addPackageEntry = true;
    } else {
        const parsed = readJsonc(settingsPath);
        if (parsed.error) {
            add(results, "fail", `Could not parse Pi settings ${settingsPath}: ${parsed.error}`);
        } else {
            packages = packagesFrom(parsed.value);
            add(results, "pass", `Pi settings found at ${settingsPath}`);
            if (hasPiMagicContextPackage(packages)) {
                add(results, "pass", `${PI_PACKAGE_SOURCE} is registered in packages[]`);
            } else {
                add(results, "fail", `${PI_PACKAGE_SOURCE} is missing from packages[]`);
                repairPlan.addPackageEntry = true;
            }
        }
    }

    const userConfigPath = getPiUserConfigPath();
    const projectPath = projectConfigPath(options.cwd);
    for (const [label, path, required] of [
        ["user", userConfigPath, true],
        ["project", projectPath, false],
    ] as const) {
        if (!existsSync(path)) {
            if (required) {
                add(results, "warn", `No ${label} magic-context.jsonc found at ${path}`);
                if (userConfigMigrationRefused) {
                    add(
                        results,
                        "warn",
                        "Default config repair skipped because legacy Magic Context user config needs manual consolidation first",
                    );
                } else {
                    repairPlan.writeUserConfig = true;
                }
            } else {
                add(results, "info", `No project Magic Context config found at ${path}`);
            }
            continue;
        }
        const parsed = readMagicContextJsonc(path, label);
        if (parsed.error)
            add(results, "fail", `${label} magic-context.jsonc is invalid JSONC: ${parsed.error}`);
        else add(results, "pass", `${label} magic-context.jsonc is valid JSONC: ${path}`);
    }

    const loadedConfig = loadPiConfig({ cwd: options.cwd });
    if (loadedConfig.warnings.length > 0) {
        for (const warning of loadedConfig.warnings.slice(0, 4)) add(results, "warn", warning);
        if (loadedConfig.warnings.length > 4) {
            add(
                results,
                "warn",
                `... and ${loadedConfig.warnings.length - 4} more config warning(s)`,
            );
        }
    } else {
        add(results, "pass", "Pi Magic Context config loads successfully");
    }

    // Warn when a reasoning model is configured for historian on a provider
    // known to apply bad default reasoning_effort values (currently GitHub Copilot).
    // Without an explicit `thinking_level`, Pi leaves the level unset and Copilot
    // injects "minimal" — which it then rejects with a 400 error.
    // Per-harness config shape: Pi's historian model resolution reads only the
    // pi harness block, so the Copilot check must look there too. Entries may be
    // strings or { model, thinking_level } objects.
    const piHistorian = loadedConfig.config.historian?.pi;
    const piHistorianEntry = piHistorian?.model;
    const historianModel = (
        typeof piHistorianEntry === "string" ? piHistorianEntry : (piHistorianEntry?.model ?? "")
    ).trim();
    const historianThinkingLevel =
        (typeof piHistorianEntry === "object" && piHistorianEntry !== null
            ? piHistorianEntry.thinking_level
            : undefined) ?? piHistorian?.thinking_level;
    if (historianModel.startsWith("github-copilot/") && !historianThinkingLevel) {
        add(
            results,
            "warn",
            `historian.model "${historianModel}" is a GitHub Copilot reasoning model but ` +
                `historian.thinking_level is not set. GitHub Copilot may apply a bad ` +
                `default reasoning_effort that it then rejects (400 error). ` +
                `Set historian.thinking_level to "medium" (or "off" to disable thinking) ` +
                `in your magic-context.jsonc.`,
        );
    } else if (historianModel.startsWith("github-copilot/") && historianThinkingLevel) {
        add(
            results,
            "pass",
            `historian.model "${historianModel}" has thinking_level "${historianThinkingLevel}" configured`,
        );
    }

    const storage = getMagicContextStorageResolution();
    const storageDir = storage.path;
    const dbPath = join(storageDir, "context.db");
    add(results, "info", `Shared storage: ${storageDir} (source: ${storage.source})`);
    const existedBeforeOpen = existsSync(dbPath);
    if (existedBeforeOpen) add(results, "pass", `Shared context DB exists at ${dbPath}`);
    else
        add(
            results,
            "warn",
            `Shared context DB not found yet at ${dbPath}; runtime will create it`,
        );

    if (existedBeforeOpen) {
        let db: ContextDatabase | null = null;
        try {
            // Doctor must observe the installed runtime's schema without migrating it.
            // The existing-only readonly helper applies the schema fence before queries.
            db = options.deps.openExistingContextDatabase(dbPath, { readonly: true });
            if (!db) {
                add(results, "fail", `Shared context DB no longer exists at ${dbPath}`);
            } else {
                add(results, "pass", "Opened the shared DB read-only with a supported schema");
                // Stable storage-version probe: live DB schema vs this binary's fence.
                const storageVersions = readStorageVersions(db);
                add(results, "info", formatStorageVersions(storageVersions));
                const fenceCheck = checkStorageVersionFence(storageVersions, {
                    blockingProcesses: getLiveMigrationBlockingProcesses(storageDir),
                });
                add(results, fenceCheck.alarm ? "fail" : "info", fenceCheck.message);

                const integrity = db.prepare("PRAGMA integrity_check").get() as {
                    integrity_check?: unknown;
                };
                if (integrity?.integrity_check === "ok")
                    add(results, "pass", "SQLite integrity_check: ok");
                else
                    add(
                        results,
                        "fail",
                        `SQLite integrity_check: ${String(integrity?.integrity_check ?? "unknown")}\n${formatDatabaseRepairGuidance(dbPath)}`,
                    );

                const counts = ROW_COUNT_TABLES.map(
                    (table) => `${table}=${countTable(db as ContextDatabase, table) ?? "n/a"}`,
                ).join(", ");
                add(results, "info", `Shared DB row counts: ${counts}`);
            }
        } catch (error) {
            if (error instanceof UnsupportedSchemaVersionError) {
                add(
                    results,
                    "fail",
                    checkStorageVersionFence({
                        context_db_schema_version: error.persistedVersion,
                        plugin_supported_version: error.supportedVersion,
                    }).message,
                );
            } else {
                add(
                    results,
                    "fail",
                    `Could not open shared context DB: ${error instanceof Error ? error.message : String(error)}\n${formatDatabaseRepairGuidance(dbPath)}`,
                );
            }
        } finally {
            db?.close();
        }
    }

    // Read user config (tokens expand) and project config (tokens stay literal —
    // secret boundary) separately so we can apply the same redirect-drop the
    // runtime loader does: if the PROJECT redirects embedding.endpoint without its
    // own api_key, the inherited USER api_key must NOT be merged in (it would be
    // sent to the repo-chosen endpoint — exfiltration).
    const userRaw = readConfigForEmbedding(userConfigPath, false);
    const projectRaw = readConfigForEmbedding(projectPath, true);
    if (projectRaw) {
        // Strip project-config fields that must never come from a repo (agent
        // prompts, sqlite.*, etc.) before they can influence the probe.
        stripUnsafeProjectConfigFields(projectRaw);
    }
    const mergedEmbedding: Record<string, unknown> = {};
    for (const config of [userRaw, projectRaw]) {
        const embedding = config?.embedding;
        if (embedding && typeof embedding === "object" && !Array.isArray(embedding)) {
            for (const key of Object.keys(embedding)) {
                if (isPrototypePollutionKey(key)) continue;
                Object.defineProperty(mergedEmbedding, key, {
                    value: (embedding as Record<string, unknown>)[key],
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
            }
        }
    }
    // Drop the inherited user api_key if the project redirected the endpoint.
    if (projectRaw) {
        dropInheritedEmbeddingKeyOnRedirect(
            projectRaw,
            { embedding: mergedEmbedding },
            userRaw ?? undefined,
        );
    }
    if (mergedEmbedding.provider === "openai-compatible") {
        const endpoint =
            typeof mergedEmbedding.endpoint === "string" ? mergedEmbedding.endpoint.trim() : "";
        const model = typeof mergedEmbedding.model === "string" ? mergedEmbedding.model.trim() : "";
        const apiKey =
            typeof mergedEmbedding.api_key === "string" ? mergedEmbedding.api_key : undefined;
        const inputType =
            typeof mergedEmbedding.input_type === "string"
                ? mergedEmbedding.input_type.trim()
                : undefined;
        const truncateMode =
            typeof mergedEmbedding.truncate === "string"
                ? mergedEmbedding.truncate.trim()
                : undefined;
        if (!endpoint || !model) {
            add(
                results,
                "fail",
                "Embedding provider is openai-compatible but endpoint/model is missing",
            );
        } else {
            try {
                const outcome = await options.deps.probeEmbeddingEndpoint({
                    endpoint,
                    model,
                    apiKey,
                    ...(inputType ? { inputType } : {}),
                    ...(truncateMode ? { truncate: truncateMode } : {}),
                    timeoutMs: 10_000,
                });
                const classified = classifyEmbeddingOutcome(outcome);
                add(results, classified.status, classified.message);
            } catch (error) {
                add(
                    results,
                    "fail",
                    `Embedding probe threw: ${sanitizeDiagnosticText(error instanceof Error ? error.message : String(error))}`,
                );
            }
        }
    } else if (loadedConfig.config.embedding.provider === "off") {
        add(results, "info", "Embedding provider disabled");
    } else {
        // Local (default) provider: verify the native ONNX runtime and the
        // persistence-capable Node WASM fallback. Resolution starts from the
        // installed plugin dir and stays silent when no tree can be inspected.
        let runtimeReported = false;
        let firstFallback: ReturnType<
            typeof checkLocalEmbeddingRuntimeByResolution
        > | null = null;
        let firstBroken: ReturnType<
            typeof checkLocalEmbeddingRuntimeByResolution
        > | null = null;
        let runtimeUnverifiedReason = "no installed plugin tree found to inspect";
        for (const pluginDir of piPluginDirCandidates(packages, options.cwd)) {
            const runtime = checkLocalEmbeddingRuntimeByResolution(
                pluginDir,
                process.platform,
                process.arch,
                loadedConfig.config.embedding.provider === "local"
                    ? loadedConfig.config.embedding.local_runtime
                    : "auto",
                // Pi runs extensions under Node even when the CLI itself was launched by Bun.
                { isBun: false, isElectron: false },
            );
            if (runtime.state === "wasm-selected") {
                add(results, "info", formatLocalEmbeddingRuntimeWasmSelected(runtime));
                runtimeReported = true;
                break;
            }
            if (runtime.state === "ok") {
                add(
                    results,
                    "pass",
                    `Embedding provider: ${loadedConfig.config.embedding.provider} (native runtime selected and OK)`,
                );
                runtimeReported = true;
                break;
            }
            if (runtime.state === "wasm-fallback") {
                // Remember the best degraded candidate but keep probing: a WASM
                // fallback in an earlier tree must not mask a later native-capable
                // install.
                firstFallback ??= runtime;
                continue;
            }
            if (isLocalEmbeddingRuntimeBroken(runtime)) {
                // Keep probing: an earlier broken candidate (e.g. a stale local
                // dev-path tree) must not mask a healthy managed install.
                firstBroken ??= runtime;
                continue;
            }
            if (runtime.state === "unknown") runtimeUnverifiedReason = runtime.reason;
        }
        if (!runtimeReported) {
            if (firstFallback) {
                add(results, "warn", formatLocalEmbeddingRuntimeWasmFallback(firstFallback));
            } else if (firstBroken) {
                add(results, "warn", formatLocalEmbeddingRuntimeDoctorWarning(firstBroken));
            } else {
                add(
                    results,
                    "warn",
                    `Embedding provider ${loadedConfig.config.embedding.provider}: selected runtime unverified (${runtimeUnverifiedReason})`,
                );
            }
        }
    }

    // Conflict detection — Pi doesn't have known competing context-management
    // extensions today, but we still check for self-conflicts that the user
    // can hit (e.g. accidentally registering both an npm entry AND a local
    // dev-path entry, which causes duplicate plugin loading).
    const piEntries = packages.filter(isPiMagicContextPackageEntry).map(describePiPackageEntry);
    if (piEntries.length > 1) {
        add(
            results,
            "fail",
            `Multiple magic-context entries in Pi packages[] — this loads the plugin twice: ${piEntries.join(", ")}`,
        );
    } else {
        add(results, "pass", "No conflicting magic-context entries in Pi packages[]");
    }

    const otherExtensions = packages
        .filter((entry) => !isPiMagicContextPackageEntry(entry))
        .map(describePiPackageEntry);
    if (otherExtensions.length > 0) {
        add(results, "info", `Other Pi extensions registered: ${otherExtensions.join(", ")}`);
    } else {
        add(results, "info", "No other Pi extensions listed in settings.json");
    }

    const configuredEntry = packages.find(isPiMagicContextPackageEntry);
    const configuredSpecifier = getPiMagicContextPackageSpecifier(configuredEntry);
    const expectedPluginVersion =
        pinnedVersionFromPackageSpecifier(configuredSpecifier) ?? latest ?? null;
    const staleCaches = findPiMagicContextCacheDirs(
        options.cwd,
        expectedPluginVersion,
        options.force === true,
    );
    if (staleCaches.length > 0) {
        repairPlan.clearCachePaths = staleCaches.map((entry) => entry.path);
        add(
            results,
            "warn",
            `Stale Pi extension cache found: ${staleCaches.map((entry) => `${entry.path}${entry.version ? ` (v${entry.version})` : ""}`).join(", ")}`,
        );
    } else {
        add(results, "pass", "Pi extension cache clean (no stale cached package found)");
    }

    const logPath = getMagicContextLogPath("pi");
    if (existsSync(logPath)) {
        const stat = statSync(logPath);
        const sizeKb = (stat.size / 1024).toFixed(0);
        const lines = readFileSync(logPath, "utf-8")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        add(results, "info", `Log file: ${logPath} (${sizeKb} KB)`);
        // Sanitize before printing — a raw log line can carry a secret/path the
        // user then pastes into a public issue.
        const lastLine = lines.at(-1);
        add(
            results,
            "info",
            `Last plugin log line: ${lastLine ? sanitizeDiagnosticText(lastLine) : "<empty log>"}`,
        );
    } else {
        add(results, "info", `No plugin log file yet at ${logPath}`);
    }

    // Historian dumps now live per-project under `<dir>/.cortexkit/magic-context/historian/`
    // and are surfaced grouped by project. The legacy harness-scoped tmp-dir
    // layout is still listed when no project-local dumps exist (older plugin
    // versions or fresh installs).
    const diagnosticsForDumps = await collectDiagnostics(options.cwd);
    const dumpBuckets = diagnosticsForDumps.historianDumps.byProject;
    if (dumpBuckets.length > 0) {
        const totalCount = dumpBuckets.reduce((sum, b) => sum + b.count, 0);
        add(
            results,
            "warn",
            `Historian debug dumps: ${totalCount} file(s) across ${dumpBuckets.length} project(s)`,
        );
        for (const bucket of dumpBuckets) {
            add(results, "info", `  [${bucket.directory}] ${bucket.count} file(s)`);
            for (const dump of bucket.recent.slice(0, 3)) {
                const age = dump.ageMinutes;
                const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
                add(results, "info", `    ${dump.name} (${ageStr})`);
            }
            if (bucket.count > 3) {
                add(results, "info", `    ... and ${bucket.count - 3} more`);
            }
        }
    }
    const legacyDumps = diagnosticsForDumps.historianDumps.legacyDumps;
    if (legacyDumps.count > 0) {
        add(
            results,
            "info",
            `Legacy historian dumps (pre-v0.18.x): ${legacyDumps.count} file(s) in ${legacyDumps.dir}`,
        );
    }

    if (!options.quiet) {
        for (const result of results) printResult(options.prompts, result);
    }

    return { results, repairPlan, ...summarize(results) };
}

function writeDefaultMagicContextConfig(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const config = {
        $schema:
            "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json",
        ...MagicContextConfigSchema.parse({}),
    };
    writeFileAtomic(path, `${stringifyJsonc(config, null, 2)}\n`);
}

function repair(plan: RepairPlan, prompts: PromptIO): number {
    let fixed = 0;
    if (plan.addPackageEntry) {
        const settingsPath = getPiUserExtensionsPath();
        try {
            const added = writePiSettingsPackage(settingsPath);
            prompts.log.success(
                added
                    ? `Added ${PI_PACKAGE_SOURCE} to ${settingsPath}`
                    : `${PI_PACKAGE_SOURCE} already present in ${settingsPath}`,
            );
            fixed += added ? 1 : 0;
        } catch (error) {
            console.error(
                `FAIL Could not update ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    if (plan.writeUserConfig) {
        const configPath = getPiUserConfigPath();
        if (!existsSync(configPath)) {
            try {
                writeDefaultMagicContextConfig(configPath);
                prompts.log.success(`Wrote default Magic Context config to ${configPath}`);
                fixed += 1;
            } catch (error) {
                console.error(
                    `FAIL Could not write ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    for (const path of plan.clearCachePaths) {
        try {
            rmSync(path, { recursive: true, force: true });
            prompts.log.success(`Cleared stale Pi extension cache: ${path}`);
            fixed += 1;
        } catch (error) {
            console.error(
                `FAIL Could not clear ${path}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    return fixed;
}

function runGhCommandWithDeps(deps: DoctorDeps, args: string[]): GhCommandResult {
    if (args[0] === "issue") {
        const result = deps.spawnSync("gh", args, {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        return {
            status: result.status,
            stdout: String(result.stdout ?? ""),
            stderr: String(result.stderr ?? ""),
        };
    }

    try {
        const output = deps.execFileSync("gh", args, {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        return { status: 0, stdout: String(output ?? ""), stderr: "" };
    } catch (error) {
        const result = error as { status?: number; stdout?: unknown; stderr?: unknown };
        return {
            status: typeof result.status === "number" ? result.status : 1,
            stdout: String(result.stdout ?? ""),
            stderr: String(result.stderr ?? ""),
        };
    }
}

async function runIssueFlow(options: {
    cwd: string;
    prompts: PromptIO;
    deps: DoctorDeps;
}): Promise<number> {
    options.prompts.intro("Magic Context for Pi Issue Report");
    const title = await options.prompts.text("Issue title", {
        placeholder: "Short summary of the Pi problem",
        validate: (value) => (value.trim() ? undefined : "Title is required"),
    });
    const description = await options.prompts.text("Issue description", {
        placeholder: "Describe what happened, what you expected, and repro steps",
        validate: (value) => (value.trim() ? undefined : "Description is required"),
    });

    const spinner = options.prompts.spinner();
    spinner.start("Collecting sanitized Pi diagnostics");
    try {
        const report = await options.deps.collectDiagnostics(options.cwd);
        spinner.stop("Diagnostics collected");

        let sessionFilter: string | null = null;
        if (report.recentSessions.length > 1) {
            const choice = await options.prompts.selectOne(
                "Which Pi session is this issue about? (filters log lines from other sessions)",
                [
                    ...report.recentSessions.map((session, index) => ({
                        label: `${session.directory} — ${session.sessionId}${index === 0 ? " (most recent)" : ""}`,
                        value: session.sessionId,
                    })),
                    {
                        label: "All sessions (no filtering)",
                        value: "__all__",
                    },
                ],
            );
            sessionFilter = choice === "__all__" ? null : choice;
        }

        spinner.start("Bundling Pi issue report");
        const bundled = await bundleIssueReport(report, description, title, {
            cwd: options.cwd,
            now: options.deps.now(),
            sessionFilter,
        });
        spinner.stop(
            bundled.fullPath
                ? `Report written to ${bundled.path}; full bundle at ${bundled.fullPath}`
                : `Report written to ${bundled.path}`,
        );

        const shouldSubmit = await options.prompts.confirm(
            "Submit this issue on GitHub now?",
            false,
        );
        if (shouldSubmit) {
            const result = submitGithubIssue(`[pi] ${title}`, bundled.path, (args) =>
                runGhCommandWithDeps(options.deps, args),
            );
            if (result.ok) {
                options.prompts.log.success(result.output);
                if (bundled.fullPath) {
                    options.prompts.log.info(
                        `Full diagnostics bundle available to drag onto the issue: ${bundled.fullPath}`,
                    );
                }
                options.prompts.outro("Issue submitted — thanks for the report!");
                return 0;
            }
            options.prompts.log.warn(
                formatGithubIssueFallback(result, bundled.fullPath ?? bundled.path),
            );
        }

        console.log(bundled.bodyMarkdown);
        options.prompts.log.info(
            `Open https://github.com/cortexkit/magic-context/issues/new and drag ${bundled.fullPath ?? bundled.path} into the issue`,
        );
        options.prompts.outro("Issue report ready");
        return 0;
    } catch (error) {
        spinner.stop("Diagnostic collection failed");
        console.error(error instanceof Error ? error.message : String(error));
        options.prompts.outro("Issue report failed");
        return 1;
    }
}

export async function runDoctor(options: RunDoctorOptions = {}): Promise<number> {
    const deps = depsFrom(options);
    const prompts = options.prompts ?? deps.prompts;
    const cwd = options.cwd ?? process.cwd();

    if (options.help) {
        printDoctorHelp();
        return 0;
    }

    const configMigrationWarnings = migrateConfigLocationsForCli(cwd, prompts.log);

    if (options.issue) {
        return runIssueFlow({ cwd, prompts, deps });
    }

    let v22Db: ReturnType<typeof openExistingContextDatabase> = null;
    const v22Result = await runV22BackfillCommands(
        {
            name: "Pi",
            openDatabase: (readonly = true) => {
                const dbPath = join(getMagicContextStorageDir(), "context.db");
                v22Db = readonly
                    ? openExistingContextDatabase(dbPath, { readonly: true })
                    : openExistingContextDatabaseForMutation(dbPath);
                return v22Db;
            },
            closeDatabase: () => {
                v22Db?.close();
                v22Db = null;
            },
            log: prompts.log,
        },
        options,
    );
    if (v22Result.handled) {
        return v22Result.exitCode;
    }

    prompts.intro("Magic Context for Pi Doctor");
    const first = await runHealthChecks({
        cwd,
        prompts,
        deps,
        configMigrationWarnings,
        force: options.force,
    });
    console.log("");
    prompts.log.message(`Summary: PASS ${first.pass} / WARN ${first.warn} / FAIL ${first.fail}`);

    if (options.force) {
        const fixed = repair(first.repairPlan, prompts);
        console.log("");
        prompts.log.message(
            `Repair attempted; ${fixed} item(s) changed. Re-running health checks.`,
        );
        const second = await runHealthChecks({
            cwd,
            prompts,
            deps,
            configMigrationWarnings,
            force: false,
        });
        console.log("");
        prompts.log.message(
            `Summary: PASS ${second.pass} / WARN ${second.warn} / FAIL ${second.fail}`,
        );
        prompts.outro(
            second.fail > 0 ? "Doctor found failures after repair" : "Doctor repair complete",
        );
        return second.fail > 0 ? 1 : 0;
    }

    prompts.outro(first.fail > 0 ? "Doctor found failures" : "Doctor complete");
    return first.fail > 0 ? 1 : 0;
}

function valueAfter(args: string[], flag: string): string | null {
    const index = args.indexOf(flag);
    if (index === -1) return null;
    // Reject a flag-shaped value: `--rekey-v22-dir-identity --force` must NOT
    // consume `--force` as the project path. Returning null drops the option
    // (parseDoctorArgs gates on `!== null`) so the doctor proceeds normally
    // instead of rekeying against a bogus `dir:<hash of cwd/--force>` identity.
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) return null;
    return next;
}

export function parseDoctorArgs(args: string[]): RunDoctorOptions {
    const rekeyV22DirIdentity = valueAfter(args, "--rekey-v22-dir-identity");
    return {
        force: args.includes("--force"),
        issue: args.includes("--issue"),
        help: args.includes("--help") || args.includes("-h"),
        checkV22Backfill: args.includes("--check-v22-backfill"),
        retryV22Backfill: args.includes("--retry-v22-backfill"),
        ...(rekeyV22DirIdentity !== null ? { rekeyV22DirIdentity } : {}),
    };
}

export function doctor(args: string[] = []): Promise<number> {
    return runDoctor(parseDoctorArgs(args));
}
