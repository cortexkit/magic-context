//! Every library function behind one JSON entry point, [`call`], and the
//! test vectors built on it.
//!
//! A runner that is not written in Rust (THALAMUS's OpenCode runner renders
//! in JavaScript) uses the library through the WebAssembly build, which
//! exports exactly [`call`]. A runner that implements the rules itself checks
//! its implementation against `vectors/cases.json`: for every [`Vector`],
//! calling its function with its input must give exactly its output. The
//! vectors are generated from this library and checked against it by the
//! crate's own tests, so they never describe anything but what it does.

use ck_contract_draft::part::{body_digest, Part, PartBody, Seal};
use ck_contract_draft::read::{entry_digest, Entry, NoticeOrigin, Role};
use ck_contract_draft::rules::ProviderRules;
use ck_contract_draft::view::{Edit, View};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{clean, render, rules, tags};

/// One test vector.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Vector {
    /// What the case shows, in a few words.
    pub name: String,
    /// One of [`FUNCTIONS`].
    pub function: String,
    pub input: Value,
    /// What [`call`] answers for `input`: `{"ok": …}` or `{"refused": …}`.
    pub output: Value,
}

/// The functions [`call`] serves, with the input each takes.
pub const FUNCTIONS: &[(&str, &str)] = &[
    ("plan", "{entries, edits}: the render plan, or the refusal"),
    (
        "apply",
        "{entries, view}: the rendered messages, or the refusal (checksum included)",
    ),
    (
        "edits_for_transcript",
        "{entries, edits}: the edits that still name messages in the transcript",
    ),
    (
        "check_carried",
        "{previous?, next}: whether the new view repeats the edits the runner applies now",
    ),
    (
        "check_rules",
        "{entries, edits, rules}: whether every signed part the view keeps stays valid",
    ),
    (
        "rules_defaults",
        "{model}: the rules a runner declares for a model",
    ),
    (
        "assign_tags",
        "{checkpoint, entries}: the entries with their parts numbered",
    ),
    (
        "tag_numbers_in",
        "{text}: every tag number written in the text",
    ),
    (
        "clean_reply",
        "{text}: a model reply with its tag notation removed",
    ),
    (
        "entry_digest",
        "{role, notice?, parts}: an entry's checksum",
    ),
    ("body_digest", "{seal?, body}: a part's checksum"),
    ("seal_view", "{version, edits}: the view with its checksum"),
];

/// Call one library function by name with JSON input. Answers
/// `{"ok": value}`, `{"refused": refusal}` for a view the function refuses,
/// or `{"error": message}` for an unknown function or malformed input.
pub fn call(function: &str, input: Value) -> Value {
    match dispatch(function, input) {
        Ok(Outcome::Ok(value)) => json!({ "ok": value }),
        Ok(Outcome::Refused(value)) => json!({ "refused": value }),
        Err(message) => json!({ "error": message }),
    }
}

enum Outcome {
    Ok(Value),
    Refused(Value),
}

fn dispatch(function: &str, input: Value) -> Result<Outcome, String> {
    Ok(match function {
        "plan" => {
            let input: EntriesEdits = parse(input)?;
            refusable(render::plan(&input.entries, &input.edits))
        }
        "apply" => {
            let input: EntriesView = parse(input)?;
            refusable(render::apply(&input.entries, &input.view))
        }
        "edits_for_transcript" => {
            let input: EntriesEdits = parse(input)?;
            ok(render::edits_for_transcript(&input.entries, &input.edits))
        }
        "check_carried" => {
            let input: Carried = parse(input)?;
            refusable(render::check_carried(input.previous.as_ref(), &input.next))
        }
        "check_rules" => {
            let input: RulesInput = parse(input)?;
            refusable(rules::check(&input.entries, &input.edits, &input.rules))
        }
        "rules_defaults" => {
            let input: Model = parse(input)?;
            ok(rules::defaults(&input.model))
        }
        "assign_tags" => {
            let mut input: Numbering = parse(input)?;
            tags::assign_tags(input.checkpoint, &mut input.entries);
            ok(input.entries)
        }
        "tag_numbers_in" => {
            let input: Text = parse(input)?;
            ok(tags::tag_numbers_in(&input.text))
        }
        "clean_reply" => {
            let input: Text = parse(input)?;
            ok(clean::clean_reply(&input.text))
        }
        "entry_digest" => {
            let input: EntryParts = parse(input)?;
            ok(entry_digest(
                input.role,
                input.notice.as_ref(),
                &input.parts,
            ))
        }
        "body_digest" => {
            let input: Body = parse(input)?;
            ok(body_digest(input.seal, &input.body))
        }
        "seal_view" => {
            let input: Sealing = parse(input)?;
            ok(View::seal(input.version, input.edits))
        }
        other => return Err(format!("unknown function {other}")),
    })
}

fn parse<T: DeserializeOwned>(input: Value) -> Result<T, String> {
    serde_json::from_value(input).map_err(|error| format!("malformed input: {error}"))
}

fn ok<T: Serialize>(value: T) -> Outcome {
    Outcome::Ok(serde_json::to_value(value).expect("library types serialize"))
}

fn refusable<T: Serialize, E: Serialize>(result: Result<T, E>) -> Outcome {
    match result {
        Ok(value) => ok(value),
        Err(refusal) => {
            Outcome::Refused(serde_json::to_value(refusal).expect("refusals serialize"))
        }
    }
}

#[derive(Deserialize)]
struct EntriesEdits {
    entries: Vec<Entry>,
    edits: Vec<Edit>,
}

#[derive(Deserialize)]
struct EntriesView {
    entries: Vec<Entry>,
    view: View,
}

#[derive(Deserialize)]
struct Carried {
    #[serde(default)]
    previous: Option<View>,
    next: View,
}

#[derive(Deserialize)]
struct RulesInput {
    entries: Vec<Entry>,
    edits: Vec<Edit>,
    rules: ProviderRules,
}

#[derive(Deserialize)]
struct Model {
    model: String,
}

#[derive(Deserialize)]
struct Numbering {
    checkpoint: u64,
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
struct Text {
    text: String,
}

#[derive(Deserialize)]
struct EntryParts {
    role: Role,
    #[serde(default)]
    notice: Option<NoticeOrigin>,
    parts: Vec<Part>,
}

#[derive(Deserialize)]
struct Body {
    #[serde(default)]
    seal: Seal,
    #[serde(flatten)]
    body: PartBody,
}

#[derive(Deserialize)]
struct Sealing {
    version: u64,
    edits: Vec<Edit>,
}
