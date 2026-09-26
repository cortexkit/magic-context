import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginConfig } from "@magic-context/core/config";
import { isCompactionEnabled } from "@magic-context/core/config/agent-disable";
import { loadRawConfigFile } from "@magic-context/core/config/raw-loader";
import {
    REMOVED_AGENT_CONFIG_WARNING,
    stripRemovedAgentConfig,
} from "@magic-context/core/config/removed-agent-config";
import { substituteConfigVariables } from "@magic-context/core/config/variable";
import {
    formatDreamerTickFailure,
    getDreamerTickFailure,
} from "@magic-context/core/features/magic-context/dreamer/tick-failure";
import type { LocalEmbeddingRuntime } from "@magic-context/core/features/magic-context/memory/embedding-local";
import {
    type EmbeddingProbeOutcome,
    probeEmbeddingEndpoint,
} from "@magic-context/core/features/magic-context/memory/embedding-probe";
import {
    formatSynapseLaneDescriptor,
    SYNAPSE_DEFAULT_MODEL,
    SynapseEmbeddingProvider,
    toSynapseLaneDescriptor,
} from "@magic-context/core/features/magic-context/memory/embedding-synapse";
import {
    formatShadowBackfillStall,
    listShadowBackfillStalls,
} from "@magic-context/core/features/magic-context/shadow-backfill-state";
import { getLiveMigrationBlockingProcesses } from "@magic-context/core/features/magic-context/storage-db";
import {
    AUTO_UPDATE_CHECK_STATE_FILENAME,
    isUpdaterPinnedSpec,
    readAutoUpdateCheckState,
} from "@magic-context/core/shared/auto-update-provenance";
import { detectConflicts } from "@magic-context/core/shared/conflict-detector";
import { fixConflicts } from "@magic-context/core/shared/conflict-fixer";
import {
    getMagicContextStorageDir,
    getMagicContextStorageResolution,
} from "@magic-context/core/shared/data-path";
import { parseJsoncRecovering } from "@magic-context/core/shared/jsonc-parser";
import {
    formatOpenCodeDbDoctorLine,
    type OpenCodeDbPathResolution,
    openCodeDbPathExists,
    openCodeHostGenerationFromVersion,
    resolveOpenCodeDbPath,
} from "@magic-context/core/shared/opencode-db-path";
import { Database } from "@magic-context/core/shared/sqlite";
import { ensureTuiPluginEntry } from "@magic-context/core/shared/tui-config";
import { parse, stringify } from "comment-json";
import {
    isDevPathPluginEntry,
    isLocalPathPluginEntry,
    matchesPluginEntry,
    pluginEntryPackage,
} from "../adapters/opencode";
import { writeFileAtomic } from "../lib/atomic-write";
import { migrateConfigLocationsForCli } from "../lib/config-location-migration";
import {
    openExistingContextDatabase,
    openExistingContextDatabaseForMutation,
    UnsupportedSchemaVersionError,
} from "../lib/database-access";
import { formatDatabaseRepairGuidance } from "../lib/database-repair-guidance";
import { collectDiagnostics } from "../lib/diagnostics-opencode";
import {
    checkLocalEmbeddingRuntime,
    formatLocalEmbeddingRuntimeDoctorWarning,
    formatLocalEmbeddingRuntimeWasmFallback,
    formatLocalEmbeddingRuntimeWasmSelected,
    isLocalEmbeddingRuntimeBroken,
} from "../lib/embedding-runtime";
import { formatGithubIssueFallback, submitGithubIssue } from "../lib/github-issue";
import { formatLogFileInspection, inspectMagicContextLogs } from "../lib/log-lines";
import { bundleIssueReport } from "../lib/logs-opencode";
import { migrateDreamerV2ForDoctor } from "../lib/migrate-dreamer-v2-doctor";
import { migrateExperimentalPinKeyFilesForDoctor } from "../lib/migrate-experimental-doctor";
import { detectOpenCodeInstallations } from "../lib/opencode-detect";
import {
    describeOpenCodeInstallations,
    type OpenCodeInstallationReport,
    selectOpenCodeStoreHost,
} from "../lib/opencode-helpers";
import {
    getOpenCodePluginCacheRoots,
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION as PLUGIN_ENTRY_WITH_VERSION,
    OPENCODE_PLUGIN_NAME as PLUGIN_NAME,
} from "../lib/opencode-plugin-cache";
import { pluginConfigKeyFor, readPluginEntries } from "../lib/opencode-plugin-registration";
import { inspectPinnedOpenCodePluginSchemaFences } from "../lib/opencode-plugin-schema-fence";
import { detectConfigPaths } from "../lib/paths";
import { confirm, intro, log, outro, selectOne, spinner, text } from "../lib/prompts";
import {
    sanitizeDiagnosticEndpoint,
    sanitizeDiagnosticText,
    sanitizePathString,
} from "../lib/redaction";
import {
    checkStorageVersionFence,
    formatStorageVersions,
    readStorageVersions,
} from "../lib/storage-versions";
import { runV22BackfillCommands, type V22BackfillCommandArgs } from "../lib/v22-backfill-commands";
import { reportAuthorityMarkers } from "./doctor-authority";
import {
    compareCachedPluginFences,
    listCachedOpenCodePluginFences,
    readContextDbSchemaVersion,
    reportCachedPluginFences,
} from "./doctor-cached-plugin-fence";
import {
    checkOpenCodeCompactionMarkerConversion,
    formatOpenCodeCompactionMarkerConversion,
    formatOpenCodeV2MissingMarkerNotice,
} from "./doctor-compaction-markers";
import {
    formatDanglingCompartmentBoundary,
    listDanglingCompartmentBoundaries,
} from "./doctor-compartment-boundaries";
import { reportUnresolvedHarnessRelabel } from "./doctor-harness-relabel";
import { clearPluginCache } from "./doctor-opencode-cache";
import { checkPluginDuplicates } from "./doctor-opencode-plugin-duplicates";
import {
    checkOpenCodePluginEntry,
    isPinnedOpenCodePluginSpecifier,
    withPluginEntrySpecifier,
} from "./doctor-opencode-plugin-entry";
import {
    checkOpenCodeV2PluginCache,
    configuredOpenCodeV2DistTag,
    openCodeHostDatabaseFiles,
    reportOpenCodeV2PluginCache,
} from "./doctor-opencode2-cache";
import {
    countPendingCoordinateRebases,
    formatPendingCoordinateRebases,
    formatUnresolvedCompartmentSession,
    listUnresolvedCompartments,
    supportsCoordinateGenerationReporting,
} from "./doctor-store-generation";

const CLI_PACKAGE_NAME = "@cortexkit/magic-context";

export function findUndeclaredConfiguredVariants(
    configured: Array<{ agent: string; model: string; variant: string }>,
    catalog: ReturnType<typeof parseOpenCodeModelCatalog>,
): Array<{ agent: string; model: string; variant: string }> {
    return configured.filter((entry) => {
        const [providerID, id] = entry.model.split("/", 2);
        const model = catalog.find((item) => item.providerID === providerID && item.id === id);
        return model !== undefined && !Object.hasOwn(model.variants, entry.variant);
    });
}

export function checkConfiguredVariantCatalog(
    config: unknown,
    hostGeneration: "v1" | "v2",
    warn: (message: string) => void,
    run: (
        args: string[],
        cwd: string,
    ) => { stdout: string; status: number | null; error?: Error } = (args, cwd) =>
        spawnSync("opencode", args, {
            cwd,
            encoding: "utf8",
            timeout: hostGeneration === "v2" ? 90_000 : 45_000,
            maxBuffer: 16 * 1024 * 1024,
        }),
    projectDir = process.cwd(),
): void {
    const configured: Array<{ agent: string; model: string; variant: string }> = [];
    const root = config && typeof config === "object" ? (config as Record<string, unknown>) : {};
    for (const agent of ["historian", "dreamer"] as const) {
        const section = root[agent];
        if (!section || typeof section !== "object") continue;
        const block = (section as Record<string, unknown>).opencode ?? section;
        if (!block || typeof block !== "object") continue;
        const record = block as Record<string, unknown>;
        const add = (entry: unknown, defaultVariant: unknown) => {
            const value =
                entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
            const model = typeof entry === "string" ? entry : value.model;
            const variant = value.variant ?? defaultVariant;
            if (typeof model === "string" && typeof variant === "string" && model.includes("/")) {
                configured.push({ agent, model, variant });
            }
        };
        add(record.model, record.variant);
        if (Array.isArray(record.fallback_models)) {
            for (const entry of record.fallback_models) add(entry, undefined);
        }
    }
    if (configured.length === 0) return;
    const tempRoot = mkdtempSync(join(tmpdir(), "magic-context-opencode-catalog-"));
    try {
        const command =
            hostGeneration === "v2"
                ? ["api", "model.list", "--param", `directory=${projectDir}`]
                : ["models", "--verbose"];
        const guidance = `opencode ${command.join(" ")}`;
        const result = run(command, tempRoot);
        const catalog =
            hostGeneration === "v2"
                ? parseOpenCodeV2ModelCatalog(result.stdout ?? "")
                : parseOpenCodeModelCatalog(result.stdout ?? "");
        if (result.error || result.status !== 0 || catalog.length === 0) {
            warn(
                `Could not verify configured hidden-agent variants: this OpenCode host did not provide a readable model catalog. ${hostGeneration === "v2" ? "Start the background service with opencode service start, then check" : "Check"} ${guidance}.`,
            );
            return;
        }
        for (const entry of findUndeclaredConfiguredVariants(configured, catalog)) {
            warn(
                `${entry.agent} model ${entry.model} requests variant '${entry.variant}', which this host does not offer. Remove the variant or choose one listed by ${guidance}.`,
            );
        }
    } finally {
        rmSync(tempRoot, { recursive: true, force: true });
    }
}

