//! The `memory_changed` v1 wake: a bus notice, sent after a commit that
//! changed memories a session's history head can show, so other modules
//! (Colliculus rebuilds a call's context on it) read them again. It names the
//! owner whose memories changed and a revision, and never any memory text.
//!
//! Every writer already reports such a commit through
//! [`ContextDb::changed`] (`Change::Memories`): an agent's `ctx_memory`, the
//! summarizer's facts and its second turn, a dreamer task, an owner command
//! from the apps, and the move of a 0.49 project's rows. That report signals
//! [`MemoryWakes`] here, and [`run`] publishes the wakes a few seconds later
//! ([`COALESCE`]), one per owner with its newest revision, so a burst of
//! writes is one wake. Nothing scans the store for changes.
//!
//! A wake is only a hint, and readers keep a backstop of their own: when the
//! bus is down or ck-bus isn't installed, the wakes are dropped and the
//! outage is logged once. Nothing is kept to send later.
//!
//! The notice carries no body, as every notice on the bus. Its subject is
//! `ck.<account>.event.magic-context.memory_changed.v1`, its message id
//! `<level>:<owner id>:<revision>` (the owner id empty at the global level),
//! its headers the three fields, and its digest the SHA-256 of the body
//! `{"level", "owner_id", "revision"}` the fields make ([`Wake::body`]).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cortexkit_bus_naming::AccountNames;
use cortexkit_bus_trait::{ContentDigest, Headers};
use rusqlite::Connection;
use tokio::sync::Notify;

use crate::bus::{Bus, Notice};
use crate::context_db::ContextDb;

/// The event, and its version.
pub(crate) const EVENT_NAME: &str = "memory_changed";
pub(crate) const EVENT_VERSION: u32 = 1;
/// The headers a wake carries, as the module's manifest declares them.
pub(crate) const EVENT_HEADERS: [&str; 3] = ["level", "owner_id", "revision"];

/// How long the wakes of a burst of writes wait for the rest of it: an owner
/// is woken at most once in this time, with its newest revision.
pub(crate) const COALESCE: Duration = Duration::from_secs(3);

/// The `memory_changed` event as the module's manifest declares it.
pub(crate) fn event_declaration() -> subc_protocol::manifest::EventDeclaration {
    subc_protocol::manifest::EventDeclaration::new(EVENT_NAME, EVENT_VERSION)
        .with_headers(
            EVENT_HEADERS
                .iter()
                .map(|name| (*name).to_owned())
                .collect(),
        )
        .with_summary(Some(
            "Magic Context memories of a project, a workspace or the person changed".into(),
        ))
}

/// The memories' revision: the sum of the AUTOINCREMENT counters of the
/// tables every memory write inserts into. A save inserts a memory; an
/// update, archive, merge or delete, by an agent, the summarizer's second
/// turn, a dreamer task or an owner command, records a journal entry and
/// usually a history row; the move of a 0.49 project's rows logs each row it
/// moves. SQLite never lowers these counters, not even when rows are deleted,
/// and a transaction that rolls back leaves them as they were, so the sum
/// rises with every committed memory change and survives restarts.
///
/// One sum covers every owner. An owner's revisions are therefore sparse,
/// since other owners' writes raise the sum too, but they always increase:
/// a wake read after an owner's change carries a higher revision than any
/// wake read before it.
pub(crate) fn revision(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(SUM(seq), 0) FROM sqlite_sequence
          WHERE name IN ('memories', 'memory_history', 'memory_journal', 'identity_merge_log')",
        [],
        |row| row.get(0),
    )
}

/// An owner of memories a head can show: a project or a workspace by its
/// id, or the person's global memories, which have no owner id.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct Owner {
    pub level: &'static str,
    pub id: Option<String>,
}

impl Owner {
    /// The owner a writer's `level` and `owner` name. Other levels (an
    /// agent's own memories) are shown by no head and wake no one.
    pub(crate) fn of(level: &str, owner: &str) -> Option<Self> {
        match level {
            "project" => Some(Self {
                level: "project",
                id: Some(owner.to_owned()),
            }),
            "workspace" => Some(Self {
                level: "workspace",
                id: Some(owner.to_owned()),
            }),
            "global" => Some(Self {
                level: "global",
                id: None,
            }),
            _ => None,
        }
    }
}

/// One wake: the owner whose memories changed, at a revision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Wake {
    pub owner: Owner,
    pub revision: i64,
}

impl Wake {
    /// `{"level": …, "owner_id": …, "revision": …}`, the owner id `null` at
    /// the global level. The keys are written in sorted order, so the bytes
    /// are the same whichever map type serde_json was built with.
    pub(crate) fn body(&self) -> String {
        serde_json::json!({
            "level": self.owner.level,
            "owner_id": self.owner.id,
            "revision": self.revision,
        })
        .to_string()
    }

    /// The bus's message id, which it deduplicates by:
    /// `<level>:<owner id>:<revision>`.
    pub(crate) fn event_key(&self) -> String {
        format!(
            "{}:{}:{}",
            self.owner.level,
            self.owner.id.as_deref().unwrap_or_default(),
            self.revision
        )
    }

