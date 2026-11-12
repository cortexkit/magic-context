import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { loadPluginConfig } from "@magic-context/core/config";
import { isCompactionEnabled } from "@magic-context/core/config/agent-disable";
import { parseCompartmentOutput } from "@magic-context/core/hooks/magic-context/compartment-parser";
import { detectConflicts } from "@magic-context/core/shared/conflict-detector";
import {
    getMagicContextStorageResolution,
    getProjectMagicContextHistorianDir,
    isMagicContextStorageOutsideEngram,
} from "@magic-context/core/shared/data-path";
import {
    assertOpenCodeStoreGeneration,
    formatOpenCodeDbDoctorLine,
    type OpenCodeDbPathResolution,
    type OpenCodeHostGeneration,
    openCodeDbPathExists,
    openCodeHostGenerationFromVersion,
    resolveOpenCodeDbPath,
} from "@magic-context/core/shared/opencode-db-path";
import { parse as parseJsonc } from "comment-json";
import { pluginEntryPackage } from "../adapters/opencode";
import { compareSemverPrecedence } from "../commands/doctor-opencode2-cache";
import { inspectMagicContextLogs, type LogFileInspection } from "./log-lines";
import { detectOpenCodeInstallations } from "./opencode-detect";
import { describeOpenCodeInstallations, type OpenCodeInstallationReport } from "./opencode-helpers";
import {
    getOpenCodePluginCacheRoots,
    getOpenCodePluginPackageJsonPath,
    getOpenCodeV2PluginCacheSlot,
    isOpenCodePluginDistTag,
    listOpenCodeV2PluginCacheSlots,
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION,
    OPENCODE_PLUGIN_NAME,
    readConfiguredOpenCodePluginSpec,
    readOpenCodeV2CachedPluginVersion,
} from "./opencode-plugin-cache";
import { readPluginEntries } from "./opencode-plugin-registration";
import { type ConfigPaths, detectConfigPaths, getMagicContextHistorianDir } from "./paths";
import { sanitizeConfigValue, sanitizeDiagnosticText, sanitizePathString } from "./redaction";

export interface DiagnosticReport {
    timestamp: string;
    platform: string;
    arch: string;
    nodeVersion: string;
    pluginVersion: string;
    opencodeInstalled: boolean;
    opencodeInstallKind: "cli" | "desktop" | "none";
    opencodeVersion: string | null;
    /** Every detected install, with the first detection-ladder rung marked active. */
    opencodeInstallations: OpenCodeInstallationReport[];
    configPaths: ConfigPaths;
    opencodeConfigHasPlugin: boolean;
    tuiConfigHasPlugin: boolean;
    magicContextConfig: {
        exists: boolean;
        parseError?: string;
        flags: Record<string, unknown>;
    };
    pluginCache: {
        path: string;
        cached?: string;
        latest?: string;
        /**
         * Where `latest` came from: `npm` when the newest published version of
         * the tag the install follows was fetched, `cli` when that fetch failed
         * and `latest` is only this CLI's own version.
         */
        latestSource?: "npm" | "cli";
        /** Every Magic Context install found across OpenCode 1 and OpenCode 2 cache layouts. */
        installs?: PluginCacheInstall[];
    };
    storageDir: {
        path: string;
        source?: string;
        exists: boolean;
        contextDbSizeBytes: number;
    };
    conflicts: {
        hasConflict: boolean;
        reasons: string[];
        /** Resolved MC compaction mode used by the writer/fixer. */
        compactionEnabled: boolean;
        /** Resolved native OpenCode compaction state (auto/prune). */
        nativeCompaction: {
            auto: boolean;
            prune: boolean;
        };
    };
    openCodeDatabase?: OpenCodeDbPathResolution & { exists: boolean };
    /** Compatibility alias for the first existing candidate, or the legacy path. */
    logFile: {
        path: string;
        exists: boolean;
        sizeKb: number;
    };
    logFiles?: LogFileInspection[];
    /**
     * Recent active OpenCode sessions (five parent groups, with up to three
     * newest children per group). Used to anchor historian-dump lookups to
     * real project directories and to power the session picker in the `--issue`
     * flow.
     *
     * Availability is reported separately so unreadable stores never look empty.
     */
    recentSessions: DiagnosticRows<RecentSessionSummary>;
    /**
     * Historian dumps grouped by project directory. Older dumps under the
     * legacy harness-scoped tmp dir are surfaced separately as `legacyDumps`
     * so users with old artifacts still see them in doctor.
     */
    historianDumps: HistorianDumpsReport;
    /** Most recent historian-failure rows from session_meta across all sessions. */
    historianFailures: DiagnosticRows<HistorianFailureSummary>;
    /**
     * Per-session rollup of the durable `historian_runs` telemetry. Surfaces the
     * fail/success/noop history that the self-clearing session_meta counter hides.
     */
    historianRuns: DiagnosticRows<HistorianRunSummary>;
}

