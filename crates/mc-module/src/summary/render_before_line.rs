//! The history renderer as it was before the line: the decay curve, its
//! budget pressure and the guard that demoted summaries oldest-first until
//! the block fit. Production no longer uses it. It is kept, for tests only,
//! so the replay harness ([`super::line_replay_tests`]) can show a session's
//! history as the released build renders it next to the line's, and the
//! goldens below keep proving that this copy is that renderer byte for byte
//! (the 0.49 TypeScript renderer's output).

use super::render::{legacy_tier, render_one_compartment, DecayRenderCompartment};

/// Half-life (in compartments) for importance 50 at pressure 1.
const H50: f64 = 24.0;
/// Importance points needed to double the half-life (imp 75 → 2×, 100 → 4×).
const D: f64 = 25.0;
/// Max extra half-lives of P4 protection from full anchor overlap.
const G: f64 = 2.0;
// Log-cost tier boundaries — geometric means of adjacent measured tier costs.
const Z1: f64 = 0.201;
const Z2: f64 = 0.729;
const Z3: f64 = 1.322;
const Z4: f64 = 2.587;
/// Pressure floor: prevents div-by-zero and caps relaxation at 10×.
const P_FLOOR: f64 = 0.1;
/// Per-tier average token cost, indexed by tier number (1..5). Index 0 unused.
const TIER_COST: [u32; 6] = [0, 322, 109, 35, 20, 5];

/// The half-life-scaled age `z = a / H` for a compartment. `a` is the 0-based
/// age, `H = H50 · 2^((imp−50)/D) / p`.
fn z_value(compartment_index: u32, importance: i32, budget_pressure: f64) -> f64 {
    let a = (compartment_index.max(1) - 1) as f64;
    let imp = importance.clamp(1, 100) as f64;
    let p = budget_pressure.max(P_FLOOR);
    let f = 2f64.powf((imp - 50.0) / D);
    let h = (H50 * f) / p;
    a / h
}

/// The curve's tier (1..=5, 5 archived), ignoring archive protection.
pub(super) fn tier(compartment_index: u32, importance: i32, budget_pressure: f64) -> u8 {
    let z = z_value(compartment_index, importance, budget_pressure);
    if z < Z1 {
        1
    } else if z < Z2 {
        2
    } else if z < Z3 {
        3
    } else if z < Z4 {
        4
    } else {
        5
    }
}

pub(super) fn should_archive(
    compartment_index: u32,
    importance: i32,
    budget_pressure: f64,
    anchor_overlap: f64,
) -> bool {
    let z = z_value(compartment_index, importance, budget_pressure);
    z >= Z4 + G * anchor_overlap.clamp(0.0, 1.0)
}

/// Archived compartments return 5; others render at most P4.
pub(super) fn rendered_tier(
    compartment_index: u32,
    importance: i32,
    budget_pressure: f64,
    anchor_overlap: f64,
) -> u8 {
    if should_archive(
        compartment_index,
        importance,
        budget_pressure,
        anchor_overlap,
    ) {
        return 5;
    }
    tier(compartment_index, importance, budget_pressure).min(4)
}

/// `(index from newest, importance)` of one summary.
pub(super) struct DecayInput {
    pub index: u32,
    pub importance: i32,
}

/// Budget pressure for a render pass: the natural cost at pressure 1 over the
/// budget.
pub(super) fn compute_budget_pressure(compartments: &[DecayInput], history_budget: f64) -> f64 {
    if history_budget <= 0.0 {
        return 1.0;
    }
    let mut natural_cost = 0.0;
    for c in compartments {
        let natural_tier = tier(c.index, c.importance, 1.0);
        if natural_tier < 5 {
            natural_cost += TIER_COST[natural_tier as usize] as f64;
        }
    }
    (natural_cost / history_budget).max(P_FLOOR)
}

