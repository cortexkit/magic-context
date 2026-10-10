import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { REMOVED_AGENT_CONFIG_WARNING } from "@magic-context/core/config/removed-agent-config";
import {
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { computeLegacyRustDirIdentity } from "@magic-context/core/features/magic-context/v22-deferred-backfill";
import { resolveOpenCodeDbPath } from "@magic-context/core/shared/opencode-db-path";
import { Database } from "@magic-context/core/shared/sqlite";
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { openExistingContextDatabase } from "../lib/database-access";
import {
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION,
    OPENCODE_PLUGIN_NAME,
} from "../lib/opencode-plugin-cache";
import { inspectPinnedOpenCodePluginSchemaFences } from "../lib/opencode-plugin-schema-fence";
import { runV22BackfillCommands } from "../lib/v22-backfill-commands";
import {
    checkConfiguredVariantCatalog,
    checkUserMemoriesDreamerCompatibility,
    collectNpmReleaseAgeWarnings,
    compareVersions,
    describeAutoUpdateStall,
    describeOpenCode2SessionAPIRequirement,
    describeOpenCodeDatabaseDoctorCheck,
    findUndeclaredConfiguredVariants,
    formatSharedDbRowCounts,
    getUserNpmrcPath,
    isPinnedOpenCodePluginSpecifier,
    migrateLegacyAgentEnabledConfigForDoctor,
    parseOpenCodeModelCatalog,
    resolveNpmRegistryUrl,
} from "./doctor-opencode";
import { clearPluginCache, readOpenCodePluginConfigUse } from "./doctor-opencode-cache";

function migrate(input: Record<string, unknown>) {
    const logs: Array<{ level: "success" | "warn"; message: string }> = [];
    const result = migrateLegacyAgentEnabledConfigForDoctor(input, {
        success: (message) => logs.push({ level: "success", message }),
        warn: (message) => logs.push({ level: "warn", message }),
    });
    return { config: input, logs, result };
}

describe("OpenCode model catalog parsing", () => {
    it("reports configured variants absent from the matching catalog model", () => {
        const catalog = [{ providerID: "provider", id: "model", variants: { high: {} } }];
        expect(
            findUndeclaredConfiguredVariants(
                [
                    { agent: "historian", model: "provider/model", variant: "medium" },
                    { agent: "dreamer", model: "provider/model", variant: "high" },
                ],
                catalog,
            ),
        ).toEqual([{ agent: "historian", model: "provider/model", variant: "medium" }]);
    });
    it("checks real v2 model.list variant IDs for both missing and declared variants", () => {
        // Captured from OpenCode 2.0.12 in an isolated root with a dummy API key.
        const output = readFileSync(
            join(import.meta.dir, "fixtures/opencode-2.0.12-model-list.json"),
            "utf8",
        );
        const warnings: string[] = [];
        const args: string[][] = [];
        checkConfiguredVariantCatalog(
            {
                historian: { opencode: { model: "anthropic/claude-opus-5-5", variant: "ultra" } },
                dreamer: { opencode: { model: "anthropic/claude-opus-5-5", variant: "high" } },
            },
            "v2",
            (message) => warnings.push(message),
            (command) => {
                args.push(command);
                return { stdout: output, status: 0 };
            },
            "/tmp/project",
        );
        expect(args).toEqual([["api", "model.list", "--param", "directory=/tmp/project"]]);
        expect(warnings).toEqual([
            "historian model anthropic/claude-opus-5-5 requests variant 'ultra', which this host does not offer. Remove the variant or choose one listed by opencode api model.list --param directory=/tmp/project.",
        ]);
    });
    it("names the background service startup command when v2 cannot read a catalog", () => {
        const warnings: string[] = [];
        checkConfiguredVariantCatalog(
            { dreamer: { opencode: { model: "provider/model", variant: "high" } } },
            "v2",
            (message) => warnings.push(message),
            () => ({ stdout: "", status: 1 }),
            "/tmp/project",
        );
        expect(warnings).toEqual([
            "Could not verify configured hidden-agent models and variants: this OpenCode host did not provide a readable model catalog. Start the background service with opencode service start, then check opencode api model.list --param directory=/tmp/project.",
        ]);
    });
    it("warns when a historian, dreamer or fallback model is not in the v2 host catalog", () => {
        // Captured from OpenCode 2.0.12 in an isolated root with a dummy API key;
        // only the anthropic provider is configured there.
        const output = readFileSync(
            join(import.meta.dir, "fixtures/opencode-2.0.12-model-list.json"),
            "utf8",
        );
        const warnings: string[] = [];
        checkConfiguredVariantCatalog(
            {
                // No variant anywhere: the model check must not depend on one.
                historian: { model: "opencode-go/muse-spark-1.3-contributor" },
                dreamer: {
                    opencode: {
                        model: "anthropic/claude-opus-5-5",
                        fallback_models: ["anthropic/not-a-model"],
                    },
                },
            },
            "v2",
            (message) => warnings.push(message),
            () => ({ stdout: output, status: 0 }),
            "/tmp/project",
        );
        expect(warnings).toEqual([
            "historian model opencode-go/muse-spark-1.3-contributor names provider 'opencode-go', which this OpenCode host does not have. The historian cannot run on it; configure that provider in OpenCode or choose a model listed by opencode api model.list --param directory=/tmp/project.",
            "dreamer fallback model anthropic/not-a-model is not offered by provider 'anthropic' on this OpenCode host. The dreamer cannot run on it; choose a model listed by opencode api model.list --param directory=/tmp/project.",
        ]);
    });
    it("reports unknown models from the v1 verbose catalog too", () => {
        const warnings: string[] = [];
        checkConfiguredVariantCatalog(
            { historian: { opencode: { model: "missing/model" } } },
            "v1",
            (message) => warnings.push(message),
            () => ({
                stdout: 'provider/model\n{\n  "id": "model",\n  "providerID": "provider",\n  "variants": {}\n}',
                status: 0,
            }),
        );
        expect(warnings).toEqual([
            "historian model missing/model names provider 'missing', which this OpenCode host does not have. The historian cannot run on it; configure that provider in OpenCode or choose a model listed by opencode models --verbose.",
        ]);
    });
    it("flags the unsupported DeepSeek dreamer name when absent from the host catalog", () => {
        const config = {
            historian: { opencode: { model: "deepseek/deepseek-flash" } },
            dreamer: { opencode: { model: "deepseek/deepseek-v4-flash" } },
        };
        const catalog = (ids: string[]) =>
            ids
                .map(
                    (id) =>
                        `deepseek/${id}\n${JSON.stringify({ id, providerID: "deepseek", variants: {} }, null, 2)}`,
                )
                .join("\n");
        const warnings: string[] = [];
        checkConfiguredVariantCatalog(
            config,
            "v1",
            (message) => warnings.push(message),
            () => ({
                stdout: catalog(["deepseek-flash", "deepseek-v4-pro"]),
                status: 0,
            }),
        );
        expect(warnings).toEqual([
            "dreamer model deepseek/deepseek-v4-flash is not offered by provider 'deepseek' on this OpenCode host. The dreamer cannot run on it; choose a model listed by opencode models --verbose.",
        ]);
        warnings.length = 0;
        checkConfiguredVariantCatalog(
            config,
            "v1",
            (message) => warnings.push(message),
            () => ({
                stdout: catalog(["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash"]),
                status: 0,
            }),
        );
        // Catalog validation cannot detect a provider rejection of an advertised ID.
        expect(warnings).toEqual([]);
    });

    it("retains the v1 verbose catalog check", () => {
        const args: string[][] = [];
        checkConfiguredVariantCatalog(
            { historian: { opencode: { model: "provider/model", variant: "high" } } },
            "v1",
            () => {},
            (command) => {
                args.push(command);
                return {
                    stdout: 'provider/model\n{\n  "id": "model",\n  "providerID": "provider",\n  "variants": { "high": {} }\n}',
                    status: 0,
                };
            },
        );
        expect(args).toEqual([["models", "--verbose"]]);
    });
    it("reads model variants from verbose CLI output", () => {
        expect(
            parseOpenCodeModelCatalog(
                `provider/model\n{\n  "id": "model",\n  "providerID": "provider",\n  "variants": {\n    "medium": {}\n  }\n}`,
            ),
        ).toEqual([{ providerID: "provider", id: "model", variants: { medium: {} } }]);
    });
});

describe("doctor shared DB row counts", () => {
    it("counts rows still in the write-ahead log through the read-only open", () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "mc-doctor-wal-"));
        const path = join(dir, "context.db");
        const writer = new Database(path);
        try {
            initializeDatabase(writer);
            runMigrations(writer);
            // Keep every new row in the WAL, as a running plugin does between
            // checkpoints.
            writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
            for (let index = 0; index < 5; index++) {
                writer
                    .prepare(
                        `INSERT INTO memories
                            (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
                         VALUES ('dir:6fb76e42d6dd', 'CONSTRAINTS', ?, ?, 1, 1, 1, 1)`,
                    )
                    .run(`content-${index}`, `hash-${index}`);
            }
            expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
            const reader = openExistingContextDatabase(path, { readonly: true });
            if (!reader) throw new Error("context DB vanished");
            try {
                expect(formatSharedDbRowCounts(reader)).toContain("memories=5");
            } finally {
                reader.close();
            }
        } finally {
            writer.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("reports an unreadable count as n/a with its reason instead of 0", () => {
        const db = {
            prepare(sql: string) {
                return {
                    get() {
                        if (sql.includes("memories")) throw new Error("database is locked");
                        return { c: 3 };
                    },
                };
            },
        };
        expect(formatSharedDbRowCounts(db)).toBe(
            "tags=3, compartments=3, memories=n/a (database is locked), notes=3, dream_runs=3",
        );
    });
});

describe("OpenCode database doctor surface", () => {
    it("reports the resolved path on success and the explicit candidate on failure", () => {
        const resolution = {
            path: "/tmp/custom-opencode.db",
            source: "OPENCODE_DB" as const,
            channel: null,
        };
        expect(describeOpenCodeDatabaseDoctorCheck(resolution, true)).toEqual({
            ok: true,
            message: "OpenCode session database: /tmp/custom-opencode.db (source=OPENCODE_DB)",
        });
        expect(describeOpenCodeDatabaseDoctorCheck(resolution, false)).toEqual({
            ok: false,
            message:
                "FAIL OpenCode session database: not found (looked for /tmp/custom-opencode.db); set OPENCODE_DB if OpenCode stores it elsewhere.",
        });
    });
});

describe("doctor OpenCode 2 database path", () => {
    it("uses an absolute OPENCODE_DB as is, like OpenCode 2 does", () => {
        const dataHome = createTestTempDirFromPath(join(tmpdir(), "mc-doctor-db-"));
        try {
            const absolute = join(dataHome, "elsewhere", "opencode.db");
            const resolution = resolveOpenCodeDbPath("v2", {
                dataHome,
                env: { OPENCODE_DB: absolute },
            });
            expect(resolution.path).toBe(absolute);
            expect(
                resolveOpenCodeDbPath("v2", { dataHome, env: { OPENCODE_DB: "custom.db" } }).path,
            ).toBe(join(dataHome, "opencode", "custom.db"));
        } finally {
            rmSync(dataHome, { recursive: true, force: true });
        }
    });
});

describe("doctor npm registry", () => {
    it("asks the registry OpenCode installs from", () => {
        expect(resolveNpmRegistryUrl({})).toBe("https://registry.npmjs.org");
        expect(resolveNpmRegistryUrl({ npm_config_registry: "http://127.0.0.1:4873/" })).toBe(
            "http://127.0.0.1:4873",
        );
        expect(resolveNpmRegistryUrl({ NPM_CONFIG_REGISTRY: "https://mirror.example" })).toBe(
            "https://mirror.example",
        );
    });
});

describe("doctor OpenCode legacy agent enabled migration", () => {
    it("migrates legacy enabled fields and deletes removed agent config", () => {
        const removedKey = ["side", "kick"].join("");
        const { config, logs, result } = migrate({
            dreamer: { enabled: false, disable: false },
            [removedKey]: { enabled: true, disable: true },
            historian: { enabled: true, disable: true },
        });

        expect(result).toEqual({ changed: true, fixes: 3 });
        expect(config).toEqual({
            dreamer: { disable: true },
            historian: { disable: true },
        });
        expect(logs).toContainEqual({
            level: "warn",
            message:
                "Migrated dreamer.enabled=false → dreamer.disable=true. This now also disables manual /ctx-dream. To keep manual dreaming, remove disable=true and set schedule to empty string.",
        });
        expect(logs.map((entry) => entry.message)).toContain(REMOVED_AGENT_CONFIG_WARNING);
        expect(logs.map((entry) => entry.message)).toContain(
            "Removed invalid historian.enabled (historian uses disable=true to turn off).",
        );
    });

    it("removes enabled=true without adding disable=false and is idempotent", () => {
        const first = migrate({ dreamer: { enabled: true } });
        expect(first.config).toEqual({ dreamer: {} });

        const second = migrate(first.config);
        expect(second.result).toEqual({ changed: false, fixes: 0 });
        expect(second.logs).toEqual([]);
    });

    it("round-trips migrated config through JSONC serialization", () => {
        const config = parseJsonc('{ "dreamer": { "enabled": false } }') as Record<string, unknown>;
        migrateLegacyAgentEnabledConfigForDoctor(config, { success: () => {}, warn: () => {} });
        const serialized = stringifyJsonc(config, null, 2);

        expect(serialized).toContain('"disable": true');
        expect(serialized).not.toContain('"enabled"');
    });
});

describe("checkUserMemoriesDreamerCompatibility", () => {
    const WARNING =
        'dreamer.tasks["review-user-memories"] is scheduled but dreamer.disable=true, so new promotions will not run. Remove dreamer.disable or set dreamer.tasks["review-user-memories"].schedule="" to disable the task.';

    it("warns when review-user-memories is scheduled and dreamer.disable=true", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: {
                disable: true,
                tasks: { "review-user-memories": { schedule: "0 2 * * *" } },
            },
        });
        expect(result).toBe(WARNING);
    });

    it("returns null when dreamer is not disabled", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: {
                disable: false,
                tasks: { "review-user-memories": { schedule: "0 2 * * *" } },
            },
        });
        expect(result).toBeNull();
    });

    it("returns null when review-user-memories schedule is empty", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: {
                disable: true,
                tasks: { "review-user-memories": { schedule: "" } },
            },
        });
        expect(result).toBeNull();
    });

    it("returns null when review-user-memories schedule is whitespace-only", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: {
                disable: true,
                tasks: { "review-user-memories": { schedule: "   " } },
            },
        });
        expect(result).toBeNull();
    });

    it("returns null when review-user-memories task is absent", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: { disable: true, tasks: { verify: { schedule: "0 2 * * *" } } },
        });
        expect(result).toBeNull();
    });

    it("returns null when dreamer block is absent", () => {
        expect(checkUserMemoriesDreamerCompatibility({})).toBeNull();
    });

    it("returns null when tasks block is absent (legacy v1 shape without user_memories)", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: { disable: true },
        });
        expect(result).toBeNull();
    });

    it("does not read legacy dreamer.user_memories (v1 key, migrated away in v2)", () => {
        const result = checkUserMemoriesDreamerCompatibility({
            dreamer: {
                disable: true,
                user_memories: { enabled: true },
            },
        });
        expect(result).toBeNull();
    });
});

