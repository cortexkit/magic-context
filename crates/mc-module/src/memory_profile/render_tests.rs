//! The renderer against today's texts (the golden test), and its rules one by
//! one: `requires` gating, each generator, unknown and unexpanded markers.

use std::collections::BTreeSet;
use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Value};

use super::frames::{self, FRAMES};
use super::render::{render, GENERATORS};
use super::{bundled, list, load_chain, Profile, Result};

fn testdata(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Today's text of every document of the bundled coding profile, under
/// `testdata/`. The summarizer's texts are the module's own copies of what it
/// sends (`two-pass/`). The other texts only the plugin sends; they are the
/// prompt extraction at this commit (`memory_profile/today/`), with runtime
/// values shown as `⟦name⟧` markers, as the profile files write them.
const TODAY: &[(&str, &str)] = &[
    ("historian/system", "two-pass/system.md"),
    ("historian/turn-one", "two-pass/turn-one.md"),
    ("historian/turn-two", "two-pass/turn-two.md"),
    (
        "dreamer/swe:map-memories/system",
        "memory_profile/today/dreamer/map-memories.system.md",
    ),
    (
        "dreamer/swe:map-memories/user",
        "memory_profile/today/dreamer/map-memories.user.md",
    ),
    (
        "dreamer/swe:verify/system",
        "memory_profile/today/dreamer/verify.system.md",
    ),
    (
        "dreamer/swe:verify/user.diff-evidence",
        "memory_profile/today/dreamer/verify.user.diff-evidence.md",
    ),
    (
        "dreamer/swe:verify-broad/user",
        "memory_profile/today/dreamer/verify-broad.user.md",
    ),
    (
        "dreamer/swe:curate/system",
        "memory_profile/today/dreamer/curate.system.md",
    ),
    (
        "dreamer/swe:curate/user",
        "memory_profile/today/dreamer/curate.user.md",
    ),
    (
        "dreamer/swe:compress-cues/system",
        "memory_profile/today/dreamer/compress-cues.system.md",
    ),
    (
        "dreamer/swe:compress-cues/user",
        "memory_profile/today/dreamer/compress-cues.user.md",
    ),
    (
        "dreamer/swe:classify-memories/system",
        "memory_profile/today/dreamer/classify-memories.system.md",
    ),
    (
        "dreamer/swe:classify-memories/user",
        "memory_profile/today/dreamer/classify-memories.user.md",
    ),
    (
        "dreamer/swe:reflect-patterns/gate.system",
        "memory_profile/today/dreamer/retrospective.gate.system.md",
    ),
    (
        "dreamer/swe:reflect-patterns/gate.user",
        "memory_profile/today/dreamer/retrospective.gate.user.md",
    ),
    (
        "dreamer/swe:reflect-patterns/system",
        "memory_profile/today/dreamer/retrospective.system.md",
    ),
    (
        "dreamer/swe:reflect-patterns/user",
        "memory_profile/today/dreamer/retrospective.user.md",
    ),
    (
        "dreamer/swe:maintain-docs/system",
        "memory_profile/today/dreamer/maintain-docs.system.md",
    ),
    (
        "dreamer/swe:maintain-docs/user",
        "memory_profile/today/dreamer/maintain-docs.user.md",
    ),
    (
        "dreamer/swe:refresh-primers/system",
        "memory_profile/today/dreamer/refresh-primers.system.md",
    ),
    (
        "dreamer/swe:refresh-primers/user.raw",
        "memory_profile/today/dreamer/refresh-primers.user.raw.md",
    ),
    (
        "dreamer/swe:refresh-primers/user.closed-book",
        "memory_profile/today/dreamer/refresh-primers.user.closed-book.md",
    ),
    (
        "dreamer/base:review-user-memories/system",
        "memory_profile/today/dreamer/review-user-memories.system.md",
    ),
    (
        "dreamer/base:review-user-memories/user",
        "memory_profile/today/dreamer/review-user-memories.user.md",
    ),
    (
        "main-agent/system.memory-guidance.full",
        "memory_profile/today/main-agent/system.memory-guidance.full.md",
    ),
    (
        "main-agent/system.memory-guidance.light",
        "memory_profile/today/main-agent/system.memory-guidance.light.md",
    ),
    (
        "main-agent/system.memory-mural-guidance",
        "memory_profile/today/main-agent/system.memory-mural-guidance.md",
    ),
];

/// The frames no profile document splices (tool descriptions, turn two's
/// checks, the user prompts the module assembles), each with today's text.
const STANDALONE: &[(&str, &str)] = &[
    (
        "dreamer/agent-registration.system",
        "memory_profile/today/dreamer/_agent-registration.system.md",
    ),
    (
        "historian/turn-one.reference-blocks",
        "memory_profile/today/historian/turn-one.reference-blocks.md",
    ),
    (
        "historian/turn-one.user.two-pass",
        "memory_profile/today/historian/turn-one.user.two-pass.md",
    ),
    (
        "historian/turn-two.check.compatibility.system",
        "memory_profile/today/historian/turn-two.check.compatibility.system.md",
    ),
    (
        "historian/turn-two.check.compatibility.user",
        "memory_profile/today/historian/turn-two.check.compatibility.user.md",
    ),
    (
        "historian/turn-two.check.disproof.system",
        "memory_profile/today/historian/turn-two.check.disproof.system.md",
    ),
    (
        "historian/turn-two.check.kept-clause.system",
        "memory_profile/today/historian/turn-two.check.kept-clause.system.md",
    ),
    (
        "historian/turn-two.check.support.system",
        "memory_profile/today/historian/turn-two.check.support.system.md",
    ),
    (
        "historian/turn-two.check.user",
        "memory_profile/today/historian/turn-two.check.user.md",
    ),
    // The module adds this rule after the decisions frame for a project in
    // a workspace of two or more projects; no profile places it.
    (
        "historian/turn-two.decisions.workspace",
        "memory_profile/today/historian/turn-two.decisions.workspace.md",
    ),
    (
        "historian/turn-two.user",
        "memory_profile/today/historian/turn-two.user.md",
    ),
    (
        "main-agent/ctx_memory.description.full",
        "memory_profile/today/main-agent/ctx_memory.description.full.md",
    ),
    (
        "main-agent/ctx_memory.description.light",
        "memory_profile/today/main-agent/ctx_memory.description.light.md",
    ),
    (
        "main-agent/ctx_memory_list.description",
        "memory_profile/today/main-agent/ctx_memory_list.description.md",
    ),
];

/// Replace each runtime marker `⟦name⟧` with its value.
fn fill(text: &str, values: &[(&str, &str)]) -> String {
    values.iter().fold(text.to_owned(), |text, (name, value)| {
        text.replace(&format!("⟦{name}⟧"), value)
    })
}

fn swe() -> Profile {
    bundled::swe().unwrap()
}

fn rendered(profile: &Profile, document: &str) -> String {
    render(profile, document, FRAMES).unwrap_or_else(|e| panic!("{document}: {e:?}"))
}

/// Turn two's instruction as the module sends it today: the allowed fact ids
/// are filled in after the text is loaded, from the `{{ALLOWED_FACT_IDS}}`
/// placeholder.
fn turn_two(profile: &Profile, ids: &str) -> String {
    fill(
        &rendered(profile, "historian/turn-two"),
        &[("allowed_fact_ids", ids)],
    )
}

/// A frame's own text, expanded as a one-section document, with the runtime
/// values the comparison with today's extraction needs.
fn standalone(profile: &Profile, frame: &str) -> String {
    let mut profile = profile.clone();
    profile.body["prompts"]["test/frame"] = json!({"sections": [{"id": "frame", "mc": frame}]});
    let text = rendered(&profile, "test/frame");
    match frame {
        "historian/turn-one.user.two-pass" => {
            let instruction = rendered(&profile, "historian/turn-one");
            fill(&text, &[("turnOneInstruction", instruction.as_str())])
        }
        // The extraction shows two example fact ids.
        "historian/turn-two.user" => {
            let instruction = turn_two(&profile, "[⟦fact.id⟧,⟦fact2.id⟧]");
            fill(&text, &[("turnTwoInstruction", instruction.as_str())])
        }
        _ => text,
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectedFile {
    #[allow(dead_code)] // Read by people, not by the test.
    about: Vec<String>,
    differences: Vec<Expected>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Expected {
    document: String,
    class: String,
    ruling: String,
    why: String,
    today: Vec<String>,
    rendered: Vec<String>,
}

#[derive(Debug, PartialEq)]
struct Block {
    /// 1-based line of today's text where the change starts.
    line: usize,
    today: Vec<String>,
    rendered: Vec<String>,
}

/// The change blocks of a line diff from `a` to `b`: each maximal run of
/// lines that are not part of one longest common subsequence. Equal lines are
/// matched first, then a removal is preferred over an addition, so the blocks
/// are the same on every run.
fn blocks(a: &str, b: &str) -> Vec<Block> {
    let a: Vec<&str> = a.split('\n').collect();
    let b: Vec<&str> = b.split('\n').collect();
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    let mut out = Vec::new();
    let mut current: Option<Block> = None;
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && a[i] == b[j] {
            out.extend(current.take());
            i += 1;
            j += 1;
            continue;
        }
        let block = current.get_or_insert_with(|| Block {
            line: i + 1,
            today: vec![],
            rendered: vec![],
        });
        if j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1]) {
            block.today.push(a[i].to_owned());
            i += 1;
        } else {
            block.rendered.push(b[j].to_owned());
            j += 1;
        }
    }
    out.extend(current);
    out
}

/// Every frame a document splices, by full name.
fn spliced_frames(profile: &Profile) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut add = |name: &str| {
        let (full, _) = frames::resolve(FRAMES, name).unwrap_or_else(|| panic!("frame {name}"));
        out.insert(full.to_string());
    };
    for doc in profile.body["prompts"].as_object().unwrap().values() {
        for section in list(doc, "sections") {
            if let Some(name) = section["mc"].as_str() {
                add(name);
            }
            if section.get("file").is_some() {
                for line in profile.member(section, "file").unwrap().lines() {
                    if let Some(name) = line.strip_prefix("⟦mc:").and_then(|l| l.strip_suffix('⟧'))
                    {
                        add(name);
                    }
                }
            }
        }
    }
    out
}

