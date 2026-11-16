//! `ck-mc move-in --copy`: start a new runner session from another session's
//! history without changing that session. A move rewrites the source's rows
//! in place, to the runner's numbering and harness; a copy only reads them
//! and writes new rows under the target session, so the source keeps every
//! row exactly as it was and may keep running.
//!
//! The target's first view is its history head, and the head is built from
//! the session's summaries. So a copy carries the summaries: every column of
//! each summary row, with the session, the harness and the covered range
//! renumbered to the target's entries exactly as a move renumbers them
//! (`Numbering::summary_coordinates`). Nothing else of the source is carried:
//! its tags, notes, search index and memory records stay the source's alone.
//! A target that already holds summaries or runner state is refused before
//! anything is written.
//!
//! Unlike a move, a copy doesn't need summaries that reach the newest
//! message. The first view cuts through the last summarized entry (never
//! through the newest one), and the rest of the transcript stays as plain
//! messages.
//!
//! The copy's saved state records where it came from ([`CopyOrigin`]). The
//! session then never writes memories, and with an injection project every
//! memory read it makes, its history head's project docs included, reads
//! that project rather than the one its runner stamps (see
//! `Session::memory_project`).

use super::*;
use crate::move_renumber::Numbering;
use rusqlite::types::Value as SqlValue;

/// Where a copied session's history came from, kept in its saved state. Only
/// `ck-mc move-in --copy` writes it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CopyOrigin {
    /// The harness and session id the summaries were copied from.
    pub harness: String,
    pub session: String,
    /// The project whose memories and project docs the copy reads in place
    /// of the project its runner stamps; none to read the stamped one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub injection_project: Option<Project>,
}

/// The source's summary rows as the copy writes them: every column of the
/// table but the row id, in `columns` order.
struct Rows {
    columns: Vec<String>,
    rows: Vec<Vec<SqlValue>>,
    /// The newest summary's last message, in the source's own numbering.
    last_end: Option<i64>,
    /// Summaries left out of the copy, each with why.
    skipped: Vec<String>,
}

/// The columns that hold a summary's text: a summary whose every one of
/// them is empty says nothing a session could read.
const TEXT_COLUMNS: [&str; 6] = ["title", "content", "p1", "p2", "p3", "p4"];

/// Whether a stored value holds no text: null, or a string of only
/// whitespace.
fn is_blank(value: &SqlValue) -> bool {
    match value {
        SqlValue::Null => true,
        SqlValue::Text(text) => text.trim().is_empty(),
        _ => false,
    }
}

fn target_exists(target: &SessionRef, what: &str) -> String {
    format!(
        "target_exists: {}/{} already holds {what}; a copy starts only a new session",
        target.harness, target.session
    )
}

fn column_error(column: &str) -> String {
    format!("invalid_summary: a summary's {column} is not what the schema says it is")
}

fn integer(value: &SqlValue, column: &str) -> Result<i64, String> {
    match value {
        SqlValue::Integer(number) => Ok(*number),
        _ => Err(column_error(column)),
    }
}

fn text(value: &SqlValue, column: &str) -> Result<String, String> {
    match value {
        SqlValue::Text(text) => Ok(text.clone()),
        SqlValue::Null => Ok(String::new()),
        _ => Err(column_error(column)),
    }
}

