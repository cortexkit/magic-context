//! Shared rendered-tail hygiene metric for the module's Channel-1 and Channel-2 nudges.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt::Write as _;

use mc_core::CoreState;
use mc_store::{
    CkOutputKind, McTagRow, MediaBlock, MediaKind, ResultBlockKind, TailHygieneBaseline,
    TailHygienePartKind, TailHygienePartMeasurement,
};
use sha2::{Digest, Sha256};

use crate::ck_wire::{FlatBlock, FlatProjection};

pub(crate) const CHANNEL1_MIN_TOKENS: i64 = 60_000;
pub(crate) const CHANNEL1_FLOOR_TOKENS: i64 = 25_000;
pub(crate) const CHANNEL2_FLOOR_TOKENS: i64 = 50_000;
pub(crate) const CHANNEL2_SEVERITY_THRESHOLD: f64 = 0.75;

const RED_KEY_PREFIX: &str = "red:";
const CAV_KEY_PREFIX: &str = "cav:";
const CHANNEL1_REMINDER_OPEN: &str = "\n\n<system-reminder>\n";
const CHANNEL1_REMINDER_CLOSE: &str = "\n</system-reminder>";
const IMAGE_TOKEN_DIVISOR: u64 = 750;
const IMAGE_FALLBACK_TOKENS: i64 = 1_200;
const IMAGE_TOKEN_CAP: i64 = 4_500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HygieneBand {
    Quiet,
    Gentle,
    Firm,
    Urgent,
    Channel2,
}

impl HygieneBand {
    #[cfg(test)]
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Quiet => "quiet",
            Self::Gentle => "gentle",
            Self::Firm => "firm",
            Self::Urgent => "urgent",
            Self::Channel2 => "channel2",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TailHygieneMeasurement {
    pub(crate) u: i64,
    pub(crate) t: i64,
    pub(crate) content_signature: String,
    pub(crate) parts: Vec<TailHygienePartMeasurement>,
}

/// Count distinct user messages that reached the tail as authored turns.
/// `FlatBlock::synthetic` is the codec's machine-origin marker: it is set for
/// injected m0/m1 heads and Channel-2 rows, so those user-shaped rows do not
/// advance Channel-1's cadence.
pub(crate) fn real_user_turn_count(projection: &FlatProjection) -> u64 {
    projection
        .blocks
        .iter()
        .filter(|block| block.role == "user" && !block.synthetic)
        .map(|block| block.mid.as_str())
        .collect::<HashSet<_>>()
        .len() as u64
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

fn strip_channel1_reminder_spans(output: &str) -> &str {
    let mut stripped = output;
    while stripped.ends_with(CHANNEL1_REMINDER_CLOSE) {
        let Some(opener) = stripped.rfind(CHANNEL1_REMINDER_OPEN) else {
            break;
        };
        stripped = &stripped[..opener];
    }
    stripped
}

fn is_drop_sentinel(content: &str) -> bool {
    let mut head = content.trim_start();
    if let Some(rest) = head.strip_prefix('§') {
        if let Some((_, suffix)) = rest.split_once("§") {
            head = suffix.trim_start();
        }
    }
    let head = head.to_ascii_lowercase();
    head.starts_with("[dropped") || head.starts_with("[truncated")
}

fn estimated_tokens(content: &str) -> i64 {
    mc_tokenizer::estimate_tokens(content) as i64
}

fn media_content(media: &MediaBlock) -> String {
    media
        .source
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| serde_json::to_string(&media.source).unwrap_or_default())
}

fn decode_base64_preview(payload: &str) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(payload.len() * 3 / 4);
    let mut quartet = [0u8; 4];
    let mut filled = 0usize;
    for byte in payload.bytes().take(512) {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return None,
        };
        quartet[filled] = value;
        filled += 1;
        if filled == 4 {
            output.push((quartet[0] << 2) | (quartet[1] >> 4));
            output.push((quartet[1] << 4) | (quartet[2] >> 2));
            output.push((quartet[2] << 6) | quartet[3]);
            filled = 0;
        }
    }
    if filled >= 2 {
        output.push((quartet[0] << 2) | (quartet[1] >> 4));
    }
    if filled >= 3 {
        output.push((quartet[1] << 4) | (quartet[2] >> 2));
    }
    Some(output)
}

fn image_dimensions(header: &str, bytes: &[u8]) -> Option<(u64, u64)> {
    if header.contains("image/png")
        && bytes.len() >= 24
        && bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a])
    {
        let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?) as u64;
        let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?) as u64;
        return (width > 0 && height > 0).then_some((width, height));
    }
    if header.contains("image/gif") && bytes.len() >= 10 && bytes.starts_with(b"GIF") {
        let width = u16::from_le_bytes(bytes[6..8].try_into().ok()?) as u64;
        let height = u16::from_le_bytes(bytes[8..10].try_into().ok()?) as u64;
        return (width > 0 && height > 0).then_some((width, height));
    }
    if (header.contains("image/jpeg") || header.contains("image/jpg"))
        && bytes.starts_with(&[0xff, 0xd8])
    {
        let mut index = 2usize;
        while index + 8 < bytes.len() {
            if bytes[index] != 0xff {
                index += 1;
                continue;
            }
            let marker = bytes[index + 1];
            let is_sof = matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf);
            if is_sof {
                let height = u16::from_be_bytes([bytes[index + 5], bytes[index + 6]]) as u64;
                let width = u16::from_be_bytes([bytes[index + 7], bytes[index + 8]]) as u64;
                return (width > 0 && height > 0).then_some((width, height));
            }
            if matches!(marker, 0xd8 | 0xd9 | 0x01) {
                index += 2;
                continue;
            }
            let segment_len = u16::from_be_bytes([bytes[index + 2], bytes[index + 3]]) as usize;
            if segment_len < 2 {
                return None;
            }
            index = index.saturating_add(2 + segment_len);
        }
    }
    if header.contains("image/webp")
        && bytes.len() >= 30
        && bytes.starts_with(b"RIFF")
        && &bytes[8..12] == b"WEBP"
    {
        let variant = &bytes[12..16];
        let (width, height) = if variant == b"VP8 " {
            (
                u16::from_le_bytes([bytes[26], bytes[27]]) as u64 & 0x3fff,
                u16::from_le_bytes([bytes[28], bytes[29]]) as u64 & 0x3fff,
            )
        } else if variant == b"VP8L" {
            let width = 1 + (u16::from_le_bytes([bytes[21], bytes[22]]) as u64 & 0x3fff);
            let height = 1
                + (((bytes[22] as u64 >> 6)
                    | ((bytes[23] as u64) << 2)
                    | ((bytes[24] as u64) << 10))
                    & 0x3fff);
            (width, height)
        } else if variant == b"VP8X" {
            (
                1 + bytes[24] as u64 + ((bytes[25] as u64) << 8) + ((bytes[26] as u64) << 16),
                1 + bytes[27] as u64 + ((bytes[28] as u64) << 8) + ((bytes[29] as u64) << 16),
            )
        } else {
            return None;
        };
        return (width > 0 && height > 0).then_some((width, height));
    }
    None
}