#[test]
fn bundled_coding_profile_renders_todays_texts_except_the_expected_differences() {
    let profile = swe();
    let mut compared: Vec<(String, String, String)> = Vec::new();
    for document in profile.body["prompts"].as_object().unwrap().keys() {
        let (_, path) = TODAY
            .iter()
            .find(|(doc, _)| doc == document)
            .unwrap_or_else(|| panic!("document {document} has no today's text in TODAY"));
        let text = match document.as_str() {
            "historian/turn-two" => turn_two(&profile, "{{ALLOWED_FACT_IDS}}"),
            _ => rendered(&profile, document),
        };
        compared.push((document.clone(), text, testdata(path)));
    }
    assert_eq!(
        compared.len(),
        TODAY.len(),
        "TODAY names a document the profile lacks"
    );

    // Every frame is checked against today's text: inside a document, or alone.
    let spliced = spliced_frames(&profile);
    for (frame, path) in STANDALONE {
        assert!(
            !spliced.contains(*frame),
            "{frame} is spliced by a document"
        );
        compared.push((
            format!("mc/{frame}"),
            standalone(&profile, frame),
            testdata(path),
        ));
    }
    let checked: BTreeSet<String> = spliced
        .into_iter()
        .chain(STANDALONE.iter().map(|(frame, _)| frame.to_string()))
        .collect();
    let all: BTreeSet<String> = FRAMES.iter().map(|(name, _)| name.to_string()).collect();
    assert_eq!(checked, all, "every MC frame is compared with today's text");

    let expected: ExpectedFile =
        serde_json::from_str(&testdata("memory_profile/expected-differences.json")).unwrap();
    let mut unused: Vec<&Expected> = expected.differences.iter().collect();
    for entry in &unused {
        assert!(
            ["ruling", "mc-interface-pending"].contains(&entry.class.as_str()),
            "{}: class {}",
            entry.document,
            entry.class
        );
        assert!(
            entry.ruling.contains('§') && !entry.why.is_empty(),
            "{}: every entry cites its ruling and says why",
            entry.document
        );
    }
    let mut unexpected = Vec::new();
    for (document, rendered, today) in &compared {
        for block in blocks(today, rendered) {
            match unused.iter().position(|e| {
                &e.document == document && e.today == block.today && e.rendered == block.rendered
            }) {
                Some(at) => {
                    unused.remove(at);
                }
                None => unexpected.push(json!({
                    "document": document,
                    "today_line": block.line,
                    "today": block.today,
                    "rendered": block.rendered,
                })),
            }
        }
    }
    assert!(
        unexpected.is_empty(),
        "differences from today's text that expected-differences.json does not list:\n{}",
        serde_json::to_string_pretty(&unexpected).unwrap()
    );
    let stale: Vec<String> = unused
        .iter()
        .map(|e| {
            format!(
                "{}: {:?}",
                e.document,
                e.rendered.first().or(e.today.first())
            )
        })
        .collect();
    assert!(
        stale.is_empty(),
        "expected differences that no longer match the rendering: {stale:#?}"
    );
}

