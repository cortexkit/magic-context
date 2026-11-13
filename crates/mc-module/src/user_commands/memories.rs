//! The person's memory and observation commands: edit, archive, restore,
//! delete and undo for each level's memories, and promoting or dismissing
//! the summarizer's observations about the person. Every write goes through
//! the person's memory writer ([`crate::memory_writes::person`]), which keeps
//! the history the apps show and undo restores.

use cortexkit_role_user_commands::{Fact, FactValue, Preview};
use rusqlite::OptionalExtension;
use serde_json::{json, Map};

use super::owner::{
    before_after, category_for, count, id, ids, joined, not_here, person_refused, plain, read,
    Plan, KEEP, KEEP_IMPORTANCE,
};
use super::*;
use crate::context_db::ContextDb;
use crate::memory_writes::person::{self, Edit, OwnerRef, Status, Target};
use crate::memory_writes::{get_memory, history_snapshot, normalized_hash, MemoryRow};

type Stamp<'s> = &'s dyn Fn(Value) -> String;

/// What a preview's version covers of one memory: the fields any of these
/// commands reads or changes. Counters and times are left out, so a search
/// hit or a repeated save doesn't make a preview stale.
fn row_state(memory: &MemoryRow) -> Value {
    json!([
        memory.id,
        memory.revision,
        memory.status,
        memory.superseded_by_memory_id,
        memory.category_id,
        memory.normalized_hash
    ])
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

/// The memories `ids` names, each of which must be the owner's. A refusal
/// names every id that isn't.
fn owned(
    db: &ContextDb,
    owner: &OwnerRef,
    ids: &[i64],
    field: &str,
) -> Result<Vec<MemoryRow>, ErrorBody> {
    let rows = read(db, |conn| {
        ids.iter()
            .map(|id| get_memory(conn, *id))
            .collect::<rusqlite::Result<Vec<_>>>()
    })?;
    let missing: Vec<i64> = ids
        .iter()
        .zip(&rows)
        .filter(|(_, row)| {
            !row.as_ref()
                .is_some_and(|row| row.level == owner.level && row.owner_id == owner.owner_id)
        })
        .map(|(id, _)| *id)
        .collect();
    if !missing.is_empty() {
        return Err(not_here(
            field,
            format!(
                "{} {} {} not among this subject's {} memories.",
                if missing.len() == 1 {
                    "Memory"
                } else {
                    "Memories"
                },
                joined(&missing),
                if missing.len() == 1 { "is" } else { "are" },
                owner.level
            ),
            &missing,
        ));
    }
    Ok(rows.into_iter().flatten().collect())
}

fn changed(db: &ContextDb, owner: &OwnerRef) {
    db.changed(crate::app_read::Change::Memories {
        level: owner.level.clone(),
        owner: owner.owner_id.clone(),
    });
}

fn applied(facts: Vec<Fact>) -> RunReply {
    let mut reply = RunReply::new("applied");
    reply.facts = Some(facts);
    reply
}

fn chars(text: &str) -> FactValue {
    let mut data = FactValue::number(text.chars().count() as f64);
    data.unit = Some("count".into());
    data.noun = Some("characters".into());
    data
}

fn importance_cell(importance: Option<i64>) -> FactValue {
    match importance {
        Some(importance) => plain(importance),
        None => FactValue::state("off"),
    }
}

pub(super) fn plan<'a>(
    db: &'a ContextDb,
    owner: OwnerRef,
    verb: &str,
    args: &Map<String, Value>,
    stamp: Stamp<'_>,
) -> Result<Plan<'a>, ErrorBody> {
    match verb {
        "edit" => edit(db, owner, args, stamp),
        "archive" => status(db, owner, args, stamp, Status::Archive),
        "restore" => status(db, owner, args, stamp, Status::Restore),
        "delete" => delete(db, owner, args, stamp),
        "undo" => undo(db, owner, args, stamp),
        _ => Err(ErrorBody::new(wire::UNKNOWN_COMMAND, "Unknown command.")),
    }
}