const tempDirs: string[] = [];
const dbs: Database[] = [];
let originalXdgCacheHome: string | undefined;
let originalHome: string | undefined;
let originalNpmUserConfig: string | undefined;
let originalOpenCodeConfigDir: string | undefined;

function makeTempDir(prefix = "mc-v22-doctor-"): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
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
    if (originalHome === undefined) {
        delete process.env.HOME;
    } else {
        process.env.HOME = originalHome;
    }
    if (originalNpmUserConfig === undefined) {
        delete process.env.NPM_CONFIG_USERCONFIG;
    } else {
        process.env.NPM_CONFIG_USERCONFIG = originalNpmUserConfig;
    }
    if (originalOpenCodeConfigDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR;
    } else {
        process.env.OPENCODE_CONFIG_DIR = originalOpenCodeConfigDir;
    }
    originalXdgCacheHome = undefined;
    originalHome = undefined;
    originalNpmUserConfig = undefined;
    originalOpenCodeConfigDir = undefined;
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
    writeFileSync(
        installedPackagePath,
        `${JSON.stringify({ name: OPENCODE_PLUGIN_NAME, version })}\n`,
    );
    return pluginCachePath;
}

/** Probe stand-in for a machine where no OpenCode process is running. */
const noOpenCodeRunning = () => ({ status: "free" as const });

