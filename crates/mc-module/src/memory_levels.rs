//! The level record of each new memory: the row in
//! `memory_placement` that says a memory belongs to a project, which profile
//! wrote it and under which category id. Written in the same transaction as
//! the memory row, followed by the memory's sync record when it is a create.
//! Ported from the memory-levels card
//! (`crates/mc-store/src/memory_levels/placement.rs` at `75adf757`).

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::memory_profile::MemoryContext;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Owner {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OriginProfile {
    pub name: String,
    pub version: String,
    pub digest: String,
}

/// What a session's writes record about who wrote a memory, taken from its
/// memory context once. `None` when the context has no category map: an old
/// or degraded context, whose writes stay unplaced rather than guessed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authority {
    pub project_id: Option<String>,
    pub profile: Option<OriginProfile>,
    pub state: String,
    pub snapshot_digest: Option<String>,
    pub category_ids: BTreeMap<String, String>,
}

impl Authority {
    pub(crate) fn from_context(context: &MemoryContext) -> Option<Self> {
        let category_ids = context.category_ids.clone()?;
        let pin = &context.profile;
        let state = pin.state.clone();
        // Only a chosen profile names the writer; a refused choice does not.
        let profile = matches!(state.as_str(), "resolved" | "entorhinal_not_answering")
            .then(|| {
                Some(OriginProfile {
                    name: pin.name.clone()?,
                    version: pin.version.clone()?,
                    digest: pin.digest.clone()?,
                })
            })
            .flatten();
        Some(Self {
            project_id: context.project_id.clone(),
            profile,
            state,
            snapshot_digest: context.snapshot_digest.clone(),
            category_ids,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CreateKind {
    /// A memory nobody had written before.
    Create,
    /// The row a merge or a replacement leaves; never synced.
    MergeSurvivor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Actor {
    MainAgent,
    Historian,
}

/// One new memory row, as its level record and sync record need it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateEvent {
    pub kind: CreateKind,
    pub actor: Actor,
    pub session_id: Option<String>,
    /// The message ordinals the memory came from, as inclusive ranges.
    pub ordinals: Vec<(u64, u64)>,
    pub memory_id: i64,
    pub writer_project_id: Option<String>,
    pub owner: Option<Owner>,
    pub category_tag: String,
    pub effective_category_id: Option<String>,
    pub importance: Option<i64>,
    pub expires_at: Option<i64>,
    pub content: String,
    pub origin_profile: Option<OriginProfile>,
    pub snapshot_digest: Option<String>,
}

/// Who writes new memories, and from which messages.
#[derive(Debug, Clone, Copy)]
pub struct Placer<'a> {
    pub authority: Option<&'a Authority>,
    pub actor: Actor,
    pub session: Option<&'a str>,
    pub ordinals: &'a [(u64, u64)],
}

impl Placer<'_> {
    /// A writer with no memory context: its memories stay unplaced.
    pub fn unplaced() -> Self {
        Self {
            authority: None,
            actor: Actor::Historian,
            session: None,
            ordinals: &[],
        }
    }
}

fn refuse(code: &str) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(code.to_owned())))
}

/// The refusal code [`merge_owner`] fails with, when its error carries one.
pub fn refusal_code(error: &rusqlite::Error) -> Option<String> {
    match error {
        rusqlite::Error::ToSqlConversionFailure(inner) => Some(inner.to_string()),
        _ => None,
    }
}

/// A memory's level record, if it has one. A record whose memory row is gone
/// is not returned.
pub fn placement_owner(conn: &Connection, id: i64) -> rusqlite::Result<Option<Owner>> {
    conn.query_row(
        "SELECT p.owner_kind, p.owner_id FROM memory_placement p JOIN memories m ON m.id = p.memory_id
         WHERE p.memory_id = ?1",
        [id],
        |row| {
            Ok(Owner {
                kind: row.get(0)?,
                id: row.get(1)?,
            })
        },
    )
    .optional()
}

