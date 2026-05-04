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
 * Run all pending migrations sequentially.
 * Each migration runs in its own transaction — if it fails, only that migration rolls back.
 * Already-applied migrations are skipped.
 */
export function runMigrations(db: Database): void {
    ensureMigrationsTable(db);

    const currentVersion = getCurrentVersion(db);
    const pendingMigrations = MIGRATIONS.filter((m) => m.version > currentVersion);

    if (pendingMigrations.length === 0) {
        return;
    }

    log(
        `[migrations] current schema version: ${currentVersion}, applying ${pendingMigrations.length} migration(s)`,
    );

    for (const migration of pendingMigrations) {
        try {
            db.transaction(() => {
                migration.up(db);
                db.prepare(
                    "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
                ).run(migration.version, migration.description, Date.now());
            })();
            log(`[migrations] applied v${migration.version}: ${migration.description}`);
        } catch (error) {
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
