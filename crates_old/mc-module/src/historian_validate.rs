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
    /// The printed `[A]`/`[A-B]` range of `<new_messages>` lines the fact cites,
    /// written as `messages=A-B` in its anchor prefix. Present only when the
    /// historian wrote that range; the TypeScript runners ask for it only on a turn
    /// one that requests anchored facts, and every production run is still
    /// unanchored. See [`resolve_fact_anchor`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_range: Option<FactSourceRange>,
}

/// An inclusive raw-ordinal range a fact anchor cites.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FactSourceRange {
    pub start: u64,
    pub end: u64,
}

/// A fact anchor resolved against the compartments of the same reply that are
/// published and the `[N]`/`[N-M]` lines the historian was sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedFactAnchor {
    /// 1-based position of the anchored compartment among the published ones.
    pub compartment_index: u64,
    /// Positions in the printed-line list of the lines that exactly tile the
    /// cited range, in order.
    pub block_indexes: Vec<usize>,
}

/// Resolve a fact's source anchor. Anything that does not resolve exactly is an
/// unknown anchor; nothing is guessed:
/// - the index must name a published compartment (a discarded tail does not count);
/// - the cited range must lie inside that compartment;
/// - the range must start at a printed line's start and end at a printed line's
///   end, so the printed lines inside it tile it exactly.
///
/// `compartments` and `printed_blocks` are inclusive `(start, end)` ordinal ranges
/// in order. The TypeScript publisher (`resolveTurnOneFactAnchor` in
/// packages/plugin/src/features/magic-context/memory/turn-one-publication.ts)
/// applies the same rules; both are pinned by
/// tests/fixtures/turn-one-anchor-goldens.json.
pub fn resolve_fact_anchor(
    fact: &FactCandidate,
    compartments: &[(u64, u64)],
    printed_blocks: &[(u64, u64)],
) -> Option<ResolvedFactAnchor> {
    let index = fact.origin_compartment_index?;
    let range = fact.source_range?;
    let slot = usize::try_from(index).ok()?.checked_sub(1)?;
    let &(compartment_start, compartment_end) = compartments.get(slot)?;
    if range.start > range.end || range.start < compartment_start || range.end > compartment_end {
        return None;
    }
    let block_indexes: Vec<usize> = printed_blocks
        .iter()
        .enumerate()
        .filter(|(_, &(start, end))| start >= range.start && end <= range.end)
        .map(|(position, _)| position)
        .collect();
    let first = printed_blocks.get(*block_indexes.first()?)?;
    let last = printed_blocks.get(*block_indexes.last()?)?;
    if first.0 != range.start || last.1 != range.end {
        return None;
    }
    Some(ResolvedFactAnchor {
        compartment_index: index,
        block_indexes,
    })
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
    // A compartment body may mention `<output>` as text; only tags outside the
    // compartment elements can open or close a second root.
    let root_elements = find_compartment_elements(root_body);
    if output_tag_regex().is_match(&text_outside_compartments(root_body, &root_elements)) {
        return Err(validation_error(
            "Historian output must contain exactly one <output> root document.",
        ));
    }

    let mut compartments = Vec::new();
    let mut facts = Vec::new();
    let mut dropped_fact_blocks = 0;
    let mut dropped_facts = 0;

    let elements = find_compartment_elements(text);
    for element in &elements {
        let attrs = element.attrs;
        let inner = element.inner;

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

        let mut tiers = extract_tiers(inner);
        if let Some(p1_value) = tiers.remove(&1).filter(|s| !s.is_empty()) {
            let p2 = tiers.remove(&2);
            let p3 = tiers.remove(&3);
            let p4 = tiers.remove(&4);
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

    // Every side channel is read outside the compartment elements, so a body
    // that mentions `<facts>` or `<events>` cannot be mistaken for the real block.
    let outside = text_outside_compartments(text, &elements);
    let facts_scope = if let Some(caps) = facts_block_regex().captures(&outside) {
        caps.get(1)
            .map(|m| m.as_str().to_string())
            .unwrap_or_default()
    } else {
        let without_events = events_block_regex().replace_all(&outside, "");
        let without_side_channels = facts_side_channel_regex().replace_all(&without_events, "");
        facts_envelope_regex()
            .replace_all(&without_side_channels, "")
            .to_string()
    };

    for (category, block) in paired_elements(&facts_scope, category_open_regex()) {
        if !HISTORIAN_CATEGORIES.contains(&category) {
            let count = fact_items(block).len();
            if count == 0 {
                continue;
            }
            dropped_fact_blocks += 1;
            dropped_facts += count;
            tracing::warn!("{}", format_dropped_fact_category(category, count));
            continue;
        }
        for item in fact_items(block) {
            let (origin_compartment_index, source_range, content) = split_fact_anchor_prefix(&item);
            if !content.is_empty() {
                facts.push(FactCandidate {
                    category: category.to_string(),
                    content,
                    origin_compartment_index,
                    source_range,
                });
            }
        }
    }

    let unprocessed_from = capture_u64(unprocessed_regex(), &outside);

    let mut user_observations = Vec::new();
    if let Some(caps) = user_observations_regex().captures(&outside) {
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
    if let Some(caps) = primer_candidates_regex().captures(&outside) {
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

    let mut events = parse_events(&outside);

    // Compartments are returned sorted by start, but `at_compartment` anchors
    // count compartments in the order the model emitted them. When the model
    // emits them out of order, re-point each in-range anchor at the same
    // compartment's sorted position, since every consumer indexes the sorted
    // list. Out-of-range anchors are left for validation to discard. Mirrors the
    // TypeScript parser; the Rust-only fact and observation anchors use the same
    // convention and are remapped too.
    let mut emitted_order: Vec<usize> = (0..compartments.len()).collect();
    emitted_order.sort_by_key(|&emitted| compartments[emitted].start_message);
    let mut sorted_position = vec![0_u64; compartments.len()];
    for (sorted, &emitted) in emitted_order.iter().enumerate() {
        sorted_position[emitted] = sorted as u64 + 1;
    }
    let remap_anchor = |anchor: &mut Option<u64>| {
        if let Some(index) = anchor.as_mut() {
            if let Some(&position) = usize::try_from(*index)
                .ok()
                .and_then(|index| index.checked_sub(1))
                .and_then(|slot| sorted_position.get(slot))
            {
                *index = position;
            }
        }
    };
    for event in &mut events {
        remap_anchor(&mut event.at_compartment);
    }
    for candidate in &mut primer_candidates {
        remap_anchor(&mut candidate.origin_compartment_index);
    }
    for fact in &mut facts {
        remap_anchor(&mut fact.origin_compartment_index);
    }
    for observation in &mut user_observations {
        remap_anchor(&mut observation.origin_compartment_index);
    }
    // Stable, so equal starts keep emission order exactly as `emitted_order` did.
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
    // A fact bound to a persisted compartment of this reply is kept. A fact anchored to
    // the discarded tail, to the weak final compartment of a forced keep, or past the
    // persisted compartments is dropped, and so is an unanchored fact of a reply with
    // either kind of weak tail: the next run re-derives those lines and may emit the
    // fact again.
    let weak_final_index = options
        .force_keep_last_compartment
        .then_some(emitted_count as u64);
    let facts = parsed
        .facts
        .into_iter()
        .filter(|fact| {
            keep_side_channel(
                fact.origin_compartment_index,
                persisted_count,
                discarded_last,
                weak_final_index,
            )
        })
        .collect();
    // Events, primer candidates and observations use a stricter rule than facts: a
    // discarded lookahead compartment invalidates every one of them, and a forced final
    // keep retains only events anchored before the final compartment.
    let events = parsed
        .events
        .into_iter()
        .filter(|event| {
            if options.force_keep_last_compartment {
                matches!(event.at_compartment, Some(index) if (1..persisted_count).contains(&index))
            } else {
                !discarded_last
                    && keep_side_channel(event.at_compartment, persisted_count, false, None)
            }
        })
        .collect();
    let primer_candidates = parsed
        .primer_candidates
        .into_iter()
        .filter(|candidate| {
            !options.force_keep_last_compartment
                && !discarded_last
                && keep_side_channel(
                    candidate.origin_compartment_index,
                    persisted_count,
                    false,
                    None,
                )
        })
        .take(1)
        .collect();
    let user_observations = parsed
        .user_observations
        .into_iter()
        .filter(|observation| {
            !options.force_keep_last_compartment
                && !discarded_last
                && keep_side_channel(
                    observation.origin_compartment_index,
                    persisted_count,
                    false,
                    None,
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
        for (name, raw_value) in paired_elements(body, event_field_open_regex()) {
            let value = unescape_xml(raw_value.trim());
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

/// Whether a side channel of a validated reply is published. A side channel
/// anchored to compartment `index` is kept when that compartment is one of the
/// `persisted_count` published ones and is not the weak final compartment of a
/// forced keep (`weak_final_index`); one anchored past them points at a discarded
/// tail. An unanchored side channel is kept only when the reply has no weak tail:
/// none was discarded (`discarded_last`) and no final compartment was kept without
/// lookahead. Mirrors `keepPublishedFact` in
/// packages/plugin/src/features/magic-context/memory/turn-one-publication.ts, and
/// both are pinned by the `keep` cases of tests/fixtures/turn-one-anchor-goldens.json.
pub fn keep_side_channel(
    origin_compartment_index: Option<u64>,
    persisted_count: u64,
    discarded_last: bool,
    weak_final_index: Option<u64>,
) -> bool {
    match origin_compartment_index {
        Some(index) => (1..=persisted_count).contains(&index) && Some(index) != weak_final_index,
        None => !discarded_last && weak_final_index.is_none(),
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

/// True when `inner` opens tier `digit` anywhere at or after `from`.
fn has_tier_opener_from(inner: &str, digit: u32, from: usize) -> bool {
    tier_open_regex()
        .captures_iter(&inner[from..])
        .any(|open| tier_digit(&open) == digit)
}

fn tier_digit(caps: &regex::Captures<'_>) -> u32 {
    caps.get(1)
        .and_then(|m| m.as_str().parse::<u32>().ok())
        .expect("tier regexes capture exactly one ASCII digit")
}

/// Find the close of tier `digit` whose body starts at `body_start`, when the
/// tier is properly closed: the first `</pN>` with the same digit that is
/// followed only by another tier tag or the end of the compartment. Tier tags
/// before that close are body text (a summary that talks about `<p2>` tags),
/// unless one of them opens a tier that is not found anywhere else: then it is
/// really the next tier after an unclosed one (`<p1>alpha<p2>beta</p1>`), and
/// `None` sends the caller to the lenient bounds. Mirrors the TypeScript
/// `findMatchingTierClose`.
fn find_matching_tier_close(
    inner: &str,
    body_start: usize,
    digit: u32,
    found: &BTreeMap<u32, String>,
) -> Option<(usize, usize)> {
    for close in tier_close_regex().captures_iter(&inner[body_start..]) {
        let whole = close.get(0)?;
        let (start, end) = (body_start + whole.start(), body_start + whole.end());
        if tier_digit(&close) != digit {
            continue;
        }
        if !tier_close_follower_regex().is_match(&inner[end..]) {
            continue;
        }
        let otherwise_missing = tier_open_regex()
            .captures_iter(&inner[body_start..start])
            .any(|open| {
                let other = tier_digit(&open);
                (1..=4).contains(&other)
                    && other != digit
                    && !found.contains_key(&other)
                    && !has_tier_opener_from(inner, other, end)
            });
        if otherwise_missing {
            return None;
        }
        return Some((start, end));
    }
    None
}

/// Extract the tier bodies from a compartment inner string, walking the tiers
/// in the order they appear. Each digit keeps its first occurrence; the map has
/// no entry for an absent tier and "" for a self-closed or empty one.
///
/// A properly closed tier keeps any tier tags written inside it as text (see
/// `find_matching_tier_close`). Otherwise the parser is lenient about the
/// close: an opened `<pN>` is terminated by the next closing tier tag of any
/// digit, because some models mismatch the close (`<p1>…</p2>`); if the close
/// is missing, the next opening tier tag or the end of the compartment bounds
/// the body. Mirrors the TypeScript `extractTiers`.
fn extract_tiers(inner: &str) -> BTreeMap<u32, String> {
    let mut tiers = BTreeMap::new();
    let mut pos = 0;
    while let Some(open) = tier_open_regex().captures_at(inner, pos) {
        let Some(whole) = open.get(0) else {
            break;
        };
        let digit = tier_digit(&open);
        let body_start = whole.end();
        let mut body_end = body_start;
        pos = body_start;
        // Self-close form (<p4/> or <p4 />) → empty tier.
        if open.get(2).map(|m| m.as_str()) != Some("/") {
            if let Some((close_start, close_end)) =
                find_matching_tier_close(inner, body_start, digit, &tiers)
            {
                body_end = close_start;
                pos = close_end;
            } else {
                // Lenient bounds: the next closing tier tag of any digit, or the
                // end of the compartment when there is none.
                let close_at = tier_close_any_regex()
                    .find_at(inner, body_start)
                    .map(|m| m.start());
                body_end = close_at.unwrap_or(inner.len());
                pos = close_at.map_or(inner.len(), |at| at + 1);
                // Over-capture guard: never swallow a subsequent tier's opening
                // tag into this tier's content. If an opener appears before the
                // close, cut there and resume the walk at that opener.
                if let Some(open_inside) =
                    tier_open_any_regex().find_at(&inner[..body_end], body_start)
                {
                    body_end = open_inside.start();
                    pos = body_end;
                }
            }
        }
        tiers
            .entry(digit)
            .or_insert_with(|| unescape_xml(inner[body_start..body_end].trim()));
    }
    tiers
}

/// One `<compartment …>…</compartment>` element; offsets index the parsed text.
struct CompartmentElement<'a> {
    start: usize,
    end: usize,
    attrs: &'a str,
    inner: &'a str,
}

/// Locate every compartment element in emission order. A compartment ends at
/// the first `</compartment>` before the next compartment's open tag that is
/// followed by output structure, so the closing tag written as text inside a
/// body does not end the compartment early. When no close qualifies, the first
/// `</compartment>` ends it, as a plain non-greedy match would. Mirrors the
/// TypeScript `findCompartmentElements`.
fn find_compartment_elements(text: &str) -> Vec<CompartmentElement<'_>> {
    const CLOSE_TAG: &str = "</compartment>";
    let find_close_from = |from: usize| text[from..].find(CLOSE_TAG).map(|at| from + at);
    let mut elements = Vec::new();
    let mut cursor = 0;
    while let Some(open) = compartment_open_regex().captures_at(text, cursor) {
        let Some(whole) = open.get(0) else {
            break;
        };
        let body_start = whole.end();
        let window_end = compartment_open_regex()
            .find_at(text, body_start)
            .map_or(text.len(), |next| next.start());
        let Some(first_close) = find_close_from(body_start) else {
            break;
        };
        let mut close_at = first_close;
        let mut candidate = Some(first_close);
        while let Some(at) = candidate.filter(|at| *at < window_end) {
            if compartment_close_follower_regex().is_match(&text[at + CLOSE_TAG.len()..]) {
                close_at = at;
                break;
            }
            candidate = find_close_from(at + 1);
        }
        let end = close_at + CLOSE_TAG.len();
        elements.push(CompartmentElement {
            start: whole.start(),
            end,
            attrs: open.get(1).map_or("", |m| m.as_str()),
            inner: &text[body_start..close_at],
        });
        cursor = end;
    }
    elements
}

/// The text with every compartment element removed; side channels are read
/// from it.
fn text_outside_compartments(text: &str, elements: &[CompartmentElement<'_>]) -> String {
    let mut outside = String::with_capacity(text.len());
    let mut last = 0;
    for element in elements {
        outside.push_str(&text[last..element.start]);
        last = element.end;
    }
    outside.push_str(&text[last..]);
    outside
}

/// Largest anchor index or ordinal accepted: JavaScript's `Number.MAX_SAFE_INTEGER`
/// (2^53 - 1), so this parser and the TypeScript one (`splitFactAnchorPrefix` in
/// packages/plugin/src/hooks/magic-context/compartment-parser.ts) accept the same
/// values. A larger value rejects the whole anchor.
const MAX_ANCHOR_ORDINAL: u64 = (1 << 53) - 1;

fn parse_anchor_ordinal(digits: &str) -> Option<u64> {
    digits
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= MAX_ANCHOR_ORDINAL)
}

/// Whitespace trimmed from fact text: Unicode White_Space without U+0085. U+0085
/// and U+FEFF stay ordinary text, as in `trimFactText` in
/// packages/plugin/src/hooks/magic-context/compartment-parser.ts.
fn is_fact_trim_char(character: char) -> bool {
    character.is_whitespace() && character != '\u{85}'
}

fn trim_fact_text(text: &str) -> &str {
    text.trim_matches(is_fact_trim_char)
}

/// The bullet items of a fact category block, XML-unescaped. A bullet is one
/// `\n`-terminated line (the `\r` of a CRLF ending is trimmed) that starts with `*`
/// after optional whitespace. U+2028, U+2029, U+0085 and a lone `\r` are ordinary
/// text inside a bullet, never a line end. Mirrors `factItems` in
/// packages/plugin/src/hooks/magic-context/compartment-parser.ts.
fn fact_items(block: &str) -> Vec<String> {
    block
        .split('\n')
        .filter_map(|line| {
            let body = line
                .trim_start_matches(is_fact_trim_char)
                .strip_prefix('*')?;
            let item = trim_fact_text(body);
            (!item.is_empty()).then(|| unescape_xml(item))
        })
        .collect()
}

fn split_anchor_prefix(text: &str) -> (Option<u64>, String) {
    let (anchor, _, content) = split_fact_anchor_prefix(text);
    (anchor, content)
}

/// Split a side-channel bullet's optional anchor prefix from its text:
/// `[at_compartment=N messages=A-B] text`, `[at_compartment=N] text`, or
/// `[at_compartment=unknown] text`. An unknown index, or an index or range past
/// 2^53, yields no anchor and no range. Mirrors `splitFactAnchorPrefix` in
/// packages/plugin/src/hooks/magic-context/compartment-parser.ts.
pub fn split_fact_anchor_prefix(text: &str) -> (Option<u64>, Option<FactSourceRange>, String) {
    let Some(caps) = side_channel_anchor_regex().captures(text) else {
        return (None, None, trim_fact_text(text).to_string());
    };
    let content = caps
        .get(4)
        .map(|m| trim_fact_text(m.as_str()).to_string())
        .unwrap_or_default();
    let Some(anchor) = caps.get(1).and_then(|m| parse_anchor_ordinal(m.as_str())) else {
        return (None, None, content);
    };
    let Some(start) = caps.get(2) else {
        return (Some(anchor), None, content);
    };
    let start = parse_anchor_ordinal(start.as_str());
    let end = match caps.get(3) {
        Some(m) => parse_anchor_ordinal(m.as_str()),
        None => start,
    };
    match (start, end) {
        (Some(start), Some(end)) => (Some(anchor), Some(FactSourceRange { start, end }), content),
        _ => (None, None, content),
    }
}

/// Decode the five predefined XML entities in a single left-to-right pass, so
/// every entity is decoded exactly once. Chained replacements that decode
/// `&amp;` first would turn the escaped literal `&amp;lt;` into `<` instead of
/// the text `&lt;`. Mirrors `unescapeXml` in packages/plugin/src/shared/xml-unescape.ts.
fn unescape_xml(s: &str) -> String {
    xml_entity_regex()
        .replace_all(s, |caps: &regex::Captures<'_>| {
            match caps.get(1).map(|m| m.as_str()) {
                Some("amp") => "&",
                Some("apos") => "'",
                Some("quot") => "\"",
                Some("lt") => "<",
                Some("gt") => ">",
                _ => unreachable!("xml_entity_regex only captures the five predefined entities"),
            }
        })
        .into_owned()
}

fn xml_entity_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"&(amp|apos|quot|lt|gt);").unwrap())
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

/// Compartment open tag; group 1 = the attribute string. Matches the TypeScript
/// `COMPARTMENT_OPEN_REGEX`: quoted attribute values are consumed whole, so a raw
/// `>` inside one (a title like "Migrate store -> SQLite") does not end the open
/// tag. A value may not span a line, so a stray unbalanced quote cannot swallow
/// the body.
fn compartment_open_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"<compartment\s+((?:[^>"]|"[^"\n]*")*?)\s*>"#).unwrap())
}

/// What may follow a compartment's real closing tag: the next compartment, the
/// end of the compartment list or document, or one of the output's own blocks.
/// A `</compartment>` written as text inside a body is followed by more prose.
fn compartment_close_follower_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\A\s*(?:\z|<(?:compartment\s|/compartments\s*>|/output\s*>|(?:facts|events|meta|user_observations|primer_candidates|unprocessed_from)\s*>))").unwrap()
    })
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

/// Tier opener: matches `<p1>` / `<p1 >` (group 2 empty) or the self-close
/// `<p4/>` / `<p4 />` (group 2 = "/"). Group 1 = tier digit. Digits are ASCII
/// (`[0-9]`) to match JavaScript's `\d`.
fn tier_open_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<p([0-9])\s*(/?)>").unwrap())
}

