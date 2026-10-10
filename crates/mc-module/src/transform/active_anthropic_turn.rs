/// First-selection protection only. Frozen removals remain absorbing even when
/// a host subset changes which turn or assistant is newest.
/// Reference predicate for one mid; production code uses the set form below.
#[cfg(test)]
fn in_active_anthropic_turn(req: &TransformRequest, mid: &str) -> bool {
    let provider = req
        .provider_id
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    let model = req.model_key.as_deref().unwrap_or("").to_ascii_lowercase();
    if !provider.contains("anthropic")
        && !model.contains("claude")
        && !model.contains("anthropic")
        && !is_prefix_bound_thinking_model(req.model_key.as_deref())
    {
        return false;
    }
    let Some(user) = req.messages.iter().rposition(|message| {
        message.ck.role == "user"
            && !message.ck.meta.synthetic
            && !message
                .ck
                .content
                .iter()
                .all(|block| matches!(block.kind, ck_wire::CkKind::ToolResult { .. }))
    }) else {
        return false;
    };
    req.messages
        .iter()
        .position(|message| message.mid == mid)
        .is_some_and(|index| index > user)
}

/// The set form of `in_active_anthropic_turn`: a mid is in the set exactly when
/// that function returns true for it. Callers that test every message use this
/// so the pass stays linear in the transcript instead of quadratic.
fn active_anthropic_turn_mids(req: &TransformRequest) -> HashSet<&str> {
    let provider = req
        .provider_id
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    let model = req.model_key.as_deref().unwrap_or("").to_ascii_lowercase();
    if !provider.contains("anthropic")
        && !model.contains("claude")
        && !model.contains("anthropic")
        && !is_prefix_bound_thinking_model(req.model_key.as_deref())
    {
        return HashSet::new();
    }
    let Some(user) = req.messages.iter().rposition(|message| {
        message.ck.role == "user"
            && !message.ck.meta.synthetic
            && !message
                .ck
                .content
                .iter()
                .all(|block| matches!(block.kind, ck_wire::CkKind::ToolResult { .. }))
    }) else {
        return HashSet::new();
    };
    // `position` finds a mid's first occurrence, so a mid already seen at or
    // before the user turn is outside the active turn even if it repeats later.
    let mut seen_before = HashSet::new();
    let mut active = HashSet::new();
    for (index, message) in req.messages.iter().enumerate() {
        let mid = message.mid.as_str();
        if index <= user {
            seen_before.insert(mid);
        } else if !seen_before.contains(mid) {
            active.insert(mid);
        }
    }
    active
}

#[cfg(test)]
mod active_turn_set_tests {
    use super::*;

    fn message(mid: &str, role: &str, kind: ck_wire::CkKind, synthetic: bool) -> CkIngressMessage {
        let mut ck = CkWireMessage::from_parts(
            role,
            vec![CkWireBlock::bare(kind)],
            None,
            ck_wire::ProviderExtras::new(),
            ck_wire::HarnessMeta::default(),
        );
        ck.meta.synthetic = synthetic;
        CkIngressMessage {
            mid: mid.to_string(),
            ordinal: 0,
            ck,
        }
    }

    fn text(value: &str) -> ck_wire::CkKind {
        ck_wire::CkKind::Text {
            text: value.to_string(),
        }
    }

    #[test]
    fn set_form_matches_the_per_mid_predicate() {
        let tool_result = || ck_wire::CkKind::ToolResult {
            id: "call".to_string(),
            tool_name: "read".to_string(),
            output: ck_wire::CkToolOutput::bare(ck_wire::CkOutputKind::Text {
                text: "out".to_string(),
            }),
            provider_executed: false,
        };
        let messages = vec![
            message("a1", "assistant", text("old"), false),
            message("dup", "assistant", text("seen before the turn"), false),
            message("u1", "user", text("real user"), false),
            message("a2", "assistant", text("in turn"), false),
            message("dup", "assistant", text("repeated id"), false),
            message("tr", "user", tool_result(), false),
            message("syn", "user", text("synthetic"), true),
            message("a3", "assistant", text("still in turn"), false),
        ];
        let mut mids: Vec<&str> = messages.iter().map(|m| m.mid.as_str()).collect();
        mids.push("absent");
        for (provider, model) in [
            (Some("anthropic"), Some("anthropic/claude-x")),
            (Some("openai"), Some("openai/gpt-5")),
            (None, Some("claude-sonnet")),
        ] {
            let mut req = opencode_test_request(messages.clone());
            req.provider_id = provider.map(str::to_string);
            req.model_key = model.map(str::to_string);
            let set = active_anthropic_turn_mids(&req);
            for mid in &mids {
                assert_eq!(
                    set.contains(mid),
                    in_active_anthropic_turn(&req, mid),
                    "{provider:?} {model:?} {mid}"
                );
            }
        }
        let mut no_user = opencode_test_request(vec![message("a", "assistant", text("x"), false)]);
        no_user.provider_id = Some("anthropic".into());
        assert!(active_anthropic_turn_mids(&no_user).is_empty());
        assert!(!in_active_anthropic_turn(&no_user, "a"));
    }

    fn opencode_test_request(messages: Vec<CkIngressMessage>) -> TransformRequest {
        let mut req: TransformRequest = serde_json::from_value(serde_json::json!({
            "v": 2,
            "session_id": "active-turn-set",
            "render_config": "active-turn-set",
            "serializer_profile": "opencode-aisdk",
            "messages": []
        }))
        .expect("minimal request");
        req.messages = messages;
        req
    }
}
