//! The memory mural: an image of the project memories that did not fit the
//! history head's memory budget, as the plugin's `mural/` builds it. Each
//! memory shows as its compressed cue (a few tokens written by a background
//! model task and stored on the memory row), under category banners.
//!
//! Which memories, in what order (`resolve-mural.ts`):
//! - the memories the head's budget trim left out, so the mural shows exactly
//!   what the text block could not;
//! - only those whose stored cue was written from the memory's current text
//!   (the cue's hash equals the SHA-256 of the content); a memory edited since
//!   waits for a new cue;
//! - ordered by category, then importance (highest first), then id, so a new
//!   memory never reshuffles the others in its band.
//!
//! A mural is drawn only when enough of the project's memories have current
//! cues: at least 15, or at least half of them (`muralCoverageGate`).
//!
//! The rendered PNG is stored per project in `mural_manifest`, keyed by the
//! layout text's checksum, which the plugin uses too: when the layout is
//! unchanged, the stored image is used as it is, whichever side drew it, so
//! both serve the same bytes for the same mural.

pub mod font;
pub mod render;

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::context_db::StoredMemory;
pub use render::Entry;

/// The fewest current cues that make a mural worth drawing, or the share of
/// the project's memories (`MIN_MURAL_CUED_MEMORIES`, `MIN_MURAL_COVERAGE`).
const MIN_CUED: usize = 15;
const MIN_COVERAGE: f64 = 0.5;
/// What `mural_manifest.model` records for a render no model made.
const DETERMINISTIC_MODEL: &str = "deterministic";

/// The text the history head shows before the mural image
/// (`MEMORY_MURAL_BLOCK`).
pub const BLOCK: &str = "<memory-mural>\nThe project memory mural image follows.\nThe memory mural image lists project memories that did not fit `<project-memory>`, as compressed cues under category banners. A red cue is a prohibition (`⊘thing (reason)`), `→` means leads to. Run `ctx_search` with a cue's identifiers to recall the full memory.\n</memory-mural>";

/// Category order on the mural: the five current categories, then the older
/// ones the plugin still recognises; anything else goes last.
const CATEGORY_ORDER: [&str; 12] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
    "USER_DIRECTIVES",
    "USER_PREFERENCES",
    "CONFIG_DEFAULTS",
    "ARCHITECTURE_DECISIONS",
    "ENVIRONMENT",
    "WORKFLOW_RULES",
    "KNOWN_ISSUES",
];

/// A memory's stored cue and the hash of the text it was written from.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Cue {
    pub text: Option<String>,
    pub hash: Option<String>,
}

/// A drawn mural.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mural {
    pub png: Vec<u8>,
    /// SHA-256 of the layout text: the mural's identity.
    pub content_hash: String,
    pub width: usize,
    pub height: usize,
    /// The memories it shows.
    pub memory_ids: Vec<i64>,
}

/// The hash a cue must carry to count as current for `content`
/// (`computeCueContentHash`: SHA-256 of the raw text, so any edit counts).
pub fn content_hash(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn current(cue: Option<&Cue>, content: &str) -> bool {
    matches!(cue, Some(Cue { text: Some(_), hash: Some(hash) }) if *hash == content_hash(content))
}

/// Whether enough of `memories` have current, non-blank cues.
pub fn coverage_ok(memories: &[StoredMemory], cues: &HashMap<i64, Cue>) -> bool {
    let cued = memories
        .iter()
        .filter(|memory| {
            let cue = cues.get(&memory.id);
            current(cue, &memory.content)
                && cue
                    .and_then(|cue| cue.text.as_deref())
                    .is_some_and(|text| !text.trim().is_empty())
        })
        .count();
    !memories.is_empty()
        && (cued >= MIN_CUED || cued as f64 >= MIN_COVERAGE * memories.len() as f64)
}

/// The mural's entries: the memories `budget_tokens` leaves out of the head,
/// with current cues, in mural order.
pub fn entries(
    memories: &[StoredMemory],
    cues: &HashMap<i64, Cue>,
    budget_tokens: u64,
    counter: crate::count::Counter,
) -> Vec<Entry> {
    let shown: HashSet<i64> =
        crate::memory::trim_to_budget(memories.to_vec(), budget_tokens, counter)
            .iter()
            .map(|memory| memory.id)
            .collect();
    let mut entries: Vec<Entry> = memories
        .iter()
        .filter(|memory| !shown.contains(&memory.id))
        .filter_map(|memory| {
            let cue = cues.get(&memory.id);
            if !current(cue, &memory.content) {
                return None;
            }
            Some(Entry {
                id: memory.id,
                category: memory.category.clone(),
                importance: memory.importance.unwrap_or(50),
                cue: cue?.text.clone()?,
            })
        })
        .collect();
    let rank = |category: &str| {
        CATEGORY_ORDER
            .iter()
            .position(|known| *known == category)
            .unwrap_or(99)
    };
    entries.sort_by(|left, right| {
        rank(&left.category)
            .cmp(&rank(&right.category))
            .then(right.importance.cmp(&left.importance))
            .then(left.id.cmp(&right.id))
    });
    entries
}

/// The stored cues of `ids`.
pub fn read_cues(conn: &Connection, ids: &[i64]) -> rusqlite::Result<HashMap<i64, Cue>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let list = serde_json::to_string(ids).expect("ids serialize");
    let mut statement = conn.prepare_cached(
        "SELECT id, mural_cue, mural_cue_hash FROM memories WHERE id IN (SELECT value FROM json_each(?1))",
    )?;
    let rows = statement.query_map(params![list], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            Cue {
                text: row.get(1)?,
                hash: row.get(2)?,
            },
        ))
    })?;
    rows.collect()
}

