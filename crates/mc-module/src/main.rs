//! ck-mc: serve Magic Context's compaction provider over the subc daemon.

#![forbid(unsafe_code)]

use std::error::Error;
use std::path::PathBuf;

use mc_module::module::Module;
use mc_module::pass::Settings;
use mc_module::transport::{manifest, Handler, SubcRunnerClient};

const DEFAULT_MODULE_ID: &str = "magic-context";

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    // Before anything could start a child that would inherit the launch
    // nonce's descriptor.
    let _ = subc_client_rs::launch_nonce();
    let connection_file = subc_arg().ok_or("missing --subc <connection-file>")?;
    let module_id = std::env::var(subc_protocol::SUBC_MODULE_ID_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODULE_ID.to_owned());
    let module = Module::new(
        SubcRunnerClient::new(connection_file.clone()),
        Settings::default(),
    );
    let (_handle, serve) = subc_client_rs::serve_with_handle(
        &connection_file,
        manifest(&module_id),
        Handler::new(module),
    )
    .await?;
    serve.await?;
    Ok(())
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