/// Read the source's summaries and give each the target's key and, unless
/// the two numberings already agree, the target's coordinates. Reads only.
fn read_summaries(
    conn: &Connection,
    numbering: &Numbering,
    (harness, session): (&str, &str),
    target: &SessionRef,
) -> Result<Rows, String> {
    let columns: Vec<String> = conn
        .prepare(
            "SELECT name FROM pragma_table_info('compartments') WHERE name <> 'id' ORDER BY cid",
        )
        .and_then(|mut statement| statement.query_map([], |row| row.get(0))?.collect())
        .map_err(|error| error.to_string())?;
    let at = |name: &str| {
        columns
            .iter()
            .position(|column| column == name)
            .ok_or_else(|| format!("invalid_summary: the summaries table has no {name} column"))
    };
    let [session_at, harness_at, sequence_at, start_at, end_at, start_id_at, end_id_at] = [
        at("session_id")?,
        at("harness")?,
        at("sequence")?,
        at("start_message")?,
        at("end_message")?,
        at("start_message_id")?,
        at("end_message_id")?,
    ];
    let list = columns
        .iter()
        .map(|column| crate::move_batches::quoted(column))
        .collect::<Vec<_>>()
        .join(", ");
    let rows: Vec<Vec<SqlValue>> = conn
        .prepare(&format!(
            "SELECT {list} FROM compartments WHERE session_id = ?1 AND harness = ?2 ORDER BY sequence"
        ))
        .and_then(|mut statement| {
            statement
                .query_map(params![session, harness], |row| {
                    (0..columns.len()).map(|i| row.get(i)).collect()
                })?
                .collect()
        })
        .map_err(|error| error.to_string())?;
    // As a move does: when every stored number already is the target's,
    // the summaries keep their coordinates.
    let identity = numbering.is_identity();
    let text_at: Vec<usize> = TEXT_COLUMNS
        .iter()
        .filter_map(|name| columns.iter().position(|column| column == name))
        .collect();
    let mut last_end = None;
    let mut skipped = Vec::new();
    let mut kept = Vec::with_capacity(rows.len());
    for mut values in rows {
        let (start, end) = (
            integer(&values[start_at], "start_message")?,
            integer(&values[end_at], "end_message")?,
        );
        // The source may keep running after its transcript was exported, and
        // its later summaries cover messages the copy doesn't have. They are
        // the newest, so every summary from the first such one is left out.
        if numbering.beyond_newest(end) {
            skipped.push(format!(
                "summaries from {} ({start}..{end}) on left out: they cover messages after the copied transcript's newest",
                integer(&values[sequence_at], "sequence")?
            ));
            break;
        }
        if !identity {
            let sequence = integer(&values[sequence_at], "sequence")?;
            let coordinates = numbering.summary_coordinates(
                session,
                sequence,
                (start, end),
                (
                    &text(&values[start_id_at], "start_message_id")?,
                    &text(&values[end_id_at], "end_message_id")?,
                ),
            );
            let (first, last, first_id, last_id) = match coordinates {
                Ok(coordinates) => coordinates,
                // A summary that covers only rows the runner left out and
                // holds no text has nothing to show and nothing to cover, so
                // leaving it out loses nothing. A move still refuses it, since
                // a move rewrites the source; a copy only reads it.
                Err(error)
                    if error.starts_with("summary_covers_no_runner_entry")
                        && text_at.iter().all(|&at| is_blank(&values[at])) =>
                {
                    skipped.push(format!(
                        "summary {sequence} ({start}..{end}) left out: it holds no text and covers only rows the runner left out"
                    ));
                    continue;
                }
                Err(error) => return Err(error),
            };
            values[start_at] = SqlValue::Integer(first);
            values[end_at] = SqlValue::Integer(last);
            values[start_id_at] = SqlValue::Text(first_id);
            values[end_id_at] = SqlValue::Text(last_id);
        }
        values[session_at] = SqlValue::Text(target.session.clone());
        values[harness_at] = SqlValue::Text(target.harness.clone());
        last_end = Some(end);
        kept.push(values);
    }
    Ok(Rows {
        columns,
        rows: kept,
        last_end,
        skipped,
    })
}

