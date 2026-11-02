//! ck-mc: serve Magic Context's compaction provider over the subc daemon.
//!
//! `ck-mc move-in` instead moves one session that ran under the standalone
//! plugin to a runner, where ck-mc manages it (see `mc_module::move_in`): it
//! reads the request as JSON on standard input and prints the first view and
//! tag checkpoint for the runner's own move. Run it with ck-mc and the
//! session's host stopped.

#![forbid(unsafe_code)]

use std::error::Error;
use std::path::PathBuf;

use mc_module::config::{Config, Loader};
use mc_module::context_db::ContextDb;
use mc_module::module::Module;
use mc_module::store::Store;
use mc_module::transport::{manifest, Handler, SubcRunnerClient};

const DEFAULT_MODULE_ID: &str = "magic-context";

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    if std::env::args().nth(1).as_deref() == Some("move-in") {
        return move_in();
    }
    // Before anything could start a child that would inherit the launch
    // nonce's descriptor.
    let _ = subc_client_rs::launch_nonce();
    let connection_file = subc_arg().ok_or("missing --subc <connection-file>")?;
    let module_id = std::env::var(subc_protocol::SUBC_MODULE_ID_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODULE_ID.to_owned());
    let db = match context_db_path() {
        Some(path) => Some(ContextDb::open(&path)?),
        None => None,
    };
    let store = match store_path() {
        Some(path) => Some(Store::open(&path)?),
        None => None,
    };
    let module = Module::new(
        SubcRunnerClient::new(connection_file.clone()),
        Config::Files(Loader::from_environment()),
        db,
        store,
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

fn move_in() -> Result<(), Box<dyn Error + Send + Sync>> {
    let request: mc_module::move_in::MoveRequest = serde_json::from_reader(std::io::stdin())?;
    let db = ContextDb::open(&context_db_path().ok_or("move-in needs MAGIC_CONTEXT_DB")?)?;
    let store = Store::open(&store_path().ok_or("move-in needs MAGIC_CONTEXT_MODE3_STORE")?)?;
    let moved = mc_module::move_in::move_in(
        db,
        &store,
        &Config::Files(Loader::from_environment()),
        &request,
    )?;
    println!("{}", serde_json::to_string(&moved)?);
    Ok(())
}

/// `context.db`, named by `MAGIC_CONTEXT_DB`. Without it summaries are kept in
/// memory only, which only throwaway test runs want.
fn context_db_path() -> Option<PathBuf> {
    std::env::var_os("MAGIC_CONTEXT_DB")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// ck-mc's own store, named by `MAGIC_CONTEXT_MODE3_STORE`. Without it a
/// restart forgets queued drops and re-renders history heads.
fn store_path() -> Option<PathBuf> {
    std::env::var_os("MAGIC_CONTEXT_MODE3_STORE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
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