fn estimate_image_tokens(data_url: &str) -> i64 {
    let Some((header, payload)) = data_url.split_once(',') else {
        return IMAGE_FALLBACK_TOKENS;
    };
    let Some(bytes) = decode_base64_preview(payload) else {
        return IMAGE_FALLBACK_TOKENS;
    };
    let Some((width, height)) = image_dimensions(header, &bytes) else {
        return IMAGE_FALLBACK_TOKENS;
    };
    let pixels = width.saturating_mul(height);
    let tokens = pixels.saturating_add(IMAGE_TOKEN_DIVISOR - 1) / IMAGE_TOKEN_DIVISOR;
    (tokens as i64).clamp(1, IMAGE_TOKEN_CAP)
}

fn media_tokens(media: &MediaBlock, content: &str) -> i64 {
    match media.kind {
        MediaKind::Image => estimate_image_tokens(content),
        MediaKind::Audio | MediaKind::Video | MediaKind::File | MediaKind::Document => {
            estimated_tokens(content)
        }
    }
}

fn tool_output_content(output: &CkOutputKind) -> String {
    match output {
        CkOutputKind::Text { text } | CkOutputKind::ErrorText { text } => text.clone(),
        CkOutputKind::Json { value } | CkOutputKind::ErrorJson { value } => {
            serde_json::to_string(value).unwrap_or_default()
        }
        CkOutputKind::ExecutionDenied { reason } => reason.clone().unwrap_or_default(),
        CkOutputKind::Content { blocks } | CkOutputKind::ErrorContent { blocks } => {
            let mut content = String::new();
            for block in blocks {
                match &block.kind {
                    ResultBlockKind::Text { text } => content.push_str(text),
                    ResultBlockKind::Media { media } => content.push_str(&media_content(media)),
                    ResultBlockKind::Opaque { .. } => {}
                }
            }
            content
        }
    }
}

fn part_measurement(
    key: String,
    kind: TailHygienePartKind,
    content: &str,
    tokens: i64,
    tag_number: Option<i64>,
    protected: bool,
    queued_for_drop: bool,
) -> TailHygienePartMeasurement {
    let kind_name = match kind {
        TailHygienePartKind::Text => "text",
        TailHygienePartKind::ToolInput => "toolInput",
        TailHygienePartKind::ToolOutput => "toolOutput",
        TailHygienePartKind::File => "file",
        TailHygienePartKind::Excluded => "excluded",
    };
    let mut hash_input = String::with_capacity(kind_name.len() + content.len() + 1);
    hash_input.push_str(kind_name);
    hash_input.push('\0');
    hash_input.push_str(content);
    let active = tag_number.is_some() && !queued_for_drop;
    TailHygienePartMeasurement {
        key,
        content_hash: hex_digest(hash_input),
        kind,
        tokens,
        u_tokens: if active && !protected { tokens } else { 0 },
        tag_number,
        tag_status: tag_number.map(|_| "active".to_string()),
        protected,
        queued_for_drop,
    }
}

fn excluded_part(key: String, content: &str) -> TailHygienePartMeasurement {
    part_measurement(
        key,
        TailHygienePartKind::Excluded,
        content,
        0,
        None,
        false,
        false,
    )
}

fn projection_message_indexes(projection: &FlatProjection) -> HashMap<&str, usize> {
    let mut indexes = HashMap::new();
    for block in &projection.blocks {
        let next = indexes.len();
        indexes.entry(block.mid.as_str()).or_insert(next);
    }
    indexes
}

fn neighborhood_consistent(
    orphan_tag_number: i64,
    message_index: usize,
    message_count: usize,
    bounds_by_message: &HashMap<usize, (i64, i64)>,
) -> bool {
    let previous_max = (0..=message_index)
        .filter_map(|index| bounds_by_message.get(&index).map(|(_, max)| *max))
        .max();
    let next_min = ((message_index + 1)..message_count)
        .filter_map(|index| bounds_by_message.get(&index).map(|(min, _)| *min))
        .min();
    matches!((previous_max, next_min), (Some(previous), Some(next)) if orphan_tag_number >= previous && orphan_tag_number <= next)
}

