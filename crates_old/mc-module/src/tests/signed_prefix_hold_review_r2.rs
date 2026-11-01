// Probes of prefix-bound signed thinking: the cached m0/m1 head and bytes before
// kept reasoning must replay unchanged until a real user message, or a genuine
// head rewrite removes the signatures bound to the old prefix. Included after
// signed_prefix_hold_review.rs in transform.rs's test module. Only temporary
// stores are used; no provider is called.

#[test]
#[ignore = "report-only extended randomized review"]
fn review_r2_randomized_new_seeds_three_times_the_passes() {
    let mut total = ReviewHeldStats::default();
    for (index, seed) in [
        0x3141_5926_5358_9793u64,
        0x2718_2818_2845_9045,
        0x6A09_E667_F3BC_C909,
        0xBB67_AE85_84CA_A73B,
        0x3C6E_F372_FE94_F82B,
        0xA54F_F53A_5F1D_36F1,
    ]
    .into_iter()
    .enumerate()
    {
        let model = if index % 2 == 0 {
            REVIEW_BOUND
        } else {
            REVIEW_BOUND_ALT
        };
        let stats = review_held_driver(seed, model, false, 240);
        total.passes += stats.passes;
        total.held += stats.held;
        total.releases += stats.releases;
        total.releases_with_work += stats.releases_with_work;
        total.pressure += stats.pressure;
        total.idle += stats.idle;
        total
            .in_turn_head_rewrites
            .extend(stats.in_turn_head_rewrites);
    }
    eprintln!("signed-hold r2 driver: {total:#?}");
    assert!(total.passes >= 3 * 449, "{total:?}");
    assert!(total.held >= 3 * 349, "{total:?}");
    assert!(total.releases_with_work >= 3 * 19, "{total:?}");
    assert!(total.in_turn_head_rewrites.is_empty(), "{total:?}");
}

/// Compare the complete ordered prefix, not just surviving messages keyed by id:
/// removal or reordering before the kept signature is a binding violation too.
fn review_r2_prefix_through(response: &TransformResponse, mid: &str) -> Vec<Vec<u8>> {
    let end = response
        .messages()
        .iter()
        .position(|message| message.meta.harness_id.as_deref() == Some(mid))
        .expect("kept thinking message is served");
    let mut prefix: Vec<CkWireMessage> = response.messages()[..=end]
        .iter()
        .map(|message| (**message).clone())
        .collect();
    let kept = prefix.last_mut().unwrap();
    let reasoning_end = kept.content.iter().rposition(is_reasoning_block).unwrap();
    kept.content.truncate(reasoning_end + 1);
    prefix
        .iter()
        .map(|message| serde_json::to_vec(message).unwrap())
        .collect()
}

#[test]
fn review_r2_tail_soft_preserves_ordered_prefix_and_releases_once() {
    for (used, recovery, idle) in [
        (86_000, false, false),
        (95_000, false, false),
        (30_000, true, false),
        (66_000, false, true),
    ] {
        let (mut sim, baseline) = review_open_turn_with_publication("r2-tail");
        let kept = sim.last_kept_reasoning_mid().unwrap();
        let early = sim.tool_results[0].clone();
        let late = sim.tool_results.last().unwrap().clone();
        sim.s()
            .append_pending_agent_drops(&sim.session, &[early.clone(), late.clone()], 1)
            .unwrap();
        review_edit_meta(sim.s(), &sim.session, |meta| {
            meta.soft_refresh_pending = true;
            meta.project_memory_epoch_pending = true;
        });
        regate_mark_history_pending(sim.s(), &sim.session);
        sim.used = used;
        if idle {
            sim.ctx.observed_last_response_at_ms = Some(sim.ctx.now_ms + 1);
            sim.ctx.now_ms += 10 * 60_000;
        }
        let relieved = sim.run(recovery).unwrap();
        assert_eq!(relieved.action, "SOFT");
        let before = review_r2_prefix_through(&baseline, &kept);
        let after = review_r2_prefix_through(&relieved, &kept);
        assert_eq!(
            before.len(),
            after.len(),
            "used={used} recovery={recovery} idle={idle}: prefix length"
        );
        for (index, (old, new)) in before.iter().zip(&after).enumerate() {
            assert!(old == new, "used={used} recovery={recovery} idle={idle}: prefix message {index} changed: {} -> {}", String::from_utf8_lossy(old), String::from_utf8_lossy(new));
        }
        assert_eq!(
            review_pending(sim.s(), &sim.session),
            BTreeSet::from([early])
        );
        assert!(
            sim.s()
                .load(&sim.session)
                .unwrap()
                .meta
                .soft_refresh_pending
        );
        assert!(
            sim.s()
                .load(&sim.session)
                .unwrap()
                .meta
                .project_memory_epoch_pending
        );
        assert!(frozen_red_targets(&sim.s().load(&sim.session).unwrap().core).contains(&late));
        sim.user_turn();
        sim.used = 66_000;
        if idle {
            sim.ctx.observed_last_response_at_ms = Some(sim.ctx.now_ms);
        }
        let released = sim.run(false).unwrap();
        assert_eq!(released.action, "HARD");
        assert!(review_pending(sim.s(), &sim.session).is_empty());
        let meta = sim.s().load(&sim.session).unwrap().meta;
        assert!(!meta.soft_refresh_pending);
        assert!(!meta.project_memory_epoch_pending);
        let resent = sim.run(false).unwrap();
        assert_eq!(resent.action, "SOFT+");
        assert_eq!(review_bytes(&released), review_bytes(&resent));
        eprintln!("r2 tail used={used} recovery={recovery} idle={idle}: ordered prefix stable, release HARD then exact replay");
    }
}

