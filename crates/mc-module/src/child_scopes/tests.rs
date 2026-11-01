use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
struct Publisher {
    calls: Mutex<Vec<(u64, Vec<ScopeRecord>)>>,
    refuse: AtomicBool,
}

#[async_trait]
impl ScopePublisher for Publisher {
    async fn sync(&self, generation: u64, scopes: Vec<ScopeRecord>) -> Result<(), ScopeError> {
        self.calls.lock().unwrap().push((generation, scopes));
        if self.refuse.swap(false, Ordering::Relaxed) {
            Err(ScopeError {
                code: "scope_sync_not_authority".into(),
                message: "not the supervised owner".into(),
            })
        } else {
            Ok(())
        }
    }
}

#[tokio::test]
async fn children_share_one_sync_and_keep_the_exact_former_bind_folder() {
    let publisher = Arc::new(Publisher::default());
    let scopes = ChildScopes::with_publisher("magic-context", publisher.clone());
    let root = Path::new("/same/project/../folder/");
    let (historian, dreamer) = tokio::join!(scopes.for_project(root), scopes.for_project(root));
    let historian = historian.unwrap();
    assert_eq!(historian, dreamer.unwrap());
    assert_eq!(
        historian.owner,
        Principal::Reserved {
            module_id: "magic-context".into()
        }
    );
    assert_eq!(historian.scope_epoch, Some(1));
    let calls = publisher.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, 1);
    assert_eq!(calls[0].1.len(), 1);
    assert_eq!(
        calls[0].1[0].workdir.as_deref(),
        Some("/same/project/../folder/")
    );
    assert_eq!(calls[0].1[0].scope_ref, historian.scope_ref);
    assert_eq!(
        serde_json::to_value(&calls[0].1[0].carriers).unwrap(),
        serde_json::json!([
            {"principal":{"kind":"reserved","module_id":"thalamus-harness"}},
            {"principal":{"kind":"reserved","module_id":"broca"}}
        ])
    );
}

#[tokio::test]
async fn adding_a_project_preserves_earlier_scopes_and_reconnect_resyncs_the_snapshot() {
    let publisher = Arc::new(Publisher::default());
    let scopes = ChildScopes::with_publisher("magic-context", publisher.clone());
    let first = scopes.for_project(Path::new("/first")).await.unwrap();
    let second = scopes.for_project(Path::new("/second")).await.unwrap();
    assert_ne!(first.scope_ref, second.scope_ref);
    assert_eq!(
        scopes.for_project(Path::new("/first")).await.unwrap(),
        first
    );
    scopes.reconnected();
    assert_eq!(
        scopes.for_project(Path::new("/first")).await.unwrap(),
        first
    );
    let calls = publisher.calls.lock().unwrap();
    assert_eq!(
        calls.iter().map(|call| call.0).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert_eq!(calls[1].1, calls[2].1);
    assert_eq!(
        calls[2]
            .1
            .iter()
            .filter_map(|record| record.workdir.as_deref())
            .collect::<Vec<_>>(),
        vec!["/first", "/second"]
    );
}

#[tokio::test]
async fn authority_refusal_propagates_without_caching_a_selector() {
    let publisher = Arc::new(Publisher::default());
    publisher.refuse.store(true, Ordering::Relaxed);
    let scopes = ChildScopes::with_publisher("magic-context", publisher.clone());
    let error = scopes.for_project(Path::new("/project")).await.unwrap_err();
    assert_eq!(error.code, "scope_sync_not_authority");
    scopes.for_project(Path::new("/project")).await.unwrap();
    scopes.for_project(Path::new("/project")).await.unwrap();
    assert_eq!(
        publisher
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|call| call.0)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
}

#[tokio::test]
async fn a_new_owner_process_uses_fresh_scope_refs_without_changing_the_folder() {
    let publisher = Arc::new(Publisher::default());
    let first = ChildScopes::new("magic-context");
    *first.publisher.lock().unwrap() = Some(publisher.clone());
    let second = ChildScopes::new("magic-context");
    *second.publisher.lock().unwrap() = Some(publisher.clone());
    let first = first.for_project(Path::new("/project")).await.unwrap();
    let second = second.for_project(Path::new("/project")).await.unwrap();
    assert_ne!(first.scope_ref, second.scope_ref);
    let calls = publisher.calls.lock().unwrap();
    assert_eq!(calls[0].1[0].workdir.as_deref(), Some("/project"));
    assert_eq!(calls[1].1[0].workdir.as_deref(), Some("/project"));
}

#[tokio::test]
async fn a_failed_sync_keeps_the_desired_project_in_the_next_full_snapshot() {
    let publisher = Arc::new(Publisher::default());
    publisher.refuse.store(true, Ordering::Relaxed);
    let scopes = ChildScopes::with_publisher("magic-context", publisher.clone());
    assert!(scopes.for_project(Path::new("/first")).await.is_err());
    scopes.for_project(Path::new("/second")).await.unwrap();
    scopes.for_project(Path::new("/first")).await.unwrap();
    let calls = publisher.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[1]
            .1
            .iter()
            .filter_map(|record| record.workdir.as_deref())
            .collect::<Vec<_>>(),
        vec!["/first", "/second"]
    );
}
