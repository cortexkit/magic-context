//! The published kit runs against real bound Handler dispatch, in-process.
//! With kit 0.15.13, every preset runs these 23 cases:
//! user_commands_catalog; role_describe_{shape,cacheable};
//! catalog_{schemas_flat,schemas_portable,reply_valid,modes_valid,
//! emits_events_boolean,schema_digest_stable,digest_only,
//! unknown_preset_refused,listed_presets_served,notice_templates};
//! system_text_{digests_match_text,preflight_digest_stable,facts_legacy_omitted};
//! terminal_frame_on_{success,refusal}; call_key_{malformed_refused,
//! well_formed_accepted}; schema_pin_{current_accepted,malformed_refused};
//! fork_calls_honour_marker.
//!
//! The 45 skipped cases are: every reply_custody_* (12); user_commands_{
//! reply,repeat,codemode_refused,flow_refused,accepted_late};
//! call_mode_matches_catalog; catalog_{capability_filter_matches_describe,
//! filter_preserves_plan_item,model_malformed_refused,filter_model_refused,
//! disabled_tool_absent}; system_text_preset_optional_served;
//! system_text_facts_{accepted,malformed_refused}, because this provider
//! does not declare system-text-facts/v1; its text uses module-owned facts;
//! call_disabled_tool_refused_by_name; tool_result_{v1_valid,
//! legacy_route_unchanged,held_reply_route_gating}; terminal_frame_on_cancel;
//! every withdraw_* (9), late_results_* (3), and crash_* (2).
//! The 11 inapplicable cases are session_notices_describe,
//! system_text_default_served, every stop_session_* (5), and call_yield_* (4).
//! These capabilities are not declared or lack a fixture in this adapter;
//! no skipped case is counted as a pass. Each test prints the full case list.
//! Transport and crash conformance are
//! not covered here; the wire suite and daemon tests cover transport.

use super::*;
use cortexkit_role_tool_provider_conformance::harness::{
    Harness, HarnessError, KillPoint, KillReport, PointDeclaration, RouteStamp, Trigger,
};
use cortexkit_role_tool_provider_conformance::{
    run_suite, CallSpec, Capability, CaseOutcome, Exchange, ObservedFrame, RouteFailure,
    ScopedPrincipals, SuiteVerdict, ToolProviderSubject, ToolRoute, CASES,
};
use std::{
    collections::BTreeSet,
    path::Path,
    sync::atomic::{AtomicU16, Ordering},
};

struct Subject {
    preset: &'static str,
    compacting: bool,
}

struct Instance {
    handler: Arc<Handler>,
    next_channel: AtomicU16,
    /// The instance's `context.db`, read on a connection of its own for the
    /// fork probe's observable state.
    db: std::path::PathBuf,
}

struct TestRoute {
    handler: Arc<Handler>,
    channel: u16,
}

#[async_trait]
impl Harness for Subject {
    type Handle = Instance;
    type Route = TestRoute;

    fn declared_points(&self) -> Vec<PointDeclaration> {
        Vec::new()
    }

    async fn spawn(&self, state_root: &Path) -> Result<Instance, HarnessError> {
        std::fs::create_dir_all(state_root).map_err(|e| HarnessError::new(e.to_string()))?;
        let path = state_root.join("context.db");
        let db =
            crate::context_db::ContextDb::create_for_tests(&path).map_err(HarnessError::new)?;
        let client = SubcRunnerClient::new(
            state_root.join("unused-connection-file"),
            Arc::new(ChildScopes::new("ck-mc-test")),
        );
        Ok(Instance {
            handler: Arc::new(Handler::new(Module::new(
                client,
                crate::pass::Settings::default(),
                Some(db),
                None,
            ))),
            next_channel: AtomicU16::new(1),
            db: path,
        })
    }

