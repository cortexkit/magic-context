// Updating the external system hash must not hide model, renderer or workspace
// changes, or consume queued history and memory edits before another rebuild.
use super::tests::{item, pctx, req, store};
use super::*;

fn request() -> TransformRequest {
    let mut request = req(
        "review",
        "system:old",
        vec![item("a", 1, "covered"), item("tail", 2, "tail")],
    );
    request.serializer_profile = "opencode-aisdk".into();
    request.system_prompt_hash = "old".into();
    request.provider_id = Some("anthropic".into());
    request.model_key = Some("anthropic/claude-opus-5-5".into());
    request.upgrade_state = "ready".into();
    request.tool_present = true;
    request.cache_ttl = Some("never".into());
    request.usage = Some(ModuleUsage {
        current_total_input_tokens: 10_000,
        context_limit_tokens: 100_000,
        final_wire_input_tokens: 0,
        final_wire_trusted: false,
    });
    request
}
fn delivered(request: &mut TransformRequest) {
    request.system_prompt_hash = "new".into();
    request.render_config = "system:new".into();
    request.adopted_system_prompt_hash = Some("new".into());
}

#[test]
fn review_adoption_cannot_waive_any_other_render_identity_input() {
    for input in [
        "provider",
        "model",
        "serializer",
        "renderer",
        "workspace",
        "upgrade",
        "tagger",
        "prompt-surface",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let mut request = request();
        let mut ctx = pctx("git:proj", "/nonexistent-review-project", 1000);
        ctx.cache_ttl = "never".into();
        assert_eq!(transform(&s, &request, &ctx).unwrap().action, "HARD");
        assert_eq!(transform(&s, &request, &ctx).unwrap().action, "SOFT+");
        delivered(&mut request);
        match input {
            "provider" => request.provider_id = Some("openai".into()),
            "model" => request.model_key = Some("anthropic/claude-opus-5-4".into()),
            "serializer" => request.serializer_profile = "owned-llmrunner".into(),
            "upgrade" => request.upgrade_state = "different-upgrade".into(),
            "prompt-surface" => request.prompt_surface_preset = PromptSurfacePreset::Light,
            _ => {
                // A stale materialized epoch is the same classifier input as an
                // upgraded renderer or changed workspace supplied on this pass.
                let mut loaded = s.load("review").unwrap();
                let (old, new) = match input {
                    "renderer" => ("mre3", "mre2"),
                    "workspace" => ("ws:0:", "ws:3:old"),
                    "tagger" => ("tfe4", "tfe3"),
                    _ => unreachable!(),
                };
                assert!(
                    loaded.meta.last_render_config.contains(old),
                    "{input}: {}",
                    loaded.meta.last_render_config
                );
                loaded.meta.last_render_config = loaded.meta.last_render_config.replace(old, new);
                s.commit("review", loaded.row_version, &loaded.core, &loaded.meta)
                    .unwrap();
            }
        }
        ctx.now_ms += 1;
        let rebuilt = transform(&s, &request, &ctx).unwrap();
        assert_eq!(
            rebuilt.action, "HARD",
            "{input}: reason={:?} delta={:?}",
            rebuilt.materialize_reason, rebuilt.identity_delta
        );
        assert!(rebuilt.prefix_bust_permitted, "{input}");
        assert_ne!(
            transform(&s, &request, &ctx).unwrap().action,
            "HARD",
            "{input}: fold repeated"
        );
    }
}

