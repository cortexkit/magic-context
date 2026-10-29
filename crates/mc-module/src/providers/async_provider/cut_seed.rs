//! What a conversation keeps of the transcript below a cut.
//!
//! Once the runner starts a lineage after a cut, the messages below the cut
//! are never read again. Everything ck-mc still needs from them is captured
//! here, once, while the old lineage's rows are still held: the system and
//! lineage-anchor messages (whose content the history head renders), the cut
//! message's times, the counts the reminder and historian cadences and the
//! historian input index carry forward, the protected tag rows below the cut,
//! the tag numbers that existed there, and the newest todo state.
//!
//! Context sources and the historian-only restart prelude have separate fixed
//! byte budgets. Neither can grow without bound with the transcript.
//!
//! Every field has a fallback for a cut ck-mc never held the rows for (for
//! example a host marker written before ck-mc served the session, found
//! again only by the cut message's id). `CutSeed::without_rows` builds that
//! seed; each fallback and its effect is documented on the field.
// Production captures a seed when publishing a cut and adopts it on the
// descending Setup. The in-place pruning helper is also exercised separately
// against full processing by the differential tests.
#![cfg_attr(not(test), allow(dead_code))]
use super::*;
use std::collections::HashSet;

/// The record format that knows about cut seeds. A stored record of an
/// older version is discarded and rebuilt (see `discard_older_record`).
pub(super) const RECORD_VERSION: u32 = 2;

/// Context sources larger than this are refused at capture
/// (`cut_seed_oversize`); the view then publishes no cut.
const MAX_CONTEXT_BYTES: usize = 256 * 1024;

/// A cut may keep at most one bounded restart suffix for the historian. This
/// caps extra seed memory independently of transcript length, like context
/// sources; an oversized suffix defers the cut, never the compaction view.
pub(super) const MAX_HISTORIAN_PRELUDE_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct HistorianPrelude {
    pub(super) from: u64,
    pub(super) ordinal_base: u64,
    pub(super) reset_next: bool,
    pub(super) messages: Vec<InboundMessage>,
}

/// The bound `LogicalPrefix::certify` applies to protected rows.
const MAX_PROTECTION_ROWS: usize = 4_096;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(crate) struct SeedProtection {
    pub floor: u64,
    pub ratio: f64,
    /// `(tag number, block id, kind, tokens, created at ms)` of the protected
    /// tool tags below the cut, as `LogicalPrefix` keeps them.
    pub rows: Vec<(i64, String, String, i64, i64)>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct SeedTodo {
    pub state_json: String,
    pub owner_message_id: String,
    pub state_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct CutSeed {
    /// The first ordinal of the lineage after the cut (F); the wire cut is
    /// F - 1 and covers every row the immutable head depends on.
    pub first_ordinal: u64,
    /// The first ordinal of the lineage the cut was taken from. The engine's
    /// ranges keep starting there, so its view of the conversation is the
    /// one full processing would hold. Fallback: 0.
    pub lineage_from: u64,
    /// The cut message's id and served digest. Fallback: the id the runner
    /// names and an empty digest (nothing compares it before a revert).
    pub cut_mid: String,
    pub cut_digest: String,
    /// The compartment sequence and flat boundary the history covered when
    /// the seed was taken. Fallback: the newest compartment's.
    pub compartment_seq: i64,
    pub boundary_id: String,
    /// System messages and the lineage-anchor message below the cut, whole,
    /// because the history head renders covered system text. Fallback:
    /// empty, so the head lists no covered system messages. OpenCode and
    /// Claude Code transcripts carry no system rows, so in practice nothing
    /// changes; the async lane never detects an anchor.
    pub context_sources: BTreeMap<u64, InboundMessage>,
    /// The cut message's `(created_at_ms, completed_at_ms)`. Fallback:
    /// unknown, so the first window message gets no temporal-gap marker.
    pub time_basis: Option<(Option<i64>, Option<i64>)>,
    /// Exact hygiene hash continuation for covered source parts. Unknown when
    /// the rows were never held; that fresh lineage hashes only known input.
    #[serde(default)]
    pub signature_prefix: Option<crate::tail_hygiene::signature::SignaturePrefix>,
    /// Authored user turns below the cut as the engine counts them
    /// (`LogicalPrefix::covered_user_turns`), for Channel-1 cadence.
    /// Fallback: 0, so that cadence counts as if the conversation began at
    /// the cut.
    pub covered_user_turns: u64,
    /// The provider's running totals below the cut: authored users (reminder
    /// echoes excluded), tool results and messages. Fallback: 0, 0 and
    /// `first_ordinal - lineage_from`. A zero tool-result base makes the
    /// historian cadence see fewer results than it last recorded, which it
    /// reads as a change, so one historian evaluation may run early.
    pub real_users: u64,
    pub tool_results: u64,
    pub messages: u64,
    /// The newest authored user message below the cut. Fallback: none, so the
    /// historian cadence sees no user turn until the next one.
    pub last_user: Option<(u64, String)>,
    /// Some tool result below the cut named no earlier call: the engine then
    /// always runs instead of being skipped. Fallback: false.
    pub orphan_result: bool,
    /// Protected tool tags below the cut. Fallback: none, so the protection
    /// window is computed over the window's tags only; tags below the cut
    /// have no live source either way.
    pub protection: Option<SeedProtection>,
    /// The inclusive span of tag numbers below the cut (at most one range),
    /// so `ctx_reduce` naming one answers that it is already in the history
    /// summary. One span, not one range per run of numbers, so the seed does
    /// not grow with the session when numbering has gaps; a number inside a
    /// gap was never shown and answers the same way. Fallback: empty, so
    /// such a number answers "not found".
    pub pre_cut_tags: Vec<(u64, u64)>,
    /// The highest tag number below the cut (0 when none).
    pub max_tag: u64,
    /// The newest todo state below the cut. Fallback: none, so no
    /// synthetic todo pair shows until the next `todowrite` in the window.
    pub todo: Option<SeedTodo>,
    /// Old seeds may embed history. New seeds refer to immutable shared objects
    /// so another cut never copies all earlier compartment payloads again.
    #[serde(default, skip_serializing)]
    pub recovery_history: Vec<mc_store::StoredCompartment>,
    #[serde(default)]
    pub(super) recovery_history_ref: Option<HistoryRef>,
    /// New immutable objects commit atomically with the seed's root reference;
    /// their payloads are never embedded in the serialized seed itself.
    #[serde(skip)]
    pub(super) pending_history_objects: BTreeMap<String, String>,
    /// Historian input only: never model input, live lineage, or session.read
    /// rows. Every row is at or below the wire cut, so a rewind changing one
    /// undoes that cut and cannot leave a stale prelude on a surviving lineage.
    #[serde(default)]
    pub historian_prelude: Option<HistorianPrelude>,
    /// State of the messages at or after the cut, as the conversation held
    /// it when the cut was taken. It is not derived from rows below the cut,
    /// but a lineage that begins at the cut cannot recompute it either: the
    /// engine froze it on passes that saw those rows. Fallback: empty, so the
    /// window starts with no reductions, no queued drops and no latches.
    #[serde(default)]
    pub window: CutWindow,
}

/// The window's engine and record state carried into a lineage that begins
/// at a cut; see `CutSeed::window`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct CutWindow {
    /// The staged live window only, never the historian prelude. A descending
    /// Setup can restore this bounded snapshot without reading the runner;
    /// its next inclusive read detects a changed or shortened suffix.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<(u64, String)>,
    /// Frozen reduction, caveman and strip units whose target message is at
    /// or after the cut, verbatim: their payloads are the bytes already
    /// served.
    pub frozen_units: Vec<mc_core::FrozenUnit>,
    /// `(last_emergency_input_sample, has_prior_emergency_drop,
    /// last_execute_ordinal)`.
    pub emergency: Option<(f64, bool, u64)>,
    /// Queued `ctx_reduce` drops on window blocks: `(block id, queued at ms)`.
    pub pending_drops: Vec<(String, i64)>,
    /// Native edits the runner acknowledged on window parts (`FrozenEdits`
    /// JSON).
    pub frozen_edits: Option<String>,
    /// For a lineage that descends from this cut: the engine namespace's
    /// folded head as it stands (frozen m0, m1, history and mural units,
    /// coverage and boundary, the tail-hygiene baseline, the m1 revisions)
    /// with the per-message state of the window and the context sources. Its
    /// size is bounded by the history budget, the frozen units and the
    /// window, not by the session's length.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<mc_store::NamespaceHead>,
    /// The record's certificate for the rows it omits when its tail starts
    /// at or after the cut, with the content proof of the window rows
    /// before that tail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) certificate: Option<(
        transform::compaction::LogicalPrefix,
        held_entries::InputProof,
    )>,
    /// The record's fixed-size cadence and policy state (`RECORD_KEEP`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<serde_json::Map<String, Value>>,
    /// The engine's produced and applied views, serialized. They hold the
    /// head and window rows only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub produced_view: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_view: Option<String>,
    /// The views the conversation retains (the applied one and any newer):
    /// `(version, view_json, engine_json, announced)`. A descending lineage
    /// keeps serving them; their kept ranges are the window's.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub views: Vec<(u64, String, Option<String>, bool)>,
    /// The stored version high-water the views are numbered under.
    #[serde(default)]
    pub views_high_water: u64,
    /// The engine's version high-water and rebuild epoch.
    #[serde(default)]
    pub engine_versions: (u64, u64),
}