describe("doctor OpenCode plugin cache", () => {
    it("clears stale @latest cache when cached plugin is older than npm latest", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.26.0");

        const result = await clearPluginCache(
            { latestVersion: "0.29.1" },
            { probe: noOpenCodeRunning },
        );

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

        const result = await clearPluginCache(
            { latestVersion: "0.29.1" },
            { probe: noOpenCodeRunning },
        );

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

        const result = await clearPluginCache(
            { latestVersion: "0.29.1" },
            { probe: noOpenCodeRunning },
        );

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

        const result = await clearPluginCache(
            { latestVersion: null },
            { probe: noOpenCodeRunning },
        );

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

        const result = await clearPluginCache(
            { force: true, latestVersion: null },
            { probe: noOpenCodeRunning },
        );

        expect(result).toMatchObject({
            action: "cleared",
            cached: "0.29.1",
            path: pluginCachePath,
            paths: [pluginCachePath],
        });
        expect(result.latest).toBeUndefined();
        expect(existsSync(pluginCachePath)).toBe(false);
    });

    it("reports the actually-failed root and clears the rest when one root fails", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const latestCachePath = createCachedOpenCodePlugin(cacheRoot, "0.26.0");
        const versionlessCachePath = createCachedOpenCodePlugin(
            cacheRoot,
            "0.26.0",
            OPENCODE_PLUGIN_NAME,
        );

        // Fail only the second root: the first must still be removed, and the
        // error must point at the failed root, not the already-removed one.
        const removed: string[] = [];
        const result = await clearPluginCache(
            { latestVersion: "0.29.1" },
            {
                probe: noOpenCodeRunning,
                remove: (path) => {
                    if (path === versionlessCachePath) {
                        throw new Error("EACCES: permission denied");
                    }
                    rmSync(path, { recursive: true, force: true });
                    removed.push(path);
                },
            },
        );

        expect(result).toMatchObject({
            action: "error",
            path: versionlessCachePath,
            paths: [versionlessCachePath],
            clearedPaths: [latestCachePath],
            failedPaths: [versionlessCachePath],
            error: "EACCES: permission denied",
        });
        expect(removed).toEqual([latestCachePath]);
        expect(existsSync(latestCachePath)).toBe(false);
    });
});

