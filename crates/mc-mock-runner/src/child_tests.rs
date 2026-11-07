use super::child::{scripted_summarizer, Runs};
use cortexkit_role_llm_runner::send::SendRequest;
use serde_json::json;

fn request(id: &str) -> SendRequest {
    serde_json::from_value(json!({
        "prompt": "summarize", "send_id": id,
        "model": {"provider": "test", "model": "test"},
        "system": "summarizer", "generation": {"max_output_tokens": 100},
        "stop_when": {"max_steps": 1},
        "cache": {"ttl": "short", "keep_warm": "off"}
    }))
    .unwrap()
}

#[test]
fn cache_is_recorded_only_on_a_planless_creating_send() {
    let mut runs = Runs::default();
    let responder = scripted_summarizer();
    let first = request("first");
    let id = runs.start("child", first.clone(), &responder).unwrap();
    assert_eq!(runs.all()[0].settings.cache, first.cache);
    assert_eq!(runs.start("child", first, &responder).unwrap(), id);
    assert_eq!(runs.all().len(), 1, "a deduplicated send writes nothing");

    assert_eq!(
        runs.start("child", request("second"), &responder)
            .unwrap_err()
            .0,
        "cache"
    );
    assert_eq!(runs.all().len(), 1, "refusal must not start a run");
    let mut continuation = request("second");
    continuation.cache = None;
    runs.start("child", continuation, &responder).unwrap();
    assert!(runs.all()[1].settings.cache.is_none());

    let mut planned = request("planned");
    planned.plan = Some(serde_json::Map::new());
    assert_eq!(
        runs.start("other-child", planned, &responder)
            .unwrap_err()
            .0,
        "cache"
    );
    assert_eq!(runs.all().len(), 2, "refusal must not create a child");
    runs.start("other-child", request("planless"), &responder)
        .unwrap();
}
