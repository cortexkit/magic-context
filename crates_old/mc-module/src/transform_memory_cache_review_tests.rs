use mc_store::memory_projection::{text_line, AgentFragment, AppliedProjection, VisibleText};
use mc_tokenizer::estimate_tokens;

fn assert_automated_memory_change(operation: &str) {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
        .unwrap();
    let id = s
        .insert_memory(memory_input(
            "git:proj",
            "CONSTRAINTS",
            "cache_ttl is 5 minutes in config.ts.",
            0,
        ))
        .unwrap();
    let second = if operation == "curate_merge" {
        Some(
            s.insert_memory(memory_input(
                "git:proj",
                "CONSTRAINTS",
                "config.ts declares a 5 minute cache_ttl.",
                0,
            ))
            .unwrap(),
        )
    } else {
        None
    };
    if operation == "expiry_archive" {
        s.with_context_conn_for_test(|conn| {
            conn.execute("UPDATE memories SET expires_at=1 WHERE id=?1", [id])
        })
        .unwrap();
    }
    let mut request = req(
        "ses",
        "cfg0",
        vec![item("a", 1, "raw"), item("tail", 2, "tail")],
    );
    request.auto_search_enabled = false;
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let before = transform(&s, &request, &ctx).unwrap();
    let served_before = serde_json::to_vec(before.messages()).unwrap();
    assert!(m0_bytes(&before).contains("cache_ttl is 5 minutes"));
    let corrected = "cache_ttl is 10 minutes in config.ts.";
    let original_hash = s.get_memory_full(id).unwrap().unwrap().normalized_hash;
    s.with_facade_command(
        "/tmp",
        "git:proj",
        "memories",
        "ses",
        "memory.curate",
        operation.rsplit('_').next().unwrap(),
        Some(operation),
        |agent_tx| {
            let tx = agent_tx.automated();
            match operation {
                "curate_update" => {
                    tx.update_memory_content("git:proj", id, corrected, None, 2)
                        .map_err(|e| e.to_string())?;
                }
                "curate_merge" => {
                    tx.merge_memories_canonical(
                        "git:proj",
                        &[id, second.unwrap()],
                        corrected,
                        Some("ses"),
                        2,
                    )
                    .map_err(|e| e.to_string())?;
                }
                "curate_archive" => {
                    tx.archive_memories("git:proj", &[id], Some("obsolete"), 2)
                        .map_err(|e| e.to_string())?;
                }
                "verify_archive" | "verify_update" => {
                    let result = tx.set_memory_verification(
                        "git:proj",
                        &[mc_store::VerificationUpdate {
                            memory_id: id,
                            content_hash_at_prompt: original_hash.clone(),
                            verification_status: if operation == "verify_update" {
                                "update"
                            } else {
                                "archive"
                            }
                            .into(),
                            updated_content: Some(corrected.into()),
                            archive_reason: Some("obsolete".into()),
                        }],
                        2,
                    )?;
                    assert_eq!(result.accepted, vec![id]);
                }
                "expiry_archive" => {
                    assert_eq!(tx.expire_memories("git:proj", &[id], 2)?.accepted, vec![id]);
                }
                _ => unreachable!(),
            }
            Ok(Vec::new())
        },
    )
    .unwrap();
    let row = s.get_memory_full(id).unwrap().unwrap();
    if operation.ends_with("archive") || second.is_some() {
        assert_eq!(row.status, "archived");
    } else {
        assert_eq!(row.content, corrected);
    }
    s.with_context_conn_for_test(|conn| {
        let (previous, snapshot): (String, String) = conn.query_row(
            "SELECT previous_text,before_json FROM memory_history WHERE memory_id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(previous, "cache_ttl is 5 minutes in config.ts.");
        assert_eq!(
            mc_store::memory_history::normalize_snapshot(
                &serde_json::from_str::<Value>(&snapshot).unwrap(),
                None
            )
            .unwrap()["status"],
            "active"
        );
        if let Some(second) = second {
            assert_eq!(
                conn.query_row(
                    "SELECT previous_text FROM memory_history WHERE memory_id=?1",
                    [second],
                    |row| row.get::<_, String>(0)
                )?,
                "config.ts declares a 5 minute cache_ttl."
            );
        }
        for table in [
            "memory_mutation_log",
            "memory_agent_fragments",
            "memory_tool_proposals",
        ] {
            assert_eq!(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))?,
                0,
                "{table}"
            );
        }
        Ok(())
    })
    .unwrap();
    let deferred = transform(&s, &request, &ctx).unwrap();
    assert_eq!(
        serde_json::to_vec(deferred.messages()).unwrap(),
        served_before
    );
    s.arm_soft_refresh("ses").unwrap();
    let soft = transform(&s, &request, &ctx).unwrap();
    assert_eq!(soft.action, "SOFT");
    assert_eq!(serde_json::to_vec(soft.messages()).unwrap(), served_before);
    request.render_config = "cfg-natural-rebuild".into();
    let hard = transform(&s, &request, &ctx).unwrap();
    assert_eq!(hard.action, "HARD");
    assert!(!m0_bytes(&hard).contains("cache_ttl is 5 minutes"));
    if !operation.ends_with("archive") {
        assert!(m0_bytes(&hard).contains(corrected));
    }
    let page = s
        .memory_history_rpc(
            "memory.history",
            &json!({ "projectPath":"git:proj", "memoryId":id }),
            3,
        )
        .unwrap();
    assert_eq!(page["decisions"].as_array().unwrap().len(), 1);
    let key = page["decisions"][0]["decisionKey"].clone();
    let preview = s
        .memory_history_rpc(
            "memory.restore.preview",
            &json!({ "projectPath":"git:proj", "decisionKey":key }),
            3,
        )
        .unwrap();
    assert_eq!(preview["state"], "ready");
    let restore = json!({ "projectPath":"git:proj", "decisionKey":key, "operationId":format!("{operation}-undo"), "expectedRevisions":preview["expectedRevisions"] });
    let receipt = s.memory_history_rpc("memory.restore", &restore, 3).unwrap();
    assert_eq!(receipt["state"], "applied");
    assert_eq!(s.get_memory_full(id).unwrap().unwrap().status, "active");
    assert_eq!(
        s.get_memory_full(id).unwrap().unwrap().content,
        "cache_ttl is 5 minutes in config.ts."
    );
    let held_restore = transform(&s, &request, &ctx).unwrap();
    assert_eq!(serde_json::to_vec(held_restore.messages()).unwrap(), serde_json::to_vec(hard.messages()).unwrap());
    s.arm_soft_refresh("ses").unwrap();
    let delta_restore = transform(&s, &request, &ctx).unwrap();
    assert_eq!(delta_restore.action, "SOFT");
    assert!(serde_json::to_string(delta_restore.messages()).unwrap().contains("cache_ttl is 5 minutes"));
    request.render_config = "cfg-restored-natural-rebuild".into();
    let epoch_hard = transform(&s, &request, &ctx).unwrap();
    assert_eq!(epoch_hard.action, "HARD");
    assert!(
        m0_bytes(&epoch_hard).contains("cache_ttl is 5 minutes"),
        "restored HARD bytes: {}",
        m0_bytes(&epoch_hard)
    );
    assert_eq!(
        s.memory_history_rpc("memory.restore", &restore, 4).unwrap(),
        receipt
    );
    s.arm_soft_refresh("ses").unwrap();
    let after_epoch = transform(&s, &request, &ctx).unwrap();
    assert_eq!(after_epoch.action, "SOFT");
    assert_eq!(
        serde_json::to_vec(after_epoch.messages()).unwrap(),
        serde_json::to_vec(epoch_hard.messages()).unwrap()
    );
}

