use super::*;
use crate::DEFAULT_MODULE_ID;
use crate::{config::McModuleConfig, test_support::descriptor};
use door::{DoorError, LookupSession, Position, ReadReply};
use sha2::{Digest, Sha256};
use subc_client_rs::{async_trait, ModuleHandler, RouteBindRequest, RouteHandle};
use subc_protocol::{BindIdentity, RouteTarget};
#[path = "vectors.rs"]
mod vectors;

#[path = "review_witness_tests.rs"]
mod review_witnesses;

const CUT: &str = "0123456789abcdef0123456789abcdef";
const ROOT: &str = "/portable/project";
const SESSION: &str = "native-old";
/// The attested runner the observed sessions are bound through.
const RUNNER: &str = "broca";
/// The route an observed session's runner binds it on.
const RUNNER_CHANNEL: u16 = 41;
const CHANNEL: u16 = 44;

#[cfg(windows)]
#[test]
fn journal_save_round_trips_and_replaces_existing_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("journal.json");
    save(&path, &vec!["first"]).unwrap();
    assert_eq!(load::<Vec<String>>(&path).unwrap(), ["first"]);
    save(&path, &vec!["replacement"]).unwrap();
    assert_eq!(load::<Vec<String>>(&path).unwrap(), ["replacement"]);
}