    async fn route(
        &self,
        instance: &Instance,
        stamp: &RouteStamp,
    ) -> Result<TestRoute, HarnessError> {
        let channel = instance.next_channel.fetch_add(1, Ordering::Relaxed);
        let mut bind = RouteBindRequest::new(
            subc_client_rs::RouteHandle::detached(channel, 1),
            RouteTarget::ToolProvider {
                module_id: crate::MODULE_ID.into(),
            },
            BindIdentity::new("test", "conformance-session"),
        );
        bind.principal = Some(Principal::Reserved {
            module_id: stamp.principal.strip_prefix("reserved:").unwrap().into(),
        });
        bind.role_versions = Some(std::collections::BTreeMap::from([(
            TOOL_ROLE.0.into(),
            TOOL_ROLE.1.into(),
        )]));
        instance.handler.on_bind(&bind).await;
        if !instance
            .handler
            .bound
            .lock()
            .unwrap()
            .contains_key(&channel)
        {
            return Err(HarnessError::new("real handler refused tool route"));
        }
        Ok(TestRoute {
            handler: instance.handler.clone(),
            channel,
        })
    }

    async fn kill_at(
        &self,
        _: Instance,
        _: &KillPoint,
        _: Trigger<'_>,
    ) -> Result<KillReport, HarnessError> {
        Err(HarnessError::new(
            "in-process catalog adapter has no kill points",
        ))
    }

    async fn restart(&self, _: &Path) -> Result<Instance, HarnessError> {
        Err(HarnessError::new(
            "in-process catalog adapter has no restart",
        ))
    }
}

#[async_trait]
impl ToolRoute for TestRoute {
    async fn request(&self, body: Value) -> Result<Exchange, RouteFailure> {
        let bytes = serde_json::to_vec(&body).unwrap();
        let frame = match self.handler.dispatch(self.channel, &bytes).await {
            Ok(bytes) => ObservedFrame::Response(
                serde_json::from_slice(&bytes).map_err(|e| RouteFailure::new(e.to_string()))?,
            ),
            Err(error) => {
                let mut body = subc_protocol::ErrorBody::new(error.code, error.message);
                body.detail = error.detail;
                ObservedFrame::Error(body)
            }
        };
        Ok(Exchange {
            frames: vec![frame],
        })
    }

    async fn request_then_cancel(&self, _: Value) -> Result<Exchange, RouteFailure> {
        Err(RouteFailure::new(
            "in-process catalog adapter cannot cancel transport requests",
        ))
    }
}

