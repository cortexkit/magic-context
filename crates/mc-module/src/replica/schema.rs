//! What the replicated tables carry to the user's other computers, and the
//! store objects that capture their changes ([`install`], run by
//! `context.db` migration 112).
//!
//! Every column of a replicated table is listed here as replicated or local
//! (a schema test fails on a column in neither list, so a new column needs
//! a decision). Replicated columns travel in a message's snapshot, and a
//! change to one of them is captured. Local columns name this computer's
//! own state (read counters, sessions, embeddings) and never leave it.
//!
//! Capture happens in the store, so no writer has to remember it: triggers
//! on each replicated table write one `replica_outbox` row per changed row
//! and raise the row's `revision`. Several changes to a row before it is
//! published share one outbox row and one revision, since only the newest
//! state is ever sent.

use rusqlite::Transaction;

/// One replicated table.
pub(crate) struct Table {
    /// The outbox and wire kind.
    pub kind: &'static str,
    pub name: &'static str,
    /// Columns carried in the snapshot. A change to any of them is captured.
    pub replicated: &'static [&'static str],
    /// Columns that stay on this computer. Nothing reads them but the
    /// schema test, which fails on a column in neither list.
    #[cfg_attr(not(test), allow(dead_code))]
    pub local: &'static [&'static str],
}

/// Columns every replicated table has that are message fields rather than
/// snapshot fields: the row's global id, and the revision a message names.
/// Listed for the schema test.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const WIRE: [&str; 2] = ["global_id", "revision"];

pub(crate) const MEMORIES: Table = Table {
    kind: "memory",
    name: "memories",
    replicated: &[
        "level",
        "owner_id",
        "category",
        "origin_category",
        "origin_profile",
        "origin_profile_version",
        "origin_profile_digest",
        "content",
        "normalized_hash",
        "importance",
        "scope",
        "shareable",
        "source_project_id",
        "source_type",
        "source_agent_id",
        "applies_to_json",
        // A link: carried as the target's global id.
        "overrides_memory_id",
        "overrides_revision",
        "authority",
        "epistemic",
        "decay_class",
        "sensitive",
        "first_seen_at",
        "created_at",
        "status",
        "expires_at",
        "verification_status",
        "verified_at",
        "classified_at",
        // A link: carried as the target's global id.
        "superseded_by_memory_id",
        // Links: carried as the sources' global ids.
        "merged_from",
        // Carried without the keys that name this computer's state
        // (`super::snapshot::LOCAL_METADATA_KEYS`).
        "metadata_json",
        "mural_cue",
        "mural_cue_hash",
        "mural_cue_at",
        "mural_cue_rejection_count",
        "safety_critical",
        "verify_result",
        "verify_files_json",
        "verify_commit",
        "source_branch",
        "source_commit",
    ],
    local: &[
        "id",
        "seen_count",
        "retrieval_count",
        "last_seen_at",
        "last_retrieved_at",
        // The read counters' writers set it together with the counters, so
        // it can't be replicated without a counter update being captured.
        "updated_at",
        // Both name a session on this computer.
        "source_session_id",
        "source_ordinals_json",
    ],
};

pub(crate) const OBSERVATIONS: Table = Table {
    kind: "observation",
    name: "memory_observations",
    replicated: &[
        "content",
        "proposed_category",
        "origin_profile",
        "origin_profile_version",
        "origin_profile_digest",
        "agent_id",
        "project_id",
        "workspace_id",
        "created_at",
        // So the review that keeps the user profile takes an observation
        // once, whichever computer runs it.
        "consumed_at",
    ],
    // The session and its message ordinals are this computer's. An arrival
    // is stored with an empty session id.
    local: &[
        "id",
        "session_id",
        "source_start_ordinal",
        "source_end_ordinal",
    ],
};

pub(crate) const PRIMERS: Table = Table {
    kind: "primer",
    name: "primers",
    replicated: &[
        "project_path",
        "question",
        "answer",
        "status",
        // These two are counted from the primer candidates on the computer
        // whose dreamer promoted or refreshed the primer. The candidates
        // themselves stay local (they belong to sessions), so other
        // computers take the counts as sent.
        "total_support",
        "last_observed_at",
        "answer_refreshed_at",
        "created_at",
    ],
    local: &[
        "id",
        "question_embedding",
        "question_embedding_model_id",
        // They name primer candidates, which are local.
        "source_candidate_ids",
        "source_candidate_provenance",
        "updated_at",
    ],
};