/// Record members a lineage that descends from a cut keeps as they are:
/// fixed-size cadence, policy and reminder state.
const RECORD_KEEP: [&str; 12] = [
    "seq",
    "completed_seq",
    "applied",
    "acknowledgements",
    "marker_outcomes",
    "frozen_edits_version",
    "usage_policy",
    "reminder_cadence",
    "reminder_baseline_generation",
    "historian_cadence",
    "historian_pending",
    "reminder_echoes",
];

/// How a conversation begins at a cut. It is decided only by whether the
/// Setup descends from a cut this conversation published (`cut_start`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CutStart {
    /// The runner just applied the view that made the cut, so the provider's
    /// cached prefix is that view's head: the folded head is adopted as it
    /// stands, and the first pass is whatever the next pass would have been.
    Descending,
    /// Not descending from a cut this conversation published (a moved
    /// session, a conversation coming off another route, a runner that lost
    /// its state): the first pass is the engine's own bootstrap fold, a full
    /// rebuild.
    Fresh,
}

/// One named refusal to capture a seed. The cut is then not taken.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum CaptureRefusal {
    /// The record does not hold the cut message and the first window message.
    Unheld,
    /// The compartments do not cover every message below the cut.
    NotCovered,
    /// A tool call below the cut has its result at or after it.
    SplitsToolArc,
    /// The prelude's first row is not a certified historian restart point.
    NotAtRestartPoint,
    /// The context sources exceed `MAX_CONTEXT_BYTES`.
    Oversize,
    /// The immutable head depends on a row outside the wire cut prefix.
    SummaryBeyondCut,
    /// Retaining the historian's restart suffix would exceed its fixed budget.
    HistorianPreludeOversize,
    /// The cut no longer holds all rows needed by the historian's restart suffix.
    HistorianPreludeMissing,
}

impl CaptureRefusal {
    pub(super) fn code(&self) -> &'static str {
        match self {
            Self::Unheld => "cut_seed_unheld",
            Self::NotCovered => "cut_not_covered",
            Self::SplitsToolArc => "cut_splits_tool_arc",
            Self::NotAtRestartPoint => "cut_not_at_restart_point",
            Self::Oversize => "cut_seed_oversize",
            Self::SummaryBeyondCut => "unsafe_cut_seed",
            Self::HistorianPreludeOversize => "cut_historian_prelude_oversize",
            Self::HistorianPreludeMissing => "cut_historian_prelude_missing",
        }
    }
}

/// The block's message id: the part before `#`, or the whole id.
fn block_mid(block: &str) -> &str {
    ck_wire::split_block_id(block).map_or(block, |(mid, _)| mid)
}

/// One fixed-size reference to immutable compartment objects. The tree shares
/// unchanged subtrees between cuts; only new source identities add payloads.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct HistoryRef {
    root: Option<String>,
    summary_end: Option<u64>,
    /// Preserve version identity even after the disposable stage is gone.
    pub(super) identity: Option<(String, i64, i64, bool)>,
    count: usize,
}

#[derive(Serialize, Deserialize)]
enum HistoryObject {
    Compartment(Box<mc_store::StoredCompartment>),
    Branch(String, String),
}

impl CutSeed {
    pub(super) fn set_recovery_history(
        &mut self,
        compartments: Vec<mc_store::StoredCompartment>,
        identity: Option<(String, i64, i64, bool)>,
        summary_end: Option<u64>,
    ) -> Result<(), HandlerOutcome> {
        let count = compartments.len();
        let summary_end = compartments
            .iter()
            .filter_map(|row| u64::try_from(row.end_message).ok())
            .chain(summary_end)
            .max();
        let mut objects = BTreeMap::new();
        let mut keep = |object: HistoryObject| -> Result<String, HandlerOutcome> {
            let kind = match &object {
                HistoryObject::Compartment(_) => "c",
                HistoryObject::Branch(_, _) => "b",
            };
            let value = serde_json::to_value(object).map_err(transient)?;
            let id = format!("{kind}:{}", contract::digest::content_digest(&value));
            objects.insert(
                format!("cut-history:{id}"),
                serde_json::to_string(&value).map_err(transient)?,
            );
            Ok(id)
        };
        let mut level = compartments
            .into_iter()
            .map(|row| keep(HistoryObject::Compartment(Box::new(row))))
            .collect::<Result<Vec<_>, _>>()?;
        while level.len() > 1 {
            let mut next = Vec::with_capacity(level.len().div_ceil(2));
            for pair in level.chunks(2) {
                next.push(if pair.len() == 2 {
                    keep(HistoryObject::Branch(pair[0].clone(), pair[1].clone()))?
                } else {
                    pair[0].clone()
                });
            }
            level = next;
        }
        self.recovery_history_ref = Some(HistoryRef {
            root: level.pop(),
            summary_end,
            identity,
            count,
        });
        self.recovery_history.clear();
        self.pending_history_objects.extend(objects);
        Ok(())
    }

    pub(super) fn recovery_compartments(
        &self,
        store: &McStore,
        reference: &str,
    ) -> Result<Vec<mc_store::StoredCompartment>, HandlerOutcome> {
        let Some(history) = &self.recovery_history_ref else {
            return Ok(self.recovery_history.clone());
        };
        let mut pending = history.root.iter().cloned().collect::<Vec<_>>();
        let archived = if self.pending_history_objects.is_empty() {
            store
                .load_async_cut_history_objects(reference, history.root.as_deref())
                .map_err(transient)?
                .ok_or_else(|| {
                    error(
                        "cut_rebootstrap_required",
                        "retained history is missing; start a full lineage",
                    )
                })?
                .into_iter()
                .collect::<BTreeMap<_, _>>()
        } else {
            BTreeMap::new()
        };
        let mut rows = Vec::with_capacity(history.count);
        let mut visited = HashSet::new();
        while let Some(id) = pending.pop() {
            if !visited.insert(id.clone()) {
                return Err(error(
                    "cut_rebootstrap_required",
                    "retained history has a repeated object identity",
                ));
            }
            let slot = format!("cut-history:{id}");
            let raw = self
                .pending_history_objects
                .get(&slot)
                .or_else(|| archived.get(&slot))
                .ok_or_else(|| {
                    error(
                        "cut_rebootstrap_required",
                        "retained history is missing; start a full lineage",
                    )
                })?;
            let value: Value = serde_json::from_str(raw).map_err(transient)?;
            if contract::digest::content_digest(&value) != id.rsplit(':').next().unwrap_or_default()
            {
                return Err(error(
                    "cut_rebootstrap_required",
                    "retained history identity changed; start a full lineage",
                ));
            }
            match serde_json::from_value::<HistoryObject>(value).map_err(transient)? {
                HistoryObject::Compartment(row) => rows.push(*row),
                HistoryObject::Branch(left, right) => {
                    pending.push(right);
                    pending.push(left);
                }
            }
        }
        if rows.len() != history.count {
            return Err(error(
                "cut_rebootstrap_required",
                "retained history is incomplete; start a full lineage",
            ));
        }
        Ok(rows)
    }

    pub(super) fn history_root(&self) -> Option<&str> {
        self.recovery_history_ref.as_ref()?.root.as_deref()
    }

    pub(super) fn summary_end(&self) -> Option<u64> {
        self.recovery_history
            .iter()
            .filter_map(|c| u64::try_from(c.end_message).ok())
            .chain(
                self.window
                    .head
                    .as_ref()
                    .and_then(|head| head.meta.coverage_ordinal),
            )
            .chain(
                self.recovery_history_ref
                    .as_ref()
                    .and_then(|history| history.summary_end),
            )
            .max()
    }

    pub(super) fn boundary_safe(&self) -> bool {
        self.first_ordinal
            .checked_sub(1)
            .zip(self.summary_end())
            .is_some_and(|(cut, end)| end <= cut)
    }