/// Build part attribution from exact block identities. Pre-composite legacy rows whose block id is
/// only a raw call id use the fallback only when one owner arc and its tag-number neighborhood are
/// unambiguous; recurring call ids otherwise remain T-only.
fn tag_numbers_by_block_and_arc(
    projection: &FlatProjection,
    tag_rows: &[McTagRow],
) -> (HashMap<String, i64>, HashMap<String, i64>) {
    let block_ids = projection
        .blocks
        .iter()
        .map(|block| block.id.as_str())
        .collect::<HashSet<_>>();
    let message_indexes = projection_message_indexes(projection);
    let mut by_block = HashMap::new();
    let mut by_arc = HashMap::new();
    let mut bounds_by_message = HashMap::<usize, (i64, i64)>::new();

    for row in tag_rows
        .iter()
        .filter(|row| block_ids.contains(row.block_id.as_str()))
    {
        by_block.insert(row.block_id.clone(), row.tag_number);
        let Some(block) = projection
            .blocks
            .iter()
            .find(|block| block.id == row.block_id)
        else {
            continue;
        };
        if let Some(arc_id) = &block.arc_id {
            by_arc.entry(arc_id.clone()).or_insert(row.tag_number);
        }
        if let Some(index) = message_indexes.get(block.mid.as_str()) {
            bounds_by_message
                .entry(*index)
                .and_modify(|(min, max)| {
                    *min = (*min).min(row.tag_number);
                    *max = (*max).max(row.tag_number);
                })
                .or_insert((row.tag_number, row.tag_number));
        }
    }

    let call_ids = projection
        .blocks
        .iter()
        .filter_map(|block| block.tool_call_id.as_deref())
        .collect::<HashSet<_>>();
    let mut orphan_rows = HashMap::<&str, Vec<&McTagRow>>::new();
    for row in tag_rows.iter().filter(|row| {
        !block_ids.contains(row.block_id.as_str()) && call_ids.contains(row.block_id.as_str())
    }) {
        orphan_rows
            .entry(row.block_id.as_str())
            .or_default()
            .push(row);
    }

    for (call_id, rows) in orphan_rows {
        if rows.len() != 1 {
            continue;
        }
        let candidate_arcs = projection
            .blocks
            .iter()
            .filter(|block| block.tool_call_id.as_deref() == Some(call_id))
            .filter_map(|block| block.arc_id.as_deref())
            .filter(|arc_id| !by_arc.contains_key(*arc_id))
            .collect::<BTreeSet<_>>();
        if candidate_arcs.len() != 1 {
            continue;
        }
        let arc_id = *candidate_arcs.first().expect("one candidate arc");
        let Some(owner_index) = projection
            .blocks
            .iter()
            .filter(|block| block.arc_id.as_deref() == Some(arc_id))
            .filter_map(|block| message_indexes.get(block.mid.as_str()).copied())
            .min()
        else {
            continue;
        };
        if neighborhood_consistent(
            rows[0].tag_number,
            owner_index,
            message_indexes.len(),
            &bounds_by_message,
        ) {
            by_arc.insert(arc_id.to_string(), rows[0].tag_number);
        }
    }

    (by_block, by_arc)
}

fn protected_tag_numbers(tag_rows: &[McTagRow], protected_tags: usize) -> HashSet<i64> {
    if protected_tags == 0 {
        return HashSet::new();
    }
    tag_rows
        .iter()
        .map(|row| row.tag_number)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .rev()
        .take(protected_tags)
        .collect()
}

fn red_targets(core: &CoreState) -> HashSet<&str> {
    core.frozen_units
        .iter()
        .filter_map(|unit| unit.key.strip_prefix(RED_KEY_PREFIX))
        .collect()
}

fn caveman_content<'a>(core: &'a CoreState, block: &FlatBlock) -> Option<&'a str> {
    let key = format!("{CAV_KEY_PREFIX}{}", block.id);
    core.frozen_units
        .iter()
        .find(|unit| unit.key == key)
        .map(|unit| unit.frozen_payload.as_str())
}

fn block_tag_number(
    block: &FlatBlock,
    by_block: &HashMap<String, i64>,
    by_arc: &HashMap<String, i64>,
) -> Option<i64> {
    by_block.get(&block.id).copied().or_else(|| {
        block
            .arc_id
            .as_ref()
            .and_then(|arc_id| by_arc.get(arc_id).copied())
    })
}

fn block_is_protected(
    block: &FlatBlock,
    tag_number: Option<i64>,
    protected_numbers: &HashSet<i64>,
    protected_block_ids: &HashSet<String>,
    protected_arc_ids: &HashSet<&str>,
) -> bool {
    tag_number.is_some_and(|number| protected_numbers.contains(&number))
        || protected_block_ids.contains(&block.id)
        || block
            .arc_id
            .as_deref()
            .is_some_and(|arc_id| protected_arc_ids.contains(arc_id))
}

// Production measures through measure_tail_hygiene_with_pending_drops (queued
// agent drops leave U); this unqueued form remains as the tests' baseline
// reference for delta/parity assertions.
#[cfg(test)]
pub(crate) fn measure_tail_hygiene(
    projection: &FlatProjection,
    core: &CoreState,
    coverage_ordinal: Option<u64>,
    tag_rows: &[McTagRow],
    protected_tags: usize,
    protected_block_ids: &HashSet<String>,
) -> TailHygieneMeasurement {
    measure_tail_hygiene_with_pending_drops(
        projection,
        core,
        coverage_ordinal,
        tag_rows,
        protected_tags,
        protected_block_ids,
        &HashSet::new(),
    )
}

pub(crate) fn queued_tag_numbers(
    tag_rows: &[McTagRow],
    pending_drop_target_ids: &HashSet<String>,
) -> HashSet<i64> {
    tag_rows
        .iter()
        .filter(|row| pending_drop_target_ids.contains(&row.block_id))
        .map(|row| row.tag_number)
        .collect()
}

