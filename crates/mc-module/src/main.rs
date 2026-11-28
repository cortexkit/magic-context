//! ck-mc: serve Magic Context's compaction provider over the subc daemon.
//!
//! `ck-mc move-in` instead moves one session that ran under the standalone
//! plugin to a runner, where ck-mc manages it (see `mc_module::move_in`): it
//! reads the request as JSON on standard input and prints the first view and
//! tag checkpoint for the runner's own move. Run it with ck-mc and the
//! session's host stopped.

#![forbid(unsafe_code)]

use std::error::Error;
use std::fmt;
use std::path::PathBuf;
use std::process::ExitCode;

use std::sync::Arc;

use mc_module::agent_data::Journal;
use mc_module::child_scopes::ChildScopes;
use mc_module::config::{Config, Loader};
use mc_module::context_db::ContextDb;
use mc_module::module::{build_dreamer_runtime, Module};
use mc_module::storage_paths::{context_db_path, store_path};
use mc_module::store::Store;
use mc_module::transport::{manifest_for, Handler, SubcRunnerClient};

const DEFAULT_MODULE_ID: &str = mc_module::MODULE_ID;

/// An error that names a store path a person may need to copy from stderr.
struct CliPathRefusal(String);

impl fmt::Display for CliPathRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl fmt::Debug for CliPathRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // A Result returned from main prints its error with Debug. Keep the
        // quotes and control-character escapes, but let Windows paths be copied.
        #[cfg(windows)]
        {
            formatter.write_str(&format!("{:?}", self.0).replace("\\\\", "\\"))
        }
        #[cfg(not(windows))]
        {
            fmt::Debug::fmt(&self.0, formatter)
        }
    }
}

impl Error for CliPathRefusal {}

fn main() -> Result<ExitCode, Box<dyn Error + Send + Sync>> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() == Some(std::ffi::OsStr::new("doctor")) {
        #[cfg(unix)]
        return Ok(mc_module::doctor::run(&args.collect::<Vec<_>>()));
        #[cfg(not(unix))]
        {
            eprintln!("ck-mc doctor is not available on this platform yet.");
            return Ok(ExitCode::from(2));
        }
    }
    run_module_cli().map(|()| ExitCode::SUCCESS)
}

fn run_module_cli() -> Result<(), Box<dyn Error + Send + Sync>> {
    // Development tool: run an experiment in the already running module,
    // without starting a second module or opening a context store here.
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("lab")) {
        match lab_run() {
            Ok(folder) => println!("{folder}"),
            Err(error) => {
                eprintln!("ck-mc lab run: {error}");
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("tag-floor") {
        return tag_floor();
    }
    if std::env::args().skip(1).any(|arg| arg == "--version") {
        println!("{}", mc_module::version_line());
        return Ok(());
    }
    if std::env::args().skip(1).any(|arg| arg == "--print-fences") {
        println!(
            "context.db={} sessions.db={}",
            mc_module::context_db::SCHEMA_VERSION,
            mc_module::store::SCHEMA_VERSION
        );
        return Ok(());
    }
    if std::env::args()
        .skip(1)
        .any(|arg| arg == "--print-tool-pins")
    {
        for line in mc_module::catalog::pin_report() {
            println!("{line}");
        }
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
    let module = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let dreamer = build_dreamer_runtime()?;
    let result = module.block_on(serve(dreamer.handle()));
    // Stop maintenance while the runtime that owns its lease watches and
    // transport is still alive. Unfinished runs are recovered on startup.
    drop(dreamer);
    result
}

fn lab_run() -> Result<String, String> {
    use serde_json::json;
    use subc_client_rs::{CallError, CallOptions, ConsumerOptions, SubcConsumer};
    use subc_protocol::{BindIdentity, RouteTarget};

    let mut args = std::env::args_os().skip(2);
    let verb = args.next();
    let spec = args.next().map(PathBuf::from);
    if verb.as_deref() != Some(std::ffi::OsStr::new("run"))
        || spec.is_none()
        || args.next().is_some()
    {
        return Err("expected run followed by an absolute spec path".into());
    }
    let spec = spec.expect("checked spec argument");
    if !spec.is_absolute() {
        return Err("spec path must be absolute".into());
    }
    let spec = spec.to_str().ok_or("spec path must be UTF-8")?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "could not start the local daemon client")?;
    runtime.block_on(async {
        let consumer = SubcConsumer::connect_default_local(ConsumerOptions::default())
            .await
            .map_err(|_| "could not connect to the local daemon socket")?;
        let request = serde_json::to_vec(&json!({"method":"commands.run","params":{
            "id":"dreamer_lab_run","args":{"spec":spec}
        }}))
        .expect("lab command serializes");
        let reply = consumer
            .call(
                RouteTarget::ManagementSurface {
                    module_id: DEFAULT_MODULE_ID.to_owned(),
                },
                BindIdentity::new("ck-mc-lab", "operator"),
                request,
                CallOptions::default(),
            )
            .await;
        consumer.close().await;
        let bytes = match reply {
            Ok(bytes) => bytes,
            Err(CallError::Module(error)) => {
                return Err(format!("{}: {}", error.code, error.message))
            }
            Err(error) if error.route_open_refusal().is_some() => {
                let error = error.route_open_refusal().expect("checked route refusal");
                return Err(format!("{}: {}", error.code, error.message));
            }
            // Do not dump the SDK's connection details or error payloads.
            Err(_) => {
                return Err(
                    "local daemon request failed; check the output directory before retrying"
                        .into(),
                )
            }
        };
        let reply: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "invalid lab reply from Magic Context")?;
        if reply.get("outcome").and_then(serde_json::Value::as_str) != Some("started") {
            return Err("Magic Context did not start the lab".into());
        }
        reply
            .get("out_dir")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "Magic Context did not return the output folder".into())
    })
}

