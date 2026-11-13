//! The projects and sessions the module manages, as the app reads see them,
//! and the reads that list a project's sessions and notes.
//!
//! A project is known once a session of it has been set up with the
//! module. A session's project is its memory context's `project_id`, kept in
//! `mode3.db` for every session that has one, and the route's project for a
//! session set up in this process. The context table has no index by
//! project, so it is read once when the replica starts (one row per
//! session, like the session list itself), and Setup keeps it current.

use std::collections::BTreeSet;

use rusqlite::types::Value as Sql;
use rusqlite::OptionalExtension;

use super::pages::{self, Keyset, Page};
use super::*;

/// What the module hands the app reads besides its stores: the settings,
/// for the dreamer's switch and each project's embedding model, and the
/// dreamer, for the task declarations of the projects it has seen.
#[derive(Clone)]
pub(crate) struct Attachment {
    pub config: Arc<crate::config::Config>,
    pub dreamer: Option<Arc<crate::dreamer::engine::Engine>>,
}

/// A project the module has seen.
#[derive(Default)]
pub(super) struct Project {
    /// Its folder, once a session of it was set up in this process.
    pub root: Option<String>,
    pub sessions: HashSet<SessionRef>,
}

pub(super) struct Apps {
    pub projects: HashMap<String, Project>,
    /// Each session's preset, read from its stored state the first time a
    /// read needs it, and from each Setup. `None` for a session the module
    /// serves tools to but does not compact.
    pub presets: HashMap<SessionRef, Option<String>>,
    pub attached: Option<Attachment>,
    /// The IANA name of the machine's time zone, whose local time dreamer
    /// schedules run in. A function so tests can fix it.
    pub zone: fn() -> Option<String>,
}

impl Default for Apps {
    fn default() -> Self {
        Self {
            projects: HashMap::new(),
            presets: HashMap::new(),
            attached: None,
            zone: || iana_time_zone::get_timezone().ok(),
        }
    }
}

impl Apps {
    pub(super) fn knows(&self, project: &str) -> bool {
        self.projects.contains_key(project)
    }

    fn add(&mut self, key: SessionRef, project: &str) {
        // A session belongs to one project: Setup may name a project its
        // stored context didn't.
        for (id, other) in &mut self.projects {
            if id != project {
                other.sessions.remove(&key);
            }
        }
        self.projects
            .entry(project.to_owned())
            .or_default()
            .sessions
            .insert(key);
    }

    /// The model id the project's memories are embedded under now, when
    /// its folder is known in this process and its settings embed memories.
    pub(super) fn embedding_model(&self, project: &str) -> Option<String> {
        let root = self.projects.get(project)?.root.as_deref()?;
        let config = &self.attached.as_ref()?.config;
        let plan = crate::upkeep::Plan::from_settings(&config.resolve(Some(root), "", 0));
        plan.memory
            .then_some(plan.embedding)
            .flatten()
            .map(|provider| provider.model_id())
    }
}

