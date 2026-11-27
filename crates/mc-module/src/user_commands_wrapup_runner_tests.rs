use super::*;
use crate::client::{Child, ClientError};
use cortexkit_role_routing::select::{RouteRef, RunnerRef, SelectAnswer, SelectRequest};

#[derive(Default)]
struct Trace {
    runner: Client,
    children: Mutex<Vec<(SessionRef, String)>>,
    selects: Mutex<Vec<SelectRequest>>,
    session_sends: Mutex<usize>,
    complete: bool,
    telemetry: Option<TelemetryCase>,
}

struct SummaryClient(Arc<Trace>);

#[derive(Clone, Copy, PartialEq, Eq)]
enum TelemetryCase {
    Stored,
    Fallback,
    Failed,
    Wait,
    Empty,
    Unconfirmed,
}

const PRIVATE_FIXTURE_TEXT: &str = "history-and-summary-marker🪶";

impl RunnerClient for SummaryClient {
    async fn read(
        &self,
        session: &SessionRef,
        request: ReadRequest,
    ) -> Result<ReadPage, ClientError> {
        if self.0.telemetry == Some(TelemetryCase::Empty) && request.detail == Detail::Full {
            return self.0.runner.read(session, request).await.map(|mut page| {
                for entry in &mut page.entries {
                    entry.parts.clear();
                }
                page
            });
        }
        self.0.runner.read(session, request).await
    }
    async fn apply_view(
        &self,
        session: &SessionRef,
        request: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        self.0.runner.apply_view(session, request).await
    }
    async fn applied_view(&self, session: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        self.0.runner.applied_view(session).await
    }
    async fn send(
        &self,
        session: &SessionRef,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        *self.0.session_sends.lock().unwrap() += 1;
        self.0.runner.send(session, request).await
    }
    async fn send_child(
        &self,
        child: &Child,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        self.0.children.lock().unwrap().push((
            child.session.clone(),
            serde_json::to_string(&request).unwrap(),
        ));
        if self.0.telemetry == Some(TelemetryCase::Unconfirmed) {
            return Err(ClientError::unanswered(PRIVATE_FIXTURE_TEXT));
        }
        if self.0.complete {
            let mut reply = SendReply::new("active");
            reply.run_id = Some("summary-run".into());
            return Ok(reply);
        }
        Err(ClientError::refused(
            "account_limit_exhausted",
            "Account is waiting",
        ))
    }
    async fn child_result(
        &self,
        child: &Child,
        _: RunResultRequest,
    ) -> Result<RunResult, ClientError> {
        assert!(self.0.complete, "the send was refused before a run started");
        let pattern = regex::Regex::new(r":(\d+)-(\d+):").unwrap();
        let captures = pattern.captures(&child.session.session).unwrap();
        let (from, through) = (&captures[1], &captures[2]);
        let next = through.parse::<u64>().unwrap() + 1;
        if self.0.telemetry == Some(TelemetryCase::Failed)
            || (self.0.telemetry == Some(TelemetryCase::Fallback)
                && child.session.session.contains("summary-decision-1:"))
        {
            return Ok(RunResult::new("summary-run", "error").with_error(
                cortexkit_role_llm_runner::run::RunError::new(
                    "permanent",
                    PRIVATE_FIXTURE_TEXT,
                    "provider_error",
                ),
            ));
        }
        let mut result = RunResult::new("summary-run", "completed");
        let p1 = if self.0.telemetry.is_some() {
            result.usage = Some(
                serde_json::from_value(json!({
                    "steps": 1, "unreported_steps": 0, "input_tokens": 100,
                    "output_tokens": 20, "cached_input_tokens": 50, "cache_write_tokens": 5
                }))
                .unwrap(),
            );
            PRIVATE_FIXTURE_TEXT
        } else {
            "Completed earlier work."
        };
        result.final_message = Some(cortexkit_role_llm_runner::run::FinalMessage {
            ordinal: 1, mid: "summary-answer".into(),
            // The summarizer's first-turn envelope; the session has no
            // project, so no second turn follows.
            text: mc_mock_runner::child::turn_one_reply(&format!("<output><compartments><compartment start=\"{from}\" end=\"{through}\" title=\"Earlier work\" episode_type=\"feature\" importance=\"50\"><p1>{p1}</p1><p2>Earlier work.</p2><p3>Work.</p3><p4 /></compartment></compartments><meta><unprocessed_from>{next}</unprocessed_from></meta></output>")),
        });
        Ok(result)
    }
}

