//! A legacy key's memories, moved or copied to a project id with the 0.49
//! merge's collision rule (`mergeMemoryRow` in
//! `packages/plugin/src/features/magic-context/storage-identity-merge.ts`),
//! ported to the leveled table: a project's memories are the rows at level
//! `project` whose `owner_id` is the project, and a live memory is unique for
//! its owner, category and normalized hash.
//!
//! A live memory that meets a live memory of the target with the same
//! category and text collides. The target's memory survives and absorbs the
//! other's history: seen and retrieval counts, verifications, a newer
//! classification, a newer mural cue and the earlier first sighting. The
//! other is archived as superseded by the survivor and belongs to the target
//! too, so the history shows on the project's own memory page. Archived
//! memories never collide: the table keeps only live rows unique.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension};

use super::store::{insert_copy, log, shape, Row, Table};
use crate::context_migrations::LIVE;
use crate::memory_writes::normalized_hash;

/// Tables that hang off a memory by its id and are copied with it, and the
/// column naming the memory. Verifications are copied only for a copy that
/// stays live; a copy that collides gives them to the survivor instead.
const MEMORY_CHILDREN: &[(&str, &str)] = &[
    ("memory_history", "memory_id"),
    ("memory_clause_evidence", "memory_id"),
    ("memory_embeddings", "memory_id"),
];

/// Links between two memories, copied when both ends are copied.
const MEMORY_LINKS: &[(&str, &str, &str)] = &[
    ("memory_successor_links", "source_id", "successor_id"),
    ("memory_conflict_links", "left_id", "right_id"),
];

fn memories_table(conn: &Connection) -> rusqlite::Result<Table> {
    shape(conn, "memories", "owner_id", None)
}

/// The project's memories at a key, by id.
pub(super) fn of(conn: &Connection, owner: &str) -> rusqlite::Result<Vec<Row>> {
    super::store::rows(
        conn,
        &memories_table(conn)?,
        "level = 'project' AND owner_id = ? ORDER BY id",
        &[Value::Text(owner.to_owned())],
    )
}

fn is_live(row: &Row) -> bool {
    matches!(row.text("status"), None | Some("active" | "permanent"))
}

/// The 0.49 merge's `normalizedContent` comparison: lower case, runs of
/// white space as one space. The texts are normalized here rather than
/// trusting the stored hashes, which may be stale; a hash match with
/// different text is not a duplicate.
fn same_text(left: &Row, right: &Row) -> bool {
    let normalized = |row: &Row| normalized_hash(row.text("content").unwrap_or_default());
    normalized(left) == normalized(right)
}

/// The target's live memory with `row`'s category and hash, if any.
fn live_duplicate(
    conn: &Connection,
    table: &Table,
    row: &Row,
    to: &str,
) -> rusqlite::Result<Option<Row>> {
    let found = super::store::rows(
        conn,
        table,
        &format!(
            "level = 'project' AND owner_id = ? AND category = ? AND normalized_hash = ?
               AND id <> ? AND {LIVE} ORDER BY id LIMIT 1"
        ),
        &[
            Value::Text(to.to_owned()),
            row.get("category").clone(),
            row.get("normalized_hash").clone(),
            row.get("id").clone(),
        ],
    )?;
    Ok(found.into_iter().next())
}

