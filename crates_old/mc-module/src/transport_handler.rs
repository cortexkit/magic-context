//! Keep synchronous store and encoding work off the module's control-plane runtime.

use crate::{
    reply_pages::{accepts_reply_pages, bound_health, ReplyPages},
    McHandler,
};
use std::{
    sync::{Arc, Mutex},
    time::SystemTime,
};
use subc_client_rs::{
    async_trait, ConnectionEnd, HandlerOutcome, HealthReport, ModuleHandler, RequestCtx,
    RouteBindRequest, RouteCloseReason, RouteHandle,
};
use subc_protocol::ModuleHelloAckBody;

/// Production SDK adapter: dispatch runs on the blocking pool; health and route
/// lifecycle hooks remain on the control-plane runtime.
pub struct McTransportHandler<H: ModuleHandler = McHandler> {
    inner: Arc<H>,
    replies: Arc<Mutex<ReplyPages>>,
}

impl<H: ModuleHandler> McTransportHandler<H> {
    pub fn new(inner: H) -> Self {
        Self {
            inner: Arc::new(inner),
            replies: Arc::new(Mutex::new(ReplyPages::default())),
        }
    }

    async fn remove_reply_channel(&self, channel: u16) {
        let replies = Arc::clone(&self.replies);
        let _ = tokio::task::spawn_blocking(move || {
            replies
                .lock()
                .expect("reply pages mutex")
                .remove_channel(channel);
        })
        .await;
    }
}

#[async_trait]
impl<H: ModuleHandler> ModuleHandler for McTransportHandler<H> {
    async fn on_hello_ack(&self, ack: &ModuleHelloAckBody) {
        self.inner.on_hello_ack(ack).await;
    }
    async fn on_bind(&self, req: &RouteBindRequest) -> subc_client_rs::BindDecision {
        self.remove_reply_channel(req.handle.channel).await;
        self.inner.on_bind(req).await
    }
    async fn on_route_gone(&self, handle: &RouteHandle) {
        self.remove_reply_channel(handle.channel).await;
        self.inner.on_route_gone(handle).await;
    }
    async fn on_bound(&self, handle: &RouteHandle) {
        self.inner.on_bound(handle).await;
    }
    async fn on_draining(&self, reason: RouteCloseReason, deadline: SystemTime) {
        self.inner.on_draining(reason, deadline).await;
    }
    async fn on_connection_end(&self, end: ConnectionEnd) {
        self.inner.on_connection_end(end).await;
    }
    async fn health(&self) -> HealthReport {
        // The SDK sends health outside the ordinary data-response adapter.
        bound_health(self.inner.health().await)
    }
    async fn handle(&self, ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome {
        // A held-open subscription must not occupy a blocking-pool thread for
        // its lifetime. Its handler moves only setup/snapshot work off-runtime.
        if crate::app_read::watch::is_watch(&body) {
            return self.inner.handle(ctx, body).await;
        }
        let inner = Arc::clone(&self.inner);
        let replies = Arc::clone(&self.replies);
        let runtime = tokio::runtime::Handle::current();
        let route = ctx.route_handle();
        let channel = (route.channel, route.epoch);
        match tokio::task::spawn_blocking(move || {
            if let Ok(request) =
                serde_json::from_slice::<serde_json::Value>(if body.len() <= 1024 {
                    &body
                } else {
                    b"null"
                })
            {
                if request.get("method").and_then(|v| v.as_str()) == Some("reply.page") {
                    if let (Some(id), Some(index)) = (
                        request.get("reply_page_id").and_then(|v| v.as_str()),
                        request
                            .get("reply_page_index")
                            .and_then(|v| v.as_u64())
                            .and_then(|n| usize::try_from(n).ok()),
                    ) {
                        return replies
                            .lock()
                            .expect("reply pages mutex")
                            .page(channel, id, index);
                    }
                    return HandlerOutcome::Error {
                        code: "bad_request".into(),
                        message: "invalid reply page request".into(),
                    };
                }
            }
            // The current-thread runtime must keep reading control frames while a
            // transform synchronously projects history, accesses SQLite and encodes JSON.
            let accept_reply_pages = accepts_reply_pages(&body);
            let outcome = runtime.block_on(inner.handle(ctx, body));
            replies
                .lock()
                .expect("reply pages mutex")
                .bound(channel, outcome, accept_reply_pages)
        })
        .await
        {
            Ok(outcome) => outcome,
            Err(error) => HandlerOutcome::Error {
                code: "dispatch_failed".into(),
                message: error.to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use subc_client_rs::HealthStatus;

    struct HealthFixture(HealthReport);
    #[async_trait]
    impl ModuleHandler for HealthFixture {
        async fn health(&self) -> HealthReport {
            self.0.clone()
        }
        async fn handle(&self, _: RequestCtx, _: Vec<u8>) -> HandlerOutcome {
            HandlerOutcome::Error {
                code: "unused".into(),
                message: "health fixture".into(),
            }
        }
    }

    #[tokio::test]
    async fn oversized_health_is_bounded_through_the_real_transport_adapter() {
        for status in [HealthStatus::Ok, HealthStatus::Failing] {
            let original = HealthReport {
                status,
                detail: None,
                metrics: Some(serde_json::json!({"runner_choices":"x".repeat(4*1024*1024)})),
            };
            assert!(
                serde_json::to_vec(&original).unwrap().len() + subc_protocol::HEADER_LEN
                    > 4 * 1024 * 1024
            );
            let report = McTransportHandler::new(HealthFixture(original))
                .health()
                .await;
            assert!(
                serde_json::to_vec(&report).unwrap().len() + subc_protocol::HEADER_LEN
                    < 4 * 1024 * 1024
            );
            assert!(report.detail.unwrap().starts_with("frame_too_large"));
            assert!(report.metrics.is_none());
            assert_eq!(
                report.status,
                if status == HealthStatus::Failing {
                    HealthStatus::Failing
                } else {
                    HealthStatus::Degraded
                }
            );
        }
    }

    #[tokio::test]
    async fn ordinary_health_remains_byte_identical_through_transport() {
        let original = HealthReport {
            metrics: Some(serde_json::json!({"async_bus": null})),
            ..HealthReport::ok()
        };
        let report = McTransportHandler::new(HealthFixture(original.clone()))
            .health()
            .await;
        assert_eq!(
            serde_json::to_vec(&report).unwrap(),
            serde_json::to_vec(&original).unwrap()
        );
    }
}
