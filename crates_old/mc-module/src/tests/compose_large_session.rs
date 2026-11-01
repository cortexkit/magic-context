//! Synthetic large-session fixture for the HARD-fold `compose_m0m1` stage.
//!
//! A long-lived OpenCode session in Rust mode can carry thousands of compartments
//! (four paraphrase tiers each, with importance and dates) plus hundreds of project
//! memories. This file builds that shape in a throwaway temporary store, never a
//! copy of a real one, and drives real transform passes through it:
//!
//! - `large_session_compose_profile` (ignored, run by hand in release) prints the
//!   per-pass stage timings at a chosen scale.
//! - `large_session_compose_differential` replays a seeded randomized sequence of
//!   fold, SOFT and defer passes and requires every pass's served m0/m1 bytes to
//!   match the digests in `testdata/compose-large-session-golden.txt`. Those were
//!   recorded using the train composition at `3549c434` with a separate compartment
//!   read for coverage and rendering; the faster paths must serve exactly the same bytes,
//!   because any change to m0/m1 busts the provider's cached prefix.
//!   SOFT replays served memory and waits for HARD to pick up canonical memory rows.

use super::tests::{item, memory_input, pctx, req, store};
use super::*;
use sha2::{Digest, Sha256};

/// A small deterministic generator (xorshift64*), so the fixture and the pass
/// sequence are identical on every machine and every run.
pub(super) struct Rng(u64);

