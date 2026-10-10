//! Shared rendered-tail hygiene metric for the module's Channel-1 and Channel-2 nudges.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt::Write as _;

use mc_core::CoreState;
use mc_store::{
    CkOutputKind, McTagRow, MediaBlock, MediaKind, ResultBlockKind, TailHygieneBaseline,
    TailHygienePartKind, TailHygienePartMeasurement, TailHygieneTokenBuckets,
};
use sha2::{Digest, Sha256};

use crate::ck_wire::{FlatBlock, FlatProjection};
#[cfg(test)]
use crate::protection_window::CoordinateSpace;
use crate::protection_window::{TagNumber, TagNumberProjection};

pub(crate) const CHANNEL1_MIN_TOKENS: i64 = 60_000;
pub(crate) const CHANNEL1_FLOOR_TOKENS: i64 = 25_000;
pub(crate) const CHANNEL1_REFIRE_FLOOR_TOKENS: i64 = 25_000;
pub(crate) const CHANNEL2_FLOOR_TOKENS: i64 = 50_000;
pub(crate) const CHANNEL2_SEVERITY_THRESHOLD: f64 = 0.75;

#[derive(Debug, Clone, Copy)]
pub(crate) struct HygieneCalibration {
    pub(crate) units_version: u8,
    pub(crate) tools_ratio: f64,
    pub(crate) prose_ratio: f64,
}

impl Default for HygieneCalibration {
    fn default() -> Self {
        Self {
            units_version: 1,
            tools_ratio: 1.0,
            prose_ratio: 1.0,
        }
    }
}

