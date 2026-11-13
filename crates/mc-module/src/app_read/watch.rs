use super::*;
use std::collections::{HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use tokio::sync::mpsc as async_mpsc;

const PER_CALLER: usize = 8;
const TOTAL: usize = 32;
const TRACKED: usize = 256;
const HISTORY: usize = 256;
const QUEUE: usize = 16;
/// The most projects, or workspaces, one watch may name.
const OWNERS: usize = 32;

pub struct Subscription {
    rx: async_mpsc::Receiver<Value>,
    lagged: Arc<AtomicBool>,
}

impl Subscription {
    pub async fn recv(&mut self) -> Result<Option<Value>, Refusal> {
        if self.lagged.load(Ordering::Acquire) {
            return Err(lagged());
        }
        let value = self.rx.recv().await;
        if self.lagged.load(Ordering::Acquire) {
            return Err(lagged());
        }
        Ok(value)
    }
}

/// A change to rows an app page shows, published by the module's writer
/// that made it. Each is a reload hint: reread this; nothing else changed.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Change {
    /// A memory of the owner was added, changed, archived, restored, deleted
    /// or re-ranked; or the owner's pending observations (the person's own
    /// memories) or candidate facts (a project's) changed.
    Memories { level: String, owner: String },
    /// A schedule, the lock or a run of the project changed.
    Dreamer { project: String },
    /// A note of the project changed, in `session` when it is one session's.
    Notes {
        project: String,
        session: Option<SessionRef>,
    },
}

impl Change {
    pub(crate) fn project_memories(project: &str) -> Self {
        Self::Memories {
            level: "project".into(),
            owner: project.into(),
        }
    }

    pub(crate) fn global_memories() -> Self {
        Self::Memories {
            level: "global".into(),
            owner: "self".into(),
        }
    }
}

/// What a watch names besides sessions.
#[derive(Default)]
struct Owners {
    projects: Vec<String>,
    workspaces: Vec<String>,
    global: bool,
}

impl Owners {
    fn wants(&self, change: &Change) -> bool {
        match change {
            Change::Memories { level, owner } => match level.as_str() {
                "project" => self.projects.contains(owner),
                "workspace" => self.workspaces.contains(owner),
                "global" => self.global,
                _ => false,
            },
            Change::Dreamer { project } | Change::Notes { project, .. } => {
                self.projects.contains(project)
            }
        }
    }

    fn is_empty(&self) -> bool {
        self.projects.is_empty() && self.workspaces.is_empty() && !self.global
    }
}

struct Watch {
    caller: String,
    sessions: Vec<SessionRef>,
    owners: Owners,
    tx: async_mpsc::Sender<Value>,
    lagged: Arc<AtomicBool>,
}

enum Topic {
    Session(SessionRef),
    Change(Change),
}

pub(super) struct Hub {
    epoch: String,
    seq: u64,
    history: VecDeque<(u64, Topic)>,
    subscribers: Vec<Watch>,
}

impl Hub {
    pub fn new() -> Self {
        static EPOCH: AtomicU64 = AtomicU64::new(0);
        Self {
            epoch: format!("{:x}{:x}", now_ms(), EPOCH.fetch_add(1, Ordering::Relaxed)),
            seq: 0,
            history: VecDeque::new(),
            subscribers: Vec::new(),
        }
    }

    fn cursor(&self) -> String {
        format!("{}:{}", self.epoch, self.seq)
    }

    fn notice(&self, kind: &str, sessions: &[SessionRef]) -> Value {
        json!({"schema":1, "op":"context.watch", "kind":kind, "cursor":self.cursor(), "sessions":sessions})
    }

