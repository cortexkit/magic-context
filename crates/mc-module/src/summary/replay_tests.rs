//! A side-by-side replay of the summarizer's two turns, for reading by hand.
//!
//! The summarizer's texts are moving from the 0.49 plugin's texts
//! ([`SummaryPrompts::plugin`], arm `a-today`) to the texts rendered from the
//! bundled coding profile ([`SummaryPrompts::bundled`], arm `b-profile`).
//! The two ignored tests below write, for every chunk and both arms, the
//! exact requests the module would send, so that both texts can run on the
//! same chunk with the same model. Nothing here calls a provider:
//! `.cortexkit/scripts/summary-replay/send.ts` sends the requests, and the
//! README beside it has the commands and the output layout.
//!
//! - [`turn_one_requests`] writes `$OUT/<case>/<arm>/turn-one.request.json`
//!   and `$OUT/manifest.json`.
//! - [`turn_two_requests`] reads each `turn-one.reply.json` the sender wrote,
//!   checks the reply with the module's own parser and validator, publishes
//!   it in a throwaway store as a first turn does, and captures the second
//!   turn the module then sends, as `turn-two.request.json`. Every arm also
//!   gets `turn-two.status.json`, which says what became of the reply.
//!
//! The chunks are of two kinds. A recorded chunk is a summarizer prompt of
//! the 0.49 plugin, with its memory block already cut out: its calibration
//! examples, session references and `<new_messages>` block are kept as they
//! are, and the module's prompt builder puts them together with each arm's
//! first-turn instruction. A synthetic chunk is a short session written as
//! printed lines: the module prints it with its own chunk builder and picks
//! its calibration examples as it does for a new session.
//!
//! Paths come from the environment: `SUMMARY_REPLAY_OUT` (required),
//! `SUMMARY_REPLAY_CORPUS` (the folder holding the recorded chunks'
//! `manifest.json`, `inputs/` and `recordings/`), `SUMMARY_REPLAY_SYNTHETIC`
//! (a folder of synthetic chunks), and optionally `SUMMARY_REPLAY_LANGUAGE`,
//! the user's `language` setting, which adds the content-language directive
//! to the system prompt as a run with that setting does.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use cortexkit_role_compaction::part::{Part, PartBody};
use cortexkit_role_compaction::read::{Entry, Role, SessionRef};
use cortexkit_role_compaction::setup::ModelRef;
use regex::Regex;
use serde_json::{json, Value};

use super::chunk::{self, Lines, PrintedBlock};
use super::fit;
use super::prompt::{build_compartment_agent_prompt, CompartmentPromptInputs};
use super::prompts::SummaryPrompts;
use super::run::{two_pass_system, Continuation, CHILD};
use super::two_pass::{turn_one, turn_two};
use super::validate::{validate_historian_output, ChunkLine, HistorianChunk, ValidateOptions};
use crate::client::Child;
use crate::context_db::{ContextDb, Recall};

/// The two sets of texts, by the folder name each arm's files go in.
const ARMS: [&str; 2] = ["a-today", "b-profile"];

/// The output a summarizer run asks for (`MAX_OUTPUT_TOKENS` in `run.rs`).
const OUTPUT_TOKENS: u64 = 32_000;
/// The chunk budget a synthetic chunk is built and fitted with: the
/// largest the module asks for (`CHUNK_MAX_TOKENS` in `run.rs`). A
/// synthetic chunk is far smaller, so it is never cut.
const CHUNK_TOKENS: u64 = 50_000;

/// Names for the throwaway store the second turn runs against. None of
/// them reaches a prompt.
const PROJECT: &str = "summary-replay";
const RUNNER: &str = "summary-replay";
const HARNESS: &str = "summary-replay";

const SEEDS_OPEN: &str = "<compartment_examples_from_other_projects>\n";
const SEEDS_CLOSE: &str = "</compartment_examples_from_other_projects>";
const REFERENCES_OPEN: &str = "<session_references>\n";
const REFERENCES_CLOSE: &str = "</session_references>";
const NEW_MESSAGES_OPEN: &str = "<new_messages>\n\n";
const NEW_MESSAGES_CLOSE: &str = "\n\n</new_messages>\n\n";
/// Stands in for the memory block that was cut out of each recorded
/// prompt. The cut removed the block's text and left its place between the
/// session references and `<new_messages>`, so a rebuild with this marker
/// in the block's place, then removed, gives the recorded bytes back.
const MEMORY_SLOT: &str = "\u{0}memory block\u{0}";

