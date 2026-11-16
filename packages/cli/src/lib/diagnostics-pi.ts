import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { resolveCortexKitProjectConfigPath } from "@magic-context/core/config/migrate-config-location";
import { parseCompartmentOutput } from "@magic-context/core/hooks/magic-context/compartment-parser";
import {
    getMagicContextStorageResolution,
    isMagicContextStorageOutsideEngram,
} from "@magic-context/core/shared/data-path";
import { loadPiConfig } from "@magic-context/pi-core/config";
import { parse as parseJsonc } from "comment-json";
import {
    type HistorianDumpFile,
    scanHistorianDumpFiles,
    scanHistorianSessionDumpDirs,
} from "./historian-dump-dirs";
import { inspectMagicContextLogs, type LogFileInspection } from "./log-lines";
import {
    getMagicContextHistorianDir,
    getPiAgentConfigDir,
    getPiSessionsRoot,
    getPiUserConfigPath,
    getPiUserExtensionsPath,
    getProjectHistorianDumpDir,
} from "./paths";
import { detectPiBinary, getPiVersion } from "./pi-helpers";
import {
    describePiPackageEntry,
    hasPiMagicContextPackage,
    isPiMagicContextPackageEntry,
} from "./pi-package-entry";
import { sanitizeConfigValue, sanitizeDiagnosticText } from "./redaction";

export interface PiConfigDiagnostic {
    path: string;
    exists: boolean;
    parseError?: string;
    flags: Record<string, unknown>;
}

export interface PiDiagnosticReport {
    timestamp: string;
    platform: string;
    arch: string;
    nodeVersion: string;
    pluginVersion: string;
    piInstalled: boolean;
    piPath: string | null;
    piVersion: string | null;
    settings: {
        path: string;
        exists: boolean;
        parseError?: string;
        hasMagicContextPackage: boolean;
        packages: unknown[];
    };
    configPaths: {
        agentDir: string;
        userConfig: string;
        projectConfig: string;
    };
    userConfig: PiConfigDiagnostic;
    projectConfig: PiConfigDiagnostic;
    loadedConfigPaths: string[];
    loadWarnings: string[];
    storageDir: {
        path: string;
        source?: string;
        exists: boolean;
        contextDbSizeBytes: number;
    };
    conflicts: {
        knownConflicts: string[];
        otherPiExtensions: string[];
    };
    /** Compatibility alias for the first existing candidate, or the legacy path. */
    logFile: {
        path: string;
        exists: boolean;
        sizeKb: number;
    };
    logFiles?: LogFileInspection[];
    /**
     * Recent Pi sessions ranked by JSONL mtime, top 5. Used to anchor
     * historian-dump lookups to real project directories and to power the
     * session picker in `--issue`. Pi stores sessions as JSONL files under
     * `~/.pi/agent/sessions/<slug>/*.jsonl` where `slug` is the project
     * directory path with `/` replaced by `-` and bookended by `--`.
     */
    recentSessions: PiRecentSessionSummary[];
    /**
     * Historian dumps from the current per-session temp dirs, the project
     * directories older plugins used, and the flat temp dir of plugins before 0.18.
     */
    historianDumps: PiHistorianDumpsReport;
}

export interface PiRecentSessionSummary {
    sessionId: string;
    /** Project directory derived from Pi's session-slug folder. */
    directory: string;
    /** ISO timestamp of the JSONL file's mtime. */
    lastActiveAt: string;
}

export interface PiHistorianDumpSummary {
    name: string;
    ageMinutes: number;
    sizeKb: number;
    /** Parsed structural metadata, when XML is valid. */
    meta?: PiHistorianDumpMeta;
    /** Parse error, when XML could not be parsed. */
    parseError?: string;
}

export interface PiHistorianDumpMeta {
    compartmentCount: number;
    minStart: number | null;
    maxEnd: number | null;
    unprocessedFrom: number | null;
    factCountByCategory: Record<string, number>;
    userObservationCount: number;
    ordinalGapCount: number;
    ordinalOverlapCount: number;
}

/**
 * Dumps that plugins up to 0.49.57 wrote under
 * `<directory>/.cortexkit/magic-context/historian/`, one bucket per project.
 */
export interface PiProjectHistorianBucket {
    directory: string;
    primarySessionId: string;
    sessionIds: string[];
    count: number;
    recent: PiHistorianDumpSummary[];
}

/** One session's dump directory under the harness temp dir. */
export interface PiSessionHistorianBucket {
    /** Name of the session's directory: the session id, reduced to filename-safe characters. */
    sessionId: string;
    count: number;
    recent: PiHistorianDumpSummary[];
}

