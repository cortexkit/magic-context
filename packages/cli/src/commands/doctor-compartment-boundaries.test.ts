import { describe, expect, it } from "bun:test";
import {
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { Database } from "@magic-context/core/shared/sqlite";
import {
    countDanglingCompartmentBoundariesBySession,
    DANGLING_BOUNDARY_EXAMPLE_LIMIT,
    type DanglingCompartmentBoundary,
    formatDanglingCompartmentBoundary,
    formatDanglingCompartmentBoundaryDetails,
    formatDanglingCompartmentBoundaryHeadline,
    listDanglingCompartmentBoundaries,
} from "./doctor-compartment-boundaries";

function contextDatabase(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    db.prepare(
        "INSERT INTO session_meta (session_id, harness) VALUES ('ses-live', 'opencode'), ('ses-pi', 'pi')",
    ).run();
    db.prepare(
        `INSERT INTO compartments
            (session_id, sequence, start_message, end_message, start_message_id,
             end_message_id, title, content, created_at)
         VALUES
            ('ses-live', 0, 1, 2, 'm1', 'm2', 'ok', 'ok', 1),
            ('ses-live', 1, 3, 4, 'missing-start', 'm4', 'bad start', 'bad', 1),
            ('ses-live', 2, 5, 6, 'm5', 'missing-end', 'bad end', 'bad', 1),
            ('ses-pi', 0, 1, 1, 'pi-entry', 'pi-entry', 'pi', 'pi', 1)`,
    ).run();
    return db;
}

function v1Store(): Database {
    const db = new Database(":memory:");
    db.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL);",
    );
    const insert = db.prepare("INSERT INTO message (id, session_id) VALUES (?, 'ses-live')");
    for (const id of ["m1", "m2", "m4", "m5"]) insert.run(id);
    return db;
}

function v2Store(): Database {
    const db = new Database(":memory:");
    db.exec(
        "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE session_v2 (id TEXT PRIMARY KEY)",
    );
    const insert = db.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, data) VALUES (?, 'ses-live', 'user', ?, '{}')",
    );
    for (const [index, id] of ["m1", "m2", "m4", "m5"].entries()) insert.run(id, index);
    return db;
}

// A 1.18.x store that OpenCode 2 migrated: the v1 `message` table is kept but frozen at the
// migration point (here holding only m1), while session_message holds every id the host serves.
function migratedV2Store(): Database {
    const db = v2Store();
    db.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL);",
    );
    db.prepare("INSERT INTO message (id, session_id) VALUES ('m1', 'ses-live')").run();
    return db;
}

// OpenCode 2 is running, but migration has not created session_v2 yet. OpenCode 1.18.x
// already had session_message, so that table can contain less history than the live message table.
function preMigrationV2HostStore(): Database {
    const db = v1Store();
    db.exec(
        "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL)",
    );
    db.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, data) VALUES ('m1', 'ses-live', 'user', 0, '{}')",
    ).run();
    return db;
}

// The reverse: OpenCode 2 touched this store (session_v2 exists, session_message frozen at m1),
// then an OpenCode 1.x host kept writing to `message`.
function downgradedV1Store(): Database {
    const db = v1Store();
    db.exec(
        "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE session_v2 (id TEXT PRIMARY KEY);",
    );
    db.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, data) VALUES ('m1', 'ses-live', 'user', 0, '{}')",
    ).run();
    return db;
}

const expectedDanglingBoundaries = [
    {
        sessionId: "ses-live",
        sequence: 1,
        missingStartMessageId: "missing-start",
        missingEndMessageId: null,
        sessionInStore: true,
    },
    {
        sessionId: "ses-live",
        sequence: 2,
        missingStartMessageId: null,
        missingEndMessageId: "missing-end",
        sessionInStore: true,
    },
];

function expectResolvedLiveStore(
    makeStore: () => Database,
    hostGeneration?: "v1" | "v2",
    onDiagnostic?: (line: string) => void,
): void {
    const context = contextDatabase();
    const store = makeStore();
    try {
        const dangling = listDanglingCompartmentBoundaries(
            context,
            store,
            hostGeneration,
            onDiagnostic,
        );
        expect(dangling).toEqual(expectedDanglingBoundaries);
        expect(formatDanglingCompartmentBoundary(dangling[0]!)).toBe(
            "session=ses-live sequence=1 missing start_message_id=missing-start",
        );
    } finally {
        context.close();
        store.close();
    }
}

describe("doctor dangling compartment boundary check", () => {
    it("uses session_message for a known v2 host after migration", () => {
        expectResolvedLiveStore(migratedV2Store, "v2");
    });

    it("uses message and reports the known-v2 pre-migration window", () => {
        const diagnostics: string[] = [];
        expectResolvedLiveStore(preMigrationV2HostStore, "v2", (line) => diagnostics.push(line));
        expect(diagnostics).toEqual([
            "Compartment boundary check: OpenCode 2 pre-migration window; using message table",
        ]);
    });

    it("heuristically uses session_message for a migrated Desktop store", () => {
        expectResolvedLiveStore(migratedV2Store);
    });

    it("uses message for a known v1 host after downgrade", () => {
        expectResolvedLiveStore(downgradedV1Store, "v1");
    });

    it("uses message for an unknown host without a populated migrated-v2 schema", () => {
        expectResolvedLiveStore(v1Store);
    });

    it("uses session_message for a native v2 store", () => {
        expectResolvedLiveStore(v2Store);
    });
});