/// The memories the 0.49 merge marked for review: no duplicate in the
/// target, but the target already has memories of that category. Decided
/// before anything changes, as the 0.49 merge's audit did.
pub(super) fn review(
    conn: &Connection,
    sources: &[Row],
    to: &str,
) -> rusqlite::Result<BTreeSet<i64>> {
    let table = memories_table(conn)?;
    let mut marked = BTreeSet::new();
    for row in sources {
        let duplicate = super::store::rows(
            conn,
            &table,
            "level = 'project' AND owner_id = ? AND category = ? AND normalized_hash = ? LIMIT 1",
            &[
                Value::Text(to.to_owned()),
                row.get("category").clone(),
                row.get("normalized_hash").clone(),
            ],
        )?;
        if duplicate.first().is_some_and(|found| same_text(found, row)) {
            continue;
        }
        let same_category: bool = conn
            .query_row(
                "SELECT 1 FROM memories WHERE level = 'project' AND owner_id = ?1 AND category = ?2 LIMIT 1",
                params![to, row.text("category")],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if same_category {
            if let Some(id) = row.int("id") {
                marked.insert(id);
            }
        }
    }
    Ok(marked)
}

/// The 0.49 plugin's `inheritMemorySafety`: one safety-critical source makes
/// the survivor safety-critical with at least importance 80; only sources
/// all assessed as not critical make it not critical; otherwise unknown.
fn inherit_safety(
    sources: [Option<i64>; 2],
    importance: Option<i64>,
) -> (Option<i64>, Option<i64>) {
    let safety = if sources.contains(&Some(1)) {
        Some(1)
    } else if sources.iter().all(|source| *source == Some(0)) {
        Some(0)
    } else {
        None
    };
    let importance = if safety == Some(1) {
        Some(importance.unwrap_or(50).max(80))
    } else {
        importance
    };
    (safety, importance)
}

/// `merged_from` in the module's form, a JSON array of ids, with `id`
/// added. A value the 0.49 plugin wrote (ids joined by commas) is read too.
fn merged_from_with(current: Option<&str>, id: i64) -> String {
    let mut ids: BTreeSet<i64> = BTreeSet::new();
    if let Some(current) = current.filter(|text| !text.trim().is_empty()) {
        match serde_json::from_str::<Vec<serde_json::Value>>(current) {
            Ok(values) => ids.extend(values.iter().filter_map(serde_json::Value::as_i64)),
            Err(_) => ids.extend(
                current
                    .split(',')
                    .filter_map(|part| part.trim().parse::<i64>().ok()),
            ),
        }
    }
    ids.insert(id);
    serde_json::to_string(&ids.into_iter().collect::<Vec<_>>()).expect("ids serialize")
}

/// The survivor of a collision takes `source`'s history: the 0.49 merge's
/// collision branch, minus archiving the source. `verifications_of` names
/// the memory whose verification rows the survivor takes, and
/// `absorbed` the id its `merged_from` records.
fn absorb(
    conn: &Connection,
    survivor: &Row,
    source: &Row,
    verifications_of: i64,
    absorbed: i64,
    now: i64,
) -> rusqlite::Result<()> {
    let target = survivor.int("id").expect("a memory has an id");
    let target_seen = survivor.int("seen_count").unwrap_or(1);
    let merged_seen = target_seen + source.int("seen_count").unwrap_or(1);
    let source_classified = source.int("classified_at").unwrap_or(0);
    let target_classified = survivor.int("classified_at").unwrap_or(0);
    let newer = source_classified > target_classified;
    let (safety, importance) = inherit_safety(
        [
            source.int("safety_critical"),
            survivor.int("safety_critical"),
        ],
        if newer {
            source.int("importance")
        } else {
            survivor.int("importance")
        },
    );
    if newer {
        // Importance, scope and shareable are the memory's scored meaning:
        // copying a newer classification that changes them is an edit, so
        // `updated_at` moves. The same scores under a newer stamp are not.
        let meaning_changed = survivor.int("importance") != importance
            || survivor.int("safety_critical") != safety
            || survivor.text("scope") != source.text("scope")
            || survivor.int("shareable").unwrap_or(0) != source.int("shareable").unwrap_or(0);
        conn.execute(
            "UPDATE memories SET scope = ?1, shareable = ?2, classified_at = ?3,
                    updated_at = CASE WHEN ?4 THEN ?5 ELSE updated_at END
              WHERE id = ?6",
            params![
                source.get("scope"),
                source.get("shareable"),
                source.get("classified_at"),
                meaning_changed,
                now,
                target
            ],
        )?;
    }
    conn.execute(
        "UPDATE memories SET safety_critical = ?1, importance = ?2 WHERE id = ?3",
        params![safety, importance, target],
    )?;
    let has_cue = |row: &Row| row.text("mural_cue").is_some_and(|cue| !cue.is_empty());
    if has_cue(source)
        && (!has_cue(survivor)
            || source.int("mural_cue_at").unwrap_or(0) > survivor.int("mural_cue_at").unwrap_or(0))
    {
        // A mural cue is a render cache of the text, so copying it is no edit.
        conn.execute(
            "UPDATE memories SET mural_cue = ?1, mural_cue_hash = ?2, mural_cue_at = ?3,
                    mural_cue_rejection_count = ?4
              WHERE id = ?5",
            params![
                source.get("mural_cue"),
                source.get("mural_cue_hash"),
                source.get("mural_cue_at"),
                source.get("mural_cue_rejection_count"),
                target
            ],
        )?;
    }
    conn.execute(
        "INSERT INTO memory_verifications (memory_id, file_path, verified_at, mapped_at, mapping_origin)
         SELECT ?1, file_path, verified_at, mapped_at, mapping_origin
           FROM memory_verifications WHERE memory_id = ?2
         ON CONFLICT(memory_id, file_path) DO UPDATE SET
             verified_at = MAX(memory_verifications.verified_at, excluded.verified_at),
             mapped_at = MAX(memory_verifications.mapped_at, excluded.mapped_at),
             mapping_origin = CASE
                 WHEN excluded.mapped_at >= memory_verifications.mapped_at
                     THEN excluded.mapping_origin
                 ELSE memory_verifications.mapping_origin
             END",
        params![target, verifications_of],
    )?;
    if merged_seen != target_seen || survivor.text("status").is_none() {
        // The seen count is bookkeeping. A survivor without a status becomes
        // active, which changes its meaning, so only then `updated_at` moves.
        // A permanent survivor stays permanent: the 0.49 merge set any
        // survivor of an active source to active, which would undo a
        // person's choice to keep a memory for good.
        conn.execute(
            "UPDATE memories
                SET seen_count = ?1,
                    status = CASE WHEN status = 'permanent' THEN status
                                  WHEN ?2 = 'active' THEN 'active'
                                  ELSE COALESCE(status, 'active') END,
                    updated_at = CASE
                        WHEN status IS NOT (CASE WHEN status = 'permanent' THEN status
                                                 WHEN ?2 = 'active' THEN 'active'
                                                 ELSE COALESCE(status, 'active') END)
                        THEN ?3 ELSE updated_at END
              WHERE id = ?4",
            params![merged_seen, source.text("status"), now, target],
        )?;
    }
    conn.execute(
        "UPDATE memories
            SET first_seen_at = MIN(first_seen_at, ?1), last_seen_at = MAX(last_seen_at, ?2),
                retrieval_count = COALESCE(retrieval_count, 0) + ?3, merged_from = ?4
          WHERE id = ?5",
        params![
            source.get("first_seen_at"),
            source.get("last_seen_at"),
            source.int("retrieval_count").unwrap_or(0),
            merged_from_with(survivor.text("merged_from"), absorbed),
            target
        ],
    )?;
    Ok(())
}

/// The metadata the 0.49 merge left on a memory to look at: the key it
/// came from, and for a hash it had to rename, the original hash.
fn mark_review(
    conn: &Connection,
    id: i64,
    from: &str,
    original_hash: Option<&str>,
) -> rusqlite::Result<()> {
    let base = "CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END";
    match original_hash {
        Some(hash) => conn.execute(
            &format!(
                "UPDATE memories SET metadata_json = json_set({base},
                     '$.identity_merge_original_hash', ?1, '$.identity_merge_review', ?2)
                  WHERE id = ?3"
            ),
            params![hash, from, id],
        ),
        None => conn.execute(
            &format!(
                "UPDATE memories SET metadata_json = json_set({base}, '$.identity_merge_review', ?1)
                  WHERE id = ?2"
            ),
            params![from, id],
        ),
    }?;
    Ok(())
}