/// A complete tier closing tag; group 1 = tier digit.
fn tier_close_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"</p([0-9])\s*>").unwrap())
}

/// What may follow a tier's real closing tag: another tier tag or the end of the
/// compartment. A tier tag written as text inside a body is followed by prose.
fn tier_close_follower_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\A\s*(?:\z|</?p[0-9]\s*/?>)").unwrap())
}

/// Lenient fallback bound: the start of any tier's closing tag (`</p1`…`</p9`).
fn tier_close_any_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"</p[0-9]").unwrap())
}

/// The over-capture guard for the lenient bounds: the start of any tier's
/// opening tag, which a tier body must never swallow.
fn tier_open_any_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<p[0-9]").unwrap())
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

/// Opening tag of a fact category block; group 1 = the category name.
fn category_open_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<([A-Za-z_][A-Za-z0-9_-]*)>").unwrap())
}

/// Scan `text` for `<name …>body</name>` elements the way the TypeScript parser's
/// backreference regexes (`/<(name)…>(.*?)<\/\1>/gs`) do, which Rust's regex
/// engine cannot express: from each opening tag (group 1 = name), the body runs
/// to the first closing tag with the SAME name, so a different closing tag
/// written as text in the body (`</compartment>`) does not end it. An opening
/// tag with no matching close is skipped and the scan resumes just after its `<`.
fn paired_elements<'a>(text: &'a str, open_regex: &Regex) -> Vec<(&'a str, &'a str)> {
    let mut elements = Vec::new();
    let mut pos = 0;
    while let Some(open) = open_regex.captures_at(text, pos) {
        let (Some(whole), Some(name)) = (open.get(0), open.get(1)) else {
            break;
        };
        let close_tag = format!("</{}>", name.as_str());
        match text[whole.end()..].find(&close_tag) {
            Some(body_len) => {
                let body_end = whole.end() + body_len;
                elements.push((name.as_str(), &text[whole.end()..body_end]));
                pos = body_end + close_tag.len();
            }
            None => pos = whole.start() + 1,
        }
    }
    elements
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

/// Opening tag of an event field; group 1 = the field name.
fn event_field_open_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<([a-z_]+)\s*>").unwrap())
}