impl Replica {
    /// Learn each stored session's project. Called once, when the replica
    /// loads; a failure leaves those projects unknown until their sessions
    /// set up again.
    pub(super) fn load_projects(&mut self) {
        let Some(conn) = &self.store else { return };
        let rows = conn
            .prepare(
                "SELECT runner, harness, session, json_extract(context, '$.project_id')
                   FROM memory_contexts",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| {
                        Ok((
                            SessionRef::new(
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                            ),
                            row.get::<_, Option<String>>(3)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()
            });
        match rows {
            Ok(rows) => {
                for (key, project) in rows {
                    if let Some(project) = project.filter(|project| !project.is_empty()) {
                        self.apps.add(key, &project);
                    }
                }
            }
            Err(error) => tracing::warn!("ck-mc: app reads: loading session projects: {error}"),
        }
    }

    /// A session set up in this process, with its project and preset.
    pub(super) fn session_seen(
        &mut self,
        key: SessionRef,
        project: String,
        root: String,
        preset: String,
    ) {
        self.apps.presets.insert(key.clone(), Some(preset));
        self.apps.add(key, &project);
        self.apps.projects.entry(project).or_default().root = Some(root);
    }

    fn preset(&mut self, key: &SessionRef) -> Option<String> {
        if let Some(preset) = self.apps.presets.get(key) {
            return preset.clone();
        }
        let preset = self.store.as_ref().and_then(|conn| {
            conn.query_row(
                "SELECT json_extract(state, '$.preset') FROM sessions
                  WHERE runner = ?1 AND harness = ?2 AND session = ?3",
                params![key.runner, key.harness, key.session],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .ok()
            .flatten()
            .flatten()
        });
        self.apps.presets.insert(key.clone(), preset.clone());
        preset
    }

    /// When the session's newest message was written, from the message
    /// index ck-mc keeps for it, or its in-memory projection.
    fn last_activity(&self, key: &SessionRef) -> Option<i64> {
        let stored = self.store.as_ref().and_then(|conn| {
            conn.query_row(
                "SELECT at_ms FROM app_read_message_index
                  WHERE runner = ?1 AND harness = ?2 AND session = ?3
                  ORDER BY ordinal DESC LIMIT 1",
                params![key.runner, key.harness, key.session],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .ok()
            .flatten()
        });
        let projected = self.snapshots.get(key).and_then(|snapshot| {
            snapshot
                .messages
                .values()
                .map(|message| message.at_ms as i64)
                .max()
        });
        stored.max(projected).filter(|at| *at > 0)
    }

    /// `sessions.page {project, harness?, preset?, cursor?, limit?}`: the
    /// project's sessions the module compacts, newest activity first.
    pub(super) fn sessions_page(&mut self, p: &Map<String, Value>) -> Result<Value, Refusal> {
        let project = string(p, "project")?;
        let harness = pages::optional(p, "harness")?;
        let preset = pages::optional(p, "preset")?;
        if preset.is_some_and(|preset| crate::preset::features(preset).is_none()) {
            return Err(invalid("preset"));
        }
        let limit = pages::limit(p, 50)?;
        let keyset = Keyset::new("sessions.page", &json!([project, harness, preset]));
        let after = keyset.after(p, "isss")?;
        let sessions: Vec<SessionRef> = self
            .apps
            .projects
            .get(project)
            .ok_or_else(pages::project_unknown)?
            .sessions
            .iter()
            .filter(|key| harness.is_none_or(|harness| key.harness == harness))
            .cloned()
            .collect();
        let mut rows = Vec::new();
        for key in sessions {
            let Some(session_preset) = self.preset(&key) else {
                continue;
            };
            if crate::preset::features(&session_preset).is_none()
                || preset.is_some_and(|preset| preset != session_preset)
            {
                continue;
            }
            // Sessions with no message yet sort after every other, as if
            // their last activity were before any.
            let at = self.last_activity(&key);
            rows.push((at.unwrap_or(-1), key, session_preset, at));
        }
        rows.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| b.1.runner.cmp(&a.1.runner))
                .then_with(|| b.1.harness.cmp(&a.1.harness))
                .then_with(|| b.1.session.cmp(&a.1.session))
        });
        let mut page = Page::new(limit);
        for (sort, key, preset, at) in rows {
            let sort_key = vec![
                Sql::Integer(sort),
                Sql::Text(key.runner.clone()),
                Sql::Text(key.harness.clone()),
                Sql::Text(key.session.clone()),
            ];
            if let Some(after) = &after {
                if !descending_after(&sort_key, after) {
                    continue;
                }
            }
            let mut row = json!({"session": key, "preset": preset});
            pages::put(&mut row, "last_activity_at", at.map(Value::from));
            if !page.push(row, sort_key)? {
                break;
            }
        }
        Ok(page.finish(&keyset, "sessions"))
    }

    /// The runner of the one session the module knows with this harness
    /// and id; notes are kept per harness and id, without the runner.
    fn runner_of(&self, harness: &str, session: &str) -> Option<String> {
        let mut runners: BTreeSet<&str> = self
            .known
            .iter()
            .chain(self.snapshots.keys())
            .chain(
                self.apps
                    .projects
                    .values()
                    .flat_map(|project| project.sessions.iter()),
            )
            .filter(|key| key.harness == harness && key.session == session)
            .map(|key| key.runner.as_str())
            .collect();
        let runner = runners.pop_first()?;
        runners.is_empty().then(|| runner.to_owned())
    }