async fn serve(dreamer: &tokio::runtime::Handle) -> Result<(), Box<dyn Error + Send + Sync>> {
    let connection_file = subc_arg().ok_or("missing --subc <connection-file>")?;
    let module_id = std::env::var(subc_protocol::SUBC_MODULE_ID_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODULE_ID.to_owned());
    let context_path = context_db_path().map_err(CliPathRefusal)?;
    let sessions_path = store_path(&context_path).map_err(CliPathRefusal)?;
    // With managed settings, a 0.49-shaped user file is converted once,
    // before ck-mc connects to the daemon or reads its settings.
    #[cfg(feature = "managed-settings")]
    let settings = {
        let settings = Loader::from_environment();
        let data_dir = data_dir(&context_path);
        mc_module::config::managed::rewrite_0_49(settings.user_path(), &data_dir);
        settings.managed(&data_dir)
    };
    let db = open_context_db(&context_path).map_err(CliPathRefusal)?;
    let store = Store::open(&sessions_path).map_err(CliPathRefusal)?;
    // Moves are enforced in every build: the journal is read before any
    // session is served, so a session a move holds is refused from the
    // first request on. Serving new moves is a separate switch.
    let agent_data = mc_module::agent_data::switch_from_environment();
    let journal = Arc::new(Journal::load(mc_module::agent_data::journal::path(
        &context_path,
    )));
    journal.log_held(agent_data);
    mc_module::agent_data::source::sweep(&context_path, &journal);
    if let Some(data_dir) = context_path.parent() {
        let _ = mc_module::engram_catalog::write_catalog_at_startup(data_dir);
    }
    let child_scopes = Arc::new(ChildScopes::new(module_id.clone()));
    let client = SubcRunnerClient::new(connection_file.clone(), Arc::clone(&child_scopes))
        .on_current_runtime();
    let run_end_waits = client.run_end_waits();
    // The replica task reaches ck-bus and the vault over the same
    // connection to the daemon.
    let replica_consumer = client.shared_consumer();
    // API keys the user's file names as `{vault:<credential id>}` are read
    // from the vault over the client's own connection to the daemon.
    let vault = mc_module::vault::Vault::new(Arc::new(mc_module::vault::Claustrum::over(
        client.shared_consumer(),
    )));
    #[cfg(not(feature = "managed-settings"))]
    let settings = Loader::from_environment();
    let module = Module::with_journal(
        client,
        Config::Files(settings.with_vault(Arc::clone(&vault))),
        Some(db),
        Some(store),
        journal,
        agent_data,
    );
    // Share one bus connection: ck-bus revokes the module's old credential
    // whenever it issues a new credential. The dreamer announces docs proposals,
    // memory changes wake other modules, Entorhinal sends change markers, and
    // runners announce run ends on this connection.
    let bus = Arc::new(mc_module::bus::Bus::through_ckbus(connection_file.clone()));
    // Register before any background work starts. Under a daemon that hands
    // ck-mc a registration channel, every outbound connection is bound with a
    // claim minted on this registration, so a connection opened before it
    // exists is refused. The daemon's requests wait unread until `serve` is
    // awaited below, after the background work is started.
    let (handle, serve) = subc_client_rs::serve_with_handle(
        &connection_file,
        manifest_for(&module_id, agent_data),
        Handler::new(module.clone()).with_bus(Arc::clone(&bus)),
    )
    .await?;
    // ck-mc's child scopes are published through its serving connection.
    child_scopes.install(handle);
    // Registered, so the connection the vault reads go over can be bound.
    vault.start();
    module.spawn_upkeep();
    module.spawn_quiet_carry_sweep();
    module.publish_docs_notices_with(mc_module::bus::DocsNotices::over(Arc::clone(&bus)));
    // Each child session ck-mc starts is attributed in context.db, and the
    // fact goes out on the bus for Astrocyte.
    module.publish_attribution_with(mc_module::bus::AttributionEvents::over(Arc::clone(&bus)));
    module.spawn_memory_wakes(Arc::clone(&bus));
    // Memories travel to the user's other computers through the hub, in a
    // build with the memory-replica feature; the box id comes from the bus.
    let replica = module.spawn_replica(replica_consumer, Arc::clone(&bus));
    mc_module::bus::spawn_run_end_reader(Arc::clone(&bus), run_end_waits);
    module.spawn_dreamer(dreamer).await?;
    module.spawn_legacy_projects();
    let registry_watch = module.spawn_entorhinal_follow(bus);
    // An install a move started before a crash is finished in every build:
    // its sessions are refused until it is.
    module.spawn_move_recovery();
    let result = serve.await;
    drop(registry_watch);
    if let Some(replica) = replica {
        replica.stop().await;
    }
    module.flush_app_snapshots().await;
    result?;
    Ok(())
}

