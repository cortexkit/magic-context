use mc_store::memory_projection::{text_line, VisibleText};

fn fragment(store: &McStore, session: &str, id: i64, text: &str, key: &str) {
    store
        .with_facade_command(
            "/tmp",
            "git:proj",
            "memories",
            session,
            "ctx_memory",
            "write",
            Some(key),
            |tx| {
                tx.record_agent_fragment(
                    session,
                    "git:proj",
                    key,
                    &[id],
                    Some(id),
                    &[text_line("added", id, "CONSTRAINTS", text)],
                    &[VisibleText {
                        id,
                        text: text.to_string(),
                    }],
                    0,
                )?;
                Ok(Vec::new())
            },
        )
        .unwrap();
}

fn soft(
    store: &McStore,
    request: &TransformRequest,
    ctx: &ProducerContext<'_>,
) -> TransformResponse {
    store.arm_soft_refresh(&request.session_id).unwrap();
    transform(store, request, ctx).unwrap()
}

#[test]
fn marker_probe_and_commit_ignore_pending_lifecycle() {
    for compaction in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let id = s
            .insert_memory(memory_input("git:proj", "CONSTRAINTS", "applied claim", 0))
            .unwrap();
        let mut request = req(
            "ses",
            "cfg0",
            vec![item("a", 1, "raw"), item("tail", 2, "stable tail")],
        );
        request.serializer_profile = "opencode-aisdk".into();
        request.mural = Some(crate::m0_compose::M0MuralInput {
            enabled: true,
            supports_vision: true,
            data_url: Some("data:image/png;base64,old".into()),
            content_hash: Some("old-image".into()),
        });
        let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
        ctx.compaction_enabled = compaction;
        if compaction {
            s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
                .unwrap();
        }
        transform(&s, &request, &ctx).unwrap();
        fragment(&s, "ses", id, "shown agent fragment", "agent-before-marker");
        let shown = soft(&s, &request, &ctx);
        assert!(m1_bytes(&shown).contains("shown agent fragment"));
        let shown_meta = s.load("ses").unwrap().meta;
        s.with_context_conn_for_test(|conn| conn.execute("UPDATE memories SET content='pending lifecycle',revision=revision+1,importance=100,verified_at=10 WHERE id=?1",[id])).unwrap();
        request.mural.as_mut().unwrap().data_url = Some("data:image/png;base64,pending".into());
        request.mural.as_mut().unwrap().content_hash = Some("pending-image".into());
        ctx.now_ms = 100;
        regate_mark_history_pending(&s, "ses");
        drop(s);
        let restarted = store(dir.path());
        let marker = transform(&restarted, &request, &ctx).unwrap();
        assert_eq!(marker.action, "HARD");
        assert!(!marker.prefix_bust_permitted);
        assert_eq!(
            serde_json::to_vec(marker.messages()).unwrap(),
            serde_json::to_vec(shown.messages()).unwrap(),
            "compaction={compaction}"
        );
        let meta = restarted.load("ses").unwrap().meta;
        assert_eq!(meta.memory_projection, shown_meta.memory_projection);
        assert_eq!(meta.expiry_cutoff_ms, shown_meta.expiry_cutoff_ms);
        request.render_config = "cfg-natural-hard".into();
        let hard = transform(&restarted, &request, &ctx).unwrap();
        assert!(m0_bytes(&hard).contains("pending lifecycle"));
        assert!(!m1_bytes(&hard).contains("shown agent fragment"));
    }
}

#[test]
fn external_repair_waits_for_natural_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let id = s
        .insert_memory(memory_input("git:proj", "CONSTRAINTS", "external old", 0))
        .unwrap();
    let mut request = req("ses", "cfg0", vec![item("tail", 1, "tail")]);
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let before = transform(&s, &request, &ctx).unwrap();
    s.with_context_conn_for_test(|conn| {
        conn.execute(
            "UPDATE memories SET content='external new' WHERE id=?1",
            [id],
        )
    })
    .unwrap();
    let held = transform(&s, &request, &ctx).unwrap();
    assert_ne!(held.action, "HARD");
    request.render_config = "cfg-natural-hard".into();
    let after = transform(&s, &request, &ctx).unwrap();
    assert_eq!(after.action, "HARD");
    assert!(after.prefix_bust_permitted);
    assert_ne!(m0_bytes(&before), m0_bytes(&after));
    assert!(m0_bytes(&after).contains("external new"));
}