#[derive(Default)]
struct FakeState {
    streams: BTreeMap<String, Vec<u8>>,
    cuts: BTreeMap<(String, String), (u64, Option<String>)>,
    lookup: Option<LookupSession>,
    unreachable: bool,
    lose_admit: bool,
}
#[derive(Default)]
struct FakeDoor {
    state: Mutex<FakeState>,
}
impl FakeDoor {
    fn seal(&self, cut: &str, prepare: &Value) {
        let mut state = self.state.lock().unwrap();
        for item in prepare["items"].as_array().unwrap() {
            let r = item["sessionRef"].as_str().unwrap();
            let end = item["endOffset"].as_u64().unwrap();
            let bytes = state.streams.get(r).unwrap();
            assert_eq!(bytes.len() as u64, end);
            let digest = format!("{:x}", Sha256::digest(bytes));
            assert_eq!(item["digest"], digest);
            state
                .cuts
                .insert((cut.into(), r.into()), (end, Some(digest)));
        }
    }
    fn cap() -> usize {
        mc_store::move_snapshot::MAX_RECORD_LENGTH - 17 - stream(DEFAULT_MODULE_ID).len()
    }
}
#[async_trait]
impl EngramDoor for FakeDoor {
    async fn cover(&self, r: &str) -> Result<Position, DoorError> {
        let state = self.state.lock().unwrap();
        let offset = state.streams.get(r).map_or(0, |b| b.len() as u64);
        Ok(Position {
            durable_offset: offset,
            cloud_offset: offset,
        })
    }
    async fn admit(&self, r: &str, offset: u64, bytes: &[u8]) -> Result<Position, DoorError> {
        let mut state = self.state.lock().unwrap();
        if bytes.len() > Self::cap() {
            return Err(DoorError {
                code: "record_too_large".into(),
                detail: None,
            });
        }
        let stream = state.streams.entry(r.into()).or_default();
        if offset != stream.len() as u64 {
            return Err(DoorError {
                code: "offset_mismatch".into(),
                detail: Some(json!({"expectedOffset":stream.len()})),
            });
        }
        stream.extend_from_slice(bytes);
        let end = stream.len() as u64;
        if state.lose_admit {
            state.lose_admit = false;
            return Err(DoorError::unavailable());
        }
        Ok(Position {
            durable_offset: end,
            cloud_offset: end,
        })
    }
    async fn read(
        &self,
        r: &str,
        offset: u64,
        limit: usize,
        cut: Option<&str>,
    ) -> Result<ReadReply, DoorError> {
        let state = self.state.lock().unwrap();
        if limit > Self::cap() {
            return Err(DoorError {
                code: "record_too_large".into(),
                detail: None,
            });
        }
        let bytes = state.streams.get(r).ok_or_else(|| DoorError {
            code: "cut_item_missing".into(),
            detail: None,
        })?;
        let (end, digest) = if let Some(cut) = cut {
            state
                .cuts
                .get(&(cut.into(), r.into()))
                .cloned()
                .ok_or_else(|| DoorError {
                    code: "cut_not_ready".into(),
                    detail: None,
                })?
        } else {
            (bytes.len() as u64, None)
        };
        if offset > end {
            return Err(DoorError {
                code: "offset_out_of_range".into(),
                detail: None,
            });
        }
        let to = end.min(offset + limit as u64);
        Ok(ReadReply {
            bytes: door::hex(&bytes[offset as usize..to as usize]),
            from_offset: offset,
            end_offset: to,
            stream_end: end,
            digest,
        })
    }
}
#[async_trait]
impl SessionLookup for FakeDoor {
    async fn session_for_ref(
        &self,
        _kind: &str,
        _reference: &str,
    ) -> Result<Option<LookupSession>, DoorError> {
        let state = self.state.lock().unwrap();
        if state.unreachable {
            Err(DoorError::unavailable())
        } else {
            Ok(state.lookup.clone())
        }
    }
}
fn reference(session: &str) -> Ref {
    Ref::new(REF_KINDS[0], session_ref(RUNNER, "opencode", session))
}
fn params(refs: &[Ref]) -> Value {
    json!({"refs":refs,"cutId":CUT})
}
fn reply(outcome: HandlerOutcome) -> Value {
    match outcome {
        HandlerOutcome::Response(bytes) => serde_json::from_slice(&bytes).unwrap(),
        error => panic!("expected reply, got {error:?}"),
    }
}
fn refusal(outcome: HandlerOutcome) -> String {
    match outcome {
        HandlerOutcome::Error { code, .. } | HandlerOutcome::ErrorWithDetail { code, .. } => code,
        reply => panic!("expected refusal, got {reply:?}"),
    }
}
async fn call(h: &McHandler, method: &str, params: Value) -> HandlerOutcome {
    h.dispatch_value(CHANNEL, json!({"method":method,"params":params}))
        .await
}
async fn bind(h: &McHandler, channel: u16, harness: &str, session: &str, principal: Principal) {
    let target = if channel == CHANNEL {
        RouteTarget::InternalService {
            module_id: DEFAULT_MODULE_ID.into(),
            service_id: role::SERVICE_ID.into(),
        }
    } else {
        RouteTarget::ManagementSurface {
            module_id: DEFAULT_MODULE_ID.into(),
        }
    };
    let request = RouteBindRequest::new(
        RouteHandle::detached(channel, 1),
        target,
        BindIdentity::new(PathBuf::from(ROOT), harness, session),
    )
    .with_principal(principal);
    let decision = h.on_bind(&request).await;
    assert!(format!("{decision:?}").contains("Accept"), "{decision:?}");
}
async fn make(dir: &Path, door: Arc<FakeDoor>) -> McHandler {
    let store = Arc::new(
        McHandler::open_store_once(&descriptor(dir), false)
            .await
            .unwrap(),
    );
    let mut handler = McHandler::new();
    handler.agent_data = Some(AgentDataService::with_io_and_visibility(
        door.clone(),
        door,
        DEFAULT_MODULE_ID.into(),
        Arc::clone(&handler.move_visibility),
    ));
    let config = McModuleConfig {
        inject_docs: false,
        temporal_awareness: false,
        memory_enabled: false,
        execute_threshold_percentage: 100.0,
        ..McModuleConfig::default()
    };
    handler.fixed_config = Some(config);
    handler.store.set(store).ok().unwrap();
    handler
        .agent_data
        .as_ref()
        .expect("test coordinator")
        .configure(&dir.join("store.db"))
        .unwrap();
    bind(
        &handler,
        CHANNEL,
        "agent-data",
        "move-driver",
        Principal::Reserved {
            module_id: "entorhinal".into(),
        },
    )
    .await;
    handler
}
/// Bind `session` on the harness route (channel 1) and through its attested
/// runner (channel `RUNNER_CHANNEL`). Only the runner's route names the
/// session's reference, so only that bind makes the ref one this module holds.
async fn observe(h: &McHandler, session: &str) {
    bind(h, 1, "opencode", session, Principal::Direct).await;
    bind(
        h,
        RUNNER_CHANNEL,
        "opencode",
        session,
        Principal::Reserved {
            module_id: RUNNER.into(),
        },
    )
    .await;
}
fn seed(h: &McHandler, session: &str) {
    h.store
        .get()
        .unwrap()
        .commit(
            session,
            None,
            &mc_core::CoreState::default(),
            &mc_store::ModuleMeta::default(),
        )
        .unwrap();
    let path = h.store.get().unwrap().context_domain_status()["path"]
        .as_str()
        .unwrap()
        .to_owned();
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute("INSERT INTO notes(type,status,content,session_id,project_path,harness,created_at,updated_at) VALUES('session','pending','portable note',?1,'git:fixture','opencode',1,1)",[session]).unwrap();
}
async fn prepared(source: &McHandler, door: &FakeDoor, refs: &[Ref]) -> Value {
    let prepare = reply(call(source, role::ops::PREPARE, params(refs)).await);
    let exported = reply(call(source, role::ops::EXPORT, params(refs)).await);
    assert_eq!(exported["items"].as_array().unwrap().len(), refs.len());
    door.seal(CUT, &prepare);
    prepare
}
#[tokio::test]
async fn caller_admission_is_attested_and_precedes_decoding() {
    let dir = tempfile::tempdir().unwrap();
    let h = make(dir.path(), Arc::new(FakeDoor::default())).await;
    for principal in [
        None,
        Some(Principal::Direct),
        Some(Principal::Reserved {
            module_id: "broca".into(),
        }),
    ] {
        h.bindings
            .lock()
            .unwrap()
            .get_mut(&CHANNEL)
            .unwrap()
            .principal = principal;
        assert_eq!(
            refusal(call(&h, role::ops::DESCRIBE, json!({})).await),
            "caller_forbidden"
        );
        assert_eq!(
            refusal(
                call(
                    &h,
                    role::ops::DESCRIBE,
                    json!({"spoof":"reserved:entorhinal"})
                )
                .await
            ),
            "caller_forbidden"
        );
        assert_eq!(
            refusal(call(&h, role::ops::DESCRIBE, json!({})).await),
            "caller_forbidden"
        );
    }
}
#[tokio::test]
async fn unknown_ref_requires_an_observed_tuple_or_registry_lookup() {
    let dir = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let h = make(dir.path(), door.clone()).await;
    seed(&h, SESSION);
    let p = json!({"refs":[reference(SESSION)]});
    assert_eq!(
        refusal(call(&h, role::ops::BUSY, p.clone()).await),
        "unknown_ref"
    );
    door.state.lock().unwrap().unreachable = true;
    assert_eq!(
        refusal(call(&h, role::ops::BUSY, p.clone()).await),
        "unknown_ref"
    );
    door.state.lock().unwrap().unreachable = false;
    door.state.lock().unwrap().lookup = Some(LookupSession {
        agent_id: "agent".into(),
        ref_kind: REF_KINDS[0].into(),
        reference: reference(SESSION).r#ref,
        harness: "opencode".into(),
        session_id: SESSION.into(),
        project_root: ROOT.into(),
        runner: Some(RUNNER.into()),
    });
    assert_eq!(
        reply(call(&h, role::ops::BUSY, p.clone()).await)["refs"][0]["state"],
        "idle"
    );
    door.state.lock().unwrap().lookup = Some(LookupSession {
        agent_id: "agent".into(),
        ref_kind: REF_KINDS[0].into(),
        reference: reference("not-held").r#ref,
        harness: "opencode".into(),
        session_id: "not-held".into(),
        project_root: ROOT.into(),
        runner: Some(RUNNER.into()),
    });
    assert_eq!(
        refusal(call(&h, role::ops::BUSY, json!({"refs":[reference("not-held")]})).await),
        "unknown_ref"
    );
    // Another spelling of the folder is metadata: the same runner, harness
    // and session still name the held session.
    door.state.lock().unwrap().lookup = Some(LookupSession {
        agent_id: "agent".into(),
        ref_kind: REF_KINDS[0].into(),
        reference: reference(SESSION).r#ref,
        harness: "opencode".into(),
        session_id: SESSION.into(),
        project_root: format!("{ROOT}/"),
        runner: Some(RUNNER.into()),
    });
    assert_eq!(
        reply(call(&h, role::ops::BUSY, p.clone()).await)["refs"][0]["state"],
        "idle"
    );
    // Another runner's session is not this ref, and an answer that names no
    // runner cannot be checked, so both stay refused.
    for runner in [Some("other-runner".to_string()), None] {
        door.state.lock().unwrap().lookup = Some(LookupSession {
            agent_id: "agent".into(),
            ref_kind: REF_KINDS[0].into(),
            reference: reference(SESSION).r#ref,
            harness: "opencode".into(),
            session_id: SESSION.into(),
            project_root: ROOT.into(),
            runner,
        });
        assert_eq!(
            refusal(call(&h, role::ops::BUSY, p.clone()).await),
            "unknown_ref"
        );
    }
    door.state.lock().unwrap().lookup = None;
    observe(&h, SESSION).await;
    assert_eq!(
        reply(call(&h, role::ops::BUSY, p).await)["refs"][0]["state"],
        "idle"
    );
}
#[tokio::test]
async fn activate_requires_exact_staged_set_and_replays_reordering() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let s = make(src.path(), door.clone()).await;
    let d = make(dst.path(), door.clone()).await;
    for id in [SESSION, "second"] {
        seed(&s, id);
        observe(&s, id).await;
    }
    let refs = vec![reference(SESSION), reference("second")];
    prepared(&s, &door, &refs).await;
    reply(call(&d, role::ops::DIVERGED, params(&refs)).await);
    reply(call(&d, role::ops::IMPORT, params(&refs)).await);
    assert_eq!(
        refusal(call(&d, role::ops::ACTIVATE, params(&refs[..1])).await),
        "invalid_state"
    );
    assert_eq!(
        refusal(
            call(
                &d,
                role::ops::ACTIVATE,
                params(&[refs[0].clone(), refs[0].clone()])
            )
            .await
        ),
        "invalid_request"
    );
    reply(call(&d, role::ops::ACTIVATE, params(&refs)).await);
    let mut reversed = refs.clone();
    reversed.reverse();
    assert_eq!(
        reply(call(&d, role::ops::ACTIVATE, params(&reversed)).await),
        json!({})
    );
    assert_eq!(
        refusal(call(&d, role::ops::ABORT, params(&refs)).await),
        "invalid_state"
    );
}