pub(crate) fn measure_tail_hygiene_with_pending_drops(
    projection: &FlatProjection,
    core: &CoreState,
    coverage_ordinal: Option<u64>,
    tag_rows: &[McTagRow],
    protected_tags: usize,
    protected_block_ids: &HashSet<String>,
    pending_drop_target_ids: &HashSet<String>,
) -> TailHygieneMeasurement {
    let (tags_by_block, tags_by_arc) = tag_numbers_by_block_and_arc(projection, tag_rows);
    let protected_numbers = protected_tag_numbers(tag_rows, protected_tags);
    let queued_numbers = queued_tag_numbers(tag_rows, pending_drop_target_ids);
    let protected_arc_ids = projection
        .blocks
        .iter()
        .filter(|block| protected_block_ids.contains(&block.id))
        .filter_map(|block| block.arc_id.as_deref())
        .collect::<HashSet<_>>();
    let red_targets = red_targets(core);
    let reduced_arcs = projection
        .blocks
        .iter()
        .filter(|block| red_targets.contains(block.id.as_str()))
        .filter_map(|block| block.arc_id.as_deref())
        .collect::<HashSet<_>>();
    let sentinel_arcs = projection
        .blocks
        .iter()
        .filter_map(|block| {
            let mc_store::CkKind::ToolResult { output, .. } = &block.wire.kind else {
                return None;
            };
            if is_drop_sentinel(&tool_output_content(&output.kind)) {
                block.arc_id.as_deref()
            } else {
                None
            }
        })
        .collect::<HashSet<_>>();

    let mut parts = Vec::with_capacity(projection.blocks.len());
    let mut u = 0i64;
    let mut t = 0i64;
    for block in &projection.blocks {
        let key = format!("{}\0{}", block.id, block.kind_tag);
        if block.synthetic
            || block.role == "system"
            || coverage_ordinal.is_some_and(|coverage| block.ordinal <= coverage)
            || block
                .arc_id
                .as_deref()
                .is_some_and(|arc| reduced_arcs.contains(arc) || sentinel_arcs.contains(arc))
            || red_targets.contains(block.id.as_str())
        {
            parts.push(excluded_part(key, &block.bytes));
            continue;
        }

        let tag_number = block_tag_number(block, &tags_by_block, &tags_by_arc);
        let protected = block_is_protected(
            block,
            tag_number,
            &protected_numbers,
            protected_block_ids,
            &protected_arc_ids,
        );
        let queued_for_drop = tag_number.is_some_and(|number| queued_numbers.contains(&number));
        let measured = match &block.wire.kind {
            mc_store::CkKind::Text { text }
                if block.role == "user" || block.role == "assistant" =>
            {
                let content = caveman_content(core, block).unwrap_or(text);
                let content = strip_channel1_reminder_spans(content);
                if content.is_empty() || is_drop_sentinel(content) {
                    excluded_part(key, content)
                } else {
                    part_measurement(
                        key,
                        TailHygienePartKind::Text,
                        content,
                        estimated_tokens(content),
                        tag_number,
                        protected,
                        queued_for_drop,
                    )
                }
            }
            mc_store::CkKind::ToolCall { input, .. } => {
                let content = serde_json::to_string(input).unwrap_or_default();
                part_measurement(
                    key,
                    TailHygienePartKind::ToolInput,
                    &content,
                    estimated_tokens(&content),
                    tag_number,
                    protected,
                    queued_for_drop,
                )
            }
            mc_store::CkKind::ToolResult { output, .. } => {
                let raw_content = tool_output_content(&output.kind);
                let content = strip_channel1_reminder_spans(&raw_content);
                if content.is_empty() || is_drop_sentinel(content) {
                    excluded_part(key, content)
                } else {
                    part_measurement(
                        key,
                        TailHygienePartKind::ToolOutput,
                        content,
                        estimated_tokens(content),
                        tag_number,
                        protected,
                        queued_for_drop,
                    )
                }
            }
            mc_store::CkKind::Media(media) => {
                let content = media_content(media);
                if content.is_empty() || is_drop_sentinel(&content) {
                    excluded_part(key, &content)
                } else {
                    part_measurement(
                        key,
                        TailHygienePartKind::File,
                        &content,
                        media_tokens(media, &content),
                        tag_number,
                        protected,
                        queued_for_drop,
                    )
                }
            }
            mc_store::CkKind::Reasoning { .. }
            | mc_store::CkKind::RedactedReasoning { .. }
            | mc_store::CkKind::Opaque(_) => excluded_part(key, &block.bytes),
            mc_store::CkKind::Text { .. } => excluded_part(key, &block.bytes),
        };
        t = t.saturating_add(measured.tokens.max(0));
        u = u.saturating_add(measured.u_tokens.max(0));
        parts.push(measured);
    }
    let mut signature_input = String::new();
    for part in &parts {
        let _ = write!(signature_input, "{}:{}\0", part.key, part.content_hash);
    }
    let t = t.max(0);
    TailHygieneMeasurement {
        u: u.clamp(0, t),
        t,
        content_signature: hex_digest(signature_input),
        parts,
    }
}

fn same_measured_prefix(
    baseline: &[TailHygienePartMeasurement],
    current: &[TailHygienePartMeasurement],
) -> Option<(i64, i64)> {
    if current.len() < baseline.len() {
        return None;
    }
    let mut boundary_advance_u = 0i64;
    let mut queued_drop_delta_u = 0i64;
    for (before, after) in baseline.iter().zip(current) {
        if before.key != after.key
            || before.content_hash != after.content_hash
            || before.kind != after.kind
            || before.tokens != after.tokens
            || before.tag_number != after.tag_number
            || before.tag_status != after.tag_status
            || (!before.protected && after.protected)
        {
            return None;
        }
        if before.protected && !after.protected {
            if after.tag_status.as_deref() != Some("active") {
                return None;
            }
            boundary_advance_u = boundary_advance_u.saturating_add(after.u_tokens);
        } else if before.queued_for_drop != after.queued_for_drop {
            if before.tag_status.as_deref() != Some("active")
                || after.tag_status.as_deref() != Some("active")
            {
                return None;
            }
            queued_drop_delta_u =
                queued_drop_delta_u.saturating_add(after.u_tokens.saturating_sub(before.u_tokens));
        } else if before.u_tokens != after.u_tokens {
            return None;
        }
    }
    Some((boundary_advance_u, queued_drop_delta_u))
}

