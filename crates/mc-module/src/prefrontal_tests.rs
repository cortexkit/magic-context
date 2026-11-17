//! A call to prefrontal's management surface over a stand-in daemon that has
//! some of prefrontal's module ids installed.

use std::sync::Mutex;

use serde_json::json;

use super::{Attempt, ManagementIds};

/// Answers under each installed id and refuses every other id as not
/// installed, recording each id a call opened a route to.
struct Daemon {
    installed: Mutex<Vec<&'static str>>,
    opened: Mutex<Vec<&'static str>>,
}

impl Daemon {
    fn with(installed: &[&'static str]) -> Self {
        Self {
            installed: Mutex::new(installed.to_vec()),
            opened: Mutex::new(Vec::new()),
        }
    }

    fn install_only(&self, installed: &[&'static str]) {
        *self.installed.lock().unwrap() = installed.to_vec();
    }

    async fn open(&self, module_id: &'static str) -> Attempt {
        self.opened.lock().unwrap().push(module_id);
        if self.installed.lock().unwrap().contains(&module_id) {
            Attempt::Settled(Ok(json!({ "answered_by": module_id })))
        } else {
            Attempt::NotInstalled
        }
    }

    /// The ids opened since the last look.
    fn opened(&self) -> Vec<&'static str> {
        std::mem::take(&mut *self.opened.lock().unwrap())
    }
}

/// Which module answered one call.
async fn call(ids: &ManagementIds, daemon: &Daemon) -> String {
    let answer = ids
        .call(|module_id| daemon.open(module_id))
        .await
        .expect("an answer");
    answer["answered_by"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn a_call_reaches_prefrontal_when_it_is_installed() {
    for installed in [&["prefrontal"][..], &["prefrontal", "prefrontal-core"][..]] {
        let daemon = Daemon::with(installed);
        let ids = ManagementIds::default();
        assert_eq!(call(&ids, &daemon).await, "prefrontal", "{installed:?}");
        assert_eq!(daemon.opened(), ["prefrontal"], "{installed:?}");
        assert_eq!(call(&ids, &daemon).await, "prefrontal", "{installed:?}");
        assert_eq!(daemon.opened(), ["prefrontal"], "{installed:?}");
    }
}

/// The fallback is learned once: later calls open only the id that answered.
#[tokio::test]
async fn a_call_falls_back_to_prefrontal_core_when_only_it_is_installed() {
    let daemon = Daemon::with(&["prefrontal-core"]);
    let ids = ManagementIds::default();
    assert_eq!(call(&ids, &daemon).await, "prefrontal-core");
    assert_eq!(daemon.opened(), ["prefrontal", "prefrontal-core"]);
    assert_eq!(call(&ids, &daemon).await, "prefrontal-core");
    assert_eq!(daemon.opened(), ["prefrontal-core"]);
}

/// A remembered id is given up only when the daemon refuses it as not
/// installed, as when a machine takes the new name while ck-mc runs.
#[tokio::test]
async fn the_remembered_id_is_learned_again_once_it_is_not_installed() {
    let daemon = Daemon::with(&["prefrontal-core"]);
    let ids = ManagementIds::default();
    call(&ids, &daemon).await;
    daemon.opened();
    daemon.install_only(&["prefrontal"]);
    assert_eq!(call(&ids, &daemon).await, "prefrontal");
    assert_eq!(daemon.opened(), ["prefrontal-core", "prefrontal"]);
    assert_eq!(call(&ids, &daemon).await, "prefrontal");
    assert_eq!(daemon.opened(), ["prefrontal"]);
}

#[tokio::test]
async fn prefrontal_is_not_installed_only_when_both_ids_are_refused() {
    let daemon = Daemon::with(&[]);
    let ids = ManagementIds::default();
    let refusal = ids
        .call(|module_id| daemon.open(module_id))
        .await
        .unwrap_err();
    assert_eq!(refusal.code, "unknown_module");
    assert_eq!(daemon.opened(), ["prefrontal", "prefrontal-core"]);
}

/// A refusal or failure under an id the daemon has installed is that call's
/// outcome: the other id is not tried, and the id stays remembered.
#[tokio::test]
async fn a_refusal_from_an_installed_id_is_not_a_reason_to_try_the_other() {
    let ids = ManagementIds::default();
    let opened = Mutex::new(Vec::new());
    let refusal = ids
        .call(|module_id| {
            opened.lock().unwrap().push(module_id);
            std::future::ready(Attempt::Settled(Err(
                crate::client::CoreRefusal::unavailable("no answer in time"),
            )))
        })
        .await
        .unwrap_err();
    assert_eq!(refusal.code, "unavailable");
    assert_eq!(*opened.lock().unwrap(), ["prefrontal"]);
}

/// Trying the second id right after the first is refused relies on the SDK
/// refusing a route to an absent module at once. Were `unknown_module` a
/// code it retries in place, every call on a machine with only one of the
/// ids installed would wait out the SDK's retry deadline before the other id
/// was tried.
#[test]
fn the_sdk_does_not_retry_a_route_to_an_absent_module() {
    assert!(!subc_client_rs::is_retryable_route_open_code(
        "unknown_module"
    ));
}
