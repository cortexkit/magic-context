/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    acquireCompartmentLease,
    isCompartmentLeaseHeld,
    releaseCompartmentLease,
    renewCompartmentLease,
} from "./compartment-lease";
import { initializeDatabase } from "./storage-db";

function makeDb(path = ":memory:"): Database {
    const db = new Database(path);
    initializeDatabase(db);
    return db;
}

describe("compartment state lease", () => {
    it("acquires, reports held, and releases", () => {
        const db = makeDb();
        expect(acquireCompartmentLease(db, "ses", "holder-a")).not.toBeNull();
        expect(isCompartmentLeaseHeld(db, "ses", "holder-a")).toBe(true);
        releaseCompartmentLease(db, "ses", "holder-a");
        expect(isCompartmentLeaseHeld(db, "ses", "holder-a")).toBe(false);
        closeQuietly(db);
    });

    it("blocks a second holder while the current lease is not expired", () => {
        const db = makeDb();
        expect(acquireCompartmentLease(db, "ses", "holder-a")).not.toBeNull();
        expect(acquireCompartmentLease(db, "ses", "holder-b")).toBeNull();
        expect(isCompartmentLeaseHeld(db, "ses", "holder-a")).toBe(true);
        closeQuietly(db);
    });

    it("lets the same holder reacquire and extend expiry", () => {
        const db = makeDb();
        const first = acquireCompartmentLease(db, "ses", "holder-a");
        expect(first).not.toBeNull();

        db.prepare("UPDATE compartment_state_lease SET expires_at = ? WHERE session_id = ?").run(
            Date.now() + 1_000,
            "ses",
        );

        const second = acquireCompartmentLease(db, "ses", "holder-a");
        expect(second).not.toBeNull();
        expect(second!.expiresAt).toBeGreaterThan(first!.acquiredAt + 1_000);
        closeQuietly(db);
    });

    it("lets another holder reclaim an expired lease", () => {
        const db = makeDb();
        expect(acquireCompartmentLease(db, "ses", "holder-a")).not.toBeNull();

        db.prepare("UPDATE compartment_state_lease SET expires_at = ? WHERE session_id = ?").run(
            Date.now() - 1,
            "ses",
        );

        expect(acquireCompartmentLease(db, "ses", "holder-b")).not.toBeNull();
        expect(isCompartmentLeaseHeld(db, "ses", "holder-b")).toBe(true);
        expect(isCompartmentLeaseHeld(db, "ses", "holder-a")).toBe(false);
        closeQuietly(db);
    });

    it("renew fails for holder mismatch or expired lease", () => {
        const db = makeDb();
        expect(acquireCompartmentLease(db, "ses", "holder-a")).not.toBeNull();
        expect(renewCompartmentLease(db, "ses", "holder-b")).toBe(false);

        db.prepare("UPDATE compartment_state_lease SET expires_at = ? WHERE session_id = ?").run(
            Date.now() - 1,
            "ses",
        );
        expect(renewCompartmentLease(db, "ses", "holder-a")).toBe(false);
        closeQuietly(db);
    });

    it("release is a no-op after another holder reclaims the row", () => {
        const db = makeDb();
        expect(acquireCompartmentLease(db, "ses", "holder-a")).not.toBeNull();

        db.prepare("UPDATE compartment_state_lease SET expires_at = ? WHERE session_id = ?").run(
            Date.now() - 1,
            "ses",
        );

        expect(acquireCompartmentLease(db, "ses", "holder-b")).not.toBeNull();
        releaseCompartmentLease(db, "ses", "holder-a");
        expect(isCompartmentLeaseHeld(db, "ses", "holder-b")).toBe(true);
        closeQuietly(db);
    });

    it("allows exactly one winner across separate DB handles", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-lease-handles-"));
        const path = join(dir, "context.db");
        const dbA = makeDb(path);
        const dbB = makeDb(path);
        try {
            const results = [
                acquireCompartmentLease(dbA, "ses", "holder-a"),
                acquireCompartmentLease(dbB, "ses", "holder-b"),
            ];
            expect(results.filter(Boolean)).toHaveLength(1);
        } finally {
            closeQuietly(dbA);
            closeQuietly(dbB);
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                // Ignore EBUSY on Windows
            }
        }
    });

    it("allows exactly one winner across subprocesses sharing a DB", async () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-lease-process-"));
        const path = join(dir, "context.db");
        const setup = makeDb(path);
        closeQuietly(setup);

        try {
            const projectRoot = process.cwd().includes("packages")
                ? join(process.cwd(), "..", "..")
                : process.cwd();
            const pluginRoot = join(projectRoot, "packages", "plugin");

            const script = `
                const sqlite = await import(${JSON.stringify(`file://${pluginRoot}/src/shared/sqlite.ts`)});
                const storageDb = await import(${JSON.stringify(`file://${pluginRoot}/src/features/magic-context/storage-db.ts`)});
                const lease = await import(${JSON.stringify(`file://${pluginRoot}/src/features/magic-context/compartment-lease.ts`)});
                const db = new sqlite.Database(${JSON.stringify(path)});
                storageDb.initializeDatabase(db);
                const ok = lease.acquireCompartmentLease(db, "ses", process.argv.at(-1) ?? "missing-holder") !== null;
                db.close();
                console.log(JSON.stringify({ ok }));
            `;

            const [a, b] = await Promise.all([
                $`bun -e ${script} holder-a`.json() as Promise<{ ok: boolean }>,
                $`bun -e ${script} holder-b`.json() as Promise<{ ok: boolean }>,
            ]);
            expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
        } finally {
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                // Ignore EBUSY on Windows
            }
        }
    });
});
