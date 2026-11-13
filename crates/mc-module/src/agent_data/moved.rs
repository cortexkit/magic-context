//! What a move carries from `context.db`, table by table and column by
//! column, and what it leaves behind.
//!
//! [`MOVED`] is the one list the snapshot reader, the snapshot decoder and
//! the install plan all walk, in its order, which puts every table after the
//! tables it refers to. Each column carries one [`Mark`]. [`NOT_MOVED`]
//! names every other table that holds session data or refers to a moved
//! row, with the reason it stays and what the install does with its rows.
//! A test reads the schema ck-mc is built against and fails when either
//! list no longer covers it.
//!
//! Row ids never travel. Every session on a machine shares `context.db`'s
//! ids, and other hosts write between install batches, so a carried id
//! would name some other row on the receiver. A row that other rows refer
//! to is named instead by its natural key within the session
//! ([`Table::key`]), and a reference is carried as that key and resolved
//! again on the receiver when the row is inserted.

/// The SQL that names the session's committed publications whose facts
/// still wait for a second turn, on parameters `?1` (session id) and `?2`
/// (harness). One predicate serves the snapshot read, the fingerprint, the
/// receiver's local rows, the collision check and the install's deletes, so
/// a move back finds the publications its first move still holds reserved.
///
/// A publication is the session's when its first turn was published under
/// the session's harness, as the summarizer finds a session's publications.
/// It is committed when it has a place in the project's backlog
/// (`commit_order`), the second turn's own rule. A fact waits when it is
/// `retryable`, or `in_flight` under a move's own reservation (`agent-data:`
/// followed by the id of the cut, the one move attempt that reserved it): a
/// second-turn send holds the other `in_flight` facts, and `applied`,
/// `covered` and `decided_pending` are final.
pub fn publications() -> String {
    format!(
        "SELECT p.publication_id FROM memory_publications p
         WHERE p.source_session_id = ?1 AND p.commit_order IS NOT NULL
           AND EXISTS (SELECT 1 FROM memory_stage_attempts s
                       WHERE s.publication_id = p.publication_id AND s.stage = 'turn_one'
                         AND s.state = 'published' AND s.session_id = p.source_session_id
                         AND s.harness = ?2)
           AND EXISTS (SELECT 1 FROM memory_pending_facts w
                       WHERE w.publication_id = p.publication_id AND {})",
        waiting("w")
    )
}

/// The session's publications whose first turn never committed. They stay
/// behind and are counted as dropped: their facts were never extracted.
pub fn uncommitted_publications() -> &'static str {
    "SELECT p.publication_id FROM memory_publications p
     WHERE p.source_session_id = ?1 AND p.commit_order IS NULL
       AND EXISTS (SELECT 1 FROM memory_stage_attempts s
                   WHERE s.publication_id = p.publication_id AND s.stage = 'turn_one'
                     AND s.session_id = p.source_session_id AND s.harness = ?2)"
}

/// Whether the fact row under `alias` waits for a second turn (see
/// [`publications`]).
pub fn waiting(alias: &str) -> String {
    let prefix = super::busy::MOVE_RESERVATION;
    format!(
        "({alias}.state = 'retryable' OR ({alias}.state = 'in_flight' AND substr({alias}.reserved_stage_key, 1, {}) = '{prefix}'))",
        prefix.len()
    )
}

/// Whether a stored fact waits for a second turn: the same rule as
/// [`waiting`], for a row already read.
pub fn is_waiting(state: &str, reserved: Option<&str>) -> bool {
    state == "retryable"
        || (state == "in_flight"
            && reserved.is_some_and(|key| key.starts_with(super::busy::MOVE_RESERVATION)))
}

/// The key a move reserves the facts it carries under.
pub fn reservation(cut: &str) -> String {
    format!("{}{cut}", super::busy::MOVE_RESERVATION)
}

/// One moved table.
#[derive(Clone, Copy, Debug)]
pub struct Table {
    pub name: &'static str,
    /// The column this machine's references to the row hold: its row id,
    /// or `publication_id` for a publication. `None` when nothing refers
    /// to the table's rows.
    pub id: Option<&'static str>,
    /// The natural key that names a row within its session, in carried
    /// columns. A reference to the row is carried as these values: the one
    /// value for a one-column key, an array otherwise. Empty when nothing
    /// refers to the table's rows and no constraint needs one.
    pub key: &'static [&'static str],
    /// Column names other tables would use to hold this table's row id. A
    /// table with such a column must be in one of the two lists.
    pub id_names: &'static [&'static str],
    /// Which of the table's rows belong to the session.
    pub scope: Scope,
    /// The order rows are read and written in: source row-id order, or
    /// for publications their place in the backlog.
    pub order_by: &'static str,
    pub columns: &'static [Column],
}