#[test]
fn module_curate_update_applies_with_history_and_waits_for_hard() {
    assert_automated_memory_change("curate_update");
}
#[test]
fn module_curate_merge_applies_with_history_and_waits_for_hard() {
    assert_automated_memory_change("curate_merge");
}
#[test]
fn module_curate_archive_applies_with_history_and_waits_for_hard() {
    assert_automated_memory_change("curate_archive");
}
#[test]
fn module_verify_archive_applies_with_history_and_waits_for_hard() {
    assert_automated_memory_change("verify_archive");
}
#[test]
fn module_verify_update_applies_with_history_and_waits_for_hard() {
    assert_automated_memory_change("verify_update");
}
#[test]
fn module_expiry_archive_applies_with_history_and_waits_for_hard() {
    assert_automated_memory_change("expiry_archive");
}

fn edit(s: &McStore, session: &str, id: i64, text: &str, key: &str) -> Result<(), McStoreError> {
    s.with_facade_command(
        "/tmp",
        "git:proj",
        "memories",
        session,
        "ctx_memory",
        "update",
        Some(key),
        |tx| {
            let row = tx
                .update_memory_content("git:proj", id, text, None, 0)
                .map_err(|e| e.to_string())?;
            tx.record_agent_fragment(
                session,
                "git:proj",
                key,
                &[id],
                Some(id),
                &[text_line("updated", id, &row.category, &row.content)],
                &[VisibleText {
                    id,
                    text: row.content,
                }],
                0,
            )?;
            Ok(Vec::new())
        },
    )?;
    Ok(())
}

#[test]
fn review_fragment_failure_rolls_back_canonical_edit_and_history() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let id = s
        .insert_memory(memory_input("git:proj", "CONSTRAINTS", "original claim", 0))
        .unwrap();
    s.with_context_conn_for_test(|conn| conn.execute_batch("CREATE TRIGGER review_fragment_failure BEFORE INSERT ON memory_agent_fragments BEGIN SELECT RAISE(ABORT, 'review fragment failure'); END;")).unwrap();
    assert!(edit(&s, "ses", id, "must roll back", "failed-fragment").is_err());
    drop(s);
    let s = store(dir.path());
    s.with_context_conn_for_test(|conn| {
        let content: String =
            conn.query_row("SELECT content FROM memories WHERE id=?1", [id], |row| {
                row.get(0)
            })?;
        assert_eq!(content, "original claim");
        for table in [
            "memory_history",
            "memory_mutation_log",
            "memory_agent_fragments",
        ] {
            let count: i64 =
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?;
            assert_eq!(count, 0, "{table} must roll back with the row");
        }
        Ok(())
    })
    .unwrap();
}

#[test]
fn review_shown_full_and_marker_lines_survive_budget_collapse() {
    let mut projection = AppliedProjection::default();
    let fragment = |id: i64, text: &str| AgentFragment {
        dashboard_log_id: None,
        id,
        operation_key: format!("op-{id}"),
        memory_ids: vec![id],
        current_id: Some(id),
        lines: vec![text_line("updated", id, "CONSTRAINTS", text)],
        visible_texts: vec![VisibleText {
            id,
            text: text.into(),
        }],
    };
    let (first, next) = crate::agent_fragments::compose(
        projection,
        &[fragment(1, "fully shown")],
        8000.0,
        60000.0,
        0,
        0,
        estimate_tokens,
    );
    projection = next;
    assert!(first.contains("fully shown"));
    let (second, next) = crate::agent_fragments::compose(
        projection,
        &[fragment(2, &"oversized correction ".repeat(5000))],
        8000.0,
        60000.0,
        0,
        0,
        estimate_tokens,
    );
    projection = next;
    assert!(second.contains("<stale-memory ids=\"2\""));
    let retained = projection.committed.clone();
    let pending = (3..103)
        .map(|id| fragment(id, "new correction"))
        .collect::<Vec<_>>();
    let (third, next) = crate::agent_fragments::compose(
        projection,
        &pending,
        0.0,
        0.0,
        50000,
        8000,
        estimate_tokens,
    );
    assert_eq!(&next.committed[..retained.len()], retained.as_slice());
    assert!(third.contains("fully shown"));
    assert!(third.contains("<stale-memory ids=\"2\""));
    assert_eq!(third.matches("<more-memory-edits ").count(), 1);
    assert_eq!(next.committed.last().unwrap().overflow_count, Some(100));
}

