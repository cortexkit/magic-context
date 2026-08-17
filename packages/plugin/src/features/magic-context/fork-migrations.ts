/**
 * Downstream-lane migrations owned by this fork.
 *
 * Upstream reserves `schema_migrations` versions below
 * `FORK_MIGRATION_VERSION_FLOOR` (10000) for itself and everything at or above
 * it for forks sharing `context.db` (docs/migration-version-lanes.md). This
 * module holds our side of that boundary.
 *
 * Why a separate array and runner instead of appending to `MIGRATIONS`:
 *
 *  1. Upstream appends new migrations at the end of the `MIGRATIONS` literal.
 *     A fork entry living there collides on essentially every release. Keeping
 *     our entries out of that array removes the conflict surface entirely.
 *  2. `LATEST_MIGRATION_VERSION` is a bare max over `MIGRATIONS`, and the
 *     schema fence asserts it equals `LATEST_SUPPORTED_VERSION`. A fork version
 *     inside that array would drag the fence ceiling to 10100+ — above anything
 *     upstream's `getPersistedVersion()` can return, since that reads
 *     `MAX(version) WHERE version < FORK_MIGRATION_VERSION_FLOOR`.
 *  3. A dozen upstream migration tests assert the newest `schema_migrations`
 *     row equals `LATEST_MIGRATION_VERSION`. Applying fork rows inside
 *     `runMigrations` would break all of them and force permanent divergence in
 *     upstream-owned test files.
 *
 * So `runMigrations()` stays byte-identical to upstream and `runForkMigrations()`
 * runs as a second pass from the real open path in storage-db.ts.
 *
 * Subrange allocation for this fork (we are our own allocator; upstream provides
 * one lane, not a registry):
 *
 *   10000-10099  skill-memory   (P1 10000, P2 10001, P3a 10002)
 *   10100-10199  external memory (allocated on the external-memory branch)
 */

import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    FORK_MIGRATION_VERSION_FLOOR,
    isSiblingMigrationConflict,
    isSqliteLockError,
    type Migration,
    MigrationLockBusyError,
} from "./migrations";
import { ensureColumn } from "./storage-schema-helpers";

function columnExists(db: Database, table: string, column: string): boolean {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    return rows.some((row) => row.name === column);
}

