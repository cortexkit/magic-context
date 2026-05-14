import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

import { parseCompartmentOutput } from "@magic-context/core/hooks/magic-context/compartment-parser";
import {
    getMagicContextStorageDir,
    getProjectMagicContextHistorianDir,
} from "@magic-context/core/shared/data-path";
import { loadPiConfig } from "@magic-context/pi-core/config";
import { parse as parseJsonc } from "comment-json";
import {
    getMagicContextHistorianDir,
    getMagicContextLogPath,
    getPiAgentConfigDir,
    getPiUserConfigPath,
    getPiUserExtensionsPath,
} from "./paths";
import { detectPiBinary, getPiVersion } from "./pi-helpers";
import {
    describePiPackageEntry,
    hasPiMagicContextPackage,
    isPiMagicContextPackageEntry,
} from "./pi-package-entry";

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
        exists: boolean;
        contextDbSizeBytes: number;
    };
    conflicts: {
        knownConflicts: string[];
        otherPiExtensions: string[];
    };
    logFile: {
        path: string;
        exists: boolean;
        sizeKb: number;
    };
    /**
     * Recent Pi sessions ranked by JSONL mtime, top 5. Used to anchor
     * historian-dump lookups to real project directories and to power the
     * session picker in `--issue`. Pi stores sessions as JSONL files under
     * `~/.pi/agent/sessions/<slug>/*.jsonl` where `slug` is the project
     * directory path with `/` replaced by `-` and bookended by `--`.
     */
    recentSessions: PiRecentSessionSummary[];
    /** Historian dumps grouped by project directory + legacy tmp-dir fallback. */
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

export interface PiProjectHistorianBucket {
    directory: string;
    primarySessionId: string;
    sessionIds: string[];
    count: number;
    recent: PiHistorianDumpSummary[];
}

export interface PiHistorianDumpsReport {
    byProject: PiProjectHistorianBucket[];
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

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function currentUserHash(): string {
    const username = userInfo().username || "unknown";
    return createHash("sha256").update(username).digest("hex").slice(0, 12);
}

function redactSecretString(value: string): string {
    return value
        .replace(/Bearer\s+[A-Za-z0-9._~+\-/=]+/g, "Bearer <REDACTED>")
        .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-<REDACTED>")
        .replace(/api[_-]?key=([^\s&]+)/gi, "api_key=<REDACTED>")
        .replace(/token=([^\s&]+)/gi, "token=<REDACTED>");
}

/**
 * Sanitize paths, usernames, and obvious secret material before writing issue
 * reports. The exact home path becomes <HOME>; the local username is replaced
 * with a stable short hash so reports can correlate repeated occurrences
 * without leaking the account name.
 */
export function sanitizeString(value: string): string {
    const home = process.env.HOME || homedir();
    const username = userInfo().username;
    const userHash = `<USER:${currentUserHash()}>`;
    let sanitized = redactSecretString(value);
    if (home) {
        sanitized = sanitized.replace(new RegExp(escapeRegex(home), "g"), "<HOME>");
    }
    sanitized = sanitized.replace(/\/Users\/[^/]+\//g, `/Users/${userHash}/`);
    sanitized = sanitized.replace(/\/home\/[^/]+\//g, `/home/${userHash}/`);
    sanitized = sanitized.replace(/C:\\Users\\[^\\]+\\/g, `C:\\Users\\${userHash}\\`);
    if (username) {
        sanitized = sanitized.replace(new RegExp(escapeRegex(username), "g"), userHash);
    }
    return sanitized;
}

function shouldRedactKey(key: string): boolean {
    return /api[_-]?key|token|secret|password|authorization|cookie/i.test(key);
}

export function sanitizeValue(value: unknown, key = ""): unknown {
    if (shouldRedactKey(key)) return "<REDACTED>";
    if (typeof value === "string") return sanitizeString(value);
    if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry));
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([entryKey, entry]) => [
                entryKey,
                sanitizeValue(entry, entryKey),
            ]),
        );
    }
    return value;
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
    return join(cwd, ".pi", "magic-context.jsonc");
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
    const sessionsRoot = join(homedir(), ".pi", "agent", "sessions");
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

function listDumpsInDir(
    dir: string,
    limit: number,
): { count: number; recent: PiHistorianDumpSummary[] } {
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
        const recent: PiHistorianDumpSummary[] = entries.slice(0, limit).map((entry) => {
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
        return { count: entries.length, recent };
    } catch {
        return { count: 0, recent: [] };
    }
}

function collectPiHistorianDumps(recentSessions: PiRecentSessionSummary[]): PiHistorianDumpsReport {
    const buckets = new Map<string, PiProjectHistorianBucket>();
    for (const session of recentSessions) {
        const dir = session.directory;
        if (!dir) continue;
        const projectHistorianDir = getProjectMagicContextHistorianDir(dir);
        const listing = listDumpsInDir(projectHistorianDir, 5);
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

    const legacyDir = getMagicContextHistorianDir("pi");
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

export async function collectDiagnostics(cwd = process.cwd()): Promise<PiDiagnosticReport> {
    const pi = detectPiBinary();
    const settingsPath = getPiUserExtensionsPath();
    const settingsParsed = readJsonc(settingsPath);
    const packages = packageEntries(settingsParsed.value);
    const userConfigPath = getPiUserConfigPath();
    const projectConfigPath = getProjectConfigPath(cwd);
    const loaded = loadPiConfig({ cwd });
    const storageDirPath = getMagicContextStorageDir();
    const dbPath = join(storageDirPath, "context.db");
    const logPath = getMagicContextLogPath("pi");
    const logFileSize = existsSync(logPath) ? statSync(logPath).size : 0;
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
            exists: existsSync(storageDirPath),
            contextDbSizeBytes: fileSize(dbPath),
        },
        conflicts: {
            knownConflicts: [],
            otherPiExtensions: otherPiExtensions.map(sanitizeString),
        },
        logFile: {
            path: logPath,
            exists: existsSync(logPath),
            sizeKb: Math.round(logFileSize / 1024),
        },
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
        exists: report.storageDir.exists,
        context_db_size: formatBytes(report.storageDir.contextDbSizeBytes),
    };

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
        "### Log file",
        `- Path: ${sanitizeString(report.logFile.path)}`,
        `- Exists: ${report.logFile.exists}`,
        `- Size: ${report.logFile.sizeKb} KB`,
    ].join("\n");
}
