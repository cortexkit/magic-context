//! Who a new memory belongs to and who wrote it: its level and owner, the
//! profile category id of the tag it was written under, and the profile that
//! wrote it. They are columns of the memory row itself (migration 106 folded
//! the old `memory_placement` sidecar into it); this module decides them and
//! queues the memory's sync record after a create.

use std::collections::BTreeMap;

use rusqlite::Connection;
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

/// The refusal code a write here fails with, when its error carries one.
pub fn refusal_code(error: &rusqlite::Error) -> Option<String> {
    match error {
        rusqlite::Error::ToSqlConversionFailure(inner) => Some(inner.to_string()),
        _ => None,
    }
}

/// The profile category id of a tag: what the writer's profile maps it to,
/// or, for a writer with no memory context, the coding profile's map as the
/// schema migration froze it. A tag no map knows is `mc:unmapped`.
pub fn category_id(tag: &str, authority: Option<&Authority>) -> String {
    authority
        .and_then(|authority| authority.category_ids.get(tag))
        .cloned()
        .unwrap_or_else(|| crate::context_migrations::frozen_category_id(tag).to_owned())
}

/// A memory's level and owner.
pub fn owner_of(conn: &Connection, id: i64) -> rusqlite::Result<Owner> {
    conn.query_row(
        "SELECT level, owner_id FROM memories WHERE id = ?1",
        [id],
        |row| {
            Ok(Owner {
                kind: row.get(0)?,
                id: row.get(1)?,
            })
        },
    )
}

/// The owner every source of a merge shares, resolved before any of them
/// changes. Sources that disagree refuse as `merge_owner_mismatch`.
pub fn merge_owner(conn: &Connection, ids: &[i64]) -> rusqlite::Result<Option<Owner>> {
    let mut shared: Option<Owner> = None;
    for id in ids {
        let owner = owner_of(conn, *id)?;
        match &shared {
            Some(prior) if prior != &owner => return Err(refuse("merge_owner_mismatch")),
            Some(_) => {}
            None => shared = Some(owner),
        }
    }
    Ok(shared)
}

/// The level and writer columns of a new memory, decided before the insert.
/// Only the project level is writable yet: anything else refuses as
/// `level_unavailable`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewRow {
    pub level: String,
    pub owner_id: String,
    pub category_id: String,
    pub origin_profile: Option<OriginProfile>,
    pub source_ordinals_json: Option<String>,
}

impl NewRow {
    pub fn decide(
        placer: &Placer,
        project: &str,
        owner: Option<&Owner>,
        tag: &str,
    ) -> rusqlite::Result<Self> {
        let owner = owner.cloned().unwrap_or_else(|| Owner {
            kind: "project".into(),
            id: project.to_owned(),
        });
        if owner.kind != "project" {
            return Err(refuse("level_unavailable"));
        }
        let ordinals = (!placer.ordinals.is_empty()).then(|| {
            serde_json::to_string(
                &placer
                    .ordinals
                    .iter()
                    .map(|(start, end)| [*start, *end])
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_default()
        });
        Ok(Self {
            level: owner.kind,
            owner_id: owner.id,
            category_id: category_id(tag, placer.authority),
            origin_profile: placer
                .authority
                .and_then(|authority| authority.profile.clone()),
            source_ordinals_json: ordinals,
        })
    }
}

/// Queue a new memory's sync record. Call it inside the transaction that
/// inserted the row, right after the insert. Without an authority or a
/// project id the memory stays unsynced, and the write still succeeds.
pub fn created(
    tx: &Connection,
    placer: &Placer,
    id: i64,
    kind: CreateKind,
    now: i64,
) -> rusqlite::Result<()> {
    if tx.is_autocommit() {
        return Err(refuse("memory create requires a transaction"));
    }
    type Row = (
        String,
        String,
        String,
        String,
        String,
        Option<i64>,
        Option<i64>,
    );
    let (level, owner_id, category_id, category, content, importance, expires_at): Row = tx
        .query_row(
            "SELECT level, owner_id, category, origin_category, content, importance, expires_at
               FROM memories WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
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
        let origin = authority.profile.clone();
        event.writer_project_id = Some(project_id.clone());
        event.owner = Some(Owner {
            kind: level,
            id: owner_id,
        });
        // A category id counts as the writer's only when a resolved profile
        // gave it.
        event.effective_category_id = origin.as_ref().map(|_| category_id);
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

    /// Where a memory is filed: its level, owner, writing profile and
    /// category id.
    fn placement(db: &ContextDb, id: i64) -> (String, String, Option<String>, String) {
        db.with_connection(|conn| {
            conn.query_row(
                "SELECT level, owner_id, origin_profile, category FROM memories WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
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
        // The row belongs to the writer's project path; the project id the
        // memory context names travels in the sync record.
        assert_ne!(project_id, "pj-a");
        assert_eq!(
            placement(&db, id),
            (
                "project".into(),
                "pj-a".into(),
                Some("@cortexkit/memory-swe".into()),
                "swe:naming".into()
            )
        );
        // Saving the same text again only bumps the seen count.
        db.with_connection(|conn| memory_writes::save(conn, &who, "NAMING", "Call it the head."))
            .unwrap();
        let rows: i64 = db.with_connection(|conn| {
            conn.query_row("SELECT count(*) FROM memories", [], |row| row.get(0))
                .unwrap()
        });
        assert_eq!(rows, 1);
    }

    /// A writer with no memory context still files its memory at its
    /// project, under the frozen category map, naming no profile.
    #[test]
    fn without_a_context_a_memory_names_no_profile() {
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
        assert_eq!(
            placement(&db, receipt.memory_id.unwrap()),
            ("project".into(), "pj-a".into(), None, "swe:naming".into())
        );
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
        // The second memory is at another level.
        db.with_connection(|conn| {
            conn.execute(
                "UPDATE memories SET level = 'workspace' WHERE id = ?1",
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
        // A memory at another level is not the project's to change.
        assert!(
            matches!(
                result,
                Err(memory_writes::MutationError::Refused(memory_writes::Refused::Pending(ref reason)))
                    if reason == "target_not_owned"
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
                "UPDATE memories SET level = 'project' WHERE id = ?1",
                [second],
            )
        })
        .unwrap();
        let receipt = db
            .with_connection(|conn| memory_writes::mutate(conn, &who, &change))
            .unwrap();
        let survivor = receipt.memory_id.unwrap();
        assert_eq!(placement(&db, survivor).1, "pj-a");
        // merge_owner itself refuses sources at different owners.
        db.with_connection(|conn| {
            conn.execute(
                "UPDATE memories SET owner_id = 'pj-other' WHERE id = ?1",
                [second],
            )
            .unwrap();
            assert_eq!(
                refusal_code(&merge_owner(conn, &[first, second]).unwrap_err()).as_deref(),
                Some("merge_owner_mismatch")
            );
        });
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