#[test]
fn review_r2_changed_floor_is_applied_on_release_and_not_lost() {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, false, "r2-floor");
    sim.run(false).unwrap();
    review_edit_meta(sim.s(), &sim.session, |meta| {
        meta.protected_tokens_effective = None
    });
    sim.run(false).unwrap();
    for _ in 0..3 {
        sim.tool_step();
        sim.run(false).unwrap();
    }
    let baseline = sim.run(false).unwrap();
    // While the signed prefix is held, token-floor changes must resolve to the
    // latest configured floor on release, not the first change observed.
    for floor in [24_000, 32_000, 28_000] {
        sim.ctx.protected_tokens_floor = floor;
        let held = sim.run(false).unwrap();
        assert_eq!(held.action, "SOFT+");
        assert_eq!(review_bytes(&held), review_bytes(&baseline));
        assert_eq!(
            sim.s()
                .load(&sim.session)
                .unwrap()
                .meta
                .protected_tokens_effective,
            None
        );
        assert_eq!(
            crate::protection_window::pre_snapshot_floor(
                sim.s().tag_cache_namespace(),
                &sim.session
            ),
            Some(16_000)
        );
    }
    sim.user_turn();
    let released = sim.run(false).unwrap();
    assert_eq!(released.action, "HARD");
    assert_eq!(
        released.materialize_reason.as_deref(),
        Some("protected_tokens_inputs_changed")
    );
    assert_eq!(
        sim.s()
            .load(&sim.session)
            .unwrap()
            .meta
            .protected_tokens_effective,
        Some(28_000)
    );
    let resent = sim.run(false).unwrap();
    assert_eq!(resent.action, "SOFT+");
    assert_eq!(review_bytes(&resent), review_bytes(&released));
    assert_eq!(
        sim.s()
            .load(&sim.session)
            .unwrap()
            .meta
            .protected_tokens_effective,
        Some(28_000)
    );
    eprintln!("r2 floor: held 24000/32000/28000; release snapshots 28000, resend exact");
}

/// Sum only text in tool results. This omits all head, user, assistant and envelope
/// tokens, so exceeding the wall here proves the complete serve cannot fit either.
fn review_r2_result_token_lower_bound(response: &TransformResponse) -> usize {
    response
        .messages()
        .iter()
        .flat_map(|message| &message.content)
        .filter_map(|block| {
            if let ck_wire::CkKind::ToolResult { output, .. } = &block.kind {
                if let ck_wire::CkOutputKind::Text { text } = &output.kind {
                    return Some(mc_tokenizer::estimate_tokens(text));
                }
            }
            None
        })
        .sum()
}