impl Table {
    pub fn column(&self, name: &str) -> Option<&Column> {
        self.columns.iter().find(|column| column.name == name)
    }

    /// The columns the snapshot body carries, in list order.
    pub fn carried(&self) -> impl Iterator<Item = &Column> {
        self.columns.iter().filter(|column| column.mark.carried())
    }
}

/// How the session's rows of a table are found, on parameters `?1`
/// (session id) and `?2` (harness).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// The table's own `session_id` and `harness`, and this extra filter
    /// when it is not empty.
    Session(&'static str),
    /// Rows of the session's summaries, by `compartment_id`.
    Compartment,
    /// Rows of the session's waiting publications ([`publications`]), by
    /// `publication_id`, and this extra filter when it is not empty.
    Publication(&'static str),
    /// Rows of the facts of those publications, by `fact_id`.
    PublicationFact,
}

/// One column of a moved table.
#[derive(Clone, Copy, Debug)]
pub struct Column {
    pub name: &'static str,
    pub mark: Mark,
}

/// What the move does with a column.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    /// Carried as is.
    Value,
    /// Carried as the natural key of the row it names in `table`.
    Reference {
        table: &'static str,
        required: Required,
    },
    /// Given a receiver value when the row is installed.
    Reassigned(Reassigned),
    /// Not carried, for this reason; it installs as NULL or its default.
    Excluded(&'static str),
}

impl Mark {
    /// Whether the snapshot body carries the column.
    pub fn carried(self) -> bool {
        match self {
            Mark::Value | Mark::Reference { .. } => true,
            Mark::Reassigned(reassigned) => reassigned.carried(),
            Mark::Excluded(_) => false,
        }
    }
}

/// When a row needs the target of a reference. A row whose required
/// reference has no target is left out of the snapshot; a missing target
/// of a reference the row does not require is carried as null.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Required {
    /// The column is NOT NULL.
    Always,
    /// The column may be null and no CHECK requires it.
    Never,
    /// A CHECK of the table requires it when `column` holds `value`.
    When {
        column: &'static str,
        value: &'static str,
    },
}

/// A column the receiver gives its own value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reassigned {
    /// The session id. Every row of the selection holds the session's own,
    /// so the body leaves it out and the install writes the session id the
    /// snapshot's header names.
    SessionId,
    /// The harness, like the session id.
    Harness,
    /// A publication's place in the project's backlog, unique across the
    /// machine. The body carries its rank among the session's moved
    /// publications, and the install appends them in that order after the
    /// receiver's own.
    CommitOrder,
    /// A fact's state. The body carries its logical state: a waiting fact
    /// is `retryable`, any other its stored state. The install writes a
    /// waiting fact `in_flight` under the cut's reservation, so no second
    /// turn on the receiver takes it before the move activates.
    FactState,
    /// A fact's reservation. Not carried: the install sets the cut's key on
    /// waiting facts and leaves every other fact unreserved.
    Reservation,
}

impl Reassigned {
    fn carried(self) -> bool {
        matches!(self, Reassigned::CommitOrder | Reassigned::FactState)
    }
}

const fn value(name: &'static str) -> Column {
    Column {
        name,
        mark: Mark::Value,
    }
}

const fn reference(name: &'static str, table: &'static str, required: Required) -> Column {
    Column {
        name,
        mark: Mark::Reference { table, required },
    }
}

const fn reassigned(name: &'static str, how: Reassigned) -> Column {
    Column {
        name,
        mark: Mark::Reassigned(how),
    }
}

const fn excluded(name: &'static str, reason: &'static str) -> Column {
    Column {
        name,
        mark: Mark::Excluded(reason),
    }
}

const ROW_ID: &str = "the row id; the receiver assigns its own";
const SESSION_ID: Column = reassigned("session_id", Reassigned::SessionId);
const HARNESS: Column = reassigned("harness", Reassigned::Harness);

