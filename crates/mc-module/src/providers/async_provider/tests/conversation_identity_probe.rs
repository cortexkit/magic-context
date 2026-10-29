//! A runner conversation is keyed on (runner, harness, session), never on the
//! project folder (compaction-provider contract §1). These tests drive
//! compaction-provider's own probe against the async provider and pin the
//! sites that look a conversation up from a route.
use super::*;
#[cfg(unix)]
use cortexkit_role_compaction_provider::conformance::{
    conversation_state_ignores_project_root, StateProbe, CASE_NAME,
};
#[cfg(unix)]
use std::collections::BTreeSet;

#[cfg(unix)]
const PARAMS: &str = r#"{"serializer_profile":"opencode-aisdk"}"#;

/// The attested session-runner module the probe's runner id stands for. The
/// provider admits only real session-runner modules, so the probe's two
/// runners are two of those; the id still reaches the provider only as the
/// route's daemon-stamped principal.
#[cfg(unix)]
fn attested_module(probe_runner: &str) -> Result<&'static str, String> {
    match probe_runner {
        "runner-a" => Ok(crate::route_targets::DEFAULT_RUNNER_MODULE_ID),
        "runner-b" => Ok(crate::route_targets::DEFAULT_THALAMUS_MODULE_ID),
        other => Err(format!("no attested runner connection for {other}")),
    }
}

/// Make `/var/probe-project` and `/private/var/probe-project` spell one
/// folder under `base`, as they do on macOS: `var` links to `private/var`.
#[cfg(unix)]
fn folder_aliases(base: &Path) {
    std::fs::create_dir_all(base.join("private/var/probe-project")).unwrap();
    std::os::unix::fs::symlink("private/var", base.join("var")).unwrap();
}

/// The probe's absolute folder spelling, placed under `base` without
/// resolving it, so each spelling reaches the provider as a distinct string.
#[cfg(unix)]
fn spelled(base: &Path, folder: &str) -> PathBuf {
    base.join(folder.trim_start_matches('/'))
}

#[cfg(unix)]
fn setup_params(harness: &str, session: &str, request_id: &str) -> Value {
    json!({
        "session": session,
        "harness": harness,
        "request_id": request_id,
        "model": "fixture",
        "context_window": 100_000,
        "composition": {"render_tags": true},
        "params": serde_json::from_str::<Value>(PARAMS).unwrap(),
        "lineage_id": "L",
        "now": 1
    })
}

/// Bind a route under `module`'s attested principal, with `project_root` as
/// its folder and a generic shared-route harness and session.
#[cfg(unix)]
fn bind_runner_route(rig: &Rig, channel: u16, module: &str, project_root: &Path, session: &str) {
    let mut binding = rig.h.facade_binding(7).unwrap();
    binding.principal = Some(subc_protocol::Principal::Reserved {
        module_id: module.into(),
    });
    binding.project_root = project_root.to_path_buf();
    binding.harness = session_resolver::RUNNER_BIND_HARNESS.into();
    binding.session = session.into();
    rig.h.bind_route(channel, binding);
}

#[cfg(unix)]
struct Adapter {
    base: PathBuf,
    rig: Rig,
    channel: u16,
}

#[cfg(unix)]
impl Adapter {
    async fn new(base: &Path) -> Self {
        folder_aliases(base);
        // The rig's own conversation is unrelated to the probe's session.
        let rig = Rig::setup_with_model(
            base,
            crate::route_targets::DEFAULT_RUNNER_MODULE_ID,
            ("runner", "bootstrap"),
            ("broca", "bootstrap"),
            "fixture",
            serde_json::from_str(PARAMS).unwrap(),
            |_| {},
        )
        .await;
        Self {
            base: base.into(),
            rig,
            channel: 20,
        }
    }

    /// The primary keys of the provider's stored records for `session`.
    fn stored_refs(&self, session: &str) -> Result<BTreeSet<String>, String> {
        let conn =
            rusqlite::Connection::open(self.base.join("store.db")).map_err(|e| e.to_string())?;
        let mut query = conn
            .prepare("SELECT session_ref FROM mc_async_compaction WHERE session=?1")
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([session], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())
    }
}

