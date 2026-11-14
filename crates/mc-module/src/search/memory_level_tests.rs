//! `ctx_search` reads the memory levels the history head draws from: the
//! session's project's project-level memories and its Entorhinal
//! workspace's workspace-level memories. Another workspace's memories, a
//! 0.49 workspace sibling's project memories and global memories stay out,
//! in every way the search reaches memories.

use super::*;

use rusqlite::params;
use serde_json::json;

const PROJECT: i64 = 1;
const WORKSPACE: i64 = 2;
const OTHER_WORKSPACE: i64 = 3;
const SIBLING: i64 = 4;
const GLOBAL: i64 = 5;

/// A store where the session's project `pj-a` is in Entorhinal's workspace
/// `team`. The 0.49 dashboard's own workspace table also groups `pj-a` with
/// `pj-b`, sharing constraints, which the search no longer follows. Every
/// memory mentions "zebra" and carries the same vector, so only ownership
/// decides which ones a search finds.
fn store() -> Connection {
    let conn = crate::context_db::ContextDb::fresh_in_memory();
    conn.execute_batch(
        "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES(1, 'Example', 0, 0);
         INSERT INTO workspace_members VALUES(1, 'pj-a', 'Alpha', '/a', 0), (1, 'pj-b', 'Beta', '/b', 0);",
    )
    .unwrap();
    let vector: Vec<u8> = [1.0_f32, 0.0]
        .iter()
        .flat_map(|n| n.to_le_bytes())
        .collect();
    for (id, level, owner, content) in [
        (PROJECT, "project", "pj-a", "zebra project rule"),
        (WORKSPACE, "workspace", "team", "zebra workspace rule"),
        (
            OTHER_WORKSPACE,
            "workspace",
            "other",
            "zebra other workspace rule",
        ),
        (SIBLING, "project", "pj-b", "zebra sibling constraint"),
        (GLOBAL, "global", "self", "zebra person fact"),
    ] {
        conn.execute(
            "INSERT INTO memories(id, level, owner_id, category, origin_category, content,
                 normalized_hash, shareable, scope, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES(?1, ?2, ?3, 'swe:constraints', 'CONSTRAINTS', ?4, ?5, 1, 'project', 0, 50, 0, 0)",
            params![id, level, owner, content, format!("hash-{id}")],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memory_embeddings VALUES(?1, ?2, 'test')",
            params![id, vector],
        )
        .unwrap();
    }
    conn
}

const SEMANTIC: sources::Semantic<'static> = sources::Semantic {
    vector: &[1.0, 0.0],
    model_id: "test",
    chunk_model_id: "test",
};

fn scope<'a>(
    workspace: Option<&'a str>,
    seen: &'a BTreeMap<i64, String>,
    semantic: Option<sources::Semantic<'a>>,
) -> Scope<'a> {
    Scope {
        harness: "mock",
        session: "level-session",
        project: Some("pj-a"),
        workspace,
        cutoff: i64::MAX,
        visible_messages: None,
        seen,
        memory_enabled: true,
        git_commits_enabled: false,
        git_repository: Some(false),
        semantic,
    }
}

/// The memory ids a reply lists, in its order.
fn reply_ids(reply: &str) -> Vec<i64> {
    reply
        .lines()
        .filter(|line| line.contains("] [memory] "))
        .filter_map(|line| {
            let id = line.split(" id=").nth(1)?.split(' ').next()?;
            id.parse().ok()
        })
        .collect()
}

fn sorted(mut ids: Vec<i64>) -> Vec<i64> {
    ids.sort_unstable();
    ids
}

#[test]
fn a_search_finds_its_project_and_its_workspace_by_words_and_by_meaning() {
    let mut conn = store();
    let seen = BTreeMap::new();
    let by_words = json!({"query": "zebra", "sources": ["memory"]});
    let reply = run(&mut conn, &scope(Some("team"), &seen, None), &by_words).unwrap();
    assert_eq!(sorted(reply_ids(&reply)), [PROJECT, WORKSPACE], "{reply}");
    assert!(
        reply
            .contains(" id=2 category=CONSTRAINTS level=workspace match=fts\nzebra workspace rule"),
        "{reply}"
    );
    assert!(
        reply.contains(" id=1 category=CONSTRAINTS match=fts\nzebra project rule"),
        "{reply}"
    );

    // No word matches; the shared vector does.
    let by_meaning = json!({"query": "unrelated words", "sources": ["memory"]});
    let reply = run(
        &mut conn,
        &scope(Some("team"), &seen, Some(SEMANTIC)),
        &by_meaning,
    )
    .unwrap();
    assert_eq!(sorted(reply_ids(&reply)), [PROJECT, WORKSPACE], "{reply}");
    assert!(
        reply.contains(" id=2 category=CONSTRAINTS level=workspace match=semantic\n"),
        "{reply}"
    );

    // A rerank's separate halves are scoped the same way.
    let mut halves = sources::Halves::default();
    let owners = sources::MemoryOwners {
        project: Some("pj-a"),
        workspace: Some("team"),
    };
    let visible = BTreeSet::new();
    sources::search_memories(
        &conn,
        owners,
        "zebra",
        10,
        &visible,
        None,
        Some(SEMANTIC),
        Some(&mut halves),
    );
    for half in [&halves.words, &halves.meaning] {
        assert_eq!(
            sorted(half.iter().map(|hit| hit.id).collect()),
            [PROJECT, WORKSPACE]
        );
    }

    // A session in no workspace reads its project's memories alone.
    for (query, semantic) in [(&by_words, None), (&by_meaning, Some(SEMANTIC))] {
        let reply = run(&mut conn, &scope(None, &seen, semantic), query).unwrap();
        assert_eq!(reply_ids(&reply), [PROJECT], "{reply}");
    }
}

