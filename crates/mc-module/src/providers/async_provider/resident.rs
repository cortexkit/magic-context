//! Resident per-conversation state for the async compaction provider.
//!
//! A conversation's `AsyncRecord` stays in memory between notices, so a notice
//! reads and folds in only the entries the runner added since the last one.
//! The held transcript is kept in its stored JSON form (`HeldEntry`), not as a
//! `serde_json::Value` tree per entry: a tree costs several times the JSON it
//! came from, and only a view build needs whole messages. Engine views are kept
//! serialized (`EngineView`) and parsed only when the engine runs.
//!
//! Persistence is unchanged: append-only entry rows plus the small record. A
//! resident record is reused only while the stored small record is exactly the
//! JSON this process last saved or loaded; anything else is rebuilt from rows.
use super::*;
use std::collections::HashMap;

/// What a notice needs to know about one held entry without decoding it
/// again, recorded once when the entry is first decoded with the
/// conversation's codec (`AsyncRecord::fold_entries`).
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub(super) struct EntryFacts {
    /// A user message with authored text or media after delivered reminders are excluded.
    pub real_user: bool,
    /// Tool-result blocks the codec decodes from the message.
    pub tool_results: u64,
}

/// One held transcript entry.
pub(crate) struct HeldEntry {
    pub(super) mid: String,
    /// Digest computed once from the immutable stored entry, including part order.
    pub(super) input_digest: [u8; 32],
    /// `serde_json` of the runner's `ReadMessage`, byte-identical to the
    /// stored `mc_async_compaction_entries.entry_json`.
    raw: Box<str>,
    #[cfg(test)]
    reference: Option<String>,
}

impl HeldEntry {
    pub(super) fn from_read(entry: &ReadMessage) -> Result<Self, HandlerOutcome> {
        let raw = serde_json::to_string(entry).map_err(transient)?;
        Ok(Self {
            mid: entry.mid.clone(),
            input_digest: Sha256::digest(raw.as_bytes()).into(),
            raw: raw.into(),
            #[cfg(test)]
            reference: None,
        })
    }

    /// An entry as stored. Only its `mid` is read here; the rest stays JSON.
    pub(super) fn from_stored(raw: String) -> Result<Self, HandlerOutcome> {
        #[derive(Deserialize)]
        struct Head {
            mid: String,
        }
        let head: Head = serde_json::from_str(&raw).map_err(transient)?;
        Ok(Self {
            mid: head.mid,
            input_digest: Sha256::digest(raw.as_bytes()).into(),
            raw: raw.into_boxed_str(),
            #[cfg(test)]
            reference: None,
        })
    }

    pub(super) fn raw(&self) -> &str {
        &self.raw
    }

    /// The complete runner message, parsed from its stored JSON.
    pub(super) fn read(&self) -> Result<ReadMessage, HandlerOutcome> {
        #[cfg(test)]
        counters::parsed(1);
        #[cfg(test)]
        if let Some(reference) = &self.reference {
            super::scaling_tests::view_work::decoded(reference, 1);
        }
        serde_json::from_str(&self.raw).map_err(transient)
    }

    #[cfg(test)]
    pub(super) fn counted_as(mut self, reference: String) -> Self {
        self.reference = Some(reference);
        self
    }

    /// The entry as the engine and the summarizer see it: a large text the
    /// runner described is its carried head and a notice of its size
    /// (`crate::descriptors::expose`).
    pub(super) fn inbound(&self) -> Result<InboundMessage, HandlerOutcome> {
        let entry = self.read()?;
        Ok(InboundMessage {
            ordinal: entry.ordinal,
            mid: entry.mid,
            message: crate::descriptors::expose(&entry.message).unwrap_or(entry.message),
        })
    }

    /// Heap and container bytes this entry keeps alive.
    pub(super) fn retained_bytes(&self) -> usize {
        // The map node, the Arc and the struct itself, conservatively.
        const OVERHEAD: usize = 128;
        OVERHEAD + self.raw.len() + self.mid.capacity()
    }
}

/// A serialized engine view, parsed only when the engine needs it. Its JSON is
/// byte-identical to what the store holds for it (`engine_json` or a stored
/// baseline row), so a baseline can be written without serializing again.
#[derive(Clone)]
pub(super) struct EngineView {
    pub(super) identity: ViewIdentity,
    pub(super) json: Arc<str>,
    pub(super) frozen_edits: Option<Arc<frozen_edits::FrozenEdits>>,
    pub(super) publication_lineage: Option<String>,
    pub(super) publication_version: Option<u64>,
    pub(super) resync_reissued: bool,
    pub(super) resync_reissued_from: Option<u64>,
}

impl EngineView {
    pub(super) fn of(view: &transform::compaction::View) -> Result<Self, HandlerOutcome> {
        Ok(Self::with_json(
            view,
            serde_json::to_string(view).map_err(transient)?.into(),
        ))
    }