describe("doctor OpenCode 1 plugin cache while OpenCode runs", () => {
    it("leaves an outdated cache in place while an OpenCode process holds the host database", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.26.0");
        const hostFiles = ["/host/opencode.db", "/host/opencode.db-wal"];
        const probed: Array<{ files: string[]; directories: string[] }> = [];
        const removed: string[] = [];

        const result = await clearPluginCache(
            { latestVersion: "0.29.1", hostFiles },
            {
                probe: (targets) => {
                    probed.push(targets);
                    return { status: "in_use", pids: [4242] };
                },
                remove: (path) => removed.push(path),
            },
        );

        expect(result).toMatchObject({ action: "in_use", pids: [4242], path: pluginCachePath });
        expect(probed).toEqual([{ files: hostFiles, directories: [pluginCachePath] }]);
        expect(removed).toEqual([]);
        expect(existsSync(pluginCachePath)).toBe(true);
    });

    it("leaves the cache in place when it cannot tell whether OpenCode is running", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.26.0");

        const result = await clearPluginCache(
            { force: true, latestVersion: null, hostFiles: [] },
            { probe: () => ({ status: "unknown", reason: "could not run lsof (ENOENT)" }) },
        );

        expect(result).toMatchObject({
            action: "in_use_unknown",
            reason: "could not run lsof (ENOENT)",
        });
        expect(existsSync(pluginCachePath)).toBe(true);
    });
});