impl Rng {
    pub(super) fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    pub(super) fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    pub(super) fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

const WORDS: &[&str] = &[
    "the",
    "module",
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
    "pressure",
    "anchor",
    "coverage",
    "transform",
    "pass",
    "frozen",
    "unit",
    "reduction",
    "tag",
    "overlay",
    "marker",
    "publish",
    "replay",
    "served",
    "bytes",
    "digest",
    "hash",
    "token",
    "estimate",
    "agent",
    "user",
    "asked",
    "fixed",
    "added",
    "removed",
    "renamed",
    "refactored",
    "tested",
    "verified",
    "reviewed",
    "merged",
    "branch",
    "commit",
    "worktree",
    "clippy",
    "cargo",
    "bun",
    "typecheck",
    "schema",
    "migration",
    "epoch",
    "lock",
    "writer",
    "reader",
    "sqlite",
    "row",
    "column",
    "index",
    "query",
    "plan",
    "latency",
    "ms",
    "MB",
    "error",
    "warning",
    "panic",
    "retry",
    "timeout",
    "deadline",
    "budget",
    "slack",
    "and",
    "or",
    "but",
    "because",
    "so",
    "then",
    "after",
    "before",
    "while",
    "when",
    "with",
    "without",
    "into",
    "from",
    "over",
    "under",
    "between",
    "across",
    "per",
    "each",
    "every",
    "OpenCode",
    "Pi",
    "Rust",
    "TypeScript",
    "Anthropic",
    "provider",
    "model",
    "thinking",
    "signature",
    "reasoning",
    "tool",
    "result",
    "call",
    "arc",
    "drop",
    "strip",
    "caveman",
    "todo",
    "note",
    "nudge",
    "profile",
    "mural",
    "docs",
    "AGENTS.md",
    "config",
    "jsonc",
    "path/to/file.rs",
    "crates/mc-module",
    "packages/plugin",
    "line",
    "42",
    "1,627",
    "3.2s",
    "v0.48.0",
    "#593",
    "<tag>",
    "a&b",
    "x>y",
    "café",
    "naïve",
    "日本語",
    "🙂",
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

/// Prose of roughly `target` bytes: sentences, some bullets, an occasional
/// heading-like line (the renderer must indent it) and blank-line paragraphs.
fn prose(rng: &mut Rng, target: usize) -> String {
    let mut out = String::new();
    while out.len() < target {
        if !out.is_empty() {
            out.push_str(match rng.below(10) {
                0 => "\n\n",
                1 | 2 => "\n- ",
                3 if rng.below(8) == 0 => "\n## ",
                _ => " ",
            });
        }
        let count = 6 + rng.below(14) as usize;
        let sentence = words(rng, count);
        let mut chars = sentence.chars();
        if let Some(first) = chars.next() {
            out.extend(first.to_uppercase());
            out.push_str(chars.as_str());
        }
        out.push('.');
    }
    out
}

fn date(day: u64) -> String {
    let month = 1 + (day / 28) % 12;
    let year = 2026 + day / (28 * 12);
    format!("{year:04}-{month:02}-{:02}", 1 + day % 28)
}

/// One stored compartment covering ordinals `start..=end`. Most rows are v2
/// four-tier rows; about one in twelve is a pre-v2 flat row, and a few carry
/// sparse tiers so the renderer's denser-tier fallback is exercised.
pub(super) fn compartment(rng: &mut Rng, sequence: i64, start: u64, end: u64) -> StoredCompartment {
    let legacy = rng.below(12) == 0;
    let size = 450 + rng.below(700) as usize;
    let p1 = prose(rng, size);
    let tiers = if legacy {
        [None, None, None, None]
    } else {
        let p2 = prose(rng, p1.len() * 45 / 100);
        let p3 = prose(rng, p1.len() / 5);
        let count = 4 + rng.below(8) as usize;
        let p4 = words(rng, count);
        match rng.below(20) {
            0 => [Some(p1.clone()), None, Some(p3), None],
            1 => [Some(p1.clone()), Some(p2), Some(p3), Some(String::new())],
            _ => [Some(p1.clone()), Some(p2), Some(p3), Some(p4)],
        }
    };
    let content = if legacy && rng.below(2) == 0 {
        format!("U: {}\n{p1}", words(rng, 8))
    } else {
        p1
    };
    let title_words = 4 + rng.below(6) as usize;
    let title = words(rng, title_words);
    let day = sequence as u64 / 3;
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

const CATEGORIES: [&str; 5] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
];
pub(super) const PROJECT: &str = "git:large-session";
pub(super) const NOW_MS: i64 = 1_790_000_000_000;

pub(super) fn insert_memory(store: &McStore, rng: &mut Rng, now_ms: i64) {
    let category = CATEGORIES[rng.below(CATEGORIES.len() as u64) as usize];
    let size = 80 + rng.below(260) as usize;
    let content = prose(rng, size);
    let mut input = memory_input(PROJECT, category, &content, now_ms);
    input.importance = Some(1 + rng.below(100) as i32);
    store.insert_memory(input).unwrap();
}

/// The fixture's session: a store, the compartment cursor and the live array.
pub(super) struct LargeSession {
    /// Shared with any other sessions driven against the same store.
    pub(super) store: std::sync::Arc<McStore>,
    pub(super) _dir: Option<tempfile::TempDir>,
    pub(super) session: String,
    pub(super) messages_per_compartment: u64,
    pub(super) next_sequence: i64,
    /// Highest ordinal covered by a stored compartment.
    pub(super) covered_end: u64,
    pub(super) messages: Vec<CkIngressMessage>,
    pub(super) render_generation: u64,
    pub(super) history_budget_tokens: f64,
    pub(super) rng: Rng,
}

impl LargeSession {
    /// `compartments` stored compartments of `messages_per_compartment` ordinals
    /// each, `memories` project memories, and a live array holding the last
    /// `live_covered` covered messages (the host trims older ones at its
    /// compaction marker) followed by `tail` uncovered messages.
    pub(super) fn new(
        seed: u64,
        compartments: usize,
        messages_per_compartment: u64,
        memories: usize,
        live_covered: u64,
        tail: u64,
        host_resolved: bool,
    ) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(store(dir.path()));
        Self::new_in(
            store,
            Some(dir),
            seed,
            compartments,
            messages_per_compartment,
            memories,
            live_covered,
            tail,
            host_resolved,
        )
    }

    /// [`Self::new`] for a session in an existing store.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn new_in(
        store: std::sync::Arc<McStore>,
        dir: Option<tempfile::TempDir>,
        seed: u64,
        compartments: usize,
        messages_per_compartment: u64,
        memories: usize,
        live_covered: u64,
        tail: u64,
        host_resolved: bool,
    ) -> Self {
        let mut rng = Rng::new(seed);
        let session = format!("ses_large_{seed}");
        let rows = (0..compartments)
            .map(|index| {
                let start = index as u64 * messages_per_compartment + 1;
                compartment(
                    &mut rng,
                    index as i64 + 1,
                    start,
                    start + messages_per_compartment - 1,
                )
            })
            .collect::<Vec<_>>();
        if host_resolved {
            // Rows published by the TypeScript historian carry bare message ids. The host
            // resolves each to the module's flat block id once and the store caches that
            // coordinate overlay; every compartment read then applies it.
            let raw = rows
                .iter()
                .map(|row| StoredCompartment {
                    start_message_id: row.start_message_id.trim_end_matches("#0").to_string(),
                    end_message_id: row.end_message_id.trim_end_matches("#0").to_string(),
                    ..row.clone()
                })
                .collect::<Vec<_>>();
            store.replace_compartments(&session, &raw).unwrap();
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
                    session_id: &session,
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
            let resolved = store.load_compartments(&session).unwrap();
            assert_eq!(
                resolved.last().map(|row| row.end_message_id.as_str()),
                rows.last().map(|row| row.end_message_id.as_str()),
                "the cached host coordinates must resolve every bare id"
            );
        } else {
            store.replace_compartments(&session, &rows).unwrap();
        }
        for index in 0..memories {
            insert_memory(&store, &mut rng, NOW_MS - 86_400_000 + index as i64);
        }
        let covered_end = compartments as u64 * messages_per_compartment;
        let first_live = covered_end.saturating_sub(live_covered) + 1;
        let mut fixture = Self {
            store,
            _dir: dir,
            session,
            messages_per_compartment,
            next_sequence: compartments as i64 + 1,
            covered_end,
            messages: Vec::new(),
            render_generation: 0,
            history_budget_tokens: 60_000.0,
            rng,
        };
        for ordinal in first_live..=covered_end + tail {
            fixture.push_message(ordinal);
        }
        fixture
    }

