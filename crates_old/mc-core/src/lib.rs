//! Magic Context cache-stability core.
//!
//! Origin-agnostic PURE decision layer: the [`CkItem`] trait, the pass
//! [`classify`] function, and re-exports of the shipped `cortexkit-cache-core`
//! types. It performs NO rendering and NO I/O — those belong to the `mc-module`
//! crate that consumes this one. The cache-core itself stays "dumb": it freezes
//! whatever rendered units it is handed and never decides what to freeze.

#![forbid(unsafe_code)]

pub mod decay;

pub use cortexkit_cache_core::{
    Action, CoreState, DurabilityClass, FrozenUnit, PassInput, StepResult,
};

/// A decoded CK conversation item. Origin-agnostic: these items are produced by the
/// outer system (whichever coding-agent harness fed the conversation in); this crate
/// never parses raw provider wire bytes.
pub trait CkItem {
    /// Stable identity. The coverage boundary is expressed as one of these ids.
    fn id(&self) -> &str;
    /// Monotonic absolute ordinal — strictly increasing across the lineage, NEVER
    /// positional (the window start moves; the ordinal does not).
    fn ordinal(&self) -> u64;
    /// Opaque byte-complete rendering of this item.
    fn bytes(&self) -> &str;
    /// Whether this is a module-synthesized block (m0/m1) rather than a real
    /// conversation item. Synthetic items are stripped before boundary/coverage/
    /// tail computation — they must never masquerade as the real boundary. Defaults
    /// to `false` (a real item).
    fn synthetic(&self) -> bool {
        false
    }
}

/// Inputs to [`classify`], all booleans the consuming module computes from the loaded
/// state + the incoming array + its decision inputs. This crate stays blind to the
/// actual frozen units (it never inspects their bytes or keys).
#[derive(Debug, Clone, Default)]
pub struct ClassifierInput {
    /// Has a baseline ever been materialized? False on a fresh session — forces a
    /// bootstrap Hard so a baseline exists before any defer can replay it.
    pub initialized: bool,
    /// EXACTLY one legacy single `"baseline"` frozen unit AND no pending changes (the
    /// shape an earlier single-block version of this code persisted). The ONLY shape
    /// eligible for the destructive clear-then-Hard migration.
    pub is_legacy_baseline: bool,
    /// The frozen set is a valid current shape: EXACTLY one `m0`, EXACTLY one `m1`, and
    /// zero-or-more tail-reduction units (`red:*`). An initialized state that is neither
    /// legacy nor valid (missing `m0`/`m1`, or any other key) is an UNKNOWN shape →
    /// [`PassPlan::Reject`] (never cleared — a destructive clear must never fire on an
    /// unrecognized shape). The module computes this; this crate only carries the bool.
    pub valid_m0m1_shape: bool,
    /// Initialized state with one valid m0 and no m1 can be rebuilt like the TS
    /// `cached_m1_missing` HARD path; it is not an arbitrary unknown shape.
    pub cached_m1_missing: bool,
    /// Render-config (model/system/tool) differs from the persisted one → epoch Hard.
    pub render_config_changed: bool,
    /// A HARD trigger fired (compaction fold / idle-ttl / pressure) — decider-supplied.
    pub hard_fold_requested: bool,
    /// Is the durable boundary id present in the synthetic-stripped live array?
    pub boundary_present: bool,
    /// The prior-pass reconcile flag: an earlier defer lost the boundary (a revert).
    pub reconcile_pending: bool,
    /// The incoming m1 content's digest differs from the frozen m1's digest. A real
    /// delta (content change), computed WITHOUT rendering (a revision compare).
    pub m1_revision_changed: bool,
    /// A NEW tail reduction needs freezing: ∃ a decision whose target is in the live
    /// tail AND not yet in the frozen reduction set. A pure id set-membership check (no
    /// payload digest) — sound because reductions are one-way / immutable-once-frozen,
    /// so a never-before-seen target id is the only "change" that can occur within an
    /// epoch. Coalesces with `m1_revision_changed` into one SOFT (never two busts).
    pub reductions_pending: bool,
    /// True only when this pass is already going to render bytes for an independent
    /// reason. A pending in-session m1 delta is deferred unless this gate is open.
    pub bust_opportunity: bool,
}

