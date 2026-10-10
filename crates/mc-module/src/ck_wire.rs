//! CK#1 ingress/egress wire types and the block-granular projection used inside MC.
//!
//! The transform receives full CK messages, but the cache machinery reasons about stable
//! block identities. This module owns that seam: parse the small CK typed core, flatten
//! each content block to a session-stable `mid#block_index` item, and retain the original
//! message objects so an unreduced response can pass them back without rebuilding them.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt::Write as _;
use std::sync::Arc;

use mc_core::CkItem;
use mc_store::BlockIdentity;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[cfg(test)]
thread_local! {
    static UNCOMPACTED_REFERENCE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Test-only reference to the former ownership model. Scope the flag to the current-thread
/// replay so its wire clones cannot affect unrelated tests, including after a panic.
#[cfg(test)]
pub(crate) struct UncompactedProjectionGuard(bool);

#[cfg(test)]
impl UncompactedProjectionGuard {
    pub(crate) fn enter() -> Self {
        Self(UNCOMPACTED_REFERENCE.with(|flag| flag.replace(true)))
    }
}

#[cfg(test)]
impl Drop for UncompactedProjectionGuard {
    fn drop(&mut self) {
        UNCOMPACTED_REFERENCE.with(|flag| flag.set(self.0));
    }
}

// The re-exported CK message/block serializers retain the original serde_json::Value
// for pass-through. That must remain a Value-level replay path, not a typed-struct
// round-trip, so harmless future CK fields are not silently dropped.
pub use mc_store::{
    CkKind, CkOutputKind, CkToolOutput, CkWireBlock, CkWireMessage, HarnessMeta, MediaBlock,
    MediaKind, MessageOrigin, OpaqueBlock, ProviderExtras, ResultBlock, ResultBlockKind,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CkIngressMessage {
    pub mid: String,
    pub ordinal: u64,
    pub ck: CkWireMessage,
}

/// The internal block item consumed by the cache-stability core. `bytes` is the
/// reduction-accounting basis, not provider-wire bytes; provider rendering is owned by
/// the producer after MC returns CK messages.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FlatBlock {
    pub id: String,
    pub mid: String,
    pub block_index: usize,
    pub ordinal: u64,
    pub role: String,
    pub kind_tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<Arc<Value>>,
    pub provider_executed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arc_id: Option<String>,
    pub bytes: Arc<str>,
    /// SHA-256 of the serialized block bytes, retained so consumers can verify that the block content has not changed.
    #[serde(skip_serializing)]
    pub content_hash: [u8; 32],
    pub synthetic: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_kind: Option<String>,
    #[serde(skip_serializing)]
    pub wire: Arc<ProjectedWireBlock>,
}

impl FlatBlock {
    /// Materialize a wire block only when a consumer needs its payload. Scalar text lives in
    /// the canonical allocation; metadata-only consumers should use `kind_tag` instead.
    pub fn wire(&self) -> Cow<'_, CkWireBlock> {
        self.wire.materialize()
    }

    /// Metadata-only view: scalar text fields are empty. Never use this for rendering,
    /// text predicates, hashing, or serialization; those require `wire` or `scalar_text`.
    pub(crate) fn wire_shape(&self) -> &CkWireBlock {
        &self.wire.shell
    }

    pub(crate) fn scalar_text(&self) -> Option<Cow<'_, str>> {
        self.wire
            .text()
            .or_else(|| scalar_text(&self.wire.shell.kind).map(|(s, _)| Cow::Borrowed(s)))
    }
}

/// A lossless wire shell with scalar text removed from both typed and original fields.
/// The encoded text is a range in the very same allocation as `FlatBlock::bytes`.
/// Complex JSON/tool arguments remain typed because consumers inspect their trees repeatedly.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedWireBlock {
    shell: CkWireBlock,
    payload: Option<WireTextPayload>,
}

#[derive(Debug, Clone, PartialEq)]
struct WireTextPayload {
    bytes: Arc<str>,
    range: std::ops::Range<usize>,
    escaped: bool,
    path: &'static str,
}

fn scalar_text(kind: &CkKind) -> Option<(&str, &'static str)> {
    match kind {
        CkKind::Text { text } | CkKind::Reasoning { text, .. } => Some((text, "/kind/text")),
        CkKind::RedactedReasoning { data } => Some((data, "/kind/data")),
        CkKind::ToolResult { output, .. } => match &output.kind {
            CkOutputKind::Text { text } | CkOutputKind::ErrorText { text } => {
                Some((text, "/kind/output/kind/text"))
            }
            _ => None,
        },
        _ => None,
    }
}

impl ProjectedWireBlock {
    pub(crate) fn matches(&self, served: &CkWireBlock) -> bool {
        let Some(payload) = &self.payload else {
            return &self.shell == served;
        };
        let same_shape = match (&self.shell.kind, &served.kind) {
            (CkKind::Text { .. }, CkKind::Text { .. })
            | (CkKind::RedactedReasoning { .. }, CkKind::RedactedReasoning { .. }) => true,
            (CkKind::Reasoning { signature: a, .. }, CkKind::Reasoning { signature: b, .. }) => {
                a == b
            }
            (
                CkKind::ToolResult {
                    id: a,
                    tool_name: an,
                    output: ao,
                    provider_executed: ap,
                },
                CkKind::ToolResult {
                    id: b,
                    tool_name: bn,
                    output: bo,
                    provider_executed: bp,
                },
            ) => {
                a == b
                    && an == bn
                    && ap == bp
                    && ao.kind.tag() == bo.kind.tag()
                    && ao.provider_extras == bo.provider_extras
            }
            _ => false,
        };
        if !same_shape || self.shell.provider_extras != served.provider_extras {
            return false;
        }
        let text = self.text().expect("retained scalar");
        if scalar_text(&served.kind).map(|(s, _)| s) != Some(text.as_ref()) {
            return false;
        }
        match (
            self.shell.retained_original_json(),
            served.retained_original_json(),
        ) {
            (None, None) => true,
            (Some(a), Some(b)) => {
                b.pointer(payload.path).and_then(Value::as_str) == Some(text.as_ref())
                    && json_eq_except_text(a, b, payload.path)
            }
            _ => false,
        }
    }

    fn new(block: &CkWireBlock, bytes: &Arc<str>) -> Self {
        #[cfg(test)]
        if UNCOMPACTED_REFERENCE.with(|flag| flag.get()) {
            return Self {
                shell: block.clone(),
                payload: None,
            };
        }
        let Some((text, path)) = scalar_text(&block.kind) else {
            return Self {
                shell: block.clone(),
                payload: None,
            };
        };
        // A caller can mutate the typed core without clearing the original. Preserve that
        // unusual state verbatim rather than replacing the original with the typed payload.
        if block
            .retained_original_json()
            .is_some_and(|v| v.pointer(path).and_then(Value::as_str) != Some(text))
        {
            return Self {
                shell: block.clone(),
                payload: None,
            };
        }
        let encoded = serde_json::to_string(text).expect("wire text serializes");
        let Some(start) = bytes.find(&encoded) else {
            return Self {
                shell: block.clone(),
                payload: None,
            };
        };
        let shell = block
            .replay_validated_shell(Some(String::new()))
            .expect("validated text shell");
        Self {
            shell,
            payload: Some(WireTextPayload {
                bytes: Arc::clone(bytes),
                range: start + 1..start + encoded.len() - 1,
                escaped: encoded.as_bytes().contains(&b'\\'),
                path,
            }),
        }
    }