export interface PiHistorianDumpsReport {
    /**
     * Dumps written by current plugins: one subdirectory per session under
     * `${tmpdir}/pi/magic-context/historian/`.
     */
    sessionDumps: {
        dir: string;
        /** Dump files across every session directory. */
        count: number;
        /** Session directories holding at least one dump. */
        sessionCount: number;
        /** The sessions with the newest dumps, newest first, capped at 10. */
        sessions: PiSessionHistorianBucket[];
    };
    byProject: PiProjectHistorianBucket[];
    /** Dumps that plugins before 0.18 wrote directly into the harness historian dir. */
    legacyDumps: {
        dir: string;
        count: number;
        recent: PiHistorianDumpSummary[];
    };
}

function getSelfVersion(): string {
    const req = createRequire(import.meta.url);
    for (const relPath of ["../../package.json", "../package.json"]) {
        try {
            const pkg = req(relPath) as { version?: unknown };
            if (typeof pkg.version === "string" && pkg.version.length > 0) {
                return pkg.version;
            }
        } catch {
            // Try next layout (src vs bundled dist).
        }
    }
    return "unknown";
}

function fileSize(path: string): number {
    try {
        return existsSync(path) ? statSync(path).size : 0;
    } catch {
        return 0;
    }
}

export function sanitizeString(value: string): string {
    return sanitizeDiagnosticText(value);
}

export function sanitizeValue(value: unknown): unknown {
    return sanitizeConfigValue(value);
}

function readJsonc(path: string): {
    value: Record<string, unknown>;
    parseError?: string;
} {
    if (!existsSync(path)) return { value: {} };
    try {
        return {
            value: parseJsonc(readFileSync(path, "utf-8")) as Record<string, unknown>,
        };
    } catch (error) {
        return {
            value: {},
            parseError: error instanceof Error ? error.message : String(error),
        };
    }
}

function getProjectConfigPath(cwd: string): string {
    return resolveCortexKitProjectConfigPath(cwd);
}

function readConfigDiagnostic(path: string): PiConfigDiagnostic {
    const parsed = readJsonc(path);
    return {
        path,
        exists: existsSync(path),
        ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
        flags: sanitizeValue(parsed.value) as Record<string, unknown>,
    };
}

function packageEntries(settings: Record<string, unknown>): unknown[] {
    return Array.isArray(settings.packages) ? settings.packages : [];
}

/**
 * Convert a Pi session-slug directory name back to its source project path.
 *
 * Pi slugs the project directory by stripping leading `/`, replacing each
 * `/` with `-`, then bookending with `--`. Example:
 *   /Users/me/Work/foo  →  --Users-me-Work-foo--
 *
 * This is lossy when a path component contains literal `-` characters; the
 * reverse path will collapse them with the `/` separators. We accept the
 * loss because the diagnostics report shows the reconstructed path as a
 * lookup key, not as a navigation target — the worst-case is a path that
 * doesn't exist on disk, which the dump walker handles gracefully.
 */
function reverseSlugToDirectory(slug: string): string | null {
    if (!slug.startsWith("--") || !slug.endsWith("--")) return null;
    const inner = slug.slice(2, -2);
    if (!inner) return null;
    return `/${inner.replace(/-/g, "/")}`;
}

/**
 * Read recent Pi sessions from `~/.pi/agent/sessions/<slug>/*.jsonl`.
 *
 * Returns the top 5 sessions ranked by JSONL mtime, with each entry
 * pointing at the project directory recovered from the slug. The session
 * ID is derived from the JSONL filename (Pi names files like
 * `<ISO-timestamp>_<uuid>.jsonl`). Empty array when `~/.pi/agent/sessions/`
 * doesn't exist (Pi not installed or never used).
 */
function collectPiRecentSessions(): PiRecentSessionSummary[] {
    const sessionsRoot = getPiSessionsRoot();
    if (!existsSync(sessionsRoot)) return [];
    try {
        const slugs = readdirSync(sessionsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);

        const candidates: Array<{
            sessionId: string;
            directory: string;
            mtime: number;
        }> = [];

        for (const slug of slugs) {
            const directory = reverseSlugToDirectory(slug);
            if (!directory) continue;
            const slugDir = join(sessionsRoot, slug);
            let files: string[];
            try {
                files = readdirSync(slugDir).filter((name) => name.endsWith(".jsonl"));
            } catch {
                continue;
            }
            for (const file of files) {
                try {
                    const mtime = statSync(join(slugDir, file)).mtimeMs;
                    // Pi filename shape: <ISO-timestamp>_<uuid>.jsonl
                    // Strip the .jsonl extension; the rest IS the session ID
                    // Pi uses internally (timestamp + uuid pair).
                    const sessionId = file.replace(/\.jsonl$/, "");
                    candidates.push({ sessionId, directory, mtime });
                } catch {
                    // Skip unreadable file
                }
            }
        }

        candidates.sort((a, b) => b.mtime - a.mtime);
        return candidates.slice(0, 5).map((entry) => ({
            sessionId: entry.sessionId,
            directory: entry.directory,
            lastActiveAt: new Date(entry.mtime).toISOString(),
        }));
    } catch {
        return [];
    }
}

