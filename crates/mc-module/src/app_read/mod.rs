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

mod cache;
mod dreamer;
pub(crate) mod head;
pub(crate) mod idle;
mod memories;
mod pages;
pub(crate) mod persistence;
mod search;
pub(crate) mod sessions;
mod states;
mod watch;
pub(crate) use watch::Change;
pub use watch::Subscription;

/// Direct is deliberately admitted while the local operator apps are in
/// development. Before release, replace this single admission with a check of
/// the daemon's operator_app stamp identifying a person-operated app, not an
/// agent or flow. Project or user configuration must not widen this authority.
pub const DEVELOPMENT_ADMITS_DIRECT: bool = true;
pub const ROLE: (&str, &str) = ("mc-app-read", "v1");
pub(crate) const REPLY_BUDGET: usize = 512 * 1024;

pub(crate) fn reply_bytes(method: &str, value: Value) -> Result<Vec<u8>, Refusal> {
    let bytes = result_bytes(value);
    if bytes.len() > REPLY_BUDGET {
        return Err(error(
            "reply_too_large",
            &format!("App reply for {method} exceeds the frame budget."),
        ));
    }
    Ok(bytes)
}

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

    /// Whether both hold the one summary list a single update made.
    #[cfg(test)]
    pub(crate) fn shares_summaries(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.summaries, &other.summaries)
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
    pub head: head::ReadState,
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
    CacheStats(oneshot::Sender<(usize, usize)>),
    #[cfg(test)]
    LoadGate(mpsc::Sender<()>, mpsc::Receiver<()>),
    Activate(SessionRef, oneshot::Sender<()>),
    #[cfg(test)]
    Publish(Box<Snapshot>),
    Update(Update),
    ForgetSession(SessionRef, bool),
    Read(String, Value, oneshot::Sender<Result<Value, Refusal>>),
    RunnerHead(
        String,
        Value,
        cortexkit_role_compaction::view::AppliedViewAnswer,
        oneshot::Sender<Result<Value, Refusal>>,
    ),
    Watch(
        String,
        Value,
        oneshot::Sender<Result<Subscription, Refusal>>,
    ),
    /// A session set up in this process: its key, project id, project
    /// folder and preset.
    SessionSeen(SessionRef, String, String, String),
    /// Whether a session of the project has been set up with the module,
    /// as the project reads decide it.
    KnowsProject(String, oneshot::Sender<bool>),
    Changed(Change),
    Attach(sessions::Attachment),
}

/// Where the module's writers tell the app reads what they changed, so open
/// pages reload on a notice instead of a timer.
#[derive(Clone)]
pub(crate) struct Notifier(mpsc::Sender<Command>);

impl Notifier {
    pub(crate) fn changed(&self, change: Change) {
        let _ = self.0.send(Command::Changed(change));
    }
}

