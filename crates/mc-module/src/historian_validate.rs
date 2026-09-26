//! Historian output validation: parse the historian's compartment XML and
//! validate it against the raw chunk and already-persisted compartment ranges
//! before any side effect can publish it.
//!
//! The functions in this module are deliberately pure. They receive the raw
//! historian text plus caller-provided chunk/store metadata, and return either a
//! fully mapped publish plan or a validation error. That keeps persistence code
//! fail-closed: malformed ranges, stale chunks, bad message-id endpoints, and
//! boundary-healing decisions are resolved before any database write is possible.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::boundary::completed_tool_arc_crosses_boundary;

const BOUNDARY_HEALING_SLACK: u64 = 2;

/// A raw ordinal range, inclusive on both ends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageRange {
    pub start: u64,
    pub end: u64,
}

/// One formatted chunk line that can be mapped back to a provider message id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkLine {
    pub ordinal: u64,
    /// The real flat block id (`<mid>#<index>`) of the line's last block. This is empty
    /// only when the raw message has no flat blocks and therefore cannot anchor a
    /// compartment boundary.
    pub message_id: String,
    /// Whether `message_id` names a real flat block. A compartment must end on an
    /// anchorable block so publication cannot mint an impossible coverage boundary.
    #[serde(default = "chunk_line_anchorable_by_default")]
    pub anchorable: bool,
}

fn chunk_line_anchorable_by_default() -> bool {
    true
}

/// The raw-history slice that the historian was asked to summarize.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistorianChunk {
    pub start_index: u64,
    pub end_index: u64,
    pub lines: Vec<ChunkLine>,
    /// All non-synthetic input ordinals visible when this chunk was built, in
    /// provider order. Claude Code proxy submissions can permanently retire
    /// ordinals when message identities are re-minted, so validation filters
    /// this sparse set to the claimed range instead of assuming 0..n density.
    #[serde(default)]
    pub present_ordinals: Vec<u64>,
    /// Gaps fully inside one of these ranges are safe to heal at any size because
    /// the omitted raw lines were tool-only transcript noise rather than narrative.
    #[serde(default)]
    pub tool_only_ranges: Vec<MessageRange>,
    /// Completed invocation/result ranges whose terminal publication boundary must stay atomic.
    #[serde(default)]
    pub completed_tool_arcs: Vec<MessageRange>,
}

/// An already-persisted compartment range with the raw start and end ordinals
/// needed to validate store ordering before appending new compartments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredCompartmentRange {
    pub start_message: u64,
    pub end_message: u64,
}

/// Options that are known by the runner but are not present in the historian XML.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidateOptions {
    /// Sequence number to assign to the first emitted compartment in this publish.
    #[serde(default)]
    pub sequence_offset: u64,
    /// When true, emergency recovery favors fast raw-history reduction over the
    /// highest-quality final boundary for the newest compartment.
    #[serde(default)]
    pub in_emergency: bool,
    /// Memory promotion is disabled when the durable memory feature is off.
    #[serde(default = "default_true")]
    pub memory_enabled: bool,
    /// Facts are also gated by the explicit auto-promote switch.
    #[serde(default = "default_true")]
    pub auto_promote: bool,
    /// Privacy gate for historian user-behavior observations.
    #[serde(default)]
    pub user_memory_collection_enabled: bool,
    /// Explicit wrapup runs retain their final compartment instead of deleting it during cleanup.
    #[serde(default)]
    pub force_keep_last_compartment: bool,
}

fn default_true() -> bool {
    true
}

impl Default for ValidateOptions {
    fn default() -> Self {
        Self {
            sequence_offset: 0,
            in_emergency: false,
            memory_enabled: true,
            auto_promote: true,
            user_memory_collection_enabled: false,
            force_keep_last_compartment: false,
        }
    }
}

/// A parsed compartment before endpoint ids are resolved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedCompartment {
    pub start_message: u64,
    pub end_message: u64,
    pub title: String,
    /// In v2 compartments the main body is duplicated into `p1`; v1/legacy
    /// compartments store their body text only in this flat `content` field.
    pub content: String,
    #[serde(default)]
    pub p1: Option<String>,
    #[serde(default)]
    pub p2: Option<String>,
    #[serde(default)]
    pub p3: Option<String>,
    #[serde(default)]
    pub p4: Option<String>,
    #[serde(default)]
    pub importance: Option<u64>,
    #[serde(default)]
    pub episode_type: Option<String>,
}

/// A fact extracted from the `<facts>` block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FactCandidate {
    pub category: String,
    pub content: String,
    /// Optional forward-compatible anchor. Current TypeScript facts are
    /// unanchored; when absent and the last compartment is discarded during
    /// boundary healing, the fact is skipped because its source compartment
    /// cannot be proven.
    #[serde(default)]
    pub origin_compartment_index: Option<u64>,
}

/// A historian-extracted event. The event kind is the XML element name; fields
/// are child element text keyed by element name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedEvent {
    pub kind: String,
    #[serde(default)]
    pub at_compartment: Option<u64>,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
}

/// A durable standing-question candidate for later primer generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrimerCandidate {
    pub question: String,
    /// 1-based index into this historian output's emitted compartments.
    #[serde(default)]
    pub origin_compartment_index: Option<u64>,
}

/// Optional user-memory observation extracted from the chunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserObservationCandidate {
    pub content: String,
    /// Optional forward-compatible anchor. Current TypeScript observations are
    /// unanchored; when the last compartment is discarded during boundary
    /// healing, an unanchored observation is skipped because its source
    /// compartment cannot be proven.
    #[serde(default)]
    pub origin_compartment_index: Option<u64>,
}

/// Parsed XML-ish historian output, before validation mutates/heals ranges.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedCompartmentOutput {
    #[serde(default)]
    pub compartments: Vec<ParsedCompartment>,
    #[serde(default)]
    pub facts: Vec<FactCandidate>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub dropped_fact_blocks: usize,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub dropped_facts: usize,
    #[serde(default)]
    pub events: Vec<ParsedEvent>,
    #[serde(default)]
    pub unprocessed_from: Option<u64>,
    #[serde(default)]
    pub user_observations: Vec<UserObservationCandidate>,
    #[serde(default)]
    pub primer_candidates: Vec<PrimerCandidate>,
}

/// A compartment whose raw endpoints have been resolved to provider message ids.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidatedCompartment {
    pub sequence: u64,
    pub start_message: u64,
    pub end_message: u64,
    pub start_message_id: String,
    pub end_message_id: String,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub p1: Option<String>,
    #[serde(default)]
    pub p2: Option<String>,
    #[serde(default)]
    pub p3: Option<String>,
    #[serde(default)]
    pub p4: Option<String>,
    #[serde(default)]
    pub importance: Option<u64>,
    #[serde(default)]
    pub episode_type: Option<String>,
}

/// The side-effect-free publish plan produced by validation.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidatedChunk {
    pub compartments: Vec<ValidatedCompartment>,
    pub facts: Vec<FactCandidate>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub dropped_fact_blocks: usize,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub dropped_facts: usize,
    pub events: Vec<ParsedEvent>,
    pub primer_candidates: Vec<PrimerCandidate>,
    pub user_observations: Vec<UserObservationCandidate>,
    /// The next raw ordinal to read after the compartments that are safe to persist.
    pub unprocessed_from: u64,
    /// True when the provisional last compartment was intentionally withheld so it
    /// can be re-derived with real lookahead in the next run.
    pub discarded_last: bool,
}

/// Validation failures are plain, serializable messages because callers surface
/// them in repair prompts and telemetry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistorianValidationError {
    pub message: String,
}

impl std::fmt::Display for HistorianValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HistorianValidationError {}

fn validation_error(message: impl Into<String>) -> HistorianValidationError {
    HistorianValidationError {
        message: message.into(),
    }
}