/// `<level>_memory_edit {id, content, category, importance}`.
fn edit<'a>(
    db: &'a ContextDb,
    owner: OwnerRef,
    args: &Map<String, Value>,
    stamp: Stamp<'_>,
) -> Result<Plan<'a>, ErrorBody> {
    let id = id(args, "id")?;
    let memory = owned(db, &owner, &[id], "id")?.remove(0);
    let (importance_now, safety_critical): (Option<i64>, bool) = read(db, |conn| {
        conn.query_row(
            "SELECT importance, COALESCE(safety_critical, 0) FROM memories WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
        )
    })?;
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let content = (!content.is_empty() && content != memory.content).then(|| content.to_owned());
    let category = match args.get("category").and_then(Value::as_str) {
        None | Some(KEEP) => None,
        Some(chosen) => {
            let category = category_for(&owner.level, chosen).ok_or_else(|| {
                ErrorBody::new(
                    wire::INVALID_PARAMS,
                    format!(
                        "{chosen} is not a category {} memories may use.",
                        owner.level
                    ),
                )
                .with_detail(json!({"field": "args.category"}))
            })?;
            (category.id != memory.category_id || category.tag != memory.category)
                .then(|| (category.id.clone(), category.tag.clone()))
        }
    };
    let importance = match args.get("importance").and_then(Value::as_f64) {
        None => None,
        Some(value) if value == KEEP_IMPORTANCE as f64 => None,
        Some(value) if value.fract() == 0.0 && (0.0..=100.0).contains(&value) => {
            Some(person::kept_importance(value as i64, safety_critical))
        }
        Some(_) => return Err(invalid("args.importance")),
    }
    .filter(|importance| Some(*importance) != importance_now);
    let change = Edit {
        content,
        category,
        importance,
    };
    let version = stamp(json!({"row": row_state(&memory), "importance": importance_now}));
    if !memory.is_mutable() {
        return Ok(Plan::unavailable(version, "not_live"));
    }
    if change == Edit::default() {
        return Ok(Plan::unavailable(version, "no_change"));
    }
    let content_after = change.content.as_deref().unwrap_or(&memory.content);
    let category_after = change
        .category
        .as_ref()
        .map_or(memory.category_id.as_str(), |(id, _)| id.as_str());
    let (duplicate, recordable) = read(db, |conn| {
        Ok((
            person::live_duplicate(
                conn,
                &owner,
                category_after,
                &normalized_hash(content_after),
                id,
            )?,
            history_snapshot(conn, id)?.is_some(),
        ))
    })?;
    if duplicate.is_some() {
        return Ok(Plan::unavailable(version, "duplicate_content"));
    }
    if !recordable {
        return Ok(Plan::unavailable(version, "history_unavailable"));
    }
    let mut what = Vec::new();
    if change.content.is_some() {
        what.push("text");
    }
    if change.category.is_some() {
        what.push("category");
    }
    if change.importance.is_some() {
        what.push("importance");
    }
    let what = match what.as_slice() {
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
        [] => String::new(),
    };
    let mut preview = Preview::new(version, true);
    preview.effect = Some(format!(
        "Changes this {} memory's {what}. History keeps the old row; undo restores it.",
        owner.level
    ));
    preview.facts = Some(vec![count("Memories", 1, Some("memories"))]);
    preview.table = before_after(vec![
        (
            "Text length".into(),
            chars(&memory.content),
            chars(content_after),
        ),
        (
            "Importance".into(),
            importance_cell(importance_now),
            importance_cell(change.importance.or(importance_now)),
        ),
        (
            "Revision".into(),
            plain(memory.revision),
            plain(memory.revision + 1),
        ),
    ]);
    let target = Target {
        id,
        revision: memory.revision,
    };
    Ok(Plan::available(
        preview,
        Box::new(move || {
            let command = format!("{}_memory_edit", owner.level);
            db.with_connection(|conn| person::edit(conn, &owner, target, &change))
                .map_err(|error| person_refused(&command, error))?;
            changed(db, &owner);
            Ok(applied(vec![
                count("Memories changed", 1, Some("memories")),
                Fact::new("Revision", plain(target.revision + 1)),
            ]))
        }),
    ))
}

