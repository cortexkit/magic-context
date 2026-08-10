import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { loadPiConfig } from "@magic-context/pi-core/config";
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";
import { OmpAdapter } from "../adapters/omp";
import { writeFileAtomic } from "../lib/atomic-write";
import {
    hasUserConfigLocationMigrationRefusal,
    migrateConfigLocationsForCli,
} from "../lib/config-location-migration";
import { openExistingContextDatabase } from "../lib/database-access";
import {
    detectOmpBinary,
    getOmpSetting,
    getOmpVersion,
    listOmpPlugins,
    OMP_PLUGIN_PACKAGE,
    type OmpBinaryInfo,
    runOmpCommand,
} from "../lib/omp-helpers";
import {
    getMagicContextLogPath,
    getOmpAgentDir,
    getOmpConfigPath,
    getOmpNonGlobalConfigSources,
    getOmpPackageDir,
    getOmpPluginsLockPath,
    getOmpSessionsRoot,
    getOmpUserConfigPath,
} from "../lib/paths";
import { type PromptIO, promptIO } from "../lib/prompts";
import { sanitizeDiagnosticText } from "../lib/redaction";

const MIN_OMP_VERSION = "17.1.7";
type Status = "pass" | "warn" | "fail" | "info";
interface CheckResult {
    status: Status;
    message: string;
}
interface RepairPlan {
    installPlugin: boolean;
    disableCompaction: boolean;
    disableMemory: boolean;
    writeUserConfig: boolean;
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
    detectOmpBinary: () => OmpBinaryInfo | null;
    getOmpVersion: typeof getOmpVersion;
    getOmpSetting: typeof getOmpSetting;
    listOmpPlugins: typeof listOmpPlugins;
    runOmpCommand: typeof runOmpCommand;
    openExistingContextDatabase: typeof openExistingContextDatabase;
    now: () => Date;
    execFileSync: typeof execFileSync;
    spawnSync: typeof spawnSync;
}

export interface RunOmpDoctorOptions {
    force?: boolean;
    issue?: boolean;
    cwd?: string;
    prompts?: PromptIO;
    deps?: Partial<DoctorDeps>;
}

const DEFAULT_DEPS: DoctorDeps = {
    prompts: promptIO,
    detectOmpBinary,
    getOmpVersion,
    getOmpSetting,
    listOmpPlugins,
    runOmpCommand,
    openExistingContextDatabase,
    now: () => new Date(),
    execFileSync,
    spawnSync,
};