#[test]
fn review_r2_witness_signed_loop_over_window_must_fit_or_refuse() {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, false, "r2-pressure");
    // Later signed reasoning binds the large results to unchanged prefix bytes.
    // No protected_tools count setting independently protects these results.
    sim.ctx.protected_tools.clear();
    sim.run(false).unwrap();
    let payload = (0..700)
        .map(|n| format!("entry{n:04} value{n:04}\n"))
        .collect::<String>();
    for _ in 0..20 {
        sim.tool_step();
        let result = sim.messages.last_mut().unwrap();
        if let ck_wire::CkKind::ToolResult { output, .. } = &mut result.ck.content[0].kind {
            output.kind = ck_wire::CkOutputKind::Text {
                text: payload.clone(),
            };
        }
        sim.run(false).unwrap();
    }
    let near_wall = review_r2_result_token_lower_bound(&sim.run(false).unwrap());
    assert!(
        (90_000..98_000).contains(&near_wall),
        "near-95% fixture: {near_wall}"
    );
    sim.tool_step();
    if let ck_wire::CkKind::ToolResult { output, .. } =
        &mut sim.messages.last_mut().unwrap().ck.content[0].kind
    {
        output.kind = ck_wire::CkOutputKind::Text {
            text: payload.repeat(2),
        };
    }
    sim.run(false).unwrap();
    // The next assistant's signature binds every earlier result, including the
    // one that pushed the input over 100000 tokens. Its own result is tiny, so
    // dropping that result cannot bring the earlier output under the limit.
    sim.tool_step();
    let baseline = sim.run(false).unwrap();
    let bound = review_r2_result_token_lower_bound(&baseline);
    assert!(bound > 100_000, "fixture has to exceed the wall: {bound}");
    let protected = active_thinking_prefix_edit_ids(
        &sim.s().load(&sim.session).unwrap().core,
        &sim.request(false),
    );
    assert!(sim.tool_results[..21]
        .iter()
        .all(|id| protected.contains(id)));
    sim.s()
        .append_pending_agent_drops(&sim.session, &sim.tool_results[..21], 1)
        .unwrap();
    review_edit_meta(sim.s(), &sim.session, |meta| {
        meta.soft_refresh_pending = true;
        meta.project_memory_epoch_pending = true;
    });
    regate_mark_history_pending(sim.s(), &sim.session);
    sim.used = 95_000;
    let mut request = sim.request(false);
    let usage = request.usage.as_mut().unwrap();
    usage.final_wire_trusted = true;
    usage.final_wire_input_tokens = bound as u64;
    match transform(sim.s(), &request, &sim.ctx) {
        Err(error) => eprintln!("r2 pressure refused: {error:?}; result-token lower bound={bound}"),
        Ok(response) => {
            let remaining = review_r2_result_token_lower_bound(&response);
            eprintln!("r2 pressure returned action={} scheduler={:?} near_wall={near_wall} before={bound} after={remaining} head_same={} pending={}", response.action, response.scheduler_decision, review_head(&response) == review_head(&baseline), review_pending(sim.s(), &sim.session).len());
            assert_eq!(review_head(&response), review_head(&baseline));
            assert!(remaining <= 100_000, "returned {} with at least {remaining} tool-result tokens against a 100000-token wall instead of fitting or refusing", response.action);
        }
    }
}

#[test]
fn review_r2_render_identity_change_survives_tail_soft_until_release() {
    let (mut sim, baseline) = review_open_turn_with_publication("r2-identity");
    let late = sim.tool_results.last().unwrap().clone();
    sim.s()
        .append_pending_agent_drops(&sim.session, &[late], 1)
        .unwrap();
    sim.used = 86_000;
    let mut request = sim.request(false);
    request.render_config = "cfg1".to_string();
    let tail = transform(sim.s(), &request, &sim.ctx).unwrap();
    assert_eq!(tail.action, "SOFT");
    assert_eq!(review_head(&baseline), review_head(&tail));
    sim.user_turn();
    request.messages = sim.messages.clone();
    let released = transform(sim.s(), &request, &sim.ctx).unwrap();
    assert_eq!(
        released.action, "HARD",
        "the deferred render identity must still be visible after a tail SOFT"
    );
    assert_eq!(released.materialize_reason.as_deref(), Some("epoch_change"));
    let replay = transform(sim.s(), &request, &sim.ctx).unwrap();
    assert_eq!(replay.action, "SOFT+");
    assert_eq!(review_bytes(&replay), review_bytes(&released));
}