/// The moved tables, parents before children.
pub const MOVED: &[Table] = &[
    Table {
        name: "compartments",
        id: Some("id"),
        key: &["sequence"],
        id_names: &["compartment_id"],
        scope: Scope::Session(""),
        order_by: "rowid",
        columns: &[
            excluded("id", ROW_ID),
            SESSION_ID,
            value("sequence"),
            value("start_message"),
            value("end_message"),
            value("start_message_id"),
            value("end_message_id"),
            value("start_block_index"),
            value("end_block_index"),
            value("title"),
            value("content"),
            value("p1"),
            value("p2"),
            value("p3"),
            value("p4"),
            value("importance"),
            value("episode_type"),
            excluded(
                "p1_embedding",
                "a blob: the install's write plan carries only text, integer and null values; the receiver embeds the summary again",
            ),
            excluded(
                "p1_embedding_model_id",
                "names the model of the embedding left behind; carried without it, the summary would read as embedded and never be embedded again",
            ),
            value("legacy"),
            value("created_at"),
            HARNESS,
            value("rebase_status"),
        ],
    },
    Table {
        name: "compartment_events",
        id: None,
        key: &[],
        id_names: &[],
        scope: Scope::Session(""),
        order_by: "rowid",
        columns: &[
            excluded("id", ROW_ID),
            SESSION_ID,
            reference("compartment_id", "compartments", Required::Never),
            value("kind"),
            // A 1-based index into the run's summaries, not a row id.
            value("at_compartment"),
            value("fields_json"),
            value("created_at"),
            HARNESS,
        ],
    },
    Table {
        name: "compartment_score_revisions",
        id: Some("id"),
        key: &["compartment_id", "source_identity", "rubric_version"],
        id_names: &["revision_id"],
        scope: Scope::Compartment,
        order_by: "rowid",
        columns: &[
            excluded("id", ROW_ID),
            reference("compartment_id", "compartments", Required::Always),
            SESSION_ID,
            value("source_identity"),
            value("old_importance"),
            value("new_importance"),
            value("rubric_version"),
            value("prompt_hash"),
            value("model"),
            value("seed_ids"),
            // Rescore provenance: text ids of rows no move carries, with no
            // foreign key and no reader that joins them.
            value("job_id"),
            value("batch_id"),
            value("attempt_id"),
            value("completed_at"),
            value("reason"),
        ],
    },
    Table {
        name: "compartment_score_selections",
        id: None,
        key: &["sequence"],
        id_names: &[],
        scope: Scope::Compartment,
        order_by: "rowid",
        columns: &[
            SESSION_ID,
            reference("compartment_id", "compartments", Required::Always),
            value("sequence"),
            // The table's CHECK requires a revision for a selection a rescore
            // published, and none for an undo.
            reference(
                "revision_id",
                "compartment_score_revisions",
                Required::When {
                    column: "origin",
                    value: "publication",
                },
            ),
            value("origin"),
            value("job_id"),
            value("batch_id"),
            value("attempt_id"),
        ],
    },
    Table {
        name: "session_facts",
        id: None,
        key: &[],
        id_names: &[],
        scope: Scope::Session(""),
        order_by: "rowid",
        columns: &[
            excluded("id", ROW_ID),
            SESSION_ID,
            value("category"),
            value("content"),
            value("created_at"),
            value("updated_at"),
            HARNESS,
        ],
    },
    Table {
        name: "notes",
        id: None,
        key: &[],
        id_names: &["note_id"],
        scope: Scope::Session("type = 'session'"),
        order_by: "rowid",
        columns: &[
            excluded("id", ROW_ID),
            value("type"),
            value("status"),
            value("content"),
            SESSION_ID,
            value("project_path"),
            value("surface_condition"),
            value("created_at"),
            value("updated_at"),
            value("last_checked_at"),
            value("ready_at"),
            value("ready_reason"),
            value("compiled_provider"),
            value("compiled_config"),
            value("compiled_at"),
            value("compile_status"),
            HARNESS,
            // A message ordinal, not a row id.
            value("anchor_ordinal"),
            value("compiled_check"),
            value("manifest_json"),
            value("check_hash"),
            value("check_cron"),
            value("check_version"),
            value("check_status"),
            value("check_failure_count"),
            value("check_network_failure_count"),
            value("check_quarantined_until"),
            value("check_next_due_at"),
            value("check_compiled_at"),
            value("check_false_since_at"),
            value("check_last_liveness_at"),
            value("policy_version"),
            // Text no ck-mc code reads.
            value("anchor_block_id"),
        ],
    },
    Table {
        name: "session_projects",
        id: None,
        key: &[],
        id_names: &[],
        scope: Scope::Session(""),
        order_by: "rowid",
        columns: &[
            SESSION_ID,
            HARNESS,
            // The project id; no project table row is needed for it.
            value("project_path"),
            value("updated_at"),
        ],
    },
    Table {
        name: "memory_publications",
        id: Some("publication_id"),
        key: &["publication_id"],
        id_names: &["publication_id"],
        scope: Scope::Publication(""),
        order_by: "commit_order",
        columns: &[
            // A text uuid, the same on every machine.
            value("publication_id"),
            value("project_path"),
            reassigned("source_session_id", Reassigned::SessionId),
            reassigned("commit_order", Reassigned::CommitOrder),
            value("committed_at"),
        ],
    },
    Table {
        name: "memory_fact_blocks",
        id: Some("id"),
        key: &["publication_id", "start_ordinal", "end_ordinal"],
        id_names: &["block_id"],
        scope: Scope::Publication(""),
        order_by: "rowid",
        columns: &[
            excluded("id", ROW_ID),
            reference("publication_id", "memory_publications", Required::Always),
            value("source_session_id"),
            value("start_ordinal"),
            value("end_ordinal"),
            value("role"),
            value("parts_json"),
            value("joined_text"),
        ],
    },
    Table {
        name: "memory_pending_facts",
        id: Some("id"),
        key: &["publication_id", "fact_index"],
        id_names: &["fact_id"],
        scope: Scope::Publication(""),
        order_by: "rowid",
        columns: &[
            excluded("id", ROW_ID),
            value("project_path"),
            reference("publication_id", "memory_publications", Required::Always),
            value("fact_index"),
            // Null once the summary the fact cited was rewritten away.
            reference("compartment_id", "compartments", Required::Never),
            value("category"),
            value("content"),
            value("anchor_known"),
            reassigned("state", Reassigned::FactState),
            value("fact_attempts"),
            value("reason"),
            reassigned("reserved_stage_key", Reassigned::Reservation),
            value("mapping_json"),
            excluded(
                "matched_memory_id",
                "the row id of a project memory, which no move carries; written when a second turn decides the fact and read by nothing",
            ),
        ],
    },
    Table {
        name: "memory_fact_block_links",
        id: None,
        key: &[],
        id_names: &[],
        scope: Scope::PublicationFact,
        order_by: "rowid",
        columns: &[
            reference("fact_id", "memory_pending_facts", Required::Always),
            reference("block_id", "memory_fact_blocks", Required::Always),
        ],
    },
    Table {
        name: "memory_stage_attempts",
        id: None,
        key: &["stage_key"],
        id_names: &["stage_key"],
        scope: Scope::Publication(
            "stage = 'turn_one' AND state = 'published' AND session_id = ?1 AND harness = ?2",
        ),
        order_by: "rowid",
        columns: &[
            // Embeds the project and the publication id, both carried as is.
            value("stage_key"),
            value("project_path"),
            reference("publication_id", "memory_publications", Required::Always),
            value("run_attempt"),
            value("stage"),
            SESSION_ID,
            HARNESS,
            value("child_session_id"),
            value("carrier"),
            value("state"),
            excluded(
                "classification_watermark",
                "a position in this machine's memory classification queue, which no move carries; only second-turn rows set it",
            ),
            value("request_json"),
            value("reply_json"),
            value("reported_profile_json"),
            value("usage_json"),
            value("started_at"),
        ],
    },
];

