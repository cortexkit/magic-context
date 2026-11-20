use super::*;
use crate::child_scopes::ChildScopes;
use crate::config::Loader;
use crate::transport::{Handler, SubcRunnerClient};
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
        Some(Store::open(&dir.path().join("mode3.db")).unwrap()),
    );
    module
        .inner
        .set_up
        .lock()
        .unwrap()
        .insert(SessionRef::new("runner", "fixture", "session"), None);
    let report = Handler::new(module).health().await;

    assert_eq!(report.status, HealthStatus::Ok);
    assert_eq!(report.detail, None);
    let metrics = report.metrics.unwrap();
    assert_eq!(
        metrics["store"],
        json!({
            "opened": true,
            "context_db_schema_version": crate::context_db::SCHEMA_VERSION,
            "mode3_db_schema_version": crate::store::SCHEMA_VERSION,
        })
    );
    assert_eq!(metrics["sessions"], json!({"count": 1}));
    assert_eq!(metrics["dreamer"], json!({"enabled": false}));
    assert_eq!(metrics["bus"], json!({"connected": false}));
    #[cfg(feature = "memory-replica")]
    assert_eq!(metrics["replica"]["enabled"], false);
    #[cfg(not(feature = "memory-replica"))]
    assert!(metrics.get("replica").is_none());
}

#[tokio::test]
async fn health_hook_degrades_when_a_store_was_not_opened() {
    let dir = tempfile::tempdir().unwrap();
    assert!(ContextDb::open(&dir.path().join("missing.db")).is_err());
    let module = test_module(
        Settings::default(),
        None,
        Some(Store::open(&dir.path().join("mode3.db")).unwrap()),
    );
    let report = Handler::new(module).health().await;

    assert_eq!(report.status, HealthStatus::Degraded);
    assert_eq!(report.detail.as_deref(), Some("context.db was not opened"));
    let metrics = report.metrics.unwrap();
    assert_eq!(metrics["store"]["opened"], false);
    assert_eq!(metrics["store"]["context_db_schema_version"], Value::Null);
    assert_eq!(
        metrics["store"]["mode3_db_schema_version"],
        crate::store::SCHEMA_VERSION
    );
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
