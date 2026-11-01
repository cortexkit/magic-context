//! Cross-commit m0/m1 differential for the large-session compose speed-ups: the
//! newest-first publication-floor walk, merged coverage ranges, the parsed strip-unit
//! survival check, one compartment read per fold, sequence-indexed cached host
//! coordinates, and the separate history render count cache in `mc-tokenizer`.
//!
//! This file compiles unchanged against the module before those speed-ups (commit
//! 58b5f70d41: master's module with only the test helpers in `transform::tests` made
//! `pub(crate)`) and after them. Each world
//! is one store shared by three sessions that run their passes on their own threads at
//! the same time. Between rounds the driver mutates the shared project memories, so
//! every session sees the same memory set however the threads interleave. Within a
//! round each session, from its own seeded generator, may append messages, publish
//! compartments, rescore its compartments' importance, switch model (a different
//! calibration ratio, so a different local history budget), change budgets, or drop
//! old covered messages from its live array (the marker-trimmed shape), and then runs
//! one defer, SOFT or fold pass.
//!
//! Each pass yields one trace line: its actions, decision, reason, coverage and the
//! SHA-256 of the frozen m0 and m1 payloads. A digest of every line must equal
//! `testdata/compose-review-differential-golden.txt`. That file was written by the
//! build of commit 58b5f70d41 (`MC_REVIEW_GOLDEN_WRITE=1`); the build after the
//! speed-ups must reproduce it byte for byte.

use super::tests::{item, memory_input, pctx, req, store};
use super::*;
use sha2::{Digest, Sha256};

/// xorshift64*: the same sequence on every machine and every run.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

/// Words chosen to stress the token-count split: `#` runs, multi-byte letters, emoji
/// with joiners, digits and contractions sit next to plain prose.
const WORDS: &[&str] = &[
    "the",
    "fold",
    "compartment",
    "historian",
    "boundary",
    "ordinal",
    "tail",
    "cache",
    "prefix",
    "store",
    "session",
    "memory",
    "render",
    "budget",
    "tier",
    "decay",
    "anchor",
    "coverage",
    "pass",
    "frozen",
    "unit",
    "marker",
    "publish",
    "token",
    "model",
    "and",
    "but",
    "because",
    "then",
    "with",
    "into",
    "over",
    "per",
    "each",
    "can't",
    "we've",
    "I'd",
    "#",
    "##",
    "m12#3",
    "a#b#0",
    "42",
    "007",
    "1,627",
    "3.2s",
    "v0.48.0",
    "café",
    "naïve",
    "日本語",
    "🙂",
    "👩‍💻",
    "e\u{301}",
    "\u{a0}nbsp",
    "x>y",
    "<EOT>",
    "a&b",
];

fn words(rng: &mut Rng, count: usize) -> String {
    let mut out = String::new();
    for index in 0..count {
        if index > 0 {
            out.push(' ');
        }
        out.push_str(WORDS[rng.below(WORDS.len() as u64) as usize]);
    }
    out
}

/// Roughly `target` bytes of prose with bullets, blank-line paragraphs and the
/// occasional embedded `\n\n## ` heading, which is where the render cache splits text.
fn prose(rng: &mut Rng, target: usize) -> String {
    let mut out = String::new();
    while out.len() < target {
        if !out.is_empty() {
            out.push_str(match rng.below(14) {
                0 => "\n\n",
                1 | 2 => "\n- ",
                3 => "\n\n## ",
                4 => "\n\n\n## ",
                5 => "\n",
                _ => " ",
            });
        }
        let count = 4 + rng.below(12) as usize;
        out.push_str(&words(rng, count));
        out.push('.');
    }
    out
}

fn date(day: u64) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        2026 + day / 336,
        1 + (day / 28) % 12,
        1 + day % 28
    )
}

