//! Cursor-only invalidations. One native database observer and one debounce task
//! serve all subscribers; transforms do not call this module or do extra reads.

use super::{envelope, locator, named, named_detail, AppReadContext};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use subc_client_rs::HandlerOutcome;
use tokio::sync::{mpsc, Notify};

pub(crate) const METHOD: &str = "context.watch";
const DEBOUNCE: Duration = Duration::from_secs(1);
const SLOW_MIN_MS: i64 = 10_000;
const PER_CALLER: usize = 8;
// The SDK has 64 in-flight request slots; subscriptions must leave room for reads.
const TOTAL: usize = 32;
const TRACKED_SESSIONS: usize = 256;
const SESSION_LIMIT: usize = 32;
const HISTORY: usize = 256;
const QUEUE: usize = 16;

type Key = (String, String, String);
fn key(session: &locator::SessionRef) -> Key {
    (
        session.runner.clone(),
        session.harness.clone(),
        session.session.clone(),
    )
}

pub(crate) struct Request {
    sessions: BTreeMap<Key, locator::SessionRef>,
    cursor: Option<String>,
}

impl Request {
    pub(crate) fn parse(params: &Map<String, Value>) -> Result<Self, HandlerOutcome> {
        envelope::refuse_unknown(params, &["sessions", "cursor"], "params")?;
        let sessions = params
            .get("sessions")
            .and_then(Value::as_array)
            .ok_or_else(|| envelope::invalid_field("params.sessions", "type", None))?;
        if sessions.is_empty() || sessions.len() > SESSION_LIMIT {
            return Err(envelope::invalid_field(
                "params.sessions",
                "range",
                Some(SESSION_LIMIT),
            ));
        }
        let mut parsed = BTreeMap::new();
        for (i, value) in sessions.iter().enumerate() {
            let session = locator::SessionRef::parse(value, &format!("params.sessions.{i}"))?;
            if parsed.insert(key(&session), session).is_some() {
                return Err(envelope::invalid_field(
                    "params.sessions",
                    "duplicate",
                    None,
                ));
            }
        }
        let cursor = params
            .get("cursor")
            .map(|value| {
                value
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 512)
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        named(
                            "cursor_invalid",
                            "The watch cursor must be a nonempty string of at most 512 bytes.",
                        )
                    })
            })
            .transpose()?;
        if cursor.as_deref().is_some_and(|c| parse_cursor(c).is_none()) {
            return Err(named(
                "cursor_invalid",
                "The watch cursor must have the form <epoch>:<version>.",
            ));
        }
        Ok(Self {
            sessions: parsed,
            cursor,
        })
    }
}

fn parse_cursor(cursor: &str) -> Option<(&str, u64)> {
    let (epoch, version) = cursor.split_once(':')?;
    if epoch.is_empty()
        || !epoch.bytes().all(|b| b.is_ascii_hexdigit())
        || !version.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some((epoch, version.parse().ok()?))
}

#[derive(Clone)]
struct Change {
    version: u64,
    sessions: BTreeSet<Key>,
}

struct Subscriber {
    caller: String,
    route: (u16, u32),
    sessions: BTreeMap<Key, locator::SessionRef>,
    tx: mpsc::Sender<Value>,
    lagged: Arc<std::sync::atomic::AtomicBool>,
    done: Arc<Notify>,
}

#[derive(Default)]
struct State {
    version: u64,
    resync_floor: u64,
    next_id: u64,
    subscribers: BTreeMap<u64, Subscriber>,
    snapshots: BTreeMap<Key, Snapshot>,
    history: VecDeque<Change>,
    slow: BTreeMap<Key, SlowState>,
    slow_dirty: BTreeSet<Key>,
}

pub(crate) struct Hub {
    epoch: String,
    state: Mutex<State>,
    wake: Arc<Notify>,
    observer: Mutex<Option<RecommendedWatcher>>,
    rescan: Arc<std::sync::atomic::AtomicBool>,
    active: Arc<std::sync::atomic::AtomicBool>,
}

