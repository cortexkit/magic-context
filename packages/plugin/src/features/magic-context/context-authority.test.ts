import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, withPrivilegedWriter } from "../../shared/sqlite";
import type { AuthorityModuleClient, AuthorityStatus, ChangefeedPage } from "./context-authority";
import {
    applyMirroredNoteCompileFields,
    applyMirrorPage,
    bumpDomainMutationEpoch,
    drainAuthority,
    ensureContextStoreUuid,
    ensureLiveMemoryResnapshot,
    getAuthorityManagedMarker,
    getModuleNoteEvaluationBridge,
    installAuthorityManagedMarker,
    prepareAuthority,
    pullAndApplyMirrorPage,
    reconcileAuthorityProject,
    registerModuleNoteEvaluationBridge,
} from "./context-authority";
import { getMemoriesByProjects, insertMemory, isMemoryRow } from "./memory/storage-memory";
import { getMemoryVerifications } from "./memory/storage-memory-verifications";
import { runMigrations } from "./migrations";
import { resolveMemoriesByIdsForSearch, unifiedSearch } from "./search";
import { initializeDatabase } from "./storage-db";

function db(): Database {
    const value = new Database(":memory:");
    initializeDatabase(value);
    runMigrations(value);
    return value;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function authority(state: AuthorityStatus["state"], generation: number): AuthorityStatus {
    return { context_store_uuid: "store", project: "/repo", domain: "memories", state, generation };
}

function protocol(seedCalls: { bytes: number[] }): AuthorityModuleClient {
    let generation = 1;
    return {
        authorityStatus: async () => ({ authority: null }),
        authorityPrepare: async (args) => {
            if (args.phase === "begin") return { authority: authority("PREPARING", generation) };
            if (args.phase === "abort") return { authority: authority("TS", ++generation) };
            if (args.phase === "ack") return { authority: authority("MODULE", ++generation) };
            return {
                authority: {
                    ...authority("PREPARING", generation),
                    checksum_expected: String(args.checksum_expected),
                    checksum_actual: String(args.checksum_expected),
                    checksum_ok: 1,
                },
            };
        },
        authoritySeed: async (args) => {
            seedCalls.bytes.push(new TextEncoder().encode(JSON.stringify(args.rows)).byteLength);
            return { seeded: Array.isArray(args.rows) ? args.rows.length : 0, module_row_ids: [] };
        },
        mirrorPull: async (args) => ({
            page: {
                domain: args.domain,
                cursor: args.cursor,
                next_cursor: args.cursor,
                has_more: false,
                rows: [],
            },
        }),
    };
}

describe("memory authority protocol", () => {
    test("mirror sync installs the module's content-bound evidence set", () => {
        const database = db();
        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 9,
                        full_row_snapshot: {
                            project_path: "/repo",
                            category: "CONSTRAINTS",
                            content: "Mirrored fact",
                            normalized_hash: "fact-hash",
                            evidence: [
                                {
                                    content_hash: "fact-hash",
                                    source_session_id: "session-a",
                                    source_message_id: "assistant-a1",
                                    source_type: "agent",
                                    observed_at: 11,
                                },
                            ],
                        },
                        content_hash: "fact-hash",
                    },
                ],
            },
        });

        expect(
            database
                .prepare(
                    "SELECT content_hash, source_session_id, source_message_id, source_type FROM memory_evidence",
                )
                .get(),
        ).toEqual({
            content_hash: "fact-hash",
            source_session_id: "session-a",
            source_message_id: "assistant-a1",
            source_type: "agent",
        });
    });

    test("sparse evidence snapshots preserve evidence while explicit empty snapshots clear it", () => {
        const database = db();
        const snapshot = (feedSeq: number, evidence?: readonly Record<string, unknown>[]) => ({
            feed_seq: feedSeq,
            domain: "memories" as const,
            op: "update" as const,
            module_row_id: 9,
            full_row_snapshot: {
                project_path: "/repo",
                category: "CONSTRAINTS",
                content: "Mirrored fact",
                normalized_hash: "fact-hash",
                ...(evidence === undefined ? {} : { evidence }),
            },
            content_hash: "fact-hash",
        });
        const apply = (feedSeq: number, evidence?: readonly Record<string, unknown>[]) =>
            applyMirrorPage({
                db: database,
                page: {
                    domain: "memories",
                    cursor: feedSeq - 1,
                    next_cursor: feedSeq,
                    has_more: false,
                    rows: [snapshot(feedSeq, evidence)],
                },
            });

        apply(1, [
            {
                content_hash: "fact-hash",
                source_session_id: "session-a",
                source_message_id: "assistant-a1",
                source_type: "agent",
                observed_at: 11,
            },
        ]);
        apply(2);
        expect(database.prepare("SELECT COUNT(*) AS count FROM memory_evidence").get()).toEqual({
            count: 1,
        });

        apply(3, []);
        expect(database.prepare("SELECT COUNT(*) AS count FROM memory_evidence").get()).toEqual({
            count: 0,
        });
    });

    test("historical sparse note feed rows preserve rich local columns", () => {
        const database = db();
        const localStoreUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    `INSERT INTO notes (id, type, status, content, project_path, session_id,
                     manifest_json, compiled_check, check_status, check_version, policy_version,
                     created_at, updated_at)
                     VALUES (41, 'smart', 'ready', 'rich note', '/repo', 'session',
                     '{"condition":"pr"}', 'compiled', 'compiled', 7, 3, 100, 200)`,
                )
                .run();
        });
        applyMirrorPage({
            db: database,
            page: {
                domain: "notes",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "notes",
                        op: "insert",
                        module_row_id: 9,
                        full_row_snapshot: {
                            context_store_uuid: localStoreUuid,
                            context_row_id: 41,
                            project_path: "/repo",
                            session_id: "session",
                            content: "updated by module",
                            status: "active",
                            updated_at_ms: 300,
                        },
                        content_hash: null,
                    },
                ],
            },
        });
        expect(
            database
                .prepare(
                    "SELECT content, manifest_json, compiled_check, check_version, policy_version FROM notes WHERE id = 41",
                )
                .get(),
        ).toEqual({
            content: "updated by module",
            manifest_json: '{"condition":"pr"}',
            compiled_check: "compiled",
            check_version: 7,
            policy_version: 3,
        });
    });

    test("repeated note drains replace a re-minted module row for the same context note", async () => {
        const database = db();
        const contextStoreUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO notes (id, type, status, content, project_path, session_id, created_at, updated_at) VALUES (41, 'smart', 'active', 'local note', '/repo', 'session', 10, 20)",
                )
                .run();
        });
        installAuthorityManagedMarker(database, "/repo");

        let feedSeq = 1;
        let moduleRowId = 9;
        let statusVersion = 1;
        let state: AuthorityStatus["state"] = "MODULE";
        const module: AuthorityModuleClient = {
            authorityStatus: async (args) => ({
                authority: {
                    ...authority(args.domain === "notes" ? state : "TS", 1),
                    domain: args.domain,
                },
            }),
            authorityPrepare: async () => ({ authority: authority("MODULE", 1) }),
            authorityDrain: async (args) => {
                state = args.action === "finish" ? "TS" : "DRAINING";
                return {
                    authority: {
                        ...authority(state, 1),
                        domain: args.domain,
                        captured_upper_bound: feedSeq,
                        coordinator_token: "note-drain-token",
                    },
                };
            },
            mirrorPull: async (args) => ({
                page: {
                    domain: "notes",
                    cursor: args.cursor,
                    next_cursor: feedSeq,
                    has_more: false,
                    rows:
                        args.cursor < feedSeq
                            ? [
                                  {
                                      feed_seq: feedSeq,
                                      domain: "notes",
                                      op: "insert",
                                      module_row_id: moduleRowId,
                                      full_row_snapshot: {
                                          context_store_uuid: contextStoreUuid,
                                          context_row_id: 41,
                                          project_path: "/repo",
                                          session_id: "session",
                                          content: `module note revision ${statusVersion}`,
                                          status: "active",
                                          status_version: statusVersion,
                                          created_at_ms: 10,
                                          updated_at_ms: 20 + statusVersion,
                                      },
                                      content_hash: null,
                                  },
                              ]
                            : [],
                },
            }),
        };

        await drainAuthority({
            db: database,
            projectPath: "/repo",
            domain: "notes",
            module,
            checksum: "same",
        });

        moduleRowId = 10;
        feedSeq = 2;
        statusVersion = 2;
        state = "MODULE";
        installAuthorityManagedMarker(database, "/repo");
        await expect(
            drainAuthority({
                db: database,
                projectPath: "/repo",
                domain: "notes",
                module,
                checksum: "same",
            }),
        ).resolves.toMatchObject({ state: "TS" });

        expect(
            database
                .prepare(
                    "SELECT module_project, module_row_id, context_row_id, status_version FROM mirror_note_revisions",
                )
                .all(),
        ).toEqual([
            {
                module_project: "/repo",
                module_row_id: 10,
                context_row_id: 41,
                status_version: 2,
            },
        ]);
        expect(
            database
                .prepare(
                    "SELECT module_row_id, context_row_id FROM mirror_identity WHERE domain = 'notes'",
                )
                .all(),
        ).toEqual([{ module_row_id: 10, context_row_id: 41 }]);
        database.close();
    });

    test("foreign-store note ids allocate a fresh row without clobbering a local collision", () => {
        const database = db();
        const localStoreUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO notes (id, type, status, content, project_path, session_id, created_at, updated_at) VALUES (41, 'smart', 'ready', 'local note', '/repo', 'local-session', 10, 20)",
                )
                .run();
        });

        applyMirrorPage({
            db: database,
            page: {
                domain: "notes",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "notes",
                        op: "insert",
                        module_row_id: 9,
                        full_row_snapshot: {
                            context_store_uuid: `${localStoreUuid}-foreign`,
                            context_row_id: 41,
                            project_path: "/repo",
                            session_id: "foreign-session",
                            content: "foreign note",
                            status: "active",
                            compiled_provider: "local-fs",
                            compiled_config: '{"kind":"path_exists","path":"/tmp/result"}',
                            compiled_at: 35,
                            compile_status: "compiled",
                            created_at_ms: 30,
                            updated_at_ms: 40,
                        },
                        content_hash: null,
                    },
                ],
            },
        });

        expect(
            database
                .prepare(
                    `SELECT id, content, session_id, compiled_provider, compiled_config,
                            compiled_at, compile_status
                       FROM notes ORDER BY id`,
                )
                .all(),
        ).toEqual([
            {
                id: 41,
                content: "local note",
                session_id: "local-session",
                compiled_provider: null,
                compiled_config: null,
                compiled_at: null,
                compile_status: null,
            },
            {
                id: 42,
                content: "foreign note",
                session_id: "foreign-session",
                compiled_provider: "local-fs",
                compiled_config: '{"kind":"path_exists","path":"/tmp/result"}',
                compiled_at: 35,
                compile_status: "compiled",
            },
        ]);
        expect(
            database
                .prepare(
                    "SELECT context_row_id FROM mirror_identity WHERE domain = 'notes' AND module_project = '/repo' AND module_row_id = 9",
                )
                .get(),
        ).toEqual({ context_row_id: 42 });
    });

    test("attaches host compilation metadata to a mirrored module note", () => {
        const database = db();
        applyMirrorPage({
            db: database,
            page: {
                domain: "notes",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "notes",
                        op: "insert",
                        module_row_id: 12,
                        full_row_snapshot: {
                            project_path: "/repo",
                            session_id: "session",
                            content: "guard secret",
                            surface_condition: "when path /tmp/project-binding-key exists",
                            status: "pending",
                            created_at_ms: 10,
                            updated_at_ms: 10,
                        },
                        content_hash: null,
                    },
                ],
            },
        });

        expect(
            applyMirroredNoteCompileFields({
                db: database,
                moduleProject: "/repo",
                moduleRowId: 12,
                fields: {
                    compiledProvider: null,
                    compiledConfig: null,
                    compiledAt: null,
                    compileStatus: "refused",
                },
            }),
        ).toBe(true);
        expect(
            database
                .prepare("SELECT compile_status FROM notes WHERE content = 'guard secret'")
                .get(),
        ).toEqual({ compile_status: "refused" });
    });

    test("matching-store note ids reuse the source row and mapped tombstones remove it", () => {
        const database = db();
        const localStoreUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO notes (id, type, status, content, project_path, session_id, created_at, updated_at) VALUES (51, 'smart', 'active', 'before mirror', '/repo', 'session', 10, 20)",
                )
                .run();
        });
        const snapshot = {
            context_store_uuid: localStoreUuid,
            context_row_id: 51,
            project_path: "/repo",
            session_id: "session",
            content: "after mirror",
            status: "ready",
            created_at_ms: 10,
            updated_at_ms: 30,
        };

        applyMirrorPage({
            db: database,
            page: {
                domain: "notes",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "notes",
                        op: "update",
                        module_row_id: 11,
                        full_row_snapshot: snapshot,
                        content_hash: null,
                    },
                ],
            },
        });

        expect(database.prepare("SELECT id, content FROM notes").all()).toEqual([
            { id: 51, content: "after mirror" },
        ]);
        expect(
            database
                .prepare(
                    "SELECT context_row_id FROM mirror_identity WHERE domain = 'notes' AND module_project = '/repo' AND module_row_id = 11",
                )
                .get(),
        ).toEqual({ context_row_id: 51 });

        applyMirrorPage({
            db: database,
            page: {
                domain: "notes",
                cursor: 1,
                next_cursor: 2,
                has_more: false,
                rows: [
                    {
                        feed_seq: 2,
                        domain: "notes",
                        op: "tombstone",
                        module_row_id: 11,
                        full_row_snapshot: snapshot,
                        content_hash: null,
                    },
                ],
            },
        });

        expect(database.prepare("SELECT COUNT(*) AS count FROM notes").get()).toEqual({ count: 0 });
        expect(
            database
                .prepare(
                    "SELECT COUNT(*) AS count FROM mirror_identity WHERE domain = 'notes' AND module_project = '/repo' AND module_row_id = 11",
                )
                .get(),
        ).toEqual({ count: 0 });
    });

    test("mapping feed rows round-trip into the verification side table", () => {
        const database = db();
        const storeUuid = ensureContextStoreUuid(database);
        const contextMemory = insertMemory(database, {
            projectPath: "/repo",
            category: "CONSTRAINTS",
            content: "mapped memory",
            sourceSessionId: "session",
            sourceType: "dreamer",
        });
        const page: ChangefeedPage = {
            domain: "memories",
            cursor: 0,
            next_cursor: 1,
            has_more: false,
            rows: [
                {
                    feed_seq: 1,
                    domain: "memories",
                    op: "update",
                    module_row_id: 41,
                    content_hash: "module-hash",
                    full_row_snapshot: {
                        id: 41,
                        project_path: "/repo",
                        category: "CONSTRAINTS",
                        content: "mapped memory",
                        normalized_hash: "module-hash",
                        status: "active",
                        verified_at: 1234,
                        mapping: ["src/lib.rs", "src/lib.rs"],
                        context_store_uuid: storeUuid,
                        context_row_id: contextMemory.id,
                    },
                },
            ],
        };
        applyMirrorPage({ db: database, page });
        const verification = getMemoryVerifications(database, [contextMemory.id]).get(
            contextMemory.id,
        );
        expect(verification?.files).toEqual(["src/lib.rs"]);
        expect(verification?.verifiedAt).toBe(1234);

        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 1,
                next_cursor: 2,
                has_more: false,
                rows: [
                    {
                        ...page.rows[0]!,
                        feed_seq: 2,
                        full_row_snapshot: {
                            ...page.rows[0]!.full_row_snapshot,
                            mapping: null,
                            verified_at: 2000,
                        },
                    },
                ],
            },
        });
        expect(getMemoryVerifications(database, [contextMemory.id]).has(contextMemory.id)).toBe(
            false,
        );
    });
    test("preserves source metadata across the historical 9397 mapping sequence", () => {
        const database = db();
        const storeUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    `INSERT INTO memories(
                        id, project_path, category, content, normalized_hash, importance, scope, shareable,
                        source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at,
                        last_seen_at, status, verification_status
                     ) VALUES (9397, '/repo', 'CONSTRAINTS', 'rig memory', 'rig-hash', 66, 'project', 0,
                               'agent', 1, 0, 1, 1, 1, 1, 'active', 'unverified')`,
                )
                .run();
        });
        const fullSnapshot = {
            id: 9397,
            project_path: "/repo",
            category: "CONSTRAINTS",
            content: "rig memory",
            normalized_hash: "rig-hash",
            importance: 66,
            scope: "project",
            shareable: 0,
            source_session_id: null,
            source_type: "agent",
            seen_count: 1,
            retrieval_count: 0,
            first_seen_at: 1,
            created_at: 1,
            updated_at: 1,
            last_seen_at: 1,
            last_retrieved_at: null,
            status: "active",
            expires_at: null,
            verification_status: "unverified",
            verified_at: null,
            classified_at: null,
            superseded_by_memory_id: null,
            merged_from: null,
            metadata_json: null,
            context_store_uuid: storeUuid,
            context_row_id: 9397,
        };
        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1321,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1321,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 9397,
                        full_row_snapshot: fullSnapshot,
                        content_hash: "rig-hash",
                    },
                ],
            },
        });
        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 1321,
                next_cursor: 1322,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1322,
                        domain: "memories",
                        op: "update",
                        module_row_id: 9397,
                        full_row_snapshot: {
                            id: 9397,
                            project_path: "/repo",
                            category: "CONSTRAINTS",
                            content: "rig memory",
                            normalized_hash: "rig-hash",
                            status: "active",
                            mapping: ["src/lib.rs"],
                        },
                        content_hash: "rig-hash",
                    },
                ],
            },
        });
        const memories = getMemoriesByProjects(database, ["/repo"]);
        expect(memories).toHaveLength(1);
        expect(memories[0]?.sourceType).toBe("agent");
        expect(memories[0]?.importance).toBe(66);
        expect(isMemoryRow(memories[0])).toBe(true);
    });

    test("heals pre-clobbered source metadata from the retained live snapshot", () => {
        const database = db();
        const storeUuid = ensureContextStoreUuid(database);
        installAuthorityManagedMarker(database, "/repo", storeUuid);
        const snapshot = {
            id: 9397,
            project_path: "/repo",
            category: "CONSTRAINTS",
            content: "rig memory",
            normalized_hash: "rig-hash",
            importance: 66,
            scope: "project",
            shareable: 0,
            source_session_id: null,
            source_type: "agent",
            seen_count: 1,
            retrieval_count: 0,
            first_seen_at: 1,
            created_at: 1,
            updated_at: 1,
            last_seen_at: 1,
            last_retrieved_at: null,
            status: "active",
            expires_at: null,
            verification_status: "unverified",
            verified_at: null,
            classified_at: null,
            superseded_by_memory_id: null,
            merged_from: null,
            metadata_json: null,
            context_store_uuid: storeUuid,
            context_row_id: 9397,
        };
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    `INSERT INTO memories(
                        id, project_path, category, content, normalized_hash, importance, source_type,
                        first_seen_at, created_at, updated_at, last_seen_at
                     ) VALUES (9397, '/repo', 'CONSTRAINTS', 'rig memory', 'rig-hash', NULL, NULL, 1, 1, 1, 1)`,
                )
                .run();
            database
                .prepare(
                    "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', '/repo', 9397, 9397)",
                )
                .run();
            database
                .prepare(
                    "INSERT INTO mirror_live_memory_rows(module_project, module_row_id, category, normalized_hash, full_row_snapshot) VALUES ('/repo', 9397, 'CONSTRAINTS', 'rig-hash', ?)",
                )
                .run(JSON.stringify(snapshot));
        });
        applyMirrorPage({
            db: database,
            page: { domain: "memories", cursor: 0, next_cursor: 0, has_more: false, rows: [] },
        });
        expect(
            database.prepare("SELECT source_type, importance FROM memories WHERE id = 9397").get(),
        ).toEqual({ source_type: "agent", importance: 66 });
    });

    test("bounds authority seed frames below the management frame cap", async () => {
        const database = db();
        const seedCalls = { bytes: [] as number[] };
        const rows = Array.from({ length: 3 }, (_, id) => ({
            source_row_id: id + 1,
            snapshot: { id: id + 1, content: "x".repeat(400_000) },
        }));
        await prepareAuthority({
            db: database,
            projectPath: "/repo",
            domains: ["memories"],
            module: protocol(seedCalls),
            seedPages: async () => rows,
        });
        expect(seedCalls.bytes.length).toBeGreaterThan(1);
        expect(Math.max(...seedCalls.bytes)).toBeLessThan(1024 * 1024);
    });

    test("records the last source row when a seed frame coalesces duplicate module ids", async () => {
        const database = db();
        const module = protocol({ bytes: [] });
        module.authoritySeed = async () => ({ seeded: 2, module_row_ids: [900, 900] });

        await prepareAuthority({
            db: database,
            projectPath: "/repo",
            domains: ["memories"],
            module,
            seedPages: async () => [
                {
                    source_row_id: 100,
                    snapshot: { id: 100, project_path: "/repo", normalized_hash: "same" },
                },
                {
                    source_row_id: 200,
                    snapshot: { id: 200, project_path: "/repo", normalized_hash: "same" },
                },
            ],
        });

        expect(
            database
                .prepare(
                    "SELECT context_row_id FROM mirror_identity WHERE domain = 'memories' AND module_project = '/repo' AND module_row_id = 900",
                )
                .get(),
        ).toEqual({ context_row_id: 200 });
    });

    test("module checksum mismatch aborts, removes the marker, and restores TS writes", async () => {
        const database = db();
        const seedCalls = { bytes: [] as number[] };
        const module = protocol(seedCalls);
        const prepare = module.authorityPrepare;
        module.authorityPrepare = async (args) => {
            const response = await prepare(args);
            if (args.phase === "complete") {
                return {
                    authority: {
                        ...response.authority,
                        checksum_actual: "module-digest-does-not-match",
                        checksum_ok: 0,
                    },
                };
            }
            return response;
        };
        await expect(
            prepareAuthority({
                db: database,
                projectPath: "/repo",
                domains: ["memories"],
                module,
                seedPages: async () => [
                    { source_row_id: 1, snapshot: { id: 1, project_path: "/repo" } },
                ],
            }),
        ).rejects.toThrow("verification failed");
        expect(getAuthorityManagedMarker(database, "/repo")).toBeNull();
        database
            .prepare(
                "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'CONSTRAINTS', 'ts works', 'h', 0, 0, 0, 0)",
            )
            .run("/repo");
        expect(database.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({
            count: 1,
        });
    });

    test("mirror updates delete stale vectors and translate references atomically", () => {
        const database = db();
        const storeUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0)",
                )
                .run("/repo", "CONSTRAINTS", "old", "h1");
            database
                .prepare(
                    "INSERT INTO memory_embeddings(memory_id, embedding, model_id) VALUES (1, ?, ?)",
                )
                .run(Buffer.from([1]), "test");
        });
        const snapshot = (
            id: number,
            content: string,
            hash: string,
            extra: Record<string, unknown> = {},
        ) => ({
            id,
            project_path: "/repo",
            category: "CONSTRAINTS",
            content,
            normalized_hash: hash,
            importance: 50,
            scope: "project",
            shareable: 0,
            source_session_id: null,
            source_type: "agent",
            seen_count: 1,
            retrieval_count: 0,
            first_seen_at: 0,
            created_at: 0,
            updated_at: 1,
            last_seen_at: 1,
            last_retrieved_at: null,
            status: "active",
            expires_at: null,
            verification_status: "unverified",
            verified_at: null,
            classified_at: null,
            superseded_by_memory_id: null,
            merged_from: null,
            metadata_json: null,
            context_store_uuid: storeUuid,
            context_row_id: id,
            ...extra,
        });
        const page = (
            cursor: number,
            next_cursor: number,
            rows: ChangefeedPage["rows"],
        ): ChangefeedPage => ({ domain: "memories", cursor, next_cursor, has_more: false, rows });
        applyMirrorPage({
            db: database,
            page: page(0, 1, [
                {
                    feed_seq: 1,
                    domain: "memories",
                    op: "insert",
                    module_row_id: 1,
                    full_row_snapshot: snapshot(1, "old", "h1"),
                    content_hash: "h1",
                },
            ]),
        });
        applyMirrorPage({
            db: database,
            page: page(1, 2, [
                {
                    feed_seq: 2,
                    domain: "memories",
                    op: "update",
                    module_row_id: 1,
                    full_row_snapshot: snapshot(1, "new", "h2"),
                    content_hash: "h2",
                },
            ]),
        });
        expect(database.prepare("SELECT content FROM memories WHERE id = 1").get()).toEqual({
            content: "new",
        });
        applyMirrorPage({
            db: database,
            page: page(2, 3, [
                {
                    feed_seq: 3,
                    domain: "memories",
                    op: "update",
                    module_row_id: 1,
                    full_row_snapshot: snapshot(1, "new", "h2", {
                        mural_cue: "cue → anchor",
                        mural_cue_hash: "cue-content-sha",
                        mural_cue_at: 42,
                        mural_cue_rejection_count: 0,
                    }),
                    content_hash: "h2",
                },
            ]),
        });
        expect(
            database
                .prepare(
                    "SELECT mural_cue, mural_cue_hash, mural_cue_at, mural_cue_rejection_count FROM memories WHERE id = 1",
                )
                .get(),
        ).toEqual({
            mural_cue: "cue → anchor",
            mural_cue_hash: "cue-content-sha",
            mural_cue_at: 42,
            mural_cue_rejection_count: 0,
        });
        expect(
            database
                .prepare("SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = 1")
                .get(),
        ).toEqual({ count: 0 });
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO memory_embeddings(memory_id, embedding, model_id) VALUES (1, ?, ?)",
                )
                .run(Buffer.from([2]), "test");
        });
        applyMirrorPage({
            db: database,
            page: page(3, 4, [
                {
                    feed_seq: 4,
                    domain: "memories",
                    op: "tombstone",
                    module_row_id: 1,
                    full_row_snapshot: snapshot(1, "new", "h2"),
                    content_hash: "h2",
                },
            ]),
        });
        expect(
            database.prepare("SELECT COUNT(*) AS count FROM memories WHERE id = 1").get(),
        ).toEqual({ count: 0 });
        expect(
            database
                .prepare("SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = 1")
                .get(),
        ).toEqual({ count: 0 });
    });

    test("mirror-back keeps same content in separate project rows", () => {
        const database = db();
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO memories (id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)",
                )
                .run(9395, "project-a", "PROJECT_RULES", "shared fact", "H");
        });
        const before = database.prepare("SELECT * FROM memories WHERE id = 9395").get();

        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 8214,
                        full_row_snapshot: {
                            id: 8214,
                            project_path: "project-b",
                            category: "PROJECT_RULES",
                            content: "shared fact",
                            normalized_hash: "H",
                            status: "active",
                        },
                        content_hash: "H",
                    },
                ],
            },
        });

        expect(database.prepare("SELECT * FROM memories WHERE id = 9395").get()).toEqual(before);
        expect(
            database
                .prepare(
                    "SELECT id, project_path, category, normalized_hash FROM memories ORDER BY id",
                )
                .all(),
        ).toEqual([
            {
                id: 9395,
                project_path: "project-a",
                category: "PROJECT_RULES",
                normalized_hash: "H",
            },
            {
                id: 9396,
                project_path: "project-b",
                category: "PROJECT_RULES",
                normalized_hash: "H",
            },
        ]);
        expect(
            database
                .prepare(
                    "SELECT context_row_id FROM mirror_identity WHERE domain = 'memories' AND module_project = 'project-b' AND module_row_id = 8214",
                )
                .get(),
        ).toEqual({ context_row_id: 9396 });
    });

    test("mirror-back adopts an unambiguous legacy facade row by same-project content", () => {
        const database = db();
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO memories (id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)",
                )
                .run(9395, "project-a", "PROJECT_RULES", "shared fact", "H");
        });

        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 8214,
                        full_row_snapshot: {
                            id: 8214,
                            project_path: "project-a",
                            category: "PROJECT_RULES",
                            content: "updated shared fact",
                            normalized_hash: "H",
                            status: "active",
                        },
                        content_hash: "H",
                    },
                ],
            },
        });

        expect(database.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({
            count: 1,
        });
        expect(database.prepare("SELECT id, project_path, content FROM memories").get()).toEqual({
            id: 9395,
            project_path: "project-a",
            content: "updated shared fact",
        });
        expect(
            database
                .prepare(
                    "SELECT context_row_id FROM mirror_identity WHERE domain = 'memories' AND module_project = 'project-a' AND module_row_id = 8214",
                )
                .get(),
        ).toEqual({ context_row_id: 9395 });
    });

    test("mirror-back skips an adopted row whose project ownership differs", () => {
        const database = db();
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO memories (id, project_path, category, content, normalized_hash, importance, source_type, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)",
                )
                .run(9395, "project-a", "PROJECT_RULES", "owned by A", "A-hash", 75, "agent");
            database
                .prepare(
                    "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', 'project-b', 8214, 9395)",
                )
                .run();
        });
        const before = database.prepare("SELECT * FROM memories WHERE id = 9395").get();

        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "memories",
                        op: "update",
                        module_row_id: 8214,
                        full_row_snapshot: {
                            id: 8214,
                            project_path: "project-b",
                            category: "PROJECT_RULES",
                            content: "owned by B",
                            normalized_hash: "B-hash",
                            status: "active",
                        },
                        content_hash: "B-hash",
                    },
                ],
            },
        });

        expect(database.prepare("SELECT * FROM memories WHERE id = 9395").get()).toEqual(before);
    });

    test("mirror-back pins row-id adoption to the local context store UUID", () => {
        const database = db();
        const localStoreUuid = ensureContextStoreUuid(database);
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO memories (id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)",
                )
                .run(9395, "project-a", "PROJECT_RULES", "local fact", "local-hash");
        });

        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 9395,
                        full_row_snapshot: {
                            id: 9395,
                            project_path: "project-a",
                            category: "PROJECT_RULES",
                            content: "foreign fact",
                            normalized_hash: "foreign-hash",
                            context_store_uuid: `${localStoreUuid}-foreign`,
                            context_row_id: 9395,
                            status: "active",
                        },
                        content_hash: "foreign-hash",
                    },
                ],
            },
        });

        expect(database.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({
            count: 2,
        });
        expect(
            database
                .prepare("SELECT id, project_path, normalized_hash FROM memories ORDER BY id")
                .all(),
        ).toEqual([
            { id: 9395, project_path: "project-a", normalized_hash: "local-hash" },
            { id: 9396, project_path: "project-a", normalized_hash: "foreign-hash" },
        ]);
        expect(
            database
                .prepare(
                    "SELECT context_row_id FROM mirror_identity WHERE domain = 'memories' AND module_project = 'project-a' AND module_row_id = 9395",
                )
                .get(),
        ).toEqual({ context_row_id: 9396 });
    });

    test("canonical mapping survives legacy-first normalization tombstone ordering", () => {
        const database = db();
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO memories (id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)",
                )
                .run(9395, "git:identity", "CONFIG_VALUES", "drive model", "same-hash");
        });

        const row = (id: number, project_path: string) => ({
            id,
            project_path,
            category: "CONFIG_VALUES",
            content: "drive model",
            normalized_hash: "same-hash",
            status: "active",
        });
        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 3,
                has_more: false,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 100,
                        full_row_snapshot: row(100, "/repo"),
                        content_hash: "same-hash",
                    },
                    {
                        feed_seq: 2,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 200,
                        full_row_snapshot: row(200, "git:identity"),
                        content_hash: "same-hash",
                    },
                    {
                        feed_seq: 3,
                        domain: "memories",
                        op: "tombstone",
                        module_row_id: 100,
                        full_row_snapshot: row(100, "/repo"),
                        content_hash: "same-hash",
                    },
                ],
            },
        });

        expect(database.prepare("SELECT id, project_path FROM memories").get()).toEqual({
            id: 9395,
            project_path: "git:identity",
        });
        expect(
            database
                .prepare(
                    "SELECT module_project, module_row_id, context_row_id FROM mirror_identity WHERE domain = 'memories'",
                )
                .all(),
        ).toEqual([{ module_project: "git:identity", module_row_id: 200, context_row_id: 9395 }]);
    });

    test("schema-57 mirror upgrades resnapshot before either tombstone order", async () => {
        const row = (id: number, projectPath: string) => ({
            id,
            project_path: projectPath,
            category: "CONFIG_VALUES",
            content: "drive model",
            normalized_hash: "same-hash",
            status: "active",
        });
        const scenarios = [
            {
                name: "legacy cleanup leaves canonical live",
                live: [row(200, "git:identity")],
                tombstones: [row(100, "/repo")],
                survives: true,
            },
            {
                name: "canonical cleanup leaves legacy live",
                live: [row(100, "/repo")],
                tombstones: [row(200, "git:identity")],
                survives: true,
            },
            {
                name: "both deleted legacy first",
                live: [],
                tombstones: [row(100, "/repo"), row(200, "git:identity")],
                survives: false,
            },
            {
                name: "both deleted canonical first",
                live: [],
                tombstones: [row(200, "git:identity"), row(100, "/repo")],
                survives: false,
            },
        ];

        for (const scenario of scenarios) {
            const database = db();
            database.exec(`
                DROP TABLE mirror_live_staging;
                DROP TABLE mirror_resnapshot_state;
                DROP TABLE mirror_live_memory_rows;
                DELETE FROM schema_migrations WHERE version >= 58;
            `);
            withPrivilegedWriter(database, () => {
                database
                    .prepare(
                        "INSERT INTO memories (id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (9395, 'git:identity', 'CONFIG_VALUES', 'drive model', 'same-hash', 0, 0, 0, 0)",
                    )
                    .run();
                database
                    .prepare(
                        "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', '/repo', 100, 9395)",
                    )
                    .run();
                database
                    .prepare(
                        "INSERT INTO mirror_cursors(domain, cursor, updated_at) VALUES ('memories', 20, 0)",
                    )
                    .run();
            });
            runMigrations(database);
            const calls: Array<{ live_only?: boolean }> = [];
            const module: AuthorityModuleClient = {
                authorityStatus: async () => ({ authority: null }),
                authorityPrepare: async () => ({ authority: authority("PREPARING", 1) }),
                mirrorPull: async (args) => {
                    calls.push(args);
                    if (args.live_only) {
                        return {
                            page: {
                                domain: "memories",
                                cursor: args.cursor,
                                next_cursor: scenario.live.at(-1)?.id ?? args.cursor,
                                has_more: false,
                                rows: scenario.live.map((snapshot) => ({
                                    feed_seq: 0,
                                    domain: "memories" as const,
                                    op: "insert" as const,
                                    module_row_id: snapshot.id,
                                    full_row_snapshot: snapshot,
                                    content_hash: "same-hash",
                                })),
                            },
                        };
                    }
                    return {
                        page: {
                            domain: "memories",
                            cursor: args.cursor,
                            next_cursor: args.cursor + scenario.tombstones.length,
                            has_more: false,
                            rows: scenario.tombstones.map((snapshot, index) => ({
                                feed_seq: args.cursor + index + 1,
                                domain: "memories" as const,
                                op: "tombstone" as const,
                                module_row_id: snapshot.id,
                                full_row_snapshot: snapshot,
                                content_hash: "same-hash",
                            })),
                        },
                    };
                },
            };

            await pullAndApplyMirrorPage({ db: database, module, domain: "memories" });
            expect(calls[0]?.live_only, scenario.name).toBe(true);
            expect(
                database.prepare("SELECT id FROM memories WHERE id = 9395").get() != null,
                scenario.name,
            ).toBe(scenario.survives);
            expect(
                database
                    .prepare("SELECT status FROM mirror_resnapshot_state WHERE domain = 'memories'")
                    .get(),
                scenario.name,
            ).toEqual({ status: "complete" });
            database.close();
        }
    });

    test("repairs a partially populated live mirror before replay", async () => {
        const database = db();
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', 'git:partial', 1, 100)",
                )
                .run();
            database
                .prepare(
                    "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', 'git:partial', 2, 101)",
                )
                .run();
            database
                .prepare(
                    "INSERT INTO mirror_live_memory_rows(module_project, module_row_id, category, normalized_hash) VALUES ('git:partial', 1, 'ARCHITECTURE', 'hash-1')",
                )
                .run();
        });
        const calls: boolean[] = [];
        const module: AuthorityModuleClient = {
            authorityStatus: async () => ({ authority: null }),
            authorityPrepare: async () => ({ authority: authority("PREPARING", 1) }),
            mirrorPull: async (args) => {
                calls.push(args.live_only === true);
                if (args.live_only) {
                    return {
                        page: {
                            domain: "memories",
                            cursor: 0,
                            next_cursor: 2,
                            has_more: false,
                            rows: [1, 2].map((moduleRowId) => ({
                                feed_seq: 0,
                                domain: "memories" as const,
                                op: "insert" as const,
                                module_row_id: moduleRowId,
                                full_row_snapshot: {
                                    project_path: "git:partial",
                                    category: "ARCHITECTURE",
                                    normalized_hash: `hash-${moduleRowId}`,
                                },
                                content_hash: `hash-${moduleRowId}`,
                            })),
                        },
                    };
                }
                return {
                    page: {
                        domain: "memories",
                        cursor: 0,
                        next_cursor: 0,
                        has_more: false,
                        rows: [],
                    },
                };
            },
        };

        await pullAndApplyMirrorPage({ db: database, module, domain: "memories" });

        expect(calls).toEqual([true, false]);
        expect(
            database
                .prepare(
                    "SELECT COUNT(*) AS count FROM mirror_live_memory_rows WHERE module_project = 'git:partial'",
                )
                .get(),
        ).toEqual({ count: 2 });
        database.close();
    });

    test("DRAINING recovery resnapshots schema-57 memory identities before tombstones", async () => {
        const row = (id: number, projectPath: string) => ({
            id,
            project_path: projectPath,
            category: "CONFIG_VALUES",
            content: "drive model",
            normalized_hash: "same-hash",
            status: "active",
        });
        for (const interruptedStatus of ["pending_check", "resnapshotting"] as const) {
            const database = db();
            database.exec(`
                DROP TABLE mirror_live_staging;
                DROP TABLE mirror_resnapshot_state;
                DROP TABLE mirror_live_memory_rows;
                DELETE FROM schema_migrations WHERE version >= 58;
            `);
            withPrivilegedWriter(database, () => {
                database
                    .prepare(
                        "INSERT INTO memories (id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (9395, 'git:identity', 'CONFIG_VALUES', 'drive model', 'same-hash', 0, 0, 0, 0)",
                    )
                    .run();
                database
                    .prepare(
                        "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', '/repo', 100, 9395)",
                    )
                    .run();
                database
                    .prepare(
                        "INSERT INTO mirror_cursors(domain, cursor, updated_at) VALUES ('memories', 20, 0)",
                    )
                    .run();
            });
            runMigrations(database);
            if (interruptedStatus === "resnapshotting") {
                database
                    .prepare(
                        "UPDATE mirror_resnapshot_state SET status = 'resnapshotting' WHERE domain = 'memories'",
                    )
                    .run();
                database
                    .prepare(
                        "INSERT INTO mirror_live_staging VALUES ('abandoned', '/stale', 1, 'CONSTRAINTS', 'stale', NULL)",
                    )
                    .run();
            }

            const calls: Array<{ live_only?: boolean; cursor: number }> = [];
            let state: AuthorityStatus["state"] = "DRAINING";
            const module: AuthorityModuleClient = {
                authorityStatus: async (args) => ({
                    authority: { ...authority(state, 3), domain: args.domain },
                }),
                authorityPrepare: async () => ({ authority: authority("MODULE", 3) }),
                mirrorPull: async (args) => {
                    calls.push({ live_only: args.live_only, cursor: args.cursor });
                    return args.live_only
                        ? {
                              page: {
                                  domain: "memories",
                                  cursor: 0,
                                  next_cursor: 200,
                                  has_more: false,
                                  rows: [
                                      {
                                          feed_seq: 0,
                                          domain: "memories",
                                          op: "insert",
                                          module_row_id: 200,
                                          full_row_snapshot: row(200, "git:identity"),
                                          content_hash: "same-hash",
                                      },
                                  ],
                              },
                          }
                        : {
                              page: {
                                  domain: "memories",
                                  cursor: args.cursor,
                                  next_cursor: 21,
                                  has_more: false,
                                  rows: [
                                      {
                                          feed_seq: 21,
                                          domain: "memories",
                                          op: "tombstone",
                                          module_row_id: 100,
                                          full_row_snapshot: row(100, "/repo"),
                                          content_hash: "same-hash",
                                      },
                                  ],
                              },
                          };
                },
                authorityDrain: async (args) => {
                    if (args.action === "finish") state = "TS";
                    return {
                        authority: {
                            ...authority(state, 3),
                            captured_upper_bound: 21,
                            coordinator_token: "recovery-token",
                        },
                    };
                },
            };

            const result = await drainAuthority({
                db: database,
                projectPath: "git:identity",
                domain: "memories",
                module,
                checksum: "same",
            });
            expect(calls.map((call) => call.live_only)).toEqual([true, undefined]);
            expect(
                database
                    .prepare("SELECT cursor FROM mirror_cursors WHERE domain = 'memories'")
                    .get(),
            ).toEqual({
                cursor: 21,
            });
            expect(database.prepare("SELECT id FROM memories WHERE id = 9395").get()).toEqual({
                id: 9395,
            });
            expect(database.prepare("SELECT status FROM mirror_resnapshot_state").get()).toEqual({
                status: "complete",
            });
            expect(
                database.prepare("SELECT COUNT(*) AS count FROM mirror_live_staging").get(),
            ).toEqual({
                count: 0,
            });
            expect(result.state).toBe("TS");
            database.close();
        }
    });

    test("stages paged live resnapshots and swaps only after the final page", async () => {
        const database = db();
        database
            .prepare(
                "UPDATE mirror_resnapshot_state SET status = 'resnapshotting' WHERE domain = 'memories'",
            )
            .run();
        database
            .prepare(
                "INSERT INTO mirror_live_memory_rows VALUES ('old', 9, 'CONSTRAINTS', 'old-hash', NULL)",
            )
            .run();
        database
            .prepare(
                "INSERT INTO mirror_live_staging VALUES ('abandoned', 'stale', 8, 'CONSTRAINTS', 'stale-hash', NULL)",
            )
            .run();
        let calls = 0;
        const module: AuthorityModuleClient = {
            authorityStatus: async () => ({ authority: null }),
            authorityPrepare: async () => ({ authority: authority("MODULE", 1) }),
            mirrorPull: async (args) => {
                calls += 1;
                expect(args.limit).toBe(1);
                expect(
                    database.prepare("SELECT module_project FROM mirror_live_memory_rows").get(),
                ).toEqual({
                    module_project: "old",
                });
                const id = args.cursor + 1;
                return {
                    page: {
                        domain: "memories",
                        cursor: args.cursor,
                        next_cursor: id,
                        has_more: calls < 3,
                        rows: [
                            {
                                feed_seq: 0,
                                domain: "memories",
                                op: "insert",
                                module_row_id: id,
                                full_row_snapshot: {
                                    project_path: `project-${id}`,
                                    category: "CONSTRAINTS",
                                    normalized_hash: `hash-${id}`,
                                },
                                content_hash: `hash-${id}`,
                            },
                        ],
                    },
                };
            },
        };

        await ensureLiveMemoryResnapshot({ db: database, module, limit: 1 });
        expect(calls).toBe(3);
        expect(
            database
                .prepare(
                    "SELECT module_project FROM mirror_live_memory_rows ORDER BY module_row_id",
                )
                .all(),
        ).toEqual([
            { module_project: "project-1" },
            { module_project: "project-2" },
            { module_project: "project-3" },
        ]);
        expect(database.prepare("SELECT COUNT(*) AS count FROM mirror_live_staging").get()).toEqual(
            {
                count: 0,
            },
        );
    });

    test("a stale paged resnapshot cannot replace a newer completed generation", async () => {
        const directory = mkdtempSync(join(tmpdir(), "mc-resnapshot-owner-"));
        const path = join(directory, "context.db");
        const first = new Database(path);
        const second = new Database(path);
        try {
            initializeDatabase(first);
            runMigrations(first);
            initializeDatabase(second);
            runMigrations(second);
            first
                .prepare(
                    "UPDATE mirror_resnapshot_state SET status = 'resnapshotting', generation = 'bootstrap' WHERE domain = 'memories'",
                )
                .run();

            const waitingForA2 = deferred();
            const releaseA2 = deferred();
            const snapshot = (project: string, id: number): ChangefeedPage["rows"][number] => ({
                feed_seq: 0,
                domain: "memories",
                op: "insert",
                module_row_id: id,
                full_row_snapshot: {
                    project_path: project,
                    category: "CONSTRAINTS",
                    normalized_hash: `${project}-hash`,
                },
                content_hash: `${project}-hash`,
            });
            const moduleA: AuthorityModuleClient = {
                authorityStatus: async () => ({ authority: null }),
                authorityPrepare: async () => ({ authority: authority("MODULE", 1) }),
                mirrorPull: async (args) => {
                    if (args.cursor === 0) {
                        return {
                            page: {
                                domain: "memories",
                                cursor: 0,
                                next_cursor: 1,
                                has_more: true,
                                rows: [snapshot("A-1", 1)],
                            },
                        };
                    }
                    waitingForA2.resolve();
                    await releaseA2.promise;
                    return {
                        page: {
                            domain: "memories",
                            cursor: 1,
                            next_cursor: 2,
                            has_more: false,
                            rows: [snapshot("A-2", 2)],
                        },
                    };
                },
            };
            const moduleB: AuthorityModuleClient = {
                authorityStatus: async () => ({ authority: null }),
                authorityPrepare: async () => ({ authority: authority("MODULE", 1) }),
                mirrorPull: async () => ({
                    page: {
                        domain: "memories",
                        cursor: 0,
                        next_cursor: 2,
                        has_more: false,
                        rows: [snapshot("B-1", 1), snapshot("B-2", 2)],
                    },
                }),
            };

            const staleAttempt = ensureLiveMemoryResnapshot({
                db: first,
                module: moduleA,
                limit: 1,
            });
            await waitingForA2.promise;
            await ensureLiveMemoryResnapshot({ db: second, module: moduleB, limit: 2 });
            releaseA2.resolve();
            await staleAttempt;

            expect(
                first
                    .prepare(
                        "SELECT module_project FROM mirror_live_memory_rows ORDER BY module_row_id",
                    )
                    .all(),
            ).toEqual([{ module_project: "B-1" }, { module_project: "B-2" }]);
            expect(
                first.prepare("SELECT status, generation FROM mirror_resnapshot_state").get(),
            ).toEqual({
                status: "complete",
                generation: expect.any(String),
            });
            expect(
                first.prepare("SELECT COUNT(*) AS count FROM mirror_live_staging").get(),
            ).toEqual({ count: 0 });
        } finally {
            first.close();
            second.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("pull and drain resnapshots honor the same file-backed generation owner", async () => {
        const directory = mkdtempSync(join(tmpdir(), "mc-resnapshot-entrypoints-"));
        const path = join(directory, "context.db");
        const pullDb = new Database(path);
        const drainDb = new Database(path);
        try {
            initializeDatabase(pullDb);
            runMigrations(pullDb);
            initializeDatabase(drainDb);
            runMigrations(drainDb);
            pullDb
                .prepare(
                    "UPDATE mirror_resnapshot_state SET status = 'resnapshotting', generation = 'bootstrap' WHERE domain = 'memories'",
                )
                .run();

            const waitingForA2 = deferred();
            const releaseA2 = deferred();
            const snapshot = (project: string, id: number): ChangefeedPage["rows"][number] => ({
                feed_seq: 0,
                domain: "memories",
                op: "insert",
                module_row_id: id,
                full_row_snapshot: {
                    project_path: project,
                    category: "CONSTRAINTS",
                    normalized_hash: `${project}-hash`,
                },
                content_hash: `${project}-hash`,
            });
            const pullModule: AuthorityModuleClient = {
                authorityStatus: async () => ({ authority: null }),
                authorityPrepare: async () => ({ authority: authority("MODULE", 1) }),
                mirrorPull: async (args) => {
                    if (!args.live_only) {
                        return {
                            page: {
                                domain: "memories",
                                cursor: args.cursor,
                                next_cursor: args.cursor,
                                has_more: false,
                                rows: [],
                            },
                        };
                    }
                    if (args.cursor === 0) {
                        return {
                            page: {
                                domain: "memories",
                                cursor: 0,
                                next_cursor: 1,
                                has_more: true,
                                rows: [snapshot("A-1", 1)],
                            },
                        };
                    }
                    waitingForA2.resolve();
                    await releaseA2.promise;
                    return {
                        page: {
                            domain: "memories",
                            cursor: 1,
                            next_cursor: 2,
                            has_more: false,
                            rows: [snapshot("A-2", 2)],
                        },
                    };
                },
            };
            let state: AuthorityStatus["state"] = "DRAINING";
            const drainModule: AuthorityModuleClient = {
                authorityStatus: async (args) => ({
                    authority: {
                        ...authority(args.domain === "memories" ? state : "TS", 3),
                        domain: args.domain,
                    },
                }),
                authorityPrepare: async () => ({ authority: authority("MODULE", 3) }),
                mirrorPull: async (args) => ({
                    page: args.live_only
                        ? {
                              domain: "memories",
                              cursor: 0,
                              next_cursor: 2,
                              has_more: false,
                              rows: [snapshot("B-1", 1), snapshot("B-2", 2)],
                          }
                        : {
                              domain: "memories",
                              cursor: args.cursor,
                              next_cursor: args.cursor,
                              has_more: false,
                              rows: [],
                          },
                }),
                authorityDrain: async (args) => {
                    if (args.action === "finish") state = "TS";
                    return {
                        authority: {
                            ...authority(state, 3),
                            captured_upper_bound: 0,
                            coordinator_token: "drain-owner",
                        },
                    };
                },
            };

            const stalePull = pullAndApplyMirrorPage({
                db: pullDb,
                module: pullModule,
                domain: "memories",
                limit: 1,
            });
            await waitingForA2.promise;
            const drained = await drainAuthority({
                db: drainDb,
                projectPath: "/repo",
                domain: "memories",
                module: drainModule,
                checksum: "same",
            });
            releaseA2.resolve();
            await stalePull;

            expect(drained.state).toBe("TS");
            expect(
                pullDb
                    .prepare(
                        "SELECT module_project FROM mirror_live_memory_rows ORDER BY module_row_id",
                    )
                    .all(),
            ).toEqual([{ module_project: "B-1" }, { module_project: "B-2" }]);
            expect(pullDb.prepare("SELECT status FROM mirror_resnapshot_state").get()).toEqual({
                status: "complete",
            });
        } finally {
            pullDb.close();
            drainDb.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("re-captures and replays when drain finish reports a later feed head", async () => {
        const database = db();
        let begins = 0;
        let finishes = 0;
        let state: AuthorityStatus["state"] = "DRAINING";
        const module: AuthorityModuleClient = {
            authorityStatus: async (args) => ({
                authority: { ...authority(state, 2), domain: args.domain },
            }),
            authorityPrepare: async () => ({ authority: authority("MODULE", 2) }),
            mirrorPull: async (args) => ({
                page: {
                    domain: "memories",
                    cursor: args.cursor,
                    next_cursor: 1,
                    has_more: false,
                    rows: [
                        {
                            feed_seq: 1,
                            domain: "memories",
                            op: "insert",
                            module_row_id: 1,
                            full_row_snapshot: {
                                id: 1,
                                project_path: "/repo",
                                category: "CONSTRAINTS",
                                content: "late memory",
                                normalized_hash: "late-hash",
                                status: "active",
                            },
                            content_hash: "late-hash",
                        },
                    ],
                },
            }),
            authorityDrain: async (args) => {
                if (args.action === "begin") begins += 1;
                if (args.action === "finish") {
                    finishes += 1;
                    if (finishes === 1) {
                        const error = new Error("authority_feed_head_advanced") as Error & {
                            code: string;
                        };
                        error.code = "authority_feed_head_advanced";
                        throw error;
                    }
                    state = "TS";
                }
                return {
                    authority: {
                        ...authority(state, 2),
                        domain: "memories",
                        captured_upper_bound: begins === 1 ? 0 : 1,
                        coordinator_token: `token-${begins}`,
                    },
                };
            },
        };

        const result = await drainAuthority({
            db: database,
            projectPath: "/repo",
            domain: "memories",
            module,
            checksum: "same",
        });
        expect({ begins, finishes, state: result.state }).toEqual({
            begins: 2,
            finishes: 2,
            state: "TS",
        });
        expect(
            database.prepare("SELECT cursor FROM mirror_cursors WHERE domain = 'memories'").get(),
        ).toEqual({ cursor: 1 });
    });

    test("bounds steady drain contention and leaves a retryable durable DRAINING state", async () => {
        const database = db();
        let begins = 0;
        let finishes = 0;
        let keepContending = true;
        let state: AuthorityStatus["state"] = "DRAINING";
        const module: AuthorityModuleClient = {
            authorityStatus: async (args) => ({
                authority: { ...authority(state, 2), domain: args.domain },
            }),
            authorityPrepare: async () => ({ authority: authority("MODULE", 2) }),
            mirrorPull: async (args) => ({
                page: {
                    domain: args.domain,
                    cursor: args.cursor,
                    next_cursor: args.cursor,
                    has_more: false,
                    rows: [],
                },
            }),
            authorityDrain: async (args) => {
                if (args.action === "begin") begins += 1;
                if (args.action === "finish") {
                    finishes += 1;
                    if (keepContending) {
                        const error = new Error("authority_feed_head_advanced") as Error & {
                            code: string;
                        };
                        error.code = "authority_feed_head_advanced";
                        throw error;
                    }
                    state = "TS";
                }
                return {
                    authority: {
                        ...authority(state, 2),
                        captured_upper_bound: 0,
                        coordinator_token: `token-${begins}`,
                    },
                };
            },
        };

        const contended = await drainAuthority({
            db: database,
            projectPath: "/repo",
            domain: "memories",
            module,
            checksum: "same",
        });
        expect(contended).toMatchObject({
            code: "authority_drain_contended",
            retryable: true,
            state: "DRAINING",
            attempts: 5,
        });
        expect({ begins, finishes }).toEqual({ begins: 6, finishes: 6 });
        expect(
            (
                await module.authorityStatus({
                    context_store_uuid: "store",
                    project: "/repo",
                    domain: "memories",
                })
            ).authority?.state,
        ).toBe("DRAINING");

        keepContending = false;
        const resumed = await drainAuthority({
            db: database,
            projectPath: "/repo",
            domain: "memories",
            module,
            checksum: "same",
        });
        expect(resumed.state).toBe("TS");
        expect({ begins, finishes }).toEqual({ begins: 7, finishes: 7 });
    });

    test("drain finish removes the marker only after module ownership returns to TS", async () => {
        const database = db();
        installAuthorityManagedMarker(database, "/repo");
        let generation = 1;
        let memoryState: AuthorityStatus["state"] = "MODULE";
        const module: AuthorityModuleClient = {
            authorityStatus: async (args) => ({
                authority:
                    args.domain === "memories"
                        ? { ...authority(memoryState, generation), domain: args.domain }
                        : { ...authority("TS", generation), domain: args.domain },
            }),
            authorityPrepare: async () => ({ authority: authority("MODULE", generation) }),
            authoritySeed: async () => ({ seeded: 0 }),
            mirrorPull: async () => ({
                page: { domain: "memories", cursor: 0, next_cursor: 0, has_more: false, rows: [] },
            }),
            authorityDrain: async (args) => {
                memoryState = args.action === "finish" ? "TS" : "DRAINING";
                return {
                    authority: {
                        ...authority(memoryState, ++generation),
                        coordinator_token: "tok-live",
                    },
                };
            },
        };
        const result = await drainAuthority({
            db: database,
            projectPath: "/repo",
            domain: "memories",
            module,
            checksum: "same",
        });
        expect(result.state).toBe("TS");
        expect(getAuthorityManagedMarker(database, "/repo")).toBeNull();
    });

    test("installs the marker before reading the stable seed set", async () => {
        const database = db();
        database
            .prepare(
                "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'CONSTRAINTS', 'before marker', 'h1', 0, 0, 0, 0)",
            )
            .run("/repo");
        let seededIds: number[] = [];
        await prepareAuthority({
            db: database,
            projectPath: "/repo",
            domains: ["memories"],
            module: protocol({ bytes: [] }),
            seedPages: async () => {
                expect(() =>
                    database
                        .prepare(
                            "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'CONSTRAINTS', 'after marker', 'h2', 0, 0, 0, 0)",
                        )
                        .run("/repo"),
                ).toThrow("managed by the Rust module");
                const rows = database
                    .prepare("SELECT * FROM memories WHERE project_path = ? ORDER BY id")
                    .all("/repo") as Array<Record<string, unknown>>;
                seededIds = rows.map((row) => Number(row.id));
                return rows.map((snapshot) => ({ source_row_id: snapshot.id, snapshot }));
            },
        });
        expect(seededIds).toEqual([1]);
    });

    test("does not hold a SQLite transaction while module transport is delayed", async () => {
        const database = db();
        database.exec("CREATE TABLE unrelated_writer_probe(id INTEGER PRIMARY KEY, value TEXT)");
        let releaseBegin: (() => void) | undefined;
        const beginGate = new Promise<void>((resolve) => {
            releaseBegin = resolve;
        });
        const module = protocol({ bytes: [] });
        const ordinaryPrepare = module.authorityPrepare;
        module.authorityPrepare = async (args) => {
            if (args.phase === "begin") await beginGate;
            return ordinaryPrepare(args);
        };
        const preparation = prepareAuthority({
            db: database,
            projectPath: "/repo",
            domains: ["memories"],
            module,
            seedPages: async () => [],
        });
        await Promise.resolve();
        database
            .prepare("INSERT INTO unrelated_writer_probe(value) VALUES ('writer was not blocked')")
            .run();
        releaseBegin?.();
        await preparation;
        expect(
            database.prepare("SELECT COUNT(*) AS count FROM unrelated_writer_probe").get(),
        ).toEqual({
            count: 1,
        });
    });

    test("restart reconciliation reinstalls a missing marker before tools can write", async () => {
        const database = db();
        const module = protocol({ bytes: [] });
        module.authorityStatus = async (args) => ({
            authority: { ...authority("MODULE", 2), domain: args.domain },
        });
        await reconcileAuthorityProject({ db: database, projectPath: "/repo", module });
        expect(getAuthorityManagedMarker(database, "/repo")).not.toBeNull();
        expect(() =>
            database
                .prepare(
                    "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'CONSTRAINTS', 'blocked', 'h', 0, 0, 0, 0)",
                )
                .run("/repo"),
        ).toThrow("managed by the Rust module");
    });

    test("resolves superseded references introduced on a later mirror page", () => {
        const database = db();
        const memory = (id: number, supersededBy: number | null) => ({
            id,
            project_path: "/repo",
            category: "CONSTRAINTS",
            content: `memory ${id}`,
            normalized_hash: `h${id}`,
            scope: "project",
            shareable: 0,
            seen_count: 1,
            retrieval_count: 0,
            first_seen_at: 0,
            created_at: 0,
            updated_at: 0,
            last_seen_at: 0,
            status: "active",
            verification_status: "unverified",
            superseded_by_memory_id: supersededBy,
        });
        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1,
                has_more: true,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 10,
                        full_row_snapshot: memory(10, 20),
                        content_hash: "h10",
                    },
                ],
            },
        });
        expect(database.prepare("SELECT superseded_by_memory_id FROM memories").get()).toEqual({
            superseded_by_memory_id: null,
        });
        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 1,
                next_cursor: 2,
                has_more: false,
                rows: [
                    {
                        feed_seq: 2,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 20,
                        full_row_snapshot: memory(20, null),
                        content_hash: "h20",
                    },
                ],
            },
        });
        const rows = database
            .prepare("SELECT id, superseded_by_memory_id FROM memories ORDER BY id")
            .all() as Array<{ id: number; superseded_by_memory_id: number | null }>;
        expect(rows[0]?.superseded_by_memory_id).toBe(rows[1]?.id);
    });

    test("privileged same-connection UPDATE between capture and verify aborts prepare", async () => {
        const database = db();
        database
            .prepare(
                "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'CONSTRAINTS', 'seed', 'h1', 0, 0, 0, 0)",
            )
            .run("/repo");
        const module = protocol({ bytes: [] });
        const ordinaryPrepare = module.authorityPrepare;
        module.authorityPrepare = async (args) => {
            if (args.phase === "complete") {
                withPrivilegedWriter(database, () => {
                    database
                        .prepare("UPDATE memories SET content = 'drifted' WHERE project_path = ?")
                        .run("/repo");
                    bumpDomainMutationEpoch(database, "/repo", "memories");
                });
            }
            return ordinaryPrepare(args);
        };
        await expect(
            prepareAuthority({
                db: database,
                projectPath: "/repo",
                domains: ["memories"],
                module,
                seedPages: async () => {
                    const rows = database
                        .prepare("SELECT * FROM memories WHERE project_path = ? ORDER BY id")
                        .all("/repo") as Array<Record<string, unknown>>;
                    return rows.map((snapshot) => ({ source_row_id: snapshot.id, snapshot }));
                },
            }),
        ).rejects.toThrow("authority capture bound changed");
        expect(getAuthorityManagedMarker(database, "/repo")).toBeNull();
    });

    test("unmapped tombstone clears pending references without resurrecting the source", () => {
        const database = db();
        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 0,
                next_cursor: 1,
                has_more: true,
                rows: [
                    {
                        feed_seq: 1,
                        domain: "memories",
                        op: "insert",
                        module_row_id: 10,
                        full_row_snapshot: {
                            id: 10,
                            project_path: "/repo",
                            category: "CONSTRAINTS",
                            content: "source",
                            normalized_hash: "h10",
                            scope: "project",
                            shareable: 0,
                            seen_count: 1,
                            retrieval_count: 0,
                            first_seen_at: 0,
                            created_at: 0,
                            updated_at: 0,
                            last_seen_at: 0,
                            status: "active",
                            verification_status: "unverified",
                            superseded_by_memory_id: 99,
                        },
                        content_hash: "h10",
                    },
                ],
            },
        });
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM mirror_pending_references").get() as {
                c: number;
            },
        ).toEqual({ c: 1 });
        applyMirrorPage({
            db: database,
            page: {
                domain: "memories",
                cursor: 1,
                next_cursor: 2,
                has_more: false,
                rows: [
                    {
                        feed_seq: 2,
                        domain: "memories",
                        op: "tombstone",
                        module_row_id: 99,
                        full_row_snapshot: {
                            id: 99,
                            project_path: "/repo",
                            category: "CONSTRAINTS",
                            content: "",
                            normalized_hash: "",
                        },
                        content_hash: null,
                    },
                ],
            },
        });
        expect(
            database.prepare("SELECT COUNT(*) AS c FROM mirror_pending_references").get() as {
                c: number;
            },
        ).toEqual({ c: 0 });
        expect(
            database.prepare("SELECT superseded_by_memory_id FROM memories WHERE id = 1").get(),
        ).toEqual({ superseded_by_memory_id: null });
    });

    test("foreign archived expired and unshareable rows stay hidden on the id search path", () => {
        const database = db();
        const now = Date.now();
        database
            .prepare(
                "INSERT INTO workspaces(id, name, created_at, updated_at, share_categories) VALUES (1, 'ws', 0, 0, ?)",
            )
            .run(JSON.stringify(["CONSTRAINTS"]));
        database
            .prepare(
                "INSERT INTO workspace_members(workspace_id, project_path, display_name, display_path, added_at) VALUES (1, '/own', 'own', '/own', 0), (1, '/foreign', 'foreign', '/foreign', 0)",
            )
            .run();
        database
            .prepare(
                `INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at, status, shareable, scope, expires_at)
                 VALUES
                 ('/own', 'CONSTRAINTS', 'own archived', 'h1', 0, 0, 0, 0, 'archived', 0, 'project', NULL),
                 ('/foreign', 'CONSTRAINTS', 'foreign archived', 'h2', 0, 0, 0, 0, 'archived', 1, 'project', NULL),
                 ('/foreign', 'CONSTRAINTS', 'foreign expired', 'h3', 0, 0, 0, 0, 'active', 1, 'project', ?),
                 ('/foreign', 'CONSTRAINTS', 'foreign private', 'h4', 0, 0, 0, 0, 'active', 0, 'project', NULL),
                 ('/foreign', 'CONSTRAINTS', 'foreign visible', 'h5', 0, 0, 0, 0, 'active', 1, 'project', NULL)`,
            )
            .run(now - 1);
        const rows = getMemoriesByProjects(
            database,
            ["/own", "/foreign"],
            ["active", "permanent", "archived"],
            now,
            ["/own"],
            ["CONSTRAINTS"],
        );
        const contents = rows.map((row) => row.content).sort();
        expect(contents).toEqual(["foreign visible", "own archived"]);
        const idPath = resolveMemoriesByIdsForSearch({
            db: database,
            projectPath: "/own",
            ids: [1, 2, 3, 4, 5],
            limit: 10,
        });
        expect(idPath?.map((hit) => hit.content).sort()).toEqual([
            "foreign visible",
            "own archived",
        ]);
    });

    test("note evaluation bridges are scoped per project", async () => {
        const calls: string[] = [];
        registerModuleNoteEvaluationBridge("/project-a", {
            sync: async () => {
                calls.push("sync-a");
            },
            evaluate: async () => {
                calls.push("eval-a");
            },
        });
        expect(getModuleNoteEvaluationBridge("/project-a")).toBeDefined();
        expect(getModuleNoteEvaluationBridge("/project-b")).toBeUndefined();
        await getModuleNoteEvaluationBridge("/project-a")?.evaluate({
            contextNoteId: 1,
            sessionId: "s",
            verdict: true,
        });
        expect(calls).toEqual(["eval-a"]);
    });

    test("module-managed memory search skips retrieval_count writes", async () => {
        const database = db();
        installAuthorityManagedMarker(database, "/repo");
        withPrivilegedWriter(database, () => {
            database
                .prepare(
                    "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at, status) VALUES (?, 'CONSTRAINTS', 'search me unique-token-xyz', 'h', 0, 0, 0, 0, 'active')",
                )
                .run("/repo");
        });
        const before = database
            .prepare("SELECT retrieval_count AS c FROM memories WHERE id = 1")
            .get() as { c: number };
        const results = await unifiedSearch(database, "session", "/repo", "unique-token-xyz", {
            memoryEnabled: true,
            embeddingEnabled: false,
            countRetrievals: true,
        });
        expect(results.some((result) => result.source === "memory")).toBe(true);
        const after = database
            .prepare("SELECT retrieval_count AS c FROM memories WHERE id = 1")
            .get() as { c: number };
        expect(after.c).toBe(before.c);
    });
});
