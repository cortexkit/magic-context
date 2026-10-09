import type { Database } from "../../shared/sqlite";
import { ensureColumn } from "./storage-schema-helpers";

/** Project evidence survives deletion of the session that originally produced it. */
export function installMemoryLifecycleSchema(db: Database): void {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='memories'").get()) {
        ensureColumn(db, "memories", "revision", "INTEGER NOT NULL DEFAULT 1");
        ensureColumn(db, "memories", "verify_result", "TEXT");
        ensureColumn(db, "memories", "verify_files_json", "TEXT");
        ensureColumn(db, "memories", "verify_commit", "TEXT");
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_mutation_log'").get()) {
        ensureColumn(
            db,
            "memory_mutation_log",
            "adoption_class",
            "TEXT NOT NULL DEFAULT 'live' CHECK(adoption_class IN ('live','deferred'))",
        );
    }
    db.exec(`
        CREATE TABLE IF NOT EXISTS memory_publications (
            publication_id TEXT PRIMARY KEY,
            project_path TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            commit_order INTEGER UNIQUE,
            committed_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS memory_fact_blocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            publication_id TEXT NOT NULL REFERENCES memory_publications(publication_id),
            source_session_id TEXT NOT NULL,
            start_ordinal INTEGER NOT NULL,
            end_ordinal INTEGER NOT NULL CHECK(end_ordinal >= start_ordinal),
            role TEXT NOT NULL,
            parts_json TEXT NOT NULL,
            joined_text TEXT NOT NULL,
            UNIQUE(publication_id, start_ordinal, end_ordinal)
        );
        CREATE TABLE IF NOT EXISTS memory_pending_facts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            publication_id TEXT NOT NULL REFERENCES memory_publications(publication_id),
            fact_index INTEGER NOT NULL,
            compartment_id INTEGER,
            category TEXT NOT NULL,
            content TEXT NOT NULL,
            anchor_known INTEGER NOT NULL DEFAULT 0 CHECK(anchor_known IN (0,1)),
            state TEXT NOT NULL DEFAULT 'retryable' CHECK(state IN ('retryable','in_flight','applied','covered','decided_pending')),
            fact_attempts INTEGER NOT NULL DEFAULT 0 CHECK(fact_attempts >= 0),
            reason TEXT,
            reserved_stage_key TEXT,
            mapping_json TEXT,
            matched_memory_id INTEGER,
            UNIQUE(publication_id, fact_index)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_pending_backlog ON memory_pending_facts(project_path,state,publication_id,id);
        CREATE TABLE IF NOT EXISTS memory_fact_block_links (
            fact_id INTEGER NOT NULL REFERENCES memory_pending_facts(id),
            block_id INTEGER NOT NULL REFERENCES memory_fact_blocks(id),
            PRIMARY KEY(fact_id,block_id)
        );
        CREATE TABLE IF NOT EXISTS memory_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            previous_text TEXT NOT NULL,
            applied_at INTEGER NOT NULL,
            reason TEXT NOT NULL,
            evidence_json TEXT NOT NULL,
            source_ids_json TEXT NOT NULL,
            decision_key TEXT NOT NULL,
            UNIQUE(memory_id,revision)
        );
        CREATE TABLE IF NOT EXISTS memory_journal (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            decision_key TEXT NOT NULL UNIQUE,
            operation TEXT NOT NULL,
            receipt_json TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_clause_evidence (
            memory_id INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            clause_ordinal INTEGER NOT NULL,
            text_hash TEXT NOT NULL,
            evidence_json TEXT NOT NULL,
            PRIMARY KEY(memory_id,revision,clause_ordinal)
        );
        CREATE TABLE IF NOT EXISTS memory_successor_links (
            source_id INTEGER NOT NULL,
            successor_id INTEGER NOT NULL,
            decision_key TEXT NOT NULL,
            PRIMARY KEY(source_id,successor_id),
            CHECK(source_id != successor_id)
        );
        CREATE TABLE IF NOT EXISTS memory_conflict_links (
            left_id INTEGER NOT NULL,
            right_id INTEGER NOT NULL,
            decision_key TEXT NOT NULL,
            PRIMARY KEY(left_id,right_id),
            CHECK(left_id < right_id)
        );
        CREATE TABLE IF NOT EXISTS memory_classification_items (
            enqueue_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            memory_id INTEGER NOT NULL,
            saved_revision INTEGER NOT NULL,
            source_session_id TEXT NOT NULL,
            tool_call_part_id TEXT NOT NULL,
            save_ordinal INTEGER NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','scored')),
            excerpt TEXT,
            clipping_json TEXT,
            importance INTEGER,
            proposed_class TEXT,
            scored_at INTEGER,
            UNIQUE(memory_id,saved_revision),
            UNIQUE(project_path,source_session_id,tool_call_part_id)
        );
        CREATE TABLE IF NOT EXISTS memory_tool_proposals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            source_session_id TEXT,
            proposal_key TEXT UNIQUE,
            writer TEXT NOT NULL,
            operation TEXT NOT NULL,
            target_ids_json TEXT NOT NULL,
            expected_revisions_json TEXT NOT NULL,
            proposal_json TEXT NOT NULL,
            reason TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_stage_attempts (
            stage_key TEXT PRIMARY KEY,
            project_path TEXT NOT NULL,
            publication_id TEXT NOT NULL,
            run_attempt INTEGER NOT NULL,
            stage TEXT NOT NULL,
            session_id TEXT NOT NULL,
            harness TEXT NOT NULL DEFAULT 'opencode',
            child_session_id TEXT,
            carrier TEXT NOT NULL,
            state TEXT NOT NULL,
            classification_watermark INTEGER,
            request_json TEXT NOT NULL,
            reply_json TEXT,
            reported_profile_json TEXT,
            usage_json TEXT,
            started_at INTEGER NOT NULL,
            UNIQUE(project_path,publication_id,run_attempt,stage)
        );
        CREATE TABLE IF NOT EXISTS memory_check_attempts (
            check_key TEXT PRIMARY KEY,
            decision_key TEXT NOT NULL,
            session_id TEXT NOT NULL,
            harness TEXT NOT NULL DEFAULT 'opencode',
            kind TEXT NOT NULL,
            operand_ids_json TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            request_profile_hash TEXT NOT NULL,
            request_json TEXT NOT NULL,
            reply_json TEXT,
            reported_profile_json TEXT,
            usage_json TEXT,
            state TEXT NOT NULL,
            started_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_decision_receipts (
            decision_key TEXT PRIMARY KEY,
            project_path TEXT NOT NULL,
            fact_id INTEGER,
            receipt_json TEXT NOT NULL,
            resolved_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_activity_ledger (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            publication_id TEXT NOT NULL,
            compartment_id INTEGER NOT NULL,
            committed_at INTEGER NOT NULL,
            UNIQUE(publication_id,compartment_id)
        );
        CREATE TABLE IF NOT EXISTS memory_applied_snapshots (
            session_id TEXT NOT NULL,
            harness TEXT NOT NULL DEFAULT 'opencode',
            project_path TEXT NOT NULL,
            applied_epoch INTEGER NOT NULL,
            applied_mutation_cursor INTEGER NOT NULL,
            max_memory_id INTEGER NOT NULL,
            generation INTEGER NOT NULL,
            source_generation INTEGER NOT NULL,
            m0_bytes TEXT NOT NULL,
            m1_bytes TEXT NOT NULL,
            mural_payload TEXT NOT NULL,
            mural_hash TEXT NOT NULL,
            applied_revisions_json TEXT NOT NULL,
            selection_metadata_json TEXT NOT NULL,
            activity_expiry_clocks_json TEXT NOT NULL,
            policy_budget_identity_json TEXT NOT NULL,
            text_cue_search_manifest_json TEXT NOT NULL,
            admission_ledger_json TEXT NOT NULL,
            correction_receipts_json TEXT NOT NULL,
            correction_cursors_json TEXT NOT NULL,
            PRIMARY KEY(session_id,harness,project_path)
        );
        CREATE TABLE IF NOT EXISTS memory_applied_rows (
            session_id TEXT NOT NULL,
            harness TEXT NOT NULL DEFAULT 'opencode',
            project_path TEXT NOT NULL,
            memory_id INTEGER NOT NULL,
            applied_revision INTEGER NOT NULL,
            projected_text TEXT NOT NULL,
            projected_metadata_json TEXT NOT NULL,
            PRIMARY KEY(session_id,harness,project_path,memory_id)
        );
    `);
}