    fn push_message(&mut self, ordinal: u64) {
        let size = 60 + self.rng.below(400) as usize;
        let text = prose(&mut self.rng, size);
        self.messages
            .push(item(&format!("m{ordinal}"), ordinal, &text));
    }

    pub(super) fn last_ordinal(&self) -> u64 {
        self.messages.last().map_or(0, |message| message.ordinal)
    }

    pub(super) fn append_messages(&mut self, count: u64) {
        let last = self.last_ordinal();
        for ordinal in last + 1..=last + count {
            self.push_message(ordinal);
        }
    }

    /// Publish one compartment over the next uncovered messages, keeping at least
    /// `keep_tail` messages uncovered. Returns false when the tail is too short.
    pub(super) fn publish_compartment(&mut self, keep_tail: u64) -> bool {
        let start = self.covered_end + 1;
        let end = self.covered_end + self.messages_per_compartment;
        if end + keep_tail > self.last_ordinal() {
            return false;
        }
        let row = compartment(&mut self.rng, self.next_sequence, start, end);
        self.store
            .append_compartments(&self.session, &[row])
            .unwrap();
        self.next_sequence += 1;
        self.covered_end = end;
        true
    }

    pub(super) fn request(&self) -> TransformRequest {
        let mut request = req(
            &self.session,
            &format!("large-session-{}", self.render_generation),
            self.messages.clone(),
        );
        request.serializer_profile = "opencode".into();
        request
    }

    /// Mark the next pass as a SOFT refresh, the way a publication signal does.
    pub(super) fn request_soft(&self) {
        let mut loaded = self.store.load(&self.session).unwrap();
        loaded.meta.soft_refresh_pending = true;
        self.store
            .commit(
                &self.session,
                loaded.row_version,
                &loaded.core,
                &loaded.meta,
            )
            .unwrap();
    }

    /// A new render-config identity, which forces the next pass to fold (HARD).
    pub(super) fn request_fold(&mut self) {
        self.render_generation += 1;
    }