export function parseOpenCodeV2ModelCatalog(
    output: string,
): ReturnType<typeof parseOpenCodeModelCatalog> {
    try {
        const payload: unknown = JSON.parse(output);
        const rows =
            payload && typeof payload === "object" && "data" in payload
                ? (payload as { data: unknown }).data
                : payload;
        if (!Array.isArray(rows)) return [];
        return rows.flatMap((row) => {
            if (!row || typeof row !== "object") return [];
            const model = row as Record<string, unknown>;
            if (
                typeof model.providerID !== "string" ||
                typeof model.id !== "string" ||
                !Array.isArray(model.variants)
            )
                return [];
            const variants: Record<string, unknown> = {};
            for (const variant of model.variants) {
                if (variant && typeof variant === "object" && typeof variant.id === "string") {
                    variants[variant.id] = variant;
                }
            }
            return [{ providerID: model.providerID, id: model.id, variants }];
        });
    } catch {
        return [];
    }
}

export function parseOpenCodeModelCatalog(output: string): Array<{
    providerID: string;
    id: string;
    variants: Record<string, unknown>;
}> {
    const models: Array<{ providerID: string; id: string; variants: Record<string, unknown> }> = [];
    const lines = output.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        if (lines[index]?.trim() !== "{") continue;
        const jsonLines = [lines[index] ?? "{"];
        while (++index < lines.length) {
            jsonLines.push(lines[index] ?? "");
            if (lines[index] === "}") break;
        }
        try {
            const value = JSON.parse(jsonLines.join("\n")) as {
                providerID?: unknown;
                id?: unknown;
                variants?: unknown;
            };
            if (
                typeof value.providerID === "string" &&
                typeof value.id === "string" &&
                value.variants &&
                typeof value.variants === "object" &&
                !Array.isArray(value.variants)
            ) {
                models.push({
                    providerID: value.providerID,
                    id: value.id,
                    variants: value.variants as Record<string, unknown>,
                });
            }
        } catch {
            // Ignore non-model output; a wholly unparseable catalog is reported by the caller.
        }
    }
    return models;
}

export function describeOpenCodeDatabaseDoctorCheck(
    resolution: OpenCodeDbPathResolution,
    exists = openCodeDbPathExists(resolution),
): { ok: boolean; message: string } {
    if (!exists) return { ok: false, message: formatOpenCodeDbDoctorLine(resolution) };
    return {
        ok: true,
        message: `OpenCode session database: ${resolution.path} (source=${resolution.source}${resolution.channel ? `, channel=${resolution.channel}` : ""})`,
    };
}

/**
 * Resolve the MC compaction mode for the doctor using the SAME loader the
 * plugin uses and the SAME accessor. On load failure the helper takes the
 * preserve-existing-native-fields branch: it returns `false` so doctor never
 * repairs native compaction fields when it cannot read the MC config, and
 * emits a diagnostic. This is distinct from the boot/TUI path, which fails
 * toward mode-on when it cannot supply the resolved value.
 */
function resolveCompactionEnabledForDoctor(): boolean {
    try {
        const config = loadPluginConfig(process.cwd());
        return isCompactionEnabled(config);
    } catch (error) {
        // Preserve-existing-native-fields: do not assume either mode. Doctor
        // reports the load failure and treats native compaction fields as
        // off-limits for repair (same as compaction-off mode).
        console.warn(
            `[magic-context] Could not load Magic Context config to resolve compaction mode; ` +
                `preserving existing native compaction fields. ` +
                `(${error instanceof Error ? error.message : String(error)})`,
        );
        return false;
    }
}

export interface DoctorMigrationLogSink {
    success(message: string): void;
    warn(message: string): void;
}

export function migrateLegacyAgentEnabledConfigForDoctor(
    mcConfig: Record<string, unknown>,
    logs: DoctorMigrationLogSink,
): { changed: boolean; fixes: number } {
    let changed = false;
    let fixes = 0;

    const sanitized = stripRemovedAgentConfig(mcConfig, []);
    if (sanitized !== mcConfig) {
        for (const key of Object.keys(mcConfig)) delete mcConfig[key];
        Object.assign(mcConfig, sanitized);
        logs.warn(REMOVED_AGENT_CONFIG_WARNING);
        changed = true;
        fixes++;
    }

    const migrateLegacyAgentEnabled = (agentName: "dreamer" | "historian"): void => {
        const agent = mcConfig[agentName] as Record<string, unknown> | undefined;
        if (!agent || typeof agent !== "object" || !("enabled" in agent)) return;

        const enabled = agent.enabled;
        const disable = agent.disable;
        delete agent.enabled;
        changed = true;
        fixes++;

        if (agentName === "historian") {
            logs.success(
                "Removed invalid historian.enabled (historian uses disable=true to turn off).",
            );
            return;
        }

        if (agentName === "dreamer") {
            if (disable !== true && enabled === false) {
                agent.disable = true;
                logs.warn(
                    "Migrated dreamer.enabled=false → dreamer.disable=true. This now also disables manual /ctx-dream. To keep manual dreaming, remove disable=true and set schedule to empty string.",
                );
            } else {
                logs.success(
                    'Removed deprecated dreamer.enabled (use dreamer.disable=true to turn off the Dreamer agent; use schedule="" for manual-only dreaming).',
                );
            }
        }
    };

    migrateLegacyAgentEnabled("dreamer");
    migrateLegacyAgentEnabled("historian");

    return { changed, fixes };
}

/**
 * Check whether the `review-user-memories` dreamer task is scheduled while the
 * dreamer itself is disabled, a no-op combination where candidate promotions
 * will never run. In v2, user-memory collection is gated by the task schedule
 * (non-empty = enabled), replacing the v1 `dreamer.user_memories` block.
 * Returns the warning message when the combination is wrong, or null otherwise.
 */
export function checkUserMemoriesDreamerCompatibility(
    mcConfig: Record<string, unknown>,
): string | null {
    const dreamerObj = mcConfig?.dreamer as Record<string, unknown> | undefined;
    if (dreamerObj?.disable !== true) return null;
    const tasksObj = dreamerObj.tasks as Record<string, unknown> | undefined;
    const reviewTask = tasksObj?.["review-user-memories"] as Record<string, unknown> | undefined;
    const schedule = reviewTask?.schedule;
    if (typeof schedule !== "string" || schedule.trim() === "") return null;
    return 'dreamer.tasks["review-user-memories"] is scheduled but dreamer.disable=true, so new promotions will not run. Remove dreamer.disable or set dreamer.tasks["review-user-memories"].schedule="" to disable the task.';
}

/**
 * Fetch the version an npm dist-tag (`latest` by default) points at. Returns
 * null on any error so the doctor can report "check unavailable" rather than fail.
 */
async function fetchNpmLatest(
    pkg: string,
    distTag = "latest",
    timeoutMs = 5000,
): Promise<string | null> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(
                `${resolveNpmRegistryUrl()}/${pkg}/${encodeURIComponent(distTag)}`,
                {
                    signal: controller.signal,
                    headers: { Accept: "application/json" },
                },
            );
            if (!res.ok) return null;
            const body = (await res.json()) as { version?: unknown };
            return typeof body.version === "string" ? body.version : null;
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return null;
    }
}

/**
 * Registry doctor asks for the latest version. OpenCode installs plugins through
 * npm's own config loader, which honours `npm_config_registry`; reading the
 * same variable keeps doctor's "latest" equal to what the host would install.
 */
export function resolveNpmRegistryUrl(env: NodeJS.ProcessEnv = process.env): string {
    const configured = (env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY)?.trim();
    return (configured || "https://registry.npmjs.org").replace(/\/+$/, "");
}

/** Self-version with src/dist layout fallback. */
function getSelfVersion(): string {
    const req = createRequire(import.meta.url);
    for (const relPath of ["../../package.json", "../package.json"]) {
        try {
            const pkg = req(relPath) as { version?: unknown };
            if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
        } catch {
            // try next
        }
    }
    return "0.0.0";
}

export { isPinnedOpenCodePluginSpecifier };

export function describeAutoUpdateStall(
    specifier: string,
    autoUpdateEnabled: boolean,
    storageDir = getMagicContextStorageDir(),
): string | null {
    if (!autoUpdateEnabled || !isPinnedOpenCodePluginSpecifier(specifier)) return null;
    const state = readAutoUpdateCheckState(join(storageDir, AUTO_UPDATE_CHECK_STATE_FILENAME));
    const owner = isUpdaterPinnedSpec(state, specifier) ? "updater" : "you";
    return `auto-update: stalled — config pinned to ${specifier} (by ${owner})`;
}

export function getUserNpmrcPath(): string {
    const custom = process.env.NPM_CONFIG_USERCONFIG?.trim();
    if (custom) return custom;
    const home = process.env.HOME?.trim();
    return join(home || homedir(), ".npmrc");
}

export function collectNpmReleaseAgeWarnings(): string[] {
    const ageWarnings: string[] = [];
    const npmrcPath = getUserNpmrcPath();
    if (!existsSync(npmrcPath)) return ageWarnings;
    try {
        const npmrc = readFileSync(npmrcPath, "utf-8");
        for (const line of npmrc.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
            const [key] = trimmed.split("=").map((s) => s.trim());
            if (key === "min-release-age" || key === "before") {
                ageWarnings.push(
                    `${sanitizePathString(npmrcPath)} has '${sanitizeDiagnosticText(trimmed)}'`,
                );
            }
        }
    } catch {
        // Can't read .npmrc — skip.
    }
    return ageWarnings;
}

/** Compare semver-like strings. Returns -1 if a<b, 0 if equal, 1 if a>b. */
function compareVersions(a: string, b: string): number {
    const pa = a.split(/[.-]/).map((s) => Number.parseInt(s, 10));
    const pb = b.split(/[.-]/).map((s) => Number.parseInt(s, 10));
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (Number.isNaN(x) || Number.isNaN(y)) return 0;
        if (x < y) return -1;
        if (x > y) return 1;
    }
    return 0;
}