#[test]
#[ignore = "requires Bun and installed workspace packages; run explicitly for the independent cache review"]
fn review_randomized_served_sequences_match_ts_composer() {
    let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut oracle_inputs = Vec::new();
    let mut actual_soft = Vec::new();
    let mut counts = [0usize; 7];
    for seed_start in [0x8b45a029u32, 0xa643d711, 0x137efccb, 0xc09d32a1] {
        let dir = tempfile::tempdir().unwrap();
        let mut s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
            .unwrap();
        let id = s
            .insert_memory(memory_input("git:proj", "CONSTRAINTS", "baseline", 0))
            .unwrap();
        let mut request = req(
            "ses",
            "cfg0",
            vec![item("a", 1, "raw"), item("tail", 2, "tail")],
        );
        request.auto_search_enabled = false;
        let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
        let mut shown = transform(&s, &request, &ctx).unwrap();
        let mut random = seed_start;
        let mut next = || {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            random
        };
        for step in 0..160 {
            let old_m0 = m0_bytes(&shown).to_string();
            let previous = serde_json::to_vec(shown.messages()).unwrap();
            let owner = if next() % 2 == 0 { "ses" } else { "foreign" };
            let mut canonical = format!("{owner} seed {seed_start} step {step}: literal & <claim> \"quoted\" 🦀\nsecond line");
            edit(&s, owner, id, &canonical, &format!("{seed_start}-{step}")).unwrap();
            if next() % 3 == 0 {
                canonical = format!("automated seed {seed_start} step {step}");
                s.with_context_conn_for_test(|conn| {
                    conn.execute(
                        "UPDATE memories SET content=?1,revision=revision+1 WHERE id=?2",
                        rusqlite::params![canonical, id],
                    )
                })
                .unwrap();
            }
            let action = next() % 7;
            counts[action as usize] += 1;
            if action == 3 {
                drop(s);
                s = store(dir.path());
            }
            if action == 4 {
                let stale = s.load("ses").unwrap();
                s.arm_soft_refresh("ses").unwrap();
                let current = s.load("ses").unwrap();
                assert!(current.row_version > stale.row_version);
                assert!(s
                    .commit("ses", stale.row_version, &stale.core, &stale.meta)
                    .is_err());
            }
            if action == 5 {
                ctx.memory_budget_tokens = 8000.0;
                request.render_config = format!("hard-{seed_start}-{step}");
            }
            if action == 6 {
                ctx.memory_budget_tokens = 8000.0;
                request.model_key = Some(format!("model-{step}"));
                request.render_config = format!("model-config-{seed_start}-{step}");
            }
            if matches!(action, 1 | 2 | 4) {
                let loaded = s.load("ses").unwrap();
                let projection = loaded.meta.memory_projection.unwrap();
                let after = projection
                    .committed
                    .iter()
                    .map(|entry| entry.id)
                    .fold(projection.fragment_watermark, i64::max);
                let pending = s.load_agent_fragments("ses", after).unwrap();
                ctx.memory_budget_tokens =
                    [8000.0, 1200.0, 500.0, 100.0, 0.0][(next() % 5) as usize];
                oracle_inputs.push(json!({
                    "before": { "generation": projection.generation, "hardMemoryBlock": "{\"updateLines\":[],\"newMemories\":\"\"}", "fragmentWatermark": projection.fragment_watermark, "committed": projection.committed, "legacy": false },
                    "pending": pending, "memoryBudgetTokens": ctx.memory_budget_tokens,
                    "historyBudgetTokens": ctx.history_budget_tokens, "independentTokens": 0,
                    "m0Tokens": estimate_tokens(&old_m0)
                }));
                s.arm_soft_refresh("ses").unwrap();
            }
            let served = transform(&s, &request, &ctx).unwrap();
            match action {
                0 | 3 => {
                    assert_eq!(served.action, "SOFT+");
                    assert_eq!(
                        serde_json::to_vec(served.messages()).unwrap(),
                        previous,
                        "defer seed {seed_start} step {step}"
                    );
                }
                1 | 2 | 4 => {
                    assert_eq!(served.action, "SOFT");
                    assert_eq!(m0_bytes(&served), old_m0);
                    let projection = s.load("ses").unwrap().meta.memory_projection.unwrap();
                    actual_soft.push((
                        crate::agent_fragments::block(m1_bytes(&served), "memory-updates"),
                        projection.committed,
                    ));
                }
                5 | 6 => {
                    assert_eq!(served.action, "HARD");
                    let escaped = canonical
                        .replace('&', "&amp;")
                        .replace('<', "&lt;")
                        .replace('>', "&gt;")
                        .replace('\n', "\n  ");
                    assert!(
                        m0_bytes(&served).contains(&escaped),
                        "HARD must fold the latest canonical text: {}",
                        m0_bytes(&served)
                    );
                    assert!(!m1_bytes(&served).contains("<memory-updates>"));
                    assert!(s
                        .load("ses")
                        .unwrap()
                        .meta
                        .memory_projection
                        .unwrap()
                        .committed
                        .is_empty());
                }
                _ => unreachable!(),
            }
            shown = served;
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("input.json");
    let output = dir.path().join("output.json");
    std::fs::write(&input, serde_json::to_vec(&oracle_inputs).unwrap()).unwrap();
    let command = std::process::Command::new("bun")
        .current_dir(&workspace)
        .args([
            "crates/mc-module/tests/fixtures/agent-fragments-golden.ts",
            "--input",
        ])
        .arg(&input)
        .arg("--output")
        .arg(&output)
        .output()
        .unwrap();
    assert!(
        command.status.success(),
        "{}",
        String::from_utf8_lossy(&command.stderr)
    );
    let expected: Vec<serde_json::Value> =
        serde_json::from_slice(&std::fs::read(output).unwrap()).unwrap();
    assert_eq!(expected.len(), actual_soft.len());
    for (index, (block, committed)) in actual_soft.iter().enumerate() {
        assert_eq!(
            block,
            expected[index]["block"].as_str().unwrap(),
            "supplied SOFT case {index}"
        );
        assert_eq!(
            serde_json::to_value(committed).unwrap(),
            expected[index]["committed"],
            "supplied SOFT case {index}"
        );
    }
    assert!(counts.iter().all(|count| *count > 0));
    println!("640 served steps; defer/SOFT/flush/restart/CAS-loss/HARD/model-switch={counts:?}; {} exact TS/Pi SOFT comparisons", actual_soft.len());
}

#[test]
#[ignore = "requires Bun and installed workspace packages; run explicitly for the independent cache review"]
fn review_new_seed_fragment_sequences_match_ts_composer() {
    let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = tempfile::tempdir().unwrap();
    let output = dir.path().join("golden.json");
    let mut checked = 0;
    for seed in [0x8b45a029u32, 0xa643d711, 0x137efccb, 0xc09d32a1] {
        let command = std::process::Command::new("bun")
            .current_dir(&workspace)
            .args([
                "crates/mc-module/tests/fixtures/agent-fragments-golden.ts",
                "--seed",
                &seed.to_string(),
                "--steps",
                "320",
                "--output",
            ])
            .arg(&output)
            .output()
            .unwrap();
        assert!(
            command.status.success(),
            "{}",
            String::from_utf8_lossy(&command.stderr)
        );
        let cases: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(&output).unwrap()).unwrap();
        assert_eq!(cases.len(), 324);
        for (index, case) in cases.iter().enumerate() {
            let projection = AppliedProjection {
                committed: serde_json::from_value(case["before"]["committed"].clone()).unwrap(),
                fragment_watermark: case["before"]["fragmentWatermark"].as_i64().unwrap(),
                ..Default::default()
            };
            if case["pass"] != "soft" {
                assert_eq!(
                    serde_json::to_value(projection.committed).unwrap(),
                    case["committed"]
                );
                continue;
            }
            let pending: Vec<AgentFragment> =
                serde_json::from_value(case["pending"].clone()).unwrap();
            let (block, actual) = crate::agent_fragments::compose(
                projection,
                &pending,
                case["memoryBudgetTokens"].as_f64().unwrap(),
                case["historyBudgetTokens"].as_f64().unwrap(),
                case["independentTokens"].as_u64().unwrap() as usize,
                case["m0Tokens"].as_u64().unwrap() as usize,
                estimate_tokens,
            );
            assert_eq!(
                block,
                case["block"].as_str().unwrap(),
                "seed {seed} pass {index}"
            );
            assert_eq!(
                serde_json::to_value(actual.committed).unwrap(),
                case["committed"],
                "seed {seed} pass {index}"
            );
        }
        checked += cases.len();
    }
    println!("{checked} newly seeded TS/Pi/Rust cases checked");
}

fn hard_with_stale_host_mural() -> TransformResponse {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
        .unwrap();
    let id = s
        .insert_memory(memory_input("git:proj", "CONSTRAINTS", "NO", 0))
        .unwrap();
    let mut request = req(
        "ses",
        "cfg0",
        vec![item("a", 1, "raw"), item("tail", 2, "tail")],
    );
    request.serializer_profile = "opencode-aisdk".into();
    request.auto_search_enabled = false;
    request.mural = Some(crate::m0_compose::M0MuralInput {
        enabled: true,
        supports_vision: true,
        data_url: Some(format!("data:image/png;base64,{NO_GLYPH_PNG}")),
        content_hash: Some("host-snapshot-NO".into()),
    });
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let first = transform(&s, &request, &ctx).unwrap();
    s.with_context_conn_for_test(|conn| {
        conn.execute(
            "UPDATE memories SET content='YES',revision=revision+1 WHERE id=?1",
            [id],
        )
    })
    .unwrap();
    let deferred = transform(&s, &request, &ctx).unwrap();
    assert_eq!(
        serde_json::to_vec(deferred.messages()).unwrap(),
        serde_json::to_vec(first.messages()).unwrap()
    );
    s.arm_soft_refresh("ses").unwrap();
    let soft = transform(&s, &request, &ctx).unwrap();
    assert_eq!(soft.action, "SOFT");
    assert_eq!(m0_bytes(&soft), m0_bytes(&first));
    assert!(serde_json::to_string(soft.messages())
        .unwrap()
        .contains(NO_GLYPH_PNG));
    request.render_config = "independent-hard".into();
    let hard = transform(&s, &request, &ctx).unwrap();
    assert_eq!(hard.action, "HARD");
    assert!(m0_bytes(&hard).contains("#1: YES"));
    hard
}

// This PNG visibly spells NO, representing a host image rendered before the row changed.
const NO_GLYPH_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAACmElEQVR4nO2cwQ3AQAyDuv/S7RC2gpDLAvjI/54n4IWgNideJa2DXYamvEpaB7sMTXmVtA52GZryKmkd7DI05VXSOthlaMqrpHWwy9CUV0nrYJehKa+S1sEuQ1NeJa2DXYamvEpaB7sMTXmVtA52GZryKmkd7DI05VXSOthlaMqrpHWwy9CUV0nrYJehKa+S1sEuQ1NeJa2DXYamvEpaB7sMTXmVtA52GZryzrF2YMqLsRaa8mKshaa8GGuhKS/GWmjKi7EWmvJirIWmvBhroSkvxlpoyouxFpryYqyFprwYa6EpL8ZaaMqLsRaa8mKshaa8GGuhKS/GWmjKi7EWmvJirIWmvBhroSlvhHE0tdnYSjma2mxspRxNbTa2Uo6mNhtbKUdTm42tlKOpzcZWytHUZmMr5Whqs7GVcjS12dhKOZrabGylHE1tNrZSjqY2G1spR1Obja2Uo6nNxlbK0dRmYyvlaGqzsZVyNLXZ2Eo5mtpsbKUcTW02tlKOpjYbW/0foQm8Eclo6sFr3ohkNPXgNW9EMpp68Jo3IhlNPXjNG5GMph685o1IRlMPXvNGJKOpB695I5LR1IPXvBHJaOrBa96IZDT14DVvRDKaevCaNyIZTT14zRuRjKYevOaNSEZTD17zRiSjqQeveSOS0dSD17wRyWjqwWveiGQ09eA1b0QymnrwmjciGU09mPIqaR3sMjTlVdI62GVoyqukdbDL0JRXSetgl6Epr5LWwS5DU14lrYNdhqa8SloHuwxNeZW0DnYZmvIqaR3sMjTlVdI62GVoyqukdbDL0JRXSetgl6Epr5LWwS5DU14lrYNdhqa8SloHuwxNeZW0DnYZmvIqaR3sMjTlVdI62GVoyqukdbDL0JSX4gOR57lX6Kr2/QAAAABJRU5ErkJggg==";

#[test]
fn review_stale_host_mural_is_frozen_on_soft_but_accepted_at_hard() {
    let hard = hard_with_stale_host_mural();
    assert!(serde_json::to_string(hard.messages())
        .unwrap()
        .contains(NO_GLYPH_PNG));
}

#[test]
// The host mural has no source revision manifest. S7 must add and validate that
// wire field before HARD can reject an image rendered from stale memory revisions.
#[ignore = "S7 host-manifest gap: HARD mural/text source revision coherence is not enforced yet"]
fn review_hard_requires_mural_revision_coherence() {
    let hard = hard_with_stale_host_mural();
    assert!(!serde_json::to_string(hard.messages()).unwrap().contains(NO_GLYPH_PNG),
        "HARD serves canonical YES beside a host image visibly spelling NO; no revision manifest rejects it");
}

#[test]
fn review_crash_between_row_and_fragment_is_atomic() {
    if let Some(root) = std::env::var_os("MC_REVIEW_CRASH_ROOT") {
        let s = store(std::path::Path::new(&root));
        let _ = s.with_facade_command(
            "/tmp",
            "git:proj",
            "memories",
            "ses",
            "ctx_memory",
            "update",
            Some("crashed-edit"),
            |tx| {
                tx.update_memory_content("git:proj", 1, "uncommitted claim", None, 0)
                    .unwrap();
                // Exit without destructors after the row write and before recording its fragment.
                std::process::exit(73);
            },
        );
        unreachable!();
    }
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let id = s
        .insert_memory(memory_input("git:proj", "CONSTRAINTS", "original claim", 0))
        .unwrap();
    assert_eq!(id, 1);
    drop(s);
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "transform::tests::memory_cache_review::review_crash_between_row_and_fragment_is_atomic", "--nocapture"])
        .env("MC_REVIEW_CRASH_ROOT", dir.path()).output().unwrap();
    assert_eq!(
        child.status.code(),
        Some(73),
        "{}",
        String::from_utf8_lossy(&child.stderr)
    );
    let s = store(dir.path());
    s.with_context_conn_for_test(|conn| {
        let content: String =
            conn.query_row("SELECT content FROM memories WHERE id=1", [], |row| {
                row.get(0)
            })?;
        assert_eq!(content, "original claim");
        for table in [
            "memory_history",
            "memory_mutation_log",
            "memory_agent_fragments",
        ] {
            let count: i64 =
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?;
            assert_eq!(count, 0, "{table} survived an uncommitted crash");
        }
        Ok(())
    })
    .unwrap();
}