    fn change_notice(&self, change: &Change) -> Value {
        let mut notice = json!({"schema":1, "op":"context.watch", "cursor":self.cursor()});
        match change {
            Change::Memories { level, owner } => {
                notice["kind"] = json!("memories");
                notice["level"] = json!(level);
                notice["owner"] = json!(owner);
            }
            Change::Dreamer { project } => {
                notice["kind"] = json!("dreamer");
                notice["project"] = json!(project);
            }
            Change::Notes { project, session } => {
                notice["kind"] = json!("notes");
                notice["project"] = json!(project);
                if let Some(session) = session {
                    notice["session"] = json!(session);
                }
            }
        }
        notice
    }

    fn record(&mut self, topic: Topic) {
        self.seq += 1;
        self.history.push_back((self.seq, topic));
        while self.history.len() > HISTORY {
            self.history.pop_front();
        }
        self.subscribers.retain(|s| !s.tx.is_closed());
    }

    /// Send `notice` to every watch `wants` picks; one whose queue is full
    /// has fallen behind and is told so on its next receive.
    fn deliver(&mut self, notice: Value, wants: impl Fn(&Watch) -> bool) {
        self.subscribers.retain(|watch| {
            if !wants(watch) {
                return true;
            }
            if watch.tx.try_send(notice.clone()).is_err() {
                watch.lagged.store(true, Ordering::Release);
                return false;
            }
            true
        });
    }

    pub fn changed(&mut self, key: SessionRef) {
        self.record(Topic::Session(key.clone()));
        let notice = self.notice("changes", std::slice::from_ref(&key));
        self.deliver(notice, |watch| watch.sessions.contains(&key));
    }

    pub fn publish(&mut self, change: Change) {
        let notice = {
            self.record(Topic::Change(change.clone()));
            self.change_notice(&change)
        };
        self.deliver(notice, |watch| watch.owners.wants(&change));
    }

    fn subscribe(
        &mut self,
        caller: String,
        sessions: Vec<SessionRef>,
        owners: Owners,
        cursor: Option<&str>,
    ) -> Result<Subscription, Refusal> {
        self.subscribers.retain(|s| !s.tx.is_closed());
        let distinct: HashSet<_> = self
            .subscribers
            .iter()
            .flat_map(|s| &s.sessions)
            .chain(&sessions)
            .collect();
        if self.subscribers.len() >= TOTAL
            || self
                .subscribers
                .iter()
                .filter(|s| s.caller == caller)
                .count()
                >= PER_CALLER
            || distinct.len() > TRACKED
        {
            return Err(Refusal::new(
                "watch_limit_exceeded",
                "The caller has too many context watches.",
                Some(json!({"limit":PER_CALLER,"total_limit":TOTAL,"session_limit":TRACKED})),
            ));
        }
        let replay = cursor
            .and_then(|c| c.rsplit_once(':'))
            .filter(|(epoch, _)| *epoch == self.epoch)
            .and_then(|(_, seq)| seq.parse::<u64>().ok())
            .filter(|seq| {
                *seq <= self.seq
                    && self
                        .history
                        .front()
                        .is_none_or(|(oldest, _)| *seq >= oldest.saturating_sub(1))
            });
        // Each owner change since the cursor is told once, newest last; more
        // than the queue holds beside the first notice is a resync instead.
        let replayed: Option<Vec<Change>> = replay.map(|seq| {
            let mut changes: Vec<Change> = Vec::new();
            for (_, topic) in self.history.iter().filter(|(n, _)| *n > seq) {
                if let Topic::Change(change) = topic {
                    if owners.wants(change) {
                        changes.retain(|known| known != change);
                        changes.push(change.clone());
                    }
                }
            }
            changes
        });
        let replay = replay.filter(|_| replayed.as_ref().is_some_and(|c| c.len() < QUEUE));
        let (tx, rx) = async_mpsc::channel(QUEUE);
        match replay {
            Some(seq) => {
                let changed = sessions
                    .iter()
                    .filter(|s| {
                        self.history.iter().any(|(n, topic)| {
                            *n > seq && matches!(topic, Topic::Session(key) if key == *s)
                        })
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                let _ = tx.try_send(self.notice("changes", &changed));
                for change in replayed.unwrap_or_default() {
                    let _ = tx.try_send(self.change_notice(&change));
                }
            }
            None => {
                let mut notice = self.notice("resync", &sessions);
                // Session-only watches keep the notice they always had.
                if !owners.projects.is_empty() {
                    notice["projects"] = json!(owners.projects);
                }
                if !owners.workspaces.is_empty() {
                    notice["workspaces"] = json!(owners.workspaces);
                }
                if owners.global {
                    notice["global"] = json!(true);
                }
                let _ = tx.try_send(notice);
            }
        }
        let lagged = Arc::new(AtomicBool::new(false));
        self.subscribers.push(Watch {
            caller,
            sessions,
            owners,
            tx,
            lagged: lagged.clone(),
        });
        Ok(Subscription { rx, lagged })
    }
}

/// A list of distinct project or workspace ids, at most [`OWNERS`].
fn owner_ids(p: &Map<String, Value>, key: &str) -> Result<Vec<String>, Refusal> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(value) => {
            let values = value
                .as_array()
                .filter(|values| values.len() <= OWNERS)
                .ok_or_else(|| invalid(key))?;
            let mut ids: Vec<String> = Vec::new();
            for value in values {
                let id = value
                    .as_str()
                    .filter(|id| !id.is_empty() && id.len() <= 512 && !id.contains('\0'))
                    .ok_or_else(|| invalid(key))?;
                if ids.iter().any(|known| known == id) {
                    return Err(invalid(key));
                }
                ids.push(id.to_owned());
            }
            Ok(ids)
        }
    }
}

