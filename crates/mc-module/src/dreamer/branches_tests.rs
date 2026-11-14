use std::time::Duration;

use super::*;
use crate::dreamer::checkout::tests::{commit_at, git_at, Repo};
use crate::dreamer::checkout::Checkout;

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap()
}

#[test]
fn a_worktree_folder_resolves_to_the_main_checkout() {
    let repo = Repo::on("master", &[("src/lib.rs", "fn main_only() {}\n")]);
    let (_outer, worktree) = repo.worktree("feature");
    std::fs::create_dir_all(worktree.join("src/deep")).unwrap();
    // From the worktree, a folder inside it, and the main checkout itself.
    for folder in [
        worktree.clone(),
        worktree.join("src/deep"),
        repo.path().to_owned(),
    ] {
        let main = main_checkout(&folder).unwrap();
        assert_eq!(canonical(&main), canonical(repo.path()), "{folder:?}");
    }
}

#[test]
fn a_folder_outside_git_or_without_a_main_checkout_stays_as_it_is() {
    let plain = tempfile::tempdir().unwrap();
    assert_eq!(main_checkout(plain.path()).unwrap(), plain.path());
    // A worktree of a bare repository has no main checkout to read.
    let source = Repo::on("master", &[("a.rs", "a\n")]);
    let outer = tempfile::tempdir().unwrap();
    let bare = outer.path().join("bare.git");
    git_at(
        outer.path(),
        &[
            "clone",
            "-q",
            "--bare",
            source.path().to_str().unwrap(),
            "bare.git",
        ],
    );
    let worktree = outer.path().join("wt");
    git_at(
        &bare,
        &[
            "worktree",
            "add",
            "-q",
            worktree.to_str().unwrap(),
            "master",
        ],
    );
    assert_eq!(main_checkout(&worktree).unwrap(), worktree);
}

#[test]
fn live_branches_are_the_default_branch_and_every_worktree_head_once_per_commit() {
    let repo = Repo::on("master", &[("a.rs", "one\n")]);
    let first = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    // A worktree on a branch at the same commit adds no live branch.
    let (_same, _) = repo.worktree("same");
    let (_outer, worktree) = repo.worktree("feature");
    let feature = commit_at(&worktree, &[("a.rs", "two\n")], "feature");
    // A branch no worktree has checked out is not live.
    repo.git(&["branch", "parked"]);
    let refs = Refs::read(repo.path()).unwrap();
    assert_eq!(
        refs.default_branch(),
        Some(("master".into(), first.clone()))
    );
    assert_eq!(refs.main_branch(), Some("master"));
    assert_eq!(refs.tip("feature"), Some(feature.as_str()));
    assert_eq!(refs.tip("parked"), Some(first.as_str()));
    assert_eq!(refs.tip("gone"), None);
    assert_eq!(
        refs.live(),
        [
            LiveBranch {
                name: "master".into(),
                commit: first.clone()
            },
            LiveBranch {
                name: "feature".into(),
                commit: feature.clone()
            },
        ]
    );
    // A detached worktree is live under its commit.
    git_at(&worktree, &["checkout", "-q", "--detach", &first]);
    let (_detached, detached) = repo.worktree("other");
    let third = commit_at(&detached, &[("b.rs", "b\n")], "third");
    git_at(&detached, &["checkout", "-q", "--detach"]);
    let names: Vec<String> = Refs::read(repo.path())
        .unwrap()
        .live()
        .into_iter()
        .map(|branch| branch.name)
        .collect();
    assert_eq!(
        names,
        [
            "master".to_owned(),
            format!("detached at {}", short(&third))
        ]
    );
}

#[test]
fn the_default_branch_is_origins_head_then_a_local_main_or_master() {
    let upstream = Repo::on("trunk", &[("a.rs", "one\n")]);
    let outer = tempfile::tempdir().unwrap();
    git_at(
        outer.path(),
        &["clone", "-q", upstream.path().to_str().unwrap(), "clone"],
    );
    let clone = outer.path().join("clone");
    let trunk = git_at(&clone, &["rev-parse", "HEAD"]).trim().to_owned();
    git_at(&clone, &["checkout", "-q", "-b", "main"]);
    commit_at(&clone, &[("b.rs", "b\n")], "local main");
    // origin's HEAD names trunk, so trunk is the default though main exists.
    let refs = Refs::read(&clone).unwrap();
    assert_eq!(refs.default_branch(), Some(("trunk".into(), trunk.clone())));
    // Without origin's HEAD, a local main is.
    git_at(&clone, &["remote", "set-head", "origin", "--delete"]);
    let main = git_at(&clone, &["rev-parse", "main"]).trim().to_owned();
    assert_eq!(
        Refs::read(&clone).unwrap().default_branch(),
        Some(("main".into(), main))
    );
    // A repository with neither has none.
    let other = Repo::on("work", &[("a.rs", "one\n")]);
    assert_eq!(Refs::read(other.path()).unwrap().default_branch(), None);
}