#[test]
fn review_adoption_preserves_ttl_flush_pressure_and_pending_m0_rebuilds() {
    for cause in ["ttl", "flush", "85", "95", "m0"] {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        s.replace_compartments(
            "review",
            &[mc_store::StoredCompartment {
                sequence: 1,
                start_message: 1,
                end_message: 1,
                end_message_id: "a#0".into(),
                title: "history".into(),
                content: "summary".into(),
                p1: Some("summary".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
        let mut request = request();
        let mut ctx = pctx("git:proj", "/nonexistent-review-project", 1000);
        ctx.cache_ttl = "never".into();
        assert_eq!(transform(&s, &request, &ctx).unwrap().action, "HARD");
        assert_eq!(transform(&s, &request, &ctx).unwrap().action, "SOFT+");
        delivered(&mut request);
        match cause {
            "ttl" => {
                request.cache_ttl = Some("5m".into());
                ctx.cache_ttl = "5m".into();
                ctx.observed_last_response_at_ms = Some(1001);
                ctx.now_ms = 301_002;
            }
            "flush" => {
                s.arm_soft_refresh("review").unwrap();
            }
            "85" | "95" => {
                request.usage.as_mut().unwrap().current_total_input_tokens =
                    if cause == "85" { 85_000 } else { 95_000 };
                s.arm_soft_refresh("review").unwrap();
            }
            "m0" => {
                s.with_context_conn_for_test(|tx| {
                    tx.execute("UPDATE compartments SET content='rewritten',p1='rewritten' WHERE session_id='review'", [])?;
                    tx.execute("INSERT INTO m0_mutation_log(session_id,mutation_type,target_id,queued_at) VALUES('review','recomp_boundary_change',NULL,1)", [])?;
                    Ok(())
                }).unwrap();
            }
            _ => unreachable!(),
        }
        let rebuilt = transform(&s, &request, &ctx).unwrap();
        assert_ne!(rebuilt.action, "SOFT+", "{cause}: {rebuilt:?}");
        assert!(rebuilt.prefix_bust_permitted, "{cause}: {rebuilt:?}");
        if cause == "flush" {
            assert!(!s.load("review").unwrap().meta.soft_refresh_pending);
        }
        assert_eq!(
            s.load("review").unwrap().meta.last_system_prompt_hash,
            "new",
            "{cause}"
        );
    }
}

#[test]
fn review_adoption_keeps_candidate_mural_pending_until_an_independent_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let mut request = request();
    request.mural = Some(crate::m0_compose::M0MuralInput {
        enabled: true,
        supports_vision: true,
        data_url: Some("data:image/png;base64,YQ==".into()),
        content_hash: Some("mural-a".into()),
    });
    let mut ctx = pctx("git:proj", "/nonexistent-review-project", 1000);
    ctx.cache_ttl = "never".into();
    let before = transform(&s, &request, &ctx).unwrap();
    delivered(&mut request);
    request.mural.as_mut().unwrap().data_url = Some("data:image/png;base64,Yg==".into());
    request.mural.as_mut().unwrap().content_hash = Some("mural-b".into());
    let after = transform(&s, &request, &ctx).unwrap();
    assert_eq!(after.action, "SOFT+");
    assert_eq!(before.ck_messages, after.ck_messages);
    assert!(!after.prefix_bust_permitted);
    request.render_config.push_str("|independent-tools-change");
    let folded = transform(&s, &request, &ctx).unwrap();
    assert_eq!(folded.action, "HARD");
    assert!(format!("{:?}", folded.ck_messages).contains("Yg=="));
    let stable = transform(&s, &request, &ctx).unwrap();
    assert_eq!(stable.action, "SOFT+");
    assert_eq!(stable.ck_messages, folded.ck_messages);
}

#[test]
fn review_adoption_preserves_published_history_across_restart_until_one_independent_fold() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let compartment =
        |sequence, start, end, end_id: &str, text: &str| mc_store::StoredCompartment {
            sequence,
            start_message: start,
            end_message: end,
            end_message_id: end_id.into(),
            title: format!("history-{sequence}"),
            content: text.into(),
            p1: Some(text.into()),
            importance: 50,
            ..Default::default()
        };
    s.replace_compartments("review", &[compartment(1, 1, 1, "a#0", "FIRST_HISTORY")])
        .unwrap();
    let mut request = request();
    request.messages = vec![
        item("a", 1, "covered"),
        item("b", 2, "later raw"),
        item("tail", 3, "latest user"),
    ];
    let mut ctx = pctx("git:proj", "/nonexistent-review-project", 1000);
    ctx.cache_ttl = "never".into();
    let initial = transform(&s, &request, &ctx).unwrap();
    s.replace_compartments(
        "review",
        &[
            compartment(1, 1, 1, "a#0", "FIRST_HISTORY"),
            compartment(2, 2, 2, "b#0", "SECOND_HISTORY"),
        ],
    )
    .unwrap();
    delivered(&mut request);
    let adopted = transform(&s, &request, &ctx).unwrap();
    assert_eq!(adopted.action, "SOFT+");
    assert_eq!(initial.ck_messages, adopted.ck_messages);
    assert_eq!(
        s.load("review").unwrap().meta.last_system_prompt_hash,
        "new"
    );
    drop(s);
    let s = store(dir.path());
    let restart = transform(&s, &request, &ctx).unwrap();
    assert_eq!(restart.action, "SOFT+");
    assert_eq!(restart.ck_messages, adopted.ck_messages);
    request.render_config.push_str("|independent-change");
    let folded = transform(&s, &request, &ctx).unwrap();
    assert_eq!(folded.action, "HARD");
    let text = folded
        .messages()
        .iter()
        .flat_map(|message| message.content.iter())
        .filter_map(|block| {
            if let ck_wire::CkKind::Text { text } = &block.kind {
                Some(text.as_str())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(text.matches("SECOND_HISTORY").count(), 1);
    let stable = transform(&s, &request, &ctx).unwrap();
    assert_eq!(stable.action, "SOFT+");
    assert_eq!(stable.ck_messages, folded.ck_messages);
}