function parseHistorianDumpMeta(path: string): PiHistorianDumpMeta | { error: string } {
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

/** Summarize the newest `limit` dump files with metadata parsed from their XML. */
function summarizeDumps(
    dir: string,
    files: HistorianDumpFile[],
    limit: number,
): PiHistorianDumpSummary[] {
    const now = Date.now();
    return files.slice(0, limit).map((entry) => {
        const meta = parseHistorianDumpMeta(join(dir, entry.name));
        const summary: PiHistorianDumpSummary = {
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
}

function listDumpsInDir(
    dir: string,
    limit: number,
): { count: number; recent: PiHistorianDumpSummary[] } {
    const files = scanHistorianDumpFiles(dir);
    return { count: files.length, recent: summarizeDumps(dir, files, limit) };
}

const SESSION_DUMP_BUCKET_LIMIT = 10;
const DUMPS_PER_BUCKET_LIMIT = 5;

/**
 * Collect historian dumps from the per-session temp dirs current plugins write,
 * the project directories (found through recent sessions) that plugins up to
 * 0.49.57 wrote, and the flat temp dir of plugins before 0.18.
 *
 * `historianRoot` is the harness historian dir; tests pass a scratch dir.
 */
export function collectPiHistorianDumps(
    recentSessions: PiRecentSessionSummary[],
    historianRoot: string = getMagicContextHistorianDir("pi"),
): PiHistorianDumpsReport {
    const sessionDirs = scanHistorianSessionDumpDirs(historianRoot);

    const buckets = new Map<string, PiProjectHistorianBucket>();
    for (const session of recentSessions) {
        const dir = session.directory;
        if (!dir) continue;
        const projectHistorianDir = getProjectHistorianDumpDir(dir);
        const listing = listDumpsInDir(projectHistorianDir, DUMPS_PER_BUCKET_LIMIT);
        const existing = buckets.get(dir);
        if (existing) {
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

    const legacyListing = listDumpsInDir(historianRoot, DUMPS_PER_BUCKET_LIMIT);

    return {
        sessionDumps: {
            dir: historianRoot,
            count: sessionDirs.reduce((sum, session) => sum + session.files.length, 0),
            sessionCount: sessionDirs.length,
            sessions: sessionDirs.slice(0, SESSION_DUMP_BUCKET_LIMIT).map((session) => ({
                sessionId: session.sessionId,
                count: session.files.length,
                recent: summarizeDumps(session.dir, session.files, DUMPS_PER_BUCKET_LIMIT),
            })),
        },
        byProject: [...buckets.values()],
        legacyDumps: {
            dir: historianRoot,
            count: legacyListing.count,
            recent: legacyListing.recent,
        },
    };
}

export async function collectDiagnostics(cwd = process.cwd()): Promise<PiDiagnosticReport> {
    const pi = detectPiBinary();
    const settingsPath = getPiUserExtensionsPath();
    const settingsParsed = readJsonc(settingsPath);
    const packages = packageEntries(settingsParsed.value);
    const userConfigPath = getPiUserConfigPath();
    const projectConfigPath = getProjectConfigPath(cwd);
    const loaded = loadPiConfig({ cwd });
    const storageResolution = getMagicContextStorageResolution();
    const storageDirPath = storageResolution.path;
    const dbPath = join(storageDirPath, "context.db");
    const logFiles = inspectMagicContextLogs("pi");
    const primaryLog = logFiles.find((file) => file.exists) ?? logFiles[0];
    const otherPiExtensions = packages
        .filter((entry) => !isPiMagicContextPackageEntry(entry))
        .map(describePiPackageEntry);
    const recentSessions = collectPiRecentSessions();
    const historianDumps = collectPiHistorianDumps(recentSessions);

    return {
        timestamp: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        pluginVersion: getSelfVersion(),
        piInstalled: pi !== null,
        piPath: pi?.path ?? null,
        piVersion: pi ? getPiVersion(pi.path) : null,
        settings: {
            path: settingsPath,
            exists: existsSync(settingsPath),
            ...(settingsParsed.parseError ? { parseError: settingsParsed.parseError } : {}),
            hasMagicContextPackage: hasPiMagicContextPackage(packages),
            packages: sanitizeValue(packages) as unknown[],
        },
        configPaths: {
            agentDir: getPiAgentConfigDir(),
            userConfig: userConfigPath,
            projectConfig: projectConfigPath,
        },
        userConfig: readConfigDiagnostic(userConfigPath),
        projectConfig: readConfigDiagnostic(projectConfigPath),
        loadedConfigPaths: loaded.loadedFromPaths.map(sanitizeString),
        loadWarnings: loaded.warnings.map(sanitizeString),
        storageDir: {
            path: storageDirPath,
            source: storageResolution.source,
            exists: existsSync(storageDirPath),
            contextDbSizeBytes: fileSize(dbPath),
        },
        conflicts: {
            knownConflicts: [],
            otherPiExtensions: otherPiExtensions.map(sanitizeString),
        },
        logFile: {
            path: primaryLog.path,
            exists: primaryLog.exists,
            sizeKb: primaryLog.sizeKb,
        },
        logFiles,
        recentSessions,
        historianDumps,
    };
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function renderDiagnosticsMarkdown(report: PiDiagnosticReport): string {
    const configPaths = sanitizeValue(report.configPaths);
    const settings = sanitizeValue(report.settings);
    const storage = {
        path: sanitizeString(report.storageDir.path),
        source: report.storageDir.source ?? "unknown",
        exists: report.storageDir.exists,
        context_db_size: formatBytes(report.storageDir.contextDbSizeBytes),
    };
    const storageBackupWarning = isMagicContextStorageOutsideEngram(report.storageDir.path)
        ? `- Warning: Magic Context storage is at ${sanitizeString(report.storageDir.path)}, outside the folder Engram backs up (~/.local/share/cortexkit/magic-context). It is not included in CortexKit backups.`
        : null;

    return [
        `- Timestamp: ${report.timestamp}`,
        `- Pi plugin: v${report.pluginVersion}`,
        `- OS: ${report.platform} ${report.arch}`,
        `- Node: ${report.nodeVersion}`,
        `- Pi installed: ${report.piInstalled}${report.piVersion ? ` (${report.piVersion})` : ""}`,
        `- Magic Context package registered: ${report.settings.hasMagicContextPackage}`,
        `- User config parse error: ${report.userConfig.parseError ?? "none"}`,
        `- Project config parse error: ${report.projectConfig.parseError ?? "none"}`,
        `- Known Pi extension conflicts: ${report.conflicts.knownConflicts.length === 0 ? "none" : report.conflicts.knownConflicts.join("; ")}`,
        "",
        "### Pi settings",
        "```json",
        JSON.stringify(settings, null, 2),
        "```",
        "",
        "### Config paths",
        "```json",
        JSON.stringify(configPaths, null, 2),
        "```",
        "",
        "### User magic-context.jsonc flags",
        "```jsonc",
        JSON.stringify(report.userConfig.flags, null, 2),
        "```",
        "",
        "### Project magic-context.jsonc flags",
        "```jsonc",
        JSON.stringify(report.projectConfig.flags, null, 2),
        "```",
        "",
        "### Loaded config paths",
        report.loadedConfigPaths.length === 0
            ? "_No config files loaded; defaults are in use._"
            : report.loadedConfigPaths.map((path) => `- ${path}`).join("\n"),
        "",
        "### Config load warnings",
        report.loadWarnings.length === 0
            ? "_None._"
            : report.loadWarnings.map((warning) => `- ${warning}`).join("\n"),
        "",
        "### Shared storage",
        ...(storageBackupWarning ? [storageBackupWarning] : []),
        "```json",
        JSON.stringify(storage, null, 2),
        "```",
        "",
        "### Pi extension conflicts",
        "No known conflicting Pi extensions are currently registered. Other Pi packages are informational only.",
        "```json",
        JSON.stringify(report.conflicts, null, 2),
        "```",
        "",
        "### Log files",
        ...(report.logFiles ?? [report.logFile]).map(
            (file) =>
                `- ${sanitizeString(file.path)}: exists=${file.exists}, grammar=${"grammar" in file ? file.grammar : "unknown"}, lines=${"lineCount" in file ? file.lineCount : 0}, size=${file.sizeKb} KB`,
        ),
    ].join("\n");
}
