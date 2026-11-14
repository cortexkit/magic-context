use super::*;

// --- The list parser ---

#[test]
fn the_parser_reads_every_learning_the_output_contract_shows() {
    let reply = "<learnings>\n<learning route=\"memory\" category=\"CONSTRAINTS\" events=\"e12,e40\">The rule a later agent follows.</learning>\n<learning route=\"observation\" category=\"COMMUNICATION\" events=\"e7,e19,e33\">What the user wants, stated in general terms.</learning>\n</learnings>";
    let parsed = parse_learnings(reply).unwrap();
    assert_eq!(
        parsed,
        vec![
            Ok(Learning {
                route: "memory".into(),
                category: "CONSTRAINTS".into(),
                events: vec![12, 40],
                text: "The rule a later agent follows.".into(),
            }),
            Ok(Learning {
                route: "observation".into(),
                category: "COMMUNICATION".into(),
                events: vec![7, 19, 33],
                text: "What the user wants, stated in general terms.".into(),
            }),
        ]
    );
}

#[test]
fn an_empty_list_is_a_valid_answer_and_no_list_is_refused() {
    assert_eq!(parse_learnings("<learnings></learnings>").unwrap(), vec![]);
    assert_eq!(
        parse_learnings("Nothing recurs.\n<learnings/>").unwrap(),
        vec![]
    );
    assert!(parse_learnings("Nothing recurs here.").is_err());
    assert!(parse_learnings("<learnings><learning route=\"memory\">").is_err());
}

#[test]
fn the_answer_is_the_last_list_not_an_example_before_it() {
    let reply = "Like the contract's <learnings><learning route=\"memory\" category=\"NAMING\" events=\"e1,e2\">Example.</learning></learnings>, my answer:\n<learnings>\n<learning route=\"memory\" category=\"CONSTRAINTS\" events=\"e3, 4\">Plan around the provider's rate limit.</learning>\n</learnings>";
    let parsed = parse_learnings(reply).unwrap();
    assert_eq!(parsed.len(), 1);
    let learning = parsed[0].as_ref().unwrap();
    assert_eq!(
        (learning.events.clone(), learning.category.as_str()),
        (vec![3, 4], "CONSTRAINTS")
    );
}

#[test]
fn a_learning_it_cannot_read_is_one_refusal_and_the_rest_still_parse() {
    let reply = "<learnings>\n<learning route=\"memory\" category=\"NAMING\" events=\"\">No events.</learning>\n<learning route=\"memory\" category=\"NAMING\" events=\"e1,x9\">Bad id.</learning>\n<learning route=\"memory\" category=\"NAMING\" events=\"e1,e2\">   </learning>\n<learning route=\"memory\" category=\"NAMING\" events=\"e1,e2\"/>\n<learning route=\"Memory\" category=\"NAMING\" events=\"e1,e2,e1\">Names   stay\n short.</learning>\n</learnings>";
    let parsed = parse_learnings(reply).unwrap();
    assert_eq!(parsed[0], Err("the learning cites no events".into()));
    assert_eq!(parsed[1], Err("x9 is not an event id".into()));
    assert_eq!(parsed[2], Err("the learning has no text".into()));
    assert_eq!(parsed[3], Err("the learning has no text".into()));
    assert_eq!(
        parsed[4],
        Ok(Learning {
            route: "memory".into(),
            category: "NAMING".into(),
            events: vec![1, 2],
            text: "Names stay short.".into(),
        })
    );
}

#[test]
fn each_xml_entity_is_written_out_exactly_once() {
    let reply = "<learnings><learning route=\"memory\" category=\"NAMING\" events=\"e1,e2\">Write &amp;lt; and &amp;amp; literally; plain &lt;tag&gt; is a tag.</learning></learnings>";
    let parsed = parse_learnings(reply).unwrap();
    assert_eq!(
        parsed[0].as_ref().unwrap().text,
        "Write &lt; and &amp; literally; plain <tag> is a tag."
    );
}

// --- The text checks ---

#[test]
fn a_clean_rule_passes_every_text_check() {
    assert_eq!(
        text_refusal(
            "Run the focused test suite before declaring a fix complete.",
            &[]
        ),
        None
    );
}

