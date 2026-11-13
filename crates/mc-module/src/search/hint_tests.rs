use super::*;

fn memory(preview: &str, full_content: &str) -> Hit {
    Hit::Memory(MemoryHit {
        id: 1,
        source_name: None,
        category: "WORKFLOW_RULES".into(),
        content: preview.into(),
        hint_content: full_content.into(),
        score: 0.95,
        match_type: "hybrid",
    })
}

#[test]
fn hybrid_hint_relevance_matches_chinese_phrases_without_trusting_retrieval_rank() {
    let query = "MC_Maze 残差怎样汇总？";
    let content = "MC_Maze 残差按种子汇总。";
    let hit = memory(content, content);
    let relevance = hint_relevance(&hit, query);
    assert!((relevance - 2.0 / 3.0).abs() < 1e-12, "{relevance}");
    assert!(relevance > 0.6);
    let Hit::Memory(mut changed) = hit else {
        unreachable!()
    };
    changed.score = 0.2;
    assert_eq!(
        hint_relevance(&Hit::Memory(changed.clone()), query),
        relevance
    );
    for match_type in ["fts", "literal"] {
        changed.match_type = match_type;
        assert_eq!(
            hint_relevance(&Hit::Memory(changed.clone()), query),
            relevance
        );
    }
    let unrelated = "MC_Maze 差旅报销规定。";
    assert!(hint_relevance(&memory(unrelated, unrelated), query) < 0.6);
    let function_words = "我们可以去吃饭";
    assert!(
        hint_relevance(
            &memory(function_words, function_words),
            "我们可以怎样汇总残差"
        ) < 0.6
    );
    changed.match_type = "semantic";
    changed.score = 0.95;
    assert_eq!(hint_relevance(&Hit::Memory(changed), query), 0.95);
}

#[test]
fn memory_hint_relevance_is_independent_of_display_preview_length() {
    let full_content = format!("{}historian cache wiring", "unrelated ".repeat(40));
    for length in [0, 80, 220, full_content.len()] {
        let preview = &full_content[..length];
        let hit = memory(preview, &full_content);
        assert_eq!(
            hint_relevance(&hit, "historian cache wiring"),
            0.8000000000000002
        );
        assert_eq!(
            format_hit(&hit, 1, "session", 0),
            format_hit(&memory(preview, preview), 1, "session", 0)
        );
    }
    let Hit::Memory(mut hit) = memory("", "historian cache wiring") else {
        unreachable!()
    };
    hit.match_type = "semantic";
    assert_eq!(
        hint_relevance(&Hit::Memory(hit), "historian cache wiring"),
        0.95
    );
    assert_eq!(
        hint_relevance(&memory("", "<task>cache</task>"), "cache"),
        0.0
    );
}

#[test]
fn memory_hint_scores_use_full_text_but_search_output_keeps_the_preview() {
    let mut conn = crate::context_db::ContextDb::fresh_in_memory();
    let full_content = format!("{}historian cache wiring", "unrelated ".repeat(40));
    for (id, content) in [(1, full_content.as_str()), (2, "historian cache wiring")] {
        conn.execute(
            "INSERT INTO memories(id,level, owner_id,category, origin_category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at)
             VALUES(?1,'project', 'hint-project','swe:project-rules', 'WORKFLOW_RULES',?2,?1,0,0,0,0)",
            rusqlite::params![id, content],
        )
        .unwrap();
        let vector: Vec<u8> = [1.0_f32, 0.0]
            .iter()
            .flat_map(|n| n.to_le_bytes())
            .collect();
        conn.execute(
            "INSERT INTO memory_embeddings VALUES(?1,?2,'test')",
            rusqlite::params![id, vector],
        )
        .unwrap();
    }
    let seen = BTreeMap::new();
    for embedding_enabled in [false, true] {
        let scope = Scope {
            harness: "mock",
            session: "hint-session",
            project: Some("hint-project"),
            cutoff: i64::MAX,
            visible_messages: None,
            seen: &seen,
            memory_enabled: true,
            git_commits_enabled: false,
            git_repository: Some(false),
            semantic: embedding_enabled.then_some(sources::Semantic {
                vector: &[1.0, 0.0],
                model_id: "test",
                chunk_model_id: "test",
            }),
        };
        let query = "historian cache wiring";
        let input = serde_json::json!({"query": query, "sources": ["memory"]});
        let explicit = prepare(&conn, &scope, &input, None).unwrap();
        let hints = auto_hits(&conn, &scope, query);
        assert_eq!(explicit.hits.len(), 2);
        assert_eq!(hints.len(), 2);
        let mut long_hit = None;
        for (hint, relevance) in &hints {
            assert_eq!(*relevance, 0.8000000000000002);
            assert!(explicit.hits.contains(hint));
            let Hit::Memory(hit) = hint else {
                panic!("expected a memory hit");
            };
            assert_eq!(
                hit.match_type,
                if embedding_enabled { "hybrid" } else { "fts" }
            );
            if hit.id == 1 {
                assert_eq!(text::utf16_len(&hit.content), 220);
                assert_eq!(hit.content, text::preview(&full_content));
                assert!(!hit.content.contains("historian"));
                long_hit = Some(hint.clone());
            }
        }
        let long_hit = long_hit.unwrap();
        let display = format_hit(&long_hit, 1, scope.session, 0);
        assert!(!display.contains("historian"));
        assert!(!serde_json::to_string(&display)
            .unwrap()
            .contains("historian"));
        let hint = build_hint(vec![(long_hit, 0.8000000000000002)], 0.6, query, 0).unwrap();
        assert!(!hint.contains("historian"));
        let output = finish(&mut conn, &scope, explicit);
        assert_eq!(
            output.matches("historian cache wiring").count(),
            2,
            "{output}"
        );
    }
}
