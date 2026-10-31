//! Versioned async data in the existing section KV store. No row is left in
//! the legacy async tables: older binaries must see absence, never a cold
//! header they cannot decode. Engine section namespaces remain independent.
use crate::cache_codec::async_provider::Sections;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(crate) use crate::cache_codec::async_provider::{CHILDREN, HEADERS, KEYS, OUTBOX};
pub(crate) const ENTRY: &str = "__ckmc_async_v2_entry:";
pub(crate) const VIEW: &str = "__ckmc_async_v2_view:";
pub(crate) const MID: &str = "__ckmc_async_v2_mid:";
const RESERVED: &str = "__ckmc_async_v2_";

pub(super) fn owner(reference: &str) -> String {
    format!("{CHILDREN}{reference}")
}

#[derive(Serialize, Deserialize)]
pub(super) struct Header {
    pub key: String,
    pub session: String,
    pub state_json: String,
    pub version_high_water: u64,
}

#[derive(Serialize, Deserialize)]
pub(super) struct Entry {
    pub ordinal: u64,
    pub entry_json: String,
    pub index_json: String,
    pub mid: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub(super) struct View {
    pub version: u64,
    pub view_json: String,
    pub engine_json: Option<String>,
    pub announced: i64,
}

fn encode<T: Serialize + ?Sized>(value: &T) -> rusqlite::Result<String> {
    serde_json::to_string(value).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
}

fn decode<T: serde::de::DeserializeOwned>(raw: &str) -> rusqlite::Result<T> {
    serde_json::from_str(raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

pub(super) fn get(conn: &Connection, owner: &str, slot: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT body FROM main.mc_cache_sections WHERE session_id=?1 AND section=?2",
        params![owner, slot],
        |row| row.get(0),
    )
    .optional()
}

pub(super) fn put(
    conn: &Connection,
    owner: &str,
    slot: &str,
    raw: &str,
) -> rusqlite::Result<usize> {
    Sections::new(conn, owner)?.put(slot, raw)
}

pub(super) fn remove(conn: &Connection, owner: &str, slot: &str) -> rusqlite::Result<usize> {
    Sections::new(conn, owner)?.remove(slot)
}

pub(super) fn header(conn: &Connection, reference: &str) -> rusqlite::Result<Option<Header>> {
    get(conn, HEADERS, reference)?
        .map(|raw| decode(&raw))
        .transpose()
}

pub(super) fn save_header(
    conn: &Connection,
    reference: &str,
    key: &str,
    session: &str,
    state: &str,
) -> rusqlite::Result<usize> {
    let next = match header(conn, reference)? {
        Some(mut prior) => {
            prior.state_json = state.into();
            prior
        }
        None => Header {
            key: key.into(),
            session: session.into(),
            state_json: state.into(),
            version_high_water: 0,
        },
    };
    write_header(conn, reference, &next)
}

fn write_header(conn: &Connection, reference: &str, next: &Header) -> rusqlite::Result<usize> {
    if let Some(raw) = get(conn, KEYS, &next.key)? {
        let owner: Value = decode(&raw)?;
        if owner["reference"].as_str() != Some(reference) {
            return Err(rusqlite::Error::InvalidParameterName(
                "async conversation key collision".into(),
            ));
        }
    }
    let rows = put(conn, HEADERS, reference, &encode(next)?)?;
    let index = encode(&json!({"reference":reference,"session":next.session}))?;
    let indexed = Sections::new(conn, KEYS)?.insert_if_absent(&next.key, &index)?;
    Ok(rows + indexed)
}

fn number(prefix: &str, value: u64) -> rusqlite::Result<String> {
    i64::try_from(value).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    Ok(format!("{prefix}{value:020}"))
}

fn outbox_key(reference: &str, version: u64) -> rusqlite::Result<String> {
    Ok(format!("{}:{version:020}", encode(reference)?))
}

fn outbox_bounds(reference: &str) -> rusqlite::Result<(String, String)> {
    let key = encode(reference)?;
    Ok((format!("{key}:"), format!("{key};")))
}

pub(super) fn baseline(
    conn: &Connection,
    reference: &str,
    slot: &str,
    raw: Option<&str>,
    immutable: bool,
) -> rusqlite::Result<usize> {
    if slot.starts_with(RESERVED) {
        return Err(rusqlite::Error::InvalidParameterName(
            "reserved async slot".into(),
        ));
    }
    match raw {
        Some(raw) if immutable => {
            Sections::new(conn, &owner(reference))?.insert_if_absent(slot, raw)
        }
        Some(raw) => put(conn, &owner(reference), slot, raw),
        None => remove(conn, &owner(reference), slot),
    }
}

pub(super) fn insert_entry(
    conn: &Connection,
    reference: &str,
    ordinal: u64,
    raw: &str,
    index: &str,
) -> rusqlite::Result<usize> {
    let mid = serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.get("mid").and_then(Value::as_str).map(str::to_owned));
    let row = Entry {
        ordinal,
        entry_json: raw.into(),
        index_json: index.into(),
        mid,
    };
    insert_entry_row(conn, reference, &row)
}

fn mid_key(mid: &str, ordinal: u64) -> rusqlite::Result<String> {
    Ok(format!("{MID}{}:{ordinal:020}", encode(mid)?))
}

fn insert_entry_row(conn: &Connection, reference: &str, row: &Entry) -> rusqlite::Result<usize> {
    let slot = number(ENTRY, row.ordinal)?;
    let mut rows = Sections::new(conn, &owner(reference))?.insert(&slot, &encode(row)?)?;
    if let Some(mid) = &row.mid {
        rows += put(
            conn,
            &owner(reference),
            &mid_key(mid, row.ordinal)?,
            &encode(&slot)?,
        )?;
    }
    Ok(rows)
}

fn delete_entry_row(conn: &Connection, reference: &str, row: &Entry) -> rusqlite::Result<usize> {
    let mut rows = remove(conn, &owner(reference), &number(ENTRY, row.ordinal)?)?;
    if let Some(mid) = &row.mid {
        rows += remove(conn, &owner(reference), &mid_key(mid, row.ordinal)?)?;
    }
    Ok(rows)
}

pub(super) fn replace_entry(
    conn: &Connection,
    reference: &str,
    ordinal: u64,
    raw: &str,
    index: &str,
) -> rusqlite::Result<usize> {
    Sections::new(conn, &owner(reference))?.replace_entry(&number(ENTRY, ordinal)?, raw, index)
}

pub(super) fn entries(
    conn: &Connection,
    reference: &str,
    from: u64,
    through: u64,
) -> rusqlite::Result<Vec<Entry>> {
    let mut statement = conn.prepare("SELECT body FROM main.mc_cache_sections WHERE session_id=?1 AND section>=?2 AND section<=?3 ORDER BY section")?;
    let rows = statement.query_map(
        params![
            owner(reference),
            number(ENTRY, from)?,
            number(ENTRY, through)?
        ],
        |row| decode::<Entry>(&row.get::<_, String>(0)?),
    )?;
    rows.collect()
}

/// The newest held entry of a conversation in the versioned layout. Entry
/// sections carry a zero-padded ordinal, so the last one in key order is the
/// newest; this reads one row, not the window.
pub(super) fn newest_entry(conn: &Connection, reference: &str) -> rusqlite::Result<Option<Entry>> {
    let lower = ENTRY.to_owned();
    let upper = format!("{ENTRY}~");
    conn.query_row(
        "SELECT body FROM main.mc_cache_sections WHERE session_id=?1 AND section>=?2 AND section<?3 ORDER BY section DESC LIMIT 1",
        params![owner(reference), lower, upper],
        |row| decode::<Entry>(&row.get::<_, String>(0)?),
    )
    .optional()
}

pub(super) fn truncate_entries(
    conn: &Connection,
    reference: &str,
    through: Option<u64>,
) -> rusqlite::Result<usize> {
    if through == Some(i64::MAX as u64) {
        return Ok(0);
    }
    let from = through.map_or(0, |n| n.saturating_add(1));
    let mut removed = 0;
    for row in entries(conn, reference, from, i64::MAX as u64)? {
        removed += delete_entry_row(conn, reference, &row)?;
    }
    Ok(removed)
}

pub(super) fn truncate_below(
    conn: &Connection,
    reference: &str,
    first: u64,
) -> rusqlite::Result<usize> {
    let mut removed = 0;
    if first > 0 {
        for row in entries(conn, reference, 0, first - 1)? {
            removed += delete_entry_row(conn, reference, &row)?;
        }
    }
    Ok(removed)
}

pub(super) fn view(
    conn: &Connection,
    reference: &str,
    version: u64,
) -> rusqlite::Result<Option<View>> {
    get(conn, &owner(reference), &number(VIEW, version)?)?
        .map(|raw| decode(&raw))
        .transpose()
}

pub(super) fn views(conn: &Connection, reference: &str) -> rusqlite::Result<Vec<View>> {
    let mut statement = conn.prepare("SELECT body FROM main.mc_cache_sections WHERE session_id=?1 AND section>=?2 AND section<?3 ORDER BY section")?;
    let rows = statement.query_map(params![owner(reference), VIEW, format!("{VIEW}~")], |row| {
        decode::<View>(&row.get::<_, String>(0)?)
    })?;
    rows.collect()
}

pub(super) fn save_view(
    conn: &Connection,
    reference: &str,
    value: &View,
    replace: bool,
) -> rusqlite::Result<usize> {
    let Some(parent) = header(conn, reference)? else {
        return Ok(0);
    };
    let slot = number(VIEW, value.version)?;
    let rows = if replace {
        put(conn, &owner(reference), &slot, &encode(value)?)?
    } else {
        Sections::new(conn, &owner(reference))?.insert(&slot, &encode(value)?)?
    };
    let key = outbox_key(reference, value.version)?;
    if value.announced == 0 {
        put(
            conn,
            OUTBOX,
            &key,
            &encode(
                &json!({"reference":reference,"version":value.version,"session":parent.session}),
            )?,
        )?;
    } else {
        remove(conn, OUTBOX, &key)?;
    }
    Ok(rows)
}

pub(super) fn reserve(conn: &Connection, reference: &str, applied: u64) -> rusqlite::Result<u64> {
    let mut value = header(conn, reference)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    value.version_high_water = value
        .version_high_water
        .max(applied)
        .checked_add(1)
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    put(conn, HEADERS, reference, &encode(&value)?)?;
    Ok(value.version_high_water)
}

pub(super) fn raise_high(conn: &Connection, reference: &str, high: u64) -> rusqlite::Result<()> {
    if let Some(mut value) = header(conn, reference)? {
        value.version_high_water = value.version_high_water.max(high);
        put(conn, HEADERS, reference, &encode(&value)?)?;
    }
    Ok(())
}

pub(super) fn announce(
    conn: &Connection,
    reference: &str,
    version: u64,
    status: i64,
) -> rusqlite::Result<usize> {
    let Some(mut value) = view(conn, reference, version)? else {
        return Ok(0);
    };
    value.announced = status;
    save_view(conn, reference, &value, true)
}

pub(super) fn retire(
    conn: &Connection,
    reference: &str,
    version: Option<u64>,
) -> rusqlite::Result<usize> {
    let mut changed = 0;
    for value in views(conn, reference)? {
        if value.announced == 0 && version.is_none_or(|version| value.version == version) {
            changed += announce(conn, reference, value.version, -1)?;
        }
    }
    Ok(changed)
}

pub(super) fn revise(
    conn: &Connection,
    reference: &str,
    version: u64,
    raw: &str,
) -> rusqlite::Result<usize> {
    let Some(mut value) = view(conn, reference, version)?.filter(|value| value.announced == 0)
    else {
        return Ok(0);
    };
    value.view_json = raw.into();
    save_view(conn, reference, &value, true)
}

pub(super) fn clear_engine_views(conn: &Connection, reference: &str) -> rusqlite::Result<usize> {
    let mut changed = 0;
    for mut value in views(conn, reference)? {
        if value.engine_json.take().is_some() {
            changed += put(
                conn,
                &owner(reference),
                &number(VIEW, value.version)?,
                &encode(&value)?,
            )?;
        }
    }
    Ok(changed)
}

pub(super) fn retain_views(
    conn: &Connection,
    reference: &str,
    floor: u64,
) -> rusqlite::Result<usize> {
    let all = conn.prepare("SELECT section FROM main.mc_cache_sections WHERE session_id=?1 AND section>=?2 AND section<?3 ORDER BY section")?
        .query_map(params![owner(reference),VIEW,format!("{VIEW}~")], |row| row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let newest = all.last();
    let floor = number(VIEW, floor)?;
    let mut changed = 0;
    for slot in &all {
        if slot < &floor && Some(slot) != newest {
            let version = slot
                .strip_prefix(VIEW)
                .and_then(|n| n.parse::<u64>().ok())
                .ok_or(rusqlite::Error::InvalidQuery)?;
            changed += remove(conn, &owner(reference), slot)?;
            remove(conn, OUTBOX, &outbox_key(reference, version)?)?;
        }
    }
    Ok(changed)
}

pub(super) fn pending(conn: &Connection) -> rusqlite::Result<Vec<(String, u64, String)>> {
    let mut result = conn.prepare("SELECT session_ref,version,view_json FROM main.mc_async_compaction_views WHERE announced=0 ORDER BY session_ref,version")?
        .query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,u64>(1)?,row.get::<_,String>(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let pending = conn
        .prepare("SELECT body FROM main.mc_cache_sections WHERE session_id=?1 ORDER BY section")?
        .query_map([OUTBOX], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for raw in pending {
        let item: Value = match decode(&raw) {
            Ok(item) => item,
            Err(error) => {
                tracing::warn!(%error, "unreadable async outbox pointer");
                continue;
            }
        };
        let (Some(reference), Some(version)) =
            (item["reference"].as_str(), item["version"].as_u64())
        else {
            continue;
        };
        // An older binary can recreate a legacy record after starting fresh.
        // Hide its dormant KV outbox until that newer state is migrated again.
        if legacy_exists(conn, reference)? {
            continue;
        }
        match view(conn, reference, version) {
            Ok(Some(value)) if value.announced == 0 => {
                result.push((reference.into(), version, value.view_json))
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(session_ref=reference, version, %error, "unreadable async outbox view")
            }
        }
    }
    result.sort_by(|left, right| (&left.0, left.1).cmp(&(&right.0, right.1)));
    Ok(result)
}

pub(super) fn legacy_exists(conn: &Connection, reference: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM main.mc_async_compaction WHERE session_ref=?1)",
        [reference],
        |row| row.get(0),
    )
}

fn clear_owned(conn: &Connection, reference: &str) -> rusqlite::Result<()> {
    Sections::new(conn, &owner(reference))?.clear_record()?;
    remove(conn, HEADERS, reference)?;
    Sections::new(conn, KEYS)?.remove_reference(reference)?;
    let (from, to) = outbox_bounds(reference)?;
    Sections::new(conn, OUTBOX)?.remove_outbox_range(&from, &to)?;
    Ok(())
}

/// Run in the same transaction as legacy removal. A crash exposes either the
/// complete legacy family or the complete KV family, never a dangling header.
pub(super) fn migrate(conn: &Connection, reference: &str) -> rusqlite::Result<bool> {
    let old = conn.query_row("SELECT conversation_key,session,state_json,version_high_water FROM main.mc_async_compaction WHERE session_ref=?1", [reference], |row| Ok(Header {
        key:row.get(0)?,session:row.get(1)?,state_json:row.get(2)?,version_high_water:row.get(3)?
    })).optional()?;
    let Some(mut old) = old else {
        return Ok(false);
    };
    let entries = conn.prepare("SELECT ordinal,entry_json,index_json,mid FROM main.mc_async_compaction_entries WHERE session_ref=?1 ORDER BY ordinal")?
        .query_map([reference], |row| Ok(Entry { ordinal:row.get(0)?,entry_json:row.get(1)?,index_json:row.get(2)?,mid:row.get(3)? }))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let views = conn.prepare("SELECT version,view_json,engine_json,announced FROM main.mc_async_compaction_views WHERE session_ref=?1 ORDER BY version")?
        .query_map([reference], |row| Ok(View { version:row.get(0)?,view_json:row.get(1)?,engine_json:row.get(2)?,announced:row.get(3)? }))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let baselines = conn
        .prepare(
            "SELECT slot,view_json FROM main.mc_async_compaction_baselines WHERE session_ref=?1",
        )?
        .query_map([reference], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    clear_owned(conn, reference)?;
    let cold = split_cold_payloads(&mut old.state_json)?;
    write_header(conn, reference, &old)?;
    for entry in entries {
        insert_entry_row(conn, reference, &entry)?;
    }
    for value in views {
        save_view(conn, reference, &value, false)?;
    }
    for (slot, value) in baselines.into_iter().chain(cold) {
        baseline(conn, reference, &slot, Some(&value), false)?;
    }
    for table in [
        "mc_async_compaction_entries",
        "mc_async_compaction_views",
        "mc_async_compaction_baselines",
        "mc_async_compaction",
    ] {
        conn.execute(
            &format!("DELETE FROM main.{table} WHERE session_ref=?1"),
            [reference],
        )?;
    }
    Ok(true)
}

fn split_cold_payloads(raw: &mut String) -> rusqlite::Result<Vec<(String, String)>> {
    let Ok(Value::Object(mut record)) = serde_json::from_str::<Value>(raw) else {
        return Ok(Vec::new());
    };
    let mut cold = Vec::new();
    if let Some(initial) = record.remove("initial") {
        record.insert("initial_stored".into(), Value::Bool(true));
        record.insert(
            "initial_ready".into(),
            Value::Bool(initial["answer"] == "ready"),
        );
        cold.push(("setup-initial".into(), encode(&initial)?));
    }
    if let Some(Value::Object(moved)) = record.get_mut("standalone_move") {
        if let Some(drops) = moved.remove("bound_drops") {
            moved.insert("bound_drops_stored".into(), Value::Bool(true));
            cold.push(("moved-bound-drops".into(), encode(&drops)?));
        }
    }
    *raw = encode(&record)?;
    Ok(cold)
}

pub(super) fn downgrade_record(conn: &Connection, reference: &str) -> rusqlite::Result<bool> {
    let Some(current) = header(conn, reference)? else {
        return Ok(false);
    };
    if legacy_exists(conn, reference)? {
        // An old binary has already written newer state for this conversation.
        // Preserve that family, not the dormant v2 copy from before rollback.
        clear_owned(conn, reference)?;
        return Ok(true);
    }
    let mut state: Value = decode(&current.state_json)?;
    let record = state.as_object_mut().ok_or(rusqlite::Error::InvalidQuery)?;
    if record.get("initial_stored").and_then(Value::as_bool) == Some(true) {
        let raw = get(conn, &owner(reference), "setup-initial")?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        record.insert("initial".into(), decode(&raw)?);
    }
    if !record.contains_key("initial") {
        return Err(rusqlite::Error::InvalidQuery);
    }
    record.remove("initial_stored");
    record.remove("initial_ready");
    record.remove("input_revision");
    record.remove("engine_cache_witness");
    if let Some(Value::Object(moved)) = record.get_mut("standalone_move") {
        if moved.get("bound_drops_stored").and_then(Value::as_bool) == Some(true) {
            let raw = get(conn, &owner(reference), "moved-bound-drops")?
                .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            moved.insert("bound_drops".into(), decode(&raw)?);
        }
        moved.remove("bound_drops_stored");
    }
    // Read and validate the complete family before the first legacy write.
    let entries = entries(conn, reference, 0, i64::MAX as u64)?;
    let views = views(conn, reference)?;
    let baselines = conn.prepare("SELECT section,body FROM main.mc_cache_sections WHERE session_id=?1 AND section NOT GLOB '__ckmc_async_v2_*' AND section NOT IN ('setup-initial','moved-bound-drops') AND section<>?2")?
        .query_map(params![owner(reference),crate::async_compaction::ENGINE_CACHE_RECOVERY_SLOT],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let state = encode(&state)?;
    conn.execute("INSERT INTO main.mc_async_compaction(session_ref,conversation_key,session,state_json,version_high_water) VALUES(?1,?2,?3,?4,?5)",params![reference,current.key,current.session,state,current.version_high_water])?;
    for entry in entries {
        conn.execute("INSERT INTO main.mc_async_compaction_entries(session_ref,session,ordinal,entry_json,index_json,mid) VALUES(?1,?2,?3,?4,?5,?6)",params![reference,current.session,entry.ordinal,entry.entry_json,entry.index_json,entry.mid])?;
    }
    for view in views {
        conn.execute("INSERT INTO main.mc_async_compaction_views(session_ref,session,version,view_json,engine_json,announced) VALUES(?1,?2,?3,?4,?5,?6)",params![reference,current.session,view.version,view.view_json,view.engine_json,view.announced])?;
    }
    for (slot, value) in baselines {
        conn.execute("INSERT INTO main.mc_async_compaction_baselines(session_ref,session,slot,view_json) VALUES(?1,?2,?3,?4)",params![reference,current.session,slot,value])?;
    }
    clear_owned(conn, reference)?;
    Ok(true)
}

pub(super) fn install_views(conn: &Connection) -> rusqlite::Result<()> {
    let installed = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_temp_master WHERE type='view' AND name='mc_async_compaction')", [], |row| row.get::<_,bool>(0))?;
    if !installed {
        conn.execute_batch(include_str!("async_compaction_views.sql"))?;
    }
    Ok(())
}

fn relation(table: &str) -> &'static str {
    let script = include_str!("async_compaction_views.sql");
    let marker = format!("CREATE TEMP VIEW IF NOT EXISTS {table} AS\n");
    script
        .split_once(&marker)
        .expect("async inspection relation")
        .1
        .split_once(';')
        .expect("async inspection relation end")
        .0
}

/// Read-only counterpart of the inspection views. CTEs work on query-only
/// readers without creating even temporary schema objects.
pub(super) fn read_sql(sql: &str) -> std::borrow::Cow<'_, str> {
    if !needs_expansion(sql) {
        return std::borrow::Cow::Borrowed(sql);
    }
    expand_current_sql(sql)
}

fn needs_expansion(sql: &str) -> bool {
    let start = sql.trim_start().to_ascii_uppercase();
    (start.contains("FROM MC_ASYNC_COMPACTION") || start.contains("JOIN MC_ASYNC_COMPACTION"))
        && !sql.contains("async-v2-direct")
        && (start.starts_with("SELECT ")
            || start.starts_with("WITH ")
            || start.starts_with("EXPLAIN QUERY PLAN "))
}

/// Before migration 75, entries have no MID column and no provider KV family
/// can exist. Preserve those historical tables' own column shape instead of
/// preparing a current-layout UNION against them.
pub(super) fn read_sql_at<'a>(
    conn: &Connection,
    sql: &'a str,
) -> rusqlite::Result<std::borrow::Cow<'a, str>> {
    if !needs_expansion(sql) || crate::single_store_schema::recorded_store_version(conn)? < 75 {
        return Ok(std::borrow::Cow::Borrowed(sql));
    }
    Ok(expand_current_sql(sql))
}

