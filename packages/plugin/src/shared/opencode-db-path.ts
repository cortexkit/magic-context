import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type OpenCodeDbPathSource = "OPENCODE_DB" | "channel" | "default" | "discovered";
export type OpenCodeHostGeneration = "v1" | "v2";
export type OpenCodeStoreGeneration = OpenCodeHostGeneration | "unknown";

export interface ResolveOpenCodeDbPathOptions {
    dataHome?: string;
    channel?: string;
    env?: NodeJS.ProcessEnv;
}

export function openCodeHostGenerationFromVersion(
    version: string | null | undefined,
): OpenCodeHostGeneration {
    const major = Number.parseInt(version?.match(/\d+/)?.[0] ?? "", 10);
    return Number.isFinite(major) && major >= 2 ? "v2" : "v1";
}

export interface OpenCodeStoreSchemaDatabase {
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

export interface OpenCodeDbPathResolution {
    path: string;
    source: OpenCodeDbPathSource;
    channel: string | null;
}

export interface OpenCodeDbReadFailure extends OpenCodeDbPathResolution {
    message: string;
}

interface CachedResolution {
    key: string;
    resolution: OpenCodeDbPathResolution;
    existed: boolean;
}

let cachedResolution: CachedResolution | null = null;
let lastReadFailure: OpenCodeDbReadFailure | null = null;
const claimedDiagnostics = new Set<string>();

function openCodeDataDir(env: NodeJS.ProcessEnv = process.env, dataHome?: string): string {
    return join(dataHome ?? env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode");
}

function environmentKey(
    dataDir: string,
    hostGeneration: OpenCodeHostGeneration,
    channel: string | undefined,
    env: NodeJS.ProcessEnv,
): string {
    return [
        hostGeneration,
        dataDir,
        env.OPENCODE_DB ?? "",
        env.OPENCODE_DISABLE_CHANNEL_DB ?? "",
        channel ?? env.OPENCODE_CHANNEL ?? "",
    ].join("\0");
}

function channelPath(dataDir: string, channel: string): string {
    return ["latest", "beta", "prod"].includes(channel)
        ? join(dataDir, "opencode.db")
        : join(dataDir, `opencode-${channel}.db`);
}

function discoveredCandidateNames(dataDir: string): string[] {
    const names = ["opencode.db", "opencode-local.db", "opencode-dev.db"];
    try {
        const discovered = readdirSync(dataDir, { withFileTypes: true })
            .filter((entry) => /^opencode-.+\.db$/.test(entry.name) && !names.includes(entry.name))
            .map((entry) => entry.name)
            .sort();
        names.push(...discovered);
    } catch {
        // A missing or unreadable data directory has no discovered candidates.
    }
    return names;
}

function discoverOpenCodeDb(dataDir: string): OpenCodeDbPathResolution {
    const candidates = discoveredCandidateNames(dataDir).map((name, order) => {
        const path = join(dataDir, name);
        try {
            const metadata = statSync(path);
            return metadata.isFile() ? { path, order, mtimeMs: metadata.mtimeMs } : null;
        } catch {
            return null;
        }
    });
    const existing = candidates
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
        .sort((left, right) => right.mtimeMs - left.mtimeMs || left.order - right.order)[0];

    if (!existing) {
        return { path: join(dataDir, "opencode.db"), source: "default", channel: null };
    }

    const name = existing.path.slice(dataDir.length + 1);
    const channel =
        name === "opencode.db" ? null : name.slice("opencode-".length, -".db".length) || null;
    return { path: existing.path, source: "discovered", channel };
}

function resolveV1Fresh(
    dataDir: string,
    env: NodeJS.ProcessEnv = process.env,
): OpenCodeDbPathResolution {
    const explicit = env.OPENCODE_DB;
    if (explicit !== undefined && explicit.length > 0) {
        if (explicit === ":memory:") {
            return { path: explicit, source: "OPENCODE_DB", channel: null };
        }
        return {
            path: isAbsolute(explicit) ? explicit : join(dataDir, explicit),
            source: "OPENCODE_DB",
            channel: null,
        };
    }

    const disableChannelDb = env.OPENCODE_DISABLE_CHANNEL_DB;
    if (disableChannelDb === "1" || disableChannelDb === "true") {
        return { path: join(dataDir, "opencode.db"), source: "default", channel: null };
    }

    const channel = env.OPENCODE_CHANNEL;
    if (channel !== undefined && channel.length > 0) {
        return { path: channelPath(dataDir, channel), source: "channel", channel };
    }

    return discoverOpenCodeDb(dataDir);
}

/** Match OpenCode 2's filename table and strip path separators from custom channels. */
export function sourceOpenCodeDatabaseFilename(
    hostGeneration: OpenCodeHostGeneration,
    channel: string,
    env: NodeJS.ProcessEnv = process.env,
): string {
    if (hostGeneration === "v1") {
        const explicit = env.OPENCODE_DB;
        if (explicit !== undefined && explicit.length > 0) return explicit;
        if (env.OPENCODE_DISABLE_CHANNEL_DB === "1" || env.OPENCODE_DISABLE_CHANNEL_DB === "true") {
            return "opencode.db";
        }
        return ["latest", "beta", "prod"].includes(channel)
            ? "opencode.db"
            : `opencode-${channel}.db`;
    }

    return (
        env.OPENCODE_DB ??
        (["latest", "dev", "beta", "next", "prod"].includes(channel) ||
        env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
        env.OPENCODE_DISABLE_CHANNEL_DB === "true"
            ? "opencode.db"
            : `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "")}.db`)
    );
}

function resolveV2Fresh(
    dataDir: string,
    channel: string,
    env: NodeJS.ProcessEnv,
): OpenCodeDbPathResolution {
    const filename = sourceOpenCodeDatabaseFilename("v2", channel, env);
    const explicit = env.OPENCODE_DB !== undefined;
    return {
        path: filename === ":memory:" ? filename : join(dataDir, filename),
        source: explicit ? "OPENCODE_DB" : env.OPENCODE_CHANNEL ? "channel" : "default",
        channel: explicit ? null : channel,
    };
}

/**
 * Resolve the store for one host generation. The default is the historical v1
 * resolver, including candidate discovery and all existing diagnostic text.
 */
export function resolveOpenCodeDbPath(
    hostGeneration: OpenCodeHostGeneration = "v1",
    options: ResolveOpenCodeDbPathOptions = {},
): OpenCodeDbPathResolution {
    const env = options.env ?? process.env;
    const dataDir = openCodeDataDir(env, options.dataHome);
    const channel = options.channel ?? env.OPENCODE_CHANNEL;
    const key = environmentKey(dataDir, hostGeneration, channel, env);
    if (
        cachedResolution?.key === key &&
        (!cachedResolution.existed || existsSync(cachedResolution.resolution.path))
    ) {
        if (cachedResolution.existed) return cachedResolution.resolution;
        // An absent result is re-probed so a DB created after plugin boot is detected.
    }

    const resolution =
        hostGeneration === "v2"
            ? resolveV2Fresh(dataDir, channel ?? "latest", env)
            : resolveV1Fresh(dataDir, env);
    cachedResolution = {
        key,
        resolution,
        existed: resolution.path !== ":memory:" && existsSync(resolution.path),
    };
    return resolution;
}

function schemaTableNames(
    db: OpenCodeStoreSchemaDatabase,
    schema: "main" | "oc_backfill" = "main",
): Set<string> {
    const rows = db
        .prepare(
            `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name IN ('message', 'part', 'session', 'project', 'session_message', 'session_v2')`,
        )
        .all() as Array<{ name?: unknown }>;
    return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

/**
 * Detect the persisted host schema.
 *
 * `session_message` does NOT identify v2: OpenCode 1.18.x ships that table beside `message`
 * and `part` (verified against a live 1.18.30 store, pinned in this module's tests). Only the
 * ABSENCE of the v1 message tables identifies a v2 store, so a v1 host is never mistaken for
 * a v2 one. A store carrying neither is a host that has not written its schema yet.
 */
export function detectOpenCodeStoreGeneration(
    db: OpenCodeStoreSchemaDatabase,
    schema: "main" | "oc_backfill" = "main",
): OpenCodeStoreGeneration {
    const tables = schemaTableNames(db, schema);
    const hasV1Messages = tables.has("message") && tables.has("part");
    if (hasV1Messages) return "v1";
    if (tables.has("session_message")) return "v2";
    if (tables.has("session") || tables.has("project")) return "v1";
    return "unknown";
}

/**
 * A store the OpenCode 2 host migrated from a v1 store keeps the v1 `message`/`part` tables
 * beside its own schema, so it carries BOTH generations and `detectOpenCodeStoreGeneration`
 * (which must keep calling a 1.18.x store v1) reports v1. `session_v2` is written only by an
 * OpenCode 2 host (1.18.x never creates it), so a store with it and `session_message` is
 * readable by v2 readers regardless of any v1 tables it also kept.
 */
function hasMigratedV2Schema(tables: Set<string>): boolean {
    return tables.has("session_message") && tables.has("session_v2");
}

/** A native OpenCode 2 store, or a v1 store an OpenCode 2 host has migrated. */
function isOpenCodeV2Store(
    db: OpenCodeStoreSchemaDatabase,
    schema: "main" | "oc_backfill" = "main",
): boolean {
    return (
        detectOpenCodeStoreGeneration(db, schema) === "v2" ||
        hasMigratedV2Schema(schemaTableNames(db, schema))
    );
}

/** Refuse before a generation-specific query can read the other host's schema. */
export function assertOpenCodeStoreGeneration(
    db: OpenCodeStoreSchemaDatabase,
    expected: OpenCodeHostGeneration,
    path: string,
    schema: "main" | "oc_backfill" = "main",
): void {
    const actual = detectOpenCodeStoreGeneration(db, schema);
    if (actual === expected) return;
    if (expected === "v2" && isOpenCodeV2Store(db, schema)) return;
    // A store with none of these tables has no schema YET — a host that has not written its
    // first row, or a fresh data directory. That is "nothing to read", not a conflicting host,
    // and readers have always treated it as empty. Refusing here made every reader throw before
    // OpenCode created its tables, which is how this guard took down 15 host e2e tests.
    if (actual === "unknown") return;
    throw new Error(
        `OpenCode store generation mismatch at ${path}: expected ${expected}, found ${actual}; refusing generation-specific database access`,
    );
}

export function openCodeDbPathExists(
    resolution: OpenCodeDbPathResolution = resolveOpenCodeDbPath(),
): boolean {
    return resolution.path !== ":memory:" && existsSync(resolution.path);
}

export function getOpenCodeDbProbeDescriptions(
    resolution: OpenCodeDbPathResolution = resolveOpenCodeDbPath(),
): string[] {
    if (resolution.source === "OPENCODE_DB") return [resolution.path];
    if (
        resolution.source === "channel" ||
        process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
        process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
    ) {
        return [resolution.path];
    }
    const dataDir = openCodeDataDir();
    return [
        join(dataDir, "opencode.db"),
        join(dataDir, "opencode-local.db"),
        join(dataDir, "opencode-dev.db"),
        join(dataDir, "opencode-<channel>.db"),
    ];
}

function lookedForText(resolution: OpenCodeDbPathResolution): string {
    return getOpenCodeDbProbeDescriptions(resolution).join(", ");
}

export function formatOpenCodeDbMissingBanner(
    resolution: OpenCodeDbPathResolution = resolveOpenCodeDbPath(),
): string {
    return `Magic Context cannot find OpenCode's session database (looked for ${lookedForText(resolution)}). History compaction (historian) and the mid-turn valve are disabled until it is found; set OPENCODE_DB if OpenCode stores it elsewhere.`;
}

export function formatOpenCodeDbMissingStatusLine(
    resolution: OpenCodeDbPathResolution = resolveOpenCodeDbPath(),
): string {
    return `OpenCode DB: MISSING (looked for ${lookedForText(resolution)}). History compaction (historian) and the mid-turn valve are disabled; set OPENCODE_DB if OpenCode stores it elsewhere.`;
}

export function formatOpenCodeDbDoctorLine(
    resolution: OpenCodeDbPathResolution = resolveOpenCodeDbPath(),
): string {
    return `FAIL OpenCode session database: not found (looked for ${lookedForText(resolution)}); set OPENCODE_DB if OpenCode stores it elsewhere.`;
}

export function formatOpenCodeDbReadFailureStatusLine(failure: OpenCodeDbReadFailure): string {
    return `OpenCode DB: READ FAILED (path=${failure.path}, source=${failure.source}) — ${failure.message}`;
}

export function recordOpenCodeDbReadFailure(
    resolution: OpenCodeDbPathResolution,
    error: unknown,
): OpenCodeDbReadFailure {
    const message = error instanceof Error ? error.message : String(error);
    lastReadFailure = { ...resolution, message };
    return lastReadFailure;
}

export function clearOpenCodeDbReadFailure(path?: string): void {
    if (path === undefined || lastReadFailure?.path === path) lastReadFailure = null;
}

export function getOpenCodeDbReadFailure(): OpenCodeDbReadFailure | null {
    return lastReadFailure;
}

export function claimOpenCodeDbDiagnosticOnce(
    surface: string,
    resolution: OpenCodeDbPathResolution,
): boolean {
    const key = `${surface}\0${resolution.path}\0${resolution.source}`;
    if (claimedDiagnostics.has(key)) return false;
    claimedDiagnostics.add(key);
    return true;
}

/** Test-only reset for process memoization and once-only diagnostics. */
export function resetOpenCodeDbPathStateForTesting(): void {
    cachedResolution = null;
    lastReadFailure = null;
    claimedDiagnostics.clear();
}
