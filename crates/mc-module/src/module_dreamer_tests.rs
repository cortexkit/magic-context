//! The folder the dreamer runs a project's tasks in: the main checkout of
//! the repository its sessions' folders are in, chosen again on every round,
//! so a session's folder that was deleted is never used.

use std::path::PathBuf;

use super::*;
use crate::dreamer::checkout::tests::Repo;
use crate::entorhinal_changes::tests::Client;
use crate::route::Project;

fn module() -> Module<Client> {
    Module::new(Client::default(), Settings::default(), None, None)
}

/// Record `session` as one of `project`'s, set up in `root`.
fn record(module: &Module<Client>, session: &str, project: &str, root: &Path) {
    module.inner.session_projects.lock().unwrap().insert(
        SessionRef::new("runner", "mock", session),
        Project {
            id: project.to_owned(),
            root: root.to_str().unwrap().to_owned(),
        },
    );
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap()
}

/// A project whose first session by key worked in an agent's task checkout
/// that has since been removed runs its tasks in the repository's main
/// checkout, found through the folder of a session that still exists.
#[tokio::test]
async fn a_project_runs_in_its_main_checkout_not_in_a_removed_task_checkout() {
    let repo = Repo::on("master", &[("a.rs", "one\n")]);
    let (_task_outer, task) = repo.worktree("task");
    let (_outer, feature) = repo.worktree("feature");
    let module = module();
    record(&module, "a-task", "pj", &task);
    record(&module, "b-head", "pj", &feature);
    repo.git(&["worktree", "remove", "--force", task.to_str().unwrap()]);
    let projects = module.projects_with_a_session();
    assert_eq!(projects.len(), 1);
    let (project, folder, session) = &projects[0];
    assert_eq!(project, "pj");
    assert!(Path::new(folder).is_dir(), "{folder} is gone");
    assert_eq!(canonical(Path::new(folder)), canonical(repo.path()));
    // The session the project's memory profile is read from is still the
    // first by key.
    assert_eq!(session.session, "a-task");
}

/// The folder is chosen again on every call: when the chosen repository's
/// folder is deleted, the next call moves to the other one, and when every
/// folder is gone the first session's folder is returned for the run's skip
/// to name.
#[tokio::test]
async fn a_folder_deleted_between_rounds_is_not_chosen_again() {
    let first = Repo::on("master", &[("a.rs", "one\n")]);
    let second = Repo::on("master", &[("a.rs", "one\n")]);
    let first_recorded = first.path().to_str().unwrap().to_owned();
    let module = module();
    record(&module, "s1", "pj", first.path());
    record(&module, "s2", "pj", second.path());
    let folder = |module: &Module<Client>| module.projects_with_a_session()[0].1.clone();
    let chosen = canonical(Path::new(&folder(&module)));
    let (chosen_repo, other) = if chosen == canonical(first.path()) {
        (first, second)
    } else {
        (second, first)
    };
    let other_path = canonical(other.path());
    // Dropping a repository deletes its folder.
    drop(chosen_repo);
    let next = folder(&module);
    assert!(Path::new(&next).is_dir(), "{next} is gone");
    assert_eq!(canonical(Path::new(&next)), other_path);
    drop(other);
    assert_eq!(folder(&module), first_recorded);
}
