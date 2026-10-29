use super::*;
use crate::McHandler;
use subc_client_rs::{ModuleHandler, RouteBindRequest, RouteHandle};
use subc_protocol::{Principal, RouteTarget};

const AS_OF_MS: i64 = 1_700_000_000_000;
const PHONE_REPLY_CAP: usize = 512 * 1024;

fn management_bind(channel: u16) -> RouteBindRequest {
    let mut req = admission::tests::phone_bind();
    req.handle = RouteHandle::detached(channel, 1);
    req.target = RouteTarget::ManagementSurface {
        module_id: crate::DEFAULT_MODULE_ID.into(),
    };
    req
}

fn session() -> Value {
    json!({"runner":"opencode", "harness":"opencode", "session":"ses"})
}

fn seed_message(db: &rusqlite::Connection, ordinal: i64, message_id: &str) {
    db.execute(
        "INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content)
        VALUES ('ses', ?1, ?2, 'assistant', 'needle')",
        rusqlite::params![ordinal, message_id],
    )
    .unwrap();
    db.execute(
        "INSERT INTO message_fts_rowid_map VALUES ('ses', ?1, ?2, ?1)",
        rusqlite::params![ordinal, db.last_insert_rowid()],
    )
    .unwrap();
}

fn response_bytes(outcome: HandlerOutcome) -> Vec<u8> {
    match outcome {
        HandlerOutcome::Response(bytes) => {
            assert!(bytes.len() <= PHONE_REPLY_CAP, "{} bytes", bytes.len());
            bytes
        }
        other => panic!("expected complete JSON response, got {other:?}"),
    }
}

/// A management reply must be exactly `{"result": <payload>}`, the envelope
/// callosum's phone reader requires; returns the payload.
fn management_payload(bytes: &[u8]) -> Value {
    let value: Value = serde_json::from_slice(bytes).unwrap();
    let object = value.as_object().expect("management reply is an object");
    assert_eq!(
        object.keys().collect::<Vec<_>>(),
        vec!["result"],
        "management reply must carry only `result`"
    );
    value["result"].clone()
}

fn code(outcome: HandlerOutcome) -> String {
    match outcome {
        HandlerOutcome::Error { code, .. } | HandlerOutcome::ErrorWithDetail { code, .. } => code,
        HandlerOutcome::Response(bytes) => {
            panic!("expected refusal, got {} response bytes", bytes.len())
        }
        other => panic!("expected refusal, got {other:?}"),
    }
}

async fn call(handler: &McHandler, channel: u16, method: &str, params: Value) -> HandlerOutcome {
    handler
        .handle_channel_at(
            channel,
            serde_json::to_vec(&json!({"method":method, "params":params})).unwrap(),
            AS_OF_MS,
        )
        .await
}

async fn handler(dir: &Path) -> McHandler {
    let handler = McHandler::new();
    handler
        .store
        .set(tests_support::open_store(dir))
        .ok()
        .unwrap();
    for req in [admission::tests::phone_bind(), management_bind(2)] {
        let decision = handler.on_bind(&req).await;
        assert!(format!("{decision:?}").contains("Accept"), "{decision:?}");
    }
    tests_support::apply_sql(
        &dir.join("context.db"),
        "INSERT INTO session_meta(session_id, harness) VALUES ('ses', 'opencode');",
    );
    handler
}

