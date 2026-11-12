//! Incremental session-side projection. Transcript changes carry ordinals;
//! Ordinary notices touch changed transcript ordinals only. View and summary
//! publications refresh their cached effects; unchanged payloads are shared.
use super::*;
use crate::app_read::{Breakdown, BreakdownSummaries, Header, IndexRow, Update};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Token-weighted provenance, in increasing order of uncertainty. Keeping it
/// beside cached rows lets labels update without rescanning the transcript.
#[derive(Clone, Copy, Default)]
struct Sources([u64; 4]);
impl Sources {
    fn add(&mut self, tokens: u64, source: &str) {
        let at = match source {
            "runner" => 0,
            "counted" => 1,
            "reported" => 2,
            _ => 3,
        };
        self.0[at] += tokens;
    }
    fn adjust(&mut self, old: Self, new: Self) {
        for at in 0..4 {
            self.0[at] = self.0[at] - old.0[at] + new.0[at];
        }
    }
    fn estimated(self) -> bool {
        self.0[2] > 0 || self.0[3] > 0
    }
    fn dominant(self) -> &'static str {
        // max_by_key keeps the last equal weight: uncertainty wins a tie.
        let at = (0..4).max_by_key(|at| self.0[*at]).unwrap();
        ["runner", "counted", "reported", "estimate"][at]
    }
}