impl Replica {
    pub(super) fn subscribe(
        &mut self,
        caller: String,
        params: &Value,
    ) -> Result<Subscription, Refusal> {
        let p = object(
            params,
            &["sessions", "projects", "workspaces", "global", "cursor"],
        )?;
        let owners = Owners {
            projects: owner_ids(p, "projects")?,
            workspaces: owner_ids(p, "workspaces")?,
            global: match p.get("global") {
                None | Some(Value::Null) => false,
                Some(value) => value.as_bool().ok_or_else(|| invalid("global"))?,
            },
        };
        // A watch names sessions, owners, or both; one that names nothing
        // is refused as it was before owners could be watched.
        let values = match p.get("sessions") {
            None | Some(Value::Null) if !owners.is_empty() => Vec::new(),
            Some(Value::Array(values)) if values.is_empty() && !owners.is_empty() => Vec::new(),
            sessions => sessions
                .and_then(Value::as_array)
                .filter(|v| !v.is_empty() && v.len() <= 32)
                .ok_or_else(|| invalid("sessions"))?
                .clone(),
        };
        let mut sessions = Vec::new();
        // A named session ck-mc doesn't hold (yet) doesn't refuse the watch:
        // the watch follows every session it names, so one session that never
        // moves to mode 3 can't stop the others from updating. Reads of that
        // session answer its refusal by name, and the watch's notice names it
        // when its first projection arrives. A project ck-mc hasn't seen is
        // followed the same way.
        for value in &values {
            let key = session(value)?;
            if sessions.contains(&key) {
                return Err(invalid("sessions"));
            }
            sessions.push(key);
        }
        let cursor = p
            .get("cursor")
            .filter(|v| !v.is_null())
            .map(|v| {
                v.as_str()
                    .filter(|v| !v.is_empty() && v.len() <= 512)
                    .ok_or_else(|| error("cursor_invalid", "Invalid watch cursor."))
            })
            .transpose()?;
        if let Some(cursor) = cursor {
            if !cursor
                .rsplit_once(':')
                .is_some_and(|(epoch, seq)| !epoch.is_empty() && seq.parse::<u64>().is_ok())
            {
                return Err(error("cursor_invalid", "Invalid watch cursor."));
            }
        }
        self.watches.subscribe(caller, sessions, owners, cursor)
    }
}

fn lagged() -> Refusal {
    error(
        "lagged",
        "The context watch fell behind; reconnect with the last received cursor.",
    )
}