#[tokio::test]
async fn phone_reads_match_internal_and_management_bytes() {
    if super::tests::isolated(
        "app_read::management_tests::phone_reads_match_internal_and_management_bytes",
    ) {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let handler = handler(dir.path()).await;
    tests_support::apply_sql(&dir.path().join("context.db"),
        "INSERT INTO compartments(session_id, sequence, start_message, end_message, title, content, created_at, harness)
         VALUES ('ses', 1, 1, 2, 'title', 'summary', 10, 'opencode');
         INSERT INTO transform_decisions(session_id, harness, message_id, ts_ms, decision)
         VALUES ('ses', 'opencode', 'a', 10, 'execute'), ('ses', 'opencode', 'b', 20, 'execute');");
    let db = rusqlite::Connection::open(dir.path().join("context.db")).unwrap();
    seed_message(&db, 1, "m1");
    seed_message(&db, 2, "m2");
    for (method, params, field) in [
        (
            "session_data.read",
            json!({"session":session(), "section":"compartments"}),
            "rows",
        ),
        (
            "context.cache_why",
            json!({"session":session(), "window":{}, "limit":1}),
            "decisions",
        ),
        (
            "context.search",
            json!({"query":"needle", "scope":{"session":session()}, "sources":["message"], "limit":1}),
            "hits",
        ),
    ] {
        let internal = response_bytes(call(&handler, 1, method, params.clone()).await);
        let management = response_bytes(call(&handler, 2, method, params).await);
        // The phone's wire body is the internal reply, byte for byte, inside
        // `{"result": ...}`. The app-read samples record the internal reply, so
        // they are exactly the payload the phone unwraps.
        let mut expected = b"{\"result\":".to_vec();
        expected.extend_from_slice(&internal);
        expected.push(b'}');
        assert_eq!(management, expected, "{method}");
        let value = management_payload(&management);
        assert_eq!(value[field].as_array().unwrap().len(), 1, "{method}");
        assert_eq!(value["as_of_ms"], AS_OF_MS);
        if method == "context.cache_why" {
            assert_eq!(value["decisions"][0]["producer_ref"], "b");
            assert!(value["next_cursor"].is_string());
        } else if method == "session_data.read" {
            assert_eq!(value["rows"][0]["title"], "title");
        } else {
            assert!(value["next_cursor"].is_string());
            assert_eq!(value["hits"][0]["snippet"], "needle");
        }
    }
    for method in APP_READ_METHODS
        .iter()
        .filter(|method| !MANAGEMENT_METHODS.contains(method))
    {
        assert_eq!(
            code(call(&handler, 2, method, json!({})).await),
            "app_caller_forbidden"
        );
    }
    handler.on_route_gone(&management_bind(2).handle).await;
    assert_eq!(
        code(call(&handler, 2, "session_data.read", json!({})).await),
        "route_unbound"
    );
}

#[tokio::test]
async fn management_reads_use_the_internal_caller_gate() {
    if super::tests::isolated(
        "app_read::management_tests::management_reads_use_the_internal_caller_gate",
    ) {
        return;
    }
    let handler = McHandler::new();
    for (principal, harness, scope, expected) in [
        (
            Some(Principal::Unverified),
            "fed-phone:peer",
            None,
            "app_caller_forbidden",
        ),
        (
            Some(Principal::Reserved {
                module_id: "basal".into(),
            }),
            "fed-phone:peer",
            None,
            "app_caller_forbidden",
        ),
        (
            Some(Principal::Reserved {
                module_id: "callosum".into(),
            }),
            "fed-computer:peer",
            None,
            "app_route_not_operator",
        ),
        (
            Some(Principal::Reserved {
                module_id: "callosum".into(),
            }),
            "fed-phone:peer",
            Some(admission::tests::scope("agent_id")),
            "app_route_agent_scope",
        ),
        (
            Some(Principal::Reserved {
                module_id: "callosum".into(),
            }),
            "fed-phone:peer",
            Some(admission::tests::scope("flow_id")),
            "app_route_agent_scope",
        ),
    ] {
        let mut internal = admission::tests::phone_bind();
        internal.principal = principal;
        internal.identity.harness = harness.into();
        internal.scope = scope;
        let refusal = admission::admit(&internal, crate::DEFAULT_MODULE_ID, true).unwrap_err();
        assert!(format!("{refusal:?}").contains(expected), "{refusal:?}");
        let decision = handler.on_bind(&internal).await;
        assert!(format!("{decision:?}").contains(expected), "{decision:?}");
        internal.target = management_bind(2).target;
        internal.handle = management_bind(2).handle;
        handler.on_bind(&internal).await;
        for method in MANAGEMENT_METHODS {
            assert_eq!(code(call(&handler, 2, method, json!({})).await), expected);
        }
    }
}

#[tokio::test]
async fn management_compartments_page_below_the_phone_reply_cap() {
    if super::tests::isolated(
        "app_read::management_tests::management_compartments_page_below_the_phone_reply_cap",
    ) {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let handler = handler(dir.path()).await;
    let db = rusqlite::Connection::open(dir.path().join("context.db")).unwrap();
    // Control characters expand sixfold in JSON; 200 titles cannot fit one reply.
    let title = "\u{1}".repeat(4096);
    for ordinal in 1..=200 {
        db.execute("INSERT INTO compartments(session_id, sequence, start_message, end_message, title, content, created_at, harness)
            VALUES ('ses', ?1, 1, 2, ?2, 'summary', ?1, 'opencode')", rusqlite::params![ordinal, title]).unwrap();
    }
    let mut params = json!({"session":session(), "section":"compartments", "limit":200});
    let mut ordinals = Vec::new();
    let mut pages = 0;
    loop {
        let bytes = response_bytes(call(&handler, 2, "session_data.read", params.clone()).await);
        let value = management_payload(&bytes);
        pages += 1;
        assert!(pages <= 200, "cursor failed to progress");
        let rows = value["rows"].as_array().unwrap();
        assert!(!rows.is_empty());
        for row in rows {
            assert_eq!(row["title"], title);
            ordinals.push(row["ordinal"].as_i64().unwrap());
        }
        if value["complete"] == true {
            assert!(value["next_cursor"].is_null());
            break;
        }
        assert!(value["next_cursor"].is_string());
        params["cursor"] = value["next_cursor"].clone();
    }
    assert!(pages > 1);
    assert_eq!(ordinals, (1..=200).rev().collect::<Vec<_>>());
}

#[tokio::test]
async fn management_cache_why_pages_windows_and_refuses_oversize_producer_sets() {
    if super::tests::isolated("app_read::management_tests::management_cache_why_pages_windows_and_refuses_oversize_producer_sets") {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let handler = handler(dir.path()).await;
    let db = rusqlite::Connection::open(dir.path().join("context.db")).unwrap();
    let model = "x".repeat(300_000);
    for at in 1..=3 {
        db.execute("INSERT INTO transform_decisions(session_id, harness, message_id, ts_ms, decision, m0_model_key_prev)
            VALUES ('ses', 'opencode', ?1, ?2, 'execute', ?3)", rusqlite::params![format!("p{at}"), at, model]).unwrap();
    }
    let mut params = json!({"session":session(), "window":{}, "limit":200});
    let mut producers = Vec::new();
    loop {
        let bytes = response_bytes(call(&handler, 2, "context.cache_why", params.clone()).await);
        let value = management_payload(&bytes);
        let rows = value["decisions"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["changes"]["model"]["prev"], model);
        producers.push(rows[0]["producer_ref"].as_str().unwrap().to_owned());
        assert!(producers.len() <= 3, "cursor failed to progress");
        if value["next_cursor"].is_null() {
            break;
        }
        params["cursor"] = value["next_cursor"].clone();
    }
    assert_eq!(producers, ["p3", "p2", "p1"]);
    let params =
        json!({"session":session(), "producers":[{"producer_ref":"p1"},{"producer_ref":"p2"}]});
    assert_eq!(
        code(call(&handler, 2, "context.cache_why", params).await),
        "reply_too_large"
    );
}

#[tokio::test]
async fn management_search_refuses_an_oversize_hit_by_name() {
    if super::tests::isolated(
        "app_read::management_tests::management_search_refuses_an_oversize_hit_by_name",
    ) {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let handler = handler(dir.path()).await;
    let db = rusqlite::Connection::open(dir.path().join("context.db")).unwrap();
    seed_message(&db, 1, &"x".repeat(PHONE_REPLY_CAP));
    let params =
        json!({"query":"needle", "scope":{"session":session()}, "sources":["message"], "limit":25});
    for channel in [1, 2] {
        assert_eq!(
            code(call(&handler, channel, "context.search", params.clone()).await),
            "reply_too_large"
        );
    }
}

#[tokio::test]
async fn management_search_pages_large_results_without_dropping_hits() {
    if super::tests::isolated(
        "app_read::management_tests::management_search_pages_large_results_without_dropping_hits",
    ) {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let handler = handler(dir.path()).await;
    let db = rusqlite::Connection::open(dir.path().join("context.db")).unwrap();
    for ordinal in 1..=3 {
        seed_message(&db, ordinal, &format!("{ordinal}{}", "x".repeat(200_000)));
    }
    let mut params =
        json!({"query":"needle", "scope":{"session":session()}, "sources":["message"], "limit":25});
    let mut ordinals = Vec::new();
    let mut pages = 0;
    loop {
        let bytes = response_bytes(call(&handler, 2, "context.search", params.clone()).await);
        let value = management_payload(&bytes);
        pages += 1;
        assert!(pages <= 4, "cursor failed to progress");
        let hits = value["hits"].as_array().unwrap();
        assert!(!hits.is_empty());
        for hit in hits {
            assert_eq!(hit["message_id"].as_str().unwrap().len(), 200_001);
            ordinals.push(hit["ordinal"].as_i64().unwrap());
        }
        if value["next_cursor"].is_null() {
            assert_eq!(value["complete"], true);
            break;
        }
        assert_eq!(value["complete"], false);
        params["cursor"] = value["next_cursor"].clone();
    }
    assert!(pages > 1);
    ordinals.sort_unstable();
    assert_eq!(ordinals, [1, 2, 3]);
}

#[tokio::test]
async fn management_search_refuses_when_size_paging_exhausts_the_cursor() {
    if super::tests::isolated("app_read::management_tests::management_search_refuses_when_size_paging_exhausts_the_cursor") {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let handler = handler(dir.path()).await;
    let db = rusqlite::Connection::open(dir.path().join("context.db")).unwrap();
    for ordinal in 1..=5 {
        seed_message(&db, ordinal, &format!("{ordinal}{}", "x".repeat(300_000)));
    }
    let mut params =
        json!({"query":"needle", "scope":{"session":session()}, "sources":["message"], "limit":25});
    for _ in 0..3 {
        let bytes = response_bytes(call(&handler, 2, "context.search", params.clone()).await);
        let value = management_payload(&bytes);
        assert_eq!(value["hits"].as_array().unwrap().len(), 1);
        assert!(value["next_cursor"].is_string());
        params["cursor"] = value["next_cursor"].clone();
    }
    assert_eq!(
        code(call(&handler, 2, "context.search", params).await),
        "reply_too_large"
    );
}
