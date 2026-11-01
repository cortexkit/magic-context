//! ck-mock-runner: the mock runner as a module of the subc daemon, for
//! testing a compaction provider over the real wire. A test calls its
//! `mock.play` op with a session config and a script, and gets the run's
//! report back.

#![forbid(unsafe_code)]

use std::error::Error;
use std::path::PathBuf;

use mc_mock_runner::subc::{manifest, Handler};

const DEFAULT_MODULE_ID: &str = "mock-runner";
/// Names the compaction provider module the runner calls.
const PROVIDER_ENV: &str = "MOCK_RUNNER_PROVIDER";
const DEFAULT_PROVIDER: &str = "magic-context";

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    // Before anything could start a child that would inherit the launch
    // nonce's descriptor.
    let _ = subc_client_rs::launch_nonce();
    let connection_file = subc_arg().ok_or("missing --subc <connection-file>")?;
    let module_id = env_or(subc_protocol::SUBC_MODULE_ID_ENV, DEFAULT_MODULE_ID);
    let provider = env_or(PROVIDER_ENV, DEFAULT_PROVIDER);
    let (_handle, serve) = subc_client_rs::serve_with_handle(
        &connection_file,
        manifest(&module_id),
        Handler::new(connection_file.clone(), provider),
    )
    .await?;
    serve.await?;
    Ok(())
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default.to_owned())
}

fn subc_arg() -> Option<PathBuf> {
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--subc" {
            return args.next().map(PathBuf::from);
        }
    }
    None
}
