// NOTE: bun:sqlite is loaded lazily inside collectHistorianFailures() via a
// runtime-gated dynamic import. The CLI runs under Node (npx invocation), so
// `bun:sqlite` is normally unavailable; we only attempt the import when running
// under Bun (e.g. someone runs `bun x @cortexkit/magic-context doctor`). A
// static `import { Database } from "bun:sqlite"` would crash the CLI under
// Node before any try/catch could intervene because Node's ESM loader rejects
// `bun:` specifiers during resolution. Historian-failure diagnostics are
// best-effort: if the DB can't be read, the report still produces all other
// information.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAftAvailability } from "@magic-context/core/features/magic-context/key-files/aft-availability";
import { parseCompartmentOutput } from "@magic-context/core/hooks/magic-context/compartment-parser";
import { detectConflicts } from "@magic-context/core/shared/conflict-detector";
import {
    getOpenCodeCacheDir,
    getProjectMagicContextHistorianDir,
} from "@magic-context/core/shared/data-path";
import { parse as parseJsonc } from "comment-json";
import { getOpenCodeVersion, isOpenCodeInstalled } from "./opencode-helpers";
import {
    type ConfigPaths,
    detectConfigPaths,
    getMagicContextHistorianDir,
    getMagicContextLogPath,
} from "./paths";
import { sanitizeConfigValue, sanitizeDiagnosticText, sanitizePathString } from "./redaction";

const PLUGIN_NAME = "@cortexkit/opencode-magic-context";
const PLUGIN_ENTRY_WITH_VERSION = `${PLUGIN_NAME}@latest`;

export interface DiagnosticReport {
    timestamp: string;
    platform: string;
    arch: string;
    nodeVersion: string;
    pluginVersion: string;
    opencodeInstalled: boolean;
    opencodeVersion: string | null;
    configPaths: ConfigPaths;
    opencodeConfigHasPlugin: boolean;
    tuiConfigHasPlugin: boolean;
    magicContextConfig: {
        exists: boolean;
        parseError?: string;
        flags: Record<string, unknown>;
    };
    aft: {
        available: boolean;
        opencode: boolean;
        pi: boolean;
        checkedPaths: string[];
    };
    pluginCache: {
        path: string;
        cached?: string;
        latest?: string;
    };
    storageDir: {
        path: string;
        exists: boolean;
        contextDbSizeBytes: number;
    };
    conflicts: {
        hasConflict: boolean;
        reasons: string[];
    };
    logFile: {
        path: string;
        exists: boolean;
        sizeKb: number;
    };
    /**
     * Recent active OpenCode sessions (top 5 by `session.time_updated`). Used
     * to anchor historian-dump lookups to real project directories and to
     * power the session picker in the `--issue` flow.
     *
     * Populated only when bun:sqlite is available (under Bun) and OpenCode's
     * own DB at ~/.local/share/opencode/opencode.db exists. Empty array on
     * Node-only runs (and the diagnostics report falls back to the legacy
     * tmp-dir historian listing).
     */
    recentSessions: RecentSessionSummary[];
    /**
     * Historian dumps grouped by project directory. Pre-Phase 3 dumps under
     * the legacy harness-scoped tmp dir are surfaced separately as
     * `legacyDumps` so users with old artifacts still see them in doctor.
     */
    historianDumps: HistorianDumpsReport;
    /** Most recent historian-failure rows from session_meta across all sessions. */
    historianFailures: HistorianFailureSummary[];
}

/**
 * Per-project historian-dump bucket built from the recent-sessions list.
 *
 * One entry per unique project directory that has at least one dump under
 * `<directory>/.opencode/magic-context/historian/`. Sessions sharing a
 * directory roll into the same bucket. Empty buckets are omitted.
 */
export interface ProjectHistorianBucket {
    /** Project directory the bucket represents. */
    directory: string;
    /** Most recently active session in this project (drives picker label). */
    primarySessionId: string;
    /** All recent session IDs touching this directory. */
    sessionIds: string[];
    /** Total dump count in the directory. */
    count: number;
    /** Up to 5 newest dumps with parsed metadata. */
    recent: HistorianDumpSummary[];
}

export interface HistorianDumpsReport {
    /** Per-project dump buckets, ordered by latest activity. */
    byProject: ProjectHistorianBucket[];
    /**
     * Legacy harness-scoped tmp-dir listing, kept so users with pre-Phase-3
     * dumps under `${tmpdir}/opencode/magic-context/historian/` still see
     * them in doctor output. Empty on fresh installs.
     */
    legacyDumps: {
        dir: string;
        count: number;
        recent: HistorianDumpSummary[];
    };
}