type BoundaryIndex = HashMap<String, Vec<(usize, &'static str)>>;

struct Replica {
    cache: cache::Cache,
    snapshots: HashMap<SessionRef, Snapshot>,
    boundaries: HashMap<SessionRef, BoundaryIndex>,
    known: HashSet<SessionRef>,
    load_failed: bool,
    store: Option<Connection>,
    context: Option<Connection>,
    watches: watch::Hub,
    heads: HashMap<SessionRef, head::ReadState>,
    idle_heads: std::cell::RefCell<HashMap<SessionRef, idle::KeptHead>>,
    head_warnings: std::cell::RefCell<HashSet<(SessionRef, u64)>>,
    apps: sessions::Apps,
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
                    cache: Default::default(),
                    snapshots: HashMap::new(),
                    boundaries: HashMap::new(),
                    known: HashSet::new(),
                    load_failed: store_expected && store.is_none(),
                    store,
                    context,
                    watches: watch::Hub::new(),
                    heads: HashMap::new(),
                    idle_heads: Default::default(),
                    head_warnings: Default::default(),
                    apps: Default::default(),
                };
                replica.load();
                loop {
                    replica.evict_idle(std::time::Instant::now());
                    let command = match rx.recv_timeout(cache::SWEEP_EVERY) {
                        Ok(command) => command,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    };
                    match command {
                        #[cfg(test)]
                        Command::CacheStats(reply) => {
                            let _ = reply.send((replica.cache.loads, replica.snapshots.len()));
                        }
                        #[cfg(test)]
                        Command::LoadGate(started, resume) => {
                            replica.cache.load_gate = Some((started, resume));
                        }
                        Command::Activate(key, reply) => {
                            replica.activate(&key);
                            let _ = reply.send(());
                        }
                        #[cfg(test)]
                        Command::Publish(snapshot) => replica.publish(*snapshot),
                        Command::Update(update) => replica.update(update),
                        Command::ForgetSession(key, any_runner) => {
                            replica.forget_session(&key, any_runner)
                        }
                        Command::Read(method, params, reply) => {
                            let _ = reply.send(replica.read(&method, &params));
                        }
                        Command::RunnerHead(method, params, answer, reply) => {
                            let _ = reply.send(replica.runner_head(&method, &params, answer));
                        }
                        Command::Watch(caller, params, reply) => {
                            let result = replica.subscribe(caller, &params);
                            let _ = reply.send(result);
                        }
                        Command::SessionSeen(key, project, root, preset) => {
                            replica.session_seen(key, project, root, preset)
                        }
                        Command::KnowsProject(project, reply) => {
                            let _ = reply.send(replica.apps.knows(&project));
                        }
                        Command::Changed(change) => replica.watches.publish(change),
                        Command::Attach(attachment) => replica.apps.attached = Some(attachment),
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

    pub(crate) async fn activate(&self, key: &SessionRef) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Command::Activate(key.clone(), tx)).is_ok() {
            let _ = rx.await;
        }
    }

    /// Drop everything this projection holds for a session a move took
    /// away or replaced, so no read is answered from the rows the move took
    /// or replaced. `any_runner` drops it under every runner, for an install
    /// that replaced rows every runner of the session shares. See
    /// [`Replica::forget_session`].
    pub(crate) fn forget_session(&self, key: &SessionRef, any_runner: bool) {
        let _ = self
            .tx
            .send(Command::ForgetSession(key.clone(), any_runner));
    }

    pub async fn read(&self, method: &str, params: Value) -> Result<Value, Refusal> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Read(method.to_owned(), params, tx))
            .map_err(|_| unavailable())?;
        rx.await.map_err(|_| unavailable())?
    }

    async fn runner_head(
        &self,
        method: &str,
        params: Value,
        answer: cortexkit_role_compaction::view::AppliedViewAnswer,
    ) -> Result<Value, Refusal> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::RunnerHead(method.into(), params, answer, tx))
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

    /// A session set up with a project: the project is known to the app
    /// reads from now on, with its folder and the session's preset.
    pub(crate) fn session_seen(
        &self,
        key: &SessionRef,
        project: &crate::route::Project,
        preset: &str,
    ) {
        let _ = self.tx.send(Command::SessionSeen(
            key.clone(),
            project.id.clone(),
            project.root.clone(),
            preset.to_owned(),
        ));
    }

    pub(crate) fn notifier(&self) -> Notifier {
        Notifier(self.tx.clone())
    }

    /// Whether the project is one the app reads know: a session of it was
    /// set up with the module. The person's commands on a project use the
    /// same rule, so a project the reads answer `project_unknown` for is an
    /// unknown subject to them.
    pub(crate) async fn knows_project(&self, project: &str) -> bool {
        let (tx, rx) = oneshot::channel();
        if self
            .tx
            .send(Command::KnowsProject(project.to_owned(), tx))
            .is_err()
        {
            return false;
        }
        rx.await.unwrap_or(false)
    }

    /// Hand the reads the module's settings and dreamer.
    pub(crate) fn attach(&self, attachment: sessions::Attachment) {
        let _ = self.tx.send(Command::Attach(attachment));
    }
}

impl Replica {
    fn forget_head(&mut self, key: &SessionRef) {
        self.heads.remove(key);
        self.idle_heads.borrow_mut().remove(key);
        self.head_warnings
            .borrow_mut()
            .retain(|(session, _)| session != key);
    }

