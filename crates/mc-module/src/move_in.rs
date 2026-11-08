//! Moving a standalone-plugin session or an existing runner session to a
//! runner. Existing runner coordinates, partial summaries and session-id
//! changes are handled by `runner`; the protocol below is the standalone
//! OpenCode/Pi plugin path.
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
//!    message before the newest one, and saves it as ck-mc's accepted view, so
//!    the runner's Setup finds it applied. The newest message stays shown,
//!    as after any cut, so the request ends with a message the runner shows
//!    as it is;
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
//! The source host and indexers must be stopped, or the target session held:
//! no writer may change that session until the fence is committed. Other
//! sessions may keep writing to the shared context.db between move batches.

use cortexkit_role_compaction::read::{Cursor, SessionRef};
use cortexkit_role_compaction::rules::ProviderRules;
use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
use cortexkit_role_compaction::view::View;
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::Arc;

use crate::config::Config;
use crate::context_db::ContextDb;
use crate::preset;
use crate::route::{Project, Route};
use crate::session::Session;
use crate::store::Store;

mod runner;

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
    /// runner's. Runner-to-runner moves require source_entry on every row.
    /// Added destination rows follow their owning row with added=true and a
    /// null source_entry; they belong to that row's summary range and cut.
    #[serde(default)]
    pub messages: Option<Vec<crate::move_renumber::HostMessage>>,
    /// The harness the standalone plugin kept the session under, when it
    /// differs from the runner's: a session moved from OpenCode 1 to a runner
    /// on OpenCode 2 was kept under `opencode` and runs as `opencode2`. The
    /// stored numbers follow that harness's numbering, and every row moves
    /// to the runner's harness (see [`rekey`]). Absent: the same harness.
    #[serde(default)]
    pub source_harness: Option<String>,
    /// The session id under which the source stored its rows.
    #[serde(default)]
    pub source_session: Option<String>,
    /// Stored coordinates are source-runner ordinals, not plugin numbers.
    #[serde(default)]
    pub source_runner_entries: bool,
    /// Highest tag exported by the source runner, including tags never stored
    /// by the standalone plugin.
    #[serde(default)]
    pub tag_floor: Option<u64>,
    /// The id of the runner's entry before the newest one, which the first
    /// view's cut goes through. Needed only without `messages`, which name it.
    #[serde(default)]
    pub before_newest: Option<String>,
}

/// What the runner's move tool installs. `ck-mc move-in` prints it as JSON.
#[derive(Debug, serde::Serialize)]
pub struct Moved {
    /// The first view, to store as the session's current view.
    pub view: View,
    /// The maximum of the stored plugin tags and the exported runner tag
    /// floor, to write as the marker's checkpoint.
    pub tag_checkpoint: u64,
    /// Pi summaries whose missing-message slots could not be located exactly.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    /// Source-runner state stays available for rollback; part ids and cached
    /// views cannot be reused by the destination runner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_state_kept: Option<bool>,
}

/// The runner's entry before the newest one, which the first view's cut goes
/// through, read from the move list. `None` for a one-message transcript.
fn cut_before_newest(request: &MoveRequest) -> Result<Option<(u64, &str)>, String> {
    let Some(before) = request.newest.ordinal.checked_sub(1).filter(|&o| o > 0) else {
        return Ok(None);
    };
    let Some(messages) = &request.messages else {
        return request
            .before_newest
            .as_deref()
            .map(|mid| Some((before, mid)))
            .ok_or_else(|| {
                "invalid_request: the first view's cut goes through the message before the newest one; name it in `messages` or `before_newest`".to_string()
            });
    };
    messages
        .iter()
        .rev()
        .find(|message| message.entry == Some(before))
        .map(|message| Some((before, message.mid.as_str())))
        .ok_or_else(|| format!("invalid_messages: no row in the move list is entry {before}, the one before the newest"))
}