    fn text(&self) -> Option<Cow<'_, str>> {
        let payload = self.payload.as_ref()?;
        if payload.escaped {
            profile_start!(_perf_parse, "rt05_escaped_text");
            Some(Cow::Owned(
                serde_json::from_str(
                    &payload.bytes[payload.range.start - 1..payload.range.end + 1],
                )
                .expect("retained JSON string"),
            ))
        } else {
            Some(Cow::Borrowed(&payload.bytes[payload.range.clone()]))
        }
    }

    fn materialize(&self) -> Cow<'_, CkWireBlock> {
        let Some(_) = &self.payload else {
            return Cow::Borrowed(&self.shell);
        };
        let text = self.text().expect("retained scalar text");
        Cow::Owned(
            self.shell
                .replay_validated_shell(Some(text.into_owned()))
                .expect("retained scalar shell"),
        )
    }

    pub(crate) fn retained_bytes(&self) -> usize {
        // The payload's Arc references `FlatBlock::bytes`, already charged once there.
        std::mem::size_of::<Self>() - std::mem::size_of::<CkWireBlock>()
            + crate::retained_size::ck_wire_block_retained_bytes(&self.shell)
    }
}

fn json_eq_except_text(a: &Value, b: &Value, path: &str) -> bool {
    if path.is_empty() {
        return true;
    }
    let path = path.strip_prefix('/').expect("scalar JSON pointer");
    let (key, rest) = path
        .find('/')
        .map_or((path, ""), |i| (&path[..i], &path[i..]));
    let (Some(a), Some(b)) = (a.as_object(), b.as_object()) else {
        return false;
    };
    a.len() == b.len()
        && a.iter().all(|(k, av)| {
            b.get(k).is_some_and(|bv| {
                if k == key {
                    json_eq_except_text(av, bv, rest)
                } else {
                    av == bv
                }
            })
        })
}

impl CkItem for FlatBlock {
    fn id(&self) -> &str {
        &self.id
    }

    fn ordinal(&self) -> u64 {
        self.ordinal
    }

    fn bytes(&self) -> &str {
        &self.bytes
    }

    fn synthetic(&self) -> bool {
        self.synthetic
    }
}

/// Projector state at one message boundary. Tail deltas resume from this exact frontier so a
/// tool result in the changed suffix can still pair with a call in the cached prefix.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ProjectionState {
    pending_calls: BTreeMap<String, VecDeque<String>>,
    call_arcs: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
struct ProjectionMessageMeta {
    mid: String,
    ordinal: u64,
    role: String,
    origin: Option<MessageOrigin>,
    provider_extras: ProviderExtras,
    meta: HarnessMeta,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FlatProjection {
    pub blocks: Vec<FlatBlock>,
    pub identity_by_mid: BTreeMap<String, Vec<BlockIdentity>>,
    /// Message shells retain the identity and message-level metadata needed to rebuild an
    /// acknowledged delta prefix. Block payloads remain single-owned by `blocks`.
    message_meta: Vec<ProjectionMessageMeta>,
    /// Flat block end after each ingress message; maps the transport's message frontier without
    /// walking or serializing the cached payload.
    message_block_ends: Vec<usize>,
    /// Shared boundary states make prefix reconstruction proportional in small Arc copies rather
    /// than cloning pending tool-arc maps for every retained message.
    states_after_messages: Vec<Arc<ProjectionState>>,
}

impl FlatProjection {
    pub(crate) fn message_count(&self) -> usize {
        self.message_block_ends.len()
    }

    pub(crate) fn prefix_block_count(&self, prefix_messages: usize) -> Option<usize> {
        if prefix_messages == 0 {
            return Some(0);
        }
        self.message_block_ends.get(prefix_messages - 1).copied()
    }

    pub(crate) fn reattach_messages_prefix(
        &self,
        prefix_messages: usize,
    ) -> Option<Vec<CkIngressMessage>> {
        profile_start!(_perf_reattach, "rt02_reattach_prefix");
        if prefix_messages > self.message_count() || self.message_meta.len() != self.message_count()
        {
            return None;
        }

        let mut block_start = 0;
        let mut messages = Vec::with_capacity(prefix_messages);
        for (message_index, message) in self.message_meta.iter().take(prefix_messages).enumerate() {
            let block_end = *self.message_block_ends.get(message_index)?;
            if block_end < block_start || block_end > self.blocks.len() {
                return None;
            }
            let content = self.blocks[block_start..block_end]
                .iter()
                .enumerate()
                .map(|(block_index, block)| {
                    (block.mid == message.mid
                        && block.ordinal == message.ordinal
                        && block.role == message.role
                        && block.block_index == block_index)
                        .then(|| block.wire().into_owned())
                })
                .collect::<Option<Vec<_>>>()?;
            messages.push(CkIngressMessage {
                mid: message.mid.clone(),
                ordinal: message.ordinal,
                ck: CkWireMessage::from_parts(
                    message.role.clone(),
                    content,
                    message.origin.clone(),
                    message.provider_extras.clone(),
                    message.meta.clone(),
                ),
            });
            block_start = block_end;
        }
        Some(messages)
    }

