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

struct Watch {
    caller: String,
    sessions: Vec<SessionRef>,
    tx: async_mpsc::Sender<Value>,
    lagged: Arc<AtomicBool>,
}

pub(super) struct Hub {
    epoch: String,
    seq: u64,
    history: VecDeque<(u64, SessionRef)>,
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

    fn notice(&self, kind: &str, sessions: &[SessionRef]) -> Value {
        json!({"schema":1, "op":"context.watch", "kind":kind, "cursor":format!("{}:{}", self.epoch, self.seq), "sessions":sessions})
    }

    pub fn changed(&mut self, key: SessionRef) {
        self.seq += 1;
        self.history.push_back((self.seq, key.clone()));
        while self.history.len() > HISTORY {
            self.history.pop_front();
        }
        self.subscribers.retain(|s| !s.tx.is_closed());
        let notice = self.notice("changes", std::slice::from_ref(&key));
        self.subscribers.retain(|watch| {
            if !watch.sessions.contains(&key) {
                return true;
            }
            if watch.tx.try_send(notice.clone()).is_err() {
                watch.lagged.store(true, Ordering::Release);
                return false;
            }
            true
        });
    }

    fn subscribe(
        &mut self,
        caller: String,
        sessions: Vec<SessionRef>,
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
        let (kind, changed) = if let Some(seq) = replay {
            let changed = sessions
                .iter()
                .filter(|s| self.history.iter().any(|(n, key)| *n > seq && key == *s))
                .cloned()
                .collect::<Vec<_>>();
            ("changes", changed)
        } else {
            ("resync", sessions.clone())
        };
        let (tx, rx) = async_mpsc::channel(QUEUE);
        let _ = tx.try_send(self.notice(kind, &changed));
        let lagged = Arc::new(AtomicBool::new(false));
        self.subscribers.push(Watch {
            caller,
            sessions,
            tx,
            lagged: lagged.clone(),
        });
        Ok(Subscription { rx, lagged })
    }
}

impl Replica {
    pub(super) fn subscribe(
        &mut self,
        caller: String,
        params: &Value,
    ) -> Result<Subscription, Refusal> {
        let p = object(params, &["sessions", "cursor"])?;
        let values = p
            .get("sessions")
            .and_then(Value::as_array)
            .filter(|v| !v.is_empty() && v.len() <= 32)
            .ok_or_else(|| invalid("sessions"))?;
        let mut sessions = Vec::new();
        // A named session ck-mc doesn't hold (yet) doesn't refuse the watch:
        // the watch follows every session it names, so one session that never
        // moves to mode 3 can't stop the others from updating. Reads of that
        // session answer its refusal by name, and the watch's notice names it
        // when its first projection arrives.
        for value in values {
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
        self.watches.subscribe(caller, sessions, cursor)
    }
}

fn lagged() -> Refusal {
    error(
        "lagged",
        "The context watch fell behind; reconnect with the last received cursor.",
    )
}
