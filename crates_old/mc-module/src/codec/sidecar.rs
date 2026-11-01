use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ck_wire::{CkIngressMessage, CkWireBlock};

/// A decoded compaction marker from a harness transcript.
///
/// This is an input fact extracted from the harness's own compaction marker. It
/// is not a caller-supplied cache anchor: the module still decides whether the
/// boundary is present and how cache-core state should consume it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedBoundary {
    pub harness: String,
    pub message_id: String,
    pub ordinal: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedHarnessMessages {
    pub messages: Vec<CkIngressMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary: Option<ExtractedBoundary>,
    pub sidecar: DecodeSidecar,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecodeSidecar {
    pub harness: String,
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub messages: BTreeMap<String, Arc<HarnessMessageMeta>>,
    #[serde(default)]
    pub mid_pins: BTreeMap<String, String>,
}

impl DecodeSidecar {
    pub fn new(harness: impl Into<String>) -> Self {
        Self {
            harness: harness.into(),
            order: Vec::new(),
            messages: BTreeMap::new(),
            mid_pins: BTreeMap::new(),
        }
    }

    pub fn remember_message(&mut self, mid: String, meta: HarnessMessageMeta) {
        if !self.messages.contains_key(&mid) {
            self.order.push(mid.clone());
        }
        self.messages.insert(mid, Arc::new(meta));
    }

    pub fn message_by_mid(&self, mid: &str) -> Option<&HarnessMessageMeta> {
        self.messages.get(mid).map(Arc::as_ref)
    }

    pub fn message_for_index(&self, index: usize) -> Option<&HarnessMessageMeta> {
        self.order
            .get(index)
            .and_then(|mid| self.messages.get(mid.as_str()))
            .map(Arc::as_ref)
    }

    pub fn inherit_pin(&self, stable_key: &str) -> Option<String> {
        self.mid_pins.get(stable_key).cloned()
    }

    pub fn pin_mid(&mut self, stable_key: impl Into<String>, mid: impl Into<String>) {
        self.mid_pins.insert(stable_key.into(), mid.into());
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HarnessMessageMeta {
    pub mid: String,
    pub ordinal: u64,
    pub role: String,
    pub raw: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stable_key: Option<String>,
    #[serde(default)]
    pub blocks: Vec<BlockMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockMeta {
    pub block_index: usize,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_fingerprint: Option<String>,
    pub raw: Value,
}

pub(crate) struct MatchedBlockMetas<'a> {
    pub(crate) by_block: Vec<Option<&'a BlockMeta>>,
    retained_native_indices: BTreeSet<usize>,
    decoded_native_indices: BTreeSet<usize>,
}

impl MatchedBlockMetas<'_> {
    pub(crate) fn remove_unretained_native_parts<T>(&self, parts: Vec<T>) -> Vec<T> {
        self.remove_unretained_native_parts_with_insertions(parts, Vec::new())
    }

    /// Remove decoded native parts whose CK blocks disappeared, then place unmatched replacement
    /// parts at an explicit native index or beside the nearest matched CK neighbor. This preserves
    /// persisted part order when fingerprints cannot prove identity after a sibling was removed.
    pub(crate) fn remove_unretained_native_parts_with_insertions<T>(
        &self,
        parts: Vec<T>,
        pending: Vec<(usize, Option<usize>, T)>,
    ) -> Vec<T> {
        let native_part_count = parts.len();
        let mut insertions = BTreeMap::<usize, Vec<T>>::new();
        for (block_index, preferred_native_index, part) in pending {
            let next_native_index = self
                .by_block
                .iter()
                .skip(block_index.saturating_add(1))
                .flatten()
                .find_map(|meta| meta.native_index);
            let previous_native_index = self
                .by_block
                .iter()
                .take(block_index)
                .rev()
                .flatten()
                .find_map(|meta| meta.native_index);
            let insertion_index = preferred_native_index
                .or(next_native_index)
                .or_else(|| previous_native_index.map(|index| index.saturating_add(1)))
                .unwrap_or(parts.len())
                .min(parts.len());
            insertions.entry(insertion_index).or_default().push(part);
        }

        let mut retained = Vec::with_capacity(
            parts
                .len()
                .saturating_add(insertions.values().map(Vec::len).sum::<usize>()),
        );
        for (native_index, part) in parts.into_iter().enumerate() {
            if let Some(mut inserted) = insertions.remove(&native_index) {
                retained.append(&mut inserted);
            }
            let decoded_block_was_removed = self.decoded_native_indices.contains(&native_index)
                && !self.retained_native_indices.contains(&native_index);
            if !decoded_block_was_removed {
                retained.push(part);
            }
        }
        if let Some(mut inserted) = insertions.remove(&native_part_count) {
            retained.append(&mut inserted);
        }
        for (_, mut inserted) in insertions {
            retained.append(&mut inserted);
        }
        retained
    }
}

const BLOCK_IDENTITY_NAMESPACE: &str = "_cortexkit_codec";
const BLOCK_INDEX_KEY: &str = "blockIndex";
const NATIVE_INDEX_KEY: &str = "nativeIndex";
const FINGERPRINT_KEY: &str = "decodedFingerprint";

#[derive(Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
struct AlignmentScore {
    origin_matches: usize,
    total_matches: usize,
}

impl AlignmentScore {
    fn with_match(self, origin_match: bool) -> Self {
        Self {
            origin_matches: self.origin_matches + usize::from(origin_match),
            total_matches: self.total_matches + 1,
        }
    }
}

pub(crate) fn decoded_block_fingerprint(block: &CkWireBlock) -> String {
    profile_start!(_perf_fingerprint, "rt07_decode_fingerprint");
    #[derive(Serialize)]
    struct TypedBlock<'a> {
        kind: &'a crate::ck_wire::CkKind,
        #[serde(skip_serializing_if = "BTreeMap::is_empty")]
        provider_extras: BTreeMap<&'a String, &'a BTreeMap<String, Value>>,
    }
    // Fingerprints deliberately ignore retained outer ingress JSON and our own
    // identity stamp. Borrow the typed fields instead of cloning and then
    // discarding the retained ingress payload. Keep the sorted Value form: a
    // typed serializer emits nested keys in a different order.
    let typed = TypedBlock {
        kind: &block.kind,
        provider_extras: block
            .provider_extras
            .iter()
            .filter(|(namespace, _)| namespace.as_str() != BLOCK_IDENTITY_NAMESPACE)
            .collect(),
    };
    stable_hash(&serde_json::to_value(typed).unwrap_or(Value::Null))
}

pub(crate) fn stamp_block_identity(
    block: &mut CkWireBlock,
    block_index: usize,
    native_index: usize,
    fingerprint: &str,
) {
    let identity = block
        .provider_extras
        .entry(BLOCK_IDENTITY_NAMESPACE.to_string())
        .or_default();
    identity.insert(BLOCK_INDEX_KEY.to_string(), Value::from(block_index));
    identity.insert(NATIVE_INDEX_KEY.to_string(), Value::from(native_index));
    identity.insert(
        FINGERPRINT_KEY.to_string(),
        Value::String(fingerprint.to_string()),
    );
    block.mark_modified();
}

fn stamped_block_identity(block: &CkWireBlock) -> Option<(usize, usize, &str)> {
    let identity = block.provider_extras.get(BLOCK_IDENTITY_NAMESPACE)?;
    let block_index = identity.get(BLOCK_INDEX_KEY)?.as_u64()?.try_into().ok()?;
    let native_index = identity.get(NATIVE_INDEX_KEY)?.as_u64()?.try_into().ok()?;
    let fingerprint = identity.get(FINGERPRINT_KEY)?.as_str()?;
    Some((block_index, native_index, fingerprint))
}

/// True when a decoded block still carries its exact native-part origin. Frozen rewrites retain
/// this stamp, allowing the encoder to update the original part instead of using compatibility
/// coalescing for an unmatched call/result shell.
pub(crate) fn has_stamped_block_identity(block: &CkWireBlock) -> bool {
    stamped_block_identity(block).is_some()
}

pub(crate) fn block_is_unchanged(block: &CkWireBlock, meta: &BlockMeta) -> bool {
    meta.content_fingerprint
        .as_deref()
        .is_some_and(|fingerprint| decoded_block_fingerprint(block) == fingerprint)
}

fn alignment_candidate(
    block: &CkWireBlock,
    block_index: usize,
    meta: &BlockMeta,
    kind_matches: bool,
) -> Option<bool> {
    if let Some((origin_block_index, origin_native_index, fingerprint)) =
        stamped_block_identity(block)
    {
        let origin_matches = origin_block_index == meta.block_index
            && Some(origin_native_index) == meta.native_index
            && meta.content_fingerprint.as_deref() == Some(fingerprint);
        return origin_matches.then_some(true);
    }

    if kind_matches
        && meta
            .content_fingerprint
            .as_deref()
            .is_some_and(|fingerprint| decoded_block_fingerprint(block) == fingerprint)
    {
        return Some(false);
    }

    // For sidecars written before fingerprints existed, match by position only when the block
    // index is unchanged. This keeps old sessions readable without re-enabling the old fallback
    // that inferred matches by scanning nearby blocks of the same kind after deletions.
    (meta.content_fingerprint.is_none() && block_index == meta.block_index && kind_matches)
        .then_some(false)
}

pub(crate) fn match_block_metas<'a>(
    blocks: &[CkWireBlock],
    metas: &'a [BlockMeta],
    allow_unstamped_positional_alignment: bool,
    mut matches: impl FnMut(&CkWireBlock, &BlockMeta) -> bool,
) -> MatchedBlockMetas<'a> {
    let mut kind_matches = vec![vec![false; metas.len()]; blocks.len()];
    let mut candidates = vec![vec![None; metas.len()]; blocks.len()];
    for (block_index, block) in blocks.iter().enumerate() {
        for (meta_index, meta) in metas.iter().enumerate() {
            let kind_matches_meta = matches(block, meta);
            kind_matches[block_index][meta_index] = kind_matches_meta;
            candidates[block_index][meta_index] =
                alignment_candidate(block, block_index, meta, kind_matches_meta);
        }
    }

    // The TypeScript adapter and the native decoder independently project the same persisted
    // OpenCode parts. Adapter blocks do not carry the decoder's private origin stamp, but when
    // the complete kind vector and every native block index agree, position is the stable origin
    // identity. This lets an in-place tag edit update its original text part instead of appending
    // after a later tool part. Any insertion or deletion breaks the whole-vector check and falls
    // through to stamped/fingerprint alignment, preserving deletion-compaction safety.
    let adapter_projection_matches = allow_unstamped_positional_alignment
        && blocks.len() == metas.len()
        && blocks
            .iter()
            .all(|block| stamped_block_identity(block).is_none())
        && metas
            .iter()
            .enumerate()
            .all(|(index, meta)| meta.block_index == index && kind_matches[index][index]);
    if adapter_projection_matches {
        return MatchedBlockMetas {
            by_block: metas.iter().map(Some).collect(),
            retained_native_indices: metas.iter().filter_map(|meta| meta.native_index).collect(),
            decoded_native_indices: metas.iter().filter_map(|meta| meta.native_index).collect(),
        };
    }

    // Origin indexes are stamped onto decoded blocks and survive reductions, overlays, and
    // deletion compaction through CkWireBlock::provider_extras. The fingerprint stored beside
    // that index is always the pre-mutation decoded fingerprint, so a mutated survivor aligns
    // with its own native meta rather than being compared by its current bytes. The LCS-style
    // walk preserves native order and refuses the former same-kind adjacency fallback.
    let mut scores = vec![vec![AlignmentScore::default(); metas.len() + 1]; blocks.len() + 1];
    for block_index in (0..blocks.len()).rev() {
        for meta_index in (0..metas.len()).rev() {
            let mut best =
                scores[block_index + 1][meta_index].max(scores[block_index][meta_index + 1]);
            if let Some(origin_match) = candidates[block_index][meta_index] {
                best = best.max(scores[block_index + 1][meta_index + 1].with_match(origin_match));
            }
            scores[block_index][meta_index] = best;
        }
    }

    let mut by_block = vec![None; blocks.len()];
    let (mut block_index, mut meta_index) = (0, 0);
    while block_index < blocks.len() && meta_index < metas.len() {
        if let Some(origin_match) = candidates[block_index][meta_index] {
            let matched_score = scores[block_index + 1][meta_index + 1].with_match(origin_match);
            if matched_score == scores[block_index][meta_index] {
                by_block[block_index] = Some(&metas[meta_index]);
                block_index += 1;
                meta_index += 1;
                continue;
            }
        }
        if scores[block_index + 1][meta_index] >= scores[block_index][meta_index + 1] {
            block_index += 1;
        } else {
            meta_index += 1;
        }
    }

    let retained_native_indices = by_block
        .iter()
        .filter_map(|meta| meta.and_then(|meta| meta.native_index))
        .collect();
    let decoded_native_indices = metas.iter().filter_map(|meta| meta.native_index).collect();

    MatchedBlockMetas {
        by_block,
        retained_native_indices,
        decoded_native_indices,
    }
}

