use cortexkit_doctor::{LogSource, ModuleId};
use cortexkit_log_manifest::{generate, ManifestMetadata};

#[test]
fn every_production_log_has_a_manifest_template() {
    let metadata = ManifestMetadata::new(
        ModuleId::new("magic-context").unwrap(),
        "https://github.com/cortexkit/magic-context",
        vec![LogSource::new("logs/magic-context.*.log").unwrap()],
    );
    let (manifest, skipped) = generate(env!("CARGO_MANIFEST_DIR"), &metadata)
        .unwrap_or_else(|error| panic!("could not generate the ck-mc log manifest: {error}"));
    assert!(!manifest.templates().is_empty());
    assert!(
        skipped.is_empty(),
        "{} ck-mc log calls could not be listed ({} distinct templates listed). \
         Use a fixed sentence as the final string literal, and log runtime values as named fields before it:\n{}",
        skipped.len(),
        manifest.templates().len(),
        skipped.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n"),
    );
}
