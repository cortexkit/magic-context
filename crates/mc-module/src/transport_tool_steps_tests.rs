//! A slow `ctx_search` or `ctx_memory` call, served by the real handler over
//! a real store, logs one line naming the steps it spent its time in
//! ([`crate::tool_timing`]); a fast one logs nothing.

use super::*;
use crate::embedding::circuit_tests::Endpoint;

const STEPS_LINE: &str = "ck-mc slow tool steps";

/// A real handler over a real store with `settings`, and the channel of a
/// tool route bound to one session.
async fn served(settings: crate::pass::Settings) -> (tempfile::TempDir, Handler, u16) {
    let dir = tempfile::tempdir().unwrap();
    let db =
        crate::context_db::ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    let client = SubcRunnerClient::new(
        dir.path().join("unused-connection-file"),
        Arc::new(ChildScopes::new("ck-mc-test")),
    );
    let handler = Handler::new(Module::new(client, settings, Some(db), None));
    let channel = 21;
    let mut bind = RouteBindRequest::new(
        subc_client_rs::RouteHandle::detached(channel, 1),
        RouteTarget::ToolProvider {
            module_id: crate::MODULE_ID.into(),
        },
        BindIdentity::new("test", "searching-session"),
    );
    bind.principal = Some(Principal::Reserved {
        module_id: "runner-module".into(),
    });
    bind.role_versions = Some(std::collections::BTreeMap::from([(
        TOOL_ROLE.0.into(),
        TOOL_ROLE.1.into(),
    )]));
    handler.on_bind(&bind).await;
    assert!(handler.bound.lock().unwrap().contains_key(&channel));
    (dir, handler, channel)
}

/// Settings whose query embedding waits `wait` for an endpoint that never
/// answers, and then searches by words only. Nothing reranks. Each test
/// names its own endpoint path: the endpoint's circuit is kept per address
/// for the whole test process, and another test may have opened it for a
/// port this server now reuses.
fn embedding_hangs(server: &Endpoint, path: &str, wait: Duration) -> crate::pass::Settings {
    crate::pass::Settings {
        embedding: Some(
            crate::embedding::Provider::for_test(&format!("{}/{path}", server.url), "test-model")
                .with_timeouts_for_test(Duration::from_secs(5), wait),
        ),
        rerank: crate::search::rerank::Reranker::Off,
        ..crate::pass::Settings::default()
    }
}

fn call(name: &str, arguments: Value) -> Vec<u8> {
    serde_json::to_vec(&ToolCallRequest::new(name, arguments)).unwrap()
}

/// The milliseconds a step line gives `step`, the first time it names it.
fn step_ms(line: &str, step: &str) -> u128 {
    let pattern = regex::Regex::new(&format!(r#"[ "]{step}=(\d+)"#)).unwrap();
    pattern
        .captures(line)
        .unwrap_or_else(|| panic!("no {step} in {line}"))[1]
        .parse()
        .unwrap()
}

fn steps_line<'a>(logs: &'a str, op: &str) -> &'a str {
    logs.lines()
        .find(|line| line.contains(STEPS_LINE) && line.contains(op))
        .unwrap_or_else(|| panic!("no step line for {op} in {logs}"))
}

#[tokio::test]
async fn a_slow_search_names_the_step_that_held_it_and_none_of_its_text() {
    let server = Endpoint::hanging().await;
    let (_dir, handler, channel) = served(embedding_hangs(
        &server,
        "tool-steps-search",
        Duration::from_millis(700),
    ))
    .await;
    let capture = crate::test_log::capture();
    let answer = handler
        .dispatch(
            channel,
            &call(
                "ctx_search",
                json!({"query": "zebra parser lanes", "sources": ["message", "note"]}),
            ),
        )
        .await;
    assert!(answer.is_ok(), "{:?}", answer.err());
    let logs = capture.text();
    assert_eq!(logs.matches(STEPS_LINE).count(), 1, "{logs}");
    let line = steps_line(&logs, "ctx_search");
    assert!(line.contains("INFO"), "{line}");
    assert!(line.contains("searching-session"), "{line}");
    assert!(line.contains("runner-module"), "{line}");
    assert!(
        line.contains("query_chars=18 sources=message,note results=0"),
        "{line}"
    );
    // The embedding is what the call waited for, and the line says how it
    // ended; every other step took a fraction of it.
    assert!(line.contains("(timeout)"), "{line}");
    let embed = step_ms(line, "embed");
    assert!(embed >= 650, "{line}");
    for step in [
        "route",
        "queue",
        "scope",
        "read_wait",
        "message_fts",
        "finish",
    ] {
        assert!(step_ms(line, step) < embed / 2, "{step} in {line}");
    }
    // The steps add up to the call's time.
    let elapsed: u128 = regex::Regex::new(r"elapsed_ms=(\d+)")
        .unwrap()
        .captures(line)
        .unwrap()[1]
        .parse()
        .unwrap();
    let steps: u128 = regex::Regex::new(r"=(\d+)")
        .unwrap()
        .captures_iter(
            line.split("steps=")
                .nth(1)
                .unwrap()
                .split(" ahead=")
                .next()
                .unwrap(),
        )
        .map(|step| step[1].parse::<u128>().unwrap())
        .sum();
    assert!(steps <= elapsed && elapsed - steps < 50, "{line}");
    // Nothing of what the model asked is written.
    assert!(!logs.contains("zebra"), "{logs}");
}

/// The pattern of a memory call sent beside a slow search: it waits for the
/// session's worker, which runs the search first, and its line says so.
#[tokio::test]
async fn a_memory_call_behind_a_slow_search_names_its_wait_and_the_search() {
    let server = Endpoint::hanging().await;
    let (_dir, handler, channel) = served(embedding_hangs(
        &server,
        "tool-steps-memory",
        Duration::from_millis(700),
    ))
    .await;
    let capture = crate::test_log::capture();
    let search = call("ctx_search", json!({"query": "where the lock is taken"}));
    let memory = call("ctx_memory", json!({"action": "get", "ids": [1]}));
    let (searched, _) = tokio::join!(
        handler.dispatch(channel, &search),
        handler.dispatch(channel, &memory),
    );
    assert!(searched.is_ok(), "{:?}", searched.err());
    let logs = capture.text();
    let line = steps_line(&logs, "ctx_memory");
    assert!(line.contains("action=get"), "{line}");
    assert!(step_ms(line, "queue") >= 650, "{line}");
    let ahead = regex::Regex::new(r"tool:ctx_search:(\d+)")
        .unwrap()
        .captures(line)
        .unwrap_or_else(|| panic!("the search is not named in {line}"))[1]
        .parse::<u128>()
        .unwrap();
    assert!(ahead >= 650, "{line}");
    // The search's own line carries no wait for the worker.
    let search_line = steps_line(&logs, "ctx_search");
    assert!(step_ms(search_line, "queue") < 100, "{search_line}");
}

#[tokio::test]
async fn a_fast_search_logs_no_steps() {
    let settings = crate::pass::Settings {
        rerank: crate::search::rerank::Reranker::Off,
        ..crate::pass::Settings::default()
    };
    let (_dir, handler, channel) = served(settings).await;
    let capture = crate::test_log::capture();
    let answer = handler
        .dispatch(channel, &call("ctx_search", json!({"query": "anything"})))
        .await;
    assert!(answer.is_ok(), "{:?}", answer.err());
    assert!(!capture.text().contains(STEPS_LINE), "{}", capture.text());
}