#[test]
fn diff_blocks_are_exact_and_minimal() {
    assert_eq!(blocks("a\nb\nc", "a\nb\nc"), vec![]);
    assert_eq!(
        blocks("a\nb\nc", "a\nB\nc\nd"),
        vec![
            Block {
                line: 2,
                today: vec!["b".into()],
                rendered: vec!["B".into()]
            },
            Block {
                line: 4,
                today: vec![],
                rendered: vec!["d".into()]
            },
        ]
    );
}

#[test]
fn frames_directory_holds_exactly_the_registered_frames() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("frames");
    fn walk(root: &Path, dir: &Path, out: &mut BTreeSet<String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, out);
            } else if let Some(name) = path
                .strip_prefix(root)
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "/")
                .strip_suffix(".md")
            {
                out.insert(name.to_owned());
            }
        }
    }
    let mut files = BTreeSet::new();
    walk(&root, &root, &mut files);
    let names: BTreeSet<String> = FRAMES.iter().map(|(name, _)| name.to_string()).collect();
    assert_eq!(files, names);
    for (name, text) in FRAMES {
        assert!(text.ends_with('\n'), "{name} ends with its newline");
        assert!(!text.contains("⟦mc:"), "{name} splices no other frame");
    }
}

/// A copy of the coding profile with one extra document, `test/doc`, whose
/// only section is a base file holding `text`.
fn with_document(mut profile: Profile, text: &str) -> Profile {
    let path = "prompts/test/doc.md";
    profile.packages[0]
        .files
        .insert(path.into(), format!("{text}\n").into_bytes());
    profile.body["prompts"]["test/doc"] = json!({"sections": [
        {"id": "doc", "file": path, "_from": "@cortexkit/memory-base"}
    ]});
    profile
}