/// Require one complete historian output envelope, then use the TypeScript host
/// parser's permissive extraction semantics for structures inside that root.
/// Malformed inner XML yields fewer usable structures for validation to assess.
pub fn parse_compartment_output(
    text: &str,
) -> Result<ParsedCompartmentOutput, HistorianValidationError> {
    let Some(root) = output_document_regex().captures(text) else {
        return Err(validation_error(
            "Historian output must be one complete <output> root document.",
        ));
    };
    let root_body = root
        .name("body")
        .map(|capture| capture.as_str())
        .unwrap_or_default();
    if output_tag_regex().is_match(root_body) {
        return Err(validation_error(
            "Historian output must contain exactly one <output> root document.",
        ));
    }

    let mut compartments = Vec::new();
    let mut facts = Vec::new();
    let mut dropped_fact_blocks = 0;
    let mut dropped_facts = 0;

    for caps in compartment_regex().captures_iter(text) {
        let attrs = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
        let inner = caps.get(2).map(|m| m.as_str()).unwrap_or_default();

        let start_message = match capture_u64(attr_start_regex(), attrs) {
            Some(v) => v,
            None => continue,
        };
        let end_message = match capture_u64(attr_end_regex(), attrs) {
            Some(v) => v,
            None => continue,
        };
        let title = match capture_string(attr_title_regex(), attrs) {
            Some(v) if !v.is_empty() => unescape_xml(&v),
            _ => continue,
        };
        if title.is_empty() {
            continue;
        }

        let episode_type = capture_string(attr_episode_regex(), attrs).map(|s| unescape_xml(&s));
        let importance = capture_u64(attr_importance_regex(), attrs);

        let p1 = extract_tier(inner, 0);
        if let Some(p1_value) = p1.filter(|s| !s.is_empty()) {
            let p2 = extract_tier(inner, 1);
            let p3 = extract_tier(inner, 2);
            let p4 = extract_tier(inner, 3);
            let p2_value = p2.clone().unwrap_or_else(|| p1_value.clone());
            let p3_value = p3
                .clone()
                .unwrap_or_else(|| p2.clone().unwrap_or_else(|| p1_value.clone()));
            let p4_value = p4.unwrap_or_default();
            compartments.push(ParsedCompartment {
                start_message,
                end_message,
                title,
                content: p1_value.clone(),
                p1: Some(p1_value),
                p2: Some(p2_value),
                p3: Some(p3_value),
                p4: Some(p4_value),
                importance,
                episode_type,
            });
            continue;
        }

        let content = unescape_xml(inner.trim());
        if !content.is_empty() {
            compartments.push(ParsedCompartment {
                start_message,
                end_message,
                title,
                content,
                p1: None,
                p2: None,
                p3: None,
                p4: None,
                importance,
                episode_type,
            });
        }
    }

    let facts_scope = if let Some(caps) = facts_block_regex().captures(text) {
        caps.get(1)
            .map(|m| m.as_str().to_string())
            .unwrap_or_default()
    } else {
        let without_events = events_block_regex().replace_all(text, "");
        let without_compartments = compartment_regex().replace_all(&without_events, "");
        let without_side_channels =
            facts_side_channel_regex().replace_all(&without_compartments, "");
        facts_envelope_regex()
            .replace_all(&without_side_channels, "")
            .to_string()
    };

    for category_caps in category_block_regex().captures_iter(&facts_scope) {
        let category = category_caps.get(1).map(|m| m.as_str()).unwrap_or_default();
        let closing = category_caps.get(3).map(|m| m.as_str()).unwrap_or_default();
        if category != closing {
            continue;
        }
        let block = category_caps.get(2).map(|m| m.as_str()).unwrap_or_default();
        if !HISTORIAN_CATEGORIES.contains(&category) {
            let count = fact_item_regex()
                .captures_iter(block)
                .filter(|caps| {
                    caps.get(1)
                        .is_some_and(|m| !unescape_xml(m.as_str().trim()).is_empty())
                })
                .count();
            if count == 0 {
                continue;
            }
            dropped_fact_blocks += 1;
            dropped_facts += count;
            tracing::warn!("{}", format_dropped_fact_category(category, count));
            continue;
        }
        for item_caps in fact_item_regex().captures_iter(block) {
            let raw = item_caps.get(1).map(|m| m.as_str()).unwrap_or_default();
            let unescaped = unescape_xml(raw.trim());
            let (origin_compartment_index, content) = split_anchor_prefix(&unescaped);
            if !content.is_empty() {
                facts.push(FactCandidate {
                    category: category.to_string(),
                    content,
                    origin_compartment_index,
                });
            }
        }
    }

    let unprocessed_from = capture_u64(unprocessed_regex(), text);

    let mut user_observations = Vec::new();
    if let Some(caps) = user_observations_regex().captures(text) {
        let block = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
        for item_caps in user_obs_item_regex().captures_iter(block) {
            let raw = item_caps.get(1).map(|m| m.as_str()).unwrap_or_default();
            let unescaped = unescape_xml(raw.trim());
            let (origin_compartment_index, content) = split_anchor_prefix(&unescaped);
            if !content.is_empty() {
                user_observations.push(UserObservationCandidate {
                    content,
                    origin_compartment_index,
                });
            }
        }
    }

    let mut primer_candidates = Vec::new();
    if let Some(caps) = primer_candidates_regex().captures(text) {
        let block = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
        let mut saw_element = false;
        for primer_caps in primer_element_regex().captures_iter(block) {
            saw_element = true;
            let question = primer_caps
                .get(2)
                .map(|m| unescape_xml(m.as_str().trim()))
                .unwrap_or_default();
            if !question.is_empty() {
                primer_candidates.push(PrimerCandidate {
                    question,
                    origin_compartment_index: primer_caps
                        .get(1)
                        .and_then(|m| m.as_str().parse::<u64>().ok()),
                });
            }
        }
        if !saw_element {
            for item_caps in primer_item_regex().captures_iter(block) {
                let question = item_caps
                    .get(1)
                    .map(|m| unescape_xml(m.as_str().trim()))
                    .unwrap_or_default();
                if !question.is_empty() {
                    primer_candidates.push(PrimerCandidate {
                        question,
                        origin_compartment_index: None,
                    });
                }
            }
        }
    }

    let events = parse_events(text);
    compartments.sort_by_key(|c| c.start_message);

    Ok(ParsedCompartmentOutput {
        compartments,
        facts,
        dropped_fact_blocks,
        dropped_facts,
        events,
        unprocessed_from,
        user_observations,
        primer_candidates,
    })
}

