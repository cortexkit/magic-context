use std::{
    collections::{BTreeMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CREATE_TABLES: &[&str] = &[
    "memory_placement",
    "memory_ops",
    "memory_outbox",
    "memory_sync_state",
];

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

/// A dream writer uses only this claim-time authority, never a session or a fresh read.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RunAuthority {
    pub project_id: Option<String>,
    pub profile: Option<OriginProfile>,
    pub state: String,
    pub snapshot_digest: Option<String>,
    pub category_ids: BTreeMap<String, String>,
}

impl RunAuthority {
    pub fn from_session_pin(pin: &Value, session: &str) -> Option<Self> {
        let Some(categories) = pin.get("category_ids").and_then(Value::as_object) else {
            // Identity-only development pins are legacy writes. L9 owns degraded-state
            // reporting; writers must not guess categories from a currently installed profile.
            static WARNED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
            if WARNED
                .get_or_init(Default::default)
                .lock()
                .unwrap()
                .insert(session.into())
            {
                tracing::warn!(
                    session,
                    "memory pin has no category snapshot; leaving placement absent"
                );
            }
            return None;
        };
        let string = |v: &Value| v.as_str().map(str::to_owned);
        let state = pin["profile"]["state"].as_str().unwrap_or_default();
        let profile = if matches!(state, "resolved" | "entorhinal_not_answering") {
            string(&pin["profile"]["name"])
                .zip(string(&pin["profile"]["version"]))
                .zip(string(&pin["profile"]["digest"]))
                .map(|((name, version), digest)| OriginProfile {
                    name,
                    version,
                    digest,
                })
        } else {
            None
        };
        Some(Self {
            project_id: string(&pin["project_id"]),
            profile,
            state: state.into(),
            snapshot_digest: string(&pin["snapshot_digest"]),
            category_ids: categories
                .iter()
                .filter_map(|(k, v)| string(v).map(|v| (k.clone(), v)))
                .collect(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CreateKind {
    Create,
    MergeSurvivor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Actor {
    MainAgent,
    Historian,
    Dreamer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateEvent {
    pub kind: CreateKind,
    pub actor: Actor,
    pub session_id: Option<String>,
    pub ordinals: Vec<i64>,
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

/// Only write on the supplied transaction; never commit it or send network work.
pub type CreateHook = Arc<dyn Fn(&Connection, &CreateEvent) -> rusqlite::Result<()> + Send + Sync>;

#[derive(Clone, Default)]
pub struct MemoryWriter {
    pub actor: Option<Actor>,
    pub session_id: Option<String>,
    pub authority: Option<RunAuthority>,
    pub hook: Option<CreateHook>,
    pub ordinals: Vec<i64>,
    pub merge_owner: Option<Owner>,
}

pub fn refuse(code: &str) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(code.to_owned())))
}

pub fn requested_level(level: &str) -> rusqlite::Result<()> {
    if level == "project" {
        Ok(())
    } else {
        Err(refuse("level_unavailable"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    pub level: String,
    pub owner: Owner,
    pub origin_profile: Option<OriginProfile>,
    pub origin_category: Option<String>,
}

/// The join returns no placement when its memory row has been deleted.
pub fn read_placement(conn: &Connection, id: i64) -> rusqlite::Result<Option<Placement>> {
    conn.query_row("SELECT p.level,p.owner_kind,p.owner_id,p.origin_profile_name,p.origin_profile_version,p.origin_profile_digest,p.origin_category FROM memory_placement p JOIN memories m ON m.id=p.memory_id WHERE p.memory_id=?1", [id], |r| {
        let name: Option<String> = r.get(3)?;
        let version: Option<String> = r.get(4)?;
        let digest: Option<String> = r.get(5)?;
        Ok(Placement { level: r.get(0)?, owner: Owner {kind:r.get(1)?,id:r.get(2)?}, origin_profile: name.zip(version).zip(digest).map(|((name,version),digest)| OriginProfile {name,version,digest}), origin_category:r.get(6)? })
    }).optional()
}

/// Resolve every source before modifying any of them. Missing placement never widens ownership.
pub fn merge_owner(
    conn: &Connection,
    ids: &[i64],
    project: &str,
    writer: &MemoryWriter,
) -> rusqlite::Result<Option<Owner>> {
    let mut effective = None;
    for id in ids {
        let owner = match read_placement(conn, *id)? {
            Some(p) => Some(p.owner),
            None => {
                let path: String =
                    conn.query_row("SELECT project_path FROM memories WHERE id=?1", [id], |r| {
                        r.get(0)
                    })?;
                writer
                    .authority
                    .as_ref()
                    .and_then(|a| a.project_id.as_ref())
                    .filter(|_| path == project)
                    .map(|id| Owner {
                        kind: "project".into(),
                        id: id.clone(),
                    })
            }
        };
        if let Some(prior) = &effective {
            if prior != &owner {
                return Err(refuse("merge_owner_mismatch"));
            }
        } else {
            effective = Some(owner);
        }
    }
    Ok(effective.flatten())
}

impl MemoryWriter {
    /// Called only after a new row is inserted, inside that row's owning transaction.
    #[allow(clippy::too_many_arguments)]
    pub fn created(
        &self,
        conn: &Connection,
        id: i64,
        actor: Actor,
        kind: CreateKind,
        session: Option<&str>,
        owner: Option<&Owner>,
        now: i64,
    ) -> rusqlite::Result<()> {
        let Some(a) = &self.authority else {
            return self.report_unplaced(conn, id, actor, kind, session);
        };
        let Some(project_id) = &a.project_id else {
            return self.report_unplaced(conn, id, actor, kind, session);
        };
        if conn.is_autocommit() {
            return Err(refuse("memory create requires a transaction"));
        }
        let owner = owner
            .or(self.merge_owner.as_ref())
            .cloned()
            .unwrap_or_else(|| Owner {
                kind: "project".into(),
                id: project_id.clone(),
            });
        requested_level(&owner.kind)?;
        let (category, content, importance, expires_at): (
            String,
            String,
            Option<i64>,
            Option<i64>,
        ) = conn.query_row(
            "SELECT category,content,importance,expires_at FROM memories WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        let origin = a
            .profile
            .as_ref()
            .filter(|_| matches!(a.state.as_str(), "resolved" | "entorhinal_not_answering"));
        let category_id = origin.and_then(|_| a.category_ids.get(&category)).cloned();
        conn.execute("INSERT INTO memory_placement(memory_id,level,owner_kind,owner_id,origin_profile_name,origin_profile_version,origin_profile_digest,origin_category,written_at) VALUES(?1,'project',?2,?3,?4,?5,?6,?7,?8)", params![id,owner.kind,owner.id,origin.map(|p| &p.name),origin.map(|p| &p.version),origin.map(|p| &p.digest),category_id,now])?;
        if let Some(hook) = &self.hook {
            hook(
                conn,
                &CreateEvent {
                    kind,
                    actor,
                    session_id: session.or(self.session_id.as_deref()).map(str::to_owned),
                    ordinals: self.ordinals.clone(),
                    memory_id: id,
                    writer_project_id: Some(project_id.clone()),
                    owner: Some(owner),
                    category_tag: category,
                    effective_category_id: category_id,
                    importance,
                    expires_at,
                    content,
                    origin_profile: origin.cloned(),
                    snapshot_digest: a.snapshot_digest.clone(),
                },
            )?;
        }
        Ok(())
    }

    /// Report an unreplicated create without guessing ownership or writing placement.
    fn report_unplaced(
        &self,
        conn: &Connection,
        id: i64,
        actor: Actor,
        kind: CreateKind,
        session: Option<&str>,
    ) -> rusqlite::Result<()> {
        let Some(hook) = &self.hook else {
            return Ok(());
        };
        if conn.is_autocommit() {
            return Err(refuse("memory create requires a transaction"));
        }
        let (category, content, importance, expires_at) = conn.query_row(
            "SELECT category,content,importance,expires_at FROM memories WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        hook(
            conn,
            &CreateEvent {
                kind,
                actor,
                session_id: session.or(self.session_id.as_deref()).map(str::to_owned),
                ordinals: self.ordinals.clone(),
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
            },
        )
    }
}

impl crate::McStore {
    pub fn set_memory_create_hook(&self, hook: Option<CreateHook>) {
        *self.memory_create_hook.write().unwrap() = hook;
    }

    pub fn run_memory_writer(&self, authority: Option<RunAuthority>) -> MemoryWriter {
        MemoryWriter {
            authority,
            actor: Some(Actor::Dreamer),
            hook: self.memory_create_hook.read().unwrap().clone(),
            ..Default::default()
        }
    }

    pub fn session_memory_writer(
        &self,
        session: Option<&str>,
    ) -> Result<MemoryWriter, crate::McStoreError> {
        let authority = match session {
            Some(session) => self
                .load_meta(session)?
                .meta
                .memory_context
                .as_ref()
                .and_then(|pin| RunAuthority::from_session_pin(pin, session)),
            None => None,
        };
        let mut writer = self.run_memory_writer(authority);
        writer.actor = None;
        writer.session_id = session.map(str::to_owned);
        Ok(writer)
    }
}