describe("doctor OpenCode 1 plugin cache against the config", () => {
    /** A local Magic Context checkout and an OpenCode config dir, both in a temp tree. */
    function devCheckout(root: string): { configDir: string; fileUrl: string } {
        const checkout = join(root, "magic-context", "packages", "plugin");
        mkdirSync(checkout, { recursive: true });
        writeFileSync(
            join(checkout, "package.json"),
            `${JSON.stringify({ name: OPENCODE_PLUGIN_NAME, version: "0.47.0" })}\n`,
        );
        const configDir = join(root, "config");
        mkdirSync(configDir, { recursive: true });
        return { configDir, fileUrl: pathToFileURL(checkout).href };
    }

    it("leaves a stale cache unused, without probing, when the config loads a file:// checkout", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.31.2");
        const { configDir, fileUrl } = devCheckout(cacheRoot);
        const use = readOpenCodePluginConfigUse(
            { plugin: [fileUrl, "other-plugin@latest"] },
            configDir,
        );
        expect(use.referencedSpecs.opencode1.size).toBe(0);
        expect(use.loadedFrom).toEqual({ opencode1: fileUrl, opencode2: fileUrl });

        let probed = false;
        const result = await clearPluginCache(
            {
                force: true,
                latestVersion: "0.47.0",
                referencedSpecs: use.referencedSpecs.opencode1,
            },
            {
                probe: () => {
                    probed = true;
                    return { status: "in_use", pids: [4242] };
                },
            },
        );

        expect(result).toEqual({
            action: "unused",
            path: pluginCachePath,
            paths: [pluginCachePath],
            cached: "0.31.2",
        });
        expect(probed).toBe(false);
        expect(existsSync(pluginCachePath)).toBe(true);
    });

    it("still treats a stale cache as in use when the config loads @latest", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        const pluginCachePath = createCachedOpenCodePlugin(cacheRoot, "0.31.2");
        const use = readOpenCodePluginConfigUse(
            { plugin: [[OPENCODE_PLUGIN_ENTRY_WITH_VERSION, {}]] },
            cacheRoot,
        );

        const result = await clearPluginCache(
            { latestVersion: "0.47.0", referencedSpecs: use.referencedSpecs.opencode1 },
            { probe: () => ({ status: "in_use", pids: [4242] }) },
        );

        expect(result).toMatchObject({ action: "in_use", path: pluginCachePath, cached: "0.31.2" });
    });

    it("treats the @latest cache as unused when the entry pins a version", async () => {
        const cacheRoot = makeTempDir("mc-opencode-cache-");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cacheRoot;
        createCachedOpenCodePlugin(cacheRoot, "0.31.2");
        const use = readOpenCodePluginConfigUse(
            { plugin: [`${OPENCODE_PLUGIN_NAME}@0.45.0`] },
            cacheRoot,
        );
        expect([...use.referencedSpecs.opencode1]).toEqual(["0.45.0"]);

        const result = await clearPluginCache(
            { latestVersion: "0.47.0", referencedSpecs: use.referencedSpecs.opencode1 },
            { probe: noOpenCodeRunning },
        );
        expect(result.action).toBe("unused");
    });

    it("counts only the plugin array for OpenCode 1, and both arrays for OpenCode 2", () => {
        const use = readOpenCodePluginConfigUse(
            { plugins: [{ package: OPENCODE_PLUGIN_NAME, options: {} }] },
            tmpdir(),
        );
        expect(use.referencedSpecs.opencode1.size).toBe(0);
        expect([...use.referencedSpecs.opencode2]).toEqual(["latest"]);
    });
});