/// Parse, heal safe gaps, map endpoint ordinals to message ids, enforce coverage,
/// apply discard-last boundary healing, and return only data safe to persist.
pub fn validate_historian_output(
    text: &str,
    chunk: &HistorianChunk,
    prior_compartments: &[StoredCompartmentRange],
    options: ValidateOptions,
) -> Result<ValidatedChunk, HistorianValidationError> {
    let present_ordinals = chunk_present_ordinals(chunk);
    if let Some(error) = validate_chunk_coverage(chunk) {
        return Err(validation_error(format!(
            "Historian chunk coverage invalid: {error}"
        )));
    }

    if let Some(error) = validate_stored_compartments(prior_compartments) {
        return Err(validation_error(format!(
            "Existing compartments are invalid: {error}"
        )));
    }

    if let Some(last) = prior_compartments.last() {
        if chunk.start_index <= last.end_message {
            return Err(validation_error(format!(
                "Historian chunk starts at raw message {} but existing compartments end at {}; expected a strictly newer raw message",
                chunk.start_index, last.end_message
            )));
        }
        if let Some(expected_start) = next_present_after(&present_ordinals, last.end_message) {
            if chunk.start_index != expected_start {
                return Err(validation_error(format!(
                    "Historian chunk starts at raw message {} but existing compartments end at {}; expected next present raw message {}",
                    chunk.start_index, last.end_message, expected_start
                )));
            }
        }
    }

    let mut parsed = parse_compartment_output(text)?;
    if parsed.compartments.is_empty() {
        return Err(validation_error(
            "Historian returned no usable compartments.",
        ));
    }

    heal_compartment_gaps(
        &mut parsed.compartments,
        &chunk.tool_only_ranges,
        &present_ordinals,
    );
    heal_terminal_completed_tool_arc(
        &mut parsed.compartments,
        &mut parsed.unprocessed_from,
        &chunk.completed_tool_arcs,
        &present_ordinals,
        chunk.end_index,
    );

    let emitted =
        map_parsed_compartments_to_chunk(&parsed.compartments, chunk, options.sequence_offset)
            .map_err(|error| {
                validation_error(format!(
                    "Historian returned invalid compartment output: {error}"
                ))
            })?;

    if let Some(error) = validate_parsed_compartments(
        &parsed.compartments,
        chunk.start_index,
        chunk.end_index,
        &present_ordinals,
        parsed.unprocessed_from,
    ) {
        return Err(validation_error(format!(
            "Historian returned invalid compartment output: {error}"
        )));
    }
    if parsed.compartments.last().is_some_and(|compartment| {
        boundary_splits_completed_tool_arc(
            compartment.end_message.saturating_add(1),
            &chunk.completed_tool_arcs,
        )
    }) {
        return Err(validation_error(
            "Historian terminal boundary splits a completed tool invocation/result arc",
        ));
    }

    let mut compartments = emitted;
    let emitted_count = compartments.len();
    let mut discarded_last = false;
    if !options.in_emergency && !options.force_keep_last_compartment && compartments.len() >= 2 {
        let last_end = compartments
            .last()
            .map(|c| c.end_message)
            .unwrap_or(chunk.end_index);
        // TypeScript uses numeric ordinal distance here. Retired message numbers are
        // intentionally part of that distance, so a sparse coordinate gap still counts
        // as lookahead for boundary healing.
        let lookahead_distance = chunk.end_index.saturating_sub(last_end);
        let previous_end = compartments
            .get(compartments.len().saturating_sub(2))
            .map(|compartment| compartment.end_message);
        let pop_would_split_arc = previous_end.is_some_and(|end| {
            boundary_splits_completed_tool_arc(end.saturating_add(1), &chunk.completed_tool_arcs)
        });
        if lookahead_distance <= BOUNDARY_HEALING_SLACK && !pop_would_split_arc {
            compartments.pop();
            discarded_last = true;
        }
    }

    let offset = prior_compartments
        .last()
        .map(|c| c.end_message.saturating_add(1))
        .unwrap_or(chunk.start_index);
    let last_new_end = compartments.last().map(|c| c.end_message).unwrap_or(0);
    if last_new_end < offset {
        return Err(validation_error(format!(
            "no forward progress beyond raw message {}",
            offset.saturating_sub(1)
        )));
    }

    let persisted_count = compartments.len() as u64;
    let facts = parsed
        .facts
        .into_iter()
        .filter(|fact| {
            !options.force_keep_last_compartment
                && keep_side_channel(
                    fact.origin_compartment_index,
                    persisted_count,
                    discarded_last,
                )
        })
        .collect();
    // A discarded lookahead compartment invalidates the whole producer output's anchors.
    // Keeping any side channel here would make a later re-read double-store it. A forced final
    // wrapup chunk has the same weak lookahead for promotions, while retaining earlier anchored
    // events that do not point at the final compartment.
    let events = parsed
        .events
        .into_iter()
        .filter(|event| {
            if options.force_keep_last_compartment {
                matches!(event.at_compartment, Some(index) if (1..persisted_count).contains(&index))
            } else {
                keep_side_channel(event.at_compartment, persisted_count, discarded_last)
            }
        })
        .collect();
    let primer_candidates = parsed
        .primer_candidates
        .into_iter()
        .filter(|candidate| {
            !options.force_keep_last_compartment
                && keep_side_channel(
                    candidate.origin_compartment_index,
                    persisted_count,
                    discarded_last,
                )
        })
        .take(1)
        .collect();
    let user_observations = parsed
        .user_observations
        .into_iter()
        .filter(|observation| {
            !options.force_keep_last_compartment
                && keep_side_channel(
                    observation.origin_compartment_index,
                    persisted_count,
                    discarded_last,
                )
        })
        .collect();

    debug_assert!(compartments.len() <= emitted_count);

    Ok(ValidatedChunk {
        compartments,
        facts,
        dropped_fact_blocks: parsed.dropped_fact_blocks,
        dropped_facts: parsed.dropped_facts,
        events,
        primer_candidates,
        user_observations,
        // This value is a publication floor, not a promise that the next integer
        // ordinal exists. Consumer legs may retire ordinals permanently, so
        // downstream scans treat it as a lower bound and advance to the next
        // present input message.
        unprocessed_from: last_new_end.saturating_add(1),
        discarded_last,
    })
}

/// Validate already-persisted ranges before appending new output.
///
/// This store-pure check anchors at the first stored compartment: only the live-aware
/// fold can decide whether that first start matches the session's true first message.
pub fn validate_stored_compartments(compartments: &[StoredCompartmentRange]) -> Option<String> {
    let first = compartments.first()?;
    if first.end_message < first.start_message {
        return Some(format!(
            "invalid range {}-{}",
            first.start_message, first.end_message
        ));
    }

    let mut previous_end = first.end_message;
    for compartment in &compartments[1..] {
        if compartment.end_message < compartment.start_message {
            return Some(format!(
                "invalid range {}-{}",
                compartment.start_message, compartment.end_message
            ));
        }
        if compartment.start_message <= previous_end {
            return Some(format!(
                "overlap before message {} (saw {}-{})",
                previous_end.saturating_add(1),
                compartment.start_message,
                compartment.end_message
            ));
        }
        previous_end = compartment.end_message;
    }

    None
}

fn chunk_present_ordinals(chunk: &HistorianChunk) -> Vec<u64> {
    if !chunk.present_ordinals.is_empty() {
        return chunk.present_ordinals.clone();
    }
    chunk.lines.iter().map(|line| line.ordinal).collect()
}

fn validate_strictly_increasing_ordinals(ordinals: &[u64], label: &str) -> Option<String> {
    for pair in ordinals.windows(2) {
        let previous = pair[0];
        let current = pair[1];
        if current == previous {
            return Some(format!(
                "{label} contain duplicate raw message ordinal {current}"
            ));
        }
        if current < previous {
            return Some(format!(
                "{label} decrease from raw message {previous} to {current}"
            ));
        }
    }
    None
}

fn next_present_after(ordinals: &[u64], after: u64) -> Option<u64> {
    ordinals.iter().copied().find(|ordinal| *ordinal > after)
}

/// Ensure the chunk's ordinal lines cover exactly the present input ordinals in
/// the advertised raw range. Consumer legs can retire ordinal numbers permanently,
/// so a missing integer is valid when it is absent from the real input set.
pub fn validate_chunk_coverage(chunk: &HistorianChunk) -> Option<String> {
    if chunk.present_ordinals.is_empty() {
        return validate_dense_chunk_coverage(chunk);
    }
    validate_chunk_coverage_against(chunk, &chunk.present_ordinals)
}

fn validate_dense_chunk_coverage(chunk: &HistorianChunk) -> Option<String> {
    let line_ordinals: Vec<u64> = chunk.lines.iter().map(|line| line.ordinal).collect();
    if let Some(error) = validate_strictly_increasing_ordinals(&line_ordinals, "chunk lines") {
        return Some(error);
    }
    if chunk.lines.is_empty() {
        return None;
    }

    let mut expected_ordinal = chunk.start_index;
    for line in &chunk.lines {
        if line.ordinal != expected_ordinal {
            return Some(format!(
                "chunk omits raw message {expected_ordinal} while still claiming coverage through {}",
                chunk.end_index
            ));
        }
        expected_ordinal = expected_ordinal.saturating_add(1);
    }

    if expected_ordinal.saturating_sub(1) != chunk.end_index {
        return Some(format!(
            "chunk omits raw message {} while still claiming coverage through {}",
            expected_ordinal, chunk.end_index
        ));
    }

    None
}

