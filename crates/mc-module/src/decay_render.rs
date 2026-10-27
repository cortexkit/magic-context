//! Deterministic decay renderer: turns a chronological compartment set into the
//! markdown-heading history bytes that fill m0/m1.
//!
//! Faithful port of the shared `decay-render.ts`. It picks a tier per compartment
//! from age + importance + budget pressure (via [`mc_core::decay`], pressure computed
//! ONCE per pass), renders the chosen paraphrase tier (P1..P4; P5 = archived =
//! omitted), and demotes oldest-first under a hard token budget as a drift guard.
//!
//! This is byte-producing, so it lives in mc-module (mc-core stays pure decision
//! math). The byte-identity invariant that matters is intra-module determinism (same
//! compartments + budget → same bytes across passes); a differential golden cross-
//! checks the v2 paraphrase path against the TS reference.
//!
//! The budget-guard loop needs a token estimator, which is its own subsystem and a
//! later port — so it is INJECTED (`estimate_tokens`). The renderer stays pure; with
//! a budget loose enough that the guard never fires, the output is estimator-
//! independent and purely curve-driven (which is what the golden exercises).

use mc_core::decay::{compute_budget_pressure, rendered_tier, DecayInput};
use mc_store::StoredCompartment;

/// Default history budget when a caller doesn't supply one.
pub const DEFAULT_HISTORY_BUDGET_TOKENS: u32 = 60_000;

/// The minimal compartment shape the renderer needs. `p1..p4` are the paraphrase
/// tiers (None / empty = not a v2-tiered row); `legacy = Some(1)` marks a pre-v2
/// flat-content row; `importance` defaults to 50 when absent.
#[derive(Debug, Clone, Default)]
#[cfg_attr(test, derive(serde::Deserialize))]
pub struct DecayRenderCompartment {
    pub start_message: i64,
    pub end_message: i64,
    pub title: String,
    pub content: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub p1: Option<String>,
    pub p2: Option<String>,
    pub p3: Option<String>,
    pub p4: Option<String>,
    pub importance: Option<i32>,
    pub legacy: Option<i32>,
}

impl DecayRenderCompartment {
    /// Empty payload rows advance coverage but are not summaries or decay inputs.
    pub fn is_no_content(&self) -> bool {
        self.title.is_empty()
            && self.content.is_empty()
            && [&self.p1, &self.p2, &self.p3, &self.p4]
                .iter()
                .all(|p| p.as_deref().unwrap_or("").is_empty())
    }
}

impl From<&StoredCompartment> for DecayRenderCompartment {
    /// Project a stored compartment into the renderer's input shape. Empty tier
    /// strings stay empty (the `is_tiered_row`/`tier_body` logic distinguishes an
    /// empty p1 = not-tiered from a non-empty p1 with an empty p4 = title-only).
    fn from(c: &StoredCompartment) -> Self {
        DecayRenderCompartment {
            start_message: c.start_message,
            end_message: c.end_message,
            title: c.title.clone(),
            content: c.content.clone(),
            start_date: c.start_date.clone(),
            end_date: c.end_date.clone(),
            p1: c.p1.clone(),
            p2: c.p2.clone(),
            p3: c.p3.clone(),
            p4: c.p4.clone(),
            importance: Some(c.importance),
            legacy: Some(c.legacy),
        }
    }
}

/// Render a session's stored compartments (chronological, oldest first — the order
/// [`mc_store::McStore::load_compartments`] returns) into the m0/m1 history body.
pub fn render_stored_compartments(
    compartments: &[StoredCompartment],
    history_budget_tokens: f64,
    estimate_tokens: impl Fn(&str) -> usize,
) -> String {
    let mapped: Vec<DecayRenderCompartment> = compartments
        .iter()
        .map(DecayRenderCompartment::from)
        .collect();
    render_decayed_compartments(&mapped, history_budget_tokens, estimate_tokens)
}

