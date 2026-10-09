/// First-selection protection only. Frozen removals remain absorbing even when
/// a host subset changes which turn or assistant is newest.
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