    /// `notes.page {project, session?, type?, status?, cursor?, limit?}`:
    /// the project's notes, most recently updated first.
    pub(super) fn notes_page(&mut self, p: &Map<String, Value>) -> Result<Value, Refusal> {
        let project = string(p, "project")?;
        if !self.apps.knows(project) {
            return Err(pages::project_unknown());
        }
        let session = p
            .get("session")
            .filter(|value| !value.is_null())
            .map(super::session)
            .transpose()?;
        let kind = pages::optional(p, "type")?;
        if kind.is_some_and(|kind| !matches!(kind, "session" | "smart")) {
            return Err(invalid("type"));
        }
        let status = pages::optional(p, "status")?;
        let limit = pages::limit(p, 100)?;
        let keyset = Keyset::new("notes.page", &json!([project, session, kind, status]));
        let after = keyset.after(p, "ii")?;
        let conn = self.context.as_ref().ok_or_else(pages::store_unavailable)?;
        // Every filter narrows the project's notes; the project index (or the
        // session index, when a session is named) finds them.
        let mut sql = String::from(
            "SELECT id, type, status, content, created_at, updated_at, harness, session_id,
                    surface_condition, ready_reason
               FROM notes WHERE project_path = ?",
        );
        let mut binds: Vec<Sql> = vec![Sql::Text(project.into())];
        if let Some(session) = &session {
            sql.push_str(" AND session_id = ? AND harness = ?");
            binds.push(Sql::Text(session.session.clone()));
            binds.push(Sql::Text(session.harness.clone()));
        }
        if let Some(kind) = kind {
            sql.push_str(" AND type = ?");
            binds.push(Sql::Text(kind.into()));
        }
        if let Some(status) = status {
            sql.push_str(" AND status = ?");
            binds.push(Sql::Text(status.into()));
        }
        if let Some(after) = after {
            sql.push_str(" AND (updated_at < ? OR (updated_at = ? AND id < ?))");
            binds.extend([after[0].clone(), after[0].clone(), after[1].clone()]);
        }
        sql.push_str(" ORDER BY updated_at DESC, id DESC LIMIT ?");
        binds.push(Sql::Integer(limit as i64 + 1));
        type NoteRow = (
            i64,
            String,
            String,
            String,
            i64,
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let rows: Vec<NoteRow> = conn
            .prepare(&sql)
            .and_then(|mut statement| {
                statement
                    .query_map(rusqlite::params_from_iter(binds), |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                            row.get(7)?,
                            row.get(8)?,
                            row.get(9)?,
                        ))
                    })?
                    .collect()
            })
            .map_err(pages::store_error)?;
        let mut page = Page::new(limit);
        for (
            id,
            kind,
            status,
            content,
            created_at,
            updated_at,
            harness,
            session,
            condition,
            ready,
        ) in rows
        {
            let mut row = json!({
                "id": id,
                "type": kind,
                "status": status,
                "content": content,
                "created_at": created_at,
                "updated_at": updated_at,
            });
            if let (Some(harness), Some(session)) = (harness, session.filter(|s| !s.is_empty())) {
                let mut named = json!({"harness": harness, "session": session});
                pages::put(
                    &mut named,
                    "runner",
                    self.runner_of(&harness, &session).map(Value::from),
                );
                row["session"] = named;
            }
            if kind == "smart" {
                pages::put(&mut row, "condition", condition.map(Value::from));
                pages::put(&mut row, "ready_reason", ready.map(Value::from));
            }
            if !page.push(row, vec![Sql::Integer(updated_at), Sql::Integer(id)])? {
                break;
            }
        }
        Ok(page.finish(&keyset, "notes"))
    }
}

/// Whether `key` comes after `cursor` in a list sorted descending on every
/// column.
fn descending_after(key: &[Sql], cursor: &[Sql]) -> bool {
    for (key, cursor) in key.iter().zip(cursor) {
        let order = match (key, cursor) {
            (Sql::Integer(a), Sql::Integer(b)) => a.cmp(b),
            (Sql::Text(a), Sql::Text(b)) => a.cmp(b),
            _ => return false,
        };
        match order {
            std::cmp::Ordering::Less => return true,
            std::cmp::Ordering::Greater => return false,
            std::cmp::Ordering::Equal => {}
        }
    }
    false
}
