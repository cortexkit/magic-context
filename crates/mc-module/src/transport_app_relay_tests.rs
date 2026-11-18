use super::*;
use crate::app_read::fixture_tests::{head, Fixture, EMPTY, PROJECT};
use crate::context_db::ContextDb;
use crate::session::Session;
use crate::store::Store;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use subc_client_rs::RouteHandle;

const DESKTOP: &str = "fed-app:sample-device";
const PHONE: &str = "fed-phone:sample-device";

fn management() -> RouteTarget {
    RouteTarget::ManagementSurface {
        module_id: crate::MODULE_ID.into(),
    }
}

fn internal() -> RouteTarget {
    RouteTarget::InternalService {
        module_id: crate::MODULE_ID.into(),
        service_id: crate::app_read::ROLE.0.into(),
    }
}

fn bind(target: RouteTarget, principal: Principal, harness: &str) -> RouteBindRequest {
    let mut request = RouteBindRequest::new(
        RouteHandle::detached(10, 1),
        target,
        BindIdentity::new(harness, "app"),
    );
    request.principal = Some(principal);
    request
}

fn callosum() -> Principal {
    Principal::Reserved {
        module_id: "callosum".into(),
    }
}

async fn bound_caller(handler: &Handler, request: RouteBindRequest) -> AppCaller {
    let decision = handler.on_bind(&request).await;
    handler
        .app_bound
        .lock()
        .unwrap()
        .get(&request.handle.channel)
        .unwrap_or_else(|| panic!("no app route for {request:?}: {decision:?}"))
        .clone()
}

fn handler(fixture: &Fixture) -> Handler {
    fixture.add_summary();
    let db = ContextDb::open(&fixture.dir.path().join("context.db")).unwrap();
    let store = Store::open(&fixture.dir.path().join("mode3.db")).unwrap();
    let handler = Handler::new(Module::new(
        SubcRunnerClient::new(
            fixture.dir.path().join("unused-relay-socket"),
            Arc::new(ChildScopes::new(crate::MODULE_ID)),
        ),
        crate::pass::Settings::default(),
        Some(db),
        Some(store),
    ));
    let app = handler.module.app_read();
    app.publish(Session::app_sample_snapshot());
    Session::app_sample_session().publish_app(app, false);
    handler
}

