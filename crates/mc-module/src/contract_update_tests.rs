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