describe("doctor OpenCode pinned plugin schema fence", () => {
    function configurePinnedPlugin(
        root: string,
        specifier: string,
        surface: "server" | "tui" = "server",
    ): string {
        const configDir = join(root, "config");
        mkdirSync(configDir, { recursive: true });
        originalOpenCodeConfigDir ??= process.env.OPENCODE_CONFIG_DIR;
        process.env.OPENCODE_CONFIG_DIR = configDir;
        const configPath = join(configDir, `${surface === "server" ? "opencode" : "tui"}.json`);
        writeFileSync(configPath, `${JSON.stringify({ plugin: [specifier] })}\n`);
        return configPath;
    }

    function createCachedPluginWithFence(root: string, version: string, fence: number): void {
        const pluginCachePath = createCachedOpenCodePlugin(
            root,
            version,
            `${OPENCODE_PLUGIN_NAME}@${version}`,
        );
        const distDir = join(
            pluginCachePath,
            "node_modules",
            "@cortexkit",
            "opencode-magic-context",
            "dist",
        );
        mkdirSync(distDir, { recursive: true });
        writeFileSync(
            join(distDir, "schema-fence.js"),
            `const LATEST_SUPPORTED_VERSION = ${fence};\n`,
        );
    }

    function createNpmTarballWithFence(fence: number): Uint8Array {
        const path = "package/dist/schema-fence.js";
        const content = new TextEncoder().encode(`const LATEST_SUPPORTED_VERSION = ${fence};\n`);
        const header = new Uint8Array(512);
        header.set(new TextEncoder().encode(path), 0);
        header.set(
            new TextEncoder().encode(`${content.length.toString(8).padStart(11, "0")}\0`),
            124,
        );
        header[156] = "0".charCodeAt(0);
        header.set(new TextEncoder().encode("ustar\0"), 257);
        const paddedContentLength = Math.ceil(content.length / 512) * 512;
        const archive = new Uint8Array(512 + paddedContentLength + 1024);
        archive.set(header);
        archive.set(content, 512);
        return gzipSync(archive);
    }

    it("fails the v78 database fixture when the running server pin only supports v77", async () => {
        const root = makeTempDir("mc-pinned-fence-");
        const configPath = configurePinnedPlugin(root, `${OPENCODE_PLUGIN_NAME}@0.36.1`);
        configurePinnedPlugin(root, `${OPENCODE_PLUGIN_NAME}@0.36.1`, "tui");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = root;
        createCachedPluginWithFence(root, "0.36.1", 77);

        const findings = await inspectPinnedOpenCodePluginSchemaFences({
            directory: root,
            databaseVersion: 78,
        });

        expect(findings.map((finding) => finding.surface)).toEqual(["server", "tui"]);
        expect(findings).toContainEqual(
            expect.objectContaining({
                status: "fail",
                databaseVersion: 78,
                pinnedVersion: "0.36.1",
                supportedVersion: 77,
                configPath,
            }),
        );
    });

    it("passes a current pin whose runtime fence supports the shared database", async () => {
        const root = makeTempDir("mc-pinned-fence-");
        configurePinnedPlugin(root, `${OPENCODE_PLUGIN_NAME}@0.37.0`);
        configurePinnedPlugin(root, `${OPENCODE_PLUGIN_NAME}@0.37.0`, "tui");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = root;
        createCachedPluginWithFence(root, "0.37.0", 78);

        const findings = await inspectPinnedOpenCodePluginSchemaFences({
            directory: root,
            databaseVersion: 78,
        });

        expect(findings).toContainEqual(
            expect.objectContaining({
                status: "pass",
                databaseVersion: 78,
                pinnedVersion: "0.37.0",
                supportedVersion: 78,
            }),
        );
    });

    it("falls back to the npm tarball when the pinned package is not installed", async () => {
        const root = makeTempDir("mc-pinned-fence-");
        configurePinnedPlugin(root, `${OPENCODE_PLUGIN_NAME}@0.36.1`);
        configurePinnedPlugin(root, `${OPENCODE_PLUGIN_NAME}@0.36.1`, "tui");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = root;
        let requestCount = 0;

        const findings = await inspectPinnedOpenCodePluginSchemaFences(
            { directory: root, databaseVersion: 78 },
            {
                fetch: async () => {
                    requestCount++;
                    if (requestCount === 1) {
                        return Response.json({
                            version: "0.36.1",
                            dist: { tarball: "https://registry.npmjs.org/plugin-0.36.1.tgz" },
                        });
                    }
                    return new Response(createNpmTarballWithFence(77));
                },
            },
        );

        expect(requestCount).toBe(2);
        expect(findings).toContainEqual(
            expect.objectContaining({
                status: "fail",
                source: "npm-tarball",
                supportedVersion: 77,
            }),
        );
    });

    it("reports an unresolvable pinned fence as UNKNOWN instead of passing", async () => {
        const root = makeTempDir("mc-pinned-fence-");
        configurePinnedPlugin(root, `${OPENCODE_PLUGIN_NAME}@0.36.1`);
        configurePinnedPlugin(root, `${OPENCODE_PLUGIN_NAME}@0.36.1`, "tui");
        originalXdgCacheHome = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = root;

        const findings = await inspectPinnedOpenCodePluginSchemaFences(
            { directory: root, databaseVersion: 78 },
            { fetch: async () => new Response(null, { status: 503 }) },
        );

        expect(findings).toContainEqual(
            expect.objectContaining({
                status: "unknown",
                databaseVersion: 78,
                pinnedVersion: "0.36.1",
            }),
        );
        expect(findings).not.toContainEqual(expect.objectContaining({ status: "pass" }));
    });
});