/// `<level>_memory_archive {ids}` and `<level>_memory_restore {ids}`.
fn status<'a>(
    db: &'a ContextDb,
    owner: OwnerRef,
    args: &Map<String, Value>,
    stamp: Stamp<'_>,
    change: Status,
) -> Result<Plan<'a>, ErrorBody> {
    let ids = ids(args, "ids")?;
    let rows = owned(db, &owner, &ids, "ids")?;
    let version = stamp(Value::Array(rows.iter().map(row_state).collect()));
    let (mut targets, mut skipped, mut duplicates, mut unrecordable) = (Vec::new(), 0, 0, 0);
    for memory in &rows {
        if !change.applies(memory) {
            skipped += 1;
            continue;
        }
        let (duplicate, recordable) = read(db, |conn| {
            let duplicate = match change {
                Status::Restore => person::live_duplicate(
                    conn,
                    &owner,
                    &memory.category_id,
                    &memory.normalized_hash,
                    memory.id,
                )?,
                Status::Archive => None,
            };
            Ok((duplicate, history_snapshot(conn, memory.id)?.is_some()))
        })?;
        if duplicate.is_some() {
            duplicates += 1;
        } else if !recordable {
            unrecordable += 1;
        } else {
            targets.push(Target {
                id: memory.id,
                revision: memory.revision,
            });
        }
    }
    if targets.is_empty() {
        let reason = if duplicates > 0 {
            "duplicate_content"
        } else if unrecordable > 0 {
            "history_unavailable"
        } else {
            "nothing_to_change"
        };
        return Ok(Plan::unavailable(version, reason));
    }
    let (verb, done, skipped_label) = match change {
        Status::Archive => ("archive", "Memories archived", "Already archived"),
        Status::Restore => ("restore", "Memories restored", "Not archived"),
    };
    let level = owner.level.clone();
    let mut facts = vec![
        count("Memories", targets.len(), Some("memories")),
        count(skipped_label, skipped, Some("memories")),
    ];
    if duplicates > 0 {
        facts.push(count(
            "Would repeat a live memory",
            duplicates,
            Some("memories"),
        ));
    }
    if unrecordable > 0 {
        facts.push(count(
            "History can't record",
            unrecordable,
            Some("memories"),
        ));
    }
    let mut preview = Preview::new(version, true);
    preview.effect = Some(match change {
        Status::Archive => format!(
            "Archives {}; agents stop seeing them. Restore brings them back.",
            plural(
                targets.len(),
                &format!("{level} memory"),
                &format!("{level} memories")
            )
        ),
        Status::Restore => format!(
            "Restores {}; agents see them again.",
            plural(
                targets.len(),
                &format!("archived {level} memory"),
                &format!("archived {level} memories")
            )
        ),
    });
    preview.facts = Some(facts);
    Ok(Plan::available(
        preview,
        Box::new(move || {
            let command = format!("{}_memory_{verb}", owner.level);
            db.with_connection(|conn| person::set_status(conn, &owner, &targets, change))
                .map_err(|error| person_refused(&command, error))?;
            changed(db, &owner);
            Ok(applied(vec![count(done, targets.len(), Some("memories"))]))
        }),
    ))
}

/// `<level>_memory_delete {ids}`: permanent.
fn delete<'a>(
    db: &'a ContextDb,
    owner: OwnerRef,
    args: &Map<String, Value>,
    stamp: Stamp<'_>,
) -> Result<Plan<'a>, ErrorBody> {
    let ids = ids(args, "ids")?;
    let rows = owned(db, &owner, &ids, "ids")?;
    let version = stamp(Value::Array(rows.iter().map(row_state).collect()));
    let history: i64 = read(db, |conn| {
        let mut total = 0;
        for id in &ids {
            total += conn.query_row(
                "SELECT COUNT(*) FROM memory_history WHERE memory_id = ?1",
                [id],
                |row| row.get::<_, i64>(0),
            )?;
        }
        Ok(total)
    })?;
    let targets: Vec<Target> = rows
        .iter()
        .map(|memory| Target {
            id: memory.id,
            revision: memory.revision,
        })
        .collect();
    let mut preview = Preview::new(version, true);
    preview.effect = Some(format!(
        "Deletes {} for good, with their history, embeddings and search entries.",
        plural(
            targets.len(),
            &format!("{} memory", owner.level),
            &format!("{} memories", owner.level)
        )
    ));
    preview.facts = Some(vec![
        count("Memories", targets.len(), Some("memories")),
        count("History entries", history as usize, Some("entries")),
    ]);
    Ok(Plan::available(
        preview,
        Box::new(move || {
            let command = format!("{}_memory_delete", owner.level);
            db.with_connection(|conn| person::delete(conn, &owner, &targets))
                .map_err(|error| person_refused(&command, error))?;
            changed(db, &owner);
            Ok(applied(vec![count(
                "Memories deleted",
                targets.len(),
                Some("memories"),
            )]))
        }),
    ))
}