fn render_text(profile: Profile, text: &str) -> Result<String> {
    render(&with_document(profile, text), "test/doc", FRAMES)
}

/// A profile with nothing in the streams `streams` names.
fn without(streams: &[&str]) -> Profile {
    let mut profile = swe();
    let body = &mut profile.body;
    for stream in streams {
        match *stream {
            "fact_categories" | "user_categories" => {
                let kind = if *stream == "fact_categories" {
                    "fact"
                } else {
                    "user-observation"
                };
                body["categories"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|c| c["stream"] != kind);
            }
            "event_kinds" => body["extraction"]["events"] = json!([]),
            "primer_candidates" => body["extraction"]["primer_candidates"] = Value::Null,
            _ => unreachable!(),
        }
    }
    profile
}

#[test]
fn requires_renders_a_section_only_when_the_profile_has_its_stream() {
    let full = rendered(&swe(), "historian/system");
    // Sections gated by `requires`, and output lines gated by `⟦if …⟧`.
    let gated = [
        (
            "event_kinds",
            "## Events — durable anchor moments",
            "<events>",
        ),
        (
            "primer_candidates",
            "## Primer candidates (optional)",
            "<primer_candidates>",
        ),
        (
            "user_categories",
            "## User observations (optional)",
            "<user_observations>",
        ),
        ("fact_categories", "### Category-routing test", "<facts>"),
    ];
    for (stream, section, output_line) in gated {
        assert!(full.contains(section) && full.lines().any(|l| l == output_line));
        let text = rendered(&without(&[stream]), "historian/system");
        assert!(!text.contains(section), "{stream}: {section}");
        assert!(
            !text.lines().any(|l| l == output_line),
            "{stream}: {output_line}"
        );
        assert!(!text.contains("⟦"), "{stream}: no marker left");
    }
    // A section without `requires` stays whatever the profile declares.
    let bare = rendered(
        &without(&[
            "fact_categories",
            "user_categories",
            "event_kinds",
            "primer_candidates",
        ]),
        "historian/system",
    );
    assert!(bare.contains("## Construction order (mandatory)"));
    assert!(bare.contains("## Output"));
    // A generated block for a missing stream drops its whole line.
    assert_eq!(
        render_text(
            without(&["fact_categories"]),
            "a\n⟦profile:fact-shape-blocks⟧\nb"
        )
        .unwrap(),
        "a\nb"
    );
}