fn noprop_automated(s: &McStore, kind: u32, step: usize) {
    let hash = s.get_memory_full(7).unwrap().unwrap().normalized_hash;
    s.with_facade_command(
        "/tmp",
        "git:proj",
        "memories",
        "ses",
        "memory.curate",
        "review",
        Some(&format!("noprop:{step}")),
        |agent_tx| {
            let tx = agent_tx.automated();
            match kind {
                2 => {
                    tx.archive_memories("git:proj", &[4], Some("obsolete"), 2)
                        .map_err(|e| e.to_string())?;
                }
                3 => {
                    tx.merge_memories_canonical(
                        "git:proj",
                        &[5, 6],
                        "Merged automated claim.",
                        Some("ses"),
                        2,
                    )
                    .map_err(|e| e.to_string())?;
                }
                4 => {
                    tx.set_memory_verification(
                        "git:proj",
                        &[mc_store::VerificationUpdate {
                            memory_id: 7,
                            content_hash_at_prompt: hash,
                            verification_status: "archive".into(),
                            updated_content: None,
                            archive_reason: Some("obsolete".into()),
                        }],
                        2,
                    )?;
                }
                _ => {
                    tx.update_memory_content(
                        "git:proj",
                        2,
                        &format!("Automated claim {step}."),
                        None,
                        2,
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            Ok(Vec::new())
        },
    )
    .unwrap();
}

#[test]
fn noprop_randomized_automated_vs_delayed_served_bytes() {
    if std::env::var("MC_NOPROP_REVIEW").as_deref() != Ok("1") {
        return;
    }
    let mut counts = [0usize; 3];
    for seed in [0x941aac21u32, 0x287cf89b, 0xb41c137e, 0x1799fdd3] {
        let dirs = [tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap()];
        let actual = store(dirs[0].path());
        let delayed = store(dirs[1].path());
        for s in [&actual, &delayed] {
            s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
                .unwrap();
            for text in [
                "Agent baseline.",
                "Automated baseline.",
                "Spare baseline.",
                "Archive baseline.",
                "Merge first.",
                "Merge second.",
                "Verify baseline.",
            ] {
                s.insert_memory(memory_input("git:proj", "CONSTRAINTS", text, 0))
                    .unwrap();
            }
        }
        let mut request = req(
            "ses",
            "cfg0",
            vec![item("a", 1, "raw"), item("tail", 2, "tail")],
        );
        request.auto_search_enabled = false;
        let ctx = pctx("git:proj", "/nonexistent-docs", 0);
        let mut previous = transform(&actual, &request, &ctx).unwrap();
        assert_eq!(
            serde_json::to_vec(previous.messages()).unwrap(),
            serde_json::to_vec(transform(&delayed, &request, &ctx).unwrap().messages()).unwrap()
        );
        let mut rng = seed;
        let mut next = || {
            rng ^= rng << 13;
            rng ^= rng >> 17;
            rng ^= rng << 5;
            rng
        };
        let mut pending = Vec::new();
        for step in 0..80 {
            let kind = if step < 3 { step as u32 + 2 } else { 0 };
            let before = actual.load_agent_fragments("ses", 0).unwrap().len();
            noprop_automated(&actual, kind, step);
            assert_eq!(actual.load_agent_fragments("ses", 0).unwrap().len(), before);
            pending.push((kind, step));
            if next() % 2 == 0 {
                let owner = if next() % 2 == 0 { "ses" } else { "foreign" };
                for s in [&actual, &delayed] {
                    edit(
                        s,
                        owner,
                        1,
                        &format!("Agent correction {step} & <quoted>."),
                        &format!("agent:{step}"),
                    )
                    .unwrap();
                }
            }
            let pass = if step == 79 { 2 } else { next() % 3 };
            counts[pass as usize] += 1;
            if pass == 2 {
                for (kind, queued) in pending.drain(..) {
                    noprop_automated(&delayed, kind, queued);
                }
                request.render_config = format!("natural-{seed}-{step}");
            } else if pass == 1 {
                actual.arm_soft_refresh("ses").unwrap();
                delayed.arm_soft_refresh("ses").unwrap();
            }
            let served = transform(&actual, &request, &ctx).unwrap();
            let oracle = transform(&delayed, &request, &ctx).unwrap();
            assert_eq!(
                serde_json::to_vec(served.messages()).unwrap(),
                serde_json::to_vec(oracle.messages()).unwrap(),
                "seed {seed}, step {step}"
            );
            assert_eq!(served.action, ["SOFT+", "SOFT", "HARD"][pass as usize]);
            if pass == 0 {
                assert_eq!(
                    serde_json::to_vec(served.messages()).unwrap(),
                    serde_json::to_vec(previous.messages()).unwrap()
                );
            }
            if pass == 1 {
                assert_eq!(m0_bytes(&served), m0_bytes(&previous));
            }
            previous = served;
        }
        actual
            .with_context_conn_for_test(|conn| {
                assert_eq!(
                    conn.query_row("SELECT COUNT(*) FROM memory_tool_proposals", [], |row| row
                        .get::<_, i64>(
                        0
                    ))?,
                    0
                );
                for id in [4, 5, 6, 7] {
                    assert_eq!(
                        conn.query_row(
                            "SELECT COUNT(*) FROM memory_history WHERE memory_id=?1",
                            [id],
                            |row| row.get::<_, i64>(0)
                        )?,
                        1
                    );
                }
                Ok(())
            })
            .unwrap();
    }
    assert!(counts.iter().all(|count| *count > 0));
    println!("noprop Rust differential: 320 passes; defer/SOFT/HARD={counts:?}");
}

#[test]
fn noprop_agent_m1_fingerprint_matches_baseline() {
    if std::env::var("MC_NOPROP_REVIEW").as_deref() != Ok("1") {
        return;
    }
    use sha2::{Digest, Sha256};
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
        .unwrap();
    let id = s
        .insert_memory(memory_input(
            "git:proj",
            "CONSTRAINTS",
            "Agent baseline.",
            0,
        ))
        .unwrap();
    let mut request = req(
        "ses",
        "cfg0",
        vec![item("a", 1, "raw"), item("tail", 2, "tail")],
    );
    request.auto_search_enabled = false;
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    let mut output = Vec::new();
    for step in 0..24 {
        edit(
            &s,
            "ses",
            id,
            &format!("Agent claim {step} & <quoted>."),
            &format!("agent:{step}"),
        )
        .unwrap();
        s.arm_soft_refresh("ses").unwrap();
        let served = transform(&s, &request, &ctx).unwrap();
        assert_eq!(served.action, "SOFT");
        assert!(m1_bytes(&served).contains("<updated id=\"1\""));
        output.push(m1_bytes(&served).to_string());
    }
    let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&output).unwrap()));
    assert_eq!(
        hash,
        "31d496e40cc01df9e0d9c19052511472d06b968d9ea41a180362659e988ccae9"
    );
    println!("noprop Rust agent m[1] SHA256 {hash}");
}