    /// The baseline slot a seed is stored in.
    pub(super) fn slot(first_ordinal: u64) -> String {
        format!("cut:{first_ordinal}")
    }

    /// A seed for a cut ck-mc never held the rows for: every field at its
    /// documented fallback.
    pub(super) fn without_rows(
        first_ordinal: u64,
        cut_mid: String,
        compartment_seq: i64,
        boundary_id: String,
    ) -> Self {
        Self {
            first_ordinal,
            lineage_from: 0,
            cut_mid,
            cut_digest: String::new(),
            compartment_seq,
            boundary_id,
            context_sources: BTreeMap::new(),
            time_basis: None,
            signature_prefix: None,
            covered_user_turns: 0,
            real_users: 0,
            tool_results: 0,
            messages: first_ordinal,
            last_user: None,
            orphan_result: false,
            protection: None,
            pre_cut_tags: Vec::new(),
            max_tag: 0,
            todo: None,
            recovery_history: Vec::new(),
            recovery_history_ref: None,
            pending_history_objects: BTreeMap::new(),
            historian_prelude: None,
            window: CutWindow::default(),
        }
    }

    /// True when `number` was a tag below the cut.
    pub(super) fn tagged_below(&self, number: u64) -> bool {
        self.pre_cut_tags
            .iter()
            .any(|(lo, hi)| (*lo..=*hi).contains(&number))
    }

    /// The running totals as they stood just below the cut, from which a
    /// fold over the window continues.
    pub(super) fn base_aggregates(&self) -> resident::Aggregates {
        let mut historian_input =
            historian_tail::InputIndex::seeded(self.first_ordinal, self.messages);
        if let Some(prelude) = &self.historian_prelude {
            historian_input.seed_prelude(prelude.from, prelude.ordinal_base, prelude.reset_next);
        }
        resident::Aggregates {
            through: self.first_ordinal.checked_sub(1),
            real_users: self.real_users,
            tool_results: self.tool_results,
            last_user: self.last_user.clone(),
            open_calls: BTreeSet::new(),
            orphan_result: self.orphan_result,
            historian_input,
        }
    }

    /// The todo scan a lineage beginning at the cut starts with: everything
    /// below the cut already scanned, no call waiting for its result (a cut
    /// never splits a tool arc).
    pub(super) fn todo_scan(&self, lineage: &str) -> super::super::runner_todo::TodoScan {
        super::super::runner_todo::TodoScan {
            lineage: lineage.into(),
            through: self.first_ordinal.checked_sub(1),
            pending: BTreeMap::new(),
        }
    }

    /// The engine's logical prefix standing for the rows below the cut.
    pub(super) fn prefix(
        &self,
        lineage: &str,
        generation: u64,
        revert_epoch: u64,
    ) -> transform::compaction::LogicalPrefix {
        let (floor, ratio, rows) = self.protection.as_ref().map_or_else(
            || (u64::MAX, f64::MIN, Vec::new()),
            |protection| (protection.floor, protection.ratio, protection.rows.clone()),
        );
        transform::compaction::LogicalPrefix::for_cut(
            transform::compaction::CutPrefixFacts {
                lineage_from: self.lineage_from,
                first_ordinal: self.first_ordinal,
                covered_user_turns: self.covered_user_turns,
                context_sources: self.context_sources.clone(),
                compartment_seq: self.compartment_seq,
                boundary: self.boundary_id.clone(),
                revert_epoch,
                protection_floor: floor,
                protection_ratio: ratio,
                protection_tags: rows,
                max_tag: self.max_tag as i64,
                time_basis: self.time_basis,
                signature_prefix: self.signature_prefix.clone(),
            },
            lineage,
            generation,
        )
    }

    pub(super) fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.cut_mid.len()
            + self.cut_digest.len()
            + self.boundary_id.len()
            + self
                .context_sources
                .values()
                .map(|source| 128 + crate::retained_size::value_retained_bytes(&source.message))
                .sum::<usize>()
            + self.protection.as_ref().map_or(0, |protection| {
                protection
                    .rows
                    .iter()
                    .map(|(_, id, kind, _, _)| 64 + id.len() + kind.len())
                    .sum()
            })
            + self.pre_cut_tags.len() * 16
            + self.recovery_history_ref.as_ref().map_or(0, |history| {
                history.root.as_ref().map_or(0, String::len)
                    + history
                        .identity
                        .as_ref()
                        .map_or(0, |identity| identity.0.len())
            })
            + self
                .pending_history_objects
                .iter()
                .map(|(key, value)| key.len() + value.len() + 64)
                .sum::<usize>()
            + self
                .signature_prefix
                .as_ref()
                .map_or(0, |prefix| prefix.heap_bytes())
            + self
                .todo
                .as_ref()
                .map_or(0, |todo| todo.state_json.len() + 128)
            + self.historian_prelude.as_ref().map_or(0, |prelude| {
                prelude
                    .messages
                    .iter()
                    .map(|source| 128 + crate::retained_size::value_retained_bytes(&source.message))
                    .sum::<usize>()
            })
            + self
                .window
                .entries
                .iter()
                .map(|(_, raw)| raw.len() + 32)
                .sum::<usize>()
    }
}

/// The held entries `ordinals` prepared as the engine would see them: decoded
/// with the conversation's codec, reminder echoes marked, Pi positions
/// counted from `source_from`.
fn prepared(
    state: &State,
    codec: codec::Codec,
    ordinals: std::ops::Range<u64>,
    source_from: u64,
) -> Result<TransformRequest, HandlerOutcome> {
    let messages = inbound_messages(state.entries.range(ordinals).map(|(_, entry)| entry))?;
    let mut request: TransformRequest = decode(
        &json!({"v":2,"kind":"compaction.step","session_id":state.namespace(),"messages":[],"render_config":"cut-seed","tool_present":false,"auto_search_enabled":false}),
    )?;
    if messages.is_empty() {
        return Ok(request);
    }
    state.reminder_echoes.prepare_with(
        codec,
        &mut request,
        &messages,
        false,
        |request, entries| codec.prepare_request_from(request, entries, source_from),
    )?;
    Ok(request)
}

/// Authored user turns among `ordinals` as the engine counts them, outside
/// `context`.
fn user_turns(
    state: &State,
    codec: codec::Codec,
    ordinals: std::ops::Range<u64>,
    source_from: u64,
    context: &BTreeSet<u64>,
) -> Result<u64, HandlerOutcome> {
    let end = ordinals.end;
    let request = prepared(state, codec, ordinals, source_from)?;
    let projection = ck_wire::project_messages(&request.messages).map_err(transient)?;
    Ok(transform::compaction::user_turns_below(
        &projection.blocks,
        end,
        context,
    ))
}

impl AsyncRecord {
    /// Reclaim superseded history after publication, never during an ordinary
    /// record load. Only branch payloads are read; compartment bodies stay cold.
    pub(super) fn gc_cut_history(&mut self, store: &McStore) -> Result<(), HandlerOutcome> {
        let reference = self.reference();
        let (roots, objects) = store
            .async_cut_history_index(&reference)
            .map_err(transient)?;
        let expected_roots = roots.clone();
        let objects = objects.into_iter().collect::<HashSet<_>>();
        let mut pending = Vec::new();
        for root in roots {
            if let Some(root) = serde_json::from_str::<Option<String>>(&root).map_err(transient)? {
                pending.push(root);
            }
        }
        if let Some(root) = self.cut_seed.as_ref().and_then(|seed| seed.history_root()) {
            pending.push(root.to_owned());
        }
        let mut live = HashSet::new();
        while let Some(id) = pending.pop() {
            let slot = format!("cut-history:{id}");
            if !live.insert(slot.clone()) {
                continue;
            }
            if !objects.contains(&slot) {
                return Err(error(
                    "cut_rebootstrap_required",
                    "retained history has a missing object",
                ));
            }
            if id.starts_with("c:") {
                continue;
            }
            if !id.starts_with("b:") {
                return Err(error(
                    "cut_rebootstrap_required",
                    "retained history has an invalid object identity",
                ));
            }
            let raw = store
                .load_async_compaction_baseline(&reference, &slot)
                .map_err(transient)?
                .ok_or_else(|| {
                    error(
                        "cut_rebootstrap_required",
                        "retained history branch is missing",
                    )
                })?;
            let value: Value = serde_json::from_str(&raw).map_err(transient)?;
            if contract::digest::content_digest(&value) != id.rsplit(':').next().unwrap_or_default()
            {
                return Err(error(
                    "cut_rebootstrap_required",
                    "retained history branch identity changed",
                ));
            }
            match serde_json::from_value::<HistoryObject>(value).map_err(transient)? {
                HistoryObject::Branch(left, right) => {
                    pending.push(left);
                    pending.push(right);
                }
                HistoryObject::Compartment(_) => {
                    return Err(error(
                        "cut_rebootstrap_required",
                        "retained history branch is not a branch",
                    ))
                }
            }
        }
        let garbage = objects.difference(&live).cloned().collect::<Vec<_>>();
        if !garbage.is_empty()
            && !store
                .discard_async_cut_history_objects(&reference, &garbage, &expected_roots)
                .map_err(transient)?
        {
            return Ok(());
        }
        self.cut_history_gc_pending = false;
        Ok(())
    }

