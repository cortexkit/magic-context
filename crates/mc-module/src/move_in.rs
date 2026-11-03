//! Moving a session that ran under the standalone Magic Context plugin
//! (OpenCode or Pi without a runner) to mode 3.
//!
//! Only a fully summarized session moves: before the move it runs
//! `/ctx-wrapup 0`, so its summaries reach its newest message. The move then
//! has nothing to pick or carry. It
//! 1. refuses, by name, a session already moved or whose summaries stop
//!    short of the transcript's end;
//! 2. builds the session's first view, the history head and a cut through the
//!    newest message, and saves it as ck-mc's accepted view, so the runner's
//!    Setup finds it applied;
//! 3. answers that view and the standalone plugin's highest tag number. The
//!    runner's own move installs the view as its stored current view and
//!    writes the number as the checkpoint on its compaction marker, so new
//!    tag numbers continue above every number the model has seen;
//! 4. writes the fence the standalone plugin checks
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
use rusqlite::{params, OptionalExtension};
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
}

/// What the runner's move tool installs. `ck-mc move-in` prints it as JSON.
#[derive(Debug, serde::Serialize)]
pub struct Moved {
    /// The first view, to store as the session's current view.
    pub view: View,
    /// The standalone plugin's highest tag number for the session, to write
    /// as the marker's checkpoint.
    pub tag_checkpoint: u64,
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
    let fence = fence_key(&key.harness, &key.session);
    let already: Option<String> = db.with_connection(|conn| {
        conn.query_row(
            "SELECT value FROM schema_migrations_meta WHERE key = ?1",
            params![fence],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
    })?;
    if already.is_some() {
        return Err(format!(
            "session_already_moved: {} was already moved to mode 3",
            key.session
        ));
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
    if reaches.as_deref() != Some(request.newest.mid.as_str()) {
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
    let view = session.first_view_after_move(&settings, &request.newest);
    let tag_checkpoint: u64 = db.with_connection(|conn| {
        conn.query_row(
            "SELECT COALESCE(MAX(tag_number), 0) FROM tags WHERE session_id = ?1 AND harness = ?2",
            params![key.session, key.harness],
            |row| row.get::<_, i64>(0),
        )
        .map(|max| max.max(0) as u64)
        .map_err(|error| error.to_string())
    })?;
    store.save(key, &session.durable());
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
        conn.execute(
            "INSERT INTO schema_migrations_meta (key, value) VALUES (?1, ?2)",
            params![fence, record.to_string()],
        )
        .map_err(|error| error.to_string())
    })?;
    Ok(Moved {
        view,
        tag_checkpoint,
    })
}