export interface RecentSessionSummary {
    sessionId: string;
    /** Session title from OpenCode (may be empty for fresh sessions). */
    title: string;
    /** Project directory the session lives under. */
    directory: string;
    /** ISO timestamp of last activity (`session.time_updated`). */
    lastActiveAt: string;
}

export interface HistorianDumpSummary {
    name: string;
    ageMinutes: number;
    sizeKb: number;
    /** Parsed metadata — only structural fields, never raw XML content. */
    meta?: HistorianDumpMeta;
    /** If the XML could not be parsed, reason for failure. */
    parseError?: string;
}

export interface HistorianDumpMeta {
    /** Number of <compartment> elements found. */
    compartmentCount: number;
    /** Smallest start ordinal across compartments, or null if none. */
    minStart: number | null;
    /** Largest end ordinal across compartments, or null if none. */
    maxEnd: number | null;
    /** Value of <unprocessed_from> tag, if present. */
    unprocessedFrom: number | null;
    /** Number of <fact> items grouped by category. */
    factCountByCategory: Record<string, number>;
    /** Number of <user_observations> items. */
    userObservationCount: number;
    /** Total number of compartment ordinal gaps (missing ranges between consecutive compartments). */
    ordinalGapCount: number;
    /** Total number of overlapping compartment ranges. */
    ordinalOverlapCount: number;
}

export interface HistorianFailureSummary {
    sessionId: string;
    failureCount: number;
    /** Sanitized truncated last-error text. May be empty if never set. */
    lastError: string;
    /** ISO timestamp of last failure, or empty if never failed. */
    lastFailureAt: string;
}

// ── Version + path helpers ──────────────────────────────────────────

function getSelfVersion(): string {
    // createRequire resolves relative to this module. In source layout this file
    // lives at src/cli/diagnostics.ts; in bundled layout at dist/cli.js.
    const require = createRequire(import.meta.url);
    for (const relPath of ["../../package.json", "../package.json"]) {
        try {
            const pkg = require(relPath) as { version?: unknown };
            if (typeof pkg.version === "string" && pkg.version.length > 0) {
                return pkg.version;
            }
        } catch {
            // Try next path.
        }
    }
    return "unknown";
}

function getPluginCacheInfo(): { path: string; cached?: string; latest?: string } {
    const path = join(getOpenCodeCacheDir(), "packages", PLUGIN_ENTRY_WITH_VERSION);
    let cached: string | undefined;
    try {
        const installedPkgPath = join(
            path,
            "node_modules",
            "@cortexkit",
            "opencode-magic-context",
            "package.json",
        );
        if (existsSync(installedPkgPath)) {
            const pkg = JSON.parse(readFileSync(installedPkgPath, "utf-8")) as {
                version?: unknown;
            };
            cached = typeof pkg.version === "string" ? pkg.version : undefined;
        }
    } catch {
        cached = undefined;
    }
    return { path, cached, latest: getSelfVersion() };
}

function getStorageDir(): string {
    const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    // Plugin v0.16+ uses the shared cortexkit/magic-context path so OpenCode and
    // Pi can share memory/embedding/dreamer state. doctor --issue diagnostics
    // should report on the live storage location, not the legacy OpenCode-only
    // path. (See packages/plugin/src/shared/data-path.ts for the canonical
    // resolver.)
    return join(dataHome, "cortexkit", "magic-context");
}

function fileSize(path: string): number {
    try {
        return existsSync(path) ? statSync(path).size : 0;
    } catch {
        return 0;
    }
}

// ── Sanitization ─────────────────────────────────────────────────────

function sanitizeString(value: string): string {
    return sanitizePathString(value);
}

function sanitizeValue(value: unknown): unknown {
    return sanitizeConfigValue(value);
}

// ── Config + plugin entry detection ────────────────────────────────

function readConfig(path: string): { value: Record<string, unknown> | null; error?: string } {
    if (!existsSync(path)) return { value: null };
    try {
        const raw = readFileSync(path, "utf-8");
        const value = parseJsonc(raw) as Record<string, unknown>;
        return { value };
    } catch (error) {
        return { value: null, error: error instanceof Error ? error.message : String(error) };
    }
}