const RED_KEY_PREFIX: &str = "red:";
const CAV_KEY_PREFIX: &str = "cav:";
const CHANNEL1_REMINDER_OPEN: &str = "\n\n<system-reminder>\n";
const CHANNEL1_REMINDER_CLOSE: &str = "\n</system-reminder>";

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

    pub(crate) const fn rank(self) -> u8 {
        match self {
            Self::Quiet => 0,
            Self::Gentle => 1,
            Self::Firm => 2,
            Self::Urgent => 3,
            Self::Channel2 => 4,
        }
    }

    pub(crate) fn from_channel1_level(value: &str) -> Self {
        match value {
            "gentle" => Self::Gentle,
            "firm" => Self::Firm,
            "urgent" => Self::Urgent,
            _ => Self::Quiet,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TailHygieneMeasurement {
    pub(crate) u: i64,
    pub(crate) t: i64,
    pub(crate) content_signature: String,
    pub(crate) parts: Vec<TailHygienePartMeasurement>,
    /// First index in `parts` that belongs to the newest message; the frozen prefix stops here.
    pub(crate) newest_message_part_start: usize,
}

/// First point where a defer pass stopped matching the frozen prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TailHygienePrefixMismatch {
    /// Index into the frozen prefix; when the measured tail is shorter, the first index it lacks.
    pub(crate) part_index: usize,
    /// Message the mismatching block belongs to, so a cause can be attributed to a message shape.
    pub(crate) message_id: String,
    pub(crate) field: &'static str,
    pub(crate) frozen_parts: usize,
    pub(crate) measured_parts: usize,
}

impl TailHygienePrefixMismatch {
    /// One line per invalidation event: where it happened, which field moved, and the response.
    pub(crate) fn diagnostic_line(&self, baseline_generation: u64) -> String {
        format!(
            "tail hygiene prefix invalidated: part_index={} message={} field={} frozen_parts={} measured_parts={} action=re-measured generation={}",
            self.part_index,
            if self.message_id.is_empty() {
                "unknown"
            } else {
                self.message_id.as_str()
            },
            self.field,
            self.frozen_parts,
            self.measured_parts,
            baseline_generation,
        )
    }
}

/// A refreshed baseline plus the mismatch that forced a re-measure, when there was one.
pub(crate) struct TailHygieneRefresh {
    pub(crate) baseline: TailHygieneBaseline,
    pub(crate) prefix_mismatch: Option<TailHygienePrefixMismatch>,
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
    crate::digest::hex(&Sha256::digest(bytes.as_ref()))
}

#[cfg(test)]
pub(crate) fn profile_part_hash_variants(session: &str, projection: &FlatProjection) {
    let mut samples = std::collections::BTreeMap::<&str, Vec<f64>>::new();
    for sample in 0..23 {
        let variants = if sample % 2 == 0 {
            ["concat_formatter", "stream_formatter", "stream_table"]
        } else {
            ["stream_table", "stream_formatter", "concat_formatter"]
        };
        for variant in variants {
            crate::per_pass_profile::begin_pass();
            profile_start!(perf_operation, "hash_variant");
            for block in &projection.blocks {
                // Mirror the production child-clock overhead in every variant.
                profile_start!(perf_hash, "variant_part");
                let hash = if variant == "concat_formatter" {
                    let mut input = String::with_capacity(9 + block.bytes.len());
                    input.push_str("excluded");
                    input.push('\0');
                    input.push_str(&block.bytes);
                    format!("{:x}", Sha256::digest(input.as_bytes()))
                } else {
                    let mut hash = Sha256::new();
                    hash.update(b"excluded");
                    hash.update([0]);
                    hash.update(block.bytes.as_bytes());
                    let digest = hash.finalize();
                    if variant == "stream_formatter" {
                        format!("{digest:x}")
                    } else {
                        crate::digest::hex(&digest)
                    }
                };
                std::hint::black_box(hash);
                profile_end!(perf_hash);
            }
            profile_end!(perf_operation);
            let costs = crate::per_pass_profile::end_pass();
            if sample >= 3 {
                samples
                    .entry(variant)
                    .or_default()
                    .push(costs["hash_variant"].thread_cpu_ms);
            }
        }
    }
    for (variant, mut samples) in samples {
        samples.sort_by(f64::total_cmp);
        println!(
            "COST_MICRO {}",
            serde_json::json!({"session":session,"finding":"RT-3",
            "shape":variant,"n":samples.len(),"parts":projection.blocks.len(),
            "thread_cpu_p50_ms":(samples[9]+samples[10])/2.0})
        );
    }
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

fn media_tokens(media: &MediaBlock, content: &str) -> i64 {
    match media.kind {
        MediaKind::Image => crate::image_tokens::estimate_image_tokens(content),
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
    profile_start!(perf_hash, "rt03_part_hash");
    let mut hash = Sha256::new();
    hash.update(kind_name.as_bytes());
    hash.update([0]);
    hash.update(content.as_bytes());
    let content_hash = crate::digest::hex(&hash.finalize());
    profile_end!(perf_hash);
    let active = tag_number.is_some() && !queued_for_drop;
    TailHygienePartMeasurement {
        key,
        content_hash,
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

#[cfg(test)]
thread_local! {
    /// Block-id and caveman-key lookups made by this thread, read by the scaling test.
    static ID_PROBES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Counts one id lookup for the scaling test; compiles to nothing outside tests.
#[inline(always)]
fn count_id_probe() {
    #[cfg(test)]
    ID_PROBES.with(|probes| probes.set(probes.get() + 1));
}

/// Build part attribution from exact block identities. Pre-composite legacy rows whose block id is
/// only a raw call id use the fallback only when one owner arc and its tag-number neighborhood are
/// unambiguous; recurring call ids otherwise remain T-only.
fn tag_numbers_by_block_and_arc(
    projection: &FlatProjection,
    tag_rows: &[McTagRow],
) -> (HashMap<String, i64>, HashMap<String, i64>) {
    // One borrowed index serves both membership and lookup. The first block with an id wins,
    // matching a front-to-back search when a projection repeats an id.
    let mut block_by_id = HashMap::<&str, &FlatBlock>::with_capacity(projection.blocks.len());
    for block in &projection.blocks {
        block_by_id.entry(block.id.as_str()).or_insert(block);
    }
    let message_indexes = projection_message_indexes(projection);
    let mut by_block = HashMap::new();
    let mut by_arc = HashMap::new();
    let mut bounds_by_message = HashMap::<usize, (i64, i64)>::new();

    for row in tag_rows {
        count_id_probe();
        let Some(block) = block_by_id.get(row.block_id.as_str()).copied() else {
            continue;
        };
        by_block.insert(row.block_id.clone(), row.tag_number);
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
        count_id_probe();
        !block_by_id.contains_key(row.block_id.as_str()) && call_ids.contains(row.block_id.as_str())
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

fn red_targets(core: &CoreState) -> HashSet<&str> {
    core.frozen_units
        .iter()
        .filter_map(|unit| unit.key.strip_prefix(RED_KEY_PREFIX))
        .collect()
}

/// Frozen caveman payloads keyed by the block id they rewrite. The first unit with a key wins,
/// matching a front-to-back search of the frozen units.
fn caveman_payloads(core: &CoreState) -> HashMap<&str, &str> {
    let mut payloads = HashMap::new();
    for unit in &core.frozen_units {
        if let Some(block_id) = unit.key.strip_prefix(CAV_KEY_PREFIX) {
            payloads
                .entry(block_id)
                .or_insert(unit.frozen_payload.as_str());
        }
    }
    payloads
}

fn caveman_content<'a>(payloads: &HashMap<&str, &'a str>, block: &FlatBlock) -> Option<&'a str> {
    count_id_probe();
    payloads.get(block.id.as_str()).copied()
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
    protected_numbers: &TagNumberProjection,
    protected_block_ids: &HashSet<String>,
    protected_arc_ids: &HashSet<&str>,
) -> bool {
    tag_number.is_some_and(|number| protected_numbers.tag_numbers.contains(&TagNumber(number)))
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
fn legacy_tag_number_projection(
    tag_rows: &[McTagRow],
    legacy_protected_count: usize,
) -> TagNumberProjection {
    let tag_numbers = tag_rows
        .iter()
        .map(|row| row.tag_number)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .rev()
        .take(legacy_protected_count)
        .map(TagNumber)
        .collect();
    TagNumberProjection {
        coordinate_space: CoordinateSpace::TagNumber,
        tag_numbers,
    }
}

#[cfg(test)]
pub(crate) fn measure_tail_hygiene(
    projection: &FlatProjection,
    core: &CoreState,
    coverage_ordinal: Option<u64>,
    tag_rows: &[McTagRow],
    legacy_protected_count: usize,
    protected_block_ids: &HashSet<String>,
) -> TailHygieneMeasurement {
    let projection_tag_numbers = legacy_tag_number_projection(tag_rows, legacy_protected_count);
    measure_tail_hygiene_with_pending_drops(
        projection,
        core,
        coverage_ordinal,
        tag_rows,
        &projection_tag_numbers,
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
    protected_tag_numbers: &TagNumberProjection,
    protected_block_ids: &HashSet<String>,
    pending_drop_target_ids: &HashSet<String>,
) -> TailHygieneMeasurement {
    profile_start!(perf_indexes, "hygiene_indexes");
    let (tags_by_block, tags_by_arc) = tag_numbers_by_block_and_arc(projection, tag_rows);
    let queued_numbers = queued_tag_numbers(tag_rows, pending_drop_target_ids);
    let protected_arc_ids = projection
        .blocks
        .iter()
        .filter(|block| protected_block_ids.contains(&block.id))
        .filter_map(|block| block.arc_id.as_deref())
        .collect::<HashSet<_>>();
    let red_targets = red_targets(core);
    let caveman_payloads = caveman_payloads(core);
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
            let mc_store::CkKind::ToolResult { output, .. } = &block.wire_shape().kind else {
                return None;
            };
            let text = block
                .scalar_text()
                .unwrap_or_else(|| std::borrow::Cow::Owned(tool_output_content(&output.kind)));
            if is_drop_sentinel(&text) {
                block.arc_id.as_deref()
            } else {
                None
            }
        })
        .collect::<HashSet<_>>();
    profile_end!(perf_indexes);

    profile_start!(perf_parts, "hygiene_parts");
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
            protected_tag_numbers,
            protected_block_ids,
            &protected_arc_ids,
        );
        let queued_for_drop = tag_number.is_some_and(|number| queued_numbers.contains(&number));
        let measured = match &block.wire_shape().kind {
            mc_store::CkKind::Text { .. } if block.role == "user" || block.role == "assistant" => {
                let text = block.scalar_text().expect("text payload");
                let content = caveman_content(&caveman_payloads, block).unwrap_or(&text);
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
                let raw_content = block
                    .scalar_text()
                    .unwrap_or_else(|| std::borrow::Cow::Owned(tool_output_content(&output.kind)));
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
    profile_end!(perf_parts);
    profile_start!(_perf_signature, "hygiene_signature");
    let mut signature_input = String::new();
    for part in &parts {
        let _ = write!(signature_input, "{}:{}\0", part.key, part.content_hash);
    }
    let t = t.max(0);
    // Blocks are measured one-to-one and in projection order, so the newest
    // message's blocks are the trailing run that shares the last block's mid.
    let mut newest_message_part_start = parts.len();
    if let Some(newest_mid) = projection.blocks.last().map(|block| block.mid.as_str()) {
        while newest_message_part_start > 0
            && projection.blocks[newest_message_part_start - 1].mid == newest_mid
        {
            newest_message_part_start -= 1;
        }
    }
    TailHygieneMeasurement {
        u: u.clamp(0, t),
        t,
        content_signature: hex_digest(signature_input),
        parts,
        newest_message_part_start,
    }
}

enum PrefixComparison {
    Valid {
        boundary_advance_u: i64,
        queued_drop_delta_u: i64,
    },
    Mismatch(TailHygienePrefixMismatch),
}

/// Message id of a measured block, recovered from its `{mid}#{index}\0{kind}` key.
fn message_id_from_part_key(key: &str) -> &str {
    let block_id = key.split('\0').next().unwrap_or(key);
    crate::ck_wire::split_block_id(block_id).map_or(block_id, |(mid, _)| mid)
}

/// Name the first field of a frozen part that a defer pass cannot explain, or None
/// when the part still matches. Protection release and queue membership are
/// explainable state moves; they are only a mismatch when the tag is no longer
/// active, because then the U they carry cannot be attributed.
pub(crate) fn compared_field(
    before: &TailHygienePartMeasurement,
    after: &TailHygienePartMeasurement,
) -> Option<&'static str> {
    if before.key != after.key {
        return Some("key");
    }
    if before.content_hash != after.content_hash {
        return Some("contentHash");
    }
    if before.kind != after.kind {
        return Some("kind");
    }
    if before.tokens != after.tokens {
        return Some("tokens");
    }
    if before.tag_number != after.tag_number {
        return Some("tagNumber");
    }
    if before.tag_status != after.tag_status {
        return Some("tagStatus");
    }
    if !before.protected && after.protected {
        return Some("protection-entered");
    }
    if before.protected && !after.protected {
        return (after.tag_status.as_deref() != Some("active"))
            .then_some("protection-exit-inactive");
    }
    if before.queued_for_drop != after.queued_for_drop {
        return (before.tag_status.as_deref() != Some("active")
            || after.tag_status.as_deref() != Some("active"))
        .then_some("queued-drop-inactive");
    }
    (before.u_tokens != after.u_tokens).then_some("uTokens")
}

fn same_measured_prefix(
    baseline: &[TailHygienePartMeasurement],
    current: &[TailHygienePartMeasurement],
) -> PrefixComparison {
    let mismatch = |part_index: usize, field: &'static str| {
        PrefixComparison::Mismatch(TailHygienePrefixMismatch {
            part_index,
            message_id: baseline
                .get(part_index)
                .map(|part| message_id_from_part_key(&part.key).to_string())
                .unwrap_or_default(),
            field,
            frozen_parts: baseline.len(),
            measured_parts: current.len(),
        })
    };
    if current.len() < baseline.len() {
        return mismatch(current.len(), "shorter");
    }
    let mut boundary_advance_u = 0i64;
    let mut queued_drop_delta_u = 0i64;
    for (index, (before, after)) in baseline.iter().zip(current).enumerate() {
        if let Some(field) = compared_field(before, after) {
            return mismatch(index, field);
        }
        if before.protected && !after.protected {
            boundary_advance_u = boundary_advance_u.saturating_add(after.u_tokens);
        } else if before.queued_for_drop != after.queued_for_drop {
            queued_drop_delta_u =
                queued_drop_delta_u.saturating_add(after.u_tokens.saturating_sub(before.u_tokens));
        }
    }
    PrefixComparison::Valid {
        boundary_advance_u,
        queued_drop_delta_u,
    }
}

/// Frozen prefix plus the delta the freezing pass itself carries.
struct FrozenMeasurement {
    baseline_u: i64,
    baseline_t: i64,
    turn_delta_u: i64,
    turn_delta_t: i64,
    baseline_parts: Vec<TailHygienePartMeasurement>,
}

/// Freeze a measurement into a baseline prefix plus this pass's delta.
///
/// The newest message is deliberately left out of the frozen prefix: while it is
/// newest its blocks are still in flight (text is still being appended, reasoning
/// is demoted once it stops being newest, new blocks keep arriving), so freezing
/// them guarantees a mismatch on the very next pass. Everything after the cut is
/// re-measured on every pass, so the reported totals are unchanged.
fn freeze_tail_hygiene_measurement(
    mut parts: Vec<TailHygienePartMeasurement>,
    newest_message_part_start: usize,
) -> FrozenMeasurement {
    let cut = newest_message_part_start.min(parts.len());
    let newest = parts.split_off(cut);
    let mut baseline_t = 0i64;
    let mut baseline_u = 0i64;
    for part in &parts {
        baseline_t = baseline_t.saturating_add(part.tokens.max(0));
        baseline_u = baseline_u.saturating_add(part.u_tokens.max(0));
    }
    let mut turn_delta_t = 0i64;
    let mut turn_delta_u = 0i64;
    for part in &newest {
        turn_delta_t = turn_delta_t.saturating_add(part.tokens);
        if part.kind != TailHygienePartKind::ToolOutput || !part.protected {
            turn_delta_u = turn_delta_u.saturating_add(part.u_tokens);
        }
    }
    let baseline_t = baseline_t.max(0);
    FrozenMeasurement {
        baseline_u: baseline_u.clamp(0, baseline_t),
        baseline_t,
        turn_delta_u,
        turn_delta_t,
        baseline_parts: parts,
    }
}

#[cfg(test)]
pub(crate) fn refresh_tail_hygiene_baseline(
    measured: TailHygieneMeasurement,
    cache_busting: bool,
    previous: Option<&TailHygieneBaseline>,
    now_ms: i64,
) -> TailHygieneRefresh {
    refresh_tail_hygiene_baseline_calibrated(
        measured,
        cache_busting,
        previous,
        now_ms,
        HygieneCalibration::default(),
    )
}

fn token_buckets(parts: &[TailHygienePartMeasurement]) -> TailHygieneTokenBuckets {
    let mut buckets = TailHygieneTokenBuckets::default();
    for part in parts {
        let (tail, reclaimable) = (part.tokens.max(0), part.u_tokens.max(0));
        match part.kind {
            TailHygienePartKind::ToolInput | TailHygienePartKind::ToolOutput => {
                buckets.tools_t = buckets.tools_t.saturating_add(tail);
                buckets.tools_u = buckets.tools_u.saturating_add(reclaimable);
            }
            TailHygienePartKind::Text | TailHygienePartKind::File => {
                buckets.prose_t = buckets.prose_t.saturating_add(tail);
                buckets.prose_u = buckets.prose_u.saturating_add(reclaimable);
            }
            TailHygienePartKind::Excluded => {}
        }
    }
    buckets
}

pub(crate) fn refresh_tail_hygiene_baseline_calibrated(
    measured: TailHygieneMeasurement,
    cache_busting: bool,
    previous: Option<&TailHygieneBaseline>,
    now_ms: i64,
    calibration: HygieneCalibration,
) -> TailHygieneRefresh {
    profile_start!(perf_buckets, "hygiene_refresh_buckets");
    let TailHygieneMeasurement {
        content_signature,
        parts,
        newest_message_part_start,
        ..
    } = measured;
    let calibration = if !cache_busting {
        previous.map_or(calibration, |baseline| HygieneCalibration {
            units_version: baseline.hygiene_units_version.max(1),
            tools_ratio: baseline.hygiene_tools_ratio,
            prose_ratio: baseline.hygiene_prose_ratio,
        })
    } else {
        calibration
    };
    let effective_token_buckets = token_buckets(&parts);
    profile_end!(perf_buckets);
    // A defer pass cannot attribute an unexplainable change to an append, and this
    // walk measures the rendered tail rather than producing wire bytes, so it
    // re-measures instead of holding the stale baseline until the next cache-busting
    // pass. Holding left the reclaim reminders unevaluable for as long as the session
    // went without a bust.
    profile_start!(perf_compare, "hygiene_refresh_compare");
    let comparison = match previous {
        Some(previous) if !cache_busting => {
            Some(same_measured_prefix(&previous.baseline_parts, &parts))
        }
        _ => None,
    };
    profile_end!(perf_compare);
    profile_start!(_perf_baseline, "hygiene_refresh_baseline");
    let (valid_delta, mismatch) = match comparison {
        Some(PrefixComparison::Valid {
            boundary_advance_u,
            queued_drop_delta_u,
        }) => (Some((boundary_advance_u, queued_drop_delta_u)), None),
        Some(PrefixComparison::Mismatch(mismatch)) => (None, Some(mismatch)),
        None => (None, None),
    };
    if let (Some(previous), Some((boundary_advance_u, queued_drop_delta_u))) =
        (previous, valid_delta)
    {
        let mut turn_delta_t = 0i64;
        // Queue membership is an action-state delta: it reduces the actionable token
        // backlog while the frozen baseline and still-rendered token total remain unchanged.
        let mut turn_delta_u = boundary_advance_u.saturating_add(queued_drop_delta_u);
        for part in &parts[previous.baseline_parts.len()..] {
            turn_delta_t = turn_delta_t.saturating_add(part.tokens);
            // Tool-output tokens are not reclaimable while their parts are protected. As new
            // outputs extend the measured tail, include outputs that have aged out of protection.
            if part.kind != TailHygienePartKind::ToolOutput || !part.protected {
                turn_delta_u = turn_delta_u.saturating_add(part.u_tokens);
            }
        }
        return TailHygieneRefresh {
            baseline: TailHygieneBaseline {
                turn_delta_u,
                turn_delta_t,
                hygiene_units_version: calibration.units_version,
                hygiene_tools_ratio: calibration.tools_ratio,
                hygiene_prose_ratio: calibration.prose_ratio,
                effective_token_buckets,
                evaluable: true,
                generation_invalidated: false,
                content_signature,
                ..previous.clone()
            },
            prefix_mismatch: None,
        };
    }
    let frozen = freeze_tail_hygiene_measurement(parts, newest_message_part_start);
    TailHygieneRefresh {
        baseline: TailHygieneBaseline {
            baseline_u: frozen.baseline_u,
            baseline_t: frozen.baseline_t,
            turn_delta_u: frozen.turn_delta_u,
            turn_delta_t: frozen.turn_delta_t,
            hygiene_units_version: calibration.units_version,
            hygiene_tools_ratio: calibration.tools_ratio,
            hygiene_prose_ratio: calibration.prose_ratio,
            effective_token_buckets,
            baseline_generation: previous
                .map_or(0, |baseline| baseline.baseline_generation)
                .saturating_add(1),
            computed_at_ms: now_ms,
            evaluable: true,
            generation_invalidated: false,
            baseline_parts: frozen.baseline_parts,
            protected_tools_policy: previous
                .and_then(|baseline| baseline.protected_tools_policy.clone()),
            content_signature,
            channel1_post_reduce_grace_baseline_u: previous
                .and_then(|baseline| baseline.channel1_post_reduce_grace_baseline_u),
            channel1_post_reduce_grace_pre_level: previous
                .map(|baseline| baseline.channel1_post_reduce_grace_pre_level.clone())
                .unwrap_or_default(),
        },
        prefix_mismatch: mismatch,
    }
}

pub(crate) fn effective_tail_hygiene(baseline: &TailHygieneBaseline) -> (i64, i64) {
    if baseline.hygiene_units_version >= 2 {
        let buckets = &baseline.effective_token_buckets;
        let calibrated = |tools: i64, prose: i64| -> i64 {
            let value = tools.max(0) as f64 * baseline.hygiene_tools_ratio
                + prose.max(0) as f64 * baseline.hygiene_prose_ratio;
            if value.is_finite() && value >= 0.0 {
                value.ceil().min(i64::MAX as f64) as i64
            } else {
                i64::MAX
            }
        };
        let t = calibrated(buckets.tools_t, buckets.prose_t);
        let u = calibrated(buckets.tools_u, buckets.prose_u).clamp(0, t);
        return (u, t);
    }
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

pub(crate) fn channel1_refire_tokens(tail_tokens: i64) -> i64 {
    let scaled = (0.08 * tail_tokens.max(0) as f64).round() as i64;
    CHANNEL1_REFIRE_FLOOR_TOKENS.max(scaled)
}

/// Grace holds until U regrows by one full cadence or the band worsens beyond
/// the band observed before ctx_reduce. Channel 2 remains a higher safety band.
pub(crate) fn post_reduce_grace_holds(
    baseline: &TailHygieneBaseline,
    reclaimable_tokens: i64,
    tail_tokens: i64,
    current_band: HygieneBand,
) -> bool {
    let Some(grace_u) = baseline.channel1_post_reduce_grace_baseline_u else {
        return false;
    };
    let pre_reduce_band =
        HygieneBand::from_channel1_level(&baseline.channel1_post_reduce_grace_pre_level);
    let regrowth = reclaimable_tokens.saturating_sub(grace_u.max(0));
    regrowth < channel1_refire_tokens(tail_tokens) && current_band.rank() <= pre_reduce_band.rank()
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

    #[test]
    fn streamed_part_hash_matches_concatenated_reference_for_every_kind() {
        for (kind, name) in [
            (TailHygienePartKind::Text, "text"),
            (TailHygienePartKind::ToolInput, "toolInput"),
            (TailHygienePartKind::ToolOutput, "toolOutput"),
            (TailHygienePartKind::File, "file"),
            (TailHygienePartKind::Excluded, "excluded"),
        ] {
            for content in ["", "\0", "\"\\\n\r", "é漢字🙂§17§", "[dropped §1§]"] {
                let reference = format!("{name}\0{content}");
                let expected = format!("{:x}", Sha256::digest(reference.as_bytes()));
                let actual =
                    part_measurement("key".into(), kind, content, 3, Some(1), false, false);
                assert_eq!(actual.content_hash, expected);
                assert_eq!(actual.tokens, 3);
                assert_eq!(actual.u_tokens, 3);
            }
        }
    }

    #[test]
    #[ignore = "release-only signature checkpoint prototype; no production cache"]
    fn signature_checkpoint_prototype_matches_full_hash() {
        if cfg!(debug_assertions) {
            panic!("run the prototype with --release");
        }
        let parts: Vec<_> = (0_u64..23_000)
            .map(|i| {
                (
                    format!("recorded-shape-{i}#0\0text"),
                    hex_digest(i.to_le_bytes()),
                )
            })
            .collect();
        // SHA-256 continuation preserves the existing ordered byte stream. A
        // tree/Merkle digest would not be a substitute for this content signature.
        let mut prefix = Sha256::new();
        let mut prefix_bytes = 0;
        for (key, hash) in &parts[..parts.len() - 1] {
            let bytes = format!("{key}:{hash}\0");
            prefix_bytes += bytes.len();
            prefix.update(bytes.as_bytes());
        }
        let mut full_costs = Vec::new();
        let mut checkpoint_costs = Vec::new();
        for pass in 0..23 {
            let hash = hex_digest(format!("streaming-{pass}"));
            crate::per_pass_profile::begin_pass();
            profile_start!(perf_full, "full_signature");
            let mut input = String::new();
            for (key, content_hash) in &parts[..parts.len() - 1] {
                let _ = write!(input, "{}:{}\0", key, content_hash);
            }
            let key = &parts.last().unwrap().0;
            let _ = write!(input, "{}:{}\0", key, hash);
            let full = hex_digest(input);
            profile_end!(perf_full);
            profile_start!(perf_checkpoint, "checkpoint_signature");
            let mut candidate = prefix.clone();
            candidate.update(format!("{key}:{hash}\0").as_bytes());
            let checkpoint = format!("{:x}", candidate.finalize());
            profile_end!(perf_checkpoint);
            let costs = crate::per_pass_profile::end_pass();
            assert_eq!(checkpoint, full, "signature bytes differ on pass {pass}");
            if pass >= 3 {
                full_costs.push(costs["full_signature"].thread_cpu_ms);
                checkpoint_costs.push(costs["checkpoint_signature"].thread_cpu_ms);
            }
        }
        let median = |mut costs: Vec<f64>| {
            costs.sort_by(f64::total_cmp);
            (costs[9] + costs[10]) / 2.0
        };
        println!(
            "SIGNATURE_PROTOTYPE {}",
            json!({"parts":parts.len(), "stable_prefix_bytes":prefix_bytes,
                "samples":20, "byte_comparisons":23,
                "checkpoint_bytes":std::mem::size_of::<Sha256>(),
                "full_cpu_p50_ms":median(full_costs),
                "checkpoint_cpu_p50_ms":median(checkpoint_costs)})
        );
    }

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
            source_bytes: Default::default(),
        }
    }

    /// Tag attribution as it was before the borrowed block index: membership came from an id
    /// set and every matching row searched the projection front to back. `comparisons` counts
    /// the id comparisons that search made. Kept only as the differential reference.
    fn scanning_tag_numbers_by_block_and_arc(
        projection: &FlatProjection,
        tag_rows: &[McTagRow],
        comparisons: &std::cell::Cell<u64>,
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
            let Some(block) = projection.blocks.iter().find(|block| {
                comparisons.set(comparisons.get() + 1);
                block.id == row.block_id
            }) else {
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

    /// The caveman lookup before frozen units were indexed: a front-to-back search per block.
    fn scanning_caveman_content<'a>(core: &'a CoreState, block: &FlatBlock) -> Option<&'a str> {
        let key = format!("{CAV_KEY_PREFIX}{}", block.id);
        core.frozen_units
            .iter()
            .find(|unit| unit.key == key)
            .map(|unit| unit.frozen_payload.as_str())
    }

    fn frozen(key: String, payload: &str) -> mc_core::FrozenUnit {
        mc_core::FrozenUnit {
            key,
            kind: "caveman".to_string(),
            frozen_payload: payload.to_string(),
            durability_class: mc_core::DurabilityClass::Lineage,
            reset_rule: String::new(),
        }
    }

    /// A tool-heavy tail of `arcs` call/result pairs plus a user text per arc, every block
    /// tagged. Also carries rows for blocks outside the projection, legacy rows keyed by a raw
    /// call id (unique and recurring), a call id shared by two arcs, and caveman units with a
    /// duplicate key, so the orphan and first-match rules are exercised.
    fn hygiene_scale_fixture(arcs: usize) -> (FlatProjection, Vec<McTagRow>, CoreState) {
        let mut messages = Vec::new();
        let mut tags = Vec::new();
        let mut core = CoreState::default();
        let mut number = 0i64;
        for n in 0..arcs {
            let ordinal = n as u64 * 3 + 1;
            // Every 97th arc reuses the previous arc's call id, as recurring provider ids do.
            let call_id = if n % 97 == 96 {
                format!("c{}", n - 1)
            } else {
                format!("c{n}")
            };
            messages.push(message(
                &format!("call{n}"),
                ordinal,
                "assistant",
                vec![CkKind::ToolCall {
                    id: call_id.clone(),
                    name: "read".to_string(),
                    input: json!({ "path": format!("f{n}") }),
                    provider_executed: false,
                }],
            ));
            messages.push(message(
                &format!("result{n}"),
                ordinal + 1,
                "user",
                vec![CkKind::ToolResult {
                    id: call_id.clone(),
                    tool_name: "read".to_string(),
                    output: CkToolOutput::bare(CkOutputKind::Text {
                        text: format!("out {n}"),
                    }),
                    provider_executed: false,
                }],
            ));
            messages.push(text(&format!("user{n}"), ordinal + 2, &format!("ask {n}")));
            if n % 13 == 5 {
                // Legacy rows name the raw call id instead of a block id.
                number += 1;
                tags.push(tag(number, &call_id));
            } else {
                for block in [format!("call{n}#0"), format!("result{n}#0")] {
                    number += 1;
                    tags.push(tag(number, &block));
                }
            }
            number += 1;
            tags.push(tag(number, &format!("user{n}#0")));
            if n % 7 == 0 {
                number += 1;
                tags.push(tag(number, &format!("gone{n}#0")));
            }
            if n % 5 == 0 {
                core.frozen_units
                    .push(frozen(format!("{CAV_KEY_PREFIX}user{n}#0"), "short"));
                if n % 10 == 0 {
                    core.frozen_units
                        .push(frozen(format!("{CAV_KEY_PREFIX}user{n}#0"), "second"));
                }
            }
        }
        (project_messages(&messages).unwrap(), tags, core)
    }

    /// The indexed attribution and caveman lookup must agree exactly with the front-to-back
    /// searches they replace, including legacy raw-call-id rows, recurring call ids, rows for
    /// absent blocks and duplicate caveman keys.
    #[test]
    fn indexed_hygiene_attribution_matches_scanning_reference() {
        for arcs in [1, 40, 300] {
            let (projection, tags, core) = hygiene_scale_fixture(arcs);
            let comparisons = std::cell::Cell::new(0);
            assert_eq!(
                tag_numbers_by_block_and_arc(&projection, &tags),
                scanning_tag_numbers_by_block_and_arc(&projection, &tags, &comparisons),
                "arcs={arcs}"
            );
            let payloads = caveman_payloads(&core);
            let mut caveman_hits = 0;
            for block in &projection.blocks {
                let indexed = caveman_content(&payloads, block);
                assert_eq!(indexed, scanning_caveman_content(&core, block));
                caveman_hits += usize::from(indexed.is_some());
            }
            assert_eq!(caveman_hits, arcs.div_ceil(5), "arcs={arcs}");
        }
        // The fixture must reach the legacy fallback for the comparison to cover it.
        let (projection, tags, _) = hygiene_scale_fixture(300);
        let (by_block, by_arc) = tag_numbers_by_block_and_arc(&projection, &tags);
        let legacy_numbers = tags
            .iter()
            .filter(|row| !row.block_id.contains('#'))
            .map(|row| row.tag_number)
            .collect::<HashSet<_>>();
        assert!(by_arc
            .values()
            .any(|number| legacy_numbers.contains(number)));
        assert!(!by_block.keys().any(|id| id.starts_with("gone")));
    }

    /// Scaling counter for the hygiene measurement: id lookups made by the full production
    /// measurement must grow linearly with tagged blocks, while the replaced front-to-back
    /// search grows quadratically. Counts, not wall clock, so the result is load-independent.
    #[test]
    #[ignore = "scaling benchmark; run with --ignored --nocapture"]
    fn hygiene_lookup_scaling_counts() {
        let mut per_block = Vec::new();
        for arcs in [334, 1_334, 5_334] {
            let (projection, tags, core) = hygiene_scale_fixture(arcs);
            let blocks = projection.blocks.len();
            let window = crate::protection_window::ProtectionWindow::from_persisted_rows(&tags, 0);
            ID_PROBES.with(|probes| probes.set(0));
            let measured = measure_tail_hygiene_with_pending_drops(
                &projection,
                &core,
                None,
                &tags,
                &window.tag_numbers,
                &HashSet::new(),
                &HashSet::new(),
            );
            let probes = ID_PROBES.with(std::cell::Cell::get);
            let comparisons = std::cell::Cell::new(0);
            scanning_tag_numbers_by_block_and_arc(&projection, &tags, &comparisons);
            eprintln!(
                "hygiene-scaling tagged_blocks={blocks} tag_rows={} indexed_probes={probes} scanning_comparisons={} t={}",
                tags.len(),
                comparisons.get(),
                measured.t
            );
            per_block.push((blocks, probes as f64 / blocks as f64));
        }
        // Linear: lookups per block stay flat (within 10%) from ~1k to ~16k blocks.
        let (_, first) = per_block[0];
        for (blocks, ratio) in &per_block {
            assert!(
                (*ratio - first).abs() <= first * 0.1,
                "{blocks} blocks: {ratio} probes per block vs {first}"
            );
        }
    }

    /// Refresh for assertions that only read the baseline, not the named mismatch.
    fn refreshed_baseline(
        measured: TailHygieneMeasurement,
        cache_busting: bool,
        previous: Option<&TailHygieneBaseline>,
        now_ms: i64,
    ) -> TailHygieneBaseline {
        refresh_tail_hygiene_baseline(measured, cache_busting, previous, now_ms).baseline
    }

    #[test]
    fn fable_tool_only_hygiene_calibrates_absolute_floors_before_band() {
        let baseline = TailHygieneBaseline {
            hygiene_units_version: 2,
            hygiene_tools_ratio: 1.551639,
            hygiene_prose_ratio: 1.571778,
            effective_token_buckets: TailHygieneTokenBuckets {
                tools_t: 40_000,
                tools_u: 20_000,
                ..Default::default()
            },
            ..Default::default()
        };
        let (u, t) = effective_tail_hygiene(&baseline);
        assert_eq!((u, t), (31_033, 62_066));
        assert_eq!(hygiene_band(u, t), HygieneBand::Firm);
    }

    #[test]
    fn token_window_excludes_call_and_result_mass_from_channel1_u() {
        let mut messages = Vec::new();
        let mut tags = Vec::new();
        for n in 1..=5 {
            messages.push(message(
                &format!("call{n}"),
                n * 20,
                "assistant",
                vec![CkKind::ToolCall {
                    id: format!("c{n}"),
                    name: "read".to_string(),
                    input: json!({"path": format!("file{n}")}),
                    provider_executed: false,
                }],
            ));
            messages.push(message(
                &format!("result{n}"),
                n * 20 + 1,
                "user",
                vec![CkKind::ToolResult {
                    id: format!("c{n}"),
                    tool_name: "read".to_string(),
                    output: CkToolOutput::bare(CkOutputKind::Text {
                        text: "mass ".repeat(1_000),
                    }),
                    provider_executed: false,
                }],
            ));
            tags.push(McTagRow {
                kind: "tool_result".to_string(),
                token_count: 4_000,
                ..tag(n as i64, &format!("result{n}#0"))
            });
        }
        let window = crate::protection_window::ProtectionWindow::from_persisted_rows(&tags, 16_000);
        let projection = project_messages(&messages).unwrap();
        let measured = measure_tail_hygiene_with_pending_drops(
            &projection,
            &CoreState::default(),
            None,
            &tags,
            &window.tag_numbers,
            &HashSet::new(),
            &HashSet::new(),
        );
        let all = measure_tail_hygiene(
            &projection,
            &CoreState::default(),
            None,
            &tags,
            0,
            &HashSet::new(),
        );
        let first = measure_tail_hygiene(
            &project_messages(&messages[..2]).unwrap(),
            &CoreState::default(),
            None,
            &tags[..1],
            0,
            &HashSet::new(),
        );
        assert!(first.u > 0);
        assert_eq!(measured.u, first.u);
        assert_eq!(measured.t, all.t);
        assert!(measured.u < all.u);
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
        let baseline = refreshed_baseline(measured, true, None, 10);
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
        let defer = refreshed_baseline(measured, false, Some(&baseline), 20);
        assert!(defer.evaluable);
        assert!(defer.turn_delta_t > 0);
        assert!(
            defer.turn_delta_u > 0,
            "old protected mass should advance into U"
        );
        assert_eq!(defer.baseline_generation, baseline.baseline_generation);
    }

    #[test]
    fn appended_tool_output_enters_defer_delta_after_protection_ages_out() {
        let base = vec![text("base", 1, "base text")];
        let base_tags = vec![tag(1, "base#0")];
        let protection = |numbers: &[i64]| TagNumberProjection {
            coordinate_space: CoordinateSpace::TagNumber,
            tag_numbers: numbers.iter().copied().map(TagNumber).collect(),
        };
        let empty = HashSet::new();
        let baseline_measurement = measure_tail_hygiene_with_pending_drops(
            &project_messages(&base).unwrap(),
            &CoreState::default(),
            None,
            &base_tags,
            &protection(&[1]),
            &empty,
            &empty,
        );
        let baseline = refreshed_baseline(baseline_measurement, true, None, 10);

        let reminder =
            "\n\n<system-reminder>\nHousekeeping backlog: spent tool outputs are reclaimable.\n</system-reminder>";
        let mut messages = base.clone();
        messages.push(message(
            "tool-delta",
            2,
            "assistant",
            vec![CkKind::ToolCall {
                id: "call-delta".to_string(),
                name: "read".to_string(),
                input: json!({"path": "new"}),
                provider_executed: false,
            }],
        ));
        messages.push(message(
            "tool-delta-result",
            3,
            "user",
            vec![CkKind::ToolResult {
                id: "call-delta".to_string(),
                tool_name: "read".to_string(),
                output: CkToolOutput::bare(CkOutputKind::Text {
                    text: format!("{}{}", "reclaimable tool output ".repeat(1_000), reminder),
                }),
                provider_executed: false,
            }],
        ));
        let tags = vec![
            base_tags[0].clone(),
            McTagRow {
                kind: "tool_result".to_string(),
                ..tag(2, "tool-delta-result#0")
            },
        ];
        let prefix_sha = hex_digest(serde_json::to_vec(&base).unwrap());
        let served_array_sha = hex_digest(serde_json::to_vec(&messages).unwrap());
        let projection = project_messages(&messages).unwrap();
        let protected_measurement = measure_tail_hygiene_with_pending_drops(
            &projection,
            &CoreState::default(),
            None,
            &tags,
            &protection(&[1, 2]),
            &empty,
            &empty,
        );
        let protected_defer = refreshed_baseline(protected_measurement, false, Some(&baseline), 20);
        let aged_measurement = measure_tail_hygiene_with_pending_drops(
            &projection,
            &CoreState::default(),
            None,
            &tags,
            &protection(&[1]),
            &empty,
            &empty,
        );
        let aged_defer =
            refreshed_baseline(aged_measurement.clone(), false, Some(&protected_defer), 30);

        assert_eq!(effective_tail_hygiene(&protected_defer).0, 0);
        assert_eq!(
            effective_tail_hygiene(&aged_defer),
            (aged_measurement.u, aged_measurement.t)
        );
        assert_eq!(hex_digest(serde_json::to_vec(&base).unwrap()), prefix_sha);
        assert_eq!(
            hex_digest(serde_json::to_vec(&messages).unwrap()),
            served_array_sha
        );
        assert!(!serde_json::to_string(&messages[0])
            .unwrap()
            .contains("Housekeeping backlog"));
        assert!(serde_json::to_string(messages.last().unwrap())
            .unwrap()
            .contains("Housekeeping backlog"));
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
        let baseline = refreshed_baseline(initial.clone(), true, None, 10);
        let queued_targets = HashSet::from(["queued#0".to_string()]);
        let queued = measure_tail_hygiene_with_pending_drops(
            &projection,
            &CoreState::default(),
            None,
            &tags,
            &legacy_tag_number_projection(&tags, 0),
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
        let defer = refreshed_baseline(queued.clone(), false, Some(&baseline), 20);

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
            &legacy_tag_number_projection(&tags, 0),
            &HashSet::new(),
            &HashSet::from(["result#0".to_string()]),
        );

        assert!(initial.u > 0);
        assert_eq!(initial.u - queued.u, initial.u);
        assert_eq!(queued.u, 0);
        assert_eq!(queued.t, initial.t);
    }

    #[test]
    fn non_append_mutation_is_named_and_re_measured_on_the_defer_pass() {
        // The newest message is never frozen, so the mutated message needs one after
        // it to land inside the frozen prefix that a defer pass compares.
        let messages = vec![text("m", 1, "original"), text("newest", 2, "newest turn")];
        let tags = vec![tag(1, "m#0")];
        let projection = project_messages(&messages).unwrap();
        let baseline = refreshed_baseline(
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
        let changed = vec![
            text("m", 1, "changed and then some"),
            text("newest", 2, "newest turn"),
        ];
        let projection = project_messages(&changed).unwrap();
        let measured = measure_tail_hygiene(
            &projection,
            &CoreState::default(),
            None,
            &tags,
            0,
            &HashSet::new(),
        );
        let re_measured =
            refresh_tail_hygiene_baseline(measured.clone(), false, Some(&baseline), 20);
        let mismatch = re_measured
            .prefix_mismatch
            .as_ref()
            .expect("an unattributable prefix change must be named");

        assert_eq!(mismatch.part_index, 0);
        assert_eq!(mismatch.message_id, "m");
        assert_eq!(mismatch.field, "contentHash");
        assert!(mismatch
            .diagnostic_line(re_measured.baseline.baseline_generation)
            .contains("message=m field=contentHash"));
        // The mismatch is reported and measured on this same pass instead of being
        // held until the next cache-busting pass.
        assert!(re_measured.baseline.evaluable);
        assert!(!re_measured.baseline.generation_invalidated);
        assert_eq!(
            re_measured.baseline.baseline_generation,
            baseline.baseline_generation + 1
        );
        assert_eq!(
            effective_tail_hygiene(&re_measured.baseline),
            (measured.u, measured.t)
        );

        // One invalidation event, one diagnostic: the next unchanged pass names none.
        let steady =
            refresh_tail_hygiene_baseline(measured, false, Some(&re_measured.baseline), 30);
        assert!(steady.prefix_mismatch.is_none());
        assert_eq!(
            steady.baseline.baseline_generation,
            re_measured.baseline.baseline_generation
        );
    }

    #[test]
    fn compaction_shrink_and_tag_loss_report_their_own_causes() {
        let messages = vec![
            text("first", 1, &"first mass ".repeat(200)),
            text("second", 2, &"second mass ".repeat(200)),
            text("newest", 3, "newest turn"),
        ];
        let tags = vec![tag(1, "first#0"), tag(2, "second#0")];
        let projection = project_messages(&messages).unwrap();
        let frozen = refreshed_baseline(
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

        // A coverage advance folds historical messages away, so the measured tail no
        // longer reaches the end of the frozen prefix.
        let shrunk = project_messages(&[text("newest", 3, "newest turn")]).unwrap();
        let shorter = refresh_tail_hygiene_baseline(
            measure_tail_hygiene(
                &shrunk,
                &CoreState::default(),
                None,
                &tags,
                0,
                &HashSet::new(),
            ),
            false,
            Some(&frozen),
            20,
        );
        // A tag row disappearing changes what an already-frozen block contributes.
        let untagged = refresh_tail_hygiene_baseline(
            measure_tail_hygiene(
                &projection,
                &CoreState::default(),
                None,
                &tags[1..],
                0,
                &HashSet::new(),
            ),
            false,
            Some(&frozen),
            20,
        );

        assert_eq!(
            shorter
                .prefix_mismatch
                .as_ref()
                .map(|mismatch| mismatch.field),
            Some("shorter")
        );
        assert_eq!(
            untagged
                .prefix_mismatch
                .as_ref()
                .map(|mismatch| (mismatch.field, mismatch.message_id.as_str())),
            Some(("tagNumber", "first"))
        );
        for refreshed in [&shorter, &untagged] {
            assert!(refreshed.baseline.evaluable);
            assert!(!refreshed.baseline.generation_invalidated);
            assert_eq!(
                refreshed.baseline.baseline_generation,
                frozen.baseline_generation + 1
            );
        }
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
        /// Inert migration sentinel retained by the cross-language fixture contract.
        protected_tags: usize,
        protected_tokens_effective: u64,
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
        token_count: i64,
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
        protected_tokens_effective: u64,
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
                protected_tokens_effective: case.protected_tokens_effective,
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
            token_count: input.token_count,
            created_at_ms: 0,
            source_bytes: Default::default(),
        }
    }

    #[test]
    fn parity_golden_matches_ts_reference_across_full_corpus() {
        let golden: HygieneGolden =
            serde_json::from_str(include_str!("../testdata/nudge-hygiene-golden.json"))
                .expect("parse nudge hygiene golden");
        assert_eq!(golden.schema, 2);
        assert_eq!(golden.provenance.generator_version, "nudge-hygiene-ts-v3");
        assert_eq!(
            hygiene_fixture_hash(&golden.cases),
            golden.provenance.input_sha256,
            "committed fixture inputs must match the TypeScript generator provenance"
        );
        assert!(golden.cases.len() >= 14);

        for case in &golden.cases {
            let messages = case
                .messages
                .iter()
                .map(fixture_message)
                .collect::<Vec<_>>();
            let tags = case.tags.iter().map(fixture_tag).collect::<Vec<_>>();
            // Rust independently walks its persisted rows with the same fixture floor; only
            // the resulting tag-number projection enters the hygiene instrument.
            let protection = crate::protection_window::ProtectionWindow::from_persisted_rows(
                &tags,
                case.protected_tokens_effective,
            );
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
                &protection.tag_numbers,
                &HashSet::new(),
                &pending_targets,
            );
            for (label, rust, ts) in [
                ("U", measured.u, case.expected.u),
                ("T", measured.t, case.expected.t),
            ] {
                assert_eq!(
                    rust, ts,
                    "{} {label} must match the TypeScript instrument exactly",
                    case.id
                );
            }
            if case.id == "queued-tool-arc-full-mass" {
                let unqueued = measure_tail_hygiene_with_pending_drops(
                    &projection,
                    &CoreState::default(),
                    None,
                    &tags,
                    &protection.tag_numbers,
                    &HashSet::new(),
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
            if case.id == "protected-recency-reserve" {
                assert!(protection.tag_numbers.tag_numbers.contains(&TagNumber(2)));
            }
            if case.id == "protected-token-window-spans-more-than-one-tag" {
                assert_eq!(
                    protection.tag_numbers.tag_numbers,
                    [TagNumber(1), TagNumber(2), TagNumber(3), TagNumber(4)]
                        .into_iter()
                        .collect()
                );
            }
            if case.id == "empty-protected-token-window" {
                assert_eq!(case.protected_tags, 99);
                assert!(protection.tag_numbers.tag_numbers.is_empty());
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