    pub(super) fn context(&self) -> ProducerContext<'static> {
        let mut context = pctx(PROJECT, "/nonexistent-docs", NOW_MS);
        context.memory_budget_tokens = 15_000.0;
        context.history_budget_tokens = self.history_budget_tokens;
        context.inject_docs = false;
        context
    }

    pub(super) fn run(&self) -> TransformResponse {
        transform(&self.store, &self.request(), &self.context()).unwrap()
    }

    /// SHA-256 of the frozen m0 and m1 payloads after the last pass.
    pub(super) fn m0_m1_digests(&self) -> [String; 2] {
        let loaded = self.store.load(&self.session).unwrap();
        ["m0", "m1"].map(|key| {
            loaded
                .core
                .frozen_units
                .iter()
                .find(|unit| unit.key == key)
                .map_or_else(
                    || "absent".to_string(),
                    |unit| format!("{:x}", Sha256::digest(unit.frozen_payload.as_bytes())),
                )
        })
    }
}

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

/// Prints stage timings for real passes over a synthetic session at production
/// scale: `MC_COMPOSE_COMPARTMENTS` (default 2,300), `MC_COMPOSE_MEMORIES`
/// (default 300) and `MC_COMPOSE_CYCLES` fold cycles (default 5). Each cycle
/// appends live messages, publishes one compartment, then runs a defer, a SOFT
/// and a HARD fold. Run in release:
/// `cargo test -p mc-module --release --lib large_session_compose_profile -- --ignored --nocapture`.
#[test]
#[ignore = "release-mode performance profile; prints timings"]
fn large_session_compose_profile() {
    let compartments = env_usize("MC_COMPOSE_COMPARTMENTS", 2_300);
    let memories = env_usize("MC_COMPOSE_MEMORIES", 300);
    let cycles = env_usize("MC_COMPOSE_CYCLES", 5);
    let build_started = Instant::now();
    let live_covered = env_usize("MC_COMPOSE_LIVE_COVERED", 400) as u64;
    let tail = env_usize("MC_COMPOSE_TAIL", 600) as u64;
    let publish = env_usize("MC_COMPOSE_PUBLISH", 1);
    let append = env_usize("MC_COMPOSE_APPEND", 80) as u64;
    let host_resolved = env_usize("MC_COMPOSE_HOST_RESOLVED", 0) == 1;
    let mut fixture = LargeSession::new(
        0x5eed,
        compartments,
        65,
        memories,
        live_covered,
        tail,
        host_resolved,
    );
    fixture.history_budget_tokens = env_usize("MC_COMPOSE_HISTORY_BUDGET", 60_000) as f64;
    let rows = fixture.store.load_compartments(&fixture.session).unwrap();
    let tier_bytes = rows
        .iter()
        .map(|row| {
            row.title.len()
                + row.content.len()
                + [&row.p1, &row.p2, &row.p3, &row.p4]
                    .iter()
                    .map(|tier| tier.as_deref().map_or(0, str::len))
                    .sum::<usize>()
        })
        .sum::<usize>();
    eprintln!(
        "large-session fixture compartments={} memories={memories} compartment_text_bytes={tier_bytes} live_messages={} covered_end={} build_ms={:.1}",
        rows.len(),
        fixture.messages.len(),
        fixture.covered_end,
        build_started.elapsed().as_secs_f64() * 1000.0,
    );
    let print = |label: &str, fixture: &LargeSession, response: &TransformResponse, wall: f64| {
        let timings = response.timings.as_ref().unwrap();
        let [m0, m1] = fixture.m0_m1_digests();
        eprintln!(
            "large-session pass={label} decision={} reason={:?} out={} wall={wall:.1} total={:.1} planning={:.1} state_evolution={:.1} compose_m0m1={:.1} decay_render_ms={:.1} tier_tokenize_ms={:.1} memory_render_ms={:.1} build_output={:.1} store_commit={:.1} m0={} m1={}",
            response.decision,
            response.materialize_reason,
            response.messages().len(),
            timings.total,
            timings.planning,
            timings.state_evolution,
            timings.compose_m0m1,
            timings.compose.decay_render_ms,
            timings.compose.tier_tokenize_ms,
            timings.compose.memory_render_ms,
            timings.build_output,
            timings.store_commit,
            m0.get(..12).unwrap_or(&m0),
            m1.get(..12).unwrap_or(&m1),
        );
    };
    let timed = |fixture: &LargeSession| {
        // With MC_COMPOSE_SPANS=1 the module's opt-in profiling spans are printed per pass
        // (top 12 by wall time), which splits state_evolution into its parts.
        let spans = std::env::var_os("MC_COMPOSE_SPANS").is_some();
        if spans {
            crate::per_pass_profile::begin_pass();
        }
        let started = Instant::now();
        let response = fixture.run();
        let wall = started.elapsed().as_secs_f64() * 1000.0;
        if spans {
            let mut costs = crate::per_pass_profile::end_pass()
                .into_iter()
                .collect::<Vec<_>>();
            costs.sort_by(|a, b| b.1.wall_ms.total_cmp(&a.1.wall_ms));
            let top = costs
                .iter()
                .take(12)
                .map(|(name, cost)| format!("{name}:{:.1}", cost.wall_ms))
                .collect::<Vec<_>>()
                .join(" ");
            eprintln!("large-session spans {top}");
        }
        (response, wall)
    };
    // MC_COMPOSE_BACKGROUND=N drives N other sessions (MC_COMPOSE_BACKGROUND_COMPARTMENTS
    // compartments each, default 600) through the same store on their own threads while
    // the measured passes run, the way one module process serves several busy sessions.
    let background = env_usize("MC_COMPOSE_BACKGROUND", 0);
    let background_compartments = env_usize("MC_COMPOSE_BACKGROUND_COMPARTMENTS", 600);
    let stop = std::sync::atomic::AtomicBool::new(false);
    let ready = std::sync::Barrier::new(background + 1);
    std::thread::scope(|scope| {
        let workers = (0..background)
            .map(|index| {
                let store = std::sync::Arc::clone(&fixture.store);
                let (stop, ready) = (&stop, &ready);
                scope.spawn(move || {
                    let mut other = LargeSession::new_in(
                        store,
                        None,
                        1_000 + index as u64,
                        background_compartments,
                        65,
                        0,
                        64,
                        1_500,
                        false,
                    );
                    other.run();
                    ready.wait();
                    let mut passes = 0usize;
                    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                        other.append_messages(10);
                        if passes % 6 == 5 {
                            other.publish_compartment(200);
                        }
                        if passes % 9 == 8 {
                            other.request_fold();
                        } else if passes % 5 == 4 {
                            other.request_soft();
                        }
                        other.run();
                        passes += 1;
                    }
                    passes
                })
            })
            .collect::<Vec<_>>();
        ready.wait();
        let (response, wall) = timed(&fixture);
        print("cold", &fixture, &response, wall);
        for cycle in 0..cycles {
            fixture.append_messages(append);
            for _ in 0..publish {
                assert!(fixture.publish_compartment(200));
            }
            let (response, wall) = timed(&fixture);
            print(&format!("c{cycle}-defer"), &fixture, &response, wall);
            fixture.request_soft();
            let (response, wall) = timed(&fixture);
            print(&format!("c{cycle}-soft"), &fixture, &response, wall);
            fixture.request_fold();
            let (response, wall) = timed(&fixture);
            print(&format!("c{cycle}-fold"), &fixture, &response, wall);
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        for (index, worker) in workers.into_iter().enumerate() {
            eprintln!(
                "large-session background={index} passes={}",
                worker.join().unwrap()
            );
        }
    });
}