fn expand_current_sql(sql: &str) -> std::borrow::Cow<'_, str> {
    let names = [
        "mc_async_compaction",
        "mc_async_compaction_entries",
        "mc_async_compaction_views",
        "mc_async_compaction_baselines",
    ];
    let ctes = names
        .iter()
        .map(|name| format!("{name} AS ({})", relation(name)))
        .collect::<Vec<_>>()
        .join(",");
    let (explain, body) = sql
        .strip_prefix("EXPLAIN QUERY PLAN ")
        .map_or(("", sql), |body| ("EXPLAIN QUERY PLAN ", body));
    let query = if let Some(body) = body.trim_start().strip_prefix("WITH ") {
        format!("{explain}WITH {ctes},{body}")
    } else {
        format!("{explain}WITH {ctes} {body}")
    };
    std::borrow::Cow::Owned(query)
}

pub(crate) const ENTRY_LOOKUP_SQL: &str = "/* async-v2-direct */
 SELECT ordinal,index_json FROM main.mc_async_compaction_entries INDEXED BY idx_mc_async_compaction_entries_mid
 WHERE session_ref=?1 AND mid=?2 AND ordinal=(SELECT MIN(ordinal) FROM main.mc_async_compaction_entries INDEXED BY idx_mc_async_compaction_entries_mid WHERE session_ref=?1 AND mid=?2)