fn compartment(rng: &mut Rng, sequence: i64, start: u64, end: u64) -> StoredCompartment {
    let legacy = rng.below(10) == 0;
    let size = 300 + rng.below(500) as usize;
    let p1 = prose(rng, size);
    let content = p1.clone();
    let tiers = if legacy {
        [None, None, None, None]
    } else {
        let p2 = prose(rng, p1.len() * 45 / 100);
        let p3 = prose(rng, p1.len() / 5);
        let count = 3 + rng.below(6) as usize;
        let p4 = words(rng, count);
        match rng.below(12) {
            0 => [Some(p1.clone()), None, Some(p3), None],
            1 => [Some(p1.clone()), Some(p2), Some(p3), Some(String::new())],
            _ => [Some(p1.clone()), Some(p2), Some(p3), Some(p4)],
        }
    };
    let count = 3 + rng.below(5) as usize;
    let title = words(rng, count);
    let day = sequence as u64 / 2;
    let [p1, p2, p3, p4] = tiers;
    StoredCompartment {
        sequence,
        start_message: start as i64,
        end_message: end as i64,
        start_message_id: format!("m{start}#0"),
        end_message_id: format!("m{end}#0"),
        start_date: Some(date(day)),
        end_date: Some(date(day + rng.below(3))),
        title,
        content,
        p1,
        p2,
        p3,
        p4,
        importance: 1 + rng.below(100) as i32,
        episode_type: Some(["work", "decision", "debug"][rng.below(3) as usize].to_string()),
        legacy: i32::from(legacy),
        created_at: 1_780_000_000_000 + sequence * 60_000,
    }
}

const PROJECT: &str = "git:compose-review";
const NOW_MS: i64 = 1_790_000_000_000;
const CATEGORIES: [&str; 5] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
];
/// None, two seeded calibration prefixes with different prose ratios, and a key no
/// seed matches.
const MODELS: [Option<&str>; 4] = [
    None,
    Some("anthropic/claude-opus-5"),
    Some("google/gemini-3.1-pro-preview"),
    Some("openai/unseeded-model"),
];

struct Session {
    store: std::sync::Arc<McStore>,
    id: String,
    per: u64,
    next_sequence: i64,
    covered_end: u64,
    messages: Vec<CkIngressMessage>,
    render_generation: u64,
    history_budget: f64,
    memory_budget: f64,
    model: usize,
    rng: Rng,
}

impl Session {
    #[allow(clippy::too_many_arguments)]
    fn new(
        store: std::sync::Arc<McStore>,
        id: String,
        seed: u64,
        compartments: u64,
        per: u64,
        full_array: bool,
        host_resolved: bool,
        history_budget: f64,
    ) -> Self {
        let mut rng = Rng::new(seed);
        let rows = (0..compartments)
            .map(|index| {
                let start = index * per + 1;
                compartment(&mut rng, index as i64 + 1, start, start + per - 1)
            })
            .collect::<Vec<_>>();
        if host_resolved {
            // The TypeScript historian's shape: bare message ids in the shared rows, with
            // the host's resolved block ids cached in store.db and overlaid on every read.
            let raw = rows
                .iter()
                .map(|row| StoredCompartment {
                    start_message_id: row.start_message_id.trim_end_matches("#0").to_string(),
                    end_message_id: row.end_message_id.trim_end_matches("#0").to_string(),
                    ..row.clone()
                })
                .collect::<Vec<_>>();
            store.replace_compartments(&id, &raw).unwrap();
            let boundaries = rows
                .iter()
                .zip(&raw)
                .map(|(row, raw)| mc_store::ResolvedContextBoundary {
                    sequence: row.sequence,
                    source_start_message: row.start_message,
                    source_end_message: row.end_message,
                    source_start_message_id: raw.start_message_id.clone(),
                    source_end_message_id: raw.end_message_id.clone(),
                    source_start_block_index: None,
                    source_end_block_index: None,
                    source_row_identity: String::new(),
                    start_message: row.start_message,
                    end_message: row.end_message,
                    start_message_id: row.start_message_id.clone(),
                    end_message_id: row.end_message_id.clone(),
                    start_date: row.start_date.clone(),
                    end_date: row.end_date.clone(),
                })
                .collect::<Vec<_>>();
            store
                .apply_authority_state_sync(mc_store::ModuleStateSyncRequest {
                    resolved_compartment_boundaries: &boundaries,
                    session_id: &id,
                    project_path: PROJECT,
                    shadow_generation: 0,
                    expected_shadow_seq: 0,
                    seed_boundary_id: rows.last().map(|row| row.end_message_id.as_str()),
                    drop_seeds: &[],
                    drop_seed_skipped: 0,
                    pending_agent_drops: &[],
                    pending_agent_drops_skipped: 0,
                    user_hint_seeds: &[],
                    auto_search_hint_skipped: 0,
                    note_nudge_anchors: None,
                    todo_synthetic_anchor: None,
                    todo_synthetic_anchor_present: false,
                    emergency_latches: None,
                    pending_compaction_marker: None,
                    deferred_execute_state: None,
                    channel2_nudge_state: None,
                    strip_seeds: &[],
                    strip_seed_skipped: 0,
                    reasoning_cleared_through_tag: None,
                    last_todo_state: None,
                    acked_watermarks: serde_json::json!({}),
                })
                .unwrap();
        } else {
            store.replace_compartments(&id, &rows).unwrap();
        }
        let covered_end = compartments * per;
        let first_live = if full_array {
            1
        } else {
            covered_end.saturating_sub(20) + 1
        };
        let mut session = Self {
            store,
            id,
            per,
            next_sequence: compartments as i64 + 1,
            covered_end,
            messages: Vec::new(),
            render_generation: 0,
            history_budget,
            memory_budget: 4_000.0,
            model: 0,
            rng,
        };
        for ordinal in first_live..=covered_end + 160 {
            session.push_message(ordinal);
        }
        session
    }