/// The curve's tier for each compartment. Legacy rows keep their fixed tier
/// and are left out of the pressure inputs.
fn compute_tiers(compartments: &[DecayRenderCompartment], history_budget: f64) -> Vec<u8> {
    let v2_indices: Vec<usize> = compartments
        .iter()
        .enumerate()
        .filter(|(_, c)| c.legacy != Some(1))
        .map(|(i, _)| i)
        .collect();
    let v2_total = v2_indices.len();
    let mut curve_index_by_original = std::collections::HashMap::new();
    let mut curve_inputs = Vec::with_capacity(v2_total);
    for (v2_ordinal, &original_index) in v2_indices.iter().enumerate() {
        let curve_index = (v2_total - v2_ordinal) as u32;
        curve_index_by_original.insert(original_index, curve_index);
        curve_inputs.push(DecayInput {
            index: curve_index,
            importance: compartments[original_index]
                .importance
                .unwrap_or(50)
                .clamp(1, 100),
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

/// A summary at one of the curve's tiers; its tier 5 renders nothing.
fn text_at(c: &DecayRenderCompartment, tier: u8) -> String {
    if tier >= 5 {
        String::new()
    } else {
        render_one_compartment(c, tier)
    }
}

/// The released renderer: the curve's tiers, then demotion oldest-first
/// while the summed pieces, then the joined body, are over the budget. A
/// budget of zero or less renders the curve at pressure 1 with no guard.
/// Returns the body and, for each shown summary, its input index, tier and
/// tokens.
pub(crate) fn render(
    compartments: &[DecayRenderCompartment],
    history_budget_tokens: f64,
    estimate_tokens: impl Fn(&str) -> usize,
) -> (String, Vec<(usize, u8, u64)>) {
    let indices: Vec<usize> = compartments
        .iter()
        .enumerate()
        .filter(|(_, c)| !c.is_no_content())
        .map(|(i, _)| i)
        .collect();
    let compartments: Vec<DecayRenderCompartment> =
        indices.iter().map(|&i| compartments[i].clone()).collect();
    if compartments.is_empty() {
        return (String::new(), Vec::new());
    }
    let mut tiers = compute_tiers(&compartments, history_budget_tokens);
    let mut tokens: std::collections::HashMap<(usize, u8), usize> = Default::default();
    let mut count = |i: usize, tier: u8| {
        *tokens.entry((i, tier)).or_insert_with(|| {
            let text = text_at(&compartments[i], tier);
            if text.is_empty() {
                0
            } else {
                estimate_tokens(&text)
            }
        })
    };
    let join = |tiers: &[u8]| {
        tiers
            .iter()
            .enumerate()
            .map(|(i, &tier)| text_at(&compartments[i], tier))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    if history_budget_tokens > 0.0 {
        let mut running: i64 = (0..tiers.len()).map(|i| count(i, tiers[i]) as i64).sum();
        let mut guard = compartments.len() * 5;
        let mut oldest = 0usize;
        let mut demote = |tiers: &mut [u8], running: &mut i64| {
            while oldest < tiers.len() && tiers[oldest] >= 5 {
                oldest += 1;
            }
            let Some(tier) = tiers.get(oldest).copied() else {
                return false;
            };
            *running += count(oldest, tier + 1) as i64 - count(oldest, tier) as i64;
            tiers[oldest] = tier + 1;
            true
        };
        while running as f64 > history_budget_tokens && guard > 0 {
            if !demote(&mut tiers, &mut running) {
                break;
            }
            guard -= 1;
        }
        let mut body = join(&tiers);
        while estimate_tokens(&body) as f64 > history_budget_tokens && guard > 0 {
            if !demote(&mut tiers, &mut running) {
                break;
            }
            guard -= 1;
            body = join(&tiers);
        }
    }
    let items = (0..compartments.len())
        .filter_map(|i| {
            let text = text_at(&compartments[i], tiers[i]);
            (!text.is_empty()).then(|| (indices[i], tiers[i], estimate_tokens(&text) as u64))
        })
        .collect();
    (join(&tiers), items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::summary::render::tests::{RawComp, RenderGolden};
    use serde::Deserialize;
    use sha2::{Digest, Sha256};

    fn body(
        compartments: &[DecayRenderCompartment],
        budget: f64,
        estimate: impl Fn(&str) -> usize,
    ) -> String {
        render(compartments, budget, estimate).0
    }

    #[derive(Deserialize)]
    struct TierCase {
        index: u32,
        importance: i32,
        pressure: f64,
        tier: u8,
        archived: bool,
        rendered: u8,
    }
    #[derive(Deserialize)]
    struct PressureCase {
        importances: Vec<i32>,
        budget: f64,
        one_pass: f64,
    }
    #[derive(Deserialize)]
    struct Golden {
        tier_cases: Vec<TierCase>,
        pressure_cases: Vec<PressureCase>,
    }

    #[test]
    fn decay_golden_matches_reference() {
        // The curve's tiers and pressure against the TypeScript reference grid
        // (`crates_old/mc-core/testdata/gen-golden.ts`).
        let raw = include_str!("../../testdata/decay-golden.json");
        let golden: Golden = serde_json::from_str(raw).expect("parse decay-golden.json");
        assert!(!golden.tier_cases.is_empty(), "empty tier grid");
        for c in &golden.tier_cases {
            assert_eq!(tier(c.index, c.importance, c.pressure), c.tier);
            assert_eq!(
                should_archive(c.index, c.importance, c.pressure, 0.0),
                c.archived
            );
            assert_eq!(
                rendered_tier(c.index, c.importance, c.pressure, 0.0),
                c.rendered
            );
        }
        for c in &golden.pressure_cases {
            let comps: Vec<DecayInput> = c
                .importances
                .iter()
                .enumerate()
                .map(|(i, &imp)| DecayInput {
                    index: (i + 1) as u32,
                    importance: imp,
                })
                .collect();
            let one = compute_budget_pressure(&comps, c.budget);
            assert!((one - c.one_pass).abs() < 1e-9);
        }
    }

    #[test]
    fn multi_summary_render_golden_matches_reference() {
        // The render golden's cases with more than one summary, which the
        // curve decides. The single-summary cases run against the live
        // renderer in `render.rs`.
        let raw = include_str!("../../testdata/render-golden.json");
        let golden: RenderGolden = serde_json::from_str(raw).expect("parse render-golden.json");
        let mut checked = 0;
        for (n, case) in golden.cases.iter().enumerate() {
            if case.forced_tier.is_some() || case.compartments.len() < 2 {
                continue;
            }
            let comps: Vec<_> = case.compartments.iter().map(RawComp::to_render).collect();
            assert_eq!(
                Some(&body(&comps, case.budget, |_| 0)),
                case.body.as_ref(),
                "render mismatch in case {n}"
            );
            checked += 1;
        }
        assert_eq!(checked, 3);
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
            serde_json::from_str(include_str!("../../testdata/decay-store-shape.json"))
                .expect("parse redacted store shape");
        assert_eq!(shape.compartments.len(), 388);
        let compartments: Vec<_> = shape.compartments.iter().map(RawComp::to_render).collect();
        let differential: DifferentialFixture =
            serde_json::from_str(include_str!("../../testdata/decay-store-differential.json"))
                .expect("parse TS differential table");
        assert_eq!(differential.cases.len(), 4);

        for case in &differential.cases {
            let (text, items) = render(&compartments, case.budget, mc_tokenizer::estimate_tokens);
            assert_eq!(
                mc_tokenizer::estimate_tokens(&text),
                case.ts_cost,
                "token cost drift at budget {}",
                case.budget
            );
            let digest = Sha256::digest(text.as_bytes());
            let hash = digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            assert_eq!(
                hash, case.body_sha256,
                "byte drift at budget {}",
                case.budget
            );
            // Each summary's tier is the first whose rendering is its section,
            // as the TypeScript fixture counted them.
            assert!(items.len() <= compartments.len());
            let sections: Vec<&str> = if text.is_empty() {
                Vec::new()
            } else {
                text.split("\n\n").collect()
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
                    .copied()
                    .unwrap_or("");
                let selected = (1..=5u8)
                    .find(|&tier| text_at(compartment, tier) == section)
                    .unwrap_or(5);
                tier_counts[selected as usize - 1] += 1;
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
        // Budgets tight enough that the TypeScript renderer demoted
        // summaries oldest-first, counted with the real estimator.
        let raw = include_str!("../../testdata/render-tight-golden.json");
        let golden: RenderGolden = serde_json::from_str(raw).expect("parse render-tight-golden");
        assert!(!golden.cases.is_empty(), "empty tight render golden");
        for (n, case) in golden.cases.iter().enumerate() {
            let comps: Vec<_> = case.compartments.iter().map(RawComp::to_render).collect();
            assert_eq!(
                Some(&body(&comps, case.budget, mc_tokenizer::estimate_tokens)),
                case.body.as_ref(),
                "tight render mismatch in case {n} (budget {})",
                case.budget
            );
        }
    }
}