#[test]
fn a_tree_matches_cited_paths_as_the_checkout_does_with_their_blobs() {
    let repo = Repo::on(
        "master",
        &[
            ("crates/mc-module/src/dreamer/task.rs", "task\n"),
            ("crates/mc-module/src/lib.rs", "lib\n"),
            ("README.md", "readme\n"),
        ],
    );
    let head = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    let tree = Tree::read(repo.path(), &head).unwrap();
    let blob = |path: &str| {
        repo.git(&["rev-parse", &format!("HEAD:{path}")])
            .trim()
            .to_owned()
    };
    let task = tree.matching("dreamer/task.rs:12");
    assert_eq!(
        task.into_iter()
            .map(|(path, object)| (path.to_owned(), object.to_owned()))
            .collect::<Vec<_>>(),
        [(
            "crates/mc-module/src/dreamer/task.rs".to_owned(),
            blob("crates/mc-module/src/dreamer/task.rs")
        )]
    );
    assert_eq!(tree.matching("mc-module/src").len(), 2);
    assert!(tree.matching("src/task.rs").is_empty());
    assert!(tree.matching("/etc/passwd").is_empty());
    assert_eq!(tree.paths().count(), 3);
}

#[test]
fn uncommitted_lists_changed_staged_deleted_and_new_files() {
    let repo = Repo::on(
        "master",
        &[
            ("a.rs", "a\n"),
            ("b.rs", "b\n"),
            ("c.rs", "c\n"),
            ("d.rs", "d\n"),
        ],
    );
    repo.write(&[("a.rs", "a changed\n"), ("new/e.rs", "e\n")]);
    repo.write(&[("b.rs", "b staged\n")]);
    repo.git(&["add", "b.rs"]);
    std::fs::remove_file(repo.path().join("c.rs")).unwrap();
    assert_eq!(
        uncommitted(repo.path()).unwrap(),
        ["a.rs", "b.rs", "c.rs", "new/e.rs"]
            .map(str::to_owned)
            .into()
    );
}

#[test]
fn holds_any_searches_one_commit_for_literal_names() {
    let repo = Repo::on("master", &[("a.rs", "fn kept_name() {}\nlet x = a.b;\n")]);
    let first = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    repo.write(&[("a.rs", "fn other() {}\n")]);
    repo.commit("second");
    let wait = Duration::from_secs(30);
    assert_eq!(
        holds_any(repo.path(), &first, &["kept_name"], wait),
        Ok(true)
    );
    // Literal, not a pattern.
    assert_eq!(holds_any(repo.path(), &first, &["a.c"], wait), Ok(false));
    let head = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    assert_eq!(
        holds_any(repo.path(), &head, &["kept_name", "missing_name"], wait),
        Ok(false)
    );
    assert!(holds_any(repo.path(), &"1".repeat(40), &["kept_name"], wait).is_err());
}

#[test]
fn a_copy_holds_one_commit_reads_its_history_up_to_there_and_is_deleted_when_dropped() {
    let repo = Repo::on("master", &[("src/a.rs", "fn first_name() {}\n")]);
    let first = repo.git(&["rev-parse", "HEAD"]).trim().to_owned();
    repo.write(&[("src/a.rs", "fn second_name() {}\n"), ("src/b.rs", "b\n")]);
    let second = repo.commit("second");
    repo.write(&[("src/a.rs", "fn third_name() {}\n")]);
    repo.commit("third");
    // An uncommitted change in the repository is not in a copy.
    repo.write(&[("src/b.rs", "uncommitted\n")]);
    let copy = Checkout::open_copy(repo.path(), &second).unwrap();
    let folder = copy.root().to_owned();
    assert!(copy.is_copy());
    assert_eq!(copy.head(), Some(second.as_str()));
    assert_eq!(
        std::fs::read_to_string(folder.join("src/a.rs")).unwrap(),
        "fn second_name() {}\n"
    );
    assert_eq!(
        std::fs::read_to_string(folder.join("src/b.rs")).unwrap(),
        "b\n"
    );
    assert_eq!(copy.tracked_file("src/b.rs"), Some("src/b.rs".into()));
    assert!(!folder.join(".git").exists());
    let search = copy.search(
        &["second_name", "third_name"],
        &crate::dreamer::checkout::SEARCH_LIMITS,
    );
    assert_eq!(search.found, [true, false]);
    // History and diffs end at the copied commit.
    let wait = Duration::from_secs(30);
    assert_eq!(copy.text_in_history("first_name", wait), Ok(true));
    assert_eq!(copy.text_in_history("third_name", wait), Ok(false));
    assert_eq!(
        copy.changed_since(&first),
        Some(["src/a.rs".to_owned(), "src/b.rs".to_owned()].into())
    );
    assert_eq!(copy.uncommitted(), Some(Default::default()));
    assert!(copy
        .diff(&first, "src/a.rs")
        .unwrap()
        .contains("+fn second_name() {}"));
    // The repository itself is unchanged.
    assert_eq!(repo.git(&["status", "--porcelain"]).trim(), "M src/b.rs");
    drop(copy);
    assert!(!folder.exists());
}