/// One seeded randomized run: each step may append live messages, publish
/// compartments or add a memory, then runs exactly one pass chosen among defer,
/// SOFT and fold. Returns one line per pass: decision, reason, m0 and m1 digests.
pub(super) fn differential_run(
    seed: u64,
    host_resolved: bool,
    history_budget_tokens: f64,
    passes: usize,
) -> Vec<String> {
    let mut fixture = LargeSession::new(seed, 80, 9, 40, 20, 160, host_resolved);
    fixture.history_budget_tokens = history_budget_tokens;
    let mut lines = Vec::with_capacity(passes + 1);
    let mut choices = Rng::new(seed ^ 0xd1ff);
    // The session's first pass materializes it, as on a real host.
    let response = fixture.run();
    let [m0, m1] = fixture.m0_m1_digests();
    lines.push(format!(
        "seed={seed} pass=cold decision={} reason={} coverage={:?} m0={m0} m1={m1}",
        response.decision,
        response.materialize_reason.as_deref().unwrap_or("-"),
        response.coverage_ordinal,
    ));
    for pass in 0..passes {
        let roll = choices.below(100);
        if roll < 35 {
            let count = 1 + choices.below(30);
            fixture.append_messages(count);
        } else if roll < 55 {
            for _ in 0..=choices.below(3) {
                fixture.publish_compartment(12);
            }
        } else if roll < 65 {
            insert_memory(
                &fixture.store,
                &mut fixture.rng,
                NOW_MS - 1_000 + pass as i64,
            );
        }
        let kind = match choices.below(10) {
            0..=3 => "defer",
            4..=6 => {
                fixture.request_soft();
                "soft"
            }
            _ => {
                fixture.request_fold();
                "fold"
            }
        };
        let response = fixture.run();
        let [m0, m1] = fixture.m0_m1_digests();
        lines.push(format!(
            "seed={seed} pass={pass} kind={kind} decision={} reason={} coverage={:?} m0={m0} m1={m1}",
            response.decision,
            response.materialize_reason.as_deref().unwrap_or("-"),
            response.coverage_ordinal,
        ));
    }
    lines
}

