import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { healAllNullColumns } from "./storage-db";

/**
 * Versioned migration framework for magic-context's SQLite database.
 *
 * Each migration is a function that runs inside a transaction.
 * Migrations are applied sequentially on startup — skipping any
 * that have already run. This handles multi-version jumps cleanly
 * (e.g. upgrading from 0.4 to 0.7 runs all intermediate migrations).
 *
 * To add a new migration:
 * 1. Append a new entry to the MIGRATIONS array
 * 2. The version number is the array index + 1
 * 3. The migration runs in a transaction — if it throws, it rolls back
 */

interface Migration {
    version: number;
    description: string;
    up: (db: Database) => void;
}

const MIGRATIONS: Migration[] = [
    {
        version: 1,
        description: "Merge session_notes + smart_notes into unified notes table",
        up: (db: Database) => {
            // Create the unified notes table
            db.exec(`
				CREATE TABLE IF NOT EXISTS notes (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					type TEXT NOT NULL DEFAULT 'session',
					status TEXT NOT NULL DEFAULT 'active',
					content TEXT NOT NULL,
					session_id TEXT,
					project_path TEXT,
					surface_condition TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					last_checked_at INTEGER,
					ready_at INTEGER,
					ready_reason TEXT
				);
				CREATE INDEX IF NOT EXISTS idx_notes_session_status ON notes(session_id, status);
				CREATE INDEX IF NOT EXISTS idx_notes_project_status ON notes(project_path, status);
				CREATE INDEX IF NOT EXISTS idx_notes_type_status ON notes(type, status);
			`);

            // Migrate session_notes → notes (type='session', status='active')
            const hasSessionNotes = db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='session_notes'",
                )
                .get();
            if (hasSessionNotes) {
                db.exec(`
					INSERT INTO notes (type, status, content, session_id, created_at, updated_at)
					SELECT 'session', 'active', content, session_id, created_at, created_at
					FROM session_notes
				`);
            }

            // Migrate smart_notes → notes (type='smart', preserve status)
            const hasSmartNotes = db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='smart_notes'")
                .get();
            if (hasSmartNotes) {
                db.exec(`
					INSERT INTO notes (type, status, content, session_id, project_path, surface_condition,
						created_at, updated_at, last_checked_at, ready_at, ready_reason)
					SELECT 'smart', status, content, created_session_id, project_path, surface_condition,
						created_at, updated_at, last_checked_at, ready_at, ready_reason
					FROM smart_notes
				`);
            }

            // Drop old tables only after verifying row counts match
            if (hasSessionNotes) {
                const sourceCount = (
                    db.prepare("SELECT COUNT(*) as c FROM session_notes").get() as { c: number }
                ).c;
                const migratedCount = (
                    db.prepare("SELECT COUNT(*) as c FROM notes WHERE type = 'session'").get() as {
                        c: number;
                    }
                ).c;
                if (migratedCount >= sourceCount) {
                    db.exec("DROP TABLE session_notes");
                } else {
                    throw new Error(
                        `session_notes migration verification failed: expected ${sourceCount} rows, got ${migratedCount}`,
                    );
                }
            }
            if (hasSmartNotes) {
                const sourceCount = (
                    db.prepare("SELECT COUNT(*) as c FROM smart_notes").get() as { c: number }
                ).c;
                const migratedCount = (
                    db.prepare("SELECT COUNT(*) as c FROM notes WHERE type = 'smart'").get() as {
                        c: number;
                    }
                ).c;
                if (migratedCount >= sourceCount) {
                    db.exec("DROP TABLE smart_notes");
                } else {
                    throw new Error(
                        `smart_notes migration verification failed: expected ${sourceCount} rows, got ${migratedCount}`,
                    );
                }
            }
        },
    },
    {
        version: 2,
        description: "Add plugin_messages table for TUI ↔ server communication",
        up: (db: Database) => {
            db.exec(`
				CREATE TABLE IF NOT EXISTS plugin_messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					direction TEXT NOT NULL,
					type TEXT NOT NULL,
					payload TEXT NOT NULL DEFAULT '{}',
					session_id TEXT,
					created_at INTEGER NOT NULL,
					consumed_at INTEGER
				);
				CREATE INDEX IF NOT EXISTS idx_plugin_messages_direction_consumed
					ON plugin_messages(direction, consumed_at);
				CREATE INDEX IF NOT EXISTS idx_plugin_messages_created
					ON plugin_messages(created_at);
			`);
        },
    },
    {
        version: 3,
        description: "Add user_memory_candidates and user_memories tables",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS user_memory_candidates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    source_compartment_start INTEGER,
                    source_compartment_end INTEGER,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_umc_created ON user_memory_candidates(created_at);

                CREATE TABLE IF NOT EXISTS user_memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    promoted_at INTEGER NOT NULL,
                    source_candidate_ids TEXT DEFAULT '[]',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_um_status ON user_memories(status);
            `);
        },
    },
    {
        version: 4,
        description: "Add git_commits + git_commit_embeddings + git_commits_fts tables",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS git_commits (
                    sha TEXT PRIMARY KEY,
                    project_path TEXT NOT NULL,
                    short_sha TEXT NOT NULL,
                    message TEXT NOT NULL,
                    author TEXT,
                    committed_at INTEGER NOT NULL,
                    indexed_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_git_commits_project_time
                    ON git_commits(project_path, committed_at DESC);

                CREATE TABLE IF NOT EXISTS git_commit_embeddings (
                    sha TEXT PRIMARY KEY,
                    embedding BLOB NOT NULL,
                    model_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    -- FK-cascade audit (v12): git_commit_embeddings.sha -> git_commits.sha
                    -- uses ON DELETE CASCADE, so SQLite PRAGMA foreign_keys must be ON on
                    -- every connection and v12 cleans historical orphan rows.
                    FOREIGN KEY(sha) REFERENCES git_commits(sha) ON DELETE CASCADE
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS git_commits_fts USING fts5(
                    sha UNINDEXED,
                    project_path UNINDEXED,
                    message,
                    tokenize = 'porter unicode61'
                );

                -- Mirror writes into FTS. We intentionally rebuild FTS rows on
                -- every INSERT OR REPLACE so amended commits or re-indexed
                -- messages update cleanly.
                CREATE TRIGGER IF NOT EXISTS git_commits_fts_insert
                AFTER INSERT ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = NEW.sha;
                    INSERT INTO git_commits_fts(sha, project_path, message)
                    VALUES (NEW.sha, NEW.project_path, NEW.message);
                END;

                CREATE TRIGGER IF NOT EXISTS git_commits_fts_delete
                AFTER DELETE ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = OLD.sha;
                END;

                CREATE TRIGGER IF NOT EXISTS git_commits_fts_update
                AFTER UPDATE OF message, project_path ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = OLD.sha;
                    INSERT INTO git_commits_fts(sha, project_path, message)
                    VALUES (NEW.sha, NEW.project_path, NEW.message);
                END;
            `);
        },
    },
    {
        version: 5,
        description: "One-shot heal of NULL session_meta columns",
        // Previous releases ran healNullTextColumns/healNullIntegerColumns/
        // healMissingMemoryBlockIds on every plugin startup — ~25 no-op UPDATE
        // statements per launch, each acquiring a write lock for zero rows on
        // DBs that had already been healed.
        //
        // Moving the heal into the versioned migration system means it runs
        // exactly once: on the v4 → v5 upgrade for existing users, and as part
        // of first-boot schema setup for brand-new DBs (fresh DBs have no NULL
        // columns to heal — the heals are best-effort and short-circuit cheaply
        // when there's nothing to fix, so running v5 on a fresh DB is a no-op).
        //
        // Future schema changes that ADD new columns to session_meta should
        // add a follow-up heal migration if those columns risk NULL on
        // pre-existing rows. ensureColumn() in initializeDatabase() is still
        // the source of truth for column existence; this migration only fixes
        // legacy NULL data.
        up: (db: Database) => {
            healAllNullColumns(db);
        },
    },
    {
        version: 6,
        description: "Heal session_meta.counter drift below MAX(tag_number)",
        // Tagger counter and tags.tag_number can diverge for several reasons,
        // most of them now fixed:
        //   - Pre-v0.15.7 the outer db.transaction in tagMessages would
        //     rollback ALL tag inserts in a pass on a single UNIQUE collision,
        //     leaving inner-savepoint tag inserts already committed but the
        //     counter upsert undone. Net effect: max(tag_number) > counter.
        //   - Multi-process bursts could hit similar races even though tag
        //     numbers were per-session.
        //   - Pre-v0.15.7 ON CONFLICT counter upsert used `excluded.counter`
        //     unconditionally (non-monotonic), so any low writer could undo
        //     a higher writer's update.
        //
        // Once divergence existed, the old initFromDb early-returned when the
        // session was already known in memory, so the counter could never
        // self-heal: every assignTag would propose `counter + 1`, which often
        // collided with a tag_number an old writer had already claimed, and
        // the old recovery (lookup by message_id) returned null for new
        // messages and threw — cascading into the cache-bust loop we shipped
        // a fix for in v0.15.7.
        //
        // This one-shot heal brings every divergent session back into sync.
        // Cheap (one indexed scan over tags + one targeted UPDATE per
        // affected session) and idempotent — a fresh DB or already-healed DB
        // updates zero rows.
        up: (db: Database) => {
            db.prepare(
                `UPDATE session_meta
                 SET counter = (
                     SELECT MAX(tag_number)
                     FROM tags
                     WHERE tags.session_id = session_meta.session_id
                 )
                 WHERE EXISTS (
                     SELECT 1
                     FROM tags
                     WHERE tags.session_id = session_meta.session_id
                       AND tags.tag_number > session_meta.counter
                 )`,
            ).run();
        },
    },
    {
        version: 7,
        description: "Add harness column to notes table for cross-harness sharing",
        // The unified `notes` table was created by migration v1. As of
        // plugin v0.16+ we share `~/.local/share/cortexkit/magic-context/`
        // between OpenCode and Pi, so every session-scoped table needs to
        // record which harness wrote each row. All other session-scoped
        // tables get the column via ensureColumn() in initializeDatabase()
        // (which runs before this migration). `notes` is the only table
        // initializeDatabase() can't touch — it doesn't exist yet at that
        // point because v1 creates it. So we ALTER TABLE here.
        //
        // SQLite physically backfills NOT NULL DEFAULT on existing rows,
        // so all pre-v0.16 notes transparently become harness='opencode'.
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(notes)").all() as Array<{ name?: string }>;
            if (!cols.some((c) => c.name === "harness")) {
                db.exec("ALTER TABLE notes ADD COLUMN harness TEXT NOT NULL DEFAULT 'opencode'");
            }
        },
    },
    {
        version: 8,
        description: "Add partial indexes on tags(session_id, tag_number) for active and dropped",
        // Hot-path optimization. The existing index
        // `idx_tags_session_tag_number ON tags(session_id, tag_number)`
        // covers `WHERE session_id = ?` but not the `status = ?` predicate,
        // so SQLite's planner falls back to scanning every tag in a session
        // (~50k rows on long-lived sessions) for the active-only and
        // dropped-only queries that run on every transform pass.
        //
        // Partial indexes restrict the index to rows matching the WHERE
        // clause, so:
        //   - `getActiveTagsBySession` becomes an index-only scan over the
        //     active rows (typically <1% of total tags),
        //   - `getMaxDroppedTagNumber` becomes a single backward index seek.
        //
        // Benchmarked at ~110× speedup on a 49k-tag session (67ms → 0.6ms
        // for the combined per-pass workload). See
        // `packages/plugin/scripts/benchmark-tag-queries.ts`.
        //
        // ANALYZE is run after creation so the planner has stats for the
        // new indexes the first time it sees a query against this DB.
        up: (db: Database) => {
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_tags_active_session_tag_number
                ON tags(session_id, tag_number)
                WHERE status = 'active';

                CREATE INDEX IF NOT EXISTS idx_tags_dropped_session_tag_number
                ON tags(session_id, tag_number)
                WHERE status = 'dropped';
            `);
            db.exec("ANALYZE tags;");
        },
    },
    {
        version: 9,
        description: "Persist tool_definition_measurements across plugin restarts",
        // The `tool.definition` plugin hook fires once per tool per
        // `ToolRegistry.tools()` call and produces our per-tool token
        // measurements. Pre-v9 these measurements lived only in an
        // in-process Map, so a plugin restart wiped them and the sidebar's
        // "Tool Defs" segment showed 0 tokens until the next chat.message
        // fired the hook chain again.
        //
        // Persisting to SQLite lets us repopulate the in-memory store at
        // openDatabase() time, so the sidebar shows the correct value
        // immediately after restart. Composite primary key matches the
        // in-memory keying (provider/model/agent/tool) so re-recording the
        // same key is a single INSERT OR REPLACE that updates the token
        // count and recorded_at without growing the table.
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS tool_definition_measurements (
                    provider_id TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    agent_name TEXT NOT NULL,
                    tool_id TEXT NOT NULL,
                    token_count INTEGER NOT NULL,
                    recorded_at INTEGER NOT NULL,
                    PRIMARY KEY (provider_id, model_id, agent_name, tool_id)
                );
            `);
        },
    },
    {
        version: 10,
        description: "Add tool_owner_message_id column to tags + composite identity indexes",
        // Tag-owner identity fix (plan v3.3.1). Pre-v10 tool tags were
        // keyed solely by (session_id, callID), but OpenCode generates
        // callIDs per-turn rather than per-session. When two assistant
        // turns produce a tool with the same internal counter (e.g.
        // `read:32`), the tagger looked up the existing row by callID
        // and bound the new occurrence to the original tag — replaying
        // the original tag's drop status onto fresh content. Wire-level
        // failures on Kimi/Moonshot followed because the resulting
        // assistant message had reasoning_content stripped but no
        // accompanying tool_use blocks.
        //
        // Persistent identity for tool tags becomes the triple
        // (session_id, callID, tool_owner_message_id). Existing rows get
        // NULL owner; the runtime lazy-adopts them on first observation
        // (one-shot adoption per orphan, defense-in-depth) and a
        // separate backfill pass populates owner from the OpenCode DB
        // (primary correctness mechanism).
        //
        // The partial UNIQUE index prevents duplicate composite identity
        // rows once owner is populated. The lookup index accelerates
        // the lazy-adoption NULL fallback path.
        //
        // SQLite metadata-only ALTER (~5ms on 353MB DB).
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(tags)").all() as Array<{
                name?: string;
            }>;
            if (!cols.some((c) => c.name === "tool_owner_message_id")) {
                db.exec("ALTER TABLE tags ADD COLUMN tool_owner_message_id TEXT DEFAULT NULL");
            }
            db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_tool_composite
                ON tags(session_id, message_id, tool_owner_message_id)
                WHERE type = 'tool' AND tool_owner_message_id IS NOT NULL;

                CREATE INDEX IF NOT EXISTS idx_tags_tool_null_owner
                ON tags(session_id, message_id)
                WHERE type = 'tool' AND tool_owner_message_id IS NULL;
            `);
        },
    },
    {
        version: 11,
        description: "Add todo state synthesis columns to session_meta",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            // Snapshot of the most recent todowrite call's args.todos, written
            // by hook-handlers.ts on tool.execute.after. Source of truth for
            // synthetic injection on cache-busting passes.
            if (!cols.some((c) => c.name === "last_todo_state")) {
                db.exec("ALTER TABLE session_meta ADD COLUMN last_todo_state TEXT DEFAULT ''");
            }
            // Synthetic call_id of the most recently injected todowrite tool
            // part. Deterministic (sha256 of the snapshot JSON) — recorded so
            // defer-pass replay can verify byte-shape stability.
            if (!cols.some((c) => c.name === "todo_synthetic_call_id")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN todo_synthetic_call_id TEXT DEFAULT ''",
                );
            }
            // Assistant message ID where the synthetic todowrite tool part is
            // anchored. Used by defer-pass replay to land at the exact same
            // message; if the anchor message disappears from the visible
            // window, the next cache-busting pass re-anchors.
            if (!cols.some((c) => c.name === "todo_synthetic_anchor_message_id")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN todo_synthetic_anchor_message_id TEXT DEFAULT ''",
                );
            }
            // Snapshot JSON of the todos as they existed at the moment we
            // injected. Defer-pass replay rebuilds the synthetic part from
            // THIS persisted state, not from `last_todo_state`. This keeps
            // T0-cache-bust → T1-defer prefix bytes identical even when a
            // real `todowrite` mutates `last_todo_state` between T0 and T1
            // (defer passes never refresh content; the next cache-busting
            // pass adopts the new state).
            if (!cols.some((c) => c.name === "todo_synthetic_state_json")) {
                db.exec(
                    "ALTER TABLE session_meta ADD COLUMN todo_synthetic_state_json TEXT DEFAULT ''",
                );
            }
        },
    },
    {
        version: 12,
        description: "Clean orphan rows from FK-cascade embedding tables",
        up: (db: Database) => {
            const hasTable = (name: string): boolean =>
                Boolean(
                    db
                        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
                        .get(name),
                );

            const memoryEmbeddings = hasTable("memory_embeddings")
                ? db
                      .prepare(
                          `DELETE FROM memory_embeddings
                           WHERE memory_id NOT IN (SELECT id FROM memories)`,
                      )
                      .run().changes
                : 0;
            log(`[migrations] v12 cleaned ${memoryEmbeddings} orphan memory_embeddings row(s)`);

            const gitCommitEmbeddings = hasTable("git_commit_embeddings")
                ? db
                      .prepare(
                          `DELETE FROM git_commit_embeddings
                           WHERE sha NOT IN (SELECT sha FROM git_commits)`,
                      )
                      .run().changes
                : 0;
            log(
                `[migrations] v12 cleaned ${gitCommitEmbeddings} orphan git_commit_embeddings row(s)`,
            );
        },
    },
    {
        version: 13,
        description: "Add pending_compaction_marker_state column for deferred marker drain",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            // CAS blob storing the deferred compaction-marker payload between
            // background publish (compartment-runner-incremental) and the
            // next consuming pass (transform-postprocess-phase). Intentionally
            // declared WITHOUT `DEFAULT ''` so absence is signalled as SQL
            // NULL — see `getSessionsWithPendingMarker` / `healNullTextColumns`
            // contracts in storage-db.ts. Plan v6 §3.
            if (!cols.some((c) => c.name === "pending_compaction_marker_state")) {
                db.exec("ALTER TABLE session_meta ADD COLUMN pending_compaction_marker_state TEXT");
            }
        },
    },
    {
        version: 14,
        description: "Add project-scoped key files and version counter",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS project_key_files (
                    project_path           TEXT    NOT NULL,
                    path                   TEXT    NOT NULL,
                    content                TEXT    NOT NULL,
                    content_hash           TEXT    NOT NULL,
                    local_token_estimate   INTEGER NOT NULL,
                    generated_at           INTEGER NOT NULL,
                    generated_by_model     TEXT,
                    generation_config_hash TEXT    NOT NULL,
                    stale_reason           TEXT,
                    PRIMARY KEY (project_path, path)
                );

                CREATE INDEX IF NOT EXISTS idx_project_key_files_project
                    ON project_key_files(project_path);
                CREATE INDEX IF NOT EXISTS idx_project_key_files_generated_at
                    ON project_key_files(project_path, generated_at);

                CREATE TABLE IF NOT EXISTS project_key_files_version (
                    project_path TEXT    PRIMARY KEY,
                    version      INTEGER NOT NULL DEFAULT 0
                );
            `);
        },
    },
    {
        version: 15,
        description: "Add deferred_execute_state column for boundary execution drain",
        up: (db: Database) => {
            const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name?: string;
            }>;
            // CAS blob storing the deferred-execute payload between a mid-turn
            // scheduler execute decision and the next boundary pass that
            // successfully runs execute work. Intentionally declared WITHOUT
            // `DEFAULT ''` so absence is signalled as SQL NULL, matching
            // pending_compaction_marker_state. Excluded from null-heal lists.
            if (!cols.some((c) => c.name === "deferred_execute_state")) {
                db.exec("ALTER TABLE session_meta ADD COLUMN deferred_execute_state TEXT");
            }
        },
    },
];

