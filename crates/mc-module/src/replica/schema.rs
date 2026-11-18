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
/// computer, so a further change may keep it. `raised` is a revision a
/// writer raised with no replicated column changed: it is never sent by
/// itself, but a later change of the row rides on it instead of raising
/// the revision again.
const UNSENT: &str = "('pending', 'too_large', 'unaddressable', 'raised')";

/// The outbox rows a further change of their row joins, as the partial
/// unique index `idx_replica_outbox_row` holds them: at most one per row.
/// A row whose message is fixed (`frozen` holds its snapshot) takes no
/// further change, and the change starts a row of its own at a new
/// revision. A row is frozen when it is claimed to be sent, so a send
/// tried again carries the same message, and by the dreamer's change lists
/// ([`super::name_writer`]), so a change of one writer never travels in
/// another writer's message.
const COALESCING: &str = "state <> 'published' AND frozen IS NULL";

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

/// The writer a captured change names: the rows of `replica_writer` a
/// writer put in its own transaction (the dreamer does), or `fallback`.
/// Those rows hold one epoch per dreamer role the run holds; the change
/// takes the epoch of `role`, the role of the changed row, and none when
/// the run doesn't hold it. A project's run that records observations of
/// the person (reflect-events) sends them so, without an epoch, and no
/// receiver fences them: they are new rows drawn from one project's events,
/// not edits that two dreamers could fight over, so every receiver keeps
/// each one.
fn writer(fallback: &str, role: &str) -> String {
    format!(
        "COALESCE((SELECT actor FROM replica_writer LIMIT 1), {fallback}),
         (SELECT run_id FROM replica_writer LIMIT 1),
         (SELECT epoch FROM replica_writer WHERE role = {role})"
    )
}

/// The dreamer role of a memory at `level` under `owner` (SQL
/// expressions): `dreamer.global` for the person's own memories, and
/// `dreamer.<owner id>` for a project's or a workspace's, as
/// [`crate::dreamer::lease::role`] names them.
fn memory_role(level: &str, owner: &str) -> String {
    format!("(CASE WHEN {level} = 'global' THEN 'dreamer.global' ELSE 'dreamer.' || {owner} END)")
}

/// The dreamer role that owns row `row` (`NEW` or `OLD`) of `table`, in
/// SQL: the role whose lease a run holds to change it. Observations are the
/// person's, like global memories; a primer belongs to its project. A
/// receiver names a change's role by the same rule, from the subject the
/// change came on ([`super::apply`]).
pub(crate) fn row_role(table: &Table, row: &str) -> String {
    match table.kind {
        "memory" => memory_role(&format!("{row}.level"), &format!("{row}.owner_id")),
        "observation" => "'dreamer.global'".to_owned(),
        _ => format!("('dreamer.' || {row}.project_path)"),
    }
}

/// The statement that records a change of row `id` at `revision` in the
/// outbox, when `condition` holds. A row keeps one unpublished outbox row:
/// a later change replaces it, keeping the base revision and `create` while
/// nothing of it was sent, and a plain metadata change never hides the more
/// telling kind of an earlier change it joins. A `raised` row becomes a
/// change to send. `role` is the changed row's dreamer role ([`row_role`]).
#[allow(clippy::too_many_arguments)]
fn queue(
    kind: &str,
    id: &str,
    revision: &str,
    base: &str,
    change: &str,
    actor: &str,
    role: &str,
    condition: &str,
) -> String {
    format!(
        "INSERT INTO replica_outbox
             (kind, local_id, revision, base_revision, change, created_at, actor, run_id, epoch)
         SELECT '{kind}', {id}, {revision}, {base}, {change}, {NOW_MS}, {writer}
          WHERE {condition}
         ON CONFLICT (kind, local_id) WHERE {COALESCING} DO UPDATE SET
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
        writer = writer(actor, role),
    )
}

