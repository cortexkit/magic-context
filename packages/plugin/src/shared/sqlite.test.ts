import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    Database,
    detectSqliteRuntime,
    getSqliteMemoryStats,
    loadSqliteModule,
    openImmutableDatabase,
    SqliteRuntimeUnavailableError,
} from "./sqlite";
import { createTestTempDir } from "./test-temp-dir";

describe("SQLite runtime selector", () => {
    it("imports the shared SQLite module in Bun without node:sqlite available", () => {
        const sqliteUrl = new URL("./sqlite.ts", import.meta.url).href;
        const script = `
            const getBuiltinModule = process.getBuiltinModule;
            process.getBuiltinModule = function (specifier) {
                if (specifier === "node:sqlite") throw new Error("node:sqlite deliberately unavailable");
                return getBuiltinModule.call(process, specifier);
            };
            await import(${JSON.stringify(sqliteUrl)});
            console.log("shared SQLite import succeeded");
        `;
        const child = spawnSync(process.execPath, ["-e", script], {
            encoding: "utf8",
            windowsHide: true,
        });

        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        expect(child.stdout).toContain("shared SQLite import succeeded");
    });

    it("suppresses only the node:sqlite experimental warning in a real Node process", () => {
        // Node 24.21 no longer emits this warning, so inject it during loading
        // to keep the suppression assertion load-bearing on newer runtimes.
        const selectorUrl = new URL("./sqlite.ts", import.meta.url).href;
        const script = `
            import { loadSqliteModule } from ${JSON.stringify(selectorUrl)};
            const originalEmitWarning = process.emitWarning;
            let listenerSawX = false;
            process.on("warning", (warning) => {
                if (warning.message === "x") listenerSawX = true;
            });
            await loadSqliteModule("Node.js", async (specifier) => {
                if (specifier !== "node:sqlite") throw new Error("unexpected backend: " + specifier);
                process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
                process.emitWarning("x", "ExperimentalWarning");
                return {};
            });
            if (process.emitWarning !== originalEmitWarning) throw new Error("emitWarning was not restored");
            process.emitWarning("after", "ExperimentalWarning");
            await new Promise((resolve) => setImmediate(resolve));
            if (!listenerSawX) throw new Error("the original warning listener was not called");
        `;
        const child = spawnSync("node", ["--trace-warnings", "--input-type=module", "-e", script], {
            encoding: "utf8",
            windowsHide: true,
        });

        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        expect(child.stderr).not.toContain("SQLite is an experimental feature");
        expect(child.stderr).toContain("ExperimentalWarning: x");
        expect(child.stderr).toContain("ExperimentalWarning: after");
        expect(child.stderr).toMatch(/ExperimentalWarning: x[\s\S]*?\n\s+at /);
    });

    it("leaves Bun and OpenCode warning emission untouched", async () => {
        expect(detectSqliteRuntime()).toBe("Bun");
        const originalEmitWarning = process.emitWarning;
        let requestedSpecifier = "";

        await loadSqliteModule("Bun", async (specifier) => {
            requestedSpecifier = specifier;
            expect(process.emitWarning).toBe(originalEmitWarning);
            return {};
        });

        expect(requestedSpecifier).toBe("bun:sqlite");
        expect(process.emitWarning).toBe(originalEmitWarning);
    });

    it("reports live connection PRAGMAs and removes closed handles", () => {
        const before = getSqliteMemoryStats().connectionCount;
        const db = new Database(":memory:");
        try {
            db.exec("PRAGMA cache_size=-1024");
            db.exec("CREATE VIRTUAL TABLE probe_fts USING fts5(content)");
            const during = getSqliteMemoryStats();
            expect(during.connectionCount).toBe(before + 1);
            expect(during.connections.at(-1)).toMatchObject({
                filename: ":memory:",
                cacheSize: -1024,
                cacheSizeUnit: "kib",
                cacheUpperBoundBytes: 1024 * 1024,
                fts5TableCount: 1,
            });
        } finally {
            db.close();
        }
        expect(getSqliteMemoryStats().connectionCount).toBe(before);
    });

    it("reads a checkpointed WAL database without creating sidecars or changing bytes", () => {
        const { dir: directory, cleanup } = createTestTempDir(
            "mc-plugin-test-xdg-pid-",
            "immutable-sqlite-",
        );
        const path = join(directory, "context.db");
        try {
            const source = join(directory, "writer.db");
            const writer = new Database(source);
            try {
                expect(writer.prepare("PRAGMA journal_mode=WAL").get()).toEqual({
                    journal_mode: "wal",
                });
                writer.exec("CREATE TABLE sample (value INTEGER); INSERT INTO sample VALUES (42)");
                expect(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual({
                    busy: 0,
                    log: 0,
                    checkpointed: 0,
                });
            } finally {
                writer.close();
            }
            // Apple's SQLite may keep the sidecars after close. Copy only the
            // fully checkpointed main file, which is still in WAL mode.
            copyFileSync(source, path);
            expect(existsSync(`${path}-wal`)).toBe(false);
            expect(existsSync(`${path}-shm`)).toBe(false);

            const before = createHash("sha256").update(readFileSync(path)).digest("hex");
            const reader = openImmutableDatabase(path);
            try {
                expect(reader.prepare("SELECT value FROM sample").get()).toEqual({ value: 42 });
            } finally {
                reader.close();
            }
            expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(before);
            expect(existsSync(`${path}-wal`)).toBe(false);
            expect(existsSync(`${path}-shm`)).toBe(false);
        } finally {
            cleanup();
        }
    });

    it("wraps a missing node:sqlite module with the detected runtime and cause", async () => {
        const cause = Object.assign(new Error("No such built-in module: node:sqlite"), {
            code: "ERR_UNKNOWN_BUILTIN_MODULE",
            name: "ResolveMessage",
        });
        let requestedSpecifier = "";
        let thrown: unknown;

        try {
            await loadSqliteModule("Node.js", async (specifier) => {
                requestedSpecifier = specifier;
                throw cause;
            });
        } catch (error) {
            thrown = error;
        }

        expect(requestedSpecifier).toBe("node:sqlite");
        expect(thrown).toBeInstanceOf(SqliteRuntimeUnavailableError);
        const compatibilityError = thrown as SqliteRuntimeUnavailableError;
        expect(compatibilityError.runtime).toBe("Node.js");
        expect(compatibilityError.specifier).toBe("node:sqlite");
        expect(compatibilityError.message).toContain("Node.js >= 24");
        expect(compatibilityError.message).toContain("Bun with bun:sqlite");
        expect(compatibilityError.message).toContain("node:sqlite");
        expect(compatibilityError.cause).toBe(cause);
    });
});
