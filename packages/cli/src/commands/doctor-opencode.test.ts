import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { computeLegacyRustDirIdentity } from "@magic-context/core/features/magic-context/v22-deferred-backfill";
import { Database } from "@magic-context/core/shared/sqlite";
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";
import {
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION,
    OPENCODE_PLUGIN_NAME,
} from "../lib/opencode-plugin-cache";
import { runV22BackfillCommands } from "../lib/v22-backfill-commands";
import { migrateLegacyAgentEnabledConfigForDoctor } from "./doctor-opencode";
import { clearPluginCache } from "./doctor-opencode-cache";

function migrate(input: Record<string, unknown>) {
    const logs: Array<{ level: "success" | "warn"; message: string }> = [];
    const result = migrateLegacyAgentEnabledConfigForDoctor(input, {
        success: (message) => logs.push({ level: "success", message }),
        warn: (message) => logs.push({ level: "warn", message }),
    });
    return { config: input, logs, result };
}

describe("doctor OpenCode legacy agent enabled migration", () => {
    it("migrates legacy enabled fields with conflict rules and warning text", () => {
        const { config, logs, result } = migrate({
            dreamer: { enabled: false, disable: false },
            sidekick: { enabled: true, disable: true },
            historian: { enabled: true, disable: true },
        });

        expect(result).toEqual({ changed: true, fixes: 3 });
        expect(config).toEqual({
            dreamer: { disable: true },
            sidekick: { disable: true },
            historian: { disable: true },
        });
        expect(logs).toContainEqual({
            level: "warn",
            message:
                "Migrated dreamer.enabled=false → dreamer.disable=true. This now also disables manual /ctx-dream. To keep manual dreaming, remove disable=true and set schedule to empty string.",
        });
        expect(logs.map((entry) => entry.message)).toContain(
            "Removed deprecated sidekick.enabled (use sidekick.disable=true to turn off Sidekick).",
        );
        expect(logs.map((entry) => entry.message)).toContain(
            "Removed invalid historian.enabled (historian uses disable=true to turn off).",
        );
    });

    it("removes enabled=true without adding disable=false and is idempotent", () => {
        const first = migrate({ dreamer: { enabled: true }, sidekick: { enabled: false } });
        expect(first.config).toEqual({ dreamer: {}, sidekick: { disable: true } });

        const second = migrate(first.config);
        expect(second.result).toEqual({ changed: false, fixes: 0 });
        expect(second.logs).toEqual([]);
    });

    it("round-trips migrated config through JSONC serialization", () => {
        const config = parseJsonc(
            '{ "dreamer": { "enabled": false }, "sidekick": { "enabled": false } }',
        ) as Record<string, unknown>;
        migrateLegacyAgentEnabledConfigForDoctor(config, { success: () => {}, warn: () => {} });
        const serialized = stringifyJsonc(config, null, 2);

        expect(serialized).toContain('"disable": true');
        expect(serialized).not.toContain('"enabled"');
    });
});

const tempDirs: string[] = [];
const dbs: Database[] = [];
let originalXdgCacheHome: string | undefined;

function makeTempDir(prefix = "mc-v22-doctor-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    dbs.push(db);
    return db;
}

function insertMemory(database: Database, projectPath: string, normalizedHash: string): number {
    const result = database
        .prepare(
            `INSERT INTO memories
                (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES (?, 'CONSTRAINTS', ?, ?, 1, 1, 1, 1)`,
        )
        .run(projectPath, `content-${normalizedHash}`, normalizedHash) as {
        lastInsertRowid: number;
    };
    return Number(result.lastInsertRowid);
}

function metaValue(database: Database, key: string): string | null {
    const row = database
        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
        .get(key) as { value: string } | undefined;
    return row?.value ?? null;
}

function makeHarness(database: Database, messages: string[]) {
    return {
        name: "test",
        openDatabase: () => database,
        closeDatabase: () => {},
        log: {
            info: (message: string) => messages.push(`info:${message}`),
            success: (message: string) => messages.push(`success:${message}`),
            warn: (message: string) => messages.push(`warn:${message}`),
            error: (message: string) => messages.push(`error:${message}`),
        },
    };
}

