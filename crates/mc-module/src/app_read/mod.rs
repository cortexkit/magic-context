//! Read-only app projections. Workers send projections without waiting; a separate
//! thread owns their replica and its SQLite connections. App reads never enter a
//! session's job queue or borrow a worker's database connection.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use cortexkit_role_compaction::{read::SessionRef, wire::Refusal};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

pub(crate) mod persistence;
mod search;
mod states;
mod watch;
pub use watch::Subscription;

/// Direct is deliberately admitted while the local operator apps are in
/// development. Before release, replace this single admission with a check of
/// the daemon's operator_app stamp identifying a person-operated app, not an
/// agent or flow. Project or user configuration must not widen this authority.
pub const DEVELOPMENT_ADMITS_DIRECT: bool = true;
pub const ROLE: (&str, &str) = ("mc-app-read", "v1");

pub(crate) fn result_bytes(value: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"result":value})).expect("app reply JSON")
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionState {
    pub last_model: Option<String>,
    pub failures: u64,
    pub last_error: Option<String>,
    #[serde(with = "stamp_map")]
    pub stamps: BTreeMap<(String, String), u64>,
}

mod stamp_map {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        map: &BTreeMap<(String, String), u64>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        map.iter().collect::<Vec<_>>().serialize(serializer)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<BTreeMap<(String, String), u64>, D::Error> {
        Ok(Vec::<((String, String), u64)>::deserialize(deserializer)?
            .into_iter()
            .collect())
    }
}

#[derive(PartialEq, Serialize, Deserialize)]
pub(crate) struct Header {
    pub base: u64,
    pub newest: u64,
    pub ready: bool,
    pub meta: Value,
    pub breakdown: Breakdown,
}

impl Header {
    /// This header as compact JSON: the bytes `serde_json::to_string` writes
    /// for it, with the breakdown's summary items copied from the JSON made
    /// with them instead of serialized again ([`Breakdown::write_json`]).
    pub(crate) fn json(&self) -> String {
        let mut out = format!(
            "{{\"base\":{},\"newest\":{},\"ready\":{},\"meta\":{},\"breakdown\":",
            self.base, self.newest, self.ready, self.meta
        );
        self.breakdown.write_json(&mut out);
        out.push('}');
        out
    }
}

/// The summary items that end a token breakdown's `items` list, one per
/// summary the history head renders, with their compact JSON.
#[derive(Debug, Default)]
pub(crate) struct BreakdownSummaries {
    items: Vec<Value>,
    /// `items` as serde_json writes them, separated by commas, without the
    /// list's brackets.
    json: String,
}

impl BreakdownSummaries {
    pub(crate) fn new(items: Vec<Value>) -> Self {
        let json = items
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join(",");
        Self { items, json }
    }
}

/// A session's token breakdown, as `session_data.read` returns it in
/// `token_breakdown`. Every step changes some of its members, but its
/// summary items change only with the history head's baseline, and there is
/// one per summary. So they are kept apart, in one list that updates share:
/// otherwise copying and comparing the breakdown on each step would cost
/// more the more summaries a session has. It compares, reads and serializes
/// as the one JSON object it stands for ([`Breakdown::to_value`]).
///
/// The summary items kept apart are exactly the `"item":"summary"` items
/// that end the `items` list, so two breakdowns are equal exactly when the
/// objects they stand for are.
#[derive(Clone, Debug, Default)]
pub(crate) struct Breakdown {
    /// Every member, except that `items` stops before the summary items.
    value: Value,
    summaries: Arc<BreakdownSummaries>,
}

impl Breakdown {
    /// `value`'s `items` list must not end with a summary item: those are
    /// `summaries`, which need `value` to have an `items` list.
    pub(crate) fn new(value: Value, summaries: Arc<BreakdownSummaries>) -> Self {
        debug_assert!(summaries.items.is_empty() || value["items"].is_array());
        debug_assert!(value["items"]
            .as_array()
            .and_then(|items| items.last())
            .is_none_or(|last| last["item"] != "summary"));
        Self { value, summaries }
    }