/// The texts one arm runs with.
fn arm_prompts(arm: &str) -> Arc<SummaryPrompts> {
    match arm {
        "a-today" => Arc::new(SummaryPrompts::plugin()),
        "b-profile" => SummaryPrompts::bundled(),
        other => panic!("unknown arm {other}"),
    }
}

/// One chunk to replay.
struct Case {
    /// The case's folder name, such as `corpus-07` or `synthetic-for-now`.
    name: String,
    /// The session the chunk's messages belong to. The second turn names it.
    session: String,
    /// The chunk's first and last ordinal.
    chunk: (u64, u64),
    /// What `<new_messages>` holds: `Messages A-B:` and the printed lines.
    input: String,
    /// What a reply's summaries are checked against.
    validation: HistorianChunk,
    /// Each printed line, in order: what a fact's anchor may cite.
    printed: Vec<PrintedBlock>,
    /// Where the first turn's calibration examples and session references
    /// come from.
    context: Context,
}

enum Context {
    /// A recorded chunk keeps its prompt's own blocks.
    Recorded { seeds: String, references: String },
    /// A synthetic chunk is a new session's: the arm's calibration examples,
    /// chosen as the module chooses them, and no earlier summaries.
    Fresh,
}

/// A line of a recording's `sourceBlocks`, or of a synthetic chunk.
struct SourceBlock {
    start: u64,
    end: u64,
    role: String,
    /// The printed line as the recording keeps it: followed by the newline
    /// that separates it from the next line or, for the chunk's last line,
    /// by the blank line before `</new_messages>`.
    printed: String,
    /// The messages the line covers, by ordinal and message id. Synthetic
    /// chunks list none.
    messages: Vec<(u64, String)>,
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn out_dir() -> PathBuf {
    env_path("SUMMARY_REPLAY_OUT").expect("set SUMMARY_REPLAY_OUT to the replay's output folder")
}

fn language() -> Option<String> {
    std::env::var("SUMMARY_REPLAY_LANGUAGE")
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).expect("JSON serializes") + "\n"
}

/// Write a request file. A request that is already there must be the same
/// bytes: a reply next to it answers that request, and replacing the
/// request under it would pair the reply with something it never saw.
fn write_request(path: &Path, request: &Value) {
    let text = pretty(request);
    if let Ok(existing) = std::fs::read_to_string(path) {
        assert!(
            existing == text,
            "{} already holds a different request; write the replay to a fresh SUMMARY_REPLAY_OUT",
            path.display()
        );
        return;
    }
    write_file(path, &text);
}

fn write_file(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().expect("a file has a folder")).expect("create folder");
    std::fs::write(path, text).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
}

fn request(case: &str, arm: &str, turn: &str, messages: Value) -> Value {
    json!({"case": case, "arm": arm, "turn": turn, "messages": messages})
}

/// The `sourceBlocks` of a recording or a synthetic chunk, in order.
fn source_blocks(value: &Value) -> Result<Vec<SourceBlock>, String> {
    let blocks = value.as_array().ok_or("no sourceBlocks")?;
    if blocks.is_empty() {
        return Err("no sourceBlocks".into());
    }
    blocks
        .iter()
        .map(|block| {
            let number = |key: &str| {
                block[key]
                    .as_u64()
                    .ok_or_else(|| format!("a source block without {key}"))
            };
            let messages = match block["laterBackupLines"].as_array() {
                Some(lines) => lines
                    .iter()
                    .map(|line| {
                        Some((
                            line["ordinal"].as_u64()?,
                            line["messageId"].as_str()?.to_owned(),
                        ))
                    })
                    .collect::<Option<Vec<_>>>()
                    .ok_or("a source block line without its ordinal or message id")?,
                None => Vec::new(),
            };
            Ok(SourceBlock {
                start: number("startOrdinal")?,
                end: number("endOrdinal")?,
                role: block["role"]
                    .as_str()
                    .ok_or("a source block without its role")?
                    .to_owned(),
                printed: block["printedText"]
                    .as_str()
                    .ok_or("a source block without its printed text")?
                    .to_owned(),
                messages,
            })
        })
        .collect()
}

/// The commits a printed line's header may name after its role, as the
/// module's chunk builder and the 0.49 plugin both print them:
/// ` commits: 1a2b3c4, 5d6e7f8`.
fn commits_header() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^ commits: [0-9a-f]+(?:, [0-9a-f]+)*").expect("valid regex"))
}

