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

/// Texts that exercise the tokenizers differently: prose, code, accented and
/// CJK text with an emoji, HTML, and the tag and placeholder forms ck-mc
/// writes into the prompt.
const COUNTED_SAMPLES: [&str; 5] = [
    "Read src/session.rs, preserve the cached prefix, then cargo test.",
    "fn main() {\n    let x: Vec<u64> = (1..=10).map(|n| n * n).collect();\n    println!(\"{x:?}\");\n}\n",
    "Grüße — 東京の天気は晴れ。 🚀 naïve café",
    "<div class=\"note\"><p>Keep <b>m[0]</b> stable.</p></div>",
    "§12§ [dropped §201§] <session-history>\n</session-history>",
];

/// A session's counts decide which summaries and memories fit its history
/// head, so a tokenizer dependency upgrade must not move them for models it
/// did not mean to change. These counts were recorded with cortexkit-tokens
/// 0.1.0; each Claude family, and Haiku 5.5's estimate, must keep them.
#[test]
fn claude_sessions_count_exactly_as_with_the_first_tokenizer_release() {
    let expected: [(&str, &str, [u64; 5]); 5] = [
        ("claude-opus-5-5", "Some(ClaudeV5)", [25, 49, 26, 30, 23]),
        (
            "claude-sonnet-5-5",
            "Some(ClaudeV5Sonnet)",
            [25, 49, 26, 30, 23],
        ),
        ("claude-opus-4-7", "Some(ClaudeV47)", [25, 49, 26, 30, 23]),
        ("claude-opus-4-1", "Some(ClaudeV3)", [16, 44, 26, 25, 21]),
        // Haiku 5.5's vocabulary is only approximated, so ck-mc estimates it.
        ("claude-haiku-5-5", "None", [16, 44, 24, 24, 20]),
    ];
    let actual: Vec<(&str, String, [u64; 5])> = expected
        .iter()
        .map(|(model, _, _)| {
            let (mut session, _, _, _, _) = fixture();
            session.conditions.model = ModelRef::new("anthropic", *model);
            let counter = session.counter();
            (
                *model,
                format!("{:?}", counter.family()),
                COUNTED_SAMPLES.map(|text| counter.count(text)),
            )
        })
        .collect();
    let expected: Vec<(&str, String, [u64; 5])> = expected
        .iter()
        .map(|(model, family, counts)| (*model, family.to_string(), *counts))
        .collect();
    assert_eq!(actual, expected);
}

/// Gemini 3 onward reads text with Gemma 4's vocabulary, which the tokenizer
/// crate counts exactly, so a session on an Antigravity Gemini route counts
/// in it instead of estimating with Claude's vocabulary: no conversion
/// between local and provider budgets either.
#[test]
fn a_gemini_session_counts_in_the_gemini_vocabulary() {
    let (mut session, _, _, _, _) = fixture();
    session.conditions.model = ModelRef::new("google", "antigravity-gemini-3.8-flash");
    let counter = session.counter();
    assert_eq!(counter.family(), Some(cortexkit_tokens::Family::Gemini));
    assert_eq!(counter.local_budget(1000.0), 1000.0);
    let counts = COUNTED_SAMPLES.map(|text| counter.count(text));
    assert_eq!(
        counts,
        COUNTED_SAMPLES.map(|text| {
            cortexkit_tokens::count(cortexkit_tokens::Family::Gemini, text).unwrap()
        })
    );
    assert_ne!(
        counts,
        COUNTED_SAMPLES.map(|text| mc_tokenizer::estimate_tokens(text) as u64),
        "the samples must tell Gemini's counts from the estimator's"
    );
}
