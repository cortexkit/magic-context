//! Projection built by a session's own work, never by an app request.
use super::*;
use crate::app_read::Message;
#[cfg(test)]
use crate::app_read::Snapshot;
use serde_json::json;
#[path = "incremental.rs"]
mod incremental;
pub(super) use incremental::Projection;

impl Session {
    #[cfg(test)]
    pub(crate) fn app_snapshot(&mut self) -> Snapshot {
        let _ = self.app_update();
        self.app_materialize()
    }

    pub(super) fn app_record_view(&mut self, view: &View) {
        let model = format!(
            "{}/{}",
            self.conditions.model.provider, self.conditions.model.model
        );
        let changes = (self.app.last_model.as_ref() != Some(&model))
            .then(|| json!({"prev":self.app.last_model,"new":model}));
        let identity_delta = if changes.is_some() {
            vec!["model"]
        } else {
            Vec::new()
        };
        let materialized = self.next_baseline.as_ref().is_some_and(|next| {
            self.baseline
                .as_ref()
                .is_none_or(|before| before.m0 != next.m0)
        });
        let freed: u64 = self
            .next_covered
            .iter()
            .filter_map(|(mid, part)| self.index.find(mid, part))
            .map(|(_, part)| crate::tokens::part(part))
            .sum();
        self.app_decisions.push(json!({"view_version":view.version, "view_checksum":view.checksum, "status":"offered", "producer_ref":null, "at_ms":crate::app_read::now_ms(), "decision":"publish", "cause":self.app_cause, "changes":{"model":changes, "system_prompt":null, "tool_set":null}, "dropped_count":self.next_covered.len(), "dropped_tokens":freed, "emergency":self.next_latch, "identity_delta":identity_delta, "input_tokens":self.conditions.last_prompt_tokens, "materialized":materialized}));
        if self.app_decisions.len() > 256 {
            self.app_decisions.remove(0);
        }
        self.app_decisions_revision += 1;
        self.app_decisions_dirty = true;
        self.app.last_model = Some(model);
    }

    pub(crate) fn app_view_status(&mut self, version: u64, status: &str) {
        if let Some(record) = self
            .app_decisions
            .iter_mut()
            .find(|r| r["view_version"] == version)
        {
            if record["status"] != status {
                record["status"] = json!(status);
                self.app_decisions_revision += 1;
                self.app_decisions_dirty = true;
            }
        }
    }
}