    pub(crate) fn retained_bytes(&self) -> usize {
        use crate::retained_size::{
            btree_map_allocation_bytes, harness_meta_heap_bytes, origin_heap_bytes,
            provider_extras_heap_bytes, value_retained_bytes, ARC_ALLOCATION_OVERHEAD_BYTES,
        };
        use std::mem::size_of;

        let block_bytes = self
            .blocks
            .capacity()
            .saturating_mul(size_of::<FlatBlock>())
            .saturating_add(
                self.blocks
                    .iter()
                    .map(|block| {
                        block
                            .id
                            .capacity()
                            .saturating_add(block.mid.capacity())
                            .saturating_add(block.role.capacity())
                            .saturating_add(block.kind_tag.capacity())
                            .saturating_add(block.name.as_ref().map_or(0, String::capacity))
                            .saturating_add(block.file_path.as_ref().map_or(0, String::capacity))
                            .saturating_add(block.arc_id.as_ref().map_or(0, String::capacity))
                            .saturating_add(block.tool_call_id.as_ref().map_or(0, String::capacity))
                            .saturating_add(block.output_kind.as_ref().map_or(0, String::capacity))
                            .saturating_add(ARC_ALLOCATION_OVERHEAD_BYTES)
                            .saturating_add(block.bytes.len())
                            .saturating_add(block.tool_input.as_ref().map_or(0, |input| {
                                ARC_ALLOCATION_OVERHEAD_BYTES
                                    .saturating_add(value_retained_bytes(input))
                            }))
                            // Charge the wire shell and its Arc, but not its reference to the
                            // canonical allocation already charged above.
                            .saturating_add(ARC_ALLOCATION_OVERHEAD_BYTES)
                            .saturating_add(block.wire.retained_bytes())
                    })
                    .sum::<usize>(),
            );
        let identity_bytes =
            btree_map_allocation_bytes::<String, Vec<BlockIdentity>>(self.identity_by_mid.len())
                .saturating_add(
                    self.identity_by_mid
                        .iter()
                        .map(|(mid, identities)| {
                            mid.capacity()
                                .saturating_add(
                                    identities
                                        .capacity()
                                        .saturating_mul(size_of::<BlockIdentity>()),
                                )
                                .saturating_add(
                                    identities
                                        .iter()
                                        .map(|identity| {
                                            identity.kind_tag.capacity().saturating_add(
                                                identity.byte_fingerprint.capacity(),
                                            )
                                        })
                                        .sum::<usize>(),
                                )
                        })
                        .sum::<usize>(),
                );
        let message_meta_bytes = self
            .message_meta
            .capacity()
            .saturating_mul(size_of::<ProjectionMessageMeta>())
            .saturating_add(
                self.message_meta
                    .iter()
                    .map(|message| {
                        message
                            .mid
                            .capacity()
                            .saturating_add(message.role.capacity())
                            .saturating_add(origin_heap_bytes(message.origin.as_ref()))
                            .saturating_add(provider_extras_heap_bytes(&message.provider_extras))
                            .saturating_add(harness_meta_heap_bytes(&message.meta))
                    })
                    .sum::<usize>(),
            );
        let frontier_bytes = self
            .states_after_messages
            .capacity()
            .saturating_mul(size_of::<Arc<ProjectionState>>())
            .saturating_add(
                self.states_after_messages
                    .iter()
                    .map(|state| {
                        let pending_calls = btree_map_allocation_bytes::<String, VecDeque<String>>(
                            state.pending_calls.len(),
                        )
                        .saturating_add(
                            state
                                .pending_calls
                                .iter()
                                .map(|(call_id, arcs)| {
                                    call_id
                                        .capacity()
                                        .saturating_add(
                                            arcs.capacity().saturating_mul(size_of::<String>()),
                                        )
                                        .saturating_add(
                                            arcs.iter().map(String::capacity).sum::<usize>(),
                                        )
                                })
                                .sum::<usize>(),
                        );
                        let call_arcs =
                            btree_map_allocation_bytes::<String, String>(state.call_arcs.len())
                                .saturating_add(
                                    state
                                        .call_arcs
                                        .iter()
                                        .map(|(block_id, arc_id)| {
                                            block_id.capacity().saturating_add(arc_id.capacity())
                                        })
                                        .sum::<usize>(),
                                );
                        ARC_ALLOCATION_OVERHEAD_BYTES
                            .saturating_add(size_of::<ProjectionState>())
                            .saturating_add(pending_calls)
                            .saturating_add(call_arcs)
                    })
                    .sum::<usize>(),
            );

        size_of::<Self>()
            .saturating_add(block_bytes)
            .saturating_add(identity_bytes)
            .saturating_add(message_meta_bytes)
            .saturating_add(frontier_bytes)
            .saturating_add(
                self.message_block_ends
                    .capacity()
                    .saturating_mul(size_of::<usize>()),
            )
    }

    pub(crate) fn differential_bytes(&self) -> Vec<u8> {
        let wires = self.blocks.iter().map(FlatBlock::wire).collect::<Vec<_>>();
        serde_json::to_vec(&(&self.blocks, &self.identity_by_mid, wires))
            .expect("flat projection differential bytes must serialize")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CkWireError {
    MidContainsReservedHash(String),
    UnsupportedBlock {
        mid: String,
        block_index: usize,
        kind: String,
    },
    UnpairedToolResult {
        mid: String,
        block_index: usize,
        tool_call_id: String,
    },
}

impl std::fmt::Display for CkWireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CkWireError::MidContainsReservedHash(mid) => {
                write!(f, "message id contains reserved '#': {mid}")
            }
            CkWireError::UnsupportedBlock {
                mid,
                block_index,
                kind,
            } => write!(f, "unsupported CK block {kind} at {mid}#{block_index}"),
            CkWireError::UnpairedToolResult {
                mid,
                block_index,
                tool_call_id,
            } => write!(
                f,
                "tool_result {tool_call_id} at {mid}#{block_index} has no adjacent tool_call"
            ),
        }
    }
}

impl std::error::Error for CkWireError {}

pub fn project_messages(messages: &[CkIngressMessage]) -> Result<FlatProjection, CkWireError> {
    project_messages_from_state(messages, FlatProjectionBuilder::default())
}

/// Reuse an acknowledged message prefix and project only its replacement suffix.
///
/// The caller validates the session fingerprint and context before supplying `cached`; malformed
/// or out-of-range local metadata falls back to a full projection rather than trusting a partial
/// result.
pub(crate) fn project_messages_incremental(
    messages: &[CkIngressMessage],
    cached: &FlatProjection,
    prefix_messages: usize,
) -> Result<FlatProjection, CkWireError> {
    profile_start!(_perf_project_incremental, "rt02_incremental_projection");
    if prefix_messages == 0
        || prefix_messages > messages.len()
        || prefix_messages > cached.message_count()
    {
        return project_messages(messages);
    }

    let prefix_block_end = cached.message_block_ends[prefix_messages - 1];
    let mut identity_by_mid = BTreeMap::new();
    for message in &messages[..prefix_messages] {
        if message.ck.meta.synthetic {
            continue;
        }
        let Some(identities) = cached.identity_by_mid.get(&message.mid) else {
            return project_messages(messages);
        };
        identity_by_mid.insert(message.mid.clone(), identities.clone());
    }
    let builder = FlatProjectionBuilder {
        blocks: cached.blocks[..prefix_block_end].to_vec(),
        identity_by_mid,
        message_meta: cached.message_meta[..prefix_messages].to_vec(),
        message_block_ends: cached.message_block_ends[..prefix_messages].to_vec(),
        states_after_messages: cached.states_after_messages[..prefix_messages].to_vec(),
        state: cached.states_after_messages[prefix_messages - 1]
            .as_ref()
            .clone(),
    };
    project_messages_from_state(&messages[prefix_messages..], builder)
}

#[derive(Default)]
struct FlatProjectionBuilder {
    blocks: Vec<FlatBlock>,
    identity_by_mid: BTreeMap<String, Vec<BlockIdentity>>,
    message_meta: Vec<ProjectionMessageMeta>,
    message_block_ends: Vec<usize>,
    states_after_messages: Vec<Arc<ProjectionState>>,
    state: ProjectionState,
}

