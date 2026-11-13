//! `ctx_note`: session notes, the pending intentions an agent wants to come
//! back to. The argument rules and reply bytes are the TypeScript tool's
//! (`packages/plugin/src/tools/ctx-note`), so an agent reads the same in both.
//!
//! Notes live in `context.db`, keyed by the session's harness and host
//! session id, so a session moved in from a standalone host keeps its notes
//! without any copy. Smart notes are not created here: their conditions are
//! checked by the standalone dreamer, which module-only ck-mc replaces with
//! other wake sources. A smart note a standalone session already holds is
//! still shown, dismissed and updated.

use serde_json::{Map, Value};

use crate::context_db::{ContextDb, NoteScope, StoredNote};

const GLANCE_TITLE_MAX: usize = 80;
/// A note untouched for this long is marked stale in the glance.
const STALE_AFTER_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_READ_LIMIT: usize = 25;
pub const EMPTY_READ_REPLY: &str = "## Notes\n\nNo session notes or smart notes.";
const SMART_NOTE_REPLY: &str =
    "Smart notes are not available in this session; stored as a plain session note.";

fn touched_at(note: &StoredNote) -> i64 {
    if note.updated_at > 0 {
        note.updated_at
    } else {
        note.created_at
    }
}

/// Compact age: `5m`, `3h`, `2d`, `6w`.
pub fn age(touched: i64, now_ms: i64) -> String {
    let elapsed = (now_ms - touched).max(0);
    let minutes = elapsed / 60_000;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = elapsed / 3_600_000;
    if hours < 24 {
        return format!("{hours}h");
    }
    let days = elapsed / 86_400_000;
    if days < 7 {
        return format!("{days}d");
    }
    format!("{}w", days / 7)
}

/// First line of the note, clipped to `max` characters with `…`.
fn clip_title(content: &str, max: usize) -> String {
    let first = content.lines().next().unwrap_or("").trim();
    if first.chars().count() <= max {
        return first.to_owned();
    }
    format!("{}…", first.chars().take(max).collect::<String>())
}

/// `#id · age · title`, plus `· status` when not active and `· stale` after
/// 30 days untouched.
fn glance_row(note: &StoredNote, now_ms: i64) -> String {
    let touched = touched_at(note);
    let mut markers: Vec<String> = Vec::new();
    if note.status != "active" {
        markers.push(note.status.clone());
    }
    if note.kind == "smart"
        && note.status == "pending"
        && note.check_status.as_deref() == Some("parked")
    {
        markers.push(format!(
            "parked: {}",
            note.ready_reason
                .as_deref()
                .unwrap_or("Condition can't be checked")
        ));
    }
    if now_ms - touched >= STALE_AFTER_MS {
        markers.push("stale".into());
    }
    let suffix = if markers.is_empty() {
        String::new()
    } else {
        format!(" · {}", markers.join(" · "))
    };
    format!(
        "#{} · {} · {}{suffix}",
        note.id,
        age(touched, now_ms),
        clip_title(&note.content, GLANCE_TITLE_MAX)
    )
}

/// Ready notes first, then pending, then the rest, each newest first.
fn order(mut notes: Vec<StoredNote>) -> Vec<StoredNote> {
    notes.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then(right.id.cmp(&left.id))
    });
    let rank = |note: &StoredNote| match note.status.as_str() {
        "ready" => 0,
        "pending" => 1,
        _ => 2,
    };
    notes.sort_by_key(rank);
    notes
}

pub fn render_glance(notes: Vec<StoredNote>, limit: usize, offset: usize, now_ms: i64) -> String {
    let ordered = order(notes);
    let total = ordered.len();
    let page: Vec<&StoredNote> = ordered.iter().skip(offset).take(limit).collect();
    if page.is_empty() {
        return EMPTY_READ_REPLY.to_owned();
    }
    let rows: Vec<String> = page.iter().map(|note| glance_row(note, now_ms)).collect();
    let remaining = total.saturating_sub(offset + page.len());
    let footer = if remaining > 0 {
        format!(
            "\n\nShowing {} of {total} — {remaining} older: ctx_note(action=\"read\", offset={})",
            page.len(),
            offset + page.len()
        )
    } else {
        String::new()
    };
    format!("## Notes\n\n{}{footer}", rows.join("\n"))
}

