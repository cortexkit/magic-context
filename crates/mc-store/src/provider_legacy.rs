//! Compatibility codec for the older runner observation lane. Only explicit
//! legacy callers hydrate a whole record; the hook API reads the small row.
use super::provider_log::*;
use crate::{McTagRow, ProviderSessionKey};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

fn sql_error(e: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(e))
}
fn parse(raw: &str) -> rusqlite::Result<Value> {
    serde_json::from_str(raw).map_err(sql_error)
}
const SPLIT: &[(&str, &str)] = &[
    ("messages", "/messages"),
    ("pending_drops", "/pending_drops"),
    ("answers", "/hook/answers"),
    ("live", "/hook/live"),
    ("burned", "/hook/burned"),
    ("last_produced", "/setup/state/last_produced"),
    ("last_applied", "/setup/state/last_applied"),
    ("wait_view", "/wait_view"),
];
fn remove_pointer(value: &mut Value, path: &str) {
    let (parent, field) = path.rsplit_once('/').unwrap();
    if let Some(object) = value.pointer_mut(parent).and_then(Value::as_object_mut) {
        object.remove(field);
    }
}
fn restore_pointer(value: &mut Value, path: &str, restored: Value) {
    let (parent, field) = path.rsplit_once('/').unwrap();
    if let Some(object) = value.pointer_mut(parent).and_then(Value::as_object_mut) {
        object.insert(field.into(), restored);
    }
}
pub(crate) fn view_tx(
    conn: &Connection,
    conv: &str,
    view: &Value,
    state: &str,
) -> rusqlite::Result<()> {
    if view.is_null() {
        return Ok(());
    }
    conn.execute("INSERT INTO mc_provider_views_v1 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,json_extract(?1,'$[1]')) ON CONFLICT(conv_key,version) DO UPDATE SET state=excluded.state,view_json=excluded.view_json,lineage_id=excluded.lineage_id,range_from=excluded.range_from,range_to=excluded.range_to,replacement_json=excluded.replacement_json",
        params![conv,view["version"].as_i64(),view["range"]["lineage_id"].as_str(),view["range"]["from"].as_i64(),view["range"]["to"].as_i64(),view["replacement"].to_string(),state,view.to_string()])?;
    Ok(())
}
pub(crate) fn save_tx(
    conn: &Connection,
    key: &ProviderSessionKey,
    raw: &str,
    namespace: &str,
    tags: &[McTagRow],
) -> rusqlite::Result<()> {
    let original = parse(raw)?;
    let mut small = original.clone();
    let mut shape = json!({});
    for (field, path) in SPLIT {
        shape[*field] = json!(original.pointer(path).is_some());
        remove_pointer(&mut small, path);
    }
    for (field, path) in [
        ("produced_version", "/setup/state/last_produced/version"),
        ("applied_version", "/setup/state/last_applied/version"),
        ("wait_version", "/wait_view/version"),
    ] {
        shape[field] = original.pointer(path).cloned().unwrap_or(Value::Null);
    }
    let setup = small.get("setup").filter(|v| !v.is_null());
    let state = setup.and_then(|s| s.get("state"));
    let conversation = ProviderConversation {
        lineage_id: original
            .pointer("/setup/request/lineage_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        preset: state.and_then(|s| s["preset"].as_str()).map(str::to_string),
        params_json: original
            .pointer("/setup/request/params")
            .unwrap_or(&json!({}))
            .to_string(),
        setup_json: setup.map(Value::to_string),
        engine_namespace: namespace.into(),
        version_high_water: state
            .and_then(|s| s["version_high_water"].as_u64())
            .unwrap_or(0),
        rebuild_epoch: state.and_then(|s| s["rebuild_epoch"].as_u64()).unwrap_or(0),
        hook_counters_json: small
            .get("hook")
            .filter(|v| !v.is_null())
            .unwrap_or(&json!({}))
            .to_string(),
        last_answer_json: original
            .get("last_answer")
            .filter(|v| !v.is_null())
            .map(Value::to_string),
        wait_request: original
            .get("wait_request")
            .and_then(Value::as_str)
            .map(str::to_string),
        ..ProviderConversation {
            historian_model_chain_json: "[]".into(),
            ..Default::default()
        }
    };
    save_conversation_tx(conn, key, &conversation)?;
    let conv = key.conversation_key();
    conn.execute("UPDATE mc_provider_conversations_v2 SET record_json=?2,legacy_shape_json=?3 WHERE conv_key=?1",params![conv,small.to_string(),shape.to_string()])?;
    if let Some(lineages) = original.get("messages").and_then(Value::as_object) {
        for (lineage, entries) in lineages {
            let entries = entries.as_object().ok_or(rusqlite::Error::InvalidQuery)?;
            let first = entries
                .keys()
                .filter_map(|s| s.parse::<i64>().ok())
                .min()
                .unwrap_or(0);
            conn.execute("INSERT INTO mc_provider_lineages_v1(conv_key,lineage_id,first_ordinal,session) VALUES (?1,?2,?3,json_extract(?1,'$[1]')) ON CONFLICT DO NOTHING",params![conv,lineage,first])?;
            for entry in entries.values() {
                let m = ProviderMessage {
                    ordinal: entry["ordinal"]
                        .as_u64()
                        .ok_or(rusqlite::Error::InvalidQuery)?,
                    mid: entry["mid"]
                        .as_str()
                        .ok_or(rusqlite::Error::InvalidQuery)?
                        .into(),
                    message_bytes: entry["message"].to_string().into_bytes(),
                };
                insert_message_tx(conn, &conv, lineage, &m).map_err(sql_error)?;
            }
        }
    }
    if let Some(answers) = original.pointer("/hook/answers").and_then(Value::as_array) {
        for (index, a) in answers.iter().enumerate() {
            conn.execute("INSERT INTO mc_provider_hook_answers_v1 (conv_key,answer_seq,lineage_id,subject_mid,hook,subject_part,ordinal,ops_json,tags_json,state,legacy_json,session) VALUES (?1,?2,?3,?4,'legacy',?5,NULL,?6,?7,?8,?9,json_extract(?1,'$[1]')) ON CONFLICT(conv_key,answer_seq) DO UPDATE SET legacy_json=excluded.legacy_json,state=excluded.state,ops_json=excluded.ops_json,tags_json=excluded.tags_json",
                params![conv,index as i64,a["lineage"].as_str().unwrap_or(""),a["subject"].as_str().unwrap_or(""),index.to_string(),a["answer"].to_string(),a["tags"].to_string(),if a["observed"].as_bool().unwrap_or(false) {"live"} else {"pending"},a.to_string()])?;
        }
    }
    conn.execute(
        "DELETE FROM mc_provider_legacy_tags_v1 WHERE conv_key=?1",
        [&conv],
    )?;
    if let Some(live) = original.pointer("/hook/live").and_then(Value::as_object) {
        for (number, tag) in live {
            conn.execute("INSERT INTO mc_provider_legacy_tags_v1 VALUES (?1,?2,'live',?3,json_extract(?1,'$[1]'))",params![conv,number.parse::<i64>().map_err(sql_error)?,tag.to_string()])?;
        }
    }
    if let Some(burned) = original.pointer("/hook/burned").and_then(Value::as_array) {
        for n in burned {
            conn.execute("INSERT INTO mc_provider_legacy_tags_v1 VALUES (?1,?2,'burned',NULL,json_extract(?1,'$[1]'))",params![conv,n.as_i64()])?;
        }
    }
    conn.execute(
        "DELETE FROM mc_provider_pending_drops_v1 WHERE conv_key=?1",
        [&conv],
    )?;
    if let Some(drops) = original.get("pending_drops").and_then(Value::as_array) {
        for n in drops {
            conn.execute(
                "INSERT INTO mc_provider_pending_drops_v1 VALUES (?1,?2,json_extract(?1,'$[1]'))",
                params![conv, n.as_i64()],
            )?;
        }
    }
    for (path, state) in [
        ("/setup/state/last_produced", "produced"),
        ("/setup/state/last_applied", "applied"),
        ("/wait_view", "produced"),
    ] {
        if let Some(view) = original.pointer(path) {
            view_tx(conn, &conv, view, state)?;
        }
    }
    insert_tags_tx(conn, namespace, tags)
}
pub(crate) fn load_tx(
    conn: &Connection,
    key: &ProviderSessionKey,
) -> rusqlite::Result<Option<String>> {
    let conv = key.conversation_key();
    let raw=conn.query_row("SELECT record_json,legacy_shape_json FROM mc_provider_conversations_v2 WHERE conv_key=?1",[&conv],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
    let Some((raw, shape)) = raw else {
        return Ok(None);
    };
    let mut record = parse(&raw)?;
    let shape = parse(&shape)?;
    let has = |field: &str| {
        shape[field]
            .as_bool()
            .unwrap_or_else(|| shape[field].as_i64() == Some(1))
    };
    if has("messages") {
        let mut messages = json!({});
        let mut lineages =
            conn.prepare("SELECT lineage_id FROM mc_provider_lineages_v1 WHERE conv_key=?1")?;
        for lineage in lineages.query_map([&conv], |r| r.get::<_, String>(0))? {
            messages[lineage?] = json!({});
        }
        let mut q=conn.prepare("SELECT lineage_id,ordinal,mid,message_bytes FROM mc_provider_messages_v1 WHERE conv_key=?1 ORDER BY lineage_id,ordinal")?;
        for row in q.query_map([&conv], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Vec<u8>>(3)?,
            ))
        })? {
            let (lineage, ordinal, mid, bytes) = row?;
            if messages.get(&lineage).is_none() {
                messages[&lineage] = json!({});
            }
            messages[&lineage][ordinal.to_string()] = json!({"ordinal":ordinal,"mid":mid,"message":serde_json::from_slice::<Value>(&bytes).map_err(sql_error)?});
        }
        record["messages"] = messages;
    }
    if has("answers") {
        let mut q=conn.prepare("SELECT legacy_json FROM mc_provider_hook_answers_v1 WHERE conv_key=?1 AND legacy_json IS NOT NULL ORDER BY answer_seq")?;
        let answers = q
            .query_map([&conv], |r| r.get::<_, String>(0))?
            .map(|r| parse(&r?))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        restore_pointer(&mut record, "/hook/answers", json!(answers));
    }
    for state in ["live", "burned"] {
        if has(state) {
            let mut q=conn.prepare("SELECT tag_number,tag_json FROM mc_provider_legacy_tags_v1 WHERE conv_key=?1 AND state=?2 ORDER BY tag_number")?;
            let rows = q
                .query_map(params![conv, state], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let value = if state == "live" {
                let mut v = json!({});
                for (n, t) in rows {
                    v[n.to_string()] = parse(&t.unwrap())?;
                }
                v
            } else {
                json!(rows.iter().map(|r| r.0).collect::<Vec<_>>())
            };
            restore_pointer(&mut record, &format!("/hook/{state}"), value);
        }
    }
    if has("pending_drops") {
        let mut q=conn.prepare("SELECT tag_number FROM mc_provider_pending_drops_v1 WHERE conv_key=?1 ORDER BY tag_number")?;
        let rows = q
            .query_map([&conv], |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        record["pending_drops"] = json!(rows);
    }
    for (field, path, version) in [
        (
            "last_produced",
            "/setup/state/last_produced",
            "produced_version",
        ),
        (
            "last_applied",
            "/setup/state/last_applied",
            "applied_version",
        ),
        ("wait_view", "/wait_view", "wait_version"),
    ] {
        if has(field) {
            let view = if let Some(version) = shape[version].as_i64() {
                conn.query_row(
                    "SELECT view_json FROM mc_provider_views_v1 WHERE conv_key=?1 AND version=?2",
                    params![conv, version],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
                .map(|s| parse(&s))
                .transpose()?
                .unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            restore_pointer(&mut record, path, view);
        }
    }
    Ok(Some(record.to_string()))
}