/// Not a defect, and not the module's contract. Queued drops never originate a bust
/// (ARCHITECTURE invariant 4): they ride the next bust, whenever it comes. Held work that
/// would itself bust (a flush, a publication, a HARD trigger) is what releases in one bust
/// on the first pass after the turn. This probe asserts the stronger, rejected rule, so it
/// stays ignored as a record of that ruling.
#[test]
#[ignore = "not the contract: plain queued drops ride the next bust (invariant 4); only held work that busts by itself releases on the next user turn"]
fn review_r2_rejected_rule_drop_only_release_applies_all_held_work() {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, false, "r2-drop-only");
    sim.run(false).unwrap();
    for _ in 0..3 {
        sim.tool_step();
        sim.run(false).unwrap();
    }
    let target = sim.tool_results[0].clone();
    sim.s()
        .append_pending_agent_drops(&sim.session, &[target], 1)
        .unwrap();
    sim.used = 66_000;
    let held = sim.run(false).unwrap();
    assert_eq!(held.action, "SOFT+");
    assert_eq!(review_pending(sim.s(), &sim.session).len(), 1);
    sim.user_turn();
    let released = sim.run(false).unwrap();
    let pending = review_pending(sim.s(), &sim.session);
    eprintln!(
        "r2 drop-only release action={} reason={:?} pending={pending:?}",
        released.action, released.materialize_reason
    );
    assert!(
        pending.is_empty(),
        "the first next-turn pass left held work queued: {pending:?} (action {})",
        released.action
    );
    let resent = sim.run(false).unwrap();
    assert_eq!(resent.action, "SOFT+");
    assert_eq!(review_bytes(&resent), review_bytes(&released));
}

/// Attach OpenCode messages to the engine result with the dispatcher's serializer.
/// The raw fixture records which original tool part produced its call/result
/// blocks, so the serializer emits one completed tool part rather than duplicate calls.
fn review_r2_native_run(sim: &ReviewSession, raw: &[Value]) -> TransformResponse {
    let mut request = sim.request(false);
    request.messages = crate::codec::decode_opencode(raw).messages;
    request.serve_native = true;
    request.native_messages = Some(raw.to_vec());
    let result = transform_with_projection(sim.s(), &request, &sim.ctx).unwrap();
    let native = crate::encode_full_native_messages(
        &result.response,
        &request,
        &result.reasoning_clear_units,
        &result.tag_numbers,
        result.mutation_exempt_mid.as_deref(),
        result.lineage_anchor_mid.as_deref(),
        result.transition_consumed,
    );
    let mut response = result.response;
    response.native_messages = Some(native.into_iter().map(std::sync::Arc::new).collect());
    response
}