impl crate::routing::Router for SummaryClient {
    async fn select(
        &self,
        request: SelectRequest,
    ) -> Result<SelectAnswer, crate::routing::RouteError> {
        let mut selects = self.0.selects.lock().unwrap();
        let number = selects.len() + 1;
        let route = if number == 1 || self.0.telemetry.is_none() {
            RouteRef::new("test", "summary-model")
        } else {
            RouteRef::new("backup-provider", format!("backup-{number}"))
        };
        let runner = RunnerRef::new(request.runners.as_ref().unwrap()[0].clone(), route.clone());
        selects.push(request);
        if !self.0.complete && selects.len() > 1 {
            return Err(crate::routing::RouteError {
                code: "no_route".into(),
                message: "every rung is walled".into(),
                detail: Some(json!({
                    "reason": "quota_or_cooldown",
                    "reset_at_ms": crate::summary::account_wait::now_ms() + 10 * 60_000,
                })),
            });
        }
        Ok(SelectAnswer::new(
            if self.0.telemetry.is_some() {
                format!("summary-decision-{number}")
            } else {
                "summary-decision".into()
            },
            route,
            runner,
            400_000,
            32_000,
            u64::MAX,
            "test",
        ))
    }
    async fn report(&self, _: cortexkit_role_routing::report::ReportRequest) {}
}

#[tokio::test(start_paused = true)]
async fn wrapup_worker_starts_one_child_and_status_reports_routings_wait() {
    let (session, _, settings) = wrapup::ready();
    let (_, _, route, mut setup, _) = fixture();
    setup.preset = "head".into();
    setup.newest = session.index.entries().last().map(cursor);
    let trace = Arc::new(Trace::default());
    *trace.runner.entries.lock().unwrap() = session.index.entries().to_vec();
    let module = crate::module::Module::new(SummaryClient(trace.clone()), settings, None, None);
    module.setup(route, setup).unwrap();
    module.idle(&session.key).await.unwrap();
    *trace.session_sends.lock().unwrap() = 0;
    let caller = subc_protocol::Principal::Reserved {
        module_id: "occipital".into(),
    };
    let p = wrapup::request(&session, Some(2));
    let body = serde_json::to_vec(&json!({"method":"commands.preview", "params":p})).unwrap();
    let p: wire::Preview =
        serde_json::from_value(module.command_request(&caller, &body).await.unwrap()).unwrap();
    assert!(p.available, "{p:?}");
    let r = wire::ModuleRunRequest::new(
        wrapup::request(&session, Some(2)),
        p.version,
        "worker-wrapup",
    );
    let body = serde_json::to_vec(&json!({"method":"commands.run", "params":r})).unwrap();
    let answer = module.command_request(&caller, &body).await.unwrap();
    assert_eq!(answer["outcome"], "scheduled");
    module.idle(&session.key).await.unwrap();
    assert_eq!(
        module.command_request(&caller, &body).await.unwrap(),
        answer
    );
    module.idle(&session.key).await.unwrap();
    {
        let children = trace.children.lock().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].0.runner, session.key.runner);
        assert_eq!(children[0].0.harness, session.key.harness);
        assert!(
            children[0].1.contains("[22]") || children[0].1.contains("-22]"),
            "requested prefix reaches message 22"
        );
        assert!(
            !children[0].1.contains("[23]"),
            "newest prompt stays raw for keep=2"
        );
        let selects = trace.selects.lock().unwrap();
        assert_eq!(selects.len(), 2);
        assert_eq!(selects[0], selects[1]);
        assert_eq!(
            *trace.session_sends.lock().unwrap(),
            0,
            "wrapup tells the agent nothing"
        );
    }
    let body = serde_json::to_vec(
        &json!({"method":"commands.preview", "params":preview_request(&session, "status")}),
    )
    .unwrap();
    let status = module.command_request(&caller, &body).await.unwrap();
    let status = status.to_string();
    assert!(status.contains("Wrapup target"));
    assert!(status.contains("Wrapup through"));
    assert!(status.contains("paused"));
    assert!(status.contains("Summaries wait for a model route"));
}