/// The moved table named `name`.
pub fn table(name: &str) -> Option<&'static Table> {
    MOVED.iter().find(|table| table.name == name)
}

/// A table a move leaves behind.
#[derive(Clone, Copy, Debug)]
pub struct NotMoved {
    pub name: &'static str,
    pub reason: &'static str,
    pub install: Install,
}

/// What the install does with a table it leaves behind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Install {
    /// The install never touches its rows, for this reason.
    Untouched(&'static str),
    /// The install deletes the session's rows of the summaries it deletes.
    /// The install's connection leaves foreign keys off, as every
    /// `context.db` connection does, so no cascade would.
    DeletedWithCompartments,
}

const HOST_STATE: &str =
    "a standalone plugin host's per-session transform state; a runner session keeps its own state in mode3.db, which the move does not carry";
const SEARCH_INDEX: &str =
    "search index rows, rebuilt on the receiver from the transcript and the summaries";
const TELEMETRY: &str = "this machine's run records and telemetry";
const PROJECT: &str = "project data, not session data; it syncs through Engram on its own";
const SECOND_TURN: &str =
    "second-turn records; the move carries only the facts still waiting for a second turn";
const NO_MOVED_ROWS: &str = "it names no row the move carries";
const RESCORE: &str = "rescore job state; a rescore on the receiver starts from its own summaries";

