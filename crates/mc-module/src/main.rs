//! mc-module entrypoint: boot on `subc-client-rs`'s `serve` (provider role).
//!
//! `serve` owns the handshake (read `--subc <connection-file>`, authenticate, send
//! HELLO{manifest}, await HELLO_ACK, then dispatch route data requests to the
//! handler). The handler opens the single-writer store in `on_hello_ack`.

#![forbid(unsafe_code)]

use std::error::Error;
use std::path::PathBuf;

use mc_module::route_targets::RouteTargetConfig;
use mc_module::{manifest_with_route_targets, McHandler, DEFAULT_MODULE_ID};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    // Fleet convention: a side-effect-free single-line --version, evaluated before
    // any runtime argument so supervisors and test substrates can probe the binary
    // without a connection file.
    if std::env::args().skip(1).any(|arg| arg == "--version") {
        println!("{}", mc_module::version_line());
        return Ok(());
    }
    let module_id = std::env::var(subc_protocol::SUBC_MODULE_ID_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODULE_ID.to_string());

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
    let connection_file = parse_subc_arg(std::env::args_os().skip(1))?;
    // The runner settings are user-tier only, so one resolution covers every project
    // this process serves. The manifest's routes and self-signals follow it: when
    // every role is configured to the host runner no Broca route is opened and none
    // is declared. An unconfigured role is decided per request by the harness, and a
    // Claude Code request then still goes to Broca, so the route stays declared.
    let route_targets =
        RouteTargetConfig::for_configured_runners(mc_module::config::user_configured_runners());
    subc_client_rs::serve_with(
        &connection_file,
        manifest_with_route_targets(&module_id, &route_targets),
        McHandler::new_with_connection_file_and_route_targets(
            Some(connection_file.clone()),
            route_targets,
        )
        .with_log_directory(logger.logs_dir().to_path_buf()),
    )
    .await?;
    Ok(())
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