/// The project's mural for `memories` (the same rows the head's memory block
/// was built from) and the head's memory budget, or `None` when there is
/// nothing to draw or too few cues. An unchanged layout reuses the stored
/// image; a new one is drawn and stored.
pub fn ensure(
    conn: &Connection,
    project: &str,
    memories: &[StoredMemory],
    budget_tokens: u64,
    now_ms: i64,
    counter: crate::count::Counter,
) -> rusqlite::Result<Option<Mural>> {
    let ids: Vec<i64> = memories.iter().map(|memory| memory.id).collect();
    let cues = read_cues(conn, &ids)?;
    if !coverage_ok(memories, &cues) {
        return Ok(None);
    }
    let entries = entries(memories, &cues, budget_tokens, counter);
    if entries.is_empty() {
        return Ok(None);
    }
    let plan = render::plan(&entries);
    let hash = content_hash(&plan.text);
    let stored: Option<(Vec<u8>, String, i64, i64)> = conn
        .query_row(
            "SELECT image, content_hash, width, height FROM mural_manifest WHERE project_path = ?1",
            params![project],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if let Some((png, stored_hash, width, height)) = stored {
        if stored_hash == hash && width as usize == plan.width && height as usize == plan.height {
            return Ok(Some(Mural {
                png,
                content_hash: hash,
                width: plan.width,
                height: plan.height,
                memory_ids: plan.rendered_ids,
            }));
        }
    }
    let png = render::encode_png(&render::raster(&plan), plan.width, plan.height);
    conn.execute(
        "INSERT INTO mural_manifest (project_path, image, content_hash, rendered_at, model, memory_ids_json, width, height)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(project_path) DO UPDATE SET
             image = excluded.image, content_hash = excluded.content_hash,
             rendered_at = excluded.rendered_at, model = excluded.model,
             memory_ids_json = excluded.memory_ids_json,
             width = excluded.width, height = excluded.height",
        params![
            project,
            png,
            hash,
            now_ms,
            DETERMINISTIC_MODEL,
            serde_json::to_string(&plan.rendered_ids).expect("ids serialize"),
            plan.width as i64,
            plan.height as i64
        ],
    )?;
    Ok(Some(Mural {
        png,
        content_hash: hash,
        width: plan.width,
        height: plan.height,
        memory_ids: plan.rendered_ids,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_db::ContextDb;

    fn memory(id: i64, category: &str, importance: i32, content: &str) -> StoredMemory {
        StoredMemory {
            id,
            project_path: "pj-mural".into(),
            category: category.into(),
            content: content.into(),
            importance: Some(importance),
            status: "active".into(),
            ..StoredMemory::default()
        }
    }

    fn cued(memory: &StoredMemory, cue: &str) -> (i64, Cue) {
        (
            memory.id,
            Cue {
                text: Some(cue.into()),
                hash: Some(content_hash(&memory.content)),
            },
        )
    }

    #[test]
    fn the_mural_shows_what_the_budget_left_out_with_current_cues_in_band_order() {
        let long = "x ".repeat(400);
        let memories = vec![
            memory(1, "NAMING", 90, "kept: the most important"),
            memory(2, "ARCHITECTURE", 10, &format!("left out {long}")),
            memory(3, "PROJECT_RULES", 20, &format!("left out too {long}")),
            memory(
                4,
                "PROJECT_RULES",
                30,
                &format!("edited since its cue {long}"),
            ),
            memory(5, "PROJECT_RULES", 20, &format!("no cue yet {long}")),
        ];
        let mut cues: HashMap<i64, Cue> = [
            cued(&memories[0], "kept"),
            cued(&memories[1], "arch cue"),
            cued(&memories[2], "rule cue"),
        ]
        .into_iter()
        .collect();
        cues.insert(
            4,
            Cue {
                text: Some("stale".into()),
                hash: Some(content_hash("the old text")),
            },
        );
        // A budget that fits only the first memory's line.
        let entries = entries(&memories, &cues, 60, crate::count::Counter::for_model(None));
        let shown: Vec<(i64, &str)> = entries
            .iter()
            .map(|entry| (entry.id, entry.cue.as_str()))
            .collect();
        assert_eq!(shown, [(3, "rule cue"), (2, "arch cue")]);
    }

    #[test]
    fn a_mural_needs_fifteen_cues_or_half_the_memories() {
        let memories: Vec<StoredMemory> = (1..=40)
            .map(|id| memory(id, "NAMING", 50, &format!("memory {id}")))
            .collect();
        let cues_for = |count: usize| -> HashMap<i64, Cue> {
            memories
                .iter()
                .take(count)
                .map(|memory| cued(memory, "cue"))
                .collect()
        };
        assert!(!coverage_ok(&memories, &cues_for(14)));
        assert!(coverage_ok(&memories, &cues_for(15)));
        let few = &memories[..10];
        assert!(!coverage_ok(few, &cues_for(4)));
        assert!(coverage_ok(few, &cues_for(5)));
        assert!(!coverage_ok(&[], &HashMap::new()));
    }

    #[test]
    fn an_unchanged_mural_reuses_the_stored_image_and_a_changed_one_is_redrawn() {
        let dir = std::env::temp_dir().join(format!("ck-mc-mural-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
        let long = "y ".repeat(300);
        let mut memories = Vec::new();
        for id in 1..=20 {
            let content = format!("memory {id} {long}");
            db.with_connection(|conn| {
                conn.execute(
                    "INSERT INTO memories (id, project_path, category, content, normalized_hash, status, importance,
                     first_seen_at, created_at, updated_at, last_seen_at, mural_cue, mural_cue_hash)
                     VALUES (?1, 'pj-mural', 'NAMING', ?2, ?3, 'active', 50, 1, 1, 1, 1, ?4, ?5)",
                    params![id, content, format!("h{id}"), format!("cue {id}"), content_hash(&content)],
                )
                .unwrap()
            });
            memories.push(memory(id, "NAMING", 50, &content));
        }
        let first = db
            .with_connection(|conn| {
                ensure(
                    conn,
                    "pj-mural",
                    &memories,
                    200,
                    1,
                    crate::count::Counter::for_model(None),
                )
            })
            .unwrap()
            .expect("a mural");
        // The plugin's stored image for the same layout is served as it is.
        let marker = vec![1u8, 2, 3];
        db.with_connection(|conn| {
            conn.execute("UPDATE mural_manifest SET image = ?1", params![marker])
                .unwrap()
        });
        let again = db
            .with_connection(|conn| {
                ensure(
                    conn,
                    "pj-mural",
                    &memories,
                    200,
                    2,
                    crate::count::Counter::for_model(None),
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(again.png, marker);
        assert_eq!(again.content_hash, first.content_hash);
        // A changed cue changes the layout: drawn and stored again.
        db.with_connection(|conn| {
            conn.execute(
                "UPDATE memories SET mural_cue = 'a new cue' WHERE id = 20",
                [],
            )
            .unwrap()
        });
        let redrawn = db
            .with_connection(|conn| {
                ensure(
                    conn,
                    "pj-mural",
                    &memories,
                    200,
                    3,
                    crate::count::Counter::for_model(None),
                )
            })
            .unwrap()
            .unwrap();
        assert_ne!(redrawn.content_hash, first.content_hash);
        assert_eq!(&redrawn.png[1..4], b"PNG");
        let stored: Vec<u8> = db.with_connection(|conn| {
            conn.query_row("SELECT image FROM mural_manifest", [], |row| row.get(0))
                .unwrap()
        });
        assert_eq!(stored, redrawn.png);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