    /// The breakdown that `value` is, with the summary items ending its
    /// `items` list kept apart.
    pub(crate) fn from_value(mut value: Value) -> Self {
        let summaries = match value.get_mut("items").and_then(Value::as_array_mut) {
            Some(items) => {
                let trailing = items
                    .iter()
                    .rev()
                    .take_while(|item| item["item"] == "summary")
                    .count();
                items.split_off(items.len() - trailing)
            }
            None => Vec::new(),
        };
        Self {
            value,
            summaries: Arc::new(BreakdownSummaries::new(summaries)),
        }
    }

    /// The whole breakdown as one JSON object.
    pub(crate) fn to_value(&self) -> Value {
        let mut value = self.value.clone();
        if let Some(items) = value.get_mut("items").and_then(Value::as_array_mut) {
            items.extend(self.summaries.items.iter().cloned());
        }
        value
    }

    /// Every member but the summary items: `items` stops before them.
    pub(crate) fn without_summaries(&self) -> &Value {
        &self.value
    }

    /// Append the bytes serde_json writes for this breakdown to `out`,
    /// copying the summary items' JSON as it was made with them. JSON objects
    /// keep their members in key order, so this follows the same order.
    fn write_json(&self, out: &mut String) {
        let Some(members) = self
            .value
            .as_object()
            .filter(|_| !self.summaries.items.is_empty())
        else {
            out.push_str(&self.value.to_string());
            return;
        };
        out.push('{');
        for (index, (key, value)) in members.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&Value::from(key.as_str()).to_string());
            out.push(':');
            if key == "items" {
                out.push('[');
                for item in value.as_array().map(Vec::as_slice).unwrap_or_default() {
                    out.push_str(&item.to_string());
                    out.push(',');
                }
                out.push_str(&self.summaries.json);
                out.push(']');
            } else {
                out.push_str(&value.to_string());
            }
        }
        out.push('}');
    }
}

impl PartialEq for Breakdown {
    fn eq(&self, other: &Self) -> bool {
        // Updates share one summary list until the baseline changes, so the
        // items are compared only when the lists differ.
        self.value == other.value
            && (Arc::ptr_eq(&self.summaries, &other.summaries)
                || self.summaries.items == other.summaries.items)
    }
}

/// A member other than `items`, whose summary items are kept apart: read
/// the whole list from [`Breakdown::to_value`].
impl std::ops::Index<&str> for Breakdown {
    type Output = Value;
    fn index(&self, key: &str) -> &Value {
        assert_ne!(key, "items", "a breakdown's items are read from to_value()");
        &self.value[key]
    }
}

