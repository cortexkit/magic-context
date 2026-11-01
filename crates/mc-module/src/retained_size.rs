//! Allocator-oriented retained-size estimates for memory-budgeted module holders.
//!
//! The estimates count inline collection elements, heap capacities, tree nodes, and `Arc`
//! allocation headers. Rust does not expose allocator size classes or `BTreeMap` node occupancy,
//! so tree entries use a documented three-word node/slack allowance. The same routines feed cache
//! admission and telemetry; the numbers are estimates, but they cannot diverge between those paths.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::mem::size_of;

use mc_store::{
    CkKind, CkOutputKind, CkToolOutput, CkWireBlock, CkWireMessage, HarnessMeta, MediaBlock,
    MessageOrigin, OpaqueBlock, ProviderExtras, ResultBlock, ResultBlockKind,
};
use serde_json::Value;

pub(crate) const ARC_ALLOCATION_OVERHEAD_BYTES: usize = size_of::<usize>() * 2;
const BTREE_ENTRY_NODE_OVERHEAD_BYTES: usize = size_of::<usize>() * 3;

pub(crate) fn cloned_string_retained_bytes(value: &str) -> usize {
    size_of::<String>().saturating_add(value.len())
}

pub(crate) fn btree_map_allocation_bytes<K, V>(len: usize) -> usize {
    len.saturating_mul(
        size_of::<K>()
            .saturating_add(size_of::<V>())
            .saturating_add(BTREE_ENTRY_NODE_OVERHEAD_BYTES),
    )
}

pub(crate) fn hash_map_allocation_bytes<K, V>(map: &HashMap<K, V>) -> usize {
    // hashbrown keeps a control byte per bucket and normally admits seven entries per eight
    // buckets. `capacity()` is the admission capacity, so expand it back to bucket count.
    let buckets = map.capacity().saturating_mul(8).saturating_add(6) / 7;
    buckets.saturating_mul(
        size_of::<K>()
            .saturating_add(size_of::<V>())
            .saturating_add(1),
    )
}

pub(crate) fn hash_set_allocation_bytes<T>(set: &HashSet<T>) -> usize {
    let buckets = set.capacity().saturating_mul(8).saturating_add(6) / 7;
    buckets.saturating_mul(size_of::<T>().saturating_add(1))
}

pub(crate) fn value_retained_bytes(value: &Value) -> usize {
    size_of::<Value>().saturating_add(value_heap_bytes(value))
}

pub(crate) fn value_heap_bytes(value: &Value) -> usize {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => 0,
        Value::String(value) => value.capacity(),
        Value::Array(values) => values
            .capacity()
            .saturating_mul(size_of::<Value>())
            .saturating_add(values.iter().map(value_heap_bytes).sum::<usize>()),
        Value::Object(values) => btree_map_allocation_bytes::<String, Value>(values.len())
            .saturating_add(
                values
                    .iter()
                    .map(|(key, value)| key.capacity().saturating_add(value_heap_bytes(value)))
                    .sum::<usize>(),
            ),
    }
}

pub(crate) fn provider_extras_heap_bytes(extras: &ProviderExtras) -> usize {
    btree_map_allocation_bytes::<String, BTreeMap<String, Value>>(extras.len()).saturating_add(
        extras
            .iter()
            .map(|(namespace, fields)| {
                namespace
                    .capacity()
                    .saturating_add(btree_map_allocation_bytes::<String, Value>(fields.len()))
                    .saturating_add(
                        fields
                            .iter()
                            .map(|(key, value)| {
                                key.capacity().saturating_add(value_heap_bytes(value))
                            })
                            .sum::<usize>(),
                    )
            })
            .sum::<usize>(),
    )
}

fn optional_string_heap_bytes(value: Option<&String>) -> usize {
    value.map_or(0, String::capacity)
}

pub(crate) fn origin_heap_bytes(origin: Option<&MessageOrigin>) -> usize {
    origin.map_or(0, |origin| {
        origin
            .provider
            .capacity()
            .saturating_add(origin.model.capacity())
            .saturating_add(origin.api.capacity())
    })
}

pub(crate) fn harness_meta_heap_bytes(meta: &HarnessMeta) -> usize {
    optional_string_heap_bytes(meta.harness_id.as_ref())
        .saturating_add(optional_string_heap_bytes(meta.finish.as_ref()))
}