#[test]
fn every_generator_renders_from_the_resolved_declarations() {
    let facts = "PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, NAMING";
    // (marker, exact text, or None to check by its parts below)
    let exact: &[(&str, &str)] = &[
        ("fact-category-count", "5"),
        ("fact-routing-next", "6"),
        ("fact-category-tags", facts),
        (
            "user-category-tags",
            "COMMUNICATION, PREFERENCES, BOUNDARIES, WORKING_STYLE, IDENTITY, ENGINEERING_PRACTICE, DEV_ENVIRONMENT",
        ),
        (
            "fact-routing-list",
            "1. **Is this a recurring developer/agent behavior?** → PROJECT_RULES\n\
             2. **Is this a WHY justifying the system's shape?** → ARCHITECTURE\n\
             3. **Is this a discovered limit or external gotcha?** → CONSTRAINTS\n\
             4. **Is this a concrete reusable value?** → CONFIG_VALUES\n\
             5. **Is this a name we chose?** → NAMING",
        ),
        (
            "episode-types",
            "`bug`, `feature`, `release`, `refactor`, `infra`, `design`, `investigation`, `docs`",
        ),
        ("cue-chars-high", "90"),
        ("cue-chars-low", "50"),
        ("cue-high-from", "70"),
        ("min-proof-count", "2"),
        (
            "memory-guidance-categories-light",
            "Categories: PROJECT_RULES (a rule), ARCHITECTURE (an architecture fact), CONSTRAINTS (a constraint), CONFIG_VALUES (a config value), NAMING (a naming convention).",
        ),
        (
            "causal_incident.disposition",
            "fixed | workaround | external_blocker | contained_failure | deferred",
        ),
    ];
    let render = |marker: &str| render_text(swe(), &format!("⟦profile:{marker}⟧")).unwrap();
    for (marker, text) in exact {
        assert_eq!(render(marker), *text, "{marker}");
    }
    let starts: &[(&str, &str, usize)] = &[
        // (marker, first line, line count)
        ("fact-category-definitions", "#### `PROJECT_RULES`", 0),
        ("user-category-definitions", "#### `COMMUNICATION`", 0),
        ("event-definitions", "### `causal_incident`", 0),
        ("fact-category-taxonomy", "- **PROJECT_RULES** — durable process/workflow rules for this repo (releases, commits, testing, debugging conventions).", 5),
        ("fact-shape-blocks", "<PROJECT_RULES>", 15),
        ("project-memory-groups", "<PROJECT_RULES>", 15),
        ("user-category-list", "- **COMMUNICATION** (global; seen by every profile's agents) — how the user wants agents to talk to them in any work: length, tone, format, reply language, how much to explain.", 7),
        ("user-observation-shape-blocks", "<COMMUNICATION>", 21),
        ("event-shape-blocks", "<causal_incident at_compartment=\"N\">", 18),
        ("decay-class-list", "  - `stable`: True until contradicted (a name, a standing boundary, a load-bearing design reason).", 6),
        ("memory-guidance-categories", "Categories for `ctx_memory`: PROJECT_RULES (a project rule), ARCHITECTURE (an architectural fact), CONSTRAINTS (a hard-won constraint), CONFIG_VALUES (a config value), NAMING (a naming convention). Examples: category=\"CONFIG_VALUES\", content=\"OpenCode source is at ~/Work/OSS/opencode\" · category=\"CONSTRAINTS\", content=\"Dashboard Tauri build needs RGBA PNGs, not grayscale\"", 1),
    ];
    for (marker, first, lines) in starts {
        let text = render(marker);
        assert_eq!(text.lines().next(), Some(*first), "{marker}");
        if *lines > 0 {
            assert_eq!(text.lines().count(), *lines, "{marker}");
        }
        assert!(
            !text.contains("⟦profile:"),
            "{marker} expands the markers it includes"
        );
    }
    // The definitions are the category files in render order, joined by a newline.
    let profile = swe();
    let defs = render("fact-category-definitions");
    assert_eq!(defs.matches("\n#### `").count(), 4);
    assert!(defs.find("`ARCHITECTURE`") < defs.find("`NAMING`"));
    assert!(render("user-category-list").contains(
        "- **ENGINEERING_PRACTICE** (global; seen by only agents running @cortexkit/memory-swe)"
    ));
    assert!(
        render("project-memory-groups").contains("<NAMING>\n- ⟦NAMING.memory.content⟧\n</NAMING>")
    );
    assert!(render("event-shape-blocks")
        .contains("<produced_fact>...</produced_fact>\n</causal_incident>"));
    assert!(render("event-definitions")
        .contains("- `affected_surface` — enum: `ui | provider_sdk | model_behavior"));
    assert_eq!(
        list(&profile.body, "decay_classes").len(),
        render("decay-class-list").lines().count()
    );

    let covered: BTreeSet<&str> = exact
        .iter()
        .map(|(m, _)| *m)
        .chain(starts.iter().map(|(m, _, _)| *m))
        .filter(|m| !m.contains('.'))
        .collect();
    assert_eq!(
        covered,
        GENERATORS.iter().copied().collect(),
        "every generator is tested"
    );
}