/// Attribution is independent of how counts were measured. A runner can supply
/// exact per-part counts here without changing totals or the app reply shape.
struct PartTokens<'a> {
    part: &'a str,
    tokens: Option<u64>,
    estimate: bool,
}
impl<'a> PartTokens<'a> {
    fn unknown(part: &'a str) -> Self {
        Self {
            part,
            tokens: None,
            estimate: true,
        }
    }
    fn estimate(part: &'a str, tokens: u64) -> Self {
        Self {
            part,
            tokens: Some(tokens),
            estimate: true,
        }
    }
}
fn breakdown(parts: &[PartTokens<'_>], provider: Option<u64>, window: u64) -> Value {
    let estimated: u64 = parts.iter().filter_map(|part| part.tokens).sum();
    let total = provider.unwrap_or(estimated);
    json!({"managed":{"value":true}, "as_of":{"step_ref":null, "at_ms":null}, "total":{"tokens":total, "source":if provider.is_some() {"provider"} else {"estimate"}}, "context_window":{"tokens":window, "source":"usage"}, "parts":parts.iter().map(|part| json!({"part":part.part,"tokens":part.tokens,"estimate":part.estimate})).collect::<Vec<_>>(), "unattributed":total.saturating_sub(estimated), "estimation_source":"legacy_estimate", "last_user_message_in_history_raw":true})
}

/// The tokens of every `tag` block in a history-head text, counted with
/// `counter`.
fn block_tokens(text: &str, tag: &str, counter: crate::count::Counter) -> u64 {
    let pattern = regex::Regex::new(&format!("(?s)<{tag}(?:\\s[^>]*)?>.*?</{tag}>"))
        .expect("fixed block tag");
    pattern
        .find_iter(text)
        .map(|m| counter.count(m.as_str()))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_role_compaction::{
        part::Part,
        read::{Entry, Role},
        rules::{EditCost, ProviderRules, SignedParts},
        setup::ModelRef,
    };

    #[test]
    fn app_read_breakdown_accepts_exact_or_estimated_parts_and_provider_total() {
        let parts = [
            PartTokens::estimate("history_raw", 10),
            PartTokens {
                part: "tool_definitions",
                tokens: Some(7),
                estimate: false,
            },
            PartTokens::unknown("system_prompt"),
        ];
        let provider = breakdown(&parts, Some(25), 1000);
        assert_eq!(provider["total"], json!({"tokens":25,"source":"provider"}));
        assert_eq!(provider["unattributed"], 8);
        assert_eq!(provider["parts"][0]["estimate"], true);
        assert_eq!(provider["parts"][1]["estimate"], false);
        assert!(provider["parts"][2]["tokens"].is_null());
        let estimated = breakdown(&parts, None, 1000);
        assert_eq!(estimated["total"], json!({"tokens":17,"source":"estimate"}));
        assert_eq!(estimated["unattributed"], 0);
    }

    #[test]
    fn app_read_stamps_wait_for_confirmed_application_and_decisions_are_bounded() {
        let route = Route {
            session: SessionRef::new("runner", "host", "s"),
            project: None,
            workdir: None,
            agent_id: None,
        };
        let request = SetupRequest::new(
            crate::catalog::Preset::Worker.as_str(),
            ModelRef::new("p", "m"),
            1000,
            100,
            ProviderRules::new(SignedParts::None, EditCost::Suffix),
            vec![],
            1,
        );
        let mut session = Session::new(&route, &request, Features::NONE, None);
        let mut part = Part::new(
            "p",
            PartBody::Text {
                text: "hello".into(),
            },
        );
        part.tag = Some(2);
        session.index.extend(vec![
            Entry::new(
                1,
                "m1",
                Role::User,
                1,
                vec![Part::new(
                    "p",
                    PartBody::Text {
                        text: "task".into(),
                    },
                )],
            ),
            Entry::new(2, "m2", Role::Assistant, 2, vec![part]),
            // A later message, so m2 isn't the one the request ends on and
            // may lose its only part.
            Entry::new(
                3,
                "m3",
                Role::User,
                3,
                vec![Part::new(
                    "p",
                    PartBody::Text {
                        text: "next".into(),
                    },
                )],
            ),
        ]);
        let key = ("m2".into(), "p".into());
        session.queued.insert(key.clone());
        session.app.stamps.insert(key.clone(), 123);
        assert_eq!(
            session.app_snapshot().messages["m2"].row["stamped_parts"][0]["stamped_at_ms"],
            123
        );
        let view = session
            .seal(
                vec![EditOp::Drop {
                    mid: "m2".into(),
                    part: Some("p".into()),
                }],
                &[key],
            )
            .unwrap();
        session.accept(view.clone());
        let pending = session.app_snapshot();
        assert_eq!(pending.messages["m2"].row["state"], "raw");
        assert_eq!(
            pending.messages["m2"].row["stamped_parts"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        session.settle_unconfirmed(
            Some(&AppliedView::new(view.version, view.checksum.clone())),
            &[],
        );
        let applied = session.app_snapshot();
        assert_eq!(applied.messages["m2"].row["state"], "dropped");
        assert!(applied.messages["m2"].row["stamped_parts"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(session.app_decisions[0]["status"], "applied");
        for _ in 0..300 {
            session.app_record_view(&view);
        }
        assert_eq!(session.app_decisions.len(), 256);
        assert!(serde_json::to_value(session.durable()).unwrap()["app"]
            .get("decisions")
            .is_none());
    }

    impl Session {
        pub(crate) fn app_sample_snapshot() -> Snapshot {
            use cortexkit_role_compaction::{
                part::Part,
                read::{Entry, Role, StepUsage},
                rules::{EditCost, ProviderRules, SignedParts},
                setup::ModelRef,
            };
            let route = Route {
                session: SessionRef::new("thalamus-harness", "opencode2", "s"),
                project: None,
                workdir: None,
                agent_id: None,
            };
            let request = SetupRequest::new(
                crate::catalog::Preset::Head.as_str(),
                ModelRef::new("provider", "model"),
                100000,
                1000,
                ProviderRules::new(SignedParts::None, EditCost::Suffix),
                vec![],
                1,
            );
            let mut session = Session::new(
                &route,
                &request,
                crate::preset::features(crate::catalog::Preset::Head.as_str()).unwrap(),
                None,
            );
            let mut entries = Vec::new();
            for (ordinal, text) in [(1, "Earlier work"), (2, "Queued text"), (3, "Dropped text")] {
                let mut part = Part::new("p", PartBody::Text { text: text.into() });
                part.tag = Some(ordinal);
                let mut entry = Entry::new(
                    ordinal,
                    format!("m{ordinal}"),
                    if ordinal == 1 {
                        Role::User
                    } else {
                        Role::Assistant
                    },
                    ordinal * 10,
                    vec![part],
                );
                if ordinal == 2 {
                    let mut tool: Part = serde_json::from_value(json!({
                        "id":"tool", "kind":"tool", "call_id":"c", "name":"read",
                        "input":{"path":"source.rs"}, "status":"completed", "digest":"d", "output_bytes":4000
                    })).unwrap();
                    tool.tokens =
                        Some(cortexkit_role_compaction::tokens::PartTokens::tool(12, 700));
                    entry.parts.push(tool);
                    entry.parts.extend([
                        Part::new(
                            "reasoning-a",
                            PartBody::Reasoning {
                                text: None,
                                text_bytes: Some(4),
                            },
                        ),
                        Part::new(
                            "reasoning-b",
                            PartBody::Reasoning {
                                text: None,
                                text_bytes: Some(8),
                            },
                        ),
                    ]);
                    entry.reasoning_tokens = Some(
                        cortexkit_role_compaction::tokens::ReasoningTokens::new(1_001, true),
                    );
                }
                if ordinal == 3 {
                    let mut usage = StepUsage::default();
                    usage.prompt_tokens = Some(80);
                    entry.usage = Some(usage);
                }
                entries.push(entry);
            }
            session.index.extend_counted(entries, Some("claude-v5/1"));
            session.surface_tokens = (
                Some(cortexkit_role_compaction::tokens::SurfaceTokens::new(
                    120, true,
                )),
                None,
            );
            session.queued.insert(("m2".into(), "p".into()));
            session.app.stamps.insert(("m2".into(), "p".into()), 123);
            session.conditions.last_prompt_tokens = Some(80);
            // ck-mc would no longer drop the only part of the newest message,
            // but these samples are pinned byte for byte by the apps and only
            // show how a dropped part reads, so the view skips ck-mc's checks.
            let view = session.seal_unchecked(vec![EditOp::Drop {
                mid: "m3".into(),
                part: Some("p".into()),
            }]);
            session.accept(view.clone());
            session.settle_unconfirmed(Some(&AppliedView::new(view.version, view.checksum)), &[]);
            session.app_decisions[0]["at_ms"] = json!(40);
            session.summaries.push(StoredCompartment {
                sequence: 1,
                start_message: 1,
                end_message: 1,
                start_message_id: "m1".into(),
                end_message_id: "m1".into(),
                title: "Earlier work".into(),
                content: "A summary".into(),
                p1: Some("detail".into()),
                p2: Some("short".into()),
                p3: Some("tiny".into()),
                p4: Some("cue".into()),
                importance: 70,
                created_at: 40,
                ..Default::default()
            });
            let inputs = crate::summary::head::Inputs {
                counter: crate::count::Counter::for_model(Some("provider/model")),
                summaries: &session.summaries,
                docs: "<project-docs>Project layout</project-docs>",
                profile: &[],
                profile_max_id: 0,
                memories: &[],
                workspace: None,
                gone: &[],
                history_budget_tokens: 1000,
                history_local_budget_tokens: 1000,
                memory_budget_tokens: 1000,
                profile_budget_tokens: 1000,
            };
            let baseline = crate::summary::head::fold(&inputs, None);
            let (m1, next, _) = crate::summary::head::delta(&baseline, &inputs);
            let ops = crate::summary::head::head_ops(&next.m0, &m1, None);
            session.next_baseline = Some(next.into());
            // It carries the drop above, so it skips the checks too.
            let view = session.seal_unchecked(ops);
            session.accept(view.clone());
            session.settle_unconfirmed(Some(&AppliedView::new(view.version, view.checksum)), &[]);
            session.app_decisions[1]["at_ms"] = json!(40);
            session.app_snapshot()
        }
    }

    /// The breakdown scales to the usable window, the model's window less
    /// the output reserve, as the standalone plugin reports it; and it shows
    /// the runner's own counts of its system text and tool definitions.
    #[test]
    fn breakdown_uses_the_usable_window_and_the_runners_surface_counts() {
        let mut session = session();
        session.conditions.last_prompt_tokens = Some(500);
        let unknown = session.app_snapshot().breakdown;
        assert_eq!(unknown["context_window"]["tokens"], json!(100000 - 1000));
        assert_eq!(unknown["parts"][0]["tokens"], Value::Null);
        assert_eq!(unknown["parts"][1]["tokens"], Value::Null);

        session.surface_tokens = (
            Some(cortexkit_role_compaction::tokens::SurfaceTokens::new(
                120, true,
            )),
            Some(cortexkit_role_compaction::tokens::SurfaceTokens::new(
                80, false,
            )),
        );
        session.conditions.last_prompt_tokens = Some(501);
        session.threshold = (75.0, "user_percentage");
        let snapshot = session.app_snapshot();
        assert_eq!(
            snapshot.meta["execute_threshold"],
            json!({"percentage":75.0,"tokens":74250,"source":"user_percentage"})
        );
        let counted = snapshot.breakdown;
        assert_eq!(
            counted["parts"][0],
            json!({"part":"system_prompt","tokens":120,"estimate":false})
        );
        assert_eq!(
            counted["parts"][1],
            json!({"part":"tool_definitions","tokens":80,"estimate":true})
        );
    }

    fn session() -> Session {
        let route = Route {
            session: SessionRef::new("runner", "test", "incremental"),
            project: None,
            workdir: None,
            agent_id: None,
        };
        let setup = SetupRequest::new(
            crate::catalog::Preset::Head.as_str(),
            ModelRef::new("provider", "model"),
            100000,
            1000,
            ProviderRules::new(SignedParts::None, EditCost::Suffix),
            vec![],
            1,
        );
        let mut session = Session::new(
            &route,
            &setup,
            crate::preset::features(crate::catalog::Preset::Head.as_str()).unwrap(),
            None,
        );
        session.index.extend((1..=200).map(|ordinal| {
            Entry::new(
                ordinal,
                format!("m{ordinal}"),
                Role::Assistant,
                ordinal,
                vec![Part::new(
                    "p",
                    PartBody::Text {
                        text: "small text".into(),
                    },
                )],
            )
        }));
        session
    }

    #[tokio::test]
    async fn app_read_refreshes_changed_rows_in_the_saved_snapshot_after_a_minute() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::store::Store::open(&dir.path().join("mode3.db")).unwrap());
        let app = crate::app_read::AppRead::new(Some(store.path.clone()), None);
        let mut session = session();
        session.index_ready = true;
        session.set_store(Some(store.clone()));
        session.publish_app(&app, true);
        session.index.extend([Entry::new(
            201,
            "m201",
            Role::Assistant,
            201,
            vec![Part::new(
                "p",
                PartBody::Text {
                    text: "newer row".into(),
                },
            )],
        )]);
        session.publish_app(&app, false);
        assert_eq!(
            store.take_app_writes().1,
            1,
            "no immediate full snapshot on a notice"
        );
        session.app_age_snapshot();
        session.publish_app(&app, false);
        let reloaded = crate::app_read::AppRead::new(Some(store.path.clone()), None);
        let reply = reloaded
            .read(
                "context.states",
                json!({"session":session.key,"message_ids":["m201"]}),
            )
            .await
            .unwrap();
        assert_eq!(reply["messages"][0]["state"], "raw");
    }

    #[tokio::test]
    async fn app_read_dirty_checkpoint_writes_only_changed_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mode3.db");
        let store = Arc::new(crate::store::Store::open(&path).unwrap());
        let app = crate::app_read::AppRead::new(Some(path.clone()), None);
        let mut session = session();
        session.index_ready = true;
        session.summaries.push(StoredCompartment {
            sequence: 1,
            start_message: 1,
            end_message: 10,
            content: "unchanged summary".into(),
            ..Default::default()
        });
        session.set_store(Some(store));
        session.publish_app(&app, true);
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE checkpoint_events(table_name TEXT);")
            .unwrap();
        let tables: Vec<String> = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('app_read_headers','app_read_messages','app_read_summaries','app_read_snapshots')").unwrap().query_map([],|row|row.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
        for table in tables {
            for op in ["INSERT", "UPDATE", "DELETE"] {
                conn.execute_batch(&format!("CREATE TRIGGER observe_{table}_{op} AFTER {op} ON {table} BEGIN INSERT INTO checkpoint_events VALUES('{table}'); END;")).unwrap();
            }
        }
        session
            .index
            .extend([Entry::new(201, "m201", Role::Assistant, 201, vec![])]);
        session.publish_app(&app, false);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM checkpoint_events", [], |row| row
                .get::<_, u64>(0))
                .unwrap(),
            0
        );
        session.app_age_snapshot();
        session.publish_app(&app, false);
        let events: Vec<(String,u64)> = conn.prepare("SELECT table_name,count(*) FROM checkpoint_events GROUP BY table_name ORDER BY table_name").unwrap().query_map([],|row|Ok((row.get(0)?,row.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap();
        assert_eq!(
            events,
            vec![
                ("app_read_headers".into(), 1),
                ("app_read_messages".into(), 1)
            ]
        );

        // A busy writer must not acknowledge pending rows or summaries. The next
        // checkpoint retries the complete delta, including intervening updates.
        session
            .index
            .extend([Entry::new(202, "m202", Role::Assistant, 202, vec![])]);
        session.summaries[0].content = "updated summary".into();
        session.app_projection.summaries_dirty = true;
        session.app_age_snapshot();
        conn.execute_batch("BEGIN IMMEDIATE;").unwrap();
        session.publish_app(&app, false);
        conn.execute_batch("ROLLBACK;").unwrap();
        session
            .index
            .extend([Entry::new(203, "m203", Role::Assistant, 203, vec![])]);
        session.publish_app(&app, false);
        let reloaded = crate::app_read::AppRead::new(Some(path), None);
        let reply = reloaded
            .read(
                "context.states",
                json!({"session":session.key,"message_ids":["m201","m202","m203"]}),
            )
            .await
            .unwrap();
        for row in reply["messages"].as_array().unwrap() {
            assert_eq!(row["state"], "raw");
        }
        let summary = reloaded
            .read(
                "context.compartment",
                json!({"session":session.key,"compartment_id":"1"}),
            )
            .await
            .unwrap();
        assert_eq!(
            summary["compartment"]["summary_markdown"],
            "updated summary"
        );
    }

    #[tokio::test]
    async fn app_read_cut_and_revert_delete_checkpoint_rows_before_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mode3.db");
        let store = Arc::new(crate::store::Store::open(&path).unwrap());
        let app = crate::app_read::AppRead::new(Some(path.clone()), None);
        let mut session = session();
        session.index_ready = true;
        session.set_store(Some(store));
        session.publish_app(&app, true);
        session.cut = Some(100);
        let gone = session.index.prune_before(100);
        session.app_persist_cut(&gone);
        session.publish_app(&app, false);
        let conn = rusqlite::Connection::open(&path).unwrap();
        let ids = || {
            conn.prepare("SELECT message_id FROM app_read_messages ORDER BY ordinal")
                .unwrap()
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(
            ids(),
            (100..=200).map(|n| format!("m{n}")).collect::<Vec<_>>()
        );
        let cut = crate::app_read::AppRead::new(Some(path.clone()), None);
        let reply = cut
            .read(
                "context.states",
                json!({"session":session.key,"message_ids":["m1","m99","m100","m200"]}),
            )
            .await
            .unwrap();
        assert_eq!(reply["messages"][0]["state"], "outside");
        assert_eq!(reply["messages"][1]["state"], "outside");
        assert_eq!(reply["messages"][2]["state"], "raw");
        assert_eq!(reply["messages"][2]["items"][0]["state"], "dropped");
        assert_eq!(reply["messages"][3]["state"], "raw");
        session.index.truncate(150);
        session.publish_app(&app, false);
        assert_eq!(
            ids(),
            (100..150).map(|n| format!("m{n}")).collect::<Vec<_>>()
        );
        let reverted = crate::app_read::AppRead::new(Some(path), None);
        let reply = reverted
            .read(
                "context.states",
                json!({"session":session.key,"message_ids":["m149","m150","m200"]}),
            )
            .await
            .unwrap();
        assert_eq!(reply["messages"][0]["state"], "raw");
        assert_eq!(reply["messages"][1]["state"], "outside");
        assert_eq!(reply["messages"][2]["state"], "outside");
    }

    #[test]
    fn app_read_items_use_runner_tool_output_not_input() {
        let mut session = session();
        let mut part: Part = serde_json::from_value(json!({
            "id":"tool", "kind":"tool", "call_id":"c", "name":"read",
            "input":{"path":"source.rs"}, "status":"completed", "digest":"d", "output_bytes":4000
        }))
        .unwrap();
        part.tokens = Some(cortexkit_role_compaction::tokens::PartTokens::tool(12, 700));
        session.index.extend_counted(
            [Entry::new(
                201,
                "tool-message",
                Role::Assistant,
                201,
                vec![part],
            )],
            Some("claude-v5/1"),
        );
        assert_eq!(
            session.app_snapshot().messages["tool-message"].row["items"],
            json!([
                {"part_ref":{"part_key":"tool"}, "kind":"tool", "tool":"read", "tokens":700, "source":"runner", "state":"live"}
            ])
        );
    }

    #[test]
    fn app_read_items_count_text_with_the_models_tokenizer() {
        let mut session = session();
        session.conditions.model = ModelRef::new("anthropic", "claude-opus-5-5");
        let text = "Read the source; preserve the cached prefix. ".repeat(30);
        session.index.extend([Entry::new(
            201,
            "text-message",
            Role::User,
            201,
            vec![Part::new("text", PartBody::Text { text: text.clone() })],
        )]);
        let tokens = cortexkit_tokens::count(cortexkit_tokens::Family::ClaudeV5, &text).unwrap();
        assert_ne!(tokens, crate::tokens::bytes(text.len() as u64));
        assert_eq!(
            session.app_snapshot().messages["text-message"].row["items"][0],
            json!(
                {"part_ref":{"part_key":"text"}, "kind":"text", "tokens":tokens, "source":"counted", "state":"live"}
            )
        );
        assert!(
            session.app_update().rows.is_empty(),
            "unchanged parts reuse their counts"
        );
    }

    #[test]
    fn app_read_items_count_dropped_placeholders_and_whole_removals() {
        let mut session = session();
        session.conditions.model = ModelRef::new("anthropic", "claude-opus-5-5");
        let mut part = Part::new(
            "p",
            PartBody::Text {
                text: "original output ".repeat(100),
            },
        );
        part.tag = Some(201);
        session
            .index
            .extend([Entry::new(201, "m201", Role::Assistant, 201, vec![part])]);
        session.app_update();
        let view = session
            .seal(
                vec![EditOp::Replace {
                    mid: "m201".into(),
                    part: "p".into(),
                    field: "text".into(),
                    value: json!("[dropped §201§]"),
                    expect: session.index.at(201).unwrap().parts[0].digest.clone(),
                }],
                &[],
            )
            .unwrap();
        session.accept(view.clone());
        session.settle_unconfirmed(Some(&AppliedView::new(view.version, view.checksum)), &[]);
        let item = session.app_snapshot().messages["m201"].row["items"][0].clone();
        assert_eq!(item["state"], "dropped");
        assert_eq!(item["source"], "counted");
        assert_eq!(
            item["tokens"],
            cortexkit_tokens::count(cortexkit_tokens::Family::ClaudeV5, "[dropped §201§]").unwrap()
        );
        let view = session
            .seal(
                vec![EditOp::Drop {
                    mid: "m3".into(),
                    part: Some("p".into()),
                }],
                &[],
            )
            .unwrap();
        session.accept(view.clone());
        session.settle_unconfirmed(Some(&AppliedView::new(view.version, view.checksum)), &[]);
        assert_eq!(
            session.app_snapshot().messages["m3"].row["items"][0]["tokens"],
            0
        );
    }

    #[test]
    fn app_read_summary_items_count_each_rendered_tier_with_the_model_tokenizer() {
        use crate::summary::{head, render};
        let mut session = session();
        session.conditions.model = ModelRef::new("anthropic", "claude-opus-5-5");
        let summaries: Vec<_> = (1..=4)
            .map(|sequence| StoredCompartment {
                sequence,
                start_message: sequence * 10,
                end_message: sequence * 10 + 9,
                title: format!("Work {sequence}"),
                content: "Fallback".into(),
                p1: Some("Detailed decisions and source review. ".repeat(100)),
                p2: Some("Shorter decisions. ".repeat(20)),
                p3: Some("Brief decisions.".into()),
                p4: Some("Cue".into()),
                importance: 50,
                legacy: i32::from(sequence == 1),
                ..Default::default()
            })
            .collect();
        let mut inputs = head::Inputs {
            counter: crate::count::Counter::for_model(Some("anthropic/claude-opus-5-5")),
            summaries: &summaries[..3],
            docs: "",
            profile: &[],
            profile_max_id: 0,
            memories: &[],
            workspace: None,
            gone: &[],
            history_budget_tokens: 10000,
            history_local_budget_tokens: 10000,
            memory_budget_tokens: 1000,
            profile_budget_tokens: 1000,
        };
        let baseline = head::fold(&inputs, None);
        inputs.summaries = &summaries;
        let (m1, next, _) = head::delta(&baseline, &inputs);
        let ops = head::head_ops(&next.m0, &m1, None);
        session.next_baseline = Some(next.into());
        let view = session.seal(ops, &[]).unwrap();
        session.accept(view.clone());
        session.settle_unconfirmed(Some(&AppliedView::new(view.version, view.checksum)), &[]);
        let snapshot = session.app_snapshot();
        let items: Vec<_> = snapshot.breakdown["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["item"] == "summary")
            .collect();
        assert_eq!(items.len(), 4);
        assert!(items.iter().any(|item| item["tier"].as_u64().unwrap() > 1));
        for item in items {
            let id: usize = item["compartment_id"].as_str().unwrap().parse().unwrap();
            let text = render::render_compartment_at_tier(
                &render::DecayRenderCompartment::from(&summaries[id - 1]),
                item["tier"].as_u64().unwrap() as u8,
            );
            let head = if id == 4 { &m1 } else { &baseline.m0 };
            assert!(
                head.contains(&text),
                "attribution must describe the bytes actually rendered"
            );
            assert_eq!(
                item["tokens"],
                cortexkit_tokens::count(cortexkit_tokens::Family::ClaudeV5, &text).unwrap()
            );
            assert_eq!(item["source"], "counted");
        }
        assert!(session.app_update().rows.is_empty());
        assert_eq!(session.app_projection.head_rebuilds, 0);
        let mut old = serde_json::to_value(baseline).unwrap();
        old.as_object_mut().unwrap().remove("summary_items");
        assert!(serde_json::from_value::<head::Baseline>(old)
            .unwrap()
            .summary_items
            .is_empty());
    }

    #[test]
    fn app_read_updates_only_changed_rows_and_reuses_summary_and_decision_arcs() {
        let mut session = session();
        let first = session.app_update();
        assert_eq!(first.rows.len(), 200);
        let summaries = first.compartments.unwrap();
        let unchanged = session.app_update();
        assert!(unchanged.rows.is_empty());
        assert!(unchanged.compartments.is_none());
        assert!(unchanged.decisions.is_none());
        assert!(Arc::ptr_eq(&first.header, &unchanged.header));
        let mut completed = session.index.at(200).unwrap().clone();
        completed.completed_at = Some(123);
        session.index.extend([completed]);
        assert!(session.app_update().rows.is_empty());
        session.index.extend([Entry::new(
            201,
            "m201",
            Role::Assistant,
            201,
            vec![Part::new(
                "p",
                PartBody::Text {
                    text: "new text".into(),
                },
            )],
        )]);
        let appended = session.app_update();
        assert_eq!(appended.rows.len(), 1);
        assert_eq!(appended.rows[0].0, "m201");
        assert!(appended.compartments.is_none());
        assert!(appended.decisions.is_none());
        session.queued.insert(("m2".into(), "p".into()));
        session.app.stamps.insert(("m2".into(), "p".into()), 42);
        session.app_projection.dirty.insert("m2".into());
        let stamp = session.app_update();
        assert_eq!(stamp.rows.len(), 1);
        assert_eq!(stamp.rows[0].1.row["stamped_parts"][0]["stamped_at_ms"], 42);
        assert_eq!(stamp.header.meta["queued_stamp_count"], 1);
        assert!(stamp.compartments.is_none());
        assert!(Arc::ptr_eq(
            &summaries,
            &session.app_projection.summary_arc()
        ));
        session.summaries.push(StoredCompartment {
            sequence: 1,
            start_message: 1,
            end_message: 3,
            ..Default::default()
        });
        session.app_projection.summaries_dirty = true;
        let summary = session.app_update();
        assert!(summary.rows.is_empty());
        assert_eq!(summary.compartments.unwrap().len(), 1);
        assert_eq!(summary.header.meta["queued_stamp_count"], 0);
    }

    /// The head's blocks are counted in the reading model's vocabulary, the
    /// one the head composer fills its budgets in, not at four bytes a
    /// token: on Claude that would show the summaries about a third low.
    #[test]
    fn breakdown_counts_the_head_with_the_models_tokenizer() {
        use cortexkit_role_compaction::view::{InsertAt, InsertedMessage};
        let mut session = session();
        session.conditions.model = ModelRef::new("anthropic", "claude-opus-5-5");
        let memory = format!(
            "<project-memory>{}</project-memory>",
            "Decided: the runner fixes a child's tools at its first send. ".repeat(200)
        );
        let history = format!(
            "<session-history>{}</session-history>",
            "Reviewed the move, merged the fix and placed the build on the Mac. ".repeat(400)
        );
        let text = format!("{memory}\n{history}");
        let head = EditOp::Insert {
            at: InsertAt::Start,
            message: InsertedMessage::new("m0", Role::User, vec![text.clone()]),
        };
        let view = session.seal(vec![head], &[]).unwrap();
        session.accept(view.clone());
        session.settle_unconfirmed(Some(&AppliedView::new(view.version, view.checksum)), &[]);
        let parts = session.app_snapshot().breakdown["parts"].clone();
        let claude =
            |text: &str| cortexkit_tokens::count(cortexkit_tokens::Family::ClaudeV5, text).unwrap();
        assert_eq!(parts[2]["part"], "memory");
        assert_eq!(parts[2]["tokens"], json!(claude(&memory)));
        assert_eq!(parts[5]["part"], "history_summaries");
        assert_eq!(parts[5]["tokens"], json!(claude(&text) - claude(&memory)));
        assert_ne!(
            parts[5]["tokens"],
            json!(crate::tokens::bytes(history.len() as u64 + 1))
        );
    }

    #[test]
    fn app_read_reuses_an_unchanged_head_when_a_drop_view_is_applied() {
        use cortexkit_role_compaction::view::{InsertAt, InsertedMessage};
        let mut session = session();
        let head = EditOp::Insert {
            at: InsertAt::Start,
            message: InsertedMessage::new(
                "cached-head",
                Role::User,
                vec![format!(
                    "<project-docs>{}</project-docs>",
                    "stable docs ".repeat(10000)
                )],
            ),
        };
        let view = session.seal(vec![head], &[]).unwrap();
        session.accept(view.clone());
        session.settle_unconfirmed(Some(&AppliedView::new(view.version, view.checksum)), &[]);
        session.app_update();
        assert_eq!(session.app_projection.head_rebuilds, 1);
        let view = session
            .seal(
                vec![EditOp::Drop {
                    mid: "m2".into(),
                    part: Some("p".into()),
                }],
                &[("m2".into(), "p".into())],
            )
            .unwrap();
        session.accept(view.clone());
        session.app_update();
        session.settle_unconfirmed(Some(&AppliedView::new(view.version, view.checksum)), &[]);
        let applied = session.app_update();
        assert_eq!(applied.rows.len(), 1);
        assert_eq!(applied.rows[0].1.row["state"], "dropped");
        assert_eq!(session.app_projection.head_rebuilds, 0);
    }

    mod perf_tests {
        include!("perf_tests.rs");
    }

    mod reasoning_tests {
        include!("reasoning_tests.rs");
    }
}
