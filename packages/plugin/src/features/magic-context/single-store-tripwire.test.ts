/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SubcModuleTransport } from "../../hooks/magic-context/module-transport";
import {
    __rustModeTransformTest,
    MemoryAuthorityUnavailableError,
    type RustModeModuleClient,
} from "../../hooks/magic-context/rust-mode-transform";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    type AuthorityDomain,
    type AuthorityModuleClient,
    type AuthorityStatus,
    type ChangefeedPage,
    drainAuthority,
    drainMirrorPages,
    ensureContextStoreUuid,
    ensureLiveMemoryResnapshot,
    getMirrorCursor,
    installAuthorityManagedMarker,
    pullMemoryMirrorOnce,
    reconcileAuthorityProject,
} from "./context-authority";
import { resolveProjectIdentity } from "./memory/project-identity";
import { runMigrations } from "./migrations";
import {
    MARKER_LANE_VERSION,
    readMarkerLane,
    readSingleStoreMarker,
    SingleStoreTripwireError,
} from "./single-store-marker";
import { getPersistedSchemaVersion, initializeDatabase } from "./storage-db";

const A = "git:tripwire-a";
const B = "git:tripwire-b";
const C = "git:tripwire-c";
const DOMAINS: AuthorityDomain[] = ["memories", "notes"];

const TRIPWIRE_RESULT = {
    code: "single_store_tripwire",
    retryable: false,
    state: "MODULE",
    attempts: 0,
    authority: null,
};

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    // The default fixture: a complete live resnapshot, so a memories drain takes the
    // shipped early return unless a test says otherwise.
    db.prepare(
        "UPDATE mirror_resnapshot_state SET status = 'complete', generation = NULL WHERE domain = 'memories'",
    ).run();
    // A resnapshot that reached `complete` has already created its repair ledger.
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

function mark(db: Database, project: string, uuid = ensureContextStoreUuid(db)): void {
    db.prepare(
        `INSERT INTO single_store_projects
            (project_path, context_store_uuid, marked_at, marked_by_version)
         VALUES (?, ?, 1700000000000, 'fixture-build-1')`,
    ).run(project, uuid);
}

function unmark(db: Database, project: string): void {
    db.prepare("DELETE FROM single_store_projects WHERE project_path = ?").run(project);
}

function setCursor(db: Database, domain: AuthorityDomain, cursor: number): void {
    db.prepare(
        "INSERT INTO mirror_cursors(domain, cursor, updated_at) VALUES (?, ?, 1) ON CONFLICT(domain) DO UPDATE SET cursor = excluded.cursor",
    ).run(domain, cursor);
}

/** A resnapshot owned by generation G, with staging rows for G and for an older one. */
function pendingResnapshot(db: Database): void {
    db.prepare(
        "UPDATE mirror_resnapshot_state SET status = 'resnapshotting', generation = 'G' WHERE domain = 'memories'",
    ).run();
    for (const generation of ["G", "OLD"]) {
        db.prepare(
            `INSERT INTO mirror_live_staging(generation, module_project, module_row_id, category, normalized_hash)
             VALUES (?, ?, 1, 'ARCHITECTURE', 'hash')`,
        ).run(generation, B);
    }
}

function resnapshotSnapshot(db: Database): unknown {
    return {
        state: db
            .prepare(
                "SELECT status, generation FROM mirror_resnapshot_state WHERE domain = 'memories'",
            )
            .get(),
        staging: db
            .prepare(
                "SELECT generation, module_project FROM mirror_live_staging ORDER BY generation",
            )
            .all(),
    };
}

/** Put the file below the marker lane: drop the table and the migration rows for it. */
function belowLane(db: Database): void {
    db.exec("DROP TABLE single_store_projects");
    db.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(MARKER_LANE_VERSION - 1);
}

interface Counts {
    authorityStatus: number;
    begin: number;
    finish: number;
    mirrorPull: number;
    liveOnlyPull: number;
    markerStatus: number;
}

interface FakeOptions {
    states?: Partial<Record<AuthorityDomain, AuthorityStatus["state"]>>;
    /** The changefeed head each domain's drain captures. */
    feedHead?: number;
    /** How `mirror.marker_status` answers; `absent` leaves the method off the client. */
    markerStatus?: "ok" | "refuse" | "absent";
    /** Make `mirror.pull` refuse the way the module does for a lane-less file. */
    pullRefuses?: boolean;
    pages?: (args: { domain: AuthorityDomain; cursor: number; limit: number }) => ChangefeedPage;
}

