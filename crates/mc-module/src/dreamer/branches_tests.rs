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
fn a_worktree_head_the_default_branch_already_contains_is_not_live() {
    let repo = Repo::on("master", &[("a.rs", "one\n")]);
    // A side checkout left on the first commit while master moved on.
    let (_old, old) = repo.worktree("old");
    let first = git_at(&old, &["rev-parse", "HEAD"]).trim().to_owned();
    let second = commit_at(repo.path(), &[("a.rs", "two\n")], "second");
    // A branch with a commit of its own stays live.
    let (_outer, feature) = repo.worktree("feature");
    let own = commit_at(&feature, &[("a.rs", "three\n")], "own");
    let refs = Refs::read(repo.path()).unwrap();
    // The default branch comes first; git lists linked worktrees in no
    // fixed order, so the rest compare as sets.
    let commits = |live: Vec<LiveBranch>| {
        let mut rest: Vec<String> = live.iter().skip(1).map(|b| b.commit.clone()).collect();
        rest.sort();
        (live[0].commit.clone(), rest)
    };
    let mut expected = vec![first.clone(), own.clone()];
    expected.sort();
    assert_eq!(commits(refs.live()), (second.clone(), expected));
    assert_eq!(
        commits(refs.live_in(repo.path()).unwrap()),
        (second, vec![own])
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
fn a_tree_lists_each_file_of_its_commit_with_its_blob() {
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
    for path in ["crates/mc-module/src/dreamer/task.rs", "README.md"] {
        assert_eq!(tree.blob(path).map(str::to_owned), Some(blob(path)));
    }
    // Only a file's whole path from the top names it.
    assert_eq!(tree.blob("dreamer/task.rs"), None);
    assert_eq!(tree.blob("crates/mc-module/src"), None);
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

/// Worktrees inside the CortexKit data root (agents' task checkouts,
/// verification and deploy copies) are no live branch, whatever commits they
/// have. The main checkout always is, and a sibling folder whose name only
/// starts like the root's is not inside it.
#[test]
fn worktrees_inside_the_cortexkit_data_root_are_not_live() {
    let repo = Repo::on("master", &[("a.rs", "one\n")]);
    let data = tempfile::tempdir().unwrap();
    let root = data.path().join("cortexkit");
    let add = |path: &Path, branch: &str| {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        git_at(
            repo.path(),
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                branch,
                path.to_str().unwrap(),
            ],
        );
        let text = format!("{branch}\n");
        commit_at(path, &[("a.rs", text.as_str())], branch);
    };
    add(&root.join("alfonso/worktrees/task"), "task");
    add(&data.path().join("cortexkit-scratch/wt"), "scratch");
    let (_outer, feature) = repo.worktree("feature");
    commit_at(&feature, &[("a.rs", "feature\n")], "feature");
    let refs = Refs::read(repo.path()).unwrap();
    let live = |refs: &Refs, root: Option<&Path>| -> Vec<String> {
        let mut names: Vec<String> = refs
            .live_outside(repo.path(), root)
            .unwrap()
            .into_iter()
            .map(|branch| branch.name)
            .collect();
        names.sort();
        names
    };
    assert_eq!(live(&refs, Some(&root)), ["feature", "master", "scratch"]);
    // With the data root elsewhere every head with commits of its own counts.
    assert_eq!(
        live(&refs, Some(&data.path().join("elsewhere"))),
        ["feature", "master", "scratch", "task"]
    );
    assert_eq!(live(&refs, None), ["feature", "master", "scratch", "task"]);
    // The root reached through a symlink still matches.
    #[cfg(unix)]
    {
        let link = data.path().join("link");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        assert_eq!(live(&refs, Some(&link)), ["feature", "master", "scratch"]);
    }
    // The main checkout is never left out, even when it is the root itself.
    git_at(repo.path(), &["checkout", "-q", "-b", "own"]);
    commit_at(repo.path(), &[("b.rs", "own\n")], "own");
    let refs = Refs::read(repo.path()).unwrap();
    assert_eq!(
        live(&refs, Some(repo.path())),
        ["feature", "master", "own", "scratch", "task"]
    );
}

/// A project's tasks run in the main checkout of its sessions' folders that
/// still exist. A folder that is gone is passed over; only when every one is
/// gone is the first returned as it is, for the run's skip to name.
#[test]
fn a_projects_tasks_run_in_the_main_checkout_of_a_folder_that_still_exists() {
    let repo = Repo::on("master", &[("a.rs", "one\n")]);
    let data = tempfile::tempdir().unwrap();
    let root = data.path().join("cortexkit");
    let text = |path: &Path| path.to_str().unwrap().to_owned();
    // An agent's task checkout inside the data root, and a session's own
    // worktree outside it.
    let task = root.join("alfonso/worktrees/task");
    std::fs::create_dir_all(task.parent().unwrap()).unwrap();
    git_at(
        repo.path(),
        &["worktree", "add", "-q", "-b", "task", &text(&task)],
    );
    let (_outer, feature) = repo.worktree("feature");
    let chosen = |roots: &[String]| {
        project_folder_outside(roots, Some(&root)).map(|folder| canonical(Path::new(&folder)))
    };
    let roots = [text(&task), text(&feature)];
    assert_eq!(chosen(&roots), Some(canonical(repo.path())));
    // Once the task checkout is removed, the other folder still leads to
    // the main checkout.
    git_at(
        repo.path(),
        &["worktree", "remove", "--force", &text(&task)],
    );
    assert_eq!(chosen(&roots), Some(canonical(repo.path())));
    // With every folder gone the first comes back as it is.
    let gone = [
        text(&data.path().join("gone-a")),
        text(&data.path().join("gone-b")),
    ];
    assert_eq!(
        project_folder_outside(&gone, Some(&root)),
        Some(gone[0].clone())
    );
    assert_eq!(project_folder_outside(&[], Some(&root)), None);
}

/// Of several main checkouts, one outside the CortexKit data root comes
/// first, then the first by path, whatever order the sessions came in. One
/// inside the root is used only when there is no other.
#[test]
fn a_main_checkout_outside_the_data_root_comes_first_then_the_first_by_path() {
    let data = tempfile::tempdir().unwrap();
    let root = data.path().join("a-cortexkit");
    let repository = |path: PathBuf| {
        std::fs::create_dir_all(&path).unwrap();
        git_at(&path, &["init", "-q"]);
        path
    };
    let inside = repository(root.join("deploy/copy"));
    let b = repository(data.path().join("b"));
    let a = repository(data.path().join("a"));
    let chosen = |roots: &[&PathBuf]| {
        let roots: Vec<String> = roots
            .iter()
            .map(|path| path.to_str().unwrap().to_owned())
            .collect();
        project_folder_outside(&roots, Some(&root)).map(|folder| canonical(Path::new(&folder)))
    };
    assert_eq!(chosen(&[&inside, &b, &a]), Some(canonical(&a)));
    assert_eq!(chosen(&[&b, &inside]), Some(canonical(&b)));
    assert_eq!(chosen(&[&inside]), Some(canonical(&inside)));
    assert_eq!(
        project_folder_outside(
            &[inside.to_str().unwrap().into(), b.to_str().unwrap().into()],
            None
        )
        .map(|folder| canonical(Path::new(&folder))),
        Some(canonical(&inside))
    );
    // The root reached through a symlink still matches.
    #[cfg(unix)]
    {
        let link = data.path().join("link");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        let roots = [
            inside.to_str().unwrap().to_owned(),
            b.to_str().unwrap().to_owned(),
        ];
        assert_eq!(
            project_folder_outside(&roots, Some(&link)).map(|folder| canonical(Path::new(&folder))),
            Some(canonical(&b))
        );
    }
}