fn note_body(note: &StoredNote, now_ms: i64) -> String {
    let anchor = note
        .anchor_ordinal
        .map(|ordinal| format!(" ↳ @msg {ordinal}"))
        .unwrap_or_default();
    let head = format!(
        "- **#{}** · {} · {}: {}{anchor}",
        note.id,
        age(touched_at(note), now_ms),
        note.status,
        note.content
    );
    if note.kind != "smart" {
        return head;
    }
    let ready = note.status == "ready";
    let condition = if ready {
        note.ready_reason
            .as_deref()
            .or(note.surface_condition.as_deref())
            .unwrap_or("Condition satisfied")
    } else {
        note.surface_condition
            .as_deref()
            .unwrap_or("No condition recorded")
    };
    let failure = match &note.ready_reason {
        Some(reason)
            if note.status == "pending" && reason.starts_with("Condition can't be checked:") =>
        {
            format!("\n  {reason}")
        }
        _ => String::new(),
    };
    format!(
        "{head}\n  {}: {condition}{failure}",
        if ready { "Condition met" } else { "Condition" }
    )
}

/// Every read reply ends with the anchor hint (when a note carries an
/// anchor) and the dismiss footer.
fn finish_read(body: String) -> String {
    if body == EMPTY_READ_REPLY {
        return body;
    }
    let hint = if body.contains("↳ @msg ") {
        "\n\n↳ @msg N marks the conversation tail when a note was written. To see what led to it: ctx_expand(start=N-x, end=N) (pick x for how far back to look)."
    } else {
        ""
    };
    format!("{body}{hint}\n\nTo dismiss a stale note: ctx_note(action=\"dismiss\", note_ids=[N])")
}

fn write_reply(id: i64, active: &[StoredNote], now_ms: i64) -> String {
    let base = format!("Saved session note #{id}.");
    match active.iter().map(touched_at).min() {
        Some(oldest) => format!(
            "{base} {} active, oldest {}.",
            active.len(),
            age(oldest, now_ms)
        ),
        None => base,
    }
}

/// `note_ids` for the actions that take them: one for update, 1–50 for
/// dismiss and a targeted read.
fn note_ids(action: &str, value: Option<&Value>) -> Result<Vec<i64>, String> {
    let max = if action == "update" { 1 } else { 50 };
    let ids: Option<Vec<i64>> = value.and_then(Value::as_array).and_then(|items| {
        items
            .iter()
            .map(|item| item.as_i64().filter(|id| *id > 0))
            .collect()
    });
    match ids {
        Some(ids) if !ids.is_empty() && ids.len() <= max => Ok(ids),
        _ if action == "update" => {
            Err("Error: 'note_ids' must contain exactly one positive integer id when action is 'update'.".into())
        }
        _ => Err(format!(
            "Error: 'note_ids' must contain 1 to 50 positive integer ids when action is '{action}'."
        )),
    }
}

fn text<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

/// Run one `ctx_note` call. `anchor` is the number of the newest message, if
/// any, which a written note records as the conversation tail it came from.
/// The action a `ctx_note` call asks for.
fn action(args: &Map<String, Value>) -> String {
    match args.get("action").and_then(Value::as_str) {
        Some(action @ ("write" | "read" | "update" | "dismiss")) => action.to_owned(),
        Some(_) => "read".into(),
        // Models that fill every field send an empty content on a read.
        None if text(args, "content").is_some() => "write".into(),
        None => "read".into(),
    }
}

/// Whether a `ctx_note` call asks to change notes, not only read them.
pub(crate) fn writes(input: &Value) -> bool {
    let empty = Map::new();
    action(input.as_object().unwrap_or(&empty)) != "read"
}