";

pub(crate) const KV_ENTRY_LOOKUP_SQL: &str = "/* async-v2-direct */
 SELECT json_extract(e.body,'$.ordinal'),json_extract(e.body,'$.index_json')
 FROM main.mc_cache_sections e
 WHERE e.session_id='__ckmc_async_v2_record:'||?1
 AND e.section=(SELECT json_extract(body,'$') FROM main.mc_cache_sections WHERE session_id='__ckmc_async_v2_record:'||?1 AND section>='__ckmc_async_v2_mid:'||json_quote(?2)||':' AND section<'__ckmc_async_v2_mid:'||json_quote(?2)||';' ORDER BY section LIMIT 1)
";

pub(crate) const EXISTS_FOR_SESSION_SQL: &str = "SELECT EXISTS(SELECT 1 FROM main.mc_async_compaction WHERE session=?1) OR EXISTS(SELECT 1 FROM main.mc_cache_sections WHERE session_id='__ckmc_async_v2_headers' AND CASE WHEN json_valid(body) THEN json_extract(body,'$.session') END=?1)";

pub(super) fn migrate_all(conn: &Connection, session: Option<&str>) -> rusqlite::Result<()> {
    let references = conn
        .prepare("SELECT session_ref FROM main.mc_async_compaction WHERE ?1 IS NULL OR session=?1")?
        .query_map([session], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for reference in references {
        migrate(conn, &reference)?;
    }
    Ok(())
}

pub(super) fn records(
    conn: &Connection,
    session: &str,
    runner: Option<&str>,
) -> rusqlite::Result<Vec<String>> {
    let rows = conn
        .prepare(
            "SELECT section,body FROM main.mc_cache_sections WHERE session_id=?1 ORDER BY section",
        )?
        .query_map([HEADERS], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut result = Vec::new();
    for (reference, raw) in rows {
        if legacy_exists(conn, &reference)? {
            continue;
        }
        let header: Header = match decode(&raw) {
            Ok(header) => header,
            Err(error) => {
                tracing::warn!(session_ref=%reference, %error, "unreadable async record index");
                continue;
            }
        };
        if header.session != session {
            continue;
        }
        if let Some(runner) = runner {
            let key: Value = decode(&header.key)?;
            if key.get(0).and_then(Value::as_str) != Some(runner) {
                continue;
            }
        }
        result.push(header.state_json);
    }
    Ok(result)
}

pub(super) fn key_exists(conn: &Connection, key: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM main.mc_cache_sections WHERE session_id=?1 AND section=?2)",
        params![KEYS, key],
        |row| row.get(0),
    )
}