fn escape_xml_content(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn format_date_range(start_date: Option<&str>, end_date: Option<&str>) -> String {
    let (Some(start_date), Some(end_date)) = (start_date, end_date) else {
        return String::new();
    };
    if start_date.is_empty() || end_date.is_empty() {
        return String::new();
    }
    if start_date == end_date {
        return start_date.to_string();
    }
    if start_date.get(..7) == end_date.get(..7) {
        if let Some(end_day) = end_date.get(8..) {
            return format!("{start_date}→{end_day}");
        }
    }
    format!("{start_date}→{end_date}")
}

fn sanitize_compartment_title(title: &str) -> String {
    // Historian-authored titles are untrusted: controls and Unicode line/paragraph
    // separators must collapse or they can forge a visually multiline heading.
    let mut single_line = String::with_capacity(title.len());
    let mut replacing_control_run = false;
    for ch in title.chars() {
        if ch.is_control() || matches!(ch, '\u{2028}' | '\u{2029}') {
            if !replacing_control_run {
                single_line.push(' ');
                replacing_control_run = true;
            }
        } else {
            single_line.push(ch);
            replacing_control_run = false;
        }
    }
    escape_xml_content(&single_line)
}

fn compartment_heading(c: &DecayRenderCompartment) -> String {
    let date_range = format_date_range(c.start_date.as_deref(), c.end_date.as_deref());
    let date_segment = if date_range.is_empty() {
        String::new()
    } else {
        format!(" · {date_range}")
    };
    format!(
        "## {}-{}{date_segment} · {}",
        c.start_message,
        c.end_message,
        sanitize_compartment_title(&c.title)
    )
}

fn guard_compartment_body(body: &str) -> String {
    // A rendered body cannot open a new compartment; indent heading-like lines so
    // the next unindented `## ` line remains an unambiguous compartment boundary.
    let guarded = body.replace("\n## ", "\n ## ");
    if guarded.starts_with("## ") {
        format!(" {guarded}")
    } else {
        guarded
    }
}

/// A row is v2-tiered ONLY when `p1` is a non-empty string. Rows with empty/null `p1`
/// (legacy rows, or the malformed pseudo-v2 state left by an interrupted upgrade —
/// `legacy=0` but tiers never populated) render via flat `content`, never as an empty
/// tier body. A VALID v2 row can still have an empty `p4` (a legitimate title-only
/// heading); that is handled by the tier-body path, since such a row has a non-empty `p1`.
fn is_tiered_row(c: &DecayRenderCompartment) -> bool {
    c.p1.as_deref().is_some_and(|p| !p.is_empty())
}

/// The v2 paraphrase tier body, with denser-tier and content fallbacks: the requested
/// tier if present, else the densest populated denser tier, else flat content.
fn tier_body(c: &DecayRenderCompartment, tier: u8) -> String {
    let tiers = [
        c.p1.as_deref(),
        c.p2.as_deref(),
        c.p3.as_deref(),
        c.p4.as_deref(),
    ];
    let idx = (tier as usize).saturating_sub(1);
    if let Some(requested) = tiers.get(idx).copied().flatten() {
        return requested.trim().to_string();
    }
    // walk denser (lower-index) tiers for a non-empty body
    for i in (0..idx).rev() {
        if let Some(t) = tiers[i] {
            if !t.is_empty() {
                return t.trim().to_string();
            }
        }
    }
    c.content.trim().to_string()
}

/// Truncate to at most `max` UTF-16 code units, exactly matching JavaScript's
/// `String.prototype.slice`. A cut through an astral scalar retains the leading
/// surrogate as an internal marker; the response encoder converts that marker to
/// the `\udxxx` JSON escape JavaScript emits for the lone unit.
fn truncate_with_ellipsis(content: &str, max: usize) -> String {
    let units = content.encode_utf16().collect::<Vec<_>>();
    if units.len() <= max {
        return content.to_string();
    }
    let prefix = crate::transform::string_from_js_utf16_prefix(&units, max);
    format!("{}…", prefix.trim_end())
}

/// Legacy flat-content tier rendering (no paraphrase columns): P1 = full, P2 = ≤1200
/// chars, P3+ = ≤420 chars.
fn legacy_body_for_tier(content: &str, tier: u8) -> String {
    if tier <= 1 {
        content.to_string()
    } else if tier == 2 {
        truncate_with_ellipsis(content, 1_200)
    } else {
        truncate_with_ellipsis(content, 420)
    }
}

/// Legacy compartments start at P3 if the body has a `U:` line, else P4.
fn legacy_tier(c: &DecayRenderCompartment) -> u8 {
    if c.content.lines().any(|l| l.starts_with("U:")) {
        3
    } else {
        4
    }
}

/// Render a single compartment at an explicit tier. Exposed for the m1 "new
/// compartments" block, which always renders newest compartments at P1 (full
/// fidelity — no decay applies to brand-new deltas).
pub fn render_compartment_at_tier(c: &DecayRenderCompartment, tier: u8) -> String {
    render_one_compartment(c, tier)
}

fn render_one_compartment(c: &DecayRenderCompartment, tier: u8) -> String {
    if c.is_no_content() || tier >= 5 {
        return String::new(); // archived
    }
    let heading = compartment_heading(c);

    // Legacy rows AND malformed pseudo-v2 rows (legacy=0 but no usable p1) render via
    // flat `content`, never as an empty title-only heading — otherwise a
    // `legacy=0, p1=''` row would silently drop the compartment body from m0/m1.
    if c.legacy == Some(1) || !is_tiered_row(c) {
        let flat = c.content.trim();
        if tier >= 4 || flat.is_empty() {
            return heading;
        }
        let body = guard_compartment_body(&escape_xml_content(&legacy_body_for_tier(flat, tier)));
        return format!("{heading}\n{body}");
    }

    let body = tier_body(c, tier);
    if body.is_empty() {
        return heading;
    }
    format!(
        "{heading}\n{}",
        guard_compartment_body(&escape_xml_content(&body))
    )
}

/// Compute the rendered tier for each compartment, given budget pressure derived once
/// from the whole set. `compartments` are chronological (oldest first); the decay
/// curve indexes from newest (1 = newest). Legacy rows are governed by deterministic
/// truncation, not the curve, and are EXCLUDED from the pressure inputs so unrelated
/// legacy cost can't demote v2 paraphrases (budget honesty for mixed sessions).
///
/// Accepts owned or borrowed compartments so callers holding references (the
/// prepared renderer) need not copy summary bodies just to pick tiers.
fn compute_tiers<C: std::borrow::Borrow<DecayRenderCompartment>>(
    compartments: &[C],
    history_budget: f64,
) -> Vec<u8> {
    let v2_indices: Vec<usize> = compartments
        .iter()
        .enumerate()
        .filter(|(_, c)| c.borrow().legacy != Some(1))
        .map(|(i, _)| i)
        .collect();
    let v2_total = v2_indices.len();

    // curve index per original index: 1-based from newest v2 row.
    let mut curve_index_by_original = std::collections::HashMap::new();
    let mut curve_inputs = Vec::with_capacity(v2_total);
    for (v2_ordinal, &original_index) in v2_indices.iter().enumerate() {
        let curve_index = (v2_total - v2_ordinal) as u32;
        curve_index_by_original.insert(original_index, curve_index);
        let importance = compartments[original_index]
            .borrow()
            .importance
            .unwrap_or(50)
            .clamp(1, 100);
        curve_inputs.push(DecayInput {
            index: curve_index,
            importance,
        });
    }
    let pressure = if history_budget > 0.0 {
        compute_budget_pressure(&curve_inputs, history_budget)
    } else {
        1.0
    };

    compartments
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let c = c.borrow();
            if c.legacy == Some(1) {
                legacy_tier(c)
            } else {
                rendered_tier(
                    *curve_index_by_original.get(&i).unwrap_or(&1),
                    c.importance.unwrap_or(50),
                    pressure,
                    0.0,
                )
            }
        })
        .collect()
}