impl Default for Hub {
    fn default() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        Self {
            epoch: format!(
                "{nanos:x}{:x}",
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ),
            state: Mutex::default(),
            wake: Arc::default(),
            observer: Mutex::default(),
            rescan: Arc::default(),
            active: Arc::default(),
        }
    }
}

pub(crate) struct Subscription {
    id: u64,
    hub: Arc<Hub>,
    pub(crate) rx: mpsc::Receiver<Value>,
    lagged: Arc<std::sync::atomic::AtomicBool>,
    done: Arc<Notify>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.hub.remove(self.id);
    }
}

impl Hub {
    pub(crate) fn remove_channel(&self, channel: u16) {
        self.state
            .lock()
            .expect("watch state")
            .subscribers
            .retain(|_, s| s.route.0 != channel);
        self.prune();
        self.wake.notify_one();
    }
    pub(crate) fn remove_route(&self, route: (u16, u32)) {
        self.state
            .lock()
            .expect("watch state")
            .subscribers
            .retain(|_, s| s.route != route);
        self.prune();
        self.wake.notify_one();
    }

    fn remove(&self, id: u64) {
        self.state
            .lock()
            .expect("watch state")
            .subscribers
            .remove(&id);
        self.prune();
        self.wake.notify_one();
    }

    fn prune(&self) {
        let mut state = self.state.lock().expect("watch state");
        let active: BTreeSet<_> = state
            .subscribers
            .values()
            .flat_map(|s| s.sessions.keys().cloned())
            .collect();
        state.snapshots.retain(|k, _| active.contains(k));
        state.slow.retain(|k, _| active.contains(k));
        state.slow_dirty.retain(|k| active.contains(k));
        self.active
            .store(!active.is_empty(), std::sync::atomic::Ordering::Release);
    }

    pub(crate) fn subscribe(
        self: &Arc<Self>,
        caller: String,
        route: (u16, u32),
        request: Request,
        ctx: &AppReadContext,
    ) -> Result<Subscription, HandlerOutcome> {
        {
            let state = self.state.lock().expect("watch state");
            if state.subscribers.len() >= TOTAL
                || state
                    .subscribers
                    .values()
                    .filter(|s| s.caller == caller)
                    .count()
                    >= PER_CALLER
            {
                return Err(limit_refusal());
            }
        }
        let store = ctx
            .store
            .clone()
            .ok_or_else(|| named("store_unavailable", "The session store is not open."))?;
        self.observe(Arc::clone(&store), ctx)?;
        let snapshots = read_snapshots(ctx, request.sessions.values())?;
        let mut state = self.state.lock().expect("watch state");
        if state.subscribers.len() >= TOTAL
            || state
                .subscribers
                .values()
                .filter(|s| s.caller == caller)
                .count()
                >= PER_CALLER
        {
            return Err(limit_refusal());
        }
        let distinct = state
            .snapshots
            .keys()
            .chain(request.sessions.keys())
            .collect::<BTreeSet<_>>()
            .len();
        if distinct > TRACKED_SESSIONS {
            return Err(limit_refusal());
        }
        // A cursor cannot cover a session that was not observed while disconnected.
        let continuously_observed = request
            .sessions
            .keys()
            .all(|k| state.snapshots.contains_key(k));
        let replay = request
            .cursor
            .as_deref()
            .and_then(parse_cursor)
            .filter(|(epoch, v)| *epoch == self.epoch && *v <= state.version)
            .filter(|(_, v)| *v >= state.resync_floor)
            .filter(|(_, v)| {
                state
                    .history
                    .front()
                    .is_none_or(|c| v.saturating_add(1) >= c.version)
            })
            .filter(|_| continuously_observed);
        let (tx, rx) = mpsc::channel(QUEUE);
        let lagged = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done = Arc::new(Notify::new());
        let (kind, changed) = match replay {
            None => ("resync", request.sessions.keys().cloned().collect()),
            Some((_, version)) => (
                "changes",
                state
                    .history
                    .iter()
                    .filter(|c| c.version > version)
                    .flat_map(|c| {
                        c.sessions
                            .iter()
                            .filter(|k| request.sessions.contains_key(*k))
                            .cloned()
                    })
                    .collect(),
            ),
        };
        tx.try_send(notice(
            kind,
            &format!("{}:{}", self.epoch, state.version),
            &request.sessions,
            &changed,
        ))
        .expect("empty watch queue");
        for (k, snapshot) in snapshots {
            state.slow.entry(k.clone()).or_insert_with(|| SlowState {
                digest: None,
                next_ms: 0,
                hash_ms: 0.0,
                admission_fast: Some(snapshot.digest.clone()),
            });
            state.snapshots.entry(k).or_insert(snapshot);
        }
        state.next_id += 1;
        let id = state.next_id;
        state.subscribers.insert(
            id,
            Subscriber {
                caller,
                route,
                sessions: request.sessions,
                tx,
                lagged: Arc::clone(&lagged),
                done: Arc::clone(&done),
            },
        );
        self.active
            .store(true, std::sync::atomic::Ordering::Release);
        drop(state);
        self.wake.notify_one();
        Ok(Subscription {
            id,
            hub: Arc::clone(self),
            rx,
            lagged,
            done,
        })
    }
}