#[test]
fn runtime_markers_stay_for_the_caller() {
    assert_eq!(
        render_text(
            swe(),
            "Project: ⟦projectIdentity⟧ has ⟦profile:fact-category-count⟧ categories"
        )
        .unwrap(),
        "Project: ⟦projectIdentity⟧ has 5 categories"
    );
}

#[test]
fn an_unknown_marker_is_refused() {
    for (text, detail) in [
        (
            "⟦profile:no-such-list⟧",
            "unknown profile marker no-such-list",
        ),
        (
            "a ⟦profile:no-such-list⟧ b",
            "unknown profile marker no-such-list",
        ),
        (
            "⟦profile:causal_incident.no_field⟧",
            "unknown profile marker",
        ),
        ("⟦mc:no-such-frame⟧", "MC frame no-such-frame not found"),
        (
            "⟦if no_such_stream⟧text",
            "unknown condition no_such_stream",
        ),
    ] {
        let refusal = render_text(swe(), text).unwrap_err();
        assert_eq!(refusal.code, "prompt_invalid", "{text}");
        assert!(
            refusal.detail.contains(detail),
            "{text}: {}",
            refusal.detail
        );
    }
    // A generator that has nothing to say cannot stand inside a line.
    let refusal =
        render_text(without(&["event_kinds"]), "x ⟦profile:event-shape-blocks⟧").unwrap_err();
    assert!(
        refusal.detail.contains("generates nothing inside a line"),
        "{}",
        refusal.detail
    );
}