function configHasPluginEntry(config: Record<string, unknown> | null): boolean {
    const plugins = Array.isArray(config?.plugin) ? config.plugin : [];
    return plugins.some((entry) => {
        if (typeof entry !== "string") return false;
        if (entry === PLUGIN_NAME) return true;
        if (entry.startsWith(`${PLUGIN_NAME}@`)) return true;
        // Local dev paths
        if (entry.includes("opencode-magic-context")) return true;
        return false;
    });
}
function parseHistorianDumpMeta(path: string): HistorianDumpMeta | { error: string } {
    try {
        const xml = readFileSync(path, "utf-8");
        const parsed = parseCompartmentOutput(xml);
        const factCountByCategory: Record<string, number> = {};
        for (const fact of parsed.facts) {
            factCountByCategory[fact.category] = (factCountByCategory[fact.category] ?? 0) + 1;
        }
        const starts = parsed.compartments.map((c) => c.startMessage);
        const ends = parsed.compartments.map((c) => c.endMessage);
        let gaps = 0;
        let overlaps = 0;
        for (let i = 1; i < parsed.compartments.length; i++) {
            const prev = parsed.compartments[i - 1];
            const curr = parsed.compartments[i];
            if (curr.startMessage > prev.endMessage + 1) gaps += 1;
            else if (curr.startMessage <= prev.endMessage) overlaps += 1;
        }
        return {
            compartmentCount: parsed.compartments.length,
            minStart: starts.length > 0 ? Math.min(...starts) : null,
            maxEnd: ends.length > 0 ? Math.max(...ends) : null,
            unprocessedFrom: parsed.unprocessedFrom,
            factCountByCategory,
            userObservationCount: parsed.userObservations.length,
            ordinalGapCount: gaps,
            ordinalOverlapCount: overlaps,
        };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Walk a directory's `*.xml` files and return them as HistorianDumpSummary
 * entries, sorted newest-first. Returns up to `limit` entries.
 *
 * Shared by both the project-local walker (one bucket per project) and the
 * legacy tmp-dir fallback walker, so changes to the dump-listing shape live
 * in one place.
 */
function listDumpsInDir(
    dir: string,
    limit: number,
): { count: number; recent: HistorianDumpSummary[] } {
    if (!existsSync(dir)) return { count: 0, recent: [] };
    try {
        const entries = readdirSync(dir)
            .filter((name) => name.endsWith(".xml"))
            .map((name) => {
                const stat = statSync(join(dir, name));
                return {
                    name,
                    mtime: stat.mtimeMs,
                    sizeKb: Math.round(stat.size / 1024),
                };
            })
            .sort((a, b) => b.mtime - a.mtime);

        const now = Date.now();
        const recent: HistorianDumpSummary[] = entries.slice(0, limit).map((entry) => {
            const meta = parseHistorianDumpMeta(join(dir, entry.name));
            const summary: HistorianDumpSummary = {
                name: entry.name,
                ageMinutes: Math.round((now - entry.mtime) / 60000),
                sizeKb: entry.sizeKb,
            };
            if ("error" in meta) {
                summary.parseError = meta.error;
            } else {
                summary.meta = meta;
            }
            return summary;
        });
        return { count: entries.length, recent };
    } catch {
        return { count: 0, recent: [] };
    }
}

/**
 * Group historian dumps by project directory using the recent-sessions list as
 * the lookup index. For each unique directory, opens
 * `<directory>/.opencode/magic-context/historian/` and lists dumps there.
 *
 * Falls back to the legacy harness-scoped tmp-dir layout when recentSessions
 * is empty (Node runs without bun:sqlite) OR when the project-local dir is
 * missing/empty. This keeps doctor useful on:
 *   - Fresh installs where no historian has run yet under the new path
 *   - Pi-only machines (Node, no bun:sqlite, no OpenCode DB)
 *   - Old machines with pre-Phase-3 dumps still in tmp
 */
function collectHistorianDumps(
    recentSessions: RecentSessionSummary[],
): DiagnosticReport["historianDumps"] {
    // Build per-project buckets from unique directories. We iterate the recent
    // sessions in time-DESC order, so the first session that touches a given
    // directory becomes the bucket's primarySessionId.
    const buckets = new Map<string, ProjectHistorianBucket>();
    for (const session of recentSessions) {
        const dir = session.directory;
        if (!dir) continue;
        const projectHistorianDir = getProjectMagicContextHistorianDir(dir);
        const listing = listDumpsInDir(projectHistorianDir, 5);
        const existing = buckets.get(dir);
        if (existing) {
            // Same directory, multiple sessions — append session id, keep
            // the listing we already computed (same path).
            if (!existing.sessionIds.includes(session.sessionId)) {
                existing.sessionIds.push(session.sessionId);
            }
            continue;
        }
        if (listing.count === 0) continue;
        buckets.set(dir, {
            directory: dir,
            primarySessionId: session.sessionId,
            sessionIds: [session.sessionId],
            count: listing.count,
            recent: listing.recent,
        });
    }

    const legacyDir = getMagicContextHistorianDir("opencode");
    const legacyListing = listDumpsInDir(legacyDir, 5);

    return {
        byProject: [...buckets.values()],
        legacyDumps: {
            dir: legacyDir,
            count: legacyListing.count,
            recent: legacyListing.recent,
        },
    };
}

/**
 * Read recent active OpenCode sessions from OpenCode's own SQLite DB.
 *
 * Returns the top 5 sessions by `session.time_updated` (descending), filtered
 * to non-archived rows. The list anchors historian-dump lookups to real
 * project directories and powers the `--issue` flow's session picker.
 *
 * Same bun:sqlite gating as collectHistorianFailures: only attempts the
 * import under Bun. Returns [] on Node runs (the typical `npx` invocation)
 * and on machines without OpenCode installed. Doctor degrades gracefully —
 * historian dumps fall back to the legacy tmp-dir listing on the empty path.
 */
async function collectRecentSessions(): Promise<RecentSessionSummary[]> {
    const opencodeDbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
    if (!existsSync(opencodeDbPath)) return [];

    if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
        return [];
    }

    type DatabaseCtor = new (
        path: string,
        opts?: { readonly?: boolean },
    ) => {
        prepare: (sql: string) => { all: () => unknown[] };
        close: () => void;
    };

    let DatabaseClass: DatabaseCtor;
    try {
        const mod = (await new Function("p", "return import(p)")("bun:sqlite")) as {
            Database: DatabaseCtor;
        };
        DatabaseClass = mod.Database;
    } catch {
        return [];
    }

    let db: { prepare: (sql: string) => { all: () => unknown[] }; close: () => void } | null = null;
    try {
        db = new DatabaseClass(opencodeDbPath, { readonly: true });
        const rows = db
            .prepare(
                // session.time_updated is refreshed within a few seconds of each
                // new message (verified live), so it's a safe recency proxy.
                // Filter time_archived to skip user-archived sessions and exclude
                // parent_id IS NOT NULL to skip subagent child sessions —
                // historian artifacts live under the parent project, not the
                // child's directory.
                "SELECT id, directory, title, time_updated FROM session " +
                    "WHERE time_archived IS NULL AND parent_id IS NULL " +
                    "ORDER BY time_updated DESC LIMIT 5",
            )
            .all() as Array<{
            id: unknown;
            directory: unknown;
            title: unknown;
            time_updated: unknown;
        }>;
        return rows.flatMap((row) => {
            const sessionId = typeof row.id === "string" ? row.id : null;
            const directory = typeof row.directory === "string" ? row.directory : null;
            if (!sessionId || !directory) return [];
            const title = typeof row.title === "string" ? row.title : "";
            const lastActiveAt =
                typeof row.time_updated === "number"
                    ? new Date(row.time_updated).toISOString()
                    : "";
            return [{ sessionId, title, directory, lastActiveAt }];
        });
    } catch {
        return [];
    } finally {
        try {
            db?.close();
        } catch {
            // ignore close errors
        }
    }
}

/**
 * Read the most recent historian-failure rows from session_meta.
 *
 * `bun:sqlite` is loaded lazily via a runtime-gated dynamic import so the
 * CLI works under both Bun and Node:
 *
 *   - Under Bun (typeof Bun !== "undefined"): import("bun:sqlite") succeeds
 *     and we read the failures.
 *   - Under Node (the default for `npx @cortexkit/magic-context doctor`):
 *     we never attempt the import, so Node's ESM loader doesn't see a `bun:`
 *     specifier. The function returns `[]` and the rest of the diagnostics
 *     report builds normally.
 *
 * A static `import { Database } from "bun:sqlite"` at module top would crash
 * the CLI before any try/catch could catch it: Node throws
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME` on `bun:` specifiers during module
 * resolution, which happens before user code runs. The dynamic-import-with-
 * function-string trick (`new Function(...)`) defeats Bun's static analysis
 * so the bundler doesn't try to resolve `bun:sqlite` at build time either.
 */
async function collectHistorianFailures(
    storageDirPath: string,
): Promise<HistorianFailureSummary[]> {
    const contextDbPath = join(storageDirPath, "context.db");
    if (!existsSync(contextDbPath)) return [];

    // Runtime gate: only attempt the import under Bun. The historian-failure
    // section is best-effort diagnostics — losing it under Node is acceptable
    // because the rest of the report (config, conflicts, log tail, dumps)
    // already gives users and us enough to triage most issues.
    if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
        return [];
    }

    type DatabaseCtor = new (
        path: string,
        opts?: { readonly?: boolean },
    ) => {
        prepare: (sql: string) => { all: () => unknown[] };
        close: () => void;
    };

    let DatabaseClass: DatabaseCtor;
    try {
        // `new Function(...)` defeats the bundler's static-analysis pass so
        // no resolver tries to load `bun:sqlite` at build time. At runtime
        // under Bun this resolves to the built-in `bun:sqlite` module.
        const mod = (await new Function("p", "return import(p)")("bun:sqlite")) as {
            Database: DatabaseCtor;
        };
        DatabaseClass = mod.Database;
    } catch {
        return [];
    }

    let db: { prepare: (sql: string) => { all: () => unknown[] }; close: () => void } | null = null;
    try {
        db = new DatabaseClass(contextDbPath, { readonly: true });
        const rows = db
            .prepare(
                "SELECT session_id, historian_failure_count, historian_last_error, historian_last_failure_at FROM session_meta WHERE historian_failure_count > 0 ORDER BY historian_last_failure_at DESC LIMIT 10",
            )
            .all() as Array<{
            session_id: unknown;
            historian_failure_count: unknown;
            historian_last_error: unknown;
            historian_last_failure_at: unknown;
        }>;
        return rows.map((row) => {
            const sessionId = typeof row.session_id === "string" ? row.session_id : "<unknown>";
            const failureCount =
                typeof row.historian_failure_count === "number" ? row.historian_failure_count : 0;
            const rawError =
                typeof row.historian_last_error === "string" ? row.historian_last_error : "";
            const lastAt =
                typeof row.historian_last_failure_at === "number"
                    ? new Date(row.historian_last_failure_at).toISOString()
                    : "";
            const lastError = sanitizeDiagnosticText(
                rawError.replace(/\s+/g, " ").trim().slice(0, 400),
            );
            return { sessionId, failureCount, lastError, lastFailureAt: lastAt };
        });
    } catch {
        return [];
    } finally {
        try {
            db?.close();
        } catch {
            // ignore close errors
        }
    }
}

