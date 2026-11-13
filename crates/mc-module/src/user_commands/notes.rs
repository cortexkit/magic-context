//! The person's note commands for a project: edit one note's text, dismiss
//! notes, and delete them for good. Notes have no history; a note's version
//! is its update time, status and text.

use cortexkit_role_user_commands::{FactValue, Preview};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Map};

use super::owner::{before_after, count, id, ids, joined, not_here, read, Plan, Refused};
use super::*;
use crate::context_db::ContextDb;

type Stamp<'s> = &'s dyn Fn(Value) -> String;

/// A project note as these commands read it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Note {
    id: i64,
    status: String,
    content: String,
    updated_at: i64,
}

fn note_state(note: &Note) -> Value {
    json!([
        note.id,
        note.status,
        note.updated_at,
        crate::memory_writes::normalized_hash(&note.content)
    ])
}

/// The project's notes `ids` names. A refusal names every id that isn't
/// one of them.
fn project_notes(
    db: &ContextDb,
    project: &str,
    ids: &[i64],
    field: &str,
) -> Result<Vec<Note>, ErrorBody> {
    let rows = read(db, |conn| {
        ids.iter()
            .map(|id| {
                conn.query_row(
                    "SELECT id, status, content, updated_at FROM notes
                      WHERE id = ?1 AND project_path = ?2",
                    params![id, project],
                    |row| {
                        Ok(Note {
                            id: row.get(0)?,
                            status: row.get(1)?,
                            content: row.get(2)?,
                            updated_at: row.get(3)?,
                        })
                    },
                )
                .optional()
            })
            .collect::<rusqlite::Result<Vec<_>>>()
    })?;
    let missing: Vec<i64> = ids
        .iter()
        .zip(&rows)
        .filter(|(_, row)| row.is_none())
        .map(|(id, _)| *id)
        .collect();
    if !missing.is_empty() {
        return Err(not_here(
            field,
            format!(
                "{} {} {} not among this project's notes.",
                if missing.len() == 1 { "Note" } else { "Notes" },
                joined(&missing),
                if missing.len() == 1 { "is" } else { "are" },
            ),
            &missing,
        ));
    }
    Ok(rows.into_iter().flatten().collect())
}

/// Apply `write` to each note in one transaction. `write` changes a note only
/// while it still has the update time and status the preview read, and
/// answers how many rows it changed; any other count rolls everything back
/// and answers `preview_stale`.
fn write_notes(
    db: &ContextDb,
    notes: &[Note],
    write: impl Fn(&rusqlite::Transaction, &Note) -> rusqlite::Result<usize>,
) -> Result<(), Refused> {
    db.with_connection(|conn| {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for note in notes {
            if write(&tx, note)? != 1 {
                return Ok(false);
            }
        }
        tx.commit()?;
        Ok::<_, rusqlite::Error>(true)
    })
    .map_err(|error| super::owner::store_failed("note", &error.to_string()))
    .and_then(|written| {
        if written {
            Ok(())
        } else {
            Err(Refused::Reply(RunReply::new("preview_stale")))
        }
    })
}

fn chars(text: &str) -> FactValue {
    let mut data = FactValue::number(text.chars().count() as f64);
    data.unit = Some("count".into());
    data.noun = Some("characters".into());
    data
}

fn applied(label: &str, notes: usize) -> RunReply {
    let mut reply = RunReply::new("applied");
    reply.facts = Some(vec![count(label, notes, Some("notes"))]);
    reply
}