/// Each block's printed line without what follows it in the recording.
fn printed_lines(blocks: &[SourceBlock]) -> Result<Vec<&str>, String> {
    blocks
        .iter()
        .enumerate()
        .map(|(index, block)| {
            let after = if index + 1 == blocks.len() {
                "\n\n"
            } else {
                "\n"
            };
            block.printed.strip_suffix(after).ok_or_else(|| {
                format!(
                    "the printed line of [{}-{}] does not end with {after:?}",
                    block.start, block.end
                )
            })
        })
        .collect()
}

/// The text of `block`'s printed `line`: the line without its `[A-B] R:`
/// header and the commits a header may name, as the module keeps a line's
/// text apart from its header.
fn line_text(block: &SourceBlock, line: &str) -> Result<String, String> {
    let range = if block.start == block.end {
        format!("[{}]", block.start)
    } else {
        format!("[{}-{}]", block.start, block.end)
    };
    let rest = line
        .strip_prefix(&format!("{range} {}:", block.role))
        .ok_or_else(|| {
            format!("{range}: the printed line does not start with its range and role")
        })?;
    let rest = commits_header()
        .find(rest)
        .map_or(rest, |header| &rest[header.end()..]);
    rest.strip_prefix(' ')
        .map(str::to_owned)
        .ok_or_else(|| format!("{range}: no text after the line's header"))
}

/// Split a recorded prompt into its calibration examples, its session
/// references and the content of its `<new_messages>` block. The split
/// counts only when the module's prompt builder, given these parts and
/// nothing else, rebuilds the recorded prompt byte for byte: then the
/// prompt carried no instruction or toggle that a replay would silently
/// drop. The memory block's empty place may be there or not.
fn split_recorded(prompt: &str) -> Result<(String, String, String), String> {
    let seeds_end = prompt
        .starts_with(SEEDS_OPEN)
        .then(|| prompt.find(SEEDS_CLOSE))
        .flatten()
        .ok_or("the prompt does not open with calibration examples")?
        + SEEDS_CLOSE.len();
    let seeds = &prompt[..seeds_end];
    let rest = &prompt[seeds_end..];
    let (references, rest) = match rest
        .strip_prefix("\n\n")
        .filter(|rest| rest.starts_with(REFERENCES_OPEN))
    {
        Some(block) => {
            let end = block
                .find(REFERENCES_CLOSE)
                .ok_or("the session references are not closed")?
                + REFERENCES_CLOSE.len();
            (&block[..end], &block[end..])
        }
        None => ("", rest),
    };
    let start = rest
        .find(NEW_MESSAGES_OPEN)
        .ok_or("the prompt has no <new_messages> block")?
        + NEW_MESSAGES_OPEN.len();
    let end = rest
        .rfind(NEW_MESSAGES_CLOSE)
        .filter(|end| *end >= start)
        .ok_or("the prompt's <new_messages> block is not closed")?;
    let transcript = &rest[start..end];
    for memory in [MEMORY_SLOT, ""] {
        let rebuilt = build_compartment_agent_prompt(&CompartmentPromptInputs {
            seed_examples: seeds,
            session_references: references,
            project_memory: memory,
            input_source: transcript,
            memory_enabled: true,
            // As the 0.49 plugin sent it: observations asked for, and no
            // first-turn instruction.
            user_observations_requested: true,
            extraction_free: false,
            anchored_facts: false,
            turn_one_instruction: "",
        })
        .replacen(MEMORY_SLOT, "", 1);
        if rebuilt == prompt {
            return Ok((
                seeds.to_owned(),
                references.to_owned(),
                transcript.to_owned(),
            ));
        }
    }
    Err("the module's prompt builder does not rebuild the recorded prompt from its calibration examples, session references and <new_messages> block, so it carries something else as well".into())
}

/// A chunk's printed lines as the module keeps them for anchors. `header`
/// is the length of the `Messages A-B:` header that precedes the lines,
/// which are joined by newlines.
fn printed_blocks(
    blocks: &[SourceBlock],
    lines: &[&str],
    header: usize,
) -> Result<Vec<PrintedBlock>, String> {
    let mut offset = header;
    let mut printed = Vec::with_capacity(blocks.len());
    for (block, line) in blocks.iter().zip(lines) {
        let text = line_text(block, line)?;
        offset += line.len();
        printed.push(PrintedBlock {
            role: block.role.clone(),
            start: block.start,
            end: block.end,
            parts: vec![text],
            text_end: offset,
        });
        offset += "\n".len();
    }
    Ok(printed)
}

