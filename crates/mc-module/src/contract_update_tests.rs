use super::*;
use cortexkit_role_compaction::view::{Edit, InsertAt, InsertedMessage};

#[tokio::test]
async fn contract_update_views_bind_policy_to_index_and_model() {
    for (provider, model, strip) in [
        ("anthropic", "claude-opus-5-5", true),
        ("vertex", "claude-sonnet-5-5@20260901", true),
        ("bedrock", "us.anthropic.claude-haiku-5-5:0", true),
        ("google", "gemini-3-pro", false),
        ("openai", "gpt-5.4", false),
    ] {
        let (mut session, client, route, mut setup, settings) = fixture();
        setup.model = ModelRef::new(provider, model);
        setup.view_anchor = Some(true);
        *client.entries.lock().unwrap() = vec![text(1, "older"), text(2, "newest")];
        setup.newest = client.entries.lock().unwrap().last().map(cursor);
        session
            .setup(&client, &settings, &route, &setup, Features::NONE)
            .await;
        let view = session
            .seal(
                vec![EditOp::Drop {
                    mid: "older".into(),
                    part: Some("p".into()),
                }],
                &[],
            )
            .unwrap();
        assert_eq!(view.built_through.as_deref(), Some("newest"), "{model}");
        assert_eq!(
            view.new_signed.as_deref(),
            strip.then_some("strip"),
            "{model}"
        );
        assert!(view.verify());
        let mut altered = view.clone();
        altered.built_through = Some("older".into());
        assert!(!altered.verify());
        let mut altered = view.clone();
        altered.new_signed = if strip { None } else { Some("strip".into()) };
        assert!(!altered.verify());
    }
    let (mut empty, _, _, _, _) = fixture();
    let view = empty
        .seal(
            vec![EditOp::Insert {
                at: InsertAt::Start,
                message: InsertedMessage::new("head", Role::User, vec!["history".into()]),
            }],
            &[],
        )
        .unwrap();
    assert_eq!(view.built_through, None);
}

#[tokio::test]
async fn contract_update_unflagged_views_preserve_legacy_sealed_bytes() {
    use sha2::{Digest, Sha256};

    for flag in [None, Some(false)] {
        for model in ["claude-opus-5-5", "gpt-5.4"] {
            let (mut session, client, route, mut setup, settings) = fixture();
            setup.model = ModelRef::new("test", model);
            setup.view_anchor = flag;
            *client.entries.lock().unwrap() = vec![text(1, "older"), text(2, "newest")];
            setup.newest = client.entries.lock().unwrap().last().map(cursor);
            session
                .setup(&client, &settings, &route, &setup, Features::NONE)
                .await;
            let view = session
                .seal(
                    vec![EditOp::Drop {
                        mid: "older".into(),
                        part: Some("p".into()),
                    }],
                    &[],
                )
                .unwrap();
            let wire = serde_json::to_value(&view).unwrap();
            assert!(wire.get("built_through").is_none(), "{flag:?}, {model}");
            assert!(wire.get("new_signed").is_none(), "{flag:?}, {model}");
            // The original checksum input had exactly these two members.
            let legacy = serde_json::json!({"version": view.version, "edits": view.edits});
            let digest = Sha256::digest(serde_jcs::to_vec(&legacy).unwrap());
            assert_eq!(view.checksum, format!("{digest:x}"));
            let expected = View::seal(view.version, view.edits.clone());
            assert_eq!(
                serde_json::to_vec(&view).unwrap(),
                serde_json::to_vec(&expected).unwrap()
            );
            assert_eq!(
                view,
                View::seal_for_setup(
                    &setup,
                    expected.version,
                    expected.edits,
                    Some("newest".into()),
                    Some("strip".into())
                )
            );
            assert!(view.verify());
        }
    }
}

#[tokio::test]
async fn contract_update_setup_switches_the_next_view_policy() {
    let (mut session, client, route, mut setup, settings) = fixture();
    setup.model = ModelRef::new("anthropic", "claude-opus-5-5");
    *client.entries.lock().unwrap() = vec![text(1, "older"), text(2, "newest")];
    setup.newest = client.entries.lock().unwrap().last().map(cursor);
    for flag in [Some(true), Some(false), Some(true), None] {
        setup.view_anchor = flag;
        session
            .setup(&client, &settings, &route, &setup, Features::NONE)
            .await;
        let view = session
            .seal(
                vec![EditOp::Drop {
                    mid: "older".into(),
                    part: Some("p".into()),
                }],
                &[],
            )
            .expect("a policy switch replaces the view even when edits are unchanged");
        assert_eq!(
            view.built_through.as_deref(),
            (flag == Some(true)).then_some("newest")
        );
        assert_eq!(
            view.new_signed.as_deref(),
            (flag == Some(true)).then_some("strip")
        );
        let expected = View::seal_for_setup(
            &setup,
            view.version,
            view.edits.clone(),
            Some("newest".into()),
            Some("strip".into()),
        );
        assert_eq!(view, expected);
        setup.applied_view = Some(view.applied());
        session.accept(view);
    }
}

#[tokio::test]
async fn contract_update_foreign_view_is_replaced_not_adopted() {
    for applied_by in [Some("other-provider"), Some(crate::MODULE_ID), None] {
        let (mut session, client, _, _, _) = fixture();
        session
            .index
            .extend(vec![text(1, "cut"), text(2, "dropped"), text(3, "newest")]);
        session
            .summaries
            .push(crate::context_db::StoredCompartment {
                sequence: 1,
                start_message: 1,
                end_message: 1,
                start_message_id: "cut".into(),
                end_message_id: "cut".into(),
                ..Default::default()
            });
        let view = View::seal(
            41,
            vec![
                Edit::new(
                    41,
                    EditOp::Cut {
                        through: "cut".into(),
                    },
                ),
                Edit::new(
                    41,
                    EditOp::Drop {
                        mid: "dropped".into(),
                        part: Some("p".into()),
                    },
                ),
            ],
        );
        let mut answer = AppliedViewAnswer::new();
        answer.view = Some(view.clone());
        answer.applied_by = applied_by.map(str::to_owned);
        *client.applied.lock().unwrap() = Some(answer);
        session.adopt_runner_view(&client).await;
        let foreign = applied_by == Some("other-provider");
        assert_eq!(
            session.cut,
            if foreign { None } else { Some(1) },
            "{applied_by:?}"
        );
        assert_eq!(
            session.latest.as_ref(),
            if foreign { None } else { Some(&view) }
        );
        let next = session
            .seal(
                vec![EditOp::Insert {
                    at: InsertAt::Start,
                    message: InsertedMessage::new(
                        "own-head",
                        Role::User,
                        vec!["own history".into()],
                    ),
                }],
                &[],
            )
            .unwrap();
        assert!(next.version > 41);
        assert_eq!(
            next.edits
                .iter()
                .any(|edit| matches!(edit.op, EditOp::Cut { .. } | EditOp::Drop { .. })),
            !foreign
        );
    }
}