#[tokio::test]
async fn wrapup_worker_drains_successive_runs_until_target_is_covered() {
    let (session, _, settings) = wrapup::ready();
    let (_, _, route, mut setup, _) = fixture();
    setup.preset = "head".into();
    let trace = Arc::new(Trace {
        complete: true,
        ..Default::default()
    });
    *trace.runner.entries.lock().unwrap() = (1..=600)
        .map(|ordinal| {
            Entry::new(
                ordinal,
                format!("m{ordinal}"),
                if ordinal % 2 == 1 {
                    Role::User
                } else {
                    Role::Assistant
                },
                ordinal,
                vec![Part::new(
                    "p",
                    PartBody::Text {
                        text: "a".repeat(400).into(),
                    },
                )],
            )
        })
        .collect();
    setup.newest = trace.runner.entries.lock().unwrap().last().map(cursor);
    let module = crate::module::Module::new(SummaryClient(trace.clone()), settings, None, None);
    module.setup(route, setup).unwrap();
    module.idle(&session.key).await.unwrap();
    let caller = subc_protocol::Principal::Reserved {
        module_id: "occipital".into(),
    };
    let body = serde_json::to_vec(
        &json!({"method":"commands.preview", "params":wrapup::request(&session, Some(0))}),
    )
    .unwrap();
    let p: wire::Preview =
        serde_json::from_value(module.command_request(&caller, &body).await.unwrap()).unwrap();
    assert!(p.available, "{p:?}");
    assert_eq!(p.facts.unwrap()[0].data.value, Some(600.0));
    let r = wire::ModuleRunRequest::new(wrapup::request(&session, Some(0)), p.version, "drain-all");
    let body = serde_json::to_vec(&json!({"method":"commands.run", "params":r})).unwrap();
    assert_eq!(
        module.command_request(&caller, &body).await.unwrap()["outcome"],
        "scheduled"
    );
    module.idle(&session.key).await.unwrap();
    assert!(
        trace.children.lock().unwrap().len() > 1,
        "success starts another capped run"
    );
    let body = serde_json::to_vec(
        &json!({"method":"commands.preview", "params":wrapup::request(&session, Some(0))}),
    )
    .unwrap();
    let p: wire::Preview =
        serde_json::from_value(module.command_request(&caller, &body).await.unwrap()).unwrap();
    assert_eq!(
        p.reason.as_deref(),
        Some("nothing_to_summarize"),
        "preview {p:?}; children {:?}",
        trace
            .children
            .lock()
            .unwrap()
            .iter()
            .map(|(child, _)| &child.session)
            .collect::<Vec<_>>()
    );
    let body = serde_json::to_vec(
        &json!({"method":"commands.preview", "params":preview_request(&session, "status")}),
    )
    .unwrap();
    assert!(!module
        .command_request(&caller, &body)
        .await
        .unwrap()
        .to_string()
        .contains("Wrapup target"));
}

/// History the runner serves without part numbers holds every view until a
/// summary passes its last entry. When that history is longer than one
/// summarizer chunk, the runs must follow one another until they reach that
/// entry, as a wrap-up's do, rather than wait for the session's next notice
/// while its views stay held.
#[tokio::test]
async fn numbers_review_summaries_drain_successive_runs_until_the_numbers_floor() {
    let (session, _, route, mut setup, settings) = fixture();
    setup.preset = "head".into();
    let trace = Arc::new(Trace {
        complete: true,
        ..Default::default()
    });
    let floor = 150;
    *trace.runner.entries.lock().unwrap() = (1..=160)
        .map(|ordinal| {
            let mut entry = Entry::new(
                ordinal,
                format!("m{ordinal}"),
                if ordinal % 2 == 1 {
                    Role::User
                } else {
                    Role::Assistant
                },
                ordinal,
                vec![Part::new(
                    "p",
                    PartBody::Text {
                        text: "word ".repeat(400).into(),
                    },
                )],
            );
            // The parts carry no tag, so marking the entry leaves its
            // digest unchanged.
            entry.numbers_unknown = ordinal <= floor;
            entry
        })
        .collect();
    let newest = trace.runner.entries.lock().unwrap().last().map(cursor);
    setup.newest = newest.clone();
    let module = crate::module::Module::new(SummaryClient(trace.clone()), settings, None, None);
    module.setup(route.clone(), setup).unwrap();
    module.idle(&route.session).await.unwrap();
    module
        .notice(&route.session, notice(&session, 1, newest))
        .unwrap();
    module.idle(&route.session).await.unwrap();
    let pattern = regex::Regex::new(r":(\d+)-(\d+):").unwrap();
    let ranges: Vec<(u64, u64)> = trace
        .children
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(child, _)| {
            let captures = pattern.captures(&child.session)?;
            Some((captures[1].parse().ok()?, captures[2].parse().ok()?))
        })
        .collect();
    assert!(!ranges.is_empty(), "no summary started");
    assert!(
        ranges.iter().any(|(_, through)| *through >= floor),
        "the summaries stopped short of the numbers floor at {floor} until another notice: runs {ranges:?}"
    );
}