fn validate_chunk_coverage_against(
    chunk: &HistorianChunk,
    present_ordinals: &[u64],
) -> Option<String> {
    if let Some(error) = validate_strictly_increasing_ordinals(present_ordinals, "input ordinals") {
        return Some(error);
    }

    let line_ordinals: Vec<u64> = chunk.lines.iter().map(|line| line.ordinal).collect();
    if let Some(error) = validate_strictly_increasing_ordinals(&line_ordinals, "chunk lines") {
        return Some(error);
    }

    if let Some(outside) = line_ordinals
        .iter()
        .find(|ordinal| **ordinal < chunk.start_index || **ordinal > chunk.end_index)
    {
        return Some(format!(
            "chunk line raw message {outside} is outside claimed coverage {}-{}",
            chunk.start_index, chunk.end_index
        ));
    }

    let expected: Vec<u64> = present_ordinals
        .iter()
        .copied()
        .filter(|ordinal| *ordinal >= chunk.start_index && *ordinal <= chunk.end_index)
        .collect();

    for (line, expected) in line_ordinals.iter().zip(expected.iter()) {
        if line == expected {
            continue;
        }
        if line > expected {
            return Some(format!(
                "chunk omits raw message {expected} while still claiming coverage through {}",
                chunk.end_index
            ));
        }
        return Some(format!(
            "chunk includes raw message {line} that is not present in input range {}-{}",
            chunk.start_index, chunk.end_index
        ));
    }

    if let Some(missing) = expected.get(line_ordinals.len()) {
        return Some(format!(
            "chunk omits raw message {missing} while still claiming coverage through {}",
            chunk.end_index
        ));
    }

    if let Some(extra) = line_ordinals.get(expected.len()) {
        return Some(format!(
            "chunk includes raw message {extra} that is not present in input range {}-{}",
            chunk.start_index, chunk.end_index
        ));
    }

    None
}

fn parse_events(text: &str) -> Vec<ParsedEvent> {
    let Some(block_caps) = events_block_regex().captures(text) else {
        return Vec::new();
    };
    let block = block_caps.get(1).map(|m| m.as_str()).unwrap_or_default();
    let mut events = Vec::new();

    // Rust's regex engine intentionally has no backreferences, while the TS parser
    // uses one to require `</kind>` to match the opening event element. Match only
    // event *open* tags here, then search for the corresponding literal close tag.
    // Event child fields do not carry `at_compartment`, so they cannot be mistaken
    // for event opens.
    for event_caps in event_open_regex().captures_iter(block) {
        let Some(full_match) = event_caps.get(0) else {
            continue;
        };
        let kind = event_caps.get(1).map(|m| m.as_str()).unwrap_or_default();
        let close_tag = format!("</{kind}>");
        let body_start = full_match.end();
        let Some(relative_body_end) = block[body_start..].find(&close_tag) else {
            continue;
        };
        let body = &block[body_start..body_start + relative_body_end];

        let mut fields = BTreeMap::new();
        for field_caps in event_field_regex().captures_iter(body) {
            let name = field_caps.get(1).map(|m| m.as_str()).unwrap_or_default();
            let closing = field_caps.get(3).map(|m| m.as_str()).unwrap_or_default();
            if name != closing {
                continue;
            }
            let value = field_caps
                .get(2)
                .map(|m| unescape_xml(m.as_str().trim()))
                .unwrap_or_default();
            if !value.is_empty() {
                fields.insert(name.to_string(), value);
            }
        }
        events.push(ParsedEvent {
            kind: kind.to_string(),
            at_compartment: event_caps
                .get(2)
                .and_then(|m| m.as_str().parse::<u64>().ok()),
            fields,
        });
    }
    events
}

fn boundary_splits_completed_tool_arc(boundary: u64, arcs: &[MessageRange]) -> bool {
    arcs.iter()
        .any(|arc| completed_tool_arc_crosses_boundary(arc.start, arc.end, boundary))
}

fn heal_terminal_completed_tool_arc(
    compartments: &mut [ParsedCompartment],
    unprocessed_from: &mut Option<u64>,
    arcs: &[MessageRange],
    present_ordinals: &[u64],
    chunk_end: u64,
) {
    let Some(last) = compartments.last_mut() else {
        return;
    };
    let original_end = last.end_message;
    for _ in 0..=arcs.len() {
        let boundary = last.end_message.saturating_add(1);
        let next_end = arcs
            .iter()
            .filter(|arc| {
                arc.end <= chunk_end
                    && completed_tool_arc_crosses_boundary(arc.start, arc.end, boundary)
            })
            .map(|arc| arc.end)
            .max()
            .unwrap_or(last.end_message);
        if next_end == last.end_message {
            break;
        }
        last.end_message = next_end;
    }
    if last.end_message != original_end {
        if let Some(unprocessed) = unprocessed_from.as_mut() {
            *unprocessed = next_present_after(present_ordinals, last.end_message)
                .unwrap_or_else(|| last.end_message.saturating_add(1));
        }
    }
}

fn heal_compartment_gaps(
    compartments: &mut [ParsedCompartment],
    tool_only_ranges: &[MessageRange],
    present_ordinals: &[u64],
) {
    for i in 1..compartments.len() {
        let gap_start = compartments[i - 1].end_message.saturating_add(1);
        let gap_end = compartments[i].start_message.saturating_sub(1);
        if gap_end < gap_start {
            continue;
        }
        let omitted_present: Vec<u64> = present_ordinals
            .iter()
            .copied()
            .filter(|ordinal| *ordinal >= gap_start && *ordinal <= gap_end)
            .collect();
        if omitted_present.is_empty() {
            continue;
        }
        let fully_inside_tool_only = omitted_present.iter().all(|ordinal| {
            tool_only_ranges
                .iter()
                .any(|range| range.start <= *ordinal && range.end >= *ordinal)
        });
        // Production replay showed contiguous narrative coverage. Tool-only noise is
        // therefore the sole safe gap to absorb; any narrative gap rejects before the
        // publish path can advance its durable boundary.
        if fully_inside_tool_only {
            compartments[i - 1].end_message = *omitted_present
                .last()
                .expect("non-empty omitted present ordinals checked above");
        }
    }
}

fn map_parsed_compartments_to_chunk(
    compartments: &[ParsedCompartment],
    chunk: &HistorianChunk,
    sequence_offset: u64,
) -> Result<Vec<ValidatedCompartment>, String> {
    let mut mapped = Vec::with_capacity(compartments.len());
    for (index, compartment) in compartments.iter().enumerate() {
        let start_line = chunk
            .lines
            .iter()
            .find(|line| line.ordinal == compartment.start_message);
        let end_line = chunk
            .lines
            .iter()
            .find(|line| line.ordinal == compartment.end_message);
        let (Some(start_line), Some(end_line)) = (start_line, end_line) else {
            return Err(format!(
                "Compartment range {}-{} does not map to raw session lines {}-{}",
                compartment.start_message,
                compartment.end_message,
                chunk.start_index,
                chunk.end_index
            ));
        };
        if !end_line.anchorable || end_line.message_id.is_empty() {
            return Err(format!(
                "Compartment ending at raw message {} cannot anchor a boundary because that message has no flat blocks",
                compartment.end_message
            ));
        }
        mapped.push(ValidatedCompartment {
            sequence: sequence_offset + index as u64,
            start_message: compartment.start_message,
            end_message: compartment.end_message,
            start_message_id: start_line.message_id.clone(),
            end_message_id: end_line.message_id.clone(),
            title: compartment.title.clone(),
            content: compartment.content.clone(),
            p1: compartment.p1.clone(),
            p2: compartment.p2.clone(),
            p3: compartment.p3.clone(),
            p4: compartment.p4.clone(),
            importance: compartment.importance,
            episode_type: compartment.episode_type.clone(),
        });
    }
    Ok(mapped)
}

