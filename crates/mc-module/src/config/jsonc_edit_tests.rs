//! Pointer edits made to a settings file's text ([`super::jsonc::edit`]).

use serde_json::json;

use super::edit::Edit;
use super::jsonc::edit;

#[test]
fn a_set_replaces_the_value_and_keeps_every_comment_around_it() {
    let text = "{\n  // How early to summarize.\n  \"execute_threshold_percentage\": 70, // percent\n  /* the clock */\n  \"clock_note\": false,\n  \"language\": \"en\"\n}\n";
    let edited = edit(
        text,
        &[
            Edit::set("/execute_threshold_percentage", json!({"default": 70})),
            Edit::set("/clock_note", json!("off")),
        ],
    )
    .unwrap();
    assert_eq!(
        edited,
        "{\n  // How early to summarize.\n  \"execute_threshold_percentage\": { \"default\": 70 }, // percent\n  /* the clock */\n  \"clock_note\": \"off\",\n  \"language\": \"en\"\n}\n"
    );
}

#[test]
fn a_new_member_goes_on_its_own_line_after_the_last_one() {
    let text = "{\n  \"rerank\": {\n    \"module\": \"synapse\" // local\n  }\n}\n";
    assert_eq!(
        edit(text, &[Edit::set("/rerank/enabled", json!(false))]).unwrap(),
        "{\n  \"rerank\": {\n    \"module\": \"synapse\", // local\n    \"enabled\": false\n  }\n}\n"
    );
    // The objects on the way are made when they don't exist yet.
    assert_eq!(
        edit(text, &[Edit::set("/dreamer/projects/kind", json!("all"))]).unwrap(),
        "{\n  \"rerank\": {\n    \"module\": \"synapse\" // local\n  },\n  \"dreamer\": { \"projects\": { \"kind\": \"all\" } }\n}\n"
    );
    // After a trailing comma, and into an empty object.
    assert_eq!(
        edit("{\n  \"a\": 1,\n}", &[Edit::set("/b", json!(2))]).unwrap(),
        "{\n  \"a\": 1,\n  \"b\": 2\n}"
    );
    assert_eq!(
        edit("{\n  \"a\": {\n  }\n}", &[Edit::set("/a/b", json!(2))]).unwrap(),
        "{\n  \"a\": {\n    \"b\": 2\n  }\n}"
    );
    assert_eq!(
        edit("{}", &[Edit::set("/a", json!(1))]).unwrap(),
        "{ \"a\": 1 }"
    );
}

