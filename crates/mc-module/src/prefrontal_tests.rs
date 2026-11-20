//! Calls to prefrontal's management surface over a stand-in daemon.

use std::sync::Mutex;

use serde_json::json;

use super::Attempt;

/// Records route targets and answers only for installed modules.
struct Daemon {
    installed: Vec<&'static str>,
    opened: Mutex<Vec<&'static str>>,
}

impl Daemon {
    fn with(installed: &[&'static str]) -> Self {
        Self {
            installed: installed.to_vec(),
            opened: Mutex::new(Vec::new()),
        }
    }

    async fn open(&self, module_id: &'static str) -> Attempt {
        self.opened.lock().unwrap().push(module_id);
        if self.installed.contains(&module_id) {
            Attempt::Settled(Ok(json!({ "answered_by": module_id })))
        } else {
            Attempt::NotInstalled
        }
    }
}

#[tokio::test]
async fn a_call_reaches_prefrontal_when_it_is_installed() {
    let daemon = Daemon::with(&["prefrontal", "prefrontal-core"]);
    for _ in 0..2 {
        let answer = super::call(|module_id| daemon.open(module_id))
            .await
            .unwrap();
        assert_eq!(answer["answered_by"], "prefrontal");
    }
    assert_eq!(*daemon.opened.lock().unwrap(), ["prefrontal", "prefrontal"]);
}

#[tokio::test]
async fn a_call_refuses_when_only_prefrontal_core_is_installed() {
    let daemon = Daemon::with(&["prefrontal-core"]);
    let refusal = super::call(|module_id| daemon.open(module_id))
        .await
        .unwrap_err();
    assert_eq!(refusal.code, "unknown_module");
    assert_eq!(*daemon.opened.lock().unwrap(), ["prefrontal"]);
}

#[tokio::test]
async fn a_call_refuses_when_prefrontal_is_not_installed() {
    let daemon = Daemon::with(&[]);
    let refusal = super::call(|module_id| daemon.open(module_id))
        .await
        .unwrap_err();
    assert_eq!(refusal.code, "unknown_module");
    assert_eq!(*daemon.opened.lock().unwrap(), ["prefrontal"]);
}

#[tokio::test]
async fn a_refusal_from_prefrontal_is_returned() {
    let opened = Mutex::new(Vec::new());
    let refusal = super::call(|module_id| {
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