/// The replicated tables, in the order their kinds are listed.
pub(crate) const TABLES: [&Table; 3] = [&MEMORIES, &OBSERVATIONS, &PRIMERS];

/// A table whose rows travel inside the snapshot of the memory that owns
/// them, and the column naming that memory. A change to one of its rows is
/// a change of that memory.
pub(crate) struct Child {
    pub name: &'static str,
    pub owner: &'static str,
    pub replicated: &'static [&'static str],
}

pub(crate) const CHILDREN: [Child; 3] = [
    // The files a memory is backed by (the map task's file mappings).
    Child {
        name: "memory_verifications",
        owner: "memory_id",
        replicated: &[
            "memory_id",
            "file_path",
            "verified_at",
            "mapped_at",
            "mapping_origin",
        ],
    },
    // A memory that replaces another: owned by the newer one, the successor.
    Child {
        name: "memory_successor_links",
        owner: "successor_id",
        replicated: &["source_id", "successor_id", "decision_key"],
    },
    // Two memories found to contradict each other: owned by the newer one,
    // the right end (`left_id < right_id`).
    Child {
        name: "memory_conflict_links",
        owner: "right_id",
        replicated: &["left_id", "right_id", "decision_key"],
    },
];

/// Outbox states in which the row's current revision has never left this
/// computer, so a further change may keep it.
const UNSENT: &str = "('pending', 'too_large', 'unaddressable')";

/// Milliseconds since the epoch, in SQL any SQLite has.
const NOW_MS: &str = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";

/// The capture triggers skip a change while an apply transaction is open on
/// this connection. Apply inserts the row of `replica_applying` when its
/// `BEGIN IMMEDIATE` transaction starts and deletes it before it commits, so
/// no other connection ever sees it: SQLite has one writer at a time, and
/// the row is never committed. It is a main-schema table, not a TEMP one,
/// because SQLite refuses a main-schema trigger that names a TEMP table, and
/// reading the TEMP schema through `pragma_table_list` would need
/// `trusted_schema` on every connection that writes these tables.
const CAPTURING: &str = "NOT EXISTS (SELECT 1 FROM replica_applying)";

/// The writer a captured change names: the row of `replica_writer` a writer
/// put in its own transaction (the dreamer does), or `fallback`.
fn writer(fallback: &str) -> String {
    format!(
        "COALESCE((SELECT actor FROM replica_writer LIMIT 1), {fallback}),
         (SELECT run_id FROM replica_writer LIMIT 1),
         (SELECT epoch FROM replica_writer LIMIT 1)"
    )
}

/// The statement that records a change of row `id` at `revision` in the
/// outbox. A row keeps one unpublished outbox row: a later change replaces
/// it, keeping the base revision and `create` while nothing of it was sent,
/// and a plain metadata change never hides the more telling kind of an
/// earlier change it joins.
fn queue(kind: &str, id: &str, revision: &str, base: &str, change: &str, actor: &str) -> String {
    format!(
        "INSERT INTO replica_outbox
             (kind, local_id, revision, base_revision, change, created_at, actor, run_id, epoch)
         VALUES ('{kind}', {id}, {revision}, {base}, {change}, {NOW_MS}, {writer})
         ON CONFLICT (kind, local_id) WHERE state <> 'published' DO UPDATE SET
             base_revision = CASE WHEN replica_outbox.state IN {UNSENT}
                 THEN replica_outbox.base_revision ELSE excluded.base_revision END,
             change = CASE
                 WHEN replica_outbox.state IN {UNSENT} AND replica_outbox.change = 'create'
                 THEN 'create'
                 WHEN replica_outbox.state IN {UNSENT} AND excluded.change = 'metadata'
                 THEN replica_outbox.change
                 ELSE excluded.change END,
             revision = excluded.revision,
             created_at = excluded.created_at,
             state = 'pending',
             stream_seq = NULL,
             actor = excluded.actor,
             run_id = excluded.run_id,
             epoch = excluded.epoch;",
        writer = writer(actor),
    )
}

