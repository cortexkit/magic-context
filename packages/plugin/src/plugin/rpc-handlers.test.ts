/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { replaceAllCompartmentState } from "../features/magic-context/compartment-storage";
import { insertMemory } from "../features/magic-context/memory";
import { resolveProjectIdentity } from "../features/magic-context/memory/project-identity";
import { runMigrations } from "../features/magic-context/migrations";
import {
    getPersistedSchemaVersion,
    initializeDatabase,
    LATEST_SUPPORTED_VERSION,
} from "../features/magic-context/storage-db";
import { createLiveSessionState } from "../hooks/magic-context/live-session-state";
import { estimateTokens } from "../hooks/magic-context/read-session-formatting";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../shared/models-dev-cache";
import { Database } from "../shared/sqlite";
import { closeQuietly } from "../shared/sqlite-helpers";
import {
    buildSidebarSnapshot,
    buildSidebarSnapshotRpcResponse,
    buildStatusDetail,
} from "./rpc-handlers";
import { resetSidebarSnapshotCache } from "./sidebar-snapshot-cache";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

afterEach(() => {
    resetSidebarSnapshotCache();
    clearModelsDevCache();
});

describe("sidebar snapshot RPC failures", () => {
    test("returns an error envelope when snapshot construction hits SQLITE_BUSY", () => {
        const busyDb = {
            prepare() {
                const error = new Error("database is locked") as Error & { code?: string };
                error.code = "SQLITE_BUSY";
                throw error;
            },
        } as unknown as Database;

        expect(buildSidebarSnapshotRpcResponse(busyDb, "ses_busy", process.cwd())).toEqual({
            error: "sidebar snapshot unavailable",
        });
    });
});