/// The routing decision for a pass. Distinguishes a plain Hard from a legacy
/// migration (clear-then-Hard) and from a clean reject (unknown/unsafe state).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PassPlan {
    /// Plain hard fold (bootstrap / epoch / trigger / reconcile-rematerialize).
    Hard,
    /// Legacy single-`"baseline"`-unit state: clear the frozen set, THEN hard fold.
    MigrateHard,
    /// An m1 delta rides at the m1 breakpoint (boundary present).
    Soft,
    /// Defer: replay the frozen bytes verbatim (the cache-core `SoftPlus` action — no
    /// new render, the cached prefix stays byte-identical).
    Defer,
    /// Unknown / unsafe frozen-set shape: clean Error, leave durable state unchanged.
    Reject(&'static str),
}

/// Ordered first-match pass classifier. Hard triggers and the legacy / unknown-shape
/// guards are evaluated BEFORE the soft-delta and defer paths.
///
/// The load-bearing ordering facts (the cache-core `step_*` mechanics referenced are
/// in `cortexkit-cache-core`):
/// - Rules 2 and 2b run right after bootstrap so a destructive clear fires ONLY on the
///   exact legacy single-`"baseline"` shape, and any other unrecognized shape errors
///   instead of being cleared.
/// - Rule 6 (reconcile-clearing defer) runs BEFORE rule 7 (soft-delta): the core's
///   `step_soft` never touches `reconcile_pending`, so a pass with the flag still set
///   must clear it via a `step_defer` first; the deferred m1 delta re-derives next pass.
/// - Rule 7 requires both `boundary_present` and `bust_opportunity`: an in-session signal
///   mismatch is pending work, not itself permission to rewrite provider-visible bytes.
///   `bust_opportunity` is supplied by the module after it identifies an independent render
///   (hard arm, explicit refresh, force/emergency drive, or first reduction application).
///   The boundary-absent delta case therefore falls to rule 8 (defer + set reconcile via
///   `step_defer`); the delta re-derives once reconcile resolves.
pub fn classify(input: &ClassifierInput) -> PassPlan {
    // 1. Bootstrap: no baseline yet → Hard (materialize the first baseline).
    if !input.initialized {
        return PassPlan::Hard;
    }
    // 2. Legacy single-"baseline"-unit state → clear-then-Hard migration.
    if input.is_legacy_baseline {
        return PassPlan::MigrateHard;
    }
    // 2b. A missing m1 is a recoverable cache shape, not an unknown schema.
    if input.cached_m1_missing {
        return PassPlan::Hard;
    }
    // 2c. Any other unrecognized shape → clean Error, NEVER a destructive clear.
    if !input.valid_m0m1_shape {
        return PassPlan::Reject("unknown frozen-set shape");
    }
    // 3. Render-config epoch change → Hard.
    if input.render_config_changed {
        return PassPlan::Hard;
    }
    // 4. A HARD trigger fired → Hard.
    if input.hard_fold_requested {
        return PassPlan::Hard;
    }
    // 5. Reconcile rematerialize: revert removed the boundary, still absent.
    if input.reconcile_pending && !input.boundary_present {
        return PassPlan::Hard;
    }
    // 6. Reconcile CLEARING: boundary returned → defer; step_defer clears the flag.
    if input.reconcile_pending {
        return PassPlan::Defer;
    }
    // 7. A delta rides only when this pass already has an independent bust opportunity.
    //    The two deltas coalesce into ONE Soft: the module's Soft render emits whichever
    //    deltas are active (changed m1 + each newly-frozen reduction) in one rendered set.
    if input.boundary_present
        && input.bust_opportunity
        && (input.m1_revision_changed || input.reductions_pending)
    {
        return PassPlan::Soft;
    }
    // 8. Defer: replay frozen bytes verbatim.
    PassPlan::Defer
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> ClassifierInput {
        ClassifierInput {
            initialized: true,
            valid_m0m1_shape: true,
            boundary_present: true,
            bust_opportunity: true,
            ..Default::default()
        }
    }

    #[test]
    fn bootstrap_when_uninitialized_is_hard() {
        let input = ClassifierInput {
            initialized: false,
            m1_revision_changed: true,
            ..Default::default()
        };
        assert_eq!(classify(&input), PassPlan::Hard);
    }

    #[test]
    fn legacy_baseline_migrates() {
        let input = ClassifierInput {
            is_legacy_baseline: true,
            valid_m0m1_shape: false, // legacy is not m0/m1-valid, but rule 2 wins
            m1_revision_changed: true,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::MigrateHard);
    }

    #[test]
    fn missing_m1_is_rebuilt_as_hard() {
        let input = ClassifierInput {
            cached_m1_missing: true,
            valid_m0m1_shape: false,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Hard);
    }

    #[test]
    fn unknown_shape_rejects_never_clears() {
        let input = ClassifierInput {
            is_legacy_baseline: false,
            valid_m0m1_shape: false,
            m1_revision_changed: true,
            ..base()
        };
        assert!(matches!(classify(&input), PassPlan::Reject(_)));
    }

    #[test]
    fn epoch_change_is_hard() {
        let input = ClassifierInput {
            render_config_changed: true,
            m1_revision_changed: true,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Hard);
    }

    #[test]
    fn hard_fold_requested_is_hard() {
        let input = ClassifierInput {
            hard_fold_requested: true,
            m1_revision_changed: true,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Hard);
    }

    #[test]
    fn reconcile_boundary_absent_rematerializes() {
        let input = ClassifierInput {
            reconcile_pending: true,
            boundary_present: false,
            m1_revision_changed: true,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Hard);
    }

    #[test]
    fn reconcile_boundary_present_defers_to_clear() {
        let input = ClassifierInput {
            reconcile_pending: true,
            boundary_present: true,
            m1_revision_changed: true, // even with a delta, the clearing defer wins
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Defer);
    }

    #[test]
    fn soft_delta_rides_only_with_boundary_present() {
        let present = ClassifierInput {
            boundary_present: true,
            m1_revision_changed: true,
            ..base()
        };
        assert_eq!(classify(&present), PassPlan::Soft);

        // The first-boundary-loss case: boundary absent + delta must DEFER (set
        // reconcile), never Soft (which would bust the m1 breakpoint and strand the flag).
        let absent = ClassifierInput {
            boundary_present: false,
            m1_revision_changed: true,
            reconcile_pending: false,
            ..base()
        };
        assert_eq!(classify(&absent), PassPlan::Defer);
    }

    #[test]
    fn pending_delta_without_bust_opportunity_defers() {
        let input = ClassifierInput {
            m1_revision_changed: true,
            bust_opportunity: false,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Defer);
    }

    #[test]
    fn boundary_present_no_delta_defers() {
        let input = ClassifierInput {
            boundary_present: true,
            m1_revision_changed: false,
            reductions_pending: false,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Defer);
    }

    #[test]
    fn a_new_reduction_rides_a_soft() {
        // a reduction to freeze, no m1 change → still one SOFT
        let input = ClassifierInput {
            boundary_present: true,
            m1_revision_changed: false,
            reductions_pending: true,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Soft);
    }

    #[test]
    fn m1_and_reduction_coalesce_into_one_soft() {
        // both change on one pass → ONE Soft (the module renders both deltas)
        let input = ClassifierInput {
            boundary_present: true,
            m1_revision_changed: true,
            reductions_pending: true,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Soft);
    }

    #[test]
    fn boundary_absent_reduction_defers_never_soft() {
        // a new reduction while the boundary is absent must DEFER (set reconcile),
        // never Soft-bust + strand the flag — same guard as the m1 soft-delta.
        let input = ClassifierInput {
            boundary_present: false,
            m1_revision_changed: true,
            reductions_pending: true,
            reconcile_pending: false,
            ..base()
        };
        assert_eq!(classify(&input), PassPlan::Defer);
    }
}