/// The outbox row of a memory revision a writer raised with no replicated
/// column changed, held as `raised`: never sent by itself, never counted as
/// a change of this computer's that holds back an arrival, and the revision
/// a later change of the row is sent at. An unpublished row it meets keeps
/// its state, and takes the new revision while that row is still unsent.
fn hold(id: &str, revision: &str, base: &str) -> String {
    format!(
        "INSERT INTO replica_outbox
             (kind, local_id, revision, base_revision, change, created_at, state, actor)
         VALUES ('memory', {id}, {revision}, {base}, 'metadata', {NOW_MS}, 'raised', 'ck-mc')
         ON CONFLICT (kind, local_id) WHERE {COALESCING} DO UPDATE SET
             revision = CASE WHEN replica_outbox.state IN {UNSENT}
                 THEN excluded.revision ELSE replica_outbox.revision END;"
    )
}

/// Copy memory `id`'s clause evidence from revision `from` to revision `to`
/// (SQL expressions over the memory, `m`) when `condition` holds. Readers
/// look a memory's clause evidence up at its current revision, so a
/// revision raised over unchanged text must keep it, as the writers that
/// raise the revision themselves do. Rows already there stay. The capture
/// triggers' own raise and an applied arrival ([`super::apply`]) both carry
/// it through this statement.
pub(crate) fn carry_evidence(id: &str, from: &str, to: &str, condition: &str) -> String {
    format!(
        "INSERT OR IGNORE INTO memory_clause_evidence
             (memory_id, revision, clause_ordinal, text_hash, evidence_json)
         SELECT e.memory_id, {to}, e.clause_ordinal, e.text_hash, e.evidence_json
           FROM memories m
           JOIN memory_clause_evidence e ON e.memory_id = m.id AND e.revision = {from}
          WHERE m.id = {id} AND {condition};"
    )
}

/// Whether the capture raises row `id`'s revision, with `row` naming the
/// row's table or an alias of it: the row was sent once, and its current
/// revision isn't still unsent. An unsent revision can carry any number of
/// changes, since the publisher reads the row as it is when it sends it.
/// A frozen row's revision is already taken by its fixed message, whatever
/// its state (`sending` included), so a change raises past it once.
fn raisable(table: &Table, row: &str, id: &str) -> String {
    format!(
        "{row}.global_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM replica_outbox o
                          WHERE o.kind = '{kind}' AND o.local_id = {id}
                            AND o.state IN {UNSENT} AND o.frozen IS NULL
                            AND o.revision = {row}.revision)",
        kind = table.kind,
    )
}

