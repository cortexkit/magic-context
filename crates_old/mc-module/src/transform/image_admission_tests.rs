#[test]
fn processed_image_admission_holds_unit_minting_without_freezing_and_admits_tail() {
    use crate::edit_admission::{EditAdmission, Message, Part};
    let image = json!({"type":"file","mime":"image/png","url":format!("data:image/png;base64,{}", "x".repeat(300))});
    let native = vec![
        json!({"info":{"id":"before","role":"user"},"parts":[{"type":"text","text":"screenshot"},image.clone(),image.clone()]}),
        json!({"info":{"id":"boundary","role":"assistant"},"parts":[{"type":"reasoning","text":"kept","metadata":{"anthropic":{"signature":"signed"}}}]}),
        json!({"info":{"id":"tail","role":"user"},"parts":[image]}),
        json!({"info":{"id":"reply","role":"assistant"},"parts":[{"type":"text","text":"processed"}]}),
    ];
    let mut request = active_opencode_req(
        "image-admission",
        "cfg",
        crate::codec::decode_opencode(&native).messages,
    );
    request.provider_id = Some("anthropic".into());
    request.model_key = Some("claude-opus-5-5".into());
    // Supply the frame directly so this test exercises image-unit admission independently
    // of the tag-target guard. In this frame the tail row is tool output, not a new user turn.
    let frame = |held: bool| {
        EditAdmission::new(
            &[
                Message {
                    id: Some("boundary".into()),
                    real_user: !held,
                    parts: vec![Part {
                        retained: held,
                        anchor: Some("signed".into()),
                    }],
                },
                Message {
                    id: Some("tail".into()),
                    real_user: false,
                    parts: vec![],
                },
            ],
            true,
        )
    };
    let mint = |core: &CoreState, held| {
        new_frozen_strip_units(
            core,
            &request,
            &BTreeMap::from([("before".into(), 1), ("tail".into(), 2)]),
            None,
            true,
            StripSelectionScope {
                reasoning: ReasoningBudgetScope::default(),
                image_watermark: 5,
                image_protected_cutoff: None,
                image_emergency: false,
            },
            &HashSet::new(),
            &frame(held),
        )
        .into_iter()
        .filter(|u| u.key.starts_with("strip:processed_image:") || u.key.starts_with("red:"))
        .collect::<Vec<_>>()
    };
    let mut core = CoreState::default();
    let held = mint(&core, true);
    let keys = |units: &[FrozenUnit]| {
        units
            .iter()
            .map(|u| u.key.as_str())
            .collect::<Vec<_>>()
            .join(",")
    };
    assert_eq!(keys(&held), "red:tail#0,strip:processed_image:tail");
    core.frozen_units.extend(held);
    assert!(
        mint(&core, true).is_empty(),
        "held image ids must never leak into frozen replay"
    );
    let release = mint(&core, false);
    assert_eq!(
        keys(&release),
        "red:before#1,red:before#2,strip:processed_image:before"
    );
    core.frozen_units.extend(release);
    assert!(
        mint(&core, true).is_empty(),
        "saved image decisions do not ask admission again"
    );
}