fn assert_module_verification_cache(kind: &str) {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
        .unwrap();
    let id = s
        .insert_memory(memory_input(
            "git:proj",
            "CONSTRAINTS",
            "Verified code claim.",
            0,
        ))
        .unwrap();
    let hash = s.get_memory_full(id).unwrap().unwrap().normalized_hash;
    let mut request = req(
        "ses",
        "cfg0",
        vec![item("a", 1, "raw"), item("tail", 2, "tail")],
    );
    request.serializer_profile = "opencode-aisdk".into();
    request.auto_search_enabled = false;
    request.mural = Some(crate::m0_compose::M0MuralInput {
        enabled: true,
        supports_vision: true,
        data_url: Some(format!("data:image/png;base64,{NO_GLYPH_PNG}")),
        content_hash: Some("verification-mural".into()),
    });
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let first = transform(&s, &request, &ctx).unwrap();
    let served = serde_json::to_vec(first.messages()).unwrap();
    assert!(String::from_utf8_lossy(&served).contains(NO_GLYPH_PNG));
    let rows = crate::memory_verification::validate_rows(&json!([{
        "memory_id": id, "expected_revision": 1, "content_hash_at_prompt": hash,
        "verification_status": kind, "updated_content": "Corrected code claim.", "files": ["source.rs"], "checked_commit": null,
    }])).unwrap();
    s.with_context_conn_for_test(|tx| {
        let receipt = crate::memory_verification::apply_row(
            tx,
            "git:proj",
            "verify-cache",
            &rows[0],
            None,
            1234,
        )?;
        assert_eq!(
            receipt["result"],
            if kind == "update" {
                "updated"
            } else {
                "confirmed"
            }
        );
        let history: i64 = tx.query_row(
            "SELECT COUNT(*) FROM memory_history WHERE memory_id=?1",
            [id],
            |row| row.get(0),
        )?;
        assert_eq!(history, if kind == "update" { 1 } else { 0 });
        let proposals: i64 =
            tx.query_row("SELECT COUNT(*) FROM memory_tool_proposals", [], |row| {
                row.get(0)
            })?;
        assert_eq!(proposals, 0);
        Ok(())
    })
    .unwrap();
    let deferred = transform(&s, &request, &ctx).unwrap();
    assert_eq!(deferred.action, "SOFT+");
    assert_eq!(serde_json::to_vec(deferred.messages()).unwrap(), served);
    s.arm_soft_refresh("ses").unwrap();
    let soft = transform(&s, &request, &ctx).unwrap();
    assert_eq!(soft.action, "SOFT");
    assert_eq!(m0_bytes(&soft), m0_bytes(&first));
    assert_eq!(m1_bytes(&soft), m1_bytes(&first));
    assert_eq!(serde_json::to_vec(soft.messages()).unwrap(), served);
    request.render_config = "independent-hard".into();
    let hard = transform(&s, &request, &ctx).unwrap();
    assert_eq!(hard.action, "HARD");
    assert!(m0_bytes(&hard).contains(if kind == "update" {
        "Corrected code claim."
    } else {
        "Verified code claim."
    }));
    if kind == "update" {
        assert!(!m0_bytes(&hard).contains("Verified code claim."));
    }
    assert!(serde_json::to_string(hard.messages())
        .unwrap()
        .contains(NO_GLYPH_PNG));
}

#[test]
fn module_verification_freezes_served_m0_m1_and_mural_until_natural_hard() {
    assert_module_verification_cache("verified");
}

#[test]
fn module_verification_direct_update_freezes_served_m0_m1_and_mural_until_natural_hard() {
    assert_module_verification_cache("update");
}

#[test]
fn module_dashboard_pin_waits_for_natural_hard_even_when_prefix_bytes_are_identical() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
        .unwrap();
    let id = s
        .insert_memory(memory_input(
            "git:proj",
            "CONSTRAINTS",
            "cache_ttl is 5 minutes in config.ts.",
            0,
        ))
        .unwrap();
    let mut request = req(
        "ses",
        "cfg",
        vec![item("a", 1, "raw"), item("tail", 2, "tail")],
    );
    request.auto_search_enabled = false;
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let original = transform(&s, &request, &ctx).unwrap();
    let receipt = s.memory_history_rpc("memory.edit", &json!({ "projectPath":"git:proj", "operationId":"pin", "expectedRevisions":[{"memoryId":id,"revision":1}], "changes":[{"memoryId":id,"status":"permanent"}] }), 1).unwrap();
    assert_eq!(receipt["state"], "applied");
    let held = transform(&s, &request, &ctx).unwrap();
    assert_eq!(serde_json::to_vec(held.messages()).unwrap(), serde_json::to_vec(original.messages()).unwrap());
    s.arm_soft_refresh("ses").unwrap();
    let delta = transform(&s, &request, &ctx).unwrap();
    assert_eq!(delta.action, "SOFT");
    assert!(serde_json::to_string(delta.messages()).unwrap().contains("<memory-updates>"));
    request.render_config = "cfg-natural-pin".into();
    let hard = transform(&s, &request, &ctx).unwrap();
    assert_eq!(hard.action, "HARD");
    assert_eq!(m0_bytes(&hard), m0_bytes(&original));
    let applied = s.load("ses").unwrap().meta.memory_projection.unwrap();
    assert_eq!(applied.project_memory_epoch, 1);
    assert_eq!(applied.rows[0].revision, 2);
    s.arm_soft_refresh("ses").unwrap();
    let soft = transform(&s, &request, &ctx).unwrap();
    assert_eq!(soft.action, "SOFT");
    assert_eq!(
        serde_json::to_vec(soft.messages()).unwrap(),
        serde_json::to_vec(hard.messages()).unwrap()
    );
}

