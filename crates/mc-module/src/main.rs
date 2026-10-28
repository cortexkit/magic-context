//! mc-module entrypoint: boot on `subc-client-rs`'s `serve` (provider role).
//!
//! `serve` owns the handshake (read `--subc <connection-file>`, authenticate, send
//! HELLO{manifest}, await HELLO_ACK, then dispatch route data requests to the
//! handler). The handler opens the single-writer store in `on_hello_ack`.

#![forbid(unsafe_code)]

use std::error::Error;
use std::path::PathBuf;

use mc_module::route_targets::RouteTargetConfig;
use mc_module::{
    manifest_with_route_targets_and_smart_notes, McHandler, McTransportHandler, DEFAULT_MODULE_ID,
};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    // Consume the inherited pipe before initialization can start any helper;
    // the SDK's HELLO and historian route opens reuse this process-wide cache.
    subc_os::launch_nonce()?;
    // Fleet convention: a side-effect-free single-line --version, evaluated before
    // any runtime argument so supervisors and test substrates can probe the binary
    // without a connection file.
    if std::env::args().skip(1).any(|arg| arg == "--version") {
        println!("{}", mc_module::version_line());
        return Ok(());
    }
    if std::env::args().skip(1).any(|arg| arg == "--print-fences") {
        println!("{}", mc_module::supported_fences_line());
        return Ok(());
    }
    let enforce_private_permissions = mc_module::config::private_storage_permissions_enabled();
    #[cfg(unix)]
    if enforce_private_permissions {
        // ck-mc owns its process, so a restrictive mask also protects files the
        // external logger and SQLite create without exposing a mode option.
        nix::sys::stat::umask(nix::sys::stat::Mode::from_bits_truncate(0o077));
    }
    // The offline single-store migration runs without subc and without serving: the doctor
    // command calls it while nothing has either database open.
    if std::env::args().nth(1).as_deref() == Some("single-store-migrate") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(mc_module::single_store_migrate::cli_main(&args));
    }
    // The history repair after a migration is also a one-shot command without subc.
    if std::env::args().nth(1).as_deref() == Some("single-store-repair-history") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(mc_module::single_store_repair::cli_main(&args));
    }
    // The offline move of a standalone OpenCode 1 session to mode 3 runs in a
    // restart window with every host and ck-mc stopped. `move-session --plan`
    // uses only read-only store connections and prints U, P and message_count.
    if std::env::args().nth(1).as_deref() == Some("offline") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(mc_module::offline_move::cli_main(&args));
    }
    let module_id = effective_module_id();

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
    let log_permissions =
        mc_store::private_permissions::tighten_tree(logger.logs_dir(), enforce_private_permissions);
    tracing::info!(
        tightened = log_permissions.tightened,
        failures = log_permissions.failures,
        "mc-module: log permission tightening"
    );
    let connection_file = parse_subc_arg(std::env::args_os().skip(1))?;
    // Engram backs up this data folder only from the catalog file in it, so the
    // catalog is published before serving. A failure is logged inside and never
    // stops startup.
    if let Some(data_dir) = mc_module::host_store::resolve_context_db_path().parent() {
        let _ = mc_module::engram_catalog::write_catalog_at_startup(data_dir);
    }
    // The runner settings are user-tier only, so one resolution covers every project
    // this process serves. The manifest's background-completion routes and
    // self-signals follow it: when every role is configured to the host runner, no
    // background-completion route to Broca is opened. An unconfigured role is decided
    // per request by the harness, and a Claude Code request then still goes to Broca,
    // so that route stays declared. The provider runner route (Broca serving as the
    // transcript source for compaction providers) is declared separately and
    // is optional: ck-mc starts and serves without it.
    let route_targets =
        RouteTargetConfig::for_configured_runners(mc_module::config::user_configured_runners());
    let smart_notes_enabled = mc_module::config::user_smart_notes_enabled();
    let result = subc_client_rs::serve_with(
        &connection_file,
        manifest_with_route_targets_and_smart_notes(
            &module_id,
            &route_targets,
            smart_notes_enabled,
        ),
        McTransportHandler::new(
            McHandler::new_with_connection_file_route_targets_and_module_id(
                Some(connection_file.clone()),
                route_targets,
                module_id,
            )
            .with_startup_smart_notes_enabled(smart_notes_enabled)
            .with_log_directory(logger.logs_dir().to_path_buf()),
        ),
    )
    .await;
    mc_module::project_identity::shutdown_pin_writes();
    result?;
    Ok(())
}

fn effective_module_id() -> String {
    std::env::var(subc_protocol::SUBC_MODULE_ID_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODULE_ID.into())
}

fn parse_subc_arg<I>(mut args: I) -> Result<PathBuf, Box<dyn Error + Send + Sync>>
where
    I: Iterator<Item = std::ffi::OsString>,
{
    while let Some(arg) = args.next() {
        if arg == "--subc" {
            return args
                .next()
                .map(PathBuf::from)
                .ok_or_else(|| "--subc requires a connection-file path".into());
        }
    }
    Err("missing --subc <connection-file>".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn module_id_override_is_the_registered_principal() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::module_id_override_child"])
            .env("MC_MODULE_ID_TEST_CHILD", "1")
            .env(subc_protocol::SUBC_MODULE_ID_ENV, "custom-magic-context")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[test]
    fn module_id_override_child() {
        if std::env::var_os("MC_MODULE_ID_TEST_CHILD").is_none() {
            return;
        }
        let module_id = super::effective_module_id();
        assert_eq!(module_id, "custom-magic-context");
        let handler = mc_module::McHandler::new_with_connection_file_route_targets_and_module_id(
            None,
            mc_module::route_targets::RouteTargetConfig::default(),
            module_id.clone(),
        );
        assert_eq!(handler.registered_module_id(), module_id);
        assert_eq!(
            mc_module::agent_data::stream(handler.registered_module_id()),
            "reserved:custom-magic-context"
        );
        let manifest = mc_module::manifest(&module_id);
        assert_eq!(
            serde_json::to_value(manifest).unwrap()["module_id"],
            module_id
        );
    }
}
