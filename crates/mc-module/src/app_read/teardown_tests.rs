use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};

use crate::child_scopes::ChildScopes;
use crate::context_db::ContextDb;
use crate::module::Module;
use crate::pass::Settings;
use crate::store::Store;
use crate::transport::SubcRunnerClient;

fn store_descriptors(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(|entry| std::fs::read_link(entry.ok()?.path()).ok())
        .filter(|path| path.starts_with(dir))
        .collect()
}

async fn module_with_held_reader(dir: &Path) -> (Module<SubcRunnerClient>, mpsc::Sender<()>) {
    let context = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    let sessions = Store::open(&dir.join("sessions.db")).unwrap();
    let client = SubcRunnerClient::new(
        dir.join("unused-connection"),
        Arc::new(ChildScopes::new("test")),
    );
    let module = Module::new(client, Settings::default(), Some(context), Some(sessions));
    let release = module.app_read().gate_thread().await;
    (module, release)
}

#[test]
fn app_reader_exit_observation_fences_its_store_handles() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (module, release, other, release_other) = runtime.block_on(async {
        let (module, release) = module_with_held_reader(first.path()).await;
        let (other, release_other) = module_with_held_reader(second.path()).await;
        (module, release, other, release_other)
    });

    let exit = module.observe_app_reader_exit();
    let other_exit = other.observe_app_reader_exit();
    drop(module);
    drop(runtime);

    assert_eq!(exit.try_recv(), Err(mpsc::TryRecvError::Empty));
    assert!(!store_descriptors(first.path()).is_empty());
    release.send(()).unwrap();
    exit.recv_timeout(std::time::Duration::from_secs(30))
        .expect("the first app reader closed its stores");
    let remaining = store_descriptors(first.path());
    assert!(
        remaining.is_empty(),
        "first app reader still holds {remaining:?}"
    );
    assert_eq!(other_exit.try_recv(), Err(mpsc::TryRecvError::Empty));
    assert!(!store_descriptors(second.path()).is_empty());
    drop(other);
    release_other.send(()).unwrap();
    other_exit
        .recv_timeout(std::time::Duration::from_secs(30))
        .expect("the second app reader closed its stores");
    assert!(store_descriptors(second.path()).is_empty());
}
