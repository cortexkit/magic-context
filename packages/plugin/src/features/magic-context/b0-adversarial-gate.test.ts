/// <reference types="bun-types" />

/**
 * Adversarial probes against the single-store marker release (context.db v93).
 *
 * These pin behaviour a reviewer needs to see before the release ships: what a new
 * plugin does against a module build that predates `mirror.marker_status`, what an
 * older plugin's fence does with a v93 file, and what a transient module failure on
 * that route does to a drain that used to proceed.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SubcModuleTransport } from "../../hooks/magic-context/module-transport";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    type AuthorityDomain,
    type AuthorityModuleClient,
    type AuthorityStatus,
    drainAuthority,
    drainMirrorPages,
    getMirrorCursor,
    pullMemoryMirrorOnce,
} from "./context-authority";
import { runMigrations } from "./migrations";
import { MARKER_LANE_VERSION, SingleStoreTripwireError } from "./single-store-marker";
import {
    __resetSchemaFenceStateForTests,
    getSchemaFenceRejection,
    initializeDatabase,
    openDatabase,
} from "./storage-db";

const PROJECT = "git:b0-gate";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    db.prepare(
        "UPDATE mirror_resnapshot_state SET status = 'complete', generation = NULL WHERE domain = 'memories'",
    ).run();
    db.exec(`
        CREATE TABLE IF NOT EXISTS mirror_memory_repair_state (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            dirty INTEGER NOT NULL DEFAULT 0 CHECK(dirty IN (0, 1)),
            updated_at INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO mirror_memory_repair_state(id, dirty, updated_at) VALUES (1, 0, 0);
    `);
    return db;
}

/** Roll the file back to the lane before the marker migration. */
function belowLane(db: Database): void {
    db.exec("DROP TABLE single_store_projects");
    db.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(MARKER_LANE_VERSION - 1);
}

function schemaVersions(db: Database): number[] {
    return (
        db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
            version: number;
        }>
    ).map((row) => row.version);
}

function tableExists(db: Database, name: string): boolean {
    return (
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !=
        null
    );
}

// ── 2. Mixed versions: a new plugin against a module without marker_status ──

/**
 * A real `SubcModuleTransport` whose wire answers the way a module build from before
 * this release does: `mirror.pull` is served (the extra `project` field is ignored) and
 * `mirror.marker_status` is an unrecognized request.
 */
function oldModuleTransport(shape: "record" | "throw"): {
    transport: SubcModuleTransport;
    calls: string[];
} {
    const transport = new SubcModuleTransport("/nonexistent/connection.json");
    const calls: string[] = [];
    (transport as unknown as { call: (args: { body: unknown }) => Promise<unknown> }).call = async (
        args,
    ) => {
        const body = args.body as { method: string; domain?: string; cursor?: number };
        calls.push(body.method);
        if (body.method === "mirror.marker_status") {
            if (shape === "throw") {
                throw Object.assign(new Error("unrecognized request shape"), {
                    code: "unrecognized_request_shape",
                });
            }
            return { code: "unrecognized_request_shape", message: "unrecognized request" };
        }
        if (body.method === "mirror.pull") {
            return {
                result: {
                    page: {
                        domain: body.domain,
                        cursor: body.cursor ?? 0,
                        next_cursor: body.cursor ?? 0,
                        has_more: false,
                        rows: [],
                    },
                },
            };
        }
        throw new Error(`unexpected method ${body.method}`);
    };
    return { transport, calls };
}

function transportModule(transport: SubcModuleTransport) {
    return {
        mirrorPull: (request: Parameters<SubcModuleTransport["mirrorPull"]>[0]) =>
            transport.mirrorPull(request),
        markerStatus: (request: Parameters<SubcModuleTransport["markerStatus"]>[0]) =>
            transport.markerStatus(request),
    };
}

describe("b0 gate: new plugin, module without mirror.marker_status", () => {
    for (const shape of ["record", "throw"] as const) {
        test(`at the marker lane with no marker row the mirror runs as before (${shape})`, async () => {
            const db = freshDb();
            try {
                const { transport, calls } = oldModuleTransport(shape);
                const drained = await drainMirrorPages({
                    db,
                    module: transportModule(transport),
                    domain: "notes",
                    projectPath: PROJECT,
                    limit: 10,
                });
                expect(drained.complete).toBe(true);
                expect(calls).toEqual(["mirror.marker_status", "mirror.pull"]);

                const flight = await pullMemoryMirrorOnce({
                    db,
                    module: transportModule(transport),
                    projectPath: PROJECT,
                });
                expect(flight.complete).toBe(true);
            } finally {
                closeQuietly(db);
            }
        });

        test(`at the marker lane with any marker row every pull is refused before the old module serves it (${shape})`, async () => {
            const db = freshDb();
            try {
                // The marker names another project: an old module would still copy that
                // project's rows into this file on the caller's page.
                db.prepare(
                    `INSERT INTO single_store_projects
                        (project_path, context_store_uuid, marked_at, marked_by_version)
                     VALUES ('git:someone-else', 'store', 1, 'fixture')`,
                ).run();
                const { transport, calls } = oldModuleTransport(shape);
                const error = await drainMirrorPages({
                    db,
                    module: transportModule(transport),
                    domain: "notes",
                    projectPath: PROJECT,
                    limit: 10,
                }).then(
                    () => null,
                    (rejected: unknown) => rejected,
                );
                expect(error).toBeInstanceOf(SingleStoreTripwireError);
                expect(error).toMatchObject({
                    code: "single_store_tripwire",
                    retryable: false,
                    state: "MODULE",
                });
                expect(calls).toEqual(["mirror.marker_status"]);
                expect(getMirrorCursor(db, "notes")).toBe(0);
            } finally {
                closeQuietly(db);
            }
        });
    }

    test("control: below the marker lane the same module serves the drain with no marker call", async () => {
        const db = freshDb();
        try {
            belowLane(db);
            const { transport, calls } = oldModuleTransport("record");
            const drained = await drainMirrorPages({
                db,
                module: transportModule(transport),
                domain: "notes",
                projectPath: PROJECT,
                limit: 10,
            });
            expect(drained.complete).toBe(true);
            expect(calls).toEqual(["mirror.pull"]);
        } finally {
            closeQuietly(db);
        }
    });

    test("a real transport failure on marker_status is rethrown, not treated as an old module", async () => {
        const db = freshDb();
        try {
            const transport = new SubcModuleTransport("/nonexistent/connection.json");
            const reset = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
            (transport as unknown as { call: () => Promise<unknown> }).call = async () => {
                throw reset;
            };
            const error = await drainMirrorPages({
                db,
                module: transportModule(transport),
                domain: "notes",
                projectPath: PROJECT,
                limit: 10,
            }).then(
                () => null,
                (rejected: unknown) => rejected,
            );
            expect(error).toBe(reset);
        } finally {
            closeQuietly(db);
        }
    });
});

