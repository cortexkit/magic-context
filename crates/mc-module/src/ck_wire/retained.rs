//! Incremental allocation charges for owned projection data. The full walker
//! in `FlatProjection::retained_bytes` remains an independent accounting oracle.
use super::*;
use crate::retained_size::{
    btree_map_allocation_bytes, harness_meta_heap_bytes, origin_heap_bytes,
    provider_extras_heap_bytes, value_retained_bytes, ARC_ALLOCATION_OVERHEAD_BYTES,
};
use std::mem::size_of;

impl FlatBlock {
    pub(super) fn retained_heap_bytes(&self) -> usize {
        self.id
            .capacity()
            .saturating_add(self.mid.capacity())
            .saturating_add(self.role.capacity())
            .saturating_add(self.kind_tag.capacity())
            .saturating_add(self.name.as_ref().map_or(0, String::capacity))
            .saturating_add(self.file_path.as_ref().map_or(0, String::capacity))
            .saturating_add(self.arc_id.as_ref().map_or(0, String::capacity))
            .saturating_add(self.tool_call_id.as_ref().map_or(0, String::capacity))
            .saturating_add(self.output_kind.as_ref().map_or(0, String::capacity))
            .saturating_add(ARC_ALLOCATION_OVERHEAD_BYTES)
            .saturating_add(self.bytes.len())
            .saturating_add(self.tool_input.as_ref().map_or(0, |input| {
                ARC_ALLOCATION_OVERHEAD_BYTES.saturating_add(value_retained_bytes(input))
            }))
            .saturating_add(ARC_ALLOCATION_OVERHEAD_BYTES)
            .saturating_add(self.wire.retained_bytes())
    }
}

pub(super) fn identities_heap_bytes(identities: &Vec<BlockIdentity>) -> usize {
    identities
        .capacity()
        .saturating_mul(size_of::<BlockIdentity>())
        .saturating_add(
            identities
                .iter()
                .map(|identity| {
                    identity
                        .kind_tag
                        .capacity()
                        .saturating_add(identity.byte_fingerprint.capacity())
                })
                .sum::<usize>(),
        )
}

impl ProjectionMessageMeta {
    pub(super) fn retained_heap_bytes(&self) -> usize {
        self.mid
            .capacity()
            .saturating_add(self.role.capacity())
            .saturating_add(origin_heap_bytes(self.origin.as_ref()))
            .saturating_add(provider_extras_heap_bytes(&self.provider_extras))
            .saturating_add(harness_meta_heap_bytes(&self.meta))
    }
}

impl ProjectionState {
    pub(super) fn retained_arc_bytes(&self) -> usize {
        self.retained_arc_bytes
    }

    // A frontier is immutable once shared. Charge its freshly cloned maps once
    // so later Arc copies and prefix reuse never rescan old frontier contents.
    pub(super) fn retained_arc_bytes_walk(&self) -> usize {
        let pending =
            btree_map_allocation_bytes::<String, VecDeque<String>>(self.pending_calls.len())
                .saturating_add(
                    self.pending_calls
                        .iter()
                        .map(|(id, arcs)| {
                            id.capacity()
                                .saturating_add(arcs.capacity().saturating_mul(size_of::<String>()))
                                .saturating_add(arcs.iter().map(String::capacity).sum::<usize>())
                        })
                        .sum::<usize>(),
                );
        let calls = btree_map_allocation_bytes::<String, String>(self.call_arcs.len())
            .saturating_add(
                self.call_arcs
                    .iter()
                    .map(|(id, arc)| id.capacity().saturating_add(arc.capacity()))
                    .sum::<usize>(),
            );
        ARC_ALLOCATION_OVERHEAD_BYTES
            .saturating_add(size_of::<Self>())
            .saturating_add(pending)
            .saturating_add(calls)
    }
}

pub(super) fn projection_heap_bytes(
    blocks: &[FlatBlock],
    identities: &BTreeMap<String, Vec<BlockIdentity>>,
    meta: &[ProjectionMessageMeta],
    frontiers: &[Arc<ProjectionState>],
) -> usize {
    blocks
        .iter()
        .map(FlatBlock::retained_heap_bytes)
        .sum::<usize>()
        .saturating_add(
            identities
                .iter()
                .map(|(mid, rows)| mid.capacity().saturating_add(identities_heap_bytes(rows)))
                .sum::<usize>(),
        )
        .saturating_add(
            meta.iter()
                .map(ProjectionMessageMeta::retained_heap_bytes)
                .sum::<usize>(),
        )
        .saturating_add(
            frontiers
                .iter()
                .map(|state| state.retained_arc_bytes())
                .sum::<usize>(),
        )
}

impl FlatProjection {
    /// Append accounting walks only new payloads/frontiers. This getter reads
    /// the recorded charges and collection capacities in constant time.
    pub(crate) fn retained_bytes_cached(&self) -> usize {
        size_of::<Self>()
            .saturating_add(self.retained_heap_bytes)
            .saturating_add(
                self.blocks
                    .capacity()
                    .saturating_mul(size_of::<FlatBlock>()),
            )
            .saturating_add(btree_map_allocation_bytes::<String, Vec<BlockIdentity>>(
                self.identity_by_mid.len(),
            ))
            .saturating_add(
                self.message_meta
                    .capacity()
                    .saturating_mul(size_of::<ProjectionMessageMeta>()),
            )
            .saturating_add(
                self.message_block_ends
                    .capacity()
                    .saturating_mul(size_of::<usize>()),
            )
            .saturating_add(
                self.states_after_messages
                    .capacity()
                    .saturating_mul(size_of::<Arc<ProjectionState>>()),
            )
    }
}