/// A side-channel bullet's optional anchor prefix. Only ASCII space and tab separate
/// its parts, and the text after it may hold any character (`(?s)`), so JavaScript
/// and Rust classify the same input the same way; see `FACT_ANCHOR_PREFIX_REGEX` in
/// packages/plugin/src/hooks/magic-context/compartment-parser.ts.
fn side_channel_anchor_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"^[ \t]*[\[(][ \t]*(?:at_compartment|origin_compartment)[ \t]*=[ \t]*"?([0-9]+|unknown)"?(?:[ \t]+messages[ \t]*=[ \t]*"?([0-9]+)(?:[ \t]*-[ \t]*([0-9]+))?"?)?[ \t]*[\])][ \t]*(?s:(.+))$"#,
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

    #[derive(Debug, Deserialize)]
    struct ParseGoldenCase {
        label: String,
        text: String,
        parsed: ParsedCompartmentOutput,
    }

    /// Parser parity with the TypeScript host: the golden records what
    /// `parseCompartmentOutput` returns for each raw historian output
    /// (regenerate with `bun crates/mc-module/gen/gen-historian-parse-golden.ts`).
    #[test]
    fn parse_golden_matches_typescript_parser() {
        let raw = include_str!("../testdata/historian-parse-golden.json");
        let cases: Vec<ParseGoldenCase> =
            serde_json::from_str(raw).expect("parse historian parse golden");
        assert!(!cases.is_empty(), "empty historian parse golden");
        // Collect every mismatching case so one run names all diverging labels.
        let mut mismatches = Vec::new();
        for case in &cases {
            match parse_compartment_output(&case.text) {
                Ok(parsed) if parsed == case.parsed => {}
                Ok(parsed) => mismatches.push(format!(
                    "{}:\n  rust: {parsed:?}\n  ts:   {:?}",
                    case.label, case.parsed
                )),
                Err(error) => mismatches.push(format!("{}: failed to parse: {error}", case.label)),
            }
        }
        assert!(
            mismatches.is_empty(),
            "parsed mismatch in {} case(s):\n{}",
            mismatches.len(),
            mismatches.join("\n")
        );
    }

    #[test]
    fn rust_only_side_channel_anchors_follow_out_of_order_compartments() {
        // Emission order: compartment 1 covers 3-4, compartment 2 covers 1-2.
        let text = "<output><compartments>\
<compartment start=\"3\" end=\"4\" title=\"later\"><p1>later</p1><p2>l</p2><p3>l</p3><p4/></compartment>\
<compartment start=\"1\" end=\"2\" title=\"earlier\"><p1>earlier</p1><p2>e</p2><p3>e</p3><p4/></compartment>\
</compartments><facts><PROJECT_RULES>\n* [at_compartment=1] Fact from later.\n</PROJECT_RULES></facts>\
<user_observations>\n* (origin_compartment=2) Observation from earlier.\n</user_observations></output>";
        let parsed = parse_compartment_output(text).expect("parse out-of-order output");
        let titles: Vec<&str> = parsed
            .compartments
            .iter()
            .map(|c| c.title.as_str())
            .collect();
        assert_eq!(titles, ["earlier", "later"]);
        assert_eq!(parsed.facts[0].content, "Fact from later.");
        assert_eq!(parsed.facts[0].origin_compartment_index, Some(2));
        assert_eq!(
            parsed.user_observations[0].content,
            "Observation from earlier."
        );
        assert_eq!(
            parsed.user_observations[0].origin_compartment_index,
            Some(1)
        );
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

    /// The historian prompt must say what `<unprocessed_from>` holds when nothing is
    /// left unprocessed; otherwise small models guess `0` or the last index and an
    /// otherwise complete chunk fails validation. The prompt prescribes chunk end + 1,
    /// so that exact value must validate, while a chunk that leaves a trailing suffix
    /// uncovered must still name that suffix's first message.
    #[test]
    fn fully_covered_chunk_validates_with_the_prompt_prescribed_boundary() {
        assert!(
            crate::historian_prompt::HISTORIAN_SYSTEM_PROMPT.contains(
                "If every message in the chunk is covered by a compartment, nothing is unprocessed: set `<unprocessed_from>` to the chunk's last message index + 1."
            ),
            "historian system prompt must define the fully covered <unprocessed_from> value"
        );

        let covered = xml(
            &[(54353, 54428, "first"), (54429, 54431, "second")],
            54432,
            "",
        );
        validate_historian_output(
            &covered,
            &chunk(54353, 54431),
            &[],
            ValidateOptions::default(),
        )
        .expect("a fully covered chunk with chunk end + 1 publishes");

        let zero = validate_historian_output(
            &xml(&[(1, 10, "all")], 0, ""),
            &chunk(1, 10),
            &[],
            ValidateOptions::default(),
        )
        .expect_err("0 is not the prescribed completion value");
        assert!(zero
            .message
            .contains("<unprocessed_from> 0 is outside chunk 1-10"));

        let last = validate_historian_output(
            &xml(&[(1, 10, "all")], 10, ""),
            &chunk(1, 10),
            &[],
            ValidateOptions::default(),
        )
        .expect_err("the last covered index is not the prescribed completion value");
        assert!(last
            .message
            .contains("<unprocessed_from> 10 does not match completed chunk boundary 11"));
    }

    #[test]
    fn uncovered_tail_still_requires_its_first_message_as_the_boundary() {
        let correct = validate_historian_output(
            &xml(&[(1, 6, "prefix")], 7, ""),
            &chunk(1, 10),
            &[],
            ValidateOptions::default(),
        )
        .expect("the first uncovered message is the correct boundary");
        assert_eq!(correct.unprocessed_from, 7);

        let claims_complete = validate_historian_output(
            &xml(&[(1, 6, "prefix")], 11, ""),
            &chunk(1, 10),
            &[],
            ValidateOptions::default(),
        )
        .expect_err("chunk end + 1 cannot claim completion over an uncovered tail");
        assert!(claims_complete
            .message
            .contains("<unprocessed_from> 11 does not match next uncovered message 7"));
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
    fn discarded_last_keeps_bound_facts_and_suppresses_the_other_side_channels() {
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
        // A fact bound to the persisted compartment survives: the next run re-reads
        // only the discarded tail, so it cannot emit that fact again.
        let facts: Vec<&str> = result
            .facts
            .iter()
            .map(|fact| fact.content.as_str())
            .collect();
        assert_eq!(facts, vec!["Keep the earlier rule."]);
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

    #[derive(Debug, Deserialize)]
    struct AnchorGolden {
        compartments: Vec<(u64, u64)>,
        blocks: Vec<(u64, u64)>,
        cases: Vec<AnchorGoldenCase>,
        keep: Vec<KeepGoldenCase>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct KeepGoldenCase {
        name: String,
        index: Option<u64>,
        persisted: u64,
        dropped_tail: bool,
        weak_final: Option<u64>,
        keep: bool,
    }

    /// Which facts a validated reply publishes matches the TypeScript runners'
    /// `keepPublishedFact` on the shared `keep` cases.
    #[test]
    fn published_fact_policy_matches_the_typescript_runners() {
        let golden: AnchorGolden = serde_json::from_str(include_str!(
            "../tests/fixtures/turn-one-anchor-goldens.json"
        ))
        .expect("parse turn-one anchor goldens");
        assert!(golden.keep.len() >= 10);
        for case in &golden.keep {
            assert_eq!(
                keep_side_channel(
                    case.index,
                    case.persisted,
                    case.dropped_tail,
                    case.weak_final
                ),
                case.keep,
                "{}",
                case.name
            );
        }
    }

    fn validated_fact_texts(options: ValidateOptions) -> Vec<String> {
        let facts = "<facts><PROJECT_RULES>\n* [at_compartment=1 messages=2] Head fact.\n* [at_compartment=2 messages=5] Tail fact.\n* Unanchored fact.\n</PROJECT_RULES></facts>";
        let text = xml(&[(1, 3, "head"), (4, 6, "tail")], 7, facts);
        validate_historian_output(&text, &chunk(1, 6), &[], options)
            .expect("valid reply")
            .facts
            .into_iter()
            .map(|fact| fact.content)
            .collect()
    }

    #[test]
    fn discard_last_keeps_facts_bound_to_persisted_compartments_only() {
        assert_eq!(
            validated_fact_texts(ValidateOptions::default()),
            vec!["Head fact.".to_string()]
        );
    }

    #[test]
    fn forced_final_keep_drops_facts_of_the_weak_final_compartment_and_unanchored_ones() {
        assert_eq!(
            validated_fact_texts(ValidateOptions {
                force_keep_last_compartment: true,
                ..ValidateOptions::default()
            }),
            vec!["Head fact.".to_string()]
        );
    }

    #[test]
    fn a_reply_without_a_weak_tail_keeps_unanchored_facts() {
        assert_eq!(
            validated_fact_texts(ValidateOptions {
                in_emergency: true,
                ..ValidateOptions::default()
            }),
            vec![
                "Head fact.".to_string(),
                "Tail fact.".to_string(),
                "Unanchored fact.".to_string()
            ]
        );
    }

    #[derive(Debug, Deserialize)]
    struct AnchorGoldenCase {
        name: String,
        line: String,
        #[serde(default)]
        blocks: Option<Vec<(u64, u64)>>,
        expect: AnchorGoldenExpect,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    struct AnchorGoldenExpect {
        content: String,
        compartment: Option<u64>,
        range: Option<(u64, u64)>,
        resolved: Option<AnchorGoldenResolved>,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    struct AnchorGoldenResolved {
        compartment: u64,
        blocks: Vec<(u64, u64)>,
    }

    /// Turn-one fact anchors parse and resolve exactly as the TypeScript publisher
    /// does; the TypeScript side asserts the same fixture in
    /// packages/plugin/src/features/magic-context/memory/turn-one-publication.test.ts.
    #[test]
    fn turn_one_anchor_goldens_match_the_typescript_publisher() {
        let golden: AnchorGolden = serde_json::from_str(include_str!(
            "../tests/fixtures/turn-one-anchor-goldens.json"
        ))
        .expect("parse turn-one anchor goldens");
        assert!(!golden.cases.is_empty());
        let mut mismatches = Vec::new();
        for case in &golden.cases {
            let (origin_compartment_index, source_range, content) =
                split_fact_anchor_prefix(&case.line);
            let fact = FactCandidate {
                category: "PROJECT_RULES".into(),
                content: content.clone(),
                origin_compartment_index,
                source_range,
            };
            let blocks = case.blocks.as_ref().unwrap_or(&golden.blocks);
            let resolved =
                resolve_fact_anchor(&fact, &golden.compartments, blocks).map(|resolved| {
                    AnchorGoldenResolved {
                        compartment: resolved.compartment_index,
                        blocks: resolved
                            .block_indexes
                            .iter()
                            .map(|&index| blocks[index])
                            .collect(),
                    }
                });
            let got = AnchorGoldenExpect {
                content,
                compartment: origin_compartment_index,
                range: source_range.map(|range| (range.start, range.end)),
                resolved,
            };
            if got != case.expect {
                mismatches.push(format!(
                    "{}:\n  rust:     {got:?}\n  expected: {:?}",
                    case.name, case.expect
                ));
            }
        }
        assert!(
            mismatches.is_empty(),
            "turn-one anchor mismatch in {} case(s):\n{}",
            mismatches.len(),
            mismatches.join("\n")
        );
    }

    #[test]
    fn fact_anchor_ranges_ride_the_out_of_order_remap() {
        let text = "<output><compartments>\
<compartment start=\"5\" end=\"6\" title=\"later\"><p1>later</p1><p2>l</p2><p3>l</p3><p4/></compartment>\
<compartment start=\"1\" end=\"2\" title=\"earlier\"><p1>earlier</p1><p2>e</p2><p3>e</p3><p4/></compartment>\
</compartments><facts><PROJECT_RULES>\n* [at_compartment=1 messages=5-6] Fact from later.\n</PROJECT_RULES></facts></output>";
        let parsed = parse_compartment_output(text).expect("parse anchored output");
        assert_eq!(parsed.facts.len(), 1);
        assert_eq!(parsed.facts[0].content, "Fact from later.");
        assert_eq!(parsed.facts[0].origin_compartment_index, Some(2));
        assert_eq!(
            parsed.facts[0].source_range,
            Some(FactSourceRange { start: 5, end: 6 })
        );
        let compartments: Vec<(u64, u64)> = parsed
            .compartments
            .iter()
            .map(|compartment| (compartment.start_message, compartment.end_message))
            .collect();
        let resolved = resolve_fact_anchor(&parsed.facts[0], &compartments, &[(1, 2), (5, 6)])
            .expect("anchor resolves to the later compartment");
        assert_eq!(resolved.compartment_index, 2);
        assert_eq!(resolved.block_indexes, vec![1]);
    }

    #[derive(Debug, Deserialize)]
    struct AnchorFuzzCorpus {
        lines: Vec<AnchorFuzzLine>,
        documents: Vec<AnchorFuzzDocument>,
    }

    #[derive(Debug, Deserialize)]
    struct AnchorFuzzLine {
        line: String,
        compartments: Vec<(u64, u64)>,
        blocks: Vec<(u64, u64)>,
        ts: AnchorGoldenExpect,
    }

    #[derive(Debug, Deserialize)]
    struct AnchorFuzzDocument {
        document: String,
        ts: Vec<AnchorFuzzFact>,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    struct AnchorFuzzFact {
        category: String,
        content: String,
        compartment: Option<u64>,
        range: Option<(u64, u64)>,
    }

    /// Input both parsers can classify the same way: no character JavaScript and Rust
    /// treat differently (U+0085 is Rust whitespace only, U+FEFF is JavaScript
    /// whitespace only, and a `\r` not followed by `\n`, U+2028 and U+2029 end a
    /// JavaScript `.` match) and no integer longer than 15 digits (TypeScript keeps
    /// only integers below 2^53). CRLF line endings are portable.
    fn portable_anchor_input(text: &str) -> bool {
        let mut digits = 0;
        let mut characters = text.chars().peekable();
        while let Some(character) = characters.next() {
            if character == '\r' && characters.peek() != Some(&'\n') {
                return false;
            }
            if matches!(character, '\u{85}' | '\u{feff}' | '\u{2028}' | '\u{2029}') {
                return false;
            }
            digits = if character.is_ascii_digit() {
                digits + 1
            } else {
                0
            };
            if digits > 15 {
                return false;
            }
        }
        true
    }

    /// The parts of the anchor fuzz comparison that disagree with TypeScript, one
    /// line per disagreeing case, split by what is compared. With `portable_only`,
    /// cases outside [`portable_anchor_input`] are skipped.
    fn anchor_fuzz_mismatches(
        portable_only: bool,
    ) -> (Vec<String>, Vec<String>, Vec<String>, usize) {
        let corpus: AnchorFuzzCorpus =
            serde_json::from_str(include_str!("../testdata/turn-one-anchor-fuzz.json"))
                .expect("parse turn-one anchor fuzz corpus");
        assert!(corpus.lines.len() >= 400 && corpus.documents.len() >= 80);
        let mut parsed_mismatches = Vec::new();
        let mut resolved_mismatches = Vec::new();
        let mut compared = 0;
        for case in &corpus.lines {
            if portable_only && !portable_anchor_input(&case.line) {
                continue;
            }
            compared += 1;
            let (origin_compartment_index, source_range, content) =
                split_fact_anchor_prefix(&case.line);
            let fact = FactCandidate {
                category: "PROJECT_RULES".into(),
                content: content.clone(),
                origin_compartment_index,
                source_range,
            };
            let resolved =
                resolve_fact_anchor(&fact, &case.compartments, &case.blocks).map(|resolved| {
                    AnchorGoldenResolved {
                        compartment: resolved.compartment_index,
                        blocks: resolved
                            .block_indexes
                            .iter()
                            .map(|&index| case.blocks[index])
                            .collect(),
                    }
                });
            let range = source_range.map(|range| (range.start, range.end));
            if content != case.ts.content
                || origin_compartment_index != case.ts.compartment
                || range != case.ts.range
            {
                parsed_mismatches.push(format!(
                    "{:?}: rust content={content:?} compartment={origin_compartment_index:?} range={range:?}; ts content={:?} compartment={:?} range={:?}",
                    case.line, case.ts.content, case.ts.compartment, case.ts.range
                ));
            }
            if resolved != case.ts.resolved {
                resolved_mismatches.push(format!(
                    "{:?}: rust {resolved:?}; ts {:?}",
                    case.line, case.ts.resolved
                ));
            }
        }
        let mut document_mismatches = Vec::new();
        for case in &corpus.documents {
            if portable_only && !portable_anchor_input(&case.document) {
                continue;
            }
            compared += 1;
            let facts: Vec<AnchorFuzzFact> = match parse_compartment_output(&case.document) {
                Ok(parsed) => parsed
                    .facts
                    .into_iter()
                    .map(|fact| AnchorFuzzFact {
                        category: fact.category,
                        content: fact.content,
                        compartment: fact.origin_compartment_index,
                        range: fact.source_range.map(|range| (range.start, range.end)),
                    })
                    .collect(),
                Err(error) => {
                    document_mismatches.push(format!("{:?}: rust error {error:?}", case.document));
                    continue;
                }
            };
            if facts != case.ts {
                document_mismatches.push(format!(
                    "{:?}:\n  rust {facts:?}\n  ts   {:?}",
                    case.document, case.ts
                ));
            }
        }
        (
            parsed_mismatches,
            resolved_mismatches,
            document_mismatches,
            compared,
        )
    }

    /// Whether an anchor binds, and to which compartment and printed lines, and the
    /// parsed anchor and fact text, match the TypeScript parser and publisher on every
    /// portable case of the seeded adversarial corpus generated by
    /// crates/mc-module/gen/gen-turn-one-anchor-fuzz.ts, for single bullets and for
    /// whole historian outputs.
    #[test]
    fn turn_one_anchor_fuzz_matches_typescript_on_portable_input() {
        let (parsed, resolved, documents, compared) = anchor_fuzz_mismatches(true);
        // Most of the corpus is portable; the filter must not empty the comparison.
        assert!(compared >= 400, "only {compared} portable cases compared");
        assert!(
            parsed.is_empty() && resolved.is_empty() && documents.is_empty(),
            "{} bullet, {} resolution and {} document mismatch(es):\n{}\n{}\n{}",
            parsed.len(),
            resolved.len(),
            documents.len(),
            parsed.join("\n"),
            resolved.join("\n"),
            documents.join("\n")
        );
    }

    /// Compares this parser with the TypeScript one over the whole fuzz corpus,
    /// including non-portable input (U+0085, U+FEFF, a lone `\r`, U+2028, U+2029 and
    /// integers past 2^53), which both must classify the same way (see
    /// `split_fact_anchor_prefix` and `fact_items`).
    #[test]
    fn review_witness_turn_one_anchor_fuzz_matches_typescript_on_all_input() {
        let (parsed, resolved, documents, _) = anchor_fuzz_mismatches(false);
        assert!(
            parsed.is_empty() && resolved.is_empty() && documents.is_empty(),
            "{} bullet, {} resolution and {} document mismatch(es):\n{}\n{}\n{}",
            parsed.len(),
            resolved.len(),
            documents.len(),
            parsed.join("\n"),
            resolved.join("\n"),
            documents.join("\n")
        );
    }
}