async fn telemetry_wrapup(
    case: TelemetryCase,
    reject_metrics: bool,
) -> (ContextDb, tempfile::TempDir, usize) {
    let (session, _, settings) = wrapup::ready();
    let (_, _, route, mut setup, _) = fixture();
    setup.preset = "head".into();
    setup.newest = session.index.entries().last().map(cursor);
    let trace = Arc::new(Trace {
        complete: case != TelemetryCase::Wait,
        telemetry: Some(case),
        ..Default::default()
    });
    *trace.runner.entries.lock().unwrap() = session.index.entries().to_vec();
    trace.runner.entries.lock().unwrap()[0] = Entry::new(
        1,
        "m1",
        Role::User,
        1,
        vec![Part::new(
            "p",
            PartBody::Text {
                text: PRIVATE_FIXTURE_TEXT.into(),
            },
        )],
    );
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    let db = ContextDb::create_for_tests(&path).unwrap();
    if reject_metrics {
        db.with_connection(|conn| {
            conn.execute_batch("CREATE TRIGGER reject_metrics BEFORE INSERT ON historian_runs BEGIN SELECT RAISE(ABORT, 'fixture'); END;")
        }).unwrap();
    }
    let module = crate::module::Module::new(
        SummaryClient(trace.clone()),
        settings,
        Some(ContextDb::open(&path).unwrap()),
        None,
    );
    module.setup(route, setup).unwrap();
    module.idle(&session.key).await.unwrap();
    let caller = subc_protocol::Principal::Reserved {
        module_id: "occipital".into(),
    };
    let request = wrapup::request(&session, Some(2));
    let body = serde_json::to_vec(&json!({"method":"commands.preview", "params":request})).unwrap();
    let preview: wire::Preview =
        serde_json::from_value(module.command_request(&caller, &body).await.unwrap()).unwrap();
    assert!(preview.available, "{preview:?}");
    let request = wire::ModuleRunRequest::new(request, preview.version, "telemetry-wrapup");
    let body = serde_json::to_vec(&json!({"method":"commands.run", "params":request})).unwrap();
    assert_eq!(
        module.command_request(&caller, &body).await.unwrap()["outcome"],
        "scheduled"
    );
    module.idle(&session.key).await.unwrap();
    let result = module
        .historian_idle()
        .await
        .expect("a run attempted its telemetry batch");
    if reject_metrics {
        assert_eq!(result.unwrap_err(), "fixture");
    } else {
        result.unwrap();
    }
    let chars = trace
        .children
        .lock()
        .unwrap()
        .last()
        .map_or(0, |(_, serialized)| {
            let request: SendRequest = serde_json::from_str(serialized).unwrap();
            let (_, chunk) = request
                .prompt
                .as_deref()
                .unwrap()
                .split_once("<new_messages>\n\n")
                .unwrap();
            let (chunk, _) = chunk.split_once("\n\n</new_messages>").unwrap();
            assert!(chunk.contains(PRIVATE_FIXTURE_TEXT));
            chunk.encode_utf16().count()
        });
    (db, dir, chars)
}

