use super::*;
use crate::client::RunnerClient;
use crate::runner_capabilities::RunnerCapabilities;
use cortexkit_role_llm_runner::delivery_order::Mode;
use serde_json::json;

const ROUTINE: &str = "mc.ctx_reduce.gentle.many.h0.v1";
const CEILING: &str = "mc.ctx_reduce.ceiling.many.h0.v1";

fn describe(modes: Value) -> Value {
    json!({
        "capabilities": ["delivery_order", "notice_keep", "message_marks", "cache_policy"],
        "delivery_order_modes": modes,
    })
}

fn old_send(id: &str, mode: Mode) -> SendRequest {
    SendRequest::template(
        "send-id",
        &DeliveryOrder::new(vec![mode])
            .with_dedupe_key("kind")
            .with_template(TemplateUse::new(id, "digest", Default::default())),
    )
}

async fn assert_sends(description: Value, cleared: bool) {
    let (session, client, _, _, _) = fixture();
    client
        .descriptions
        .lock()
        .unwrap()
        .push_back(Ok(description));
    for template in crate::nudges::templates() {
        let id = template.id.as_str();
        let fallback =
            if id == crate::nudges::KEEP_TEMPLATE || id.starts_with("mc.ctx_reduce.ceiling.") {
                Mode::Steer
            } else {
                Mode::ToolResult
            };
        let actual = session
            .reminder(
                &client,
                "send-id".into(),
                TemplateUse::new(id, "digest", Default::default()),
                "kind",
            )
            .await;
        let expected = if cleared {
            SendRequest::template(
                "send-id",
                &DeliveryOrder::new(vec![Mode::TurnSystemCleared, fallback])
                    .with_dedupe_key("kind")
                    .with_template(TemplateUse::new(id, "digest", Default::default())),
            )
        } else {
            old_send(id, fallback)
        };
        assert_eq!(
            serde_json::to_vec(&actual).unwrap(),
            serde_json::to_vec(&expected).unwrap(),
            "{id}"
        );
    }
}

#[tokio::test]
async fn a_runner_naming_cleared_system_gets_preferred_lists() {
    assert_sends(
        describe(json!(["turn_system_cleared", "tool_result", "steer"])),
        true,
    )
    .await;
}

#[tokio::test]
async fn other_runners_get_byte_identical_old_sends() {
    assert_sends(json!({"capabilities": ["delivery_order"]}), false).await;
    for modes in [
        Value::Null,
        json!(["turn_system", "tool_result", "steer"]),
        json!(["future_mode"]),
    ] {
        assert_sends(describe(modes), false).await;
    }
}

#[tokio::test]
async fn setup_withdraws_clearing_system_support_before_the_next_send() {
    let (session, client, _, _, _) = fixture();
    client.descriptions.lock().unwrap().extend([
        Ok(describe(json!(["turn_system_cleared"]))),
        Ok(describe(json!(["tool_result", "steer"]))),
    ]);
    assert!(client.turn_system_cleared(&session.key).await);
    client.runner_setup(&session.key.runner);
    for (id, fallback) in [
        (ROUTINE, Mode::ToolResult),
        (CEILING, Mode::Steer),
        (crate::nudges::KEEP_TEMPLATE, Mode::Steer),
    ] {
        let actual = session
            .reminder(
                &client,
                "send-id".into(),
                TemplateUse::new(id, "digest", Default::default()),
                "kind",
            )
            .await;
        assert_eq!(
            serde_json::to_vec(&actual).unwrap(),
            serde_json::to_vec(&old_send(id, fallback)).unwrap()
        );
    }
}

#[tokio::test]
async fn reconnect_withdraws_clearing_system_support() {
    let cache = RunnerCapabilities::default();
    assert!(
        cache
            .turn_system_cleared("runner", 1, async {
                Ok(describe(json!(["turn_system_cleared"])))
            })
            .await
    );
    let cleared = cache
        .turn_system_cleared("runner", 2, async {
            Ok(describe(json!(["tool_result", "steer"])))
        })
        .await;
    for (id, expected) in [
        (ROUTINE, json!(["tool_result"])),
        (CEILING, json!(["steer"])),
        (crate::nudges::KEEP_TEMPLATE, json!(["steer"])),
    ] {
        assert_eq!(
            serde_json::to_value(crate::nudges::delivery(id, cleared)).unwrap(),
            expected
        );
    }
}

#[tokio::test]
async fn cleared_and_unknown_delivery_modes_leave_keep_sweep_enabled() {
    let (mut session, client, route, mut request, settings) = fixture();
    client
        .descriptions
        .lock()
        .unwrap()
        .push_back(Ok(describe(json!(["turn_system_cleared", "future_mode"]))));
    *client.entries.lock().unwrap() = notice_and_tool_entries();
    request.newest = client.entries.lock().unwrap().last().map(cursor);
    session
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    assert!(session.notice_keep);
    assert!(client.turn_system_cleared(&session.key).await);
    assert!(
        client
            .capabilities
            .cache_policy(&session.key.runner, 1, async {
                panic!("the same describe must serve every feature")
            })
            .await
    );
    for _ in 0..2 {
        let (view, _) = session.build(&settings, None, true, None);
        if let Some(view) = view {
            session.accept(view);
        } else {
            session.commit_bookmark();
        }
    }
    assert!(session
        .latest
        .as_ref()
        .unwrap()
        .edits
        .iter()
        .any(|edit| matches!(&edit.op,
        EditOp::Replace { mid, field, value, .. }
        if mid == "old-notice" && field == "text" && value == "[dropped §1§]")));
}