pub fn run(
    db: &ContextDb,
    scope: &NoteScope,
    input: &Value,
    anchor: Option<u64>,
    now_ms: i64,
) -> Result<String, String> {
    let empty = Map::new();
    let args = input.as_object().unwrap_or(&empty);
    let action = action(args);
    let listed = args.get("note_ids").and_then(Value::as_array).map(Vec::len);
    let targeted = match action.as_str() {
        "dismiss" | "update" => Some(note_ids(&action, args.get("note_ids"))?),
        "read" if listed.is_some_and(|count| count > 0) => {
            Some(note_ids(&action, args.get("note_ids"))?)
        }
        _ => None,
    };
    match action.as_str() {
        "write" => {
            let content = text(args, "content")
                .ok_or("Error: 'content' is required when action is 'write'.")?;
            let id = db.add_session_note(scope, content, anchor, now_ms)?;
            let reply = write_reply(id, &db.session_notes(scope, &["active"])?, now_ms);
            Ok(if text(args, "surface_condition").is_some() {
                format!("{reply}\n{SMART_NOTE_REPLY}")
            } else {
                reply
            })
        }
        "dismiss" => {
            let ids = targeted.expect("checked");
            let outcomes = db.dismiss_notes(&ids, scope, now_ms)?;
            if let [(id, done)] = outcomes[..] {
                return Ok(if done {
                    format!("Note #{id} dismissed.")
                } else {
                    format!(
                        "Error: Note #{id} not found in your session/project or already dismissed."
                    )
                });
            }
            let dismissed = outcomes.iter().filter(|(_, done)| *done).count();
            let lines: Vec<String> = outcomes
                .iter()
                .map(|(id, done)| {
                    format!(
                        "- Note #{id}: {}",
                        if *done { "dismissed" } else { "not_found" }
                    )
                })
                .collect();
            Ok(format!(
                "Dismissed {dismissed} of {} notes.\n{}",
                outcomes.len(),
                lines.join("\n")
            ))
        }
        "update" => {
            let id = targeted.expect("checked")[0];
            if text(args, "surface_condition").is_some()
                && db
                    .note_in_scope(id, scope)?
                    .is_some_and(|note| note.kind == "session")
            {
                return Ok("Error: Only a note created with a condition can have one. Write a new note with surface_condition, and dismiss this one.".into());
            }
            let Some(content) = text(args, "content") else {
                return Err(
                    "Error: Provide 'content' and/or 'surface_condition' to update.".into(),
                );
            };
            if db.update_note_content(id, scope, content, now_ms)? {
                Ok(format!("Updated note #{id}:\nContent: {content}"))
            } else {
                Err(format!(
                    "Error: Note #{id} not found in your session/project or has no compatible fields to update."
                ))
            }
        }
        "read" => {
            let body = match targeted {
                Some(ids) => {
                    let lines: Vec<String> = ids
                        .iter()
                        .map(|id| {
                            Ok(match db.note_in_scope(*id, scope)? {
                                Some(note) => note_body(&note, now_ms),
                                None => format!("- Note #{id}: not_found"),
                            })
                        })
                        .collect::<Result<_, String>>()?;
                    format!("## Notes by ID\n\n{}", lines.join("\n\n"))
                }
                None => {
                    let notes = match args.get("filter").and_then(Value::as_str) {
                        None | Some("") => {
                            let mut notes = db.session_notes(scope, &["active"])?;
                            notes.extend(db.project_smart_notes(scope, &["ready", "pending"])?);
                            notes
                        }
                        Some(filter) => {
                            let statuses: &[&str] = match filter {
                                "all" => &["active", "pending", "ready", "dismissed"],
                                "active" => &["active"],
                                "pending" => &["pending"],
                                "ready" => &["ready"],
                                "dismissed" => &["dismissed"],
                                _ => &["active", "ready", "pending"],
                            };
                            let mut notes = db.session_notes(scope, statuses)?;
                            notes.extend(db.project_smart_notes(scope, statuses)?);
                            notes
                        }
                    };
                    let positive = |key: &str| {
                        args.get(key)
                            .and_then(Value::as_f64)
                            .filter(|value| *value > 0.0)
                            .map(|value| value.floor() as usize)
                    };
                    render_glance(
                        notes,
                        positive("limit").unwrap_or(DEFAULT_READ_LIMIT),
                        positive("offset").unwrap_or(0),
                        now_ms,
                    )
                }
            };
            Ok(finish_read(body))
        }
        other => Err(format!("Error: unknown action '{other}'.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: i64, status: &str, content: &str, updated_at: i64) -> StoredNote {
        StoredNote {
            id,
            kind: "session".into(),
            status: status.into(),
            content: content.into(),
            created_at: updated_at,
            updated_at,
            ..StoredNote::default()
        }
    }

    #[test]
    fn the_glance_orders_clips_marks_and_pages() {
        let day = 86_400_000;
        let notes = vec![
            note(1, "active", "Old note\nwith detail", 0),
            note(2, "dismissed", &"t".repeat(90), 40 * day),
            note(3, "active", "Newest", 40 * day + 1),
        ];
        let glance = render_glance(notes, 2, 0, 41 * day);
        assert_eq!(
            glance,
            format!(
                "## Notes\n\n#3 · 23h · Newest\n#2 · 1d · {}… · dismissed\n\nShowing 2 of 3 — 1 older: ctx_note(action=\"read\", offset=2)",
                "t".repeat(80)
            )
        );
    }

    #[test]
    fn ids_follow_the_action() {
        assert!(note_ids("update", Some(&serde_json::json!([1, 2]))).is_err());
        assert_eq!(
            note_ids("dismiss", Some(&serde_json::json!([4, 5]))),
            Ok(vec![4, 5])
        );
        assert!(note_ids("dismiss", Some(&serde_json::json!([0]))).is_err());
    }
}