/// The served m0/m1 bytes of every pass in four seeded randomized runs (240
/// randomized passes after each run's materializing pass: folds, SOFT refreshes and
/// defers over indexed and host-resolved compartment rows) must equal the digests in
/// `testdata/compose-large-session-golden.txt`, so a performance change cannot alter
/// rendered output (see the module comment). Regenerate the file only for an
/// intentional render change: `MC_COMPOSE_GOLDEN_WRITE=1 cargo test -p mc-module
/// --lib large_session_compose_differential`.
#[test]
fn large_session_compose_differential() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata/compose-large-session-golden.txt");
    let mut actual = Vec::new();
    for (seed, host_resolved, budget) in [
        (11, false, 3_000.0),
        (12, true, 3_000.0),
        (13, false, 12_000.0),
        (14, true, 800.0),
    ] {
        actual.extend(differential_run(seed, host_resolved, budget, 60));
    }
    let actual = actual.join("\n") + "\n";
    if std::env::var_os("MC_COMPOSE_GOLDEN_WRITE").is_some() {
        // Also printed, for runners whose file writes do not reach the checkout.
        for line in actual.lines() {
            eprintln!("GOLDEN {line}");
        }
        std::fs::write(&path, &actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).unwrap();
    for (index, (actual, expected)) in actual.lines().zip(expected.lines()).enumerate() {
        assert_eq!(actual, expected, "first differing pass at line {index}");
    }
    assert_eq!(actual.lines().count(), expected.lines().count());
    // The run must exercise every pass type, or a matching digest proves little.
    assert!(!expected.contains("decision=PASSTHROUGH"));
    let distinct = |prefix: &str| {
        expected
            .lines()
            .filter_map(|line| line.split(' ').find(|field| field.starts_with(prefix)))
            .collect::<BTreeSet<_>>()
            .len()
    };
    assert!(distinct("m0=") >= 40, "too few distinct m0 renders");
    assert!(distinct("m1=") >= 8, "too few distinct m1 renders");
    for decision in ["decision=HARD", "decision=SOFT ", "decision=SOFT+"] {
        assert!(
            expected
                .lines()
                .filter(|line| line.contains(decision))
                .count()
                >= 20,
            "fewer than 20 {decision} passes"
        );
    }
}

