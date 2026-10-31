// A compaction view's head insertion invalidates every later Anthropic signature.
// The default compaction entry points remove those signed blocks from the view; the
// asynchronous runner lane (`SignedReasoning::RunnerCompanion`) leaves them for the
// runner's companion edit, and changes nothing else.
#[test]
fn compaction_views_strip_later_signed_reasoning_unless_the_runner_owns_the_companion() {
    use compaction::{setup_with, SignedReasoning, State, Status};

    fn signed_turn(mid: &str, ordinal: u64) -> CkIngressMessage {
        let mut message = wire_item("assistant", mid, ordinal, &["answer"]);
        message.ck.content.insert(
            0,
            CkWireBlock::bare(ck_wire::CkKind::Reasoning {
                text: "plan".into(),
                signature: Some(format!("{mid}-signature")),
            }),
        );
        message.ck.mark_modified();
        message
    }
    /// Setup's view of a two-turn signed session; `None` takes the default entry point.
    fn view(signed: Option<SignedReasoning>) -> Vec<CkWireMessage> {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        let mut request = req(
            "signed-companion",
            "cfg0",
            vec![
                item("u0", 0, "first prompt"),
                signed_turn("a1", 1),
                item("u2", 2, "second prompt"),
                signed_turn("a3", 3),
            ],
        );
        request.kind = "compaction.step".into();
        request.serializer_profile = "claude-code-anthropic".into();
        request.provider_id = Some("anthropic".into());
        let status = Status {
            lineage_id: "L".into(),
            newest_ordinal: Some(3),
            previous_usage: None,
            request_tokens: 0,
            context_window: 100_000,
            prefix_rebuilding: false,
            cold_prefix: false,
            pipeline_switch: false,
            last_applied_version: None,
            last_not_applied: None,
        };
        let mut state = State::new("signed-companion".into(), compaction::Preset::Head);
        let ctx = pctx("git:proj", "/nonexistent-docs", 0);
        let output = match signed {
            None => compaction::setup(&s, &request, &ctx, &status, &mut state),
            Some(signed) => setup_with(&s, &request, &ctx, &status, &mut state, signed),
        }
        .unwrap();
        let compaction::Answer::Replacement(view) = output.answer else {
            panic!("setup always answers with its initial view")
        };
        view.replacement
    }
    fn signatures(messages: &[CkWireMessage]) -> Vec<String> {
        messages
            .iter()
            .flat_map(|message| &message.content)
            .filter_map(|block| match &block.kind {
                ck_wire::CkKind::Reasoning {
                    signature: Some(signature),
                    ..
                } => Some(signature.clone()),
                _ => None,
            })
            .collect()
    }
    let stripped = view(None);
    assert_eq!(
        serde_json::to_vec(&stripped).unwrap(),
        serde_json::to_vec(&view(Some(SignedReasoning::Strip))).unwrap(),
        "the default entry point strips"
    );
    let kept = view(Some(SignedReasoning::RunnerCompanion));
    // Setup's view starts with its history head, so every signed block is after the
    // first changed byte.
    assert!(stripped[0].meta.synthetic && kept[0].meta.synthetic);
    assert_eq!(signatures(&stripped), Vec::<String>::new());
    assert_eq!(signatures(&kept), ["a1-signature", "a3-signature"]);
    // Apart from the signed blocks the two views are the same messages.
    let without_signed = |messages: &[CkWireMessage]| {
        messages
            .iter()
            .map(|message| {
                message
                    .content
                    .iter()
                    .filter(|block| !matches!(block.kind, ck_wire::CkKind::Reasoning { .. }))
                    .map(|block| serde_json::to_value(&block.kind).unwrap())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(without_signed(&stripped), without_signed(&kept));
}