/// Render the decayed compartment-history body (no `<session-history>` wrapper —
/// callers add their own framing). Demotes oldest-first under the budget as a drift
/// guard, measured by the injected `estimate_tokens` (the estimator is its own
/// subsystem). Never renders session facts (v2 faithful).
pub fn render_decayed_compartments(
    compartments: &[DecayRenderCompartment],
    history_budget_tokens: f64,
    estimate_tokens: impl Fn(&str) -> usize,
) -> String {
    if compartments.is_empty() {
        return String::new();
    }
    let filtered;
    let compartments = if compartments
        .iter()
        .any(DecayRenderCompartment::is_no_content)
    {
        filtered = compartments
            .iter()
            .filter(|c| !c.is_no_content())
            .cloned()
            .collect::<Vec<_>>();
        filtered.as_slice()
    } else {
        compartments
    };
    let mut tiers = compute_tiers(compartments, history_budget_tokens);

    let render = |tiers: &[u8]| -> String {
        let mut parts = Vec::new();
        for (i, c) in compartments.iter().enumerate() {
            let rendered = render_one_compartment(c, tiers[i]);
            if !rendered.is_empty() {
                parts.push(rendered);
            }
        }
        parts.join("\n\n")
    };

    let mut body = render(&tiers);
    // Budget guard: the curve already targets the budget, but estimate drift or a very
    // tight budget can overshoot. Demote oldest-first until it fits.
    let mut guard = compartments.len() * 5;
    while history_budget_tokens > 0.0
        && estimate_tokens(&body) as f64 > history_budget_tokens
        && guard > 0
    {
        let mut demoted = false;
        for t in tiers.iter_mut() {
            if *t < 5 {
                *t += 1;
                demoted = true;
                break;
            }
        }
        if !demoted {
            break;
        }
        body = render(&tiers);
        guard -= 1;
    }
    body
}

#[derive(Default)]
struct PreparedTier {
    text: String,
    final_count: usize,
    continued_count: usize,
}

/// A compose-local tier cache. Retry attempts change pressure, not tier bytes.
/// Only tiers actually visited by the curve or demotion loop are rendered.
pub(crate) struct PreparedDecay<'a> {
    compartments: Vec<&'a DecayRenderCompartment>,
    tiers: Vec<[Option<PreparedTier>; 4]>,
    pub tokenize_ms: f64,
}

impl<'a> PreparedDecay<'a> {
    pub fn new(compartments: &'a [DecayRenderCompartment]) -> Self {
        let compartments: Vec<_> = compartments.iter().filter(|c| !c.is_no_content()).collect();
        let tiers = (0..compartments.len())
            .map(|_| Default::default())
            .collect();
        Self {
            compartments,
            tiers,
            tokenize_ms: 0.0,
        }
    }

    fn tier(&mut self, index: usize, tier: u8) -> &PreparedTier {
        let slot = &mut self.tiers[index][usize::from(tier - 1)];
        slot.get_or_insert_with(|| {
            let text = render_one_compartment(self.compartments[index], tier);
            let start = std::time::Instant::now();
            let (final_count, continued_count) =
                mc_tokenizer::history_render_paragraph_counts(&text);
            self.tokenize_ms += start.elapsed().as_secs_f64() * 1000.0;
            PreparedTier {
                text,
                final_count,
                continued_count,
            }
        })
    }

