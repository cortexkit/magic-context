import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { insertMemory } from "./memory/storage-memory";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

function fixture(mode: "WAL" | "DELETE") {
    const root = join(tmpdir(), "magic-context", "two-pass-s02-review");
    mkdirSync(root, { recursive: true });
    const home = createTestTempDirFromPath(join(root, "migration-"));
    const path = join(home, "context.db");
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    for (let i = 0; i < 256; i++) {
        insertMemory(db, {
            projectPath: "git:s02-review",
            category: i % 2 === 0 ? "PROJECT_RULES" : "ARCHITECTURE",
            content: `Populated legacy row ${i}: never remove a production backup without approval.`,
        });
    }
    db.exec(`UPDATE memories SET importance=40,classified_at=7;
        UPDATE memories SET status='archived' WHERE id%7=0;
        ALTER TABLE memories DROP COLUMN safety_critical;
        DELETE FROM schema_migrations WHERE version=104;`);
    db.exec(`PRAGMA journal_mode=${mode}`);
    const rows = db.prepare("SELECT * FROM memories ORDER BY id").all();
    db.close();
    return { home, path, rows };
}

for (const mode of ["WAL", "DELETE"] as const) {
    test(`s02 review: populated 103 survives SIGKILL after migration 104 DDL (${mode})`, async () => {
        const f = fixture(mode);
        try {
            const child = Bun.spawn(
                [
                    process.execPath,
                    "-e",
                    `import { Database } from ${JSON.stringify(new URL("../../shared/sqlite.ts", import.meta.url).href)};
                import { MIGRATIONS, runMigrations } from ${JSON.stringify(new URL("./migrations.ts", import.meta.url).href)};
                import { writeSync } from 'node:fs';
                const db = new Database(${JSON.stringify(f.path)});
                const step = MIGRATIONS.find(m => m.version === 104);
                const original = step.up;
                step.up = db => {
                    original(db);
                    const col = db.prepare('PRAGMA table_info(memories)').all().find(c => c.name === 'safety_critical');
                    if (!col) throw new Error('DDL was not reached');
                    writeSync(1, 'migration 104 DDL reached before version insert/COMMIT\\n');
                    process.kill(process.pid, 'SIGKILL');
                };
                runMigrations(db);`,
                ],
                { stdout: "pipe", stderr: "pipe", windowsHide: true },
            );
            const exit = await child.exited;
            const output = await new Response(child.stdout).text();
            expect(exit).not.toBe(0);
            expect(output).toContain("migration 104 DDL reached before version insert/COMMIT");
            const db = new Database(f.path);
            try {
                expect(db.prepare("SELECT MAX(version) v FROM schema_migrations").get()).toEqual({
                    v: 103,
                });
                expect(
                    db
                        .prepare("PRAGMA table_info(memories)")
                        .all()
                        .some((c) => c.name === "safety_critical"),
                ).toBe(false);
                expect(db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(f.rows);
                runMigrations(db);
                expect(db.prepare("SELECT MAX(version) v FROM schema_migrations").get()).toEqual({
                    v: 104,
                });
                expect(db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(
                    f.rows.map((row) => ({ ...row, safety_critical: null })),
                );
                expect(db.prepare("PRAGMA integrity_check").get()).toEqual({
                    integrity_check: "ok",
                });
                console.log(
                    `s02 migration ${mode}: 256 rows preserved, killed inside real migration transaction, replay committed v104`,
                );
            } finally {
                db.close();
            }
        } finally {
            cleanupTestTempDir(f.home);
        }
    }, 30_000);
}