    /// The ordinal the next transcript read starts at: the newest held entry
    /// (read again to check the overlap), or the first ordinal of the
    /// lineage when nothing is held. A lineage that begins at a cut is never
    /// read below its first ordinal.
    pub(super) fn read_from(&self) -> u64 {
        self.entries.last_key_value().map_or_else(
            || self.cut_seed.as_ref().map_or(0, |seed| seed.first_ordinal),
            |(n, _)| *n,
        )
    }

    /// The first ordinal of the lineage this record's ordinals count from.
    pub(super) fn lineage_from(&self) -> u64 {
        self.cut_seed.as_ref().map_or_else(
            || self.entries.first_key_value().map_or(0, |(n, _)| *n),
            |seed| seed.lineage_from,
        )
    }

    fn capture_historian_prelude(
        &self,
        _store: &McStore,
        previous: Option<&CutSeed>,
        window: historian_tail::InputWindow,
        first: u64,
        reset_next: bool,
    ) -> Result<Result<HistorianPrelude, CaptureRefusal>, HandlerOutcome> {
        let carried = previous
            .and_then(|seed| seed.historian_prelude.as_ref())
            .into_iter()
            .flat_map(|prelude| &prelude.messages)
            .filter(|message| {
                message.ordinal >= window.from
                    && message.ordinal < first
                    && !self.entries.contains_key(&message.ordinal)
            })
            .cloned()
            .map(Ok);
        let live = self
            .entries
            .range(window.from..first)
            .map(|(_, entry)| entry.inbound());
        let mut messages = Vec::new();
        let mut bytes = serde_json::to_vec(&HistorianPrelude {
            from: window.from,
            ordinal_base: window.ordinal_base,
            reset_next,
            messages: Vec::new(),
        })
        .map_err(transient)?
        .len();
        for source in carried.chain(live) {
            let source = source?;
            bytes = bytes.saturating_add(
                serde_json::to_vec(&source).map_err(transient)?.len()
                    + usize::from(!messages.is_empty()),
            );
            if bytes > MAX_HISTORIAN_PRELUDE_BYTES {
                #[cfg(test)]
                cut_runtime::measurements::prelude(_store, bytes, true);
                return Ok(Err(CaptureRefusal::HistorianPreludeOversize));
            }
            messages.push(source);
        }
        messages.sort_by_key(|message| message.ordinal);
        if messages.first().map(|m| m.ordinal) != Some(window.from)
            || messages.last().map(|m| m.ordinal.saturating_add(1)) != Some(first)
            || messages
                .windows(2)
                .any(|pair| pair[0].ordinal.checked_add(1) != Some(pair[1].ordinal))
        {
            return Ok(Err(CaptureRefusal::HistorianPreludeMissing));
        }
        let prelude = HistorianPrelude {
            from: window.from,
            ordinal_base: window.ordinal_base,
            reset_next,
            messages,
        };
        let bytes = serde_json::to_vec(&prelude).map_err(transient)?.len();
        #[cfg(test)]
        cut_runtime::measurements::prelude(_store, bytes, bytes > MAX_HISTORIAN_PRELUDE_BYTES);
        if bytes > MAX_HISTORIAN_PRELUDE_BYTES {
            return Ok(Err(CaptureRefusal::HistorianPreludeOversize));
        }
        Ok(Ok(prelude))
    }