function parseSemver(value: string | null): [number, number, number] | null {
    const match = value?.match(/(\d+)\.(\d+)\.(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isOlderThan(value: string | null, minimum: string): boolean {
    const left = parseSemver(value);
    const right = parseSemver(minimum);
    if (!left || !right) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return left[index] < right[index];
    }
    return false;
}

function add(results: CheckResult[], status: Status, message: string): void {
    results.push({ status, message });
}

function printResult(prompts: PromptIO, result: CheckResult): void {
    const line = `${result.status.toUpperCase()} ${result.message}`;
    if (result.status === "pass") prompts.log.success(line);
    else if (result.status === "warn") prompts.log.warn(line);
    else if (result.status === "info") prompts.log.info(line);
    else prompts.log.error(line);
}

function selfVersion(): string {
    const req = createRequire(import.meta.url);
    for (const path of ["../../package.json", "../package.json"]) {
        try {
            const value = req(path) as { version?: unknown };
            if (typeof value.version === "string") return value.version;
        } catch {
            // Try the source/published alternate layout.
        }
    }
    return "unknown";
}

function readConfig(path: string): { error?: string } {
    if (!existsSync(path)) return {};
    try {
        const parsed = parseJsonc(readFileSync(path, "utf-8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? {}
            : { error: "top level is not an object" };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

function pluginDeclaresOmp(path: string | undefined): boolean | null {
    if (!path) return null;
    try {
        const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf-8")) as {
            omp?: { extensions?: unknown };
            pi?: { extensions?: unknown };
        };
        return Array.isArray(pkg.omp?.extensions) || Array.isArray(pkg.pi?.extensions);
    } catch {
        return null;
    }
}

async function runHealthChecks(options: {
    cwd: string;
    prompts: PromptIO;
    deps: DoctorDeps;
    quiet?: boolean;
}): Promise<HealthReport> {
    const results: CheckResult[] = [];
    const repairPlan: RepairPlan = {
        installPlugin: false,
        disableCompaction: false,
        disableMemory: false,
        writeUserConfig: false,
    };
    const omp = options.deps.detectOmpBinary();
    if (!omp) {
        add(results, "fail", "OMP binary not found on PATH or in standard user bin directories");
    } else {
        const version = options.deps.getOmpVersion(omp.path);
        if (!version) add(results, "fail", `OMP at ${omp.path} could not report its version`);
        else if (isOlderThan(version, MIN_OMP_VERSION)) {
            add(results, "fail", `OMP ${version} is older than tested minimum ${MIN_OMP_VERSION}`);
        } else add(results, "pass", `OMP ${version} detected at ${omp.path}`);

        const plugins = options.deps.listOmpPlugins(omp.path);
        if (!plugins) {
            add(results, "fail", "`omp plugin list --json` failed or returned invalid JSON");
        } else {
            const plugin = plugins.find((entry) => entry.name === OMP_PLUGIN_PACKAGE);
            if (!plugin) {
                add(results, "fail", `${OMP_PLUGIN_PACKAGE} is not installed in OMP`);
                repairPlan.installPlugin = true;
            } else if (!plugin.enabled) {
                add(results, "fail", `${OMP_PLUGIN_PACKAGE} is installed but disabled in OMP`);
                repairPlan.installPlugin = true;
            } else {
                add(results, "pass", `${OMP_PLUGIN_PACKAGE} ${plugin.version} is enabled`);
                const manifest = pluginDeclaresOmp(plugin.path);
                if (manifest === true)
                    add(results, "pass", "Plugin exposes an OMP/Pi extension manifest");
                else if (manifest === false)
                    add(results, "fail", "Installed plugin has no OMP/Pi extension manifest");
                else add(results, "warn", "Could not inspect the installed plugin manifest");
            }
        }

        const compaction = options.deps.getOmpSetting(omp.path, "compaction.enabled");
        if (compaction === false) add(results, "pass", "OMP native compaction is disabled");
        else if (compaction === true) {
            add(
                results,
                "fail",
                "OMP native compaction is enabled and conflicts with Magic Context",
            );
            repairPlan.disableCompaction = true;
        } else add(results, "fail", "Could not read OMP compaction.enabled");

        const memory = options.deps.getOmpSetting(omp.path, "memory.backend");
        if (memory === "off") add(results, "pass", "OMP automatic memory backend is disabled");
        else if (typeof memory === "string") {
            add(
                results,
                "fail",
                `OMP memory.backend=${memory} duplicates Magic Context memory injection`,
            );
            repairPlan.disableMemory = true;
        } else add(results, "fail", "Could not read OMP memory.backend");

        const nonGlobalSources = getOmpNonGlobalConfigSources(options.cwd);
        if (
            nonGlobalSources.length > 0 &&
            (repairPlan.disableCompaction || repairPlan.disableMemory)
        ) {
            add(
                results,
                "warn",
                "OMP project/overlay config owns effective conflicting settings; automatic global repair is disabled: " +
                    nonGlobalSources.join(", "),
            );
        }

        const reportedAgentDir = options.deps.runOmpCommand(omp.path, ["config", "path"], 10_000);
        if (!reportedAgentDir.ok) {
            add(results, "warn", "Could not verify OMP active agent directory");
        } else {
            const reportedPath = resolve(reportedAgentDir.stdout);
            const expectedPath = resolve(getOmpAgentDir());
            if (reportedPath === expectedPath) {
                add(results, "pass", `OMP agent directory resolved to ${getOmpAgentDir()}`);
            } else {
                add(
                    results,
                    "fail",
                    `OMP reports agent directory ${reportedAgentDir.stdout}, but Magic Context resolved ${getOmpAgentDir()}`,
                );
            }
        }
    }

    const userConfigPath = getOmpUserConfigPath();
    if (!existsSync(userConfigPath)) {
        add(results, "warn", `No Magic Context user config at ${userConfigPath}`);
        repairPlan.writeUserConfig = true;
    } else {
        const parsed = readConfig(userConfigPath);
        if (parsed.error) add(results, "fail", `Invalid Magic Context config: ${parsed.error}`);
        else add(results, "pass", `Magic Context config parses: ${userConfigPath}`);
    }
    const loaded = loadPiConfig({ cwd: options.cwd });
    if (loaded.warnings.length === 0)
        add(results, "pass", "Magic Context runtime config loads successfully");
    else for (const warning of loaded.warnings.slice(0, 5)) add(results, "warn", warning);

    const dbPath = join(getMagicContextStorageDir(), "context.db");
    if (!existsSync(dbPath)) add(results, "info", `Shared context DB will be created at ${dbPath}`);
    else {
        let db: ContextDatabase | null = null;
        try {
            db = options.deps.openExistingContextDatabase(dbPath, { readonly: true });
            const integrity = db?.prepare("PRAGMA integrity_check").get() as
                | { integrity_check?: unknown }
                | undefined;
            if (integrity?.integrity_check === "ok")
                add(results, "pass", "SQLite integrity_check: ok");
            else
                add(
                    results,
                    "fail",
                    `SQLite integrity_check: ${String(integrity?.integrity_check)}`,
                );
        } catch (error) {
            add(results, "fail", `Could not inspect shared DB: ${String(error)}`);
        } finally {
            db?.close();
        }
    }

    add(results, "info", `OMP config: ${getOmpConfigPath()}`);
    add(results, "info", `OMP plugin lock: ${getOmpPluginsLockPath()}`);
    add(results, "info", `OMP sessions: ${getOmpSessionsRoot()}`);
    const packageDir = getOmpPackageDir();
    if (packageDir) add(results, "info", `OMP package override: ${packageDir}`);
    for (const source of getOmpNonGlobalConfigSources(options.cwd)) {
        add(results, "info", `OMP non-global config: ${source}`);
    }
    const logPath = getMagicContextLogPath("pi");
    add(
        results,
        "info",
        `Pi-compatible runtime log: ${logPath}${existsSync(logPath) ? "" : " (not created yet)"}`,
    );

    if (!options.quiet) for (const result of results) printResult(options.prompts, result);
    return {
        results,
        repairPlan,
        pass: results.filter((result) => result.status === "pass").length,
        warn: results.filter((result) => result.status === "warn").length,
        fail: results.filter((result) => result.status === "fail").length,
    };
}

function writeDefaultConfig(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const config = {
        $schema:
            "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json",
        ...MagicContextConfigSchema.parse({}),
    };
    writeFileAtomic(path, `${stringifyJsonc(config, null, 2)}\n`);
}

async function repair(
    plan: RepairPlan,
    deps: DoctorDeps,
    prompts: PromptIO,
    cwd: string,
): Promise<number> {
    let fixed = 0;
    if (plan.writeUserConfig && !existsSync(getOmpUserConfigPath())) {
        writeDefaultConfig(getOmpUserConfigPath());
        prompts.log.success(`Wrote default Magic Context config to ${getOmpUserConfigPath()}`);
        fixed += 1;
    }
    const omp = deps.detectOmpBinary();
    if (!omp) return fixed;
    if (plan.installPlugin) {
        const result = await new OmpAdapter().ensurePluginEntry();
        if (result.ok) {
            prompts.log.success(result.message);
            fixed += 1;
        } else prompts.log.error(result.message);
    }
    const nonGlobalSources = getOmpNonGlobalConfigSources(cwd);
    for (const [enabled, key, value] of [
        [plan.disableCompaction, "compaction.enabled", "false"],
        [plan.disableMemory, "memory.backend", "off"],
    ] as const) {
        if (!enabled) continue;
        if (nonGlobalSources.length > 0) {
            prompts.log.error(
                `Refusing to set global OMP ${key}: effective settings include ${nonGlobalSources.join(", ")}`,
            );
            continue;
        }
        const result = deps.runOmpCommand(omp.path, ["config", "set", key, value], 10_000);
        if (result.ok) {
            prompts.log.success(`Set OMP ${key}=${value}`);
            fixed += 1;
        } else prompts.log.error(result.stderr || `Could not set OMP ${key}`);
    }

    return fixed;
}

function timestamp(date: Date): string {
    return date
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
}

async function runIssueFlow(options: {
    cwd: string;
    prompts: PromptIO;
    deps: DoctorDeps;
}): Promise<number> {
    const title = await options.prompts.text("Issue title", {
        placeholder: "Short summary of the OMP problem",
        validate: (value) => (value.trim() ? undefined : "Title is required"),
    });
    const description = await options.prompts.text("Issue description", {
        placeholder: "What happened, expected behavior, and reproduction steps",
        validate: (value) => (value.trim() ? undefined : "Description is required"),
    });
    const report = await runHealthChecks({ ...options, quiet: true });
    const body = [
        "## Description",
        sanitizeDiagnosticText(description),
        "",
        "## OMP diagnostics",
        `- Magic Context CLI: ${selfVersion()}`,
        ...report.results.map(
            (result) =>
                `- ${result.status.toUpperCase()}: ${sanitizeDiagnosticText(result.message)}`,
        ),
    ].join("\n");
    const path = join(options.cwd, `magic-context-omp-issue-${timestamp(options.deps.now())}.md`);
    writeFileAtomic(path, `${body}\n`);
    options.prompts.log.success(`Sanitized report written to ${path}`);
    try {
        options.deps.execFileSync("gh", ["--version"], { stdio: "ignore" });
    } catch {
        options.prompts.log.info("gh CLI unavailable; submit the generated report manually");
        return 0;
    }
    try {
        options.deps.execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
    } catch {
        options.prompts.log.info(
            "gh CLI is installed but not authenticated; submit the generated report manually",
        );
        return 0;
    }
    if (await options.prompts.confirm("Submit this issue on GitHub now?", false)) {
        const result = options.deps.spawnSync(
            "gh",
            [
                "issue",
                "create",
                "-R",
                "cortexkit/magic-context",
                "--title",
                `[omp] ${title}`,
                "--body-file",
                path,
            ],
            { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
        );
        if (result.status === 0) options.prompts.log.success(String(result.stdout).trim());
        else options.prompts.log.warn(String(result.stderr).trim());
    }
    return 0;
}

export async function runDoctor(options: RunOmpDoctorOptions = {}): Promise<number> {
    const deps: DoctorDeps = {
        ...DEFAULT_DEPS,
        prompts: options.prompts ?? DEFAULT_DEPS.prompts,
        ...options.deps,
    };
    const prompts = options.prompts ?? deps.prompts;
    const cwd = options.cwd ?? process.cwd();
    const migrationWarnings = migrateConfigLocationsForCli(cwd, prompts.log);
    const migrationRefused = hasUserConfigLocationMigrationRefusal(migrationWarnings);
    if (options.issue) return runIssueFlow({ cwd, prompts, deps });

    prompts.intro("Magic Context for Oh My Pi (OMP) Doctor");
    const first = await runHealthChecks({ cwd, prompts, deps });
    prompts.log.message(`Summary: PASS ${first.pass} / WARN ${first.warn} / FAIL ${first.fail}`);
    if (!options.force || first.fail === 0) return first.fail === 0 ? 0 : 1;
    if (migrationRefused && first.repairPlan.writeUserConfig) {
        first.repairPlan.writeUserConfig = false;
        prompts.log.error(
            "Refusing to write a default shared config while legacy user-config migration is unresolved.",
        );
    }

    const fixed = await repair(first.repairPlan, deps, prompts, cwd);
    prompts.log.info(`Applied ${fixed} repair(s); re-checking`);
    const second = await runHealthChecks({ cwd, prompts, deps });
    prompts.log.message(`Summary: PASS ${second.pass} / WARN ${second.warn} / FAIL ${second.fail}`);
    return second.fail === 0 ? 0 : 1;
}