export interface PluginCacheInstall {
    /** `opencode1`: `<cache>/opencode/packages/`; `opencode2`: `<cache>/opencode/npm/`. */
    layout: "opencode1" | "opencode2";
    /** What the install is keyed by: `latest`, a dist-tag such as `beta`, or a version. */
    spec: string;
    path: string;
    cached?: string;
}

/**
 * Per-project historian-dump bucket built from the recent-sessions list.
 *
 * One entry per unique project directory that has at least one dump under
 * `<directory>/.cortexkit/magic-context/historian/`. Sessions sharing a
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

export type DiagnosticRows<T> =
    | { available: true; rows: T[] }
    | { available: false; reason: string };

export interface RecentSessionSummary {
    sessionId: string;
    /** Session title from OpenCode (may be empty for fresh sessions). */
    title: string;
    /** Project directory the session lives under. */
    directory: string;
    /** ISO timestamp of last activity (`session.time_updated`). */
    lastActiveAt: string;
    /** Direct parent session ID for a child session, or null for a root. */
    parentSessionId?: string | null;
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

/**
 * Per-session rollup of the durable `historian_runs` telemetry table (migration
 * v24). Unlike `session_meta.historian_failure_count` — which is RESET to 0 on
 * every successful run — these rows are never cleared, so a "fails N times then
 * succeeds once" pattern (e.g. a flaky historian model that keeps returning
 * empty/invalid output) stays visible. This is what surfaces the failure history
 * the session_meta counter hides.
 */