pub(super) fn remove_cut_facts(
    conn: &Connection,
    reference: &str,
    active: Option<&str>,
) -> rusqlite::Result<usize> {
    Sections::new(conn, &owner(reference))?.remove_cut_facts(active)
}

pub(super) const HOT_BASELINES_SQL: &str = "SELECT section,body FROM main.mc_cache_sections WHERE session_id='__ckmc_async_v2_record:'||?1 AND section IN ('applied','produced','frozen_edits','retired_native_edits','pending-cut-stage','setup-initial','moved-bound-drops')";

pub(super) fn hot_baselines(
    conn: &Connection,
    reference: &str,
) -> rusqlite::Result<Vec<(String, String)>> {
    conn.prepare(HOT_BASELINES_SQL)?
        .query_map([reference], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect()
}

pub(super) fn source_rows(
    conn: &Connection,
    reference: &str,
) -> rusqlite::Result<Option<super::async_compaction::AsyncCompactionRows>> {
    let Some(header) = header(conn, reference)? else {
        return Ok(None);
    };
    Ok(Some(super::async_compaction::AsyncCompactionRows {
        state: header.state_json,
        entries: entries(conn, reference, 0, i64::MAX as u64)?
            .into_iter()
            .map(|entry| (entry.ordinal, entry.entry_json, entry.index_json))
            .collect(),
        engine_views: views(conn, reference)?
            .into_iter()
            .filter_map(|view| view.engine_json.map(|raw| (view.version, raw)))
            .collect(),
        baselines: hot_baselines(conn, reference)?,
    }))
}

/// The pre-v2 section selector remains valid for engine namespaces. Reserved
/// v2 groups are selected by their opaque host-session owner, never by a name
/// that happens to equal another session's internal namespace.
pub(crate) const MOVE_SELECTOR: &str = "
 (session_id=?1 AND session_id NOT IN ('__ckmc_async_v2_headers','__ckmc_async_v2_keys','__ckmc_async_v2_outbox') AND session_id NOT GLOB '__ckmc_async_v2_record:*')
 OR (session_id IN ('__ckmc_async_v2_headers','__ckmc_async_v2_keys','__ckmc_async_v2_outbox') AND CASE WHEN json_valid(body) THEN json_extract(body,'$.session') END=?1)
 OR session_id IN (SELECT '__ckmc_async_v2_record:'||section FROM mc_cache_sections WHERE session_id='__ckmc_async_v2_headers' AND CASE WHEN json_valid(body) THEN json_extract(body,'$.session') END=?1)
";

pub(crate) fn owner_expression(side: &str) -> String {
    format!("CASE
      WHEN {side}.session_id IN ('{HEADERS}','{KEYS}','{OUTBOX}') THEN CASE WHEN json_valid({side}.body) THEN json_extract({side}.body,'$.session') END
      WHEN substr({side}.session_id,1,{length})='{CHILDREN}' THEN (SELECT CASE WHEN json_valid(h.body) THEN json_extract(h.body,'$.session') END FROM main.mc_cache_sections h WHERE h.session_id='{HEADERS}' AND h.section=substr({side}.session_id,{start}))
      ELSE {side}.session_id END", length=CHILDREN.len(),start=CHILDREN.len()+1)
}

pub(crate) fn special_owner(row: &[rusqlite::types::Value], session: &str) -> Option<bool> {
    use rusqlite::types::Value as SqlValue;
    let Some(SqlValue::Text(kind)) = row.first() else {
        return None;
    };
    if ![HEADERS, KEYS, OUTBOX].contains(&kind.as_str()) && !kind.starts_with(CHILDREN) {
        return None;
    }
    let [SqlValue::Text(owner), SqlValue::Text(_), SqlValue::Text(body)] = row else {
        return Some(false);
    };
    if [HEADERS, KEYS, OUTBOX].contains(&owner.as_str()) {
        return Some(
            serde_json::from_str::<Value>(body)
                .ok()
                .and_then(|value| value["session"].as_str().map(|owner| owner == session))
                .unwrap_or(false),
        );
    }
    if let Some(reference) = owner.strip_prefix(CHILDREN) {
        // Cross-row ownership is checked against the staged source header
        // catalogue before installation; a destination cannot supply it.
        return Some(!reference.is_empty());
    }
    None
}

#[cfg(test)]
#[path = "async_compaction_layout_tests.rs"]
mod tests;
