//! Memory reads for the apps: an owner's counts, a page of its memories, one
//! memory with its history, the summarizer's pending observations about the
//! person, and a project's candidate facts waiting for their second turn.
//!
//! Every query is bound to one owner and walks an index of it
//! (`idx_memories_owner_status`, the observation and backlog indexes); the
//! reads sort only that owner's rows.

use rusqlite::types::Value as Sql;
use rusqlite::OptionalExtension;

use super::pages::{self, Keyset, Page};
use super::*;

const COLUMNS: &str = "m.id, m.content, m.category, m.level, m.owner_id,
    COALESCE(m.status, 'active'), m.importance, m.shareable, m.safety_critical, m.sensitive,
    m.source_type, m.source_session_id, m.source_project_id, COALESCE(m.seen_count, 1),
    COALESCE(m.retrieval_count, 0), m.first_seen_at, m.last_seen_at, m.created_at,
    m.updated_at, m.expires_at, m.revision, m.mural_cue, m.merged_from,
    m.superseded_by_memory_id";

/// One memory as the pages show it, and the key it sorts under.
fn memory_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(Value, Vec<Sql>)> {
    let id: i64 = row.get(0)?;
    let category: String = row.get(2)?;
    let level: String = row.get(3)?;
    let importance: Option<i64> = row.get(6)?;
    let updated_at: i64 = row.get(18)?;
    let mut source = json!({});
    pages::put(
        &mut source,
        "type",
        row.get::<_, Option<String>>(10)?.map(Value::from),
    );
    pages::put(
        &mut source,
        "session",
        row.get::<_, Option<String>>(11)?
            .filter(|session| !session.is_empty())
            .map(Value::from),
    );
    // A project memory's source project is the project itself; for other
    // levels it names where the memory came from.
    if level != "project" {
        pages::put(
            &mut source,
            "project",
            row.get::<_, Option<String>>(12)?
                .filter(|project| !project.is_empty())
                .map(Value::from),
        );
    }
    let mut value = json!({
        "id": id,
        "content": row.get::<_, String>(1)?,
        "category": category,
        "level": level,
        "owner": row.get::<_, String>(4)?,
        "status": row.get::<_, String>(5)?,
        "shareable": row.get::<_, i64>(7)? != 0,
        "sensitive": row.get::<_, i64>(9)? != 0,
        "source": source,
        "seen_count": row.get::<_, i64>(13)?,
        "retrieval_count": row.get::<_, i64>(14)?,
        "first_seen_at": row.get::<_, i64>(15)?,
        "last_seen_at": row.get::<_, i64>(16)?,
        "created_at": row.get::<_, i64>(17)?,
        "updated_at": updated_at,
        "revision": row.get::<_, i64>(20)?,
    });
    pages::put(&mut value, "importance", importance.map(Value::from));
    pages::put(
        &mut value,
        "safety_critical",
        row.get::<_, Option<i64>>(8)?
            .map(|flag| Value::from(flag != 0)),
    );
    pages::put(
        &mut value,
        "expires_at",
        row.get::<_, Option<i64>>(19)?.map(Value::from),
    );
    pages::put(
        &mut value,
        "cue",
        row.get::<_, Option<String>>(21)?.map(Value::from),
    );
    let key = vec![
        Sql::Text(category),
        Sql::Integer(importance.unwrap_or(-1)),
        Sql::Integer(updated_at),
        Sql::Integer(id),
    ];
    Ok((value, key))
}

/// The search over a project's or workspace's memories: each word must
/// appear in the text, through the full-text index. Each word is quoted, so
/// nothing the person types is read as query syntax. A word with no letter
/// or digit holds no token the index could match, so it is left out.
fn fts_query(text: &str) -> Option<String> {
    let words: Vec<String> = text
        .split_whitespace()
        .filter(|word| word.chars().any(char::is_alphanumeric))
        .map(|word| format!("content : \"{}\"", word.replace('"', "\"\"")))
        .collect();
    (!words.is_empty()).then(|| words.join(" AND "))
}

impl Replica {
    fn context(&self) -> Result<&Connection, Refusal> {
        self.context.as_ref().ok_or_else(pages::store_unavailable)
    }

    fn memory_owner(&self, p: &Map<String, Value>) -> Result<(String, String), Refusal> {
        pages::owner(p, |project| self.apps.knows(project))
    }

