//! Recorded prompt and response pairs for a scripted historian: a responder
//! with no model that reads ck-mc's historian prompt and answers with one
//! compartment covering the chunk. A test rig without a historian model uses
//! one so ck-mc folds its sessions.
//!
//! Three consecutive folds of one session go through the provider (async
//! lane) assembler and ck-mc's own historian validation. Each prompt must
//! match its recorded file byte for byte, the responder's answer must match
//! the recorded response, and that response must validate and leave the store
//! ready for the next fold. A port of the responder in another language is
//! checked against the same files. Set `MC_BLESS_SCRIPTED_HISTORIAN_PAIRS=1`
//! to rewrite them after an intended prompt change.
use super::*;
use crate::historian_chunk::{
    assemble_provider_historian_firing, AssembleHistorianFiringOutcome, HistorianAssemblerConfig,
};
use crate::historian_validate::validate_historian_output;

const BLESS_ENV: &str = "MC_BLESS_SCRIPTED_HISTORIAN_PAIRS";
const SESSION: &str = "ses-scripted-historian";

fn pairs_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/scripted-historian")
}

/// The scripted responder, ported line for line from the reference
/// TypeScript module. It reads only the `<new_messages>` block's
/// `Messages S-E:` header and the block headers under it.
fn scripted_historian_response(prompt: &str) -> Result<String, String> {
    const OPEN: &str = "<new_messages>\n\nMessages ";
    const CLOSE: &str = "\n\n</new_messages>";
    let at = prompt
        .find(OPEN)
        .ok_or("no <new_messages> block with a Messages header")?
        + OPEN.len();
    let rest = &prompt[at..];
    let colon = rest.find(":\n\n").ok_or("unterminated Messages header")?;
    let (start, end) = rest[..colon]
        .split_once('-')
        .ok_or("Messages header without a range")?;
    let digits = |text: &str| {
        (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
            .then(|| text.parse::<u64>().ok())
            .flatten()
    };
    let (start, end) = (
        digits(start).ok_or("bad range start")?,
        digits(end).ok_or("bad range end")?,
    );
    if end < start {
        return Err("range end before start".into());
    }
    let close = rest.rfind(CLOSE).ok_or("no </new_messages>")?;
    let body = rest.get(colon + 3..close).unwrap_or("");
    let blocks = body
        .split('\n')
        .filter(|line| is_block_header(line))
        .count();
    Ok(format!(
        "<output>\n<compartments>\n<compartment start=\"{start}\" end=\"{end}\" title=\"Scripted fold {start}-{end}\" episode_type=\"feature\" importance=\"50\">\n<p1>Scripted summary of raw messages {start}-{end}: {blocks} transcript blocks.</p1>\n<p2>Scripted summary of raw messages {start}-{end}.</p2>\n<p3>Messages {start}-{end}.</p3>\n<p4 />\n</compartment>\n</compartments>\n<meta><messages_processed>{start}-{end}</messages_processed><unprocessed_from>{}</unprocessed_from></meta>\n</output>\n",
        end + 1
    ))
}

/// `[N] R:` or `[N-M] R:` at the start of a line, `R` one or more of A-Z.
fn is_block_header(line: &str) -> bool {
    let Some(rest) = line.strip_prefix('[') else {
        return false;
    };
    let Some(close) = rest.find("] ") else {
        return false;
    };
    let range = &rest[..close];
    let numeric = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit());
    let range_ok = match range.split_once('-') {
        Some((a, b)) => numeric(a) && numeric(b),
        None => numeric(range),
    };
    let role = &rest[close + 2..];
    let letters = role.bytes().take_while(u8::is_ascii_uppercase).count();
    range_ok && letters > 0 && role.as_bytes().get(letters) == Some(&b':')
}

fn message(mid: &str, ordinal: u64, role: &str, blocks: Vec<CkKind>) -> CkIngressMessage {
    CkIngressMessage {
        mid: mid.to_string(),
        ordinal,
        ck: CkWireMessage::from_parts(
            role,
            blocks
                .into_iter()
                .map(|kind| CkWireBlock::with_provider_extras(kind, ProviderExtras::default()))
                .collect(),
            None,
            ProviderExtras::default(),
            HarnessMeta::default(),
        ),
    }
}

fn say(text: &str) -> CkKind {
    CkKind::Text {
        text: text.to_string(),
    }
}

fn call(id: &str, name: &str, input: Value) -> CkKind {
    CkKind::ToolCall {
        id: id.to_string(),
        name: name.to_string(),
        input,
        provider_executed: false,
    }
}