fn validate_parsed_compartments(
    compartments: &[ParsedCompartment],
    chunk_start: u64,
    chunk_end: u64,
    present_ordinals: &[u64],
    unprocessed_from: Option<u64>,
) -> Option<String> {
    let chunk_ordinals: Vec<u64> = present_ordinals
        .iter()
        .copied()
        .filter(|ordinal| *ordinal >= chunk_start && *ordinal <= chunk_end)
        .collect();
    let mut expected_start = chunk_ordinals.first().copied();

    for (index, compartment) in compartments.iter().enumerate() {
        // P1 is the required v2 boundary. Missing P2-P4 deliberately keep the
        // parser's denser-tier fallbacks; only the flat v1 shape must retry.
        match compartment.p1.as_deref() {
            Some(p1) if !p1.trim().is_empty() => {}
            _ => {
                return Some(format!(
                    "compartment {} is missing the tiered paraphrase structure (p1..p4); re-emit with all four tiers",
                    index + 1
                ));
            }
        }
        if compartment.end_message < compartment.start_message {
            return Some(format!(
                "invalid range {}-{}",
                compartment.start_message, compartment.end_message
            ));
        }
        if compartment.start_message < chunk_start || compartment.end_message > chunk_end {
            return Some(format!(
                "range {}-{} is outside chunk {}-{}",
                compartment.start_message, compartment.end_message, chunk_start, chunk_end
            ));
        }
        if !chunk_ordinals.contains(&compartment.start_message) {
            return Some(format!(
                "range start {} is not a present raw message in chunk {}-{}",
                compartment.start_message, chunk_start, chunk_end
            ));
        }
        if !chunk_ordinals.contains(&compartment.end_message) {
            return Some(format!(
                "range end {} is not a present raw message in chunk {}-{}",
                compartment.end_message, chunk_start, chunk_end
            ));
        }
        let Some(expected) = expected_start else {
            return Some(format!(
                "range {}-{} starts after chunk coverage already ended",
                compartment.start_message, compartment.end_message
            ));
        };
        if compartment.start_message != expected {
            if compartment.start_message < expected {
                return Some(format!(
                    "overlap before message {expected} (saw {}-{})",
                    compartment.start_message, compartment.end_message
                ));
            }
            return Some(format!(
                "gap before present message {} (expected {expected})",
                compartment.start_message
            ));
        }
        expected_start = next_present_after(&chunk_ordinals, compartment.end_message);
    }

    if let Some(unprocessed_from) = unprocessed_from {
        if let Some(expected) = expected_start {
            if unprocessed_from != expected {
                return Some(format!(
                    "<unprocessed_from> {unprocessed_from} does not match next uncovered message {expected}"
                ));
            }
            return None;
        }
        if unprocessed_from == chunk_end.saturating_add(1) {
            return None;
        }
        if unprocessed_from < chunk_start || unprocessed_from > chunk_end {
            return Some(format!(
                "<unprocessed_from> {unprocessed_from} is outside chunk {chunk_start}-{chunk_end}"
            ));
        }
        return Some(format!(
            "<unprocessed_from> {unprocessed_from} does not match completed chunk boundary {}",
            chunk_end.saturating_add(1)
        ));
    }

    if let Some(expected) = expected_start {
        return Some(format!(
            "output left uncovered messages {expected}-{chunk_end} without <unprocessed_from>"
        ));
    }

    None
}

fn keep_side_channel(
    origin_compartment_index: Option<u64>,
    persisted_count: u64,
    discarded_last: bool,
) -> bool {
    if discarded_last {
        return false;
    }
    match origin_compartment_index {
        Some(index) => (1..=persisted_count).contains(&index),
        None => !discarded_last,
    }
}

fn capture_string(regex: &Regex, haystack: &str) -> Option<String> {
    regex
        .captures(haystack)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()))
}

fn capture_u64(regex: &Regex, haystack: &str) -> Option<u64> {
    regex
        .captures(haystack)
        .and_then(|caps| caps.get(1).and_then(|m| m.as_str().parse::<u64>().ok()))
}

fn extract_tier(inner: &str, index: usize) -> Option<String> {
    let open_match = tier_open_regexes()[index].captures(inner)?;
    let full = open_match.get(0)?;
    // Self-close form (<p4/> or <p4 />) → empty tier.
    if open_match.get(1).map(|m| m.as_str()) == Some("/") {
        return Some(String::new());
    }
    let rest = &inner[full.end()..];
    // Bound the body at the next closing tier tag (any digit). When there is no
    // close at all, run to the end of the compartment and let the guard below
    // trim at the next opener if one is present.
    let end = tier_close_any_regex()
        .find(rest)
        .map(|m| m.start())
        .unwrap_or(rest.len());
    let mut body = &rest[..end];
    // Over-capture guard: never swallow a subsequent tier's opening tag into
    // this tier's content. If an opener appears before the close, cut there.
    if let Some(open_inside) = tier_open_any_regex().find(body) {
        body = &body[..open_inside.start()];
    }
    Some(unescape_xml(body.trim()))
}

fn split_anchor_prefix(text: &str) -> (Option<u64>, String) {
    if let Some(caps) = side_channel_anchor_regex().captures(text) {
        let anchor = caps.get(1).and_then(|m| m.as_str().parse::<u64>().ok());
        let content = caps
            .get(2)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        return (anchor, content);
    }
    (None, text.trim().to_string())
}

fn unescape_xml(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn output_document_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?is)\A\s*<output(?:\s[^>]*)?>(?P<body>.*)</output\s*>\s*\z").unwrap()
    })
}

fn output_tag_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)</?output(?:\s[^>]*)?>").unwrap())
}

fn compartment_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?s)<compartment\s+([^>]*?)\s*>(.*?)</compartment>"#).unwrap())
}

fn attr_start_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\bstart="(\d+)""#).unwrap())
}

fn attr_end_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\bend="(\d+)""#).unwrap())
}

fn attr_title_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\btitle="([^"]*)""#).unwrap())
}

fn attr_episode_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\bepisode_type="([^"]*)""#).unwrap())
}

fn attr_importance_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\bimportance="(\d+)""#).unwrap())
}

/// Per-tier opener: matches `<p1>` / `<p1 >` (group 1 empty) or the self-close
/// `<p1/>` / `<p1 />` (group 1 = "/"). The body that follows an opener is
/// bounded procedurally in `extract_tier` rather than by an exact `</pN>` close,
/// because some models mismatch the closing digit (e.g. `<p1>…</p2>`).
fn tier_open_regexes() -> &'static [Regex; 4] {
    static RE: OnceLock<[Regex; 4]> = OnceLock::new();
    RE.get_or_init(|| {
        [
            Regex::new(r"<p1\s*(/?)>").unwrap(),
            Regex::new(r"<p2\s*(/?)>").unwrap(),
            Regex::new(r"<p3\s*(/?)>").unwrap(),
            Regex::new(r"<p4\s*(/?)>").unwrap(),
        ]
    })
}

/// Any tier's closing tag (`</p1>`…`</p9>`) — bounds an opened tier's body
/// regardless of whether the close digit matches the opener.
fn tier_close_any_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"</p\d").unwrap())
}

/// Any tier's OPENING tag (`<p1>`…`<p9>`) — the over-capture guard: a tier body
/// must never swallow a following tier's opener.
fn tier_open_any_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<p\d").unwrap())
}

fn facts_side_channel_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)<meta>.*?</meta>|<user_observations>.*?</user_observations>|<primer_candidates>.*?</primer_candidates>").unwrap())
}

fn facts_envelope_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"</?(?:output|compartments)>").unwrap())
}

fn facts_block_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?s)<facts>(.*?)</facts>"#).unwrap())
}

fn events_block_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?s)<events>(.*?)</events>"#).unwrap())
}

const HISTORIAN_CATEGORIES: &[&str] = &[
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
];

fn is_zero(value: &usize) -> bool {
    *value == 0
}

fn format_dropped_fact_category(category: &str, count: usize) -> String {
    format!("[historian] Dropped <facts> category {category} ({count} facts)")
}