    /// `memories.stats {level, owner?}`: counts over the whole owner.
    pub(super) fn memories_stats(&self, p: &Map<String, Value>) -> Result<Value, Refusal> {
        let (level, owner) = self.memory_owner(p)?;
        let conn = self.context()?;
        let counts: Vec<(String, String, i64)> = conn
            .prepare(
                "SELECT category, COALESCE(status, 'active'), COUNT(*) FROM memories
                  WHERE level = ?1 AND owner_id = ?2 GROUP BY 1, 2",
            )
            .and_then(|mut statement| {
                statement
                    .query_map(params![level, owner], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    })?
                    .collect()
            })
            .map_err(pages::store_error)?;
        let mut by_category = Map::new();
        let mut total = 0;
        for (category, status, count) in counts {
            total += count;
            let entry = by_category
                .entry(category)
                .or_insert_with(|| json!({"active": 0, "permanent": 0, "archived": 0}));
            if let Some(slot) = entry.get_mut(&status) {
                *slot = json!(slot.as_i64().unwrap_or(0) + count);
            }
        }
        let mut reply = json!({
            "level": level,
            "owner": owner,
            "by_category": by_category,
            "total": total,
        });
        if level == "global" {
            let pending: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_observations WHERE consumed_at IS NULL",
                    [],
                    |row| row.get(0),
                )
                .map_err(pages::store_error)?;
            reply["pending_observations"] = json!(pending);
        }
        Ok(reply)
    }

    /// `memories.page {level, owner?, status?, category?, text?, cursor?,
    /// limit?}`: by category, then importance (highest first), then newest
    /// update.
    pub(super) fn memories_page(&self, p: &Map<String, Value>) -> Result<Value, Refusal> {
        let (level, owner) = self.memory_owner(p)?;
        let status = pages::optional(p, "status")?.unwrap_or("live");
        let statuses: &[&str] = match status {
            "live" => &["active", "permanent"],
            "all" => &[],
            "active" => &["active"],
            "permanent" => &["permanent"],
            "archived" => &["archived"],
            _ => return Err(invalid("status")),
        };
        let category = pages::optional(p, "category")?;
        let text = pages::optional(p, "text")?;
        let search = match text {
            Some(text) if level == "global" => Some(Sql::Text(text.to_owned())),
            Some(text) => Some(Sql::Text(fts_query(text).ok_or_else(|| invalid("text"))?)),
            None => None,
        };
        let limit = pages::limit(p, 200)?;
        let keyset = Keyset::new(
            "memories.page",
            &json!([level, owner, status, category, text]),
        );
        let after = keyset.after(p, "siii")?;
        let model = (level == "project")
            .then(|| self.apps.embedding_model(&owner))
            .flatten();
        let conn = self.context()?;
        let mut binds: Vec<Sql> = Vec::new();
        let embedded = match &model {
            Some(model) => {
                binds.push(Sql::Text(model.clone()));
                "EXISTS(SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id AND e.model_id = ?)"
            }
            None => "NULL",
        };
        let mut sql = format!(
            "SELECT {COLUMNS}, {embedded} FROM memories m WHERE m.level = ? AND m.owner_id = ?"
        );
        binds.push(Sql::Text(level.clone()));
        binds.push(Sql::Text(owner.clone()));
        if !statuses.is_empty() {
            sql.push_str(&format!(
                " AND COALESCE(m.status, 'active') IN ({})",
                vec!["?"; statuses.len()].join(", ")
            ));
            binds.extend(statuses.iter().map(|status| Sql::Text((*status).into())));
        }
        if let Some(category) = category {
            sql.push_str(" AND m.category = ?");
            binds.push(Sql::Text(category.into()));
        }
        if let Some(search) = search {
            // Global memories aren't in the full-text index, so their search
            // is a plain substring match.
            sql.push_str(if level == "global" {
                " AND instr(lower(m.content), lower(?)) > 0"
            } else {
                " AND m.id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)"
            });
            binds.push(search);
        }
        if let Some(after) = after {
            sql.push_str(
                " AND (m.category > ? OR (m.category = ? AND (COALESCE(m.importance, -1) < ?
                   OR (COALESCE(m.importance, -1) = ? AND (m.updated_at < ?
                   OR (m.updated_at = ? AND m.id < ?))))))",
            );
            binds.extend([
                after[0].clone(),
                after[0].clone(),
                after[1].clone(),
                after[1].clone(),
                after[2].clone(),
                after[2].clone(),
                after[3].clone(),
            ]);
        }
        sql.push_str(
            " ORDER BY m.category ASC, COALESCE(m.importance, -1) DESC, m.updated_at DESC,
               m.id DESC LIMIT ?",
        );
        binds.push(Sql::Integer(limit as i64 + 1));
        let rows: Vec<(Value, Vec<Sql>)> = conn
            .prepare(&sql)
            .and_then(|mut statement| {
                statement
                    .query_map(rusqlite::params_from_iter(binds), |row| {
                        let (mut value, key) = memory_row(row)?;
                        pages::put(
                            &mut value,
                            "embedded",
                            row.get::<_, Option<i64>>(24)?
                                .map(|flag| Value::from(flag != 0)),
                        );
                        Ok((value, key))
                    })?
                    .collect()
            })
            .map_err(pages::store_error)?;
        let mut page = Page::new(limit);
        for (row, key) in rows {
            if !page.push(row, key)? {
                break;
            }
        }
        let mut reply = page.finish(&keyset, "memories");
        reply["level"] = json!(level);
        reply["owner"] = json!(owner);
        Ok(reply)
    }

    /// `memories.get {id}`: one memory, with its history newest first.
    pub(super) fn memories_get(&self, p: &Map<String, Value>) -> Result<Value, Refusal> {
        let id = pages::id(p, "id")?;
        let conn = self.context()?;
        let found = conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM memories m WHERE m.id = ?1"),
                params![id],
                |row| {
                    let (value, _) = memory_row(row)?;
                    let merged: Option<String> = row.get(22)?;
                    let superseded: Option<i64> = row.get(23)?;
                    Ok((value, merged, superseded))
                },
            )
            .optional()
            .map_err(pages::store_error)?;
        let Some((mut memory, merged, superseded)) = found else {
            return Err(error("memory_not_found", "No memory matches the id."));
        };
        if memory["level"] == "project" {
            let owner = memory["owner"].as_str().unwrap_or_default().to_owned();
            if let Some(model) = self.apps.embedding_model(&owner) {
                let embedded: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM memory_embeddings WHERE memory_id = ?1 AND model_id = ?2)",
                        params![id, model],
                        |row| row.get(0),
                    )
                    .map_err(pages::store_error)?;
                memory["embedded"] = json!(embedded);
            }
        }
        memory["merged_from"] = json!(merged
            .as_deref()
            .and_then(|json| serde_json::from_str::<Vec<Value>>(json).ok())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|id| id.as_i64())
            .collect::<Vec<_>>());
        pages::put(&mut memory, "superseded_by", superseded.map(Value::from));
        memory["history"] = Value::Array(self.history(conn, id)?);
        Ok(json!({"memory": memory}))
    }

    /// The memory's undo history, newest first, each entry with the writer
    /// that made it when the store records it.
    fn history(&self, conn: &Connection, id: i64) -> Result<Vec<Value>, Refusal> {
        type HistoryRow = (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            i64,
            String,
            String,
            Option<String>,
        );
        let rows: Vec<HistoryRow> = conn
            .prepare(
                "SELECT h.previous_text, h.after_text, h.before_json, h.after_json, h.applied_at,
                        h.reason, h.decision_key, j.before_json
                   FROM memory_history h
                   LEFT JOIN memory_journal j ON j.decision_key = h.decision_key
                  WHERE h.memory_id = ?1
                  ORDER BY h.applied_at DESC, h.id DESC",
            )
            .and_then(|mut statement| {
                statement
                    .query_map(params![id], |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                            row.get(7)?,
                        ))
                    })?
                    .collect()
            })
            .map_err(pages::store_error)?;
        let snapshot = |json: &Option<String>| -> Option<Value> {
            json.as_deref()
                .and_then(|json| serde_json::from_str::<Value>(json).ok())
                .map(|value| value["snapshot"].clone())
        };
        let mut entries = Vec::new();
        for (previous, after_text, before_json, after_json, at, reason, key, decision) in rows {
            let before = snapshot(&before_json);
            let after = snapshot(&after_json);
            let mut entry = json!({"at": at, "reason": reason});
            pages::put(
                &mut entry,
                "revision",
                after
                    .as_ref()
                    .and_then(|after| after["revision"].as_i64())
                    .map(Value::from),
            );
            // Rows written before history kept snapshots have only the text.
            let before_text = match &before {
                Some(snapshot) => snapshot["content"].as_str().map(str::to_owned),
                None => Some(previous),
            };
            let after_text = match &after {
                Some(snapshot) => snapshot["content"].as_str().map(str::to_owned),
                None => after_text,
            };
            pages::put(&mut entry, "before", before_text.map(Value::from));
            pages::put(&mut entry, "after", after_text.map(Value::from));
            for (field, value) in writer(conn, &key, decision.as_deref())? {
                entry[field] = value;
            }
            entries.push(entry);
        }
        Ok(entries)
    }

    /// `observations.page {cursor?, limit?}`: what summaries noticed about
    /// the person that no review has taken yet, newest first.
    pub(super) fn observations_page(&self, p: &Map<String, Value>) -> Result<Value, Refusal> {
        let limit = pages::limit(p, 200)?;
        let keyset = Keyset::new("observations.page", &json!([]));
        let after = keyset.after(p, "ii")?;
        let conn = self.context()?;
        let mut sql = String::from(
            "SELECT id, content, proposed_category, session_id, project_id, created_at
               FROM memory_observations WHERE consumed_at IS NULL",
        );
        let mut binds: Vec<Sql> = Vec::new();
        if let Some(after) = after {
            sql.push_str(" AND (created_at < ? OR (created_at = ? AND id < ?))");
            binds.extend([after[0].clone(), after[0].clone(), after[1].clone()]);
        }
        sql.push_str(" ORDER BY created_at DESC, id DESC LIMIT ?");
        binds.push(Sql::Integer(limit as i64 + 1));
        type ObservationRow = (i64, String, Option<String>, String, Option<String>, i64);
        let rows: Vec<ObservationRow> = conn
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
                        ))
                    })?
                    .collect()
            })
            .map_err(pages::store_error)?;
        let mut page = Page::new(limit);
        for (id, content, category, session, project, created_at) in rows {
            let mut row =
                json!({"id": id, "content": content, "session": session, "created_at": created_at});
            pages::put(&mut row, "proposed_category", category.map(Value::from));
            pages::put(&mut row, "project", project.map(Value::from));
            if !page.push(row, vec![Sql::Integer(created_at), Sql::Integer(id)])? {
                break;
            }
        }
        Ok(page.finish(&keyset, "observations"))
    }

    /// `facts.page {project, cursor?, limit?}`: the project's candidate facts
    /// still waiting for the summarizer's second turn, in queue order.
    pub(super) fn facts_page(&self, p: &Map<String, Value>) -> Result<Value, Refusal> {
        let project = string(p, "project")?;
        if !self.apps.knows(project) {
            return Err(pages::project_unknown());
        }
        let limit = pages::limit(p, 200)?;
        let keyset = Keyset::new("facts.page", &json!([project]));
        let after = keyset.after(p, "i")?;
        let conn = self.context()?;
        // Applied and covered facts have left the queue; the other states
        // still wait for a decision.
        let rows: Vec<(i64, String, String, String, i64, Option<String>)> = conn
            .prepare(
                "SELECT id, content, category, state, fact_attempts, reason
                   FROM memory_pending_facts
                  WHERE project_path = ?1 AND state IN ('retryable', 'in_flight', 'decided_pending')
                    AND id > ?2
                  ORDER BY id LIMIT ?3",
            )
            .and_then(|mut statement| {
                statement
                    .query_map(
                        params![
                            project,
                            after
                                .and_then(|after| match after[0] {
                                    Sql::Integer(id) => Some(id),
                                    _ => None,
                                })
                                .unwrap_or(0),
                            limit as i64 + 1
                        ],
                        |row| {
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                                row.get(5)?,
                            ))
                        },
                    )?
                    .collect()
            })
            .map_err(pages::store_error)?;
        let mut page = Page::new(limit);
        for (id, content, category, state, attempts, reason) in rows {
            let mut row = json!({"id": id, "content": content, "category": category, "state": state, "attempts": attempts});
            pages::put(&mut row, "reason", reason.map(Value::from));
            if !page.push(row, vec![Sql::Integer(id)])? {
                break;
            }
        }
        Ok(page.finish(&keyset, "facts"))
    }
}