export const FORK_MIGRATIONS: Migration[] = [
    {
        // Skill-memory P1: per-skill cross-session recall.
        //
        // Renumbered on nearly every upstream release (v38 -> v39 -> v42 -> v54 ->
        // v70 -> v73 -> v75) before moving here. Subrange 10000-10099 is this
        // fork's skill-memory allocation.
        //
        // NOTE: skill-memory is also proposed upstream as PR #181, where it stays
        // in the UPSTREAM lane (v75/76/77) -- a PR to upstream is not a fork, so
        // its migrations belong in upstream's range. This union branch is what we
        // actually run, so here they live in the fork lane and never collide.
        version: 10_000,
        description: "Add skill_memory table for per-skill cross-session recall",
        up: (db: Database) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS skill_memory (
                  id              INTEGER PRIMARY KEY AUTOINCREMENT,
                  skill_id        TEXT NOT NULL,
                  resolved_path   TEXT NOT NULL,
                  tier            TEXT NOT NULL CHECK(tier IN ('project', 'global')),
                  skill_source    TEXT CHECK(skill_source IN (
                                    'opencode-project', 'opencode-global',
                                    'claude-skills', 'agents-skills'
                                  )),
                  project_identity TEXT NOT NULL,
                  intent          TEXT NOT NULL,
                  intent_embedding BLOB,
                  embedding_model_version TEXT,
                  kind            TEXT NOT NULL CHECK(kind IN ('gotcha', 'discovery', 'fix', 'workflow')),
                  delta           TEXT NOT NULL,
                  tags            TEXT,
                  hit_count       INTEGER NOT NULL DEFAULT 0,
                  pinned          INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
                  normalized_hash TEXT NOT NULL,
                  created_at      INTEGER NOT NULL,
                  last_used_at    INTEGER,
                  UNIQUE(skill_id, tier, project_identity, normalized_hash)
                );

                CREATE INDEX IF NOT EXISTS idx_skill_memory_lookup
                  ON skill_memory(skill_id, tier, project_identity, last_used_at DESC);

                CREATE INDEX IF NOT EXISTS idx_skill_memory_fts_prep
                  ON skill_memory(skill_id, tier, project_identity, kind);
            `);
        },
    },

    {
        // Skill-memory P2: was v39/v43/v55/v71/v74 across earlier rebases;
        // renumbered across upstream migrations — now v76 after upstream v0.34.0
        // took v73-v74 (skill-P1 is v75, skill-P2 v76, skill-P3a v77).
        version: 10_001,
        description:
            "Skill-memory P2: delta_embedding + recall_count columns + skill_memory_fts FTS5 vtable",
        up: (db: Database) => {
            // skill_memory is migration-only (created by v75); ALTER is safe here.
            if (!columnExists(db, "skill_memory", "delta_embedding")) {
                db.exec(`ALTER TABLE skill_memory ADD COLUMN delta_embedding BLOB;`);
            }

            // recall_count: read-side usage counter, bumped each time a note is surfaced
            // in a recall block (distinct from hit_count, which is write-side re-record salience).
            // Answers "which notes are recalled most". NOT_NULL+DEFAULT is valid in ALTER ADD COLUMN.
            if (!columnExists(db, "skill_memory", "recall_count")) {
                db.exec(
                    `ALTER TABLE skill_memory ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0;`,
                );
            }

            // FTS5 over (intent, delta), content-linked to skill_memory — mirrors memories_fts.
            db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS skill_memory_fts USING fts5(
                  intent,
                  delta,
                  content='skill_memory',
                  content_rowid='id',
                  tokenize='porter unicode61'
                );

                CREATE TRIGGER IF NOT EXISTS skill_memory_ai AFTER INSERT ON skill_memory BEGIN
                  INSERT INTO skill_memory_fts(rowid, intent, delta) VALUES (new.id, new.intent, new.delta);
                END;

                CREATE TRIGGER IF NOT EXISTS skill_memory_ad AFTER DELETE ON skill_memory BEGIN
                  INSERT INTO skill_memory_fts(skill_memory_fts, rowid, intent, delta) VALUES ('delete', old.id, old.intent, old.delta);
                END;

                CREATE TRIGGER IF NOT EXISTS skill_memory_au AFTER UPDATE ON skill_memory BEGIN
                  INSERT INTO skill_memory_fts(skill_memory_fts, rowid, intent, delta) VALUES ('delete', old.id, old.intent, old.delta);
                  INSERT INTO skill_memory_fts(rowid, intent, delta) VALUES (new.id, new.intent, new.delta);
                END;
            `);

            // Backfill the FTS index for any existing skill_memory rows. External-content FTS5 tables
            // expose content rowids immediately, so a `NOT IN (SELECT rowid FROM …_fts)` guard is a no-op;
            // the 'rebuild' command is the correct way to (re)populate an external-content index.
            db.exec(`INSERT INTO skill_memory_fts(skill_memory_fts) VALUES('rebuild');`);
        },
    },
    {
        // Skill-memory historian extraction: was v41/v44/v56/v72/v75 across
        // earlier rebases; renumbered across upstream migrations — now v77 after
        // upstream v0.34.0 took v73-v74 (skill is now v75/76/77).
        version: 10_002,
        description:
            "Skill-memory historian extraction: origin_project + source_type columns; unify global-tier notes under project_identity='*' (collision-merge)",
        up: (db: Database) => {
            db.transaction(() => {
                if (!columnExists(db, "skill_memory", "origin_project")) {
                    db.exec(`ALTER TABLE skill_memory ADD COLUMN origin_project TEXT;`);
                }
                if (!columnExists(db, "skill_memory", "source_type")) {
                    db.exec(`ALTER TABLE skill_memory ADD COLUMN source_type TEXT;`);
                }

                // resolved_path stays TEXT NOT NULL; historian writes the '' sentinel
                // (handled in storage layer, not here).
                const groups = db
                    .prepare(
                        `SELECT skill_id, normalized_hash, COUNT(*) AS n, MIN(created_at) AS min_created,
                                SUM(hit_count) AS sum_hit, SUM(recall_count) AS sum_recall, MAX(last_used_at) AS max_used
                         FROM skill_memory
                         WHERE tier='global' AND project_identity != '*'
                         GROUP BY skill_id, normalized_hash HAVING COUNT(*) > 1`,
                    )
                    .all() as Array<{
                    skill_id: string;
                    normalized_hash: string;
                    n: number;
                    min_created: number;
                    sum_hit: number;
                    sum_recall: number;
                    max_used: number | null;
                }>;
                for (const g of groups) {
                    const survivor = db
                        .prepare(
                            `SELECT id, project_identity FROM skill_memory
                             WHERE skill_id=? AND normalized_hash=? AND tier='global' AND project_identity != '*'
                             ORDER BY created_at ASC, id ASC LIMIT 1`,
                        )
                        .get(g.skill_id, g.normalized_hash) as {
                        id: number;
                        project_identity: string;
                    };
                    db.prepare(
                        `DELETE FROM skill_memory WHERE skill_id=? AND normalized_hash=? AND tier='global' AND project_identity != '*' AND id != ?`,
                    ).run(g.skill_id, g.normalized_hash, survivor.id);
                    db.prepare(
                        `UPDATE skill_memory SET hit_count=?, recall_count=?, last_used_at=?, origin_project=?, project_identity='*' WHERE id=?`,
                    ).run(
                        g.sum_hit,
                        g.sum_recall,
                        g.max_used,
                        survivor.project_identity,
                        survivor.id,
                    );
                }

                // Defensive (S4): drop any pre-'*' row whose (skill_id, normalized_hash)
                // already has a '*' sibling. Dead code in normal flow — v41 is the only
                // writer of '*' rows and runs atomically, so a pre-'*' row can't coexist
                // with a '*' sibling after a clean run. It only fires if a prior v41 run
                // was interrupted after creating some '*' rows but before finishing; in
                // that case the '*' row is canonical and the leftover pre-'*' row is
                // dropped rather than colliding on the singleton UPDATE below.
                db.prepare(
                    `DELETE FROM skill_memory AS s
                     WHERE s.tier='global' AND s.project_identity != '*'
                       AND EXISTS (SELECT 1 FROM skill_memory g WHERE g.tier='global' AND g.project_identity='*' AND g.skill_id=s.skill_id AND g.normalized_hash=s.normalized_hash)`,
                ).run();

                db.prepare(
                    `UPDATE skill_memory SET origin_project = project_identity, project_identity = '*' WHERE tier='global' AND project_identity != '*'`,
                ).run();
            })();
        },
    },
];