    pub(super) fn with_json(view: &transform::compaction::View, json: Arc<str>) -> Self {
        Self {
            identity: view_identity(view),
            json,
            frozen_edits: None,
            publication_lineage: None,
            publication_version: None,
            resync_reissued: false,
            resync_reissued_from: None,
        }
    }

    pub(super) fn with_frozen_edits(mut self, edits: frozen_edits::FrozenEdits) -> Self {
        self.frozen_edits = Some(Arc::new(edits));
        self
    }

    pub(super) fn with_publication_lineage(mut self, lineage: String) -> Self {
        self.publication_lineage = Some(lineage);
        self
    }

    pub(super) fn with_publication_version(mut self, version: u64) -> Self {
        self.publication_version = Some(version);
        self
    }

    /// A stored engine view. Only what its identity needs is read; the
    /// messages stay JSON until the engine runs.
    pub(super) fn parse(json: String) -> Result<Self, HandlerOutcome> {
        #[derive(Deserialize)]
        struct Head {
            version: u64,
            range: transform::compaction::Range,
            replacement: Vec<serde::de::IgnoredAny>,
            #[serde(default)]
            native_frozen_edits: Option<frozen_edits::FrozenEdits>,
            #[serde(default)]
            publication_lineage: Option<String>,
            #[serde(default)]
            publication_version: Option<u64>,
            #[serde(default)]
            resync_reissued: bool,
            #[serde(default)]
            resync_reissued_from: Option<u64>,
        }
        let head: Head = serde_json::from_str(&json).map_err(transient)?;
        Ok(Self {
            identity: (head.version, head.range, head.replacement.len()),
            json: json.into(),
            frozen_edits: head.native_frozen_edits.map(Arc::new),
            publication_lineage: head.publication_lineage,
            publication_version: head.publication_version,
            resync_reissued: head.resync_reissued,
            resync_reissued_from: head.resync_reissued_from,
        })
    }

    pub(super) fn view(&self) -> Result<transform::compaction::View, HandlerOutcome> {
        #[cfg(test)]
        counters::engine_view_parsed();
        serde_json::from_str(&self.json).map_err(transient)
    }
}

/// A decoded tail hygiene baseline and the stored identity it was read at
/// (`McStore::load_meta_with_tail_identity`): an equal identity means an
/// equal baseline.
pub(super) struct CachedEngineState {
    pub namespace: String,
    pub identity: String,
    pub bytes: usize,
    pub baseline: Option<Arc<mc_store::TailHygieneBaseline>>,
}

/// The reminder pass's inputs from the engine's cache state; `full` is the
/// whole state when this pass had to load it.
pub(super) struct ReminderBase {
    pub baseline: Option<Arc<mc_store::TailHygieneBaseline>>,
    pub coverage_ordinal: Option<u64>,
    pub full: Option<Arc<mc_store::LoadedState>>,
}

/// Running aggregates over the held entries' facts.
#[derive(Clone, Default, Debug, PartialEq, Eq)]
pub(super) struct Aggregates {
    /// Highest ordinal whose facts are counted below.
    pub through: Option<u64>,
    pub real_users: u64,
    pub tool_results: u64,
    /// Ordinal and mid of the newest authored user message.
    pub last_user: Option<(u64, String)>,
    /// Tool calls without a result yet, and whether some result had no
    /// earlier call: the engine refuses a working range in either case, so a
    /// notice must then run it rather than skip it.
    pub open_calls: BTreeSet<String>,
    pub orphan_result: bool,
    pub historian_input: historian_tail::InputIndex,
}

impl Aggregates {
    pub(super) fn add(
        &mut self,
        ordinal: u64,
        mid: &str,
        facts: EntryFacts,
        message: &ck_wire::CkIngressMessage,
    ) {
        self.historian_input.add(message);
        self.through = Some(ordinal);
        self.tool_results += facts.tool_results;
        if facts.real_user {
            self.real_users += 1;
            self.last_user = Some((ordinal, mid.to_owned()));
        }
        // Track tool calls without a result, and results without an earlier
        // call, as the engine's `working_range` checks them over the whole
        // transcript.
        for block in &message.ck.content {
            match &block.kind {
                ck_wire::CkKind::ToolCall {
                    id,
                    provider_executed: false,
                    ..
                } => {
                    self.open_calls.insert(id.clone());
                }
                ck_wire::CkKind::ToolResult {
                    id,
                    provider_executed: false,
                    ..
                } if !self.open_calls.remove(id) => self.orphan_result = true,
                _ => {}
            }
        }
    }
}

/// Conversations held in memory between operations, with a process-wide byte
/// budget. A record is taken out for the duration of one operation (under the
/// conversation's provider lock) and put back only after that operation's
/// final save succeeded, so the held copy always equals the store.
pub(crate) struct ResidentCache {
    budget: usize,
    clock: u64,
    held: HashMap<String, Held>,
    #[cfg(test)]
    pub(super) evictions: u64,
    #[cfg(test)]
    pub(super) oracle: bool,
}

struct Held {
    state: AsyncRecord,
    bytes: usize,
    used: u64,
}

