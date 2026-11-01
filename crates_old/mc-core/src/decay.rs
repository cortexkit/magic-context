//! Deterministic tier-decay curve.
//!
//! Pure functions that select which paraphrase tier (P1..P4) renders for each
//! compartment of session history, and which compartments archive (P5, not
//! rendered). Tier demotion is byte-deterministic at render time, driven by
//! compartment age, an emitted importance (semantically a *decay rate*), and live
//! budget pressure — no LLM call.
//!
//! This is a faithful port of the council-validated model. The hyperparameters,
//! tier-cost constants, and log-cost boundary values are reproduced exactly from
//! the reference implementation; the model's invariants (age/importance
//! monotonicity, finite demotion even at importance 100, append stability, O(H)
//! render cost, budget self-tuning) hold by the same construction.
//!
//! Determinism note: the cache-stability invariant this layer must satisfy is
//! INTRA-module determinism (same inputs → same tiers → same rendered bytes across
//! passes), which f64 gives for free (same code, same result). Bit-exact agreement
//! with the reference TS is a development cross-check (the `decay_golden` test), not
//! a runtime invariant — in the target, only this implementation renders.

/// Half-life (in compartments) for importance 50 at pressure 1.
pub const H50: f64 = 24.0;
/// Importance points needed to double the half-life (imp 75 → 2×, 100 → 4×).
pub const D: f64 = 25.0;
/// Max extra half-lives of P4 protection from full anchor overlap.
pub const G: f64 = 2.0;

// Log-cost tier boundaries — geometric means of adjacent measured tier costs.
/// P1→P2 boundary.
pub const Z1: f64 = 0.201;
/// P2→P3 boundary.
pub const Z2: f64 = 0.729;
/// P3→P4 boundary.
pub const Z3: f64 = 1.322;
/// P4→P5 (archive candidate) boundary.
pub const Z4: f64 = 2.587;

/// Pressure floor: prevents div-by-zero and caps relaxation at 10×.
pub const P_FLOOR: f64 = 0.1;

/// Per-tier average token cost, indexed by tier number (1..5). Index 0 unused.
pub const TIER_COST: [u32; 6] = [0, 322, 109, 35, 20, 5];

/// A rendered paraphrase tier: 1 (verbose) .. 5 (archived / not rendered).
pub type Tier = u8;

/// A compartment's decay inputs for budget-pressure computation.
#[derive(Debug, Clone, Copy)]
pub struct DecayInput {
    /// 1-based position from newest (1 = newest).
    pub index: u32,
    /// 1..100 emitted importance (decay rate).
    pub importance: i32,
}

#[inline]
fn clamp_importance(importance: i32) -> f64 {
    importance.clamp(1, 100) as f64
}

/// The half-life-scaled age `z = a / H` for a compartment, the quantity compared
/// against the tier boundaries. `a` is the 0-based age, `H = H50 · 2^((imp−50)/D) / p`.
#[inline]
fn z_value(compartment_index: u32, importance: i32, budget_pressure: f64) -> f64 {
    let a = (compartment_index.max(1) - 1) as f64;
    let imp = clamp_importance(importance);
    let p = budget_pressure.max(P_FLOOR);
    let f = 2f64.powf((imp - 50.0) / D);
    let h = (H50 * f) / p;
    a / h
}