#[test]
fn a_workspace_hit_names_its_level_and_a_project_hit_reads_as_before() {
    let hit = |level| {
        Hit::Memory(MemoryHit {
            id: 7,
            level,
            category: "swe:constraints".into(),
            content: "keep one store file".into(),
            hint_content: "keep one store file".into(),
            score: 0.9,
            match_type: "fts",
        })
    };
    assert_eq!(
        format_hit(&hit(MemoryLevel::Project), 1, "s", 0),
        "[1] [memory] score=0.90 id=7 category=swe:constraints match=fts\nkeep one store file"
    );
    assert_eq!(
        format_hit(&hit(MemoryLevel::Workspace), 2, "s", 0),
        "[2] [memory] score=0.90 id=7 category=swe:constraints level=workspace match=fts\nkeep one store file"
    );
}

#[test]
fn memories_the_head_shows_in_full_are_suppressed_at_either_level() {
    let mut conn = store();
    // The head's own read and fold for this session: its `seen` holds the
    // workspace memory's text as well as the project memory's.
    let rows = crate::head_memories::read_rows(&conn, Some("pj-a"), Some("team"), 100).unwrap();
    let classes = std::collections::HashMap::new();
    let baseline = crate::summary::head::fold(
        &crate::summary::head::Inputs {
            counter: crate::count::Counter::for_model(None),
            summaries: &[],
            docs: "",
            rows: &rows,
            classes: &classes,
            now_ms: 100,
            gone: &[],
            history_budget_tokens: 60_000,
            history_local_budget_tokens: 60_000,
            memory_budget_tokens: 4_000,
            profile_budget_tokens: 4_000,
        },
        None,
    );
    assert_eq!(
        baseline.seen.get(&WORKSPACE).map(String::as_str),
        Some("zebra workspace rule")
    );
    assert_eq!(
        baseline.seen.get(&PROJECT).map(String::as_str),
        Some("zebra project rule")
    );
    let query = json!({"query": "zebra", "sources": ["memory"]});
    let reply = run(
        &mut conn,
        &scope(Some("team"), &baseline.seen, None),
        &query,
    )
    .unwrap();
    assert_eq!(
        reply,
        "No hidden results found for \"zebra\".\n\nMemories: 2 matches found, all already visible in your project-memory and workspace-memory blocks (ids 1, 2)."
    );

    let only = |id: i64| -> BTreeMap<i64, String> {
        baseline
            .seen
            .iter()
            .filter(|(seen, _)| **seen == id)
            .map(|(id, text)| (*id, text.clone()))
            .collect()
    };
    let workspace_seen = only(WORKSPACE);
    let reply = run(
        &mut conn,
        &scope(Some("team"), &workspace_seen, None),
        &query,
    )
    .unwrap();
    assert_eq!(reply_ids(&reply), [PROJECT], "{reply}");
    assert!(
        reply.contains("Memories: 1 additional match suppressed because it is already visible in your workspace-memory block (ids 2)."),
        "{reply}"
    );
    let project_seen = only(PROJECT);
    let reply = run(&mut conn, &scope(Some("team"), &project_seen, None), &query).unwrap();
    assert_eq!(reply_ids(&reply), [WORKSPACE], "{reply}");
    assert!(
        reply.contains("Memories: 1 additional match suppressed because it is already visible in your project-memory block (ids 1)."),
        "{reply}"
    );

    // An id lookup suppresses a shown workspace memory too.
    let reply = by_ids(
        &conn,
        &scope(Some("team"), &workspace_seen, None),
        &json!({"query": "2"}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        reply,
        "No hidden results found for \"2\".\n\nMemories: 1 match found, all already visible in your workspace-memory block (ids 2)."
    );
}

#[test]
fn an_id_lookup_and_the_automatic_hint_read_the_same_levels() {
    let conn = store();
    let seen = BTreeMap::new();
    let reply = by_ids(
        &conn,
        &scope(Some("team"), &seen, None),
        &json!({"query": "1 2 3 4 5"}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(reply_ids(&reply), [PROJECT, WORKSPACE], "{reply}");
    assert!(
        reply.contains(" id=2 category=CONSTRAINTS level=workspace match=fts\n"),
        "{reply}"
    );
    // Ids naming only other owners' memories are no lookup: the full
    // search runs instead.
    assert!(by_ids(
        &conn,
        &scope(Some("team"), &seen, None),
        &json!({"query": "3 4 5"})
    )
    .is_none());
    // Without a workspace, the workspace memory's id is no lookup either.
    assert!(by_ids(&conn, &scope(None, &seen, None), &json!({"query": "2"})).is_none());

    for semantic in [None, Some(SEMANTIC)] {
        let hits = auto_hits(
            &conn,
            &mut messages::Coverage::default(),
            &scope(Some("team"), &seen, semantic),
            "zebra",
        );
        let ids: Vec<i64> = hits
            .iter()
            .filter_map(|(hit, _)| match hit {
                Hit::Memory(memory) => Some(memory.id),
                _ => None,
            })
            .collect();
        assert_eq!(sorted(ids), [PROJECT, WORKSPACE]);
    }
}
