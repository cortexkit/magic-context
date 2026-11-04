//! Moving a session that ran under the standalone Magic Context plugin
//! (OpenCode or Pi without a runner) to mode 3.
//!
//! Only a fully summarized session moves: before the move it runs
//! `/ctx-wrapup 0`, so its summaries reach its newest message. The move then
//! has nothing to pick or carry. It
//! 1. refuses, by name, a session already moved;
//! 2. converts the message numbers Magic Context stored for the session to
//!    the runner's numbering, when the runner's move tool sends the
//!    transcript's message rows ([`crate::move_renumber`]); the standalone
//!    plugin numbers messages differently after a compaction;
//! 3. refuses, by name, a session whose summaries stop short of the
//!    transcript's end;
//! 4. builds the session's first view, the history head and a cut through the
//!    newest message, and saves it as ck-mc's accepted view, so the runner's
//!    Setup finds it applied;
//! 5. answers that view and the standalone plugin's highest tag number. The
//!    runner's own move installs the view as its stored current view and
//!    writes the number as the checkpoint on its compaction marker, so new
//!    tag numbers continue above every number the model has seen;
//! 6. writes the fence the standalone plugin checks
//!    (`mode3_move:<harness>:<session>` in `schema_migrations_meta`), last,
//!    as the move's commit point. From then on that plugin stands down on
//!    the session.
//!
//! Everything the session owns in `context.db` (summaries, notes, the search
//! index) is keyed by harness and host session id, so the moved session
//! finds it where it is: nothing is copied.
//!
//! The move runs with ck-mc and the session's host stopped, so nothing else
//! writes either store meanwhile.

use cortexkit_role_compaction::read::{Cursor, SessionRef};
use cortexkit_role_compaction::rules::ProviderRules;
use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
use cortexkit_role_compaction::view::View;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::sync::Arc;

use crate::config::Config;
use crate::context_db::ContextDb;
use crate::preset;
use crate::route::{Project, Route};
use crate::session::Session;
use crate::store::Store;

/// What the runner's move tool knows about the session. `ck-mc move-in`
/// reads it as JSON on standard input.
#[derive(Debug, serde::Deserialize)]
pub struct MoveRequest {
    pub session: SessionRef,
    pub preset: String,
    pub project: Option<Project>,
    pub model: ModelRef,
    pub context_window: u64,
    pub output_reserve: u64,
    pub rules: ProviderRules,
    /// The transcript's newest message.
    pub newest: Cursor,
    /// Milliseconds since the Unix epoch, for the fence record.
    pub now: u64,
    /// Every message row of the session's active path, in host order, with
    /// the runner's entry number for each; on Pi, every journal entry of the
    /// active branch, root to leaf, with its kind. Needed when the standalone
    /// plugin's numbering differs from the runner's (an OpenCode compaction,
    /// any Pi tool result); without it the stored numbers must already be the
    /// runner's.
    #[serde(default)]
    pub messages: Option<Vec<crate::move_renumber::HostMessage>>,
    /// The harness the standalone plugin kept the session under, when it
    /// differs from the runner's: a session moved from OpenCode 1 to a runner
    /// on OpenCode 2 was kept under `opencode` and runs as `opencode2`. The
    /// stored numbers follow that harness's numbering, and every row moves
    /// to the runner's harness (see [`rekey`]). Absent: the same harness.
    #[serde(default)]
    pub source_harness: Option<String>,
}

