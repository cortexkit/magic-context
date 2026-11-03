import { expect, it, spyOn } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    acquireLeaseWithAcquisition,
    leaseOwnershipMatches,
    releaseLease,
    renewLease,
} from "./lease";

interface InteropState {
    name: string;
    holder: string;
    key: string;
    now_ms: number;
    rows: Record<string, string>;
    owns: Record<string, Record<string, boolean>>;
}

type InteropStep = InteropState &
    (
        | { op: "acquire"; generation?: number; result: boolean }
        | { op: "renew"; generation: number; result: boolean }
        | { op: "release" | "expire" }
    );

// Both runtimes check this committed oracle independently; neither test suite
// needs to launch the other runtime or derive expected row names from its code.
const steps = JSON.parse(
    readFileSync(
        new URL("../../../../test-fixtures/runtime/dream_domain_interop.json", import.meta.url),
        "utf8",
    ),
) as InteropStep[];

function withDb(run: (db: Database) => void): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), "dream-domain-interop-"));
    const db = new Database(join(dir, "context.db"));
    try {
        initializeDatabase(db);
        runMigrations(db);
        run(db);
    } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
}

function rows(db: Database): Record<string, string> {
    const records = db.prepare("SELECT key,value FROM dream_state").all() as {
        key: string;
        value: string;
    }[];
    return Object.fromEntries(records.map(({ key, value }) => [key, value]));
}

it("typescript replays the shared dream-domain interop fixture", () => {
    withDb((db) => {
        let now = 0;
        const clock = spyOn(Date, "now").mockImplementation(() => now);
        const generations = new Map<string, number>();
        try {
            expect(steps).toHaveLength(17);
            for (const step of steps) {
                now = step.now_ms;
                const identity = `${step.key}/${step.holder}`;
                switch (step.op) {
                    case "acquire": {
                        const lease = acquireLeaseWithAcquisition(db, step.holder, step.key);
                        expect(lease !== null, step.name).toBe(step.result);
                        expect(lease?.generation, step.name).toBe(step.generation);
                        if (lease) generations.set(identity, lease.generation);
                        break;
                    }
                    case "renew":
                        expect(
                            renewLease(db, step.holder, step.key, step.generation),
                            step.name,
                        ).toBe(step.result);
                        break;
                    case "release":
                        releaseLease(db, step.holder, step.key);
                        break;
                    case "expire":
                        // Advancing time expires ownership without erasing its rows.
                        break;
                    default:
                        throw new Error("Unknown fixture operation");
                }
                expect(rows(db), step.name).toEqual(step.rows);
                for (const [key, holders] of Object.entries(step.owns)) {
                    for (const [holder, expected] of Object.entries(holders)) {
                        expect(
                            leaseOwnershipMatches(
                                db,
                                holder,
                                generations.get(`${key}/${holder}`) ?? 0,
                                key,
                            ),
                            `${step.name}: ${key} / ${holder}`,
                        ).toBe(expected);
                    }
                }
            }
        } finally {
            clock.mockRestore();
        }
    });
});

it("typescript recognizes committed Rust rows and preserves legacy dreaming isolation", () => {
    withDb((db) => {
        const step = steps.find((s) => s.name === "rust-acquire-memory");
        if (!step) throw new Error("Missing Rust acquisition fixture");
        const clock = spyOn(Date, "now").mockReturnValue(step.now_ms);
        try {
            // Rust's native replay proves this exact foreign-runtime snapshot.
            db.exec("BEGIN IMMEDIATE");
            for (const [key, value] of Object.entries(step.rows)) {
                db.prepare("INSERT INTO dream_state(key,value) VALUES(?,?)").run(key, value);
            }
            db.exec("COMMIT");
            expect(leaseOwnershipMatches(db, "rust", 2, step.key)).toBe(true);
            expect(acquireLeaseWithAcquisition(db, "typescript", step.key)).toBeNull();
            expect(rows(db)).toEqual(step.rows);
            releaseLease(db, "rust", step.key);
            expect(leaseOwnershipMatches(db, "rust", 1, "dreaming")).toBe(true);
            expect(acquireLeaseWithAcquisition(db, "typescript", step.key)?.generation).toBe(3);
            expect(leaseOwnershipMatches(db, "typescript", 3, step.key)).toBe(true);
            expect(leaseOwnershipMatches(db, "rust", 1, "dreaming")).toBe(true);
            expect(rows(db).dreaming_lease_holder).toBe("rust");
            expect(Object.keys(rows(db)).some((key) => key.startsWith("lease:dreaming:"))).toBe(
                false,
            );
        } finally {
            clock.mockRestore();
        }
    });
});