fn limit_refusal() -> HandlerOutcome {
    named_detail(
        "watch_limit_exceeded",
        "The caller has too many context watches.",
        json!({"limit": PER_CALLER, "total_limit": TOTAL, "session_limit": TRACKED_SESSIONS}),
    )
}

fn notice(
    kind: &str,
    cursor: &str,
    sessions: &BTreeMap<Key, locator::SessionRef>,
    changed: &BTreeSet<Key>,
) -> Value {
    let sessions: Vec<_> = changed.iter().filter_map(|k| sessions.get(k)).collect();
    json!({"schema":1,"op":METHOD,"kind":kind,"cursor":cursor,"sessions":sessions})
}

struct Snapshot {
    digest: Vec<u8>,
    deadline: Option<i64>,
}

struct SlowState {
    digest: Option<Vec<u8>>,
    next_ms: i64,
    hash_ms: f64,
    admission_fast: Option<Vec<u8>>,
}

fn read_snapshots<'a>(
    ctx: &AppReadContext,
    sessions: impl Iterator<Item = &'a locator::SessionRef>,
) -> Result<BTreeMap<Key, Snapshot>, HandlerOutcome> {
    use rusqlite::OptionalExtension;
    use sha2::{Digest, Sha256};
    ctx.with_reads(|context, store| {
        let mut snapshots = BTreeMap::new();
        for session in sessions {
            let target = match locator::locate(context, store, session) {
                Ok(target) => target,
                Err(error) => return Ok(Err(error)),
            };
            let version = super::version::session_version(context, store, &target, super::version::VersionRequest::States(&[]))?;
            let (mut meta, response, ttl) = match &target.source {
                locator::SessionSource::Standalone => context.query_row(super::session_data::META_SQL, [&session.session], |r| {
                    let values: Vec<_> = (0..r.as_ref().column_count()).map(|i| r.get_ref(i).map(|v| format!("{v:?}"))).collect::<rusqlite::Result<_>>()?;
                    Ok((values.join("\0"), r.get::<_, Option<i64>>(1)?, r.get::<_, Option<String>>(2)?))
                })?,
                locator::SessionSource::Async { namespace, reference, .. } => {
                    let (meta, ttl): (String, Option<String>) = store.query_row("SELECT meta,json_extract(meta,'$.cache_ttl_policy.value') FROM mc_cache_state WHERE session_id=?1", [namespace], |r| Ok((r.get(0)?,r.get(1)?))).optional()?.unwrap_or_default();
                    let (policy, response): (String, Option<i64>) = store.query_row("SELECT json_array(json_extract(state_json,'$.usage_policy'),json_extract(state_json,'$.historian_pending'),json_extract(state_json,'$.failure')),json_extract(state_json,'$.usage_policy.last_response_at_ms') FROM mc_async_compaction WHERE session_ref=?1", [reference], |r| Ok((r.get(0)?, r.get(1)?)))?;
                    (format!("{meta}\0{policy}"), response, ttl)
                }
            };
            if matches!(target.source, locator::SessionSource::Standalone) {
                // Breakdown writes are thresholded independently of session_meta usage updates.
                meta.push('\0');
                if let Some(breakdown) = super::session_data::host_pass_breakdown_text(context, &session.session)? {
                    meta.push_str(&breakdown);
                }
            }
            let expiry = response.filter(|v| *v > 0).zip(ttl.as_deref().and_then(|s| crate::scheduler::parse_cache_ttl(s).ok()))
                .and_then(|(at, ttl)| i64::try_from(ttl).ok().and_then(|ttl| at.checked_add(ttl)?.checked_add(1)));
            let expired = expiry.is_some_and(|at| at <= ctx.now_ms());
            let mut digest = Sha256::new();
            digest.update(version);
            digest.update(meta);
            digest.update([u8::from(expired)]);
            snapshots.insert(key(session), Snapshot { digest: digest.finalize().to_vec(), deadline: expiry.filter(|at| *at > ctx.now_ms()) });
        }
        Ok(Ok(snapshots))
    })?
}