    /// Drop the session's projection, its message boundaries, the heads
    /// captured for it, and the note that this process knows it. A read of
    /// the session is then answered as for a session this process has
    /// never seen, until its next Setup projects it again. Watchers of the
    /// session are told it changed, so they read it again.
    fn forget_session(&mut self, key: &SessionRef, any_runner: bool) {
        let matches = |other: &SessionRef| {
            if any_runner {
                other.harness == key.harness && other.session == key.session
            } else {
                other == key
            }
        };
        let mut sessions: HashSet<SessionRef> = self
            .known
            .iter()
            .chain(self.snapshots.keys())
            .chain(self.cache.checkpoints.iter())
            .chain(self.cache.active.iter())
            .chain(self.boundaries.keys())
            .chain(self.heads.keys())
            .filter(|other| matches(other))
            .cloned()
            .collect();
        sessions.extend(
            self.idle_heads
                .borrow()
                .keys()
                .filter(|other| matches(other))
                .cloned(),
        );
        sessions.extend(
            self.head_warnings
                .borrow()
                .iter()
                .map(|(other, _)| other)
                .filter(|other| matches(other))
                .cloned(),
        );
        for session in sessions {
            self.forget_head(&session);
            self.boundaries.remove(&session);
            self.known.remove(&session);
            let checkpoint = self.cache.checkpoints.remove(&session);
            self.cache.active.remove(&session);
            self.cache.used.remove(&session);
            self.cache.pending.remove(&session);
            if self.snapshots.remove(&session).is_some() || checkpoint {
                self.watches.changed(session);
            }
        }
    }

    fn warn_head(&self, key: &SessionRef, result: &Value) {
        let version = result["as_of"]["view"].as_u64();
        let other = result["messages"].as_array().is_some_and(|messages| {
            messages.iter().any(|message| {
                message["sections"].as_array().is_some_and(|sections| {
                    sections.iter().any(|section| section["kind"] == "other")
                })
            })
        });
        if let Some(version) = version.filter(|_| other) {
            if self
                .head_warnings
                .borrow_mut()
                .insert((key.clone(), version))
            {
                tracing::warn!("ck-mc: session {}: context.head view {} has an unrecognized section; serving its remaining text unsplit",key.session,version);
            }
        }
    }
    fn upgrade_breakdown(&self, snapshot: &mut Snapshot) {
        if snapshot
            .breakdown
            .without_summaries()
            .get("items")
            .is_none()
        {
            // Older snapshots retain block totals, but not summary tiers or
            // part identities. Upgrade only the attribution they can prove.
            // Without an `items` list a breakdown keeps no summary items
            // apart, so its value is the whole breakdown.
            let mut breakdown = snapshot.breakdown.to_value();
            let parts = breakdown["parts"].as_array().cloned().unwrap_or_default();
            breakdown["items"] = json!(["system_prompt", "tool_definitions", "memory", "project_docs", "user_profile"].into_iter().filter_map(|name| {
                let part = parts.iter().find(|part| part["part"] == name)?;
                Some(json!({"item":name,"tokens":part["tokens"],"source":if matches!(name, "system_prompt" | "tool_definitions") {
                    if part["tokens"].is_null() {"estimate"} else {"runner"}
                } else {"counted"}}))
            }).collect::<Vec<_>>());
            snapshot.breakdown = Breakdown::from_value(breakdown);
        }
    }

    #[cfg(test)]
    fn publish(&mut self, mut snapshot: Snapshot) {
        self.upgrade_breakdown(&mut snapshot);
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
        self.activate(&update.key);
        if self.ensure_loaded(&update.key).is_err() {
            self.cache
                .pending
                .entry(update.key.clone())
                .or_default()
                .push(update);
            return;
        }
        self.apply_update(update);
    }

