//! Hermetic control-plane responsiveness probe: real MC dispatch with a deliberate
//! synchronous delay. This example is never built into the production module.

use mc_module::{manifest, McHandler, McTransportHandler, DEFAULT_MODULE_ID};
use std::{path::PathBuf, time::Duration};
use subc_client_rs::{
    async_trait, HandlerOutcome, HealthReport, ModuleHandler, RequestCtx, RouteBindRequest,
    RouteHandle,
};
use subc_protocol::ModuleHelloAckBody;

struct SlowMc(McHandler);

#[async_trait]
impl ModuleHandler for SlowMc {
    async fn on_hello_ack(&self, ack: &ModuleHelloAckBody) {
        self.0.on_hello_ack(ack).await;
    }
    async fn on_bind(&self, req: &RouteBindRequest) -> subc_client_rs::BindDecision {
        self.0.on_bind(req).await
    }
    async fn on_route_gone(&self, handle: &RouteHandle) {
        self.0.on_route_gone(handle).await;
    }
    async fn health(&self) -> HealthReport {
        self.0.health().await
    }
    async fn handle(&self, ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome {
        std::thread::sleep(Duration::from_secs(2));
        self.0.handle(ctx, body).await
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut args = std::env::args().skip(1);
    assert_eq!(args.next().as_deref(), Some("--subc"));
    let connection = PathBuf::from(args.next().expect("connection file"));
    subc_client_rs::serve_with(
        &connection,
        manifest(DEFAULT_MODULE_ID),
        McTransportHandler::new(SlowMc(McHandler::new_with_connection_file(Some(
            connection.clone(),
        )))),
    )
    .await?;
    Ok(())
}
