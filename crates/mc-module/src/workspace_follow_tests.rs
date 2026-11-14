use std::sync::Arc;

use cortexkit_role_compaction::read::SessionRef;
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};

use super::*;
use crate::memory_profile::MemoryContext;

fn session_with(store: Option<Arc<crate::store::Store>>) -> Session {
    let route = Route {
        session: SessionRef::new("test", "mock", "s1"),
        project: None,
        workdir: Some("/work/a".into()),
        agent_id: None,
    };
    let request = SetupRequest::new(
        crate::catalog::Preset::Head.as_str(),
        ModelRef::new("test", "model"),
        100_000,
        1000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
        Vec::new(),
        1,
    );
    let mut session = Session::new(&route, &request, crate::preset::Features::NONE, None);
    session.set_store(store);
    session
}

fn context(workspace: Option<&str>) -> MemoryContext {
    use crate::memory_context::ContextAnswer;
    let mut context = crate::memory_profile::resolve(
        &ContextAnswer::NotAnswering,
        &ContextAnswer::NotAnswering,
        &[],
    );
    context.project_id = Some("pj-a".into());
    context.workspace_id = workspace.map(str::to_owned);
    context
}

#[test]
fn a_session_follows_its_project_to_another_workspace_and_keeps_it_stored() {
    let dir = std::env::temp_dir().join(format!("ck-mc-workspace-follow-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch folder");
    let store = Arc::new(crate::store::Store::open(&dir.join("mode3.db")).expect("open the store"));
    let key = SessionRef::new("test", "mock", "s1");
    let stored = store.keep_memory_context(&key, context(Some("team")));
    let mut session = session_with(Some(Arc::clone(&store)));
    session.set_memory_context(stored);

    // The same workspace, or an answer about another project, changes nothing.
    assert!(!session.follow_workspace(Some("pj-a"), Some("team".into())));
    assert!(!session.follow_workspace(Some("pj-b"), Some("other".into())));
    assert_eq!(
        store
            .memory_context(&key)
            .and_then(|context| context.workspace_id),
        Some("team".into())
    );

    // A move reaches the session and its stored context, and nothing else of
    // the context changes.
    assert!(session.follow_workspace(Some("pj-a"), Some("other".into())));
    let after = store.memory_context(&key).expect("still stored");
    assert_eq!(after.workspace_id.as_deref(), Some("other"));
    assert_eq!(after.project_id.as_deref(), Some("pj-a"));
    assert_eq!(
        session
            .memory_context
            .as_ref()
            .and_then(|context| context.workspace_id.as_deref()),
        Some("other")
    );

    // Leaving every workspace is a move too.
    assert!(session.follow_workspace(Some("pj-a"), None));
    assert_eq!(
        store
            .memory_context(&key)
            .and_then(|context| context.workspace_id),
        None
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_session_without_a_memory_context_follows_nothing() {
    let mut session = session_with(None);
    assert!(!session.follow_workspace(Some("pj-a"), Some("team".into())));
    assert!(session.memory_context.is_none());
}

/// `ctx_search` reads the workspace the session is in now: after its
/// project moves, the new workspace's memories and not the old one's.
#[test]
fn a_session_that_followed_a_workspace_move_searches_its_new_workspace() {
    let mut session = session_with(None);
    session.project = Some(Project {
        id: "pj-a".into(),
        root: "/work/a".into(),
    });
    session.set_memory_context(context(Some("team")));
    let mut conn = crate::context_db::ContextDb::fresh_in_memory();
    for (id, owner, content) in [
        (1, "team", "zebra team rule"),
        (2, "other", "zebra other rule"),
    ] {
        conn.execute(
            "INSERT INTO memories(id, level, owner_id, category, origin_category, content,
                 normalized_hash, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES(?1, 'workspace', ?2, 'swe:constraints', 'CONSTRAINTS', ?3, ?1, 0, 0, 0, 0)",
            rusqlite::params![id, owner, content],
        )
        .expect("a workspace memory");
    }
    let search = |session: &Session, conn: &mut rusqlite::Connection| {
        let empty = std::collections::BTreeMap::new();
        let scope = session.search_scope(&Settings::default(), &empty);
        crate::search::run(
            conn,
            &scope,
            &serde_json::json!({"query": "zebra", "sources": ["memory"]}),
        )
        .expect("a search")
    };
    let before = search(&session, &mut conn);
    assert!(
        before.contains(" id=1 category=CONSTRAINTS level=workspace ")
            && !before.contains(" id=2 "),
        "{before}"
    );
    assert!(session.follow_workspace(Some("pj-a"), Some("other".into())));
    let after = search(&session, &mut conn);
    assert!(
        after.contains(" id=2 category=CONSTRAINTS level=workspace ") && !after.contains(" id=1 "),
        "{after}"
    );
}
