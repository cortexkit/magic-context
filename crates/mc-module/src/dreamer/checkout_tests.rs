use std::path::Path;
use std::process::Command;
use std::time::Duration;

use super::*;

/// A git repository in a temporary folder, for tests that need a checkout.
pub(crate) struct Repo {
    pub dir: tempfile::TempDir,
}

impl Repo {
    /// A repository whose first commit holds `files` (path, text).
    pub(crate) fn new(files: &[(&str, &str)]) -> Self {
        let repo = Self {
            dir: tempfile::tempdir().unwrap(),
        };
        repo.git(&["init", "-q"]);
        repo.write(files);
        repo.commit("first");
        repo
    }

    pub(crate) fn path(&self) -> &Path {
        self.dir.path()
    }

    pub(crate) fn git(&self, args: &[&str]) -> String {
        let output = Command::new("git")
            .args([
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(self.path())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    pub(crate) fn write(&self, files: &[(&str, &str)]) {
        for (path, text) in files {
            let full = self.path().join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, text).unwrap();
        }
    }

    /// Commit everything in the working tree; the new commit's id.
    pub(crate) fn commit(&self, message: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "--allow-empty", "-m", message]);
        self.git(&["rev-parse", "HEAD"]).trim().to_owned()
    }

    /// Commit `files` (path, text), then delete them in a later commit, so
    /// the history holds them and the working tree does not.
    pub(crate) fn add_then_remove(&self, files: &[(&str, &str)]) {
        self.write(files);
        self.commit("add");
        for (path, _) in files {
            std::fs::remove_file(self.path().join(path)).unwrap();
        }
        self.commit("remove");
    }

    pub(crate) fn checkout(&self) -> Checkout {
        Checkout::open(self.path()).unwrap()
    }
}

#[test]
fn a_checkout_lists_tracked_files_and_finds_cited_paths_by_their_tail() {
    let repo = Repo::new(&[
        (
            "crates/mc-module/src/dreamer/task.rs",
            "pub trait Task {}\n",
        ),
        ("README.md", "readme\n"),
    ]);
    repo.write(&[("untracked.rs", "fn untracked() {}\n")]);
    let checkout = repo.checkout();
    assert_eq!(
        checkout.head(),
        Some(repo.git(&["rev-parse", "HEAD"]).trim())
    );
    for present in [
        "crates/mc-module/src/dreamer/task.rs",
        "dreamer/task.rs",
        "./src/dreamer/task.rs:12",
        "task.rs#L4",
        "crates/mc-module/",
        "mc-module/src",
        "README.md",
    ] {
        assert_eq!(checkout.has_path(present), Some(true), "{present}");
    }
    // An untracked file, a path that only shares a name's end, and a moved
    // file are not there.
    for absent in [
        "untracked.rs",
        "ask.rs",
        "src/task.rs",
        "crates/mc-store/src/dreamer/task.rs",
    ] {
        assert_eq!(checkout.has_path(absent), Some(false), "{absent}");
    }
    for no_path in [
        "/etc/passwd",
        "~/notes.md",
        "https://x.io/a.rs",
        "a/../b.rs",
        "",
    ] {
        assert_eq!(checkout.has_path(no_path), None, "{no_path}");
    }
    assert_eq!(
        checkout.tracked_file("./crates/mc-module/src/dreamer/task.rs"),
        Some("crates/mc-module/src/dreamer/task.rs".into())
    );
    assert_eq!(checkout.tracked_file("untracked.rs"), None);
    assert_eq!(checkout.tracked_file("crates/mc-module"), None);
}

#[test]
fn the_top_level_is_every_tracked_paths_first_part_and_cortexkit() {
    let repo = Repo::new(&[
        ("crates/a/src/lib.rs", "\n"),
        ("docs/guide.md", "\n"),
        ("README.md", "\n"),
    ]);
    repo.write(&[("untracked/x.rs", "\n")]);
    assert_eq!(
        repo.checkout()
            .top_level()
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [".cortexkit", "README.md", "crates", "docs"]
    );
}

#[test]
fn the_history_holds_what_some_commit_added_or_removed() {
    let repo = Repo::new(&[("src/live.rs", "fn live_name() {}\n")]);
    repo.add_then_remove(&[("crates/old/src/dreamer/gone.rs", "fn removed_name() {}\n")]);
    let checkout = repo.checkout();
    let wait = Duration::from_secs(30);
    for removed in [
        "crates/old/src/dreamer/gone.rs",
        "dreamer/gone.rs",
        "./src/dreamer/gone.rs:4",
        "crates/old",
        "old/src/",
    ] {
        assert_eq!(
            checkout.path_in_history(removed, wait),
            Ok(true),
            "{removed}"
        );
    }
    for never in ["src/gone.rs", "ask.rs", "crates/new", "old/sr", "gone.rs*"] {
        assert_eq!(checkout.path_in_history(never, wait), Ok(false), "{never}");
    }
    assert!(checkout.path_in_history("/etc/passwd", wait).is_err());
    assert_eq!(checkout.text_in_history("removed_name", wait), Ok(true));
    assert_eq!(checkout.text_in_history("live_name", wait), Ok(true));
    assert_eq!(checkout.text_in_history("never_name", wait), Ok(false));
    // The text is literal, not a pattern.
    assert_eq!(checkout.text_in_history("removed_.ame", wait), Ok(false));
    // A lookup that runs past its time is killed and tells no answer.
    let timed_out = checkout.text_in_history("removed_name", Duration::ZERO);
    assert!(
        timed_out
            .as_ref()
            .is_err_and(|why| why.contains("timed out")),
        "{timed_out:?}"
    );
}