/// Which writer made a history row, from what it recorded: the dreamer's
/// key names its run, and every other writer records itself in the
/// decision its journal row keeps. Rows that record neither get no writer.
fn writer(
    conn: &Connection,
    key: &str,
    decision: Option<&str>,
) -> Result<Vec<(&'static str, Value)>, Refusal> {
    if let Some(run) = key
        .strip_prefix("dream-run:")
        .and_then(|rest| rest.split(':').next())
        .and_then(|run| run.parse::<i64>().ok())
    {
        let task: Option<String> = conn
            .query_row(
                "SELECT task FROM dream_task_runs WHERE id = ?1",
                params![run],
                |row| row.get(0),
            )
            .optional()
            .map_err(pages::store_error)?;
        let mut fields = vec![("writer", json!("dreamer")), ("run_id", json!(run))];
        fields.extend(task.map(|task| ("task", json!(task))));
        return Ok(fields);
    }
    let recorded = decision
        .and_then(|decision| serde_json::from_str::<Value>(decision).ok())
        .and_then(|decision| decision["writer"].as_str().map(str::to_owned));
    Ok(match recorded.as_deref() {
        Some("ctx_memory") => vec![("writer", json!("agent"))],
        Some("historian") => vec![("writer", json!("summary"))],
        // The person's commands from the apps record `person`; the
        // dashboard's edits and restores (0.49) recorded these two.
        Some("person" | "dashboard_edit" | "dashboard_restore") => {
            vec![("writer", json!("person"))]
        }
        // Rows the plugin's dreamer wrote (Magic Context 0.49 and earlier),
        // before dreamer runs were recorded: the task is the plugin's task
        // name and there is no run to name.
        Some(task @ ("curate" | "verify" | "expire")) => {
            vec![("writer", json!("dreamer")), ("task", json!(task))]
        }
        _ => Vec::new(),
    })
}
