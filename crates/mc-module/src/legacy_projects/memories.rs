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
use rusqlite::{params, Connection};

use super::store::{insert_copy, log, row_key, run, shape, table_exists, Row, Table};
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

/// The next `limit` memories of the project at a key, by id.
pub(super) fn batch(conn: &Connection, owner: &str, limit: usize) -> rusqlite::Result<Vec<Row>> {
    super::store::rows(
        conn,
        &memories_table(conn)?,
        "level = 'project' AND owner_id = ? ORDER BY id LIMIT ?",
        &[Value::Text(owner.to_owned()), Value::Integer(limit as i64)],
    )
}

/// What `to` held of its own before this pool reached it, which the 0.49
/// merge's review mark depends on: its memories that didn't come from
/// `from`, whatever earlier batches of this pool moved or copied there.
#[derive(Clone, Debug, Default)]
pub(super) struct Own {
    categories: BTreeSet<String>,
    /// The normalized text of one own memory per category and stored hash.
    texts: BTreeMap<(String, String), String>,
}

impl Own {
    pub(super) fn load(conn: &Connection, from: &str, to: &str) -> rusqlite::Result<Self> {
        let arrived: BTreeSet<i64> = conn
            .prepare_cached(
                "SELECT CASE WHEN action = 'copied' THEN CAST(target_row_id AS INTEGER)
                             ELSE CAST(row_id AS INTEGER) END
                   FROM identity_merge_log
                  WHERE from_identity = ?1 AND to_identity = ?2 AND table_name = 'memories'",
            )?
            .query_map(params![from, to], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let rows: Vec<(i64, String, String, String)> = conn
            .prepare_cached(
                "SELECT id, category, normalized_hash, content FROM memories
                  WHERE level = 'project' AND owner_id = ?1 ORDER BY id",
            )?
            .query_map([to], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut own = Self::default();
        for (id, category, hash, content) in rows {
            if arrived.contains(&id) {
                continue;
            }
            own.categories.insert(category.clone());
            own.texts
                .entry((category, hash))
                .or_insert_with(|| normalized_hash(&content));
        }
        Ok(own)
    }

    /// Whether the 0.49 plugin's project-id merge would mark `row` for
    /// review: the target had no memory with its text, but had memories of
    /// that category. As in 0.49, this is decided from the target's
    /// memories before any row of the pool changes.
    fn needs_review(&self, row: &Row) -> bool {
        let (Some(category), Some(hash)) = (row.text("category"), row.text("normalized_hash"))
        else {
            return false;
        };
        if !self.categories.contains(category) {
            return false;
        }
        let text = normalized_hash(row.text("content").unwrap_or_default());
        self.texts.get(&(category.to_owned(), hash.to_owned())) != Some(&text)
    }
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
        run(
            conn,
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
    run(
        conn,
        "UPDATE memories SET safety_critical = ?1, importance = ?2 WHERE id = ?3",
        params![safety, importance, target],
    )?;
    let has_cue = |row: &Row| row.text("mural_cue").is_some_and(|cue| !cue.is_empty());
    if has_cue(source)
        && (!has_cue(survivor)
            || source.int("mural_cue_at").unwrap_or(0) > survivor.int("mural_cue_at").unwrap_or(0))
    {
        // A mural cue is a render cache of the text, so copying it is no edit.
        run(
            conn,
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
    run(
        conn,
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
        run(
            conn,
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
    run(
        conn,
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
        Some(hash) => run(
            conn,
            &format!(
                "UPDATE memories SET metadata_json = json_set({base},
                     '$.identity_merge_original_hash', ?1, '$.identity_merge_review', ?2)
                  WHERE id = ?3"
            ),
            params![hash, from, id],
        ),
        None => run(
            conn,
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

/// Move `sources`, memories of `from`, to `to`: the 0.49 merge's
/// `mergeMemoryRow`. `own` is what `to` held before any memory of `from`
/// reached it, which decides the review mark.
pub(super) fn move_some(
    conn: &Connection,
    from: &str,
    to: &str,
    sources: &[Row],
    own: &Own,
    now: i64,
) -> rusqlite::Result<()> {
    let table = memories_table(conn)?;
    for source in sources {
        let id = source.int("id").expect("a memory has an id");
        let mut flagged = own.needs_review(source);
        let duplicate = if is_live(source) {
            live_duplicate(conn, &table, source, to)?
        } else {
            None
        };
        match duplicate {
            Some(survivor) if same_text(&survivor, source) => {
                absorb(conn, &survivor, source, id, id, now)?;
                run(
                    conn,
                    "DELETE FROM memory_verifications WHERE memory_id = ?1",
                    [id],
                )?;
                let survivor_id = survivor.int("id").expect("a memory has an id");
                // Archived and pointing at the survivor, the duplicate is no
                // longer the live claim: that is an edit. It moves with the
                // rest, so the project's history keeps it.
                run(
                    conn,
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
                run(
                    conn,
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
        run(
            conn,
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
    Ok(())
}

/// One memory copied, and the references its copy still carries from its
/// source: they name the source's memories until those have copies too.
pub(super) struct Made {
    source: i64,
    copy: i64,
    pointers: Vec<(&'static str, i64)>,
}

/// The columns by which one memory points at another.
const POINTERS: [&str; 2] = ["superseded_by_memory_id", "overrides_memory_id"];

/// Copy `sources`, memories of `from`, to `to` as new rows, with the rows
/// that hang off them. Every source gets a copy, so references between the
/// sources can point at the copies ([`Copies::record`]): a copy that
/// collides with a live memory of `to` is made archived and superseded by
/// it, and that memory absorbs the source's history as on a move. Returns the
/// rows copied per table, and each copy.
pub(super) fn copy_some(
    conn: &Connection,
    from: &str,
    to: &str,
    sources: &[Row],
    own: &Own,
    now: i64,
) -> rusqlite::Result<(BTreeMap<String, u64>, Vec<Made>)> {
    let table = memories_table(conn)?;
    let mut rows: BTreeMap<String, u64> = BTreeMap::new();
    let mut made = Vec::new();
    let children: Vec<(Table, &str)> = MEMORY_CHILDREN
        .iter()
        .copied()
        .chain([("memory_verifications", "memory_id")])
        .filter_map(|(name, column)| match table_exists(conn, name) {
            Ok(true) => Some(shape(conn, name, column, None).map(|child| (child, column))),
            Ok(false) => None,
            Err(error) => Some(Err(error)),
        })
        .collect::<rusqlite::Result<_>>()?;
    for source in sources {
        let id = source.int("id").expect("a memory has an id");
        let mut overrides = vec![
            ("owner_id", Value::Text(to.to_owned())),
            (
                "source_project_id",
                match source.text("source_project_id") {
                    Some(project) if project == from => Value::Text(to.to_owned()),
                    _ => source.get("source_project_id").clone(),
                },
            ),
        ];
        let mut flagged = own.needs_review(source);
        let duplicate = if is_live(source) {
            live_duplicate(conn, &table, source, to)?
        } else {
            None
        };
        let mut review_hash = None;
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
        if let Some(survivor) = &survivor {
            absorb(conn, survivor, source, id, copy, now)?;
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
        *rows.entry("memories".into()).or_default() += 1;
        made.push(Made {
            source: id,
            copy,
            // A copy superseded by the survivor already points where it should.
            pointers: POINTERS
                .into_iter()
                .filter(|column| !(survivor.is_some() && *column == POINTERS[0]))
                .filter_map(|column| source.int(column).map(|pointer| (column, pointer)))
                .collect(),
        });
        for (child, column) in &children {
            // A copy that collided gave its verifications to the survivor.
            if child.name == "memory_verifications" && survivor.is_some() {
                continue;
            }
            for row in super::store::rows(
                conn,
                child,
                &format!("\"{column}\" = ?"),
                &[Value::Integer(id)],
            )? {
                let key = row_key(child, &row);
                let made = insert_copy(conn, child, &row, &[(*column, Value::Integer(copy))])?;
                log(
                    conn,
                    from,
                    to,
                    &child.name,
                    &key,
                    "copied",
                    Some(&made),
                    now,
                )?;
                *rows.entry(child.name.clone()).or_default() += 1;
            }
        }
    }
    Ok((rows, made))
}

/// The copies of a key's memories made in one project so far, and the
/// references among them still waiting for the copy they should name. It
/// is read from the store once per round and kept up to date batch by
/// batch, so a batch costs the same however many copies came before it.
pub(super) struct Copies {
    /// Each copied source, with its copy.
    pub(super) map: BTreeMap<i64, i64>,
    /// A source not copied yet, with the copies (and columns) that point at it.
    waiting: BTreeMap<i64, Vec<(i64, &'static str)>>,
}

impl Copies {
    /// What the log and the copies say: the log records every copy, and
    /// a copy's reference still names a source until that source is copied.
    pub(super) fn load(conn: &Connection, from: &str, to: &str) -> rusqlite::Result<Self> {
        let map: BTreeMap<i64, i64> = conn
            .prepare_cached(
                "SELECT CAST(row_id AS INTEGER), CAST(target_row_id AS INTEGER)
                   FROM identity_merge_log
                  WHERE from_identity = ?1 AND to_identity = ?2 AND table_name = 'memories'
                    AND action = 'copied'",
            )?
            .query_map(params![from, to], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let made: BTreeSet<i64> = map.values().copied().collect();
        let pointing: Vec<(i64, Option<i64>, Option<i64>)> = conn
            .prepare_cached(
                "SELECT id, superseded_by_memory_id, overrides_memory_id FROM memories
                  WHERE level = 'project' AND owner_id = ?1
                    AND (superseded_by_memory_id IS NOT NULL OR overrides_memory_id IS NOT NULL)",
            )?
            .query_map([to], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut copies = Self {
            map,
            waiting: BTreeMap::new(),
        };
        for (id, superseded_by, overrides) in pointing {
            if !made.contains(&id) {
                continue;
            }
            for (column, pointer) in POINTERS.into_iter().zip([superseded_by, overrides]) {
                // A copy or a memory of `to` is where the reference should
                // be; anything else may still be a source to copy.
                if let Some(pointer) = pointer.filter(|pointer| !made.contains(pointer)) {
                    copies.point(conn, id, column, pointer)?;
                }
            }
        }
        Ok(copies)
    }

    /// Point `copy`'s `column` at the copy of `source`, or wait for it.
    fn point(
        &mut self,
        conn: &Connection,
        copy: i64,
        column: &'static str,
        source: i64,
    ) -> rusqlite::Result<()> {
        match self.map.get(&source) {
            Some(target) => {
                run(
                    conn,
                    &format!("UPDATE memories SET {column} = ?1 WHERE id = ?2"),
                    params![target, copy],
                )?;
            }
            None => self.waiting.entry(source).or_default().push((copy, column)),
        }
        Ok(())
    }

    /// Take in one batch's copies: each now names the copies of the sources
    /// its source named, and earlier copies waiting for one of these sources
    /// name its copy.
    pub(super) fn record(&mut self, conn: &Connection, made: &[Made]) -> rusqlite::Result<()> {
        for each in made {
            self.map.insert(each.source, each.copy);
        }
        for each in made {
            for (column, pointer) in &each.pointers {
                self.point(conn, each.copy, column, *pointer)?;
            }
        }
        for each in made {
            for (copy, column) in self.waiting.remove(&each.source).unwrap_or_default() {
                self.point(conn, copy, column, each.source)?;
            }
        }
        Ok(())
    }
}

/// Copy the links between two memories whose ends both have copies in `to`
/// now, for links that touch `batch`, the sources copied in this
/// transaction. Returns the links copied.
pub(super) fn copy_links(
    conn: &Connection,
    from: &str,
    to: &str,
    batch: &[i64],
    map: &BTreeMap<i64, i64>,
    now: i64,
) -> rusqlite::Result<BTreeMap<String, u64>> {
    let mut rows: BTreeMap<String, u64> = BTreeMap::new();
    let ids = serde_json::to_string(batch).expect("ids serialize");
    for (name, left, right) in MEMORY_LINKS {
        if !table_exists(conn, name)? {
            continue;
        }
        let link = shape(conn, name, left, None)?;
        let candidates = super::store::rows(
            conn,
            &link,
            &format!(
                "\"{left}\" IN (SELECT value FROM json_each(?1))
                 OR \"{right}\" IN (SELECT value FROM json_each(?1))"
            ),
            &[Value::Text(ids.clone())],
        )?;
        for row in candidates {
            let (Some(new_left), Some(new_right)) = (
                row.int(left).and_then(|old| map.get(&old)),
                row.int(right).and_then(|old| map.get(&old)),
            ) else {
                continue;
            };
            let exists = conn
                .prepare_cached(&format!(
                    "SELECT 1 FROM {name} WHERE \"{left}\" = ?1 AND \"{right}\" = ?2"
                ))?
                .exists(params![new_left, new_right])?;
            if exists {
                continue;
            }
            let key = row_key(&link, &row);
            let made = insert_copy(
                conn,
                &link,
                &row,
                &[
                    (*left, Value::Integer(*new_left)),
                    (*right, Value::Integer(*new_right)),
                ],
            )?;
            log(conn, from, to, name, &key, "copied", Some(&made), now)?;
            *rows.entry((*name).to_owned()).or_default() += 1;
        }
    }
    Ok(rows)
}