/// Which paraphrase tier a compartment renders at, ignoring archive protection.
///
/// `compartment_index` is 1-based from newest (1 = newest); `importance` is 1..100;
/// `budget_pressure` is 0.10..∞ (computed once per pass via [`compute_budget_pressure`]).
pub fn tier(compartment_index: u32, importance: i32, budget_pressure: f64) -> Tier {
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

/// Whether a compartment should archive (P5, not rendered). Anchor overlap extends
/// P4 protection by up to [`G`] half-lives; with `anchor_overlap = 0.0` (the default
/// today, anchors not yet a first-class storage primitive) this reduces to `z >= Z4`.
pub fn should_archive(
    compartment_index: u32,
    importance: i32,
    budget_pressure: f64,
    anchor_overlap: f64,
) -> bool {
    let z = z_value(compartment_index, importance, budget_pressure);
    let o = anchor_overlap.clamp(0.0, 1.0);
    z >= Z4 + G * o
}

/// Final rendered tier combining base tier + archive protection. Archived
/// compartments return 5; non-archived ones render at most P4 (the verbose-to-anchor
/// ladder caps at 4 — P5 is reserved for actual archival).
pub fn rendered_tier(
    compartment_index: u32,
    importance: i32,
    budget_pressure: f64,
    anchor_overlap: f64,
) -> Tier {
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

/// Compute budget pressure for a render pass in a single forward pass. Because
/// `H ∝ 1/p`, the per-tier compartment counts scale as `1/p`, so `C(p) ≈ C(1)/p`;
/// setting `p = C(1)/B` gives `C(p) ≈ B`. Overshoots up to ~30% at very tight
/// budgets (<8K).
pub fn compute_budget_pressure(compartments: &[DecayInput], history_budget: f64) -> f64 {
    if history_budget <= 0.0 {
        return 1.0;
    }
    let mut natural_cost = 0.0;
    for c in compartments {
        let natural_tier = tier(c.index, c.importance, 1.0);
        // Archived compartments render as an empty string, so charging the P5
        // placeholder cost here would create phantom pressure from bytes that never
        // appear in the prompt.
        if natural_tier < 5 {
            natural_cost += TIER_COST[natural_tier as usize] as f64;
        }
    }
    (natural_cost / history_budget).max(P_FLOOR)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    // --- model invariants (hold by construction, independent of the TS oracle) ---

    #[test]
    fn newest_compartment_is_tier_1() {
        // index 1 → a = 0 → z = 0 → tier 1, for any importance/pressure.
        for imp in [1, 50, 100] {
            for p in [0.1, 1.0, 5.0] {
                assert_eq!(tier(1, imp, p), 1);
            }
        }
    }

    #[test]
    fn age_monotonic_demotion() {
        // for fixed importance/pressure, tier is non-decreasing in age.
        let mut prev = 0u8;
        for idx in 1..=400u32 {
            let t = tier(idx, 50, 1.0);
            assert!(t >= prev, "tier decreased with age at idx {idx}");
            prev = t;
        }
    }

    #[test]
    fn importance_protects_against_demotion() {
        // higher importance → same-or-lower tier (more protection) at fixed age/pressure.
        for idx in [10u32, 50, 200] {
            let lo = tier(idx, 10, 1.0);
            let hi = tier(idx, 90, 1.0);
            assert!(hi <= lo, "higher importance demoted faster at idx {idx}");
        }
    }

    #[test]
    fn pressure_accelerates_demotion() {
        for idx in [10u32, 50, 200] {
            let lo = tier(idx, 50, 0.5);
            let hi = tier(idx, 50, 4.0);
            assert!(hi >= lo, "higher pressure protected more at idx {idx}");
        }
    }

    #[test]
    fn finite_demotion_at_max_importance() {
        // even importance 100 archives eventually (finite half-life) — no immortal row.
        assert!(should_archive(100_000, 100, 1.0, 0.0));
    }

    #[test]
    fn rendered_tier_caps_at_four_unless_archived() {
        for idx in 1..=500u32 {
            let rt = rendered_tier(idx, 50, 1.0, 0.0);
            assert!(rt == 5 || rt <= 4);
        }
    }

    #[test]
    fn pressure_self_tunes_toward_budget() {
        let comps: Vec<DecayInput> = (1..=200)
            .map(|i| DecayInput {
                index: i,
                importance: 50,
            })
            .collect();
        // tighter budget → higher pressure.
        let loose = compute_budget_pressure(&comps, 20_000.0);
        let tight = compute_budget_pressure(&comps, 2_000.0);
        assert!(tight > loose);
        assert!(loose >= P_FLOOR);
    }

    // --- differential golden grid vs the reference TS (development cross-check) ---

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
        // The fixture is generated by the co-located gen-golden.ts (the TS reference,
        // `bun crates/mc-core/testdata/gen-golden.ts`). Exact match expected across the
        // grid; a divergence flags a port error (or, rarely, a last-ULP boundary case —
        // investigate, don't auto-tolerate).
        let raw = include_str!("../testdata/decay-golden.json");
        let golden: Golden = serde_json::from_str(raw).expect("parse decay-golden.json");
        assert!(!golden.tier_cases.is_empty(), "empty tier grid");

        for c in &golden.tier_cases {
            assert_eq!(
                tier(c.index, c.importance, c.pressure),
                c.tier,
                "tier mismatch at idx={} imp={} p={}",
                c.index,
                c.importance,
                c.pressure
            );
            assert_eq!(
                should_archive(c.index, c.importance, c.pressure, 0.0),
                c.archived,
                "archive mismatch at idx={} imp={} p={}",
                c.index,
                c.importance,
                c.pressure
            );
            assert_eq!(
                rendered_tier(c.index, c.importance, c.pressure, 0.0),
                c.rendered,
                "rendered mismatch at idx={} imp={} p={}",
                c.index,
                c.importance,
                c.pressure
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
            assert!(
                (one - c.one_pass).abs() < 1e-9,
                "one-pass pressure mismatch: rust={one} ts={} budget={}",
                c.one_pass,
                c.budget
            );
        }
    }
}