    fn apply_update(&mut self, update: Update) {
        let _timing = crate::notice_cost_timing::span("app.replica");
        let key = update.key;
        self.cache.checkpoints.insert(key.clone());
        self.idle_heads.borrow_mut().remove(&key);
        self.heads.insert(key.clone(), update.head);
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

    fn identity(&self, key: &SessionRef) -> Result<(), Refusal> {
        let mut candidates = self
            .known
            .iter()
            .chain(self.snapshots.keys())
            .chain(self.cache.checkpoints.iter())
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
        Ok(())
    }

    fn locate(&self, key: &SessionRef) -> Result<&Snapshot, Refusal> {
        self.identity(key)?;
        // A crash may leave the write-ahead session record before its first
        // projection. The runner identity is still known; missing read state
        // is temporary, not a lasting session_not_found refusal.
        self.snapshots.get(key).ok_or_else(|| {
            error(
                "store_unavailable",
                "The session read projection is not ready.",
            )
        })
    }

    fn read(&mut self, method: &str, params: &Value) -> Result<Value, Refusal> {
        let allowed: &[&str] = match method {
            "session_data.read" => &["session", "section", "if_version"],
            "context.states" => &["session", "message_ids", "if_version"],
            "context.head" => &["session"],
            "context.head_section" => &[
                "session",
                "view",
                "slot",
                "section",
                "part",
                "offset",
                "max_bytes",
            ],
            "context.compartment" => &["session", "compartment_id"],
            "context.cache_why" => &["session", "producers"],
            "context.search" => &["query", "scope", "sources", "cursor"],
            "memories.stats" => &["level", "owner"],
            "memories.page" => &[
                "level", "owner", "status", "category", "text", "cursor", "limit",
            ],
            "memories.get" | "dreamer.run" => &["id"],
            "observations.page" => &["cursor", "limit"],
            "facts.page" => &["project", "cursor", "limit"],
            "dreamer.status" => &["project"],
            "dreamer.runs" => &["project", "task", "cursor", "limit"],
            "sessions.page" => &["project", "harness", "preset", "cursor", "limit"],
            "notes.page" => &["project", "session", "type", "status", "cursor", "limit"],
            _ => return Err(unavailable()),
        };
        let p = object(params, allowed)?;
        if method == "context.search" {
            return self.search(p);
        }
        // Owner reads: memories, the dreamer, a project's sessions and notes.
        // None names a session to load.
        let owner_read = match method {
            "memories.stats" => Some(self.memories_stats(p)),
            "memories.page" => Some(self.memories_page(p)),
            "memories.get" => Some(self.memories_get(p)),
            "observations.page" => Some(self.observations_page(p)),
            "facts.page" => Some(self.facts_page(p)),
            "dreamer.status" => Some(self.dreamer_status(p)),
            "dreamer.runs" => Some(self.dreamer_runs(p)),
            "dreamer.run" => Some(self.dreamer_run(p)),
            "sessions.page" => Some(self.sessions_page(p)),
            "notes.page" => Some(self.notes_page(p)),
            _ => None,
        };
        if let Some(result) = owner_read {
            let mut fields = result?;
            envelope(method, &mut fields);
            return Ok(fields);
        }
        let key = session(p.get("session").unwrap_or(&Value::Null))?;
        if method == "context.head_section" {
            head::SectionRequest::parse(params)?;
        }
        self.identity(&key)?;
        let loaded = self.ensure_loaded(&key);
        let snapshot = match loaded.and_then(|()| self.locate(&key)) {
            Err(refusal)
                if matches!(method, "context.head" | "context.head_section")
                    && refusal.code == "store_unavailable"
                    && self.known.contains(&key) =>
            {
                return self
                    .kept_head(&key, method, params)
                    .unwrap_or_else(|| Err(head::not_ready()))
            }
            result => result?,
        };
        if matches!(method, "context.head" | "context.head_section") {
            if let Some(state) = self.heads.get(&key).filter(|state| state.ready) {
                self.idle_heads.borrow_mut().remove(&key);
                return self.serve_head(
                    &key,
                    method,
                    params,
                    snapshot.breakdown.without_summaries(),
                    state,
                );
            }
            if let Some(result) = self.kept_head(&key, method, params) {
                return result;
            }
            return self.serve_head(
                &key,
                method,
                params,
                snapshot.breakdown.without_summaries(),
                self.heads.get(&key).unwrap_or(&head::ReadState::default()),
            );
        }
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

#[cfg(test)]
mod lazy_tests;

#[cfg(test)]
mod fixture_tests;

#[cfg(test)]
mod memories_tests;

#[cfg(test)]
mod dreamer_tests;

#[cfg(test)]
mod sessions_tests;

#[cfg(test)]
mod samples_v13_tests;