function tripwireFromModule(message: string): Error {
    // The shape a module `HandlerOutcome::Error` takes after the transport: an error
    // carrying the wire code, not a SingleStoreTripwireError.
    return Object.assign(new Error(message), { code: "single_store_tripwire" });
}

function fakeModule(options: FakeOptions = {}): {
    module: AuthorityModuleClient;
    counts: Counts;
    pulledProjects: string[];
    markerProjects: string[];
} {
    const counts: Counts = {
        authorityStatus: 0,
        begin: 0,
        finish: 0,
        mirrorPull: 0,
        liveOnlyPull: 0,
        markerStatus: 0,
    };
    const states: Record<AuthorityDomain, AuthorityStatus["state"]> = {
        memories: options.states?.memories ?? "DRAINING",
        notes: options.states?.notes ?? "DRAINING",
    };
    const feedHead = options.feedHead ?? 5;
    const pulledProjects: string[] = [];
    const markerProjects: string[] = [];
    const status = (domain: AuthorityDomain, state: AuthorityStatus["state"]): AuthorityStatus => ({
        context_store_uuid: "store",
        project: A,
        domain,
        state,
        generation: 1,
        coordinator_token: "tok",
        captured_upper_bound: feedHead,
    });
    const module: AuthorityModuleClient = {
        authorityStatus: async (args) => {
            counts.authorityStatus += 1;
            return { authority: status(args.domain, states[args.domain]) };
        },
        authorityPrepare: async () => {
            throw new Error("prepare is not part of these cells");
        },
        authorityDrain: async (args) => {
            const domain = args.domain as AuthorityDomain;
            if (args.action === "begin") {
                counts.begin += 1;
                states[domain] = "DRAINING";
            }
            if (args.action === "finish") {
                counts.finish += 1;
                states[domain] = "TS";
            }
            return { authority: status(domain, states[domain]) };
        },
        mirrorPull: async (args) => {
            counts.mirrorPull += 1;
            pulledProjects.push(args.project);
            if (args.live_only) counts.liveOnlyPull += 1;
            if (options.pullRefuses) {
                throw tripwireFromModule("single_store_fence_missing: context.db has no lane");
            }
            if (options.pages && !args.live_only) return { page: options.pages(args) };
            return {
                page: {
                    domain: args.domain,
                    cursor: args.cursor,
                    next_cursor: args.live_only ? args.cursor : Math.max(args.cursor, feedHead),
                    has_more: false,
                    rows: [],
                },
            };
        },
    };
    if (options.markerStatus !== "absent") {
        module.markerStatus = async (args) => {
            counts.markerStatus += 1;
            markerProjects.push(args.project);
            if (options.markerStatus === "refuse") {
                throw tripwireFromModule(
                    "single_store_fingerprint_mismatch: the single-store marker cannot be read",
                );
            }
            return { ok: true };
        };
    }
    return { module, counts, pulledProjects, markerProjects };
}

function authorityRows(db: Database): unknown {
    return db.prepare("SELECT * FROM mirror_cursors ORDER BY domain").all();
}

function expectTripwireError(error: unknown): void {
    expect(error).toBeInstanceOf(SingleStoreTripwireError);
    const record = error as Record<string, unknown>;
    expect(Object.hasOwn(record, "code")).toBe(true);
    expect(record.code).toBe("single_store_tripwire");
    expect(record.retryable).toBe(false);
    expect(record.state).toBe("MODULE");
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error("expected a rejection");
}

describe("single-store marker lane read", () => {
    test("the lane read matches the plugin's persisted-version reader, including a lane-less file", () => {
        const db = freshDb();
        try {
            expect(readMarkerLane(db)).toBe(getPersistedSchemaVersion(db));
            expect(readMarkerLane(db)).toBeGreaterThanOrEqual(MARKER_LANE_VERSION);
            belowLane(db);
            expect(readMarkerLane(db)).toBe(getPersistedSchemaVersion(db));
            expect(readMarkerLane(db)).toBeLessThan(MARKER_LANE_VERSION);
            db.exec("DROP TABLE schema_migrations");
            expect(getPersistedSchemaVersion(db)).toBe(0);
            expect(readMarkerLane(db)).toBe(0);
            expect(readSingleStoreMarker(db, A)).toEqual({ kind: "below_lane", lane: 0 });
        } finally {
            closeQuietly(db);
        }
    });
});