    /// Capture the seed for a cut whose first window ordinal is `first`,
    /// while the rows below it are still held. The work is bounded by the
    /// window and the span between the cut and the current certificate,
    /// except for a record with no certificate, whose rows below the cut are
    /// decoded once.
    pub(super) fn capture_cut_seed(
        &mut self,
        store: &McStore,
        codec: codec::Codec,
        first: u64,
    ) -> Result<Result<CutSeed, CaptureRefusal>, HandlerOutcome> {
        let previous = self.cut_seed.clone();
        let base = previous.as_ref().map_or_else(
            || self.entries.first_key_value().map_or(0, |(n, _)| *n),
            |seed| seed.first_ordinal,
        );
        let lineage_from = self.lineage_from();
        let Some(cut) = first.checked_sub(1) else {
            return Ok(Err(CaptureRefusal::Unheld));
        };
        let renewal = previous
            .as_ref()
            .is_some_and(|seed| seed.first_ordinal == first);
        if first < base
            || (!renewal && !self.entries.contains_key(&cut))
            || !self.entries.contains_key(&first)
        {
            return Ok(Err(CaptureRefusal::Unheld));
        }
        let namespace = self.namespace();
        let loaded = store.load(&namespace).map_err(transient)?;
        let compartments = store.load_compartments(&namespace).map_err(transient)?;
        let mut next = lineage_from as i64;
        let mut sorted = compartments.iter().collect::<Vec<_>>();
        sorted.sort_by_key(|c| c.start_message);
        for compartment in sorted {
            if compartment.start_message <= next && compartment.end_message >= next {
                next = compartment.end_message.saturating_add(1);
            }
        }
        // The compartments must cover every message below the cut, and the
        // engine must have folded through it: a runner applies a cut only
        // with a view whose history covers it.
        if loaded
            .meta
            .coverage_ordinal
            .is_none_or(|coverage| coverage < cut)
            || next <= cut as i64
        {
            return Ok(Err(CaptureRefusal::NotCovered));
        }
        let newest_compartment = compartments.iter().max_by_key(|c| c.sequence);
        // The running totals cover every held entry; subtract the window.
        self.fold_entries(codec, None)?;
        let mut window_users = 0u64;
        let mut window_tools = 0u64;
        for (_, entry) in self.entries.range(first..) {
            let mut message = decoded_entry(codec, &entry.inbound()?)?;
            self.reminder_echoes.annotate(&mut message);
            window_users += u64::from(self.reminder_echoes.authored(&message));
            window_tools += message
                .ck
                .content
                .iter()
                .filter(|block| matches!(block.kind, ck_wire::CkKind::ToolResult { .. }))
                .count() as u64;
        }
        // A tool result in the window whose call is not in the window would
        // be split from it by the cut. Checked on the window as the engine
        // decodes it, where positional fallback ids agree.
        let end = self.entries.last_key_value().map_or(first, |(n, _)| n + 1);
        let window = prepared(self, codec, first..end, lineage_from)?;
        let mut calls = HashSet::new();
        for message in &window.messages {
            for block in &message.ck.content {
                match &block.kind {
                    ck_wire::CkKind::ToolCall {
                        id,
                        provider_executed: false,
                        ..
                    } => {
                        calls.insert(id.clone());
                    }
                    ck_wire::CkKind::ToolResult {
                        id,
                        provider_executed: false,
                        ..
                    } if !calls.contains(id) => return Ok(Err(CaptureRefusal::SplitsToolArc)),
                    _ => {}
                }
            }
        }
        let window_count = self.entries.range(first..).count() as u64;
        let aggregates = &self.aggregates;
        let historian_window = aggregates.historian_input.window(Some(cut));
        if !aggregates.historian_input.is_start(historian_window.from) {
            return Ok(Err(CaptureRefusal::NotAtRestartPoint));
        }
        let mut last_user = aggregates
            .last_user
            .clone()
            .filter(|(ordinal, _)| *ordinal < first);
        if aggregates
            .last_user
            .as_ref()
            .is_some_and(|(ordinal, _)| *ordinal >= first)
        {
            // The newest authored user is in the window: find the newest one
            // below the cut, walking back from it.
            last_user = previous.as_ref().and_then(|seed| seed.last_user.clone());
            for (ordinal, entry) in self.entries.range(base..first).rev() {
                let mut message = decoded_entry(codec, &entry.inbound()?)?;
                self.reminder_echoes.annotate(&mut message);
                if self.reminder_echoes.authored(&message) {
                    last_user = Some((*ordinal, entry.mid.clone()));
                    break;
                }
            }
        }
        let real_users = aggregates.real_users.saturating_sub(window_users);
        let tool_results = aggregates.tool_results.saturating_sub(window_tools);
        let messages = aggregates
            .historian_input
            .count()
            .saturating_sub(window_count);
        let orphan_result = aggregates.orphan_result;
        // A certificate whose omitted input is unchanged carries the engine's
        // own count, context and protection below its tail.
        let certificate = self
            .logical_prefix
            .clone()
            .filter(|prefix| !prefix.is_cut())
            .filter(|prefix| prefix.tail_from > base || previous.is_none())
            .filter(|prefix| {
                self.entries
                    .matches(self.prefix_input_proof.as_ref(), prefix.tail_from)
            });
        let anchor_mid = loaded
            .meta
            .anchor_block_id
            .as_deref()
            .map(|block| block_mid(block).to_owned());
        let system_rows = |state: &Self,
                           span: std::ops::Range<u64>|
         -> Result<BTreeMap<u64, InboundMessage>, HandlerOutcome> {
            let mut sources = BTreeMap::new();
            for (ordinal, entry) in state.entries.range(span) {
                let inbound = entry.inbound()?;
                let decoded = decoded_entry(codec, &inbound)?;
                if decoded.ck.role == "system" || anchor_mid.as_deref() == Some(entry.mid.as_str())
                {
                    sources.insert(*ordinal, inbound);
                }
            }
            Ok(sources)
        };
        let mut context_sources = previous
            .as_ref()
            .map(|seed| seed.context_sources.clone())
            .unwrap_or_default();
        let covered_user_turns = match &certificate {
            Some(prefix) => {
                let tail = prefix.tail_from;
                context_sources.extend(
                    prefix
                        .context_sources
                        .iter()
                        .filter(|(ordinal, _)| **ordinal < first)
                        .map(|(ordinal, source)| (*ordinal, source.clone())),
                );
                if tail <= first {
                    let span = system_rows(self, tail..first)?;
                    let context = span.keys().copied().collect();
                    context_sources.extend(span);
                    prefix.covered_user_turns
                        + user_turns(self, codec, tail..first, lineage_from, &context)?
                } else {
                    let context = prefix.context_ordinals.clone();
                    prefix.covered_user_turns.saturating_sub(user_turns(
                        self,
                        codec,
                        first..tail,
                        lineage_from,
                        &context,
                    )?)
                }
            }
            None => {
                let span = system_rows(self, base..first)?;
                let context = span.keys().copied().collect();
                context_sources.extend(span);
                previous.as_ref().map_or(0, |seed| seed.covered_user_turns)
                    + user_turns(self, codec, base..first, lineage_from, &context)?
            }
        };
        let context_bytes = context_sources
            .values()
            .map(|source| source.message.to_string().len())
            .sum::<usize>();
        if context_bytes > MAX_CONTEXT_BYTES {
            return Ok(Err(CaptureRefusal::Oversize));
        }
        let (cut_mid, cut_digest, time_basis, reset_next) =
            if let Some(entry) = self.entries.get(&cut) {
                let raw = entry.read()?;
                let decoded = decoded_entry(codec, &entry.inbound()?)?;
                (
                    raw.mid.clone(),
                    served_digest(&raw)?,
                    Some((
                        decoded.ck.meta.created_at_ms,
                        decoded.ck.meta.completed_at_ms,
                    )),
                    decoded.ck.role != "assistant" && decoded.ck.role != "tool",
                )
            } else {
                // Re-advertising an already certified cut refreshes only its live
                // window. The closed prefix facts come from the existing seed.
                let seed = previous.as_ref().expect("renewal needs its prefix seed");
                (
                    seed.cut_mid.clone(),
                    seed.cut_digest.clone(),
                    seed.time_basis,
                    seed.historian_prelude
                        .as_ref()
                        .is_some_and(|p| p.reset_next),
                )
            };
        // Protected tool tags whose block is not in the window.
        let below = |block: &str| {
            self.mid_index
                .get(block_mid(block))
                .is_none_or(|ordinal| *ordinal < first)
        };
        let protection = match &certificate {
            Some(prefix) => {
                let (floor, ratio, rows) = prefix.protection();
                SeedProtection {
                    floor,
                    ratio,
                    rows: rows.iter().filter(|row| below(&row.1)).cloned().collect(),
                }
            }
            None => {
                let model = self
                    .conditions
                    .as_ref()
                    .and_then(|conditions| conditions.get("model"))
                    .map(String::as_str)
                    .unwrap_or(&self.setup.model);
                let floor = loaded.meta.protected_tokens_effective.unwrap_or(0);
                let ratio =
                    crate::decision_calibration::DecisionCalibration::for_model(Some(model))
                        .tools_ratio;
                let rows = store
                    .load_tags_after(&namespace, i64::MIN)
                    .map_err(transient)?;
                let window =
                    crate::protection_window::ProtectionWindow::from_persisted_rows_calibrated(
                        &rows, floor, ratio,
                    );
                SeedProtection {
                    floor,
                    ratio,
                    rows: window
                        .member_rows
                        .into_iter()
                        .filter(|row| below(&row.block_id))
                        .map(|row| {
                            (
                                row.tag_number,
                                row.block_id,
                                row.kind,
                                row.token_count,
                                row.created_at_ms,
                            )
                        })
                        .collect(),
                }
            }
        };
        if protection.rows.len() > MAX_PROTECTION_ROWS {
            return Ok(Err(CaptureRefusal::Oversize));
        }
        let mut numbers = self
            .tag_index
            .iter()
            .filter(|(_, address)| address.ordinal < first)
            .filter_map(|(tag, _)| tags::parse_tag(tag))
            .collect::<Vec<_>>();
        numbers.sort_unstable();
        let pre_cut_tags = previous
            .as_ref()
            .map(|seed| seed.pre_cut_tags.clone())
            .unwrap_or_default()
            .into_iter()
            .chain(
                numbers
                    .first()
                    .zip(numbers.last())
                    .map(|(lo, hi)| (*lo, *hi)),
            )
            .reduce(|(lo, hi), (next_lo, next_hi)| (lo.min(next_lo), hi.max(next_hi)))
            .into_iter()
            .collect::<Vec<_>>();
        let max_tag = numbers
            .last()
            .copied()
            .into_iter()
            .chain(previous.as_ref().map(|seed| seed.max_tag))
            .max()
            .unwrap_or(0);
        let mut todo = previous.as_ref().and_then(|seed| seed.todo.clone());
        if let (Some(state_json), Some(owner), Some(hash)) = (
            &loaded.meta.last_todo_state,
            &loaded.meta.last_todo_state_owner_message_id,
            &loaded.meta.last_todo_state_hash,
        ) {
            if self
                .mid_index
                .get(owner)
                .is_none_or(|ordinal| *ordinal < first)
            {
                // The transcript scan already proved this is the latest todo;
                // when its owner is below the cut, no older rows need decoding.
                todo = Some(SeedTodo {
                    state_json: state_json.clone(),
                    owner_message_id: owner.clone(),
                    state_hash: hash.clone(),
                });
            } else {
                let mut scan = super::super::runner_todo::TodoScan::default();
                if let Some(latest) = scan.advance(
                    self.lineage.as_deref().unwrap_or_default(),
                    &prepared(self, codec, base..first, lineage_from)?.messages,
                ) {
                    todo = Some(SeedTodo {
                        state_json: latest.state_json,
                        owner_message_id: latest.owner_message_id,
                        state_hash: latest.state_hash,
                    });
                }
            }
        }
        // The window's state, keyed by the window's messages.
        let window_mids: HashSet<&str> = self
            .entries
            .range(first..)
            .map(|(_, entry)| entry.mid.as_str())
            .collect();
        let in_window = |block: &str| window_mids.contains(block_mid(block));
        let window = CutWindow {
            entries: self
                .entries
                .range(first..)
                .map(|(ordinal, entry)| (*ordinal, entry.raw().to_owned()))
                .collect(),
            frozen_units: loaded
                .core
                .frozen_units
                .iter()
                .filter(|unit| {
                    frozen_unit_mid(&unit.key).is_some_and(|mid| window_mids.contains(mid))
                })
                .cloned()
                .collect(),
            emergency: Some((
                loaded.meta.last_emergency_input_sample,
                loaded.meta.has_prior_emergency_drop,
                loaded.meta.last_execute_ordinal,
            )),
            pending_drops: store
                .load_pending_agent_drops(&namespace)
                .map_err(transient)?
                .into_iter()
                .filter(|drop| in_window(&drop.target_id))
                .map(|drop| (drop.target_id, drop.queued_at_ms))
                .collect(),
            frozen_edits: Some(
                self.frozen_edits
                    .only_mids(&window_mids.iter().map(|mid| (*mid).to_owned()).collect())
                    .json()?,
            ),
            ..CutWindow::default()
        };
        let mut window = window;
        // The folded head, keeping the per-message state of the window and of
        // the context sources (which still render).
        let context_mids: HashSet<String> = context_sources
            .values()
            .map(|source| source.mid.clone())
            .collect();
        let keep = |mid: &str| window_mids.contains(mid) || context_mids.contains(mid);
        window.head = store
            .load_namespace_head(&namespace)
            .map_err(transient)?
            .map(|mut head| {
                for units in [&mut head.core.frozen_units, &mut head.core.pending_changes] {
                    units.retain(|unit| frozen_unit_mid(&unit.key).is_none_or(keep));
                }
                head.retain_messages(keep);
                head
            });
        if let Some(prefix) = self
            .logical_prefix
            .as_ref()
            .filter(|prefix| !prefix.is_cut() && prefix.tail_from >= first)
            .filter(|prefix| {
                self.entries
                    .matches(self.prefix_input_proof.as_ref(), prefix.tail_from)
            })
        {
            let mut held = held_entries::HeldEntries::default();
            held.proof_before(prefix.tail_from);
            for (ordinal, entry) in self.entries.range(first..prefix.tail_from) {
                held.insert(*ordinal, Arc::clone(entry));
            }
            window.certificate =
                Some((prefix.as_ref().clone(), held.proof_before(prefix.tail_from)));
        }
        let record = serde_json::to_value(&*self).map_err(transient)?;
        window.record = Some(
            RECORD_KEEP
                .iter()
                .filter_map(|key| Some(((*key).to_owned(), record.get(*key)?.clone())))
                .collect(),
        );
        window.produced_view = self
            .produced_view
            .as_ref()
            .map(|view| view.json.to_string());
        window.applied_view = self.applied_view.as_ref().map(|view| view.json.to_string());
        let (views, high) = store
            .load_async_compaction_views(&self.reference())
            .map_err(transient)?;
        window.views = views;
        window.views_high_water = high;
        window.engine_versions = (self.engine.version_high_water, self.engine.rebuild_epoch);
        let historian_prelude = match self.capture_historian_prelude(
            store,
            previous.as_deref(),
            historian_window,
            first,
            reset_next,
        )? {
            Ok(prelude) => prelude,
            Err(reason) => return Ok(Err(reason)),
        };
        let summary_end = compartments
            .iter()
            .filter_map(|c| u64::try_from(c.end_message).ok())
            .chain(loaded.meta.coverage_ordinal)
            .max();
        if summary_end.is_none_or(|end| end > cut) {
            return Ok(Err(CaptureRefusal::SummaryBeyondCut));
        }
        let mut seed = CutSeed {
            historian_prelude: Some(historian_prelude),
            recovery_history: Vec::new(),
            recovery_history_ref: None,
            pending_history_objects: BTreeMap::new(),
            window,
            first_ordinal: first,
            lineage_from,
            cut_mid,
            cut_digest,
            compartment_seq: loaded.meta.coverage_compartment_seq.unwrap_or_else(|| {
                newest_compartment.map_or(loaded.meta.folded_compartment_seq, |c| c.sequence)
            }),
            boundary_id: if loaded.core.boundary_id.is_empty() {
                newest_compartment.map_or_else(String::new, |c| c.end_message_id.clone())
            } else {
                loaded.core.boundary_id.clone()
            },
            context_sources,
            time_basis,
            signature_prefix: if let Some(signature) = self
                .cut_signature
                .as_ref()
                .filter(|prefix| prefix.first == first)
            {
                Some(signature.clone())
            } else {
                let previous_signature = self
                    .cut_signature
                    .as_ref()
                    .filter(|prefix| prefix.first <= first)
                    .or_else(|| {
                        previous
                            .as_ref()
                            .and_then(|seed| seed.signature_prefix.as_ref())
                    });
                let signature_base = previous_signature.map_or(base, |prefix| prefix.first);
                crate::tail_hygiene::signature::SignaturePrefix::capture(
                    first,
                    previous_signature,
                    &ck_wire::project_messages(
                        &prepared(self, codec, signature_base..first, lineage_from)?.messages,
                    )
                    .map_err(transient)?,
                )
            },
            covered_user_turns,
            real_users,
            tool_results,
            messages,
            last_user,
            orphan_result,
            protection: Some(protection),
            pre_cut_tags,
            max_tag,
            todo,
        };
        seed.set_recovery_history(
            compartments,
            store
                .compartment_history_identity(&self.namespace())
                .map_err(transient)?,
            summary_end,
        )?;
        Ok(Ok(seed))
    }
}