#[derive(Clone, PartialEq)]
struct PartInfo {
    id: String,
    kind: &'static str,
    tag: Option<u64>,
    tokens: u64,
    bytes: Option<u64>,
    tool: Option<String>,
    item_tokens: u64,
    source: &'static str,
    runner_tokens: Option<cortexkit_role_compaction::tokens::PartTokens>,
    origin: Option<Value>,
    /// Signed reasoning, which the runner strips at or before its signed
    /// floor.
    signed: bool,
}
#[derive(Clone)]
struct Cached {
    mid: String,
    digest: String,
    at_ms: u64,
    parts: Vec<PartInfo>,
    reasoning_measure: (u64, &'static str),
    user_origin: Option<Value>,
    row: Option<Arc<Message>>,
    raw: u64,
    user_text: [u64; 2],
    tool: u64,
    reasoning: u64,
    /// Raw, tool, reasoning, person text, then notice text provenance.
    sources: [Sources; 5],
    stamps: usize,
}
#[derive(Clone)]
struct Usage {
    mid: String,
    at_ms: u64,
    prompt: Option<u64>,
}
/// One history-head insert's token counts, kept while the view replays its
/// bytes unchanged (same `since`).
#[derive(Clone)]
struct HeadSlot {
    since: u64,
    /// The whole insert.
    total: u64,
    /// Its memory, project-docs and user-profile blocks.
    counts: [u64; 3],
}

#[derive(Clone, PartialEq)]
struct Replacement {
    since: u64,
    tokens: u64,
}

#[derive(Clone)]
pub(crate) struct Projection {
    pub(crate) head_read: crate::app_read::head::ReadState,
    identity: u64,
    model: String,
    live: BTreeMap<u64, Cached>,
    positions: HashMap<String, u64>,
    usages: BTreeMap<u64, Usage>,
    stamped: BTreeMap<u64, usize>,
    raw: u64,
    /// Person text, then notice text, accounted separately from other raw content.
    user_text: [u64; 2],
    tool: u64,
    reasoning: u64,
    sources: [Sources; 5],
    queued: usize,
    pub(crate) dirty: BTreeSet<String>,
    pub(crate) summaries_dirty: bool,
    ranges: BTreeMap<u64, u64>,
    compartments: Arc<Vec<Value>>,
    decisions: Arc<Vec<Value>>,
    decisions_revision: u64,
    view: Option<(u64, cortexkit_role_compaction::Digest)>,
    cut: Option<u64>,
    dropped: BTreeSet<lanes::PartKey>,
    dropped_messages: BTreeSet<String>,
    replacements: BTreeMap<lanes::PartKey, Replacement>,
    head: [u64; 4],
    head_slots: HashMap<String, HeadSlot>,
    /// The breakdown's summary items, and the baseline items they were made
    /// from: they are made again only for a baseline with other items.
    head_items: Arc<BreakdownSummaries>,
    head_items_from: Option<crate::summary::head::SummaryItems>,
    base: u64,
    initialized: bool,
    header: Option<Arc<Header>>,
    persisted: Option<(u64, String)>,
    snapshot_saved: Option<tokio::time::Instant>,
    snapshot_dirty: bool,
    snapshot_changed: Option<tokio::time::Instant>,
    snapshot_retry: Option<tokio::time::Instant>,
    snapshot_timer: Option<SnapshotTimer>,
    snapshot_rows: BTreeMap<String, Arc<Message>>,
    snapshot_removed: BTreeSet<String>,
    snapshot_reset: bool,
    snapshot_summaries: bool,
    pending_rows: BTreeMap<u64, IndexRow>,
    revert_from: Option<u64>,
    revert_dirty: Option<u64>,
    /// The signed floor's ordinal the rows were last made with: signed
    /// reasoning at or before it is not sent, so it counts as dropped.
    signed_floor: Option<u64>,
    #[cfg(test)]
    pub(crate) rebuilt_rows: usize,
    #[cfg(test)]
    pub(crate) head_rebuilds: usize,
}

// Speculative session copies share ownership of the timer, not cancellation:
// discarding a plan must not cancel the live projection's checkpoint.
type SnapshotTimer = Arc<CancelSnapshotTimer>;

struct CancelSnapshotTimer(tokio::task::AbortHandle);

impl Drop for CancelSnapshotTimer {
    fn drop(&mut self) {
        self.0.abort();
    }
}

const SNAPSHOT_DELAY: std::time::Duration = std::time::Duration::from_secs(60);

impl Default for Projection {
    fn default() -> Self {
        Self {
            head_read: Default::default(),
            identity: 0,
            model: String::new(),
            live: BTreeMap::new(),
            positions: HashMap::new(),
            usages: BTreeMap::new(),
            stamped: BTreeMap::new(),
            raw: 0,
            user_text: [0; 2],
            tool: 0,
            reasoning: 0,
            sources: [Sources::default(); 5],
            queued: 0,
            dirty: BTreeSet::new(),
            summaries_dirty: true,
            ranges: BTreeMap::new(),
            compartments: Arc::new(Vec::new()),
            decisions: Arc::new(Vec::new()),
            decisions_revision: u64::MAX,
            view: None,
            cut: None,
            dropped: BTreeSet::new(),
            dropped_messages: BTreeSet::new(),
            replacements: BTreeMap::new(),
            head: [0; 4],
            head_slots: HashMap::new(),
            head_items: Default::default(),
            head_items_from: None,
            base: 0,
            initialized: false,
            header: None,
            persisted: None,
            snapshot_saved: None,
            snapshot_dirty: false,
            snapshot_changed: None,
            snapshot_retry: None,
            snapshot_timer: None,
            snapshot_rows: BTreeMap::new(),
            snapshot_removed: BTreeSet::new(),
            snapshot_reset: false,
            snapshot_summaries: false,
            pending_rows: BTreeMap::new(),
            revert_from: None,
            revert_dirty: None,
            signed_floor: None,
            #[cfg(test)]
            rebuilt_rows: 0,
            #[cfg(test)]
            head_rebuilds: 0,
        }
    }
}
impl Projection {
    #[cfg(test)]
    pub(crate) fn summary_arc(&self) -> Arc<Vec<Value>> {
        self.compartments.clone()
    }
    pub(crate) fn revert(&mut self, from: u64) {
        if self.revert_dirty.is_none_or(|old| from < old) {
            self.pending_rows.retain(|ordinal, _| *ordinal < from);
        }
        self.revert_from = Some(self.revert_from.map_or(from, |old| old.min(from)));
        self.revert_dirty = Some(self.revert_dirty.map_or(from, |old| old.min(from)));
    }
    fn summarized(&self, ordinal: u64) -> bool {
        self.ranges
            .range(..=ordinal)
            .next_back()
            .is_some_and(|(_, end)| ordinal <= *end)
    }
    fn remove(&mut self, ordinal: u64) {
        if let Some(old) = self.live.remove(&ordinal) {
            self.raw -= old.raw;
            for (total, old) in self.user_text.iter_mut().zip(old.user_text) {
                *total -= old;
            }
            self.tool -= old.tool;
            self.reasoning -= old.reasoning;
            for at in 0..5 {
                self.sources[at].adjust(old.sources[at], Sources::default());
            }
            if !self.summarized(ordinal) {
                self.queued -= old.stamps;
            }
            self.positions.remove(&old.mid);
            self.snapshot_rows.remove(&old.mid);
            self.snapshot_removed.insert(old.mid);
            self.usages.remove(&ordinal);
            self.stamped.remove(&ordinal);
        }
    }
}

impl Session {
    pub(crate) fn app_update(&mut self) -> Update {
        let mut p = std::mem::take(&mut self.app_projection);
        let model = format!(
            "{}/{}",
            self.conditions.model.provider, self.conditions.model.model
        );
        let model_changed = p.model != model;
        let counter = crate::count::Counter::for_model(Some(&model));
        p.model = model;
        #[cfg(test)]
        {
            p.rebuilt_rows = 0;
            p.head_rebuilds = 0;
        }
        let (identity, mut changed, truncated, pruned) = self.index.app_changes();
        if model_changed {
            changed.extend(self.index.entries().iter().map(|entry| entry.ordinal));
            p.head_slots.clear();
            p.replacements.clear();
        }
        if p.persisted.is_none() {
            p.persisted = Some(
                self.store
                    .as_ref()
                    .and_then(|s| s.app_index_tip(&self.key))
                    .unwrap_or((0, String::new())),
            );
        }
        if let Some(from) = truncated {
            p.revert(from);
        }
        let reset = identity != p.identity;
        let newest = self
            .index
            .entries()
            .last()
            .map_or(self.cut.unwrap_or(0), |e| e.ordinal);
        if reset {
            p.snapshot_reset = true;
            p.snapshot_rows.clear();
            p.snapshot_removed.clear();
            if self.index_ready {
                let (tip, mid) = p.persisted.as_ref().expect("initialized tip");
                if *tip > newest {
                    p.revert(newest + 1);
                } else if self.index.at(*tip).is_some_and(|e| &e.mid != mid) {
                    p.revert(self.index.base());
                }
            }
            p.live.clear();
            p.positions.clear();
            p.usages.clear();
            p.stamped.clear();
            p.raw = 0;
            p.tool = 0;
            p.reasoning = 0;
            p.queued = 0;
            p.identity = identity;
        }
        let reverted = p.revert_dirty.take();
        if let Some(from) = reverted {
            let removed: Vec<_> = p.live.range(from..).map(|(ordinal, _)| *ordinal).collect();
            for ordinal in removed {
                p.remove(ordinal);
            }
        }
        if let Some(base) = pruned {
            let removed: Vec<_> = p.live.range(..base).map(|(ordinal, _)| *ordinal).collect();
            for ordinal in removed {
                p.remove(ordinal);
            }
        }
        let through = p
            .revert_from
            .map(|from| from.saturating_sub(1))
            .unwrap_or_else(|| p.persisted.as_ref().unwrap().0);
        for ordinal in changed {
            let Some(entry) = self.index.at(ordinal) else {
                continue;
            };
            if p.live.get(&ordinal).is_some_and(|old| old.mid != entry.mid) {
                p.remove(ordinal);
            }
            p.positions.insert(entry.mid.clone(), ordinal);
            let reasoning: Vec<_> = entry
                .parts
                .iter()
                .filter(|part| matches!(part.body, PartBody::Reasoning { .. }))
                .collect();
            let measure = lanes::reasoning_measure(entry, &reasoning);
            let user_origin =
                (entry.role == cortexkit_role_compaction::read::Role::User).then(|| {
                    if let Some(notice) = &entry.notice {
                        let mut origin = json!({"kind":"notice", "sender":notice.sender});
                        if let Some(agent) = &entry.speaks_for {
                            origin["speaks_for"] = json!(agent);
                        }
                        origin
                    } else if let Some(agent) = &entry.speaks_for {
                        let mut origin = json!({"kind":"agent", "agent_id":agent.agent_id});
                        if let Some(name) = &agent.name {
                            origin["name"] = json!(name);
                        }
                        origin
                    } else {
                        json!({"kind":"person"})
                    }
                });
            let row = p.live.entry(ordinal).or_insert_with(|| Cached {
                mid: entry.mid.clone(),
                digest: String::new(),
                at_ms: entry.written_at,
                parts: Vec::new(),
                reasoning_measure: (0, "estimate"),
                user_origin: None,
                row: None,
                raw: 0,
                user_text: [0; 2],
                tool: 0,
                reasoning: 0,
                sources: [Sources::default(); 5],
                stamps: 0,
            });
            if model_changed
                || row.row.is_none()
                || row.digest != entry.digest
                || row.reasoning_measure != measure
                || row.user_origin != user_origin
                || row
                    .parts
                    .iter()
                    .zip(&entry.parts)
                    .any(|(old, new)| old.runner_tokens != new.tokens)
            {
                let mut weights = reasoning_weights(&reasoning, measure.0).into_iter();
                row.parts = entry
                    .parts
                    .iter()
                    .map(|part| {
                        let (item_tokens, source) =
                            if matches!(part.body, PartBody::Reasoning { .. }) {
                                (weights.next().expect("reasoning part weight"), measure.1)
                            } else {
                                item_tokens(part, counter)
                            };
                        PartInfo {
                            id: part.id.clone(),
                            kind: kind(&part.body),
                            tag: part.tag,
                            tokens: if matches!(part.body, PartBody::Reasoning { .. }) {
                                item_tokens
                            } else {
                                crate::tokens::part(part)
                            },
                            item_tokens,
                            source,
                            runner_tokens: part.tokens,
                            signed: part.seal == cortexkit_role_compaction::part::Seal::Signed,
                            origin: if matches!(part.body, PartBody::Text { .. }) {
                                user_origin.clone()
                            } else {
                                None
                            },
                            tool: match &part.body {
                                PartBody::Tool(tool) => Some(tool.name.clone()),
                                _ => None,
                            },
                            bytes: match &part.body {
                                PartBody::Text { text } => Some(text.len() as u64),
                                PartBody::Reasoning { text_bytes, .. } => *text_bytes,
                                PartBody::Tool(tool) => tool.output_bytes,
                                _ => None,
                            },
                        }
                    })
                    .collect();
                row.digest = entry.digest.to_string();
                row.reasoning_measure = measure;
                row.user_origin = user_origin;
                p.dirty.insert(entry.mid.clone());
            }
            row.at_ms = entry.written_at;
            if let Some(usage) = entry.usage {
                p.usages.insert(
                    ordinal,
                    Usage {
                        mid: entry.mid.clone(),
                        at_ms: entry.completed_at.unwrap_or(entry.written_at),
                        prompt: usage.prompt_tokens,
                    },
                );
            } else {
                p.usages.remove(&ordinal);
            }
            if ordinal > through {
                p.pending_rows.insert(
                    ordinal,
                    IndexRow {
                        mid: entry.mid.clone(),
                        ordinal,
                        at_ms: entry.written_at,
                    },
                );
            }
        }
        let compartments = if p.summaries_dirty {
            p.ranges = summary_ranges(&self.summaries);
            p.compartments = Arc::new(self.summaries.iter().map(compartment).collect());
            p.queued = p
                .stamped
                .iter()
                .filter(|(ordinal, _)| !p.summarized(**ordinal))
                .map(|(_, count)| count)
                .sum();
            p.summaries_dirty = false;
            Some(p.compartments.clone())
        } else {
            None
        };
        let (view, cut) = self
            .unconfirmed
            .first()
            .map_or((self.latest.as_ref(), self.cut), |pending| {
                (pending.before.latest.as_ref(), pending.before.cut)
            });
        let view_changed = model_changed
            || reset
            || !p.initialized
            || p.cut != cut
            || p.view.as_ref().map(|(v, h)| (*v, h)) != view.map(|v| (v.version, &v.checksum));
        if view_changed {
            let mut dropped = BTreeSet::new();
            let mut messages = BTreeSet::new();
            let mut replacements = BTreeMap::new();
            for edit in view.map(|v| v.edits.as_slice()).unwrap_or_default() {
                match &edit.op {
                    EditOp::Drop {
                        mid,
                        part: Some(part),
                    } => {
                        dropped.insert((mid.clone(), part.clone()));
                    }
                    EditOp::Drop { mid, part: None } => {
                        messages.insert(mid.clone());
                    }
                    EditOp::Replace {
                        mid,
                        part,
                        field,
                        value,
                        ..
                    } => {
                        if matches!(field.as_str(), "text" | "output") {
                            if let Some(text) = value.as_str() {
                                let key = (mid.clone(), part.clone());
                                let tokens = p
                                    .replacements
                                    .get(&key)
                                    .filter(|old| old.since == edit.since)
                                    .map_or_else(|| counter.count(text), |old| old.tokens);
                                replacements.insert(
                                    key,
                                    Replacement {
                                        since: edit.since,
                                        tokens,
                                    },
                                );
                            }
                        }
                        let info = p
                            .positions
                            .get(mid)
                            .and_then(|ord| p.live.get(ord))
                            .and_then(|row| row.parts.iter().find(|info| &info.id == part));
                        let permanent = info.is_none_or(|info| match (info.kind, field.as_str()) {
                            ("file", "text") => true,
                            ("text", "text") | ("tool", "output") => {
                                info.tag.map(|tag| format!("[dropped §{tag}§]")).as_deref()
                                    == value.as_str()
                            }
                            ("tool", _) => false,
                            _ => true,
                        });
                        if permanent {
                            dropped.insert((mid.clone(), part.clone()));
                        }
                    }
                    _ => {}
                }
            }
            p.dirty.extend(
                p.dropped
                    .symmetric_difference(&dropped)
                    .map(|key| key.0.clone()),
            );
            p.dirty
                .extend(p.dropped_messages.symmetric_difference(&messages).cloned());
            for key in p.replacements.keys().chain(replacements.keys()) {
                if p.replacements.get(key) != replacements.get(key) {
                    p.dirty.insert(key.0.clone());
                }
            }
            if p.cut != cut {
                let end = p.cut.unwrap_or(0).max(cut.unwrap_or(0));
                p.dirty
                    .extend(p.live.range(..=end).map(|(_, row)| row.mid.clone()));
            }
            p.dropped = dropped;
            p.dropped_messages = messages;
            p.replacements = replacements;
            p.cut = cut;
            p.view = view.map(|view| (view.version, view.checksum.clone()));
            // The head is counted in the reading model's vocabulary, as the
            // head composer counts it against its budgets.
            let (head, rebuilt) = head_counts(view, &mut p.head_slots, counter);
            p.head = head;
            let source = self
                .unconfirmed
                .first()
                .map_or(self.baseline.as_ref(), |pending| {
                    pending.before.baseline.as_ref()
                })
                .map(|baseline| &baseline.summary_items);
            let made = match (&p.head_items_from, source) {
                (Some(from), Some(items)) => from.same(items),
                (None, None) => true,
                _ => false,
            };
            if !made {
                p.head_items = Arc::new(BreakdownSummaries::new(
                    source
                        .map(|items| {
                            items
                                .iter()
                                .map(|item| {
                                    json!({
                                        "item":"summary", "compartment_id":item.compartment_id,
                                        "tier":item.tier, "tokens":item.tokens, "source":"counted"
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                ));
                p.head_items_from = source.cloned();
            }
            #[cfg(test)]
            {
                p.head_rebuilds = rebuilt;
            }
            #[cfg(not(test))]
            let _ = rebuilt;
        }
        // A moved signed floor changes which reasoning is sent in every row
        // with signed parts at or before it, old floor or new.
        let signed_floor = self.signed_floor();
        if p.signed_floor != signed_floor {
            let end = p.signed_floor.max(signed_floor).unwrap_or(0);
            p.dirty.extend(
                p.live
                    .range(..=end)
                    .filter(|(_, row)| row.parts.iter().any(|part| part.signed))
                    .map(|(_, row)| row.mid.clone()),
            );
            p.signed_floor = signed_floor;
        }
        let mut rows = Vec::new();
        for mid in std::mem::take(&mut p.dirty) {
            let Some(ordinal) = p.positions.get(&mid).copied() else {
                continue;
            };
            let summarized = p.summarized(ordinal);
            let cached = p.live.get_mut(&ordinal).expect("live position");
            p.raw -= cached.raw;
            for (total, old) in p.user_text.iter_mut().zip(cached.user_text) {
                *total -= old;
            }
            p.tool -= cached.tool;
            p.reasoning -= cached.reasoning;
            if !summarized {
                p.queued -= cached.stamps;
            }
            let (message, raw, tool, reasoning, user_text, stamps, sources) = message(
                self,
                cached,
                ordinal,
                &p.dropped,
                &p.dropped_messages,
                &p.replacements,
                cut,
            );
            cached.raw = raw;
            cached.user_text = user_text;
            cached.tool = tool;
            cached.reasoning = reasoning;
            cached.stamps = stamps;
            for (at, source) in sources.iter().enumerate() {
                p.sources[at].adjust(cached.sources[at], *source);
            }
            cached.sources = sources;
            p.raw += raw;
            for (total, count) in p.user_text.iter_mut().zip(user_text) {
                *total += count;
            }
            p.tool += tool;
            p.reasoning += reasoning;
            if !summarized {
                p.queued += stamps;
            }
            if stamps == 0 {
                p.stamped.remove(&ordinal);
            } else {
                p.stamped.insert(ordinal, stamps);
            }
            let message = Arc::new(message);
            cached.row = Some(message.clone());
            rows.push((mid, message));
            #[cfg(test)]
            {
                p.rebuilt_rows += 1;
            }
        }
        let usage = p.usages.last_key_value().map(|(_, usage)| usage);
        let at = usage.map(|usage| usage.at_ms);
        let provider = self.conditions.last_prompt_tokens.or_else(|| {
            // After a stale reading the newest step's own usage is that same
            // stale request, so it doesn't stand in for the stored reading.
            usage.and_then(|u| u.prompt).filter(|_| !self.reading_stale)
        });
        let memory_count = self
            .unconfirmed
            .first()
            .map_or(self.baseline.as_ref(), |pending| {
                pending.before.baseline.as_ref()
            })
            .map_or(0, |b| b.seen.len());
        let surface = |name, counted: Option<cortexkit_role_compaction::tokens::SurfaceTokens>| {
            counted.map_or(PartTokens::unknown(name), |counted| PartTokens {
                part: name,
                tokens: Some(counted.count),
                estimate: !counted.exact,
            })
        };
        let attributed = |name, tokens, sources: Sources| PartTokens {
            part: name,
            tokens: Some(tokens),
            estimate: sources.estimated(),
        };
        let counted = |name, tokens| PartTokens {
            part: name,
            tokens: Some(tokens),
            estimate: false,
        };
        let notes = surface("notes", self.notes.measured);
        let notes_known = !self.notes.is_empty();
        let mut parts = vec![
            surface("system_prompt", self.surface_tokens.0),
            surface("tool_definitions", self.surface_tokens.1),
            counted("memory", p.head[0]),
            counted("project_docs", p.head[1]),
            counted("user_profile", p.head[2]),
            counted("history_summaries", p.head[3]),
            attributed("history_raw", p.raw, p.sources[0]),
            attributed("tool_calls_results", p.tool, p.sources[1]),
            attributed("reasoning", p.reasoning, p.sources[2]),
            counted("last_user_message", 0),
            attributed("user_messages", p.user_text[0], p.sources[3]),
            attributed("notices", p.user_text[1], p.sources[4]),
        ];
        if notes_known {
            parts.push(notes);
        }
        // The window the apps scale to is the usable one, as the standalone
        // plugin reports it: the model's window less the output reserve.
        let mut breakdown = breakdown(
            &parts,
            provider,
            crate::pass::usable_window(&self.conditions),
        );
        let mut sources = Sources::default();
        for source in p.sources {
            sources.adjust(Sources::default(), source);
        }
        sources.add(p.head.iter().sum(), "counted");
        for surface in [
            self.surface_tokens.0,
            self.surface_tokens.1,
            self.notes.measured,
        ]
        .into_iter()
        .flatten()
        {
            sources.add(surface.count, "runner");
        }
        breakdown["estimation_source"] = json!(sources.dominant());
        breakdown["managed"] = json!({"value":!self.tools_only&&!self.suspended});
        breakdown["as_of"] = json!({"step_ref":usage.map(|u|&u.mid),"at_ms":at});
        breakdown["parts"][2]["count"] = json!(memory_count);
        let mut items = vec![
            json!({"item":"system_prompt","tokens":parts[0].tokens,"source":if self.surface_tokens.0.is_some() {"runner"} else {"estimate"}}),
            json!({"item":"tool_definitions","tokens":parts[1].tokens,"source":if self.surface_tokens.1.is_some() {"runner"} else {"estimate"}}),
        ];
        if notes_known {
            items.push(json!({"item":"notes","tokens":self.notes.measured.map(|counted|counted.count),"source":if self.notes.measured.is_some() {"runner"} else {"estimate"}}));
        }
        for (item, tokens) in ["memory", "project_docs", "user_profile"]
            .into_iter()
            .zip(p.head)
        {
            items.push(json!({"item":item,"tokens":tokens,"source":"counted"}));
        }
        // The summary items follow these, shared from one list rather than
        // copied into each update ([`Breakdown`]).
        breakdown["items"] = json!(items);
        let mut summaries = p.head_items.clone();
        if self.tools_only || self.suspended {
            breakdown["total"] = Value::Null;
            breakdown["context_window"] = Value::Null;
            breakdown["parts"] = json!([]);
            breakdown["items"] = json!([]);
            summaries = Default::default();
            breakdown["unattributed"] = Value::Null;
            breakdown["estimation_source"] = Value::Null;
        }
        let meta = json!({"session_id":self.key.session,"compartment_count":self.summaries.len(),"newest_compartment_at_ms":self.summaries.last().map(|c|c.created_at),"queued_stamp_count":p.queued,"compartment_in_progress":self.summarizing,"historian_failure_count":self.app.failures,"historian_last_error":self.app.last_error,"memory_block_count":memory_count,"cache_ttl":null,"last_response_time_ms":at,"is_subagent":!self.features.summarizer,"last_input_tokens":provider,"execute_threshold":{"percentage":self.threshold.0,"tokens":(crate::pass::usable_window(&self.conditions) as f64 * self.threshold.0 / 100.0).floor() as u64,"source":self.threshold.1}});
        let header = Header {
            base: self.index.base(),
            newest,
            ready: self.index_ready,
            meta,
            breakdown: Breakdown::new(breakdown, summaries),
        };
        let header = if let Some(old) = p.header.as_ref().filter(|old| old.as_ref() == &header) {
            old.clone()
        } else {
            Arc::new(header)
        };
        p.header = Some(header.clone());
        let decisions = if p.decisions_revision != self.app_decisions_revision {
            p.decisions = Arc::new(self.app_decisions.clone());
            p.decisions_revision = self.app_decisions_revision;
            Some(p.decisions.clone())
        } else {
            None
        };
        let update = Update {
            head: {
                let mut head = p.head_read.clone();
                head.counter = Some(counter);
                head
            },
            key: self.key.clone(),
            header,
            rows,
            reset_from: if reset {
                Some(self.index.base())
            } else {
                reverted
            },
            prune_before: if p.base != self.index.base() {
                Some(self.index.base())
            } else {
                pruned
            },
            compartments,
            decisions,
            reverted: reverted.is_some(),
        };
        // Publishing consumes the projection's row dirtiness every update, but
        // checkpoints may wait a minute or fail. Retain the latest changed rows
        // independently until a transaction commits successfully.
        p.snapshot_rows.extend(update.rows.iter().cloned());
        p.snapshot_summaries |= update.compartments.is_some();
        let changed =
            !update.rows.is_empty() || update.reset_from.is_some() || update.prune_before.is_some();
        p.snapshot_dirty |= changed;
        if changed {
            p.snapshot_changed = Some(tokio::time::Instant::now());
        }
        p.base = self.index.base();
        p.initialized = true;
        self.app_projection = p;
        update
    }

    pub(crate) fn app_publish_update(&mut self, app: &crate::app_read::AppRead, checkpoint: bool) {
        let _timing = crate::notice_cost_timing::span("app.projection");
        let old_base = self.app_projection.base;
        let initialized = self.app_projection.initialized;
        let update = self.app_update();
        let checkpoint = checkpoint
            || (initialized && old_base != self.index.base())
            || update.reverted
            || (self.app_projection.snapshot_dirty
                && self
                    .app_projection
                    .snapshot_saved
                    .is_none_or(|saved| saved.elapsed() >= std::time::Duration::from_secs(60)));
        self.app_persist_index();
        if let Some(store) = &self.store {
            if self.app_decisions_dirty {
                match store.save_app_decisions(&self.key, &self.app_decisions) {
                    Ok(()) => self.app_decisions_dirty = false,
                    Err(error) => tracing::warn!("ck-mc: {error}"),
                }
            }
        }
        if checkpoint {
            self.app_save_snapshot();
        }
        app.update(update);
    }

    pub(crate) fn app_save_snapshot(&mut self) {
        if !self.app_projection.initialized {
            self.app_update();
        }
        if let Some(store) = &self.store {
            let p = &self.app_projection;
            let checkpoint = crate::app_read::persistence::Checkpoint::new(
                p.header.as_ref().expect("projection header"),
                p.snapshot_rows
                    .iter()
                    .map(|(mid, row)| (mid.as_str(), row.as_ref())),
                p.snapshot_summaries.then_some(p.compartments.as_slice()),
                p.snapshot_removed.iter().map(String::as_str),
                p.snapshot_reset,
            );
            match store.save_app_checkpoint(&self.key, &checkpoint) {
                Ok(()) => {
                    self.app_projection.snapshot_saved = Some(tokio::time::Instant::now());
                    self.app_projection.snapshot_dirty = false;
                    self.app_projection.snapshot_changed = None;
                    self.app_projection.snapshot_retry = None;
                    self.app_projection.snapshot_timer = None;
                    self.app_projection.snapshot_rows.clear();
                    self.app_projection.snapshot_removed.clear();
                    self.app_projection.snapshot_reset = false;
                    self.app_projection.snapshot_summaries = false;
                }
                Err(error) => {
                    // Keep the delta, but a busy store must not make an overdue
                    // timer retry continuously between session jobs.
                    self.app_projection.snapshot_retry =
                        Some(tokio::time::Instant::now() + SNAPSHOT_DELAY);
                    tracing::warn!("ck-mc: {error}");
                }
            }
        }
    }

    pub(crate) fn app_snapshot_deadline(&self) -> Option<tokio::time::Instant> {
        let p = &self.app_projection;
        (self.store.is_some() && p.snapshot_dirty && p.snapshot_timer.is_none())
            .then(|| {
                p.snapshot_changed.map(|changed| {
                    let due = changed + SNAPSHOT_DELAY;
                    p.snapshot_retry.map_or(due, |retry| due.max(retry))
                })
            })
            .flatten()
    }

    pub(crate) fn app_arm_snapshot(&mut self, timer: tokio::task::AbortHandle) {
        self.app_projection.snapshot_timer = Some(Arc::new(CancelSnapshotTimer(timer)));
    }

    pub(crate) fn app_checkpoint_if_due(&mut self, flush: bool) {
        self.app_projection.snapshot_timer = None;
        if self.app_projection.snapshot_dirty
            && (flush
                || self
                    .app_snapshot_deadline()
                    .is_some_and(|deadline| deadline <= tokio::time::Instant::now()))
        {
            self.app_save_snapshot();
        }
    }

    #[cfg(test)]
    pub(crate) fn app_age_snapshot(&mut self) {
        self.app_projection.snapshot_saved = Some(tokio::time::Instant::now() - SNAPSHOT_DELAY);
    }

    fn app_persist_index(&mut self) {
        let p = &mut self.app_projection;
        if p.pending_rows.is_empty() && p.revert_from.is_none() {
            return;
        }
        let rows: Vec<_> = p.pending_rows.values().cloned().collect();
        if let Some(store) = &self.store {
            if let Err(error) = store.save_app_index(&self.key, &rows, p.revert_from) {
                tracing::warn!("ck-mc: {error}");
                return;
            }
            p.persisted = Some(
                rows.last()
                    .map(|row| (row.ordinal, row.mid.clone()))
                    .unwrap_or_else(|| {
                        store.app_index_tip(&self.key).unwrap_or((0, String::new()))
                    }),
            );
        } else if let Some(last) = rows.last() {
            p.persisted = Some((last.ordinal, last.mid.clone()));
        }
        p.pending_rows.clear();
        p.revert_from = None;
    }

    pub(crate) fn app_persist_cut(&mut self, entries: &[cortexkit_role_compaction::read::Entry]) {
        let Some(store) = &self.store else {
            return;
        };
        let p = &mut self.app_projection;
        if p.persisted.is_none() {
            p.persisted = Some(store.app_index_tip(&self.key).unwrap_or((0, String::new())));
        }
        let through = p
            .revert_from
            .map(|from| from.saturating_sub(1))
            .unwrap_or_else(|| p.persisted.as_ref().unwrap().0);
        for entry in entries.iter().filter(|entry| entry.ordinal > through) {
            p.pending_rows.insert(
                entry.ordinal,
                IndexRow {
                    mid: entry.mid.clone(),
                    ordinal: entry.ordinal,
                    at_ms: entry.written_at,
                },
            );
        }
        self.app_persist_index();
    }

    #[cfg(test)]
    pub(super) fn app_materialize(&self) -> Snapshot {
        let p = &self.app_projection;
        let h = p.header.as_ref().expect("projection header");
        Snapshot {
            key: self.key.clone(),
            base: h.base,
            newest: h.newest,
            ready: h.ready,
            meta: h.meta.clone(),
            breakdown: h.breakdown.clone(),
            compartments: (*p.compartments).clone(),
            messages: p
                .live
                .values()
                .filter_map(|cached| {
                    cached
                        .row
                        .as_ref()
                        .map(|row| (cached.mid.clone(), (**row).clone()))
                })
                .collect(),
            decisions: (*p.decisions).clone(),
        }
    }

    pub(crate) fn app_prune_stamps(&mut self, keys: impl IntoIterator<Item = lanes::PartKey>) {
        for key in keys {
            self.app_projection.dirty.insert(key.0.clone());
            if !self.queued.contains(&key)
                && !self
                    .unconfirmed
                    .first()
                    .is_some_and(|pending| pending.before.queued.contains(&key))
            {
                self.app.stamps.remove(&key);
            }
        }
    }
}

fn message(
    session: &mut Session,
    cached: &Cached,
    ordinal: u64,
    dropped: &BTreeSet<lanes::PartKey>,
    messages: &BTreeSet<String>,
    replacements: &BTreeMap<lanes::PartKey, Replacement>,
    cut: Option<u64>,
) -> (Message, u64, u64, u64, [u64; 2], usize, [Sources; 5]) {
    let mut stamped = Vec::new();
    let mut gone = Vec::new();
    let mut raw = 0;
    let mut user_text = [0; 2];
    let mut tool = 0;
    let mut reasoning = 0;
    let mut tagged = 0;
    let mut items = Vec::with_capacity(cached.parts.len());
    let mut sources = [Sources::default(); 5];
    let before = session
        .unconfirmed
        .first()
        .map(|pending| &pending.before.queued);
    let cut = cut.is_some_and(|cut| ordinal <= cut);
    // The runner strips signed reasoning at or before its signed floor, so
    // the model never sees it: it counts like reasoning a view dropped.
    let floor = session.signed_floor().is_some_and(|floor| ordinal <= floor);
    for part in &cached.parts {
        tagged += usize::from(part.tag.is_some());
        let key = (cached.mid.clone(), part.id.clone());
        let removed = cut
            || messages.contains(&cached.mid)
            || dropped.contains(&key)
            || (floor && part.signed && part.kind == "reasoning");
        let queued =
            session.queued.contains(&key) || before.is_some_and(|queued| queued.contains(&key));
        let (tokens, source) =
            if cut || messages.contains(&cached.mid) || (removed && part.kind == "reasoning") {
                (0, "counted")
            } else if let Some(replacement) = replacements.get(&key) {
                (replacement.tokens, "counted")
            } else if removed {
                (0, "counted")
            } else {
                (part.item_tokens, part.source)
            };
        let mut item = json!({"part_ref":{"part_key":part.id},"kind":part.kind,"tokens":tokens,"source":source,"state":if removed {"dropped"} else if queued {"stamped"} else {"live"}});
        if let Some(origin) = &part.origin {
            item["origin"] = origin.clone();
        }
        if let Some(tool) = &part.tool {
            item["tool"] = json!(tool);
        }
        items.push(item);
        let size =
            json!({"bytes":part.bytes,"tokens":part.tokens,"input_bytes":null,"input_tokens":null});
        if queued && !removed {
            stamped.push(json!({"kind":part.kind,"part_ref":{"part_key":part.id},"size":size,"stage":"queued","stamped_at_ms":session.app.stamps.get(&key),"stamped_at_source":"recorded"}));
        }
        if !queued {
            session.app.stamps.remove(&key);
        }
        if removed && !cut {
            gone.push(json!({"kind":part.kind,"part_ref":{"part_key":part.id},"size":size,"dropped_at_ms":null,"dropped_at_source":"not_recorded","drop_mode":null}));
        } else if !removed {
            if part.kind == "tool" {
                tool += part.tokens;
                sources[1].add(part.tokens, source);
            } else if part.kind == "reasoning" {
                reasoning += tokens;
                sources[2].add(tokens, source);
            } else if let Some(origin) = &part.origin {
                let category = usize::from(origin["kind"] != "person");
                user_text[category] += part.tokens;
                sources[3 + category].add(part.tokens, source);
            } else {
                raw += part.tokens;
                sources[0].add(part.tokens, source);
            }
        }
    }
    let stamps = stamped.len();
    let state = if !cached.parts.is_empty() && gone.len() == cached.parts.len() {
        "dropped"
    } else {
        "raw"
    };
    (
        Message {
            ordinal,
            at_ms: cached.at_ms,
            row: json!({"message_id":cached.mid,"state":state,"compartment_id":null,"outside_reason":null,"split":null,"parts":{"tagged":tagged,"stamped":stamps,"dropped":gone.len()},"stamped_parts":stamped,"dropped_parts":gone,"items":items}),
        },
        raw,
        tool,
        reasoning,
        user_text,
        stamps,
        sources,
    )
}

fn reasoning_weights(reasoning: &[&cortexkit_role_compaction::part::Part], cost: u64) -> Vec<u64> {
    let sizes: Vec<u128> = reasoning
        .iter()
        .map(|part| match &part.body {
            PartBody::Reasoning { text_bytes, .. } => text_bytes.unwrap_or(0) as u128,
            _ => 0,
        })
        .collect();
    let total: u128 = sizes.iter().sum();
    let mut remaining = cost;
    sizes
        .iter()
        .enumerate()
        .map(|(at, size)| {
            // Visible sizes apportion the entry's replay cost, not just the
            // exposed text. Opaque-only entries split evenly; the last part
            // takes all rounding remainder so the shares always sum exactly.
            let share = if at + 1 == sizes.len() {
                remaining
            } else {
                (cost as u128 * size)
                    .checked_div(total)
                    .map_or_else(|| cost / sizes.len() as u64, |share| share as u64)
            };
            remaining -= share;
            share
        })
        .collect()
}

fn item_tokens(
    part: &cortexkit_role_compaction::part::Part,
    counter: crate::count::Counter,
) -> (u64, &'static str) {
    use cortexkit_role_compaction::tokens::PartTokens;
    match (&part.body, part.tokens) {
        (PartBody::Tool(tool), counts) => (
            crate::tokens::tool_result(part, tool),
            if matches!(counts, Some(PartTokens::Tool(_))) {
                "runner"
            } else {
                "estimate"
            },
        ),
        (PartBody::Text { .. } | PartBody::File(_), Some(PartTokens::Count(_))) => {
            (crate::tokens::part(part), "runner")
        }
        (PartBody::Text { text }, _) => (counter.count(text), "counted"),
        _ => (crate::tokens::part(part), "estimate"),
    }
}
fn kind(body: &PartBody) -> &'static str {
    match body {
        PartBody::Text { .. } => "text",
        PartBody::Reasoning { .. } => "reasoning",
        PartBody::Tool(_) => "tool",
        PartBody::File(_) => "file",
        PartBody::Opaque(_) => "opaque",
        _ => "opaque",
    }
}
fn compartment(c: &StoredCompartment) -> Value {
    json!({"compartment_id":c.sequence.to_string(), "ordinal":c.sequence, "title":c.title, "first_message_id":c.start_message_id, "last_message_id":c.end_message_id, "first_message_ordinal":c.start_message, "last_message_ordinal":c.end_message, "first_at_ms":null, "last_at_ms":null, "message_count":(c.end_message-c.start_message+1).max(0), "importance":c.importance, "summary_markdown":c.content, "summary_markdown_bytes":c.content.len(), "summary_markdown_truncated":false, "tiers":{"p1":c.p1, "p2":c.p2, "p3":c.p3, "p4":c.p4}, "tiers_bytes":{"p1":c.p1.as_ref().map(String::len), "p2":c.p2.as_ref().map(String::len), "p3":c.p3.as_ref().map(String::len), "p4":c.p4.as_ref().map(String::len)}, "tiers_truncated":{"p1":false,"p2":false,"p3":false,"p4":false}, "created_at_ms":c.created_at, "legacy":c.legacy!=0, "episode_type":c.episode_type, "facts":{"attribution":"historian_run", "by_category":{}, "session_facts_cursor":null}})
}

fn summary_ranges(summaries: &[StoredCompartment]) -> BTreeMap<u64, u64> {
    // Older summaries can share message boundaries. Cache their union so
    // messages already summarized are excluded from pending part removals,
    // regardless of overlapping ranges or row order.
    let mut spans: Vec<_> = summaries
        .iter()
        .map(|c| (c.start_message as u64, c.end_message as u64))
        .collect();
    spans.sort_unstable();
    let mut merged = Vec::<(u64, u64)>::new();
    for (start, end) in spans {
        if let Some(last) = merged.last_mut().filter(|last| start <= last.1) {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    merged.into_iter().collect()
}

fn head_counts(
    view: Option<&View>,
    slots: &mut HashMap<String, HeadSlot>,
    counter: crate::count::Counter,
) -> ([u64; 4], usize) {
    // An insert retains its `since` version while its bytes are replayed.
    // Dropping a conversation part must not re-count the unchanged large head.
    let mut previous = std::mem::take(slots);
    let mut rebuilt = 0;
    for edit in view.map(|view| view.edits.as_slice()).unwrap_or_default() {
        let EditOp::Insert { message, .. } = &edit.op else {
            continue;
        };
        let slot = previous
            .remove(&message.id)
            .filter(|slot| slot.since == edit.since)
            .unwrap_or_else(|| {
                rebuilt += 1;
                let text = message.texts.join("\n");
                HeadSlot {
                    since: edit.since,
                    total: counter.count(&text),
                    counts: [
                        block_tokens(&text, "project-memory", counter)
                            + block_tokens(&text, "memory-updates", counter),
                        block_tokens(&text, "project-docs", counter),
                        block_tokens(&text, "user-profile", counter),
                    ],
                }
            });
        slots.insert(message.id.clone(), slot);
    }
    let mut counts = [0; 3];
    let mut total = 0;
    for slot in slots.values() {
        total += slot.total;
        for (sum, value) in counts.iter_mut().zip(slot.counts) {
            *sum += value;
        }
    }
    // The history summaries are what the head holds besides those blocks.
    (
        [
            counts[0],
            counts[1],
            counts[2],
            total.saturating_sub(counts.iter().sum()),
        ],
        rebuilt,
    )
}
