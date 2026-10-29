use super::{Package, Profile, Result};
use std::collections::BTreeMap;

pub(crate) fn packages() -> Vec<Package> {
    static PACKAGES: std::sync::OnceLock<Vec<Package>> = std::sync::OnceLock::new();
    PACKAGES.get_or_init(build_packages).clone()
}

fn build_packages() -> Vec<Package> {
    vec![
        Package::decode(include_bytes!("../../profiles/memory-base/ck.json"), BTreeMap::from([
            ("prompts/categories/boundaries.historian.md".into(), include_bytes!("../../profiles/memory-base/prompts/categories/boundaries.historian.md").to_vec()),
            ("prompts/categories/communication.historian.md".into(), include_bytes!("../../profiles/memory-base/prompts/categories/communication.historian.md").to_vec()),
            ("prompts/categories/identity.historian.md".into(), include_bytes!("../../profiles/memory-base/prompts/categories/identity.historian.md").to_vec()),
            ("prompts/categories/preferences.historian.md".into(), include_bytes!("../../profiles/memory-base/prompts/categories/preferences.historian.md").to_vec()),
            ("prompts/categories/working-style.historian.md".into(), include_bytes!("../../profiles/memory-base/prompts/categories/working-style.historian.md").to_vec()),
            ("prompts/dreamer/review-user-memories/system.md".into(), include_bytes!("../../profiles/memory-base/prompts/dreamer/review-user-memories/system.md").to_vec()),
            ("prompts/dreamer/review-user-memories/user.category-rules.md".into(), include_bytes!("../../profiles/memory-base/prompts/dreamer/review-user-memories/user.category-rules.md").to_vec()),
            ("prompts/dreamer/review-user-memories/user.intro.md".into(), include_bytes!("../../profiles/memory-base/prompts/dreamer/review-user-memories/user.intro.md").to_vec()),
            ("prompts/dreamer/review-user-memories/user.safety-heading.md".into(), include_bytes!("../../profiles/memory-base/prompts/dreamer/review-user-memories/user.safety-heading.md").to_vec()),
            ("prompts/historian/system/anchor-decay.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/anchor-decay.md").to_vec()),
            ("prompts/historian/system/boundary-other-rules.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/boundary-other-rules.md").to_vec()),
            ("prompts/historian/system/categories-intro.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/categories-intro.md").to_vec()),
            ("prompts/historian/system/compartment-boundaries.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/compartment-boundaries.md").to_vec()),
            ("prompts/historian/system/construction-order.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/construction-order.md").to_vec()),
            ("prompts/historian/system/episode-type.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/episode-type.md").to_vec()),
            ("prompts/historian/system/fact-category-definitions.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/fact-category-definitions.md").to_vec()),
            ("prompts/historian/system/fact-routing-test.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/fact-routing-test.md").to_vec()),
            ("prompts/historian/system/facts-general-rules.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/facts-general-rules.md").to_vec()),
            ("prompts/historian/system/how-magic-context-works.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/how-magic-context-works.md").to_vec()),
            ("prompts/historian/system/importance-bands.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/importance-bands.md").to_vec()),
            ("prompts/historian/system/importance-cross-check.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/importance-cross-check.md").to_vec()),
            ("prompts/historian/system/importance-trap.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/importance-trap.md").to_vec()),
            ("prompts/historian/system/inputs.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/inputs.md").to_vec()),
            ("prompts/historian/system/p4-shapes.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/p4-shapes.md").to_vec()),
            ("prompts/historian/system/persona.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/persona.md").to_vec()),
            ("prompts/historian/system/tiers-p1-to-p4.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/tiers-p1-to-p4.md").to_vec()),
            ("prompts/historian/system/tiers-voice-and-cross-tier.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/tiers-voice-and-cross-tier.md").to_vec()),
            ("prompts/historian/system/time-and-certainty.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/time-and-certainty.md").to_vec()),
            ("prompts/historian/system/u-lines.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/u-lines.md").to_vec()),
            ("prompts/historian/system/user-observations-end.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/user-observations-end.md").to_vec()),
            ("prompts/historian/system/user-observations.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/user-observations.md").to_vec()),
            ("prompts/historian/system/what-you-produce.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/what-you-produce.md").to_vec()),
            ("prompts/historian/system/world-experience-split.md".into(), include_bytes!("../../profiles/memory-base/prompts/historian/system/world-experience-split.md").to_vec()),
            ("prompts/main-agent/system.memory-guidance.full.md".into(), include_bytes!("../../profiles/memory-base/prompts/main-agent/system.memory-guidance.full.md").to_vec()),
            ("prompts/main-agent/system.memory-guidance.light.md".into(), include_bytes!("../../profiles/memory-base/prompts/main-agent/system.memory-guidance.light.md").to_vec()),
            ("prompts/main-agent/system.memory-mural-guidance.md".into(), include_bytes!("../../profiles/memory-base/prompts/main-agent/system.memory-mural-guidance.md").to_vec()),
        ])).expect("validated bundled package"),
        Package::decode(include_bytes!("../../profiles/memory-swe/ck.json"), BTreeMap::from([
            ("prompts/categories/architecture.historian.md".into(), include_bytes!("../../profiles/memory-swe/prompts/categories/architecture.historian.md").to_vec()),
            ("prompts/categories/config-values.historian.md".into(), include_bytes!("../../profiles/memory-swe/prompts/categories/config-values.historian.md").to_vec()),
            ("prompts/categories/constraints.historian.md".into(), include_bytes!("../../profiles/memory-swe/prompts/categories/constraints.historian.md").to_vec()),
            ("prompts/categories/dev-environment.historian.md".into(), include_bytes!("../../profiles/memory-swe/prompts/categories/dev-environment.historian.md").to_vec()),
            ("prompts/categories/engineering-practice.historian.md".into(), include_bytes!("../../profiles/memory-swe/prompts/categories/engineering-practice.historian.md").to_vec()),
            ("prompts/categories/naming.historian.md".into(), include_bytes!("../../profiles/memory-swe/prompts/categories/naming.historian.md").to_vec()),
            ("prompts/categories/project-rules.historian.md".into(), include_bytes!("../../profiles/memory-swe/prompts/categories/project-rules.historian.md").to_vec()),
            ("prompts/dreamer/classify-memories/system.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/classify-memories/system.md").to_vec()),
            ("prompts/dreamer/classify-memories/user.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/classify-memories/user.md").to_vec()),
            ("prompts/dreamer/compress-cues/system.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/compress-cues/system.md").to_vec()),
            ("prompts/dreamer/compress-cues/user.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/compress-cues/user.md").to_vec()),
            ("prompts/dreamer/curate/system.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/curate/system.md").to_vec()),
            ("prompts/dreamer/curate/user.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/curate/user.md").to_vec()),
            ("prompts/dreamer/maintain-docs/system.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/maintain-docs/system.md").to_vec()),
            ("prompts/dreamer/maintain-docs/user.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/maintain-docs/user.md").to_vec()),
            ("prompts/dreamer/map-memories/system.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/map-memories/system.md").to_vec()),
            ("prompts/dreamer/map-memories/user.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/map-memories/user.md").to_vec()),
            ("prompts/dreamer/reflect-patterns/gate.system.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/reflect-patterns/gate.system.md").to_vec()),
            ("prompts/dreamer/reflect-patterns/gate.user.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/reflect-patterns/gate.user.md").to_vec()),
            ("prompts/dreamer/reflect-patterns/system.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/reflect-patterns/system.md").to_vec()),
            ("prompts/dreamer/reflect-patterns/user.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/reflect-patterns/user.md").to_vec()),
            ("prompts/dreamer/refresh-primers/system.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/refresh-primers/system.md").to_vec()),
            ("prompts/dreamer/refresh-primers/user.closed-book.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/refresh-primers/user.closed-book.md").to_vec()),
            ("prompts/dreamer/refresh-primers/user.raw.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/refresh-primers/user.raw.md").to_vec()),
            ("prompts/dreamer/review-user-memories/user.swe-categories.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/review-user-memories/user.swe-categories.md").to_vec()),
            ("prompts/dreamer/verify/system.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/verify/system.md").to_vec()),
            ("prompts/dreamer/verify/user.diff-evidence.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/verify/user.diff-evidence.md").to_vec()),
            ("prompts/dreamer/verify-broad/user.md".into(), include_bytes!("../../profiles/memory-swe/prompts/dreamer/verify-broad/user.md").to_vec()),
            ("prompts/events/causal_incident.historian.md".into(), include_bytes!("../../profiles/memory-swe/prompts/events/causal_incident.historian.md").to_vec()),
            ("prompts/events/trajectory_correction.historian.md".into(), include_bytes!("../../profiles/memory-swe/prompts/events/trajectory_correction.historian.md").to_vec()),
            ("prompts/historian/reference-seeds.json".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/reference-seeds.json").to_vec()),
            ("prompts/historian/system/anchor-decay.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/anchor-decay.md").to_vec()),
            ("prompts/historian/system/boundary-other-rules.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/boundary-other-rules.md").to_vec()),
            ("prompts/historian/system/compartment-boundaries.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/compartment-boundaries.md").to_vec()),
            ("prompts/historian/system/episode-type.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/episode-type.md").to_vec()),
            ("prompts/historian/system/event-definitions.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/event-definitions.md").to_vec()),
            ("prompts/historian/system/event-extraction-gates.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/event-extraction-gates.md").to_vec()),
            ("prompts/historian/system/events-intro.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/events-intro.md").to_vec()),
            ("prompts/historian/system/facts-general-rules.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/facts-general-rules.md").to_vec()),
            ("prompts/historian/system/how-magic-context-works.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/how-magic-context-works.md").to_vec()),
            ("prompts/historian/system/importance-bands.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/importance-bands.md").to_vec()),
            ("prompts/historian/system/importance-cross-check.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/importance-cross-check.md").to_vec()),
            ("prompts/historian/system/p4-shapes.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/p4-shapes.md").to_vec()),
            ("prompts/historian/system/persona.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/persona.md").to_vec()),
            ("prompts/historian/system/primer-candidates.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/primer-candidates.md").to_vec()),
            ("prompts/historian/system/tiers-p1-to-p4.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/tiers-p1-to-p4.md").to_vec()),
            ("prompts/historian/system/tiers-voice-and-cross-tier.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/tiers-voice-and-cross-tier.md").to_vec()),
            ("prompts/historian/system/user-observations-swe.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/user-observations-swe.md").to_vec()),
            ("prompts/historian/system/what-you-produce.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/what-you-produce.md").to_vec()),
            ("prompts/historian/system/world-experience-split.md".into(), include_bytes!("../../profiles/memory-swe/prompts/historian/system/world-experience-split.md").to_vec()),
        ])).expect("validated bundled package"),
    ]
}

pub(crate) fn swe() -> Result<Profile> {
    static SWE: std::sync::OnceLock<Result<Profile>> = std::sync::OnceLock::new();
    SWE.get_or_init(|| super::load_chain(&packages())).clone()
}

/// Entorhinal hashes raw ck.json bytes, not a decoded or canonicalized body.
/// Its catalog publish.rs:21-24,61-62 hashes those bytes; record.rs:151-173
/// verifies the hash and byte identity of the archive member before pinning.
pub(crate) fn pin_manifest_digest(package: &Package) -> String {
    super::sha256(&package.ck_bytes)
}