export interface HistorianRunSummary {
    sessionId: string;
    /** Counts over the recent window (most-recent runs for this session). */
    total: number;
    success: number;
    failed: number;
    noop: number;
    /** Sanitized classified reason, marker for a legacy failure with no reason, or empty if none failed. */
    lastFailureReason: string;
    /** ISO timestamp of the most recent run in the window. */
    lastRunAt: string;
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

function readLegacyCachedVersion(root: string): string | undefined {
    try {
        const pkg = JSON.parse(readFileSync(getOpenCodePluginPackageJsonPath(root), "utf-8")) as {
            version?: unknown;
        };
        return typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The plugin-cache section of the issue report. `path`/`cached` describe the
 * install the running host loads: on OpenCode 2 the `npm/<name>@<spec>/` slot
 * for the configured spec, on OpenCode 1 the `packages/` tree. `installs`
 * lists every Magic Context install found in either layout, since both can
 * exist on one machine.
 */
export function collectOpenCodePluginCacheReport(
    hostGeneration: OpenCodeHostGeneration,
    opencodeConfig: Record<string, unknown> | null,
    npmVersions: NpmPluginVersions = {},
): DiagnosticReport["pluginCache"] {
    const installs: PluginCacheInstall[] = [];
    for (const root of getOpenCodePluginCacheRoots()) {
        if (!existsSync(root)) continue;
        const spec = root.endsWith("@latest") ? "latest" : "(bare)";
        installs.push({
            layout: "opencode1",
            spec,
            path: root,
            cached: readLegacyCachedVersion(root),
        });
    }
    for (const slot of listOpenCodeV2PluginCacheSlots()) {
        installs.push({
            layout: "opencode2",
            spec: slot.spec,
            path: slot.slot,
            cached: slot.version,
        });
    }

    let path: string;
    let cached: string | undefined;
    // The dist-tag whose newest version the reported install is compared with:
    // an OpenCode 2 entry may follow `@beta` or `@next`, OpenCode 1 only `latest`.
    let distTag = "latest";
    if (hostGeneration === "v2") {
        const spec = readConfiguredOpenCodePluginSpec(opencodeConfig);
        path = getOpenCodeV2PluginCacheSlot(undefined, spec);
        cached = readOpenCodeV2CachedPluginVersion(path);
        if (isOpenCodePluginDistTag(spec)) distTag = spec;
    } else {
        [path = ""] = getOpenCodePluginCacheRoots();
        cached = installs.find(
            (install) => install.layout === "opencode1" && install.cached,
        )?.cached;
    }
    const newest = npmVersions[distTag];
    return newest
        ? { path, cached, latest: newest, latestSource: "npm", installs }
        : { path, cached, latest: getSelfVersion(), latestSource: "cli", installs };
}

/**
 * Newest published plugin versions by dist-tag (`latest`, `beta`, ...), as
 * fetched from npm by the caller. A tag that could not be fetched is absent.
 */
export type NpmPluginVersions = Readonly<Record<string, string>>;

/**
 * The plain-language line an issue shows when the reported plugin install is
 * older than the newest published version, or null when it is current, when
 * either version is unknown, or when `latest` is only the CLI's own version.
 */
export function describeOutdatedPluginInstall(
    pluginCache: DiagnosticReport["pluginCache"],
): string | null {
    const { cached, latest, latestSource } = pluginCache;
    if (latestSource !== "npm" || !cached || !latest) return null;
    const comparison = compareSemverPrecedence(cached, latest);
    if (comparison === null || comparison >= 0) return null;
    return `Plugin is outdated: installed ${cached}, newest ${latest}.`;
}

function getStorageResolution(): ReturnType<typeof getMagicContextStorageResolution> {
    return getMagicContextStorageResolution();
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

export function configHasPluginEntry(config: Record<string, unknown> | null): boolean {
    // Both keys: OpenCode 2 loads `plugin` and `plugins` together.
    // Tuple and OpenCode 2 `{ package, options }` entries register the plugin too.
    const plugins = readPluginEntries(config).map(({ entry }) => pluginEntryPackage(entry));
    return plugins.some((entry) => {
        if (entry === null) return false;
        if (entry === OPENCODE_PLUGIN_NAME) return true;
        if (entry === OPENCODE_PLUGIN_ENTRY_WITH_VERSION) return true;
        if (entry.startsWith(`${OPENCODE_PLUGIN_NAME}@`)) return true;
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
 * `<directory>/.cortexkit/magic-context/historian/` and lists dumps there.
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

const RECENT_SESSION_GROUP_LIMIT = 5;
const CHILD_SESSIONS_PER_PARENT_LIMIT = 3;

export interface RecentSessionDatabase {
    prepare(sql: string): { all: () => unknown[] };
}

/**
 * Select recent OpenCode sessions for the issue picker from an injectable DB
 * seam. Five parent groups keep the default picker compact; each group can
 * show its three newest children, so a recent subagent remains selectable
 * without turning the prompt into an unbounded session dump.
 */
export function collectRecentSessionsFromDatabase(
    database: RecentSessionDatabase,
): RecentSessionSummary[] {
    const rows = database
        .prepare(
            `WITH active AS (
                SELECT id, directory, title, time_updated, parent_id
                FROM session
                WHERE time_archived IS NULL
            ),
            root_activity AS (
                SELECT p.id AS root_id,
                       MAX(
                           CASE
                               WHEN c.time_updated > p.time_updated THEN c.time_updated
                               ELSE p.time_updated
                           END
                       ) AS latest_activity
                FROM active p
                LEFT JOIN active c ON c.parent_id = p.id
                WHERE p.parent_id IS NULL
                GROUP BY p.id
            ),
            selected_roots AS (
                SELECT p.id, p.directory, p.title, p.time_updated, r.latest_activity
                FROM active p
                JOIN root_activity r ON r.root_id = p.id
                ORDER BY r.latest_activity DESC
                LIMIT ${RECENT_SESSION_GROUP_LIMIT}
            ),
            ranked_children AS (
                SELECT c.id, c.directory, c.title, c.time_updated, c.parent_id,
                       r.latest_activity,
                       ROW_NUMBER() OVER (
                           PARTITION BY c.parent_id
                           ORDER BY c.time_updated DESC
                       ) AS child_rank
                FROM active c
                JOIN selected_roots r ON c.parent_id = r.id
            )
            SELECT id, directory, title, time_updated, NULL AS parent_id,
                   latest_activity, 0 AS row_kind, 0 AS child_rank
            FROM selected_roots
            UNION ALL
            SELECT id, directory, title, time_updated, parent_id,
                   latest_activity, 1 AS row_kind, child_rank
            FROM ranked_children
            WHERE child_rank <= ${CHILD_SESSIONS_PER_PARENT_LIMIT}
            ORDER BY latest_activity DESC, row_kind ASC, child_rank ASC, time_updated DESC`,
        )
        .all() as Array<{
        id: unknown;
        directory: unknown;
        title: unknown;
        time_updated: unknown;
        parent_id: unknown;
    }>;

    return rows.flatMap((row) => {
        const sessionId = typeof row.id === "string" ? row.id : null;
        const directory = typeof row.directory === "string" ? row.directory : null;
        if (!sessionId || !directory) return [];
        const title = typeof row.title === "string" ? row.title : "";
        const lastActiveAt =
            typeof row.time_updated === "number" ? new Date(row.time_updated).toISOString() : "";
        const parentSessionId =
            typeof row.parent_id === "string" && row.parent_id.length > 0 ? row.parent_id : null;
        return [{ sessionId, title, directory, lastActiveAt, parentSessionId }];
    });
}

/** Read a diagnostic store without creating it or upgrading its schema. */
async function collectDatabaseRows<T>(
    path: string,
    read: (db: InstanceType<typeof import("@magic-context/core/shared/sqlite").Database>) => T[],
): Promise<DiagnosticRows<T>> {
    if (!existsSync(path)) return { available: false, reason: "path missing" };
    let backend: typeof import("@magic-context/core/shared/sqlite");
    try {
        backend = await import("@magic-context/core/shared/sqlite");
    } catch (error) {
        return { available: false, reason: `runtime unavailable: ${diagnosticError(error)}` };
    }
    let db: InstanceType<typeof backend.Database> | undefined;
    try {
        db = new backend.Database(path, { readonly: true });
        return { available: true, rows: read(db) };
    } catch (error) {
        const message = diagnosticError(error);
        const category = /no such (table|column)/i.test(message) ? "schema too old" : "query error";
        return { available: false, reason: `${category}: ${message}` };
    } finally {
        try {
            db?.close();
        } catch {
            // A close failure must not hide the diagnostic query result.
        }
    }
}

function diagnosticError(error: unknown): string {
    return sanitizeDiagnosticText(error instanceof Error ? error.message : String(error));
}

/** Read recent active sessions from the resolved OpenCode store on Bun or Node. */
export async function collectRecentSessions(
    resolution: OpenCodeDbPathResolution,
    hostGeneration: OpenCodeHostGeneration,
): Promise<DiagnosticRows<RecentSessionSummary>> {
    return collectDatabaseRows(resolution.path, (db) => {
        assertOpenCodeStoreGeneration(db, hostGeneration, resolution.path);
        return collectRecentSessionsFromDatabase(db);
    });
}

/** Read historian failure counters, which reset to zero after a successful run. */
export async function collectHistorianFailures(
    storageDirPath: string,
): Promise<DiagnosticRows<HistorianFailureSummary>> {
    return collectDatabaseRows(join(storageDirPath, "context.db"), (db) => {
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
    });
}

/** Read durable historian telemetry, which persists across successful runs. */
export async function collectHistorianRuns(
    storageDirPath: string,
): Promise<DiagnosticRows<HistorianRunSummary>> {
    return collectDatabaseRows(join(storageDirPath, "context.db"), (db) => {
        const aggRows = db
            .prepare(
                `SELECT session_id,
                    COUNT(*) AS total,
                    SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
                    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
                    SUM(CASE WHEN status='noop' THEN 1 ELSE 0 END) AS noop,
                    MAX(created_at) AS last_run_at
                 FROM historian_runs
                 GROUP BY session_id
                 ORDER BY last_run_at DESC
                 LIMIT 10`,
            )
            .all() as Array<{
            session_id: unknown;
            total: unknown;
            success: unknown;
            failed: unknown;
            noop: unknown;
            last_run_at: unknown;
        }>;
        if (aggRows.length === 0) return [];

        // Most-recent failure reason per session (only for sessions with failures).
        const reasonRows = db
            .prepare(
                `SELECT session_id, failure_reason, created_at
                 FROM historian_runs
                 WHERE status='failed' AND failure_reason IS NOT NULL
                 ORDER BY created_at DESC
                 LIMIT 200`,
            )
            .all() as Array<{ session_id: unknown; failure_reason: unknown }>;
        const latestReasonBySession = new Map<string, string>();
        for (const row of reasonRows) {
            const sid = typeof row.session_id === "string" ? row.session_id : "";
            if (!sid || latestReasonBySession.has(sid)) continue;
            if (typeof row.failure_reason === "string") {
                latestReasonBySession.set(sid, row.failure_reason);
            }
        }

        const asNum = (v: unknown): number => (typeof v === "number" ? v : 0);
        return aggRows.map((row) => {
            const sessionId = typeof row.session_id === "string" ? row.session_id : "<unknown>";
            const failed = asNum(row.failed);
            const rawReason = latestReasonBySession.get(sessionId) ?? "";
            return {
                sessionId,
                total: asNum(row.total),
                success: asNum(row.success),
                failed,
                noop: asNum(row.noop),
                lastFailureReason: rawReason.trim()
                    ? sanitizeDiagnosticText(rawReason.replace(/\s+/g, " ").trim().slice(0, 400))
                    : failed > 0
                      ? "no reason recorded (older version)"
                      : "",
                lastRunAt:
                    typeof row.last_run_at === "number"
                        ? new Date(row.last_run_at).toISOString()
                        : "",
            };
        });
    });
}

/**
 * Plugin logs an issue report reads for this host. The OpenCode 2 plugin writes
 * under the `opencode2` temp subtree, so on an OpenCode 2 host its log comes
 * first; the OpenCode 1 log follows because a machine that just upgraded has
 * its earlier history there.
 */
export function openCodeIssueLogHarnesses(
    hostGeneration: "v1" | "v2",
): Array<"opencode" | "opencode2"> {
    return hostGeneration === "v2" ? ["opencode2", "opencode"] : ["opencode"];
}

// ── Main entry ─────────────────────────────────────────────────────

export interface CollectDiagnosticsOptions {
    /** Newest published plugin versions the caller already fetched from npm. */
    npmVersions?: NpmPluginVersions;
}

export async function collectDiagnostics(
    options: CollectDiagnosticsOptions = {},
): Promise<DiagnosticReport> {
    const pluginVersion = getSelfVersion();
    const configPaths = detectConfigPaths();
    const opencodeConfig = readConfig(configPaths.opencodeConfig);
    const tuiConfig = readConfig(configPaths.tuiConfig);
    const magicContextConfig = readConfig(configPaths.magicContextConfig);
    const storageResolution = getStorageResolution();
    const storageDirPath = storageResolution.path;
    const contextDbPath = join(storageDirPath, "context.db");

    // Resolve the MC compaction mode via the same loader + accessor the
    // plugin uses, so diagnostics never re-derives the compaction decision.
    // On load failure take the preserve-existing-native-fields branch (false)
    // and emit a diagnostic, never assuming either mode.
    let compactionEnabled = false;
    try {
        compactionEnabled = isCompactionEnabled(loadPluginConfig(process.cwd()));
    } catch (error) {
        console.warn(
            `[magic-context] Could not load Magic Context config to resolve compaction mode; ` +
                `preserving existing native compaction fields. ` +
                `(${error instanceof Error ? error.message : String(error)})`,
        );
    }
    const opencodeInstallations = describeOpenCodeInstallations(detectOpenCodeInstallations());
    const activeInstallation = opencodeInstallations[0];
    const hostGeneration = openCodeHostGenerationFromVersion(activeInstallation?.version);
    const logFiles = openCodeIssueLogHarnesses(hostGeneration)
        .flatMap((harness) => inspectMagicContextLogs(harness))
        .filter((file, index, all) => all.findIndex((other) => other.path === file.path) === index);
    const primaryLog = logFiles.find((file) => file.exists) ?? logFiles[0];
    const conflictResult = detectConflicts(process.cwd(), { compactionEnabled, hostGeneration });
    const openCodeDatabaseResolution = resolveOpenCodeDbPath(hostGeneration);
    const recentSessions = await collectRecentSessions(openCodeDatabaseResolution, hostGeneration);
    let openCodeInstallKind: "cli" | "desktop" | "none" = "none";
    if (activeInstallation) openCodeInstallKind = activeInstallation.kind;

    return {
        timestamp: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        pluginVersion,
        opencodeInstalled: openCodeInstallKind !== "none",
        opencodeInstallKind: openCodeInstallKind,
        opencodeVersion:
            activeInstallation?.kind === "cli" && activeInstallation.version !== "unknown"
                ? activeInstallation.version
                : null,
        opencodeInstallations,
        configPaths,
        opencodeConfigHasPlugin: configHasPluginEntry(opencodeConfig.value),
        tuiConfigHasPlugin: configHasPluginEntry(tuiConfig.value),
        magicContextConfig: {
            exists: existsSync(configPaths.magicContextConfig),
            ...(magicContextConfig.error ? { parseError: magicContextConfig.error } : {}),
            flags: (sanitizeValue(magicContextConfig.value ?? {}) as Record<string, unknown>) ?? {},
        },
        pluginCache: collectOpenCodePluginCacheReport(
            hostGeneration,
            opencodeConfig.value,
            options.npmVersions,
        ),
        storageDir: {
            path: storageDirPath,
            source: storageResolution.source,
            exists: existsSync(storageDirPath),
            contextDbSizeBytes: fileSize(contextDbPath),
        },
        openCodeDatabase: {
            ...openCodeDatabaseResolution,
            exists: openCodeDbPathExists(openCodeDatabaseResolution),
        },
        conflicts: {
            hasConflict: conflictResult.hasConflict,
            reasons: conflictResult.reasons,
            compactionEnabled,
            nativeCompaction: conflictResult.nativeCompaction,
        },
        logFile: {
            path: primaryLog.path,
            exists: primaryLog.exists,
            sizeKb: primaryLog.sizeKb,
        },
        logFiles,
        recentSessions,
        historianDumps: collectHistorianDumps(recentSessions.available ? recentSessions.rows : []),
        historianFailures: await collectHistorianFailures(storageDirPath),
        historianRuns: await collectHistorianRuns(storageDirPath),
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
        latest_source: report.pluginCache.latestSource ?? "cli",
        installs: (report.pluginCache.installs ?? []).map((install) => ({
            ...install,
            path: sanitizeString(install.path),
            cached: install.cached ?? null,
        })),
    };

    const storage = {
        path: sanitizeString(report.storageDir.path),
        source: report.storageDir.source ?? "unknown",
        exists: report.storageDir.exists,
        context_db_size: formatBytes(report.storageDir.contextDbSizeBytes),
    };
    const storageBackupWarning = isMagicContextStorageOutsideEngram(report.storageDir.path)
        ? `- Warning: Magic Context storage is at ${sanitizeString(report.storageDir.path)}, outside the folder Engram backs up (~/.local/share/cortexkit/magic-context). It is not included in CortexKit backups.`
        : null;

    const openCodeInstallations = report.opencodeInstallations ?? [];
    const openCodeInstallationTable =
        openCodeInstallations.length > 1
            ? [
                  "",
                  "### OpenCode installations",
                  "| Marker | Path | Version | Source |",
                  "| --- | --- | --- | --- |",
                  ...openCodeInstallations.map(
                      (installation) =>
                          `| ${installation.active ? "[active]" : ""} | \`${sanitizeString(installation.path)}\` | ${installation.version} | ${installation.source} |`,
                  ),
              ]
            : [];

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

    const recentSessions = (report.recentSessions.available ? report.recentSessions.rows : []).map(
        (session) => ({
            sessionId: session.sessionId,
            title: sanitizeDiagnosticText(session.title),
            directory: sanitizeString(session.directory),
            lastActiveAt: session.lastActiveAt,
            parentSessionId: session.parentSessionId ?? null,
        }),
    );

    return [
        `- Timestamp: ${report.timestamp}`,
        `- magic-context CLI: v${report.pluginVersion}`,
        `- OS: ${report.platform} ${report.arch}`,
        `- Node: ${report.nodeVersion}`,
        `- OpenCode installed: ${report.opencodeInstalled} [${report.opencodeInstallKind}]${report.opencodeVersion ? ` (${report.opencodeVersion})` : ""}`,
        ...(report.openCodeDatabase
            ? [
                  report.openCodeDatabase.exists
                      ? `- OpenCode session database: ${sanitizeString(report.openCodeDatabase.path)} (source=${report.openCodeDatabase.source}${report.openCodeDatabase.channel ? `, channel=${report.openCodeDatabase.channel}` : ""})`
                      : `- ${formatOpenCodeDbDoctorLine(report.openCodeDatabase)}`,
              ]
            : []),
        `- Plugin registered in opencode config: ${report.opencodeConfigHasPlugin}`,
        `- Plugin registered in tui config: ${report.tuiConfigHasPlugin}`,
        `- magic-context.jsonc parse error: ${report.magicContextConfig.parseError ?? "none"}`,
        `- Conflicts detected: ${report.conflicts.hasConflict ? report.conflicts.reasons.join("; ") : "none"}`,
        `- MC compaction mode: ${report.conflicts.compactionEnabled ? "on" : "off"}`,
        `- Native compaction: auto=${report.conflicts.nativeCompaction?.auto ?? "unknown"}, prune=${report.conflicts.nativeCompaction?.prune ?? "unknown"}`,
        ...openCodeInstallationTable,
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
        ...(storageBackupWarning ? [storageBackupWarning] : []),
        "```json",
        JSON.stringify(storage, null, 2),
        "```",
        "",
        "### Recent sessions",
        !report.recentSessions.available
            ? `Recent sessions: unavailable (${sanitizeDiagnosticText(report.recentSessions.reason)})`
            : recentSessions.length === 0
              ? "_No recent OpenCode sessions found._"
              : ["```json", JSON.stringify(recentSessions, null, 2), "```"].join("\n"),
        "",
        "### Historian dumps",
        "(Metadata only — XML content is not included in this report.)",
        "Dumps are stored per-project under `<project>/.cortexkit/magic-context/historian/`.",
        "```json",
        JSON.stringify(historianDumps, null, 2),
        "```",
        "",
        "### Historian failures (session_meta)",
        "_Note: this counter RESETS to 0 on every successful run — see 'Historian runs' below for the durable history._",
        !report.historianFailures.available
            ? `Historian failures: unavailable (${sanitizeDiagnosticText(report.historianFailures.reason)})`
            : report.historianFailures.rows.length === 0
              ? "_No sessions with historian failures._"
              : [
                    "```json",
                    JSON.stringify(sanitizeConfigValue(report.historianFailures.rows), null, 2),
                    "```",
                ].join("\n"),
        "",
        "### Historian runs (durable telemetry)",
        "Per-session success/failure/no-op counts from `historian_runs` (never reset).",
        !report.historianRuns.available
            ? `Historian runs: unavailable (${sanitizeDiagnosticText(report.historianRuns.reason)})`
            : report.historianRuns.rows.length === 0
              ? "_No historian runs recorded._"
              : [
                    "```json",
                    JSON.stringify(sanitizeConfigValue(report.historianRuns.rows), null, 2),
                    "```",
                ].join("\n"),
        "",
        "### Log files",
        ...(report.logFiles ?? [report.logFile]).map(
            (file) =>
                `- ${sanitizeString(file.path)}: exists=${file.exists}, grammar=${"grammar" in file ? file.grammar : "unknown"}, lines=${"lineCount" in file ? file.lineCount : 0}, size=${file.sizeKb} KB`,
        ),
    ].join("\n");
}
