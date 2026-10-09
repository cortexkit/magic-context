import type { Database } from "../../shared/sqlite";
import { ensureColumn } from "./storage-schema-helpers";

/** Adds rescore storage on fresh stores and upgrades without changing compartments or compartment_history_versions. */
export function installCompartmentRescoreSchema(db: Database): void {
    // Sparse legacy stores may not have session metadata yet. Normal boot
    // creates session_meta before calling this installer.
    if (db.prepare("PRAGMA table_info(session_meta)").all().length > 0) {
        ensureColumn(
            db,
            "session_meta",
            "cached_m0_score_selection_watermark",
            "INTEGER NOT NULL DEFAULT 0 CHECK (cached_m0_score_selection_watermark BETWEEN 0 AND 9223372036854775807)",
        );
    }
    db.exec(`
        CREATE TABLE IF NOT EXISTS rescore_snapshots (
            id TEXT PRIMARY KEY NOT NULL,
            scope TEXT NOT NULL CHECK (scope IN ('session', 'project')),
            scope_key TEXT NOT NULL,
            project_path TEXT NOT NULL,
            target_sessions TEXT NOT NULL,
            items TEXT NOT NULL,
            cutoff INTEGER NOT NULL,
            rubric_version INTEGER NOT NULL,
            model_profile TEXT NOT NULL,
            seed_policy TEXT NOT NULL,
            cost_estimate TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            superseded_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_rescore_snapshots_scope
            ON rescore_snapshots(scope, scope_key, created_at);
        CREATE TRIGGER IF NOT EXISTS rescore_snapshots_frozen
            BEFORE UPDATE OF id, scope, scope_key, project_path, target_sessions, items,
                cutoff, rubric_version, model_profile, seed_policy, cost_estimate, created_at
            ON rescore_snapshots BEGIN
                SELECT RAISE(ABORT, 'rescore snapshot is immutable');
            END;

        CREATE TABLE IF NOT EXISTS rescore_jobs (
            id TEXT PRIMARY KEY NOT NULL,
            snapshot_id TEXT NOT NULL REFERENCES rescore_snapshots(id),
            originating_harness TEXT NOT NULL,
            project_path TEXT NOT NULL,
            model_profile TEXT NOT NULL,
            cutoff INTEGER NOT NULL,
            rubric_version INTEGER NOT NULL,
            owner_generation INTEGER NOT NULL DEFAULT 1 CHECK (owner_generation > 0),
            heartbeat_at INTEGER NOT NULL,
            consecutive_failed_batches INTEGER NOT NULL DEFAULT 0
                CHECK (consecutive_failed_batches >= 0),
            last_error TEXT,
            state TEXT NOT NULL CHECK (state IN
                ('running', 'paused', 'auto-paused', 'interrupted', 'cancelled', 'complete')),
            pause_reason TEXT,
            blocking_job_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rescore_jobs_project
            ON rescore_jobs(project_path, state);

        CREATE TABLE IF NOT EXISTS rescore_batches (
            id TEXT PRIMARY KEY NOT NULL,
            job_id TEXT NOT NULL REFERENCES rescore_jobs(id),
            sequence INTEGER NOT NULL CHECK (sequence >= 1),
            state TEXT NOT NULL CHECK (state IN
                ('pending', 'running', 'published', 'failed', 'cancelled')),
            current_attempt_id TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE (job_id, sequence)
        );

        CREATE TABLE IF NOT EXISTS rescore_attempts (
            id TEXT PRIMARY KEY NOT NULL,
            job_id TEXT NOT NULL REFERENCES rescore_jobs(id),
            batch_id TEXT NOT NULL REFERENCES rescore_batches(id),
            state TEXT NOT NULL CHECK (state IN ('admitted', 'settled', 'abandoned', 'cancelled')),
            outcome TEXT CHECK (outcome IN ('published', 'failed')),
            handle_map TEXT NOT NULL,
            prompt_hash TEXT NOT NULL,
            seed_ids TEXT NOT NULL,
            model TEXT NOT NULL,
            owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
            admitted_at INTEGER NOT NULL,
            carrier_run_id TEXT,
            payload TEXT,
            item_outcomes TEXT,
            settled_at INTEGER,
            CHECK ((state = 'settled' AND outcome IS NOT NULL)
                OR (state != 'settled' AND outcome IS NULL)),
            CHECK (state = 'admitted' OR payload IS NULL)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_rescore_attempts_one_admitted_per_job
            ON rescore_attempts(job_id) WHERE state = 'admitted';
        CREATE INDEX IF NOT EXISTS idx_rescore_attempts_batch ON rescore_attempts(batch_id);

        CREATE TABLE IF NOT EXISTS rescore_items (
            id TEXT PRIMARY KEY NOT NULL,
            job_id TEXT NOT NULL REFERENCES rescore_jobs(id),
            target_session_id TEXT NOT NULL,
            compartment_id INTEGER NOT NULL,
            source_identity TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN
                ('pending', 'running', 'completed', 'failed', 'oversize', 'cancelled', 'stale', 'skipped')),
            batch_id TEXT REFERENCES rescore_batches(id),
            attempt_id TEXT REFERENCES rescore_attempts(id),
            skipped_job_id TEXT,
            UNIQUE (job_id, target_session_id, compartment_id)
        );
        CREATE INDEX IF NOT EXISTS idx_rescore_items_source
            ON rescore_items(compartment_id, source_identity, state);

        -- These two tables deliberately have no foreign key to compartments:
        -- deletion or id reuse must not erase accepted revisions or undo history.
        CREATE TABLE IF NOT EXISTS compartment_score_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            compartment_id INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            source_identity TEXT NOT NULL,
            old_importance INTEGER NOT NULL CHECK (old_importance BETWEEN 1 AND 100),
            new_importance INTEGER NOT NULL CHECK (new_importance BETWEEN 1 AND 100),
            rubric_version INTEGER NOT NULL,
            prompt_hash TEXT NOT NULL,
            model TEXT NOT NULL,
            seed_ids TEXT NOT NULL,
            job_id TEXT NOT NULL,
            batch_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            completed_at INTEGER NOT NULL,
            reason TEXT NOT NULL,
            UNIQUE (compartment_id, source_identity, rubric_version),
            UNIQUE (id, session_id, compartment_id)
        );
        CREATE INDEX IF NOT EXISTS idx_compartment_score_revisions_session
            ON compartment_score_revisions(session_id);

        -- A NULL revision_id means base. NULL publication keys identify user undo.
        CREATE TABLE IF NOT EXISTS compartment_score_selections (
            session_id TEXT NOT NULL,
            compartment_id INTEGER NOT NULL,
            sequence INTEGER NOT NULL CHECK (sequence >= 1),
            revision_id INTEGER,
            origin TEXT NOT NULL CHECK (origin IN ('publication', 'undo')),
            job_id TEXT,
            batch_id TEXT,
            attempt_id TEXT,
            PRIMARY KEY (session_id, sequence),
            UNIQUE (job_id, batch_id, attempt_id, compartment_id),
            FOREIGN KEY (revision_id, session_id, compartment_id)
                REFERENCES compartment_score_revisions(id, session_id, compartment_id),
            CHECK ((origin = 'publication' AND revision_id IS NOT NULL
                    AND job_id IS NOT NULL AND batch_id IS NOT NULL AND attempt_id IS NOT NULL)
                OR (origin = 'undo' AND job_id IS NULL AND batch_id IS NULL AND attempt_id IS NULL))
        );
        CREATE INDEX IF NOT EXISTS idx_compartment_score_selections_view
            ON compartment_score_selections(session_id, compartment_id, sequence DESC);
        CREATE TRIGGER IF NOT EXISTS compartment_score_selections_no_update
            BEFORE UPDATE ON compartment_score_selections BEGIN
                SELECT RAISE(ABORT, 'score selections are append-only');
            END;

        CREATE TABLE IF NOT EXISTS rescore_activation (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            activated_at INTEGER NOT NULL
        );
    `);
    // Epoch milliseconds, like compartments.created_at. Only compartments older
    // than this first-open timestamp are eligible for rescoring. Later openers
    // preserve it so already-upgraded writers' new compartments stay excluded.
    db.prepare("INSERT OR IGNORE INTO rescore_activation(id, activated_at) VALUES (1, ?)").run(
        Date.now(),
    );
}