/// Recorded chunk `index` of the corpus at `dir`.
fn recorded_case(dir: &Path, index: u64) -> Result<Case, String> {
    let input = read_json(&dir.join(format!("inputs/{index}.json")))?;
    let recording = read_json(&dir.join(format!("recordings/{index}.json")))?;
    let prompt = input["prompt"].as_str().ok_or("the input has no prompt")?;
    let (seeds, references, transcript) = split_recorded(prompt)?;
    let blocks = source_blocks(&recording["sourceBlocks"])?;
    let chunk = (blocks[0].start, blocks[blocks.len() - 1].end);
    let header = format!("Messages {}-{}:\n\n", chunk.0, chunk.1);
    let lines = printed_lines(&blocks)?;
    if transcript != format!("{header}{}", lines.join("\n")) {
        return Err("the recording's source blocks are not the printed lines of the prompt's <new_messages> block, so anchors could not be resolved against them".into());
    }
    let printed = printed_blocks(&blocks, &lines, header.len())?;
    // Every message the lines cover, so a reply's summary boundaries can be
    // checked as the module checks them.
    let mut messages: Vec<&(u64, String)> =
        blocks.iter().flat_map(|block| &block.messages).collect();
    messages.sort_by_key(|(ordinal, _)| *ordinal);
    let present: Vec<u64> = messages.iter().map(|(ordinal, _)| *ordinal).collect();
    if present.windows(2).any(|pair| pair[0] == pair[1])
        || blocks
            .iter()
            .any(|block| !present.contains(&block.start) || !present.contains(&block.end))
    {
        return Err("the recording does not list each message of its lines once".into());
    }
    Ok(Case {
        name: format!("corpus-{index:02}"),
        session: recording["session"]["parent_id"]
            .as_str()
            .ok_or("the recording names no source session")?
            .to_owned(),
        chunk,
        input: transcript,
        validation: HistorianChunk {
            start_index: chunk.0,
            end_index: chunk.1,
            lines: messages
                .iter()
                .map(|(ordinal, id)| ChunkLine {
                    ordinal: *ordinal,
                    message_id: id.clone(),
                    anchorable: true,
                })
                .collect(),
            present_ordinals: present,
            // Every message lies inside a printed line's range.
            hidden_ordinals: Vec::new(),
            // The recordings don't say which lines held only tool calls, so
            // no gap between summaries is healed as tool-only noise.
            tool_only_ranges: Vec::new(),
            completed_tool_arcs: Vec::new(),
        },
        printed,
        context: Context::Recorded { seeds, references },
    })
}

/// The synthetic chunk in `path`, printed by the module's own chunk
/// builder. Its file must hold exactly the lines the module prints.
fn synthetic_case(path: &Path) -> Case {
    let file = read_json(path).unwrap_or_else(|error| panic!("{error}"));
    let name = file["case"]
        .as_str()
        .unwrap_or_else(|| panic!("{}: no case name", path.display()));
    let session = file["session"]
        .as_str()
        .unwrap_or_else(|| panic!("{}: no session", path.display()));
    let blocks =
        source_blocks(&file["sourceBlocks"]).unwrap_or_else(|error| panic!("{name}: {error}"));
    let lines = printed_lines(&blocks).unwrap_or_else(|error| panic!("{name}: {error}"));
    let entries: Vec<Entry> = blocks
        .iter()
        .zip(&lines)
        .map(|(block, line)| {
            assert_eq!(block.start, block.end, "{name}: one message per line");
            let role = match block.role.as_str() {
                "U" => Role::User,
                "A" => Role::Assistant,
                other => panic!("{name}: role {other} is neither U nor A"),
            };
            let text = line_text(block, line).unwrap_or_else(|error| panic!("{name}: {error}"));
            Entry::new(
                block.start,
                format!("m{}", block.start),
                role,
                0,
                vec![Part::new(
                    format!("p{}", block.start),
                    PartBody::Text { text: text.into() },
                )],
            )
        })
        .collect();
    let chunk = chunk::build_with(
        &entries,
        CHUNK_TOKENS,
        Lines::PerMessage,
        crate::count::Counter::for_model(None),
    )
    .unwrap_or_else(|| panic!("{name}: nothing to summarize"));
    assert!(!chunk.has_more, "{name}: the chunk was cut");
    let first = blocks[0].start;
    let last = blocks[blocks.len() - 1].end;
    assert_eq!(
        chunk.input,
        format!("Messages {first}-{last}:\n\n{}", lines.join("\n")),
        "{name}: the module prints the chunk's messages differently from its file"
    );
    Case {
        name: format!("synthetic-{name}"),
        session: session.to_owned(),
        chunk: (first, last),
        input: chunk.input,
        validation: chunk.validation,
        printed: chunk.printed_blocks,
        context: Context::Fresh,
    }
}