/// A hash a colliding memory with different text takes, so it can live
/// beside the other: a stale or colliding hash is no reason to drop text.
fn conflict_hash(row: &Row, id: i64) -> String {
    format!(
        "{}:identity-conflict:{id}",
        row.text("normalized_hash").unwrap_or_default()
    )
}

/// Move every memory of `from` to `to`, the 0.49 merge's `mergeMemoryRow`.
/// Returns how many memories changed.
pub(super) fn move_all(conn: &Connection, from: &str, to: &str, now: i64) -> rusqlite::Result<u64> {
    let table = memories_table(conn)?;
    let sources = of(conn, from)?;
    let marked = review(conn, &sources, to)?;
    for source in &sources {
        let id = source.int("id").expect("a memory has an id");
        let mut flagged = marked.contains(&id);
        let duplicate = if is_live(source) {
            live_duplicate(conn, &table, source, to)?
        } else {
            None
        };
        match duplicate {
            Some(survivor) if same_text(&survivor, source) => {
                absorb(conn, &survivor, source, id, id, now)?;
                conn.execute(
                    "DELETE FROM memory_verifications WHERE memory_id = ?1",
                    [id],
                )?;
                let survivor_id = survivor.int("id").expect("a memory has an id");
                // Archived and pointing at the survivor, the duplicate is no
                // longer the live claim: that is an edit. It moves with the
                // rest, so the project's history keeps it.
                conn.execute(
                    "UPDATE memories
                        SET status = 'archived', superseded_by_memory_id = ?1, updated_at = ?2,
                            owner_id = ?3,
                            source_project_id = CASE WHEN source_project_id = ?4 THEN ?3
                                                     ELSE source_project_id END
                      WHERE id = ?5 AND level = 'project' AND owner_id = ?4",
                    params![survivor_id, now, to, from, id],
                )?;
                log(
                    conn,
                    from,
                    to,
                    "memories",
                    &id.to_string(),
                    "superseded",
                    Some(&survivor_id.to_string()),
                    now,
                )?;
                continue;
            }
            Some(_) => {
                conn.execute(
                    "UPDATE memories SET normalized_hash = ?1 WHERE id = ?2",
                    params![conflict_hash(source, id), id],
                )?;
                mark_review(conn, id, from, source.text("normalized_hash"))?;
                flagged = false;
            }
            None => {}
        }
        if flagged {
            mark_review(conn, id, from, None)?;
        }
        // Moving a memory to its project's new id doesn't change the
        // memory, so `updated_at` stays.
        conn.execute(
            "UPDATE memories
                SET owner_id = ?1,
                    source_project_id = CASE WHEN source_project_id = ?2 THEN ?1
                                             ELSE source_project_id END
              WHERE id = ?3 AND level = 'project' AND owner_id = ?2",
            params![to, from, id],
        )?;
        log(
            conn,
            from,
            to,
            "memories",
            &id.to_string(),
            "rekeyed",
            None,
            now,
        )?;
    }
    Ok(sources.len() as u64)
}