/** `perSession` dangling compartments in each of `sessions` sessions, the last one absent from the store. */
function manyDangling(sessions: number, perSession: number): DanglingCompartmentBoundary[] {
    const boundaries: DanglingCompartmentBoundary[] = [];
    for (let session = 0; session < sessions; session++) {
        // Give each session a distinct count so the ordering is observable.
        for (let sequence = 0; sequence < perSession + session; sequence++) {
            boundaries.push({
                sessionId: `ses-${String(session).padStart(3, "0")}`,
                sequence,
                missingStartMessageId: `ccm-${sequence}`,
                missingEndMessageId: `ccm-${sequence + 16}`,
                sessionInStore: session !== sessions - 1,
            });
        }
    }
    return boundaries;
}

describe("doctor dangling compartment boundary listing", () => {
    it("reports a session with no messages in the store", () => {
        const context = contextDatabase();
        context
            .prepare(
                `INSERT INTO compartments
                    (session_id, sequence, start_message, end_message, start_message_id,
                     end_message_id, title, content, created_at)
                 VALUES ('ses-gone', 0, 1, 2, 'ccm-0', 'ccm-16', 'gone', 'gone', 1)`,
            )
            .run();
        const store = v1Store();
        try {
            const dangling = listDanglingCompartmentBoundaries(context, store, "v1");
            expect(dangling.find((boundary) => boundary.sessionId === "ses-gone")).toEqual({
                sessionId: "ses-gone",
                sequence: 0,
                missingStartMessageId: "ccm-0",
                missingEndMessageId: "ccm-16",
                sessionInStore: false,
            });
        } finally {
            context.close();
            store.close();
        }
    });

    it("caps the listing at a summary by session plus a few examples", () => {
        const boundaries = manyDangling(90, 200);
        const lines = formatDanglingCompartmentBoundaryDetails(boundaries);

        const sessionLines = lines.filter(
            (line) => line.startsWith("  session=ses-") && line.includes(": "),
        );
        const exampleLines = lines.filter((line) => line.includes(" sequence="));
        expect(sessionLines).toHaveLength(DANGLING_BOUNDARY_EXAMPLE_LIMIT);
        expect(exampleLines).toHaveLength(DANGLING_BOUNDARY_EXAMPLE_LIMIT);
        expect(lines.length).toBeLessThanOrEqual(2 * DANGLING_BOUNDARY_EXAMPLE_LIMIT + 5);
        // Largest session first, and the one absent from the store is labelled.
        expect(sessionLines[0]).toBe(
            "  session=ses-089: 289 compartment(s) (session has no messages in this store)",
        );
        expect(sessionLines[1]).toBe("  session=ses-088: 288 compartment(s)");
        expect(lines).toContain(`By session (largest 10 of 90):`);
        expect(lines).toContain(`  … and 80 more session(s)`);
        expect(lines).toContain(`Examples (10 of ${boundaries.length}):`);
        expect(lines.at(-1)).toBe(
            `Run \`magic-context doctor --verbose\` for the full list of ${boundaries.length} compartment(s).`,
        );
    });

    it("prints every session and compartment with --verbose", () => {
        const boundaries = manyDangling(90, 200);
        const lines = formatDanglingCompartmentBoundaryDetails(boundaries, { verbose: true });

        const exampleLines = lines.filter((line) => line.includes(" sequence="));
        expect(exampleLines).toEqual(
            boundaries.map((boundary) => `  ${formatDanglingCompartmentBoundary(boundary)}`),
        );
        expect(countDanglingCompartmentBoundariesBySession(boundaries)).toHaveLength(90);
        expect(
            lines.filter((line) => line.startsWith("  session=ses-") && line.includes(": ")),
        ).toHaveLength(90);
        expect(lines.some((line) => line.includes("--verbose"))).toBe(false);
        expect(lines.some((line) => line.includes("more session(s)"))).toBe(false);
    });

    it("prints a short listing in full without a --verbose hint", () => {
        const boundaries = manyDangling(2, 1);
        const lines = formatDanglingCompartmentBoundaryDetails(boundaries);
        expect(lines).toEqual([
            "By session:",
            "  session=ses-001: 2 compartment(s) (session has no messages in this store)",
            "  session=ses-000: 1 compartment(s)",
            "Compartments:",
            "  session=ses-000 sequence=0 missing start_message_id=ccm-0 end_message_id=ccm-16",
            "  session=ses-001 sequence=0 missing start_message_id=ccm-0 end_message_id=ccm-16",
            "  session=ses-001 sequence=1 missing start_message_id=ccm-1 end_message_id=ccm-17",
        ]);
    });

    it("says in the headline whether the user has to act", () => {
        const boundaries = manyDangling(90, 200);
        const converted = formatDanglingCompartmentBoundaryHeadline(boundaries, "opencode2");
        expect(converted).toStartWith(
            `Informational, no action needed: ${boundaries.length} compartment(s) in 90 session(s) point at OpenCode message ids`,
        );
        expect(converted).toContain("1 of those session(s) have no messages in this store at all");
        expect(formatDanglingCompartmentBoundaryHeadline(boundaries, "other")).toStartWith(
            `${boundaries.length} compartment(s) in 90 session(s) have dangling OpenCode boundary ids.`,
        );
    });
});