describe("drainAuthority single-store tripwire", () => {
    for (const domain of DOMAINS) {
        test(`${domain}: a marked project is refused before the begin route`, async () => {
            for (const uuid of [undefined, "a-different-context-store"]) {
                const db = freshDb();
                try {
                    mark(db, A, uuid);
                    setCursor(db, domain, 2);
                    pendingResnapshot(db);
                    const resnapshotBefore = resnapshotSnapshot(db);
                    const fake = fakeModule();
                    const result = await drainAuthority({
                        db,
                        projectPath: A,
                        domain,
                        module: fake.module,
                        checksum: "x",
                    });
                    expect(result).toEqual(TRIPWIRE_RESULT);
                    expect(fake.counts).toEqual({
                        authorityStatus: 0,
                        begin: 0,
                        finish: 0,
                        mirrorPull: 0,
                        liveOnlyPull: 0,
                        markerStatus: 0,
                    });
                    expect(getMirrorCursor(db, domain)).toBe(2);
                    expect(resnapshotSnapshot(db)).toEqual(resnapshotBefore);
                } finally {
                    closeQuietly(db);
                }
            }
        });

        test(`${domain}: an unreadable marker table refuses every project without a module call`, async () => {
            const db = freshDb();
            try {
                db.exec("DROP TABLE single_store_projects");
                setCursor(db, domain, 2);
                for (const project of [A, B]) {
                    const fake = fakeModule();
                    const result = await drainAuthority({
                        db,
                        projectPath: project,
                        domain,
                        module: fake.module,
                        checksum: "x",
                    });
                    expect(result).toEqual(TRIPWIRE_RESULT);
                    expect(
                        fake.counts.begin + fake.counts.markerStatus + fake.counts.mirrorPull,
                    ).toBe(0);
                }
                expect(getMirrorCursor(db, domain)).toBe(2);
            } finally {
                closeQuietly(db);
            }
        });

        test(`${domain}: a refusing module marker answer stops the drain before begin`, async () => {
            const db = freshDb();
            try {
                setCursor(db, domain, 2);
                pendingResnapshot(db);
                const resnapshotBefore = resnapshotSnapshot(db);
                const fake = fakeModule({ markerStatus: "refuse" });
                const result = await drainAuthority({
                    db,
                    projectPath: B,
                    domain,
                    module: fake.module,
                    checksum: "x",
                });
                expect(result).toEqual(TRIPWIRE_RESULT);
                expect(fake.counts).toMatchObject({
                    markerStatus: 1,
                    begin: 0,
                    mirrorPull: 0,
                    authorityStatus: 0,
                });
                expect(getMirrorCursor(db, domain)).toBe(2);
                expect(resnapshotSnapshot(db)).toEqual(resnapshotBefore);
            } finally {
                closeQuietly(db);
            }
        });

        test(`${domain}: a client without markerStatus is refused at the lane and not below it`, async () => {
            const db = freshDb();
            try {
                const fake = fakeModule({ markerStatus: "absent" });
                const refused = await drainAuthority({
                    db,
                    projectPath: B,
                    domain,
                    module: fake.module,
                    checksum: "x",
                });
                expect(refused).toEqual(TRIPWIRE_RESULT);
                expect(fake.counts.begin + fake.counts.mirrorPull).toBe(0);

                belowLane(db);
                const below = fakeModule({ markerStatus: "absent" });
                const drained = await drainAuthority({
                    db,
                    projectPath: B,
                    domain,
                    module: below.module,
                    checksum: "x",
                });
                expect(drained).toMatchObject({ state: "TS" });
                expect(below.counts.begin).toBe(1);
            } finally {
                closeQuietly(db);
            }
        });

        test(`${domain}: an unmarked project drains with exactly one marker_status call`, async () => {
            const db = freshDb();
            try {
                const fake = fakeModule();
                const drained = await drainAuthority({
                    db,
                    projectPath: B,
                    domain,
                    module: fake.module,
                    checksum: "x",
                });
                expect(drained).toMatchObject({ state: "TS" });
                expect(fake.counts.markerStatus).toBe(1);
                expect(fake.counts.begin).toBe(1);
                expect(fake.counts.finish).toBe(1);
                expect(getMirrorCursor(db, domain)).toBe(5);
                expect(new Set(fake.pulledProjects)).toEqual(new Set([B]));
            } finally {
                closeQuietly(db);
            }
        });

        test(`${domain}: a file below the marker lane drains as before with no marker call`, async () => {
            const db = freshDb();
            try {
                belowLane(db);
                const fake = fakeModule();
                const drained = await drainAuthority({
                    db,
                    projectPath: B,
                    domain,
                    module: fake.module,
                    checksum: "x",
                });
                expect(drained).toMatchObject({ state: "TS" });
                expect(fake.counts.markerStatus).toBe(0);
                expect(getMirrorCursor(db, domain)).toBe(5);
            } finally {
                closeQuietly(db);
            }
        });

        test(`${domain}: the marker is read on every call`, async () => {
            const db = freshDb();
            try {
                const first = fakeModule();
                expect(
                    await drainAuthority({
                        db,
                        projectPath: A,
                        domain,
                        module: first.module,
                        checksum: "x",
                    }),
                ).toMatchObject({ state: "TS" });
                mark(db, A);
                const second = fakeModule();
                expect(
                    await drainAuthority({
                        db,
                        projectPath: A,
                        domain,
                        module: second.module,
                        checksum: "x",
                    }),
                ).toEqual(TRIPWIRE_RESULT);
                expect(second.counts.begin).toBe(0);
                unmark(db, A);
                const third = fakeModule();
                expect(
                    await drainAuthority({
                        db,
                        projectPath: A,
                        domain,
                        module: third.module,
                        checksum: "x",
                    }),
                ).toMatchObject({ state: "TS" });
            } finally {
                closeQuietly(db);
            }
        });

        test(`${domain}: a lane-less file reaches the module's mirror.pull refusal after begin and returns the tripwire`, async () => {
            const db = freshDb();
            try {
                db.exec("DROP TABLE schema_migrations");
                setCursor(db, domain, 2);
                pendingResnapshot(db);
                const fake = fakeModule({ pullRefuses: true });
                const result = await drainAuthority({
                    db,
                    projectPath: A,
                    domain,
                    module: fake.module,
                    checksum: "x",
                });
                expect(result).toEqual(TRIPWIRE_RESULT);
                expect(fake.counts.markerStatus).toBe(0);
                expect(fake.counts.begin).toBe(1);
                expect(fake.counts.finish).toBe(0);
                expect(fake.counts.mirrorPull).toBe(1);
                expect(getMirrorCursor(db, domain)).toBe(2);
                if (domain === "memories") {
                    // The resnapshot claim commits before its first live pull, which is the
                    // one the module refuses: a fresh generation, and older staging gone.
                    expect(fake.counts.liveOnlyPull).toBe(1);
                    const state = db
                        .prepare(
                            "SELECT status, generation FROM mirror_resnapshot_state WHERE domain = 'memories'",
                        )
                        .get() as { status: string; generation: string };
                    expect(state.status).toBe("resnapshotting");
                    expect(state.generation).not.toBe("G");
                    expect(
                        db.prepare("SELECT COUNT(*) AS count FROM mirror_live_staging").get(),
                    ).toEqual({ count: 0 });
                } else {
                    expect(fake.counts.liveOnlyPull).toBe(0);
                }
            } finally {
                closeQuietly(db);
            }
        });
    }

    test("a raw directory caller is unmarked, and another data home's marker changes nothing", async () => {
        const db = freshDb();
        const other = freshDb();
        try {
            mark(other, B);
            // A marker keyed by an identity string never matches a raw directory path.
            mark(db, "git:some-project");
            const fake = fakeModule();
            const drained = await drainAuthority({
                db,
                projectPath: "/Users/someone/some-project",
                domain: "notes",
                module: fake.module,
                checksum: "x",
            });
            expect(drained).toMatchObject({ state: "TS" });
            const otherHome = fakeModule();
            expect(
                await drainAuthority({
                    db,
                    projectPath: B,
                    domain: "notes",
                    module: otherHome.module,
                    checksum: "x",
                }),
            ).toMatchObject({ state: "TS" });
        } finally {
            closeQuietly(db);
            closeQuietly(other);
        }
    });

    test("the resolver's identity string is what reaches the module and what the marker is keyed by", async () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-tripwire-identity-"));
        const db = freshDb();
        try {
            const identity = resolveProjectIdentity(dir);
            const fake = fakeModule();
            await drainAuthority({
                db,
                projectPath: identity,
                domain: "memories",
                module: fake.module,
                checksum: "x",
            });
            await drainMirrorPages({
                db,
                module: fake.module,
                domain: "notes",
                projectPath: identity,
            });
            expect(new Set(fake.pulledProjects)).toEqual(new Set([identity]));
            expect(new Set(fake.markerProjects)).toEqual(new Set([identity]));

            mark(db, identity);
            const refused = fakeModule();
            expect(
                await drainAuthority({
                    db,
                    projectPath: identity,
                    domain: "memories",
                    module: refused.module,
                    checksum: "x",
                }),
            ).toEqual(TRIPWIRE_RESULT);
        } finally {
            closeQuietly(db);
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("reconcileAuthorityProject single-store tripwire", () => {
    /** Both domains MODULE, no identity for A, cursors at N, A's and B's mirror rows present. */
    function reconcileFixture(db: Database): void {
        for (const domain of DOMAINS) setCursor(db, domain, 7);
        installAuthorityManagedMarker(db, A);
        for (const domain of DOMAINS) {
            db.prepare(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES (?, ?, 1, 1)",
            ).run(domain, B);
        }
        // Pending references exist only for memories.
        for (const project of [A, B]) {
            db.prepare(
                `INSERT INTO mirror_pending_references(domain, module_project, module_row_id, target_module_row_id)
                 VALUES ('memories', ?, 1, 2)`,
            ).run(project);
        }
        for (const [index, project] of [A, B].entries()) {
            db.prepare(
                "INSERT INTO mirror_note_revisions(module_project, module_row_id, context_row_id, status_version) VALUES (?, 1, ?, 1)",
            ).run(project, 100 + index);
        }
    }

    function mirrorRows(db: Database): unknown {
        return {
            identity: db
                .prepare("SELECT * FROM mirror_identity ORDER BY domain, module_project")
                .all(),
            pending: db
                .prepare("SELECT * FROM mirror_pending_references ORDER BY domain, module_project")
                .all(),
            revisions: db
                .prepare("SELECT * FROM mirror_note_revisions ORDER BY module_project")
                .all(),
            cursors: authorityRows(db),
        };
    }

    test("control: an unmarked project is reset and replayed", async () => {
        const db = freshDb();
        try {
            reconcileFixture(db);
            const fake = fakeModule({ states: { memories: "MODULE", notes: "MODULE" } });
            await reconcileAuthorityProject({ db, projectPath: A, module: fake.module });
            // Two eligible domains, one marker_status call each.
            expect(fake.counts.markerStatus).toBe(2);
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM mirror_pending_references WHERE module_project = ?",
                    )
                    .get(A),
            ).toEqual({ count: 0 });
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM mirror_note_revisions WHERE module_project = ?",
                    )
                    .get(A),
            ).toEqual({ count: 0 });
        } finally {
            closeQuietly(db);
        }
    });

    test("a marked project rejects before the reset and leaves every mirror row", async () => {
        const db = freshDb();
        try {
            reconcileFixture(db);
            mark(db, A);
            const before = mirrorRows(db);
            const fake = fakeModule({ states: { memories: "MODULE", notes: "MODULE" } });
            const error = await rejection(
                reconcileAuthorityProject({ db, projectPath: A, module: fake.module }),
            );
            expectTripwireError(error);
            expect(mirrorRows(db)).toEqual(before);
            expect(fake.counts).toMatchObject({
                markerStatus: 0,
                begin: 0,
                mirrorPull: 0,
                liveOnlyPull: 0,
            });
        } finally {
            closeQuietly(db);
        }
    });

    test("a refusing marker answer is taken before the reset; a skipped domain is not asked", async () => {
        const db = freshDb();
        try {
            reconcileFixture(db);
            // memories already has an identity row for A, so the shipped loop skips it.
            db.prepare(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', ?, 9, 9)",
            ).run(A);
            const before = mirrorRows(db);
            const fake = fakeModule({
                states: { memories: "MODULE", notes: "MODULE" },
                markerStatus: "refuse",
            });
            const error = await rejection(
                reconcileAuthorityProject({ db, projectPath: A, module: fake.module }),
            );
            expectTripwireError(error);
            expect(fake.counts.markerStatus).toBe(1);
            expect(fake.counts.mirrorPull).toBe(0);
            expect(mirrorRows(db)).toEqual(before);
        } finally {
            closeQuietly(db);
        }
    });

    test("a lane-less file runs the shipped reset, then meets the module refusal at mirror.pull", async () => {
        const db = freshDb();
        try {
            reconcileFixture(db);
            db.exec("DROP TABLE schema_migrations");
            const fake = fakeModule({
                states: { memories: "MODULE", notes: "MODULE" },
                pullRefuses: true,
            });
            const error = await rejection(
                reconcileAuthorityProject({ db, projectPath: A, module: fake.module }),
            );
            expectTripwireError(error);
            expect(fake.counts.markerStatus).toBe(0);
            expect(getMirrorCursor(db, "memories")).toBe(0);
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM mirror_pending_references WHERE module_project = ?",
                    )
                    .get(A),
            ).toEqual({ count: 0 });
            // Sibling B's rows survive the reset of A.
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM mirror_pending_references WHERE module_project = ?",
                    )
                    .get(B),
            ).toEqual({ count: 1 });
        } finally {
            closeQuietly(db);
        }
    });
});

