import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { loadPiConfig } from "@magic-context/pi-core/config";
import { parse as parseJsonc } from "comment-json";
import { getPiAgentConfigDir, getPiUserConfigPath, getPiUserExtensionsPath } from "./paths";
import { detectPiBinary, getPiVersion, PI_PACKAGE_SOURCE } from "./pi-helpers";

const PACKAGE_NAME = "@cortexkit/pi-magic-context";

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
        packages: string[];
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

function packageEntries(settings: Record<string, unknown>): string[] {
    return Array.isArray(settings.packages)
        ? settings.packages.filter((entry): entry is string => typeof entry === "string")
        : [];
}

function hasMagicContextPackage(packages: string[]): boolean {
    return packages.some(
        (entry) =>
            entry === PI_PACKAGE_SOURCE ||
            entry === PACKAGE_NAME ||
            entry.includes("pi-magic-context"),
    );
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
    const logPath = join(tmpdir(), "magic-context.log");
    const logFileSize = existsSync(logPath) ? statSync(logPath).size : 0;
    const otherPiExtensions = packages.filter((entry) => !hasMagicContextPackage([entry]));

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
            hasMagicContextPackage: hasMagicContextPackage(packages),
            packages: packages.map(sanitizeString),
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