#[test]
fn an_apostrophe_inside_a_word_is_not_a_quotation_mark() {
    for text in [
        "Don't restart the host while a summary runs.",
        "The agent's checkout is read only.",
        "It\u{2019}s the provider\u{2019}s limit, not ours.",
        "Use `cargo fmt` before a commit.",
    ] {
        assert_eq!(quotation_mark(text), None, "{text}");
        assert_eq!(text_refusal(text, &[]), None, "{text}");
    }
}

#[test]
fn every_kind_of_quotation_mark_refuses_a_learning() {
    for (text, mark) in [
        ("They said \"do it now please\".", '"'),
        (
            "Call it a \u{201c}soft bust\u{201d} from now on.",
            '\u{201c}',
        ),
        ("Name it the \u{201e}head\u{201c}.", '\u{201e}'),
        (
            "The so-called \u{00ab}fold\u{00bb} rebuilds the head.",
            '\u{00ab}',
        ),
        ("Prefer \u{2039}short\u{203a} answers.", '\u{2039}'),
        ("The user wants \u{2018}short\u{2019} answers.", '\u{2018}'),
        ("Never write 'quoted' words.", '\''),
        ("The agents' builds share one cache.", '\''),
        ("Keep \u{2019}em short.", '\u{2019}'),
    ] {
        assert_eq!(quotation_mark(text), Some(mark), "{text}");
        assert_eq!(
            text_refusal(text, &[]),
            Some(format!("the text holds a quotation mark ({mark})")),
            "{text}"
        );
    }
}

#[test]
fn a_date_refuses_a_learning_but_a_version_does_not() {
    for text in [
        "Broke on 2026-06-20 release.",
        "Since 11/14/2026 the host restarts nightly.",
        "After Nov 14, 2026 the API changed.",
    ] {
        assert!(
            text_refusal(text, &[])
                .is_some_and(|reason| reason.starts_with("the text holds a date")),
            "{text}"
        );
    }
    assert_eq!(
        text_refusal("Version 2.3.4 of the SDK drops streaming.", &[]),
        None
    );
}

#[test]
fn a_frustration_phrase_refuses_a_learning() {
    for text in [
        "That's wrong again, check the cache first.",
        "No, no, stop guessing the schema.",
        "This is wrong and needs a fix.",
        "Read the docs first!!!",
    ] {
        assert!(
            text_refusal(text, &[])
                .is_some_and(|reason| reason.starts_with("the text keeps a frustration phrase")),
            "{text}"
        );
    }
}

#[test]
fn a_long_shared_run_of_words_refuses_a_learning_and_a_short_one_does_not() {
    let source = ["the historian must never run during an active tool call window"];
    assert!(copies_a_run(
        "Ensure the historian must never run during an active tool call window.",
        &source
    ));
    assert!(!copies_a_run(
        "Keep the historian idle during tool use.",
        &source
    ));
    assert_eq!(
        text_refusal(
            "Avoid using bash to search the codebase instead of the dedicated search tool.",
            &["you keep using bash to search the codebase instead of the dedicated search tool"],
        ),
        Some("the text copies a run of words from the events it cites".into())
    );
    assert_eq!(
        text_refusal(
            "Prefer indexed search tools over shell scans for code lookups.",
            &["you keep using bash to search the codebase instead of the dedicated search tool"],
        ),
        None
    );
}

#[test]
fn a_run_anywhere_in_a_long_source_is_found() {
    let filler: Vec<String> = (0..500).map(|index| format!("filler{index}")).collect();
    let tail = "delete the production database without any backup whatsoever";
    let source = format!("{} {tail}", filler.join(" "));
    assert!(copies_a_run(&format!("Note: {tail}."), &[source.as_str()]));
}

#[test]
fn a_short_learning_counts_half_its_own_length_as_a_copied_run() {
    // Four words: a run of three copied words is a copy.
    assert!(copies_a_run(
        "Retry the upload twice.",
        &["we should retry the upload later"]
    ));
    assert!(!copies_a_run(
        "Retry uploads twice.",
        &["we should retry the upload later"]
    ));
}