fn result(id: &str, name: &str, output: &str) -> CkKind {
    CkKind::ToolResult {
        id: id.to_string(),
        tool_name: name.to_string(),
        output: CkToolOutput::bare(CkOutputKind::Text {
            text: output.to_string(),
        }),
        provider_executed: false,
    }
}

/// A coding session with tool calls, so some block headers span several raw
/// ordinals (`[2-3] A:`), ending in a protected tail message.
fn session() -> Vec<CkIngressMessage> {
    vec![
        message("m1", 1, "user", vec![say("Please add a retry budget to the uploader; failures should back off instead of retrying at once.")]),
        message("m2", 2, "assistant", vec![say("I'll read the uploader first."), call("c2", "read", json!({"path":"src/uploader.rs"}))]),
        message("m3", 3, "tool", vec![result("c2", "read", "pub fn upload(item: &Item) -> Result<()> {\n    loop {\n        if send(item).is_ok() { return Ok(()); }\n    }\n}")]),
        message("m4", 4, "assistant", vec![say("The uploader retries in a tight loop. I'll add exponential backoff capped at 30 s."), call("c4", "edit", json!({"path":"src/uploader.rs"}))]),
        message("m5", 5, "tool", vec![result("c4", "edit", "Edited src/uploader.rs")]),
        message("m6", 6, "user", vec![say("Also log one line per failed attempt.")]),
        message("m7", 7, "assistant", vec![say("Added a warn line per attempt. Running the tests."), call("c7", "bash", json!({"command":"cargo test -p uploader"}))]),
        message("m8", 8, "tool", vec![result("c7", "bash", "test result: ok. 12 passed; 0 failed")]),
        message("m9", 9, "user", vec![say("Great. Now document the new setting in the README.")]),
        message("m10", 10, "assistant", vec![say("Documenting `retry_max_secs`."), call("c10", "edit", json!({"path":"README.md"}))]),
        message("m11", 11, "tool", vec![result("c10", "edit", "Edited README.md")]),
        message("m12", 12, "user", vec![say("Commit it.")]),
        message("m13", 13, "assistant", vec![say("Committed as abc1234: uploader: back off between retries.")]),
        message("m14", 14, "user", vec![say("Next, the downloader needs the same treatment.")]),
    ]
}

fn assemble(
    store: &mc_store::McStore,
    messages: &[CkIngressMessage],
    eligible_end: u64,
) -> crate::historian_chunk::AssembledHistorianFiring {
    let projection = crate::ck_wire::project_messages(messages).unwrap();
    let outcome = assemble_provider_historian_firing(
        store,
        messages,
        &projection.blocks,
        &projection.identity_by_mid,
        HistorianAssemblerConfig {
            expand_tools: BTreeMap::new(),
            model_limits: Default::default(),
            model_variants: Default::default(),
            session_id: SESSION.to_string(),
            project_path: "/proj".to_string(),
            project_slug: "proj".to_string(),
            model_chain: vec!["scripted/historian".to_string()],
            token_budget: 32_000,
            historian_context_limit_tokens: None,
            max_output_tokens: 32_000,
            boundary: crate::boundary::BoundaryResolution {
                protected_start_ordinal: eligible_end,
                eligible_head: 1..eligible_end,
                n_tokens: 0.0,
                floored_by_live_prompt: false,
                fenced_by_open_arc: false,
                true_raw_eligible_tokens: 10_000.0,
                oversize_atomic_unit: false,
                raw_message_count: messages.len() as u64,
                boundary_reason: "test".to_string(),
            },
            memory_enabled: true,
            auto_promote: true,
            user_memory_collection_enabled: false,
            // These recorded prompts assume a running user-memory reviewer.
            user_observations_requested: true,
            extraction_free: false,
            in_emergency: false,
            force_keep_last_compartment: false,
            fold_is_only_reclaim: false,
            failure_backoff_at_ms: 0,
            min_chunk_tokens: 0,
        },
        1_700_000_000_000,
    )
    .unwrap();
    let AssembleHistorianFiringOutcome::Fire(firing) = outcome else {
        panic!("expected a firing below ordinal {eligible_end}: {outcome:?}");
    };
    *firing
}