/// `<level>_memory_undo {id, revision}`.
fn undo<'a>(
    db: &'a ContextDb,
    owner: OwnerRef,
    args: &Map<String, Value>,
    stamp: Stamp<'_>,
) -> Result<Plan<'a>, ErrorBody> {
    let id = id(args, "id")?;
    let revision = super::owner::id(args, "revision")?;
    let memory = owned(db, &owner, &[id], "id")?.remove(0);
    let (entry, recordable, importance_now) = read(db, |conn| {
        Ok((
            person::entry(conn, id, revision)?,
            history_snapshot(conn, id)?.is_some(),
            conn.query_row(
                "SELECT importance FROM memories WHERE id = ?1",
                [id],
                |row| row.get::<_, Option<i64>>(0),
            )?,
        ))
    })?;
    let version = stamp(json!({
        "row": row_state(&memory),
        // The entry is named by the revisions it joins, not by its decision
        // key, which carries the writer's process and clock.
        "entry": entry.as_ref().map(|entry| json!([
            entry.before.as_ref().map(|before| &before["revision"]),
            entry.after["revision"],
        ])),
    }));
    let Some(entry) = entry else {
        return Ok(Plan::unavailable(version, "history_not_found"));
    };
    if !recordable || !person::restorable(&memory, entry.before.as_ref()) {
        return Ok(Plan::unavailable(version, "history_unavailable"));
    }
    let restored = person::restored(&memory, entry.before.as_ref());
    if restored.live {
        let duplicate = read(db, |conn| {
            person::live_duplicate(conn, &owner, &restored.category_id, &restored.hash, id)
        })?;
        if duplicate.is_some() {
            return Ok(Plan::unavailable(version, "duplicate_content"));
        }
    }
    let mut preview = Preview::new(version, true);
    let (text_after, importance_after) = match &entry.before {
        Some(before) => (
            before["content"]
                .as_str()
                .unwrap_or(&memory.content)
                .to_owned(),
            before["importance"].as_i64(),
        ),
        None => (memory.content.clone(), importance_now),
    };
    preview.effect = Some(match entry.before {
        Some(_) => format!(
            "Restores this {} memory as it was before revision {revision}. Undo can take that back too.",
            owner.level
        ),
        None => format!(
            "Archives this {} memory: revision {revision} created it.",
            owner.level
        ),
    });
    preview.facts = Some(vec![count("Memories", 1, Some("memories"))]);
    preview.table = before_after(vec![
        (
            "Text length".into(),
            chars(&memory.content),
            chars(&text_after),
        ),
        (
            "Importance".into(),
            importance_cell(importance_now),
            importance_cell(importance_after),
        ),
        (
            "Revision".into(),
            plain(memory.revision),
            plain(memory.revision + 1),
        ),
    ]);
    let target = Target {
        id,
        revision: memory.revision,
    };
    Ok(Plan::available(
        preview,
        Box::new(move || {
            let command = format!("{}_memory_undo", owner.level);
            db.with_connection(|conn| person::undo(conn, &owner, target, &entry))
                .map_err(|error| person_refused(&command, error))?;
            changed(db, &owner);
            Ok(applied(vec![
                count("Memories changed", 1, Some("memories")),
                Fact::new("Revision", plain(target.revision + 1)),
            ]))
        }),
    ))
}

/// One observation row: its id, text and whether a review took it.
type ObservationRow = (i64, String, Option<i64>);

