import { execFileSync, spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { substituteConfigVariables } from "@magic-context/core/config/variable";
import {
    type EmbeddingProbeOutcome,
    probeEmbeddingEndpoint,
} from "@magic-context/core/features/magic-context/memory/embedding-probe";
import {
    type ContextDatabase,
    closeDatabase,
    isDatabasePersisted,
    openDatabase,
} from "@magic-context/core/features/magic-context/storage";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { loadPiConfig } from "@magic-context/pi-core/config";
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";
import { collectDiagnostics } from "../lib/diagnostics-pi";
import { bundleIssueReport } from "../lib/logs-pi";
import {
    getMagicContextLogPath,
    getPiAgentConfigDir,
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
    hasPiMagicContextPackage,
    isPiMagicContextPackageEntry,
} from "../lib/pi-package-entry";
import { type PromptIO, promptIO } from "../lib/prompts";
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
    probeEmbeddingEndpoint: typeof probeEmbeddingEndpoint;
    openDatabase: typeof openDatabase;
    isDatabasePersisted: typeof isDatabasePersisted;
    closeDatabase: typeof closeDatabase;
    now: () => Date;
    execFileSync: typeof execFileSync;
    spawnSync: typeof spawnSync;
}

export interface RunDoctorOptions {
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
    probeEmbeddingEndpoint,
    openDatabase,
    isDatabasePersisted,
    closeDatabase,
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
    else console.error(line);
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

function packagesFrom(settings: Record<string, unknown>): unknown[] {
    return Array.isArray(settings.packages) ? settings.packages : [];
}

function projectConfigPath(cwd: string): string {
    return join(cwd, ".pi", "magic-context.jsonc");
}

function readConfigForEmbedding(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) return null;
    try {
        const rawText = readFileSync(path, "utf-8");
        const substituted = substituteConfigVariables({
            text: rawText,
            configPath: path,
        });
        return parseJsonc(substituted.text) as Record<string, unknown>;
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
                message: `Embedding endpoint network error: ${outcome.message}`,
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
                message: `Embedding endpoint must start with http:// or https://: ${outcome.endpoint}`,
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

function cacheRoots(): string[] {
    const home = homedir();
    const cacheHome = process.env.XDG_CACHE_HOME || join(home, ".cache");
    return [
        join(home, ".pi", "cache", "extensions"),
        join(home, ".pi", "cache", "packages"),
        join(cacheHome, "pi", "extensions"),
        join(cacheHome, "pi", "packages"),
        join(getPiAgentConfigDir(), "cache", "extensions"),
    ];
}

function findPiMagicContextCacheDirs(
    self: string,
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
                if (name === PACKAGE_NAME || path.includes("pi-magic-context")) {
                    if (force || !version || version !== self) found.set(path, { path, version });
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

    for (const root of cacheRoots()) visit(root, 5);
    return [...found.values()];
}

async function runHealthChecks(options: {
    cwd: string;
    prompts: PromptIO;
    deps: DoctorDeps;
    quiet?: boolean;
}): Promise<HealthReport> {
    const results: CheckResult[] = [];
    const repairPlan: RepairPlan = {
        addPackageEntry: false,
        writeUserConfig: false,
        clearCachePaths: [],
    };
    const self = selfVersion();

    const pi = options.deps.detectPiBinary();
    if (!pi) {
        add(results, "fail", "Pi binary not found on PATH or at ~/.pi/bin/pi");
    } else {
        const version = options.deps.getPiVersion(pi.path);
        add(
            results,
            "pass",
            version ? `Pi ${version} detected at ${pi.path}` : `Pi detected at ${pi.path}`,
        );
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
    if (latest && compareSemver(self, latest) === -1) {
        add(
            results,
            "warn",
            `Magic Context for Pi CLI v${self} is older than npm latest v${latest}`,
        );
    } else if (latest) {
        add(
            results,
            "pass",
            `Magic Context for Pi CLI v${self} is current (npm latest v${latest})`,
        );
    } else {
        add(results, "info", `Magic Context for Pi CLI v${self}; npm latest check unavailable`);
    }

    const settingsPath = getPiUserExtensionsPath();
    let packages: unknown[] = [];
    if (!existsSync(settingsPath)) {
        add(results, "warn", `Pi settings not found at ${settingsPath}`);
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
                add(results, "warn", `${PI_PACKAGE_SOURCE} is missing from packages[]`);
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
                repairPlan.writeUserConfig = true;
            } else {
                add(results, "info", `No project Pi magic-context.jsonc found at ${path}`);
            }
            continue;
        }
        const parsed = readJsonc(path);
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
    const historianModel = loadedConfig.config.historian?.model?.trim() ?? "";
    const historianThinkingLevel = loadedConfig.config.historian?.thinking_level;
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

    const storageDir = getMagicContextStorageDir();
    const dbPath = join(storageDir, "context.db");
    const existedBeforeOpen = existsSync(dbPath);
    if (existedBeforeOpen) add(results, "pass", `Shared context DB exists at ${dbPath}`);
    else
        add(
            results,
            "warn",
            `Shared context DB not found yet at ${dbPath}; runtime will create it`,
        );

    let db: ContextDatabase | null = null;
    try {
        db = options.deps.openDatabase();
        if (options.deps.isDatabasePersisted(db))
            add(results, "pass", "openDatabase() opened the shared DB");
        else
            add(
                results,
                "fail",
                "openDatabase() fell back to an in-memory DB; shared DB is broken or unwritable",
            );

        const integrity = db.prepare("PRAGMA integrity_check").get() as {
            integrity_check?: unknown;
        };
        if (integrity?.integrity_check === "ok") add(results, "pass", "SQLite integrity_check: ok");
        else
            add(
                results,
                "fail",
                `SQLite integrity_check: ${String(integrity?.integrity_check ?? "unknown")}`,
            );

        const counts = ROW_COUNT_TABLES.map(
            (table) => `${table}=${countTable(db as ContextDatabase, table) ?? "n/a"}`,
        ).join(", ");
        add(results, "info", `Shared DB row counts: ${counts}`);
    } catch (error) {
        add(
            results,
            "fail",
            `Could not open shared context DB: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
        options.deps.closeDatabase();
    }

    const embeddingConfigs = [userConfigPath, projectPath]
        .map(readConfigForEmbedding)
        .filter((config): config is Record<string, unknown> => config !== null);
    const mergedEmbedding: Record<string, unknown> = {};
    for (const config of embeddingConfigs) {
        const embedding = config.embedding;
        if (embedding && typeof embedding === "object" && !Array.isArray(embedding)) {
            Object.assign(mergedEmbedding, embedding);
        }
    }
    if (mergedEmbedding.provider === "openai-compatible") {
        const endpoint =
            typeof mergedEmbedding.endpoint === "string" ? mergedEmbedding.endpoint.trim() : "";
        const model = typeof mergedEmbedding.model === "string" ? mergedEmbedding.model.trim() : "";
        const apiKey =
            typeof mergedEmbedding.api_key === "string" ? mergedEmbedding.api_key : undefined;
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
                    timeoutMs: 10_000,
                });
                const classified = classifyEmbeddingOutcome(outcome);
                add(results, classified.status, classified.message);
            } catch (error) {
                add(
                    results,
                    "fail",
                    `Embedding probe threw: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    } else if (loadedConfig.config.embedding.provider === "off") {
        add(results, "info", "Embedding provider disabled");
    } else {
        add(results, "pass", `Embedding provider: ${loadedConfig.config.embedding.provider}`);
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

    const staleCaches = findPiMagicContextCacheDirs(self, false);
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
        add(results, "info", `Last plugin log line: ${lines.at(-1) ?? "<empty log>"}`);
    } else {
        add(results, "info", `No plugin log file yet at ${logPath}`);
    }

    // Historian dumps now live per-project under `<dir>/.opencode/magic-context/historian/`
    // — surface them grouped by project. Falls back to the legacy harness-scoped
    // tmp-dir layout when no project-local dumps are present (pre-Phase-3 plugin
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
    writeFileSync(path, `${stringifyJsonc(config, null, 2)}\n`);
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

function ghAvailableAndAuthed(deps: DoctorDeps): boolean {
    try {
        deps.execFileSync("gh", ["--version"], {
            stdio: ["ignore", "pipe", "ignore"],
        });
        deps.execFileSync("gh", ["auth", "status"], {
            stdio: ["ignore", "pipe", "ignore"],
        });
        return true;
    } catch {
        return false;
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
        spinner.stop(`Report written to ${bundled.path}`);

        if (ghAvailableAndAuthed(options.deps)) {
            const shouldSubmit = await options.prompts.confirm(
                "Submit this issue on GitHub now?",
                false,
            );
            if (shouldSubmit) {
                const result = options.deps.spawnSync(
                    "gh",
                    [
                        "issue",
                        "create",
                        "-R",
                        "cortexkit/magic-context",
                        "--title",
                        `[pi] ${title}`,
                        "--body-file",
                        bundled.path,
                    ],
                    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
                );
                if (result.status === 0) {
                    options.prompts.log.success(String(result.stdout).trim());
                    options.prompts.outro("Issue submitted — thanks for the report!");
                    return 0;
                }
                options.prompts.log.warn(String(result.stderr).trim() || "gh issue create failed");
            }
        } else {
            options.prompts.log.warn(
                "gh CLI is unavailable or not authenticated; printing report for manual issue creation",
            );
        }

        console.log(bundled.bodyMarkdown);
        options.prompts.log.info(
            `Open https://github.com/cortexkit/magic-context/issues/new and attach ${bundled.path}`,
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
    if (options.issue) {
        return runIssueFlow({ cwd, prompts, deps });
    }

    prompts.intro("Magic Context for Pi Doctor");
    const first = await runHealthChecks({ cwd, prompts, deps });
    console.log("");
    prompts.log.message(`Summary: PASS ${first.pass} / WARN ${first.warn} / FAIL ${first.fail}`);

    if (options.force) {
        const fixed = repair(first.repairPlan, prompts);
        console.log("");
        prompts.log.message(
            `Repair attempted; ${fixed} item(s) changed. Re-running health checks.`,
        );
        const second = await runHealthChecks({ cwd, prompts, deps });
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

export function parseDoctorArgs(args: string[]): RunDoctorOptions {
    return {
        force: args.includes("--force"),
        issue: args.includes("--issue"),
        help: args.includes("--help") || args.includes("-h"),
    };
}

export function doctor(args: string[] = []): Promise<number> {
    return runDoctor(parseDoctorArgs(args));
}
