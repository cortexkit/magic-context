use super::*;

#[tokio::test]
async fn user_commands_preview_audits_relayed_caller_without_changing_the_reply() {
    let module = crate::module::Module::new(Client::default(), Settings::default(), None, None);
    let principal = subc_protocol::Principal::Reserved {
        module_id: "occipital".into(),
    };
    let (session, _, _) = ready();
    let mut request = serde_json::to_value(preview_request(&session, "status")).unwrap();
    let mut replies = Vec::new();
    for caller in [
        json!({"app":"phone", "admission":"phone", "device":"0123456789abcdef"}),
        json!({"app":"desktop", "admission":"operator_app"}),
    ] {
        request["caller"] = caller.clone();
        let body = serde_json::to_vec(&json!({
            "method":"commands.preview", "params":request
        }))
        .unwrap();
        let (reply, logs) =
            crate::test_log::logged_async(module.command_request(&principal, &body)).await;
        replies.push(reply.unwrap());
        let lines: Vec<_> = logs.lines().collect();
        assert_eq!(lines.len(), 1, "{logs}");
        for expected in [
            "INFO",
            "ck-mc: user command",
            "op=\"commands.preview\"",
            "command_id=\"status\"",
            "session=\"s1\"",
            "outcome=\"not_managed\"",
        ] {
            assert!(lines[0].contains(expected), "missing {expected}: {logs}");
        }
        for field in ["app", "admission", "device"] {
            let value = caller[field].as_str().unwrap_or("");
            assert!(logs.contains(&format!("{field}=\"{value}\"")), "{logs}");
        }
        assert!(!logs.contains("args"), "{logs}");
    }
    assert_eq!(replies[0], replies[1], "relay labels are audit-only");
}

#[tokio::test]
async fn user_commands_audits_describe_and_rejected_run_once_each() {
    let module = crate::module::Module::new(Client::default(), Settings::default(), None, None);
    let principal = subc_protocol::Principal::Reserved {
        module_id: "occipital".into(),
    };
    for (op, params, outcome) in [
        ("commands.describe", json!({}), "ok"),
        (
            "commands.run",
            json!({"id":"unknown", "args":{"secret":"not-for-logs"}}),
            "unknown_command",
        ),
    ] {
        let body = serde_json::to_vec(&json!({"method":op, "params":params})).unwrap();
        let (_, logs) =
            crate::test_log::logged_async(module.command_request(&principal, &body)).await;
        assert_eq!(logs.lines().count(), 1, "{logs}");
        assert!(logs.contains(&format!("op=\"{op}\"")), "{logs}");
        assert!(logs.contains(&format!("outcome=\"{outcome}\"")), "{logs}");
        assert!(!logs.contains("not-for-logs"), "{logs}");
    }
}