/**
 * Highest version this fork owns in the downstream lane, or 0 when the branch
 * carries no fork migrations.
 *
 * NOT a schema fence: nothing refuses to open a database because of it, because
 * fork rows are fence-invisible by design. It exists so fork-owned migration
 * tests can assert against the lane they live in instead of hardcoding a literal
 * that drifts whenever a subrange is reallocated.
 */
export const LATEST_FORK_MIGRATION_VERSION: number = FORK_MIGRATIONS.reduce(
    (max, migration) => Math.max(max, migration.version),
    0,
);

function schemaMigrationsTableExists(db: Database): boolean {
    return (
        db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations' LIMIT 1",
            )
            .get() != null
    );
}

function isForkMigrationApplied(db: Database, version: number): boolean {
    return db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version) != null;
}

/**
 * Apply pending downstream-lane migrations.
 *
 * Selection is by per-row presence only — deliberately NOT by the
 * `version > currentVersion` watermark upstream uses. Upstream's watermark reads
 * `MAX(version) WHERE version < FORK_MIGRATION_VERSION_FLOOR`, so it can never
 * describe fork rows; checking each row directly is what makes this pass immune
 * to the renumber-collision skip that previously required manual DB repair.
 *
 * Requires `schema_migrations` to exist, which `runMigrations()` guarantees.
 * Callers must run the upstream pass first; a fork migration's DDL may depend on
 * upstream tables.
 *
 * Each migration runs in its own immediate transaction, matching upstream's
 * per-migration isolation: a failure rolls back only that migration.
 */
export function runForkMigrations(db: Database): void {
    if (FORK_MIGRATIONS.length === 0) return;
    if (!schemaMigrationsTableExists(db)) {
        throw new Error(
            "runForkMigrations requires the schema_migrations table; call runMigrations(db) first",
        );
    }

    const ordered = [...FORK_MIGRATIONS].sort((a, b) => a.version - b.version);
    let loggedPlan = false;

    for (const migration of ordered) {
        if (migration.version < FORK_MIGRATION_VERSION_FLOOR) {
            // Fail loudly rather than silently corrupting the upstream lane: a
            // fork migration below the floor would be swept into upstream's
            // watermark and could make its runner skip a real upstream body.
            throw new Error(
                `Fork migration v${migration.version} is below the downstream floor ${FORK_MIGRATION_VERSION_FLOOR}`,
            );
        }

        try {
            const applied = db
                .transaction(() => {
                    if (isForkMigrationApplied(db, migration.version)) return false;
                    if (!loggedPlan) {
                        const pending = ordered.filter(
                            (candidate) => !isForkMigrationApplied(db, candidate.version),
                        ).length;
                        log(`[migrations] fork lane: applying ${pending} downstream migration(s)`);
                        loggedPlan = true;
                    }
                    migration.up(db);
                    db.prepare(
                        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
                    ).run(migration.version, migration.description, Date.now());
                    return true;
                })
                .immediate();

            if (applied) {
                log(`[migrations] applied fork v${migration.version}: ${migration.description}`);
            }
        } catch (error) {
            if (isSqliteLockError(error)) {
                throw new MigrationLockBusyError(
                    `failed to acquire migration write lock for fork v${migration.version}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
            if (isSiblingMigrationConflict(db, error, migration.version)) {
                log(
                    `[migrations] fork v${migration.version} already applied by sibling instance — continuing`,
                );
                continue;
            }
            const detail = error instanceof Error ? error.message : String(error);
            log(
                `[migrations] FAILED fork v${migration.version}: ${migration.description} — ${detail}`,
            );
            throw new Error(
                `Fork migration v${migration.version} failed: ${detail}. Database may need manual repair.`,
            );
        }
    }
}