fn hash_json(
    conn: &rusqlite::Connection,
    sql: &str,
    session: &str,
    digest: &mut ring::digest::Context,
) -> rusqlite::Result<()> {
    let value: String = conn.query_row(sql, [session], |r| r.get(0))?;
    digest.update(&(value.len() as u64).to_le_bytes());
    digest.update(value.as_bytes());
    Ok(())
}

fn slow_digest(
    ctx: &AppReadContext,
    session: &locator::SessionRef,
) -> Result<Vec<u8>, HandlerOutcome> {
    ctx.with_reads(|context, store| {
        let target = match locator::locate(context, store, session) { Ok(target) => target, Err(error) => return Ok(Err(error)) };
        let mut digest = ring::digest::Context::new(&ring::digest::SHA256);
        if matches!(target.source, locator::SessionSource::Standalone) {
            // SQLite builds the canonical scalar in C. Do not allocate and
            // Debug-format every column of every historical dropped row in Rust.
            for sql in [
                "SELECT json_group_array(json_array(tag_number,message_id,type,tool_owner_message_id,tool_name,byte_size,token_count,input_byte_size,input_token_count,drop_mode)) FROM (SELECT * FROM tags INDEXED BY idx_tags_dropped_session_tag_number WHERE session_id=?1 AND status='dropped' ORDER BY tag_number)",
                "SELECT json_group_array(json_array(tag_number,message_id,type,tool_owner_message_id,tool_name,byte_size,token_count,input_byte_size,input_token_count,drop_mode)) FROM (SELECT * FROM tags WHERE session_id=?1 AND status='active' AND type IN ('message','file','tool') AND tag_number IN (SELECT tag_id FROM pending_ops WHERE session_id=?1 AND operation='drop') ORDER BY tag_number)",
                "SELECT json_group_array(json_array(id,tag_id,operation,queued_at)) FROM (SELECT id,tag_id,operation,queued_at FROM pending_ops WHERE session_id=?1 ORDER BY tag_id,id)",
            ] { hash_json(context, sql, target.context_session_id(), &mut digest)?; }
        } else {
            hash_json(store, "SELECT json_group_array(json_array(id,target_id,queued_at)) FROM (SELECT id,target_id,queued_at FROM pending_agent_drops WHERE session_id=?1 ORDER BY id)", target.context_session_id(), &mut digest)?;
        }
        Ok(Ok(digest.finish().as_ref().to_vec()))
    })?
}