/// What copying a legacy key's memories to one more project made.
#[derive(Debug, Default)]
pub(super) struct Copied {
    /// Rows copied, per table.
    pub rows: BTreeMap<String, u64>,
    /// Each source memory's copy.
    pub ids: BTreeMap<i64, i64>,
}

/// Copy every memory of `from` to `to` as new rows, with the rows that hang
/// off them. Each source gets a copy, so every reference between the
/// sources can point at the copies: a copy that collides with a live memory
/// of `to` is made archived and superseded by it, and that memory absorbs
/// the source's history as on a move.
pub(super) fn copy_all(
    conn: &Connection,
    from: &str,
    to: &str,
    now: i64,
) -> rusqlite::Result<Copied> {
    let table = memories_table(conn)?;
    let sources = of(conn, from)?;
    let marked = review(conn, &sources, to)?;
    let mut copied = Copied::default();
    let mut kept_live = BTreeSet::new();
    let moved_source_project = |row: &Row| match row.text("source_project_id") {
        Some(project) if project == from => Value::Text(to.to_owned()),
        _ => row.get("source_project_id").clone(),
    };
    for source in &sources {
        let id = source.int("id").expect("a memory has an id");
        let mut overrides = vec![
            ("owner_id", Value::Text(to.to_owned())),
            ("source_project_id", moved_source_project(source)),
        ];
        let duplicate = if is_live(source) {
            live_duplicate(conn, &table, source, to)?
        } else {
            None
        };
        let mut review_hash = None;
        let mut flagged = marked.contains(&id);
        let survivor = match duplicate {
            Some(survivor) if same_text(&survivor, source) => {
                let survivor_id = survivor.int("id").expect("a memory has an id");
                overrides.push(("status", Value::Text("archived".into())));
                overrides.push(("superseded_by_memory_id", Value::Integer(survivor_id)));
                overrides.push(("updated_at", Value::Integer(now)));
                Some(survivor)
            }
            Some(_) => {
                overrides.push(("normalized_hash", Value::Text(conflict_hash(source, id))));
                review_hash = source.text("normalized_hash");
                flagged = false;
                None
            }
            None => None,
        };
        let copy: i64 = insert_copy(conn, &table, source, &overrides)?
            .parse()
            .expect("a memory copy has an integer id");
        match &survivor {
            Some(survivor) => absorb(conn, survivor, source, id, copy, now)?,
            None => {
                kept_live.insert(id);
            }
        }
        if review_hash.is_some() || flagged {
            mark_review(conn, copy, from, review_hash)?;
        }
        log(
            conn,
            from,
            to,
            "memories",
            &id.to_string(),
            "copied",
            Some(&copy.to_string()),
            now,
        )?;
        copied.ids.insert(id, copy);
    }
    *copied.rows.entry("memories".into()).or_default() += sources.len() as u64;
    // A copy points at the copies of the memories its source pointed at.
    for column in ["superseded_by_memory_id", "overrides_memory_id"] {
        for (old, new) in &copied.ids {
            conn.execute(
                &format!(
                    "UPDATE memories SET {column} = ?1
                      WHERE {column} = ?2 AND level = 'project' AND owner_id = ?3
                        AND id IN (SELECT value FROM json_each(?4))"
                ),
                params![
                    new,
                    old,
                    to,
                    serde_json::to_string(&copied.ids.values().collect::<Vec<_>>())
                        .expect("ids serialize")
                ],
            )?;
        }
    }
    for (name, column) in MEMORY_CHILDREN
        .iter()
        .copied()
        .chain([("memory_verifications", "memory_id")])
    {
        if !super::store::table_exists(conn, name)? {
            continue;
        }
        let child = shape(conn, name, column, None)?;
        for (old, new) in &copied.ids {
            // A copy that collided gave its verifications to the survivor.
            if name == "memory_verifications" && !kept_live.contains(old) {
                continue;
            }
            for row in super::store::rows(
                conn,
                &child,
                &format!("\"{column}\" = ?"),
                &[Value::Integer(*old)],
            )? {
                let key = super::store::row_key(&child, &row);
                let made = insert_copy(
                    conn,
                    &child,
                    &row,
                    &[(column_name(column), Value::Integer(*new))],
                )?;
                log(conn, from, to, name, &key, "copied", Some(&made), now)?;
                *copied.rows.entry(name.to_owned()).or_default() += 1;
            }
        }
    }
    for (name, left, right) in MEMORY_LINKS {
        if !super::store::table_exists(conn, name)? {
            continue;
        }
        let link = shape(conn, name, left, None)?;
        for (old, new) in &copied.ids {
            for row in super::store::rows(
                conn,
                &link,
                &format!("\"{left}\" = ?"),
                &[Value::Integer(*old)],
            )? {
                let Some(other) = row.int(right).and_then(|other| copied.ids.get(&other)) else {
                    continue;
                };
                let key = super::store::row_key(&link, &row);
                let made = insert_copy(
                    conn,
                    &link,
                    &row,
                    &[
                        (column_name(left), Value::Integer(*new)),
                        (column_name(right), Value::Integer(*other)),
                    ],
                )?;
                log(conn, from, to, name, &key, "copied", Some(&made), now)?;
                *copied.rows.entry((*name).to_owned()).or_default() += 1;
            }
        }
    }
    Ok(copied)
}

/// A child table's memory column as a `'static` override key.
fn column_name(column: &str) -> &'static str {
    [
        "memory_id",
        "source_id",
        "successor_id",
        "left_id",
        "right_id",
    ]
    .into_iter()
    .find(|known| *known == column)
    .expect("a memory reference column")
}