#[cfg(unix)]
#[test]
fn a_tracked_symlink_out_of_the_checkout_is_neither_a_mapping_nor_searched() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(
        outside.path().join("secret.rs"),
        "fn outside_only_name() {}\n",
    )
    .unwrap();
    let repo = Repo::new(&[("inside.rs", "fn inside_name() {}\n")]);
    std::os::unix::fs::symlink(
        outside.path().join("secret.rs"),
        repo.path().join("link.rs"),
    )
    .unwrap();
    repo.commit("link");
    let checkout = repo.checkout();
    assert_eq!(checkout.has_path("link.rs"), Some(true));
    assert_eq!(checkout.tracked_file("link.rs"), None);
    let search = checkout.search(&["outside_only_name", "inside_name"], &SEARCH_LIMITS);
    assert_eq!(search.found, [false, true]);
    assert!(!search.cut);
}

#[test]
fn a_search_finds_overlapping_names_and_names_in_paths() {
    let repo = Repo::new(&[
        ("src/a.rs", "let abcdef = 1;\n"),
        ("src/verify_host_helper.rs", "\n"),
        ("src/b.rs", "nothing here\n"),
    ]);
    let checkout = repo.checkout();
    // `abcd` and `bcdef` overlap inside `abcdef`; `verify_host` is only a
    // file's name; `ab` is too short to count as missing.
    let search = checkout.search(
        &["abcd", "bcdef", "verify_host", "missing_name", "ab"],
        &SEARCH_LIMITS,
    );
    assert_eq!(search.found, [true, true, true, false, true]);
    assert!(!search.cut);
    assert_eq!(search.files, 3);
}

#[test]
fn a_search_stopped_by_its_limits_says_it_was_cut() {
    let repo = Repo::new(&[("a.rs", "first\n"), ("b.rs", "needle_name\n")]);
    let checkout = repo.checkout();
    let by_files = checkout.search(
        &["needle_name"],
        &Limits {
            max_files: 1,
            max_time: Duration::from_secs(60),
        },
    );
    assert_eq!(
        (by_files.found.as_slice(), by_files.files, by_files.cut),
        (&[false][..], 1, true)
    );
    let by_time = checkout.search(
        &["needle_name"],
        &Limits {
            max_files: 100,
            max_time: Duration::ZERO,
        },
    );
    assert_eq!(
        (by_time.found.as_slice(), by_time.cut),
        (&[false][..], true)
    );
    // A search that found everything before its limit is complete.
    let found = checkout.search(&["needle_name"], &SEARCH_LIMITS);
    assert_eq!((found.found.as_slice(), found.cut), (&[true][..], false));
}

#[test]
fn changes_since_a_commit_include_the_working_tree() {
    let repo = Repo::new(&[("a.rs", "one\n"), ("b.rs", "two\n"), ("c.rs", "three\n")]);
    let first = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    repo.write(&[("a.rs", "one changed\n")]);
    repo.commit("second");
    repo.write(&[("b.rs", "two, not committed\n")]);
    let checkout = repo.checkout();
    assert_eq!(
        checkout.changed_since(&first),
        Some(["a.rs".to_owned(), "b.rs".to_owned()].into())
    );
    assert_eq!(checkout.uncommitted(), Some(["b.rs".to_owned()].into()));
    let diff = checkout.diff(&first, "a.rs").unwrap();
    assert!(diff.contains("-one\n+one changed\n"), "{diff}");
    assert_eq!(checkout.changed_since(&"0".repeat(40)), None);
    assert_eq!(
        checkout.changed_since("HEAD"),
        None,
        "only a commit id is passed to git"
    );
    assert!(checkout.last_commit_ms("a.rs").unwrap() > 0);
    assert_eq!(checkout.last_commit_ms("nowhere.rs"), None);
}

#[test]
fn a_folder_without_git_is_no_checkout() {
    let dir = tempfile::tempdir().unwrap();
    assert!(Checkout::open(dir.path()).is_err());
    assert!(Checkout::open(&dir.path().join("missing")).is_err());
}

#[test]
fn a_cited_path_is_cleaned_of_line_references() {
    assert_eq!(clean_path("src\\a.rs:10:2"), Some("src/a.rs".into()));
    assert_eq!(clean_path("./src/"), Some("src".into()));
    assert_eq!(clean_path("a.rs#L1-L4"), Some("a.rs".into()));
    assert_eq!(clean_path("src//a.rs"), None);
}