fn project_messages_from_state(
    messages: &[CkIngressMessage],
    mut builder: FlatProjectionBuilder,
) -> Result<FlatProjection, CkWireError> {
    for msg in messages {
        if msg.mid.contains('#') {
            return Err(CkWireError::MidContainsReservedHash(msg.mid.clone()));
        }

        let role = msg.ck.role.as_str();
        if role == "assistant" {
            builder.state.pending_calls.clear();
            builder.state.call_arcs.clear();
            let mut call_counts = BTreeMap::<&str, usize>::new();
            for block in &msg.ck.content {
                if let CkKind::ToolCall { id, .. } = &block.kind {
                    *call_counts.entry(id.as_str()).or_default() += 1;
                }
            }
            for (index, block) in msg.ck.content.iter().enumerate() {
                if let CkKind::ToolCall { id, .. } = &block.kind {
                    let block_id = block_id(&msg.mid, index);
                    let arc_id = if call_counts.get(id.as_str()).copied().unwrap_or(0) > 1 {
                        tool_arc_id(&msg.mid, id)
                    } else {
                        block_id.clone()
                    };
                    builder.state.call_arcs.insert(block_id, arc_id.clone());
                    builder
                        .state
                        .pending_calls
                        .entry(id.clone())
                        .or_default()
                        .push_back(arc_id);
                }
            }
        }

        let mut identities = Vec::new();
        for (index, block) in msg.ck.content.iter().enumerate() {
            let id = block_id(&msg.mid, index);
            let arc_id = arc_for_block(
                &msg.mid,
                index,
                &msg.ck,
                &mut builder.state.pending_calls,
                &builder.state.call_arcs,
            )?;
            let flat = flatten_block(msg, index, block, id, arc_id)?;
            if !flat.synthetic {
                identities.push(BlockIdentity {
                    kind_tag: flat.kind_tag.clone(),
                    byte_fingerprint: block_identity_fingerprint(msg, block, &flat)?,
                });
            }
            builder.blocks.push(flat);
        }

        // A tool arc ends at the next non-tool-carrying turn, but the clear must run
        // AFTER this message's own blocks consume their pending calls: on the Anthropic
        // wire a tool_result may ride inside a USER message together with the user's
        // next text (Claude Code emits this when input arrives while a tool runs).
        // Clearing before the block walk made that legal shape unpairable — and because
        // ingress errors precede any state commit, one such message in the history
        // rejected every subsequent pass for the session's lifetime.
        if role != "assistant" && role != "tool" {
            builder.state.pending_calls.clear();
        }
        if !msg.ck.meta.synthetic {
            builder.identity_by_mid.insert(msg.mid.clone(), identities);
        }
        builder.message_meta.push(ProjectionMessageMeta {
            mid: msg.mid.clone(),
            ordinal: msg.ordinal,
            role: msg.ck.role.clone(),
            origin: msg.ck.origin.clone(),
            provider_extras: msg.ck.provider_extras.clone(),
            meta: msg.ck.meta.clone(),
        });
        builder.message_block_ends.push(builder.blocks.len());
        builder
            .states_after_messages
            .push(Arc::new(builder.state.clone()));
    }

    Ok(FlatProjection {
        blocks: builder.blocks,
        identity_by_mid: builder.identity_by_mid,
        message_meta: builder.message_meta,
        message_block_ends: builder.message_block_ends,
        states_after_messages: builder.states_after_messages,
    })
}

pub fn block_id(mid: &str, index: usize) -> String {
    format!("{mid}#{index}")
}

pub fn split_block_id(id: &str) -> Option<(&str, usize)> {
    let (mid, index) = id.rsplit_once('#')?;
    let index = index.parse().ok()?;
    Some((mid, index))
}

fn is_reduction_envelope(input: &Value) -> bool {
    input.get("reduced") == Some(&Value::Bool(true))
        && input.get("summary").is_some_and(Value::is_string)
}

fn reduced_tool_call_input(original: &Value, reduced: &str) -> Value {
    // Frozen payloads normally contain the clamped argument object. A short-lived renderer also
    // persisted the wrapper itself, so unwrap that legacy form without ever serving its foreign
    // keys. Malformed historical payloads fall back to the original real argument object.
    let parsed = serde_json::from_str::<Value>(reduced)
        .ok()
        .filter(Value::is_object);
    if let Some(parsed) = parsed {
        if !is_reduction_envelope(&parsed) {
            return parsed;
        }
        if let Some(recovered) = parsed
            .get("summary")
            .and_then(Value::as_str)
            .and_then(|summary| serde_json::from_str::<Value>(summary).ok())
            .filter(Value::is_object)
            .filter(|input| !is_reduction_envelope(input))
        {
            return recovered;
        }
    }

    if original.is_object() && !is_reduction_envelope(original) {
        original.clone()
    } else {
        Value::Object(serde_json::Map::new())
    }
}

pub fn reduced_block(block: &CkWireBlock, reduced: &str) -> CkWireBlock {
    let kind = match &block.kind {
        CkKind::ToolResult {
            id,
            tool_name,
            provider_executed,
            ..
        } => CkKind::ToolResult {
            id: id.clone(),
            tool_name: tool_name.clone(),
            output: CkToolOutput::bare(CkOutputKind::Text {
                text: reduced.to_string(),
            }),
            provider_executed: *provider_executed,
        },
        CkKind::ToolCall {
            id,
            name,
            input: original_input,
            provider_executed,
            ..
        } => CkKind::ToolCall {
            id: id.clone(),
            name: name.clone(),
            input: reduced_tool_call_input(original_input, reduced),
            provider_executed: *provider_executed,
        },
        CkKind::Reasoning { .. } => CkKind::Reasoning {
            text: reduced.to_string(),
            signature: None,
        },
        CkKind::Text { .. } | CkKind::RedactedReasoning { .. } => CkKind::Text {
            text: reduced.to_string(),
        },
        CkKind::Media(_) | CkKind::Opaque(_) => CkKind::Text {
            text: reduced.to_string(),
        },
    };
    CkWireBlock::with_provider_extras(kind, block.provider_extras.clone())
}

pub fn text_from_message(msg: &CkWireMessage) -> Option<&str> {
    match msg.content.first()?.kind {
        CkKind::Text { ref text } => Some(text.as_str()),
        _ => None,
    }
}

fn block_identity_fingerprint(
    msg: &CkIngressMessage,
    block: &CkWireBlock,
    flat: &FlatBlock,
) -> Result<String, CkWireError> {
    if msg
        .ck
        .provider_extras
        .get("_cortexkit_codec")
        .and_then(|extras| extras.get("ingressProfile"))
        .and_then(Value::as_str)
        != Some("opencode")
    {
        return Ok(fingerprint_digest(&flat.content_hash));
    }
    // Full-request OpenCode passes ingest CK JSON from TypeScript, without the
    // origin coordinates that Rust's native decoder adds for lossless rendering.
    // Persist the same source-content identity across a pipeline switch: sorted
    // JSON without those coordinates or the default false tool flag omitted by
    // TypeScript. Keep actual content and all other provider extras, and leave
    // served bytes/content_hash untouched for native-part alignment.
    let mut value = serde_json::to_value(block).map_err(|_| CkWireError::UnsupportedBlock {
        mid: flat.mid.clone(),
        block_index: flat.block_index,
        kind: flat.kind_tag.clone(),
    })?;
    if let Some(extras) = value
        .get_mut("provider_extras")
        .and_then(Value::as_object_mut)
    {
        extras.remove("_cortexkit_codec");
        if extras.is_empty() {
            value.as_object_mut().unwrap().remove("provider_extras");
        }
    }
    if matches!(
        block.kind,
        CkKind::ToolCall {
            provider_executed: false,
            ..
        } | CkKind::ToolResult {
            provider_executed: false,
            ..
        }
    ) {
        value["kind"]
            .as_object_mut()
            .unwrap()
            .remove("provider_executed");
    }
    Ok(fingerprint(&value.to_string()))
}