/// One named refusal to prune below a cut.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum PruneRefusal {
    /// The seed is not for a cut above this record's current first row, or
    /// the record does not hold its first window message.
    NotAhead,
    /// A view this record still serves or may serve renders a row below the
    /// cut.
    RenderedBelow,
}

/// The message a frozen engine unit edits, by its key: `red:` and `cav:`
/// name a block, `strip:<kind>:` a block or a message.
fn frozen_unit_mid(key: &str) -> Option<&str> {
    if let Some(block) = key
        .strip_prefix("red:")
        .or_else(|| key.strip_prefix("cav:"))
    {
        return Some(block_mid(block));
    }
    let rest = key.strip_prefix("strip:")?;
    let (_, target) = rest.rsplit_once(':')?;
    Some(block_mid(target))
}

impl AsyncRecord {
    /// The running totals a fold over the held entries starts from: what the
    /// cut seed stands for, or nothing.
    pub(super) fn base_aggregates(&self) -> resident::Aggregates {
        self.cut_seed
            .as_ref()
            .map_or_else(Default::default, |seed| seed.base_aggregates())
    }

    /// Begin this conversation at a cut: the record holds no rows yet and
    /// its first read starts at the seed's first ordinal. Its engine
    /// namespace has the compartments covering everything below the cut and
    /// nothing derived from the transcript; the first engine pass is the
    /// engine's own bootstrap over the seed's context sources and the window
    /// (see `async_engine`).
    pub(super) fn begin_at_cut(
        &mut self,
        store: &McStore,
        seed: CutSeed,
        start: CutStart,
    ) -> Result<(), HandlerOutcome> {
        if !self.entries.is_empty() {
            return Err(invalid(
                "a conversation begins at a cut only before it holds rows",
            ));
        }
        if start == CutStart::Descending {
            if !seed.boundary_safe() {
                return Err(error(
                    "unsafe_cut_seed",
                    "the stored head requires a fresh full lineage",
                ));
            }
            return self.adopt_folded_head(store, seed);
        }
        self.stage_fresh_cut(store, seed)?;
        self.save(store, &[])
    }

    /// Initialize the namespace and stage fresh cut fields without saving the
    /// provider record. Setup saves the complete answer and validated window
    /// together, so a retry cannot see a half-started lineage.
    pub(super) fn stage_fresh_cut(
        &mut self,
        store: &McStore,
        mut seed: CutSeed,
    ) -> Result<(), HandlerOutcome> {
        if !self.entries.is_empty() {
            return Err(invalid(
                "a conversation begins at a cut only before it holds rows",
            ));
        }
        if seed.summary_end().is_none() {
            seed.set_recovery_history(
                store
                    .load_compartments(&self.namespace())
                    .map_err(transient)?,
                store
                    .compartment_history_identity(&self.namespace())
                    .map_err(transient)?,
                None,
            )?;
        }
        if !seed.boundary_safe() {
            return Err(error(
                "unsafe_cut_seed",
                "the stored head requires a fresh full lineage",
            ));
        }
        self.initialize_cut_namespace(store, &seed)?;
        if let Some(json) = &seed.window.frozen_edits {
            self.frozen_edits = frozen_edits::FrozenEdits::from_json(json)?;
            self.frozen_edits.dirty = true;
        }
        if let Some(todo) = &seed.todo {
            store
                .set_todo_state(
                    &self.namespace(),
                    &todo.state_json,
                    &todo.owner_message_id,
                    &todo.state_hash,
                )
                .map_err(transient)?;
        }
        self.todo_scan = self
            .lineage
            .as_deref()
            .map(|lineage| seed.todo_scan(lineage));
        self.cut_first_ordinal = Some(seed.first_ordinal);
        // Adoption consumed the cached window. Ordinary restarts need only
        // prefix facts and the immutable history reference, not another cache.
        seed.window = CutWindow::default();
        self.cut_seed = Some(Arc::new(seed));
        self.aggregates = self.base_aggregates();
        self.journal.cut_seed_dirty = true;
        Ok(())
    }