    fn push_message(&mut self, ordinal: u64) {
        let size = 40 + self.rng.below(300) as usize;
        let text = prose(&mut self.rng, size);
        self.messages
            .push(item(&format!("m{ordinal}"), ordinal, &text));
    }

    fn append(&mut self, count: u64) {
        let last = self.messages.last().map_or(0, |message| message.ordinal);
        for ordinal in last + 1..=last + count {
            self.push_message(ordinal);
        }
    }

    fn publish(&mut self) -> bool {
        let start = self.covered_end + 1;
        let end = self.covered_end + self.per;
        let last = self.messages.last().map_or(0, |message| message.ordinal);
        if end + 12 > last {
            return false;
        }
        let row = compartment(&mut self.rng, self.next_sequence, start, end);
        self.store.append_compartments(&self.id, &[row]).unwrap();
        self.next_sequence += 1;
        self.covered_end = end;
        true
    }

    /// Rewrite a few compartments' importance, as a rescore does, keeping every
    /// other column (including the coordinates the last read resolved).
    fn rescore(&mut self) {
        let mut rows = self.store.load_compartments(&self.id).unwrap();
        for _ in 0..3 {
            let index = self.rng.below(rows.len() as u64) as usize;
            rows[index].importance = 1 + self.rng.below(100) as i32;
        }
        self.store.replace_compartments(&self.id, &rows).unwrap();
    }

    /// Drop covered messages from the front of the live array, the way a host trims
    /// at its compaction marker. The newest 20 covered messages stay, so the fold's
    /// anchor block remains present.
    fn marker_trim(&mut self) {
        let keep_from = self.covered_end.saturating_sub(20) + 1;
        self.messages.retain(|message| message.ordinal >= keep_from);
    }