#[test]
#[ignore = "writes independent base/tip served output when MC_REVIEW_OUTPUT is set"]
#[allow(unexpected_cfgs)]
fn independent_review_randomized_base_served_requests() {
    let output = std::env::var("MC_REVIEW_OUTPUT").unwrap();
    let dashboard = std::env::var("MC_REVIEW_DASHBOARD").as_deref() == Ok("1");
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let schema_conn = rusqlite::Connection::open_with_flags(
        dir.path().join("store.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let schema = schema_conn.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").unwrap().query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?))
    }).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
    drop(schema_conn);
    s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
        .unwrap();
    for text in [
        "Agent baseline.",
        "Automated baseline.",
        "Dashboard baseline.",
        "Spare four.",
        "Spare five.",
        "Spare six.",
        "Spare seven.",
    ] {
        s.insert_memory(memory_input("git:proj", "CONSTRAINTS", text, 0))
            .unwrap();
    }
    let mut request = req(
        "ses",
        "cfg0",
        vec![item("a", 1, "raw"), item("tail", 2, "tail")],
    );
    request.auto_search_enabled = false;
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let mut records = Vec::new();
    let initial = transform(&s, &request, &ctx).unwrap();
    records.push(json!({"step": -1, "action": initial.action, "messages": initial.messages()}));
    let mut rng = 0x68291cadu32;
    let mut next = || {
        rng ^= rng << 13;
        rng ^= rng >> 17;
        rng ^= rng << 5;
        rng
    };
    let mut counts = [0usize; 3];
    for step in 0..240 {
        let random_kind = next() % 3;
        let kind = if !dashboard && random_kind == 2 {
            1
        } else {
            random_kind
        };
        match kind {
            0 => edit(
                &s,
                if next() % 2 == 0 { "ses" } else { "foreign" },
                1,
                &format!("Agent correction {step} & <quoted>."),
                &format!("review-agent:{step}"),
            )
            .unwrap(),
            1 => noprop_automated(&s, 0, step),
            _ => {
                let status = if step % 2 == 0 { "permanent" } else { "active" };
                    let revision = s
                        .with_context_conn_for_test(|conn| {
                            conn.query_row("SELECT revision FROM memories WHERE id=3", [], |row| {
                                row.get::<_, i64>(0)
                            })
                        })
                        .unwrap();
                    let receipt = s.memory_history_rpc("memory.edit", &json!({"projectPath":"git:proj", "operationId":format!("review-dashboard:{step}"), "expectedRevisions":[{"memoryId":3,"revision":revision}], "changes":[{"memoryId":3,"status":status}]}), 2).unwrap();
                    assert!(receipt["state"] == "applied" || receipt["reason"] == "no_change");

            }
        }
        let pass = next() % 3;
        counts[pass as usize] += 1;
        if pass == 2 {
            request.render_config = format!("natural-{step}");
        } else if pass == 1 {
            s.arm_soft_refresh("ses").unwrap();
        }
        let served = transform(&s, &request, &ctx).unwrap();
        records.push(
            json!({"step":step, "kind":kind, "action":served.action, "bust":pass != 0, "natural":pass == 2, "messages":served.messages()}),
        );
    }
    std::fs::write(
        output,
        serde_json::to_vec(&json!({"schema":schema,"records":records})).unwrap(),
    )
    .unwrap();
    println!("independent base differential: {} serialized Rust requests; requested defer/SOFT/natural HARD={counts:?}", records.len());
}

#[test]
fn dashboard_delta_holds_admits_freezes_and_folds_across_240_randomized_passes() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")]).unwrap();
    let id = s.insert_memory(memory_input("git:proj", "CONSTRAINTS", "Initial dashboard rule.", 0)).unwrap();
    let agent = s.insert_memory(memory_input("git:proj", "CONSTRAINTS", "Initial agent rule.", 0)).unwrap();
    let mut request = req("ses", "cfg0", vec![item("a", 1, "raw"), item("tail", 2, "tail")]);
    request.auto_search_enabled = false;
    let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
    ctx.memory_budget_tokens = 10000.0;
    ctx.history_budget_tokens = 10000.0;
    let bytes = |r: &TransformResponse| serde_json::to_vec(r.messages()).unwrap();
    let initial = transform(&s, &request, &ctx).unwrap();
    let dashboard = |step: usize| {
        let revision: i64 = s.with_context_conn_for_test(|conn| conn.query_row("SELECT revision FROM memories WHERE id=?1", [id], |row| row.get(0))).unwrap();
        let receipt = s.memory_history_rpc("memory.edit", &json!({"projectPath":"git:proj", "operationId":format!("dashboard-proof:{step}"), "expectedRevisions":[{"memoryId":id,"revision":revision}],"changes":[{"memoryId":id,"content":format!("Dashboard correction {step}.")}]}), 2).unwrap();
        assert_eq!(receipt["state"], "applied");
    };
    dashboard(999);
    let held = transform(&s, &request, &ctx).unwrap();
    assert_ne!(held.action, "HARD");
    assert_eq!(bytes(&held), bytes(&initial));
    s.arm_soft_refresh("ses").unwrap();
    let admitted = transform(&s, &request, &ctx).unwrap();
    assert_eq!(admitted.action, "SOFT");
    assert!(String::from_utf8(bytes(&admitted)).unwrap().contains("Dashboard correction 999."));
    s.with_context_conn_for_test(|conn| conn.execute("UPDATE memories SET content='Later automated text',revision=revision+1 WHERE id=?1", [id])).unwrap();
    for _ in 0..12 {
        s.arm_soft_refresh("ses").unwrap();
        let replay = transform(&s, &request, &ctx).unwrap();
        assert_eq!(replay.action, "SOFT");
        assert_eq!(bytes(&replay), bytes(&admitted));
    }
    request.render_config = "cfg-natural".into();
    let folded = transform(&s, &request, &ctx).unwrap();
    assert_eq!(folded.action, "HARD");
    assert!(m0_bytes(&folded).contains("Later automated text"));
    let mut previous = bytes(&folded);
    let mut previous_m0 = m0_bytes(&folded).to_string();
    let mut rng = 0x49b13cdu32;
    let mut counts = [0usize; 3];
    for step in 0..240 {
        rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
        let kind = rng % 3;
        counts[kind as usize] += 1;
        if kind == 0 { dashboard(step); }
        else if kind == 1 { edit(&s, "ses", agent, &format!("Agent correction {step}."), &format!("proof-agent:{step}")).unwrap(); }
        let natural = step % 19 == 18;
        let bust = natural || (rng >> 8).is_multiple_of(3);
        if natural { request.render_config = format!("cfg-natural:{step}"); }
        else if bust { s.arm_soft_refresh("ses").unwrap(); }
        let current = transform(&s, &request, &ctx).unwrap();
        assert_eq!(current.action == "HARD", natural, "step {step}");
        if !bust { assert_eq!(bytes(&current), previous, "held step {step}"); }
        if !natural { assert_eq!(m0_bytes(&current), previous_m0, "m0 step {step}"); }
        previous = bytes(&current);
        previous_m0 = m0_bytes(&current).to_string();
    }
    println!("Rust dashboard proof: 240 randomized passes dashboard/agent/normal={counts:?}");
}