    /// Exactly the headers the declaration lists. A header without a value
    /// (the owner id at the global level) is left out, never sent empty.
    pub(crate) fn headers(&self) -> Result<Headers, String> {
        let mut headers = BTreeMap::new();
        for name in EVENT_HEADERS {
            let value = match name {
                "level" => self.owner.level.to_owned(),
                "owner_id" => self.owner.id.clone().unwrap_or_default(),
                "revision" => self.revision.to_string(),
                other => {
                    return Err(format!(
                        "event_header_unmapped: {EVENT_NAME} declares header {other} with no publisher mapping"
                    ))
                }
            };
            if value.is_empty() {
                continue;
            }
            if value.chars().any(char::is_control) {
                return Err("header_invalid".into());
            }
            headers.insert(name.to_owned(), value);
        }
        Ok(headers)
    }

    /// The wake's notice in `account`.
    pub(crate) fn notice(&self, account: &AccountNames) -> Result<Notice, String> {
        let subject = account
            .event_subject(crate::MODULE_ID, EVENT_NAME, EVENT_VERSION)
            .map_err(|error| format!("event_subject: {error}"))?;
        Ok(Notice {
            subject,
            id: self.event_key(),
            digest: ContentDigest::of_bytes(self.body().as_bytes()),
            headers: self.headers()?,
        })
    }
}

/// The owners whose memories changed since the last round, which
/// [`ContextDb::changed`] fills after each commit and [`run`] empties.
#[derive(Default)]
pub struct MemoryWakes {
    pending: Mutex<BTreeSet<Owner>>,
    notify: Notify,
}

impl MemoryWakes {
    /// A commit changed memories of `owner` at `level`.
    pub(crate) fn signal(&self, level: &str, owner: &str) {
        if let Some(owner) = Owner::of(level, owner) {
            self.pending.lock().expect("pending wakes").insert(owner);
            self.notify.notify_one();
        }
    }

    /// The owners signalled since the last call.
    pub(crate) fn take(&self) -> BTreeSet<Owner> {
        std::mem::take(&mut *self.pending.lock().expect("pending wakes"))
    }
}

/// What publishes the wakes, and what it last published.
pub(crate) struct Publisher {
    bus: Arc<Bus>,
    /// The revision each owner was last woken with.
    woken: HashMap<Owner, i64>,
    /// The revision when the publisher started: an owner not woken since is
    /// woken only once the revision is past it, since every change before
    /// it was committed before this process could announce anything.
    floor: i64,
    /// Whether the current outage was logged, so it is logged once.
    logged: bool,
}

impl Publisher {
    pub(crate) fn new(bus: Arc<Bus>, floor: i64) -> Self {
        Self {
            bus,
            woken: HashMap::new(),
            floor,
            logged: false,
        }
    }

    /// One round: wake each of `owners` whose revision moved since it was
    /// last woken, with the revision read now, after the commits that
    /// signalled it. Returns the wakes the bus took. When the bus can't be
    /// reached or a publish fails, the rest are dropped, and the outage is
    /// logged once until a round gets through.
    pub(crate) async fn round(&mut self, db: &ContextDb, owners: BTreeSet<Owner>) -> Vec<Wake> {
        let revision = match db.with_connection(|conn| revision(conn)) {
            Ok(revision) => revision,
            Err(error) => {
                tracing::warn!("ck-mc: bus: reading the memory revision failed; this round's memory wakes are dropped: {error}");
                return Vec::new();
            }
        };
        let due: Vec<Wake> = owners
            .into_iter()
            .filter(|owner| revision > *self.woken.get(owner).unwrap_or(&self.floor))
            .map(|owner| Wake { owner, revision })
            .collect();
        if due.is_empty() {
            return Vec::new();
        }
        let mut sent = Vec::new();
        let outcome = async {
            let session = self.bus.session().await?;
            for wake in due {
                let published = match wake.notice(&session.account) {
                    Ok(notice) => {
                        session
                            .publisher
                            .publish(&notice.subject, &notice.id, notice.digest, notice.headers)
                            .await
                    }
                    Err(error) => Err(error),
                };
                if let Err(error) = published {
                    session.discard();
                    return Err(error);
                }
                sent.push(wake);
            }
            Ok(())
        }
        .await;
        for wake in &sent {
            self.woken.insert(wake.owner.clone(), wake.revision);
        }
        match outcome {
            Ok(()) => self.logged = false,
            Err(error) => {
                if !std::mem::replace(&mut self.logged, true) {
                    tracing::warn!(
                        "ck-mc: bus: memory change wakes are dropped until the bus is reachable: {error}"
                    );
                }
            }
        }
        sent
    }
}

/// Publish the wakes `wakes` collects through `publisher`, for good: each
/// round waits [`COALESCE`] after the first signal, so the rest of a burst
/// joins it.
pub(crate) async fn run(mut publisher: Publisher, db: Arc<ContextDb>, wakes: Arc<MemoryWakes>) {
    loop {
        wakes.notify.notified().await;
        tokio::time::sleep(COALESCE).await;
        let owners = wakes.take();
        if !owners.is_empty() {
            publisher.round(&db, owners).await;
        }
    }
}

/// Signal `wakes` with every memory change `db`'s writers report from now on,
/// and the publisher of those wakes through `bus`. Its floor is the revision
/// read after `wakes` is in place, so a change committed after that read is
/// signalled and woken, and one before it predates anything this process
/// could announce.
pub(crate) fn publisher_for(db: &ContextDb, bus: Arc<Bus>, wakes: &Arc<MemoryWakes>) -> Publisher {
    db.wake_on_memory_changes(Arc::clone(wakes));
    let floor = db.with_connection(|conn| revision(conn)).unwrap_or(0);
    Publisher::new(bus, floor)
}

#[cfg(test)]
#[path = "memory_changed_tests.rs"]
pub(crate) mod tests;