/// Raise row `id`'s revision for a change, unless the current revision is
/// still unsent: an unsent revision can carry any number of changes, since
/// the publisher reads the row as it is when it sends it. A row without a
/// global id was never sent at all.
fn raise(table: &Table, id: &str, condition: &str) -> String {
    format!(
        "UPDATE {name} SET revision = revision + 1
          WHERE id = {id} AND {condition} AND global_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM replica_outbox o
                             WHERE o.kind = '{kind}' AND o.local_id = {id}
                               AND o.state IN {UNSENT} AND o.revision = {name}.revision);",
        name = table.name,
        kind = table.kind,
    )
}

/// `NEW.a IS NOT OLD.a OR …` over `columns`: an update that rewrites a
/// value unchanged changes nothing to send. A memory's `metadata_json` is
/// compared without the keys that stay on this computer, so a change to
/// one of those alone sends nothing either.
fn any_changed(columns: &[&str]) -> String {
    columns
        .iter()
        .map(|column| match *column {
            "metadata_json" => format!(
                "{} IS NOT {}",
                shared_metadata("NEW.metadata_json"),
                shared_metadata("OLD.metadata_json")
            ),
            _ => format!("NEW.{column} IS NOT OLD.{column}"),
        })
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// `value` without the metadata keys that stay on this computer, in SQL.
/// Text that isn't valid JSON is compared as it is, since `json_remove`
/// would fail the writer's statement on it.
fn shared_metadata(value: &str) -> String {
    let paths = super::snapshot::LOCAL_METADATA_KEYS
        .iter()
        .map(|key| format!("'$.{key}'"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("(CASE WHEN json_valid({value}) THEN json_remove({value}, {paths}) ELSE {value} END)")
}

/// The change kind of an update, for the journal and the apps; applying
/// never depends on it. A row never sent is still a create.
fn update_change(table: &Table) -> String {
    let text = match table.kind {
        "memory" => "content",
        "observation" => "content",
        _ => "answer",
    };
    let status = table.replicated.contains(&"status");
    let mut arms = vec!["WHEN NEW.global_id IS NULL THEN 'create'".to_owned()];
    if status {
        arms.push(
            "WHEN OLD.status = 'archived' AND NEW.status IS NOT 'archived' THEN 'restore'".into(),
        );
        arms.push(
            "WHEN NEW.status = 'archived' AND OLD.status IS NOT 'archived' THEN 'archive'".into(),
        );
    }
    if table.kind == "memory" {
        arms.push(
            "WHEN NEW.merged_from IS NOT OLD.merged_from
               OR NEW.superseded_by_memory_id IS NOT OLD.superseded_by_memory_id THEN 'merge'"
                .into(),
        );
    }
    let mut changed = format!("NEW.{text} IS NOT OLD.{text}");
    if table.kind == "primer" {
        changed.push_str(" OR NEW.question IS NOT OLD.question");
    }
    arms.push(format!("WHEN {changed} THEN 'update'"));
    format!("CASE {} ELSE 'metadata' END", arms.join(" "))
}

/// The capture triggers of one replicated table.
fn table_triggers(table: &Table) -> String {
    let (name, kind) = (table.name, table.kind);
    // Agent-level memories never replicate: an agent lives on one computer,
    // and its memories travel with it through the agent-data move. A row
    // that moves to another level is captured then, as a create.
    let (new_level, old_level) = if kind == "memory" {
        ("NEW.level <> 'agent' AND ", "OLD.level <> 'agent' AND ")
    } else {
        ("", "")
    };
    let created_by = if kind == "memory" {
        "COALESCE(NEW.source_type, 'ck-mc')"
    } else {
        "'ck-mc'"
    };
    let mut watched: Vec<&str> = table.replicated.to_vec();
    // Writers of memories raise the revision themselves, often in a
    // statement of its own before the rest of the change; watching it
    // records that change at the revision the writer gave it.
    if kind == "memory" {
        watched.push("revision");
    }
    let insert = format!(
        "CREATE TRIGGER {name}_replica_ai AFTER INSERT ON {name}
         WHEN {new_level}{CAPTURING}
         BEGIN
             {queue}
         END;",
        queue = queue(kind, "NEW.id", "NEW.revision", "0", "'create'", created_by),
    );
    let update = format!(
        "CREATE TRIGGER {name}_replica_au AFTER UPDATE OF {columns} ON {name}
         WHEN {new_level}{CAPTURING} AND ({changed})
         BEGIN
             {raise}
             {queue}
         END;",
        columns = watched.join(", "),
        changed = any_changed(&watched),
        raise = raise(table, "NEW.id", "NEW.revision = OLD.revision"),
        queue = queue(
            kind,
            "NEW.id",
            &format!("(SELECT revision FROM {name} WHERE id = NEW.id)"),
            "OLD.revision",
            &update_change(table),
            "'ck-mc'",
        ),
    );
    // A row never sent is known nowhere else, so its delete sends nothing.
    // A sent row's delete sends a tombstone under its global id, which the
    // outbox row carries, with the level and owner its subject needs,
    // because the row is gone by the time it is sent.
    let (level, owner) = match kind {
        "memory" => ("OLD.level", "OLD.owner_id"),
        "primer" => ("NULL", "OLD.project_path"),
        _ => ("NULL", "NULL"),
    };
    let delete = format!(
        "CREATE TRIGGER {name}_replica_ad AFTER DELETE ON {name}
         WHEN {old_level}{CAPTURING}
         BEGIN
             DELETE FROM replica_outbox
              WHERE kind = '{kind}' AND local_id = OLD.id AND state <> 'published'
                AND OLD.global_id IS NULL;
             INSERT INTO replica_outbox
                 (kind, local_id, revision, base_revision, change, created_at, actor, run_id,
                  epoch, global_id, level, owner)
             SELECT '{kind}', OLD.id, OLD.revision + 1, OLD.revision, 'delete', {NOW_MS},
                    {writer}, OLD.global_id, {level}, {owner}
              WHERE OLD.global_id IS NOT NULL
             ON CONFLICT (kind, local_id) WHERE state <> 'published' DO UPDATE SET
                 revision = excluded.revision,
                 base_revision = excluded.base_revision,
                 change = 'delete',
                 created_at = excluded.created_at,
                 state = 'pending',
                 stream_seq = NULL,
                 global_id = excluded.global_id,
                 level = excluded.level,
                 owner = excluded.owner,
                 actor = excluded.actor,
                 run_id = excluded.run_id,
                 epoch = excluded.epoch;
         END;",
        writer = writer("'ck-mc'"),
    );
    format!("{insert}\n{update}\n{delete}")
}

/// The triggers of a child table: any change to one of its rows is a
/// change of the memory that owns it. They only raise that memory's
/// revision; the memory's own update trigger records the change.
fn child_triggers(child: &Child) -> String {
    let (name, owner) = (child.name, child.owner);
    let raise_for = |row: &str| raise(&MEMORIES, &format!("{row}.{owner}"), "level <> 'agent'");
    format!(
        "CREATE TRIGGER {name}_replica_ai AFTER INSERT ON {name}
         WHEN {CAPTURING}
         BEGIN
             {insert_raise}
         END;
         CREATE TRIGGER {name}_replica_au AFTER UPDATE ON {name}
         WHEN {CAPTURING} AND ({changed})
         BEGIN
             {old_raise}
             {insert_raise}
         END;
         CREATE TRIGGER {name}_replica_ad AFTER DELETE ON {name}
         WHEN {CAPTURING}
         BEGIN
             {old_raise}
         END;",
        insert_raise = raise_for("NEW"),
        old_raise = raise_for("OLD"),
        changed = any_changed(child.replicated),
    )
}

/// Migration 112's replication tables and capture triggers. Existing rows
/// are not queued: a computer publishes its rows when it first joins the
/// stream ([`super::join`]).
pub(crate) fn install(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "ALTER TABLE memories ADD COLUMN global_id TEXT;
         CREATE UNIQUE INDEX idx_memories_global_id ON memories(global_id)
             WHERE global_id IS NOT NULL;
         ALTER TABLE memory_observations ADD COLUMN global_id TEXT;
         ALTER TABLE memory_observations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
         CREATE UNIQUE INDEX idx_memory_observations_global_id
             ON memory_observations(global_id) WHERE global_id IS NOT NULL;
         ALTER TABLE primers ADD COLUMN global_id TEXT;
         ALTER TABLE primers ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
         CREATE UNIQUE INDEX idx_primers_global_id ON primers(global_id)
             WHERE global_id IS NOT NULL;

         -- Which local row each global id names. Several global ids may name
         -- one row: the same fact written on two computers. A deleted row's
         -- ids stay, marked deleted, so a late snapshot can't bring it back;
         -- `local_id` is null for a delete that arrived before its row.
         CREATE TABLE replica_ids (
           kind TEXT NOT NULL CHECK (kind IN ('memory', 'observation', 'primer')),
           global_id TEXT PRIMARY KEY,
           local_id INTEGER,
           deleted_at INTEGER
         );
         CREATE INDEX idx_replica_ids_local ON replica_ids(kind, local_id);

         -- Changes waiting to be sent, one unpublished row per local row.
         -- `published` rows wait for the stream to deliver them back: until
         -- then this computer's change is later in the stream than anything
         -- it receives for that row. A delete carries the row's global id,
         -- level and owner, since the row is gone when it is sent.
         CREATE TABLE replica_outbox (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           kind TEXT NOT NULL CHECK (kind IN ('memory', 'observation', 'primer')),
           local_id INTEGER NOT NULL,
           revision INTEGER NOT NULL,
           base_revision INTEGER NOT NULL,
           change TEXT NOT NULL CHECK (change IN
             ('create', 'update', 'merge', 'archive', 'restore', 'metadata', 'delete')),
           created_at INTEGER NOT NULL,
           state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
             ('pending', 'sending', 'published', 'too_large', 'unaddressable')),
           global_id TEXT,
           level TEXT,
           owner TEXT,
           stream_seq INTEGER,
           actor TEXT NOT NULL,
           run_id INTEGER,
           epoch INTEGER
         );
         CREATE UNIQUE INDEX idx_replica_outbox_row ON replica_outbox(kind, local_id)
           WHERE state <> 'published';
         CREATE INDEX idx_replica_outbox_state ON replica_outbox(state, id);

         -- Stream messages that could not be opened or applied: recorded,
         -- acknowledged and skipped, so one bad message never stops the rest.
         CREATE TABLE replica_rejects (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           stream_seq INTEGER NOT NULL,
           subject TEXT NOT NULL,
           global_id TEXT,
           reason TEXT NOT NULL,
           recorded_at INTEGER NOT NULL
         );

         -- The stream position applied so far, this computer's box id, and
         -- when it first joined the stream (null until then).
         CREATE TABLE replica_state (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           stream_seq INTEGER NOT NULL DEFAULT 0,
           box_id TEXT,
           joined_at INTEGER
         );
         INSERT INTO replica_state (id) VALUES (1);

         -- Holds a row only inside an apply transaction; see the triggers.
         CREATE TABLE replica_applying (applying INTEGER NOT NULL);

         -- Who is writing, while a writer that names itself holds a row here
         -- inside its own transaction (the dreamer's change lists); the
         -- triggers copy it into the outbox row.
         CREATE TABLE replica_writer (
           actor TEXT NOT NULL,
           run_id INTEGER,
           epoch INTEGER
         );

         -- Links an arrival names to a global id not seen yet. Resolved, and
         -- deleted, when that id arrives.
         CREATE TABLE replica_pending_links (
           kind TEXT NOT NULL,
           local_id INTEGER NOT NULL,
           field TEXT NOT NULL,
           target_global_id TEXT NOT NULL,
           detail TEXT,
           PRIMARY KEY (kind, local_id, field, target_global_id)
         );
         CREATE INDEX idx_replica_pending_links_target
           ON replica_pending_links(target_global_id);

         -- The primers' search index is kept by an update trigger that fired
         -- on every column. The capture trigger raises a primer's revision in
         -- a nested update, which would make it re-index the row while the
         -- outer update's own re-index is still to come, and leave the index
         -- out of step with the table. It now fires only for the columns the
         -- index holds.
         DROP TRIGGER IF EXISTS primers_au;
         CREATE TRIGGER primers_au AFTER UPDATE OF question, answer, project_path ON primers BEGIN
           INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
           VALUES ('delete', old.id, old.question, old.answer, old.project_path);
           INSERT INTO primers_fts(rowid, question, answer, project_path)
           VALUES (new.id, new.question, new.answer, new.project_path);
         END;

         -- The Engram memory sync's tables; the hub replaces it.
         DROP TABLE IF EXISTS memory_ops;
         DROP TABLE IF EXISTS memory_outbox;
         DROP TABLE IF EXISTS memory_sync_state;",
    )?;
    for table in TABLES {
        tx.execute_batch(&table_triggers(table))?;
    }
    for child in &CHILDREN {
        tx.execute_batch(&child_triggers(child))?;
    }
    Ok(())
}
