//! Append-only trigger summaries. The ordinary boundary functions remain the
//! oracle; unsupported orderings and budget-sensitive chunks use that oracle.
use super::*;
use std::collections::BTreeSet;
mod chunks;
pub(super) use chunks::ChunkCache;

#[derive(Default)]
struct ArcIndex {
    arcs: Vec<ToolArc>,
    owners: Vec<Option<String>>,
    open: BTreeMap<String, BTreeSet<usize>>,
}

impl ArcIndex {
    fn append(&mut self, messages: &[BoundaryMsg]) {
        for message in messages {
            for block in &message.blocks {
                if block.provider_executed || !matches!(block.kind, SelKind::ToolCall { .. }) {
                    continue;
                }
                let Some(id) = &block.arc_id else {
                    continue;
                };
                let index = self.arcs.len();
                self.arcs.push(ToolArc {
                    inv_ordinal: message.message_ordinal,
                    res_ordinal: None,
                });
                self.owners.push(Some(id.clone()));
                self.open.entry(id.clone()).or_default().insert(index);
            }
            for block in &message.blocks {
                if block.provider_executed || !matches!(block.kind, SelKind::ToolResult { .. }) {
                    continue;
                }
                let Some(id) = &block.arc_id else {
                    continue;
                };
                let Some(index) = self.open.get_mut(id).and_then(BTreeSet::pop_first) else {
                    continue;
                };
                if self.open.get(id).is_some_and(BTreeSet::is_empty) {
                    self.open.remove(id);
                }
                let ordinal = self.arcs[index].inv_ordinal;
                let start = self.arcs.partition_point(|arc| arc.inv_ordinal < ordinal);
                let end = self.arcs.partition_point(|arc| arc.inv_ordinal <= ordinal);
                let first_open =
                    start + self.arcs[start..end].partition_point(|arc| arc.res_ordinal.is_some());
                if first_open != index {
                    let other = self.owners[first_open].take().expect("open arc owner");
                    let positions = self.open.get_mut(&other).expect("open arc positions");
                    positions.remove(&first_open);
                    positions.insert(index);
                    self.owners[index] = Some(other);
                }
                self.owners[first_open] = None;
                self.arcs[first_open].res_ordinal = Some(message.message_ordinal);
            }
        }
    }
}

pub(crate) struct AsyncTriggerCache {
    count: usize,
    index: Option<TokenIndex>,
    calibration: Option<(u64, u64)>,
    arcs: ArcIndex,
    chunks: ChunkCache,
    supported: bool,
}

impl Default for AsyncTriggerCache {
    fn default() -> Self {
        Self {
            count: 0,
            index: None,
            calibration: None,
            arcs: ArcIndex::default(),
            chunks: ChunkCache::default(),
            supported: true,
        }
    }
}

impl AsyncTriggerCache {
    pub(crate) fn check(
        &mut self,
        messages: &[BoundaryMsg],
        ctx: &TriggerContext,
        estimate: &mut dyn FnMut(&str) -> usize,
    ) -> TriggerDecision {
        if ctx
            .boundary
            .calibration
            .is_some_and(|seed| !seed.prose_ratio.is_finite() || !seed.tools_ratio.is_finite())
        {
            return check_compartment_trigger_tail_with_token_estimator(messages, ctx, estimate);
        }
        if messages.len() < self.count
            || messages[self.count.saturating_sub(1).min(messages.len())..]
                .windows(2)
                .any(|pair| pair[0].message_ordinal >= pair[1].message_ordinal)
        {
            self.supported = false;
        }
        if !self.supported {
            return check_compartment_trigger_tail_with_token_estimator(messages, ctx, estimate);
        }
        let appended = &messages[self.count..];
        self.arcs.append(appended);
        self.chunks.append(appended, estimate);
        let calibration = ctx
            .boundary
            .calibration
            .map(|seed| (seed.prose_ratio.to_bits(), seed.tools_ratio.to_bits()));
        if self.calibration != calibration {
            self.index = None;
        }
        if let Some(index) = self.index.as_mut() {
            for message in appended {
                let total = message
                    .blocks
                    .iter()
                    .map(|block| {
                        let ratio = ctx
                            .boundary
                            .calibration
                            .map_or(1.0, |seed| match block.kind {
                                SelKind::ToolCall { .. } | SelKind::ToolResult { .. } => {
                                    seed.tools_ratio
                                }
                                SelKind::Media => 1.0,
                                _ => seed.prose_ratio,
                            });
                        block.original_token_count as f64 * ratio
                    })
                    .sum::<f64>();
                index.ordinals.push(message.message_ordinal);
                index
                    .tokens_by_ordinal
                    .insert(message.message_ordinal, total);
                index
                    .prefix
                    .push(index.prefix.last().copied().unwrap_or(0.0) + total);
            }
            index.raw_message_count = index.ordinals.len() as u64;
            index.last_ordinal = index.ordinals.last().copied().unwrap_or(0);
            index.terminal_ordinal = index
                .ordinals
                .last()
                .map_or(1, |ordinal| ordinal.saturating_add(1));
        } else {
            self.index = Some(TokenIndex::calibrated(messages, ctx.boundary.calibration));
            self.calibration = calibration;
        }
        self.count = messages.len();
        let index = self.index.as_mut().expect("trigger index");
        index.first_ordinal = index.ordinals.first().copied().unwrap_or(1);
        if let Some(covered) = ctx.boundary.last_compartment_end_ordinal {
            index.first_ordinal = index.first_ordinal.min(covered.saturating_add(1));
        }
        check_compartment_trigger_prepared(
            messages,
            ctx,
            index,
            estimate,
            Some(&self.arcs.arcs),
            Some(&self.chunks),
        )
    }
}