/// `note_edit {id, content}`, `note_dismiss {ids}` and `note_delete {ids}`.
pub(super) fn plan<'a>(
    db: &'a ContextDb,
    command: &str,
    project: String,
    args: &Map<String, Value>,
    stamp: Stamp<'_>,
) -> Result<Plan<'a>, ErrorBody> {
    let notify = move |db: &ContextDb, project: &str| {
        db.changed(crate::app_read::Change::Notes {
            project: project.to_owned(),
            session: None,
        })
    };
    match command {
        "note_edit" => {
            let id = id(args, "id")?;
            let content = args
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_owned();
            if content.is_empty() {
                return Err(invalid("args.content"));
            }
            let note = project_notes(db, &project, &[id], "id")?.remove(0);
            let version = stamp(note_state(&note));
            if note.content == content {
                return Ok(Plan::unavailable(version, "no_change"));
            }
            let mut preview = Preview::new(version, true);
            preview.effect = Some("Replaces this note's text; agents see the new text.".into());
            preview.facts = Some(vec![count("Notes", 1, Some("notes"))]);
            preview.table = before_after(vec![(
                "Text length".into(),
                chars(&note.content),
                chars(&content),
            )]);
            Ok(Plan::available(
                preview,
                Box::new(move || {
                    let now = crate::memory_writes::now_ms();
                    write_notes(db, std::slice::from_ref(&note), |tx, note| {
                        tx.execute(
                            "UPDATE notes SET content = ?5, updated_at = ?6
                              WHERE id = ?1 AND project_path = ?2 AND updated_at = ?3 AND status = ?4",
                            params![note.id, project, note.updated_at, note.status, content, now],
                        )
                    })?;
                    notify(db, &project);
                    Ok(applied("Notes changed", 1))
                }),
            ))
        }
        "note_dismiss" => {
            let ids = ids(args, "ids")?;
            let notes = project_notes(db, &project, &ids, "ids")?;
            let version = stamp(Value::Array(notes.iter().map(note_state).collect()));
            let open: Vec<Note> = notes
                .iter()
                .filter(|note| note.status != "dismissed")
                .cloned()
                .collect();
            if open.is_empty() {
                return Ok(Plan::unavailable(version, "nothing_to_change"));
            }
            let mut preview = Preview::new(version, true);
            preview.effect = Some(format!(
                "Dismisses {} of this project; agents stop seeing {}.",
                if open.len() == 1 {
                    "1 note".to_owned()
                } else {
                    format!("{} notes", open.len())
                },
                if open.len() == 1 { "it" } else { "them" }
            ));
            preview.facts = Some(vec![
                count("Notes", open.len(), Some("notes")),
                count("Already dismissed", notes.len() - open.len(), Some("notes")),
            ]);
            Ok(Plan::available(
                preview,
                Box::new(move || {
                    let now = crate::memory_writes::now_ms();
                    write_notes(db, &open, |tx, note| {
                        tx.execute(
                            "UPDATE notes SET status = 'dismissed', updated_at = ?5
                              WHERE id = ?1 AND project_path = ?2 AND updated_at = ?3 AND status = ?4",
                            params![note.id, project, note.updated_at, note.status, now],
                        )
                    })?;
                    notify(db, &project);
                    Ok(applied("Notes dismissed", open.len()))
                }),
            ))
        }
        _ => {
            let ids = ids(args, "ids")?;
            let notes = project_notes(db, &project, &ids, "ids")?;
            let version = stamp(Value::Array(notes.iter().map(note_state).collect()));
            let mut preview = Preview::new(version, true);
            preview.effect = Some(format!(
                "Deletes {} of this project for good.",
                if notes.len() == 1 {
                    "1 note".to_owned()
                } else {
                    format!("{} notes", notes.len())
                }
            ));
            preview.facts = Some(vec![count("Notes", notes.len(), Some("notes"))]);
            Ok(Plan::available(
                preview,
                Box::new(move || {
                    write_notes(db, &notes, |tx, note| {
                        tx.execute(
                            "DELETE FROM notes
                              WHERE id = ?1 AND project_path = ?2 AND updated_at = ?3 AND status = ?4",
                            params![note.id, project, note.updated_at, note.status],
                        )
                    })?;
                    notify(db, &project);
                    Ok(applied("Notes deleted", notes.len()))
                }),
            ))
        }
    }
}