impl Hub {
    fn observe(
        self: &Arc<Self>,
        store: Arc<mc_store::McStore>,
        ctx: &AppReadContext,
    ) -> Result<(), HandlerOutcome> {
        let mut observer = self.observer.lock().expect("watch observer");
        if observer.is_some() {
            return Ok(());
        }
        // Watch parent directories, not WAL inodes: SQLite deletes and recreates
        // WAL files at checkpoints. Read/access events must not wake our own reads.
        let paths = ctx.with_reads(|context, store| {
            let path = |conn: &rusqlite::Connection| {
                conn.query_row(
                    "SELECT file FROM pragma_database_list WHERE name='main'",
                    [],
                    |r| r.get::<_, String>(0).map(PathBuf::from),
                )
            };
            Ok(vec![path(context)?, path(store)?])
        })?;
        let paths = paths
            .into_iter()
            .map(std::fs::canonicalize)
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(|error| {
                named(
                    "watch_unavailable",
                    format!("Database paths cannot be observed: {error}"),
                )
            })?;
        let files: BTreeSet<_> = paths
            .iter()
            .flat_map(|p| [p.clone(), PathBuf::from(format!("{}-wal", p.display()))])
            .collect();
        let active = Arc::clone(&self.active);
        let rescan = Arc::clone(&self.rescan);
        let wake = Arc::clone(&self.wake);
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if !active.load(std::sync::atomic::Ordering::Acquire) {
                    return;
                }
                match event {
                    Ok(event) if event.need_rescan() => {
                        rescan.store(true, std::sync::atomic::Ordering::Release);
                        wake.notify_one();
                    }
                    Ok(event)
                        if !matches!(event.kind, EventKind::Access(_))
                            && event.paths.iter().any(|p| files.contains(p)) =>
                    {
                        wake.notify_one()
                    }
                    Err(_) => {
                        rescan.store(true, std::sync::atomic::Ordering::Release);
                        wake.notify_one();
                    }
                    _ => {}
                }
            })
            .map_err(observer_error)?;
        for dir in paths
            .iter()
            .filter_map(|p| p.parent())
            .collect::<BTreeSet<_>>()
        {
            watcher
                .watch(dir, RecursiveMode::NonRecursive)
                .map_err(observer_error)?;
        }
        *observer = Some(watcher);
        let weak = Arc::downgrade(self);
        let wake = Arc::clone(&self.wake);
        tokio::spawn(async move {
            loop {
                let Some(hub) = weak.upgrade() else {
                    break;
                };
                let deadline = {
                    let state = hub.state.lock().expect("watch state");
                    state
                        .snapshots
                        .values()
                        .filter_map(|s| s.deadline)
                        .chain(state.slow.values().map(|s| s.next_ms))
                        .min()
                };
                drop(hub);
                if let Some(at) = deadline {
                    let delay =
                        Duration::from_millis(at.saturating_sub(crate::now_ms()).max(0) as u64);
                    tokio::select! { _ = wake.notified() => {}, _ = tokio::time::sleep(delay) => {} }
                } else {
                    wake.notified().await;
                }
                // Establish new baselines off the admission/reply path, before
                // the first coalesced wake can publish their confirmation.
                let baseline_hub = Weak::clone(&weak);
                let baseline_store = Arc::clone(&store);
                if tokio::task::spawn_blocking(move || {
                    if let Some(hub) = baseline_hub.upgrade() {
                        hub.check_slow(baseline_store, true, false);
                    }
                })
                .await
                .is_err()
                {
                    break;
                }
                // A fixed window, rather than trailing-edge debounce, guarantees
                // progress even when database events arrive continuously.
                tokio::time::sleep(DEBOUNCE).await;
                let weak = Weak::clone(&weak);
                let store = Arc::clone(&store);
                if tokio::task::spawn_blocking(move || {
                    if let Some(hub) = weak.upgrade() {
                        hub.refresh(Arc::clone(&store));
                        hub.check_slow(store, false, false);
                    }
                })
                .await
                .is_err()
                {
                    break;
                }
            }
        });
        Ok(())
    }

    fn refresh(&self, store: Arc<mc_store::McStore>) {
        let sessions: BTreeMap<_, _> = self
            .state
            .lock()
            .expect("watch state")
            .subscribers
            .values()
            .flat_map(|s| s.sessions.iter().map(|(k, v)| (k.clone(), v.clone())))
            .collect();
        if sessions.is_empty() {
            return;
        }
        let ctx =
            AppReadContext::from_parts(Some(store), Arc::default(), Vec::new(), crate::now_ms());
        match read_snapshots(&ctx, sessions.values()) {
            Ok(snapshots) => self.publish(
                snapshots,
                self.rescan.swap(false, std::sync::atomic::Ordering::AcqRel),
            ),
            // Do not advance past an unreadable snapshot. Reconnect must refetch.
            Err(_) => self.publish(BTreeMap::new(), true),
        }
    }

    fn check_slow(&self, store: Arc<mc_store::McStore>, baselines_only: bool, force: bool) {
        let now = crate::now_ms();
        let sessions: BTreeMap<_, _> = {
            let state = self.state.lock().expect("watch state");
            state
                .subscribers
                .values()
                .flat_map(|s| s.sessions.iter())
                .filter(|(k, _)| {
                    state.slow.get(*k).is_some_and(|s| {
                        (force || s.next_ms <= now) && (!baselines_only || s.digest.is_none())
                    })
                })
                .map(|(k, s)| (k.clone(), s.clone()))
                .collect()
        };
        for (k, session) in sessions {
            let start = std::time::Instant::now();
            let mut ctx = AppReadContext::from_parts(
                Some(Arc::clone(&store)),
                Arc::default(),
                Vec::new(),
                crate::now_ms(),
            );
            // This work is not admission. Legacy drop-mode conversion, growing
            // output/input sizes, legacy output/input token-count backfills after
            // a restart or loss of in-memory tag assignments, and direct
            // name/queued-at edits need a full hash because the frozen schema has
            // no counter for them. Check every max(10 seconds, 100 * last hash
            // duration), then deliver differences on the next one-second coalesced wake.
            ctx.budget = Duration::from_secs(30);
            let result = slow_digest(&ctx, &session);
            let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
            let mut state = self.state.lock().expect("watch state");
            let Some(slow) = state.slow.get_mut(&k) else {
                continue;
            };
            slow.hash_ms = elapsed_ms;
            slow.next_ms = crate::now_ms().saturating_add(slow_interval_ms(slow.hash_ms));
            match result {
                Ok(digest) => {
                    let confirm_admission = slow.admission_fast.take().is_some();
                    let changed = slow.digest.as_ref().is_some_and(|old| old != &digest);
                    slow.digest = Some(digest);
                    // The reply-time fast snapshot cannot exclude payload-only
                    // edits between the initial notice/client read and the first
                    // full-baseline capture. Confirm once after capture so clients
                    // re-read at/after that boundary. Later baseline differences
                    // cover edits between successive full-baseline captures.
                    if confirm_admission || changed {
                        state.slow_dirty.insert(k);
                        self.wake.notify_one();
                    }
                }
                Err(_) => {
                    self.rescan
                        .store(true, std::sync::atomic::Ordering::Release);
                    self.wake.notify_one();
                }
            }
        }
    }

    fn publish(&self, snapshots: BTreeMap<Key, Snapshot>, resync: bool) {
        let mut state = self.state.lock().expect("watch state");
        let mut changed: BTreeSet<_> = snapshots
            .iter()
            .filter(|(k, s)| {
                state
                    .snapshots
                    .get(*k)
                    .is_none_or(|old| old.digest != s.digest)
            })
            .map(|(k, _)| k.clone())
            .collect();
        changed.append(&mut state.slow_dirty);
        for (k, snapshot) in snapshots {
            if let std::collections::btree_map::Entry::Occupied(mut entry) =
                state.snapshots.entry(k)
            {
                entry.insert(snapshot);
            }
        }
        if changed.is_empty() && !resync {
            return;
        }
        state.version += 1;
        let version = state.version;
        if resync {
            state.history.clear();
            state.resync_floor = version;
        }
        let sessions = if resync {
            state.snapshots.keys().cloned().collect()
        } else {
            changed.clone()
        };
        state.history.push_back(Change { version, sessions });
        while state.history.len() > HISTORY {
            state.history.pop_front();
        }
        let cursor = format!("{}:{version}", self.epoch);
        state.subscribers.retain(|_, s| {
            let keys: BTreeSet<Key> = if resync {
                s.sessions.keys().cloned().collect()
            } else {
                changed
                    .intersection(&s.sessions.keys().cloned().collect())
                    .cloned()
                    .collect()
            };
            if keys.is_empty() {
                return true;
            }
            match s.tx.try_send(notice(
                if resync { "resync" } else { "changes" },
                &cursor,
                &s.sessions,
                &keys,
            )) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    s.lagged.store(true, std::sync::atomic::Ordering::Release);
                    s.done.notify_one();
                    false
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            }
        });
        drop(state);
        self.prune();
    }
}