#[test]
fn dashboard_workspace_join_and_removal_hold_and_unseen_foreign_ids_wait_for_hard() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let foreign = s.insert_memory(memory_input("git:joined", "CONSTRAINTS", "Unseen workspace rule.", 0)).unwrap();
    let own = s.insert_memory(memory_input("git:proj", "CONSTRAINTS", "Own archived rule.", 0)).unwrap();
    let mut request = req("ses", "cfg", vec![item("tail", 1, "tail")]);
    request.auto_search_enabled = false;
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let bytes = |r: &TransformResponse| serde_json::to_vec(r.messages()).unwrap();
    let initial = transform(&s, &request, &ctx).unwrap();
    s.with_context_conn_for_test(|conn| {
        conn.execute_batch("INSERT INTO workspaces(id,name,share_categories,created_at,updated_at) VALUES(919,'proof','[\"CONSTRAINTS\"]',1,1); INSERT INTO workspace_members(workspace_id,project_path,display_name,display_path,added_at) VALUES(919,'git:proj','Own','/own',1),(919,'git:joined','Joined','/joined',1);")?;
        conn.execute("UPDATE memories SET shareable=1 WHERE id=?1", [foreign])
    }).unwrap();
    s.arm_soft_refresh("ses").unwrap();
    let joined = transform(&s, &request, &ctx).unwrap();
    assert_ne!(joined.action, "HARD", "join reason {:?}", joined.materialize_reason);
    assert_eq!(bytes(&joined), bytes(&initial));
    let edit = s.memory_history_rpc("memory.edit", &json!({"projectPath":"git:joined","operationId":"unseen","expectedRevisions":[{"memoryId":foreign,"revision":1}],"changes":[{"memoryId":foreign,"content":"Unseen joined correction."}]}), 2).unwrap();
    assert_eq!(edit["state"], "applied");
    s.arm_soft_refresh("ses").unwrap();
    assert_eq!(bytes(&transform(&s, &request, &ctx).unwrap()), bytes(&joined));
    s.with_context_conn_for_test(|conn| conn.execute("UPDATE memories SET shareable=1 WHERE id=?1", [foreign])).unwrap();
    request.render_config = "cfg-natural-join".into();
    let hard = transform(&s, &request, &ctx).unwrap();
    assert!(m0_bytes(&hard).contains("Unseen joined correction."));
    s.with_context_conn_for_test(|conn| conn.execute("DELETE FROM workspace_members WHERE project_path='git:joined'", [])).unwrap();
    s.arm_soft_refresh("ses").unwrap();
    let removed = transform(&s, &request, &ctx).unwrap();
    assert_ne!(removed.action, "HARD");
    assert_eq!(bytes(&removed), bytes(&hard));
    request.render_config = "cfg-natural-remove".into();
    let hard = transform(&s, &request, &ctx).unwrap();
    assert!(!m0_bytes(&hard).contains("Unseen joined correction."));
    let archive = s.memory_history_rpc("memory.edit", &json!({"projectPath":"git:proj","operationId":"archive","expectedRevisions":[{"memoryId":own,"revision":1}],"changes":[{"memoryId":own,"status":"archived"}]}), 3).unwrap();
    assert_eq!(archive["state"], "applied");
    assert_eq!(bytes(&transform(&s, &request, &ctx).unwrap()), bytes(&hard));
    s.arm_soft_refresh("ses").unwrap();
    let delta = transform(&s, &request, &ctx).unwrap();
    assert_eq!(m0_bytes(&delta), m0_bytes(&hard));
    assert!(m1_bytes(&delta).contains(&format!("<removed id=\"{own}\"/>")));
    request.render_config = "cfg-natural-archive".into();
    assert!(!m0_bytes(&transform(&s, &request, &ctx).unwrap()).contains("Own archived rule."));
}

#[test]
fn single_store_id_reset_hard_precedes_dashboard_delta_refresh() {
    for compaction in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let id = s.insert_memory(memory_input("git:proj", "CONSTRAINTS", "Canonical memory before reset.", 0)).unwrap();
        let mut request = req("ses", "cfg", vec![item("tail", 1, "tail")]);
        request.auto_search_enabled = false;
        let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
        ctx.compaction_enabled = compaction;
        transform(&s, &request, &ctx).unwrap();
        let mut old = s.load("ses").unwrap();
        let old_m0 = old.core.frozen_units.iter_mut().find(|unit| unit.key == "m0").unwrap();
        old_m0.frozen_payload = old_m0.frozen_payload.replace("Canonical memory before reset.", "OLD_ID_TEXT from the former id space.");
        let stale_bytes = old_m0.frozen_payload.clone();
        old.meta.rendered_memory_ids = vec![9001];
        old.meta.max_memory_id = 9001;
        old.meta.memory_mutation_cursor = 9001;
        if let Some(projection) = old.meta.memory_projection.as_mut() { projection.bind_m0(&stale_bytes); }
        s.commit("ses", old.row_version, &old.core, &old.meta).unwrap();
        let edit = s.memory_history_rpc("memory.edit", &json!({"projectPath":"git:proj","operationId":"reset-dashboard","expectedRevisions":[{"memoryId":id,"revision":1}],"changes":[{"memoryId":id,"content":"Current canonical id text."}]}), 2).unwrap();
        assert_eq!(edit["state"], "applied");
        let conn = rusqlite::Connection::open(dir.path().join("store.db")).unwrap();
        assert_eq!(mc_store::single_store_schema::reset_cache_state_for_single_store(&conn).unwrap(), 1);
        drop(conn);
        let reset = s.load("ses").unwrap().meta;
        assert_eq!(reset.max_memory_id, 0);
        assert_eq!(reset.memory_mutation_cursor, 0);
        assert!(reset.rendered_memory_ids.is_empty());
        s.arm_soft_refresh("ses").unwrap();
        let first = transform(&s, &request, &ctx).unwrap();
        assert_eq!(first.action, "HARD", "compaction={compaction}: no delta may render against reset ids");
        assert!(m0_bytes(&first).contains("Current canonical id text."));
        assert!(!m0_bytes(&first).contains("OLD_ID_TEXT"));
        assert!(!m1_bytes(&first).contains("<memory-updates>"));
        assert!(!s.load("ses").unwrap().meta.bootstrap_seed_fold_pending);
        let replay = transform(&s, &request, &ctx).unwrap();
        assert_ne!(replay.action, "HARD");
        assert_eq!(serde_json::to_vec(replay.messages()).unwrap(), serde_json::to_vec(first.messages()).unwrap());
    }
}