fn opaque_block_heap_bytes(block: &OpaqueBlock) -> usize {
    value_heap_bytes(&block.source)
        .saturating_add(block.kind.capacity())
        .saturating_add(value_heap_bytes(&block.raw))
        .saturating_add(block.arc.as_ref().map_or(0, value_heap_bytes))
}

fn media_block_heap_bytes(block: &MediaBlock) -> usize {
    block
        .media_type
        .capacity()
        .saturating_add(optional_string_heap_bytes(block.filename.as_ref()))
        .saturating_add(value_heap_bytes(&block.source))
}

fn result_block_heap_bytes(block: &ResultBlock) -> usize {
    let kind_bytes = match &block.kind {
        ResultBlockKind::Text { text } => text.capacity(),
        ResultBlockKind::Media { media } => media_block_heap_bytes(media),
        ResultBlockKind::Opaque { opaque } => opaque_block_heap_bytes(opaque),
    };
    kind_bytes.saturating_add(provider_extras_heap_bytes(&block.provider_extras))
}

fn output_kind_heap_bytes(kind: &CkOutputKind) -> usize {
    match kind {
        CkOutputKind::Text { text } | CkOutputKind::ErrorText { text } => text.capacity(),
        CkOutputKind::Json { value } | CkOutputKind::ErrorJson { value } => value_heap_bytes(value),
        CkOutputKind::ExecutionDenied { reason } => optional_string_heap_bytes(reason.as_ref()),
        CkOutputKind::Content { blocks } | CkOutputKind::ErrorContent { blocks } => blocks
            .capacity()
            .saturating_mul(size_of::<ResultBlock>())
            .saturating_add(blocks.iter().map(result_block_heap_bytes).sum::<usize>()),
    }
}

fn tool_output_heap_bytes(output: &CkToolOutput) -> usize {
    output_kind_heap_bytes(&output.kind)
        .saturating_add(provider_extras_heap_bytes(&output.provider_extras))
}

fn kind_heap_bytes(kind: &CkKind) -> usize {
    match kind {
        CkKind::Text { text } | CkKind::RedactedReasoning { data: text } => text.capacity(),
        CkKind::Reasoning { text, signature } => text
            .capacity()
            .saturating_add(optional_string_heap_bytes(signature.as_ref())),
        CkKind::ToolCall {
            id, name, input, ..
        } => id
            .capacity()
            .saturating_add(name.capacity())
            .saturating_add(value_heap_bytes(input)),
        CkKind::ToolResult {
            id,
            tool_name,
            output,
            ..
        } => id
            .capacity()
            .saturating_add(tool_name.capacity())
            .saturating_add(tool_output_heap_bytes(output)),
        CkKind::Media(media) => media_block_heap_bytes(media),
        CkKind::Opaque(opaque) => opaque_block_heap_bytes(opaque),
    }
}

pub(crate) fn ck_wire_block_retained_bytes(block: &CkWireBlock) -> usize {
    size_of::<CkWireBlock>()
        .saturating_add(kind_heap_bytes(&block.kind))
        .saturating_add(provider_extras_heap_bytes(&block.provider_extras))
        // Deserialized blocks retain their parsed object in addition to the typed fields.
        // Read that tree directly: serializing every block merely to estimate its memory was
        // the dominant cost of cold output-cache population.
        .saturating_add(
            block
                .retained_original_json()
                .map_or(0, value_retained_bytes),
        )
}

pub(crate) fn ck_wire_message_retained_bytes(message: &CkWireMessage) -> usize {
    let blocks = message
        .content
        .capacity()
        .saturating_mul(size_of::<CkWireBlock>())
        .saturating_add(
            message
                .content
                .iter()
                .map(|block| {
                    ck_wire_block_retained_bytes(block).saturating_sub(size_of::<CkWireBlock>())
                })
                .sum::<usize>(),
        );
    size_of::<CkWireMessage>()
        .saturating_add(message.role.capacity())
        .saturating_add(blocks)
        .saturating_add(origin_heap_bytes(message.origin.as_ref()))
        .saturating_add(provider_extras_heap_bytes(&message.provider_extras))
        .saturating_add(harness_meta_heap_bytes(&message.meta))
        // Message deserialization also retains the complete parsed object independently of each
        // block object accounted above.
        .saturating_add(
            message
                .retained_original_json()
                .map_or(0, value_retained_bytes),
        )
}