#[test]
fn an_unexpanded_marker_is_refused() {
    for text in [
        // An MC marker is spliced only when it is the whole line.
        "see ⟦mc:verify.input⟧ here",
        // A condition applies only at the start of a line.
        "x ⟦if fact_categories⟧y",
        // Unclosed markers.
        "⟦profile:fact-category-count",
        "a ⟦profile:fact-category-count b",
    ] {
        let refusal = render_text(swe(), text).unwrap_err();
        assert_eq!(refusal.code, "prompt_invalid", "{text}");
        assert!(
            refusal.detail.contains("left unexpanded"),
            "{text}: {}",
            refusal.detail
        );
    }
    // A frame cannot splice another frame.
    let frames = [
        ("test/outer", "⟦mc:test/inner⟧\n"),
        ("test/inner", "inner\n"),
    ];
    let profile = with_document(swe(), "⟦mc:test/outer⟧");
    let refusal = render(&profile, "test/doc", &frames).unwrap_err();
    assert!(
        refusal.detail.contains("left unexpanded: ⟦mc:test/inner⟧"),
        "{}",
        refusal.detail
    );
    // An MC marker in a category definition is never spliced.
    let mut profile = swe();
    let path = "prompts/categories/naming.historian.md";
    let definition = String::from_utf8(profile.packages[1].files[path].clone()).unwrap();
    profile.packages[1].files.insert(
        path.into(),
        format!("{definition}⟦mc:verify.input⟧\n").into_bytes(),
    );
    let refusal = render(&profile, "historian/system", FRAMES).unwrap_err();
    assert!(
        refusal.detail.contains("left unexpanded"),
        "{}",
        refusal.detail
    );
}

#[test]
fn a_missing_document_or_trailing_newline_is_refused() {
    let refusal = render(&swe(), "historian/none", FRAMES).unwrap_err();
    assert!(refusal.detail.contains("document historian/none missing"));
    let mut profile = with_document(swe(), "text");
    profile.packages[0]
        .files
        .insert("prompts/test/doc.md".into(), b"text".to_vec());
    let refusal = render(&profile, "test/doc", FRAMES).unwrap_err();
    assert!(
        refusal.detail.contains("does not end with a newline"),
        "{}",
        refusal.detail
    );
}

#[test]
fn historian_documents_must_keep_their_frames() {
    for (document, section, frame) in [
        ("historian/system", "output", "historian/output-contract"),
        (
            "historian/turn-one",
            "anchor-format",
            "historian/turn-one.anchor-format",
        ),
        (
            "historian/turn-two",
            "decisions",
            "historian/turn-two.decisions",
        ),
    ] {
        let mut packages = bundled::packages();
        packages[0].env["body"]["prompts"][document]["sections"]
            .as_array_mut()
            .unwrap()
            .retain(|s| s["id"] != section);
        let refusal = load_chain(&packages).unwrap_err();
        assert_eq!(refusal.code, "prompt_invalid", "{document}");
        assert_eq!(
            refusal.detail,
            format!("{document} must contain the MC frame {frame}")
        );
    }
    // A document no longer declares variants of itself.
    let mut packages = bundled::packages();
    packages[0].env["body"]["prompts"]["historian/system"]["variants"] = json!(["xml", "combined"]);
    assert_eq!(
        load_chain(&packages).unwrap_err().code,
        "profile_schema_invalid"
    );
}