impl Serialize for Breakdown {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{SerializeMap, SerializeSeq};
        struct Items<'a>(&'a Value, &'a [Value]);
        impl Serialize for Items<'_> {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let leading = self.0.as_array().map(Vec::as_slice).unwrap_or_default();
                let mut list = serializer.serialize_seq(Some(leading.len() + self.1.len()))?;
                for item in leading.iter().chain(self.1) {
                    list.serialize_element(item)?;
                }
                list.end()
            }
        }
        let Some(members) = self
            .value
            .as_object()
            .filter(|_| !self.summaries.items.is_empty())
        else {
            return self.value.serialize(serializer);
        };
        let mut map = serializer.serialize_map(Some(members.len()))?;
        for (key, value) in members {
            if key == "items" {
                map.serialize_entry(key, &Items(value, &self.summaries.items))?;
            } else {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for Breakdown {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Value::deserialize(deserializer).map(Self::from_value)
    }
}

pub(crate) struct Update {
    pub key: SessionRef,
    pub header: Arc<Header>,
    pub rows: Vec<(String, Arc<Message>)>,
    pub reset_from: Option<u64>,
    pub prune_before: Option<u64>,
    pub compartments: Option<Arc<Vec<Value>>>,
    pub decisions: Option<Arc<Vec<Value>>>,
    pub reverted: bool,
}

#[derive(Clone)]
pub(crate) struct IndexRow {
    pub mid: String,
    pub ordinal: u64,
    pub at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Message {
    pub ordinal: u64,
    pub at_ms: u64,
    pub row: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Snapshot {
    pub key: SessionRef,
    pub base: u64,
    pub newest: u64,
    pub ready: bool,
    pub meta: Value,
    pub breakdown: Breakdown,
    pub compartments: Vec<Value>,
    pub messages: BTreeMap<String, Message>,
    pub decisions: Vec<Value>,
}

#[derive(Clone)]
pub struct AppRead {
    tx: mpsc::Sender<Command>,
}

enum Command {
    #[cfg(test)]
    Publish(Box<Snapshot>),
    Update(Update),
    Read(String, Value, oneshot::Sender<Result<Value, Refusal>>),
    Watch(
        String,
        Value,
        oneshot::Sender<Result<Subscription, Refusal>>,
    ),
}

type BoundaryIndex = HashMap<String, Vec<(usize, &'static str)>>;

struct Replica {
    snapshots: HashMap<SessionRef, Snapshot>,
    boundaries: HashMap<SessionRef, BoundaryIndex>,
    known: HashSet<SessionRef>,
    load_failed: bool,
    store: Option<Connection>,
    context: Option<Connection>,
    watches: watch::Hub,
}

impl AppRead {
    pub(crate) fn new(store: Option<PathBuf>, context: Option<PathBuf>) -> Self {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("mc-app-read".into())
            .spawn(move || {
                let store_expected = store.is_some();
                let store = store.and_then(|path| {
                    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
                });
                if let Some(conn) = &store {
                    let _ = conn.busy_timeout(std::time::Duration::ZERO);
                }
                let context = context.and_then(|path| {
                    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
                });
                if let Some(conn) = &context {
                    let _ = conn.busy_timeout(std::time::Duration::ZERO);
                }
                let mut replica = Replica {
                    snapshots: HashMap::new(),
                    boundaries: HashMap::new(),
                    known: HashSet::new(),
                    load_failed: store_expected && store.is_none(),
                    store,
                    context,
                    watches: watch::Hub::new(),
                };
                replica.load();
                while let Ok(command) = rx.recv() {
                    match command {
                        #[cfg(test)]
                        Command::Publish(snapshot) => replica.publish(*snapshot),
                        Command::Update(update) => replica.update(update),
                        Command::Read(method, params, reply) => {
                            let _ = reply.send(replica.read(&method, &params));
                        }
                        Command::Watch(caller, params, reply) => {
                            let result = replica.subscribe(caller, &params);
                            let _ = reply.send(result);
                        }
                    }
                }
            })
            .expect("app read replica thread");
        Self { tx }
    }

    #[cfg(test)]
    pub(crate) fn publish(&self, snapshot: Snapshot) {
        let _ = self.tx.send(Command::Publish(Box::new(snapshot)));
    }

    pub(crate) fn update(&self, update: Update) {
        let _ = self.tx.send(Command::Update(update));
    }

    pub async fn read(&self, method: &str, params: Value) -> Result<Value, Refusal> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Read(method.to_owned(), params, tx))
            .map_err(|_| unavailable())?;
        rx.await.map_err(|_| unavailable())?
    }

    pub async fn watch(&self, caller: String, params: Value) -> Result<Subscription, Refusal> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Watch(caller, params, tx))
            .map_err(|_| unavailable())?;
        rx.await.map_err(|_| unavailable())?
    }
}