#[async_trait]
impl ToolProviderSubject for Subject {
    fn capabilities(&self) -> BTreeSet<Capability> {
        BTreeSet::from([
            Capability::CallKey,
            Capability::SchemaPin,
            Capability::SystemText,
        ])
    }
    fn plain_stamp(&self) -> RouteStamp {
        RouteStamp {
            principal: "reserved:conformance-runner".into(),
            scope: None,
        }
    }
    fn scoped_principals(&self) -> Option<ScopedPrincipals> {
        None
    }
    fn catalog_arguments(&self) -> Value {
        json!({"preset": self.preset, "params": {"compacting": self.compacting}})
    }
    fn system_text_catalog_arguments(&self) -> Option<Value> {
        Some(
            json!({"preset": self.preset, "params": {"compacting": self.compacting},
            "system_text": {"preset": self.preset, "params": {"compacting": self.compacting}}}),
        )
    }
    fn quick_call(&self) -> CallSpec {
        if self.preset == "worker" || self.preset == "reader" {
            (
                "ctx_search".into(),
                json!({"query": "conformance", "sources": ["note"]}),
            )
        } else {
            ("ctx_note".into(), json!({"action": "read"}))
        }
    }
    fn slow_call(&self) -> Option<CallSpec> {
        None
    }
    /// One probe for each tool the catalog marks read-only. The bound route
    /// names a session with no Setup, so `ctx_expand` answers its tools-only
    /// refusal; the session-level tests cover a compacted session.
    fn fork_calls(&self) -> Vec<CallSpec> {
        vec![
            ("ctx_search".into(), json!({"query": "conformance"})),
            ("ctx_expand".into(), json!({"tag": 1})),
        ]
    }
    /// Every row of every table in the instance's `context.db`: the apps,
    /// the head and every other session read that store, so all of it is
    /// observable. ck-mc never asks the person for approval, so there is no
    /// approval activity to add.
    async fn fork_observable_state(&self, instance: &Instance) -> Result<Value, HarnessError> {
        let error = |e: rusqlite::Error| HarnessError::new(e.to_string());
        let conn = rusqlite::Connection::open_with_flags(
            &instance.db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(error)?;
        let tables: Vec<String> = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                  ORDER BY name",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()
            })
            .map_err(error)?;
        let mut state = serde_json::Map::new();
        for table in tables {
            let rows: Vec<Value> = conn
                .prepare(&format!("SELECT * FROM \"{table}\""))
                .and_then(|mut statement| {
                    let columns = statement.column_count();
                    statement
                        .query_map([], |row| {
                            (0..columns)
                                .map(|at| {
                                    row.get::<_, rusqlite::types::Value>(at)
                                        .map(|value| json!(format!("{value:?}")))
                                })
                                .collect::<rusqlite::Result<Value>>()
                        })?
                        .collect::<rusqlite::Result<_>>()
                })
                .map_err(error)?;
            state.insert(table, Value::Array(rows));
        }
        Ok(Value::Object(state))
    }
    fn disabled_tool(&self) -> Option<String> {
        None
    }
    fn held_call(&self, _: &Path) -> Option<CallSpec> {
        None
    }
    async fn await_held(&self, _: &str) -> Result<(), HarnessError> {
        Err(HarnessError::new("no held calls"))
    }
    async fn approve(&self, _: &str) -> Result<(), HarnessError> {
        Err(HarnessError::new("no held calls"))
    }
    async fn settle(&self) {}
}

async fn check(preset: &'static str, compacting: bool) {
    let dir = tempfile::tempdir().unwrap();
    let subject = Subject { preset, compacting };
    let report = run_suite(&subject, dir.path()).await.unwrap();
    println!("{preset} compacting={compacting}:\n{}", report.render());
    assert!(
        matches!(
            report.verdict,
            SuiteVerdict::ConformingForDeclaredCapabilities { .. } | SuiteVerdict::Passed
        ),
        "{}",
        report.render()
    );
    let passed = [
        "user_commands_catalog",
        "role_describe_shape",
        "role_describe_cacheable",
        "catalog_schemas_flat",
        "catalog_schemas_portable",
        "catalog_reply_valid",
        "catalog_modes_valid",
        "catalog_emits_events_boolean",
        "catalog_schema_digest_stable",
        "catalog_digest_only",
        "catalog_unknown_preset_refused",
        "catalog_listed_presets_served",
        "system_text_digests_match_text",
        "system_text_preflight_digest_stable",
        // Callers omit facts for a provider without system-text-facts/v1;
        // the kit omits them and verifies the real handler's legacy catalog.
        "system_text_facts_legacy_omitted",
        // ck-mc declares no session-notices/v1 and refuses the
        // `notice_templates` member, as the contract asks of a non-declarer.
        "catalog_notice_templates",
        "terminal_frame_on_success",
        "terminal_frame_on_refusal",
        "call_key_malformed_refused",
        "call_key_well_formed_accepted",
        "schema_pin_current_accepted",
        "schema_pin_malformed_refused",
        // Every preset's catalog marks ctx_search read-only, and the head's
        // and the subagents' also mark ctx_expand.
        "fork_calls_honour_marker",
    ];
    for case in CASES {
        let outcome = report.outcome(case.name);
        if passed.contains(&case.name) {
            assert_eq!(
                outcome,
                Some(&CaseOutcome::Passed),
                "{}: {}",
                case.name,
                report.render()
            );
        } else if case.name == "session_notices_describe"
            || case.name == "system_text_default_served"
            || case.name.starts_with("stop_session_")
            || case.name.starts_with("call_yield_")
        {
            assert!(
                matches!(outcome, Some(CaseOutcome::Inapplicable { .. })),
                "{}: {outcome:?}",
                case.name
            );
        } else {
            assert!(
                matches!(outcome, Some(CaseOutcome::Skipped { .. })),
                "{}: {outcome:?}",
                case.name
            );
        }
    }
    assert!(report.kills.is_empty());
}