/// Blocks for the helper equivalence tests: `count` single-text messages, then each
/// block's ordinal, role and text are scrambled by `rng` (duplicate ordinals, system
/// rows, descending runs) so the inputs are not the tidy shape the transform builds.
fn scrambled_blocks(rng: &mut Rng, count: usize) -> Vec<FlatBlock> {
    let messages = (0..count)
        .map(|index| {
            let size = 1 + rng.below(120) as usize;
            let text = prose(rng, size);
            item(&format!("b{index}"), index as u64 + 1, &text)
        })
        .collect::<Vec<_>>();
    let projection = crate::ck_wire::project_messages(&messages).unwrap();
    let mut blocks = projection.blocks;
    let span = 1 + rng.below(count as u64 + 3);
    for block in &mut blocks {
        block.ordinal = 1 + rng.below(span);
        if rng.below(7) == 0 {
            block.role = "system".to_string();
        }
    }
    if rng.below(2) == 0 {
        blocks.sort_by_key(|block| block.ordinal);
    }
    blocks
}

/// Reference publication-floor walk that never stops early: tokenize every
/// non-system block, then walk the per-ordinal totals newest first. The tests
/// compare the early-stopping `protected_tail_floor_ordinal` against it.
fn protected_tail_floor_ordinal_reference(
    live: &[&FlatBlock],
    source_first_ordinal: u64,
    context_limit: f64,
    execute_threshold_percentage: f64,
    estimate_tokens: impl Fn(&str) -> usize,
) -> u64 {
    let newest_live = live
        .iter()
        .filter(|block| block.ordinal >= source_first_ordinal)
        .map(|block| block.ordinal)
        .max()
        .unwrap_or(source_first_ordinal);
    let target =
        crate::boundary::derive_protected_tail_token_target(&crate::boundary::BoundaryContext {
            context_limit,
            execute_threshold_percentage,
            ..Default::default()
        });
    let floor_tokens = target.effective_floor.ceil().max(1.0) as usize;
    let mut tokens_by_ordinal = BTreeMap::<u64, usize>::new();
    for block in live
        .iter()
        .filter(|block| block.role != "system" && block.ordinal >= source_first_ordinal)
    {
        let tokens = estimate_tokens(block.bytes.as_ref());
        *tokens_by_ordinal.entry(block.ordinal).or_default() += tokens;
    }
    let mut accumulated = 0usize;
    let mut floor_ordinal = newest_live;
    for (ordinal, tokens) in tokens_by_ordinal.iter().rev() {
        floor_ordinal = *ordinal;
        accumulated = accumulated.saturating_add(*tokens);
        if accumulated >= floor_tokens {
            break;
        }
    }
    floor_ordinal.max(1)
}

#[test]
fn publication_floor_matches_the_full_walk_and_stops_at_the_floor() {
    let mut rng = Rng::new(0xf100);
    let mut stopped_early = 0;
    for case in 0..400 {
        let count = rng.below(60) as usize;
        let blocks = scrambled_blocks(&mut rng, count);
        let live = blocks.iter().collect::<Vec<_>>();
        // Cover both a full source lineage and a lineage whose older half is
        // represented by a closed cut prefix rather than eligible tail rows.
        let source_first_ordinal = if case % 2 == 0 {
            0
        } else {
            live.iter().map(|block| block.ordinal).max().unwrap_or(0) / 2
        };
        // Small context limits put the floor inside the array; large ones walk it all.
        let context_limit = [800.0, 3_000.0, 20_000.0, 1_000_000.0][case % 4];
        // A fixed per-block cost keeps the cases fast and makes the floor reachable.
        let estimate = |text: &str| 40 + text.len() / 3;
        let calls = std::cell::Cell::new(0usize);
        let counted = |text: &str| {
            calls.set(calls.get() + 1);
            estimate(text)
        };
        assert_eq!(
            protected_tail_floor_ordinal(&live, source_first_ordinal, context_limit, 65.0, counted),
            protected_tail_floor_ordinal_reference(
                &live,
                source_first_ordinal,
                context_limit,
                65.0,
                estimate
            ),
            "case {case}"
        );
        let non_system = live
            .iter()
            .filter(|block| block.role != "system" && block.ordinal >= source_first_ordinal)
            .count();
        assert!(calls.get() <= non_system, "case {case}");
        if calls.get() < non_system {
            stopped_early += 1;
        }
    }
    // The walk must stop before the oldest blocks in the cases whose floor it reaches.
    assert!(
        stopped_early >= 50,
        "only {stopped_early} cases stopped early"
    );
}

