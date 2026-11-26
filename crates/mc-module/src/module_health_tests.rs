use super::*;
use crate::child_scopes::ChildScopes;
use crate::config::Loader;
use crate::transport::{Handler, SubcRunnerClient};
use cortexkit_role_compaction::setup::ModelRef;
use serde_json::json;
use subc_client_rs::{HealthStatus, ModuleHandler};

#[tokio::test]
async fn health_hook_reports_the_open_stores_and_in_memory_state() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("magic-context.json");
    std::fs::write(&config_path, r#"{"dreamer":{"disable":true}}"#).unwrap();
    let settings = Loader::with_user_path(config_path).with_vault(crate::vault::Vault::none());
    let module = test_module(
        Config::Files(settings),
        Some(ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap()),
        Some(Store::open(&dir.path().join("sessions.db")).unwrap()),
    );
    module
        .setup(
            Route {
                session: SessionRef::new("runner", "fixture", "session"),
                project: None,
                workdir: None,
                agent_id: None,
            },
            SetupRequest::new(
                "worker",
                ModelRef::new("anthropic", "claude-opus-5-5"),
                200_000,
                1_000,
                cortexkit_role_compaction::rules::ProviderRules::new(
                    cortexkit_role_compaction::rules::SignedParts::None,
                    cortexkit_role_compaction::rules::EditCost::Suffix,
                ),
                Vec::new(),
                1,
            ),
        )
        .unwrap();
    let report = Handler::new(module).health().await;

    assert_eq!(report.status, HealthStatus::Ok);
    assert_eq!(report.detail, None);
    let metrics = report.metrics.unwrap();
    assert_eq!(
        metrics["store"],
        json!({
            "opened": true,
            "context_db_schema_version": crate::context_db::SCHEMA_VERSION,
            "sessions_db_schema_version": crate::store::SCHEMA_VERSION,
        })
    );
    assert_eq!(metrics["sessions"], json!({"count": 1}));
    assert_eq!(metrics["dreamer"], json!({"enabled": false}));
    assert_eq!(metrics["bus"], json!({"connected": false}));
    let headline = vec![
        "session_count",
        "bus_connected",
        "context_db_schema_version",
        "sessions_db_schema_version",
        "dreamer_enabled",
        "settings_source",
    ];
    #[cfg(feature = "memory-replica")]
    let headline = [
        headline,
        vec!["replica_unsent_count", "replica_epoch_holds"],
    ]
    .concat();
    assert_eq!(metrics["headline"], json!(headline));
    assert_eq!(metrics["session_count"], 1);
    assert_eq!(metrics["bus_connected"], false);
    assert_eq!(
        metrics["context_db_schema_version"],
        crate::context_db::SCHEMA_VERSION
    );
    assert_eq!(
        metrics["sessions_db_schema_version"],
        crate::store::SCHEMA_VERSION
    );
    assert_eq!(metrics["dreamer_enabled"], false);
    #[cfg(feature = "managed-settings")]
    assert_eq!(metrics["settings_source"], "file");
    #[cfg(not(feature = "managed-settings"))]
    assert_eq!(metrics["settings_source"], "unmanaged");
    #[cfg(feature = "memory-replica")]
    assert_eq!(metrics["replica"]["enabled"], false);
    #[cfg(not(feature = "memory-replica"))]
    assert!(metrics.get("replica").is_none());
}

#[tokio::test]
async fn health_remains_healthy_while_a_statement_holds_the_setup_lock() {
    let dir = tempfile::tempdir().unwrap();
    let module = test_module(
        Settings::default(),
        Some(ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap()),
        Some(Store::open(&dir.path().join("sessions.db")).unwrap()),
    );
    let idle = module.health(false);
    let statement = module.inner.set_up.lock().unwrap();
    let busy = module.health(false);
    drop(statement);
    assert_eq!(busy.status, HealthStatus::Ok);
    assert_eq!(
        busy.metrics.unwrap()["session_count"],
        idle.metrics.unwrap()["session_count"]
    );
}