fn move_in() -> Result<(), Box<dyn Error + Send + Sync>> {
    let context_path = context_db_path()?;
    // A move installs a head into the store its summaries already live in;
    // a machine without one has nothing to move into.
    if !context_path.exists() {
        return Err(MISSING_STORE.into());
    }
    let db = open_context_db(&context_path)?;
    let store = Store::open(&store_path(&context_path).map_err(CliPathRefusal)?)?;
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
    let settings = Loader::from_environment();
    // Without the daemon, managed settings come from the last view a run
    // applied, or the defaults.
    #[cfg(feature = "managed-settings")]
    let settings = settings.managed_offline(&data_dir(&context_path));
    let moved = mc_module::move_in::move_in(db, &store, &Config::Files(settings), &request)?;
    println!("{}", serde_json::to_string(&moved)?);
    Ok(())
}

/// ck-mc's data folder, where `context.db` lives.
#[cfg(feature = "managed-settings")]
fn data_dir(context_path: &std::path::Path) -> PathBuf {
    context_path
        .parent()
        .map_or_else(|| PathBuf::from("."), std::path::Path::to_path_buf)
}

fn rekey_runner() -> Result<(), Box<dyn Error + Send + Sync>> {
    let args: Vec<String> = std::env::args().skip(2).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{}", mc_module::rekey::HELP);
        return Ok(());
    }
    let request = mc_module::rekey::Request::parse(args)?;
    let context = context_db_path()?;
    mc_module::agent_data::refuse_offline(
        &context,
        request
            .sessions
            .iter()
            .map(|session| (request.harness.as_str(), session.as_str())),
    )?;
    let store = store_path(&context).map_err(CliPathRefusal)?;
    let summary = mc_module::rekey::rekey_runner(&store, &context, &request)?;
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
    let path = context_db_path()?;
    if !path.try_exists()? {
        return Err(MISSING_STORE.into());
    }
    // ContextDb startup writes to the shared store. Move preparation needs
    // this read without module startup or opening sessions.db.
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

/// The refusal of a command that needs an existing store.
const MISSING_STORE: &str = "Magic Context has no context.db. Run `npx @cortexkit/magic-context doctor store init`, then restart ck-mc.";

fn open_context_db(path: &std::path::Path) -> Result<ContextDb, String> {
    // From 0.50 the module owns the store: a machine without one gets a new
    // one, and a store the 0.49 plugin left behind is migrated on open.
    if !path.exists() {
        tracing::info!(path = %path.display(), "ck-mc: creating context.db");
        return ContextDb::create(path);
    }
    ContextDb::open(path)
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

#[cfg(test)]
mod tests {
    use super::CliPathRefusal;

    #[test]
    fn store_refusal_quotes_the_message_and_keeps_controls_escaped() {
        let refusal = CliPathRefusal("store in C:\\work\\old\"dir\nrefused".into());
        #[cfg(windows)]
        let expected = r#""store in C:\work\old\"dir\nrefused""#;
        #[cfg(not(windows))]
        let expected = r#""store in C:\\work\\old\"dir\nrefused""#;
        assert_eq!(format!("{refusal:?}"), expected);
    }
}