fn observations(
    db: &ContextDb,
    ids: &[i64],
    field: &str,
) -> Result<Vec<ObservationRow>, ErrorBody> {
    let rows = read(db, |conn| {
        ids.iter()
            .map(|id| {
                conn.query_row(
                    "SELECT id, content, consumed_at FROM memory_observations WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
            })
            .collect::<rusqlite::Result<Vec<Option<ObservationRow>>>>()
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
                "No observation has the id{} {}.",
                if missing.len() == 1 { "" } else { "s" },
                joined(&missing)
            ),
            &missing,
        ));
    }
    Ok(rows.into_iter().flatten().collect())
}

/// `observation_promote {id, category}`: the person writes the global
/// memory; the review task never sees the observation.
pub(super) fn promote<'a>(
    db: &'a ContextDb,
    args: &Map<String, Value>,
    stamp: Stamp<'_>,
) -> Result<Plan<'a>, ErrorBody> {
    let id = id(args, "id")?;
    let chosen = args.get("category").and_then(Value::as_str).unwrap_or("");
    let category = category_for("global", chosen).ok_or_else(|| {
        ErrorBody::new(
            wire::INVALID_PARAMS,
            format!("{chosen} is not a category global memories may use."),
        )
        .with_detail(json!({"field": "args.category"}))
    })?;
    let (_, content, consumed) = observations(db, &[id], "id")?.remove(0);
    let hash = normalized_hash(&content);
    let version = stamp(json!([id, consumed, hash]));
    if consumed.is_some() {
        return Ok(Plan::unavailable(version, "already_reviewed"));
    }
    let owner = person::global();
    let duplicate = read(db, |conn| {
        person::live_duplicate(conn, &owner, &category.id, &hash, 0)
    })?;
    if duplicate.is_some() {
        return Ok(Plan::unavailable(version, "duplicate_content"));
    }
    let mut preview = Preview::new(version, true);
    preview.effect = Some(format!(
        "Saves this observation as a global memory under {}; the review task skips it.",
        category.label
    ));
    preview.facts = Some(vec![
        count("Memories", 1, Some("memories")),
        Fact::new("Text length", chars(&content)),
    ]);
    Ok(Plan::available(
        preview,
        Box::new(move || {
            let memory = db
                .with_connection(|conn| {
                    person::promote(conn, id, (category.id.as_str(), category.tag.as_str()))
                })
                .map_err(|error| person_refused("observation_promote", error))?;
            changed(db, &owner);
            Ok(applied(vec![
                count("Memories saved", 1, Some("memories")),
                Fact::new("Memory id", plain(memory)),
            ]))
        }),
    ))
}

/// `observation_dismiss {ids}`.
pub(super) fn dismiss<'a>(
    db: &'a ContextDb,
    args: &Map<String, Value>,
    stamp: Stamp<'_>,
) -> Result<Plan<'a>, ErrorBody> {
    let ids = ids(args, "ids")?;
    let rows = observations(db, &ids, "ids")?;
    let version = stamp(Value::Array(
        rows.iter()
            .map(|(id, _, consumed)| json!([id, consumed]))
            .collect(),
    ));
    let pending: Vec<i64> = rows
        .iter()
        .filter(|(_, _, consumed)| consumed.is_none())
        .map(|(id, _, _)| *id)
        .collect();
    if pending.is_empty() {
        return Ok(Plan::unavailable(version, "nothing_to_change"));
    }
    let mut preview = Preview::new(version, true);
    preview.effect = Some(format!(
        "Takes {} out of review; no memory is written.",
        plural(pending.len(), "observation", "observations")
    ));
    preview.facts = Some(vec![
        count("Observations", pending.len(), Some("observations")),
        count(
            "Already reviewed",
            rows.len() - pending.len(),
            Some("observations"),
        ),
    ]);
    Ok(Plan::available(
        preview,
        Box::new(move || {
            let dismissed = db
                .with_connection(|conn| person::dismiss_observations(conn, &pending))
                .map_err(|error| {
                    super::owner::store_failed("observation_dismiss", &error.to_string())
                })?;
            db.changed(crate::app_read::Change::global_memories());
            Ok(applied(vec![count(
                "Observations dismissed",
                dismissed,
                Some("observations"),
            )]))
        }),
    ))
}
