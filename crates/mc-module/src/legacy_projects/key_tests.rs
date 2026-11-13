use std::path::Path;
use std::process::{Command, Stdio};

use super::*;

/// `(input, key)` pairs the 0.49 plugin's `resolveProjectIdentity` printed
/// for paths that don't exist, which is its `dir:` fallback of the resolved
/// path (carried over from the 0.49 Rust module's tests).
const DIRECTORY_GOLDEN: &[(&str, &str)] = &[
    ("/work/api", "dir:e02ef1f35c06"),
    ("/work/api/", "dir:e02ef1f35c06"),
    ("/work/./x/../api", "dir:e02ef1f35c06"),
    ("/tmp/n\u{e4}me dir", "dir:93e3ea277593"),
    ("/", "dir:6666cd76f969"),
];

/// The root commit of the fixed repository [`golden_repository`] builds,
/// as the 0.49 plugin resolved it.
pub(crate) const GOLDEN_ROOT_COMMIT: &str = "5dd1e9f0bd6f4800131f7c6887d174ffceac99d6";

/// Run git with a fixed author, dates and no outside configuration, so the
/// same commands make the same commits on every machine.
pub(crate) fn git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_AUTHOR_NAME", "golden")
        .env("GIT_AUTHOR_EMAIL", "golden@example.invalid")
        .env("GIT_COMMITTER_NAME", "golden")
        .env("GIT_COMMITTER_EMAIL", "golden@example.invalid")
        .env("GIT_AUTHOR_DATE", "2001-01-01T00:00:00Z")
        .env("GIT_COMMITTER_DATE", "2001-01-01T00:00:00Z")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_COUNT", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("git runs");
    assert!(status.success(), "git {args:?}");
}

/// A repository whose one commit has a fixed author, date and content, so
/// its root commit is [`GOLDEN_ROOT_COMMIT`].
pub(crate) fn golden_repository(at: &Path) {
    std::fs::create_dir_all(at.join("sub")).unwrap();
    git(at, &["init", "-q", "-b", "main"]);
    std::fs::write(at.join("README"), "golden\n").unwrap();
    git(at, &["add", "README"]);
    git(at, &["commit", "-q", "-m", "golden root"]);
}

#[test]
fn a_folder_outside_any_checkout_keeps_the_plugins_directory_key() {
    for (directory, expected) in DIRECTORY_GOLDEN {
        assert_eq!(
            directory_key(Path::new(directory)),
            *expected,
            "{directory}"
        );
    }
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        without_git(dir.path()),
        Probe::Known(directory_key(dir.path()))
    );
}

#[test]
fn a_checkout_with_history_gets_its_smallest_root_commit_from_git() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    golden_repository(&repo);
    assert_eq!(without_git(&repo), Probe::NeedsGit);
    let expected = format!("git:{GOLDEN_ROOT_COMMIT}");
    assert_eq!(with_git(&repo, GIT_TIMEOUT), Ok(expected.clone()));
    // A subfolder of the checkout has the checkout's key, as in the plugin.
    assert_eq!(with_git(&repo.join("sub"), GIT_TIMEOUT), Ok(expected));
    assert_eq!(
        smallest_root_commit("ffffffff\n  0123abcd \nnot-a-hash\n"),
        Some("0123abcd".to_owned())
    );
}

#[test]
fn a_repository_without_commits_keeps_its_directory_key() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("fresh");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    assert_eq!(without_git(&repo), Probe::Known(directory_key(&repo)));
    // Git says the same when the files alone can't.
    assert_eq!(with_git(&repo, GIT_TIMEOUT), Ok(directory_key(&repo)));
}

#[test]
fn a_checkout_git_cannot_read_has_no_key() {
    let dir = tempfile::tempdir().unwrap();
    let broken = dir.path().join("broken");
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::write(
        broken.join(".git"),
        "gitdir: /nonexistent/legacy-projects-test\n",
    )
    .unwrap();
    assert_eq!(without_git(&broken), Probe::NeedsGit);
    assert!(with_git(&broken, GIT_TIMEOUT).is_err());
}
