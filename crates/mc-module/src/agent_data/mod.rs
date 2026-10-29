//! agent-data/v1 participant and its two-store coordinator. A private, synced
//! all-ref journal is the visibility gate: no caller observes one installed half
//! while the other half (or another ref in the move) is still being recovered.
pub mod door;
mod snapshot;
mod visibility;
pub(crate) use visibility::MoveVisibility;
#[cfg(test)]
#[path = "adapter_tests.rs"]
mod tests;

use crate::{McHandler, SessionBinding};
use cortexkit_role_agent_data as role;
use door::{EngramDoor, SessionLookup, SubcMoveIo};
use mc_store::{
    move_context::ContextMoveStore,
    move_store::{CutBinding, MoveStore},
    private_permissions, McStore,
};
use role::{
    errors::{
        BusyDetail, BusyRef, Detail, ErrorBody, InvalidStateDetail, RefusalCode, UnknownRefDetail,
    },
    idempotency::{self, Repeat},
    refs::{Ref, Refs},
    request::Request,
    step::{self, Step, StepRefusal},
    Op,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use snapshot::{error, storage, Half, Header, Identity, Incoming};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use subc_client_rs::HandlerOutcome;
use subc_protocol::Principal;

pub const REF_KINDS: [&str; 3] = ["opencode-session", "pi-session", "claude-code-session"];
pub const ENABLED: bool = cfg!(feature = "agent-data");
pub fn stream(module_id: &str) -> String {
    format!("reserved:{module_id}")
}
fn kind(harness: &str) -> Option<&'static str> {
    match harness {
        "opencode" | "opencode2" => Some(REF_KINDS[0]),
        "pi" | "omp" => Some(REF_KINDS[1]),
        "claude-code" => Some(REF_KINDS[2]),
        _ => None,
    }
}
/// A session this module saw bound. `runner` is the bare module id of the
/// daemon-attested runner principal and, with `harness` and `session`, names
/// the session's reference; `project_root` is route metadata only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct BindTuple {
    runner: String,
    harness: String,
    project_root: String,
    session: String,
}
impl BindTuple {
    fn reference(&self) -> String {
        session_ref(&self.runner, &self.harness, &self.session)
    }
}
/// The shared session reference (llm-runner §14.1) for a bare runner module
/// id, harness and session, each used exactly as given.
fn session_ref(runner: &str, harness: &str, session: &str) -> String {
    cortexkit_role_llm_runner::session_ref(&cortexkit_role_llm_runner::SessionIdentity {
        runner,
        harness,
        session,
    })
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Receipt {
    params: Value,
    reply: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Snapshot {
    header: Header,
    start: u64,
    end: u64,
    digest: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Cut {
    #[serde(default)]
    seal_unverified_logged: bool,
    step: Step,
    refs: Option<Refs>,
    sessions: Vec<Identity>,
    receipts: BTreeMap<String, Receipt>,
    intent: Option<String>,
    snapshots: Vec<Snapshot>,
    observations: BTreeMap<String, Vec<String>>,
    installed: BTreeSet<String>,
    undo: Vec<Header>,
    holder: Option<String>,
}
impl Default for Cut {
    fn default() -> Self {
        Self {
            seal_unverified_logged: false,
            step: Step::None,
            refs: None,
            sessions: vec![],
            receipts: BTreeMap::new(),
            intent: None,
            snapshots: vec![],
            observations: BTreeMap::new(),
            installed: BTreeSet::new(),
            undo: vec![],
            holder: None,
        }
    }
}
#[derive(Default, Serialize, Deserialize)]
struct Journal {
    cuts: BTreeMap<String, Cut>,
    baselines: BTreeMap<String, Vec<String>>,
    current: BTreeMap<String, String>,
}
#[derive(Default)]
struct Activity {
    active: BTreeMap<String, BTreeMap<String, usize>>,
    gates: BTreeMap<String, (String, Option<String>)>,
}
pub(crate) struct PassGuard {
    activity: Arc<Mutex<Activity>>,
    sessions: Vec<String>,
    reason: String,
}
impl Drop for PassGuard {
    fn drop(&mut self) {
        let mut a = self.activity.lock().expect("move activity");
        for s in &self.sessions {
            if let Some(reasons) = a.active.get_mut(s) {
                if let Some(n) = reasons.get_mut(&self.reason) {
                    *n -= 1;
                }
                reasons.retain(|_, n| *n > 0);
            }
        }
        a.active.retain(|_, r| !r.is_empty());
    }
}
pub(crate) struct AgentDataService {
    visibility: Arc<MoveVisibility>,
    module_id: String,
    tuples: Mutex<Vec<BindTuple>>,
    pub(crate) channels: Mutex<BTreeSet<u16>>,
    serial: tokio::sync::Mutex<()>,
    door: Arc<dyn EngramDoor>,
    lookup: Arc<dyn SessionLookup>,
    lookup_warned: AtomicBool,
    corruption_warned: Mutex<BTreeSet<String>>,
    #[cfg(test)]
    crash_after: Mutex<Option<usize>>,
    #[cfg(test)]
    crash_after_context_replace: AtomicBool,
}
impl AgentDataService {
    pub(crate) fn new(
        connection_file: Option<PathBuf>,
        module_id: String,
        visibility: Arc<MoveVisibility>,
    ) -> Self {
        let io = Arc::new(SubcMoveIo::new(connection_file, module_id.clone()));
        Self::with_io_and_visibility(io.clone(), io, module_id, visibility)
    }
    fn with_io_and_visibility(
        door: Arc<dyn EngramDoor>,
        lookup: Arc<dyn SessionLookup>,
        module_id: String,
        visibility: Arc<MoveVisibility>,
    ) -> Self {
        Self {
            visibility,
            module_id,
            tuples: Mutex::new(vec![]),
            channels: Mutex::new(BTreeSet::new()),
            serial: tokio::sync::Mutex::new(()),
            door,
            lookup,
            lookup_warned: AtomicBool::new(false),
            corruption_warned: Mutex::new(BTreeSet::new()),
            #[cfg(test)]
            crash_after: Mutex::new(None),
            #[cfg(test)]
            crash_after_context_replace: AtomicBool::new(false),
        }
    }
    fn root(&self) -> Result<PathBuf, ErrorBody> {
        self.root
            .lock()
            .expect("move root")
            .clone()
            .ok_or_else(|| storage("move storage is not ready"))
    }
    pub(crate) fn configure(&self, path: &Path) -> Result<(), ErrorBody> {
        let root = path
            .parent()
            .ok_or_else(|| storage("store has no parent"))?
            .join("agent-data");
        let mut configured = self.root.lock().expect("move root");
        if configured.as_ref() == Some(&root) {
            return Ok(());
        }
        private_permissions::ensure_directory(&root, true).map_err(storage)?;
        if private_permissions::tighten_tree(&root, true).failures > 0 {
            return Err(storage("cannot make move storage private"));
        }
        let persisted: Vec<BindTuple> = load(&root.join("bindings.json"))?;
        let mut tuples = self.tuples.lock().expect("move tuples");
        for tuple in persisted {
            if !tuples.contains(&tuple) {
                tuples.push(tuple);
            }
        }
        save(&root.join("bindings.json"), &*tuples)?;
        let journal: Journal = load(&root.join("journal.json"))?;
        self.refresh_gates(&journal);
        *configured = Some(root);
        Ok(())
    }
    pub(crate) fn observe(&self, binding: &SessionBinding) -> Result<(), ErrorBody> {
        if kind(&binding.harness).is_none() || binding.session.is_empty() {
            return Ok(());
        }
        // A session's reference needs the runner the daemon attested on its
        // route; a route without one names no reference this module can serve.
        let Some(runner) = crate::providers::records::attested_runner(binding) else {
            return Ok(());
        };
        let tuple = BindTuple {
            runner: runner.into(),
            harness: binding.harness.clone(),
            project_root: binding.project_root.to_string_lossy().into_owned(),
            session: binding.session.clone(),
        };
        let root = self.root.lock().expect("move root").clone();
        let mut tuples = self.tuples.lock().expect("move tuples");
        if !tuples.contains(&tuple) {
            tuples.push(tuple);
        }
        if let Some(root) = root {
            save(&root.join("bindings.json"), &*tuples)?;
        }
        Ok(())
    }
    fn checkpoint(&self, root: &Path, journal: &Journal) -> Result<(), ErrorBody> {
        save(&root.join("journal.json"), journal)?;
        self.refresh_gates(journal);
        #[cfg(test)]
        {
            let mut crash = self.crash_after.lock().expect("move crash hook");
            if let Some(n) = crash.as_mut() {
                if *n == 0 {
                    *crash = None;
                    return Err(storage("simulated crash after durable move write"));
                }
                *n -= 1;
            }
        }
        Ok(())
    }
}
fn load<T: serde::de::DeserializeOwned + Default>(path: &Path) -> Result<T, ErrorBody> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(storage),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(storage(e)),
    }
}
fn save(path: &Path, value: &impl Serialize) -> Result<(), ErrorBody> {
    private_permissions::write_file_atomic(
        path,
        &serde_json::to_vec(value).map_err(storage)?,
        true,
    )
    .map_err(storage)?;
    private_permissions::sync_directory(path.parent().expect("journal parent")).map_err(storage)
}
fn internal_cut(cut: &str, session: &str, phase: &str) -> String {
    mc_store::move_snapshot::digest(format!("{cut}\n{session}\n{phase}").as_bytes())[..32].into()
}
fn binding(cut: &str, reference: &str, session: &str, phase: &str, start: u64) -> CutBinding {
    CutBinding {
        cut_id: internal_cut(cut, session, phase),
        session_ref: reference.into(),
        host_session_id: session.into(),
        host_end_offset: 0,
        host_cut: Value::Null,
        mc_start_offset: start,
    }
}
fn directory(root: &Path, cut: &str, reference: &str) -> PathBuf {
    root.join(cut)
        .join(mc_store::move_snapshot::digest(reference.as_bytes()))
}
fn fingerprint(
    mover: &MoveStore,
    context: &ContextMoveStore,
    id: &Identity,
) -> Result<Vec<String>, ErrorBody> {
    std::iter::once(&id.session)
        .chain(id.namespaces.iter())
        .map(|session| {
            Ok(format!(
                "{}:{}",
                context.fingerprint(session).map_err(storage)?,
                mover.fingerprint(session).map_err(storage)?
            ))
        })
        .collect()
}
/// Whether a provider row's first key column names this session. Runner
/// conversations store their runner module id there and folder-keyed records
/// store their project folder (see `providers::Key::store_key`).
fn provider_row_names(column: &str, runner: &str, project_root: &str) -> bool {
    column == runner || column == project_root
}
fn held(mover: &MoveStore, context: &ContextMoveStore, id: &Identity) -> Result<bool, ErrorBody> {
    for s in std::iter::once(&id.session).chain(id.namespaces.iter()) {
        if mover.has_session_data(s).map_err(storage)?
            || context.has_session_data(s).map_err(storage)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}
fn unknown(r: &Ref) -> ErrorBody {
    ErrorBody::with_typed_detail(
        Detail::UnknownRef(UnknownRefDetail::new(&r.ref_kind, &r.r#ref)),
        "MC does not hold this ref",
    )
}
fn outcome(result: Result<Value, ErrorBody>) -> HandlerOutcome {
    match result {
        Ok(value) => crate::respond(value),
        Err(body) => match body.detail {
            Some(detail) => HandlerOutcome::ErrorWithDetail {
                code: body.code.as_str().into(),
                message: body.message,
                detail,
            },
            None => HandlerOutcome::Error {
                code: body.code.as_str().into(),
                message: body.message,
            },
        },
    }
}

/// Admission precedes decoding: an untrusted caller learns no request or store state.
fn decode(caller: Option<&Principal>, method: &str, params: &Value) -> Result<Request, ErrorBody> {
    let admitted = matches!(caller,Some(Principal::Reserved {module_id}) if format!("reserved:{module_id}")==role::ADMITTED_CALLER);
    if !admitted {
        return Err(error(
            RefusalCode::CallerForbidden,
            "only reserved:entorhinal may move MC data",
        ));
    }
    let request = Request::decode(method, params)?;
    if request.refs().is_some_and(|refs| {
        refs.iter()
            .any(|r| r.ref_kind.len() > 64 || r.r#ref.len() > 512)
    }) {
        return Err(error(
            RefusalCode::InvalidRequest,
            "ref exceeds its registered size limit",
        ));
    }
    Ok(request)
}
fn transition(request: &Request, cut: &Cut) -> Result<(Step, Option<Value>), ErrorBody> {
    if let Some(receipt) = cut.receipts.get(request.op().method()) {
        let first = Request::decode(request.op().method(), &receipt.params)?;
        match idempotency::compare(&first, request) {
            Repeat::Replay => return Ok((cut.step, Some(receipt.reply.clone()))),
            Repeat::Reused => {
                return Err(error(
                    RefusalCode::IdReused,
                    "cutId/op was already answered for another request",
                ))
            }
            _ => {}
        }
    }
    let next = step::advance(request.op(), cut.step).map_err(|refusal| match refusal {
        StepRefusal::CutUnknown => error(RefusalCode::CutUnknown, "no earlier step for this cut"),
        StepRefusal::InvalidState { step } => ErrorBody::with_typed_detail(
            Detail::InvalidState(InvalidStateDetail::new(step)),
            "operation is out of order",
        ),
    })?;
    if let Some(refs) = request.refs() {
        step::check_ref_set(request.op(), cut.step, cut.refs.as_ref(), refs).map_err(|detail| {
            ErrorBody::with_typed_detail(
                Detail::InvalidState(detail),
                "operation must name exactly the started ref set",
            )
        })?;
    }
    Ok((next, None))
}
impl AgentDataService {
    async fn resolve(
        &self,
        r: &Ref,
        store: &McStore,
        mover: &mut MoveStore,
        context: &ContextMoveStore,
    ) -> Result<Identity, ErrorBody> {
        if !REF_KINDS.contains(&r.ref_kind.as_str()) {
            return Err(unknown(r));
        }
        // Provider rows name no attested runner, so they only contribute the
        // engine namespaces of a session found through its observed binding.
        let providers = store.move_provider_identities().map_err(storage)?;
        let tuples = self.tuples.lock().expect("move tuples").clone();
        for tuple in tuples {
            if kind(&tuple.harness) == Some(r.ref_kind.as_str()) && tuple.reference() == r.r#ref {
                if self
                    .activity
                    .lock()
                    .expect("move activity")
                    .gates
                    .get(&tuple.session)
                    .is_some_and(|(code, _)| code == "session_moved")
                {
                    return Err(unknown(r));
                }
                let namespaces = providers
                    .iter()
                    .filter(|(h, p, s, _)| {
                        h == &tuple.harness
                            && provider_row_names(p, &tuple.runner, &tuple.project_root)
                            && s == &tuple.session
                    })
                    .map(|(_, _, _, e)| e.clone())
                    .filter(|e| !e.is_empty() && e != &tuple.session)
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect();
                let id = Identity {
                    runner: tuple.runner,
                    harness: tuple.harness,
                    project_root: tuple.project_root,
                    session: tuple.session,
                    namespaces,
                };
                return if held(mover, context, &id)? {
                    Ok(id)
                } else {
                    Err(unknown(r))
                };
            }
        }
        let found = match self.lookup.session_for_ref(&r.ref_kind, &r.r#ref).await {
            Ok(value) => value,
            Err(e) => {
                if !self.lookup_warned.swap(true, Ordering::Relaxed) {
                    tracing::warn!(code=%e.code,"Entorhinal session ref lookup unavailable; unknown refs remain refused");
                }
                None
            }
        };
        // Entorhinal's answer is usable only when it names the runner: the
        // reference cannot be checked without it, so the ref stays refused.
        if let Some((found, runner)) =
            found.and_then(|found| found.runner.clone().map(|runner| (found, runner)))
        {
            if kind(&found.harness) == Some(r.ref_kind.as_str())
                && found.ref_kind == r.ref_kind
                && found.reference == r.r#ref
                && session_ref(&runner, &found.harness, &found.session_id) == r.r#ref
            {
                if self
                    .activity
                    .lock()
                    .expect("move activity")
                    .gates
                    .get(&found.session_id)
                    .is_some_and(|(code, _)| code == "session_moved")
                {
                    return Err(unknown(r));
                }
                let namespaces = providers
                    .iter()
                    .filter(|(h, p, s, _)| {
                        h == &found.harness
                            && provider_row_names(p, &runner, &found.project_root)
                            && s == &found.session_id
                    })
                    .map(|(_, _, _, e)| e.clone())
                    .filter(|e| !e.is_empty() && e != &found.session_id)
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect();
                let id = Identity {
                    runner,
                    harness: found.harness,
                    project_root: found.project_root,
                    session: found.session_id,
                    namespaces,
                };
                if held(mover, context, &id)? {
                    return Ok(id);
                }
            }
        }
        Err(unknown(r))
    }
    fn busy(
        &self,
        handler: &McHandler,
        mover: &MoveStore,
        refs: &Refs,
        ids: &[Identity],
    ) -> Result<Vec<Value>, ErrorBody> {
        let activity = self.activity.lock().expect("move activity");
        refs.iter().zip(ids).map(|(_,id)| {
            for session in std::iter::once(&id.session).chain(id.namespaces.iter()) {
                let reason=activity.active.get(session).and_then(|reasons|reasons.keys().next()).cloned()
                    .or_else(||handler.live_historian_sessions.lock().expect("live historian sessions").contains_key(session).then(||"historian_running".into()))
                    .or_else(||handler.wrapup_sessions.lock().expect("wrapup sessions").contains_key(session).then(||"historian_running".into()))
                    .or_else(||handler.active_dreamer_runs.lock().expect("dreamer runs").contains(session).then(||"dreamer_running".into()));
                let reason=reason.or(mover.busy_reason(session).map_err(storage)?.map(String::from));
                if let Some(reason)=reason {return Ok(json!({"state":"busy","reason_code":reason,"reason":"MC work is in flight"}));}
            }
            Ok(json!({"state":"idle"}))
        }).collect()
    }
    fn gate(&self, refs: &Refs, ids: &[Identity]) -> Result<(), ErrorBody> {
        let mut activity = self.activity.lock().expect("move activity");
        let mut busy = vec![];
        for (r, id) in refs.iter().zip(ids) {
            for s in std::iter::once(&id.session).chain(id.namespaces.iter()) {
                if let Some(reasons) = activity.active.get(s) {
                    busy.push(
                        BusyRef::new(&r.ref_kind, &r.r#ref, "MC work is in flight")
                            .with_reason_code(reasons.keys().next().expect("nonempty activity")),
                    );
                    break;
                }
            }
        }
        if !busy.is_empty() {
            return Err(ErrorBody::with_typed_detail(
                Detail::Busy(BusyDetail::new(busy)),
                "MC data is busy",
            ));
        }
        for id in ids {
            for s in std::iter::once(&id.session).chain(id.namespaces.iter()) {
                activity
                    .gates
                    .insert(s.clone(), ("session_moving".into(), None));
            }
        }
        Ok(())
    }
    fn refuse_busy(
        &self,
        handler: &McHandler,
        mover: &MoveStore,
        refs: &Refs,
        ids: &[Identity],
    ) -> Result<(), ErrorBody> {
        let replies = self.busy(handler, mover, refs, ids)?;
        let busy = refs
            .iter()
            .zip(replies)
            .filter(|(_, value)| value["state"] != "idle")
            .map(|(r, value)| {
                BusyRef::new(&r.ref_kind, &r.r#ref, "MC work is in flight")
                    .with_reason_code(value["reason_code"].as_str().unwrap_or("run_active"))
            })
            .collect::<Vec<_>>();
        if busy.is_empty() {
            Ok(())
        } else {
            Err(ErrorBody::with_typed_detail(
                Detail::Busy(BusyDetail::new(busy)),
                "MC data is busy",
            ))
        }
    }
    pub(crate) async fn handle(
        &self,
        handler: &McHandler,
        channel: u16,
        method: &str,
        params: &Value,
    ) -> HandlerOutcome {
        let binding = handler
            .bindings
            .lock()
            .expect("route bindings")
            .get(&channel)
            .cloned();
        let request = match decode(
            binding.as_ref().and_then(|b| b.principal.as_ref()),
            method,
            params,
        ) {
            Ok(request) => request,
            Err(error) => return outcome(Err(error)),
        };
        if !self
            .channels
            .lock()
            .expect("agent data channels")
            .contains(&channel)
        {
            return outcome(Err(error(
                RefusalCode::CallerForbidden,
                "agent-data is an internal service",
            )));
        }
        let result = self.execute(handler, &request).await.map_err(|body| {
            if role::errors::may_refuse(request.op(), &body.code) {
                body
            } else {
                error(
                    RefusalCode::Unavailable,
                    format!("MC move step: {} ({})", body.message, body.code.as_str()),
                )
            }
        });
        outcome(result)
    }
    async fn execute_locked(
        &self,
        handler: &McHandler,
        request: &Request,
    ) -> Result<Value, ErrorBody> {
        if matches!(request, Request::Describe(_)) {
            return Ok(
                json!({"ref_kinds":REF_KINDS,"stores":[{"name":"context.db","sync_class":role::describe::sync_class::AGENT},{"name":"store.db","sync_class":role::describe::sync_class::AGENT}],"external":false}),
            );
        }
        let store = handler
            .store_for_request()
            .await
            .map_err(|_| storage("MC store is unavailable"))?;
        self.configure(
            store
                .move_storage_path()
                .ok_or_else(|| storage("agent moves require SQLite"))?,
        )?;
        let root = self.root()?;
        let context_path = store
            .context_domain_status()
            .get("path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .ok_or_else(|| storage("context store is unavailable"))?;
        let context = ContextMoveStore::open(&context_path).map_err(storage)?;
        let mut mover = store.move_store().map_err(storage)?;
        let mut journal: Journal = load(&root.join("journal.json"))?;
        let refs = request.refs().expect("non-describe refs");
        if matches!(request.op(), Op::Status | Op::Abort)
            && refs
                .iter()
                .any(|r| !REF_KINDS.contains(&r.ref_kind.as_str()))
        {
            return Err(error(
                RefusalCode::InvalidRequest,
                "MC does not declare this ref kind",
            ));
        }
        if let Request::Busy(_) = request {
            let mut ids = vec![];
            for r in refs {
                ids.push(self.resolve(r, &store, &mut mover, &context).await?);
            }
            return Ok(json!({"refs":self.busy(handler,&mover,refs,&ids)?}));
        }
        let cut_id = request.cut_id().expect("cut op").as_str();
        if let Request::Status(_) = request {
            return Ok(
                json!({"step":journal.cuts.get(cut_id).map(|c|c.step).unwrap_or(Step::None)}),
            );
        }
        let cut = journal.cuts.get(cut_id).cloned().unwrap_or_default();
        if let Request::Diverged(_) = request {
            return self
                .diverged(&root, &mut journal, cut_id, refs, &mut mover, &context)
                .await;
        }
        let (next, replay) = transition(request, &cut)?;
        if let Some(reply) = replay {
            return Ok(reply);
        }
        if cut
            .intent
            .as_deref()
            .is_some_and(|op| op != request.op().method())
            && request.op() != Op::Abort
        {
            return Err(storage(
                "an interrupted move step must be retried or aborted",
            ));
        }
        let reply = match request {
            Request::Prepare(_) => {
                self.prepare(
                    handler,
                    &root,
                    &mut journal,
                    cut_id,
                    refs,
                    &store,
                    &mut mover,
                    &context,
                )
                .await?
            }
            Request::Export(_) => {
                self.export(
                    &root,
                    &mut journal,
                    cut_id,
                    refs,
                    &store,
                    &mut mover,
                    &context,
                )
                .await?
            }
            Request::Import(_) => {
                self.import(
                    handler,
                    &root,
                    &mut journal,
                    cut_id,
                    refs,
                    &mut mover,
                    &context,
                )
                .await?
            }
            Request::Activate(_) => self.activate(
                handler,
                &root,
                &mut journal,
                cut_id,
                refs,
                &mut mover,
                &context,
            )?,
            Request::Abort(_) => {
                self.abort(&root, &mut journal, cut_id, refs, &mut mover, &context)?
            }
            Request::Release(r) => {
                self.release(
                    &root,
                    &mut journal,
                    cut_id,
                    refs,
                    &r.holder,
                    &store,
                    &mut mover,
                    &context,
                )
                .await?
            }
            _ => unreachable!("reads handled above"),
        };
        let cut = journal.cuts.entry(cut_id.into()).or_default();
        cut.step = next;
        cut.intent = None;
        cut.receipts.insert(
            request.op().method().into(),
            Receipt {
                params: request.params(),
                reply: reply.clone(),
            },
        );
        self.checkpoint(&root, &journal)?;
        Ok(reply)
    }
}

impl AgentDataService {
    #[allow(clippy::too_many_arguments)] // Two SQLite handles share one persisted move record; explicit arguments make both writes auditable.
    async fn prepare(
        &self,
        handler: &McHandler,
        root: &Path,
        journal: &mut Journal,
        cut_id: &str,
        refs: &Refs,
        store: &McStore,
        mover: &mut MoveStore,
        context: &ContextMoveStore,
    ) -> Result<Value, ErrorBody> {
        if journal.cuts.get(cut_id).is_none_or(|c| c.intent.is_none()) {
            let mut ids = vec![];
            for r in refs {
                ids.push(self.resolve(r, store, mover, context).await?);
            }
            self.refuse_busy(handler, mover, refs, &ids)?;
            self.gate(refs, &ids)?;
            ids.clear();
            for r in refs {
                ids.push(self.resolve(r, store, mover, context).await?);
            }
            self.refuse_busy(handler, mover, refs, &ids)?;
            let mut unique = BTreeSet::new();
            if ids.iter().any(|id| {
                std::iter::once(&id.session)
                    .chain(id.namespaces.iter())
                    .any(|s| !unique.insert(s.clone()))
            }) {
                return Err(error(
                    RefusalCode::NotExportable,
                    "refs overlap one MC storage session",
                ));
            }
            let cut = journal.cuts.entry(cut_id.into()).or_default();
            cut.refs = Some(refs.clone());
            cut.sessions = ids;
            cut.intent = Some(Op::Prepare.method().into());
            for id in &cut.sessions {
                for session in std::iter::once(&id.session).chain(id.namespaces.iter()) {
                    journal.current.insert(session.clone(), cut_id.into());
                }
            }
            self.checkpoint(root, journal)?;
        }
        let original = journal.cuts[cut_id].refs.clone().expect("prepared refs");
        if !original.same_set(refs) {
            return Err(storage(
                "retry must name the same refs as the interrupted prepare",
            ));
        }
        let ids = journal.cuts[cut_id].sessions.clone();
        for (index, (r, id)) in original.iter().zip(&ids).enumerate() {
            if journal.cuts[cut_id].snapshots.len() > index {
                continue;
            }
            let position = self
                .door
                .cover(&r.r#ref)
                .await
                .map_err(|e| snapshot::door_error(e, false))?;
            if position.cloud_offset < position.durable_offset {
                return Err(storage("engram has not covered the existing MC stream"));
            }
            let dir = directory(root, cut_id, &r.r#ref);
            private_permissions::ensure_directory(&dir, true).map_err(storage)?;
            let mut halves = vec![];
            for (i, session) in std::iter::once(&id.session)
                .chain(id.namespaces.iter())
                .enumerate()
            {
                let binding = binding(cut_id, &r.r#ref, session, "source", position.durable_offset);
                mover.acquire_fence(&binding).map_err(storage)?;
                self.checkpoint(root, journal)?;
                mover.freeze(&binding.cut_id).map_err(storage)?;
                self.checkpoint(root, journal)?;
                let module = dir.join(format!("module-{i}.bin"));
                let ctx = dir.join(format!("context-{i}.bin"));
                if let Some(record) = mover
                    .source_cut_record(&binding)
                    .map_err(storage)?
                    .and_then(|r| r.receipt)
                {
                    halves.push(serde_json::from_str(&record).map_err(storage)?);
                    continue;
                }
                remove(&module)?;
                remove(&ctx)?;
                let module_length = mover.capture(&binding.cut_id, &module).map_err(|e| {
                    if e.code() == "non_portable_project" {
                        error(RefusalCode::NotExportable, e.to_string())
                    } else {
                        storage(e)
                    }
                })?;
                let context_length = context.capture(session, &ctx).map_err(|e| {
                    if e.code() == "non_portable_project" {
                        error(RefusalCode::NotExportable, e.to_string())
                    } else {
                        storage(e)
                    }
                })?;
                let half = Half {
                    session: session.clone(),
                    module_length,
                    context_length,
                    module_digest: snapshot::file_digest(&module)?,
                    context_digest: snapshot::file_digest(&ctx)?,
                };
                mover
                    .record_capture(
                        &binding.cut_id,
                        &half.module_digest,
                        &module,
                        &serde_json::to_string(&half).map_err(storage)?,
                    )
                    .map_err(storage)?;
                self.checkpoint(root, journal)?;
                halves.push(half);
            }
            let header = Header {
                cut_id: cut_id.into(),
                ref_kind: r.ref_kind.clone(),
                session_ref: r.r#ref.clone(),
                identity: id.clone(),
                context_version: mc_store::move_inventory::CONTEXT_SCHEMA_VERSION,
                store_version: mc_store::move_inventory::STORE_SCHEMA_VERSION,
                inventory_version: mc_store::move_inventory::INVENTORY_VERSION,
                halves,
            };
            let wire = dir.join("wire.bin");
            remove(&wire)?;
            let length = snapshot::envelope(&wire, &header, &dir)?;
            let digest = snapshot::prefix_digest(
                self.door.as_ref(),
                &r.r#ref,
                position.durable_offset,
                &wire,
            )
            .await?;
            let end = position
                .durable_offset
                .checked_add(length)
                .ok_or_else(|| storage("MC stream offset overflow"))?;
            journal
                .baselines
                .insert(r.r#ref.clone(), fingerprint(mover, context, id)?);
            journal
                .cuts
                .get_mut(cut_id)
                .expect("source cut")
                .snapshots
                .push(Snapshot {
                    header,
                    start: position.durable_offset,
                    end,
                    digest,
                });
            self.checkpoint(root, journal)?;
        }
        let items=journal.cuts[cut_id].snapshots.iter().map(|s|json!({"ref_kind":s.header.ref_kind,"ref":s.header.session_ref,"sessionRef":s.header.session_ref,"stream":stream(&self.module_id),"endOffset":s.end,"digest":s.digest,"format":s.header.format(),"frozen":true})).collect::<Vec<_>>();
        Ok(json!({"items":items,"external":[]}))
    }
    #[allow(clippy::too_many_arguments)] // Two SQLite handles share one persisted move record; explicit arguments make both writes auditable.
    async fn export(
        &self,
        root: &Path,
        journal: &mut Journal,
        cut_id: &str,
        refs: &Refs,
        store: &McStore,
        mover: &mut MoveStore,
        context: &ContextMoveStore,
    ) -> Result<Value, ErrorBody> {
        for r in refs {
            self.resolve(r, store, mover, context).await?;
        }
        journal.cuts.get_mut(cut_id).expect("source cut").intent = Some(Op::Export.method().into());
        self.checkpoint(root, journal)?;
        let snapshots = journal.cuts[cut_id].snapshots.clone();
        for snapshot in &snapshots {
            let r = &snapshot.header.session_ref;
            let position = self
                .door
                .cover(r)
                .await
                .map_err(|e| snapshot::door_error(e, false))?;
            let mut offset = position.durable_offset;
            if offset < snapshot.start || offset > snapshot.end {
                return Err(storage("engram MC stream differs from the prepared range"));
            }
            let mut file =
                File::open(directory(root, cut_id, r).join("wire.bin")).map_err(storage)?;
            file.seek(SeekFrom::Start(offset - snapshot.start))
                .map_err(storage)?;
            let cap =
                mc_store::move_snapshot::MAX_RECORD_LENGTH - 17 - stream(&self.module_id).len();
            let mut bytes = vec![0; snapshot::PAGE.min(cap)];
            while offset < snapshot.end {
                let count = file.read(&mut bytes).map_err(storage)?;
                if count == 0 {
                    return Err(storage("prepared stream file is incomplete"));
                }
                match self.door.admit(r, offset, &bytes[..count]).await {
                    Ok(reply) => {
                        if reply.durable_offset != offset + count as u64 {
                            return Err(storage("engram admitted an unexpected byte range"));
                        }
                        offset = reply.durable_offset;
                    }
                    Err(e) if e.code == "offset_mismatch" => {
                        let expected = e
                            .detail
                            .as_ref()
                            .and_then(|d| d.get("expectedOffset"))
                            .and_then(Value::as_u64)
                            .ok_or_else(|| storage("engram omitted expectedOffset"))?;
                        if expected <= offset || expected > snapshot.end {
                            return Err(storage("engram has a conflicting stream offset"));
                        }
                        offset = expected;
                        file.seek(SeekFrom::Start(offset - snapshot.start))
                            .map_err(storage)?;
                    }
                    Err(e) => return Err(snapshot::door_error(e, false)),
                }
                self.checkpoint(root, journal)?;
            }
            let position = self
                .door
                .cover(r)
                .await
                .map_err(|e| snapshot::door_error(e, false))?;
            if position.cloud_offset < snapshot.end {
                return Err(storage("engram has not covered the exported cut"));
            }
            if snapshot::stream_digest(self.door.as_ref(), r, snapshot.end).await?
                != snapshot.digest
            {
                return Err(storage(
                    "engram exported bytes differ from the prepared digest",
                ));
            }
        }
        Ok(
            json!({"items":snapshots.iter().map(|s|json!({"sessionRef":s.header.session_ref,"endOffset":s.end})).collect::<Vec<_>>()}),
        )
    }
    async fn read_all(
        &self,
        refs: &Refs,
        cut_id: &str,
        mover: &mut MoveStore,
        context: &ContextMoveStore,
    ) -> Result<Vec<Incoming>, ErrorBody> {
        let mut incoming = vec![];
        for r in refs {
            if !REF_KINDS.contains(&r.ref_kind.as_str()) {
                return Err(error(
                    RefusalCode::InvalidRequest,
                    "MC does not declare this ref kind",
                ));
            }
            incoming.push(
                snapshot::incoming(
                    self.door.as_ref(),
                    &r.ref_kind,
                    &r.r#ref,
                    cut_id,
                    None,
                    (
                        context.schema_version().map_err(storage)?,
                        mover.schema_version().map_err(storage)?,
                    ),
                )
                .await?,
            );
        }
        Ok(incoming)
    }
    async fn diverged(
        &self,
        root: &Path,
        journal: &mut Journal,
        cut_id: &str,
        refs: &Refs,
        mover: &mut MoveStore,
        context: &ContextMoveStore,
    ) -> Result<Value, ErrorBody> {
        let incoming = self.read_all(refs, cut_id, mover, context).await?;
        let mut states = vec![];
        let mut observations = BTreeMap::new();
        for (r, item) in refs.iter().zip(&incoming) {
            let live = fingerprint(mover, context, &item.header.identity)?;
            let at_cut = !held(mover, context, &item.header.identity)?
                || item
                    .header
                    .halves
                    .iter()
                    .map(|h| format!("{}:{}", h.context_digest, h.module_digest))
                    .collect::<Vec<_>>()
                    == live
                || journal.baselines.get(&r.r#ref) == Some(&live);
            states.push(json!({"state":if at_cut {"at_cut"} else {"advanced"}}));
            if at_cut {
                observations.insert(r.r#ref.clone(), live);
            }
        }
        journal.cuts.entry(cut_id.into()).or_default().observations = observations;
        self.checkpoint(root, journal)?;
        Ok(json!({"refs":states}))
    }
    #[allow(clippy::too_many_arguments)] // Two SQLite handles share one persisted move record; explicit arguments make both writes auditable.
    async fn import(
        &self,
        handler: &McHandler,
        root: &Path,
        journal: &mut Journal,
        cut_id: &str,
        refs: &Refs,
        mover: &mut MoveStore,
        context: &ContextMoveStore,
    ) -> Result<Value, ErrorBody> {
        // All formats are checked before the first staging file or move intent is written.
        let incoming = self.read_all(refs, cut_id, mover, context).await?;
        let ids = incoming
            .iter()
            .map(|i| i.header.identity.clone())
            .collect::<Vec<_>>();
        self.refuse_busy(handler, mover, refs, &ids)?;
        for (r, id) in refs.iter().zip(&ids) {
            let current = fingerprint(mover, context, id)?;
            let expected = journal
                .cuts
                .get(cut_id)
                .and_then(|c| c.observations.get(&r.r#ref))
                .or_else(|| journal.baselines.get(&r.r#ref));
            if expected.is_some_and(|e| e != &current)
                || (expected.is_none()
                    && held(mover, context, id)?
                    && incoming
                        .iter()
                        .find(|item| item.header.session_ref == r.r#ref)
                        .map(|item| {
                            item.header
                                .halves
                                .iter()
                                .map(|h| format!("{}:{}", h.context_digest, h.module_digest))
                                .collect::<Vec<_>>()
                        })
                        != Some(current.clone()))
            {
                return Err(error(
                    RefusalCode::LocalAdvanced,
                    "local MC data advanced before import",
                ));
            }
        }
        self.gate(refs, &ids)?;
        let cut = journal.cuts.entry(cut_id.into()).or_default();
        if cut.refs.as_ref().is_some_and(|r| !r.same_set(refs)) {
            return Err(storage("retry must name the interrupted import's refs"));
        }
        cut.refs = Some(refs.clone());
        cut.sessions = ids;
        cut.intent = Some(Op::Import.method().into());
        for (r, item) in refs.iter().zip(&incoming) {
            cut.observations
                .entry(r.r#ref.clone())
                .or_insert(fingerprint(mover, context, &item.header.identity)?);
        }
        self.checkpoint(root, journal)?;
        let mut items = vec![];
        let mut verified = true;
        for (index, (r, checked)) in refs.iter().zip(&incoming).enumerate() {
            let dir = directory(root, cut_id, &r.r#ref);
            private_permissions::ensure_directory(&dir, true).map_err(storage)?;
            for i in 0..checked.header.halves.len() {
                remove(&dir.join(format!("context-{i}.bin")))?;
                remove(&dir.join(format!("module-{i}.bin")))?;
            }
            let staged = snapshot::incoming(
                self.door.as_ref(),
                &r.ref_kind,
                &r.r#ref,
                cut_id,
                Some(&dir),
                (
                    context.schema_version().map_err(storage)?,
                    mover.schema_version().map_err(storage)?,
                ),
            )
            .await?;
            if staged.header != checked.header || staged.digest != checked.digest {
                return Err(error(
                    RefusalCode::DigestMismatch,
                    "cut changed between checking and staging",
                ));
            }
            for (i, half) in staged.header.halves.iter().enumerate() {
                context
                    .validate_import(&half.session, &dir.join(format!("context-{i}.bin")))
                    .map_err(storage)?;
                mover
                    .validate_import(&half.session, &dir.join(format!("module-{i}.bin")))
                    .map_err(storage)?;
            }
            verified &= staged.verified;
            items.push(json!({"sessionRef":r.r#ref,"endOffset":staged.end,"digest":staged.digest}));
            let snapshot = Snapshot {
                header: staged.header,
                start: 0,
                end: staged.end,
                digest: staged.digest,
            };
            let cut = journal.cuts.get_mut(cut_id).expect("receiver cut");
            if cut.snapshots.len() > index {
                cut.snapshots[index] = snapshot;
            } else {
                cut.snapshots.push(snapshot);
            }
            self.checkpoint(root, journal)?;
        }
        if !verified && !journal.cuts[cut_id].seal_unverified_logged {
            journal
                .cuts
                .get_mut(cut_id)
                .expect("receiver cut")
                .seal_unverified_logged = true;
            self.checkpoint(root, journal)?;
            tracing::warn!(cut_id,"MC import checked snapshot digests but engram did not supply a sealed stream digest; seal verification is unavailable");
        }
        Ok(json!({"items":items}))
    }
}
fn remove(path: &Path) -> Result<(), ErrorBody> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(storage(e)),
    }
}

impl AgentDataService {
    #[allow(clippy::too_many_arguments)] // Two SQLite handles share one persisted move record; explicit arguments make both writes auditable.
    fn activate(
        &self,
        handler: &McHandler,
        root: &Path,
        journal: &mut Journal,
        cut_id: &str,
        refs: &Refs,
        mover: &mut MoveStore,
        context: &ContextMoveStore,
    ) -> Result<Value, ErrorBody> {
        let cut = journal.cuts[cut_id].clone();
        for snapshot in &cut.snapshots {
            self.validate_images(
                &cut,
                cut_id,
                &snapshot.header,
                &directory(root, cut_id, &snapshot.header.session_ref),
                "activate",
                mover,
                role::errors::digest_mismatch_reason::STAGING_DIGEST_MISMATCH,
            )?;
        }
        for header in &cut.undo {
            self.validate_images(
                &cut,
                cut_id,
                header,
                &directory(root, cut_id, &header.session_ref).join("undo"),
                "abort",
                mover,
                role::errors::digest_mismatch_reason::UNDO_DIGEST_MISMATCH,
            )?;
        }
        if cut.intent.is_none() {
            self.refuse_busy(handler, mover, refs, &cut.sessions)?;
            self.gate(refs, &cut.sessions)?;
            for snapshot in &cut.snapshots {
                let expected = cut.observations.get(&snapshot.header.session_ref);
                if expected != Some(&fingerprint(mover, context, &snapshot.header.identity)?) {
                    self.refresh_gates(journal);
                    return Err(error(
                        RefusalCode::LocalAdvanced,
                        "local MC data advanced after staging",
                    ));
                }
            }
            journal.cuts.get_mut(cut_id).expect("receiver cut").intent =
                Some(Op::Activate.method().into());
            self.checkpoint(root, journal)?;
        }
        let snapshots = journal.cuts[cut_id].snapshots.clone();
        for (index, snapshot) in snapshots.iter().enumerate() {
            if journal.cuts[cut_id].undo.len() > index {
                continue;
            }
            let dir = directory(root, cut_id, &snapshot.header.session_ref).join("undo");
            private_permissions::ensure_directory(&dir, true).map_err(storage)?;
            let mut header = snapshot.header.clone();
            header.halves.clear();
            for (i, original) in snapshot.header.halves.iter().enumerate() {
                let ctx = dir.join(format!("context-{i}.bin"));
                let module = dir.join(format!("module-{i}.bin"));
                remove(&ctx)?;
                remove(&module)?;
                let context_length = context.capture(&original.session, &ctx).map_err(storage)?;
                let module_length = mover
                    .capture_undo(&original.session, &module)
                    .map_err(storage)?;
                header.halves.push(Half {
                    session: original.session.clone(),
                    context_length,
                    module_length,
                    context_digest: snapshot::file_digest(&ctx)?,
                    module_digest: snapshot::file_digest(&module)?,
                });
            }
            journal
                .cuts
                .get_mut(cut_id)
                .expect("receiver cut")
                .undo
                .push(header);
            self.checkpoint(root, journal)?;
        }
        for snapshot in &snapshots {
            let dir = directory(root, cut_id, &snapshot.header.session_ref);
            for header in &journal.cuts[cut_id].undo {
                self.validate_images(
                    &journal.cuts[cut_id],
                    cut_id,
                    header,
                    &directory(root, cut_id, &header.session_ref).join("undo"),
                    "abort",
                    mover,
                    role::errors::digest_mismatch_reason::UNDO_DIGEST_MISMATCH,
                )?;
            }
            self.replace_halves(
                root,
                journal,
                cut_id,
                &snapshot.header,
                &dir,
                "activate",
                mover,
                context,
            )?;
        }
        for snapshot in &snapshots {
            for half in &snapshot.header.halves {
                mover
                    .activate(&internal_cut(cut_id, &half.session, "activate-install"))
                    .map_err(storage)?;
                self.checkpoint(root, journal)?;
            }
        }
        for snapshot in &snapshots {
            journal.baselines.insert(
                snapshot.header.session_ref.clone(),
                fingerprint(mover, context, &snapshot.header.identity)?,
            );
            for session in std::iter::once(&snapshot.header.identity.session)
                .chain(snapshot.header.identity.namespaces.iter())
            {
                journal.current.insert(session.clone(), cut_id.into());
            }
            {
                let project_root = &snapshot.header.identity.project_root;
                let mut tuples = self.tuples.lock().expect("move tuples");
                let tuple = BindTuple {
                    runner: snapshot.header.identity.runner.clone(),
                    harness: snapshot.header.identity.harness.clone(),
                    project_root: project_root.clone(),
                    session: snapshot.header.identity.session.clone(),
                };
                if !tuples.contains(&tuple) {
                    tuples.push(tuple);
                }
                save(&root.join("bindings.json"), &*tuples)?;
            }
        }
        Ok(json!({}))
    }
    #[allow(clippy::too_many_arguments)]
    fn replace_halves(
        &self,
        root: &Path,
        journal: &mut Journal,
        cut_id: &str,
        header: &Header,
        dir: &Path,
        phase: &str,
        mover: &mut MoveStore,
        context: &ContextMoveStore,
    ) -> Result<(), ErrorBody> {
        self.validate_images(
            &journal.cuts[cut_id],
            cut_id,
            header,
            dir,
            phase,
            mover,
            if phase == "abort" {
                role::errors::digest_mismatch_reason::UNDO_DIGEST_MISMATCH
            } else {
                role::errors::digest_mismatch_reason::STAGING_DIGEST_MISMATCH
            },
        )?;
        for (i, half) in header.halves.iter().enumerate() {
            let install = binding(
                cut_id,
                &header.session_ref,
                &half.session,
                &format!("{phase}-install"),
                0,
            );
            if journal.cuts[cut_id].installed.contains(&install.cut_id) {
                continue;
            }
            let completed = mover
                .installed_result(&install, Some(&half.module_digest))
                .map_err(storage)?;
            if completed.is_none() {
                let discard = binding(
                    cut_id,
                    &header.session_ref,
                    &half.session,
                    &format!("{phase}-discard"),
                    0,
                );
                let fence = mover.session_fence_cut(&half.session).map_err(storage)?;
                if let Some(fence) = &fence {
                    let owned = journal.cuts.iter().any(|(id, c)| {
                        c.sessions.iter().any(|identity| {
                            identity.session == half.session
                                || identity.namespaces.contains(&half.session)
                        }) && [
                            "source",
                            "activate-discard",
                            "activate-install",
                            "abort-discard",
                            "abort-install",
                        ]
                        .iter()
                        .any(|p| internal_cut(id, &half.session, p) == *fence)
                    });
                    if !owned {
                        return Err(storage("another move owns this local session"));
                    }
                }
                mover
                    .reserve_discard(&discard, fence.as_deref())
                    .map_err(storage)?;
                self.checkpoint(root, journal)?;
                mover.begin_discard(&discard.cut_id).map_err(storage)?;
                self.checkpoint(root, journal)?;
                while !mover.discard_batch(&discard.cut_id).map_err(storage)? {
                    self.checkpoint(root, journal)?;
                }
                while !mover
                    .discard_key_map_batch(&discard.cut_id)
                    .map_err(storage)?
                {
                    self.checkpoint(root, journal)?;
                }
                mover.finish_discard(&discard.cut_id).map_err(storage)?;
                self.checkpoint(root, journal)?;
                context
                    .replace(&half.session, &dir.join(format!("context-{i}.bin")))
                    .map_err(storage)?;
                self.checkpoint(root, journal)?;
                #[cfg(test)]
                if self
                    .crash_after_context_replace
                    .swap(false, Ordering::SeqCst)
                {
                    return Err(storage("simulated crash after context replacement"));
                }
                mover
                    .reserve_install(
                        &install,
                        &half.module_digest,
                        &dir.join(format!("module-{i}.bin")),
                    )
                    .map_err(storage)?;
                self.checkpoint(root, journal)?;
                while !mover
                    .install_batch(&install.cut_id)
                    .map_err(storage)?
                    .complete
                {
                    self.checkpoint(root, journal)?;
                }
                mover
                    .finish_install(&install.cut_id, "{}")
                    .map_err(storage)?;
            }
            journal
                .cuts
                .get_mut(cut_id)
                .expect("receiver cut")
                .installed
                .insert(install.cut_id);
            self.checkpoint(root, journal)?;
        }
        Ok(())
    }
    fn abort(
        &self,
        root: &Path,
        journal: &mut Journal,
        cut_id: &str,
        refs: &Refs,
        mover: &mut MoveStore,
        context: &ContextMoveStore,
    ) -> Result<Value, ErrorBody> {
        let original = journal.cuts.get(cut_id).cloned().unwrap_or_default();
        for header in &original.undo {
            self.validate_images(
                &original,
                cut_id,
                header,
                &directory(root, cut_id, &header.session_ref).join("undo"),
                "abort",
                mover,
                role::errors::digest_mismatch_reason::UNDO_DIGEST_MISMATCH,
            )?;
        }
        let cut = journal.cuts.entry(cut_id.into()).or_default();
        cut.intent = Some(Op::Abort.method().into());
        self.checkpoint(root, journal)?;
        if !original.undo.is_empty() {
            for header in &original.undo {
                let dir = directory(root, cut_id, &header.session_ref).join("undo");
                self.replace_halves(root, journal, cut_id, header, &dir, "abort", mover, context)?;
                for half in &header.halves {
                    mover
                        .activate(&internal_cut(cut_id, &half.session, "abort-install"))
                        .map_err(storage)?;
                    self.checkpoint(root, journal)?;
                }
                // Restoring cache generations changes storage bookkeeping, not
                // session history. Record the restored row-store cut so only
                // a subsequent local write can be reported as divergence.
                journal.baselines.insert(
                    header.session_ref.clone(),
                    fingerprint(mover, context, &header.identity)?,
                );
            }
        } else {
            for id in &original.sessions {
                for session in std::iter::once(&id.session).chain(id.namespaces.iter()) {
                    let source = internal_cut(cut_id, session, "source");
                    if mover.cut_state(&source).map_err(storage)?.is_some() {
                        mover.release_source(&source, false).map_err(storage)?;
                        self.checkpoint(root, journal)?;
                    }
                }
            }
        }
        // Preserve older released-session markers on abort: they still say that
        // the session lives elsewhere, even if this attempted move back failed.
        for (old_id, old) in &journal.cuts {
            if old_id != cut_id && old.step == Step::Released {
                for id in &old.sessions {
                    for session in std::iter::once(&id.session).chain(id.namespaces.iter()) {
                        if journal.current.get(session) == Some(old_id) {
                            mover
                                .restore_source_fence(&internal_cut(old_id, session, "source"))
                                .map_err(storage)?;
                        }
                    }
                }
            }
        }
        if original.refs.is_none() {
            journal.cuts.get_mut(cut_id).expect("aborted cut").refs = None;
        }
        if let Some(refs) = &original.refs {
            for (i, r) in refs.iter().enumerate() {
                let dir = directory(root, cut_id, &r.r#ref);
                let count = original
                    .sessions
                    .get(i)
                    .map_or(0, |id| id.namespaces.len() + 1);
                for j in 0..count {
                    for side in ["context", "module"] {
                        remove(&dir.join(format!("{side}-{j}.bin")))?;
                        remove(&dir.join("undo").join(format!("{side}-{j}.bin")))?;
                    }
                }
                remove(&dir.join("wire.bin"))?;
            }
        }
        let _ = refs;
        Ok(json!({}))
    }
    #[allow(clippy::too_many_arguments)]
    async fn release(
        &self,
        root: &Path,
        journal: &mut Journal,
        cut_id: &str,
        refs: &Refs,
        holder: &str,
        store: &McStore,
        mover: &mut MoveStore,
        context: &ContextMoveStore,
    ) -> Result<Value, ErrorBody> {
        for r in refs {
            self.resolve(r, store, mover, context).await?;
        }
        let cut = journal.cuts.get_mut(cut_id).expect("source cut");
        cut.intent = Some(Op::Release.method().into());
        cut.holder = Some(holder.into());
        self.checkpoint(root, journal)?;
        for id in journal.cuts[cut_id].sessions.clone() {
            for session in std::iter::once(&id.session).chain(id.namespaces.iter()) {
                mover
                    .release_source(&internal_cut(cut_id, session, "source"), true)
                    .map_err(storage)?;
                self.checkpoint(root, journal)?;
            }
        }
        Ok(json!({"enforced":true}))
    }
}

impl AgentDataService {}

impl AgentDataService {
    async fn execute(&self, handler: &McHandler, request: &Request) -> Result<Value, ErrorBody> {
        let _serial = self.serial.lock().await;
        let result = self.execute_locked(handler, request).await;
        if result.is_err() {
            if let Ok(root) = self.root() {
                if let Ok(journal) = load::<Journal>(&root.join("journal.json")) {
                    self.refresh_gates(&journal);
                }
            }
        }
        result
    }
}

impl std::ops::Deref for AgentDataService {
    type Target = MoveVisibility;
    fn deref(&self) -> &Self::Target {
        &self.visibility
    }
}

impl AgentDataService {
    #[allow(clippy::too_many_arguments)]
    fn validate_images(
        &self,
        cut: &Cut,
        cut_id: &str,
        header: &Header,
        dir: &Path,
        phase: &str,
        mover: &MoveStore,
        reason: &str,
    ) -> Result<(), ErrorBody> {
        for (i, half) in header.halves.iter().enumerate() {
            let install = internal_cut(cut_id, &half.session, &format!("{phase}-install"));
            let complete = cut.installed.contains(&install)
                || matches!(
                    mover.cut_state(&install).map_err(storage)?.as_deref(),
                    Some("installed" | "activated")
                );
            if complete {
                continue;
            }
            for (side, expected) in [
                ("context", &half.context_digest),
                ("module", &half.module_digest),
            ] {
                let path = dir.join(format!("{side}-{i}.bin"));
                if snapshot::file_digest(&path).as_ref() != Ok(expected) {
                    let key = format!("{cut_id}:{reason}");
                    if self
                        .corruption_warned
                        .lock()
                        .expect("move corruption warnings")
                        .insert(key)
                    {
                        tracing::error!(cut_id,reason,session=%half.session,store=side,"move image is corrupt; preserve the preimages and repair or abort the move");
                    }
                    return Err(ErrorBody::with_digest_mismatch_detail(
                        role::errors::DigestMismatchDetail::new(reason),
                        format!("{reason}: {side} image does not match its saved digest"),
                    ));
                }
            }
        }
        Ok(())
    }
}