fn shared_reads() -> [(&'static str, Value); 4] {
    let session = head();
    [
        (
            "session_data.read",
            json!({"session": session, "section": "meta"}),
        ),
        (
            "context.cache_why",
            json!({"session": session, "producers": [{"producer_ref": "runner-step"}]}),
        ),
        (
            "context.search",
            json!({"query": "needle", "scope": {"session": session}, "sources": ["message"]}),
        ),
        ("context.watch", json!({"sessions": [session]})),
    ]
}

fn desktop_reads() -> [(&'static str, Value); 14] {
    let session = head();
    [
        (
            "context.states",
            json!({"session": session, "message_ids": ["m1", "m2", "m3", "absent"]}),
        ),
        ("context.head", json!({"session": session})),
        (
            "context.head_section",
            json!({"session": session, "view": 2, "slot": "baseline", "section": 0}),
        ),
        (
            "context.compartment",
            json!({"session": session, "compartment_id": "1"}),
        ),
        (
            "memories.stats",
            json!({"level": "project", "owner": PROJECT}),
        ),
        (
            "memories.page",
            json!({"level": "project", "owner": PROJECT, "limit": 1}),
        ),
        ("memories.get", json!({"id": 1})),
        ("observations.page", json!({"limit": 1})),
        ("facts.page", json!({"project": PROJECT, "limit": 1})),
        ("dreamer.status", json!({"project": EMPTY})),
        ("dreamer.runs", json!({"project": PROJECT, "limit": 1})),
        ("dreamer.run", json!({"id": 2})),
        ("sessions.page", json!({"project": PROJECT, "limit": 1})),
        ("notes.page", json!({"project": PROJECT, "limit": 1})),
    ]
}

async fn reply(handler: &Handler, caller: &AppCaller, request: &Value) -> Value {
    match handler
        .app_dispatch(&serde_json::to_vec(request).unwrap(), caller)
        .await
        .unwrap_or_else(|error| panic!("{request}: {error:?}"))
    {
        AppAnswer::Read(bytes) => serde_json::from_slice(&bytes).unwrap(),
        AppAnswer::Watch(mut subscription) => {
            let first = subscription.recv().await.unwrap().unwrap();
            assert_eq!(first["kind"], "resync");
            json!({"result": first})
        }
    }
}

async fn assert_unknown_method(handler: &Handler, caller: &AppCaller, method: &str) {
    let body = serde_json::to_vec(&json!({"method": method, "params": null})).unwrap();
    let Err(error) = handler.app_dispatch(&body, caller).await else {
        panic!("{method} was admitted for {caller:?}");
    };
    assert_eq!(error.code, "unknown_method", "{method}: {error:?}");
    if caller.management {
        assert_eq!(
            error.message,
            format!("{method} isn't served on ck-mc's management surface.")
        );
    }
}

#[tokio::test]
async fn relayed_app_reads_follow_the_caller_on_both_surfaces() {
    let fixture = Fixture::new();
    let handler = handler(&fixture);
    for target in [management(), internal()] {
        let desktop = bound_caller(&handler, bind(target.clone(), callosum(), DESKTOP)).await;
        let phone = bound_caller(&handler, bind(target, callosum(), PHONE)).await;
        for (method, params) in shared_reads() {
            let request = json!({"method": method, "params": params});
            for caller in [&desktop, &phone] {
                assert!(reply(&handler, caller, &request).await["result"].is_object());
            }
        }
        for (method, params) in desktop_reads() {
            let request = json!({"method": method, "params": params});
            assert!(reply(&handler, &desktop, &request).await["result"].is_object());
            assert_unknown_method(&handler, &phone, method).await;
        }
        for caller in [&desktop, &phone] {
            assert_unknown_method(&handler, caller, "dreamer.docs_proposal").await;
            assert_unknown_method(&handler, caller, "unlisted.read").await;
        }
    }

    // Spelling a remote harness does not change a Direct route's privileges.
    let direct = bound_caller(&handler, bind(internal(), Principal::Direct, DESKTOP)).await;
    let request = json!({"method": "dreamer.docs_proposal", "params": {"project": PROJECT}});
    assert!(reply(&handler, &direct, &request).await["result"]["proposal"].is_null());
    let direct = app_admission(&bind(management(), Principal::Direct, DESKTOP)).unwrap();
    assert_unknown_method(&handler, &direct, "context.states").await;
}

#[test]
fn internal_service_declares_the_relayed_reads_and_the_local_docs_read() {
    let service = manifest(crate::MODULE_ID)
        .provides
        .into_iter()
        .find_map(|role| match role {
            ProviderRole::InternalService {
                service_id,
                operations,
                ..
            } if service_id == crate::app_read::ROLE.0 => Some(operations),
            _ => None,
        })
        .unwrap();
    let mut expected: Vec<_> = shared_reads()
        .into_iter()
        .chain(desktop_reads())
        .map(|(method, _)| method.to_owned())
        .collect();
    expected.push("dreamer.docs_proposal".into());
    let mut service = service;
    service.sort();
    expected.sort();
    assert_eq!(service, expected);
}

#[tokio::test]
async fn samples_v19() {
    let testdata = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata");
    let v18 = testdata.join("mc-app-read-samples-v18");
    let mut samples = BTreeMap::new();
    for line in fs::read_to_string(v18.join("SHA256SUMS")).unwrap().lines() {
        let (_, name) = line.split_once("  ").unwrap();
        samples.insert(name.to_owned(), fs::read(v18.join(name)).unwrap());
    }

    let fixture = Fixture::new();
    let handler = handler(&fixture);
    let caller = bound_caller(&handler, bind(management(), callosum(), DESKTOP)).await;
    for (method, params) in desktop_reads() {
        let request = json!({"method": method, "params": params});
        let mut response = reply(&handler, &caller, &request).await;
        if let Some(as_of) = response["result"].get_mut("as_of_ms") {
            *as_of = json!(1_700_000_000_000_u64);
        }
        let name = format!("fed-app-{}", method.replace(['.', '_'], "-"));
        let sample = json!({
            "name": name,
            "route": {"target": management(), "principal": "reserved:callosum", "harness": caller.harness},
            "request": request,
            "response": response,
        });
        let bytes = format!("{}\n", serde_json::to_string_pretty(&sample).unwrap()).into_bytes();
        assert!(samples.insert(format!("{name}.json"), bytes).is_none());
    }

    let output = std::env::var_os("MC_REGENERATE_APP_READ_SAMPLES");
    let regenerate = output.is_some();
    let root = output
        .filter(|path| path != "1")
        .map_or_else(|| testdata.join("mc-app-read-samples-v19"), PathBuf::from);
    if regenerate {
        fs::create_dir_all(&root).unwrap();
    }
    let mut sums = String::new();
    for (name, bytes) in samples {
        let path = root.join(&name);
        let current = fs::read(&path);
        if regenerate && current.as_ref().ok() != Some(&bytes) {
            fs::write(path, &bytes).unwrap();
        } else {
            assert_eq!(
                current.unwrap_or_else(|_| panic!("missing {name}")),
                bytes,
                "stale {name}"
            );
        }
        sums.push_str(&format!("{:x}  {name}\n", Sha256::digest(&bytes)));
    }
    if regenerate {
        fs::write(root.join("SHA256SUMS"), &sums).unwrap();
    }
    assert_eq!(fs::read_to_string(root.join("SHA256SUMS")).unwrap(), sums);
}
