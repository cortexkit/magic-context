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

use std::sync::Arc;

use mc_module::agent_data::Journal;
use mc_module::child_scopes::ChildScopes;
use mc_module::config::{Config, Loader};
use mc_module::context_db::ContextDb;
use mc_module::module::Module;
use mc_module::storage_paths::{context_db_path, store_path};
use mc_module::store::Store;
use mc_module::transport::{manifest_for, Handler, SubcRunnerClient};

const DEFAULT_MODULE_ID: &str = mc_module::MODULE_ID;

fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    if std::env::args().nth(1).as_deref() == Some("tag-floor") {
        return tag_floor();
    }
    if std::env::args().skip(1).any(|arg| arg == "--version") {
        println!("{}", mc_module::version_line());
        return Ok(());
    }
    if std::env::args().skip(1).any(|arg| arg == "--print-fences") {
        println!(
            "context.db={} mode3.db={}",
            mc_module::context_db::SCHEMA_VERSION,
            mc_module::store::SCHEMA_VERSION
        );
        return Ok(());
    }
    #[cfg(unix)]
    nix::sys::stat::umask(nix::sys::stat::Mode::from_bits_truncate(0o077));
    if std::env::args().nth(1).as_deref() == Some("rekey-runner") {
        return rekey_runner();
    }
    // Read and close the inherited pipe carrying the daemon's launch nonce before
    // initialization can spawn helpers that would inherit the pipe too.
    let _ = subc_client_rs::launch_nonce();
    let logger = match cortexkit_log::init_from_env() {
        Ok(logger) => logger,
        Err(cortexkit_log::InitError::ModuleIdNotInEnvironment) => {
            let logger = cortexkit_log::init(cortexkit_log::Config::for_module(DEFAULT_MODULE_ID))?;
            tracing::info!("SUBC_MODULE_ID absent; using magic-context for local module logging");
            logger
        }
        Err(error) => return Err(error.into()),
    };
    tracing::info!("mc-module: logger initialized");
    let log_permissions = mc_module::private_permissions::tighten_tree(logger.logs_dir());
    tracing::info!(
        tightened = log_permissions.tightened,
        failures = log_permissions.failures,
        "mc-module: log permission tightening"
    );
    if std::env::args().nth(1).as_deref() == Some("move-in") {
        return move_in();
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(serve())
}

async fn serve() -> Result<(), Box<dyn Error + Send + Sync>> {
    let connection_file = subc_arg().ok_or("missing --subc <connection-file>")?;
    let module_id = std::env::var(subc_protocol::SUBC_MODULE_ID_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODULE_ID.to_owned());
    let context_path = context_db_path();
    let db = open_context_db(&context_path)?;
    let store = Store::open(&store_path(&context_path))?;
    // Moves are enforced in every build: the journal is read before any
    // session is served, so a session a move holds is refused from the
    // first request on. Serving new moves is a separate switch.
    let agent_data = mc_module::agent_data::switch_from_environment();
    let journal = Arc::new(Journal::load(mc_module::agent_data::journal::path(
        &context_path,
    )));
    journal.log_held(agent_data);
    if let Some(data_dir) = context_path.parent() {
        let _ = mc_module::engram_catalog::write_catalog_at_startup(data_dir);
    }
    let child_scopes = Arc::new(ChildScopes::new(module_id.clone()));
    let module = Module::with_journal(
        SubcRunnerClient::new(connection_file.clone(), Arc::clone(&child_scopes)),
        Config::Files(Loader::from_environment()),
        Some(db),
        Some(store),
        journal,
        agent_data,
    );
    module.spawn_upkeep();
    module.spawn_memory_sync();
    let (handle, serve) = subc_client_rs::serve_with_handle(
        &connection_file,
        manifest_for(&module_id, agent_data),
        Handler::new(module.clone()),
    )
    .await?;
    // ck-mc's child scopes are published through its serving connection.
    child_scopes.install(handle);
    let result = serve.await;
    module.flush_app_snapshots().await;
    result?;
    Ok(())
}

fn move_in() -> Result<(), Box<dyn Error + Send + Sync>> {
    let context_path = context_db_path();
    let db = open_context_db(&context_path)?;
    let store = Store::open(&store_path(&context_path))?;
    let request: mc_module::move_in::MoveRequest = serde_json::from_reader(std::io::stdin())?;
    // The session's rows are rewritten under both the harness it runs as and
    // the one the plugin kept it under; a move holding either is refused.
    let source_harness = request
        .source_harness
        .as_deref()
        .unwrap_or(&request.session.harness);
    let source_session = request
        .source_session
        .as_deref()
        .unwrap_or(&request.session.session);
    mc_module::agent_data::refuse_offline(
        &context_path,
        [
            (
                request.session.harness.as_str(),
                request.session.session.as_str(),
            ),
            (source_harness, source_session),
        ],
    )?;
    let moved = mc_module::move_in::move_in(
        db,
        &store,
        &Config::Files(Loader::from_environment()),
        &request,
    )?;
    println!("{}", serde_json::to_string(&moved)?);
    Ok(())
}

fn rekey_runner() -> Result<(), Box<dyn Error + Send + Sync>> {
    let args: Vec<String> = std::env::args().skip(2).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{}", mc_module::rekey::HELP);
        return Ok(());
    }
    let request = mc_module::rekey::Request::parse(args)?;
    let context = context_db_path();
    mc_module::agent_data::refuse_offline(
        &context,
        request
            .sessions
            .iter()
            .map(|session| (request.harness.as_str(), session.as_str())),
    )?;
    let summary = mc_module::rekey::rekey_runner(&store_path(&context), &context, &request)?;
    println!("{}", serde_json::to_string(&summary)?);
    Ok(())
}

fn tag_floor() -> Result<(), Box<dyn Error + Send + Sync>> {
    const HELP: &str = "Usage: ck-mc tag-floor --harness <harness> --session <session id>";
    let args: Vec<String> = std::env::args().skip(2).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{HELP}");
        return Ok(());
    }
    let usage = || -> ! {
        eprintln!("{HELP}");
        std::process::exit(2);
    };
    let (mut harness, mut session) = (None, None);
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let slot = match arg.as_str() {
            "--harness" => &mut harness,
            "--session" => &mut session,
            _ => usage(),
        };
        let value = args
            .next()
            .filter(|value| !value.is_empty() && !value.starts_with('-'))
            .unwrap_or_else(|| usage());
        if slot.replace(value).is_some() {
            usage();
        }
    }
    let harness = harness.unwrap_or_else(|| usage());
    let session = session.unwrap_or_else(|| usage());
    let path = context_db_path();
    if !path.try_exists()? {
        return Err("Magic Context has no context.db. Run `npx @cortexkit/magic-context doctor store init`, then restart ck-mc.".into());
    }
    // ContextDb startup writes to the shared store. Move preparation needs
    // this read without module startup or opening mode3.db.
    let conn =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let (tag_floor, tags) = mc_module::move_in::tag_floor(&conn, &harness, &session)?;
    println!(
        "{}",
        serde_json::json!({"harness": harness, "session": session, "tag_floor": tag_floor, "tags": tags})
    );
    Ok(())
}

fn open_context_db(path: &std::path::Path) -> Result<ContextDb, Box<dyn Error + Send + Sync>> {
    if !path.exists() {
        return Err("Magic Context has no context.db. Run `npx @cortexkit/magic-context doctor store init`, then restart ck-mc.".into());
    }
    Ok(ContextDb::open(path)?)
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
