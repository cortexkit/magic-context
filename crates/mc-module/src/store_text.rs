//! Large immutable history strings live once in mode3.db, not in every
//! current/rollback/pending-view JSON record. Normal wire serialization stays
//! byte-identical; only Store's scoped encoder emits references.

use cortexkit_role_compaction::view::{Edit, EditOp, InsertedMessage, View};
use rusqlite::{params, Connection};
use serde::{Serialize, Serializer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::sync::Arc;

const MIN_BYTES: usize = 4_096;

#[derive(Clone, Default)]
pub(crate) struct Cache(Vec<(Arc<str>, String)>);

thread_local! {
    static ENCODER: RefCell<Option<Encoding>> = const { RefCell::new(None) };
}

struct Encoding {
    cache: Cache,
    added: Vec<(String, String)>,
    used: BTreeSet<String>,
}

fn reference(text: &str) -> Option<Value> {
    ENCODER.with(|encoder| {
        let mut encoder = encoder.borrow_mut();
        let encoder = encoder.as_mut()?;
        if text.len() < MIN_BYTES {
            return None;
        }
        let id = match encoder
            .cache
            .0
            .iter()
            .find(|(held, _)| held.as_ref() == text)
        {
            Some((_, id)) => id.clone(),
            None => {
                let id = format!("{:x}", Sha256::digest(text.as_bytes()));
                encoder.added.push((id.clone(), text.to_owned()));
                // Keep only a few recent text strings in memory; older blobs remain
                // addressable by their durable content digest after a restart.
                if encoder.cache.0.len() == 8 {
                    encoder.cache.0.remove(0);
                }
                encoder.cache.0.push((Arc::from(text), id.clone()));
                id
            }
        };
        encoder.used.insert(id.clone());
        Some(json!({"mode3_text":id}))
    })
}

pub(crate) fn encode(
    state: &crate::store::Durable,
    cache: &mut Cache,
) -> (String, Vec<(String, String)>, BTreeSet<String>) {
    ENCODER.with(|slot| {
        assert!(slot.borrow().is_none(), "nested store text encoder");
        *slot.borrow_mut() = Some(Encoding {
            cache: std::mem::take(cache),
            added: vec![],
            used: BTreeSet::new(),
        });
    });
    let text = serde_json::to_string(state).expect("state serializes");
    let encoding = ENCODER.with(|slot| slot.borrow_mut().take().unwrap());
    *cache = encoding.cache;
    cache.0.retain(|(_, id)| encoding.used.contains(id));
    (text, encoding.added, encoding.used)
}

pub(crate) fn text<S: Serializer>(text: &str, serializer: S) -> Result<S::Ok, S::Error> {
    match reference(text) {
        Some(value) => value.serialize(serializer),
        None => text.serialize(serializer),
    }
}

struct Text<'a>(&'a str);
impl Serialize for Text<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        text(self.0, serializer)
    }
}

struct StoredMessage<'a>(&'a InsertedMessage);
impl Serialize for StoredMessage<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("id", &self.0.id)?;
        map.serialize_entry("role", &self.0.role)?;
        map.serialize_entry(
            "texts",
            &self.0.texts.iter().map(|s| Text(s)).collect::<Vec<_>>(),
        )?;
        if !self.0.images.is_empty() {
            map.serialize_entry("images", &self.0.images)?;
        }
        map.end()
    }
}

struct StoredEdit<'a>(&'a Edit);
impl Serialize for StoredEdit<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if let EditOp::Insert { at, message } = &self.0.op {
            use serde::ser::SerializeMap;
            let mut map = serializer.serialize_map(None)?;
            map.serialize_entry("since", &self.0.since)?;
            map.serialize_entry("op", "insert")?;
            map.serialize_entry("at", at)?;
            map.serialize_entry("message", &StoredMessage(message))?;
            map.end()
        } else {
            self.0.serialize(serializer)
        }
    }
}

pub(crate) fn view<S: Serializer>(view: &View, serializer: S) -> Result<S::Ok, S::Error> {
    if ENCODER.with(|s| s.borrow().is_none()) {
        return view.serialize(serializer);
    }
    use serde::ser::SerializeStruct;
    let mut state = serializer.serialize_struct("View", 3)?;
    state.serialize_field("version", &view.version)?;
    state.serialize_field("checksum", &view.checksum)?;
    state.serialize_field(
        "edits",
        &view.edits.iter().map(StoredEdit).collect::<Vec<_>>(),
    )?;
    state.end()
}

