use std::path::{Path, PathBuf};

pub fn root(workspace: &Path) -> PathBuf {
    std::env::var_os("MC_TEST_SUBCONSCIOUS_SOURCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            workspace
                .parent()
                .expect("workspace has a parent")
                .join("subconscious")
        })
}

pub fn available(workspace: &Path) -> bool {
    available_at(
        &root(workspace),
        std::env::var_os("MC_TEST_SUBCONSCIOUS_SOURCE").is_some(),
    )
}

fn available_at(sibling: &Path, required: bool) -> bool {
    if sibling.join("Cargo.toml").is_file() {
        true
    } else {
        assert!(
            !required,
            "MC_TEST_SUBCONSCIOUS_SOURCE requires a checkout at {}",
            sibling.display()
        );
        eprintln!(
            "SKIP real-daemon test: sibling subconscious checkout is missing at {}",
            sibling.display()
        );
        false
    }
}

#[test]
fn missing_checkout_skips_but_a_present_checkout_runs() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("magic-context");
    std::fs::create_dir(&workspace).unwrap();
    let sibling = root.path().join("subconscious");
    assert!(!available_at(&sibling, false));
    std::fs::create_dir(&sibling).unwrap();
    std::fs::write(sibling.join("Cargo.toml"), "[workspace]\n").unwrap();
    assert!(available_at(&sibling, false));
    assert!(available_at(&sibling, true));
}

#[test]
#[should_panic(expected = "MC_TEST_SUBCONSCIOUS_SOURCE requires a checkout")]
fn explicitly_required_missing_checkout_fails() {
    let root = tempfile::tempdir().unwrap();
    available_at(&root.path().join("missing"), true);
}