// ── Main entry ─────────────────────────────────────────────────────

export async function collectDiagnostics(): Promise<DiagnosticReport> {
    const pluginVersion = getSelfVersion();
    const configPaths = detectConfigPaths();
    const opencodeConfig = readConfig(configPaths.opencodeConfig);
    const tuiConfig = readConfig(configPaths.tuiConfig);
    const magicContextConfig = readConfig(configPaths.magicContextConfig);
    const storageDirPath = getStorageDir();
    const contextDbPath = join(storageDirPath, "context.db");

    const logPath = getMagicContextLogPath("opencode");
    const logFileSize = existsSync(logPath) ? statSync(logPath).size : 0;

    const conflictResult = detectConflicts(process.cwd());
    const recentSessions = await collectRecentSessions();

    return {
        timestamp: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        pluginVersion,
        opencodeInstalled: isOpenCodeInstalled(),
        opencodeVersion: getOpenCodeVersion(),
        configPaths,
        opencodeConfigHasPlugin: configHasPluginEntry(opencodeConfig.value),
        tuiConfigHasPlugin: configHasPluginEntry(tuiConfig.value),
        magicContextConfig: {
            exists: existsSync(configPaths.magicContextConfig),
            ...(magicContextConfig.error ? { parseError: magicContextConfig.error } : {}),
            flags: (sanitizeValue(magicContextConfig.value ?? {}) as Record<string, unknown>) ?? {},
        },
        aft: getAftAvailability(),
        pluginCache: getPluginCacheInfo(),
        storageDir: {
            path: storageDirPath,
            exists: existsSync(storageDirPath),
            contextDbSizeBytes: fileSize(contextDbPath),
        },
        conflicts: {
            hasConflict: conflictResult.hasConflict,
            reasons: conflictResult.reasons,
        },
        logFile: {
            path: logPath,
            exists: existsSync(logPath),
            sizeKb: Math.round(logFileSize / 1024),
        },
        recentSessions,
        historianDumps: collectHistorianDumps(recentSessions),
        historianFailures: await collectHistorianFailures(storageDirPath),
    };
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function renderDiagnosticsMarkdown(report: DiagnosticReport): string {
    const configPaths = {
        configDir: sanitizeString(report.configPaths.configDir),
        opencodeConfig: sanitizeString(report.configPaths.opencodeConfig),
        opencodeConfigFormat: report.configPaths.opencodeConfigFormat,
        magicContextConfig: sanitizeString(report.configPaths.magicContextConfig),
        tuiConfig: sanitizeString(report.configPaths.tuiConfig),
        tuiConfigFormat: report.configPaths.tuiConfigFormat,
        omoConfig: report.configPaths.omoConfig
            ? sanitizeString(report.configPaths.omoConfig)
            : null,
    };

    const pluginCache = {
        path: sanitizeString(report.pluginCache.path),
        cached: report.pluginCache.cached ?? null,
        latest: report.pluginCache.latest ?? null,
    };

    const storage = {
        path: sanitizeString(report.storageDir.path),
        exists: report.storageDir.exists,
        context_db_size: formatBytes(report.storageDir.contextDbSizeBytes),
    };

    const historianDumps = {
        byProject: report.historianDumps.byProject.map((bucket) => ({
            directory: sanitizeString(bucket.directory),
            primarySessionId: bucket.primarySessionId,
            sessionIds: bucket.sessionIds,
            count: bucket.count,
            recent: bucket.recent,
        })),
        legacyDumps: {
            dir: sanitizeString(report.historianDumps.legacyDumps.dir),
            count: report.historianDumps.legacyDumps.count,
            recent: report.historianDumps.legacyDumps.recent,
        },
    };

    const recentSessions = report.recentSessions.map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        directory: sanitizeString(session.directory),
        lastActiveAt: session.lastActiveAt,
    }));

    return [
        `- Timestamp: ${report.timestamp}`,
        `- Plugin: v${report.pluginVersion}`,
        `- OS: ${report.platform} ${report.arch}`,
        `- Node: ${report.nodeVersion}`,
        `- OpenCode installed: ${report.opencodeInstalled}${report.opencodeVersion ? ` (${report.opencodeVersion})` : ""}`,
        `- Plugin registered in opencode config: ${report.opencodeConfigHasPlugin}`,
        `- Plugin registered in tui config: ${report.tuiConfigHasPlugin}`,
        `- magic-context.jsonc parse error: ${report.magicContextConfig.parseError ?? "none"}`,
        `- AFT available: ${report.aft?.available ?? false} (opencode=${report.aft?.opencode ?? false}, pi=${report.aft?.pi ?? false})`,
        `- Conflicts detected: ${report.conflicts.hasConflict ? report.conflicts.reasons.join("; ") : "none"}`,
        "",
        "### Config paths",
        "```json",
        JSON.stringify(configPaths, null, 2),
        "```",
        "",
        "### magic-context.jsonc flags",
        "```jsonc",
        JSON.stringify(sanitizeConfigValue(report.magicContextConfig.flags), null, 2),
        "```",
        "",
        "### Plugin cache",
        "```json",
        JSON.stringify(pluginCache, null, 2),
        "```",
        "",
        "### Storage",
        "```json",
        JSON.stringify(storage, null, 2),
        "```",
        "",
        "### Recent sessions",
        recentSessions.length === 0
            ? "_No recent OpenCode sessions found (or OpenCode DB unavailable on this runtime)._"
            : ["```json", JSON.stringify(recentSessions, null, 2), "```"].join("\n"),
        "",
        "### Historian dumps",
        "(Metadata only — XML content is not included in this report.)",
        "Dumps are stored per-project under `<project>/.opencode/magic-context/historian/`.",
        "```json",
        JSON.stringify(historianDumps, null, 2),
        "```",
        "",
        "### Historian failures (session_meta)",
        report.historianFailures.length === 0
            ? "_No sessions with historian failures._"
            : [
                  "```json",
                  JSON.stringify(sanitizeConfigValue(report.historianFailures), null, 2),
                  "```",
              ].join("\n"),
        "",
        "### Log file",
        `- Path: ${sanitizeString(report.logFile.path)}`,
        `- Exists: ${report.logFile.exists}`,
        `- Size: ${report.logFile.sizeKb} KB`,
    ].join("\n");
}
