/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import type { Database as DatabaseType } from "../../shared/sqlite";
import { Database, withPrivilegedWriter } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    applyMirrorPage,
    ensureContextStoreUuid,
    installAuthorityManagedMarker,
} from "./context-authority";
import { getMemoriesByProject, insertMemory } from "./memory/storage-memory";
import { MIGRATIONS, runMigrations } from "./migrations";
import { recordSessionProjectIdentity } from "./session-project-storage";
import { initializeDatabase } from "./storage-db";
import { addNote, getSmartNotes } from "./storage-notes";

const PROJECT_PATH = "/armed-migration-replay";
const STATE_TABLE_PREDICATE =
    "COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0";
const MEMORY_REFUSAL = "context.db memory writes are managed by the Rust module";
const NOTE_REFUSAL = "context.db note writes are managed by the Rust module";
const GUARD_TRIGGERS = [
    "memories_authority_guard_insert",
    "memories_authority_guard_update",
    "memories_authority_guard_delete",
    "notes_authority_guard_insert",
    "notes_authority_guard_update",
    "notes_authority_guard_delete",
] as const;

interface ReplayState {
    armed: boolean;
    contextStoreUuid: string | null;
    expectedMemoryContents: Set<string>;
    expectedNoteContents: Set<string>;
    memoryMirrorCursor: number;
    nextModuleMemoryId: number;
}

function installMigrationLedgerFromSource(db: DatabaseType): void {
    // initializeDatabase + runMigrations is the same from-source baseline used by the
    // replay harness. Read the runner-owned ledger DDL from a scratch store rather than
    // duplicating that private schema here; a hand-written baseline would drift alongside
    // the migration list and could blame a future migration for a fixture omission.
    const source = new Database(":memory:");
    try {
        initializeDatabase(source);
        runMigrations(source);
        const row = source
            .prepare(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
            )
            .get() as { sql?: string } | null;
        if (!row?.sql) throw new Error("source migration runner did not create its ledger");
        db.exec(row.sql);
    } finally {
        closeQuietly(source);
    }
}

function applyExactlyOneMigration(db: DatabaseType, migration: (typeof MIGRATIONS)[number]): void {
    db.transaction(() => {
        migration.up(db);
        db.prepare(
            "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
        ).run(migration.version, migration.description, Date.now());
    }).immediate();
}

// Tables the populate arms CLAIM to fill by the end of the walk. Static on
// purpose: the per-step assertions compare against expectation sets maintained
// by the same arms that write, so an arm refactored into a no-op empties both
// sides together and stays green — the fence itself becomes the stale claim.
// This list is the independent side of that claim: it only changes when a
// human edits it, so a populate arm going quiet reddens the walk with the
// table's name instead of silently narrowing coverage.
// Both arms write the same two tables, so a per-table count would let one arm
// go quiet behind the other's rows (proved by a survived early-return mutant
// during construction). The claim is therefore per ARM: each arm's rows carry
// a distinctive content prefix, and each prefix must be present at walk end.
const CLAIMED_ARM_SIGNATURES = [
    { arm: "populateTsOwnedRows", table: "memories", like: "memory populated after v%" },
    { arm: "populateTsOwnedRows", table: "notes", like: "note populated after v%" },
    { arm: "populateModuleOwnedRows", table: "memories", like: "module memory populated after v%" },
    { arm: "populateModuleOwnedRows", table: "notes", like: "module note populated after v%" },
] as const;

function assertClaimedTablesNonEmpty(db: DatabaseType): void {
    for (const claim of CLAIMED_ARM_SIGNATURES) {
        const row = db
            .prepare(`SELECT COUNT(*) AS n FROM ${claim.table} WHERE content LIKE ?`)
            .get(claim.like) as { n: number };
        if (row.n === 0) {
            throw new Error(
                `${claim.table} carries no rows matching "${claim.like}" at end of the ` +
                    `step-through walk: no migration was tested against ${claim.arm}'s data — ` +
                    `that populate arm has stopped writing. Fix the arm (or, if the claim ` +
                    `itself changed, update CLAIMED_ARM_SIGNATURES deliberately).`,
            );
        }
    }
}

function assertPopulatedRowsLanded(db: DatabaseType, state: ReplayState): void {
    // Before v1 the unified notes table does not exist and there are no populated rows yet.
    if (state.expectedMemoryContents.size === 0 && state.expectedNoteContents.size === 0) return;

    expect(
        getMemoriesByProject(db, PROJECT_PATH)
            .map((memory) => memory.content)
            .sort(),
    ).toEqual([...state.expectedMemoryContents].sort());
    expect(
        getSmartNotes(db, PROJECT_PATH)
            .map((note) => note.content)
            .sort(),
    ).toEqual([...state.expectedNoteContents].sort());
}