// ── Issue flow ──────────────────────────────────────────────────────

function openBrowser(url: string): void {
    try {
        if (process.platform === "darwin") {
            const child = spawnSync("open", [url], { stdio: "ignore" });
            if (child.status === 0) return;
        } else if (process.platform === "linux") {
            const child = spawnSync("xdg-open", [url], { stdio: "ignore" });
            if (child.status === 0) return;
        } else if (process.platform === "win32") {
            const child = spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
            if (child.status === 0) return;
        }
    } catch {
        // Best-effort only.
    }
}

async function runIssueFlow(): Promise<number> {
    intro("Magic Context Issue Report");

    const title = await text("Issue title", {
        placeholder: "Short summary of the problem",
        validate: (value) => (value.trim() ? undefined : "Title is required"),
    });
    const description = await text("Issue description", {
        placeholder: "Describe what happened, what you expected, and repro steps",
        validate: (value) => (value.trim() ? undefined : "Description is required"),
    });

    const s = spinner();
    s.start("Collecting diagnostics");

    try {
        const report = await collectDiagnostics();
        s.stop("Diagnostics collected");

        // Ask the user which session this issue relates to. Only show the
        // picker when there's more than one recent session — otherwise the
        // single-session case is unambiguous, and the no-session case
        // (Node-only run without bun:sqlite) skips filtering entirely.
        let sessionFilter: string | null = null;
        if (report.recentSessions.length > 1) {
            const choice = await selectOne(
                "Which session is this issue about? (filters log lines from other sessions)",
                [
                    ...report.recentSessions.map((session, index) => {
                        const displayTitle = session.title.trim() || "(no title)";
                        const truncatedTitle =
                            displayTitle.length > 50
                                ? `${displayTitle.slice(0, 47)}...`
                                : displayTitle;
                        const childPrefix = session.parentSessionId ? "  ↳ " : "";
                        const parentSuffix = session.parentSessionId
                            ? ` (child of ${session.parentSessionId})`
                            : "";
                        return {
                            label: `${childPrefix}${truncatedTitle} — ${session.sessionId}${parentSuffix}${index === 0 ? " (most recent)" : ""}`,
                            value: session.sessionId,
                        };
                    }),
                    {
                        label: "All sessions (no filtering)",
                        value: "__all__",
                    },
                ],
            );
            sessionFilter = choice === "__all__" ? null : choice;
        }

        s.start("Bundling issue report");
        const bundled = await bundleIssueReport(report, description, title, sessionFilter);
        s.stop(
            bundled.fullPath
                ? `Report written to ${bundled.path}; full bundle at ${bundled.fullPath}`
                : `Report written to ${bundled.path}`,
        );

        const shouldSubmit = await confirm("Submit this issue on GitHub now?", true);
        if (shouldSubmit) {
            const result = submitGithubIssue(title, bundled.path);
            if (result.ok) {
                log.success(result.output);
                if (bundled.fullPath) {
                    log.info(
                        `Full diagnostics bundle available to drag onto the issue: ${bundled.fullPath}`,
                    );
                }
                outro("Issue submitted — thanks for the report!");
                return 0;
            }

            const fallbackPath = bundled.fullPath ?? bundled.path;
            log.warn(formatGithubIssueFallback(result, fallbackPath));
        }

        const url = `https://github.com/cortexkit/magic-context/issues/new?title=${encodeURIComponent(title)}&template=bug_report.yml`;
        log.info(
            `Open this URL and drag ${bundled.fullPath ?? bundled.path} into the Diagnostics field:`,
        );
        log.info(url);
        openBrowser(url);
        outro("Issue report ready");
        return 0;
    } catch (error) {
        s.stop("Diagnostic collection failed");
        log.error(error instanceof Error ? error.message : String(error));
        outro("Issue report failed");
        return 1;
    }
}

// ── Embedding configuration check ───────────────────────────────────

/**
 * Validate the user's embedding configuration by probing the configured
 * endpoint. Runs only for `openai-compatible` providers — `local` needs no
 * network check and `off` degrades cleanly by design.
 *
 * Known footguns we surface specifically:
 *   - `{env:VAR}` in api_key when VAR is not exported → auth will fail with
 *     a literal `Bearer {env:VAR}` header.
 *   - Endpoint pointing at a specific route (e.g. `.../chat/completions`)
 *     rather than the provider base (e.g. `.../v1`) — gets detected by the
 *     real probe returning 404/405.
 *   - Provider that accepts the URL shape but doesn't implement embeddings
 *     (OpenRouter's /v1 for example) — same detection path.
 */
// Local embeddings prefer onnxruntime-node and fall back to the Node WASM
// bundle when the native addon is absent. Verify both lanes so a loadable
// onnxruntime-web package cannot hide a missing persistence-capable bundle.
// Shared by the explicit-`local` branch and the no-config/default-provider path.
function checkLocalEmbeddingRuntimeForDoctor(runtimePreference: LocalEmbeddingRuntime = "auto"): {
    issues: number;
    localRuntimeBroken?: boolean;
    unverified?: boolean;
} {
    const runtime = checkLocalEmbeddingRuntime(
        getOpenCodePluginCacheRoots(),
        process.platform,
        process.arch,
        runtimePreference,
    );
    if (runtime.state === "wasm-selected") {
        log.info(formatLocalEmbeddingRuntimeWasmSelected(runtime));
        return { issues: 0 };
    }
    if (runtime.state === "wasm-fallback") {
        log.warn(formatLocalEmbeddingRuntimeWasmFallback(runtime));
        return { issues: 0 };
    }
    if (isLocalEmbeddingRuntimeBroken(runtime)) {
        log.warn(formatLocalEmbeddingRuntimeDoctorWarning(runtime));
        return { issues: 1, localRuntimeBroken: true };
    }
    if (runtime.state === "unknown") {
        log.warn(`Local embedding runtime unverified: ${runtime.reason}`);
        return { issues: 0, unverified: true };
    }
    log.success(
        "Embedding provider: local (native runtime selected and OK; Xenova/all-MiniLM-L6-v2 bundled)",
    );
    return { issues: 0 };
}