    pub fn render(&mut self, budget: f64) -> String {
        let mut tiers = compute_tiers(&self.compartments, budget);
        let mut active: std::collections::VecDeque<_> = tiers
            .iter()
            .enumerate()
            .filter(|(_, tier)| **tier < 5)
            .map(|(i, _)| i)
            .collect();
        let mut continued_total: usize = active
            .iter()
            .map(|&i| self.tier(i, tiers[i]).continued_count)
            .sum();
        while let Some(&last) = active.back() {
            let last_tier = self.tier(last, tiers[last]);
            let exact = continued_total - last_tier.continued_count + last_tier.final_count;
            if budget.is_nan() || budget <= 0.0 || exact as f64 <= budget {
                break;
            }
            let first = *active.front().unwrap();
            continued_total -= self.tier(first, tiers[first]).continued_count;
            tiers[first] += 1;
            if tiers[first] == 5 {
                active.pop_front();
            } else {
                continued_total += self.tier(first, tiers[first]).continued_count;
            }
        }
        // Same bytes as joining the selected tier texts with blank lines, written
        // straight into one buffer instead of cloning each prepared text first.
        let mut out = String::new();
        for (position, &i) in active.iter().enumerate() {
            if position > 0 {
                out.push_str("\n\n");
            }
            out.push_str(&self.tier(i, tiers[i]).text);
        }
        out
    }
}