function populateTsOwnedRows(
    db: DatabaseType,
    version: number,
    state: ReplayState,
    includeNote: boolean,
): void {
    const sessionId = `armed-replay-session-v${version}`;
    const memoryContent = `memory populated after v${version}`;

    recordSessionProjectIdentity(db, sessionId, PROJECT_PATH);
    insertMemory(db, {
        projectPath: PROJECT_PATH,
        category: "CONSTRAINTS",
        content: memoryContent,
        sourceSessionId: sessionId,
    });
    state.expectedMemoryContents.add(memoryContent);

    if (includeNote) {
        const noteContent = `note populated after v${version}`;
        addNote(db, "smart", {
            projectPath: PROJECT_PATH,
            sessionId,
            content: noteContent,
            surfaceCondition: "always",
        });
        state.expectedNoteContents.add(noteContent);
    }
}

function assertPrivilegeClosed(db: DatabaseType): void {
    expect(db.prepare("SELECT enabled FROM context_privilege_state WHERE id = 1").get()).toEqual({
        enabled: 0,
    });
}

function assertDurableAuthorityTriggers(db: DatabaseType): void {
    const actualNames = (
        db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%authority_guard%' ORDER BY name",
            )
            .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(
        actualNames,
        "new trigger added: arm it in the step-through fence before shipping",
    ).toEqual([...GUARD_TRIGGERS].sort());

    for (const name of GUARD_TRIGGERS) {
        const trigger = db
            .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
            .get(name) as { sql?: string } | null;
        expect(trigger?.sql).toContain(STATE_TABLE_PREDICATE);
        expect(trigger?.sql).not.toContain("mc_privileged_writer");
    }
}

function assertUnprivilegedWritesRefused(db: DatabaseType, version: number): void {
    // These statements are negative guard probes, never fixture population. The fixture's
    // successful rows are created only through the public storage and authority APIs.
    expect(() =>
        db
            .prepare(
                "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'CONSTRAINTS', ?, ?, 0, 0, 0, 0)",
            )
            .run(
                PROJECT_PATH,
                `blocked memory after v${version}`,
                `blocked-memory-hash-v${version}`,
            ),
    ).toThrow(MEMORY_REFUSAL);
    expect(() =>
        addNote(db, "smart", {
            projectPath: PROJECT_PATH,
            content: `blocked note after v${version}`,
            surfaceCondition: "always",
        }),
    ).toThrow(NOTE_REFUSAL);
}

function populateModuleOwnedRows(db: DatabaseType, version: number, state: ReplayState): void {
    if (!state.contextStoreUuid) throw new Error("armed replay has no context store identity");

    const memoryContent = `module memory populated after v${version}`;
    const noteContent = `module note populated after v${version}`;
    const nextCursor = state.memoryMirrorCursor + 1;
    applyMirrorPage({
        db,
        page: {
            domain: "memories",
            cursor: state.memoryMirrorCursor,
            next_cursor: nextCursor,
            has_more: false,
            rows: [
                {
                    feed_seq: nextCursor,
                    domain: "memories",
                    op: "insert",
                    module_row_id: state.nextModuleMemoryId,
                    content_hash: `module-memory-hash-v${version}`,
                    full_row_snapshot: {
                        context_store_uuid: state.contextStoreUuid,
                        project_path: PROJECT_PATH,
                        category: "CONSTRAINTS",
                        content: memoryContent,
                        normalized_hash: `module-memory-hash-v${version}`,
                        importance: 50,
                        scope: "project",
                        shareable: 0,
                        source_type: "historian",
                        seen_count: 1,
                        retrieval_count: 0,
                        first_seen_at: version,
                        created_at: version,
                        updated_at: version,
                        last_seen_at: version,
                        status: "active",
                        verification_status: "unverified",
                    },
                },
            ],
        },
    });
    withPrivilegedWriter(db, () => {
        addNote(db, "smart", {
            projectPath: PROJECT_PATH,
            content: noteContent,
            surfaceCondition: "always",
        });
    });

    state.memoryMirrorCursor = nextCursor;
    state.nextModuleMemoryId += 1;
    state.expectedMemoryContents.add(memoryContent);
    state.expectedNoteContents.add(noteContent);
    assertPrivilegeClosed(db);
    assertUnprivilegedWritesRefused(db, version);
}

function armAuthorityAtV71(db: DatabaseType, state: ReplayState): void {
    const contextStoreUuid = ensureContextStoreUuid(db);
    // One project marker arms both authority domains: all managed memories and both
    // project-owned and session-linked notes. context_privilege_state is only the writer
    // bracket; enabled=0 is the required state outside public privileged operations.
    installAuthorityManagedMarker(db, PROJECT_PATH, contextStoreUuid);
    state.armed = true;
    state.contextStoreUuid = contextStoreUuid;

    assertPrivilegeClosed(db);
    assertDurableAuthorityTriggers(db);
}

