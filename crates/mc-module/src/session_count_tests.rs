use super::*;

#[tokio::test]
async fn ordinary_notices_do_not_recount_a_9000_message_session() {
    for (model, same_role) in [
        (ModelRef::new("anthropic", "claude-opus-5-5"), false),
        (ModelRef::new("anthropic", "claude-opus-5-5"), true),
        (ModelRef::new("test", "model"), false),
    ] {
        let (mut session, client, _, _, settings) = fixture();
        session.conditions.model = model;
        session.conditions.context_window = 100_000_000;
        session.conditions.last_prompt_tokens = Some(10_000);
        session.features.summarizer = true;
        let entries: Vec<_> = (1..=9000).map(|ordinal| {
            Entry::new(ordinal, format!("m{ordinal}"), if same_role || ordinal % 2 == 0 { Role::Assistant } else { Role::User }, ordinal,
                vec![Part::new("p", PartBody::Text { text: "Read src/session.rs; keep the prefix stable and run the filtered tests.".into() })])
        }).collect();
        session.index.extend(entries.clone());
        session.index_ready = true;
        let latest = entries.last().unwrap().clone();
        let mut first = notice(&session, 1, Some(cursor(&latest)));
        first.entries = vec![latest.clone()];
        assert!(session.notice(&client, &settings, first).await.is_none());
        let counted = session.scan_counts.misses;
        let headers = session.scan_counts.header_misses;
        assert!(
            counted > 1000,
            "the trigger must actually inspect the held history"
        );
        for seq in 2..=4 {
            let ordinal = 8999 + seq;
            let source = &entries[((ordinal + 1) % 2) as usize];
            let appended = Entry::new(
                ordinal,
                format!("m{ordinal}"),
                source.role.clone(),
                ordinal,
                source.parts.clone(),
            );
            let mut next = notice(&session, seq, Some(cursor(&appended)));
            next.entries = vec![appended];
            assert!(session.notice(&client, &settings, next).await.is_none());
        }
        let additional = session.scan_counts.misses - counted;
        assert!(
            session.scan_counts.header_misses - headers <= 3,
            "unchanged line headers must also reuse their counts"
        );
        assert!(additional <= 3, "ordinary notice passes must count only newly eligible entries, versus one count per scanned line before caching: {additional}");
        assert!(client.reads.lock().unwrap().is_empty());
        println!("NOTICE_COUNTS model={}/{} same_role={same_role} messages=9000 warm_counts={counted} ordinary_passes=3 additional_counts={additional}", session.conditions.model.provider, session.conditions.model.model);
    }
}