#[test]
fn review_r2_native_engine_exports_force_and_idle_for_host_strip() {
    for variant in 0..3 {
        let idle = variant == 1;
        let rewriting = variant == 2;
        let kind = if rewriting {
            "rewrite"
        } else if idle {
            "idle"
        } else {
            "force"
        };
        let mut sim = ReviewSession::new(
            REVIEW_BOUND,
            true,
            false,
            if rewriting {
                "r2-host-rewrite"
            } else if idle {
                "r2-host-idle"
            } else {
                "r2-host-force"
            },
        );
        let mut raw = vec![
            json!({"info": {"id": "u1", "role": "user", "sessionID": sim.session}, "parts": [{"type": "text", "text": "earlier task"}]}),
            json!({"info": {"id": "a2", "role": "assistant", "sessionID": sim.session}, "parts": [{"type": "reasoning", "text": "older-think", "metadata": {"anthropic": {"signature": "sig-older-think"}}}, {"type": "text", "text": "earlier answer"}]}),
            json!({"info": {"id": "u3", "role": "user", "sessionID": sim.session}, "parts": [{"type": "text", "text": "current task"}]}),
        ];
        review_r2_native_run(&sim, &raw);
        for n in 4..=6 {
            raw.push(json!({"info": {"id": format!("a{n}"), "role": "assistant", "sessionID": sim.session}, "parts": [
                {"type": "reasoning", "text": format!("think {n}"), "metadata": {"anthropic": {"signature": format!("sig-think {n}")}}},
                {"type": "text", "text": format!("note {n}")},
                {"type": "tool", "callID": format!("t{n}"), "tool": "read", "state": {"status": "completed", "input": {"path": "a.txt"}, "output": format!("output {n} {}", "x".repeat(400))}}
            ]}));
            review_r2_native_run(&sim, &raw);
        }
        raw.push(json!({"info": {"id": "a7", "role": "assistant", "sessionID": sim.session}, "parts": [
            {"type": "text", "text": "unsigned step after the kept thinking"},
            {"type": "tool", "callID": "t7", "tool": "read", "state": {"status": "completed", "input": {"path": "late.txt"}, "output": "late output ".repeat(400)}}
        ]}));
        review_r2_native_run(&sim, &raw);
        let baseline = review_r2_native_run(&sim, &raw);
        assert!(review_serves_signature(&baseline, "older-think"));
        sim.s()
            .append_pending_agent_drops(&sim.session, &["a7#2".to_string()], 1)
            .unwrap();
        sim.used = if idle { 66_000 } else { 86_000 };
        if idle {
            sim.ctx.observed_last_response_at_ms = Some(sim.ctx.now_ms + 1);
            sim.ctx.now_ms += 10 * 60_000;
        }
        if rewriting {
            sim.s()
                .replace_compartments(
                    &sim.session,
                    &[
                        comp(1, 1, 1, "u1", "SUMMARY-1"),
                        comp(2, 2, 2, "a2", "OLDER SUMMARY"),
                    ],
                )
                .unwrap();
            let mut loaded = sim.s().load(&sim.session).unwrap();
            loaded.core.frozen_units.retain(|unit| unit.key != "m1");
            sim.s()
                .commit(&sim.session, loaded.row_version, &loaded.core, &loaded.meta)
                .unwrap();
        }
        let pressured = review_r2_native_run(&sim, &raw);
        assert_eq!(pressured.action, if rewriting { "HARD" } else { "SOFT" });
        assert!(pressured.prefix_bust_permitted);
        assert_ne!(
            baseline.native_messages, pressured.native_messages,
            "the native output must actually change, not merely grant permission"
        );
        if rewriting {
            assert_ne!(review_head(&baseline), review_head(&pressured));
        } else {
            assert_eq!(
                review_r2_prefix_through(&baseline, "a6"),
                review_r2_prefix_through(&pressured, "a6")
            );
            assert!(review_serves_signature(&pressured, "older-think"));
        }
        let fixture = json!({"session_id": sim.session, "kind": kind, "idle": idle, "input": raw, "before": baseline, "pressured": pressured});
        if let Ok(directory) = std::env::var("MC_REVIEW_R2_EXPORT_DIR") {
            let path = std::path::Path::new(&directory).join(format!("{kind}.json"));
            std::fs::write(path, serde_json::to_vec_pretty(&fixture).unwrap()).unwrap();
        }
        eprintln!(
            "r2 native engine kind={kind}: decision={} head_same={} active_signature_kept={}",
            pressured.action,
            review_head(&baseline) == review_head(&pressured),
            review_serves_signature(&pressured, "think 6")
        );
        println!(
            "R2_HOST_FIXTURE {}",
            json!({
                "session_id": sim.session, "kind": kind, "idle": idle, "input": fixture["input"],
                "before": {"decision": fixture["before"]["decision"], "prefix_bust_permitted": fixture["before"]["prefix_bust_permitted"], "native_messages": fixture["before"]["native_messages"], "reasoning_trim_only": fixture["before"]["reasoning_trim_only"]},
                "pressured": {"decision": fixture["pressured"]["decision"], "prefix_bust_permitted": fixture["pressured"]["prefix_bust_permitted"], "native_messages": fixture["pressured"]["native_messages"], "reasoning_trim_only": fixture["pressured"]["reasoning_trim_only"], "signed_thinking_reset": fixture["pressured"]["signed_thinking_reset"]}
            })
        );
    }
}

#[test]
fn review_r2_witness_rewriting_head_cannot_keep_signed_thinking() {
    let (mut sim, before) = review_open_turn_with_publication("r2-unreplayable");
    let mut loaded = sim.s().load(&sim.session).unwrap();
    loaded.core.frozen_units.retain(|unit| unit.key != "m1");
    sim.s()
        .commit(&sim.session, loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
    let after = sim.run(false).unwrap();
    assert_eq!(after.action, "HARD");
    assert_ne!(
        review_head(&after),
        review_head(&before),
        "the rebuilt head must really differ"
    );
    let kept = review_serves_signature(&after, &format!("think {}", sim.ordinal - 1));
    eprintln!(
        "r2 unavoidable: action={} reason={:?} head_changed=true active_signature_kept={kept}",
        after.action, after.materialize_reason
    );
    assert!(
        !kept,
        "a truly rewritten head kept signed thinking bound to the old prefix"
    );
}