    pub(super) fn initialize_cut_namespace(
        &self,
        store: &McStore,
        seed: &CutSeed,
    ) -> Result<(), HandlerOutcome> {
        // Commit the history's coverage through the cut in the engine
        // namespace first, as the fold that made the cut did: the seeded
        // boundary adopts it from the compartments, and the engine's first
        // pass is its own bootstrap fold over a namespace whose rows below
        // the cut are covered history, not tail.
        if !seed.boundary_id.is_empty() {
            // Setup's initial view initializes the namespace without folding
            // anything. A namespace that has covered nothing takes the seed
            // as a fresh one would; one with coverage keeps its own boundary.
            let namespace = self.namespace();
            let loaded = store.load_meta(&namespace).map_err(transient)?;
            if loaded.meta.initialized && loaded.meta.coverage_ordinal.is_none() {
                let mut meta = loaded.meta;
                meta.initialized = false;
                store
                    .commit_meta(&namespace, loaded.row_version, &meta)
                    .map_err(transient)?;
            }
            let seq_before = store
                .load_meta(&namespace)
                .map_err(transient)?
                .meta
                .shadow_seq;
            let pending_drops = seed
                .window
                .pending_drops
                .iter()
                .map(
                    |(block_id, queued_at_ms)| mc_store::PendingAgentDropSeedRow {
                        block_id: block_id.clone(),
                        queued_at_ms: *queued_at_ms,
                    },
                )
                .collect::<Vec<_>>();
            store
                .apply_authority_state_sync(mc_store::ModuleStateSyncRequest {
                    resolved_compartment_boundaries: &[],
                    session_id: &self.namespace(),
                    project_path: &self.project().to_string_lossy(),
                    shadow_generation: 0,
                    expected_shadow_seq: 0,
                    seed_boundary_id: Some(&seed.boundary_id),
                    drop_seeds: &[],
                    drop_seed_skipped: 0,
                    strip_seeds: &[],
                    strip_seed_skipped: 0,
                    reasoning_cleared_through_tag: None,
                    last_todo_state: None,
                    pending_agent_drops: &pending_drops,
                    pending_agent_drops_skipped: 0,
                    user_hint_seeds: &[],
                    auto_search_hint_skipped: 0,
                    note_nudge_anchors: None,
                    todo_synthetic_anchor: None,
                    todo_synthetic_anchor_present: false,
                    emergency_latches: seed.window.emergency,
                    pending_compaction_marker: None,
                    deferred_execute_state: None,
                    channel2_nudge_state: None,
                    acked_watermarks: Value::Null,
                })
                .map_err(|error| transient(format!("{error:?}")))?;
            // The window's frozen units, verbatim: the drop-seed slot would
            // rebuild reductions as generic drops and has no caveman form,
            // while these hold the exact bytes already served. The state
            // sync also counts itself in `shadow_seq`; the async lane has no
            // host shadow, so the count is put back to what the namespace
            // had, as if the fold that made the cut had committed directly.
            let units = seed.window.frozen_units.clone();
            commit_cache_state(store, &namespace, |loaded| {
                for unit in &units {
                    if !loaded
                        .core
                        .frozen_units
                        .iter()
                        .any(|held| held.key == unit.key)
                    {
                        loaded.core.frozen_units.push(unit.clone());
                    }
                }
                loaded.meta.shadow_seq = seq_before;
            })?;
        }
        Ok(())
    }

    /// Whether a Setup that names `descends_from` continues from a cut this
    /// conversation published and the runner applied: the same lineage, and
    /// a retained view whose cut (with an `applied` marker outcome) ends at
    /// the named ordinal. Anything else is a fresh start.
    pub(super) fn cut_start(
        &self,
        store: &McStore,
        descends_from: Option<&compact::lineage::DescendsFrom>,
    ) -> Result<CutStart, HandlerOutcome> {
        let Some(descends) = descends_from else {
            return Ok(CutStart::Fresh);
        };
        if self.lineage.as_deref() != Some(descends.lineage_id.as_str()) {
            return Ok(CutStart::Fresh);
        }
        for (cut_id, outcome) in &self.marker_outcomes {
            let Some(version) = cut_id
                .strip_prefix('v')
                .and_then(|version| version.parse::<u64>().ok())
                .filter(|_| outcome == "applied")
            else {
                continue;
            };
            let Some(raw) = store
                .load_async_compaction_view(&self.reference(), version)
                .map_err(transient)?
            else {
                continue;
            };
            let view: view::CompactionView = serde_json::from_str(&raw).map_err(transient)?;
            if view.cut.as_ref().is_some_and(|cut| {
                cut.cut_id == *cut_id && cut.through_ordinal == descends.through_ordinal
            }) {
                return Ok(CutStart::Descending);
            }
        }
        Ok(CutStart::Fresh)
    }

    /// Begin a lineage that descends from a cut this conversation published:
    /// adopt the namespace's folded head and the record's cadence state as
    /// they stand, with the window's state, so nothing is rebuilt.
    fn adopt_folded_head(
        &mut self,
        store: &McStore,
        mut seed: CutSeed,
    ) -> Result<(), HandlerOutcome> {
        let first = seed.first_ordinal;
        let head = seed
            .window
            .head
            .as_ref()
            .ok_or_else(|| invalid("a descending cut needs the namespace's folded head"))?;
        store
            .adopt_namespace_head(&self.namespace(), head)
            .map_err(transient)?;
        for (key, value) in seed.window.record.iter().flatten() {
            let value = value.clone();
            match key.as_str() {
                "seq" => self.seq = serde_json::from_value(value).map_err(transient)?,
                "completed_seq" => {
                    self.completed_seq = serde_json::from_value(value).map_err(transient)?
                }
                "applied" => self.applied = serde_json::from_value(value).map_err(transient)?,
                "acknowledgements" => {
                    self.acknowledgements = serde_json::from_value(value).map_err(transient)?
                }
                "marker_outcomes" => {
                    self.marker_outcomes = serde_json::from_value(value).map_err(transient)?
                }
                "frozen_edits_version" => {
                    self.frozen_edits_version = serde_json::from_value(value).map_err(transient)?
                }
                "usage_policy" => {
                    self.usage_policy = serde_json::from_value(value).map_err(transient)?
                }
                "reminder_cadence" => {
                    self.reminder_cadence = serde_json::from_value(value).map_err(transient)?
                }
                "reminder_baseline_generation" => {
                    self.reminder_baseline_generation =
                        serde_json::from_value(value).map_err(transient)?
                }
                "historian_cadence" => {
                    self.historian_cadence = serde_json::from_value(value).map_err(transient)?
                }
                "historian_pending" => {
                    self.historian_pending = serde_json::from_value(value).map_err(transient)?
                }
                "reminder_echoes" => {
                    let mut echoes: reminder_echoes::ReminderEchoes =
                        serde_json::from_value(value).map_err(transient)?;
                    // Covered prelude rows still need their original reminder
                    // classification when the historian replays that suffix.
                    echoes
                        .truncate_below(seed.historian_prelude.as_ref().map_or(first, |p| p.from));
                    self.reminder_echoes = echoes;
                }
                _ => {}
            }
        }
        if let Some(json) = &seed.window.frozen_edits {
            self.frozen_edits = frozen_edits::FrozenEdits::from_json(json)?;
            self.frozen_edits.dirty = true;
        }
        let (high, epoch) = seed.window.engine_versions;
        self.engine.version_high_water = self.engine.version_high_water.max(high);
        self.engine.rebuild_epoch = epoch;
        store
            .adopt_async_compaction_views(
                &self.reference(),
                &seed.window.views,
                seed.window.views_high_water,
            )
            .map_err(transient)?;
        for (version, _, engine, _) in &seed.window.views {
            if let Some(engine) = engine {
                self.published_engine
                    .insert(*version, EngineView::parse(engine.clone())?);
            }
        }
        self.produced_view = seed
            .window
            .produced_view
            .clone()
            .map(EngineView::parse)
            .transpose()?;
        self.applied_view = seed
            .window
            .applied_view
            .clone()
            .map(EngineView::parse)
            .transpose()?;
        for (ordinal, raw) in &seed.window.entries {
            let entry = HeldEntry::from_stored(raw.clone())?;
            #[cfg(test)]
            let entry = entry.counted_as(self.reference());
            self.entries.insert(*ordinal, Arc::new(entry));
        }
        if let Some((prefix, proof)) = &seed.window.certificate {
            let mut prefix = prefix.clone();
            prefix.generation = self.generation;
            prefix
                .rebase_tag_summary(store, &self.namespace())
                .map_err(engine_error)?;
            self.entries.proof_before(prefix.tail_from);
            self.logical_prefix = Some(Arc::new(prefix));
            self.prefix_input_proof = Some(proof.clone());
        } else {
            self.logical_prefix = None;
            self.prefix_input_proof = None;
        }
        self.todo_scan = self
            .lineage
            .as_deref()
            .map(|lineage| seed.todo_scan(lineage));
        self.cut_first_ordinal = Some(first);
        seed.window = CutWindow::default();
        self.cut_seed = Some(Arc::new(seed));
        self.aggregates = self.base_aggregates();
        self.journal.cut_seed_dirty = true;
        let codec = codec::Codec::from_params(&Value::Object(self.setup.params.clone()))?;
        let rows = tag_rows(self, codec)?;
        self.save(store, &rows)
    }