#[test]
fn independent_dashboard_archive_membership_restore_mix_480_passes() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
        .unwrap();
    let own = s
        .insert_memory(memory_input("git:proj", "CONSTRAINTS", "OWN_BASE", 0))
        .unwrap();
    let agent = s
        .insert_memory(memory_input("git:proj", "CONSTRAINTS", "AGENT_BASE", 0))
        .unwrap();
    let foreign = s
        .insert_memory(memory_input("git:other", "CONSTRAINTS", "FOREIGN_BASE", 0))
        .unwrap();
    s.with_context_conn_for_test(|conn| {
        conn.execute_batch("INSERT INTO workspaces(id,name,share_categories,created_at,updated_at) VALUES(919,'review','[\"CONSTRAINTS\"]',1,1); INSERT INTO workspace_members(workspace_id,project_path,display_name,display_path,added_at) VALUES(919,'git:proj','Own','/own',1)")?;
        conn.execute("UPDATE memories SET shareable=1,scope='project' WHERE id=?1", [foreign])
    }).unwrap();
    let mut request = req(
        "ses",
        "cfg",
        vec![item("a", 1, "raw"), item("tail", 2, "tail")],
    );
    request.auto_search_enabled = false;
    let mut ctx = pctx("git:proj", "/nonexistent-docs", 1);
    ctx.memory_budget_tokens = 100000.0;
    ctx.history_budget_tokens = 100000.0;
    ctx.cache_ttl = "5m".into();
    let bytes = |r: &TransformResponse| (m0_bytes(r).to_string(), m1_bytes(r).to_string());
    let mut previous = bytes(&transform(&s, &request, &ctx).unwrap());
    let mut rng = 0x93801acu32;
    let mut joined = false;
    let mut decision: Option<String> = None;
    let mut counts = [0; 10];
    let mut changes = Vec::new();
    for step in 0..480 {
        rng ^= rng << 13;
        rng ^= rng >> 17;
        rng ^= rng << 5;
        let kind = (rng % 10) as usize;
        counts[kind] += 1;
        let revision = |id: i64| {
            s.with_context_conn_for_test(|conn| {
                conn.query_row("SELECT revision FROM memories WHERE id=?1", [id], |r| {
                    r.get::<_, i64>(0)
                })
            })
            .unwrap()
        };
        if [0, 1, 8].contains(&kind) {
            let id = if kind == 8 { foreign } else { own };
            let project = if kind == 8 { "git:other" } else { "git:proj" };
            let change = if kind == 1 {
                let status = s
                    .with_context_conn_for_test(|conn| {
                        conn.query_row("SELECT status FROM memories WHERE id=?1", [own], |r| {
                            r.get::<_, String>(0)
                        })
                    })
                    .unwrap();
                json!({"memoryId":own,"status":if status == "archived" { "active" } else { "archived" }})
            } else {
                json!({"memoryId":id,"content":format!("DASH_{id}_{step}"),"status":"active"})
            };
            let receipt = s.memory_history_rpc("memory.edit", &json!({"projectPath":project,"operationId":format!("review-{step}"),"expectedRevisions":[{"memoryId":id,"revision":revision(id)}],"changes":[change]}), step as i64 + 2).unwrap();
            assert_eq!(receipt["state"], "applied");
            if id == own {
                decision = receipt["decisionKey"].as_str().map(str::to_string);
            } else {
                s.with_context_conn_for_test(|conn| {
                    conn.execute(
                        "UPDATE memories SET shareable=1,scope='project' WHERE id=?1",
                        [foreign],
                    )
                })
                .unwrap();
            }
        } else if kind == 2 {
            if let Some(key) = decision.take() {
                let preview = s
                    .memory_history_rpc(
                        "memory.restore.preview",
                        &json!({"projectPath":"git:proj","decisionKey":key}),
                        step as i64 + 2,
                    )
                    .unwrap();
                let receipt = s.memory_history_rpc("memory.restore", &json!({"projectPath":"git:proj","decisionKey":key,"operationId":format!("restore-{step}"),"expectedRevisions":preview["expectedRevisions"]}), step as i64 + 2).unwrap();
                assert_eq!(receipt["state"], "applied", "{receipt}");
            }
        } else if kind == 3 && !joined {
            s.with_context_conn_for_test(|conn| conn.execute("INSERT INTO workspace_members(workspace_id,project_path,display_name,display_path,added_at) VALUES(919,'git:other','Other','/other',1)", [])).unwrap();
            joined = true;
        } else if kind == 4 {
            s.with_context_conn_for_test(|conn| {
                conn.execute(
                    "DELETE FROM workspace_members WHERE project_path='git:other'",
                    [],
                )
            })
            .unwrap();
            joined = false;
        } else if kind == 5 || kind == 7 {
            edit(
                &s,
                if kind == 5 { "ses" } else { "other" },
                agent,
                &format!("AGENT_{step}"),
                &format!("review-agent-{step}"),
            )
            .unwrap();
        } else if kind == 6 {
            s.with_context_conn_for_test(|conn| {
                conn.execute(
                    "UPDATE memories SET content=?1,revision=revision+1 WHERE id=?2",
                    rusqlite::params![format!("DREAM_{step}"), agent],
                )
            })
            .unwrap();
        }
        ctx.now_ms = (step as i64 + 2) * 1_000_000;
        let idle = step % 29 == 28;
        let flush = step % 67 == 66;
        ctx.observed_last_response_at_ms = idle.then_some(ctx.now_ms - 300_001);
        let bust = idle || flush || (rng >> 8).is_multiple_of(4);
        if bust && !idle {
            s.arm_soft_refresh("ses").unwrap();
        }
        let response = transform(&s, &request, &ctx).unwrap();
        let current = bytes(&response);
        let m0_changed = current.0 != previous.0;
        let m1_changed = current.1 != previous.1;
        if m0_changed || m1_changed {
            changes.push(json!({"step":step,"kind":kind,"bust":bust,"idle":idle,"flush":flush,"action":response.action,"m0Changed":m0_changed,"m1Changed":m1_changed}));
        }
        assert_eq!(
            response.action == "HARD",
            idle,
            "step {step} kind {kind}: {:?}",
            response.materialize_reason
        );
        if !bust {
            assert_eq!(current, previous, "held step {step} kind {kind}");
        }
        if !idle {
            assert_eq!(current.0, previous.0, "m0 step {step}");
            if kind == 6 || kind == 7 {
                assert!(
                    !current.1.contains(&format!(
                        "{}_{step}",
                        if kind == 6 { "DREAM" } else { "AGENT" }
                    )),
                    "foreign leak step {step}"
                );
            }
        } else {
            let active = s.with_context_conn_for_test(|conn| {
                let mut q = conn.prepare("SELECT content FROM memories WHERE project_path='git:proj' AND status IN ('active','permanent') ORDER BY id")?;
                let rows = q.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            }).unwrap();
            for text in active {
                assert_eq!(
                    current.0.matches(&text).count(),
                    1,
                    "fold once {step}: {text}"
                );
                assert!(!current.1.contains(&text));
            }
        }
        previous = current;
    }
    println!(
        "INDEPENDENT_RUST_MIX {}",
        json!({"passes":480,"counts":counts,
            "m0Changes":changes.iter().filter(|c| c["m0Changed"] == true).map(|c| &c["step"]).collect::<Vec<_>>(),
            "m1Changes":changes.iter().filter(|c| c["m1Changed"] == true).map(|c| &c["step"]).collect::<Vec<_>>(),
            "unpermittedChanges":changes.iter().filter(|c| c["bust"] == false).collect::<Vec<_>>()})
    );
}

#[test]
#[ignore = "run from two separately built revisions with an isolated MC_INDEPENDENT_STORE"]
fn independent_base_store_upgrade_probe() {
    let path = std::path::PathBuf::from(std::env::var("MC_INDEPENDENT_STORE").unwrap());
    let s = store(&path);
    let request = req("upgrade", "unchanged", vec![item("tail", 1, "tail")]);
    let ctx = pctx("git:proj", "/nonexistent-docs", 1);
    let capture = path.join("served.json");
    if std::env::var("MC_INDEPENDENT_PHASE").as_deref() == Ok("base") {
        s.insert_memory(memory_input(
            "git:proj",
            "CONSTRAINTS",
            "Independent upgrade memory.",
            0,
        ))
        .unwrap();
        let first = transform(&s, &request, &ctx).unwrap();
        assert_eq!(first.action, "HARD");
        std::fs::write(capture, serde_json::to_vec(first.messages()).unwrap()).unwrap();
        println!("independent base 1f78949d: created real persisted module store");
    } else {
        let baseline = std::fs::read(capture).unwrap();
        for pass in 0..5 {
            if pass % 2 == 0 {
                s.arm_soft_refresh("upgrade").unwrap();
            }
            let current = transform(&s, &request, &ctx).unwrap();
            assert_ne!(current.action, "HARD", "upgrade pass {pass}");
            assert_eq!(
                serde_json::to_vec(current.messages()).unwrap(),
                baseline,
                "upgrade bytes pass {pass}"
            );
        }
        println!("independent Rust base -> tip: 5 passes, 0 extra rebuilds, identical prefix");
    }
}

#[test]
fn independent_legacy_dashboard_epoch_hard_receipt_is_still_accepted() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let id = s
        .insert_memory(memory_input(
            "git:proj",
            "CONSTRAINTS",
            "Legacy receipt memory.",
            0,
        ))
        .unwrap();
    let edit = s.memory_history_rpc("memory.edit", &json!({"projectPath":"git:proj","operationId":"archive-for-receipt","expectedRevisions":[{"memoryId":id,"revision":1}],"changes":[{"memoryId":id,"status":"archived"}]}), 1).unwrap();
    let preview = s
        .memory_history_rpc(
            "memory.restore.preview",
            &json!({"projectPath":"git:proj","decisionKey":edit["decisionKey"]}),
            2,
        )
        .unwrap();
    let request = json!({"projectPath":"git:proj","operationId":"restore-for-receipt","decisionKey":edit["decisionKey"],"expectedRevisions":preview["expectedRevisions"]});
    let mut receipt = s.memory_history_rpc("memory.restore", &request, 3).unwrap();
    assert_eq!(receipt["state"], "applied");
    assert!(mc_store::memory_history::valid_receipt(
        "memory.restore",
        &request,
        &receipt
    ));
    receipt["adoption"] = json!("dashboard_epoch_hard");
    assert!(mc_store::memory_history::valid_receipt(
        "memory.restore",
        &request,
        &receipt
    ));
    receipt["adoption"] = json!("not-a-real-receipt");
    assert!(!mc_store::memory_history::valid_receipt(
        "memory.restore",
        &request,
        &receipt
    ));
}