async function checkEmbeddingConfig(
    magicContextConfigPath: string,
): Promise<{ issues: number; localRuntimeBroken?: boolean; unverified?: boolean }> {
    if (!existsSync(magicContextConfigPath)) {
        // No config → local provider defaults apply. Still verify the local
        // runtime: local is the DEFAULT, so "no config" means local embeddings,
        // and a broken onnxruntime-node would silently fail (#128/#6).
        return checkLocalEmbeddingRuntimeForDoctor();
    }

    let rawText: string;
    try {
        const raw = loadRawConfigFile({ configPath: magicContextConfigPath, tier: "user" });
        if (!raw) return checkLocalEmbeddingRuntimeForDoctor();
        rawText = raw.text;
    } catch {
        log.warn("Could not read magic-context.jsonc for embedding check");
        return { issues: 1 };
    }

    // Substitute {env:} and {file:} before parsing so api_key / endpoint
    // reflect the values the runtime will actually see, and so we can report
    // unresolved tokens as concrete issues.
    const substituted = substituteConfigVariables({
        text: rawText,
        configPath: magicContextConfigPath,
    });

    let parsedConfig: Record<string, unknown>;
    try {
        parsedConfig = parse(substituted.text) as Record<string, unknown>;
    } catch (error) {
        log.warn(
            `Embedding check skipped — could not parse magic-context.jsonc: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { issues: 1 };
    }

    const embedding = parsedConfig?.embedding as Record<string, unknown> | undefined;
    const provider = embedding?.provider;

    if (provider === "off") {
        log.info("Embedding provider disabled — semantic memory search is off");
        return { issues: 0 };
    }

    if (provider === undefined || provider === "local") {
        const runtimePreference =
            embedding?.local_runtime === "native" || embedding?.local_runtime === "wasm"
                ? embedding.local_runtime
                : "auto";
        return checkLocalEmbeddingRuntimeForDoctor(runtimePreference);
    }

    if (provider === "synapse") {
        const loaded = loadPluginConfig(process.cwd());
        if (!loaded.subc) {
            log.error("Embedding provider is synapse but the subc connection block is missing");
            return { issues: 1 };
        }
        const model =
            typeof embedding?.model === "string" && embedding.model.trim().length > 0
                ? embedding.model.trim()
                : SYNAPSE_DEFAULT_MODEL;
        const probeSpinner = spinner();
        probeSpinner.start(`Testing Synapse embedding lane ${sanitizeDiagnosticText(model)}`);
        try {
            const metadata = await SynapseEmbeddingProvider.discover({
                connectionFile: loaded.subc.connection_file,
                projectRoot: process.cwd(),
                session: "doctor:opencode",
                model,
            });
            probeSpinner.stop("Synapse embedding lane probed");
            log.success(
                `Embedding provider: synapse — ${sanitizeDiagnosticText(
                    formatSynapseLaneDescriptor(toSynapseLaneDescriptor(metadata)),
                )}`,
            );
            return { issues: 0 };
        } catch (error) {
            probeSpinner.stop("Synapse embedding probe failed");
            log.error(
                `Synapse embedding lane unavailable: ${sanitizeDiagnosticText(
                    error instanceof Error ? error.message : String(error),
                )}`,
            );
            return { issues: 1 };
        }
    }

    if (provider !== "openai-compatible") {
        log.warn(
            `Unknown embedding provider: ${String(provider)} (expected local | openai-compatible | synapse | off)`,
        );
        return { issues: 1 };
    }

    const endpoint = typeof embedding?.endpoint === "string" ? embedding.endpoint.trim() : "";
    const model = typeof embedding?.model === "string" ? embedding.model.trim() : "";
    const apiKey = typeof embedding?.api_key === "string" ? embedding.api_key : undefined;
    const inputType =
        typeof embedding?.input_type === "string" ? embedding.input_type.trim() : undefined;
    const truncateMode =
        typeof embedding?.truncate === "string" ? embedding.truncate.trim() : undefined;

    let localIssues = 0;

    // Static configuration hygiene checks — raise before the network probe so
    // users get the specific guidance even when they're offline.
    if (!endpoint) {
        log.error("Embedding provider is openai-compatible but 'endpoint' is missing");
        return { issues: 1 };
    }
    if (!model) {
        log.error("Embedding provider is openai-compatible but 'model' is missing");
        return { issues: 1 };
    }

    // Flag unresolved {env:} residue — the substitution pass above would have
    // replaced resolved tokens, so any leftover {env: here means either the
    // env var was missing or the user wrote the literal text.
    if (apiKey && /\{env:[^}]+\}/.test(apiKey)) {
        log.warn(
            "api_key still contains {env:...} after substitution — the referenced environment variable is not set in this shell",
        );
        log.info(`  Raw value: ${apiKey}`);
        log.info(
            "  Export the variable before launching OpenCode (e.g. in ~/.zshrc, ~/.bashrc, or a shell profile)",
        );
        localIssues++;
    }

    // Surface any substitution warnings for the *user* config — we can't
    // tell which substitutions fed the embedding block specifically, but if
    // the block is broken and there are env-var warnings, they're almost
    // certainly related.
    if (substituted.warnings.length > 0) {
        for (const w of substituted.warnings.slice(0, 3)) {
            log.info(`  ${w}`);
        }
        if (substituted.warnings.length > 3) {
            log.info(`  ... and ${substituted.warnings.length - 3} more`);
        }
    }

    // Run the live probe.
    const probeSpinner = spinner();
    probeSpinner.start(
        `Testing embedding endpoint ${sanitizeDiagnosticEndpoint(endpoint)} (model: ${sanitizeDiagnosticText(model)})`,
    );

    let outcome: EmbeddingProbeOutcome;
    try {
        outcome = await probeEmbeddingEndpoint({
            endpoint,
            model,
            apiKey: apiKey,
            ...(inputType ? { inputType } : {}),
            ...(truncateMode ? { truncate: truncateMode } : {}),
            timeoutMs: 10_000,
        });
    } catch (error) {
        probeSpinner.stop("Embedding probe failed unexpectedly");
        log.error(
            `Probe threw: ${sanitizeDiagnosticText(error instanceof Error ? error.message : String(error))}`,
        );
        return { issues: localIssues + 1 };
    }

    probeSpinner.stop("Embedding endpoint probed");

    switch (outcome.kind) {
        case "ok":
            log.success(
                `Embedding endpoint OK (${outcome.status}, ${outcome.dimensions ?? "?"}-dim vectors)`,
            );
            return { issues: localIssues };
        case "auth_failed":
            log.error(
                `Embedding endpoint rejected credentials (${outcome.status}) — check api_key / env var`,
            );
            if (outcome.preview) log.info(`  ${sanitizeDiagnosticText(outcome.preview)}`);
            return { issues: localIssues + 1 };
        case "endpoint_unsupported":
            log.error(`Embedding endpoint does not support embeddings (${outcome.status})`);
            if (outcome.preview) log.info(`  ${sanitizeDiagnosticText(outcome.preview)}`);
            log.info(
                "  Common causes: endpoint points at a chat-completion route (should be the provider base, e.g. '.../v1'), or the provider doesn't offer an embeddings API",
            );
            log.info(
                "  Known non-embedding providers: OpenRouter (chat proxy), Anthropic (no embeddings endpoint). Use OpenAI, Voyage, Together, or a local provider instead.",
            );
            return { issues: localIssues + 1 };
        case "http_error":
            log.error(`Embedding endpoint returned ${outcome.status}`);
            if (outcome.preview) log.info(`  ${sanitizeDiagnosticText(outcome.preview)}`);
            return { issues: localIssues + 1 };
        case "timeout":
            log.warn(
                `Embedding endpoint did not respond within ${outcome.timeoutMs}ms — check endpoint URL and network`,
            );
            return { issues: localIssues + 1 };
        case "network_error":
            log.error(
                `Could not reach embedding endpoint: ${sanitizeDiagnosticText(outcome.message)}`,
            );
            return { issues: localIssues + 1 };
        case "invalid_scheme":
            log.error(
                `Embedding endpoint must start with http:// or https://: ${sanitizeDiagnosticEndpoint(outcome.endpoint)}`,
            );
            return { issues: localIssues + 1 };
    }
}

// ── Main doctor entry ───────────────────────────────────────────────

function logOpenCodeInstallationTable(installations: OpenCodeInstallationReport[]): void {
    log.info("OpenCode installations:");
    log.info("  marker   | path | version | source");
    for (const installation of installations) {
        log.info(
            `  ${installation.active ? "[active]" : "        "} | ${installation.path} | ${installation.version} | ${installation.source}`,
        );
    }
}

