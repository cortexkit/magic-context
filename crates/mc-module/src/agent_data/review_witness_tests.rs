//! Review-only witnesses. Tests describing a gap pin the observed unsafe
//! behavior, rather than silently changing the participant's implementation.
use super::*;
#[cfg(not(feature = "agent-data"))]
use crate::route_targets::{RegisteredRoute, RouteTargetConfig};

const BACK: &str = "abcdef0123456789abcdef0123456789";

fn context_conn(h: &McHandler) -> rusqlite::Connection {
    rusqlite::Connection::open(
        h.store.get().unwrap().context_domain_status()["path"]
            .as_str()
            .unwrap(),
    )
    .unwrap()
}

fn note(h: &McHandler) -> String {
    context_conn(h)
        .query_row(
            "SELECT content FROM notes WHERE session_id=?1 AND type='session'",
            [SESSION],
            |r| r.get(0),
        )
        .unwrap()
}

fn back_params(refs: &[Ref]) -> Value {
    json!({"refs":refs,"cutId":BACK})
}

fn module_shipped_rows(h: &McHandler) -> BTreeMap<String, Vec<Vec<String>>> {
    use mc_store::move_inventory::{Class, RowSelector, Store, TABLES};
    let conn =
        rusqlite::Connection::open(h.store.get().unwrap().move_storage_path().unwrap()).unwrap();
    let mut result = BTreeMap::new();
    for table in TABLES
        .iter()
        .filter(|t| t.store == Store::Module && t.class == Class::Ship)
    {
        let RowSelector::Predicate(predicate) = table.rows else {
            continue;
        };
        let columns = table.shipped_columns();
        let sql = format!(
            "SELECT {} FROM {} WHERE {} ORDER BY {}",
            columns.join(","),
            table.table,
            predicate,
            table.primary_key.join(",")
        );
        let rows = conn
            .prepare(&sql)
            .unwrap()
            .query_map([SESSION], |row| {
                (0..columns.len())
                    .map(|i| {
                        row.get::<_, rusqlite::types::Value>(i)
                            .map(|v| format!("{v:?}"))
                    })
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        result.insert(table.table.into(), rows);
    }
    result
}

fn seed_project_rows(h: &McHandler, label: &str) {
    let conn = context_conn(h);
    conn.execute("INSERT INTO memories(project_path,category,content,normalized_hash,first_seen_at,last_seen_at,created_at,updated_at) VALUES('git:fixture','learnings',?1,?1,1,1,1,1)", [label]).unwrap();
    conn.execute("INSERT INTO notes(id,type,status,content,session_id,project_path,harness,created_at,updated_at) VALUES(100,'smart','pending',?1,?2,'git:fixture','opencode',1,1)", rusqlite::params![label, SESSION]).unwrap();
    conn.execute("INSERT INTO git_commits(sha,project_path,short_sha,message,committed_at,indexed_at) VALUES(?1,'git:fixture',?1,?1,1,1)", [label]).unwrap();
}

fn project_rows(h: &McHandler) -> Vec<String> {
    let conn = context_conn(h);
    [
        "SELECT content FROM memories",
        "SELECT content FROM notes WHERE type='smart'",
        "SELECT message FROM git_commits",
    ]
    .into_iter()
    .map(|sql| conn.query_row(sql, [], |r| r.get(0)).unwrap())
    .collect()
}

#[cfg(not(feature = "agent-data"))]
fn manifest_before_participant(
    config: &RouteTargetConfig,
    smart_notes: bool,
) -> subc_protocol::manifest::ModuleManifest {
    use crate::prompt_surface::{PromptSurfacePreset, PromptSurfaceSelection};
    use subc_protocol::manifest::{
        Concurrency, ConsumerRole, IdentityScope, ModuleManifest, ProviderRole, TrustTier,
    };
    let mut tools = crate::prompt_surface::module_tools(&PromptSurfaceSelection::default());
    if !smart_notes {
        crate::prompt_surface::disable_smart_notes_in_tools(&mut tools, PromptSurfacePreset::Full);
    }
    // Without agent-data, model tools and provider roles still use optional
    // project lookup, model catalog, bus bootstrap and non-served Synapse retrieval. Pin routes independently
    // so a disabled participant route cannot change both manifests.
    let mut targets = vec!["thalamus".to_string()];
    for id in [
        config.runner_module_id(),
        Some(config.provider_runner_module_id()),
        Some("fusiform"),
        Some("ckbus"),
        Some("entorhinal"),
    ]
    .into_iter()
    .flatten()
    {
        if !targets.iter().any(|target| target == id) {
            targets.push(id.to_string());
        }
    }
    targets.push("synapse".into());
    ModuleManifest::builder(
        DEFAULT_MODULE_ID.to_string(),
        env!("CARGO_PKG_VERSION").to_string(),
    )
    .trust_tier(Some(TrustTier::FirstParty))
    .protocol_ver(subc_protocol::PROTOCOL_VERSION)
    .capabilities(Some(subc_protocol::manifest::CapabilityDeclarations {
        // The facades' conversation binding is a declared capability since
        // mcp-conversation-binding/v1; it changes no route or service.
        provides: vec![
            cortexkit_role_compaction_provider::PROVIDES.to_string(),
            crate::MCP_CONVERSATION_BINDING_V1.to_string(),
            // Declared with the flow fence; the agent-data feature changes nothing here.
            subc_protocol::scope::FLOW_SCOPES_CAPABILITY.to_string(),
        ],
        requires: vec![],
        must_never_reach: vec![],
    }))
    .self_signals(Some(crate::route_targets::self_signals(config)))
    .provenance(
        subc_client_rs::build_provenance(option_env!("MC_BUILD_SHA"), None, None)
            .ok()
            .map(|p| p.with_launch_nonce_source(subc_client_rs::launch_nonce_source())),
    )
    .provides(vec![
        ProviderRole::ToolProvider {
            tools,
            identity_scope: vec![IdentityScope::Project, IdentityScope::Session],
            concurrency: Concurrency::ModuleManaged,
            emits_push: false,
            sub_supervises: false,
        },
        // Added after the participant and independent of it: the read-only
        // management query basal flows call. The agent-data feature changes nothing here.
        crate::subagent_invocations_read::management_role(),
        // App-read design §3.1: this independent read service remains present with agent-data off.
        ProviderRole::InternalService {
            service_id: crate::app_read::SERVICE_ID.into(),
            transport: subc_protocol::manifest::InternalTransport::Bulk,
            agent_facing: false,
            operations: crate::app_read::APP_READ_METHODS
                .iter()
                .map(|method| method.to_string())
                .collect(),
        },
    ])
    .consumes(vec![ConsumerRole::ServiceClient { of: targets }])
    .build()
}

#[cfg(not(feature = "agent-data"))]
#[test]
fn review_feature_off_manifest_bytes_services_and_routes_match_old_builder() {
    for config in [
        RouteTargetConfig::default(),
        RouteTargetConfig::host_runner(),
        RouteTargetConfig::runner_module("alternate-runner")
            .with_provider_runner_module("other-provider"),
    ] {
        assert!(config.target(RegisteredRoute::EngramDoor).is_none());
        assert!(config
            .target(RegisteredRoute::EntorhinalSessionRef)
            .is_none());
        for smart in [false, true] {
            let before = serde_json::to_vec(&manifest_before_participant(&config, smart)).unwrap();
            let after = serde_json::to_vec(&crate::manifest_with_route_targets_and_smart_notes(
                DEFAULT_MODULE_ID,
                &config,
                smart,
            ))
            .unwrap();
            assert_eq!(after, before);
            eprintln!(
                "feature-off manifest smart_notes={smart}: {} bytes SHA256={:x}",
                after.len(),
                Sha256::digest(&after)
            );
        }
    }
}

#[cfg(not(feature = "agent-data"))]
#[tokio::test]
async fn review_feature_off_ignores_registry_failure_on_an_ordinary_bind() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("agent-data");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(root.join("bindings.json")).unwrap();
    let h = production_make(dir.path()).await;
    assert!(h.agent_data.is_none());
    let request = RouteBindRequest::new(
        RouteHandle::detached(1, 1),
        RouteTarget::ManagementSurface {
            module_id: DEFAULT_MODULE_ID.into(),
        },
        BindIdentity::new(PathBuf::from(ROOT), "opencode", SESSION),
    )
    .with_principal(Principal::Direct);
    let decision = h.on_bind(&request).await;
    assert!(format!("{decision:?}").contains("Accept"), "{decision:?}");
    assert!(h.bindings.lock().unwrap().contains_key(&1));
    assert!(root.join("bindings.json").is_dir());
}

// Make a genuine move back: A still has its released preimage, while B has
// gained a new session note since receiving the first cut.
async fn staged_move_back(a: &McHandler, b: &McHandler, door: &FakeDoor) -> Vec<Ref> {
    seed(a, SESSION);
    observe(a, SESSION).await;
    let refs = vec![reference(SESSION)];
    prepared(a, door, &refs).await;
    reply(call(b, role::ops::IMPORT, params(&refs)).await);
    reply(call(b, role::ops::ACTIVATE, params(&refs)).await);
    let mut release = params(&refs);
    release["holder"] = json!("B");
    reply(call(a, role::ops::RELEASE, release).await);
    context_conn(b)
        .execute(
            "UPDATE notes SET content='returned note' WHERE session_id=?1 AND type='session'",
            [SESSION],
        )
        .unwrap();
    let p = back_params(&refs);
    let prepared = reply(call(b, role::ops::PREPARE, p.clone()).await);
    reply(call(b, role::ops::EXPORT, p.clone()).await);
    door.seal(BACK, &prepared);
    assert_eq!(
        reply(call(a, role::ops::DIVERGED, p.clone()).await)["refs"][0]["state"],
        "at_cut"
    );
    reply(call(a, role::ops::IMPORT, p).await);
    refs
}

#[tokio::test]
async fn review_session_diagnostics_refuse_released_data() {
    let dir = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let h = make(dir.path(), door.clone()).await;
    seed(&h, SESSION);
    observe(&h, SESSION).await;
    let refs = vec![reference(SESSION)];
    prepared(&h, &door, &refs).await;
    let mut p = params(&refs);
    p["holder"] = json!("other-Mac");
    reply(call(&h, role::ops::RELEASE, p).await);
    for method in ["transform", "status", "health", "diagnostics"] {
        assert_eq!(
            refusal(
                h.dispatch_value(1, json!({"method":method,"session_id":SESSION}))
                    .await
            ),
            "session_moved",
            "{method}"
        );
    }
    for method in ["status", "health", "diagnostics"] {
        assert_eq!(
            reply(h.dispatch_value(1, json!({"method":method})).await)["ok"],
            true
        );
    }
}

#[tokio::test]
async fn review_overlapping_refs_refusal_rolls_back_the_temporary_gate() {
    let dir = tempfile::tempdir().unwrap();
    let h = make(dir.path(), Arc::new(FakeDoor::default())).await;
    seed(&h, SESSION);
    observe(&h, SESSION).await;
    bind(
        &h,
        2,
        "opencode2",
        SESSION,
        Principal::Reserved {
            module_id: RUNNER.into(),
        },
    )
    .await;
    let alias = Ref::new(REF_KINDS[0], session_ref(RUNNER, "opencode2", SESSION));
    let refs = vec![reference(SESSION), alias];
    assert_eq!(
        refusal(call(&h, role::ops::PREPARE, params(&refs)).await),
        "not_exportable"
    );
    let journal: Journal = load(
        &h.agent_data
            .as_ref()
            .expect("test coordinator")
            .root()
            .unwrap()
            .join("journal.json"),
    )
    .unwrap();
    assert!(!journal.cuts.contains_key(CUT));
    assert!(h
        .agent_data
        .as_ref()
        .expect("test coordinator")
        .enter(vec![SESSION.into()], "turn_in_flight")
        .is_ok());
    reply(call(&h, role::ops::ABORT, params(&refs)).await);
    assert!(h
        .agent_data
        .as_ref()
        .expect("test coordinator")
        .enter(vec![SESSION.into()], "turn_in_flight")
        .is_ok());
}

#[cfg(not(feature = "agent-data"))]
#[tokio::test]
async fn review_feature_off_does_not_write_bind_registry_and_preserves_stranded_gates() {
    let clean = tempfile::tempdir().unwrap();
    let h = production_make(clean.path()).await;
    assert!(h.agent_data.is_none());
    observe(&h, SESSION).await;
    assert!(!clean.path().join("agent-data").exists());
    drop(h);
    for step in [
        Step::Prepared,
        Step::Exported,
        Step::Released,
        Step::Imported,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("agent-data");
        std::fs::create_dir(&root).unwrap();
        let identity = Identity {
            runner: RUNNER.into(),
            harness: "opencode".into(),
            project_root: ROOT.into(),
            session: SESSION.into(),
            namespaces: vec![],
        };
        let mut cut = Cut {
            step,
            sessions: vec![identity],
            ..Cut::default()
        };
        if step == Step::Imported {
            cut.intent = Some(role::ops::ACTIVATE.into());
        }
        let mut journal = Journal::default();
        journal.cuts.insert(CUT.into(), cut);
        save(&root.join("journal.json"), &journal).unwrap();
        let before = std::fs::read(root.join("journal.json")).unwrap();
        let h = production_make(dir.path()).await;
        observe(&h, SESSION).await;
        assert_eq!(
            refusal(
                h.dispatch_value(1, json!({"method":"status","session_id":SESSION}))
                    .await
            ),
            if step == Step::Released {
                "session_moved"
            } else {
                "session_moving"
            }
        );
        assert!(!root.join("bindings.json").exists());
        assert_eq!(std::fs::read(root.join("journal.json")).unwrap(), before);
        h.move_visibility
            .configure_readonly(&dir.path().join("store.db"))
            .unwrap();
        assert_eq!(
            h.move_visibility.stranded_sessions.lock().unwrap().len(),
            if matches!(step, Step::Prepared | Step::Exported) {
                1
            } else {
                0
            }
        );
    }
}

#[cfg(not(feature = "agent-data"))]
#[tokio::test]
async fn review_feature_off_refuses_internal_service_without_an_intent() {
    let dir = tempfile::tempdir().unwrap();
    let h = production_make(dir.path()).await;
    assert!(h.agent_data.is_none());
    let request = RouteBindRequest::new(
        RouteHandle::detached(CHANNEL, 1),
        RouteTarget::InternalService {
            module_id: DEFAULT_MODULE_ID.into(),
            service_id: role::SERVICE_ID.into(),
        },
        BindIdentity::new(PathBuf::from(ROOT), "agent-data", "driver"),
    )
    .with_principal(Principal::Reserved {
        module_id: "entorhinal".into(),
    });
    let decision = h.on_bind(&request).await;
    assert!(format!("{decision:?}").contains("Reject"));
    assert_eq!(
        refusal(call(&h, role::ops::PREPARE, params(&[reference(SESSION)])).await),
        "unavailable"
    );
    assert!(!dir.path().join("agent-data").exists());
    assert!(!h.bindings.lock().unwrap().contains_key(&CHANNEL));
}

#[tokio::test]
async fn review_partial_activate_abort_restores_rows_and_does_not_fork() {
    let mut reached = false;
    // Stop after context.db's replacement commits but before store.db's installation.
    // A named hook keeps this crash window stable when the module table inventory grows.
    // The imported note must be present while module cache rows are still absent.
    for point in ["context replacement"] {
        let adir = tempfile::tempdir().unwrap();
        let bdir = tempfile::tempdir().unwrap();
        let door = Arc::new(FakeDoor::default());
        let a = make(adir.path(), door.clone()).await;
        let b = make(bdir.path(), door.clone()).await;
        seed_project_rows(&a, "A project data");
        seed_project_rows(&b, "B project data");
        let refs = staged_move_back(&a, &b, &door).await;
        let context = ContextMoveStore::open(Path::new(
            a.store.get().unwrap().context_domain_status()["path"]
                .as_str()
                .unwrap(),
        ))
        .unwrap();
        let mover = a.store.get().unwrap().move_store().unwrap();
        let before_context = context.fingerprint(SESSION).unwrap();
        let before_module = mover.fingerprint(SESSION).unwrap();
        let before_rows = module_shipped_rows(&a);
        a.agent_data
            .as_ref()
            .expect("test coordinator")
            .crash_after_context_replace
            .store(true, Ordering::SeqCst);
        let outcome = call(&a, role::ops::ACTIVATE, back_params(&refs)).await;
        let journal: Journal = load(
            &a.agent_data
                .as_ref()
                .expect("test coordinator")
                .root()
                .unwrap()
                .join("journal.json"),
        )
        .unwrap();
        if note(&a) != "returned note" || journal.cuts[BACK].step == Step::Activated {
            assert!(
                matches!(
                    outcome,
                    HandlerOutcome::Error { .. } | HandlerOutcome::ErrorWithDetail { .. }
                ),
                "did not reach the context/module gap at boundary {point}"
            );
            continue;
        }
        eprintln!("reached context/module gap at activation boundary {point}");
        assert_eq!(refusal(outcome), "unavailable");
        assert_eq!(
            journal.cuts[BACK].intent.as_deref(),
            Some(role::ops::ACTIVATE)
        );
        assert_eq!(note(&a), "returned note");
        assert_ne!(context.fingerprint(SESSION).unwrap(), before_context);
        assert_ne!(mover.fingerprint(SESSION).unwrap(), before_module);
        for method in ["status", "health", "diagnostics"] {
            assert_eq!(
                refusal(
                    a.dispatch_value(1, json!({"method":method,"session_id":SESSION}))
                        .await
                ),
                "session_moving"
            );
        }
        assert!(a
            .agent_data
            .as_ref()
            .expect("test coordinator")
            .enter(vec![SESSION.into()], "turn_in_flight")
            .is_err());
        drop(mover);
        drop(a);
        let a = make(adir.path(), door.clone()).await;
        reply(call(&a, role::ops::ABORT, back_params(&refs)).await);
        let restored = a.store.get().unwrap().move_store().unwrap();
        assert_eq!(
            note(&a),
            "portable note",
            "abort must restore the pre-activation session note"
        );
        assert_eq!(
            context.fingerprint(SESSION).unwrap(),
            before_context,
            "abort must restore context.db's shipped preimage"
        );
        for (table, rows) in module_shipped_rows(&a) {
            if table == "mc_tag_cache_generations" {
                // Restore deliberately changes cache freshness, even though the
                // snapshot fingerprint includes that table as shipped data.
                assert!(before_rows[&table].is_empty());
                assert_eq!(rows.len(), 1);
                continue;
            }
            assert_eq!(
                rows, before_rows[&table],
                "abort must restore shipped session rows in {table}"
            );
        }
        assert_ne!(restored.fingerprint(SESSION).unwrap(), before_module);
        assert_eq!(
            reply(call(&a, role::ops::DIVERGED, back_params(&refs)).await)["refs"][0]["state"],
            "at_cut",
            "restored installation bookkeeping must not create a fork"
        );
        assert_eq!(project_rows(&a), vec!["A project data"; 3]);
        assert_eq!(project_rows(&b), vec!["B project data"; 3]);
        assert_eq!(
            refusal(
                a.dispatch_value(1, json!({"method":"transform","session_id":SESSION}))
                    .await
            ),
            "session_moved"
        );
        eprintln!("undo restore exercised context/module gap at activation boundary {point}; old released holder preserved");
        reached = true;
        break;
    }
    assert!(
        reached,
        "no interrupted activation with distinct context and module data was reached"
    );
}

#[tokio::test]
async fn review_move_back_replaces_released_copy_and_serves_again() {
    let adir = tempfile::tempdir().unwrap();
    let bdir = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let a = make(adir.path(), door.clone()).await;
    let b = make(bdir.path(), door.clone()).await;
    seed_project_rows(&a, "A project data");
    seed_project_rows(&b, "B project data");
    let refs = staged_move_back(&a, &b, &door).await;
    assert_eq!(
        note(&a),
        "portable note",
        "import stages without replacing the released copy"
    );
    reply(call(&a, role::ops::ACTIVATE, back_params(&refs)).await);
    assert_eq!(note(&a), "returned note");
    assert!(a
        .agent_data
        .as_ref()
        .expect("test coordinator")
        .enter(vec![SESSION.into()], "turn_in_flight")
        .is_ok());
    assert_eq!(
        reply(call(&a, role::ops::STATUS, back_params(&refs)).await)["step"],
        "activated"
    );
    assert_eq!(project_rows(&a), vec!["A project data"; 3]);
    assert_eq!(project_rows(&b), vec!["B project data"; 3]);
}

#[tokio::test]
async fn review_concurrent_imports_do_not_overwrite_a_newly_activated_copy() {
    let sdir = tempfile::tempdir().unwrap();
    let tdir = tempfile::tempdir().unwrap();
    let ddir = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let s = make(sdir.path(), door.clone()).await;
    let t = make(tdir.path(), door.clone()).await;
    let d = make(ddir.path(), door.clone()).await;
    for h in [&s, &t] {
        seed(h, SESSION);
        observe(h, SESSION).await;
    }
    context_conn(&t)
        .execute(
            "UPDATE notes SET content='different cut' WHERE session_id=?1",
            [SESSION],
        )
        .unwrap();
    let refs = vec![reference(SESSION)];
    prepared(&s, &door, &refs).await;
    let prepared = reply(call(&t, role::ops::PREPARE, back_params(&refs)).await);
    reply(call(&t, role::ops::EXPORT, back_params(&refs)).await);
    door.seal(BACK, &prepared);
    let (first, second) = tokio::join!(
        call(&d, role::ops::IMPORT, params(&refs)),
        call(&d, role::ops::IMPORT, back_params(&refs))
    );
    reply(first);
    reply(second);
    assert!(!context_conn(&d)
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes WHERE session_id=?1)",
            [SESSION],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
    reply(call(&d, role::ops::ACTIVATE, params(&refs)).await);
    assert_eq!(
        refusal(call(&d, role::ops::ACTIVATE, back_params(&refs)).await),
        "local_advanced"
    );
    reply(call(&d, role::ops::ABORT, back_params(&refs)).await);
    assert_eq!(note(&d), "portable note");
    assert!(d
        .agent_data
        .as_ref()
        .expect("test coordinator")
        .enter(vec![SESSION.into()], "turn_in_flight")
        .is_ok());
}

#[tokio::test]
async fn review_staging_corruption_is_refused_without_replacing_rows() {
    let sdir = tempfile::tempdir().unwrap();
    let ddir = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let s = make(sdir.path(), door.clone()).await;
    let d = make(ddir.path(), door.clone()).await;
    seed(&s, SESSION);
    observe(&s, SESSION).await;
    let refs = vec![reference(SESSION)];
    prepared(&s, &door, &refs).await;
    reply(call(&d, role::ops::IMPORT, params(&refs)).await);
    let root = d.agent_data.as_ref().unwrap().root().unwrap();
    let path = directory(&root, CUT, &refs[0].r#ref).join("context-0.bin");
    let before_module = module_shipped_rows(&d);
    let before_notes = context_conn(&d)
        .query_row(
            "SELECT COUNT(*) FROM notes WHERE session_id=?1",
            [SESSION],
            |r| r.get::<_, i64>(0),
        )
        .unwrap();
    let before_journal = std::fs::read(root.join("journal.json")).unwrap();
    let original = std::fs::read(&path).unwrap();
    let mut bytes = original.clone();
    let old = b"portable note";
    let offset = bytes.windows(old.len()).position(|w| w == old).unwrap();
    bytes[offset..offset + old.len()].copy_from_slice(b"CORRUPT! note");
    std::fs::write(&path, &bytes).unwrap();
    let refused = call(&d, role::ops::ACTIVATE, params(&refs)).await;
    assert_eq!(refusal(refused.clone()), "digest_mismatch");
    match refused {
        HandlerOutcome::ErrorWithDetail { detail, .. } => {
            assert_eq!(detail["reason"], "staging_digest_mismatch")
        }
        _ => panic!("corruption must be named"),
    }
    assert_eq!(module_shipped_rows(&d), before_module);
    assert_eq!(
        context_conn(&d)
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE session_id=?1",
                [SESSION],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        before_notes
    );
    assert_eq!(
        std::fs::read(root.join("journal.json")).unwrap(),
        before_journal
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert!(!directory(&root, CUT, &refs[0].r#ref).join("undo").exists());
    std::fs::write(path, original).unwrap();
    reply(call(&d, role::ops::ACTIVATE, params(&refs)).await);
    assert_eq!(note(&d), "portable note");
}

#[cfg(not(feature = "agent-data"))]
fn row_counts(h: &McHandler, context: bool) -> BTreeMap<String, i64> {
    let conn = if context {
        context_conn(h)
    } else {
        rusqlite::Connection::open(h.store.get().unwrap().move_storage_path().unwrap()).unwrap()
    };
    let tables = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap().query_map([], |r| r.get::<_, String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    tables
        .into_iter()
        .map(|table| {
            let count = conn
                .query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |r| {
                    r.get(0)
                })
                .unwrap();
            (table, count)
        })
        .collect()
}

#[cfg(not(feature = "agent-data"))]
#[tokio::test]
async fn review_feature_off_normal_dispatch_preserves_business_write_footprints() {
    let old_dir = tempfile::tempdir().unwrap();
    let new_dir = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let mut old = make(old_dir.path(), door.clone()).await;
    let mut new = make(new_dir.path(), door.clone()).await;
    for h in [&mut old, &mut new] {
        h.fixed_config.as_mut().unwrap().memory_enabled = true;
        observe(h, SESSION).await;
    }
    let mut fixture = FixtureBuilder::frozen_reductions();
    fixture.session_id = SESSION.into();
    let request = fixture.call_transform();
    let bytes = serde_json::to_vec(&request).unwrap().len();
    // Direct transform, historian-claim and facade calls are a reference for
    // the dispatcher: they bypass AgentDataService's pass admission but execute
    // the same persistence handlers. This compares the wrapper's SQL footprint,
    // not a separately compiled older binary.
    let direct = reply(
        old.handle_transform_dispatch(1, request.clone(), Some(bytes))
            .await,
    );
    let dispatched = reply(new.dispatch_value(1, request).await);
    assert_eq!(dispatched["ck_messages"], direct["ck_messages"]);
    assert!(dispatched["ck_messages"].is_array());
    for context in [false, true] {
        assert_eq!(row_counts(&old, context), row_counts(&new, context));
    }
    let mut before_historian = BTreeMap::new();
    for h in [&old, &new] {
        let store = h.store.get().unwrap();
        let loaded = store.load(SESSION).unwrap();
        let mut meta = loaded.meta;
        meta.historian = mc_store::HistorianDurableState {
            state: mc_store::HistorianPhase::Firing,
            firing_seq: 1,
            chunk_range: Some(mc_store::HistorianChunkRange {
                from_ordinal: 1,
                to_ordinal: 3,
            }),
            chunk_fingerprint: "review-fingerprint".into(),
            fired_at_ms: Some(crate::now_ms()),
            ..mc_store::HistorianDurableState::default()
        };
        store
            .commit(SESSION, loaded.row_version, &loaded.core, &meta)
            .unwrap();
        let binding = h.facade_binding(1).unwrap();
        let project = h.historian_lane_project(1, &binding, store).unwrap();
        store
            .publish_pending_historian_run(&mc_store::NewHistorianPendingRun {
                run_id: "review-run".into(),
                session_id: SESSION.into(),
                project_path: project,
                firing_seq: 1,
                chunk_fingerprint: "review-fingerprint".into(),
                system_prompt: "review-system".into(),
                user_prompt: "review-user".into(),
                model_chain: vec!["test/first".into()],
                await_budget_ms: 30_000,
                historian_timeout_ms: None,
                now_ms: crate::now_ms(),
            })
            .unwrap();
        before_historian = row_counts(h, false);
    }
    let claim = json!({"method":"historian.claim","v":1,"run_id":"review-run","claimant_instance_id":"review-host"});
    let direct = reply(old.handle_historian_claim_value(1, &claim));
    let dispatched = reply(new.dispatch_value(1, claim).await);
    assert_eq!(direct["ok"], true, "{direct}");
    assert_eq!(dispatched["ok"], true, "{dispatched}");
    assert!(direct["token"]
        .as_str()
        .is_some_and(|token| !token.is_empty()));
    assert!(dispatched["token"]
        .as_str()
        .is_some_and(|token| !token.is_empty()));
    assert_eq!(row_counts(&old, false), row_counts(&new, false));
    assert_eq!(
        old.store
            .get()
            .unwrap()
            .load(SESSION)
            .unwrap()
            .meta
            .historian
            .state,
        new.store
            .get()
            .unwrap()
            .load(SESSION)
            .unwrap()
            .meta
            .historian
            .state
    );
    assert!(!before_historian.is_empty());
    let tool = json!({"name":"ctx_memory","arguments":{"action":"write","category":"PROJECT_RULES","content":"A deterministic review fact.","command_id":"review-write"}});
    let before = row_counts(&old, true);
    let direct = reply(old.handle_facade_value(1, tool.clone()).await);
    let dispatched = reply(new.dispatch_value(1, tool).await);
    assert_eq!(dispatched, direct);
    assert_eq!(row_counts(&old, true), row_counts(&new, true));
    assert_ne!(
        row_counts(&old, true),
        before,
        "the tool probe must really write context.db"
    );
    assert_eq!(row_counts(&old, false), row_counts(&new, false));
    eprintln!("direct unchanged business handlers vs feature-off dispatch: identical transform ck_messages and SQL row footprints after transform, historian claim and ctx_memory write");
}

#[cfg(not(feature = "agent-data"))]
async fn production_make(dir: &Path) -> McHandler {
    let store = Arc::new(
        McHandler::open_store_once(&descriptor(dir), false)
            .await
            .unwrap(),
    );
    let mut h = McHandler::new();
    h.fixed_config = Some(McModuleConfig {
        inject_docs: false,
        temporal_awareness: false,
        memory_enabled: false,
        execute_threshold_percentage: 100.0,
        ..McModuleConfig::default()
    });
    h.store.set(store).ok().unwrap();
    h.move_visibility
        .configure_readonly(&dir.join("store.db"))
        .unwrap();
    h
}

#[tokio::test]
async fn review_abort_restore_rebaselines_but_a_real_turn_still_advances() {
    let sdir = tempfile::tempdir().unwrap();
    let ddir = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let s = make(sdir.path(), door.clone()).await;
    let d = make(ddir.path(), door.clone()).await;
    seed(&s, SESSION);
    seed(&d, SESSION);
    observe(&s, SESSION).await;
    observe(&d, SESSION).await;
    let refs = vec![reference(SESSION)];
    let local = json!({"refs":refs,"cutId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"});
    reply(call(&d, role::ops::PREPARE, local.clone()).await);
    reply(call(&d, role::ops::ABORT, local).await);
    context_conn(&s)
        .execute(
            "UPDATE notes SET content='incoming note' WHERE session_id=?1",
            [SESSION],
        )
        .unwrap();
    prepared(&s, &door, &refs).await;
    assert_eq!(
        reply(call(&d, role::ops::DIVERGED, params(&refs)).await)["refs"][0]["state"],
        "at_cut"
    );
    reply(call(&d, role::ops::IMPORT, params(&refs)).await);
    *d.agent_data.as_ref().unwrap().crash_after.lock().unwrap() = Some(1);
    assert_eq!(
        refusal(call(&d, role::ops::ACTIVATE, params(&refs)).await),
        "unavailable"
    );
    reply(call(&d, role::ops::ABORT, params(&refs)).await);
    assert_eq!(note(&d), "portable note");
    assert_eq!(
        reply(call(&d, role::ops::DIVERGED, params(&refs)).await)["refs"][0]["state"],
        "at_cut"
    );
    let mut turn = FixtureBuilder::frozen_reductions();
    turn.session_id = SESSION.into();
    assert!(reply(d.dispatch_value(1, turn.call_transform()).await)["ck_messages"].is_array());
    assert_eq!(
        reply(call(&d, role::ops::DIVERGED, params(&refs)).await)["refs"][0]["state"],
        "advanced"
    );
}
#[tokio::test]
async fn review_undo_corruption_refuses_activation_and_abort_without_new_writes() {
    let sdir = tempfile::tempdir().unwrap();
    let ddir = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let s = make(sdir.path(), door.clone()).await;
    let d = make(ddir.path(), door.clone()).await;
    seed(&s, SESSION);
    observe(&s, SESSION).await;
    let refs = vec![reference(SESSION)];
    prepared(&s, &door, &refs).await;
    reply(call(&d, role::ops::IMPORT, params(&refs)).await);
    *d.agent_data.as_ref().unwrap().crash_after.lock().unwrap() = Some(1);
    assert_eq!(
        refusal(call(&d, role::ops::ACTIVATE, params(&refs)).await),
        "unavailable"
    );
    let root = d.agent_data.as_ref().unwrap().root().unwrap();
    let path = directory(&root, CUT, &refs[0].r#ref).join("undo/context-0.bin");
    let original = std::fs::read(&path).unwrap();
    let mut corrupt = original.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    std::fs::write(&path, &corrupt).unwrap();
    let before = std::fs::read(root.join("journal.json")).unwrap();
    let rows = module_shipped_rows(&d);
    for op in [role::ops::ACTIVATE, role::ops::ABORT] {
        let error = call(&d, op, params(&refs)).await;
        assert_eq!(refusal(error.clone()), "digest_mismatch");
        match error {
            HandlerOutcome::ErrorWithDetail { detail, .. } => {
                assert_eq!(detail["reason"], "undo_digest_mismatch")
            }
            _ => panic!("undo corruption must be named"),
        }
        assert_eq!(module_shipped_rows(&d), rows);
        assert_eq!(std::fs::read(root.join("journal.json")).unwrap(), before);
        assert_eq!(std::fs::read(&path).unwrap(), corrupt);
    }
    std::fs::write(path, original).unwrap();
    reply(call(&d, role::ops::ABORT, params(&refs)).await);
}
#[tokio::test]
async fn review_effective_registration_id_controls_bind_and_item_stream() {
    let dir = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let mut h = make(dir.path(), door).await;
    h.registered_module_id = "override-magic-context".into();
    h.agent_data.as_mut().unwrap().module_id = h.registered_module_id.clone();
    let request = RouteBindRequest::new(
        RouteHandle::detached(CHANNEL, 2),
        RouteTarget::InternalService {
            module_id: h.registered_module_id.clone(),
            service_id: role::SERVICE_ID.into(),
        },
        BindIdentity::new(PathBuf::from(ROOT), "agent-data", "driver"),
    )
    .with_principal(Principal::Reserved {
        module_id: "entorhinal".into(),
    });
    assert!(format!("{:?}", h.on_bind(&request).await).contains("Accept"));
    seed(&h, SESSION);
    observe(&h, SESSION).await;
    let prepare = reply(call(&h, role::ops::PREPARE, params(&[reference(SESSION)])).await);
    assert_eq!(
        prepare["items"][0]["stream"],
        "reserved:override-magic-context"
    );
}