/// Copy another session's summaries to a new runner session and answer its
/// first view, as [`move_in`] does for a move. The request names the source
/// in `source_harness` and `source_session` and carries `messages`, the
/// target's entry for every source message; `injection_project`, when set,
/// names the project whose memories and docs the copy reads.
pub fn copy_in(
    db: ContextDb,
    store: &Store,
    config: &Config,
    request: &MoveRequest,
) -> Result<Moved, String> {
    let target = &request.session;
    let (Some(source_harness), Some(source_session)) = (
        request.source_harness.as_deref(),
        request.source_session.as_deref(),
    ) else {
        return Err(
            "invalid_request: a copy names its source in source_harness and source_session".into(),
        );
    };
    // Summaries are unique by session id and sequence whatever their
    // harness, so the copy needs a session id of its own.
    if source_session == target.session {
        return Err(
            "invalid_request: a copy's target session id must differ from its source's".into(),
        );
    }
    let features = preset::features(&request.preset)
        .ok_or_else(|| format!("unknown preset `{}`", request.preset))?;
    let messages = request.messages.as_deref().ok_or(
        "invalid_messages: a copy needs messages, the target's entry for every source message",
    )?;
    if !request.source_runner_entries && !matches!(source_harness, "opencode" | "pi") {
        return Err(renumbering_unsupported(source_harness));
    }
    if store
        .has_rows(target)
        .map_err(|error| format!("state_read_failed: {error}"))?
    {
        return Err(target_exists(target, "runner state"));
    }
    let before_newest = cut_before_newest(request)?;
    let (copied, summary_cut, source_tags, warnings) = db.with_connection(|conn| {
        let numbering = if request.source_runner_entries {
            Numbering::runner(messages, &request.newest)?
        } else if source_harness == "pi" {
            Numbering::pi(messages, &request.newest)?.align_pi(
                conn,
                source_harness,
                source_session,
            )?
        } else {
            Numbering::opencode(messages, &request.newest)?
        };
        let rows = read_summaries(conn, &numbering, (source_harness, source_session), target)?;
        let summary_cut = rows
            .last_end
            .and_then(|end| numbering.cut(end))
            .map(|(entry, mid)| (entry, mid.to_owned()));
        let source_tags = tag_floor(conn, source_harness, source_session)?.0;
        let insert = format!(
            "INSERT INTO compartments ({}) VALUES ({})",
            rows.columns
                .iter()
                .map(|column| crate::move_batches::quoted(column))
                .collect::<Vec<_>>()
                .join(", "),
            (1..=rows.columns.len())
                .map(|i| format!("?{i}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
        // The check and the inserts share one transaction, so no summary can
        // land on the target between them.
        crate::move_batches::transaction(conn, "copy", |tx| {
            let held: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM compartments WHERE session_id = ?1)",
                    params![target.session],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if held {
                return Err(target_exists(target, "summaries"));
            }
            let mut statement = tx.prepare(&insert).map_err(|error| error.to_string())?;
            for row in &rows.rows {
                statement
                    .execute(rusqlite::params_from_iter(row))
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        })?;
        Ok::<_, String>((
            rows.rows.len(),
            summary_cut,
            source_tags,
            numbering
                .alignment_warnings()
                .iter()
                .cloned()
                .chain(rows.skipped.iter().cloned())
                .collect::<Vec<_>>(),
        ))
    })?;
    // The newest message stays shown, as after a move: the cut goes through
    // the last summarized entry or the one before the newest, whichever
    // comes first.
    let cut = match (summary_cut, before_newest) {
        (Some((entry, mid)), Some((before, _))) if entry < before => Some((entry, mid)),
        (Some(_), Some((before, mid))) => Some((before, mid.to_owned())),
        _ => None,
    };
    let origin = CopyOrigin {
        harness: source_harness.into(),
        session: source_session.into(),
        injection_project: request.injection_project.as_ref().map(|project| Project {
            id: project.id.clone(),
            root: project.folder.clone(),
        }),
    };
    let db = Arc::new(db);
    let first_view = (|| {
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
        // Offline: the operator names the session and the project its runner
        // will stamp, which picks its configuration.
        let route = Route {
            session: target.clone(),
            project: request.project.clone(),
            workdir: request.project.as_ref().map(|project| project.root.clone()),
            agent_id: None,
        };
        let mut session = Session::new(&route, &setup, features, Some(Arc::clone(&db)));
        // Before the first render, so the first head already reads the
        // injection project.
        session.copied_from(origin.clone());
        session.load_summaries();
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
        let view = session
            .first_view_after_move(&settings, cut.as_ref().map(|(n, mid)| (*n, mid.as_str())))?;
        let tag_checkpoint = db
            .with_connection(|conn| tag_floor(conn, &target.harness, &target.session))?
            .0
            .max(source_tags)
            .max(request.tag_floor.unwrap_or(0));
        let durable = session.durable();
        store
            .save(target, &durable)
            .map_err(|error| format!("state_save_failed: {error}"))?;
        Ok::<_, String>((view, tag_checkpoint, durable.cut))
    })();
    let (view, tag_checkpoint, cut_entry) = match first_view {
        Ok(done) => done,
        Err(error) => {
            // Take the copied summaries back, so a retry finds the target as
            // it was rather than refusing it as taken.
            db.with_connection(|conn| {
                crate::move_batches::transaction(conn, "copy-undo", |tx| {
                    tx.execute(
                        "DELETE FROM compartments WHERE session_id = ?1 AND harness = ?2",
                        params![target.session, target.harness],
                    )
                    .map(|_| ())
                    .map_err(|error| error.to_string())
                })
            })
            .map_err(|undo| format!("{error}; removing the copied summaries failed: {undo}"))?;
            return Err(error);
        }
    };
    let cut_mid = view.edits.iter().find_map(|edit| match &edit.op {
        cortexkit_role_compaction::view::EditOp::Cut { through } => Some(through.as_str()),
        _ => None,
    });
    tracing::info!(
        "ck-mc: move-in copy: {source_harness}/{source_session} copied to {}/{}/{}: {copied} summaries, cut {}, injection project {}",
        target.runner,
        target.harness,
        target.session,
        match (cut_entry, cut_mid) {
            (Some(entry), Some(mid)) => format!("through entry {entry} ({mid})"),
            _ => "none".into(),
        },
        origin
            .injection_project
            .as_ref()
            .map_or_else(|| "none".into(), |project| format!("{} ({})", project.id, project.root)),
    );
    Ok(Moved {
        view,
        tag_checkpoint,
        warnings,
        // The source keeps every row; nothing of it is reused here.
        source_state_kept: Some(true),
    })
}