    /// Remove every row below the seed's cut from this record and its engine
    /// namespace, and keep the seed. Permitted only when nothing a held view
    /// renders lies below the cut, so no later view can need a removed row.
    pub(super) fn prune_below_cut(
        &mut self,
        store: &McStore,
        mut seed: CutSeed,
    ) -> Result<Result<(), PruneRefusal>, HandlerOutcome> {
        let first = seed.first_ordinal;
        let base = self.cut_seed.as_ref().map_or(0, |held| held.first_ordinal);
        if first <= base || !self.entries.contains_key(&first) {
            return Ok(Err(PruneRefusal::NotAhead));
        }
        for view in self
            .produced_view
            .iter()
            .chain(&self.applied_view)
            .chain(self.published_engine.values())
        {
            if view.view()?.replacement.iter().any(|message| {
                !message.meta.synthetic && message.meta.ordinal.is_some_and(|n| n < first)
            }) {
                return Ok(Err(PruneRefusal::RenderedBelow));
            }
        }
        let kept: HashSet<&str> = seed
            .context_sources
            .values()
            .map(|source| source.mid.as_str())
            .collect();
        let below: HashSet<String> = self
            .entries
            .range(..first)
            .map(|(_, entry)| entry.mid.clone())
            .filter(|mid| !kept.contains(mid.as_str()))
            .collect();
        self.entries.retain(|ordinal, _| *ordinal >= first);
        self.mid_index.retain(|_, ordinal| *ordinal >= first);
        self.tag_index.retain(|_, address| address.ordinal >= first);
        self.reminder_echoes
            .truncate_below(seed.historian_prelude.as_ref().map_or(first, |p| p.from));
        self.frozen_edits.forget_mids(&below);
        self.retired_frozen.forget_mids(&below);
        self.aggregates.historian_input.truncate_below(first);
        if let Some(prelude) = &seed.historian_prelude {
            self.aggregates
                .historian_input
                .keep_prelude_start(prelude.from, prelude.ordinal_base);
        }
        self.entry_bytes = (None, 0);
        // A certificate whose tail is at or after the cut still describes the
        // held rows it omits: re-prove them without the removed ones.
        match self.logical_prefix.as_ref().map(|prefix| prefix.tail_from) {
            Some(tail) if tail >= first => {
                self.prefix_input_proof = Some(self.entries.proof_before(tail));
            }
            _ => {
                self.logical_prefix = None;
                self.prefix_input_proof = None;
            }
        }
        let namespace = self.namespace();
        let mids = below.iter().cloned().collect::<Vec<_>>();
        store
            .prune_namespace_messages(&namespace, &mids)
            .map_err(transient)?;
        // The removed tag rows moved the namespace's tag summary; the kept
        // certificate's protection rows still stand for them.
        if let Some(prefix) = &mut self.logical_prefix {
            Arc::make_mut(prefix)
                .rebase_tag_summary(store, &namespace)
                .map_err(engine_error)?;
        }
        commit_cache_state(store, &namespace, |loaded| {
            loaded
                .core
                .frozen_units
                .retain(|unit| frozen_unit_mid(&unit.key).is_none_or(|mid| !below.contains(mid)));
            let meta = &mut loaded.meta;
            meta.block_identity_by_mid
                .retain(|mid, _| !below.contains(mid));
            for set in [
                &mut meta.protected_tool_block_ids,
                &mut meta.pending_tag_block_ids,
                &mut meta.pending_user_hint_block_ids,
            ] {
                set.retain(|block| !below.contains(block_mid(block)));
            }
            meta.reclassified_synthetic_mids
                .retain(|mid| !below.contains(mid));
        })?;
        self.journal.truncate_below = Some(first);
        self.journal.persisted_through = self.entries.last_key_value().map(|(n, _)| *n);
        self.cut_first_ordinal = Some(first);
        seed.window = CutWindow::default();
        self.cut_seed = Some(Arc::new(seed));
        self.journal.cut_seed_dirty = true;
        self.save(store, &[])?;
        Ok(Ok(()))
    }
}

/// Discard a stored record written before cut seeds existed: it is rebuilt
/// through the reset a lineage change takes, in the next generation, and its
/// next read starts from the runner's first ordinal. Such records exist only
/// in tests; there is no migration.
pub(super) fn discard_older_record(
    state: &mut AsyncRecord,
    store: &McStore,
) -> Result<bool, HandlerOutcome> {
    if state.record_version >= RECORD_VERSION {
        return Ok(false);
    }
    state.record_version = RECORD_VERSION;
    state.cut_first_ordinal = None;
    state.cut_seed = None;
    state.reset(store)?;
    Ok(true)
}

/// Edit a namespace's cache state and commit it, retrying on a concurrent
/// write. Uses the logical snapshot and commit, as prefix hygiene does:
/// module code never rewrites the whole cache state. A namespace that was
/// never written is left alone.
fn commit_cache_state(
    store: &McStore,
    namespace: &str,
    mut edit: impl FnMut(&mut mc_store::LoadedState),
) -> Result<(), HandlerOutcome> {
    for _ in 0..4 {
        let mut loaded = store
            .load_logical_transform_snapshot(namespace, &[])
            .map_err(transient)?
            .loaded;
        if loaded.row_version.is_none() {
            return Ok(());
        }
        edit(&mut loaded);
        let committed = store.commit_logical_transform_with_provider_policy(
            namespace,
            mc_store::TransformCommit {
                expected: loaded.row_version,
                core: &loaded.core,
                meta: &loaded.meta,
                sections: mc_store::SectionsCommit {
                    base: loaded.sections.as_ref(),
                    meta_only_steps: 0,
                    frozen_clear: mc_store::FrozenClear::Explicit,
                },
                consumed_drop_ids: &[],
                first_applied_command_ids: &[],
                memory_revision: None,
                compartment_max_seq: None,
                project_root: None,
                first_divergence: None,
                scheduler_observation: None,
                scheduler_request_observed_at_ms: None,
                scheduler_full_array_fingerprint: None,
                scheduler_eligible_supersession_count: None,
                scheduler_withheld_by_tag_window: None,
                scheduler_withheld_by_exempt_message: None,
                scheduler_applied_supersession_count: None,
                scheduler_applied_reductions: false,
                overlays: mc_store::TransformOverlayBatch::default(),
            },
            None,
        );
        match committed {
            Ok(_) => return Ok(()),
            Err(mc_store::McStoreError::CasConflict { .. }) => continue,
            Err(error) => return Err(transient(error)),
        }
    }
    Err(transient("engine state kept changing while it was edited"))
}

/// Engine passes by provider store, for tests that compare how two
/// providers handled the same notices.
#[cfg(test)]
pub(super) mod pass_trace {
    use std::sync::Mutex;

    static PASSES: Mutex<Vec<(usize, String)>> = Mutex::new(Vec::new());

    pub fn record(provider: usize, line: String) {
        PASSES.lock().unwrap().push((provider, line));
    }

    /// The passes `provider` ran since the last call, in order.
    pub fn take(provider: usize) -> Vec<String> {
        let mut passes = PASSES.lock().unwrap();
        let (taken, kept) = std::mem::take(&mut *passes)
            .into_iter()
            .partition::<Vec<_>, _>(|(owner, _)| *owner == provider);
        *passes = kept;
        taken.into_iter().map(|(_, line)| line).collect()
    }
}

#[cfg(test)]
pub(super) mod notice_trace {
    use std::sync::Mutex;
    static DECISIONS: Mutex<Vec<(usize, u64, bool)>> = Mutex::new(Vec::new());
    pub fn record(provider: usize, sequence: u64, run: bool) {
        DECISIONS.lock().unwrap().push((provider, sequence, run));
    }
    pub fn take(provider: usize) -> Vec<(u64, bool)> {
        let mut decisions = DECISIONS.lock().unwrap();
        let (taken, kept) = std::mem::take(&mut *decisions)
            .into_iter()
            .partition::<Vec<_>, _>(|(owner, _, _)| *owner == provider);
        *decisions = kept;
        taken
            .into_iter()
            .map(|(_, sequence, run)| (sequence, run))
            .collect()
    }
}