fn category_block_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?s)<([A-Za-z_][A-Za-z0-9_-]*)>(.*?)</([A-Za-z_][A-Za-z0-9_-]*)>"#).unwrap()
    })
}

fn fact_item_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?m)^\s*\*\s*(.+)$"#).unwrap())
}

fn unprocessed_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"<unprocessed_from>(\d+)</unprocessed_from>"#).unwrap())
}

fn user_observations_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?s)<user_observations>(.*?)</user_observations>"#).unwrap())
}

fn user_obs_item_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?m)^\s*\*\s*(.+)$"#).unwrap())
}

fn primer_candidates_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?s)<primer_candidates>(.*?)</primer_candidates>"#).unwrap())
}

fn primer_element_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?s)<primer\s+at_compartment="(\d+)"\s*>(.*?)</primer>"#).unwrap()
    })
}

fn primer_item_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?m)^\s*(?:\*|-|\d+\.)\s*(.+)$"#).unwrap())
}

fn event_open_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"<([a-z_]+)\s+at_compartment="(\d+)"\s*>"#).unwrap())
}

fn event_field_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?s)<([a-z_]+)\s*>(.*?)</([a-z_]+)>"#).unwrap())
}

fn side_channel_anchor_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"^\s*[\[(]\s*(?:at_compartment|origin_compartment)\s*=\s*"?(\d+)"?\s*[\])]\s*(.+)$"#,
        )
        .unwrap()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_fact_categories_report_every_drop() {
        let parsed = parse_compartment_output("<output><facts><PROJECT_RULS>\n* One\n* Two\n</PROJECT_RULS><USER_DIRECTIVES>\n* Three\n</USER_DIRECTIVES><project-ruls>\n* Four\n</project-ruls></facts></output>").unwrap();
        assert!(parsed.facts.is_empty());
        assert_eq!(parsed.dropped_fact_blocks, 3);
        assert_eq!(parsed.dropped_facts, 4);
        assert_eq!(
            format_dropped_fact_category("PROJECT_RULS", 2),
            "[historian] Dropped <facts> category PROJECT_RULS (2 facts)"
        );
    }

    #[test]
    fn fallback_ignores_tags_without_fact_items() {
        let parsed = parse_compartment_output("<output><PROJECT_RULS>\n* One\n* Two\n</PROJECT_RULS><unprocessed_from>12</unprocessed_from></output>").unwrap();
        assert!(parsed.facts.is_empty());
        assert_eq!(parsed.unprocessed_from, Some(12));
        assert_eq!(parsed.dropped_fact_blocks, 1);
        assert_eq!(parsed.dropped_facts, 2);
    }

    #[derive(Debug, Deserialize)]
    struct GoldenInput {
        text: String,
        chunk: HistorianChunk,
        #[serde(default)]
        prior_compartments: Vec<StoredCompartmentRange>,
        #[serde(default)]
        options: ValidateOptions,
    }

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    struct GoldenVerdict {
        ok: bool,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        result: Option<ValidatedChunk>,
    }

    #[derive(Debug, Deserialize)]
    struct GoldenCase {
        label: String,
        input: GoldenInput,
        parsed: ParsedCompartmentOutput,
        validation: GoldenVerdict,
    }

    fn verdict(result: Result<ValidatedChunk, HistorianValidationError>) -> GoldenVerdict {
        match result {
            Ok(result) => GoldenVerdict {
                ok: true,
                error: None,
                result: Some(result),
            },
            Err(error) => GoldenVerdict {
                ok: false,
                error: Some(error.message),
                result: None,
            },
        }
    }

    fn chunk(start: u64, end: u64) -> HistorianChunk {
        HistorianChunk {
            start_index: start,
            end_index: end,
            lines: (start..=end)
                .map(|ordinal| ChunkLine {
                    ordinal,
                    message_id: format!("msg-{ordinal}"),
                    anchorable: true,
                })
                .collect(),
            present_ordinals: (start..=end).collect(),
            tool_only_ranges: Vec::new(),
            completed_tool_arcs: Vec::new(),
        }
    }

    fn xml(compartments: &[(u64, u64, &str)], unprocessed_from: u64, extra: &str) -> String {
        let body = compartments
            .iter()
            .map(|(start, end, title)| {
                format!(
                    r#"<compartment start="{start}" end="{end}" title="{title}" episode_type="feature" importance="50"><p1>{title} full</p1><p2>{title} short</p2><p3>{title}</p3><p4 /></compartment>"#
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "<output><compartments>{body}</compartments>{extra}<meta><unprocessed_from>{unprocessed_from}</unprocessed_from></meta></output>"
        )
    }

    #[test]
    fn validate_golden_matches_typescript_oracle() {
        let raw = include_str!("../testdata/validate-golden.json");
        let cases: Vec<GoldenCase> = serde_json::from_str(raw).expect("parse validate golden");
        assert!(!cases.is_empty(), "empty validate golden");

        for case in &cases {
            match parse_compartment_output(&case.input.text) {
                Ok(parsed) => assert_eq!(parsed, case.parsed, "parsed mismatch in {}", case.label),
                Err(error) => {
                    assert!(
                        !case.validation.ok && error.message.contains("<output> root document"),
                        "only malformed envelopes may diverge from the permissive TypeScript parser in {}",
                        case.label
                    );
                    continue;
                }
            }

            let got = verdict(validate_historian_output(
                &case.input.text,
                &case.input.chunk,
                &case.input.prior_compartments,
                case.input.options,
            ));
            assert_eq!(
                got, case.validation,
                "validation mismatch in {}",
                case.label
            );
        }
    }

    #[test]
    fn validation_is_deterministic() {
        let text = xml(&[(1, 2, "alpha"), (3, 4, "beta")], 5, "");
        let chunk = chunk(1, 7);
        let first = validate_historian_output(&text, &chunk, &[], ValidateOptions::default());
        let second = validate_historian_output(&text, &chunk, &[], ValidateOptions::default());
        assert_eq!(first, second);
    }

    #[test]
    fn five_message_narrative_gap_rejects_like_typescript_validator() {
        let text = xml(&[(1, 10, "first"), (16, 20, "second")], 21, "");
        let error = validate_historian_output(
            &text,
            &chunk(1, 20),
            &[],
            ValidateOptions {
                in_emergency: true,
                ..ValidateOptions::default()
            },
        )
        .expect_err("unclassified gaps may contain narrative and must reject");

        assert!(error.message.contains("gap"));
    }

    #[test]
    fn twenty_message_tool_only_gap_heals_like_typescript_validator() {
        let text = xml(&[(1, 10, "first"), (31, 40, "second")], 41, "");
        let mut input = chunk(1, 40);
        input.tool_only_ranges = vec![MessageRange { start: 11, end: 30 }];
        let validated = validate_historian_output(
            &text,
            &input,
            &[],
            ValidateOptions {
                in_emergency: true,
                ..ValidateOptions::default()
            },
        )
        .expect("a proven tool-only gap remains safe to absorb");

        assert_eq!(validated.compartments[0].end_message, 30);
        assert_eq!(validated.compartments[1].start_message, 31);
    }

    #[test]
    fn tierless_compartments_reject_while_p1_only_output_keeps_soft_fallbacks() {
        let flat = r#"<output><compartment start="1" end="2" title="flat">flat summary</compartment><meta><unprocessed_from>3</unprocessed_from></meta></output>"#;
        let error = validate_historian_output(flat, &chunk(1, 2), &[], ValidateOptions::default())
            .expect_err("flat v1 output must re-enter the producer retry chain");
        assert!(error.message.contains(
            "compartment 1 is missing the tiered paraphrase structure (p1..p4); re-emit with all four tiers"
        ));

        let p1_only = r#"<output><compartment start="1" end="2" title="partial"><p1>full summary</p1></compartment><meta><unprocessed_from>3</unprocessed_from></meta></output>"#;
        let validated =
            validate_historian_output(p1_only, &chunk(1, 2), &[], ValidateOptions::default())
                .expect("P1 is enough for the parser's deliberate soft-tier fallback");
        let compartment = &validated.compartments[0];
        assert_eq!(compartment.p1.as_deref(), Some("full summary"));
        assert_eq!(compartment.p2.as_deref(), Some("full summary"));
        assert_eq!(compartment.p3.as_deref(), Some("full summary"));
        assert_eq!(compartment.p4.as_deref(), Some(""));
    }

    #[test]
    fn mismatched_tier_close_parses_leniently_while_tierless_output_still_rejects() {
        // Exact observed shape from issue #246: deepseek-v4-flash-free closes
        // <p1> with </p2>. The lenient parser terminates the opened <p1> at the
        // NEXT closing tier tag (any digit) and the real <p2> still parses, so
        // validation passes (the legacy=0 tiered path) instead of retrying.
        let mangled = r#"<output><compartment start="1" end="2" title="mangled" importance="55"><p1>
full narrative
</p2>
<p2>condensed</p2><p3>outcome</p3><p4/></compartment><meta><unprocessed_from>3</unprocessed_from></meta></output>"#;
        let validated =
            validate_historian_output(mangled, &chunk(1, 2), &[], ValidateOptions::default())
                .expect("mismatched close must parse leniently into a tiered compartment");
        let compartment = &validated.compartments[0];
        assert_eq!(compartment.p1.as_deref(), Some("full narrative"));
        assert_eq!(compartment.content, "full narrative"); // mirrors P1
        assert_eq!(compartment.p2.as_deref(), Some("condensed"));
        assert_eq!(compartment.p3.as_deref(), Some("outcome"));
        assert_eq!(compartment.p4.as_deref(), Some(""));

        // Genuinely tier-free flat output still rejects into retry/fallback.
        let flat = r#"<output><compartment start="1" end="2" title="flat">flat summary</compartment><meta><unprocessed_from>3</unprocessed_from></meta></output>"#;
        let error = validate_historian_output(flat, &chunk(1, 2), &[], ValidateOptions::default())
            .expect_err("tier-free flat output must still reject");
        assert!(error
            .message
            .contains("missing the tiered paraphrase structure (p1..p4)"));
    }

    #[test]
    fn lenient_tier_extraction_bounds_bodies_and_guards_overcapture() {
        // Missing close entirely: an opened tier is bounded by the next opener.
        let missing_close = r#"<output><compartments><compartment start="1" end="2" title="x" importance="50"><p1>first body<p2>second body</p2><p3>third</p3><p4/></compartment></compartments></output>"#;
        let parsed = parse_compartment_output(missing_close).expect("parse missing-close");
        let compartment = &parsed.compartments[0];
        assert_eq!(compartment.p1.as_deref(), Some("first body"));
        assert_eq!(compartment.p2.as_deref(), Some("second body"));
        assert_eq!(compartment.p3.as_deref(), Some("third"));

        // Over-capture guard: a stray close past the next opener must not extend
        // the earlier tier's body across that opener.
        let overcapture = r#"<output><compartments><compartment start="1" end="2" title="x" importance="50"><p1>alpha<p2>beta</p1><p3>gamma</p3><p4/></compartment></compartments></output>"#;
        let parsed = parse_compartment_output(overcapture).expect("parse over-capture");
        let compartment = &parsed.compartments[0];
        assert_eq!(compartment.p1.as_deref(), Some("alpha"));
        assert_eq!(compartment.p2.as_deref(), Some("beta"));
    }

    #[test]
    fn stored_compartment_validation_is_basis_agnostic_and_allows_sparse_gaps() {
        assert_eq!(
            validate_stored_compartments(&[
                StoredCompartmentRange {
                    start_message: 0,
                    end_message: 4,
                },
                StoredCompartmentRange {
                    start_message: 5,
                    end_message: 8,
                },
            ]),
            None
        );

        assert_eq!(
            validate_stored_compartments(&[
                StoredCompartmentRange {
                    start_message: 5,
                    end_message: 7,
                },
                StoredCompartmentRange {
                    start_message: 9,
                    end_message: 10,
                },
            ]),
            None,
            "store-pure validation cannot distinguish retired ordinals from gaps",
        );

        let overlap = validate_stored_compartments(&[
            StoredCompartmentRange {
                start_message: 0,
                end_message: 4,
            },
            StoredCompartmentRange {
                start_message: 4,
                end_message: 6,
            },
        ])
        .expect("overlap rejected");
        assert!(overlap.contains("overlap before message 5"));
    }

    #[test]
    fn chunk_coverage_rejects_duplicate_and_decreasing_ordinals() {
        let duplicate = HistorianChunk {
            start_index: 1,
            end_index: 2,
            lines: vec![
                ChunkLine {
                    ordinal: 1,
                    message_id: "m1#0".into(),
                    anchorable: true,
                },
                ChunkLine {
                    ordinal: 1,
                    message_id: "m1-dup#0".into(),
                    anchorable: true,
                },
                ChunkLine {
                    ordinal: 2,
                    message_id: "m2#0".into(),
                    anchorable: true,
                },
            ],
            present_ordinals: vec![1, 1, 2],
            tool_only_ranges: Vec::new(),
            completed_tool_arcs: Vec::new(),
        };
        let duplicate_error = validate_chunk_coverage(&duplicate).expect("duplicate rejected");
        assert!(duplicate_error.contains("duplicate raw message ordinal 1"));

        let decreasing = HistorianChunk {
            start_index: 1,
            end_index: 3,
            lines: vec![
                ChunkLine {
                    ordinal: 1,
                    message_id: "m1#0".into(),
                    anchorable: true,
                },
                ChunkLine {
                    ordinal: 3,
                    message_id: "m3#0".into(),
                    anchorable: true,
                },
                ChunkLine {
                    ordinal: 2,
                    message_id: "m2#0".into(),
                    anchorable: true,
                },
            ],
            present_ordinals: vec![1, 2, 3],
            tool_only_ranges: Vec::new(),
            completed_tool_arcs: Vec::new(),
        };
        let decreasing_error = validate_chunk_coverage(&decreasing).expect("decrease rejected");
        assert!(decreasing_error.contains("chunk lines decrease from raw message 3 to 2"));
    }

    #[test]
    fn discard_last_progress_guard_boundary_k1_vs_k2() {
        let one = xml(&[(1, 4, "single")], 5, "");
        let two = xml(&[(1, 2, "first"), (3, 4, "second")], 5, "");
        let chunk = chunk(1, 4);

        let one_result = validate_historian_output(&one, &chunk, &[], ValidateOptions::default())
            .expect("single compartment remains publishable");
        let two_result = validate_historian_output(&two, &chunk, &[], ValidateOptions::default())
            .expect("two compartments keep progress after discard");

        assert!(!one_result.discarded_last, "k=1 must not discard");
        assert!(
            two_result.discarded_last,
            "k=2 may discard the provisional tail"
        );
        assert_eq!(two_result.compartments.len(), 1);
        assert_eq!(two_result.unprocessed_from, 3);
    }

    #[test]
    fn emergency_recovery_keeps_the_provisional_last_compartment() {
        let text = xml(&[(1, 2, "first"), (3, 4, "provisional")], 5, "");
        let validated = validate_historian_output(
            &text,
            &chunk(1, 4),
            &[],
            ValidateOptions {
                in_emergency: true,
                ..ValidateOptions::default()
            },
        )
        .expect("emergency output remains publishable");

        assert!(!validated.discarded_last);
        assert_eq!(validated.compartments.len(), 2);
        assert_eq!(validated.compartments[1].title, "provisional");
        assert_eq!(validated.unprocessed_from, 5);
    }

    #[test]
    fn parser_requires_one_complete_output_root() {
        let rootless = r#"<compartments><compartment start="1" end="1" title="t"><p1>x</p1></compartment></compartments><meta><unprocessed_from>2</unprocessed_from></meta>"#;
        let truncated = r#"<output><compartments><compartment start="1" end="1" title="t"><p1>x</p1></compartment></compartments>"#;
        let nested = format!("<output>{}</output>", xml(&[(1, 1, "nested")], 2, ""));

        for malformed in [rootless, truncated, nested.as_str()] {
            let error = parse_compartment_output(malformed).expect_err("invalid root rejected");
            assert!(error.message.contains("<output> root document"));
        }
    }

    #[test]
    fn compartment_end_must_be_anchorable() {
        let mut chunk = chunk(1, 2);
        chunk.lines[1].message_id.clear();
        chunk.lines[1].anchorable = false;
        let text = xml(&[(1, 2, "zero-block tail")], 3, "");

        let error = validate_historian_output(&text, &chunk, &[], ValidateOptions::default())
            .expect_err("a zero-block endpoint cannot publish");
        assert!(error.message.contains("cannot anchor a boundary"));

        chunk.lines[1].message_id = "m2#0".to_string();
        chunk.lines[1].anchorable = true;
        let validated = validate_historian_output(&text, &chunk, &[], ValidateOptions::default())
            .expect("a real flat-block endpoint remains publishable");
        assert_eq!(validated.compartments[0].end_message_id, "m2#0");
    }

    #[test]
    fn terminal_unprocessed_boundary_closes_a_completed_arc_forward() {
        // This fixture models a chunk spanning ordinals 98-128 with a completed tool arc at
        // 123-124. Its adapted bytes carry no provider verdict.
        let mut row_chunk = chunk(98, 128);
        row_chunk.completed_tool_arcs = vec![MessageRange {
            start: 123,
            end: 124,
        }];
        let text = xml(&[(98, 123, "covered prefix")], 124, "");

        let validated = validate_historian_output(
            &text,
            &row_chunk,
            &[],
            ValidateOptions {
                in_emergency: true,
                ..ValidateOptions::default()
            },
        )
        .expect("the terminal boundary should close the completed arc forward");

        assert_eq!(validated.compartments[0].end_message, 124);
        assert_eq!(validated.compartments[0].end_message_id, "msg-124");
        assert_eq!(validated.unprocessed_from, 125);
    }

    #[test]
    fn completed_arc_past_chunk_end_rejects_instead_of_publishing_half() {
        let mut short_chunk = chunk(1, 2);
        short_chunk.completed_tool_arcs = vec![MessageRange { start: 2, end: 3 }];
        let text = xml(&[(1, 2, "prefix")], 3, "");

        let error = validate_historian_output(
            &text,
            &short_chunk,
            &[],
            ValidateOptions {
                in_emergency: true,
                ..ValidateOptions::default()
            },
        )
        .expect_err("an unavailable result must keep the whole arc out of durable coverage");

        assert!(error.message.contains("terminal boundary splits"));
    }

    #[test]
    fn discard_last_cannot_reopen_a_completed_arc() {
        let mut row_chunk = chunk(98, 128);
        row_chunk.completed_tool_arcs = vec![MessageRange {
            start: 123,
            end: 124,
        }];
        let text = xml(&[(98, 123, "prefix"), (124, 128, "lookahead")], 129, "");

        let validated =
            validate_historian_output(&text, &row_chunk, &[], ValidateOptions::default())
                .expect("discard-last healing must preserve the whole completed arc");

        assert!(!validated.discarded_last);
        assert_eq!(validated.compartments.len(), 2);
        assert_eq!(validated.compartments.last().unwrap().end_message, 128);
    }

    #[test]
    fn discard_last_uses_numeric_sparse_ordinal_distance() {
        let sparse = HistorianChunk {
            start_index: 1,
            end_index: 100,
            lines: [1, 2, 100]
                .into_iter()
                .map(|ordinal| ChunkLine {
                    ordinal,
                    message_id: format!("m{ordinal}#0"),
                    anchorable: true,
                })
                .collect(),
            present_ordinals: vec![1, 2, 100],
            tool_only_ranges: Vec::new(),
            completed_tool_arcs: Vec::new(),
        };
        let text = xml(&[(1, 1, "first"), (2, 2, "provisional")], 100, "");

        let validated = validate_historian_output(&text, &sparse, &[], ValidateOptions::default())
            .expect("sparse chunk validates");
        assert!(!validated.discarded_last);
        assert_eq!(validated.compartments.len(), 2);
        assert_eq!(validated.unprocessed_from, 3);
    }

    #[test]
    fn zero_side_channel_anchor_is_suppressed() {
        let extra = r#"
<facts><PROJECT_RULES>
* [at_compartment=0] Drop the zero rule.
* [at_compartment=1] Keep the first rule.
</PROJECT_RULES></facts>
<events>
<causal_incident at_compartment="0"><summary>zero event</summary></causal_incident>
<trajectory_correction at_compartment="1"><summary>first event</summary></trajectory_correction>
</events>
<user_observations>
* [at_compartment=0] Drop the zero observation.
* [at_compartment=1] Keep the first observation.
</user_observations>
<primer_candidates>
<primer at_compartment="0">Drop the zero primer?</primer>
<primer at_compartment="1">Keep the first primer?</primer>
</primer_candidates>
"#;
        let text = xml(&[(1, 2, "only")], 3, extra);
        let validated =
            validate_historian_output(&text, &chunk(1, 2), &[], ValidateOptions::default())
                .expect("valid compartment publishes");

        assert_eq!(validated.facts.len(), 1);
        assert_eq!(validated.facts[0].content, "Keep the first rule.");
        assert_eq!(validated.events.len(), 1);
        assert_eq!(validated.events[0].kind, "trajectory_correction");
        assert_eq!(validated.user_observations.len(), 1);
        assert_eq!(
            validated.user_observations[0].content,
            "Keep the first observation."
        );
        assert_eq!(validated.primer_candidates.len(), 1);
        assert_eq!(
            validated.primer_candidates[0].question,
            "Keep the first primer?"
        );
    }

    #[test]
    fn discarded_last_suppresses_every_side_channel_for_the_whole_run() {
        let extra = r#"
<facts>
<PROJECT_RULES>
* [at_compartment=1] Keep the earlier rule.
* [at_compartment=2] Drop the provisional rule.
</PROJECT_RULES>
</facts>
<events>
<causal_incident at_compartment="1"><summary>kept event</summary></causal_incident>
<trajectory_correction at_compartment="2"><summary>dropped event</summary></trajectory_correction>
</events>
<user_observations>
* [at_compartment=1] Keep the earlier observation.
* [at_compartment=2] Drop the provisional observation.
</user_observations>
<primer_candidates>
<primer at_compartment="1">How does the kept subsystem work?</primer>
<primer at_compartment="2">How does the dropped subsystem work?</primer>
</primer_candidates>
"#;
        let text = xml(&[(1, 2, "first"), (3, 4, "second")], 5, extra);
        let result =
            validate_historian_output(&text, &chunk(1, 4), &[], ValidateOptions::default())
                .expect("discard-last should still make forward progress");

        assert!(result.discarded_last);
        assert!(result.facts.is_empty());
        assert!(result.events.is_empty());
        assert!(result.user_observations.is_empty());
        assert!(result.primer_candidates.is_empty());
    }

    #[test]
    fn force_keep_last_preserves_final_compartment_and_side_channels() {
        let extra = r#"
<events>
<trajectory_correction at_compartment="1"><summary>earlier event</summary></trajectory_correction>
<trajectory_correction at_compartment="2"><summary>final event</summary></trajectory_correction>
</events>
"#;
        let text = xml(&[(1, 2, "first"), (3, 4, "final")], 5, extra);
        let options = ValidateOptions {
            force_keep_last_compartment: true,
            ..ValidateOptions::default()
        };
        let result = validate_historian_output(&text, &chunk(1, 4), &[], options)
            .expect("force-keep wrapup output should validate");

        assert!(!result.discarded_last);
        assert_eq!(result.compartments.len(), 2);
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].at_compartment, Some(1));
    }
}