pub(crate) fn refresh_tail_hygiene_baseline(
    measured: TailHygieneMeasurement,
    cache_busting: bool,
    previous: Option<&TailHygieneBaseline>,
    now_ms: i64,
) -> TailHygieneBaseline {
    if !cache_busting && previous.is_some_and(|baseline| baseline.generation_invalidated) {
        let mut baseline = previous.expect("checked previous baseline").clone();
        baseline.content_signature = measured.content_signature;
        return baseline;
    }
    if cache_busting || previous.is_none() {
        return TailHygieneBaseline {
            baseline_u: measured.u,
            baseline_t: measured.t,
            turn_delta_u: 0,
            turn_delta_t: 0,
            baseline_generation: previous
                .map_or(0, |baseline| baseline.baseline_generation)
                .saturating_add(1),
            computed_at_ms: now_ms,
            evaluable: true,
            generation_invalidated: false,
            baseline_parts: measured.parts,
            content_signature: measured.content_signature,
        };
    }

    let previous = previous.expect("non-busting refresh has a previous baseline");
    let Some((boundary_advance_u, queued_drop_delta_u)) =
        same_measured_prefix(&previous.baseline_parts, &measured.parts)
    else {
        let mut invalidated = previous.clone();
        invalidated.evaluable = false;
        invalidated.generation_invalidated = true;
        invalidated.content_signature = measured.content_signature;
        return invalidated;
    };
    let mut turn_delta_t = 0i64;
    // Queue membership is an action-state delta: it reduces the actionable token
    // backlog while the frozen baseline and still-rendered token total remain unchanged.
    let mut turn_delta_u = boundary_advance_u.saturating_add(queued_drop_delta_u);
    for part in &measured.parts[previous.baseline_parts.len()..] {
        turn_delta_t = turn_delta_t.saturating_add(part.tokens);
        // A just-completed output is always in the newest recency reserve. Keeping it T-only
        // prevents a defer pass from inflating U before the next full bust walk.
        if part.kind != TailHygienePartKind::ToolOutput {
            turn_delta_u = turn_delta_u.saturating_add(part.u_tokens);
        }
    }
    TailHygieneBaseline {
        turn_delta_u,
        turn_delta_t,
        evaluable: true,
        generation_invalidated: false,
        content_signature: measured.content_signature,
        ..previous.clone()
    }
}

pub(crate) fn effective_tail_hygiene(baseline: &TailHygieneBaseline) -> (i64, i64) {
    let t = baseline
        .baseline_t
        .saturating_add(baseline.turn_delta_t)
        .max(0);
    let u = baseline
        .baseline_u
        .saturating_add(baseline.turn_delta_u)
        .clamp(0, t);
    (u, t)
}