// ── 5. Rollback: an older plugin's fence against a v93 file ─────────────────

describe("b0 gate: rollback to a plugin whose fence is below 93", () => {
    for (const olderFence of [91, 92]) {
        test(`a fence of ${olderFence} refuses to open a v93 file and leaves it untouched`, () => {
            const dir = mkdtempSync(join(tmpdir(), "mc-b0-gate-rollback-"));
            const dbPath = join(dir, "context.db");
            try {
                const seed = new Database(dbPath);
                initializeDatabase(seed);
                runMigrations(seed);
                expect(schemaVersions(seed).at(-1)).toBe(93);
                seed.close();

                __resetSchemaFenceStateForTests();
                const opened = openDatabase({ dbPath, latestSupportedVersion: olderFence });
                expect(opened).toBeNull();
                expect(getSchemaFenceRejection()).toEqual({
                    persistedVersion: 93,
                    supportedVersion: olderFence,
                });

                const after = new Database(dbPath);
                expect(schemaVersions(after).at(-1)).toBe(93);
                expect(tableExists(after, "single_store_projects")).toBe(true);
                after.close();
            } finally {
                __resetSchemaFenceStateForTests();
                rmSync(dir, { recursive: true, force: true });
            }
        });
    }
});

// ── 4. Error mapping: a transient marker_status failure ────────────────────

function drainingModule(markerStatus: AuthorityModuleClient["markerStatus"]): {
    module: AuthorityModuleClient;
    counts: { begin: number; pull: number };
} {
    const counts = { begin: 0, pull: 0 };
    const states: Record<AuthorityDomain, AuthorityStatus["state"]> = {
        memories: "DRAINING",
        notes: "DRAINING",
    };
    const status = (domain: AuthorityDomain): AuthorityStatus => ({
        context_store_uuid: "store",
        project: PROJECT,
        domain,
        state: states[domain],
        generation: 1,
        coordinator_token: "tok",
        captured_upper_bound: 5,
    });
    return {
        counts,
        module: {
            authorityStatus: async (args) => ({ authority: status(args.domain) }),
            authorityPrepare: async () => {
                throw new Error("not used");
            },
            authorityDrain: async (args) => {
                if (args.action === "begin") counts.begin += 1;
                if (args.action === "finish") states[args.domain as AuthorityDomain] = "TS";
                return { authority: status(args.domain as AuthorityDomain) };
            },
            mirrorPull: async (args) => {
                counts.pull += 1;
                return {
                    page: {
                        domain: args.domain,
                        cursor: args.cursor,
                        next_cursor: 5,
                        has_more: false,
                        rows: [],
                    },
                };
            },
            markerStatus,
        },
    };
}

describe("b0 gate: a transient marker_status failure", () => {
    test("drainAuthority rejects before begin instead of draining", async () => {
        const db = freshDb();
        try {
            const reset = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
            const { module, counts } = drainingModule(async () => {
                throw reset;
            });
            const error = await drainAuthority({
                db,
                projectPath: PROJECT,
                domain: "notes",
                module,
                checksum: "x",
            }).then(
                () => null,
                (rejected: unknown) => rejected,
            );
            expect(error).toBe(reset);
            expect(counts).toEqual({ begin: 0, pull: 0 });
            expect(getMirrorCursor(db, "notes")).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("control: the same module with a healthy marker_status drains", async () => {
        const db = freshDb();
        try {
            const { module, counts } = drainingModule(async () => ({ ok: true }));
            const drained = await drainAuthority({
                db,
                projectPath: PROJECT,
                domain: "notes",
                module,
                checksum: "x",
            });
            expect("code" in drained).toBe(false);
            expect(counts.begin).toBe(1);
            expect(getMirrorCursor(db, "notes")).toBe(5);
        } finally {
            closeQuietly(db);
        }
    });
});