#[tokio::test]
async fn health_hook_degrades_when_a_store_was_not_opened() {
    let dir = tempfile::tempdir().unwrap();
    assert!(ContextDb::open(&dir.path().join("missing.db")).is_err());
    let module = test_module(
        Settings::default(),
        None,
        Some(Store::open(&dir.path().join("sessions.db")).unwrap()),
    );
    let report = Handler::new(module).health().await;

    assert_eq!(report.status, HealthStatus::Degraded);
    assert_eq!(report.detail.as_deref(), Some("context.db was not opened"));
    let metrics = report.metrics.unwrap();
    assert_eq!(metrics["store"]["opened"], false);
    assert_eq!(metrics["store"]["context_db_schema_version"], Value::Null);
    assert_eq!(metrics["context_db_schema_version"], Value::Null);
    assert_eq!(
        metrics["store"]["sessions_db_schema_version"],
        crate::store::SCHEMA_VERSION
    );
}

#[cfg(feature = "managed-settings")]
#[tokio::test]
async fn health_hook_degrades_on_managed_defaults_and_recovers_when_a_view_arrives() {
    use subc_client_rs::config::{ConfigAvailability, ConfigState};

    let dir = tempfile::tempdir().unwrap();
    let module = managed_test_module(dir.path());
    let handler = Handler::new(module);
    let waiting = handler.health().await;
    assert_eq!(waiting.status, HealthStatus::Ok);
    assert_eq!(waiting.detail, None);
    assert_eq!(waiting.metrics.unwrap()["settings_source"], "waiting");

    handler
        .on_config_state(ConfigState::ConfigGated {
            view: ConfigAvailability::NoApprovedConfig,
            refusal: subc_protocol::ErrorBody::new(
                "config_gated",
                "the settings wait for approval",
            ),
        })
        .await;
    let defaults = handler.health().await;
    assert_eq!(defaults.status, HealthStatus::Degraded);
    assert_eq!(
        defaults.detail.as_deref(),
        Some("running default settings until they are approved")
    );
    assert_eq!(defaults.metrics.unwrap()["settings_source"], "defaults");

    handler.config_apply(approved_test_view()).await.unwrap();
    let approved = handler.health().await;
    assert_eq!(approved.status, HealthStatus::Ok);
    assert_eq!(approved.detail, None);
    assert_eq!(approved.metrics.unwrap()["settings_source"], "view");
}

#[cfg(feature = "managed-settings")]
#[tokio::test]
async fn declaration_pending_view_is_served_on_first_apply() {
    use subc_client_rs::config::{ConfigDeclarationPending, ConfigState};

    let dir = tempfile::tempdir().unwrap();
    let module = managed_test_module(dir.path());
    let handler = Handler::new(module.clone());
    let mut active = approved_test_view();
    // A pending declaration does not make the approved settings pending.
    active.declaration_pending = Some(ConfigDeclarationPending::default());
    handler.config_apply(active.clone()).await.unwrap();
    assert_eq!(
        handler.health().await.metrics.unwrap()["settings_source"],
        "view"
    );
    handler.on_config_state(ConfigState::Active(active)).await;

    let settings = module
        .config()
        .resolve(None, "anthropic/claude-opus-5-5", 200_000);
    assert_eq!(settings.execute_threshold_percentage, 70.0);
    assert_eq!(settings.clock_note, Settings::default().clock_note);
}

#[cfg(feature = "managed-settings")]
fn approved_test_view() -> subc_client_rs::config::ConfigView {
    use subc_client_rs::config::{ConfigStatus, ConfigView, Layer};

    ConfigView::new(
        1,
        json!({"execute_threshold_percentage": {"default": 70}}),
        [("/execute_threshold_percentage/default".into(), Layer::User)].into(),
        vec![],
        ConfigStatus::Active,
    )
}

#[cfg(feature = "managed-settings")]
fn managed_test_module(dir: &std::path::Path) -> Module<SubcRunnerClient> {
    let user = dir.join("magic-context.jsonc");
    std::fs::write(
        &user,
        r#"{"execute_threshold_percentage":{"default":80},"clock_note":"off"}"#,
    )
    .unwrap();
    test_module(
        Config::Files(Loader::with_user_path(user).managed(dir)),
        Some(ContextDb::create_for_tests(&dir.join("context.db")).unwrap()),
        Some(Store::open(&dir.join("sessions.db")).unwrap()),
    )
}

fn test_module(
    config: impl Into<Config>,
    db: Option<ContextDb>,
    store: Option<Store>,
) -> Module<SubcRunnerClient> {
    let client = SubcRunnerClient::new(
        "unused-connection-file".into(),
        Arc::new(ChildScopes::new(crate::MODULE_ID)),
    );
    Module::new(client, config, db, store)
}