afterEach(() => {
    if (originalXdgCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
    } else {
        process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    }
    originalXdgCacheHome = undefined;
    for (const db of dbs.splice(0)) {
        db.close();
    }
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function createCachedOpenCodePlugin(
    root: string,
    version: string,
    entry = OPENCODE_PLUGIN_ENTRY_WITH_VERSION,
): string {
    const pluginCachePath = join(root, "opencode", "packages", entry);
    const installedPackagePath = join(
        pluginCachePath,
        "node_modules",
        "@cortexkit",
        "opencode-magic-context",
        "package.json",
    );
    mkdirSync(dirname(installedPackagePath), { recursive: true });
    writeFileSync(installedPackagePath, `${JSON.stringify({ version })}\n`);
    return pluginCachePath;
}

describe("doctor OpenCode plugin cache", () => {
    it("clears stale @latest cache when cached plugin is older than npm latest", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.26.0");

        const result = await clearPluginCache({ latestVersion: "0.29.1" });

        expect(result).toMatchObject({
            action: "cleared",
            cached: "0.26.0",
            latest: "0.29.1",
            path: pluginCachePath,
        });
        expect(existsSync(pluginCachePath)).toBe(false);
    });

    it("keeps @latest cache when cached plugin matches npm latest", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.29.1");

        const result = await clearPluginCache({ latestVersion: "0.29.1" });

        expect(result).toMatchObject({
            action: "up_to_date",
            cached: "0.29.1",
            latest: "0.29.1",
            path: pluginCachePath,
        });
        expect(existsSync(pluginCachePath)).toBe(true);
    });

    it("clears stale versionless cache even when @latest cache is current", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const latestCachePath = createCachedOpenCodePlugin(cacheRoot, "0.29.1");
        const versionlessCachePath = createCachedOpenCodePlugin(
            cacheRoot,
            "0.26.0",
            OPENCODE_PLUGIN_NAME,
        );

        const result = await clearPluginCache({ latestVersion: "0.29.1" });

        expect(result).toMatchObject({
            action: "cleared",
            cached: "0.26.0",
            latest: "0.29.1",
            path: versionlessCachePath,
            paths: [versionlessCachePath],
        });
        expect(existsSync(latestCachePath)).toBe(true);
        expect(existsSync(versionlessCachePath)).toBe(false);
    });

    it("preserves existing cache when plugin npm latest is unavailable", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.29.1");

        const result = await clearPluginCache({ latestVersion: null });

        expect(result).toMatchObject({
            action: "check_unavailable",
            cached: "0.29.1",
            path: pluginCachePath,
            paths: [pluginCachePath],
        });
        expect(result.latest).toBeUndefined();
        expect(existsSync(pluginCachePath)).toBe(true);
    });

    it("force-clears existing cache even when plugin npm latest is unavailable", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.29.1");

        const result = await clearPluginCache({ force: true, latestVersion: null });

        expect(result).toMatchObject({
            action: "cleared",
            cached: "0.29.1",
            path: pluginCachePath,
            paths: [pluginCachePath],
        });
        expect(result.latest).toBeUndefined();
        expect(existsSync(pluginCachePath)).toBe(false);
    });
});

describe("doctor v22 backfill commands", () => {
    it("--check-v22-backfill reports status", async () => {
        const database = makeDb();
        const messages: string[] = [];

        const result = await runV22BackfillCommands(makeHarness(database, messages), {
            checkV22Backfill: true,
        });

        expect(result).toEqual({ handled: true, exitCode: 0 });
        expect(messages.join("\n")).toContain("v22 backfill status: pending");
    });

    it("--retry-v22-backfill with no failures is a no-op and marks completed", async () => {
        const database = makeDb();
        const messages: string[] = [];

        const result = await runV22BackfillCommands(makeHarness(database, messages), {
            retryV22Backfill: true,
        });

        expect(result.exitCode).toBe(0);
        expect(messages.join("\n")).toContain("No v22 backfill failures to retry.");
        expect(metaValue(database, "v22_legacy_memory_backfill")).toBe("completed");
    });

    it("--retry-v22-backfill clears successful retries and sets status completed", async () => {
        const database = makeDb();
        const dir = makeTempDir();
        const rowId = insertMemory(database, dir, "retry");
        database
            .prepare(
                `INSERT INTO v22_backfill_failures
                    (table_name, row_id, raw_project_path, error_class, error_message, failed_at)
                 VALUES ('memories', ?, ?, 'permission_denied', 'permission denied', 1)`,
            )
            .run(rowId, dir);
        database
            .prepare(
                "UPDATE schema_migrations_meta SET value = 'completed_with_failures' WHERE key = 'v22_legacy_memory_backfill'",
            )
            .run();
        const messages: string[] = [];

        const result = await runV22BackfillCommands(makeHarness(database, messages), {
            retryV22Backfill: true,
        });

        expect(result.exitCode).toBe(0);
        const failures = database
            .prepare("SELECT COUNT(*) AS count FROM v22_backfill_failures")
            .get() as { count: number };
        expect(failures.count).toBe(0);
        expect(metaValue(database, "v22_legacy_memory_backfill")).toBe("completed");
        const memory = database
            .prepare("SELECT project_path FROM memories WHERE id = ?")
            .get(rowId) as {
            project_path: string;
        };
        expect(memory.project_path).toMatch(/^dir:[0-9a-f]{12}$/);
    });

    it("--rekey-v22-dir-identity rekeys matching legacy dir rows", async () => {
        const database = makeDb();
        const dir = makeTempDir();
        const oldIdentity = computeLegacyRustDirIdentity(dir);
        const rowId = insertMemory(database, oldIdentity, "rekey");
        const messages: string[] = [];

        const result = await runV22BackfillCommands(makeHarness(database, messages), {
            rekeyV22DirIdentity: dir,
        });

        expect(result.exitCode).toBe(0);
        const memory = database
            .prepare("SELECT project_path FROM memories WHERE id = ?")
            .get(rowId) as {
            project_path: string;
        };
        expect(memory.project_path).toMatch(/^dir:[0-9a-f]{12}$/);
        expect(memory.project_path).not.toBe(oldIdentity);
        expect(messages.join("\n")).toContain("Re-keyed 1 row(s)");
    });
});