describe("mirror pull paths single-store tripwire", () => {
    test("a marked project is refused before the resnapshot and any module call", async () => {
        for (const resnapshot of ["pending", "complete"] as const) {
            const db = freshDb();
            try {
                mark(db, A);
                setCursor(db, "memories", 3);
                if (resnapshot === "pending") pendingResnapshot(db);
                const before = resnapshotSnapshot(db);
                const fake = fakeModule();
                expectTripwireError(
                    await rejection(
                        drainMirrorPages({
                            db,
                            module: fake.module,
                            domain: "memories",
                            projectPath: A,
                        }),
                    ),
                );
                expectTripwireError(
                    await rejection(
                        pullMemoryMirrorOnce({ db, module: fake.module, projectPath: A }),
                    ),
                );
                expect(fake.counts.mirrorPull + fake.counts.markerStatus).toBe(0);
                expect(getMirrorCursor(db, "memories")).toBe(3);
                expect(resnapshotSnapshot(db)).toEqual(before);
            } finally {
                closeQuietly(db);
            }
        }
    });

    test("a refusing marker answer is asked once per page entered and moves nothing", async () => {
        const db = freshDb();
        try {
            setCursor(db, "memories", 3);
            pendingResnapshot(db);
            const before = resnapshotSnapshot(db);
            const fake = fakeModule({ markerStatus: "refuse" });
            expectTripwireError(
                await rejection(
                    drainMirrorPages({
                        db,
                        module: fake.module,
                        domain: "memories",
                        projectPath: B,
                    }),
                ),
            );
            expect(fake.counts.markerStatus).toBe(1);
            expectTripwireError(
                await rejection(pullMemoryMirrorOnce({ db, module: fake.module, projectPath: B })),
            );
            expect(fake.counts.markerStatus).toBe(2);
            expect(fake.counts.mirrorPull).toBe(0);
            expect(getMirrorCursor(db, "memories")).toBe(3);
            expect(resnapshotSnapshot(db)).toEqual(before);
        } finally {
            closeQuietly(db);
        }
    });

    test("an unmarked pull asks marker_status once per page, for either domain", async () => {
        for (const domain of DOMAINS) {
            const db = freshDb();
            try {
                let served = 0;
                const fake = fakeModule({
                    pages: (args) => {
                        served += 1;
                        return {
                            domain: args.domain,
                            cursor: args.cursor,
                            next_cursor: args.cursor + 1,
                            has_more: served < 3,
                            rows: [],
                        };
                    },
                });
                const result = await drainMirrorPages({
                    db,
                    module: fake.module,
                    domain,
                    projectPath: B,
                });
                expect(result).toMatchObject({ pagesPulled: 3, complete: true });
                expect(fake.counts.markerStatus).toBe(3);
                expect(new Set(fake.markerProjects)).toEqual(new Set([B]));
            } finally {
                closeQuietly(db);
            }
        }
    });

    test("ensureLiveMemoryResnapshot itself reads no marker and asks nothing", async () => {
        const db = freshDb();
        try {
            mark(db, A);
            const fake = fakeModule();
            await ensureLiveMemoryResnapshot({
                db,
                module: fake.module,
                limit: 10,
                projectPath: A,
            });
            expect(fake.counts.markerStatus + fake.counts.mirrorPull).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("an empty window of excluded rows is traversed by one unbudgeted drain", async () => {
        const db = freshDb();
        try {
            // What the module serves for unmarked B when marked A owns feed rows 1 and 2
            // and B and C own 3 and 4, at a page limit of 2.
            const note = (feedSeq: number, project: string) => ({
                feed_seq: feedSeq,
                domain: "notes" as const,
                op: "insert" as const,
                module_row_id: feedSeq,
                full_row_snapshot: {
                    project_path: project,
                    type: "session",
                    status: "active",
                    content: `note ${feedSeq}`,
                    session_id: "ses",
                },
                content_hash: null,
            });
            const windows: Record<number, ChangefeedPage> = {
                0: { domain: "notes", cursor: 0, next_cursor: 2, has_more: true, rows: [] },
                2: {
                    domain: "notes",
                    cursor: 2,
                    next_cursor: 4,
                    has_more: true,
                    rows: [note(3, B), note(4, C)],
                },
                4: { domain: "notes", cursor: 4, next_cursor: 4, has_more: false, rows: [] },
            };
            const fake = fakeModule({
                pages: (args) => windows[args.cursor] as ChangefeedPage,
            });
            const result = await drainMirrorPages({
                db,
                module: fake.module,
                domain: "notes",
                projectPath: B,
            });
            expect(result).toEqual({
                cursor: 4,
                pagesPulled: 3,
                rowsApplied: 2,
                complete: true,
                budgetExhausted: false,
            });
            expect(
                db.prepare("SELECT project_path FROM notes ORDER BY project_path").all(),
            ).toEqual([{ project_path: B }, { project_path: C }]);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("mirror flights", () => {
    test("callers on one client and database share a flight whatever their project", async () => {
        const db = freshDb();
        const second = freshDb();
        try {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const fake = fakeModule();
            const original = fake.module.mirrorPull;
            fake.module.mirrorPull = async (args) => {
                await gate;
                return original!(args);
            };
            const first = pullMemoryMirrorOnce({ db, module: fake.module, projectPath: B });
            const joined = pullMemoryMirrorOnce({ db, module: fake.module, projectPath: C });
            expect(joined).toBe(first);
            const otherDb = pullMemoryMirrorOnce({
                db: second,
                module: fake.module,
                projectPath: B,
            });
            expect(otherDb).not.toBe(first);

            mark(db, A);
            const refused = pullMemoryMirrorOnce({ db, module: fake.module, projectPath: A });
            expect(refused).not.toBe(first);
            await expect(refused).rejects.toMatchObject({
                code: "single_store_tripwire",
                retryable: false,
                state: "MODULE",
            });

            release();
            const [result, joinedResult] = await Promise.all([first, joined, otherDb]);
            expect(result).toMatchObject({ complete: true });
            expect(joinedResult).toBe(result);
        } finally {
            closeQuietly(db);
            closeQuietly(second);
        }
    });
});

describe("session start on a single-store project", () => {
    function sessionState() {
        return {
            initialized: false,
            consecutiveFailures: 0,
            passCount: 0,
            parked: false,
            passesSincePark: 0,
            warningSent: false,
            ordinalMemoAnchor: null,
            ordinalMemoStoredCount: null,
            ordinalMemoCanonicalCount: 0,
            seedPassPending: true,
            failureCount: 0,
            parkCount: 0,
            moduleGeneration: 0,
            lastAckedSeq: 0,
            lastAckedWatermarks: null,
            idOrdinalMemoGeneration: 0,
            idOrdinalMemo: new Map(),
            syntheticTurnCount: 0,
            lastObservedUserMessageId: null,
            syntheticLoopBreakerLogged: false,
            memoryAuthorityProject: null as string | null,
            memoryAuthorityRoot: null as string | null,
            memoryAuthorityReady: false,
        };
    }

    for (const variant of ["marked", "refusing marker answer"] as const) {
        test(`a DRAINING domain refuses once and names the tripwire (${variant})`, async () => {
            const db = freshDb();
            try {
                if (variant === "marked") mark(db, A);
                const calls = {
                    begin: 0,
                    prepare: 0,
                    seed: 0,
                    mirrorPull: 0,
                    markerStatus: 0,
                };
                const module: RustModeModuleClient = {
                    call: async () => ({ ok: true }),
                    authorityStatus: async (args) => ({
                        authority: {
                            context_store_uuid: "store",
                            project: A,
                            domain: args.domain,
                            state: args.domain === "memories" ? "DRAINING" : "MODULE",
                            generation: 3,
                            coordinator_token: "tok",
                            captured_upper_bound: 4,
                        },
                    }),
                    authorityPrepare: async () => {
                        calls.prepare += 1;
                        throw new Error("prepare must not run");
                    },
                    authoritySeed: async () => {
                        calls.seed += 1;
                        return { seeded: 0 };
                    },
                    authorityDrain: async () => {
                        calls.begin += 1;
                        throw new Error("the drain must not begin");
                    },
                    markerStatus: async () => {
                        calls.markerStatus += 1;
                        throw tripwireFromModule("single_store_fingerprint_mismatch");
                    },
                    mirrorPull: async () => {
                        calls.mirrorPull += 1;
                        throw new Error("mirror.pull must not run");
                    },
                };
                const error = await rejection(
                    __rustModeTransformTest.prepareRustMemoryAuthority({
                        db,
                        module,
                        projectPath: A,
                        projectRoot: "/worktrees/tripwire",
                        state: sessionState(),
                    }),
                );
                expect(error).toBeInstanceOf(MemoryAuthorityUnavailableError);
                const message = (error as Error).message;
                expect(message).toContain("single_store_tripwire");
                expect(message).not.toContain("the next scheduled transform will resume the drain");
                // One drainAuthority invocation: a marked project asks nothing, and a
                // refusing answer is asked exactly once (a retry would ask twice).
                expect(calls).toEqual({
                    begin: 0,
                    prepare: 0,
                    seed: 0,
                    mirrorPull: 0,
                    markerStatus: variant === "marked" ? 0 : 1,
                });
            } finally {
                closeQuietly(db);
            }
        });
    }
});

describe("module transport single-store mapping", () => {
    test("a tripwire-coded module refusal becomes a SingleStoreTripwireError; project is forwarded", async () => {
        const transport = new SubcModuleTransport("/nonexistent/connection.json");
        const bodies: unknown[] = [];
        let mode: "throw" | "record" | "ok" = "throw";
        (transport as unknown as { call: (args: { body: unknown }) => Promise<unknown> }).call =
            async (args) => {
                bodies.push(args.body);
                if (mode === "throw") {
                    throw Object.assign(new Error("project is marked single-store"), {
                        code: "single_store_tripwire",
                    });
                }
                if (mode === "record") {
                    return { code: "single_store_tripwire", message: "refused" };
                }
                return {
                    result: {
                        ok: true,
                        page: {
                            domain: "notes",
                            cursor: 0,
                            next_cursor: 0,
                            has_more: false,
                            rows: [],
                        },
                    },
                };
            };
        const request = {
            domain: "notes" as const,
            cursor: 0,
            limit: 10,
            project: A,
            projectRoot: "/route/root",
        };
        expectTripwireError(await rejection(transport.mirrorPull(request)));
        expectTripwireError(await rejection(transport.markerStatus({ project: A })));
        mode = "record";
        expectTripwireError(await rejection(transport.mirrorPull(request)));
        mode = "ok";
        await transport.mirrorPull(request);
        expect(await transport.markerStatus({ project: A })).toEqual({
            ok: true,
            marked: false,
            below_lane: false,
        });
        for (const body of bodies) {
            // The routing root is stripped; the project identity is carried verbatim.
            expect(body).toMatchObject({ project: A });
            expect(body).not.toHaveProperty("projectRoot");
        }
    });
});