export async function runDoctor(
    options: { force?: boolean; fix?: boolean; issue?: boolean } & V22BackfillCommandArgs = {},
): Promise<number> {
    migrateConfigLocationsForCli(process.cwd(), log);

    if (options.issue) {
        return runIssueFlow();
    }

    let v22Db: ReturnType<typeof openExistingContextDatabase> = null;
    const v22Result = await runV22BackfillCommands(
        {
            name: "OpenCode",
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
            log,
        },
        options,
    );
    if (v22Result.handled) {
        return v22Result.exitCode;
    }

    intro("Magic Context Doctor");

    let issues = 0;
    let fixed = 0;
    // Aligned with Pi doctor: emit a PASS/WARN/FAIL summary at the end so
    // results are scannable.
    let passCount = 0;
    let warnCount = 0;
    let failCount = 0;
    const pass = (msg: string) => {
        log.success(msg);
        passCount++;
    };
    const warn = (msg: string) => {
        log.warn(msg);
        warnCount++;
    };
    const fail = (msg: string) => {
        log.error(msg);
        failCount++;
        issues++;
    };

    const authorityDbPath = join(getMagicContextStorageDir(), "context.db");
    let authorityDb: ReturnType<typeof openExistingContextDatabase> = null;
    try {
        authorityDb = openExistingContextDatabase(authorityDbPath, { readonly: true });
        if (authorityDb) {
            await reportAuthorityMarkers({ db: authorityDb, info: log.info, warn, fail });
            // Sessions whose OpenCode harness label the v87 repair could not verify
            // because no OpenCode store was readable when it ran.
            reportUnresolvedHarnessRelabel({ db: authorityDb, warn, detail: log.warn });
        } else {
            log.info("Authority: no context database found");
        }
    } catch (error) {
        warn(
            `Authority check unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
        authorityDb?.close();
    }

    // 1. Check OpenCode is installed. Keep every rung so a stale CLI cannot
    // hide a newer install that the user actually runs.
    const installationReports = describeOpenCodeInstallations(detectOpenCodeInstallations());
    const activeInstallation = installationReports[0];
    if (!activeInstallation) {
        fail("OpenCode is not installed or not in PATH");
        // Help users whose binary IS on PATH but is shadowed by a wrapper
        // script or lives in a directory not searched by our detection
        // (e.g. tool-version shims that only inject PATH at shell time).
        log.info(
            "Doctor checked ~/.opencode/bin/opencode, each entry in $PATH, and the OpenCode CLI bundled in OpenChamber.app.",
        );
        log.info(
            "If `which opencode` succeeds outside doctor, your wrapper or shim may not be readable by Node — please share that wrapper in the issue.",
        );
        outro("Doctor failed — install OpenCode first");
        return 1;
    }
    if (installationReports.length > 1) {
        logOpenCodeInstallationTable(installationReports);
    }
    if (activeInstallation.kind === "desktop") {
        // Desktop ships no invocable CLI; the rest of doctor operates on config
        // and the plugin cache (both present for a Desktop install), so continue.
        pass(
            installationReports.length > 1
                ? "OpenCode Desktop selected for plugin checks (CLI not installed)"
                : "OpenCode Desktop detected (CLI not installed)",
        );
    } else if (activeInstallation.version === "unknown") {
        fail(`OpenCode CLI was found at ${activeInstallation.path} but could not be executed`);
    } else {
        pass(
            installationReports.length > 1
                ? `OpenCode ${activeInstallation.version} installed (active install marked above)`
                : `OpenCode ${activeInstallation.version} installed`,
        );
    }

    const hostGeneration = openCodeHostGenerationFromVersion(activeInstallation.version);
    // Plugin registration follows the active (PATH) install; store checks follow the
    // OpenCode 2 CLI when one is installed beside an OpenCode 1 that PATH resolves
    // first, because that is the host converting and serving the store.
    const storeHostSelection = selectOpenCodeStoreHost(
        installationReports,
        openCodeHostGenerationFromVersion,
    );
    const storeHost = storeHostSelection?.host ?? activeInstallation;
    const storeGeneration = openCodeHostGenerationFromVersion(storeHost.version);
    const openCodeDbResolution = resolveOpenCodeDbPath(storeGeneration);
    if (storeHostSelection?.shadowed) {
        const activeStore = resolveOpenCodeDbPath(hostGeneration).path;
        const shared = activeStore === openCodeDbResolution.path;
        // OpenChamber's bundled CLI prints "opencode v2.0.16" rather than "2.0.16".
        const versionLabel = (version: string) => version.replace(/^opencode\s+v?/i, "");
        const activeVersion = versionLabel(activeInstallation.version);
        const storeVersion = versionLabel(storeHost.version);
        warn(
            `OpenCode ${activeVersion} (${activeInstallation.path}) is first on PATH, and OpenCode ${storeVersion} is also installed (${storeHost.path})${shared ? `; both use ${openCodeDbResolution.path}` : ""}.`,
        );
        log.warn(
            `  Store and conversion checks below use OpenCode ${storeVersion}. Plugin configuration checks use OpenCode ${activeVersion}; to check OpenCode ${storeVersion}'s configuration instead, put its binary first on PATH and run doctor again.`,
        );
    }
    const openCodeDbCheck = describeOpenCodeDatabaseDoctorCheck(openCodeDbResolution);
    if (openCodeDbCheck.ok) pass(openCodeDbCheck.message);
    else fail(openCodeDbCheck.message);

    if (openCodeDbCheck.ok) {
        let markerDb: Database | null = null;
        try {
            markerDb = new Database(openCodeDbResolution.path, {
                readonly: !options.fix,
                fileMustExist: true,
            });
            const report = checkOpenCodeCompactionMarkerConversion(markerDb, {
                fix: options.fix,
            });
            const summary = formatOpenCodeCompactionMarkerConversion(report);
            if (report.missingBefore === 0) {
                pass(summary);
            } else if (options.fix && report.missingAfter === 0) {
                pass(`${summary}; repaired=${report.repaired}`);
                fixed += report.repaired;
            } else if (options.fix) {
                warn(`${summary}; repaired=${report.repaired}, but some rows remain unconvertible`);
            } else if (report.migrationCompleted) {
                // The backfill only matters for a conversion that has not run yet; this
                // store's conversion is finished and will not run again on its own.
                log.info(`${summary}; OpenCode 2 already converted this store`);
            } else {
                warn(`${summary}; run \`magic-context doctor --fix\` before upgrading OpenCode`);
            }

            const notice = formatOpenCodeV2MissingMarkerNotice(report);
            if (notice) {
                for (const [index, line] of notice.entries()) {
                    log.info(index === 0 ? line : `  ${line}`);
                }
            }
        } catch (error) {
            warn(
                `OpenCode compaction marker conversion check unavailable: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            markerDb?.close();
        }

        let contextDb: ReturnType<typeof openExistingContextDatabase> = null;
        let sessionDb: Database | null = null;
        try {
            contextDb = openExistingContextDatabase(authorityDbPath, { readonly: true });
            if (contextDb) {
                sessionDb = new Database(openCodeDbResolution.path, {
                    readonly: true,
                    fileMustExist: true,
                });
                // Only a parsed version identifies the host; Desktop installs report
                // "unknown" (which maps to v1), so leave those to store detection.
                const dangling = listDanglingCompartmentBoundaries(
                    contextDb,
                    sessionDb,
                    /\d/.test(storeHost.version) ? storeGeneration : undefined,
                    (line) => log.info(line),
                );
                if (dangling.length === 0) {
                    pass("Compartment boundary ids resolve in the OpenCode session store");
                } else if (storeGeneration === "v2" && /\d/.test(storeHost.version)) {
                    // OpenCode 2's conversion drops some OpenCode 1 rows, such as the
                    // summary half of a compaction pair or a compaction whose summary
                    // never completed, so a compartment anchored there loses its id.
                    // Magic Context places such a compartment from its neighbours; one
                    // it cannot place is reported by the unresolved-compartment check.
                    log.info(
                        `${dangling.length} compartment(s) point at OpenCode message ids that are not in the OpenCode 2 store. Magic Context places these from the neighbouring compartments; any it cannot place are listed as excluded from range recovery below.`,
                    );
                    for (const boundary of dangling) {
                        log.info(`  ${formatDanglingCompartmentBoundary(boundary)}`);
                    }
                } else {
                    warn(`${dangling.length} compartment(s) have dangling OpenCode boundary ids`);
                    for (const boundary of dangling) {
                        log.warn(`  ${formatDanglingCompartmentBoundary(boundary)}`);
                    }
                }

                // Read-only view of the store-projection rebase: what the next
                // open would re-anchor, and what an earlier open could not.
                // Doctor never rebases; the plugin owns that on its own pass.
                if (!supportsCoordinateGenerationReporting(contextDb)) {
                    log.info(
                        "Store projection check: this context database predates the coordinate columns",
                    );
                } else if (!/\d/.test(storeHost.version)) {
                    log.info(
                        "Store projection check: OpenCode reported no version, so the running projection is unknown",
                    );
                } else {
                    const pendingRebases = countPendingCoordinateRebases(
                        contextDb,
                        storeGeneration,
                    );
                    const pendingLine = formatPendingCoordinateRebases(
                        pendingRebases,
                        storeGeneration,
                    );
                    if (pendingRebases.changed + pendingRebases.unrecorded === 0) {
                        pass(pendingLine);
                    } else {
                        log.info(pendingLine);
                    }

                    const unresolved = listUnresolvedCompartments(contextDb);
                    if (unresolved.total === 0) {
                        pass("No compartment is excluded from range recovery by a store change");
                    } else {
                        warn(
                            `${unresolved.total} compartment(s) across ${unresolved.sessions} session(s) could not be re-anchored and are excluded from range recovery`,
                        );
                        for (const session of unresolved.top) {
                            log.warn(`  ${formatUnresolvedCompartmentSession(session)}`);
                        }
                    }
                }
            } else {
                log.info("Compartment boundary check: no context database found");
            }
        } catch (error) {
            warn(
                `Compartment boundary check unavailable: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            sessionDb?.close();
            contextDb?.close();
        }
    }

    // 1b. CLI vs npm latest
    const selfVersion = getSelfVersion();
    const [npmLatest, pluginNpmLatest] = await Promise.all([
        fetchNpmLatest(CLI_PACKAGE_NAME),
        fetchNpmLatest(PLUGIN_NAME),
    ]);
    if (!npmLatest) {
        log.info(`Magic Context CLI v${selfVersion}; npm latest check unavailable`);
    } else if (compareVersions(selfVersion, npmLatest) < 0) {
        warn(`Magic Context CLI v${selfVersion} is older than npm latest v${npmLatest}`);
    } else {
        pass(`Magic Context CLI v${selfVersion} is current (npm latest v${npmLatest})`);
    }

    // 2. Check config paths exist
    const paths = detectConfigPaths();

    if (paths.opencodeConfigFormat === "none") {
        fail(`No opencode.json found at ${paths.opencodeConfig}`);
    } else {
        pass(`OpenCode config: ${paths.opencodeConfig}`);
    }

    // 3. Check magic-context.jsonc exists + parses + loads through schema
    let autoUpdateEnabled = true;
    if (existsSync(paths.magicContextConfig)) {
        pass(`Magic Context config: ${paths.magicContextConfig}`);
        // 3a. Validate JSONC parses (with config-variable substitution)
        try {
            const raw = loadRawConfigFile({ configPath: paths.magicContextConfig, tier: "user" });
            if (!raw)
                throw new Error("Magic Context config disappeared while doctor was reading it");
            const substituted = substituteConfigVariables({
                text: raw.text,
                configPath: paths.magicContextConfig,
            }).text;
            const parsed = parseJsoncRecovering(substituted);
            const issue = parsed.issues[0];
            if (issue) {
                throw new Error(
                    `${paths.magicContextConfig}:${issue.line}:${issue.column}: ${issue.message} (runtime recovery does not make the file valid)`,
                );
            }
            pass("magic-context.jsonc parses as valid JSONC");
        } catch (err) {
            fail(
                `magic-context.jsonc parse failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        // 3b. Validate config loads through plugin schema. loadPluginConfig
        // recovers from invalid leaf settings field-by-field and surfaces
        // soft warnings via configWarnings, so we can ask the schema to
        // load and report them without bailing on the doctor run.
        try {
            const result = loadPluginConfig(process.cwd());
            autoUpdateEnabled = result.auto_update !== false;
            checkConfiguredVariantCatalog(result, hostGeneration, warn);
            const warnings = result.configWarnings ?? [];
            if (warnings.length > 0) {
                warn(
                    `Magic Context config has ${warnings.length} warning(s) — see 'magic-context doctor --issue' for details`,
                );
            } else {
                pass("Magic Context config loads successfully");
            }
        } catch (err) {
            fail(
                `Could not load Magic Context config: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    } else {
        warn(`No magic-context.jsonc found — using defaults`);
        log.info("  Run 'setup' to create one with model recommendations");
    }

    // 3b. Migrate deprecated experimental config keys in magic-context.jsonc
    if (existsSync(paths.magicContextConfig)) {
        try {
            const raw = loadRawConfigFile({ configPath: paths.magicContextConfig, tier: "user" });
            if (!raw)
                throw new Error("Magic Context config disappeared while doctor was reading it");
            const mcConfig = parse(raw.text) as Record<string, unknown>;
            let mcChanged = false;

            // Remove deprecated compaction_markers config — always-on since v0.21.4.
            //
            // The flag lived in two places across releases:
            //   - `experimental.compaction_markers` (early experimental phase)
            //   - top-level `compaction_markers` (graduated stable, default true,
            //     v0.9.0+)
            //
            // As of v0.21.4 the feature is mandatory and the knob is gone from
            // the schema. We clean BOTH locations so users don't see a
            // "compaction_markers is not allowed" warning at plugin load.
            //
            // Intentional: comment-json stores comments on hidden Symbol keys
            // attached to the parent object via their associated key. Deleting
            // a key drops its immediately-preceding "before-property" comment.
            // We accept that single-comment loss; the rest of the user's
            // comments (block comments, other properties' before-comments,
            // trailing comments on sibling keys) survive untouched. We do NOT
            // delete the `experimental` object even when it becomes empty,
            // because its header comment is anchored there.
            const experimental = mcConfig.experimental as Record<string, unknown> | undefined;
            if (experimental && "compaction_markers" in experimental) {
                delete experimental.compaction_markers;
                mcChanged = true;
                log.success(
                    "Removed deprecated experimental.compaction_markers (always-on since v0.21.4)",
                );
                fixed++;
            }
            if ("compaction_markers" in mcConfig) {
                delete mcConfig.compaction_markers;
                mcChanged = true;
                log.success("Removed deprecated compaction_markers (always-on since v0.21.4)");
                fixed++;
            }

            // Remove deprecated auto_drop_tool_age / drop_tool_structure — Phase 2
            // replaced need-blind routine tool drops with the tiered target-headroom
            // emergency drop (always full-drop), so both knobs are gone from the
            // schema and would trigger a "not allowed" warning at plugin load.
            for (const deadKey of ["auto_drop_tool_age", "drop_tool_structure"]) {
                if (deadKey in mcConfig) {
                    delete mcConfig[deadKey];
                    mcChanged = true;
                    log.success(
                        `Removed deprecated ${deadKey} (replaced by tiered emergency drop)`,
                    );
                    fixed++;
                }
            }

            const agentEnabledMigration = migrateLegacyAgentEnabledConfigForDoctor(mcConfig, log);
            if (agentEnabledMigration.changed) {
                mcChanged = true;
                fixed += agentEnabledMigration.fixes;
            }

            // Migrate experimental.user_memories → dreamer.user_memories.
            // The feature is now stable and lives under dreamer config (since
            // dreamer owns candidate review and promotion). We preserve the
            // user's existing enabled state so users who had it enabled keep
            // it enabled, and users who had it explicitly disabled stay opted
            // out. New users (no existing setting) get the new default:
            // enabled=true under dreamer.user_memories.
            if (experimental && "user_memories" in experimental) {
                const dreamer = (mcConfig.dreamer as Record<string, unknown> | undefined) ?? {};
                const oldUM = experimental.user_memories;
                const existingUM = dreamer.user_memories;
                if (existingUM === undefined) {
                    // No dreamer.user_memories yet — move the old value over.
                    // Coerce primitives (e.g., `experimental.user_memories: true`)
                    // to object shape so the Zod schema accepts them. Without
                    // this coercion, a primitive would trip schema validation
                    // and silently fall back to defaults — losing the user's
                    // explicit opt-in/out state.
                    if (typeof oldUM === "boolean") {
                        dreamer.user_memories = { enabled: oldUM };
                    } else {
                        dreamer.user_memories = oldUM;
                    }
                } else if (
                    typeof oldUM === "object" &&
                    oldUM !== null &&
                    typeof existingUM === "object" &&
                    existingUM !== null
                ) {
                    // Both blocks exist — merge field-by-field so we don't drop
                    // sub-fields like `promotion_threshold` that the user set
                    // under experimental. Existing dreamer.user_memories fields
                    // win (user already graduated them).
                    const merged = {
                        ...(oldUM as Record<string, unknown>),
                        ...(existingUM as Record<string, unknown>),
                    };
                    dreamer.user_memories = merged;
                } else if (typeof oldUM === "object" && oldUM !== null) {
                    // Old block is a proper object but new block is a malformed
                    // primitive (e.g., user wrote `dreamer.user_memories: true`
                    // as a shortcut). Without this branch we'd silently drop
                    // the old block's sub-fields like `promotion_threshold`.
                    // Coerce the primitive to { enabled: <primitive-as-bool> }
                    // shape, then merge — old sub-fields fill in, new enabled
                    // preserves what the user literally typed.
                    const coerced: Record<string, unknown> = {
                        ...(oldUM as Record<string, unknown>),
                        enabled: Boolean(existingUM),
                    };
                    dreamer.user_memories = coerced;
                    log.warn(
                        `Coerced malformed dreamer.user_memories (${typeof existingUM}) to object form while merging sub-fields from experimental.user_memories`,
                    );
                }
                // else: both are primitive/malformed — nothing safe to merge.
                mcConfig.dreamer = dreamer;
                delete experimental.user_memories;
                mcChanged = true;
                log.success(
                    "Migrated experimental.user_memories → dreamer.user_memories (now default: enabled)",
                );
                fixed++;
            }

            if (experimental && migrateExperimentalPinKeyFilesForDoctor(mcConfig)) {
                mcChanged = true;
                log.success(
                    "Migrated experimental.pin_key_files → dreamer.pin_key_files (preserved user enabled state)",
                );
                fixed++;
            }

            // Relocate graduated feature flags out of the (retired) experimental.*
            // namespace to their new homes:
            //   - temporal_awareness / caveman_text_compression / mural → top-level keys
            //   - auto_search / git_commit_indexing → memory.* (recall features)
            // We preserve the user's explicit values so opt-ins/opt-outs survive;
            // the destination wins when a user has already started graduating,
            // merging sub-fields so partial settings aren't dropped.
            const relocateGraduated = (
                key: string,
                dest: Record<string, unknown>,
                destLabel: string,
            ): void => {
                if (!experimental || !(key in experimental)) return;
                const oldValue = experimental[key];
                const existing = dest[key];
                if (existing === undefined) {
                    dest[key] = oldValue;
                } else if (
                    typeof oldValue === "object" &&
                    oldValue !== null &&
                    typeof existing === "object" &&
                    existing !== null
                ) {
                    dest[key] = {
                        ...(oldValue as Record<string, unknown>),
                        ...(existing as Record<string, unknown>),
                    };
                }
                delete experimental[key];
                mcChanged = true;
                log.success(`Migrated experimental.${key} → ${destLabel}${key} (graduated)`);
                fixed++;
            };
            if (experimental) {
                relocateGraduated("temporal_awareness", mcConfig, "");
                relocateGraduated("caveman_text_compression", mcConfig, "");
                relocateGraduated("mural", mcConfig, "");
                const memoryDest = (mcConfig.memory as Record<string, unknown> | undefined) ?? {};
                relocateGraduated("auto_search", memoryDest, "memory.");
                relocateGraduated("git_commit_indexing", memoryDest, "memory.");
                if (Object.keys(memoryDest).length > 0) {
                    mcConfig.memory = memoryDest;
                }
                // The experimental.* namespace is fully retired; drop the now-empty
                // block so it does not linger as obsolete clutter. (Accepts the loss
                // of the block's anchored header comment — the block no longer exists.)
                if (Object.keys(experimental).length === 0 && "experimental" in mcConfig) {
                    delete mcConfig.experimental;
                    mcChanged = true;
                }
            }

            // Dreamer v2: convert the legacy v1 dreamer shape (window schedule,
            // tasks array, user_memories/pin_key_files blocks) into the per-task
            // `tasks` record. Runs AFTER the experimental migrations above so a
            // relocated dreamer.user_memories/pin_key_files is folded into tasks.
            if (migrateDreamerV2ForDoctor(mcConfig)) {
                mcChanged = true;
                log.success(
                    "Migrated legacy dreamer scheduling → per-task dreamer.tasks (window→cron, blocks→tasks)",
                );
                fixed++;
            }

            // Remove `compartment_token_budget` — replaced by auto-derivation from
            // main/historian model context in later versions. The value is no longer
            // read; leaving it in config is harmless but misleading.
            if ("compartment_token_budget" in mcConfig) {
                delete mcConfig.compartment_token_budget;
                mcChanged = true;
                log.success(
                    "Removed deprecated compartment_token_budget (auto-derived from model context now)",
                );
                fixed++;
            }

            if (mcChanged) {
                writeFileAtomic(paths.magicContextConfig, `${stringify(mcConfig, null, 2)}\n`);
            }
        } catch {
            log.warn("Could not migrate deprecated config keys in magic-context.jsonc");
        }
    }

    // 4. Check plugin is in opencode.json
    const reportedAutoUpdateStalls = new Set<string>();
    const reportAutoUpdateStall = (specifier: string): void => {
        const message = describeAutoUpdateStall(specifier, autoUpdateEnabled);
        if (!message || reportedAutoUpdateStalls.has(message)) return;
        reportedAutoUpdateStalls.add(message);
        warn(message);
    };
    if (paths.opencodeConfigFormat !== "none") {
        try {
            const raw = readFileSync(paths.opencodeConfig, "utf-8");
            const config = parse(raw) as Record<string, unknown>;
            const configName =
                paths.opencodeConfigFormat === "jsonc" ? "opencode.jsonc" : "opencode.json";
            // Duplicates first, so the single-entry checks below see the
            // deduplicated config when --fix removed the extra entries.
            if (
                checkPluginDuplicates(config, configName, options, {
                    warn,
                    pass: (message) => {
                        pass(message);
                        fixed++;
                    },
                    info: (message) => log.info(message),
                })
            ) {
                writeFileAtomic(paths.opencodeConfig, `${stringify(config, null, 2)}\n`);
            }
            // OpenCode 2 loads the legacy `plugin` array and its native `plugins`
            // array together, so an entry under either key is a live registration
            // and a fresh entry must go under the running host's own key.
            const allEntries = readPluginEntries(config);
            if (
                allEntries.some(
                    ({ entry }) =>
                        isLocalPathPluginEntry(entry) &&
                        String(entry).includes("magic-context") &&
                        !isDevPathPluginEntry(entry),
                )
            ) {
                warn(
                    "An unverifiable local OpenCode plugin path was ignored because its package name is not Magic Context",
                );
            }
            // String, tuple and OpenCode 2 `{ package, options }` entries are all
            // read, and a rewrite keeps the entry's shape and options.
            if (
                checkOpenCodePluginEntry(
                    config,
                    configName,
                    { force: options.force, registrationKey: pluginConfigKeyFor(hostGeneration) },
                    {
                        pass,
                        warn,
                        fixed: (message) => {
                            pass(message);
                            fixed++;
                        },
                        autoUpdateStall: reportAutoUpdateStall,
                    },
                )
            ) {
                writeFileAtomic(paths.opencodeConfig, `${stringify(config, null, 2)}\n`);
            }
        } catch {
            warn("Could not parse opencode config to verify plugin entry");
        }
    }

    // 5. Check for conflicts
    // The resolved MC compaction mode is threaded in explicitly via the same
    // loader + accessor the plugin boot uses. On load failure the helper takes
    // the preserve-existing-native-fields branch (returns false) and emits a
    // diagnostic, so doctor never assumes either mode.
    const cwd = process.cwd();
    const compactionEnabled = resolveCompactionEnabledForDoctor();
    const conflictResult = detectConflicts(cwd, { compactionEnabled });

    // Doctor has no OpenCode server handle, so it uses the file-based
    // compaction check (the same one the plugin falls back to when its
    // resolved-config fetch fails). Name the arm so a #309-shaped report tells
    // us which check produced the verdict — the running server's resolved
    // config may differ from what the file reader sees.
    log.info(
        "Compaction check: file-based; the running server's resolved config may differ — `opencode debug config` is authoritative",
    );

    if (conflictResult.hasConflict) {
        for (const reason of conflictResult.reasons) {
            fail(`Conflict: ${reason}`);
        }
        // Auto-fix conflicts. In compaction-off mode the fixer skips native
        // compaction fields (compaction.auto/prune) — it may report, never
        // repair, native compaction fields in that mode. DCP and OMO hook
        // fixes keep their existing policy in BOTH modes.
        const actions = fixConflicts(cwd, conflictResult.conflicts, { compactionEnabled });
        for (const action of actions) {
            pass(`Fixed: ${action}`);
            fixed++;
        }
        if (actions.length > 0) {
            warn("Restart OpenCode for conflict fixes to take effect");
        }
    } else {
        // Honest compaction state label in both modes. When MC compaction is
        // OFF, native compaction.auto=true is the intended state (native
        // compaction active), not a conflict; when auto=false as well, nothing
        // manages the window (no-manager configuration) — report it plainly.
        if (!compactionEnabled) {
            if (conflictResult.nativeCompaction.auto || conflictResult.nativeCompaction.prune) {
                pass(
                    "No conflicts detected (compaction, DCP, OMO hooks) — native compaction active (compaction-off mode)",
                );
            } else {
                warn(
                    "No compaction manager is active: Magic Context compaction is off and OpenCode auto-compaction is disabled",
                );
            }
        } else {
            pass("No conflicts detected (compaction, DCP, OMO hooks)");
        }
    }

    // 6. Check tui.json. OpenCode 2 loads the sidebar from the plugin entry itself
    // (its host resolves a `tui` entrypoint next to `server`), so tui.json is a
    // 1.x-only surface and writing it on a 2.x host would register nothing.
    if (hostGeneration === "v2") {
        pass("TUI sidebar loads from the plugin entry on OpenCode 2 (tui.json not used)");
    } else {
        const tuiAdded = ensureTuiPluginEntry();
        if (tuiAdded) {
            pass("Added TUI sidebar plugin to tui.json");
            warn("Restart OpenCode to see the sidebar");
            fixed++;
        } else if (existsSync(paths.tuiConfig)) {
            // Check for pinned version in tui config. Same tuple/dev-path rules
            // as the main opencode config — preserve every entry shape on write.
            try {
                const tuiRaw = readFileSync(paths.tuiConfig, "utf-8");
                const tuiConfig = parse(tuiRaw) as Record<string, unknown>;
                const tuiRawPlugins: unknown[] = Array.isArray(tuiConfig?.plugin)
                    ? tuiConfig.plugin
                    : [];
                const tuiIdx = tuiRawPlugins.findIndex(
                    (entry) =>
                        matchesPluginEntry(entry, PLUGIN_NAME) || isDevPathPluginEntry(entry),
                );
                if (
                    tuiRawPlugins.some(
                        (entry) =>
                            isLocalPathPluginEntry(entry) &&
                            String(entry).includes("magic-context") &&
                            !isDevPathPluginEntry(entry),
                    )
                ) {
                    warn(
                        "An unverifiable local TUI plugin path was ignored because its package name is not Magic Context",
                    );
                }
                if (tuiIdx >= 0) {
                    const tuiEntry = tuiRawPlugins[tuiIdx];
                    const tuiEntryStr = pluginEntryPackage(tuiEntry) ?? "";
                    if (isDevPathPluginEntry(tuiEntry)) {
                        pass(`TUI sidebar plugin configured (dev path: ${tuiEntryStr})`);
                    } else {
                        const tuiPinned = isPinnedOpenCodePluginSpecifier(tuiEntryStr);
                        if (tuiPinned && !options.force) {
                            reportAutoUpdateStall(tuiEntryStr);
                            warn(
                                `TUI plugin pinned to ${tuiEntryStr} — use 'doctor --force' to upgrade`,
                            );
                        } else if (tuiPinned && options.force) {
                            // Preserve tuple or object options when upgrading.
                            tuiRawPlugins[tuiIdx] = withPluginEntrySpecifier(
                                tuiEntry,
                                PLUGIN_ENTRY_WITH_VERSION,
                            );
                            tuiConfig.plugin = tuiRawPlugins;
                            writeFileAtomic(paths.tuiConfig, `${stringify(tuiConfig, null, 2)}\n`);
                            pass(
                                `Upgraded TUI plugin: ${tuiEntryStr} → ${PLUGIN_ENTRY_WITH_VERSION}`,
                            );
                            fixed++;
                        } else {
                            pass("TUI sidebar plugin configured");
                        }
                    }
                } else {
                    fail("TUI sidebar plugin is missing after the repair attempt");
                }
            } catch (error) {
                fail(
                    `Could not verify TUI sidebar config: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        } else {
            fail("Could not create or verify the TUI sidebar config");
        }
    }

    // 7. Check user memories + dreamer compatibility.
    // In v2, user-memory collection is gated by the `review-user-memories` task
    // schedule (non-empty = enabled), replacing the v1 `dreamer.user_memories`
    // block. The task needs the dreamer to actually run to promote candidates,
    // so warn loudly when the combination is wrong.
    if (existsSync(paths.magicContextConfig)) {
        try {
            const raw = loadRawConfigFile({ configPath: paths.magicContextConfig, tier: "user" });
            if (!raw)
                throw new Error("Magic Context config disappeared while doctor was reading it");
            const mcConfig = parse(raw.text) as Record<string, unknown>;
            const warning = checkUserMemoriesDreamerCompatibility(mcConfig);
            if (warning) {
                log.warn(warning);
                issues++;
            }
        } catch {
            // Config parse failed — skip this check
        }
    }

    // 7b. Validate embedding configuration — runs a real probe against the
    // configured endpoint so users catch misconfigured URL / missing env var /
    // wrong provider issues before relying on semantic memory search.
    const embeddingCheck = await checkEmbeddingConfig(paths.magicContextConfig);
    issues += embeddingCheck.issues;
    if (embeddingCheck.issues > 0) failCount += embeddingCheck.issues;
    else if (embeddingCheck.unverified) warnCount++;
    else passCount++;

    // 7c. Shared context DB exists, opens, integrity_check, row counts.
    // This catches corrupted DB files and misaligned storage paths early.
    const storage = getMagicContextStorageResolution();
    const dbPath = join(storage.path, "context.db");
    log.info(`Shared storage: ${storage.path} (source: ${storage.source})`);
    if (!existsSync(dbPath)) {
        log.info(`Shared context DB not yet created at ${dbPath} (will be created on first run)`);
    } else {
        log.info(`Shared context DB exists at ${dbPath}`);
        try {
            // The schema compatibility check runs before integrity checks so a
            // newer schema can never be reported healthy by an older CLI.
            const db = openExistingContextDatabase(dbPath, { readonly: true });
            if (db === null) {
                throw new Error(`Shared context DB no longer exists at ${dbPath}`);
            }
            try {
                pass("Opened the shared DB with a supported schema");
                // Stable storage-version probe: live DB schema vs this binary's fence.
                const storageVersions = readStorageVersions(db);
                log.info(formatStorageVersions(storageVersions));

                // The CLI's bundled schema-compatibility check only proves this doctor
                // can read the database. A health probe must validate the package that
                // will run, so pinned server and TUI entries are checked against the
                // compatibility fence shipped in their own distributions.
                const pinnedPluginFenceFindings = await inspectPinnedOpenCodePluginSchemaFences({
                    directory: process.cwd(),
                    databaseVersion: storageVersions.context_db_schema_version,
                });
                for (const finding of pinnedPluginFenceFindings) {
                    const location = `${finding.surface} entry ${finding.specifier} in ${sanitizePathString(finding.configPath)}`;
                    if (finding.status === "fail") {
                        fail(
                            `Pinned plugin schema fence mismatch: ${location} pins plugin v${finding.pinnedVersion}, which supports through schema v${finding.supportedVersion}; shared context.db is v${finding.databaseVersion}. Recovery: unpin the entry (use @latest), or upgrade the pin to a version released after this migration that supports v${finding.databaseVersion} or later.`,
                        );
                    } else if (finding.status === "unknown") {
                        warn(
                            `UNKNOWN: Pinned plugin schema fence could not be resolved for ${location}; shared context.db is v${finding.databaseVersion}, so doctor cannot verify the plugin that will run. Install the pinned package and rerun doctor, or unpin/upgrade it to a version released after this migration.`,
                        );
                        // Unknown compatibility is not healthy: do not let an
                        // uninspectable pinned artifact produce a successful doctor exit.
                        issues++;
                    } else {
                        pass(
                            `Pinned plugin schema fence: ${location} pins plugin v${finding.pinnedVersion}, which supports shared context.db v${finding.databaseVersion}.`,
                        );
                    }
                }

                const fenceCheck = checkStorageVersionFence(storageVersions, {
                    blockingProcesses: getLiveMigrationBlockingProcesses(
                        getMagicContextStorageDir(),
                    ),
                });
                if (fenceCheck.alarm) fail(fenceCheck.message);
                else log.info(fenceCheck.message);
                try {
                    const integrity = db.prepare("PRAGMA integrity_check").get() as
                        | { integrity_check?: string }
                        | undefined;
                    const result = integrity?.integrity_check ?? "unknown";
                    if (result === "ok") pass("SQLite integrity_check: ok");
                    else
                        fail(
                            `SQLite integrity_check reported: ${result}\n${formatDatabaseRepairGuidance(dbPath)}`,
                        );
                } catch (err) {
                    fail(
                        `SQLite integrity_check failed: ${err instanceof Error ? err.message : String(err)}\n${formatDatabaseRepairGuidance(dbPath)}`,
                    );
                }

                // Row counts across the major tables — informational, not pass/fail.
                try {
                    const counts: Record<string, number> = {};
                    for (const table of [
                        "tags",
                        "compartments",
                        "memories",
                        "notes",
                        "dream_runs",
                    ]) {
                        try {
                            const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as
                                | { c?: number }
                                | undefined;
                            counts[table] = row?.c ?? 0;
                        } catch {
                            // Table may not exist on a brand-new DB before migrations run
                            counts[table] = 0;
                        }
                    }
                    const summary = Object.entries(counts)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(", ");
                    log.info(`Shared DB row counts: ${summary}`);
                } catch {
                    // Don't fail the doctor on row-count introspection issues
                }
                for (const stall of listShadowBackfillStalls(db)) {
                    warn(formatShadowBackfillStall(stall));
                }
                const tickFailure = getDreamerTickFailure(db);
                if (tickFailure) warn(formatDreamerTickFailure(tickFailure));
                else pass("Background maintenance completed its last pass");
            } finally {
                db.close();
            }
        } catch (err) {
            if (err instanceof UnsupportedSchemaVersionError) {
                fail(
                    checkStorageVersionFence({
                        context_db_schema_version: err.persistedVersion,
                        plugin_supported_version: err.supportedVersion,
                    }).message,
                );
            } else {
                fail(
                    `Could not open shared DB: ${err instanceof Error ? err.message : String(err)}\n${formatDatabaseRepairGuidance(dbPath)}`,
                );
            }
        }
    }

    // 8. Check plugin npm cache — clear only if outdated
    const cacheResult = await clearPluginCache({
        force: options.force,
        latestVersion: pluginNpmLatest,
    });
    if (cacheResult.action === "cleared") {
        const versionInfo = cacheResult.cached
            ? ` (cached: ${cacheResult.cached}${cacheResult.latest ? `, latest: ${cacheResult.latest}` : ""})`
            : "";
        const reason = cacheResult.latest
            ? "outdated plugin cache"
            : "plugin cache (latest version check unavailable)";
        pass(`Cleared ${reason}${versionInfo} — latest will download on restart`);
        log.info(`  ${cacheResult.path}`);
        fixed++;
    } else if (cacheResult.action === "up_to_date") {
        pass(`Plugin cache up to date (v${cacheResult.cached})`);
    } else if (cacheResult.action === "check_unavailable") {
        warn(
            `Plugin cache version check unavailable; preserving cached plugin${cacheResult.cached ? ` (cached: ${cacheResult.cached})` : ""}. Use doctor --force to reinstall it.`,
        );
    } else if (cacheResult.action === "error") {
        warn(`Could not clear plugin cache: ${cacheResult.error}`);
        if (cacheResult.clearedPaths && cacheResult.clearedPaths.length > 0) {
            log.info(`  Cleared roots: ${cacheResult.clearedPaths.join(", ")}`);
        }
        if (cacheResult.failedPaths && cacheResult.failedPaths.length > 0) {
            log.info(`  Failed roots: ${cacheResult.failedPaths.join(", ")}`);
        } else {
            log.info(`  Manually delete: ${cacheResult.path}`);
        }
        issues++;
    } else if (hostGeneration !== "v2") {
        // OpenCode 2 never uses the 1.x `packages/` tree; its own cache is
        // reported by the next step, so an empty 1.x tree says nothing there.
        pass("Plugin cache clean (no cached version found)");
    }

    // 8b. OpenCode 2 caches plugins under `npm/<name>@<spec>/<generation>/` and
    // never replaces an `@latest` install on its own. An entry that follows
    // another dist-tag (`@beta`, `@next`) loads from that tag's slot, which is
    // stale against the tag's current version, not against `latest`. The config
    // is read again here because the entry check above may have rewritten it.
    let v2DistTag: string | undefined;
    if (paths.opencodeConfigFormat !== "none") {
        try {
            v2DistTag = configuredOpenCodeV2DistTag(
                parse(readFileSync(paths.opencodeConfig, "utf-8")) as Record<string, unknown>,
            );
        } catch {
            // An unreadable config was already reported; check the `@latest` slot.
        }
    }
    const v2Cache = reportOpenCodeV2PluginCache(
        checkOpenCodeV2PluginCache({
            fix: options.fix,
            force: options.force,
            latestVersion: v2DistTag
                ? await fetchNpmLatest(PLUGIN_NAME, v2DistTag)
                : pluginNpmLatest,
            distTag: v2DistTag,
            hostFiles: openCodeHostDatabaseFiles([openCodeDbResolution.path]),
        }),
        { pass, warn, info: (message) => log.info(message) },
        { reportMissing: hostGeneration === "v2" },
    );
    if (v2Cache.fixed) fixed++;
    if (v2Cache.issue) issues++;

    // 8c. OpenCode 1 and OpenCode 2 share context.db but cache Magic Context
    // separately. Once the newer copy migrates the database, every cached copy
    // whose compiled schema fence is behind it fails closed in its host. Runs
    // after the cache steps above so a copy they just removed is not reported.
    const sharedDbVersion = readContextDbSchemaVersion(dbPath);
    if (sharedDbVersion !== null) {
        reportCachedPluginFences(
            compareCachedPluginFences(listCachedOpenCodePluginFences(), sharedDbVersion),
            { pass, fail, info: (message) => log.info(message) },
        );
    }

    // 9. Check for min-release-age / before restrictions in ~/.npmrc.
    // OpenCode installs plugins with npm under the hood, so npm's age guards
    // apply. We don't check Bun's bunfig.toml anymore — the unified CLI uses
    // npx and the auto-update checker uses npm install, neither of which read
    // bunfig.
    {
        const ageWarnings = collectNpmReleaseAgeWarnings();

        if (ageWarnings.length > 0) {
            log.warn(
                "npm min-release-age restriction detected — this can prevent OpenCode from installing the latest plugin version",
            );
            for (const w of ageWarnings) {
                log.info(`  ${w}`);
            }
            log.info(
                "  If the plugin stays on an old version after doctor --force, this is the likely cause.",
            );
            log.info(
                "  Workaround: temporarily remove the restriction, restart OpenCode, then re-enable it.",
            );
            issues++;
        }
    }

    // 10. Show diagnostics info (log file, historian dumps)

    // The OpenCode 2 plugin writes its own log (under the `opencode2` temp subtree),
    // so a machine running both hosts needs both files read.
    const logHarnesses: Array<"opencode" | "opencode2"> = [
        ...(hostGeneration === "v1" ? ["opencode" as const] : []),
        ...(hostGeneration === "v2" || storeGeneration === "v2" ? ["opencode2" as const] : []),
    ];
    const logFiles = logHarnesses
        .flatMap((harness) => inspectMagicContextLogs(harness))
        .filter((file, index, all) => all.findIndex((other) => other.path === file.path) === index);
    const existingLogFiles = logFiles.filter((file) => file.exists);
    if (existingLogFiles.length === 0) {
        log.info(
            `No plugin log file yet; checked: ${logFiles.map((file) => file.path).join(", ")}`,
        );
    } else {
        for (const file of existingLogFiles) {
            log.info(`Log file read: ${formatLogFileInspection(file)}`);
        }
    }

    // Historian dumps live per-project under `<dir>/.cortexkit/magic-context/historian/`.
    // We surface them grouped by project so users can see which session's dumps are
    // where. Falls back to the legacy tmp-dir layout when collectDiagnostics returns
    // empty buckets (Node-only runs, no OpenCode DB, no historian has run yet under
    // the new path).
    const diagnostics = await collectDiagnostics();
    const dumpBuckets = diagnostics.historianDumps.byProject;
    if (dumpBuckets.length > 0) {
        const totalCount = dumpBuckets.reduce((sum, b) => sum + b.count, 0);
        const sessionCount = dumpBuckets.length;
        warn(`Historian debug dumps: ${totalCount} file(s) across ${sessionCount} project(s)`);
        for (const bucket of dumpBuckets) {
            log.info(`  [${bucket.directory}] ${bucket.count} file(s)`);
            for (const dump of bucket.recent.slice(0, 3)) {
                const age = dump.ageMinutes;
                const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
                log.info(`    ${dump.name} (${ageStr})`);
            }
            if (bucket.count > 3) {
                log.info(`    ... and ${bucket.count - 3} more`);
            }
        }
    }
    // Legacy tmp-dir dumps from pre-Phase 3 plugin versions — still listed if
    // present so users can find old artifacts without spelunking the tmp dir.
    const legacy = diagnostics.historianDumps.legacyDumps;
    if (legacy.count > 0) {
        log.info(`Legacy historian dumps (pre-v0.18.x): ${legacy.count} file(s) in ${legacy.dir}`);
    }

    // 11. Check OMO config
    if (paths.omoConfig) {
        log.info(`OMO config found: ${paths.omoConfig}`);
    }

    // Summary — aligned with Pi doctor format.
    console.log("");
    log.message(`Summary: PASS ${passCount} / WARN ${warnCount} / FAIL ${failCount}`);
    if (issues === 0 && fixed === 0) {
        outro("Everything looks good! ✨");
    } else if (issues > 0 && fixed > 0) {
        outro(`Found ${issues} issue(s), fixed ${fixed}. Restart OpenCode to apply.`);
    } else if (fixed > 0) {
        outro(`Fixed ${fixed} issue(s). Restart OpenCode to apply.`);
    } else {
        outro(`Found ${issues} issue(s) that need manual attention.`);
        return 1;
    }

    return 0;
}