/// Every case the environment names, in order, each with where it came from;
/// a recorded chunk that can't be replayed carries the reason instead.
fn load_cases() -> Vec<(String, String, Result<Case, String>)> {
    let corpus = env_path("SUMMARY_REPLAY_CORPUS");
    let synthetic = env_path("SUMMARY_REPLAY_SYNTHETIC");
    assert!(
        corpus.is_some() || synthetic.is_some(),
        "set SUMMARY_REPLAY_CORPUS, SUMMARY_REPLAY_SYNTHETIC or both"
    );
    let mut cases = Vec::new();
    if let Some(dir) = corpus {
        let manifest =
            read_json(&dir.join("manifest.json")).unwrap_or_else(|error| panic!("{error}"));
        for entry in manifest["cases"]
            .as_array()
            .expect("the manifest lists cases")
        {
            let index = entry["index"].as_u64().expect("each case has its index");
            cases.push((
                format!("corpus-{index:02}"),
                format!("inputs/{index}.json, recordings/{index}.json"),
                recorded_case(&dir, index),
            ));
        }
    }
    if let Some(dir) = synthetic {
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
            .map(|entry| entry.expect("folder entry").path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect();
        files.sort();
        for path in files {
            let case = synthetic_case(&path);
            let source = path
                .file_name()
                .expect("a file name")
                .to_string_lossy()
                .into_owned();
            cases.push((case.name.clone(), source, Ok(case)));
        }
    }
    cases
}

/// The first turn's user prompt for `case` under `prompts`, as the
/// module's run builds it (`summarize_on` in `run.rs`): the calibration
/// examples and session references, the arm's first-turn instruction where
/// the prompt builder puts it, the chunk, and the format instruction last.
fn turn_one_prompt(case: &Case, prompts: &SummaryPrompts, system: &str) -> String {
    let fresh;
    let (seeds, references) = match &case.context {
        Context::Recorded { seeds, references } => (seeds.as_str(), references.as_str()),
        Context::Fresh => {
            // No model window is named, so nothing is trimmed: a synthetic
            // chunk and its examples fit any summarizer model.
            fresh = fit::fit(&fit::Input {
                session_id: &case.session,
                chunk_start: case.chunk.0,
                last_ordinal: case.chunk.1,
                summaries: &[],
                memories: &[],
                memory_enabled: true,
                anchored_facts: true,
                system_prompt: system,
                prompts,
                windows: &[],
                output_cap: OUTPUT_TOKENS,
                requested_chunk_tokens: CHUNK_TOKENS,
            })
            .expect("a prompt without a model window fits");
            (
                fresh.seed_examples.as_str(),
                fresh.session_references.as_str(),
            )
        }
    };
    let prompt = build_compartment_agent_prompt(&CompartmentPromptInputs {
        seed_examples: seeds,
        session_references: references,
        // The first turn shows no memories: the second turn compares the
        // facts with them.
        project_memory: "",
        input_source: &case.input,
        memory_enabled: true,
        user_observations_requested: false,
        extraction_free: false,
        anchored_facts: true,
        turn_one_instruction: &prompts.turn_one,
    });
    format!("{prompt}\n\n{}", turn_one::FORMAT_INSTRUCTION)
}

#[test]
#[ignore = "writes summarizer replay requests from local chunks; see .cortexkit/scripts/summary-replay/README.md"]
fn turn_one_requests() {
    let out = out_dir();
    let language = language();
    let arms: Vec<(&str, Arc<SummaryPrompts>)> =
        ARMS.iter().map(|arm| (*arm, arm_prompts(arm))).collect();
    let mut listed = Vec::new();
    for (name, source, case) in load_cases() {
        let case = match case {
            Ok(case) => case,
            Err(reason) => {
                println!("{name}: skipped: {reason}");
                listed.push(json!({"case": name, "source": source, "skipped": reason}));
                continue;
            }
        };
        // Both arms' prompts as sent, and with each arm's own first-turn
        // instruction taken out, for the manifest to say whether the arms'
        // prompts are the same and whether they differ in anything else.
        let mut prompts_sent = Vec::new();
        let mut rest = Vec::new();
        for (arm, prompts) in &arms {
            let system = two_pass_system(&prompts.system, language.as_deref());
            let prompt = turn_one_prompt(&case, prompts, &system);
            rest.push(prompt.replacen(&prompts.turn_one, "", 1));
            write_request(
                &out.join(&case.name).join(arm).join("turn-one.request.json"),
                &request(
                    &case.name,
                    arm,
                    "turn-one",
                    json!([
                        {"role": "system", "content": system},
                        {"role": "user", "content": prompt},
                    ]),
                ),
            );
            prompts_sent.push(prompt);
        }
        println!("{}: turn-one requests written", case.name);
        listed.push(json!({
            "case": case.name,
            "source": source,
            "session": case.session,
            "chunk": [case.chunk.0, case.chunk.1],
            "printedLines": case.printed.len(),
            "userPromptsIdentical": prompts_sent.windows(2).all(|pair| pair[0] == pair[1]),
            "userPromptsDifferOnlyInTheFirstTurnInstruction": rest.windows(2).all(|pair| pair[0] == pair[1]),
        }));
    }
    write_file(
        &out.join("manifest.json"),
        &pretty(&json!({
            "language": language,
            "arms": arms.iter().map(|(arm, prompts)| json!({
                "arm": arm,
                "texts": if *arm == "a-today" { "SummaryPrompts::plugin()" } else { "SummaryPrompts::bundled()" },
                "digest": prompts.digest,
            })).collect::<Vec<_>>(),
            "cases": listed,
        })),
    );
}

/// What became of one arm's first-turn reply.
struct SecondTurn {
    /// Written as `turn-two.status.json`.
    status: Value,
    /// The second turn's request, when the module sends one.
    request: Option<Value>,
}

impl SecondTurn {
    fn not_sent(reason: impl Into<String>) -> Self {
        Self {
            status: json!({"built": false, "reason": reason.into()}),
            request: None,
        }
    }
}

/// The second turn for `case` under `arm`, from the first turn's request
/// and reply in `dir`: the reply is checked with the module's parser and
/// validator, published in a throwaway store as a first turn publishes it,
/// and the second turn the module sends from that store is captured from a
/// stand-in runner that answers nothing. The store holds no memories, so
/// every fact shows no neighbours.
async fn second_turn(case: &Case, arm: &str, dir: &Path, language: Option<&str>) -> SecondTurn {
    let Ok(first) = read_json(&dir.join("turn-one.request.json")) else {
        return SecondTurn::not_sent("no turn-one request");
    };
    let Ok(reply) = read_json(&dir.join("turn-one.reply.json")) else {
        return SecondTurn::not_sent("no turn-one reply yet");
    };
    if reply["ok"] != json!(true) {
        return SecondTurn::not_sent(format!("turn one failed: {}", reply["error"]));
    }
    let choice = &reply["body"]["choices"][0];
    let Some(text) = choice["message"]["content"].as_str() else {
        return SecondTurn::not_sent("the turn-one reply has no message text");
    };
    // The module fails a first turn that stopped at its output limit.
    if choice["finish_reason"] == json!("length") {
        return SecondTurn::not_sent(
            "the turn-one reply hit its output limit, which fails the module's run",
        );
    }
    let Some(xml) = turn_one::parse_reply(text) else {
        return SecondTurn::not_sent("the reply is not a turn-one JSON envelope");
    };
    // A routine run: memory and promotion on, no emergency, no forced keep,
    // and no earlier summaries to continue from.
    let validated =
        match validate_historian_output(&xml, &case.validation, &[], ValidateOptions::default()) {
            Ok(validated) => validated,
            Err(error) => {
                return SecondTurn::not_sent(format!("invalid turn-one reply: {}", error.message))
            }
        };
    let store = tempfile::tempdir().expect("a throwaway folder");
    let db =
        ContextDb::create_for_tests(&store.path().join("context.db")).expect("a throwaway store");
    let now = crate::memory_writes::now_ms();
    let child = format!("{}:{CHILD}:summary-replay:turn-one", case.session);
    let send = db
        .with_connection(|conn| {
            turn_one::allocate(
                conn,
                &turn_one::SendInput {
                    project: PROJECT,
                    session: &case.session,
                    harness: HARNESS,
                    carrier: &format!("ck-mc:{RUNNER}"),
                    chunk: case.chunk,
                    model: json!({"provider": "replay", "model": "replay", "variant": null, "decision": "replay"}),
                    child: &child,
                },
                now,
            )
        })
        .expect("record the first turn's send");
    let publication = turn_one::Publication {
        send: send.clone(),
        project: PROJECT.to_owned(),
        session: case.session.clone(),
        // Every line reached the summarizer whole: the replay never cuts a
        // chunk.
        blocks: case.printed.clone(),
        candidates: validated.facts.clone(),
    };
    let candidates = db
        .publish_summaries(
            HARNESS,
            &case.session,
            &validated.compartments,
            Some(&publication),
            &Recall::default(),
            now,
        )
        .expect("publish the first turn");
    let anchored: i64 = db.with_connection(|conn| {
        conn.query_row(
            "SELECT COALESCE(SUM(anchor_known), 0) FROM memory_pending_facts",
            [],
            |row| row.get(0),
        )
        .expect("count anchored facts")
    });
    let mut status = json!({
        "built": false,
        "summaries": validated.compartments.len(),
        "discardedLast": validated.discarded_last,
        "facts": validated.facts.len(),
        "candidates": candidates,
        "anchored": anchored,
    });
    if candidates == 0 {
        status["reason"] = json!("no candidate facts, so the module sends no second turn");
        return SecondTurn {
            status,
            request: None,
        };
    }
    let client = super::run::session_class_tests::Client::new(false);
    let job = turn_two::Job {
        owner: SessionRef::new(RUNNER, HARNESS, case.session.clone()),
        project: PROJECT.to_owned(),
        project_root: None,
        continuation: Continuation {
            child: Child {
                session: SessionRef::new(RUNNER, HARNESS, child.clone()),
                project_root: None,
            },
            model: ModelRef::new("replay", "replay"),
            decision_id: "replay".into(),
            output_tokens: OUTPUT_TOKENS,
            language: language.map(str::to_owned),
            publication_id: send.publication_id.clone(),
            prompts: arm_prompts(arm),
            keep_child: false,
        },
        memory_enabled: true,
        auto_promote: true,
        embedding: None,
        authority: None,
    };
    // The stand-in runner answers every send with an empty reply, so the
    // outcome says nothing about the replay; only the send matters.
    let outcome = turn_two::run(&client, &db, &job).await;
    let sends = client.sends.lock().expect("sends");
    let Some((_, sent)) = sends.iter().find(|(to, _)| to.session.session == child) else {
        status["reason"] = json!(format!("the module sent no second turn: {outcome:?}"));
        return SecondTurn {
            status,
            request: None,
        };
    };
    let prompt = sent.prompt.clone().expect("a second turn sends a prompt");
    let system = &sent.runner_params["system"];
    assert_eq!(
        system, &first["messages"][0]["content"],
        "{}/{arm}: the second turn's system prompt differs from the first turn's; is SUMMARY_REPLAY_LANGUAGE the same as for turn one?",
        case.name
    );
    status["built"] = json!(true);
    status["factsInPrompt"] = json!(prompt
        .lines()
        .filter(|line| line.starts_with("## Fact "))
        .count());
    SecondTurn {
        request: Some(request(
            &case.name,
            arm,
            "turn-two",
            json!([
                first["messages"][0],
                first["messages"][1],
                {"role": "assistant", "content": text},
                {"role": "user", "content": prompt},
            ]),
        )),
        status,
    }
}

#[tokio::test]
#[ignore = "writes summarizer replay requests from local chunks; see .cortexkit/scripts/summary-replay/README.md"]
async fn turn_two_requests() {
    let out = out_dir();
    let language = language();
    for (_, _, case) in load_cases() {
        let Ok(case) = case else { continue };
        for arm in ARMS {
            let dir = out.join(&case.name).join(arm);
            if !dir.exists() {
                continue;
            }
            let turn = second_turn(&case, arm, &dir, language.as_deref()).await;
            let path = dir.join("turn-two.request.json");
            match &turn.request {
                Some(request) => write_request(&path, request),
                None => assert!(
                    !path.exists(),
                    "{} is left from an earlier reply; write the replay to a fresh SUMMARY_REPLAY_OUT",
                    path.display()
                ),
            }
            println!("{}/{arm}: {}", case.name, turn.status);
            write_file(&dir.join("turn-two.status.json"), &pretty(&turn.status));
        }
    }
}

mod harness_checks {
    use super::*;

    const SEEDS: &str = "<compartment_examples_from_other_projects>\n<compartment start=\"1\" end=\"2\" title=\"Seed\">\nA seed.\n</compartment>\n</compartment_examples_from_other_projects>";
    const REFERENCES: &str = "<session_references>\n<compartment start=\"3\" end=\"9\" title=\"Earlier\">\nEarlier work.\n</compartment>\n</session_references>";
    const TRANSCRIPT: &str =
        "Messages 10-12:\n\n[10] U: Ship it.\n[11-12] A: commits: 1a2b3c4, 5d6e7f8 Shipped.";

    /// A 0.49 plugin prompt: built with a memory block, observations asked
    /// for and no first-turn instruction, then the memory block cut out.
    fn recorded(instruction: &str) -> String {
        build_compartment_agent_prompt(&CompartmentPromptInputs {
            seed_examples: SEEDS,
            session_references: REFERENCES,
            project_memory: "<project-memory>\n<CONSTRAINTS>\n- Releases need two reviewers.\n</CONSTRAINTS>\n</project-memory>",
            input_source: TRANSCRIPT,
            memory_enabled: true,
            user_observations_requested: true,
            extraction_free: false,
            anchored_facts: !instruction.is_empty(),
            turn_one_instruction: instruction,
        })
        .replacen(
            "<project-memory>\n<CONSTRAINTS>\n- Releases need two reviewers.\n</CONSTRAINTS>\n</project-memory>",
            "",
            1,
        )
    }

    #[test]
    fn a_recorded_prompt_splits_into_the_parts_the_builder_rebuilds_it_from() {
        assert_eq!(
            split_recorded(&recorded("")).unwrap(),
            (
                SEEDS.to_owned(),
                REFERENCES.to_owned(),
                TRANSCRIPT.to_owned()
            )
        );
        // A prompt that still has no memory block in it splits the same way.
        let whole = recorded("").replacen("\n\n\n\n<new_messages>", "\n\n<new_messages>", 1);
        assert_eq!(split_recorded(&whole).unwrap().2, TRANSCRIPT);
    }

    #[test]
    fn a_recorded_prompt_with_an_instruction_of_its_own_is_not_split() {
        let error = split_recorded(&recorded("<fact_anchors>required</fact_anchors>")).unwrap_err();
        assert!(error.contains("does not rebuild"), "{error}");
        assert!(split_recorded("no calibration examples").is_err());
    }

    fn block(start: u64, end: u64, role: &str, printed: &str) -> SourceBlock {
        SourceBlock {
            start,
            end,
            role: role.into(),
            printed: printed.into(),
            messages: Vec::new(),
        }
    }

    #[test]
    fn a_recording_keeps_a_newline_after_each_line_and_a_blank_line_after_the_last() {
        let blocks = [
            block(10, 10, "U", "[10] U: Ship it.\n"),
            block(11, 12, "A", "[11-12] A: Shipped.\n\n"),
        ];
        assert_eq!(
            printed_lines(&blocks).unwrap(),
            ["[10] U: Ship it.", "[11-12] A: Shipped."]
        );
        let printed = printed_blocks(&blocks, &printed_lines(&blocks).unwrap(), 17).unwrap();
        // Where each line ends in `Messages 10-12:\n\n[10] U: Ship it.\n[11-12] A: Shipped.`.
        assert_eq!(
            printed
                .iter()
                .map(|block| block.text_end)
                .collect::<Vec<_>>(),
            [33, 53]
        );
        assert!(printed_lines(&[block(10, 10, "U", "[10] U: Ship it.\n")]).is_err());
    }

    #[test]
    fn a_printed_line_keeps_its_text_without_its_header_or_commits() {
        let text = |start, end, role, line| line_text(&block(start, end, role, ""), line);
        assert_eq!(text(10, 10, "U", "[10] U: Ship it.").unwrap(), "Ship it.");
        assert_eq!(
            text(
                11,
                12,
                "A",
                "[11-12] A: commits: 1a2b3c4, 5d6e7f8 Shipped / Tagged."
            )
            .unwrap(),
            "Shipped / Tagged."
        );
        // Only a header names commits: a hash-like first word is text.
        assert_eq!(
            text(13, 13, "A", "[13] A: deadbeef is the build id.").unwrap(),
            "deadbeef is the build id."
        );
        assert!(text(14, 14, "U", "[14] A: Wrong role.").is_err());
        assert!(text(15, 16, "U", "[15] U: Wrong range.").is_err());
    }
}