#[test]
fn merged_coverage_ranges_match_the_per_compartment_scan() {
    let mut rng = Rng::new(0xc0de);
    for case in 0..400 {
        let compartments = (0..rng.below(12))
            .map(|sequence| {
                let start = rng.below(80) as i64 - 5;
                // Mostly ordered spans; some inverted, empty or overlapping ones.
                let end = start + rng.below(20) as i64 - 3;
                StoredCompartment {
                    sequence: sequence as i64,
                    start_message: start,
                    end_message: end,
                    ..Default::default()
                }
            })
            .collect::<Vec<_>>();
        let covered = CoveredOrdinals::new(&compartments);
        for ordinal in 0..100u64 {
            assert_eq!(
                covered.contains(ordinal),
                compartments
                    .iter()
                    .any(|compartment| stored_compartment_covers_ordinal(compartment, ordinal)),
                "case {case} ordinal {ordinal}: {compartments:?}"
            );
        }
        let count = rng.below(40) as usize;
        let blocks = scrambled_blocks(&mut rng, count);
        let live = blocks.iter().collect::<Vec<_>>();
        let coverage = (rng.below(4) > 0).then(|| rng.below(90));
        let reference = coverage.and_then(|coverage| {
            live.iter()
                .copied()
                .filter(|block| block.role != "system" && block.ordinal() <= coverage)
                .filter(|block| {
                    !compartments.iter().any(|compartment| {
                        stored_compartment_covers_ordinal(compartment, block.ordinal())
                    })
                })
                .min_by_key(|block| block.ordinal())
        });
        assert_eq!(
            first_uncovered_live_block(&compartments, &live, coverage).map(|block| &block.id),
            reference.map(|block| &block.id),
            "case {case}"
        );
    }
}

#[test]
fn strip_survival_matches_the_formatted_block_id_set() {
    let mut rng = Rng::new(0x5719);
    for case in 0..300 {
        let mut request = req("strip-survival", "cfg", Vec::new());
        for index in 0..rng.below(8) {
            let mid = ["m", "m#1", "a#", "x0", "m#01"][rng.below(5) as usize];
            let mut message = item(&format!("{mid}{index}"), index + 1, "text");
            if rng.below(3) == 0 {
                message.mid = mid.to_string();
            }
            for _ in 0..rng.below(4) {
                message.ck.content.push(message.ck.content[0].clone());
            }
            request.messages.push(message);
        }
        let mut core = CoreState::default();
        for _ in 0..12 {
            let target = match rng.below(9) {
                0 => "m#1".to_string(),
                1 => "m#01".to_string(),
                2 => "m1#".to_string(),
                3 => format!("m{}#{}", rng.below(8), rng.below(6)),
                4 => format!("m#1{}#{}", rng.below(8), rng.below(6)),
                5 => format!("a#{}#0{}", rng.below(8), rng.below(3)),
                6 => format!("x0{}", rng.below(8)),
                7 => format!("x0{}#+1", rng.below(8)),
                _ => format!("m{}#18446744073709551616", rng.below(8)),
            };
            let kind = ["drop", "reasoning_age", "image"][rng.below(3) as usize];
            core.frozen_units.push(FrozenUnit {
                key: format!("strip:{kind}:{target}"),
                kind: "strip".to_string(),
                frozen_payload: String::new(),
                durability_class: mc_core::DurabilityClass::Lineage,
                reset_rule: String::new(),
            });
        }
        assert_eq!(
            surviving_strip_units(&core, &request),
            surviving_strip_units_reference(&core, &request),
            "case {case}"
        );
    }
}