/// Before renumbering, a fully summarized session's newest summary may end at
/// the transcript's newest message, or a row after it that the runner left
/// out (OpenCode 2's conversion drops an assistant step that ended with no
/// content). Renumbering snaps those endpoints to the newest kept row.
fn summary_ends(request: &MoveRequest) -> Vec<&str> {
    let mut ends = vec![request.newest.mid.as_str()];
    if let Some(messages) = &request.messages {
        if let Some(last) = messages.iter().rposition(|message| message.entry.is_some()) {
            ends.extend(
                messages[last + 1..]
                    .iter()
                    .map(|message| message.mid.as_str()),
            );
        }
    }
    ends
}

fn renumbering_unsupported(source: &str) -> String {
    format!(
        "renumbering_unsupported: converting message numbers is built for OpenCode 1 and Pi sessions, not {source}"
    )
}

fn not_summarized(session: &str, reaches: Option<&str>, request: &MoveRequest) -> String {
    format!(
        "session_not_summarized: the summaries of {session} end at {}, not at its newest message {}; run /ctx-wrapup 0 first",
        reaches.unwrap_or("nothing"),
        request.newest.mid
    )
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
    if request.source_runner_entries {
        return runner::move_in(db, store, config, request);
    }
    if request
        .source_session
        .as_deref()
        .is_some_and(|source| source != request.session.session)
    {
        return Err(
            "invalid_request: source_session may differ only with source_runner_entries".into(),
        );
    }
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
    // Checked before anything is written: renumbering and re-keying commit on
    // their own, so a refusal after them would leave a half-moved session. A
    // move list for a host whose numbering isn't built refuses first, by name.
    if request.messages.is_some() && !matches!(source, "opencode" | "pi") {
        return Err(renumbering_unsupported(source));
    }
    let ends = summary_ends(request);
    let newest_end: Option<String> = db.with_connection(|conn| {
        conn.query_row(
            "SELECT end_message_id FROM compartments WHERE session_id = ?1 AND harness IN (?2, ?3)
             ORDER BY sequence DESC LIMIT 1",
            params![key.session, source, key.harness],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
    })?;
    if !newest_end.as_deref().is_some_and(|end| ends.contains(&end)) {
        return Err(not_summarized(&key.session, newest_end.as_deref(), request));
    }
    let mut warnings = Vec::new();
    if let Some(messages) = &request.messages {
        // The OpenCode 1 and Pi plugins' numberings are rebuilt here; another
        // host's standalone numbering has its own rules.
        db.with_connection(|conn| {
            let numbering = match source {
                "opencode" => crate::move_renumber::Numbering::opencode(messages, &request.newest)?,
                "pi" => crate::move_renumber::Numbering::pi(messages, &request.newest)?.align_pi(
                    conn,
                    source,
                    &key.session,
                )?,
                other => return Err(renumbering_unsupported(other)),
            };
            crate::move_renumber::renumber_for_move(
                conn,
                source,
                &key.session,
                &numbering,
                Some((&key.harness, &key.session)),
            )?;
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
    if !reaches.as_deref().is_some_and(|end| ends.contains(&end))
        || session.last_summary_ordinal() != Some(request.newest.ordinal)
    {
        return Err(not_summarized(&key.session, reaches.as_deref(), request));
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
    let cut = cut_before_newest(request)?;
    let view = session.first_view_after_move(&settings, cut)?;
    let cut_mid = view.edits.iter().find_map(|edit| match &edit.op {
        cortexkit_role_compaction::view::EditOp::Cut { through } => Some(through.as_str()),
        _ => None,
    });
    let tag_checkpoint: u64 = db
        .with_connection(|conn| {
            conn.query_row(
            "SELECT COALESCE(MAX(tag_number), 0) FROM tags WHERE session_id = ?1 AND harness = ?2",
            params![key.session, key.harness],
            |row| row.get::<_, i64>(0),
        )
        .map(|max| max.max(0) as u64)
        .map_err(|error| error.to_string())
        })?
        .max(request.tag_floor.unwrap_or(0));
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
        "cut": cut_mid,
        "view_version": view.version,
        "view_checksum": view.checksum,
        "moved_at": request.now,
    });
    db.with_connection(|conn| {
        verify_source_unchanged(conn, &key.session, source, &key.harness)?;
        crate::move_batches::transaction(conn, "fence", |tx| {
            for fence in &fences {
                tx.execute(
                    "INSERT INTO schema_migrations_meta (key, value) VALUES (?1, ?2)",
                    params![fence, record.to_string()],
                )
                .map_err(|error| error.to_string())?;
            }
            Ok(())
        })
    })?;
    Ok(Moved {
        view,
        tag_checkpoint,
        warnings,
        source_state_kept: None,
    })
}

/// Move every session/harness table, including schema-discovered virtual
/// tables. A mixed source/destination table is a conflict unless a durable
/// plan proves that the split belongs to an interrupted move.
fn rekey(conn: &mut Connection, session: &str, from: &str, to: &str) -> Result<(), String> {
    let key = format!("mode3_rekey:{session}");
    if let Some(record) = crate::move_batches::record(conn, &key)? {
        if record["from"] != from || record["to"] != to {
            return Err(format!(
                "harness_conflict: {session} already has a move from {} to {}",
                record["from"], record["to"]
            ));
        }
    }
    if crate::move_batches::resume(conn, &key)? {
        return Ok(());
    }
    let plan = crate::move_batches::Plan::default();
    for table in crate::move_batches::session_tables(conn)? {
        let rows = crate::move_batches::harness_rows(conn, &table, session)?;
        let old = rows.iter().any(|(_, h)| h == from);
        let new = rows.iter().any(|(_, h)| h == to);
        if old && new {
            return Err(format!(
                "harness_conflict: {table} holds rows for {session} under both {from} and {to}"
            ));
        }
        plan.phase(&format!("rekey/{table}"));
        let sql = format!(
            "UPDATE {} SET harness=?1 WHERE rowid=?2",
            crate::move_batches::quoted(&table)
        );
        for (id, harness) in rows {
            if harness == from {
                plan.execute(&sql, params![to, id])
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    plan.stage(conn, &key, serde_json::json!({"from":from,"to":to}))
}

fn verify_source_unchanged(
    conn: &Connection,
    session: &str,
    from: &str,
    to: &str,
) -> Result<(), String> {
    if from != to {
        for table in crate::move_batches::session_tables(conn)? {
            let remaining = crate::move_batches::harness_rows(conn, &table, session)?
                .into_iter()
                .filter(|(_, h)| h == from)
                .count();
            if remaining > 0 {
                return Err(source_changed(session, &table, remaining));
            }
        }
    }
    if let Some(progress) =
        crate::move_batches::record(conn, &crate::move_renumber::record_key(from, session))?
    {
        if let Some(expected) = progress["source_rows"].as_u64() {
            let found: u64 = conn.query_row("SELECT count(*) FROM message_history_source WHERE session_id=?1 AND harness IN (?2,?3)", params![session,from,to],|row| row.get(0)).map_err(|e| e.to_string())?;
            if found != expected {
                return Err(source_changed(
                    session,
                    "message_history_source",
                    found.abs_diff(expected) as usize,
                ));
            }
        }
        if let Some(expected) = progress["search_rows"].as_u64() {
            let found = crate::move_batches::message_rows(conn, session)
                .map_err(|e| e.to_string())?
                .len() as u64;
            if found != expected {
                return Err(source_changed(
                    session,
                    "message_history_fts",
                    found.abs_diff(expected) as usize,
                ));
            }
        }
    }
    Ok(())
}

fn source_changed(session: &str, table: &str, rows: usize) -> String {
    format!("move_source_changed: {session}: {rows} rows appeared or changed in {table}; stop the source host and its indexers or hold the session before rerunning move-in")
}

#[cfg(test)]
#[path = "move_in/lock_tests.rs"]
pub(crate) mod tests;