fn flatten_block(
    msg: &CkIngressMessage,
    index: usize,
    block: &CkWireBlock,
    id: String,
    arc_id: Option<String>,
) -> Result<FlatBlock, CkWireError> {
    let bytes = serde_json::to_string(block).map_err(|_| CkWireError::UnsupportedBlock {
        mid: msg.mid.clone(),
        block_index: index,
        kind: block.kind.tag().to_string(),
    })?;
    let content_hash: [u8; 32] = Sha256::digest(bytes.as_bytes()).into();
    let (name, file_path, tool_input, provider_executed, tool_call_id, output_kind) =
        match &block.kind {
            CkKind::ToolCall {
                id,
                name,
                input,
                provider_executed,
            } => (
                Some(name.clone()),
                extract_file_path(input),
                Some({
                    profile_start!(_perf_input_copy, "rt20_project_input_copy");
                    Arc::new(input.clone())
                }),
                *provider_executed,
                Some(id.clone()),
                None,
            ),
            CkKind::ToolResult {
                id,
                output,
                provider_executed,
                ..
            } => (
                None,
                None,
                None,
                *provider_executed,
                Some(id.clone()),
                Some(output.kind.tag().to_string()),
            ),
            _ => (None, None, None, false, None, None),
        };

    let bytes: Arc<str> = Arc::from(bytes);
    let wire = Arc::new(ProjectedWireBlock::new(block, &bytes));
    Ok(FlatBlock {
        id,
        mid: msg.mid.clone(),
        block_index: index,
        ordinal: msg.ordinal,
        role: msg.ck.role.clone(),
        kind_tag: block.kind.tag().to_string(),
        name,
        file_path,
        tool_input,
        provider_executed,
        arc_id,
        bytes,
        content_hash,
        synthetic: msg.ck.meta.synthetic,
        tool_call_id,
        output_kind,
        wire,
    })
}

fn tool_arc_id(mid: &str, call_id: &str) -> String {
    format!("{mid}#call:{call_id}")
}

fn arc_for_block(
    mid: &str,
    index: usize,
    msg: &CkWireMessage,
    pending_calls: &mut BTreeMap<String, VecDeque<String>>,
    call_arcs: &BTreeMap<String, String>,
) -> Result<Option<String>, CkWireError> {
    match &msg.content[index].kind {
        CkKind::ToolCall { .. } if msg.role == "assistant" => {
            Ok(call_arcs.get(&block_id(mid, index)).cloned())
        }
        CkKind::ToolResult { id, .. } => {
            let Some(queue) = pending_calls.get_mut(id) else {
                return Err(CkWireError::UnpairedToolResult {
                    mid: mid.to_string(),
                    block_index: index,
                    tool_call_id: id.clone(),
                });
            };
            let Some(call_block_id) = queue.pop_front() else {
                return Err(CkWireError::UnpairedToolResult {
                    mid: mid.to_string(),
                    block_index: index,
                    tool_call_id: id.clone(),
                });
            };
            Ok(Some(call_block_id))
        }
        CkKind::Reasoning { .. } | CkKind::RedactedReasoning { .. } if msg.role == "assistant" => {
            Ok(adjacent_tool_call_arc(mid, index, &msg.content))
        }
        _ => Ok(None),
    }
}

fn adjacent_tool_call_arc(mid: &str, index: usize, content: &[CkWireBlock]) -> Option<String> {
    if index > 0 && matches!(content[index - 1].kind, CkKind::ToolCall { .. }) {
        return Some(block_id(mid, index - 1));
    }
    if index + 1 < content.len() && matches!(content[index + 1].kind, CkKind::ToolCall { .. }) {
        return Some(block_id(mid, index + 1));
    }
    None
}

fn extract_file_path(input: &Value) -> Option<String> {
    let obj = input.as_object()?;
    ["filePath", "file_path", "path"]
        .iter()
        .find_map(|key| obj.get(*key).and_then(Value::as_str).map(str::to_string))
}

