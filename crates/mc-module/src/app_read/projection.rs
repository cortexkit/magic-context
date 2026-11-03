//! Projection built by a session's own work, never by an app request.
use super::*;
use crate::app_read::{Message, Snapshot};
use serde_json::json;

impl Session {
    pub(crate) fn app_snapshot(&mut self) -> Snapshot {
        let mut queued = self.queued.clone();
        let (view, cut) = if let Some(pending) = self.unconfirmed.first() {
            queued.extend(pending.before.queued.iter().cloned());
            (pending.before.latest.as_ref(), pending.before.cut)
        } else {
            (self.latest.as_ref(), self.cut)
        };
        self.app.stamps.retain(|(key, _)| queued.contains(key));
        let edited = lanes::Edited::of(view, &self.index, cut);
        let mut messages = std::collections::BTreeMap::new();
        let mut raw_tokens = 0;
        let mut tool_tokens = 0;
        for entry in self.index.entries() {
            let mut stamped = Vec::new();
            let mut dropped = Vec::new();
            let mut tagged = 0;
            for part in &entry.parts {
                tagged += usize::from(part.tag.is_some());
                let key = (entry.mid.clone(), part.id.clone());
                let tokens = crate::tokens::part(part);
                let body = serde_json::to_value(part).expect("part JSON");
                let kind = body["kind"].as_str().unwrap_or("opaque");
                let bytes = match &part.body {
                    PartBody::Text { text } => Some(text.len() as u64),
                    PartBody::Reasoning { text_bytes, .. } => *text_bytes,
                    PartBody::Tool(tool) => tool.output_bytes,
                    _ => None,
                };
                let size = json!({"bytes":bytes, "tokens":tokens, "input_bytes":null, "input_tokens":null});
                if queued.contains(&key) && !edited.covers(&entry.mid, &part.id) {
                    stamped.push(json!({"kind":kind, "part_ref":{"part_key":part.id}, "size":size, "stage":"queued", "stamped_at_ms":self.app.stamps.iter().find(|(k,_)| k==&key).map(|(_,at)| at), "stamped_at_source":"recorded"}));
                }
                if edited.covers(&entry.mid, &part.id)
                    && !cut.is_some_and(|cut| entry.ordinal <= cut)
                {
                    dropped.push(json!({"kind":kind, "part_ref":{"part_key":part.id}, "size":size, "dropped_at_ms":null, "dropped_at_source":"not_recorded", "drop_mode":null}));
                } else if !cut.is_some_and(|cut| entry.ordinal <= cut) {
                    if matches!(part.body, PartBody::Tool(_)) {
                        tool_tokens += tokens;
                    } else {
                        raw_tokens += tokens;
                    }
                }
            }
            let state = if !entry.parts.is_empty() && dropped.len() == entry.parts.len() {
                "dropped"
            } else {
                "raw"
            };
            let row = json!({"message_id":entry.mid, "state":state, "compartment_id":null, "outside_reason":null, "split":null, "parts":{"tagged":tagged, "stamped":stamped.len(), "dropped":dropped.len()}, "stamped_parts":stamped, "dropped_parts":dropped});
            messages.insert(
                entry.mid.clone(),
                Message {
                    ordinal: entry.ordinal,
                    at_ms: entry.written_at,
                    row,
                },
            );
        }
        let compartments: Vec<Value> = self.summaries.iter().map(|c| {
            json!({"compartment_id":c.sequence.to_string(), "ordinal":c.sequence, "title":c.title, "first_message_id":c.start_message_id, "last_message_id":c.end_message_id, "first_message_ordinal":c.start_message, "last_message_ordinal":c.end_message, "first_at_ms":null, "last_at_ms":null, "message_count":(c.end_message-c.start_message+1).max(0), "importance":c.importance, "summary_markdown":c.content, "summary_markdown_bytes":c.content.len(), "summary_markdown_truncated":false, "tiers":{"p1":c.p1, "p2":c.p2, "p3":c.p3, "p4":c.p4}, "tiers_bytes":{"p1":c.p1.as_ref().map(String::len), "p2":c.p2.as_ref().map(String::len), "p3":c.p3.as_ref().map(String::len), "p4":c.p4.as_ref().map(String::len)}, "tiers_truncated":{"p1":false,"p2":false,"p3":false,"p4":false}, "created_at_ms":c.created_at, "legacy":c.legacy!=0, "episode_type":c.episode_type, "facts":{"attribution":"historian_run", "by_category":{}, "session_facts_cursor":null}})
        }).collect();
        let usage = self
            .index
            .entries()
            .iter()
            .rev()
            .find(|entry| entry.usage.is_some());
        let at = usage.map(|entry| entry.completed_at.unwrap_or(entry.written_at));
        let provider_total = self
            .conditions
            .last_prompt_tokens
            .or_else(|| usage.and_then(|e| e.usage.and_then(|u| u.prompt_tokens)));
        let head_text = view
            .map(|view| {
                view.edits
                    .iter()
                    .filter_map(|edit| match &edit.op {
                        EditOp::Insert { message, .. } => Some(message.texts.join("\n")),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        let docs = block_tokens(&head_text, "project-docs");
        let profile = block_tokens(&head_text, "user-profile");
        let memory =
            block_tokens(&head_text, "project-memory") + block_tokens(&head_text, "memory-updates");
        let head_tokens =
            crate::tokens::bytes(head_text.len() as u64).saturating_sub(docs + profile + memory);
        let baseline = self
            .unconfirmed
            .first()
            .map_or(self.baseline.as_ref(), |pending| {
                pending.before.baseline.as_ref()
            });
        let memory_count = baseline.map_or(0, |b| b.seen.len());
        let parts = [
            PartTokens::unknown("system_prompt"),
            PartTokens::unknown("tool_definitions"),
            PartTokens::estimate("memory", memory),
            PartTokens::estimate("project_docs", docs),
            PartTokens::estimate("user_profile", profile),
            PartTokens::estimate("history_summaries", head_tokens),
            PartTokens::estimate("history_raw", raw_tokens),
            PartTokens::estimate("tool_calls_results", tool_tokens),
            PartTokens::estimate("last_user_message", 0),
        ];
        let mut breakdown = breakdown(&parts, provider_total, self.conditions.context_window);
        breakdown["managed"] = json!({"value":!self.tools_only && !self.suspended});
        breakdown["as_of"] = json!({"step_ref":usage.map(|entry| &entry.mid), "at_ms":at});
        breakdown["parts"][2]["count"] = json!(memory_count);
        if self.tools_only || self.suspended {
            breakdown["total"] = Value::Null;
            breakdown["context_window"] = Value::Null;
            breakdown["parts"] = json!([]);
            breakdown["unattributed"] = Value::Null;
            breakdown["estimation_source"] = Value::Null;
        }
        let queued_stamp_count: usize = messages
            .values()
            .filter(|message| {
                !self.summaries.iter().any(|c| {
                    c.start_message as u64 <= message.ordinal
                        && c.end_message as u64 >= message.ordinal
                })
            })
            .map(|message| message.row["stamped_parts"].as_array().map_or(0, Vec::len))
            .sum();
        let meta = json!({"session_id":self.key.session, "compartment_count":self.summaries.len(), "newest_compartment_at_ms":self.summaries.last().map(|c| c.created_at), "queued_stamp_count":queued_stamp_count, "compartment_in_progress":self.summarizing, "historian_failure_count":self.app.failures, "historian_last_error":self.app.last_error, "memory_block_count":memory_count, "cache_ttl":null, "last_response_time_ms":at, "is_subagent":!self.features.summarizer, "last_input_tokens":provider_total});
        Snapshot {
            key: self.key.clone(),
            base: self.index.base(),
            newest: self
                .index
                .entries()
                .last()
                .map_or(self.cut.unwrap_or(0), |e| e.ordinal),
            ready: self.index_ready,
            meta,
            breakdown,
            compartments,
            messages,
            decisions: self.app.decisions.clone(),
        }
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
        self.app.decisions.push(json!({"view_version":view.version, "view_checksum":view.checksum, "status":"offered", "producer_ref":null, "at_ms":crate::app_read::now_ms(), "decision":"publish", "cause":self.app_cause, "changes":{"model":changes, "system_prompt":null, "tool_set":null}, "dropped_count":self.next_covered.len(), "dropped_tokens":freed, "emergency":self.next_latch, "identity_delta":identity_delta, "input_tokens":self.conditions.last_prompt_tokens, "materialized":materialized}));
        if self.app.decisions.len() > 256 {
            self.app.decisions.remove(0);
        }
        self.app.last_model = Some(model);
    }

    pub(crate) fn app_view_status(&mut self, version: u64, status: &str) {
        if let Some(record) = self
            .app
            .decisions
            .iter_mut()
            .find(|r| r["view_version"] == version)
        {
            record["status"] = json!(status);
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
            "worker",
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
        session.app.stamps.push((key.clone(), 123));
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
        assert_eq!(session.app.decisions[0]["status"], "applied");
        for _ in 0..300 {
            session.app_record_view(&view);
        }
        assert_eq!(session.app.decisions.len(), 256);
        assert_eq!(session.durable().app.decisions.len(), 256);
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
                "head",
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
                crate::preset::features("head").unwrap(),
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
            session.app.stamps.push((("m2".into(), "p".into()), 123));
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
            session.app.decisions[0]["at_ms"] = json!(40);
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
}