describe("doctor OpenCode auto-update status", () => {
    const spec = `${OPENCODE_PLUGIN_NAME}@0.42.5`;

    it("attributes a matching persisted spec to the updater", () => {
        const storageDir = makeTempDir("mc-auto-update-doctor-");
        writeFileSync(
            join(storageDir, "last-update-check.json"),
            JSON.stringify({
                lastCheckedMs: Date.now(),
                updaterPinnedSpec: spec,
                updaterPinnedAt: Date.now(),
            }),
        );

        expect(describeAutoUpdateStall(spec, true, storageDir)).toBe(
            `auto-update: stalled — config pinned to ${spec} (by updater)`,
        );
    });

    it("attributes a different or absent persisted spec to the user", () => {
        const storageDir = makeTempDir("mc-auto-update-doctor-");
        writeFileSync(
            join(storageDir, "last-update-check.json"),
            JSON.stringify({
                lastCheckedMs: Date.now(),
                updaterPinnedSpec: `${OPENCODE_PLUGIN_NAME}@0.42.4`,
                updaterPinnedAt: Date.now(),
            }),
        );

        expect(describeAutoUpdateStall(spec, true, storageDir)).toBe(
            `auto-update: stalled — config pinned to ${spec} (by you)`,
        );
        expect(describeAutoUpdateStall(spec, false, storageDir)).toBeNull();
    });
});