#[tokio::test]
async fn busy_covers_transform_historian_and_dreamer_and_import_races() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let s = make(src.path(), door.clone()).await;
    let d = make(dst.path(), door.clone()).await;
    seed(&s, SESSION);
    observe(&s, SESSION).await;
    let refs = vec![reference(SESSION)];
    for reason in ["turn_in_flight", "historian_running", "dreamer_running"] {
        let pass = s
            .agent_data
            .as_ref()
            .expect("test coordinator")
            .enter(vec![SESSION.into()], reason)
            .unwrap();
        let busy = reply(call(&s, role::ops::BUSY, json!({"refs":refs})).await);
        assert_eq!(busy["refs"][0]["state"], "busy");
        assert_eq!(busy["refs"][0]["reason_code"], reason);
        assert_eq!(
            refusal(call(&s, role::ops::PREPARE, params(&refs)).await),
            "busy"
        );
        drop(pass);
    }
    prepared(&s, &door, &refs).await;
    reply(call(&d, role::ops::DIVERGED, params(&refs)).await);
    let pass = d
        .agent_data
        .as_ref()
        .expect("test coordinator")
        .enter(vec![SESSION.into()], "dreamer_running")
        .unwrap();
    assert_eq!(
        refusal(call(&d, role::ops::IMPORT, params(&refs)).await),
        "busy"
    );
    drop(pass);
    reply(call(&d, role::ops::IMPORT, params(&refs)).await);
    let pass = d
        .agent_data
        .as_ref()
        .expect("test coordinator")
        .enter(vec![SESSION.into()], "turn_in_flight")
        .unwrap();
    assert_eq!(
        refusal(call(&d, role::ops::ACTIVATE, params(&refs)).await),
        "busy"
    );
    drop(pass);
    seed(&d, SESSION);
    assert_eq!(
        refusal(call(&d, role::ops::ACTIVATE, params(&refs)).await),
        "local_advanced"
    );
    assert_eq!(
        reply(call(&d, role::ops::STATUS, params(&refs)).await)["step"],
        "imported"
    );
    reply(call(&d, role::ops::ABORT, params(&refs)).await);
    assert!(d
        .store
        .get()
        .unwrap()
        .load(SESSION)
        .unwrap()
        .row_version
        .is_some());
}
#[tokio::test]
async fn abort_after_import_leaves_both_live_halves_untouched() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let s = make(src.path(), door.clone()).await;
    let d = make(dst.path(), door.clone()).await;
    seed(&s, SESSION);
    observe(&s, SESSION).await;
    let refs = vec![reference(SESSION)];
    prepared(&s, &door, &refs).await;
    let path = d.store.get().unwrap().context_domain_status()["path"]
        .as_str()
        .unwrap()
        .to_owned();
    let ctx = ContextMoveStore::open(Path::new(&path)).unwrap();
    let before_ctx = ctx.fingerprint(SESSION).unwrap();
    let before_module = d
        .store
        .get()
        .unwrap()
        .move_store()
        .unwrap()
        .fingerprint(SESSION)
        .unwrap();
    reply(call(&d, role::ops::DIVERGED, params(&refs)).await);
    reply(call(&d, role::ops::IMPORT, params(&refs)).await);
    assert_eq!(ctx.fingerprint(SESSION).unwrap(), before_ctx);
    assert_eq!(
        d.store
            .get()
            .unwrap()
            .move_store()
            .unwrap()
            .fingerprint(SESSION)
            .unwrap(),
        before_module
    );
    reply(call(&d, role::ops::ABORT, params(&refs)).await);
    assert_eq!(ctx.fingerprint(SESSION).unwrap(), before_ctx);
    assert_eq!(
        d.store
            .get()
            .unwrap()
            .move_store()
            .unwrap()
            .fingerprint(SESSION)
            .unwrap(),
        before_module
    );
    assert_eq!(
        reply(call(&d, role::ops::STATUS, params(&refs)).await)["step"],
        "aborted"
    );
    reply(call(&s, role::ops::ABORT, params(&refs)).await);
    assert!(s
        .agent_data
        .as_ref()
        .expect("test coordinator")
        .enter(vec![SESSION.into()], "turn_in_flight")
        .is_ok());
    assert!(s
        .store
        .get()
        .unwrap()
        .session_move_phase(SESSION)
        .unwrap()
        .is_none());
}
#[tokio::test]
async fn incompatible_version_and_cut_not_ready_precede_all_staging_writes() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let s = make(src.path(), door.clone()).await;
    let d = make(dst.path(), door.clone()).await;
    seed(&s, SESSION);
    observe(&s, SESSION).await;
    let refs = vec![reference(SESSION)];
    let p = reply(call(&s, role::ops::PREPARE, params(&refs)).await);
    reply(call(&s, role::ops::EXPORT, params(&refs)).await);
    assert_eq!(
        refusal(call(&d, role::ops::DIVERGED, params(&refs)).await),
        "cut_not_ready"
    );
    door.seal(CUT, &p);
    let destination_path = d.store.get().unwrap().context_domain_status()["path"]
        .as_str()
        .unwrap()
        .to_owned();
    let conn = rusqlite::Connection::open(destination_path).unwrap();
    conn.execute("DELETE FROM schema_migrations WHERE version>=100", [])
        .unwrap();
    conn.execute_batch("DROP TABLE lkg_served_markers").unwrap();
    for op in [role::ops::DIVERGED, role::ops::IMPORT] {
        assert_eq!(
            refusal(call(&d, op, params(&refs)).await),
            "incompatible_version"
        );
    }
    {
        let mut state = door.state.lock().unwrap();
        let bytes = state.streams.get_mut(&refs[0].r#ref).unwrap();
        let n = u32::from_le_bytes(bytes[5..9].try_into().unwrap()) as usize;
        let mut header: Header = serde_json::from_slice(&bytes[9..9 + n]).unwrap();
        header.store_version += 1;
        let metadata = serde_json::to_vec(&header).unwrap();
        let mut next = snapshot::MAGIC.to_vec();
        next.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
        next.extend_from_slice(&metadata);
        next.extend_from_slice(&bytes[9 + n..]);
        *bytes = next;
        let end = bytes.len() as u64;
        let digest = format!("{:x}", Sha256::digest(&*bytes));
        state
            .cuts
            .insert((CUT.into(), refs[0].r#ref.clone()), (end, Some(digest)));
    }
    for op in [role::ops::DIVERGED, role::ops::IMPORT] {
        assert_eq!(
            refusal(call(&d, op, params(&refs)).await),
            "incompatible_version"
        );
    }
    let root = d
        .agent_data
        .as_ref()
        .expect("test coordinator")
        .root()
        .unwrap();
    assert!(!root.join(CUT).exists());
    assert_eq!(
        reply(call(&d, role::ops::STATUS, params(&refs)).await)["step"],
        "none"
    );
}
#[tokio::test]
async fn local_advanced_before_import_keeps_local_data_and_records_no_reply() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let s = make(src.path(), door.clone()).await;
    let d = make(dst.path(), door.clone()).await;
    seed(&s, SESSION);
    observe(&s, SESSION).await;
    let refs = vec![reference(SESSION)];
    prepared(&s, &door, &refs).await;
    reply(call(&d, role::ops::DIVERGED, params(&refs)).await);
    seed(&d, SESSION);
    assert_eq!(
        refusal(call(&d, role::ops::IMPORT, params(&refs)).await),
        "local_advanced"
    );
    assert_eq!(
        reply(call(&d, role::ops::STATUS, params(&refs)).await)["step"],
        "none"
    );
    assert!(d
        .store
        .get()
        .unwrap()
        .load(SESSION)
        .unwrap()
        .row_version
        .is_some());
}
#[tokio::test]
async fn daemon_target_and_manifest_stream_cannot_drift() {
    let dir = tempfile::tempdir().unwrap();
    let h = make(dir.path(), Arc::new(FakeDoor::default())).await;
    assert_eq!(
        stream(DEFAULT_MODULE_ID),
        format!("reserved:{DEFAULT_MODULE_ID}")
    );
    let request = RouteBindRequest::new(
        RouteHandle::detached(88, 1),
        RouteTarget::InternalService {
            module_id: "other-module".into(),
            service_id: role::SERVICE_ID.into(),
        },
        BindIdentity::new(PathBuf::from(ROOT), "agent-data", "move"),
    )
    .with_principal(Principal::Reserved {
        module_id: "entorhinal".into(),
    });
    let decision = h.on_bind(&request).await;
    assert!(format!("{decision:?}").contains("agent_data_target_mismatch"));
    assert!(!h
        .agent_data
        .as_ref()
        .expect("test coordinator")
        .channels
        .lock()
        .unwrap()
        .contains(&88));
    let manifest = crate::manifest(DEFAULT_MODULE_ID);
    let value = serde_json::to_value(manifest).unwrap();
    assert_eq!(
        value["capabilities"]["provides"]
            .as_array()
            .unwrap()
            .contains(&json!(role::PROVIDES)),
        ENABLED
    );
    let service = value["provides"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["service_id"] == role::SERVICE_ID);
    assert_eq!(service.is_some(), ENABLED);
    if let Some(service) = service {
        assert_eq!(service["operations"], json!(role::REQUIRED_OPS));
        assert_eq!(service["agent_facing"], false);
    }
}
#[tokio::test]
async fn lost_admit_reply_uses_durable_offset_without_appending_twice() {
    let dir = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let s = make(dir.path(), door.clone()).await;
    seed(&s, SESSION);
    observe(&s, SESSION).await;
    let refs = vec![reference(SESSION)];
    let p = reply(call(&s, role::ops::PREPARE, params(&refs)).await);
    door.state.lock().unwrap().lose_admit = true;
    assert_eq!(
        refusal(call(&s, role::ops::EXPORT, params(&refs)).await),
        "unavailable"
    );
    reply(call(&s, role::ops::EXPORT, params(&refs)).await);
    door.seal(CUT, &p);
    let error = door.admit(&refs[0].r#ref, 0, b"wrong").await.unwrap_err();
    assert_eq!(error.code, "offset_mismatch");
    assert_eq!(
        error.detail.unwrap()["expectedOffset"],
        p["items"][0]["endOffset"]
    );
    assert_eq!(
        door.read(&refs[0].r#ref, 0, FakeDoor::cap() + 1, None)
            .await
            .unwrap_err()
            .code,
        "record_too_large"
    );
}

#[tokio::test]
async fn every_durable_write_boundary_recovers_after_restart_and_retry() {
    for op in [
        role::ops::PREPARE,
        role::ops::EXPORT,
        role::ops::IMPORT,
        role::ops::ACTIVATE,
        role::ops::ABORT,
        role::ops::RELEASE,
    ] {
        let mut reached = 0;
        for point in 0..256 {
            let src = tempfile::tempdir().unwrap();
            let dst = tempfile::tempdir().unwrap();
            let door = Arc::new(FakeDoor::default());
            let mut s = make(src.path(), door.clone()).await;
            let mut d = make(dst.path(), door.clone()).await;
            seed(&s, SESSION);
            observe(&s, SESSION).await;
            let refs = vec![reference(SESSION)];
            let mut p = params(&refs);
            if op != role::ops::PREPARE {
                let prepared = reply(call(&s, role::ops::PREPARE, p.clone()).await);
                if op != role::ops::EXPORT {
                    reply(call(&s, role::ops::EXPORT, p.clone()).await);
                    door.seal(CUT, &prepared);
                }
            }
            let receiver = matches!(
                op,
                role::ops::IMPORT | role::ops::ACTIVATE | role::ops::ABORT
            );
            if receiver {
                reply(call(&d, role::ops::DIVERGED, p.clone()).await);
                if op != role::ops::IMPORT {
                    reply(call(&d, role::ops::IMPORT, p.clone()).await);
                }
            }
            if op == role::ops::RELEASE {
                reply(call(&d, role::ops::DIVERGED, p.clone()).await);
                reply(call(&d, role::ops::IMPORT, p.clone()).await);
                reply(call(&d, role::ops::ACTIVATE, p.clone()).await);
                p["holder"] = json!("receiver");
            }
            let h = if receiver { &d } else { &s };
            *h.agent_data
                .as_ref()
                .expect("test coordinator")
                .crash_after
                .lock()
                .unwrap() = Some(point);
            let result = call(h, op, p.clone()).await;
            if matches!(result, HandlerOutcome::Response(_)) {
                assert!(reached > 0, "{op} had no injected write boundary");
                break;
            }
            assert_eq!(refusal(result), "unavailable", "{op} boundary {point}");
            reached += 1;
            if receiver {
                drop(d);
                d = make(dst.path(), door.clone()).await;
            } else {
                drop(s);
                s = make(src.path(), door.clone()).await;
            }
            let h = if receiver { &d } else { &s };
            let _status = reply(call(h, role::ops::STATUS, params(&refs)).await);
            let durable: Journal = load(
                &h.agent_data
                    .as_ref()
                    .expect("test coordinator")
                    .root()
                    .unwrap()
                    .join("journal.json"),
            )
            .unwrap();
            if durable.cuts[CUT].intent.is_some() {
                assert!(
                    h.agent_data
                        .as_ref()
                        .expect("test coordinator")
                        .enter(vec![SESSION.into()], "turn_in_flight")
                        .is_err(),
                    "{op} boundary {point}: partial write was served"
                );
            }
            reply(call(h, op, p.clone()).await);
            assert_eq!(
                reply(call(h, op, p).await),
                reply(
                    call(
                        h,
                        op,
                        if op == role::ops::RELEASE {
                            let mut p = params(&refs);
                            p["holder"] = json!("receiver");
                            p
                        } else {
                            params(&refs)
                        }
                    )
                    .await
                )
            );
            let expected = match op {
                role::ops::PREPARE => "prepared",
                role::ops::EXPORT => "exported",
                role::ops::IMPORT => "imported",
                role::ops::ACTIVATE => "activated",
                role::ops::ABORT => "aborted",
                role::ops::RELEASE => "released",
                _ => unreachable!(),
            };
            assert_eq!(
                reply(call(h, role::ops::STATUS, params(&refs)).await)["step"],
                expected,
                "{op} boundary {point}"
            );
            assert!(
                point < 255,
                "write-boundary enumeration did not terminate for {op}"
            );
        }
        eprintln!("{op}: recovered {reached} durable write boundaries");
    }
}
#[tokio::test]
async fn project_memories_remain_machine_owned_and_snapshot_files_have_platform_permissions() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let s = make(src.path(), door.clone()).await;
    let d = make(dst.path(), door.clone()).await;
    seed(&s, SESSION);
    observe(&s, SESSION).await;
    let conn = |h: &McHandler| {
        rusqlite::Connection::open(
            h.store.get().unwrap().context_domain_status()["path"]
                .as_str()
                .unwrap(),
        )
        .unwrap()
    };
    for (h, text) in [
        (&s, "SOURCE PROJECT MEMORY"),
        (&d, "DESTINATION PROJECT MEMORY"),
    ] {
        conn(h).execute("INSERT INTO memories(project_path,category,content,normalized_hash,first_seen_at,last_seen_at,created_at,updated_at) VALUES('git:fixture','learnings',?1,'fixture-hash',1,1,1,1)",[text]).unwrap();
    }
    let refs = vec![reference(SESSION)];
    prepared(&s, &door, &refs).await;
    reply(call(&d, role::ops::DIVERGED, params(&refs)).await);
    reply(call(&d, role::ops::IMPORT, params(&refs)).await);
    reply(call(&d, role::ops::ACTIVATE, params(&refs)).await);
    let content: String = conn(&d)
        .query_row(
            "SELECT content FROM memories WHERE project_path='git:fixture'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(content, "DESTINATION PROJECT MEMORY");
    let note: String = conn(&d)
        .query_row(
            "SELECT content FROM notes WHERE session_id=?1",
            [SESSION],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(note, "portable note");
    fn assert_platform_permissions(path: &Path) {
        let meta = std::fs::metadata(path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(meta.permissions().mode() & 0o077, 0, "{}", path.display());
        }
        #[cfg(windows)]
        if meta.is_file() {
            // Writability is independent of the inherited Windows ACL's privacy.
            assert!(!meta.permissions().readonly(), "{}", path.display());
            drop(std::fs::OpenOptions::new().write(true).open(path).unwrap());
        }
        if meta.is_dir() {
            for entry in std::fs::read_dir(path).unwrap() {
                assert_platform_permissions(&entry.unwrap().path());
            }
        }
    }
    assert_platform_permissions(
        &s.agent_data
            .as_ref()
            .expect("test coordinator")
            .root()
            .unwrap(),
    );
    assert_platform_permissions(
        &d.agent_data
            .as_ref()
            .expect("test coordinator")
            .root()
            .unwrap(),
    );
}

#[tokio::test]
async fn durable_provider_launch_intent_is_busy_without_a_live_handler() {
    let dir = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let h = make(dir.path(), door).await;
    seed(&h, SESSION);
    // A provider row names no runner, so the ref is held through the runner's
    // observed bind; the row still supplies the durable launch intent.
    observe(&h, SESSION).await;
    let store = h.store.get().unwrap();
    let conn = rusqlite::Connection::open(store.move_storage_path().unwrap()).unwrap();
    let key = serde_json::to_string(&(ROOT, SESSION, "opencode")).unwrap();
    conn.execute("INSERT INTO mc_provider_conversations_v2(conv_key,project_root,session,harness,engine_namespace,hook_counters_json) VALUES(?1,?2,?3,'opencode',?3,?4)",rusqlite::params![key,ROOT,SESSION,r#"{"historian_launch_pending":{"generation":3}}"#]).unwrap();
    let refs = vec![reference(SESSION)];
    let busy = reply(call(&h, role::ops::BUSY, json!({"refs":refs})).await);
    assert_eq!(busy["refs"][0]["reason_code"], "historian_running");
    assert_eq!(
        refusal(call(&h, role::ops::PREPARE, params(&refs)).await),
        "busy"
    );
    conn.execute(
        "UPDATE mc_provider_conversations_v2 SET hook_counters_json='{}' WHERE conv_key=?1",
        [key],
    )
    .unwrap();
    assert_eq!(
        reply(call(&h, role::ops::BUSY, json!({"refs":refs})).await)["refs"][0]["state"],
        "idle"
    );
}
#[tokio::test]
async fn missing_sealed_digest_is_recorded_and_a_wrong_seal_is_refused() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let door = Arc::new(FakeDoor::default());
    let s = make(src.path(), door.clone()).await;
    let d = make(dst.path(), door.clone()).await;
    seed(&s, SESSION);
    observe(&s, SESSION).await;
    let refs = vec![reference(SESSION)];
    prepared(&s, &door, &refs).await;
    door.state
        .lock()
        .unwrap()
        .cuts
        .get_mut(&(CUT.into(), refs[0].r#ref.clone()))
        .unwrap()
        .1 = Some("0".repeat(64));
    assert_eq!(
        refusal(call(&d, role::ops::IMPORT, params(&refs)).await),
        "digest_mismatch"
    );
    assert!(!d
        .agent_data
        .as_ref()
        .expect("test coordinator")
        .root()
        .unwrap()
        .join(CUT)
        .exists());
    door.state
        .lock()
        .unwrap()
        .cuts
        .get_mut(&(CUT.into(), refs[0].r#ref.clone()))
        .unwrap()
        .1 = None;
    reply(call(&d, role::ops::DIVERGED, params(&refs)).await);
    reply(call(&d, role::ops::IMPORT, params(&refs)).await);
    let journal: Journal = load(
        &d.agent_data
            .as_ref()
            .expect("test coordinator")
            .root()
            .unwrap()
            .join("journal.json"),
    )
    .unwrap();
    assert!(journal.cuts[CUT].seal_unverified_logged);
}