pub(crate) fn optional_view<S: Serializer>(
    value: &Option<View>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        Some(value) => view(value, serializer),
        None => serializer.serialize_none(),
    }
}

fn transform_text(
    value: &mut Value,
    connection: &Connection,
    importing: bool,
) -> Result<(), String> {
    if importing {
        if let Some(text) = value.as_str().filter(|s| s.len() >= MIN_BYTES) {
            let id = format!("{:x}", Sha256::digest(text.as_bytes()));
            connection
                .execute(
                    "INSERT OR IGNORE INTO state_texts (id,text) VALUES (?1,?2)",
                    params![id, text],
                )
                .map_err(|e| e.to_string())?;
            *value = json!({"mode3_text":id});
        }
    } else if let Some(id) = value.get("mode3_text").and_then(Value::as_str) {
        let text: String = connection
            .query_row("SELECT text FROM state_texts WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .map_err(|e| format!("state_text_unavailable: {id}: {e}"))?;
        *value = Value::String(text);
    }
    Ok(())
}

fn transform_baseline(
    value: &mut Value,
    connection: &Connection,
    importing: bool,
) -> Result<(), String> {
    if let Some(text) = value.get_mut("m0") {
        transform_text(text, connection, importing)?;
    }
    Ok(())
}

fn transform_view(
    value: &mut Value,
    connection: &Connection,
    importing: bool,
) -> Result<(), String> {
    if let Some(edits) = value.get_mut("edits").and_then(Value::as_array_mut) {
        for edit in edits {
            if edit.get("op").and_then(Value::as_str) == Some("insert") {
                if let Some(texts) = edit
                    .get_mut("message")
                    .and_then(|m| m.get_mut("texts"))
                    .and_then(Value::as_array_mut)
                {
                    for text in texts {
                        transform_text(text, connection, importing)?;
                    }
                }
            }
        }
    }
    Ok(())
}

/// Only typed baseline and inserted-text locations are references. A tool's
/// arbitrary JSON value that happens to use the same keys is never rewritten.
pub(crate) fn transform(
    value: &mut Value,
    connection: &Connection,
    importing: bool,
) -> Result<(), String> {
    if let Some(base) = value.get_mut("baseline") {
        transform_baseline(base, connection, importing)?;
    }
    if let Some(pending) = value.get_mut("unconfirmed").and_then(Value::as_array_mut) {
        for pending in pending {
            if let Some(view) = pending.get_mut("view") {
                transform_view(view, connection, importing)?;
            }
            if let Some(before) = pending.get_mut("before") {
                if let Some(base) = before.get_mut("baseline") {
                    transform_baseline(base, connection, importing)?;
                }
                if let Some(view) = before.get_mut("latest") {
                    transform_view(view, connection, importing)?;
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), String> {
    let rows = {
        let mut statement = connection
            .prepare("SELECT runner,harness,session,state FROM sessions")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for (runner, harness, session, text) in rows {
        let mut value: Value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(error) => {
                // Loading this row already yields no state. Leave its bytes
                // untouched so one damaged session cannot prevent all others
                // from opening or migrating their valid state.
                tracing::warn!("ck-mc: session {session}: skipping undecodable state during migration: {error}");
                continue;
            }
        };
        transform(&mut value, connection, true)?;
        let mut used = BTreeSet::new();
        fn reference(value: &Value, used: &mut BTreeSet<String>) {
            if let Some(id) = value.get("mode3_text").and_then(Value::as_str) {
                used.insert(id.to_owned());
            }
        }
        fn view_references(value: &Value, used: &mut BTreeSet<String>) {
            if let Some(edits) = value.get("edits").and_then(Value::as_array) {
                for edit in edits.iter().filter(|e| e["op"] == "insert") {
                    if let Some(texts) = edit["message"]["texts"].as_array() {
                        for text in texts {
                            reference(text, used);
                        }
                    }
                }
            }
        }
        reference(&value["baseline"]["m0"], &mut used);
        if let Some(pending) = value["unconfirmed"].as_array() {
            for pending in pending {
                view_references(&pending["view"], &mut used);
                view_references(&pending["before"]["latest"], &mut used);
                reference(&pending["before"]["baseline"]["m0"], &mut used);
            }
        }
        for id in used {
            connection.execute("INSERT OR IGNORE INTO state_text_refs (runner,harness,session,id) VALUES (?1,?2,?3,?4)",params![runner,harness,session,id]).map_err(|e|e.to_string())?;
        }
        connection
            .execute(
                "UPDATE sessions SET state=?4 WHERE runner=?1 AND harness=?2 AND session=?3",
                params![runner, harness, session, value.to_string()],
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