#[tokio::test]
async fn historian_telemetry_stored_run_uses_durable_summary_ids_and_numeric_metrics() {
    let (db, _dir, chunk_chars) = telemetry_wrapup(TelemetryCase::Stored, false).await;
    db.with_connection(|conn| {
        let (link, status, kind, harness, start, end, next, produced, low, high, metrics): (
            i64,
            String,
            String,
            String,
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
            String,
        ) = conn
            .query_row(
                "SELECT subagent_invocation_id, status, run_kind, harness, chunk_start_ordinal,
             chunk_end_ordinal, unprocessed_from, compartments_produced, compartment_id_min,
             compartment_id_max, facts_by_category_json FROM historian_runs",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                        r.get(10)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!((status.as_str(), kind.as_str()), ("success", "incremental"));
        assert_eq!((start, end, next, produced), (1, 22, 23, 1));
        let counters: serde_json::Value = serde_json::from_str(&metrics).unwrap();
        assert_eq!(counters["trigger"], "wrapup");
        assert_eq!(counters["chunk_messages"], 22);
        assert_eq!(counters["chunk_chars"], chunk_chars);
        assert_eq!(
            counters["tier_chars"],
            json!([PRIVATE_FIXTURE_TEXT.encode_utf16().count(), 13, 5, 0])
        );
        assert_eq!(counters["requests"], 1);
        assert_eq!(counters["events_published"], 0);
        assert_eq!(counters["facts_promoted"], 0);
        assert!(counters["duration_ms"].is_u64());
        let (id, owner, p1): (i64, String, String) = conn
            .query_row("SELECT id,harness,p1 FROM compartments", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!((low, high, harness.as_str()), (id, id, owner.as_str()));
        assert_eq!(p1, PRIVATE_FIXTURE_TEXT);
        assert!(!metrics.contains(PRIVATE_FIXTURE_TEXT));
        let session_id: String = conn
            .query_row("SELECT session_id FROM compartments", [], |r| r.get(0))
            .unwrap();
        let rows =
            crate::historian_telemetry_reader::get_subagent_invocations(conn, &session_id).unwrap();
        assert_eq!(
            crate::historian_telemetry_reader::count_historian_runs(conn, &session_id),
            1
        );
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.id, link);
        assert_eq!(row.harness, owner);
        assert_eq!(row.subagent, "historian");
        assert_eq!(row.task.as_deref(), Some("turn_one"));
        assert_eq!(row.provider_id.as_deref(), Some("test"));
        assert_eq!(row.model_id.as_deref(), Some("summary-model"));
        assert_eq!(row.status, "completed");
        assert_eq!(
            (
                row.input_tokens,
                row.output_tokens,
                row.cache_read_tokens,
                row.cache_write_tokens
            ),
            (100, 20, 50, 5)
        );
        assert_eq!(
            (row.error.as_deref(), row.parent_invocation_id),
            (None, None)
        );
        let created: i64 = conn
            .query_row("SELECT created_at FROM historian_runs", [], |r| r.get(0))
            .unwrap();
        assert!(row.started_at > 0 && (row.started_at..=created).contains(&row.ended_at.unwrap()));
        assert!(!serde_json::to_string(row)
            .unwrap()
            .contains(PRIVATE_FIXTURE_TEXT));
    });
}

#[tokio::test]
async fn historian_telemetry_fallback_keeps_the_refusal_and_links_the_winning_request() {
    let (db, _dir, _) = telemetry_wrapup(TelemetryCase::Fallback, false).await;
    db.with_connection(|conn| {
        let rows: Vec<(String, String, i64, Option<String>, bool)> = conn.prepare(
            "SELECT model_id, s.status, input_tokens, error, s.id = h.subagent_invocation_id
             FROM subagent_invocations s JOIN historian_runs h USING(session_id, harness) ORDER BY s.id",
        ).unwrap().query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))
            .unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert_eq!(rows, [
            ("summary-model".into(), "failed".into(), 0, Some("permanent".into()), false),
            ("backup-2".into(), "completed".into(), 100, None, true),
        ]);
    });
}

#[tokio::test]
async fn historian_telemetry_records_failure_noop_and_refused_sends_without_text() {
    for (case, expected, reason, requests, not_sent) in [
        (TelemetryCase::Failed, "failed", Some("permanent"), 3, None),
        (TelemetryCase::Empty, "noop", None, 0, None),
        (
            TelemetryCase::Wait,
            "noop",
            Some("account_wait"),
            0,
            Some(1),
        ),
    ] {
        let (db, _dir, _) = telemetry_wrapup(case, false).await;
        db.with_connection(|conn| {
            let row: (String, Option<String>, i64, Option<i64>) = conn.query_row(
                "SELECT status, failure_reason, json_extract(facts_by_category_json, '$.requests'),
                 json_extract(facts_by_category_json, '$.not_sent') FROM historian_runs",
                [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
            ).unwrap();
            assert_eq!(
                (row.0.as_str(), row.1.as_deref(), row.2, row.3),
                (expected, reason, requests, not_sent)
            );
        });
    }
}

#[tokio::test]
async fn historian_telemetry_insert_failure_leaves_the_summary_stored() {
    let (db, _dir, _) = telemetry_wrapup(TelemetryCase::Stored, true).await;
    db.with_connection(|conn| {
        let count = |table| {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
        };
        assert_eq!(count("compartments"), 1);
        assert_eq!(count("historian_runs"), 0);
        assert_eq!(count("subagent_invocations"), 0);
    });
}

#[tokio::test]
async fn historian_telemetry_unknown_delivery_counts_the_send_id_once() {
    let (db, _dir, _) = telemetry_wrapup(TelemetryCase::Unconfirmed, false).await;
    db.with_connection(|conn| {
        let row: (String, String, i64, i64, Option<i64>) = conn.query_row(
            "SELECT status, failure_reason, json_extract(facts_by_category_json, '$.requests'),
             json_extract(facts_by_category_json, '$.unconfirmed'), subagent_invocation_id FROM historian_runs",
            [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
        ).unwrap();
        assert_eq!(row, ("failed".into(), "unconfirmed".into(), 0, 1, None));
    });
}