/// Raise row `id`'s revision for a change when `condition` (its columns
/// written `{row}.column`) and [`raisable`] hold. A memory's clause evidence
/// goes to the new revision first, under the same conditions, when
/// `keeps_text` holds too.
fn raise(table: &Table, id: &str, condition: &str, keeps_text: &str) -> String {
    let update = format!(
        "UPDATE {name} SET revision = revision + 1
          WHERE id = {id} AND {condition} AND {raisable};",
        name = table.name,
        condition = condition.replace("{row}", table.name),
        raisable = raisable(table, table.name, id),
    );
    if table.kind != MEMORIES.kind {
        return update;
    }
    let carry = carry_evidence(
        id,
        "m.revision",
        "m.revision + 1",
        &format!(
            "{} AND {} AND {keeps_text}",
            condition.replace("{row}", "m"),
            raisable(table, "m", id)
        ),
    );
    format!("{carry}\n{update}")
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
    // that moves from the agent level to another level is captured then, as
    // a create. A sent row moved into the agent level is not captured at
    // all, so the other computers keep it at its old level. No writer moves
    // a memory into the agent level today; one that ever does must send a
    // tombstone for the row's global id, as a delete does.
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
    let changed = any_changed(table.replicated);
    let insert = format!(
        "CREATE TRIGGER {name}_replica_ai AFTER INSERT ON {name}
         WHEN {new_level}{CAPTURING}
         BEGIN
             {queue}
         END;",
        queue = queue(
            kind,
            "NEW.id",
            "NEW.revision",
            "0",
            "'create'",
            created_by,
            &row_role(table, "NEW"),
            "1"
        ),
    );
    // A writer that sets a memory's status or successor itself takes over
    // from the archive this computer derived for it, the second of two rows
    // holding one fact ([`super::apply`]): what it wrote is the row's state
    // from then on, and is what gets sent.
    let derived = if kind == "memory" {
        "DELETE FROM replica_derived WHERE local_id = NEW.id
            AND (NEW.status IS NOT OLD.status
                 OR NEW.superseded_by_memory_id IS NOT OLD.superseded_by_memory_id);"
    } else {
        ""
    };
    let update = format!(
        "CREATE TRIGGER {name}_replica_au AFTER UPDATE OF {columns} ON {name}
         WHEN {new_level}{CAPTURING} AND ({changed})
         BEGIN
             {raise}
             {queue}
             {derived}
         END;",
        columns = table.replicated.join(", "),
        raise = raise(
            table,
            "NEW.id",
            "NEW.revision = OLD.revision",
            "NEW.content IS OLD.content"
        ),
        queue = queue(
            kind,
            "NEW.id",
            &format!("(SELECT revision FROM {name} WHERE id = NEW.id)"),
            "OLD.revision",
            &update_change(table),
            "'ck-mc'",
            &row_role(table, "NEW"),
            "1",
        ),
    );
    // Writers of memories often raise the revision in a statement of its
    // own before the rest of their change, and some raise it with nothing
    // replicated changed at all (the summarizer seeing a fact again). Such a
    // raise is held as `raised`: the change that follows, in the same
    // transaction or a later one, is sent at that revision, and a raise
    // alone is never sent. A row never sent has no revision anywhere else,
    // so its raises are not recorded.
    let raised = if kind == "memory" {
        format!(
            "CREATE TRIGGER {name}_replica_raised AFTER UPDATE OF revision ON {name}
             WHEN {new_level}NEW.global_id IS NOT NULL AND {CAPTURING}
                  AND NEW.revision IS NOT OLD.revision AND NOT ({changed})
             BEGIN
                 {hold}
             END;",
            hold = hold("NEW.id", "NEW.revision", "OLD.revision"),
        )
    } else {
        String::new()
    };
    // A row never sent is known nowhere else, so its delete sends nothing.
    // A sent row's delete sends a tombstone under its global id, which the
    // outbox row carries, with the level and owner its subject needs,
    // because the row is gone by the time it is sent. Its message is fixed
    // (`frozen` is JSON null, a delete's snapshot), so nothing joins it. The
    // row's changes still waiting to be sent go: the tombstone replaces them
    // on every computer. One being sent stays, as it may be in the stream
    // already, and so does one sent. The global id is marked deleted at
    // once, in the delete's own transaction, so no arrival read before the
    // tombstone is sent brings the row back.
    let (level, owner) = match kind {
        "memory" => ("OLD.level", "OLD.owner_id"),
        "primer" => ("NULL", "OLD.project_path"),
        _ => ("NULL", "NULL"),
    };
    let derived_gone = if kind == "memory" {
        "DELETE FROM replica_derived WHERE local_id = OLD.id;"
    } else {
        ""
    };
    let delete = format!(
        "CREATE TRIGGER {name}_replica_ad AFTER DELETE ON {name}
         WHEN {old_level}{CAPTURING}
         BEGIN
             DELETE FROM replica_outbox
              WHERE kind = '{kind}' AND local_id = OLD.id AND state NOT IN ('published', 'sending');
             INSERT INTO replica_outbox
                 (kind, local_id, revision, base_revision, change, created_at, actor, run_id,
                  epoch, global_id, level, owner, frozen)
             SELECT '{kind}', OLD.id, OLD.revision + 1, OLD.revision, 'delete', {NOW_MS},
                    {writer}, OLD.global_id, {level}, {owner}, 'null'
              WHERE OLD.global_id IS NOT NULL;
             INSERT INTO replica_ids (kind, global_id, local_id, deleted_at)
             SELECT '{kind}', OLD.global_id, OLD.id, {NOW_MS}
              WHERE OLD.global_id IS NOT NULL
             ON CONFLICT (global_id) DO UPDATE SET deleted_at = excluded.deleted_at;
             {derived_gone}
         END;",
        writer = writer("'ck-mc'", &row_role(table, "OLD")),
    );
    format!("{insert}\n{update}\n{raised}\n{delete}")
}