function ensureMigrationsTable(db: Database): void {
    db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			description TEXT NOT NULL,
			applied_at INTEGER NOT NULL
		)
	`);
}

function getCurrentVersion(db: Database): number {
    const row = db.prepare("SELECT MAX(version) as version FROM schema_migrations").get() as {
        version: number | null;
    } | null;
    return row?.version ?? 0;
}

/**
 * Detect the specific case where a sibling process already committed the
 * same `schema_migrations` row we're about to insert. Two OpenCode/Pi
 * instances starting concurrently can both read `MAX(version)=N` before
 * either commits. The first commits v(N+1); the second's transaction body
 * runs `migration.up()` (a no-op now that the schema change already
 * landed), then hits PRIMARY KEY conflict on the
 * `INSERT INTO schema_migrations` row.
 *
 * Without this guard the plugin fail-closes and the second instance
 * refuses to start. With it, we recognize "sibling beat us to it",
 * re-read the version, and continue from the next pending migration.
 *
 * Important: only PRIMARY KEY conflicts on `schema_migrations` are
 * swallowed. Any other failure (CREATE TABLE, ALTER TABLE, data heal,
 * etc.) surfaces normally and fail-closes per contract.
 */
function isSiblingMigrationConflict(error: unknown, version: number): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as { code?: unknown }).code;
    if (code !== "SQLITE_CONSTRAINT_PRIMARYKEY" && code !== "SQLITE_CONSTRAINT_UNIQUE") {
        return false;
    }
    // Distinguish "PRIMARY KEY conflict on schema_migrations(version)"
    // from any other UNIQUE/PK collision the migration body could surface.
    // SQLite's better-sqlite3 binding includes the constraint in the
    // message, e.g. "UNIQUE constraint failed: schema_migrations.version".
    const msg = error.message;
    if (!msg.includes("schema_migrations")) return false;
    if (!msg.toLowerCase().includes("version")) return false;
    // Final guard: confirm the row is actually present now. If something
    // else somehow produced this error shape without the row landing, we
    // want to fall through to fail-closed.
    void version; // version is implicit from the row check above
    return true;
}

/**
 * Run all pending migrations sequentially.
 * Each migration runs in its own transaction — if it fails, only that migration rolls back.
 * Already-applied migrations are skipped.
 *
 * Multi-instance race tolerance: when two plugin processes start against
 * the same shared DB, both can read the same MAX(version) before either
 * commits. The first wins; the second's INSERT into schema_migrations
 * fails with a PRIMARY KEY conflict. We catch that specific case and
 * resume from the next pending migration. All other migration errors
 * still fail-close per the existing contract.
 */
export function runMigrations(db: Database): void {
    ensureMigrationsTable(db);

    let currentVersion = getCurrentVersion(db);
    let pendingMigrations = MIGRATIONS.filter((m) => m.version > currentVersion);

    if (pendingMigrations.length === 0) {
        return;
    }

    log(
        `[migrations] current schema version: ${currentVersion}, applying ${pendingMigrations.length} migration(s)`,
    );

    let migrationIndex = 0;
    while (migrationIndex < pendingMigrations.length) {
        const migration = pendingMigrations[migrationIndex];
        try {
            db.transaction(() => {
                migration.up(db);
                db.prepare(
                    "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
                ).run(migration.version, migration.description, Date.now());
            })();
            log(`[migrations] applied v${migration.version}: ${migration.description}`);
            migrationIndex += 1;
        } catch (error) {
            if (isSiblingMigrationConflict(error, migration.version)) {
                // Sibling process committed this version between our
                // MAX(version) read and our INSERT. Re-read the version
                // and rebuild the pending list — the sibling may have
                // applied multiple migrations while we were preparing
                // this one.
                log(
                    `[migrations] v${migration.version} already applied by sibling instance — resuming with re-read version`,
                );
                const reReadVersion = getCurrentVersion(db);
                if (reReadVersion <= currentVersion) {
                    // Defensive: sibling-conflict shape detected but
                    // version didn't actually advance. Treat as a real
                    // failure to avoid an infinite loop on a malformed
                    // error.
                    log(
                        `[migrations] FAILED v${migration.version}: sibling-conflict shape but version not advanced (${reReadVersion} <= ${currentVersion}) — failing closed`,
                    );
                    throw new Error(
                        `Migration v${migration.version} failed: sibling conflict reported but version did not advance. Database may need manual repair.`,
                    );
                }
                currentVersion = reReadVersion;
                pendingMigrations = MIGRATIONS.filter((m) => m.version > currentVersion);
                migrationIndex = 0;
                continue;
            }
            log(
                `[migrations] FAILED v${migration.version}: ${migration.description} — ${error instanceof Error ? error.message : String(error)}`,
            );
            throw new Error(
                `Migration v${migration.version} failed: ${error instanceof Error ? error.message : String(error)}. Database may need manual repair.`,
            );
        }
    }

    log(`[migrations] schema version now: ${MIGRATIONS[MIGRATIONS.length - 1].version}`);
}