describe("buildSidebarSnapshot — stale build error state", () => {
    test("surfaces the persisted stale-build failure in the sidebar snapshot", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-stale-build";
            db.prepare(
                "INSERT INTO session_meta (session_id, last_transform_error) VALUES (?, ?)",
            ).run(
                sessionId,
                "Magic Context: plugin build is older than its database — restart OpenCode",
            );

            const snapshot = buildSidebarSnapshot(db, sessionId, process.cwd());

            expect(snapshot.lastTransformError).toBe(
                "Magic Context: plugin build is older than its database — restart OpenCode",
            );
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildSidebarSnapshot — memory tokens fallback (bug #1)", () => {
    test("computes memoryTokens on-demand when memory_block_cache is empty but memory_block_count > 0", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-test-1";
            // Resolve a project identity that getMemoriesByProject will key on.
            // Using process.cwd() as the directory matches what the production
            // call site does (the RPC handler receives the user's directory).
            const directory = process.cwd();
            const projectIdentity = resolveProjectIdentity(directory);

            // Insert a few memories under this project so renderMemoryBlock has
            // real content to tokenize. Without these, the on-demand render
            // returns an empty block and tokens stay at 0.
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "USER_DIRECTIVES",
                content: "Always use Bun for builds",
                sourceSessionId: sessionId,
            });
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "ENVIRONMENT",
                content:
                    "OpenCode source lives at ~/Work/OSS/opencode (cloned for cross-reference, not a workspace package).",
                sourceSessionId: sessionId,
            });

            // Seed session_meta with the regression-trigger shape:
            //   memory_block_cache = ''  (cleared by historian/recomp/etc.)
            //   memory_block_count > 0  (preserved across cache busts)
            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count
                ) VALUES (?, 50000, 25, 5000, '', 2)`,
            ).run(sessionId);

            const snapshot = buildSidebarSnapshot(
                db,
                sessionId,
                directory,
                undefined,
                4000, // injection budget tokens, matching default config
            );

            // The bug: memoryTokens used to be 0 here because the fallback path
            // wasn't implemented. After the fix, it should be > 0 because we
            // render the memory block on-demand from the memories table.
            expect(snapshot.memoryBlockCount).toBe(2);
            expect(snapshot.memoryTokens).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("falls back to 0 when cache is empty AND memory_block_count is 0 (truly nothing to render)", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-test-2";
            const directory = process.cwd();

            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count
                ) VALUES (?, 0, 0, 0, '', 0)`,
            ).run(sessionId);

            const snapshot = buildSidebarSnapshot(db, sessionId, directory, undefined, 4000);
            expect(snapshot.memoryBlockCount).toBe(0);
            expect(snapshot.memoryTokens).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("omits retired factCount from the RPC sidebar payload", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-sidebar-no-fact-count";
            const directory = process.cwd();
            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count
                ) VALUES (?, 50000, 25, 5000, '', 0)`,
            ).run(sessionId);

            const snapshot = buildSidebarSnapshot(db, sessionId, directory, undefined, 4000);
            expect(Object.hasOwn(snapshot as object, "factCount")).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("memory bucket measures the <project-memory> slice ACTUALLY in m[0] (v2 wire), not memory_block_cache", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-test-3";
            const directory = process.cwd();
            // m[0] carries the compact v2 category-grouped render.
            const m0 =
                "<session-history>\n</session-history>\n\n" +
                "<project-memory>\n<ARCHITECTURE>\n#1: a durable architectural fact about the system\n</ARCHITECTURE>\n</project-memory>";
            // memory_block_cache holds the LEGACY v1 shape — must be IGNORED for
            // the token bucket now (it under-counts the real injected cost).
            const v1Cache = "<project-memory>\n- a durable architectural fact\n</project-memory>";

            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count, cached_m0_bytes
                ) VALUES (?, 50000, 25, 5000, ?, 1, ?)`,
            ).run(sessionId, v1Cache, Buffer.from(m0, "utf8"));

            const snapshot = buildSidebarSnapshot(db, sessionId, directory, undefined, 4000);
            expect(snapshot.memoryBlockCount).toBe(1);
            // Tokens come from the actual m[0] v2 slice, not the stale cache.
            const v2SliceTokens = snapshot.memoryTokens;
            expect(v2SliceTokens).toBeGreaterThan(0);
            expect(
                estimateTokens(m0.match(/<project-memory>[\s\S]*?<\/project-memory>/)?.[0] ?? ""),
            ).toBe(v2SliceTokens);
            expect(v2SliceTokens).not.toBe(estimateTokens(v1Cache));
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildSidebarSnapshot — context limit", () => {
    test("populates contextLimit from the active session model", async () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-sidebar-context-limit";
            const directory = process.cwd();
            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count
                ) VALUES (?, 80000, 40, 5000, '', 0)`,
            ).run(sessionId);
            await refreshModelLimitsFromApi({
                config: {
                    providers: async () => ({
                        data: {
                            providers: [
                                {
                                    id: "test-provider",
                                    models: {
                                        "test-model": { limit: { context: 200_000 } },
                                    },
                                },
                            ],
                        },
                    }),
                },
            });
            const live = createLiveSessionState();
            live.liveModelBySession.set(sessionId, {
                providerID: "test-provider",
                modelID: "test-model",
            });

            const snapshot = buildSidebarSnapshot(db, sessionId, directory, live, 4000);

            expect(snapshot.contextLimit).toBe(200_000);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildSidebarSnapshot — Rust module status merge", () => {
    test("uses module pressure, boundary, coverage, and compartment counts", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-sidebar-rust-status";
            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_cache, memory_block_count
                ) VALUES (?, 1, 1, 5000, '', 0)`,
            ).run(sessionId);

            const snapshot = buildSidebarSnapshot(
                db,
                sessionId,
                process.cwd(),
                undefined,
                4000,
                undefined,
                {
                    usage: {
                        current_total_input_tokens: 42_000,
                        context_limit_tokens: 100_000,
                    },
                    boundary_present: true,
                    coverage_ordinal: 17,
                    compartment_count: 4,
                    compartment_tokens: 23,
                    pending_drop_count: 2,
                },
            );

            expect(snapshot.inputTokens).toBe(42_000);
            expect(snapshot.usagePercentage).toBe(42);
            expect(snapshot.contextLimit).toBe(100_000);
            expect(snapshot.compartmentCount).toBe(4);
            expect(snapshot.compartmentTokens).toBe(23);
            expect(snapshot.pendingOpsCount).toBe(2);
            expect(snapshot.boundaryPresent).toBe(true);
            expect(snapshot.coverageOrdinal).toBe(17);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("compaction-off sidebar RPC data", () => {
    test("reports the resolved mode and raw native usage independently of threshold fill", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-native-sidebar";
            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, memory_block_count
                ) VALUES (?, 63077, 97, 0, 0)`,
            ).run(sessionId);
            replaceAllCompartmentState(
                db,
                sessionId,
                [
                    {
                        sequence: 0,
                        startMessage: 1,
                        endMessage: 4,
                        startMessageId: "msg-1",
                        endMessageId: "msg-4",
                        title: "Archived",
                        content: "Historical context retained for later expansion.",
                    },
                ],
                [],
            );

            const snapshot = buildSidebarSnapshot(
                db,
                sessionId,
                process.cwd(),
                undefined,
                4000,
                { execute_threshold_percentage: 65 },
                {
                    usage: {
                        current_total_input_tokens: 41_000,
                        context_limit_tokens: 100_000,
                    },
                },
                false,
            );
            const detail = buildStatusDetail(
                db,
                sessionId,
                process.cwd(),
                undefined,
                { execute_threshold_percentage: 65 },
                undefined,
                4000,
                {
                    usage: {
                        current_total_input_tokens: 41_000,
                        context_limit_tokens: 100_000,
                    },
                },
                false,
            );
            const thresholdFillPercentage = (41_000 / (100_000 * 0.65)) * 100;

            expect(snapshot.compaction_enabled).toBe(false);
            expect(detail.compaction_enabled).toBe(false);
            expect(snapshot.native_context_usage_percentage).toBe(41);
            expect(detail.native_context_usage_percentage).toBe(41);
            expect(snapshot.native_context_usage_percentage).not.toBeCloseTo(
                thresholdFillPercentage,
            );
            expect(snapshot.archivedCompartmentCount).toBe(1);

            const enabledDetail = buildStatusDetail(db, "ses-native-sidebar-on", process.cwd());
            expect(enabledDetail.compaction_enabled).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildStatusDetail — history token reuse (council audit bg_51106601 #1)", () => {
    test("sets historyBlockTokens from compartmentTokens only (facts retired in v2)", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-status-history-tokens";
            const directory = process.cwd();

            db.prepare(
                `INSERT INTO session_meta (
                    session_id, last_input_tokens, last_context_percentage,
                    system_prompt_tokens, conversation_tokens
                ) VALUES (?, 50000, 25, 5000, 0)`,
            ).run(sessionId);
            replaceAllCompartmentState(
                db,
                sessionId,
                [
                    {
                        sequence: 0,
                        startMessage: 1,
                        endMessage: 4,
                        startMessageId: "msg-1",
                        endMessageId: "msg-4",
                        title: "Setup",
                        content: "User configured the project and installed dependencies.",
                    },
                    {
                        sequence: 1,
                        startMessage: 5,
                        endMessage: 8,
                        startMessageId: "msg-5",
                        endMessageId: "msg-8",
                        title: "Implementation",
                        content: "Assistant implemented the requested performance fix.",
                    },
                ],
                [
                    { category: "preference", content: "Use Bun for plugin commands." },
                    { category: "environment", content: "The workspace is a git repository." },
                ],
            );

            const detail = buildStatusDetail(db, sessionId, directory);

            // v2: facts are retired as a render source (promoted to memories), so
            // factTokens is 0 and the history block is compartments only — facts
            // no longer contribute to rendered <session-history> bytes.
            expect(detail.compartmentTokens).toBeGreaterThan(0);
            expect(detail.factTokens).toBe(0);
            expect(detail.historyBlockTokens).toBe(detail.compartmentTokens);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildStatusDetail — storage versions probe", () => {
    test("reports the live context.db schema version and the plugin fence", () => {
        const db = createTestDb();
        try {
            const detail = buildStatusDetail(db, "ses-storage-versions", process.cwd());

            // The probe must carry the live MAX(schema_migrations) value, not a
            // hardcoded one, plus this build's fence. A fully migrated test DB sits
            // exactly at the fence.
            expect(detail.storage_versions.context_db_schema_version).toBe(
                getPersistedSchemaVersion(db),
            );
            expect(detail.storage_versions.plugin_supported_version).toBe(LATEST_SUPPORTED_VERSION);
            expect(detail.storage_versions.context_db_schema_version).toBe(
                LATEST_SUPPORTED_VERSION,
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("follows an older live DB version while the fence stays put", () => {
        const db = createTestDb();
        try {
            // Simulate a DB migrated by an older plugin: drop the recorded versions
            // above 50. The probe must follow the live value down.
            db.prepare("DELETE FROM schema_migrations WHERE version > ?").run(50);

            const detail = buildStatusDetail(db, "ses-storage-versions-old", process.cwd());

            expect(detail.storage_versions.context_db_schema_version).toBe(50);
            expect(detail.storage_versions.plugin_supported_version).toBe(LATEST_SUPPORTED_VERSION);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildStatusDetail — cacheNeverExpires with 'never' TTL", () => {
    test("sets cacheNeverExpires: true when cache_ttl is 'never'", () => {
        const db = createTestDb();
        try {
            const sessionId = "ses-status-never";
            const directory = process.cwd();

            // Force-create the session meta row so the UPDATE lands on an existing row.
            db.prepare(`INSERT INTO session_meta (session_id) VALUES (?)`).run(sessionId);
            // Seed last_response_time: the cacheNeverExpires branch only runs
            // inside `if (lastResponseTime > 0)` — without this the test would
            // pass even if Infinity leaked into cacheRemainingMs.
            db.prepare(
                "UPDATE session_meta SET cache_ttl = ?, last_response_time = ? WHERE session_id = ?",
            ).run("never", Date.now() - 60_000, sessionId);

            const detail = buildStatusDetail(db, sessionId, directory);

            expect(detail.cacheNeverExpires).toBe(true);
            expect(detail.cacheExpired).toBe(false);
            // Infinity must NOT leak into the numeric RPC field — JSON.stringify
            // converts Infinity to null, violating the StatusDetail contract.
            expect(detail.cacheRemainingMs).toBe(0);
            const roundTripped = JSON.parse(JSON.stringify(detail));
            expect(roundTripped.cacheRemainingMs).toBe(0);
            expect(roundTripped.cacheRemainingMs).not.toBeNull();
        } finally {
            closeQuietly(db);
        }
    });
});