#[tokio::test]
async fn head() {
    check("head", true).await;
}
#[tokio::test]
async fn worker() {
    check("worker", true).await;
}
#[tokio::test]
async fn reader() {
    check("reader", true).await;
}
#[tokio::test]
async fn tools_only() {
    check("tools-only", false).await;
    // A frozen composition fixes its tool names, so the kit's preset-changing
    // probes use preflight above. Verify the real non-compacting composition
    // returns exactly the same catalog tools, through the same bound handler.
    let dir = tempfile::tempdir().unwrap();
    let subject = Subject {
        preset: "tools-only",
        compacting: false,
    };
    let instance = subject.spawn(dir.path()).await.unwrap();
    let route = subject
        .route(&instance, &subject.plain_stamp())
        .await
        .unwrap();
    let args = subject.catalog_arguments();
    let preflight = route
        .request(json!({"name":"tool.catalog", "arguments":args}))
        .await
        .unwrap();
    let ObservedFrame::Response(preflight) = &preflight.frames[0] else {
        panic!("catalog refused")
    };
    let mut args = subject.catalog_arguments();
    args["composition"] =
        json!({"providers":[{"provider":crate::MODULE_ID,"tools":preflight["tools"]}]});
    let composed = route
        .request(json!({"name":"tool.catalog", "arguments":args}))
        .await
        .unwrap();
    let ObservedFrame::Response(composed) = &composed.frames[0] else {
        panic!("catalog refused")
    };
    assert_eq!(composed["tools"], preflight["tools"]);
}

#[tokio::test]
async fn oversized_refusal_body_is_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let subject = Subject {
        preset: "head",
        compacting: true,
    };
    let instance = subject.spawn(dir.path()).await.unwrap();
    let route = subject
        .route(&instance, &subject.plain_stamp())
        .await
        .unwrap();
    let exchange = route
        .request(json!({"name": format!("unknown_{}", "界".repeat(70_000)), "arguments":{}}))
        .await
        .unwrap();
    let ObservedFrame::Error(error) = &exchange.frames[0] else {
        panic!("expected refusal")
    };
    assert_eq!(error.code, "unknown_tool");
    assert!(error.message.contains("bytes omitted here"));
    assert!(error.message.len() <= cortexkit_role_tool_provider::result::MAX_MODEL_VISIBLE_BYTES);
}

#[tokio::test]
async fn one_bind_identity_is_shared_across_roles_and_isolated_by_principal() {
    let dir = tempfile::tempdir().unwrap();
    let subject = Subject {
        preset: "head",
        compacting: true,
    };
    let instance = subject.spawn(dir.path()).await.unwrap();
    for (i, role) in [COMPACTION_ROLE, TOOL_ROLE, HOOK_ROLE]
        .into_iter()
        .enumerate()
    {
        for (j, runner) in ["runner-a", "runner-b"].into_iter().enumerate() {
            let channel = (i * 2 + j + 1) as u16;
            let mut bind = RouteBindRequest::new(
                subc_client_rs::RouteHandle::detached(channel, 1),
                RouteTarget::ToolProvider {
                    module_id: crate::MODULE_ID.into(),
                },
                BindIdentity::new("same-harness", "same-session"),
            );
            bind.principal = Some(Principal::Reserved {
                module_id: runner.into(),
            });
            bind.role_versions = Some(std::collections::BTreeMap::from([(
                role.0.into(),
                role.1.into(),
            )]));
            instance.handler.on_bind(&bind).await;
            assert_eq!(
                instance.handler.bound.lock().unwrap()[&channel]
                    .route
                    .session,
                SessionRef::new(runner, "same-harness", "same-session")
            );
        }
    }
}
