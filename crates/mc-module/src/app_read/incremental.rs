//! Incremental session-side projection. Transcript changes carry ordinals;
//! Ordinary notices touch changed transcript ordinals only. View and summary
//! publications refresh their cached effects; unchanged payloads are shared.
use super::*;
use crate::app_read::{Header, IndexRow, Update};
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[derive(Clone)]
struct PartInfo {
    id: String,
    kind: &'static str,
    tag: Option<u64>,
    tokens: u64,
    bytes: Option<u64>,
}
struct Cached {
    mid: String,
    digest: String,
    at_ms: u64,
    parts: Vec<PartInfo>,
    row: Option<Arc<Message>>,
    raw: u64,
    tool: u64,
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
struct HeadSlot {
    since: u64,
    /// The whole insert.
    total: u64,
    /// Its memory, project-docs and user-profile blocks.
    counts: [u64; 3],
}

pub(crate) struct Projection {
    identity: u64,
    live: BTreeMap<u64, Cached>,
    positions: HashMap<String, u64>,
    usages: BTreeMap<u64, Usage>,
    stamped: BTreeMap<u64, usize>,
    raw: u64,
    tool: u64,
    queued: usize,
    pub(crate) dirty: BTreeSet<String>,
    pub(crate) summaries_dirty: bool,
    ranges: BTreeMap<u64, u64>,
    compartments: Arc<Vec<Value>>,
    decisions: Arc<Vec<Value>>,
    decisions_revision: u64,
    view: Option<(u64, String)>,
    cut: Option<u64>,
    dropped: BTreeSet<lanes::PartKey>,
    dropped_messages: BTreeSet<String>,
    head: [u64; 4],
    head_slots: HashMap<String, HeadSlot>,
    base: u64,
    initialized: bool,
    header: Option<Arc<Header>>,
    persisted: Option<(u64, String)>,
    pending_rows: BTreeMap<u64, IndexRow>,
    revert_from: Option<u64>,
    revert_dirty: Option<u64>,
    #[cfg(test)]
    pub(crate) rebuilt_rows: usize,
    #[cfg(test)]
    pub(crate) head_rebuilds: usize,
}
impl Default for Projection {
    fn default() -> Self {
        Self {
            identity: 0,
            live: BTreeMap::new(),
            positions: HashMap::new(),
            usages: BTreeMap::new(),
            stamped: BTreeMap::new(),
            raw: 0,
            tool: 0,
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
            head: [0; 4],
            head_slots: HashMap::new(),
            base: 0,
            initialized: false,
            header: None,
            persisted: None,
            pending_rows: BTreeMap::new(),
            revert_from: None,
            revert_dirty: None,
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
            self.tool -= old.tool;
            if !self.summarized(ordinal) {
                self.queued -= old.stamps;
            }
            self.positions.remove(&old.mid);
            self.usages.remove(&ordinal);
            self.stamped.remove(&ordinal);
        }
    }
}

impl Session {
    pub(crate) fn app_update(&mut self) -> Update {
        let mut p = std::mem::take(&mut self.app_projection);
        #[cfg(test)]
        {
            p.rebuilt_rows = 0;
            p.head_rebuilds = 0;
        }
        let (identity, changed, truncated, pruned) = self.index.app_changes();
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
            let row = p.live.entry(ordinal).or_insert_with(|| Cached {
                mid: entry.mid.clone(),
                digest: String::new(),
                at_ms: entry.written_at,
                parts: Vec::new(),
                row: None,
                raw: 0,
                tool: 0,
                stamps: 0,
            });
            if row.row.is_none() || row.digest != entry.digest {
                row.parts = entry
                    .parts
                    .iter()
                    .map(|part| PartInfo {
                        id: part.id.clone(),
                        kind: kind(&part.body),
                        tag: part.tag,
                        tokens: crate::tokens::part(part),
                        bytes: match &part.body {
                            PartBody::Text { text } => Some(text.len() as u64),
                            PartBody::Reasoning { text_bytes, .. } => *text_bytes,
                            PartBody::Tool(tool) => tool.output_bytes,
                            _ => None,
                        },
                    })
                    .collect();
                row.digest = entry.digest.clone();
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
        let view_changed = reset
            || !p.initialized
            || p.cut != cut
            || p.view.as_ref().map(|(v, h)| (*v, h.as_str()))
                != view.map(|v| (v.version, v.checksum.as_str()));
        if view_changed {
            let mut dropped = BTreeSet::new();
            let mut messages = BTreeSet::new();
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
            if p.cut != cut {
                let end = p.cut.unwrap_or(0).max(cut.unwrap_or(0));
                p.dirty
                    .extend(p.live.range(..=end).map(|(_, row)| row.mid.clone()));
            }
            p.dropped = dropped;
            p.dropped_messages = messages;
            p.cut = cut;
            p.view = view.map(|view| (view.version, view.checksum.clone()));
            // The head is counted in the reading model's vocabulary, as the
            // head composer counts it against its budgets.
            let counter = crate::count::Counter::for_model(Some(&format!(
                "{}/{}",
                self.conditions.model.provider, self.conditions.model.model
            )));
            let (head, rebuilt) = head_counts(view, &mut p.head_slots, counter);
            p.head = head;
            #[cfg(test)]
            {
                p.head_rebuilds = rebuilt;
            }
            #[cfg(not(test))]
            let _ = rebuilt;
        }
        let mut rows = Vec::new();
        for mid in std::mem::take(&mut p.dirty) {
            let Some(ordinal) = p.positions.get(&mid).copied() else {
                continue;
            };
            let summarized = p.summarized(ordinal);
            let cached = p.live.get_mut(&ordinal).expect("live position");
            p.raw -= cached.raw;
            p.tool -= cached.tool;
            if !summarized {
                p.queued -= cached.stamps;
            }
            let (message, raw, tool, stamps) =
                message(self, cached, ordinal, &p.dropped, &p.dropped_messages, cut);
            cached.raw = raw;
            cached.tool = tool;
            cached.stamps = stamps;
            p.raw += raw;
            p.tool += tool;
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
        let provider = self
            .conditions
            .last_prompt_tokens
            .or_else(|| usage.and_then(|u| u.prompt));
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
        let parts = [
            surface("system_prompt", self.surface_tokens.0),
            surface("tool_definitions", self.surface_tokens.1),
            PartTokens::estimate("memory", p.head[0]),
            PartTokens::estimate("project_docs", p.head[1]),
            PartTokens::estimate("user_profile", p.head[2]),
            PartTokens::estimate("history_summaries", p.head[3]),
            PartTokens::estimate("history_raw", p.raw),
            PartTokens::estimate("tool_calls_results", p.tool),
            PartTokens::estimate("last_user_message", 0),
        ];
        // The window the apps scale to is the usable one, as the standalone
        // plugin reports it: the model's window less the output reserve.
        let mut breakdown = breakdown(
            &parts,
            provider,
            crate::pass::usable_window(&self.conditions),
        );
        breakdown["managed"] = json!({"value":!self.tools_only&&!self.suspended});
        breakdown["as_of"] = json!({"step_ref":usage.map(|u|&u.mid),"at_ms":at});
        breakdown["parts"][2]["count"] = json!(memory_count);
        if self.tools_only || self.suspended {
            breakdown["total"] = Value::Null;
            breakdown["context_window"] = Value::Null;
            breakdown["parts"] = json!([]);
            breakdown["unattributed"] = Value::Null;
            breakdown["estimation_source"] = Value::Null;
        }
        let meta = json!({"session_id":self.key.session,"compartment_count":self.summaries.len(),"newest_compartment_at_ms":self.summaries.last().map(|c|c.created_at),"queued_stamp_count":p.queued,"compartment_in_progress":self.summarizing,"historian_failure_count":self.app.failures,"historian_last_error":self.app.last_error,"memory_block_count":memory_count,"cache_ttl":null,"last_response_time_ms":at,"is_subagent":!self.features.summarizer,"last_input_tokens":provider,"execute_threshold":{"percentage":self.threshold.0,"tokens":(crate::pass::usable_window(&self.conditions) as f64 * self.threshold.0 / 100.0).floor() as u64,"source":self.threshold.1}});
        let header = Header {
            base: self.index.base(),
            newest,
            ready: self.index_ready,
            meta,
            breakdown,
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
        let checkpoint =
            checkpoint || (initialized && old_base != self.index.base()) || update.reverted;
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
            if let Some(store) = &self.store {
                if let Err(error) = store.save_app_snapshot(&self.app_materialize()) {
                    tracing::warn!("ck-mc: {error}");
                }
            }
        }
        app.update(update);
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
    cut: Option<u64>,
) -> (Message, u64, u64, usize) {
    let mut stamped = Vec::new();
    let mut gone = Vec::new();
    let mut raw = 0;
    let mut tool = 0;
    let mut tagged = 0;
    let before = session
        .unconfirmed
        .first()
        .map(|pending| &pending.before.queued);
    let cut = cut.is_some_and(|cut| ordinal <= cut);
    for part in &cached.parts {
        tagged += usize::from(part.tag.is_some());
        let key = (cached.mid.clone(), part.id.clone());
        let removed = cut || messages.contains(&cached.mid) || dropped.contains(&key);
        let queued =
            session.queued.contains(&key) || before.is_some_and(|queued| queued.contains(&key));
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
            } else {
                raw += part.tokens;
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
            row: json!({"message_id":cached.mid,"state":state,"compartment_id":null,"outside_reason":null,"split":null,"parts":{"tagged":tagged,"stamped":stamps,"dropped":gone.len()},"stamped_parts":stamped,"dropped_parts":gone}),
        },
        raw,
        tool,
        stamps,
    )
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
