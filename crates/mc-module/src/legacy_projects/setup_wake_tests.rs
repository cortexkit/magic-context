//! A Setup that names a project id this process hasn't seen wakes the
//! rounds that move a 0.49 store's project rows.

use std::time::Duration;

use cortexkit_role_compaction::read::{Head, ReadPage, ReadRequest, SessionRef};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};

use crate::client::{Child, ClientError, RunnerClient};
use crate::module::Module;
use crate::pass::Settings;
use crate::route::{Project, Route};
use crate::routing::Router;
use crate::store::Store;

/// A runner whose transcript is empty and which takes every view.
struct Client;

impl RunnerClient for Client {
    async fn read(&self, _: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        Ok(ReadPage::new(vec![], Head::new()))
    }

    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        Ok(ApplyViewAnswer::Accepted)
    }

    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        Ok(AppliedViewAnswer::default())
    }

    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError::new("no reminders here"))
    }

    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError::new("no summarizer here"))
    }

    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        Err(ClientError::new("no summarizer here"))
    }
}

impl Router for Client {
    async fn select(
        &self,
        _: cortexkit_role_routing::select::SelectRequest,
    ) -> Result<cortexkit_role_routing::select::SelectAnswer, crate::routing::RouteError> {
        unreachable!("a worker preset runs no summarizer")
    }

    async fn report(&self, _: cortexkit_role_routing::report::ReportRequest) {}
}

fn setup(module: &Module<Client>, session: &str, project: &str) {
    let route = Route {
        session: SessionRef::new("runner", "mock", session),
        project: Some(Project {
            id: project.to_owned(),
            root: "/nonexistent/legacy-projects-wake".to_owned(),
        }),
        workdir: None,
        agent_id: None,
    };
    let request = SetupRequest::new(
        "worker",
        ModelRef::new("test", "model"),
        100_000,
        1000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
        vec![],
        1,
    );
    module.setup(route, request).unwrap();
}

async fn woken(module: &Module<Client>) -> bool {
    tokio::time::timeout(
        Duration::from_millis(200),
        module.legacy_wake().notify.notified(),
    )
    .await
    .is_ok()
}

#[tokio::test]
async fn a_setup_naming_a_new_project_id_wakes_the_rounds() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("mode3.db")).unwrap();
    let module = Module::new(Client, Settings::default(), None, Some(store));
    setup(&module, "s1", "pj-first");
    assert!(woken(&module).await, "a new project id wakes a round");
    setup(&module, "s2", "pj-first");
    assert!(!woken(&module).await, "a known project id doesn't");
    setup(&module, "s3", "pj-second");
    assert!(woken(&module).await);
}