fn slow_interval_ms(hash_ms: f64) -> i64 {
    SLOW_MIN_MS.max((hash_ms * 100.0).ceil() as i64)
}

fn observer_error(error: notify::Error) -> HandlerOutcome {
    named(
        "watch_unavailable",
        format!("Native database notifications are unavailable: {error}"),
    )
}

pub(crate) fn is_watch(body: &[u8]) -> bool {
    body.len() <= envelope::REQUEST_LIMIT
        && serde_json::from_slice::<Value>(body)
            .ok()
            .is_some_and(|v| v.get("method").and_then(Value::as_str) == Some(METHOD))
}

pub(crate) async fn forward(
    ctx: subc_client_rs::RequestCtx,
    mut subscription: Subscription,
    management: bool,
) -> HandlerOutcome {
    loop {
        if subscription
            .lagged
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return named(
                "lagged",
                "The context watch fell behind; reconnect with the last received cursor.",
            );
        }
        let value = tokio::select! {
            biased;
            _ = ctx.cancelled() => return HandlerOutcome::Streamed,
            _ = subscription.done.notified() => continue,
            value = subscription.rx.recv() => match value { Some(value) => value, None => return HandlerOutcome::Streamed },
        };
        let value = if management {
            json!({"result":value})
        } else {
            value
        };
        let bytes = serde_json::to_vec(&value).expect("watch notice JSON");
        tokio::select! {
            biased;
            _ = ctx.cancelled() => return HandlerOutcome::Streamed,
            _ = subscription.done.notified() => continue,
            result = ctx.emit(bytes) => if result.is_err() { return HandlerOutcome::Streamed; },
        }
    }
}

impl Drop for Hub {
    fn drop(&mut self) {
        self.wake.notify_one();
    }
}

#[cfg(test)]
pub(super) struct Sample {
    pub name: &'static str,
    pub file: &'static str,
    pub params: Value,
    pub result: Result<Value, HandlerOutcome>,
}

#[cfg(test)]
pub(super) fn samples() -> Vec<Sample> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(transport_tests::sample_fixtures::samples())
}

#[cfg(test)]
#[path = "watch_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "watch_transport_tests.rs"]
mod transport_tests;

#[cfg(test)]
#[path = "../context_watch_cost_bench.rs"]
mod cost_bench;