/// Extract a top-level m0 block slice (e.g. "session-history") for budget measurement
/// and token attribution. Returns the full `<tag>…</tag>` slice or None. Manual
/// shortest-match (the non-greedy `<tag>[\s\S]*?</tag>`): the first `</tag>` after the
/// first `<tag>`.
pub fn extract_m0_block(m0_text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = m0_text.find(&open)?;
    let after_open = start + open.len();
    let close_rel = m0_text[after_open..].find(&close)?;
    let end = after_open + close_rel + close.len();
    Some(m0_text[start..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::FixtureBuilder;
    use serde::Deserialize;

    #[test]
    fn incremental_decay_matches_generic_for_nonmonotone_tiers_and_whitespace() {
        let rows = (0..30)
            .map(|i| DecayRenderCompartment {
                start_message: i * 2,
                end_message: i * 2 + 1,
                title: format!("title {i} \t"),
                p1: Some("small🙂".into()),
                p2: Some("larger tier 漢字 \n".repeat(10)),
                p3: Some("x".into()),
                p4: Some(String::new()),
                importance: Some(50),
                ..Default::default()
            })
            .collect::<Vec<_>>();
        let mut prepared = PreparedDecay::new(&rows);
        for budget in [0.0, 1.0, 40.0, 200.0, 500.0, 10_000.0] {
            assert_eq!(
                prepared.render(budget),
                render_decayed_compartments(&rows, budget, |s| mc_tokenizer::encode_ordinary(s)
                    .len()),
                "budget={budget}"
            );
        }
    }

    /// The prepared renderer as it was before tier selection borrowed rows: it
    /// cloned every compartment for `compute_tiers` and cloned every selected
    /// tier text before joining. Kept only as the differential reference.
    fn cloning_prepared_render(prepared: &mut PreparedDecay<'_>, budget: f64) -> String {
        let mapped: Vec<_> = prepared.compartments.iter().map(|c| (*c).clone()).collect();
        let mut tiers = compute_tiers(&mapped, budget);
        let mut active: std::collections::VecDeque<_> = tiers
            .iter()
            .enumerate()
            .filter(|(_, tier)| **tier < 5)
            .map(|(i, _)| i)
            .collect();
        let mut continued_total: usize = active
            .iter()
            .map(|&i| prepared.tier(i, tiers[i]).continued_count)
            .sum();
        while let Some(&last) = active.back() {
            let last_tier = prepared.tier(last, tiers[last]);
            let exact = continued_total - last_tier.continued_count + last_tier.final_count;
            if budget.is_nan() || budget <= 0.0 || exact as f64 <= budget {
                break;
            }
            let first = *active.front().unwrap();
            continued_total -= prepared.tier(first, tiers[first]).continued_count;
            tiers[first] += 1;
            if tiers[first] == 5 {
                active.pop_front();
            } else {
                continued_total += prepared.tier(first, tiers[first]).continued_count;
            }
        }
        active
            .iter()
            .map(|&i| prepared.tier(i, tiers[i]).text.clone())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// Borrowed tier selection and direct output assembly must produce the same
    /// bytes and the same tier choices as the cloning renderer, across legacy,
    /// malformed pseudo-v2, no-content, tiered and mixed-importance rows, over
    /// budgets from unbounded to tight enough to archive everything.
    #[test]
    fn borrowed_prepared_render_matches_cloning_render() {
        let mut rows = Vec::new();
        for i in 0..60i64 {
            let row = match i % 6 {
                0 => DecayRenderCompartment {
                    content: format!("U: legacy {i}\nA: reply\n").repeat(40),
                    legacy: Some(1),
                    ..Default::default()
                },
                1 => DecayRenderCompartment {
                    content: format!("flat body {i}"),
                    legacy: Some(0),
                    p1: Some(String::new()),
                    ..Default::default()
                },
                2 => DecayRenderCompartment::default(),
                _ => DecayRenderCompartment {
                    p1: Some(format!("full {i} ").repeat(30)),
                    p2: Some(format!("dense {i}\n## fake heading")),
                    p3: (i % 2 == 0).then(|| "x".to_string()),
                    p4: Some(String::new()),
                    importance: Some((i * 17 % 100) as i32),
                    ..Default::default()
                },
            };
            rows.push(DecayRenderCompartment {
                start_message: i * 3,
                end_message: i * 3 + 2,
                title: if i % 6 == 2 {
                    String::new()
                } else {
                    format!("title {i}")
                },
                start_date: Some("2026-01-01".into()),
                end_date: Some(format!("2026-01-{:02}", i % 28 + 1)),
                ..row
            });
        }
        let borrowed: Vec<&DecayRenderCompartment> =
            rows.iter().filter(|c| !c.is_no_content()).collect();
        let owned: Vec<DecayRenderCompartment> = borrowed.iter().map(|c| (*c).clone()).collect();
        let mut current = PreparedDecay::new(&rows);
        let mut reference = PreparedDecay::new(&rows);
        for budget in [f64::NAN, 0.0, 1.0, 50.0, 400.0, 2_000.0, 8_000.0, 1e9] {
            assert_eq!(
                compute_tiers(&borrowed, budget),
                compute_tiers(&owned, budget),
                "tiers at budget={budget}"
            );
            assert_eq!(
                current.render(budget),
                cloning_prepared_render(&mut reference, budget),
                "bytes at budget={budget}"
            );
        }
    }

    #[test]
    #[ignore = "requires a read-only live-store fixture"]
    fn aft_live_compose_profile() {
        let path = std::env::var("AFT_COMPOSE_FIXTURE").expect("fixture path");
        let rows: Vec<DecayRenderCompartment> =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let calls = std::cell::Cell::new(0usize);
        let token_time = std::cell::Cell::new(std::time::Duration::ZERO);
        let start = std::time::Instant::now();
        let body = render_decayed_compartments(&rows, 60_000.0, |text| {
            calls.set(calls.get() + 1);
            let start = std::time::Instant::now();
            let count = mc_tokenizer::estimate_tokens(text);
            token_time.set(token_time.get() + start.elapsed());
            count
        });
        let elapsed = start.elapsed();
        let incremental_start = std::time::Instant::now();
        let mut prepared = PreparedDecay::new(&rows);
        let incremental = prepared.render(60_000.0);
        assert_eq!(body, incremental);
        tracing::debug!(
            "aft-incremental total_ms={:.1} tier_tokenize_ms={:.1}",
            incremental_start.elapsed().as_secs_f64() * 1000.0,
            prepared.tokenize_ms
        );
        for row in &rows {
            for tier in 1..5 {
                let text = render_one_compartment(row, tier);
                let joined = format!("{text}\n\n## next\n🙂 ");
                assert_eq!(
                    mc_tokenizer::estimate_tokens(&joined),
                    mc_tokenizer::encode_ordinary(&joined).len()
                );
                let counts = mc_tokenizer::history_paragraph_counts(&text);
                assert_eq!(
                    counts.1 + mc_tokenizer::encode_ordinary("## next\n🙂 ").len(),
                    mc_tokenizer::encode_ordinary(&joined).len()
                );
            }
        }
        use sha2::{Digest, Sha256};
        tracing::debug!(
            "aft-compose rows={} total_ms={:.1} tokenize_ms={:.1} calls={} sha256={:x}",
            rows.len(),
            elapsed.as_secs_f64() * 1000.0,
            token_time.get().as_secs_f64() * 1000.0,
            calls.get(),
            Sha256::digest(body.as_bytes())
        );
    }
    use sha2::{Digest, Sha256};

    fn comp(
        start: i64,
        end: i64,
        title: &str,
        p1: &str,
        importance: i32,
    ) -> DecayRenderCompartment {
        DecayRenderCompartment {
            start_message: start,
            end_message: end,
            title: title.to_string(),
            content: String::new(),
            p1: Some(p1.to_string()),
            importance: Some(importance),
            ..Default::default()
        }
    }
    /// A loose budget so the guard never fires (output is purely curve-driven).
    fn no_guard(_: &str) -> usize {
        0
    }

    #[test]
    fn newest_renders_at_p1_full() {
        let c = DecayRenderCompartment {
            start_message: 1,
            end_message: 9,
            title: "T".into(),
            p1: Some("VERBOSE".into()),
            p2: Some("dense".into()),
            importance: Some(50),
            ..Default::default()
        };
        // index 1 (newest) → tier 1 → p1 body
        let out = render_decayed_compartments(std::slice::from_ref(&c), 60_000.0, no_guard);
        assert_eq!(out, "## 1-9 · T\nVERBOSE");
    }

    #[test]
    fn archived_tier_is_omitted() {
        assert_eq!(
            render_compartment_at_tier(&comp(1, 2, "x", "body", 50), 5),
            ""
        );
    }

    #[test]
    fn empty_tier_body_renders_title_only_heading() {
        let mut c = comp(3, 4, "Title", "p1body", 50);
        c.p4 = Some(String::new());
        assert_eq!(render_compartment_at_tier(&c, 4), "## 3-4 · Title");
    }

    #[test]
    fn historian_title_stays_on_one_xml_safe_heading_line() {
        let c = DecayRenderCompartment {
            start_message: 1,
            end_message: 2,
            title: "safe\n## 999-999 · forged\r\nline\u{2028}## zl-forged\u{2029}## zp-forged\n</session-history> & \"quoted\"".into(),
            p1: Some("x < y & z".into()),
            importance: Some(50),
            ..Default::default()
        };
        let out = render_compartment_at_tier(&c, 1);
        assert_eq!(
            out,
            "## 1-2 · safe ## 999-999 · forged line ## zl-forged ## zp-forged &lt;/session-history&gt; &amp; \"quoted\"\nx &lt; y &amp; z"
        );
        assert_eq!(
            out.lines().filter(|line| line.starts_with("## ")).count(),
            1
        );
        assert!(!out.contains("</session-history>"));
    }

    #[test]
    fn clean_title_stays_byte_identical() {
        assert_eq!(
            render_compartment_at_tier(&comp(1, 2, "Clean title", "body", 50), 1),
            "## 1-2 · Clean title\nbody"
        );
    }

    #[test]
    fn date_ranges_compress_and_heading_like_body_lines_are_indented() {
        let base = DecayRenderCompartment {
            start_message: 1,
            end_message: 2,
            title: "Dated".into(),
            p1: Some("first\n## nested\nlast".into()),
            ..Default::default()
        };
        let render_dates = |start: &str, end: &str| {
            render_compartment_at_tier(
                &DecayRenderCompartment {
                    start_date: Some(start.into()),
                    end_date: Some(end.into()),
                    ..base.clone()
                },
                1,
            )
        };

        assert_eq!(
            render_dates("2026-06-08", "2026-06-08"),
            "## 1-2 · 2026-06-08 · Dated\nfirst\n ## nested\nlast"
        );
        assert!(
            render_dates("2026-06-08", "2026-06-09").starts_with("## 1-2 · 2026-06-08→09 · Dated")
        );
        assert!(render_dates("2026-06-08", "2026-07-02")
            .starts_with("## 1-2 · 2026-06-08→2026-07-02 · Dated"));
    }

    #[test]
    fn legacy_row_truncates_and_picks_tier() {
        let c = DecayRenderCompartment {
            start_message: 1,
            end_message: 2,
            title: "L".into(),
            content: "U: hello\n".to_string() + &"x".repeat(2000),
            legacy: Some(1),
            ..Default::default()
        };
        // has a U: line → legacy starts at P3 → ≤420 chars + ellipsis
        let out = render_decayed_compartments(std::slice::from_ref(&c), 60_000.0, no_guard);
        assert!(out.ends_with('…'), "P3 truncates: {out}");
    }

    #[test]
    fn malformed_pseudo_v2_renders_flat_not_empty() {
        // legacy=0 but p1 empty (interrupted upgrade) → flat content, not empty tier
        let c = DecayRenderCompartment {
            start_message: 1,
            end_message: 2,
            title: "M".into(),
            content: "flat body".into(),
            p1: Some(String::new()),
            legacy: Some(0),
            ..Default::default()
        };
        let out = render_compartment_at_tier(&c, 1);
        assert_eq!(out, "## 1-2 · M\nflat body");
    }

    #[test]
    fn budget_guard_demotes_oldest_first() {
        // three compartments; a synthetic estimator (chars) forces demotion. Oldest
        // (index 0, chronologically first) demotes first.
        let comps = vec![
            comp(1, 2, "OLD", "oldverbosebody", 50),
            comp(3, 4, "MID", "midverbosebody", 50),
            comp(5, 6, "NEW", "newverbosebody", 50),
        ];
        let chars = |s: &str| s.chars().count();
        // tiny budget forces demotion until it fits
        let out = render_decayed_compartments(&comps, 80.0, chars);
        assert!(
            chars(&out) as f64 <= 80.0 || out.is_empty(),
            "fits budget: {}",
            chars(&out)
        );
        // the newest should retain more fidelity than the oldest after demotion
        assert!(out.contains(" · NEW"), "newest survives: {out}");
    }

    #[test]
    fn stored_compartment_projects_and_renders() {
        // a StoredCompartment converts directly into the renderer's input shape and
        // renders the same as a hand-built compartment
        let stored = StoredCompartment {
            sequence: 1,
            start_message: 1,
            end_message: 9,
            title: "Stored".into(),
            content: "P1 full".into(),
            start_date: Some("2026-01-02".into()),
            end_date: Some("2026-01-03".into()),
            p1: Some("P1 full".into()),
            p2: Some("P2".into()),
            importance: 50,
            legacy: 0,
            ..Default::default()
        };
        let out = render_stored_compartments(std::slice::from_ref(&stored), 60_000.0, no_guard);
        assert_eq!(out, "## 1-9 · 2026-01-02→03 · Stored\nP1 full");
        // an empty-p1 stored row is treated as not-tiered → flat content
        let legacy_ish = StoredCompartment {
            sequence: 1,
            title: "Flat".into(),
            content: "flat".into(),
            p1: Some(String::new()),
            legacy: 0,
            ..Default::default()
        };
        let out2 =
            render_stored_compartments(std::slice::from_ref(&legacy_ish), 60_000.0, no_guard);
        assert_eq!(out2, "## 0-0 · Flat\nflat");

        let partial = DecayRenderCompartment {
            start_message: 1,
            end_message: 2,
            title: "Partial".into(),
            content: "flat".into(),
            start_date: Some("2026-01-02".into()),
            legacy: Some(1),
            ..Default::default()
        };
        let partial_out = render_compartment_at_tier(&partial, 1);
        assert_eq!(partial_out, "## 1-2 · Partial\nflat");
    }

    #[test]
    fn extract_m0_block_shortest_match() {
        let m0 = "<a>x</a><session-history>HIST</session-history><b>y</b>";
        assert_eq!(
            extract_m0_block(m0, "session-history").as_deref(),
            Some("<session-history>HIST</session-history>")
        );
        assert_eq!(extract_m0_block(m0, "missing"), None);
    }

    // --- differential golden vs the TS reference (v2 paraphrase path, guard off) ---

    #[derive(Deserialize)]
    struct RawComp {
        #[serde(rename = "startMessage")]
        start: i64,
        #[serde(rename = "endMessage")]
        end: i64,
        title: String,
        #[serde(default, rename = "startDate")]
        start_date: Option<String>,
        #[serde(default, rename = "endDate")]
        end_date: Option<String>,
        #[serde(default)]
        content: String,
        p1: Option<String>,
        p2: Option<String>,
        p3: Option<String>,
        p4: Option<String>,
        importance: Option<i32>,
        legacy: Option<i32>,
    }
    #[derive(Deserialize)]
    struct RenderCase {
        compartments: Vec<RawComp>,
        budget: f64,
        body: Option<String>,
        body_utf16_hex: Option<String>,
        forced_tier: Option<u8>,
    }
    #[derive(Deserialize)]
    struct RenderGolden {
        cases: Vec<RenderCase>,
    }

    #[test]
    fn render_golden_matches_reference() {
        // Generated by crates/mc-core/testdata/gen-golden.ts. All cases use a loose
        // budget so the TS estimateTokens guard never fires → the Rust output (guard
        // off) is the same purely-curve-driven body. Exercises the v2 paraphrase path,
        // legacy truncation (ASCII), archive omission, and XML escaping.
        let raw = include_str!("../testdata/render-golden.json");
        let golden: RenderGolden = serde_json::from_str(raw).expect("parse render-golden.json");
        assert!(!golden.cases.is_empty(), "empty render golden");

        for (n, case) in golden.cases.iter().enumerate() {
            let comps: Vec<DecayRenderCompartment> = case
                .compartments
                .iter()
                .map(|r| DecayRenderCompartment {
                    start_message: r.start,
                    end_message: r.end,
                    title: r.title.clone(),
                    content: r.content.clone(),
                    start_date: r.start_date.clone(),
                    end_date: r.end_date.clone(),
                    p1: r.p1.clone(),
                    p2: r.p2.clone(),
                    p3: r.p3.clone(),
                    p4: r.p4.clone(),
                    importance: r.importance,
                    legacy: r.legacy,
                })
                .collect();
            let got = case.forced_tier.map_or_else(
                || render_decayed_compartments(&comps, case.budget, no_guard),
                |tier| render_compartment_at_tier(&comps[0], tier),
            );
            if case.forced_tier.is_none() {
                assert_eq!(
                    PreparedDecay::new(&comps).render(case.budget),
                    got,
                    "incremental loose golden case {n}"
                );
            }
            if let Some(expected_hex) = &case.body_utf16_hex {
                let actual_hex = crate::transform::js_utf16_units_from_internal(&got)
                    .into_iter()
                    .map(|unit| format!("{unit:04x}"))
                    .collect::<String>();
                assert_eq!(
                    actual_hex, *expected_hex,
                    "UTF-16 render mismatch in case {n}"
                );
            } else {
                assert_eq!(
                    Some(&got),
                    case.body.as_ref(),
                    "render mismatch in case {n}"
                );
            }
        }
    }

    #[test]
    fn redacted_store_shape_matches_ts_at_real_history_budgets() {
        #[derive(Deserialize)]
        struct ShapeFixture {
            compartments: Vec<RawComp>,
        }
        #[derive(Deserialize)]
        struct DifferentialCase {
            budget: f64,
            #[serde(rename = "tsCost")]
            ts_cost: usize,
            #[serde(rename = "tsTierCounts")]
            ts_tier_counts: [usize; 5],
            #[serde(rename = "bodySha256")]
            body_sha256: String,
        }
        #[derive(Deserialize)]
        struct DifferentialFixture {
            cases: Vec<DifferentialCase>,
        }

        let shape: ShapeFixture =
            serde_json::from_str(include_str!("../testdata/decay-store-shape.json"))
                .expect("parse redacted store shape");
        assert_eq!(
            shape.compartments.len(),
            388,
            "fixture must preserve the store shape"
        );
        let compartments: Vec<DecayRenderCompartment> = shape
            .compartments
            .iter()
            .map(|raw| DecayRenderCompartment {
                start_message: raw.start,
                end_message: raw.end,
                title: raw.title.clone(),
                content: raw.content.clone(),
                start_date: raw.start_date.clone(),
                end_date: raw.end_date.clone(),
                p1: raw.p1.clone(),
                p2: raw.p2.clone(),
                p3: raw.p3.clone(),
                p4: raw.p4.clone(),
                importance: raw.importance,
                legacy: raw.legacy,
            })
            .collect();
        let differential: DifferentialFixture =
            serde_json::from_str(include_str!("../testdata/decay-store-differential.json"))
                .expect("parse TS differential table");
        assert_eq!(differential.cases.len(), 4);

        let mut previous_cost = None;
        for case in &differential.cases {
            let body = render_decayed_compartments(
                &compartments,
                case.budget,
                mc_tokenizer::estimate_tokens,
            );
            let rust_cost = mc_tokenizer::estimate_tokens(&body);
            assert_eq!(
                rust_cost, case.ts_cost,
                "token cost drift at budget {}",
                case.budget
            );
            assert!(
                rust_cost as f64 <= case.budget || body.is_empty(),
                "render exceeded budget {} with {} tokens",
                case.budget,
                rust_cost
            );
            if let Some(previous) = previous_cost {
                assert!(
                    rust_cost > previous,
                    "shrinking budget must not grow rendered cost: previous {previous}, current {rust_cost}"
                );
            }
            previous_cost = Some(rust_cost);

            let digest = Sha256::digest(body.as_bytes());
            let rust_hash = digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            assert_eq!(
                rust_hash, case.body_sha256,
                "byte drift at budget {}",
                case.budget
            );

            let sections = if body.is_empty() {
                Vec::new()
            } else {
                body.split("\n\n").collect::<Vec<_>>()
            };
            let mut tier_counts = [0usize; 5];
            for compartment in &compartments {
                let heading = format!(
                    "## {}-{}",
                    compartment.start_message, compartment.end_message
                );
                let section = sections
                    .iter()
                    .find(|section| section.starts_with(&heading))
                    .copied();
                let mut selected = 5usize;
                for tier in 1..=5u8 {
                    if render_compartment_at_tier(compartment, tier).as_str()
                        == section.unwrap_or("")
                    {
                        selected = tier as usize;
                        break;
                    }
                }
                tier_counts[selected - 1] += 1;
            }
            assert_eq!(
                tier_counts, case.ts_tier_counts,
                "tier drift at budget {}",
                case.budget
            );
        }
    }

    #[test]
    fn render_tight_golden_matches_reference_with_real_estimator() {
        // The budget GUARD path: these cases use budgets tight enough that the TS
        // renderDecayedCompartments demoted compartments oldest-first (via the REAL
        // Claude estimateTokens). Here we run the SAME cases with the REAL
        // mc_tokenizer::estimate_tokens. Because the tokenizer is bit-identical to
        // ai-tokenizer (proven by mc-tokenizer's differential golden) AND the demotion
        // loops are structurally identical, the Rust guard must reach the same tiers and
        // emit byte-identical bodies — including the CJK cases where a char/N proxy would
        // mis-demote. This is the end-to-end proof that activating the estimator is
        // faithful, not just that the tokenizer counts match in isolation.
        let raw = include_str!("../testdata/render-tight-golden.json");
        let golden: RenderGolden = serde_json::from_str(raw).expect("parse render-tight-golden");
        assert!(!golden.cases.is_empty(), "empty tight render golden");

        let mut fired = 0;
        for (n, case) in golden.cases.iter().enumerate() {
            let comps: Vec<DecayRenderCompartment> = case
                .compartments
                .iter()
                .map(|r| DecayRenderCompartment {
                    start_message: r.start,
                    end_message: r.end,
                    title: r.title.clone(),
                    content: r.content.clone(),
                    start_date: r.start_date.clone(),
                    end_date: r.end_date.clone(),
                    p1: r.p1.clone(),
                    p2: r.p2.clone(),
                    p3: r.p3.clone(),
                    p4: r.p4.clone(),
                    importance: r.importance,
                    legacy: r.legacy,
                })
                .collect();
            // The real estimator drives the guard, exactly as production's HARD arm does.
            let got =
                render_decayed_compartments(&comps, case.budget, mc_tokenizer::estimate_tokens);
            assert_eq!(
                Some(&got),
                case.body.as_ref(),
                "tight render mismatch in case {n} (budget {})",
                case.budget
            );
            assert_eq!(
                PreparedDecay::new(&comps).render(case.budget),
                got,
                "incremental tight golden case {n}"
            );
            // Confirm this case actually exercised the guard (the real estimator agrees the
            // body fits): either it demoted to fit, or it hit the floor (empty). A case
            // whose curve output already fit the tight budget wouldn't prove the guard.
            if mc_tokenizer::estimate_tokens(&got) as f64 <= case.budget || got.is_empty() {
                fired += 1;
            }
        }
        assert_eq!(
            fired,
            golden.cases.len(),
            "every tight case must end within budget (or at the floor) under the real estimator"
        );
    }
    #[test]
    fn fixture_builder_drives_tagged_session_render() {
        let fixture = FixtureBuilder::tagged_session();
        let rendered = render_decayed_compartments(&fixture.compartments, 10_000.0, no_guard);
        assert!(rendered.contains("## 1-1 · Boundary"));
    }
}

/// Convert the real history allowance only at a materialization edge. Both the
/// curve pressure and exact demotion loop consume the resulting local allowance.
pub fn history_local_budget(provider_tokens: f64, model_key: Option<&str>) -> f64 {
    let ratio = crate::decision_calibration::DecisionCalibration::for_model(model_key).prose_ratio;
    if ratio == 1.0 {
        provider_tokens
    } else {
        crate::decision_calibration::local_budget(provider_tokens, ratio)
    }
}

#[cfg(test)]
mod calibration_tests {
    #[test]
    fn fable_history_budget_is_provider_tokens() {
        assert_eq!(
            super::history_local_budget(60_000.0, Some("anthropic/claude-fable-5-1")),
            38173.0
        );
        assert_eq!(
            super::history_local_budget(60_000.0, Some("anthropic/claude-fable-5-2")),
            38173.0
        );
        assert_eq!(
            super::history_local_budget(60_000.0, Some("unknown/model")),
            60000.0
        );
    }
}