/// The owner every source of a merge shares, resolved before any of them
/// changes. An unplaced source belongs to the writer's project only when its
/// row does; otherwise it has no owner, which never matches a placed one.
/// Sources that disagree refuse as `merge_owner_mismatch`.
pub fn merge_owner(
    conn: &Connection,
    ids: &[i64],
    project: &str,
    authority: Option<&Authority>,
) -> rusqlite::Result<Option<Owner>> {
    let mut shared: Option<Option<Owner>> = None;
    for id in ids {
        let owner = match placement_owner(conn, *id)? {
            Some(owner) => Some(owner),
            None => {
                let path: String = conn.query_row(
                    "SELECT project_path FROM memories WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )?;
                authority
                    .and_then(|authority| authority.project_id.as_ref())
                    .filter(|_| path == project)
                    .map(|id| Owner {
                        kind: "project".into(),
                        id: id.clone(),
                    })
            }
        };
        match &shared {
            Some(prior) if prior != &owner => return Err(refuse("merge_owner_mismatch")),
            Some(_) => {}
            None => shared = Some(owner),
        }
    }
    Ok(shared.flatten())
}

/// Record a new memory row: its level record, then, for a create, its sync
/// record. Call it inside the transaction that inserted the row,
/// right after the insert. Without an authority or a project id the row stays
/// unplaced and unsynced, and the write still succeeds.
pub fn created(
    tx: &Connection,
    placer: &Placer,
    id: i64,
    kind: CreateKind,
    owner: Option<&Owner>,
    now: i64,
) -> rusqlite::Result<()> {
    if tx.is_autocommit() {
        return Err(refuse("memory create requires a transaction"));
    }
    let (category, content, importance, expires_at): (String, String, Option<i64>, Option<i64>) =
        tx.query_row(
            "SELECT category, content, importance, expires_at FROM memories WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    let mut event = CreateEvent {
        kind,
        actor: placer.actor,
        session_id: placer.session.map(str::to_owned),
        ordinals: placer.ordinals.to_vec(),
        memory_id: id,
        writer_project_id: None,
        owner: None,
        category_tag: category,
        effective_category_id: None,
        importance,
        expires_at,
        content,
        origin_profile: None,
        snapshot_digest: None,
    };
    if let Some((authority, project_id)) = placer
        .authority
        .and_then(|authority| Some((authority, authority.project_id.as_ref()?)))
    {
        let owner = owner.cloned().unwrap_or_else(|| Owner {
            kind: "project".into(),
            id: project_id.clone(),
        });
        if owner.kind != "project" {
            return Err(refuse("level_unavailable"));
        }
        let origin = authority.profile.clone();
        let category_id = origin
            .as_ref()
            .and_then(|_| authority.category_ids.get(&event.category_tag))
            .cloned();
        tx.execute(
            "INSERT INTO memory_placement(memory_id, level, owner_kind, owner_id, origin_profile_name,
                 origin_profile_version, origin_profile_digest, origin_category, written_at)
             VALUES (?1, 'project', ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                owner.kind,
                owner.id,
                origin.as_ref().map(|profile| &profile.name),
                origin.as_ref().map(|profile| &profile.version),
                origin.as_ref().map(|profile| &profile.digest),
                category_id,
                now
            ],
        )?;
        event.writer_project_id = Some(project_id.clone());
        event.owner = Some(owner);
        event.effective_category_id = category_id;
        event.origin_profile = origin;
        event.snapshot_digest = authority.snapshot_digest.clone();
    }
    crate::memory_sync::queue(tx, &event, now)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::context_db::ContextDb;
    use crate::memory_context::ContextAnswer;
    use crate::memory_writes::{self, Change, Operation, Writer};

    fn database(name: &str) -> ContextDb {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "ck-mc-levels-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        ContextDb::create_for_tests(&dir.join("context.db")).unwrap()
    }

    /// A context as Entorhinal's answer for a project with no domain gives
    /// it: the bundled software profile.
    fn context() -> MemoryContext {
        let records: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../testdata/entorhinal-memory-context-v1/context-project.json"
        ))
        .unwrap();
        let mut result = records[0]["reply"]["result"].clone();
        result["domain"] = serde_json::Value::Null;
        let project = serde_json::from_value(result).unwrap();
        crate::memory_profile::resolve(
            &ContextAnswer::Answer(project),
            &ContextAnswer::NotAnswering,
            &[],
        )
    }

    fn placement(
        db: &ContextDb,
        id: i64,
    ) -> Option<(String, String, Option<String>, Option<String>)> {
        db.with_connection(|conn| {
            conn.query_row(
                "SELECT owner_kind, owner_id, origin_profile_name, origin_category FROM memory_placement
                 WHERE memory_id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .unwrap()
        })
    }

    #[test]
    fn a_saved_memory_is_placed_at_its_project() {
        let db = database("save");
        let context = context();
        let authority = Authority::from_context(&context).unwrap();
        let project_id = authority.project_id.clone().unwrap();
        let who = Writer {
            harness: "opencode",
            session: "s1",
            project: "pj-a",
            authority: Some(&authority),
        };
        let receipt = db
            .with_connection(|conn| memory_writes::save(conn, &who, "NAMING", "Call it the head."))
            .unwrap();
        let id = receipt.memory_id.unwrap();
        assert_eq!(
            placement(&db, id),
            Some((
                "project".into(),
                project_id,
                Some("@cortexkit/memory-swe".into()),
                Some("swe:naming".into())
            ))
        );
        // Saving the same text again only bumps the seen count.
        db.with_connection(|conn| memory_writes::save(conn, &who, "NAMING", "Call it the head."))
            .unwrap();
        let rows: i64 = db.with_connection(|conn| {
            conn.query_row("SELECT count(*) FROM memory_placement", [], |row| {
                row.get(0)
            })
            .unwrap()
        });
        assert_eq!(rows, 1);
    }

    #[test]
    fn without_a_context_a_memory_stays_unplaced() {
        let db = database("unplaced");
        let who = Writer {
            harness: "opencode",
            session: "s1",
            project: "pj-a",
            authority: None,
        };
        let receipt = db
            .with_connection(|conn| memory_writes::save(conn, &who, "NAMING", "No owner."))
            .unwrap();
        assert!(receipt.applied);
        assert_eq!(placement(&db, receipt.memory_id.unwrap()), None);
    }

    #[test]
    fn a_merge_of_differently_owned_memories_is_refused() {
        let db = database("merge");
        let authority = Authority::from_context(&context()).unwrap();
        let who = Writer {
            harness: "opencode",
            session: "s1",
            project: "pj-a",
            authority: Some(&authority),
        };
        let first = db
            .with_connection(|conn| memory_writes::save(conn, &who, "NAMING", "First name."))
            .unwrap()
            .memory_id
            .unwrap();
        let second = db
            .with_connection(|conn| memory_writes::save(conn, &who, "NAMING", "Second name."))
            .unwrap()
            .memory_id
            .unwrap();
        // The second memory belongs to another project's owner.
        db.with_connection(|conn| {
            conn.execute(
                "UPDATE memory_placement SET owner_id = 'pj-other' WHERE memory_id = ?1",
                [second],
            )
        })
        .unwrap();
        let change = Change {
            operation: Operation::Merge,
            targets: &[(first, 1), (second, 1)],
            content: Some("One name."),
            category: None,
            reason: None,
        };
        let result = db.with_connection(|conn| memory_writes::mutate(conn, &who, &change));
        assert!(
            matches!(
                result,
                Err(memory_writes::MutationError::Refused(memory_writes::Refused::Pending(ref reason)))
                    if reason == "merge_owner_mismatch"
            ),
            "{result:?}"
        );
        let archived: i64 = db.with_connection(|conn| {
            conn.query_row(
                "SELECT count(*) FROM memories WHERE status = 'archived'",
                [],
                |row| row.get(0),
            )
            .unwrap()
        });
        assert_eq!(archived, 0, "a refused merge changes nothing");
        // Sources that share an owner merge, and the survivor takes it.
        db.with_connection(|conn| {
            conn.execute(
                "UPDATE memory_placement SET owner_id = (SELECT owner_id FROM memory_placement WHERE memory_id = ?1)
                 WHERE memory_id = ?2",
                [first, second],
            )
        })
        .unwrap();
        let receipt = db
            .with_connection(|conn| memory_writes::mutate(conn, &who, &change))
            .unwrap();
        let survivor = receipt.memory_id.unwrap();
        assert_eq!(
            placement(&db, survivor).map(|(_, owner, _, _)| owner),
            authority.project_id.clone()
        );
    }

    #[test]
    fn a_refused_profile_names_no_writer() {
        let mut context = context();
        context.profile.state = "conflict".into();
        let authority = Authority::from_context(&context).unwrap();
        assert!(authority.profile.is_none());
        // A context without a category map leaves writes unplaced.
        context.category_ids = None;
        assert!(Authority::from_context(&context).is_none());
    }
}
