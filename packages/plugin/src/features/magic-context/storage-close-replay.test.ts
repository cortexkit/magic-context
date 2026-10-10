import { Database as BunDatabase } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { closeDatabase, openDatabase } from "./storage-db";
import { ensureSessionMetaRow } from "./storage-meta-shared";

const roots: string[] = [];
function fixturePath(): string {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-close-replay-"));
    roots.push(root);
    return join(realpathSync(root), "context.db");
}

function openFiles(path: string): string[] {
    const inventory = spawnSync("lsof", ["-p", String(process.pid), "-Fn"], {
        encoding: "utf8",
        windowsHide: true,
    });
    expect(inventory.status).toBe(0);
    return inventory.stdout.split("\n").filter((line) => line.startsWith(`n${path}`));
}

afterEach(() => {
    closeDatabase();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")(
    "cached metadata probe releases WAL on native Bun close",
    () => {
        const path = fixturePath();
        const db = new BunDatabase(path);
        db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE session_meta(session_id TEXT PRIMARY KEY);
        INSERT INTO session_meta VALUES ('existing')`);
        // A direct Bun caller is supported too, not only the shared Database wrapper.
        ensureSessionMetaRow(db as never, "existing");
        expect(existsSync(`${path}-wal`)).toBe(true);
        expect(openFiles(path).length).toBeGreaterThan(0);
        db.close();
        // Keep the JS handle alive: successful cleanup must not depend on GC.
        expect(() => db.query("SELECT 1")).toThrow();
        expect(openFiles(path)).toEqual([]);
    },
);

test.skipIf(process.platform === "win32")(
    "context close checkpoints boot probes before replay bytes are restored",
    () => {
        const path = fixturePath();
        const db = openDatabase(path);
        expect(db).not.toBeNull();
        expect(existsSync(`${path}-wal`)).toBe(true);
        expect(openFiles(path).length).toBeGreaterThan(0);
        closeDatabase();
        // WAL files may persist after a genuine close on macOS. Descriptor release,
        // not sidecar existence or the tracked JS connection count, is the invariant.
        expect(openFiles(path)).toEqual([]);

        const saved = readFileSync(path);
        const next = openDatabase(path);
        expect(next).not.toBeNull();
        next!.exec(
            "CREATE TABLE replay_marker(value TEXT); INSERT INTO replay_marker VALUES ('later')",
        );
        closeDatabase();
        expect(openFiles(path)).toEqual([]);
        for (const suffix of ["-wal", "-shm"]) {
            if (existsSync(path + suffix)) unlinkSync(path + suffix);
        }
        writeFileSync(path, saved);
        const replay = new BunDatabase(path);
        try {
            expect(replay.query("PRAGMA integrity_check").all()).toEqual([
                { integrity_check: "ok" },
            ]);
            expect(
                replay.query("SELECT name FROM sqlite_master WHERE name = 'replay_marker'").all(),
            ).toEqual([]);
        } finally {
            replay.close();
        }
    },
);

test.skipIf(process.platform === "win32")(
    "shared connection close releases WAL after the collector drops one-shot statements",
    async () => {
        const path = fixturePath();
        const db = new Database(path);
        db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(a)");
        const statements: WeakRef<object>[] = [];
        for (let index = 0; index < 50; index++) {
            const statement = db.prepare(`SELECT ${index}`);
            statement.all();
            statements.push(new WeakRef(statement));
        }
        // Let the collector mark the one-shot statements dead the way a busy host
        // does, by allocating, never by a synchronous Bun.gc(true) that would also
        // sweep (and so finalize) them. A dead statement's weak reference is
        // cleared before its sweep finalizes it, so the shared Database wrapper's
        // close cannot reach it to finalize it.
        const deadline = Date.now() + 30_000;
        while (statements.every((ref) => ref.deref() !== undefined) && Date.now() < deadline) {
            let garbage: object[] = [];
            for (let index = 0; index < 200_000; index++) garbage.push({ index });
            garbage = [];
            await Bun.sleep(1);
        }
        expect(statements.some((ref) => ref.deref() === undefined)).toBe(true);
        expect(openFiles(path).length).toBeGreaterThan(0);
        db.close();
        expect(openFiles(path)).toEqual([]);
    },
    60_000,
);