#[cfg(unix)]
impl StateProbe for Adapter {
    fn setup_and_state_marker(
        &mut self,
        runner_module_id: &str,
        harness: &str,
        session: &str,
        project_root: &str,
    ) -> Result<String, String> {
        let module = attested_module(runner_module_id)?;
        let before = self.stored_refs(session)?;
        self.channel += 1;
        let channel = self.channel;
        bind_runner_route(
            &self.rig,
            channel,
            module,
            &spelled(&self.base, project_root),
            "",
        );
        let outcome = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(self.rig.h.dispatch_value(
                channel,
                json!({"method":"compaction.setup","params":setup_params(harness, session, &format!("probe-{channel}"))}),
            ))
        });
        let HandlerOutcome::Response(bytes) = outcome else {
            return Err(format!("Setup was not answered: {outcome:?}"));
        };
        let answer: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if answer["answer"] != "ready" {
            return Err(format!("Setup was not ready: {answer}"));
        }
        // The marker is the stored record the Setup created or, when it
        // created none, the one record it reused for this session.
        let after = self.stored_refs(session)?;
        let created: Vec<_> = after.difference(&before).cloned().collect();
        match (created.as_slice(), after.len()) {
            ([created], _) => Ok(created.clone()),
            ([], 1) => Ok(after.into_iter().next().unwrap()),
            _ => Err(format!(
                "cannot tell which record the Setup reached: before {before:?}, after {after:?}"
            )),
        }
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conversation_state_ignores_project_root_probe_passes() {
    let base = tempfile::tempdir().unwrap();
    let mut adapter = Adapter::new(base.path()).await;
    conversation_state_ignores_project_root(&mut adapter).unwrap_or_else(|failure| {
        assert!(failure.starts_with(CASE_NAME), "{failure}");
        panic!("{failure}")
    });
}

/// The stored reference is the shared derivation over the attested
/// principal's bare module id. A `reserved:`-prefixed id names a different
/// session, so a runner deriving the reference from its own id would never
/// find the provider's views.
#[tokio::test]
async fn conversation_reference_uses_the_bare_attested_module_id() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "thalamus",
        "claude-code",
        json!({"serializer_profile":"anthropic-messages"}),
    )
    .await;
    let bare = runner_session_ref("thalamus", "claude-code", "s");
    let state = load(rig.h.store.get().unwrap(), &bare)
        .unwrap()
        .expect("the record is stored under the bare module id's reference");
    assert_eq!(state.reference(), bare);
    assert_eq!(state.key.runner, "thalamus");
    assert_ne!(
        bare,
        runner_session_ref("reserved:thalamus", "claude-code", "s")
    );
}

/// A tool or flush call on a route with another spelling of the folder still
/// reaches the conversation: route lookups use the attested runner and the
/// session, like Setup's key. A different runner reaches nothing.
#[cfg(unix)]
#[tokio::test]
async fn route_lookups_reach_the_conversation_through_another_folder_spelling() {
    let base = tempfile::tempdir().unwrap();
    folder_aliases(base.path());
    let original = spelled(base.path(), "/var/probe-project");
    let rig = Rig::open(
        &original,
        "broca",
        "opencode",
        serde_json::from_str(PARAMS).unwrap(),
    )
    .await;
    let namespace = rig.state().namespace();

    bind_runner_route(
        &rig,
        30,
        "broca",
        &spelled(base.path(), "/private/var/probe-project"),
        "s",
    );
    let alias = rig.h.facade_binding(30).unwrap();
    assert_eq!(
        rig.h.async_compaction_namespace(&alias, true).unwrap(),
        Some(namespace)
    );

    bind_runner_route(&rig, 31, "thalamus", &original, "s");
    let other_runner = rig.h.facade_binding(31).unwrap();
    assert_eq!(
        rig.h
            .async_compaction_namespace(&other_runner, true)
            .unwrap(),
        None
    );
}

/// A route with no attested runner (a Claude Code MCP facade) reaches the
/// conversation by its session only from the exact folder Setup's route
/// carried. The same session from any other folder finds nothing.
#[tokio::test]
async fn a_route_without_a_runner_reaches_the_session_only_from_setups_folder() {
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "thalamus",
        "claude-code",
        json!({"serializer_profile":"anthropic-messages"}),
    )
    .await;
    let namespace = rig.state().namespace();
    rig.bind(8, "claude-code", "s");
    let same_folder = rig.h.facade_binding(8).unwrap();
    assert_eq!(
        rig.h
            .async_compaction_namespace(&same_folder, true)
            .unwrap(),
        Some(namespace)
    );
    let mut elsewhere = same_folder;
    elsewhere.project_root = other.path().to_path_buf();
    rig.h.bind_route(9, elsewhere);
    let elsewhere = rig.h.facade_binding(9).unwrap();
    assert_eq!(
        rig.h.async_compaction_namespace(&elsewhere, true).unwrap(),
        None
    );
}