    fn request_soft(&self) {
        let mut loaded = self.store.load(&self.id).unwrap();
        loaded.meta.soft_refresh_pending = true;
        self.store
            .commit(&self.id, loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();
    }

    fn run(&self) -> String {
        let mut request = req(
            &self.id,
            &format!("review-{}", self.render_generation),
            self.messages.clone(),
        );
        request.serializer_profile = "opencode".into();
        request.model_key = MODELS[self.model].map(str::to_string);
        let mut context = pctx(PROJECT, "/nonexistent-docs", NOW_MS);
        context.memory_budget_tokens = self.memory_budget;
        context.history_budget_tokens = self.history_budget;
        context.inject_docs = false;
        let outcome = match transform(&self.store, &request, &context) {
            Ok(response) => format!(
                "decision={} reason={} coverage={:?}",
                response.decision,
                response.materialize_reason.as_deref().unwrap_or("-"),
                response.coverage_ordinal,
            ),
            Err(error) => {
                let text = format!("{error:?}");
                format!("error={}", text.chars().take(160).collect::<String>())
            }
        };
        let loaded = self.store.load(&self.id).unwrap();
        let [m0, m1] = ["m0", "m1"].map(|key| {
            loaded
                .core
                .frozen_units
                .iter()
                .find(|unit| unit.key == key)
                .map_or_else(
                    || "absent".to_string(),
                    |unit| format!("{:x}", Sha256::digest(unit.frozen_payload.as_bytes())),
                )
        });
        format!("{outcome} m0={m0} m1={m1}")
    }

    /// One randomized step and its pass; returns the trace line body.
    fn step(&mut self) -> String {
        let mut actions = Vec::new();
        let roll = self.rng.below(100);
        if roll < 30 {
            let count = 1 + self.rng.below(30);
            self.append(count);
            actions.push(format!("append{count}"));
        } else if roll < 50 {
            let mut published = 0;
            for _ in 0..=self.rng.below(3) {
                published += usize::from(self.publish());
            }
            actions.push(format!("publish{published}"));
        } else if roll < 60 {
            self.model = self.rng.below(MODELS.len() as u64) as usize;
            actions.push(format!("model{}", self.model));
        } else if roll < 65 {
            self.history_budget = [800.0, 3_000.0, 12_000.0][self.rng.below(3) as usize];
            self.memory_budget = [600.0, 4_000.0][self.rng.below(2) as usize];
            actions.push("budget".to_string());
        } else if roll < 70 {
            self.rescore();
            actions.push("rescore".to_string());
        } else if roll < 74 {
            self.marker_trim();
            actions.push("trim".to_string());
        }
        let kind = match self.rng.below(10) {
            0..=3 => "defer",
            4..=6 => {
                self.request_soft();
                "soft"
            }
            _ => {
                self.render_generation += 1;
                "fold"
            }
        };
        let actions = if actions.is_empty() {
            "-".to_string()
        } else {
            actions.join(",")
        };
        format!(
            "{actions} kind={kind} model={} live={} {}",
            self.model,
            self.messages.len(),
            self.run()
        )
    }
}

/// Mutate the shared project memories between rounds: insert, edit or archive.
fn mutate_memories(store: &McStore, rng: &mut Rng, ids: &mut Vec<i64>, round: usize) -> String {
    let now = NOW_MS - 10_000 + round as i64;
    match rng.below(10) {
        0..=3 => {
            let category = CATEGORIES[rng.below(5) as usize];
            let size = 60 + rng.below(200) as usize;
            let content = prose(rng, size);
            let mut input = memory_input(PROJECT, category, &content, now);
            input.importance = Some(1 + rng.below(100) as i32);
            ids.push(store.insert_memory(input).unwrap());
            "memory-insert".to_string()
        }
        4 if !ids.is_empty() => {
            let id = ids[rng.below(ids.len() as u64) as usize];
            let size = 60 + rng.below(200) as usize;
            let content = prose(rng, size);
            let updated = store
                .update_memory_content(PROJECT, id, &content, None, now)
                .unwrap()
                .is_some();
            format!("memory-update{}", u8::from(updated))
        }
        5 if ids.len() > 4 => {
            let id = ids.remove(rng.below(ids.len() as u64) as usize);
            let archived = store
                .archive_memory(PROJECT, id, Some("review"), now)
                .unwrap()
                .is_some();
            format!("memory-archive{}", u8::from(archived))
        }
        _ => "memory-none".to_string(),
    }
}

/// One world: a fresh store, `memories` shared memories, three concurrent sessions
/// with the given shapes, `rounds` rounds. Returns the trace, sessions in order.
fn world(index: u64, shapes: [(bool, bool); 3], history_budget: f64, rounds: usize) -> Vec<String> {
    let dir = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(store(dir.path()));
    let mut driver = Rng::new(0x5ee0 + index);
    let mut memory_ids = Vec::new();
    for round in 0..30 {
        mutate_memories(&store, &mut driver, &mut memory_ids, round);
    }
    let mut sessions = shapes
        .iter()
        .enumerate()
        .map(|(slot, (full_array, host_resolved))| {
            Session::new(
                std::sync::Arc::clone(&store),
                format!("ses_review_w{index}_s{slot}"),
                index * 100 + slot as u64 + 1,
                40 + 20 * slot as u64,
                9,
                *full_array,
                *host_resolved,
                history_budget,
            )
        })
        .collect::<Vec<_>>();
    let mut traces: Vec<Vec<String>> = vec![Vec::new(); sessions.len()];
    for round in 0..=rounds {
        let shared = if round == 0 {
            "cold".to_string()
        } else {
            mutate_memories(&store, &mut driver, &mut memory_ids, 100 + round)
        };
        let lines = std::thread::scope(|scope| {
            let handles = sessions
                .iter_mut()
                .map(|session| {
                    scope.spawn(move || {
                        if round == 0 {
                            // The first pass materializes the session, as on a real host.
                            format!(
                                "- kind=cold model=0 live={} {}",
                                session.messages.len(),
                                session.run()
                            )
                        } else {
                            session.step()
                        }
                    })
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        for (slot, line) in lines.into_iter().enumerate() {
            traces[slot].push(format!("w{index} s{slot} r{round} {shared} {line}"));
        }
    }
    traces.into_iter().flatten().collect()
}

fn trace() -> Vec<String> {
    let mut lines = Vec::new();
    // (full_array, host_resolved) per session.
    let worlds: [([(bool, bool); 3], f64); 4] = [
        ([(false, false), (true, true), (false, true)], 3_000.0),
        ([(true, false), (false, false), (true, true)], 800.0),
        ([(false, true), (true, false), (false, false)], 12_000.0),
        ([(true, true), (false, true), (true, false)], 3_000.0),
    ];
    for (index, (shapes, budget)) in worlds.into_iter().enumerate() {
        lines.extend(world(index as u64, shapes, budget, 27));
    }
    lines
}

/// One golden line per pass: the trace line's first three tokens (its world, session
/// and round label, such as `w0 s1 r7`) and the first 12 hex digits of the
/// SHA-256 of the whole trace line (actions, decision, reason, coverage and the full
/// m0 and m1 digests). The compact form keeps the committed file small; a mismatch
/// prints the full trace line.
fn golden_line(line: &str) -> String {
    let label = line.splitn(4, ' ').take(3).collect::<Vec<_>>().join(" ");
    let digest = format!("{:x}", Sha256::digest(line.as_bytes()));
    format!("{label} {}", &digest[..12])
}

/// The served m0/m1 bytes of 336 passes must equal the golden recorded from the module
/// from the train composition at `3549c434`, with separate compartment reads for
/// coverage and rendering. SOFT replays served memory rather than picking up canonical
/// memory rows; those wait for HARD. Four worlds of three
/// concurrent sessions run rounds 0 through 27: round 0 is each session's
/// materializing pass (12 passes) and rounds 1 to 27 are randomized (324 passes). Regenerate only for an intentional render
/// change: `MC_REVIEW_GOLDEN_WRITE=1 cargo test -p mc-module --lib
/// compose_review_differential -- --nocapture`, which also prints every full trace line.
#[test]
fn compose_review_differential() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata/compose-review-differential-golden.txt");
    let trace = trace();
    let golden = trace
        .iter()
        .map(|line| golden_line(line))
        .collect::<Vec<_>>();
    if std::env::var_os("MC_REVIEW_GOLDEN_WRITE").is_some() {
        for (line, golden) in trace.iter().zip(&golden) {
            println!("TRACE {line}");
            println!("GOLDEN {golden}");
        }
        std::fs::write(&path, golden.join("\n") + "\n").unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).unwrap();
    for (index, (actual, expected)) in golden.iter().zip(expected.lines()).enumerate() {
        assert_eq!(
            actual, expected,
            "first differing pass at line {index}: {}",
            trace[index]
        );
    }
    assert_eq!(golden.len(), expected.lines().count());
    // The trace must cover what it claims, or matching digests prove little.
    let count = |needle: &str| trace.iter().filter(|line| line.contains(needle)).count();
    assert!(count("decision=HARD") >= 60, "too few HARD passes");
    assert!(count("decision=SOFT ") >= 30, "too few SOFT passes");
    assert!(count("decision=SOFT+") >= 30, "too few SOFT+ passes");
    assert!(count("pressure_refold") >= 1, "no pressure refold");
    assert!(count(" publish") >= 40, "too few publications");
    assert!(count(" trim ") >= 5, "too few marker trims");
    assert!(count(" rescore ") >= 5, "too few rescores");
    assert_eq!(count("error="), 0, "a pass failed");
    for model in 0..MODELS.len() {
        assert!(
            count(&format!("model={model} ")) >= 10,
            "model {model} rarely used"
        );
    }
    let distinct = |prefix: &str| {
        trace
            .iter()
            .filter_map(|line| line.split(' ').find(|field| field.starts_with(prefix)))
            .collect::<BTreeSet<_>>()
            .len()
    };
    assert!(distinct("m0=") >= 60, "too few distinct m0 renders");
    assert!(distinct("m1=") >= 12, "too few distinct m1 renders");
}
