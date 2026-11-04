//! Projection built by a session's own work, never by an app request.
use super::*;
use crate::app_read::{Message, Snapshot};
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

fn block_tokens(text: &str, tag: &str) -> u64 {
    let pattern = regex::Regex::new(&format!("(?s)<{tag}(?:\\s[^>]*)?>.*?</{tag}>"))
        .expect("fixed block tag");
    pattern
        .find_iter(text)
        .map(|m| crate::tokens::bytes(m.as_str().len() as u64))
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
                if ordinal == 3 {
                    let mut usage = StepUsage::default();
                    usage.prompt_tokens = Some(80);
                    entry.usage = Some(usage);
                }
                entries.push(entry);
            }
            session.index.extend(entries);
            session.queued.insert(("m2".into(), "p".into()));
            session.app.stamps.insert(("m2".into(), "p".into()), 123);
            session.conditions.last_prompt_tokens = Some(80);
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
}