#[test]
fn objects_on_one_line_stay_on_one_line() {
    assert_eq!(
        edit(r#"{"a": 1, "b": {"c": 2}}"#, &[Edit::set("/b/d", json!(3))]).unwrap(),
        r#"{"a": 1, "b": {"c": 2, "d": 3}}"#
    );
    assert_eq!(
        edit(r#"{"a": 1, "b": 2}"#, &[Edit::remove("/b")]).unwrap(),
        r#"{"a": 1 }"#
    );
    assert_eq!(
        edit(r#"{"a": 1, "b": 2}"#, &[Edit::remove("/a")]).unwrap(),
        r#"{ "b": 2}"#
    );
}

#[test]
fn a_removed_member_takes_its_comma_and_its_line_but_no_comment() {
    let text =
        "{\n  // about a\n  \"a\": 1,\n  // about b\n  \"b\": 2, // b's note\n  \"c\": 3\n}\n";
    assert_eq!(
        edit(text, &[Edit::remove("/a")]).unwrap(),
        "{\n  // about a\n  // about b\n  \"b\": 2, // b's note\n  \"c\": 3\n}\n"
    );
    assert_eq!(
        edit(text, &[Edit::remove("/b")]).unwrap(),
        "{\n  // about a\n  \"a\": 1,\n  // about b\n   // b's note\n  \"c\": 3\n}\n"
    );
    // The last member gives up the comma before it.
    assert_eq!(
        edit(text, &[Edit::remove("/c")]).unwrap(),
        "{\n  // about a\n  \"a\": 1,\n  // about b\n  \"b\": 2 // b's note\n}\n"
    );
    assert_eq!(
        edit("{\n  \"a\": 1\n}\n", &[Edit::remove("/a")]).unwrap(),
        "{\n}\n"
    );
    // A whole section, and a member that isn't there.
    assert_eq!(
        edit(
            "{\n  \"x\": {\n    \"y\": 1\n  },\n  \"z\": 2\n}",
            &[Edit::remove("/x"), Edit::remove("/q")]
        )
        .unwrap(),
        "{\n  \"z\": 2\n}"
    );
}

#[test]
fn a_rename_keeps_the_value_and_the_comments_in_place() {
    let text = "{\n  \"dreamer\": {\n    /* Off while I travel. */\n    \"disable\": true, // for now\n    \"maxTokens\": 5000000\n  }\n}";
    assert_eq!(
        edit(
            text,
            &[
                Edit::rename("/dreamer/disable", "enabled"),
                Edit::set("/dreamer/enabled", json!(false)),
                Edit::rename("/dreamer/maxTokens", "max_tokens"),
            ],
        )
        .unwrap(),
        "{\n  \"dreamer\": {\n    /* Off while I travel. */\n    \"enabled\": false, // for now\n    \"max_tokens\": 5000000\n  }\n}"
    );
    assert!(edit(r#"{"a": 1, "b": 2}"#, &[Edit::rename("/a", "b")]).is_err());
}

#[test]
fn windows_line_ends_and_a_byte_order_mark_are_kept() {
    let text = "\u{feff}{\r\n  \"a\": 1 // one\r\n}\r\n";
    assert_eq!(
        edit(text, &[Edit::set("/b", json!(2))]).unwrap(),
        "\u{feff}{\r\n  \"a\": 1, // one\r\n  \"b\": 2\r\n}\r\n"
    );
    assert_eq!(
        edit(
            "{\r\n  \"a\": 1,\r\n  \"b\": 2\r\n}\r\n",
            &[Edit::remove("/b")]
        )
        .unwrap(),
        "{\r\n  \"a\": 1\r\n}\r\n"
    );
}

#[test]
fn a_key_written_twice_is_set_where_it_is_read_and_removed_everywhere() {
    let text = "{\n  \"a\": 1,\n  \"a\": 2\n}";
    assert_eq!(
        edit(text, &[Edit::set("/a", json!(3))]).unwrap(),
        "{\n  \"a\": 1,\n  \"a\": 3\n}"
    );
    assert_eq!(edit(text, &[Edit::remove("/a")]).unwrap(), "{\n}");
}

#[test]
fn keys_with_slashes_and_tildes_are_addressed_by_their_escapes() {
    let text = r#"{"m": {"openai/gpt-5": 60, "a~b": 1}}"#;
    assert_eq!(
        edit(
            text,
            &[
                Edit::set("/m/openai~1gpt-5", json!(70)),
                Edit::remove("/m/a~0b")
            ]
        )
        .unwrap(),
        r#"{"m": {"openai/gpt-5": 70 }}"#
    );
}

#[test]
fn a_file_it_cannot_read_completely_is_refused_unchanged() {
    for (text, edits) in [
        // A syntax issue the reader recovers from.
        (r#"{"a": 1 "b": 2}"#, vec![Edit::set("/c", json!(3))]),
        // Not an object at the top.
        ("[1, 2]", vec![Edit::set("/c", json!(3))]),
        // Through a value that is not an object.
        (r#"{"a": 1}"#, vec![Edit::set("/a/b", json!(3))]),
        // The whole file.
        (r#"{"a": 1}"#, vec![Edit::remove("")]),
    ] {
        assert!(edit(text, &edits).is_err(), "{text}");
    }
}