/// Default process-wide budget for resident conversations. One 150k-message
/// conversation (≈278 MB of transcript) holds roughly 1.7× that in memory, so
/// this keeps a few long conversations resident without nearing 2 GB.
const DEFAULT_BUDGET: usize = 1536 * 1024 * 1024;

impl Default for ResidentCache {
    fn default() -> Self {
        Self {
            budget: std::env::var("MC_ASYNC_RESIDENT_BUDGET_BYTES")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(DEFAULT_BUDGET),
            clock: 0,
            held: HashMap::new(),
            #[cfg(test)]
            evictions: 0,
            #[cfg(test)]
            oracle: false,
        }
    }
}

impl ResidentCache {
    /// Take a conversation out if it is held and still equals the stored
    /// small record `stored`.
    pub(super) fn take(&mut self, reference: &str, stored: &str) -> Option<AsyncRecord> {
        let held = self.held.remove(reference)?;
        (held.state.journal.saved_json.as_deref() == Some(stored)).then_some(held.state)
    }

    pub(super) fn forget(&mut self, reference: &str) {
        self.held.remove(reference);
    }

    /// Put a conversation back, evicting the least recently used others
    /// while the budget is exceeded. A conversation larger than the whole
    /// budget is not kept; its next operation rebuilds it from rows.
    pub(super) fn put(&mut self, mut state: AsyncRecord) {
        #[cfg(test)]
        if self.oracle {
            return;
        }
        if !state.journal.complete || state.journal.saved_json.is_none() {
            return;
        }
        let bytes = state.retained_bytes();
        let reference = state.reference();
        self.held.remove(&reference);
        if bytes > self.budget {
            return;
        }
        let mut total = bytes + self.held.values().map(|held| held.bytes).sum::<usize>();
        while total > self.budget {
            let Some(oldest) = self
                .held
                .iter()
                .min_by_key(|(_, held)| held.used)
                .map(|(reference, _)| reference.clone())
            else {
                break;
            };
            if let Some(evicted) = self.held.remove(&oldest) {
                total -= evicted.bytes;
                #[cfg(test)]
                {
                    self.evictions += 1;
                }
            }
        }
        self.clock += 1;
        self.held.insert(
            reference,
            Held {
                state,
                bytes,
                used: self.clock,
            },
        );
    }

    #[cfg(test)]
    pub(super) fn set_budget(&mut self, budget: usize) {
        self.budget = budget;
    }

    #[cfg(test)]
    pub(super) fn held_bytes(&self, reference: &str) -> Option<usize> {
        self.held.get(reference).map(|held| held.bytes)
    }
}

/// Test counters of transcript work, per thread: how many held entries were
/// parsed from JSON and decoded by the codec, and how many engine passes and
/// engine-view parses ran. A notice that publishes nothing must keep these
/// independent of the conversation's length.
#[cfg(test)]
pub(crate) mod counters {
    use std::cell::Cell;

    thread_local! {
        static REASON: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
        static REASONS: std::cell::RefCell<std::collections::BTreeMap<String, u64>> = const { std::cell::RefCell::new(std::collections::BTreeMap::new()) };
        static PARSED: Cell<u64> = const { Cell::new(0) };
        static DECODED: Cell<u64> = const { Cell::new(0) };
        static ENGINE: Cell<u64> = const { Cell::new(0) };
        static VIEWS: Cell<u64> = const { Cell::new(0) };
    }

    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct Work {
        pub parsed: u64,
        pub decoded: u64,
        pub engine_passes: u64,
        pub engine_views: u64,
    }

    pub fn parsed(count: u64) {
        PARSED.with(|cell| cell.set(cell.get() + count));
    }
    pub fn decoded(count: u64) {
        DECODED.with(|cell| cell.set(cell.get() + count));
    }
    pub fn engine_pass() {
        ENGINE.with(|cell| cell.set(cell.get() + 1));
    }
    /// Why the last notice on this thread ran the engine.
    pub fn engine_reason(reason: &str) {
        REASON.with(|cell| *cell.borrow_mut() = reason.to_owned());
        let short = reason
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_owned();
        REASONS.with(|cell| *cell.borrow_mut().entry(short).or_default() += 1);
    }
    /// How often each reason made a notice on this thread run the engine.
    pub fn engine_reasons() -> std::collections::BTreeMap<String, u64> {
        REASONS.with(|cell| cell.borrow().clone())
    }
    pub fn last_engine_reason() -> String {
        REASON.with(|cell| cell.borrow().clone())
    }
    pub fn engine_view_parsed() {
        VIEWS.with(|cell| cell.set(cell.get() + 1));
    }

    static SKIPPED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    /// Engine passes skipped by any provider in this process, so a
    /// differential can show its resident side really skipped them.
    pub fn engine_pass_skipped() {
        SKIPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    pub fn skipped_engine_passes() -> u64 {
        SKIPPED.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn read() -> Work {
        Work {
            parsed: PARSED.with(Cell::get),
            decoded: DECODED.with(Cell::get),
            engine_passes: ENGINE.with(Cell::get),
            engine_views: VIEWS.with(Cell::get),
        }
    }
}