/// The triggers of a child table: any change to one of its rows is a
/// change of the memory that owns it, which is raised (with its clause
/// evidence) and queued.
fn child_triggers(child: &Child) -> String {
    let (name, owner) = (child.name, child.owner);
    let change_of = |row: &str| {
        let id = format!("{row}.{owner}");
        let raise = raise(&MEMORIES, &id, "{row}.level <> 'agent'", "1");
        let queue = queue(
            MEMORIES.kind,
            &id,
            &format!("(SELECT revision FROM memories WHERE id = {id})"),
            &format!(
                "(SELECT CASE WHEN global_id IS NULL THEN 0 ELSE revision - 1 END
                    FROM memories WHERE id = {id})"
            ),
            &format!(
                "(SELECT CASE WHEN global_id IS NULL THEN 'create' ELSE 'metadata' END
                    FROM memories WHERE id = {id})"
            ),
            "'ck-mc'",
            &format!(
                "(SELECT {} FROM memories WHERE id = {id})",
                memory_role("level", "owner_id")
            ),
            &format!("EXISTS (SELECT 1 FROM memories WHERE id = {id} AND level <> 'agent')"),
        );
        format!("{raise}\n{queue}")
    };
    format!(
        "CREATE TRIGGER {name}_replica_ai AFTER INSERT ON {name}
         WHEN {CAPTURING}
         BEGIN
             {new_change}
         END;
         CREATE TRIGGER {name}_replica_au AFTER UPDATE ON {name}
         WHEN {CAPTURING} AND ({changed})
         BEGIN
             {old_change}
             {new_change}
         END;
         CREATE TRIGGER {name}_replica_ad AFTER DELETE ON {name}
         WHEN {CAPTURING}
         BEGIN
             {old_change}
         END;",
        new_change = change_of("NEW"),
        old_change = change_of("OLD"),
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

         -- Which local row each global id names, one row per global id. A
         -- deleted row's id stays, marked deleted, so a late snapshot can't
         -- bring it back; `local_id` is null for a delete that arrived
         -- before its row.
         -- `revision` and `seq` name the message that decides the row's state
         -- on every computer, by the stream's order: the highest revision,
         -- and of equal ones the later in the stream. Null until one arrives.
         -- `written` is the newest outbox row id when that message's content
         -- was last written to the row here: this computer's own changes of
         -- the row with a higher outbox id were written over it. `undone` is
         -- the newest outbox row id of this computer's own changes of the
         -- row that were undone because they could no longer win, the row
         -- brought back to an older own change.
         CREATE TABLE replica_ids (
           kind TEXT NOT NULL CHECK (kind IN ('memory', 'observation', 'primer')),
           global_id TEXT PRIMARY KEY,
           local_id INTEGER,
           deleted_at INTEGER,
           revision INTEGER,
           seq INTEGER,
           written INTEGER,
           undone INTEGER
         );
         CREATE INDEX idx_replica_ids_local ON replica_ids(kind, local_id);

         -- Changes waiting to be sent. A local row has at most one row a
         -- further change joins; the others are frozen: `frozen` holds the
         -- snapshot their message carries, fixed when the row is claimed to
         -- be sent or by a dreamer's change list. `sender` is the store id
         -- the message id names, fixed when the row is first claimed, so a
         -- send tried again is the same message. `published` rows wait for
         -- the stream to deliver them back: until then this computer's change
         -- is later in the stream than anything it receives for that row. A
         -- delete carries the row's global id, level and owner, since the row
         -- is gone when it is sent.
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
             ('pending', 'sending', 'published', 'too_large', 'unaddressable', 'raised')),
           global_id TEXT,
           level TEXT,
           owner TEXT,
           stream_seq INTEGER,
           actor TEXT NOT NULL,
           run_id INTEGER,
           epoch INTEGER,
           sender TEXT,
           frozen TEXT
         );
         CREATE UNIQUE INDEX idx_replica_outbox_row ON replica_outbox(kind, local_id)
           WHERE state <> 'published' AND frozen IS NULL;
         CREATE INDEX idx_replica_outbox_local ON replica_outbox(kind, local_id);
         CREATE INDEX idx_replica_outbox_global ON replica_outbox(global_id, revision);
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

         -- The stream position applied so far, and the creation time of the
         -- stream it belongs to (a stream made anew is read from its start);
         -- the store id this store's global ids are formed under (32 random
         -- lowercase hex characters, made anew at the first join and when
         -- the store may have been copied or restored); the box id of the
         -- computer it last ran on; and when it first joined the stream (null
         -- until then).
         CREATE TABLE replica_state (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           stream_seq INTEGER NOT NULL DEFAULT 0,
           store_id TEXT NOT NULL,
           box_id TEXT,
           joined_at INTEGER,
           stream_created TEXT
         );
         INSERT INTO replica_state (id, store_id) VALUES (1, lower(hex(randomblob(16))));

         -- Memories this computer archived because another memory holds the
         -- same fact (owner, category and text) under a lower global id
         -- (`survivor`). The archive is this computer's alone: the row's own
         -- status and successor, as its last change gave them, are kept here,
         -- and are what is sent if the row is sent.
         CREATE TABLE replica_derived (
           local_id INTEGER PRIMARY KEY,
           survivor INTEGER,
           status TEXT,
           superseded_by INTEGER
         );
         CREATE INDEX idx_replica_derived_survivor ON replica_derived(survivor);

         -- Holds a row only inside an apply transaction; see the triggers.
         CREATE TABLE replica_applying (applying INTEGER NOT NULL);

         -- Who is writing, while a writer that names itself holds rows here
         -- inside its own transaction (the dreamer's change lists): one per
         -- dreamer role its run holds, with that role's lease generation, or
         -- one without a role. The triggers copy the actor and run into the
         -- outbox row, with the epoch of the changed row's own role.
         CREATE TABLE replica_writer (
           actor TEXT NOT NULL,
           run_id INTEGER,
           role TEXT,
           epoch INTEGER
         );

         -- The newest dreamer lease generation the stream holds a change of
         -- each row under, by the role the change was written for. It is the
         -- row's fence: a dreamer change of that row and role under an older
         -- epoch is skipped. It is read from the stream alone, so every
         -- computer at the same position fences the same.
         CREATE TABLE replica_fences (
           global_id TEXT NOT NULL,
           role TEXT NOT NULL,
           epoch INTEGER NOT NULL,
           PRIMARY KEY (global_id, role)
         );

         -- What every other computer holds for a row while this computer's
         -- own change of it is still to land: the stream's winning message
         -- among the arrivals that own change passed over, by the stream's
         -- order. It is applied if the own change can no longer win (fenced,
         -- too large to send, or beaten by a later arrival), and goes when the
         -- own change lands and wins or a later arrival beats both.
         CREATE TABLE replica_passed (
           global_id TEXT PRIMARY KEY,
           seq INTEGER NOT NULL,
           revision INTEGER NOT NULL,
           body TEXT NOT NULL
         );

         -- Rows to read again from the stream: this computer's own change
         -- of the row can no longer win, and the message every other computer
         -- holds for it (at `seq`) was applied here before that change wrote
         -- over it. The message is read again by its sequence and applied.
         CREATE TABLE replica_restore (
           global_id TEXT PRIMARY KEY,
           seq INTEGER NOT NULL
         );

         -- The fleet epochs this computer's vault has opened a message of.
         -- A message the vault can't open under one of them never will be.
         CREATE TABLE replica_epochs (epoch INTEGER PRIMARY KEY);

         -- Every memory holding a fact, live or not, for the rule that keeps
         -- one live memory per fact (the store's unique key counts live
         -- rows only, so its index can't find the others).
         CREATE INDEX idx_memories_fact
           ON memories(level, owner_id, category, normalized_hash);

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