#[test]
fn archiving_holds_admitted_text_until_natural_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let id = s
        .insert_memory(memory_input(
            "git:proj",
            "CONSTRAINTS",
            "explicitly revoked",
            0,
        ))
        .unwrap();
    let mut request = req("ses", "cfg0", vec![item("tail", 1, "tail")]);
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    s.with_context_conn_for_test(|conn| {
        conn.execute("UPDATE memories SET status='archived' WHERE id=?1", [id])
    })
    .unwrap();
    let held = transform(&s, &request, &ctx).unwrap();
    assert_ne!(held.action, "HARD");
    request.render_config = "cfg-natural-hard".into();
    let after = transform(&s, &request, &ctx).unwrap();
    assert_eq!(after.action, "HARD");
    assert!(after.prefix_bust_permitted);
    assert!(!m0_bytes(&after).contains("explicitly revoked"));
}

#[test]
fn soft_keeps_admitted_membership_and_revisions() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
        .unwrap();
    let request = req(
        "ses",
        "cfg0",
        vec![item("a", 1, "raw"), item("tail", 2, "tail")],
    );
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    fragment(&s, "ses", 42, "shown immutable claim", "first");
    let first = soft(&s, &request, &ctx);
    assert!(m1_bytes(&first).contains("shown immutable claim"));
    s.insert_memory(memory_input(
        "git:proj",
        "CONSTRAINTS",
        "foreign high priority",
        1,
    ))
    .unwrap();
    s.with_context_conn_for_test(|conn| conn.execute_batch("UPDATE memories SET importance=100,expires_at=1,status='archived',content='foreign repair'" )).unwrap();
    drop(s);
    let s = store(dir.path());
    let next = soft(&s, &request, &ctx);
    assert_eq!(m0_bytes(&first), m0_bytes(&next));
    assert_eq!(m1_bytes(&first), m1_bytes(&next));
    assert_eq!(
        first.messages(),
        transform(&s, &request, &ctx).unwrap().messages()
    );
}

#[test]
fn pending_lifecycle_cannot_manufacture_pressure_hard() {
    for ratio_bound in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
            .unwrap();
        if ratio_bound {
            s.insert_memory(memory_input(
                "git:proj",
                "CONSTRAINTS",
                &"baseline text ".repeat(300),
                0,
            ))
            .unwrap();
        }
        let request = req(
            "ses",
            "cfg0",
            vec![item("a", 1, "raw"), item("tail", 2, "tail")],
        );
        let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
        ctx.memory_budget_tokens = 100_000.0;
        if !ratio_bound {
            ctx.history_budget_tokens = 500.0;
        }
        let baseline = transform(&s, &request, &ctx).unwrap();
        assert_eq!(
            mc_tokenizer::estimate_tokens(m0_bytes(&baseline)) >= 500,
            ratio_bound
        );
        for id in 1..80 {
            fragment(
                &s,
                "ses",
                id,
                &"large claim ".repeat(2_000),
                &format!("op-{id}"),
            );
        }
        let shown = soft(&s, &request, &ctx);
        assert!(matches!(shown.action.as_str(), "SOFT" | "SOFT+"));
        assert!(m1_bytes(&shown).contains("stale-memory"));
        assert!(m1_bytes(&shown).contains("more-memory-edits"));
        let cap = if ratio_bound {
            mc_tokenizer::estimate_tokens(m0_bytes(&shown)) as f64 * 0.15
        } else {
            ctx.history_budget_tokens * 0.20
        };
        assert!(
            mc_tokenizer::estimate_tokens(m1_bytes(&shown)) as f64 > cap,
            "the reserved traces must cross the counterfactual pressure cap"
        );
        let meta = s.load("ses").unwrap().meta;
        let committed = meta.memory_projection.unwrap().committed;
        assert!(
            committed
                .iter()
                .filter(|entry| entry.form == "full")
                .flat_map(|entry| &entry.lines)
                .count()
                <= 40
        );
        assert_eq!(
            shown.messages(),
            transform(&s, &request, &ctx).unwrap().messages()
        );
    }
}

