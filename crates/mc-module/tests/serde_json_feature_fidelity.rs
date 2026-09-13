use std::path::Path;
use std::process::Command;

fn serde_json_feature_tree(edges: &str) -> String {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("mc-module must be inside the Rust workspace");
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let output = Command::new(cargo)
        .current_dir(workspace_root)
        .args([
            "tree",
            "-p",
            "mc-module",
            "--edges",
            edges,
            "-i",
            "serde_json",
        ])
        .output()
        .expect("run cargo tree for serde_json");
    assert!(
        output.status.success(),
        "cargo tree failed for {edges}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("cargo tree output must be UTF-8")
}

#[test]
fn resolved_serde_json_features_keep_release_and_tests_number_faithful() {
    // The D5 fixture once enabled serde_json/arbitrary_precision through a dev-dependency.
    // Cargo then gave tests a number serializer absent from release builds, so guard both graphs.
    for (label, edges) in [
        ("release", "normal,features"),
        ("test", "normal,dev,features"),
    ] {
        let tree = serde_json_feature_tree(edges);
        assert!(
            tree.contains("serde_json v"),
            "missing {label} serde_json graph"
        );
        assert!(
            !tree.contains("serde_json feature \"arbitrary_precision\""),
            "{label} graph enables arbitrary_precision:\n{tree}"
        );
    }
}