function populateForVersion(db: DatabaseType, version: number, state: ReplayState): void {
    switch (version) {
        case 1:
        case 2:
        case 3:
        case 4:
        case 5:
        case 6:
        case 7:
        case 8:
        case 9:
        case 10:
        case 11:
        case 12:
        case 13:
        case 14:
        case 15:
        case 16:
        case 17:
        case 18:
        case 19:
        case 20:
        case 21:
        case 22:
        case 23:
        case 24:
        case 25:
        case 26:
        case 27:
        case 28:
            // The public note writer is intentionally unused through v28: addNote writes
            // notes.harness (added in v7) and notes.anchor_ordinal (added in v29). Until both
            // columns exist, this arm populates only memories; inserting a note directly
            // would bypass and misrepresent the public storage contract.
            populateTsOwnedRows(db, version, state, false);
            return;
        case 29:
        case 30:
        case 31:
        case 32:
        case 33:
        case 34:
        case 35:
        case 36:
        case 37:
        case 38:
        case 39:
        case 40:
        case 41:
        case 42:
        case 43:
        case 44:
        case 45:
        case 46:
        case 47:
        case 48:
        case 49:
        case 50:
        case 51:
        case 52:
        case 53:
        case 54:
        case 55:
        case 56:
        case 57:
        case 58:
        case 59:
        case 60:
        case 61:
        case 62:
        case 63:
        case 64:
        case 65:
        case 66:
        case 67:
        case 68:
        case 69:
        case 70:
            populateTsOwnedRows(db, version, state, true);
            return;
        case 71:
            populateTsOwnedRows(db, version, state, true);
            armAuthorityAtV71(db, state);
            populateModuleOwnedRows(db, version, state);
            return;
        case 72:
        case 73:
        case 74:
        case 75:
        case 76:
        case 77:
        case 78:
        case 79:
        case 80:
        case 81:
        case 82:
            if (!state.armed) throw new Error(`migration v${version} reached an unarmed store`);
            populateModuleOwnedRows(db, version, state);
            return;
        default:
            throw new Error(`populateForVersion has no arm for migration v${version}`);
    }
}

/*
 * This step-through is deliberately not folded into the existing v54 armed replay or
 * either schema-convergence guard. The v54 leg proves that a legacy replay batch
 * reinstalls the latest triggers, while the convergence guards prove schema/version
 * visibility. Neither executes each next migration against rows populated after the
 * preceding version. Keeping those orthogonal claims separate prevents one green probe
 * from being mistaken for the populated-and-armed migration fence.
 *
 * Discriminating mutation record (2026-08-17; both mutants were removed):
 *
 * 1. Appended a temporary migration at the then-current end of MIGRATIONS. Its data
 *    mover used getNotes/updateNote to update the first populated smart note; the
 *    temporary populate arm prevented the exhaustive-helper alarm from masking this property. `bun run typecheck` passed,
 *    and the existing empty-store authority controls stayed green (4 pass, 0 fail):
 *    `bun test src/features/magic-context/migrations-v71.test.ts`.
 *    This fence alone went red with the guarded migration write:
 *    `SQLiteError: context.db note writes are managed by the Rust module`.
 *
 * 2. Added an idempotent inert trigger to v78:
 *    `AFTER INSERT ON notes BEGIN SELECT 1; END`. `bun run typecheck` passed, and the
 *    same empty-store controls stayed green (4 pass, 0 fail). This fence alone went red:
 *    `new trigger added: arm it in the step-through fence before shipping`, listing
 *    `inert_authority_guard` as the sole extra trigger. The inert body is intentional:
 *    a RAISE trigger would create unrelated failures and would not discriminate the
 *    trigger-set expiry obligation.
 */
test("every migration lands on populated rows and v72+ stores stay armed", () => {
    const testDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    if (!testDataDir || !isAbsolute(testDataDir)) {
        throw new Error("MAGIC_CONTEXT_TEST_DATA_DIR must be an absolute test-only path");
    }

    const db = new Database(":memory:");
    const state: ReplayState = {
        armed: false,
        contextStoreUuid: null,
        expectedMemoryContents: new Set(),
        expectedNoteContents: new Set(),
        memoryMirrorCursor: 0,
        nextModuleMemoryId: 1,
    };

    try {
        initializeDatabase(db);
        installMigrationLedgerFromSource(db);

        for (const [index, migration] of MIGRATIONS.entries()) {
            expect(migration.version).toBe(index + 1);
            assertPopulatedRowsLanded(db, state);
            applyExactlyOneMigration(db, migration);
            populateForVersion(db, migration.version, state);
        }

        assertPopulatedRowsLanded(db, state);
        assertClaimedTablesNonEmpty(db);
        assertPrivilegeClosed(db);
        assertDurableAuthorityTriggers(db);
        expect(state.armed).toBe(true);
        expect(() => populateForVersion(db, Number.MAX_SAFE_INTEGER, state)).toThrow(
            "populateForVersion has no arm",
        );
    } finally {
        closeQuietly(db);
    }
});