/// What the runner's move tool installs. `ck-mc move-in` prints it as JSON.
#[derive(Debug, serde::Serialize)]
pub struct Moved {
    /// The first view, to store as the session's current view.
    pub view: View,
    /// The standalone plugin's highest tag number for the session, to write
    /// as the marker's checkpoint.
    pub tag_checkpoint: u64,
    /// Pi summaries whose missing-message slots could not be located exactly.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

pub fn fence_key(harness: &str, session: &str) -> String {
    format!("mode3_move:{harness}:{session}")
}

pub fn move_in(
    db: ContextDb,
    store: &Store,
    config: &Config,
    request: &MoveRequest,
) -> Result<Moved, String> {
    let key = &request.session;
    let features = preset::features(&request.preset)
        .ok_or_else(|| format!("unknown preset `{}`", request.preset))?;
    let source = request.source_harness.as_deref().unwrap_or(&key.harness);
    // The standalone plugin checks the fence under its own harness, so a
    // session that changes harness is fenced under both.
    let fences: Vec<String> = if source == key.harness {
        vec![fence_key(&key.harness, &key.session)]
    } else {
        vec![
            fence_key(source, &key.session),
            fence_key(&key.harness, &key.session),
        ]
    };
    let already: Option<String> = db.with_connection(|conn| {
        let mut found = None;
        for fence in &fences {
            found = conn
                .query_row(
                    "SELECT value FROM schema_migrations_meta WHERE key = ?1",
                    params![fence],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            if found.is_some() {
                break;
            }
        }
        Ok::<_, String>(found)
    })?;
    if already.is_some() {
        return Err(format!(
            "session_already_moved: {} was already moved to mode 3",
            key.session
        ));
    }
    let mut warnings = Vec::new();
    if let Some(messages) = &request.messages {
        // The OpenCode 1 and Pi plugins' numberings are rebuilt here; another
        // host's standalone numbering has its own rules.
        db.with_connection(|conn| {
            let numbering = match source {
                "opencode" => crate::move_renumber::Numbering::opencode(messages, &request.newest)?,
                "pi" => crate::move_renumber::Numbering::pi(messages, &request.newest)?
                    .align_pi(conn, source, &key.session)?,
                other => {
                    return Err(format!(
                        "renumbering_unsupported: converting message numbers is built for OpenCode 1 and Pi sessions, not {other}"
                    ))
                }
            };
            crate::move_renumber::renumber(conn, source, &key.session, &numbering)?;
            warnings = numbering.alignment_warnings().to_vec();
            Ok::<_, String>(())
        })?;
    }
    if source != key.harness {
        db.with_connection(|conn| rekey(conn, &key.session, source, &key.harness))?;
    }
    // Offline, nothing rides; the runner declares what it detects at its own
    // Setup.
    let setup = SetupRequest::new(
        request.preset.clone(),
        request.model.clone(),
        request.context_window,
        request.output_reserve,
        request.rules.clone(),
        Vec::new(),
        request.now,
    )
    .with_newest(request.newest.clone());
    // The operator names the session and project here; this runs offline,
    // not on a runner's route.
    let route = Route {
        session: key.clone(),
        project: request.project.clone(),
        workdir: request.project.as_ref().map(|project| project.root.clone()),
        agent_id: None,
    };
    let db = Arc::new(db);
    let mut session = Session::new(&route, &setup, features, Some(Arc::clone(&db)));
    session.load_summaries();
    let reaches = session.last_summary_end();
    if reaches.as_deref() != Some(request.newest.mid.as_str())
        || session.last_summary_ordinal() != Some(request.newest.ordinal)
    {
        return Err(format!(
            "session_not_summarized: the summaries of {} end at {}, not at its newest message {}; run /ctx-wrapup 0 first",
            key.session,
            reaches.as_deref().unwrap_or("nothing"),
            request.newest.mid
        ));
    }
    let settings = config.resolve(
        request
            .project
            .as_ref()
            .map(|project| project.root.as_str()),
        &format!("{}/{}", request.model.provider, request.model.model),
        request
            .context_window
            .saturating_sub(request.output_reserve),
    );
    let view = session.first_view_after_move(&settings, &request.newest)?;
    let tag_checkpoint: u64 = db.with_connection(|conn| {
        conn.query_row(
            "SELECT COALESCE(MAX(tag_number), 0) FROM tags WHERE session_id = ?1 AND harness = ?2",
            params![key.session, key.harness],
            |row| row.get::<_, i64>(0),
        )
        .map(|max| max.max(0) as u64)
        .map_err(|error| error.to_string())
    })?;
    store
        .save(key, &session.durable())
        .map_err(|error| format!("state_save_failed: {error}"))?;
    let record = serde_json::json!({
        "version": 3,
        "session": key.session,
        "harness": key.harness,
        "runner": key.runner,
        "state": "moved",
        "tag_checkpoint": tag_checkpoint,
        "cut": request.newest.mid,
        "view_version": view.version,
        "view_checksum": view.checksum,
        "moved_at": request.now,
    });
    db.with_connection(|conn| {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        for fence in &fences {
            tx.execute(
                "INSERT INTO schema_migrations_meta (key, value) VALUES (?1, ?2)",
                params![fence, record.to_string()],
            )
            .map_err(|error| error.to_string())?;
        }
        tx.commit().map_err(|error| error.to_string())
    })?;
    Ok(Moved {
        view,
        tag_checkpoint,
        warnings,
    })
}

/// Move every row `context.db` holds for `session` under harness `from` to
/// harness `to`, in one transaction: every table with both a `session_id`
/// and a `harness` column, found from the schema, so a table added later is
/// covered too. Refuses (`harness_conflict`), changing nothing, when a table
/// already holds rows for the session under both harnesses. A retry after
/// the rows moved finds none under `from` and changes nothing.
fn rekey(conn: &mut Connection, session: &str, from: &str, to: &str) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let tables: Vec<String> = {
        let mut statement = tx
            .prepare(
                "SELECT m.name FROM sqlite_master m
                  WHERE m.type = 'table'
                    AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'session_id')
                    AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'harness')
                  ORDER BY m.name",
            )
            .map_err(|error| error.to_string())?;
        let names = statement
            .query_map([], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|error| error.to_string())?;
        names
    };
    let count = |table: &str, harness: &str| -> Result<i64, String> {
        tx.query_row(
            &format!("SELECT count(*) FROM \"{table}\" WHERE session_id = ?1 AND harness = ?2"),
            params![session, harness],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
    };
    let mut moving = Vec::new();
    for table in &tables {
        let (old, new) = (count(table, from)?, count(table, to)?);
        if old > 0 && new > 0 {
            return Err(format!(
                "harness_conflict: {table} holds rows for {session} under both {from} and {to}"
            ));
        }
        if old > 0 {
            moving.push(table);
        }
    }
    for table in moving {
        tx.execute(
            &format!("UPDATE \"{table}\" SET harness = ?3 WHERE session_id = ?1 AND harness = ?2"),
            params![session, from, to],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}
