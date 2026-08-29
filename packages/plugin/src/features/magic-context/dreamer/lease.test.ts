/// <reference types="bun-types" />

import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import * as logger from "../../../shared/logger";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    acquireLease,
    acquireLeaseWithAcquisition,
    DREAMING_LEASE_KEY,
    getLeaseHolder,
    isLeaseActive,
    releaseLease,
    renewLease,
    runLeaseGuardedWrite,
    startLeaseHeartbeat,
} from "./lease";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function expireLease(db: Database, key = "dreaming_lease_expiry"): void {
    db.prepare(`UPDATE dream_state SET value = ? WHERE key = '${key}'`).run(String(Date.now() - 1));
}

function makeDb(path = ":memory:"): Database {
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("dreamer lease (serialized acquisition)", () => {
    it("acquires, renews for the same holder, and releases", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        expect(isLeaseActive(db)).toBe(true);
        expect(getLeaseHolder(db)).toBe("holder-a");
        expect(renewLease(db, "holder-a")).toBe(true);
        releaseLease(db, "holder-a");
        expect(isLeaseActive(db)).toBe(false);
        expect(getLeaseHolder(db)).toBeNull();
        closeQuietly(db);
    });

    it("blocks a second holder while the lease is active", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        expect(acquireLease(db, "holder-b")).toBe(false);
        expect(getLeaseHolder(db)).toBe("holder-a");
        closeQuietly(db);
    });

    it("keyed leases for different domains do NOT block each other", () => {
        const db = makeDb();
        // These three different lease keys represent independent conflict domains.
        expect(acquireLease(db, "h-mem", "memory:git:abc")).toBe(true);
        expect(acquireLease(db, "h-kf", "key-files:git:abc")).toBe(true);
        expect(acquireLease(db, "h-um", "user-memories")).toBe(true);
        // A second holder for the same key is rejected.
        expect(acquireLease(db, "h-mem2", "memory:git:abc")).toBe(false);
        // A lease for the same type in a different project is independent and can also be acquired.
        expect(acquireLease(db, "h-mem3", "memory:git:other")).toBe(true);
        expect(getLeaseHolder(db, "memory:git:abc")).toBe("h-mem");
        expect(getLeaseHolder(db, "key-files:git:abc")).toBe("h-kf");
        expect(isLeaseActive(db, "user-memories")).toBe(true);
        closeQuietly(db);
    });

    it("releasing one keyed lease leaves siblings untouched", () => {
        const db = makeDb();
        expect(acquireLease(db, "h-mem", "memory:git:abc")).toBe(true);
        expect(acquireLease(db, "h-kf", "key-files:git:abc")).toBe(true);
        releaseLease(db, "h-mem", "memory:git:abc");
        expect(isLeaseActive(db, "memory:git:abc")).toBe(false);
        expect(isLeaseActive(db, "key-files:git:abc")).toBe(true);
        expect(getLeaseHolder(db, "key-files:git:abc")).toBe("h-kf");
        closeQuietly(db);
    });

    it("legacy default key is isolated from new keyed leases", () => {
        const db = makeDb();
        expect(acquireLease(db, "legacy-holder")).toBe(true); // default = DREAMING_LEASE_KEY
        expect(isLeaseActive(db, DREAMING_LEASE_KEY)).toBe(true);
        // A keyed domain lease is unaffected by the legacy lease being held.
        expect(acquireLease(db, "h-mem", "memory:git:abc")).toBe(true);
        expect(isLeaseActive(db)).toBe(true); // legacy still held
        closeQuietly(db);
    });

    it("lets another holder reclaim an expired lease", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        // Force expiry in the past.
        db.prepare("UPDATE dream_state SET value = ? WHERE key = 'dreaming_lease_expiry'").run(
            String(Date.now() - 1),
        );
        expect(acquireLease(db, "holder-b")).toBe(true);
        expect(getLeaseHolder(db)).toBe("holder-b");
        closeQuietly(db);
    });

    it("renew fails for holder mismatch or expired lease", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        expect(renewLease(db, "holder-b")).toBe(false);
        db.prepare("UPDATE dream_state SET value = ? WHERE key = 'dreaming_lease_expiry'").run(
            String(Date.now() - 1),
        );
        expect(renewLease(db, "holder-a")).toBe(false);
        closeQuietly(db);
    });

    it("release is a no-op after another holder reclaims the lease", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        db.prepare("UPDATE dream_state SET value = ? WHERE key = 'dreaming_lease_expiry'").run(
            String(Date.now() - 1),
        );
        expect(acquireLease(db, "holder-b")).toBe(true);
        // holder-a's stale release must NOT clear holder-b's live lease.
        releaseLease(db, "holder-a");
        expect(getLeaseHolder(db)).toBe("holder-b");
        expect(isLeaseActive(db)).toBe(true);
        closeQuietly(db);
    });

    it("lease-guarded writes reject a stolen lease before committing", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a", "memory:proj")).toBe(true);
        expect(db.prepare("CREATE TABLE guarded_writes (value TEXT)").run()).toBeDefined();

        // Simulate a stale holder: holder-a's lease expires, then holder-b acquires
        // the same domain before holder-a's guarded write starts.
        expect(getLeaseHolder(db, "memory:proj")).toBe("holder-a");
        expireLease(db, "lease:memory:proj:expiry");
        expect(acquireLease(db, "holder-b", "memory:proj")).toBe(true);

        expect(() =>
            runLeaseGuardedWrite(db, "holder-a", "memory:proj", () => {
                db.prepare("INSERT INTO guarded_writes (value) VALUES ('committed')").run();
            }),
        ).toThrow(/lease lost/i);
        expect(db.prepare("SELECT COUNT(*) AS count FROM guarded_writes").get()).toEqual({
            count: 0,
        });
        closeQuietly(db);
    });

    it("logs a slow guarded write after COMMIT with its lease domain", () => {
        const db = makeDb();
        const events: string[] = [];
        const realExec = db.exec.bind(db);
        const execSpy = spyOn(db, "exec").mockImplementation((sql: string) => {
            events.push(sql);
            return realExec(sql);
        });
        const logSpy = spyOn(logger, "log").mockImplementation((message: string) => {
            events.push(`log:${message}`);
        });
        try {
            expect(acquireLease(db, "holder-a", "memory:proj")).toBe(true);
            db.prepare("CREATE TABLE guarded_write_timing (value TEXT)").run();
            runLeaseGuardedWrite(
                db,
                "holder-a",
                "memory:proj",
                () => {
                    events.push("body");
                    db.prepare(
                        "INSERT INTO guarded_write_timing (value) VALUES ('committed')",
                    ).run();
                },
                0,
            );

            const commitIndex = events.indexOf("COMMIT");
            const logIndex = events.findIndex((event) => event.startsWith("log:"));
            expect(commitIndex).toBeGreaterThanOrEqual(0);
            expect(logIndex).toBeGreaterThan(commitIndex);
            // Filter for this instrument's own line: the spy wraps the shared
            // module logger, so unrelated subsystems (e.g. background embedding
            // retries) can interleave calls in the same worker process. Positional
            // assertions on calls[0] were the real source of this file's flakes.
            const timingLines = logSpy.mock.calls
                .map((call) => String(call[0]))
                .filter((line) => line.includes("site=lease-guarded-write:memory:proj"));
            expect(timingLines.length).toBe(1);
            expect(timingLines[0]).toMatch(/held=\d+\.\dms/);
        } finally {
            logSpy.mockRestore();
            execSpy.mockRestore();
            closeQuietly(db);
        }
    });

    it("does not log a guarded write below the slow-write threshold", () => {
        const db = makeDb();
        const logSpy = spyOn(logger, "log").mockImplementation(() => {});
        try {
            expect(acquireLease(db, "holder-a", "memory:proj")).toBe(true);
            runLeaseGuardedWrite(db, "holder-a", "memory:proj", () => {}, Number.MAX_SAFE_INTEGER);
            // Assert no WRITE-TIMING line specifically — unrelated logger traffic
            // from the shared worker process must not fail this test.
            const timingLines = logSpy.mock.calls
                .map((call) => String(call[0]))
                .filter((line) => line.includes("site=lease-guarded-write"));
            expect(timingLines).toEqual([]);
        } finally {
            logSpy.mockRestore();
            closeQuietly(db);
        }
    });

    it("allows exactly one winner across separate DB handles", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-dream-lease-handles-"));
        const path = join(dir, "context.db");
        const dbA = makeDb(path);
        const dbB = makeDb(path);
        try {
            const results = [acquireLease(dbA, "holder-a"), acquireLease(dbB, "holder-b")];
            // Only one holder can acquire the global lease across handles sharing this database.
            expect(results.filter(Boolean)).toHaveLength(1);
        } finally {
            closeQuietly(dbA);
            closeQuietly(dbB);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("allows exactly one winner across subprocesses sharing a DB", async () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-dream-lease-process-"));
        const path = join(dir, "context.db");
        const setup = makeDb(path);
        closeQuietly(setup);
        try {
            const pluginRoot = process.cwd().endsWith("/packages/plugin")
                ? process.cwd()
                : join(process.cwd(), "packages", "plugin");
            const script = `
                const sqlite = await import(${JSON.stringify(`file://${pluginRoot}/src/shared/sqlite.ts`)});
                const storageDb = await import(${JSON.stringify(`file://${pluginRoot}/src/features/magic-context/storage-db.ts`)});
                const migrations = await import(${JSON.stringify(`file://${pluginRoot}/src/features/magic-context/migrations.ts`)});
                const lease = await import(${JSON.stringify(`file://${pluginRoot}/src/features/magic-context/dreamer/lease.ts`)});
                const db = new sqlite.Database(${JSON.stringify(path)});
                storageDb.initializeDatabase(db);
                migrations.runMigrations(db);
                const ok = lease.acquireLease(db, process.argv.at(-1) ?? "missing-holder");
                db.close();
                console.log(JSON.stringify({ ok }));
            `;
            const [a, b] = await Promise.all([
                $`bun -e ${script} holder-a`.json() as Promise<{ ok: boolean }>,
                $`bun -e ${script} holder-b`.json() as Promise<{ ok: boolean }>,
            ]);
            expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("startLeaseHeartbeat", () => {
    it("keeps the lease alive without declaring it lost", async () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        const hb = startLeaseHeartbeat(db, "holder-a", DREAMING_LEASE_KEY, () => {}, 20);
        await sleep(70);
        expect(hb.lost).toBe(false);
        expect(getLeaseHolder(db)).toBe("holder-a");
        expect(isLeaseActive(db)).toBe(true);
        hb.stop();
        closeQuietly(db);
    });

    it("declares a different active holder lost before returning", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-b")).toBe(true);
        let lostCalls = 0;
        const hb = startLeaseHeartbeat(
            db,
            "holder-a",
            DREAMING_LEASE_KEY,
            () => {
                lostCalls += 1;
            },
            20,
        );
        expect(hb.lost).toBe(true);
        expect(lostCalls).toBe(1);
        expect(getLeaseHolder(db)).toBe("holder-b");
        hb.stop();
        closeQuietly(db);
    });

    it("reclaims a self-inflicted expiry instead of declaring lost (transient-tolerant)", async () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        // Simulate a missed beat: the lease expired but nobody else took it.
        expireLease(db);
        let lostReason: string | null = null;
        const hb = startLeaseHeartbeat(
            db,
            "holder-a",
            DREAMING_LEASE_KEY,
            (reason) => {
                lostReason = reason;
            },
            20,
        );
        await sleep(50);
        // The heartbeat first tries to renew; if the lease expired but remains
        // unclaimed, it reacquires it instead of reporting loss.
        expect(lostReason).toBeNull();
        expect(hb.lost).toBe(false);
        expect(getLeaseHolder(db)).toBe("holder-a");
        hb.stop();
        closeQuietly(db);
    });

    it("declares lost (not reclaim) when the lease lapsed past a full TTL — split-brain guard", async () => {
        // If more than two minutes pass without confirming ownership, another process
        // may have used the lease. Continuing with stale work is unsafe even if the
        // lease is now free; a shorter gap remains safe to recover (see the
        // transient-tolerant test above).
        const db = makeDb();
        const realNow = Date.now();
        const clock = { value: realNow };
        const nowSpy = spyOn(Date, "now").mockImplementation(() => clock.value);
        try {
            expect(acquireLease(db, "holder-a")).toBe(true);
            let lostReason: string | null = null;
            // Use a short interval so a timer-driven beat runs during the test; the
            // first beat runs synchronously and records the initial confirmation time.
            const hb = startLeaseHeartbeat(
                db,
                "holder-a",
                DREAMING_LEASE_KEY,
                (reason) => {
                    lostReason = reason;
                },
                20,
            );
            expect(hb.lost).toBe(false);

            // Advance the fake clock by 3 minutes, past the two-minute confirmation
            // cutoff. The lease has lapsed, so the next beat cannot renew it and the
            // gap exceeds the allowed ownership-confirmation period.
            clock.value = realNow + 3 * 60 * 1000;
            await sleep(60);

            expect(hb.lost).toBe(true);
            expect(lostReason).toContain("past TTL");
            hb.stop();
        } finally {
            nowSpy.mockRestore();
            closeQuietly(db);
        }
    });

    it("uses acquisition time and generation across a pre-heartbeat interloper gap", () => {
        const db = makeDb();
        const realNow = Date.now();
        const clock = { value: realNow };
        const nowSpy = spyOn(Date, "now").mockImplementation(() => clock.value);
        try {
            const acquisition = acquireLeaseWithAcquisition(db, "holder-a");
            expect(acquisition).not.toBeNull();
            clock.value = realNow + 3 * 60 * 1_000;
            expect(acquireLease(db, "holder-b")).toBe(true);
            releaseLease(db, "holder-b");
            let lostReason: string | null = null;

            const hb = startLeaseHeartbeat(
                db,
                "holder-a",
                DREAMING_LEASE_KEY,
                (reason) => {
                    lostReason = reason;
                },
                acquisition ?? undefined,
            );

            expect(hb.lost).toBe(true);
            expect(lostReason).toContain("generation changed");
            expect(getLeaseHolder(db)).toBeNull();
            hb.stop();
        } finally {
            nowSpy.mockRestore();
            closeQuietly(db);
        }
    });

    it("declares lost exactly once when a different holder actively owns the lease", async () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        let lostCalls = 0;
        const hb = startLeaseHeartbeat(
            db,
            "holder-a",
            DREAMING_LEASE_KEY,
            () => {
                lostCalls += 1;
            },
            20,
        );
        // Simulate another holder taking the lease after it expires.
        expireLease(db);
        expect(acquireLease(db, "holder-b")).toBe(true);
        await sleep(80);
        expect(hb.lost).toBe(true);
        expect(lostCalls).toBe(1); // onLost fires once, not on every subsequent beat
        expect(getLeaseHolder(db)).toBe("holder-b");
        hb.stop();
        closeQuietly(db);
    });

    it("stops firing after stop()", async () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        let beats = 0;
        const hb = startLeaseHeartbeat(
            db,
            "holder-a",
            DREAMING_LEASE_KEY,
            () => {
                beats += 1;
            },
            20,
        );
        hb.stop();
        expireLease(db);
        expect(acquireLease(db, "holder-b")).toBe(true);
        await sleep(60);
        expect(beats).toBe(0); // no callbacks after stop()
        closeQuietly(db);
    });
});