impl Replica {
    fn load(&mut self) {
        let Some(conn) = &self.store else {
            return;
        };
        let keys = (|| -> rusqlite::Result<Vec<SessionRef>> {
            conn.prepare("SELECT runner,harness,session FROM sessions")?
                .query_map([], |row| {
                    Ok(SessionRef::new(
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect()
        })();
        match keys {
            Ok(keys) => self.known.extend(keys),
            Err(error) => {
                self.load_failed = true;
                tracing::warn!("ck-mc: app session lookup: {error}");
            }
        }
        let rows = persistence::load(conn);
        match rows {
            Ok(rows) => {
                for snapshot in rows {
                    self.publish(snapshot);
                }
            }
            Err(error) => {
                self.load_failed = true;
                tracing::warn!("ck-mc: app replica load: {error}");
            }
        }
        let decisions = (|| -> rusqlite::Result<Vec<(SessionRef, String)>> {
            let Some(conn) = &self.store else {
                return Ok(Vec::new());
            };
            conn.prepare("SELECT runner,harness,session,decisions FROM app_read_decisions")?
                .query_map([], |row| {
                    Ok((
                        SessionRef::new(
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ),
                        row.get(3)?,
                    ))
                })?
                .collect()
        })();
        if let Ok(decisions) = decisions {
            for (key, text) in decisions {
                if let Some(snapshot) = self.snapshots.get_mut(&key) {
                    if let Ok(rows) = serde_json::from_str(&text) {
                        snapshot.decisions = rows;
                    }
                }
            }
        }
    }

    fn publish(&mut self, mut snapshot: Snapshot) {
        if snapshot.breakdown.without_summaries().get("items").is_none() {
            // Older snapshots retain block totals, but not summary tiers or
            // part identities. Upgrade only the attribution they can prove.
            // Without an `items` list a breakdown keeps no summary items
            // apart, so its value is the whole breakdown.
            let mut breakdown = snapshot.breakdown.to_value();
            let parts = breakdown["parts"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            breakdown["items"] = json!(["system_prompt", "tool_definitions", "memory", "project_docs", "user_profile"].into_iter().filter_map(|name| {
                let part = parts.iter().find(|part| part["part"] == name)?;
                Some(json!({"item":name,"tokens":part["tokens"],"source":if matches!(name, "system_prompt" | "tool_definitions") {
                    if part["tokens"].is_null() {"estimate"} else {"runner"}
                } else {"counted"}}))
            }).collect::<Vec<_>>());
            snapshot.breakdown = Breakdown::from_value(breakdown);
        }
        if let Some(previous) = self
            .snapshots
            .get(&snapshot.key)
            .filter(|_| self.store.is_none())
        {
            // In-memory fixtures have no durable message index. Keep prior
            // messages before the new base only if they are no later than
            // the newest message, excluding history removed by a revert.
            for (mid, message) in &previous.messages {
                if message.ordinal < snapshot.base && message.ordinal <= snapshot.newest {
                    snapshot
                        .messages
                        .entry(mid.clone())
                        .or_insert_with(|| message.clone());
                }
            }
        }
        self.enrich(&mut snapshot);
        if self.snapshots.get(&snapshot.key) == Some(&snapshot) {
            return;
        }
        let key = snapshot.key.clone();
        self.boundaries
            .insert(key.clone(), boundary_index(&snapshot));
        self.snapshots.insert(key.clone(), snapshot);
        self.watches.changed(key);
    }

    fn enrich(&self, snapshot: &mut Snapshot) {
        for compartment in &mut snapshot.compartments {
            for (id, time) in [
                ("first_message_id", "first_at_ms"),
                ("last_message_id", "last_at_ms"),
            ] {
                let at_ms = compartment[id].as_str().and_then(|mid| snapshot.messages.get(mid)).map(|message| message.at_ms)
                .or_else(|| self.store.as_ref().and_then(|conn| conn.query_row("SELECT at_ms FROM app_read_message_index WHERE runner=?1 AND harness=?2 AND session=?3 AND message_id=?4",params![snapshot.key.runner,snapshot.key.harness,snapshot.key.session,compartment[id].as_str()], |row| row.get::<_,u64>(0)).ok()))
                .or_else(|| {
                    let ordinal = if id == "first_message_id" { &compartment["first_message_ordinal"] } else { &compartment["last_message_ordinal"] };
                    self.context.as_ref().and_then(|conn| conn.query_row("SELECT map.message_time_ms FROM message_fts_rowid_map map JOIN message_history_source src USING(session_id,message_ordinal) WHERE map.session_id=?1 AND src.harness=?2 AND src.message_id=?3 AND map.message_ordinal=?4", params![snapshot.key.session,snapshot.key.harness,compartment[id].as_str(),ordinal.as_u64()], |row| row.get::<_,Option<u64>>(0)).ok().flatten())
                });
                compartment[time] = json!(at_ms);
            }
        }
    }

    fn update(&mut self, update: Update) {
        let _timing = crate::notice_cost_timing::span("app.replica");
        let key = update.key;
        let h = update.header;
        let mut snapshot = self.snapshots.remove(&key).unwrap_or_else(|| Snapshot {
            key: key.clone(),
            base: 0,
            newest: 0,
            ready: false,
            meta: Value::Null,
            breakdown: Breakdown::default(),
            compartments: Vec::new(),
            messages: BTreeMap::new(),
            decisions: Vec::new(),
        });
        let mut changed = snapshot.base != h.base
            || snapshot.newest != h.newest
            || snapshot.ready != h.ready
            || snapshot.meta != h.meta
            || snapshot.breakdown != h.breakdown;
        snapshot.base = h.base;
        snapshot.newest = h.newest;
        snapshot.ready = h.ready;
        snapshot.meta = h.meta.clone();
        snapshot.breakdown = h.breakdown.clone();
        if let Some(from) = update.reset_from {
            let before = snapshot.messages.len();
            snapshot
                .messages
                .retain(|_, message| message.ordinal < from && message.ordinal <= h.newest);
            changed |= before != snapshot.messages.len();
        }
        if self.store.is_some() {
            if let Some(base) = update.prune_before {
                snapshot
                    .messages
                    .retain(|_, message| message.ordinal >= base);
            }
        }
        for (mid, row) in update.rows {
            if let Some(boundaries) = self.boundaries.get(&key).and_then(|index| index.get(&mid)) {
                for (index, field) in boundaries {
                    if let Some(compartment) = snapshot.compartments.get_mut(*index) {
                        let at = json!(row.at_ms);
                        changed |= compartment[*field] != at;
                        compartment[*field] = at;
                    }
                }
            }
            if snapshot.messages.get(&mid) != Some(row.as_ref()) {
                snapshot.messages.insert(mid, (*row).clone());
                changed = true;
            }
        }
        if let Some(compartments) = update.compartments {
            snapshot.compartments = (*compartments).clone();
            self.enrich(&mut snapshot);
            self.boundaries
                .insert(key.clone(), boundary_index(&snapshot));
            changed = true;
        }
        if let Some(decisions) = update.decisions {
            snapshot.decisions = (*decisions).clone();
            changed = true;
        }
        self.snapshots.insert(key.clone(), snapshot);
        if changed {
            self.watches.changed(key);
        }
    }

    fn locate(&self, key: &SessionRef) -> Result<&Snapshot, Refusal> {
        let mut candidates = self
            .known
            .iter()
            .chain(self.snapshots.keys())
            .filter(|s| s.harness == key.harness && s.session == key.session)
            .collect::<HashSet<_>>()
            .into_iter();
        let Some(actual) = candidates.next() else {
            if self.load_failed {
                return Err(error(
                    "store_unavailable",
                    "The session store could not be read.",
                ));
            }
            return Err(error(
                "session_not_found",
                "No session matches the reference.",
            ));
        };
        if candidates.next().is_some() {
            return Err(error(
                "session_ambiguous",
                "More than one conversation matches the session.",
            ));
        }
        if actual.runner != key.runner {
            return Err(Refusal::new(
                "session_runner_mismatch",
                "The session belongs to another runner.",
                Some(json!({"runner": actual.runner})),
            ));
        }
        // A crash may leave the write-ahead session record before its first
        // projection. The runner identity is still known; missing read state
        // is temporary, not a lasting session_not_found refusal.
        self.snapshots.get(actual).ok_or_else(|| {
            error(
                "store_unavailable",
                "The session read projection is not ready.",
            )
        })
    }

    fn read(&self, method: &str, params: &Value) -> Result<Value, Refusal> {
        let allowed: &[&str] = match method {
            "session_data.read" => &["session", "section", "if_version"],
            "context.states" => &["session", "message_ids", "if_version"],
            "context.compartment" => &["session", "compartment_id"],
            "context.cache_why" => &["session", "producers"],
            "context.search" => &["query", "scope", "sources", "cursor"],
            _ => return Err(unavailable()),
        };
        let p = object(params, allowed)?;
        if method == "context.search" {
            return self.search(p);
        }
        let key = session(p.get("session").unwrap_or(&Value::Null))?;
        let snapshot = self.locate(&key)?;
        let mut fields = match method {
            "session_data.read" => {
                let section = string(p, "section")?;
                let breakdown;
                let row = match section {
                    "meta" => &snapshot.meta,
                    "token_breakdown" if snapshot.ready => {
                        breakdown = snapshot.breakdown.to_value();
                        &breakdown
                    }
                    "token_breakdown" => {
                        return Err(error(
                            "store_unavailable",
                            "The session transcript is not ready.",
                        ))
                    }
                    _ => return Err(unavailable()),
                };
                let mut result = conditional(p, row)?;
                result["section"] = json!(section);
                if result["state"] == "ready" {
                    result["row"] = row.clone();
                }
                result
            }
            "context.states" => {
                let ids = strings(p.get("message_ids"), 100)?;
                if !snapshot.ready {
                    return Err(error(
                        "store_unavailable",
                        "The session transcript is not ready.",
                    ));
                }
                let messages: Vec<Value> = ids.iter().map(|mid| {
                    let ordinal = if snapshot.messages.contains_key(mid) { None } else {
                        self.store.as_ref().and_then(|conn| conn.query_row("SELECT ordinal FROM app_read_message_index WHERE runner=?1 AND harness=?2 AND session=?3 AND message_id=?4",params![key.runner,key.harness,key.session,mid], |row| row.get::<_,u64>(0)).ok())
                            .or_else(|| self.context.as_ref().and_then(|conn| conn.query_row("SELECT message_ordinal FROM message_history_source WHERE session_id=?1 AND harness=?2 AND message_id=?3", params![key.session,key.harness,mid], |row| row.get::<_,u64>(0)).ok()))
                    };
                    states::message_state(snapshot, mid, ordinal)
                }).collect();
                // A page lists only the summaries its requested messages touch.
                let compartments: Vec<Value> = snapshot.compartments.iter().filter(|c| messages.iter().any(|m| !m["compartment_id"].is_null() && m["compartment_id"] == c["compartment_id"])).map(|c| json!({"compartment_id":c["compartment_id"], "ordinal":c["ordinal"], "first_message_id":c["first_message_id"], "last_message_id":c["last_message_id"]})).collect();
                let body = json!({"messages":messages, "compartments":compartments});
                let mut result = conditional(p, &body)?;
                if result["state"] == "ready" {
                    result["messages"] = body["messages"].clone();
                    result["compartments"] = body["compartments"].clone();
                }
                result["session_kind"] = json!("mode3");
                result["moved_from_standalone"] = json!(false);
                result
            }
            "context.compartment" => {
                let id = string(p, "compartment_id")?;
                let row = snapshot
                    .compartments
                    .iter()
                    .find(|c| c["compartment_id"] == id)
                    .ok_or_else(|| {
                        error("compartment_not_found", "No compartment matches the id.")
                    })?;
                json!({"state":"ready", "version":version(row), "compartment":row})
            }
            "context.cache_why" => {
                let producers = p
                    .get("producers")
                    .and_then(Value::as_array)
                    .filter(|v| !v.is_empty() && v.len() <= 100)
                    .ok_or_else(|| invalid("producers"))?;
                for producer in producers {
                    let producer = object(producer, &["producer_ref", "at_ms"])?;
                    if string(producer, "producer_ref")?.len() > 512 {
                        return Err(invalid("producer_ref"));
                    }
                    if producer
                        .get("at_ms")
                        .is_some_and(|v| !v.is_null() && v.as_i64().is_none())
                    {
                        return Err(invalid("at_ms"));
                    }
                }
                // Compaction entries expose mid and generated_under, but not
                // llm-runner's run_id/step_id/attempt_id. None can be derived
                // from an ordinal or notice sequence, including after reverts.
                json!({"join":"unavailable", "join_reason":"runner_step_identity_not_recorded", "producer_ref_kind":null, "session_kind":"mode3", "managed":{"value":snapshot.breakdown.without_summaries()["managed"]["value"], "by":"ck_mc"}, "missing":[], "decisions":[], "next_cursor":null, "retention":{"max_rows":256, "oldest_retained_at_ms":snapshot.decisions.first().map(|v| &v["at_ms"])}})
            }
            _ => unreachable!(),
        };
        envelope(method, &mut fields);
        Ok(fields)
    }
}

fn boundary_index(snapshot: &Snapshot) -> BoundaryIndex {
    // Late transcript entries can fill summary boundary dates. Index those
    // references once instead of rescanning every summary on each append.
    let mut index = BoundaryIndex::new();
    for (ordinal, compartment) in snapshot.compartments.iter().enumerate() {
        for (id, time) in [
            ("first_message_id", "first_at_ms"),
            ("last_message_id", "last_at_ms"),
        ] {
            if let Some(mid) = compartment[id].as_str().filter(|mid| !mid.is_empty()) {
                index
                    .entry(mid.to_owned())
                    .or_default()
                    .push((ordinal, time));
            }
        }
    }
    index
}

fn conditional(p: &Map<String, Value>, row: &Value) -> Result<Value, Refusal> {
    let version = version(row);
    let previous = p
        .get("if_version")
        .filter(|v| !v.is_null())
        .map(|v| {
            v.as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| invalid("if_version"))
        })
        .transpose()?;
    Ok(
        json!({"state":if previous == Some(&version) {"unchanged"} else {"ready"}, "version":version}),
    )
}

pub(crate) fn version(value: &Value) -> String {
    format!(
        "mca1:{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("JSON"))
    )
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn envelope(method: &str, fields: &mut Value) {
    fields["schema"] = json!(1);
    fields["op"] = json!(method);
    fields["as_of_ms"] = json!(now_ms());
}
pub(crate) fn error(code: &str, message: &str) -> Refusal {
    Refusal::new(code, message, None)
}
pub(crate) fn invalid(field: &str) -> Refusal {
    Refusal::new(
        "invalid_params",
        format!("Invalid {field}."),
        Some(json!({"field":field})),
    )
}
fn unavailable() -> Refusal {
    error("app_op_unavailable", "This app operation is not available.")
}
pub(crate) fn object<'a>(
    value: &'a Value,
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, Refusal> {
    let p = value.as_object().ok_or_else(|| invalid("params"))?;
    if p.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid("unknown_field"));
    }
    Ok(p)
}
pub(crate) fn string<'a>(p: &'a Map<String, Value>, key: &str) -> Result<&'a str, Refusal> {
    p.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.contains('\0'))
        .ok_or_else(|| invalid(key))
}
pub(crate) fn session(value: &Value) -> Result<SessionRef, Refusal> {
    let p = object(value, &["runner", "harness", "session"])?;
    Ok(SessionRef::new(
        string(p, "runner")?,
        string(p, "harness")?,
        string(p, "session")?,
    ))
}
pub(crate) fn strings(value: Option<&Value>, limit: usize) -> Result<Vec<String>, Refusal> {
    let values = value
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty() && v.len() <= limit)
        .ok_or_else(|| invalid("list"))?;
    let mut result = Vec::new();
    for v in values {
        let s = v
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 512 && !s.contains('\0'))
            .ok_or_else(|| invalid("list"))?;
        if result.iter().any(|v| v == s) {
            return Err(invalid("duplicate"));
        }
        result.push(s.to_owned());
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