/// The tables a move leaves behind. Each holds a column named for a
/// session or for a moved row, or a foreign key to a moved table.
pub const NOT_MOVED: &[NotMoved] = &[
    NotMoved {
        name: "compartment_chunk_embeddings",
        reason: "chunk vectors of the summaries for message-history search; the receiver embeds its summaries again",
        install: Install::DeletedWithCompartments,
    },
    NotMoved {
        name: "compartment_history_versions",
        reason: "a per-session revision counter for shared readers, which this machine's triggers keep",
        install: Install::Untouched(
            "the compartments triggers bump it as the install deletes and inserts summaries",
        ),
    },
    NotMoved {
        name: "compartment_state_lease",
        reason: "a lease held by a summarizer on this machine",
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "compression_depth",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "dream_locks",
        reason: "a lock a dreamer run on this machine holds",
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "dream_schedules",
        reason: "this machine's dreamer schedules; a receiver schedules its own projects",
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "dream_task_runs",
        reason: TELEMETRY,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "embedding_measurement_corpus",
        reason: SEARCH_INDEX,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "historian_runs",
        reason: TELEMETRY,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "host_runner_entries",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "host_runner_ids",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "host_runner_state",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "host_runner_views",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "lkg_served_markers",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "lkg_slot_chunks",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "lkg_slots",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "m0_mutation_log",
        reason: HOST_STATE,
        install: Install::Untouched(
            "only a standalone plugin host reads it, for its own m[0]; a runner session is not served by one",
        ),
    },
    NotMoved {
        name: "memories",
        reason: PROJECT,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "memory_activity_ledger",
        reason: "this machine's count of summaries each publication stored",
        install: Install::Untouched(
            "written once per published summary and read by no ck-mc or plugin code; row ids are never reused, so a stale row never names an installed summary",
        ),
    },
    NotMoved {
        name: "memory_agent_fragments",
        reason: "the session's memory corrections as served in its head, rebuilt from project memory on the receiver",
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "memory_applied_rows",
        reason: "the project memory the session's head was served, rebuilt on the receiver",
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "memory_applied_snapshots",
        reason: "the project memory the session's head was served, rebuilt on the receiver",
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "memory_check_attempts",
        reason: SECOND_TURN,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "memory_classification_items",
        reason: PROJECT,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "memory_decision_receipts",
        reason: "receipts of second-turn decisions this machine applied to project memory",
        install: Install::Untouched(
            "a receipt names the fact it decided by row id, and row ids are never reused, so a stale receipt never names an installed fact",
        ),
    },
    NotMoved {
        name: "memory_tool_proposals",
        reason: PROJECT,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "message_fts_rowid_map",
        reason: SEARCH_INDEX,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "message_history_fts",
        reason: SEARCH_INDEX,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "message_history_index",
        reason: SEARCH_INDEX,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "message_history_orphan_sweep",
        reason: SEARCH_INDEX,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "message_history_source",
        reason: SEARCH_INDEX,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "message_time_backfill_state",
        reason: SEARCH_INDEX,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "migration_pending",
        reason: "this machine's journal of an offline move between plugin hosts",
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "pending_ops",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "pending_session_cleanup",
        reason: "this machine's queue of deleted sessions to clean",
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "plugin_messages",
        reason: "messages between a plugin host and its terminal interface on this machine",
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "primer_candidates",
        reason: PROJECT,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "recomp_compartments",
        reason: "a standalone plugin host's staging for rebuilding summaries, which ck-mc never runs",
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "recomp_facts",
        reason: "a standalone plugin host's staging for rebuilding summaries, which ck-mc never runs",
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "rescore_items",
        reason: RESCORE,
        install: Install::Untouched(
            "a job's items name summaries by row id, and row ids are never reused, so a stale item never names an installed summary",
        ),
    },
    NotMoved {
        name: "session_meta",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "session_meta_chunks",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "session_meta_collection_revisions",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "session_render_cache",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "session_replay_decisions",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "source_contents",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "subagent_invocations",
        reason: TELEMETRY,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "synapse_batch_ledger",
        reason: SEARCH_INDEX,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "tags",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "temporal_decisions",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "tool_owner_backfill_state",
        reason: HOST_STATE,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "transform_decisions",
        reason: TELEMETRY,
        install: Install::Untouched(NO_MOVED_ROWS),
    },
    NotMoved {
        name: "memory_observations",
        reason: "observations about the person for the global review, which are not session data",
        install: Install::Untouched(NO_MOVED_ROWS),
    },
];