/// Compares `actual` with the recorded file, or records it under bless.
fn recorded(name: &str, actual: &str) {
    let path = pairs_dir().join(name);
    if std::env::var_os(BLESS_ENV).is_some() {
        std::fs::create_dir_all(pairs_dir()).unwrap();
        std::fs::write(&path, actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}; set {BLESS_ENV}=1", path.display()));
    assert!(
        expected == actual,
        "{name} changed; rerun with {BLESS_ENV}=1 only if the change is intended"
    );
}

#[test]
fn scripted_historian_pairs_validate_and_fold_three_consecutive_chunks() {
    let fixture = crate::test_support::FixtureBuilder::store();
    let store = &fixture.store;
    let messages = session();
    let mut published: Vec<StoredCompartment> = Vec::new();
    // Each fold's protected boundary, and the chunk it must produce.
    for (pair, (eligible_end, from, to)) in
        [(6, 1, 5), (9, 6, 8), (14, 9, 13)].into_iter().enumerate()
    {
        let pair = pair + 1;
        let firing = assemble(store, &messages, eligible_end);
        assert_eq!((firing.from_ordinal, firing.to_ordinal), (from, to));
        assert!(firing
            .prompt
            .contains(&format!("<new_messages>\n\nMessages {from}-{to}:\n\n")));
        recorded(&format!("pair-{pair}.prompt.txt"), &firing.prompt);

        let response = scripted_historian_response(&firing.prompt).unwrap();
        recorded(&format!("pair-{pair}.response.xml"), &response);

        let validated = validate_historian_output(
            &response,
            &firing.chunk.chunk,
            &firing.prior_compartments,
            firing.validate_options,
        )
        .unwrap_or_else(|error| panic!("pair {pair} rejected: {error}"));
        assert_eq!(validated.compartments.len(), 1, "pair {pair}");
        let compartment = &validated.compartments[0];
        assert_eq!(
            (compartment.start_message, compartment.end_message),
            (from, to)
        );
        assert_eq!(validated.unprocessed_from, to + 1);
        assert!(!validated.discarded_last);

        // Persist as the publish path does, so the next fold starts after it
        // and its prompt carries this compartment as a session reference.
        published.push(StoredCompartment {
            sequence: compartment.sequence as i64,
            start_message: compartment.start_message as i64,
            end_message: compartment.end_message as i64,
            start_message_id: compartment.start_message_id.clone(),
            end_message_id: compartment.end_message_id.clone(),
            title: compartment.title.clone(),
            content: compartment.content.clone(),
            p1: compartment.p1.clone(),
            p2: compartment.p2.clone(),
            p3: compartment.p3.clone(),
            p4: compartment.p4.clone(),
            importance: compartment.importance.map(|i| i as i32).unwrap_or(50),
            episode_type: compartment.episode_type.clone(),
            created_at: 1_700_000_000_000,
            ..Default::default()
        });
        store.replace_compartments(SESSION, &published).unwrap();
    }
}

/// The `<unprocessed_from>` cases the responder relies on, against the same
/// validator: a fully covered chunk may omit the tag or give `end + 1`; the
/// chunk's own last ordinal or `0` (both seen from real models) is rejected.
#[test]
fn scripted_historian_unprocessed_from_cases() {
    let fixture = crate::test_support::FixtureBuilder::store();
    let firing = assemble(&fixture.store, &session(), 6);
    let response = scripted_historian_response(&firing.prompt).unwrap();
    let check = |text: &str| {
        validate_historian_output(
            text,
            &firing.chunk.chunk,
            &firing.prior_compartments,
            firing.validate_options,
        )
    };
    let tag = "<unprocessed_from>6</unprocessed_from>";
    assert!(response.contains(tag));
    assert!(check(&response).is_ok());
    assert!(
        check(&response.replace(tag, "")).is_ok(),
        "omitted when fully covered"
    );
    let same_end = check(&response.replace(tag, "<unprocessed_from>5</unprocessed_from>"));
    assert!(same_end
        .unwrap_err()
        .message
        .contains("does not match completed chunk boundary 6"));
    let zero = check(&response.replace(tag, "<unprocessed_from>0</unprocessed_from>"));
    assert!(zero.unwrap_err().message.contains("is outside chunk 1-5"));
    // A partial answer names the first ordinal it left out.
    let partial = response
        .replace("end=\"5\"", "end=\"3\"")
        .replace(tag, "<unprocessed_from>4</unprocessed_from>");
    let validated = check(&partial).unwrap();
    assert_eq!(validated.compartments[0].end_message, 3);
    assert_eq!(validated.unprocessed_from, 4);
    // A compartment without `<p1>` is the flat v1 shape and never publishes.
    assert!(check(&response.replace("<p1>", "<x>").replace("</p1>", "</x>")).is_err());
    assert!(scripted_historian_response("no historian prompt here").is_err());
}
