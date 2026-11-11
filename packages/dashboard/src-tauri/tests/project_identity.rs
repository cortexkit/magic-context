#[path = "support/isolated_home.rs"]
mod isolated_home;
use isolated_home::isolated_home;

use std::path::{Path, PathBuf};

use magic_context_dashboard_lib::project_identity::{
    logical_absolute, normalize_stored_project_path,
};
use serde::Deserialize;

fn expected_dir_identity(path: &Path) -> String {
    let digest = md5::compute(path.to_string_lossy().as_bytes());
    let hex = format!("{digest:x}");
    format!("dir:{}", &hex[..12])
}

#[test]
#[cfg(unix)]
fn logical_absolute_matches_node_path_resolve_matrix() {
    isolated_home();
    let cwd = Path::new("/tmp/cwd/project");
    let cases = [
        ("/foo/bar", "/foo/bar"),
        ("/foo/../bar", "/bar"),
        ("./baz", "/tmp/cwd/project/baz"),
        ("foo/bar", "/tmp/cwd/project/foo/bar"),
        ("/", "/"),
        ("/..", "/"),
        ("../sibling", "/tmp/cwd/sibling"),
        ("foo/./bar//baz/", "/tmp/cwd/project/foo/bar/baz"),
    ];

    for (input, expected) in cases {
        assert_eq!(
            logical_absolute(Path::new(input), cwd),
            PathBuf::from(expected)
        );
    }
}

#[test]
fn normalize_stored_project_path_preserves_identity_values() {
    isolated_home();
    assert_eq!(normalize_stored_project_path("git:abc123"), "git:abc123");
    assert_eq!(
        normalize_stored_project_path("dir:deadbeef0000"),
        "dir:deadbeef0000"
    );
    assert_eq!(
        normalize_stored_project_path("pj-dashboard-editor").as_bytes(),
        b"pj-dashboard-editor"
    );
}

#[test]
fn normalize_stored_project_path_hashes_raw_paths_as_directory_fallback() {
    isolated_home();
    let dir = tempfile::tempdir().expect("tempdir");
    assert_eq!(
        normalize_stored_project_path(dir.path().to_str().expect("utf8 tempdir")),
        expected_dir_identity(dir.path())
    );
}

#[derive(Deserialize)]
struct ParityFixture {
    input: String,
    resolved: String,
    identity: String,
}

#[test]
#[cfg(unix)]
fn cross_language_identity_parity_fixture_matches_directory_fallback_contract() {
    isolated_home();
    // Fixture outputs are generated from the TypeScript production contract for
    // non-git directories: path.resolve(input), then MD5 over the resolved path
    // string truncated to 12 hex characters.
    let cases: Vec<ParityFixture> =
        serde_json::from_str(include_str!("fixtures/project_identity_parity.json"))
            .expect("parse parity fixture");

    for case in cases {
        assert_eq!(
            logical_absolute(Path::new(&case.input), Path::new("/ignored")),
            PathBuf::from(&case.resolved)
        );
        assert_eq!(normalize_stored_project_path(&case.input), case.identity);
    }
}