pub fn stable_hash(value: &Value) -> String {
    let digest = crate::digest::json_value(value);
    hex_prefix(&digest, digest.len())
}

pub fn stable_hash_prefix(value: &Value, chars: usize) -> String {
    let digest = crate::digest::json_value(value);
    hex_prefix(&digest, chars.div_ceil(2))
        .chars()
        .take(chars)
        .collect()
}

fn hex_prefix(bytes: &[u8], count: usize) -> String {
    crate::digest::hex(&bytes[..count.min(bytes.len())])
}

pub fn meta_for_ck<'a>(
    sidecar: &'a DecodeSidecar,
    msg: &'a crate::ck_wire::CkWireMessage,
    index: usize,
) -> Option<&'a HarnessMessageMeta> {
    msg.meta
        .harness_id
        .as_deref()
        .and_then(|mid| sidecar.message_by_mid(mid))
        .or_else(|| {
            (!msg.meta.synthetic)
                .then(|| sidecar.message_for_index(index))
                .flatten()
        })
}

pub(crate) fn is_synthetic_part(part: &Value) -> bool {
    part.get("synthetic")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || part
            .get("syntheticTodoMarker")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

#[cfg(test)]
mod digest_tests {
    use super::*;
    use crate::ck_wire::{CkKind, CkOutputKind, CkToolOutput};
    use serde_json::json;
    use sha2::{Digest, Sha256};

    #[test]
    fn borrowed_decoded_fingerprint_matches_owned_sorted_reference() {
        for kind in [
            CkKind::Text {
                text: "quoted\"\0é🙂".into(),
            },
            CkKind::Reasoning {
                text: "thinking".into(),
                signature: Some("signature".into()),
            },
            CkKind::ToolCall {
                id: "call".into(),
                name: "read".into(),
                input: json!({"z":[1.0,false],"a":{"quoted":"\"\\"}}),
                provider_executed: false,
            },
            CkKind::ToolResult {
                id: "call".into(),
                tool_name: "read".into(),
                output: CkToolOutput::bare(CkOutputKind::Json {
                    value: json!({"z":1,"a":[null,"é"]}),
                }),
                provider_executed: false,
            },
        ] {
            let mut value = serde_json::to_value(CkWireBlock::bare(kind)).unwrap();
            value["unknown_outer_ingress"] = json!({"ignored":"retained source"});
            let mut block: CkWireBlock = serde_json::from_value(value).unwrap();
            for extras in [false, true] {
                if extras {
                    block.provider_extras.insert(
                        "vendor".into(),
                        BTreeMap::from([
                            ("z".into(), json!({"nested":[1.0, "é\0"]})),
                            ("a".into(), json!(true)),
                        ]),
                    );
                }
                block.provider_extras.insert(
                    BLOCK_IDENTITY_NAMESPACE.into(),
                    BTreeMap::from([("stamp".into(), json!(42))]),
                );
                let mut owned = block.clone();
                owned.provider_extras.remove(BLOCK_IDENTITY_NAMESPACE);
                owned.mark_modified();
                let canonical = serde_json::to_value(owned).unwrap();
                let bytes = serde_json::to_vec(&canonical).unwrap();
                let expected = format!("{:x}", Sha256::digest(bytes));
                assert_eq!(decoded_block_fingerprint(&block), expected);
                for length in [0, 1, 23, 24, 63, 64, 65] {
                    assert_eq!(
                        stable_hash_prefix(&canonical, length),
                        expected.chars().take(length).collect::<String>()
                    );
                }
            }
        }
    }
}