pub(crate) fn fingerprint_digest(content_hash: &[u8; 32]) -> String {
    let mut out = String::with_capacity(content_hash.len() * 2);
    for byte in content_hash {
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

pub(crate) fn fingerprint(bytes: &str) -> String {
    let content_hash: [u8; 32] = Sha256::digest(bytes.as_bytes()).into();
    fingerprint_digest(&content_hash)
}

/// Hex fingerprint + serialized length when `served` is still the projected block wire.
///
/// Projection stores SHA-256 of the same `serde_json::to_string(CkWireBlock)` basis that
/// divergence attribution uses. Reuse that digest only when the served wire is still
/// identical (including retained ingress bytes); modified/reduced/overlaid blocks must
/// re-hash.
pub(crate) fn fingerprint_from_projected_wire(
    served: &CkWireBlock,
    projected: Option<&FlatBlock>,
) -> Option<(String, usize)> {
    let flat = projected?;
    if !flat.wire.matches(served) {
        return None;
    }
    Some((fingerprint_digest(&flat.content_hash), flat.bytes.len()))
}

pub fn duplicate_ids(blocks: &[FlatBlock]) -> Option<String> {
    let mut seen = BTreeSet::new();
    for block in blocks {
        if !seen.insert(block.id.as_str()) {
            return Some(block.id.clone());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_msg(mid: &str, ordinal: u64, role: &str, text: &str) -> CkIngressMessage {
        CkIngressMessage {
            mid: mid.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                role,
                vec![CkWireBlock::bare(CkKind::Text { text: text.into() })],
                None,
                ProviderExtras::new(),
                HarnessMeta::default(),
            ),
        }
    }

    fn assistant_with_call(mid: &str, ordinal: u64, call_id: &str) -> CkIngressMessage {
        CkIngressMessage {
            mid: mid.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                "assistant",
                vec![
                    CkWireBlock::bare(CkKind::Text {
                        text: "running a tool".into(),
                    }),
                    CkWireBlock::bare(CkKind::ToolCall {
                        id: call_id.to_string(),
                        name: "read".to_string(),
                        input: serde_json::json!({}),
                        provider_executed: false,
                    }),
                ],
                None,
                ProviderExtras::new(),
                HarnessMeta::default(),
            ),
        }
    }

    #[test]
    fn compact_projection_scalar_wire_roundtrip() {
        for kind in [
            serde_json::json!({"type":"text","text":"雪\n\"text\""}),
            serde_json::json!({"type":"reasoning","text":"think\\path","signature":"signed"}),
            serde_json::json!({"type":"redacted_reasoning","data":"secret"}),
            serde_json::json!({"type":"tool_result","id":"c","tool_name":"work","output":{"kind":{"type":"text","text":"done\n雪"}}}),
            serde_json::json!({"type":"tool_result","id":"c","tool_name":"work","output":{"kind":{"type":"error_text","text":"failed"}}}),
        ] {
            let mut kind = kind;
            kind["future"] = serde_json::json!({"unchanged":[true,1.5]});
            let wire: CkWireBlock = serde_json::from_value(serde_json::json!({"kind":kind,"future_block":7,"provider_extras":{"future":{"flag":true}}})).unwrap();
            let bytes: Arc<str> = Arc::from(serde_json::to_string(&wire).unwrap());
            let retained = ProjectedWireBlock::new(&wire, &bytes);
            assert!(retained.payload.is_some());
            assert_eq!(scalar_text(&retained.shell.kind).unwrap().0, "");
            assert_eq!(retained.materialize().as_ref(), &wire);
            assert_eq!(
                serde_json::to_vec(retained.materialize().as_ref()).unwrap(),
                bytes.as_bytes()
            );
            assert!(retained.matches(&wire));
            assert!(Arc::ptr_eq(
                &retained.payload.as_ref().unwrap().bytes,
                &bytes
            ));
        }
        // Typed/original mismatches are legal Rust values, although not produced by ingress
        // deserialization. Never compact one by choosing either view over the other.
        let mut wire: CkWireBlock =
            serde_json::from_str(r#"{"kind":{"type":"text","text":"original"}}"#).unwrap();
        wire.kind = CkKind::Text {
            text: "edited".into(),
        };
        let bytes: Arc<str> = Arc::from(serde_json::to_string(&wire).unwrap());
        let retained = ProjectedWireBlock::new(&wire, &bytes);
        assert!(retained.payload.is_none());
        assert_eq!(retained.materialize().as_ref(), &wire);
        let bare = CkWireBlock::bare(CkKind::Text {
            text: "bare".into(),
        });
        let bytes: Arc<str> = Arc::from(serde_json::to_string(&bare).unwrap());
        let retained = ProjectedWireBlock::new(&bare, &bytes);
        assert_eq!(retained.materialize().as_ref(), &bare);
        assert!(retained.materialize().retained_original_json().is_none());
    }

    #[test]
    fn compact_projection_wire_matching_includes_unknown_fields() {
        let original = serde_json::json!({"kind":{"type":"text","text":"payload","future":1},"future_block":true});
        let wire: CkWireBlock = serde_json::from_value(original.clone()).unwrap();
        let bytes: Arc<str> = Arc::from(serde_json::to_string(&wire).unwrap());
        let retained = ProjectedWireBlock::new(&wire, &bytes);
        for pointer in ["/kind/text", "/kind/future", "/future_block"] {
            let mut changed = original.clone();
            *changed.pointer_mut(pointer).unwrap() = Value::String("changed".into());
            let changed: CkWireBlock = serde_json::from_value(changed).unwrap();
            assert!(!retained.matches(&changed), "ignored {pointer}");
        }
        let mut changed = wire.clone();
        changed.kind = CkKind::Text {
            text: "typed change".into(),
        };
        assert!(!retained.matches(&changed));
        let bare = CkWireBlock::bare(wire.kind.clone());
        assert!(!retained.matches(&bare));
    }

    #[test]
    fn legacy_reduced_tool_call_inputs_keep_real_argument_keys() {
        let original = CkWireBlock::bare(CkKind::ToolCall {
            id: "edit-call".to_string(),
            name: "edit".to_string(),
            input: serde_json::json!({
                "filePath": "/workspace/src/lib.rs",
                "oldString": "old region that is intentionally bulky",
                "newString": "new region that is intentionally bulky",
            }),
            provider_executed: false,
        });
        let payload = serde_json::json!({
            "filePath": "/workspace/src/lib.rs",
            "oldString": "old region...[truncated]",
            "newString": "new region...[truncated]",
        })
        .to_string();

        let reduced = reduced_block(&original, &payload);
        let CkKind::ToolCall { input, .. } = reduced.kind else {
            panic!("reduced tool call must remain a tool call");
        };
        assert_eq!(input, serde_json::from_str::<Value>(&payload).unwrap());
        assert!(input.get("filePath").is_some());
        assert!(input.get("oldString").is_some());
        assert!(input.get("newString").is_some());
        assert!(input.get("reduced").is_none());
        assert!(input.get("summary").is_none());
    }

    #[test]
    fn projection_retained_bytes_counts_original_tool_input_and_frontier_allocations() {
        use std::mem::size_of;

        fn manual_value_retained_bytes(value: &Value) -> usize {
            fn heap(value: &Value) -> usize {
                match value {
                    Value::Null | Value::Bool(_) | Value::Number(_) => 0,
                    Value::String(value) => value.capacity(),
                    Value::Array(values) => values
                        .capacity()
                        .saturating_mul(size_of::<Value>())
                        .saturating_add(values.iter().map(heap).sum::<usize>()),
                    Value::Object(values) => values
                        .len()
                        .saturating_mul(
                            size_of::<String>() + size_of::<Value>() + size_of::<usize>() * 3,
                        )
                        .saturating_add(
                            values
                                .iter()
                                .map(|(key, value)| key.capacity().saturating_add(heap(value)))
                                .sum::<usize>(),
                        ),
                }
            }
            size_of::<Value>().saturating_add(heap(value))
        }

        let input = Value::Object(
            (0..96)
                .map(|index| {
                    (
                        format!("k{index}"),
                        serde_json::json!({"v": format!("x{index}"), "ok": index % 2 == 0}),
                    )
                })
                .collect(),
        );
        let constructed = CkIngressMessage {
            mid: "tool-heavy".to_string(),
            ordinal: 1,
            ck: CkWireMessage::from_parts(
                "assistant",
                vec![CkWireBlock::bare(CkKind::ToolCall {
                    id: "call-heavy".to_string(),
                    name: "fixture_tool".to_string(),
                    input,
                    provider_executed: false,
                })],
                None,
                ProviderExtras::new(),
                HarnessMeta::default(),
            ),
        };
        // Reparse through the wire so both CkWireMessage and CkWireBlock own original JSON.
        let message: CkIngressMessage =
            serde_json::from_value(serde_json::to_value(constructed).unwrap()).unwrap();
        let projection = project_messages(&[message]).unwrap();
        let block = &projection.blocks[0];
        let wire_json = serde_json::to_value(block.wire().as_ref()).unwrap();
        let CkKind::ToolCall {
            id, name, input, ..
        } = &block.wire_shape().kind
        else {
            panic!("fixture must project a tool call");
        };
        let wire_retained = size_of::<CkWireBlock>()
            .saturating_add(id.capacity())
            .saturating_add(name.capacity())
            .saturating_add(manual_value_retained_bytes(input).saturating_sub(size_of::<Value>()))
            .saturating_add(manual_value_retained_bytes(&wire_json));
        let wire_retained =
            wire_retained + size_of::<ProjectedWireBlock>() - size_of::<CkWireBlock>();
        let block_heap = block
            .id
            .capacity()
            .saturating_add(block.mid.capacity())
            .saturating_add(block.role.capacity())
            .saturating_add(block.kind_tag.capacity())
            .saturating_add(block.name.as_ref().map_or(0, String::capacity))
            .saturating_add(block.file_path.as_ref().map_or(0, String::capacity))
            .saturating_add(block.arc_id.as_ref().map_or(0, String::capacity))
            .saturating_add(block.tool_call_id.as_ref().map_or(0, String::capacity))
            .saturating_add(block.output_kind.as_ref().map_or(0, String::capacity))
            .saturating_add(crate::retained_size::ARC_ALLOCATION_OVERHEAD_BYTES)
            .saturating_add(block.bytes.len())
            .saturating_add(
                crate::retained_size::ARC_ALLOCATION_OVERHEAD_BYTES
                    + manual_value_retained_bytes(block.tool_input.as_ref().unwrap()),
            )
            .saturating_add(crate::retained_size::ARC_ALLOCATION_OVERHEAD_BYTES)
            .saturating_add(wire_retained);
        let blocks = projection
            .blocks
            .capacity()
            .saturating_mul(size_of::<FlatBlock>())
            .saturating_add(block_heap);
        let identities = projection
            .identity_by_mid
            .len()
            .saturating_mul(
                size_of::<String>() + size_of::<Vec<BlockIdentity>>() + size_of::<usize>() * 3,
            )
            .saturating_add(
                projection
                    .identity_by_mid
                    .iter()
                    .map(|(mid, identities)| {
                        mid.capacity()
                            .saturating_add(
                                identities
                                    .capacity()
                                    .saturating_mul(size_of::<BlockIdentity>()),
                            )
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
                    })
                    .sum::<usize>(),
            );
        let frontiers = projection
            .states_after_messages
            .capacity()
            .saturating_mul(size_of::<Arc<ProjectionState>>())
            .saturating_add(
                projection
                    .states_after_messages
                    .iter()
                    .map(|state| {
                        let pending = state
                            .pending_calls
                            .len()
                            .saturating_mul(
                                size_of::<String>()
                                    + size_of::<VecDeque<String>>()
                                    + size_of::<usize>() * 3,
                            )
                            .saturating_add(
                                state
                                    .pending_calls
                                    .iter()
                                    .map(|(key, values)| {
                                        key.capacity()
                                            .saturating_add(
                                                values
                                                    .capacity()
                                                    .saturating_mul(size_of::<String>()),
                                            )
                                            .saturating_add(
                                                values.iter().map(String::capacity).sum::<usize>(),
                                            )
                                    })
                                    .sum::<usize>(),
                            );
                        let arcs = state
                            .call_arcs
                            .len()
                            .saturating_mul(size_of::<String>() * 2 + size_of::<usize>() * 3)
                            .saturating_add(
                                state
                                    .call_arcs
                                    .iter()
                                    .map(|(key, value)| {
                                        key.capacity().saturating_add(value.capacity())
                                    })
                                    .sum::<usize>(),
                            );
                        crate::retained_size::ARC_ALLOCATION_OVERHEAD_BYTES
                            .saturating_add(size_of::<ProjectionState>())
                            .saturating_add(pending)
                            .saturating_add(arcs)
                    })
                    .sum::<usize>(),
            );
        let expected = size_of::<FlatProjection>()
            .saturating_add(blocks)
            .saturating_add(identities)
            .saturating_add(frontiers)
            .saturating_add(
                projection
                    .message_block_ends
                    .capacity()
                    .saturating_mul(size_of::<usize>()),
            );
        let legacy = projection
            .blocks
            .iter()
            .map(|block| {
                size_of::<FlatBlock>()
                    + block.id.len()
                    + block.mid.len()
                    + block.role.len()
                    + block.kind_tag.len()
                    + block.name.as_deref().map_or(0, str::len)
                    + block.file_path.as_deref().map_or(0, str::len)
                    + block.arc_id.as_deref().map_or(0, str::len)
                    + block.tool_call_id.as_deref().map_or(0, str::len)
                    + block.output_kind.as_deref().map_or(0, str::len)
                    + block.bytes.len() * 3
            })
            .sum::<usize>()
            + projection
                .identity_by_mid
                .iter()
                .map(|(mid, identities)| mid.len() + identities.len() * size_of::<BlockIdentity>())
                .sum::<usize>()
            + projection
                .states_after_messages
                .iter()
                .map(|state| {
                    state
                        .pending_calls
                        .iter()
                        .map(|(key, values)| {
                            key.len() + values.iter().map(String::len).sum::<usize>()
                        })
                        .sum::<usize>()
                        + state
                            .call_arcs
                            .iter()
                            .map(|(key, value)| key.len() + value.len())
                            .sum::<usize>()
                })
                .sum::<usize>()
            + projection.message_block_ends.len() * size_of::<usize>();
        let retained = projection.retained_bytes();

        assert!(retained >= legacy.saturating_mul(2));
        assert!(
            retained.abs_diff(expected) <= expected / 20,
            "projection estimate left 5% fixture tolerance: retained={retained} expected={expected}"
        );
    }

    #[test]
    fn repeated_call_id_within_owner_message_shares_one_arc_identity() {
        let message = CkIngressMessage {
            mid: "assistant-1".to_string(),
            ordinal: 1,
            ck: CkWireMessage::from_parts(
                "assistant",
                vec![
                    CkWireBlock::bare(CkKind::ToolCall {
                        id: "duplicate".into(),
                        name: "read".into(),
                        input: serde_json::json!({"path": "one"}),
                        provider_executed: false,
                    }),
                    CkWireBlock::bare(CkKind::ToolCall {
                        id: "duplicate".into(),
                        name: "read".into(),
                        input: serde_json::json!({"path": "two"}),
                        provider_executed: false,
                    }),
                ],
                None,
                ProviderExtras::new(),
                HarnessMeta::default(),
            ),
        };
        let projection = project_messages(&[message]).expect("duplicate call ids are projectable");
        assert_eq!(projection.blocks[0].arc_id, projection.blocks[1].arc_id);
        assert_eq!(
            projection.blocks[0].arc_id.as_deref(),
            Some("assistant-1#call:duplicate")
        );
    }

    // Claude Code emits the tool_result INSIDE the next user message (alongside the
    // user's queued text) when input arrives while a tool is still running. The result
    // must pair against the prior assistant's call even though the carrying role is
    // "user"; the arc-window clear runs after the message's own blocks are walked.
    #[test]
    fn user_carried_tool_result_pairs_with_prior_assistant_call() {
        let user_with_result = CkIngressMessage {
            mid: "m2".to_string(),
            ordinal: 2,
            ck: CkWireMessage::from_parts(
                "user",
                vec![
                    CkWireBlock::bare(CkKind::ToolResult {
                        id: "toolu_1".to_string(),
                        tool_name: "read".to_string(),
                        output: CkToolOutput::bare(CkOutputKind::Text {
                            text: "file contents".into(),
                        }),
                        provider_executed: false,
                    }),
                    CkWireBlock::bare(CkKind::Text {
                        text: "queued user question".into(),
                    }),
                ],
                None,
                ProviderExtras::new(),
                HarnessMeta::default(),
            ),
        };
        let messages = vec![
            text_msg("m0", 0, "user", "start"),
            assistant_with_call("m1", 1, "toolu_1"),
            user_with_result,
        ];
        let projection = project_messages(&messages).expect("user-carried result must pair");
        let result_block = projection
            .blocks
            .iter()
            .find(|b| b.id == "m2#0")
            .expect("result block present");
        assert_eq!(
            result_block.arc_id.as_deref(),
            Some("m1#1"),
            "result pairs to the prior assistant's call block"
        );
        // The user message still ends the arc window: a later stray result must fail.
        let mut with_stray = messages.clone();
        with_stray.push(CkIngressMessage {
            mid: "m3".to_string(),
            ordinal: 3,
            ck: CkWireMessage::from_parts(
                "tool",
                vec![CkWireBlock::bare(CkKind::ToolResult {
                    id: "toolu_1".to_string(),
                    tool_name: "read".to_string(),
                    output: CkToolOutput::bare(CkOutputKind::Text {
                        text: "again".into(),
                    }),
                    provider_executed: false,
                })],
                None,
                ProviderExtras::new(),
                HarnessMeta::default(),
            ),
        });
        let err = project_messages(&with_stray).expect_err("arc window closed by user turn");
        assert!(matches!(err, CkWireError::UnpairedToolResult { .. }));
    }

    // A genuinely orphaned result in a user message (no prior assistant call) still
    // fails loud — the fix moved the arc-window clear, it did not weaken pairing.
    #[test]
    fn user_carried_tool_result_without_prior_call_still_rejects() {
        let messages = vec![
            text_msg("m0", 0, "user", "start"),
            CkIngressMessage {
                mid: "m1".to_string(),
                ordinal: 1,
                ck: CkWireMessage::from_parts(
                    "user",
                    vec![CkWireBlock::bare(CkKind::ToolResult {
                        id: "toolu_orphan".to_string(),
                        tool_name: "read".to_string(),
                        output: CkToolOutput::bare(CkOutputKind::Text { text: "x".into() }),
                        provider_executed: false,
                    })],
                    None,
                    ProviderExtras::new(),
                    HarnessMeta::default(),
                ),
            },
        ];
        let err = project_messages(&messages).expect_err("orphan result must reject");
        assert!(matches!(err, CkWireError::UnpairedToolResult { .. }));
    }

    // Opaque and Media carriers inside tool_result content blocks are first-class
    // pass-through values, matching their top-level treatment.
    #[test]
    fn opaque_and_media_inside_tool_result_content_are_accepted_and_projected() {
        let result_with_opaque = CkIngressMessage {
            mid: "m2".to_string(),
            ordinal: 2,
            ck: CkWireMessage::from_parts(
                "tool",
                vec![CkWireBlock::bare(CkKind::ToolResult {
                    id: "toolu_1".to_string(),
                    tool_name: "computer".to_string(),
                    output: CkToolOutput::bare(CkOutputKind::Content {
                        blocks: vec![
                            ResultBlock {
                                kind: ResultBlockKind::Text {
                                    text: "screenshot captured".into(),
                                },
                                provider_extras: ProviderExtras::new(),
                            },
                            ResultBlock {
                                kind: ResultBlockKind::Opaque {
                                    opaque: OpaqueBlock {
                                        source: serde_json::json!({"source": "wire", "wire": "anthropic"}),
                                        kind: "image".to_string(),
                                        raw: serde_json::json!([1, 2, 3]),
                                        arc: None,
                                    },
                                },
                                provider_extras: ProviderExtras::new(),
                            },
                        ],
                    }),
                    provider_executed: false,
                })],
                None,
                ProviderExtras::new(),
                HarnessMeta::default(),
            ),
        };
        let messages = vec![
            text_msg("m0", 0, "user", "start"),
            assistant_with_call("m1", 1, "toolu_1"),
            result_with_opaque,
        ];
        let projection =
            project_messages(&messages).expect("result-embedded opaque must be accepted");
        assert!(projection.blocks.iter().any(|b| b.id == "m2#0"));

        let mut with_media = messages;
        if let CkKind::ToolResult { output, .. } = &mut with_media[2].ck.content[0].kind {
            if let CkOutputKind::Content { blocks } = &mut output.kind {
                blocks[1].kind = ResultBlockKind::Media {
                    media: MediaBlock {
                        kind: MediaKind::Image,
                        media_type: "image/png".to_string(),
                        filename: Some("capture.png".to_string()),
                        source: serde_json::json!({"type": "url", "url": "file://capture.png"}),
                    },
                };
            }
        }
        let media_projection =
            project_messages(&with_media).expect("result-embedded media must be accepted");
        assert!(media_projection
            .blocks
            .iter()
            .find(|block| block.id == "m2#0")
            .expect("media result block")
            .bytes
            .contains("file://capture.png"));
    }

    #[test]
    fn incremental_projection_reuses_prefix_storage_and_preserves_tool_arc_state() {
        let mut messages = vec![
            text_msg("m0", 0, "user", "start"),
            assistant_with_call("m1", 1, "toolu_1"),
            CkIngressMessage {
                mid: "m2".to_string(),
                ordinal: 2,
                ck: CkWireMessage::from_parts(
                    "tool",
                    vec![CkWireBlock::bare(CkKind::ToolResult {
                        id: "toolu_1".to_string(),
                        tool_name: "read".to_string(),
                        output: CkToolOutput::bare(CkOutputKind::Text {
                            text: "first result".into(),
                        }),
                        provider_executed: false,
                    })],
                    None,
                    ProviderExtras::new(),
                    HarnessMeta::default(),
                ),
            },
        ];
        let cached = project_messages(&messages).expect("initial projection");
        let reattached = cached
            .reattach_messages_prefix(2)
            .expect("cached projection rebuilds its acknowledged ingress prefix");
        assert_eq!(reattached, messages[..2]);
        if let CkKind::ToolResult { output, .. } = &mut messages[2].ck.content[0].kind {
            output.kind = CkOutputKind::Text {
                text: "changed result".into(),
            };
        }

        let incremental =
            project_messages_incremental(&messages, &cached, 2).expect("incremental projection");
        let full = project_messages(&messages).expect("full projection");
        assert_eq!(incremental, full);
        assert_eq!(incremental.differential_bytes(), full.differential_bytes());
        assert!(Arc::ptr_eq(
            &incremental.blocks[0].wire,
            &cached.blocks[0].wire
        ));
        assert!(Arc::ptr_eq(
            &incremental.blocks[0].bytes,
            &cached.blocks[0].bytes
        ));
        assert_eq!(
            incremental.blocks[2].arc_id.as_deref(),
            Some("m1#1"),
            "the cached frontier must carry the pending tool call into the suffix"
        );
    }
}