#[test]
fn current_revision_search_survives_old_prompt_exclusion() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let id = s
        .insert_memory(memory_input(
            "git:proj",
            "CONSTRAINTS",
            "old searchable claim",
            0,
        ))
        .unwrap();
    let request = req("ses", "cfg0", vec![item("tail", 1, "tail")]);
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let first = transform(&s, &request, &ctx).unwrap();
    assert_eq!(s.fully_visible_memory_ids("ses").unwrap(), vec![id]);
    s.update_memory_content("git:proj", id, "current searchable claim", None, 1)
        .unwrap();
    assert!(s.fully_visible_memory_ids("ses").unwrap().is_empty());
    let explicit = crate::memory_tool::resolve_memory_ids_for_search_with_diagnostics(
        &s,
        "git:proj",
        &[id],
        10,
        &BTreeSet::new(),
        None,
        None,
    )
    .unwrap();
    assert!(explicit.results.unwrap()[0]
        .snippet
        .contains("current searchable claim"));
    assert_eq!(
        first.messages(),
        transform(&s, &request, &ctx).unwrap().messages()
    );
}

#[test]
fn cue_visibility_does_not_hide_full_text() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let id = s
        .insert_memory(memory_input("git:proj", "CONSTRAINTS", "cue claim", 0))
        .unwrap();
    let request = req("ses", "cfg0", vec![item("tail", 1, "tail")]);
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    let mut loaded = s.load("ses").unwrap();
    loaded.meta.memory_projection.as_mut().unwrap().rows[0].representation = "cue".into();
    s.commit("ses", loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
    assert!(s.fully_visible_memory_ids("ses").unwrap().is_empty());
    let result = crate::memory_tool::resolve_memory_ids_for_search_with_diagnostics(
        &s,
        "git:proj",
        &[id],
        10,
        &BTreeSet::new(),
        None,
        None,
    )
    .unwrap();
    assert!(result.results.unwrap()[0].snippet.contains("cue claim"));
}

#[test]
fn retired_rows_are_history_only() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let id = s
        .insert_memory(memory_input("git:proj", "CONSTRAINTS", "retired claim", 0))
        .unwrap();
    s.archive_memories("git:proj", &[id], None, 1).unwrap();
    let result = crate::memory_tool::resolve_memory_ids_for_search_with_diagnostics(
        &s,
        "git:proj",
        &[id],
        10,
        &BTreeSet::new(),
        None,
        None,
    )
    .unwrap();
    assert!(result.results.is_none());
    assert_eq!(
        s.get_memory_full(id).unwrap().unwrap().content,
        "retired claim"
    );
}

#[test]
fn applied_snapshot_commit_is_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
        .unwrap();
    let request = req(
        "ses",
        "cfg0",
        vec![item("a", 1, "raw"), item("tail", 2, "tail")],
    );
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    let stale = s.load("ses").unwrap();
    fragment(&s, "ses", 42, "new shown claim", "op");
    soft(&s, &request, &ctx);
    let current = s.load("ses").unwrap();
    assert_eq!(
        current
            .meta
            .memory_projection
            .as_ref()
            .unwrap()
            .committed
            .len(),
        1
    );
    assert!(s
        .commit("ses", stale.row_version, &stale.core, &stale.meta)
        .is_err());
    drop(s);
    let s = store(dir.path());
    let after = s.load("ses").unwrap();
    assert_eq!(after.core, current.core);
    assert_eq!(after.meta.memory_projection, current.meta.memory_projection);
}

#[test]
fn randomized_soft_defer_hard_restarts_replay_exact_pair() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = store(dir.path());
    s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
        .unwrap();
    let mut request = req(
        "ses",
        "cfg0",
        vec![item("a", 1, "raw"), item("tail", 2, "tail")],
    );
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    let mut seed = 0x54c0ffeeu32;
    for index in 0..80 {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        match seed % 3 {
            0 => {
                fragment(
                    &s,
                    "ses",
                    100 + index,
                    &format!("immutable {index}"),
                    &format!("op-{index}"),
                );
                assert!(m1_bytes(&soft(&s, &request, &ctx)).contains(&format!("immutable {index}")));
            }
            1 => {
                request.render_config = format!("config-{index}");
                transform(&s, &request, &ctx).unwrap();
            }
            _ => {
                transform(&s, &request, &ctx).unwrap();
            }
        }
        let shown = transform(&s, &request, &ctx).unwrap();
        drop(s);
        s = store(dir.path());
        let replay = transform(&s, &request, &ctx).unwrap();
        assert_eq!(
            serde_json::to_vec(shown.messages()).unwrap(),
            serde_json::to_vec(replay.messages()).unwrap(),
            "round {index}"
        );
        assert_eq!(shown.boundary_id, replay.boundary_id);
    }
}