describe("doctor OpenCode helper logic", () => {
    it("treats dist-tags like @next and @beta as pinned plugin entries", () => {
        expect(isPinnedOpenCodePluginSpecifier("@cortexkit/opencode-magic-context@next")).toBe(
            true,
        );
        expect(isPinnedOpenCodePluginSpecifier("@cortexkit/opencode-magic-context@beta")).toBe(
            true,
        );
        expect(isPinnedOpenCodePluginSpecifier("@cortexkit/opencode-magic-context@0.29.1")).toBe(
            true,
        );
        expect(isPinnedOpenCodePluginSpecifier("@cortexkit/opencode-magic-context")).toBe(false);
        expect(isPinnedOpenCodePluginSpecifier("@cortexkit/opencode-magic-context@latest")).toBe(
            false,
        );
    });

    it("honors NPM_CONFIG_USERCONFIG before HOME for npmrc release-age warnings", () => {
        const root = makeTempDir("mc-npmrc-");
        const home = join(root, "home");
        const customNpmrc = join(root, "custom.npmrc");
        originalHome = process.env.HOME;
        originalNpmUserConfig = process.env.NPM_CONFIG_USERCONFIG;
        process.env.HOME = home;
        process.env.NPM_CONFIG_USERCONFIG = customNpmrc;
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, ".npmrc"), "min-release-age=9999\n");
        writeFileSync(customNpmrc, "before=2026-01-01\n");

        expect(getUserNpmrcPath()).toBe(customNpmrc);
        expect(collectNpmReleaseAgeWarnings()).toEqual([`${customNpmrc} has 'before=2026-01-01'`]);
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

it("names the installed OpenCode host and minimum native session API version", () => {
    expect(describeOpenCode2SessionAPIRequirement("2.0.21")).toBe(
        "OpenCode host 2.0.21; Magic Context requires OpenCode 2.0.22 or newer with session.remove and session.compact.",
    );
});

describe("doctor CLI version comparison", () => {
    it("ranks a prerelease below its release and above the previous release", () => {
        expect(compareVersions("0.45.0-beta.1", "0.45.0")).toBeLessThan(0);
        expect(compareVersions("0.45.0", "0.45.0-beta.1")).toBeGreaterThan(0);
        expect(compareVersions("0.45.0-beta.1", "0.45.0-beta.3")).toBeLessThan(0);
        expect(compareVersions("0.45.0-beta.1", "0.44.4")).toBeGreaterThan(0);
    });

    it("compares releases by their numeric parts", () => {
        expect(compareVersions("0.44.4", "0.45.0")).toBeLessThan(0);
        expect(compareVersions("0.45.0", "0.45.0")).toBe(0);
        expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    });

    it("reports an unparseable version as not comparable instead of equal", () => {
        expect(compareVersions("0.0.0-dev", "0.45.0")).toBeLessThan(0);
        expect(compareVersions("not-a-version", "0.45.0")).toBeNull();
    });
});
