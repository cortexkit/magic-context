//! A runner may answer a run-starting send as soon as it has stored it,
//! before the prompt reaches its host: `pending` with the run's id
//! (llm-runner 0.8.53). The summary send follows that run like an active one.

use super::*;
use crate::client::ClientError;
use cortexkit_role_compaction::read::{ReadPage, ReadRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::send::SendReply;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Answers every send `pending` with a run id, and reports that run
/// `pending` for its first `results_pending` reads, then `completed`.
struct Client {
    results_pending: usize,
    reads: AtomicUsize,
}

impl RunnerClient for Client {
    async fn read(&self, _: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        unreachable!()
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        unreachable!()
    }
    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        unreachable!()
    }
    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        unreachable!()
    }
    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        let mut reply = SendReply::new(send_states::PENDING);
        reply.run_id = Some("run".into());
        Ok(reply)
    }
    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        let read = self.reads.fetch_add(1, Ordering::SeqCst);
        let state = if read < self.results_pending {
            send_states::PENDING
        } else {
            states::COMPLETED
        };
        Ok(RunResult::new("run", state))
    }
}

fn child() -> Child {
    Child {
        session: SessionRef::new("pending-send-test", "mock", "summary-child"),
        project_root: Some("/project".into()),
    }
}

#[tokio::test(start_paused = true)]
async fn a_send_answered_pending_with_a_run_id_is_followed_to_its_end() {
    let client = Client {
        results_pending: 2,
        reads: AtomicUsize::new(0),
    };
    let model = ModelRef::new("provider", "model");
    let how = Model {
        model: &model,
        decision_id: "decision",
        output_tokens: 1000,
        system: "system",
        deadline: tokio::time::Instant::now() + Duration::from_secs(60),
        continuation: false,
        creates_child: true,
        attribution: None,
        keep_child: false,
        cache_ttl: cortexkit_role_llm_runner::cache::Ttl::None,
        send: SendKind::TurnOne,
        plan: None,
    };
    send_and_wait(&client, &child(), "first", "prompt", &how, &mut None)
        .await
        .unwrap();
    // Two reads saw the run still pending; the third saw it end.
    assert_eq!(client.reads.load(Ordering::SeqCst), 3);
}