pub(crate) fn hygiene_band(u: i64, t: i64) -> HygieneBand {
    let t = t.max(0);
    let u = u.clamp(0, t);
    if t < CHANNEL1_MIN_TOKENS || u < CHANNEL1_FLOOR_TOKENS {
        return HygieneBand::Quiet;
    }
    let severity = u as f64 / t.max(1) as f64;
    if u >= CHANNEL2_FLOOR_TOKENS && severity >= CHANNEL2_SEVERITY_THRESHOLD {
        HygieneBand::Channel2
    } else if severity >= 0.60 {
        HygieneBand::Urgent
    } else if severity >= 0.40 {
        HygieneBand::Firm
    } else if severity >= 0.20 {
        HygieneBand::Gentle
    } else {
        HygieneBand::Quiet
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ck_wire::{project_messages, CkIngressMessage};
    use mc_store::{
        CkKind, CkToolOutput, CkWireBlock, CkWireMessage, HarnessMeta, MediaBlock, MediaKind,
        ProviderExtras,
    };
    use serde::{Deserialize, Serialize};
    use serde_json::{json, Value};

    fn message(mid: &str, ordinal: u64, role: &str, blocks: Vec<CkKind>) -> CkIngressMessage {
        CkIngressMessage {
            mid: mid.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                role,
                blocks.into_iter().map(CkWireBlock::bare).collect(),
                None,
                ProviderExtras::new(),
                HarnessMeta::default(),
            ),
        }
    }

    fn text(mid: &str, ordinal: u64, value: &str) -> CkIngressMessage {
        message(
            mid,
            ordinal,
            "user",
            vec![CkKind::Text {
                text: value.to_string(),
            }],
        )
    }

    fn tag(number: i64, block_id: &str) -> McTagRow {
        McTagRow {
            tag_number: number,
            block_id: block_id.to_string(),
            kind: "message".to_string(),
            token_count: 0,
            created_at_ms: 0,
            source_bytes: Vec::new(),
        }
    }

    #[test]
    fn real_user_turn_count_ignores_interleaved_synthetic_user_rows() {
        let real = text("real", 1, "continue");
        let mut reminder = text(
            "reminder",
            2,
            "<system-reminder>board stale</system-reminder>",
        );
        reminder.ck.meta.synthetic = true;
        let mut channel2 = text("channel2", 3, "<system-reminder>reduce</system-reminder>");
        channel2.ck.meta.synthetic = true;
        let projection = project_messages(&[real, reminder, channel2]).unwrap();

        assert_eq!(real_user_turn_count(&projection), 1);
    }

    #[test]
    fn defer_delta_and_boundary_advance_are_additive() {
        let base = vec![
            text("old", 1, &"old mass ".repeat(2_000)),
            text("recent", 2, "recent"),
        ];
        let tags = vec![tag(1, "old#0"), tag(2, "recent#0")];
        let projection = project_messages(&base).unwrap();
        let measured = measure_tail_hygiene(
            &projection,
            &CoreState::default(),
            None,
            &tags,
            2,
            &HashSet::new(),
        );
        let baseline = refresh_tail_hygiene_baseline(measured, true, None, 10);
        assert_eq!(baseline.baseline_u, 0);

        let mut appended = base;
        appended.push(text("new", 3, &"new mass ".repeat(2_000)));
        let tags = vec![tag(1, "old#0"), tag(2, "recent#0"), tag(3, "new#0")];
        let projection = project_messages(&appended).unwrap();
        let measured = measure_tail_hygiene(
            &projection,
            &CoreState::default(),
            None,
            &tags,
            2,
            &HashSet::new(),
        );
        let defer = refresh_tail_hygiene_baseline(measured, false, Some(&baseline), 20);
        assert!(defer.evaluable);
        assert!(defer.turn_delta_t > 0);
        assert!(
            defer.turn_delta_u > 0,
            "old protected mass should advance into U"
        );
        assert_eq!(defer.baseline_generation, baseline.baseline_generation);
    }

    #[test]
    fn queued_drop_mass_uses_a_defer_delta_without_changing_t_or_the_frozen_baseline() {
        let messages = vec![
            text("queued", 1, &"mass ".repeat(25_000)),
            text("remaining", 2, &"mass ".repeat(45_000)),
            text("untagged", 3, &"mass ".repeat(30_000)),
        ];
        let tags = vec![tag(1, "queued#0"), tag(2, "remaining#0")];
        let projection = project_messages(&messages).unwrap();
        let initial = measure_tail_hygiene(
            &projection,
            &CoreState::default(),
            None,
            &tags,
            0,
            &HashSet::new(),
        );
        let baseline = refresh_tail_hygiene_baseline(initial.clone(), true, None, 10);
        let queued_targets = HashSet::from(["queued#0".to_string()]);
        let queued = measure_tail_hygiene_with_pending_drops(
            &projection,
            &CoreState::default(),
            None,
            &tags,
            0,
            &HashSet::new(),
            &queued_targets,
        );
        let queued_only = project_messages(&[messages[0].clone()]).unwrap();
        let queued_mass = measure_tail_hygiene(
            &queued_only,
            &CoreState::default(),
            None,
            &[tags[0].clone()],
            0,
            &HashSet::new(),
        )
        .u;
        let defer = refresh_tail_hygiene_baseline(queued.clone(), false, Some(&baseline), 20);

        assert_eq!(queued.t, initial.t);
        assert_eq!(queued.u, initial.u - queued_mass);
        assert!(defer.evaluable);
        assert_eq!(defer.baseline_u, baseline.baseline_u);
        assert_eq!(defer.baseline_t, baseline.baseline_t);
        assert_eq!(effective_tail_hygiene(&defer), (queued.u, queued.t));
        assert_eq!(hygiene_band(initial.u, initial.t), HygieneBand::Urgent);
        assert_eq!(hygiene_band(queued.u, queued.t), HygieneBand::Firm);
    }

    #[test]
    fn queued_tool_tag_excludes_the_full_call_and_result_arc_from_u() {
        let messages = vec![
            message(
                "owner",
                1,
                "assistant",
                vec![CkKind::ToolCall {
                    id: "queued-call".to_string(),
                    name: "read".to_string(),
                    input: json!({ "payload": "large queued input".repeat(200) }),
                    provider_executed: false,
                }],
            ),
            message(
                "result",
                2,
                "user",
                vec![CkKind::ToolResult {
                    id: "queued-call".to_string(),
                    tool_name: "read".to_string(),
                    output: CkToolOutput::bare(CkOutputKind::Text {
                        text: "large queued output ".repeat(2_000),
                    }),
                    provider_executed: false,
                }],
            ),
        ];
        let projection = project_messages(&messages).unwrap();
        let mut tool_tag = tag(7, "result#0");
        tool_tag.kind = "tool".to_string();
        let tags = vec![tool_tag];
        let initial = measure_tail_hygiene(
            &projection,
            &CoreState::default(),
            None,
            &tags,
            0,
            &HashSet::new(),
        );
        let queued = measure_tail_hygiene_with_pending_drops(
            &projection,
            &CoreState::default(),
            None,
            &tags,
            0,
            &HashSet::new(),
            &HashSet::from(["result#0".to_string()]),
        );

        assert!(initial.u > 0);
        assert_eq!(initial.u - queued.u, initial.u);
        assert_eq!(queued.u, 0);
        assert_eq!(queued.t, initial.t);
    }

    #[test]
    fn non_append_mutation_invalidates_until_a_bust() {
        let messages = vec![text("m", 1, "original")];
        let tags = vec![tag(1, "m#0")];
        let projection = project_messages(&messages).unwrap();
        let baseline = refresh_tail_hygiene_baseline(
            measure_tail_hygiene(
                &projection,
                &CoreState::default(),
                None,
                &tags,
                0,
                &HashSet::new(),
            ),
            true,
            None,
            10,
        );
        let projection = project_messages(&[text("m", 1, "changed")]).unwrap();
        let invalid = refresh_tail_hygiene_baseline(
            measure_tail_hygiene(
                &projection,
                &CoreState::default(),
                None,
                &tags,
                0,
                &HashSet::new(),
            ),
            false,
            Some(&baseline),
            20,
        );
        assert!(!invalid.evaluable);
        assert!(invalid.generation_invalidated);
    }

    #[derive(Debug, Deserialize)]
    struct HygieneGolden {
        schema: u32,
        provenance: HygieneGoldenProvenance,
        cases: Vec<HygieneGoldenCase>,
    }

    #[derive(Debug, Deserialize)]
    struct HygieneGoldenProvenance {
        generator_version: String,
        input_sha256: String,
    }

    #[derive(Debug, Deserialize)]
    struct HygieneGoldenCase {
        id: String,
        protected_tags: usize,
        messages: Vec<HygieneFixtureMessage>,
        tags: Vec<HygieneFixtureTag>,
        #[serde(default)]
        pending_drop_tag_numbers: Vec<i64>,
        expected: HygieneExpected,
    }

    fn is_false(value: &bool) -> bool {
        !*value
    }

    #[derive(Debug, Deserialize, Serialize)]
    struct HygieneFixtureMessage {
        mid: String,
        ordinal: u64,
        role: String,
        #[serde(default, skip_serializing_if = "is_false")]
        synthetic: bool,
        blocks: Vec<HygieneFixtureBlock>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    enum HygieneFixtureBlock {
        Text {
            unit: String,
            repeat: usize,
        },
        Reasoning {
            unit: String,
            repeat: usize,
        },
        ToolCall {
            id: String,
            name: String,
            input: Value,
        },
        ToolResult {
            id: String,
            name: String,
            unit: String,
            repeat: usize,
        },
        File {
            mime: String,
            url: String,
        },
    }

    #[derive(Debug, Deserialize, Serialize)]
    struct HygieneFixtureTag {
        tag_number: i64,
        block_id: String,
        kind: String,
    }

    #[derive(Debug, Deserialize)]
    struct HygieneExpected {
        u: i64,
        t: i64,
        band: String,
    }

    #[derive(Serialize)]
    struct HygieneFixtureInput<'a> {
        id: &'a str,
        protected_tags: usize,
        messages: &'a [HygieneFixtureMessage],
        tags: &'a [HygieneFixtureTag],
        #[serde(skip_serializing_if = "Option::is_none")]
        pending_drop_tag_numbers: Option<&'a [i64]>,
    }

    fn hygiene_fixture_canonical(cases: &[HygieneGoldenCase]) -> String {
        let input = cases
            .iter()
            .map(|case| HygieneFixtureInput {
                id: &case.id,
                protected_tags: case.protected_tags,
                messages: &case.messages,
                tags: &case.tags,
                pending_drop_tag_numbers: (!case.pending_drop_tag_numbers.is_empty())
                    .then_some(case.pending_drop_tag_numbers.as_slice()),
            })
            .collect::<Vec<_>>();
        format!(
            "{}\n",
            serde_json::to_string_pretty(&input).expect("serialize hygiene fixture inputs")
        )
    }

    fn hygiene_fixture_hash(cases: &[HygieneGoldenCase]) -> String {
        format!(
            "{:x}",
            Sha256::digest(hygiene_fixture_canonical(cases).as_bytes())
        )
    }

    fn fixture_message(input: &HygieneFixtureMessage) -> CkIngressMessage {
        let blocks = input
            .blocks
            .iter()
            .map(|block| match block {
                HygieneFixtureBlock::Text { unit, repeat } => CkKind::Text {
                    text: unit.repeat(*repeat),
                },
                HygieneFixtureBlock::Reasoning { unit, repeat } => CkKind::Reasoning {
                    text: unit.repeat(*repeat),
                    signature: Some("fixture-signature".to_string()),
                },
                HygieneFixtureBlock::ToolCall { id, name, input } => CkKind::ToolCall {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                    provider_executed: false,
                },
                HygieneFixtureBlock::ToolResult {
                    id,
                    name,
                    unit,
                    repeat,
                } => CkKind::ToolResult {
                    id: id.clone(),
                    tool_name: name.clone(),
                    output: CkToolOutput::bare(CkOutputKind::Text {
                        text: unit.repeat(*repeat),
                    }),
                    provider_executed: false,
                },
                HygieneFixtureBlock::File { mime, url } => CkKind::Media(MediaBlock {
                    kind: if mime.starts_with("image/") {
                        MediaKind::Image
                    } else {
                        MediaKind::File
                    },
                    media_type: mime.clone(),
                    filename: None,
                    source: Value::String(url.clone()),
                }),
            })
            .map(CkWireBlock::bare)
            .collect();
        CkIngressMessage {
            mid: input.mid.clone(),
            ordinal: input.ordinal,
            ck: CkWireMessage::from_parts(
                input.role.clone(),
                blocks,
                None,
                ProviderExtras::new(),
                HarnessMeta {
                    synthetic: input.synthetic,
                    ..HarnessMeta::default()
                },
            ),
        }
    }

    fn fixture_tag(input: &HygieneFixtureTag) -> McTagRow {
        McTagRow {
            tag_number: input.tag_number,
            block_id: input.block_id.clone(),
            kind: input.kind.clone(),
            token_count: 0,
            created_at_ms: 0,
            source_bytes: Vec::new(),
        }
    }

    #[test]
    fn parity_golden_matches_ts_reference_across_full_corpus() {
        let golden: HygieneGolden =
            serde_json::from_str(include_str!("../testdata/nudge-hygiene-golden.json"))
                .expect("parse nudge hygiene golden");
        assert_eq!(golden.schema, 1);
        assert_eq!(golden.provenance.generator_version, "nudge-hygiene-ts-v2");
        assert_eq!(
            hygiene_fixture_hash(&golden.cases),
            golden.provenance.input_sha256,
            "committed fixture inputs must match the TypeScript generator provenance"
        );
        assert!(golden.cases.len() >= 12);

        for case in &golden.cases {
            let messages = case
                .messages
                .iter()
                .map(fixture_message)
                .collect::<Vec<_>>();
            let tags = case.tags.iter().map(fixture_tag).collect::<Vec<_>>();
            let projection = project_messages(&messages).expect("project parity fixture");
            let pending_numbers = case
                .pending_drop_tag_numbers
                .iter()
                .copied()
                .collect::<HashSet<_>>();
            let pending_targets = tags
                .iter()
                .filter(|tag| pending_numbers.contains(&tag.tag_number))
                .map(|tag| tag.block_id.clone())
                .collect::<HashSet<_>>();
            let measured = measure_tail_hygiene_with_pending_drops(
                &projection,
                &CoreState::default(),
                None,
                &tags,
                case.protected_tags,
                &HashSet::new(),
                &pending_targets,
            );
            for (label, rust, ts) in [
                ("U", measured.u, case.expected.u),
                ("T", measured.t, case.expected.t),
            ] {
                let tolerance = 12.max((ts.unsigned_abs() as f64 * 0.03).ceil() as i64);
                assert!(
                    (rust - ts).abs() <= tolerance,
                    "{} {label} drifted outside tokenizer tolerance: Rust={rust}, TS={ts}, tolerance={tolerance}",
                    case.id
                );
            }
            if case.id == "queued-tool-arc-full-mass" {
                let unqueued = measure_tail_hygiene(
                    &projection,
                    &CoreState::default(),
                    None,
                    &tags,
                    case.protected_tags,
                    &HashSet::new(),
                );
                assert_eq!(
                    unqueued.u - measured.u,
                    unqueued.u,
                    "queueing the tool tag must remove the full attributed call/result mass",
                );
                assert_eq!(
                    measured.u, case.expected.u,
                    "Rust and TS queued U must agree"
                );
            }
            if case.id == "reasoning-excluded-both-terms" {
                let reasoning_tokens = case
                    .messages
                    .iter()
                    .flat_map(|message| &message.blocks)
                    .filter_map(|block| match block {
                        HygieneFixtureBlock::Reasoning { unit, repeat } => {
                            Some(estimated_tokens(&unit.repeat(*repeat)))
                        }
                        _ => None,
                    })
                    .sum::<i64>();
                let tolerance =
                    12.max((case.expected.t.unsigned_abs() as f64 * 0.03).ceil() as i64);
                assert!(
                    (measured.t + reasoning_tokens - case.expected.t).abs() > tolerance,
                    "Rust reasoning-arm counting mutant must redden its parity leg"
                );
            }
            assert_eq!(
                hygiene_band(measured.u, measured.t).as_str(),
                case.expected.band,
                "{} band drifted",
                case.id
            );
            assert!(measured.u <= measured.t, "{} violated U subset T", case.id);
        }
    }

    #[test]
    fn provenance_guard_rejects_mutated_fixture_input() {
        let golden: HygieneGolden =
            serde_json::from_str(include_str!("../testdata/nudge-hygiene-golden.json"))
                .expect("parse nudge hygiene golden");
        let canonical = hygiene_fixture_canonical(&golden.cases);
        let mutated = canonical.replacen(
            "live-incident-mixed-tail",
            "mutated-live-incident-mixed-tail",
            1,
        );
        assert_ne!(
            format!("{:x}", Sha256::digest(mutated.as_bytes())),
            golden.provenance.input_sha256
        );
    }

    #[test]
    fn reasoning_mutant_changes_neither_term_but_tagged_text_mutant_reddens() {
        let tags = vec![tag(1, "visible#0")];
        let base = vec![
            text("visible", 1, "kept text"),
            message(
                "thinking",
                2,
                "assistant",
                vec![CkKind::Reasoning {
                    text: "private".repeat(10_000),
                    signature: Some("signed".repeat(1_000)),
                }],
            ),
        ];
        let measured = measure_tail_hygiene(
            &project_messages(&base).unwrap(),
            &CoreState::default(),
            None,
            &tags,
            0,
            &HashSet::new(),
        );
        let mut reasoning_mutant = base.clone();
        reasoning_mutant[1].ck.content[0].kind = CkKind::Reasoning {
            text: "different private".repeat(20_000),
            signature: Some("different signature".repeat(2_000)),
        };
        let reasoning_measured = measure_tail_hygiene(
            &project_messages(&reasoning_mutant).unwrap(),
            &CoreState::default(),
            None,
            &tags,
            0,
            &HashSet::new(),
        );
        assert_eq!(
            (reasoning_measured.u, reasoning_measured.t),
            (measured.u, measured.t)
        );

        let text_mutant = vec![text("visible", 1, "kept text plus loud mutation")];
        let text_measured = measure_tail_hygiene(
            &project_messages(&text_mutant).unwrap(),
            &CoreState::default(),
            None,
            &tags,
            0,
            &HashSet::new(),
        );
        assert_ne!((text_measured.u, text_measured.t), (measured.u, measured.t));
    }

    #[test]
    fn consumed_protected_set_excludes_the_whole_exemplar_tool_arc_from_u() {
        let messages = vec![
            message(
                "owner",
                1,
                "assistant",
                vec![CkKind::ToolCall {
                    id: "exemplar-call".to_string(),
                    name: "read".to_string(),
                    input: json!({"path":"fixture"}),
                    provider_executed: false,
                }],
            ),
            message(
                "result",
                2,
                "tool",
                vec![CkKind::ToolResult {
                    id: "exemplar-call".to_string(),
                    tool_name: "read".to_string(),
                    output: CkToolOutput::bare(CkOutputKind::Text {
                        text: "large exemplar output".repeat(5_000),
                    }),
                    provider_executed: false,
                }],
            ),
        ];
        let projection = project_messages(&messages).unwrap();
        let tags = vec![tag(1, "result#0")];
        let measured = measure_tail_hygiene(
            &projection,
            &CoreState::default(),
            None,
            &tags,
            0,
            &HashSet::from(["owner#0".to_string()]),
        );
        assert_eq!(measured.u, 0);
        assert!(measured.t > 0);
    }

    #[test]
    fn recurring_raw_call_id_orphan_is_conservative_t_only() {
        let messages = vec![
            text("before", 1, "before"),
            message(
                "owner-a",
                2,
                "assistant",
                vec![CkKind::ToolCall {
                    id: "repeat".to_string(),
                    name: "read".to_string(),
                    input: json!({"path":"a"}),
                    provider_executed: false,
                }],
            ),
            message(
                "result-a",
                3,
                "tool",
                vec![CkKind::ToolResult {
                    id: "repeat".to_string(),
                    tool_name: "read".to_string(),
                    output: CkToolOutput::bare(CkOutputKind::Text {
                        text: "first".to_string(),
                    }),
                    provider_executed: false,
                }],
            ),
            message(
                "owner-b",
                4,
                "assistant",
                vec![CkKind::ToolCall {
                    id: "repeat".to_string(),
                    name: "read".to_string(),
                    input: json!({"path":"b"}),
                    provider_executed: false,
                }],
            ),
            message(
                "result-b",
                5,
                "tool",
                vec![CkKind::ToolResult {
                    id: "repeat".to_string(),
                    tool_name: "read".to_string(),
                    output: CkToolOutput::bare(CkOutputKind::Text {
                        text: "second".to_string(),
                    }),
                    provider_executed: false,
                }],
            ),
            text("after", 6, "after"),
        ];
        let projection = project_messages(&messages).unwrap();
        let tags = vec![tag(1, "before#0"), tag(2, "repeat"), tag(3, "after#0")];
        let measured = measure_tail_hygiene(
            &projection,
            &CoreState::default(),
            None,
            &tags,
            0,
            &HashSet::new(),
        );
        let tagged_text_tokens = estimated_tokens("before") + estimated_tokens("after");
        assert_eq!(measured.u, tagged_text_tokens);
        assert!(measured.t > measured.u);
    }
}
