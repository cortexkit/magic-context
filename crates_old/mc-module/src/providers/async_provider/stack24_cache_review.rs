//! Independent cache-review witnesses; these tests do not change provider policy.
//!
//! `Review` adds two observations to the resident-versus-oracle differential
//! that do not depend on the oracle agreeing with the resident:
//!
//! - Served-edit stability: once the runner acknowledged a view, every later
//!   view that keeps the same unchanged source part must keep that part's edit
//!   (the frozen-replay rule). A later view that restores dropped bytes or
//!   rewrites an acknowledged edit is reported with the step that published it.
//! - Reminder echoes: with `echoes`, the fake runner delivers each accepted
//!   `session.send` into the transcript the way a real runner would (a steer
//!   user block, a user message mixing the reminder with authored words, or a
//!   text block inside a tool result), and sometimes the user pastes the text
//!   of a reminder that was already delivered. A view that drops a user text
//!   part which was not a delivered reminder is reported.
use super::*;
use std::collections::VecDeque;

type PartKey = (u64, String, String);

/// Edits by (source ordinal, part): `None` drops the part, `Some` replaces it.
type PartEdits = BTreeMap<(u64, String), Option<String>>;

/// A part's edit in one view: `None` when the view keeps the source bytes,
/// `Some(None)` when it drops the part, `Some(Some(bytes))` when it replaces it.
type EditValue = Option<Option<String>>;

struct Snapshot {
    version: u64,
    /// Index of the operation that published this view, in `Pair::log`.
    step: usize,
    /// The publishing operation and the two before it.
    context: String,
    /// The provider's resync generation when it published.
    generation: u64,
    parts: BTreeMap<PartKey, (String, EditValue)>,
}

#[derive(Default)]
pub(super) struct Review {
    pub(super) echoes: bool,
    /// Rendered texts of accepted sends not yet delivered into the transcript.
    queue: VecDeque<String>,
    consumed_sends: usize,
    delivered: Vec<String>,
    /// Parts whose whole text is a delivered reminder.
    echo_parts: BTreeSet<PartKey>,
    /// Parts holding a user's paste of an already delivered reminder.
    pasted_parts: BTreeSet<PartKey>,
    /// Every acknowledgement in the order the runner sent it: the index of
    /// the operation carrying it, and the version it names.
    acks: Vec<(usize, u64)>,
    snapshots: Vec<Snapshot>,
    /// Tags an agent `ctx_reduce` named; dropping their parts is requested.
    pub(super) requested: BTreeSet<u64>,
    pub(super) violations: Vec<String>,
    pub(super) counts: BTreeMap<String, u64>,
}

/// The text the runner delivers for a reminder send: a template's part slots
/// render the number the runner's transcript shows for the named part.
fn rendered_send(params: &Value, entries: &[ReadMessage]) -> Option<String> {
    let request: cortexkit_role_llm_runner::send::SendRequest =
        serde_json::from_value(params.clone()).ok()?;
    let order = request.delivery_order().ok()??;
    match order.template {
        Some(template) => cortexkit_role_llm_runner::delivery_order::render(
            &crate::runner_reminders::templates(),
            &template,
            |part| {
                entries
                    .iter()
                    .filter(|entry| entry.mid == part.mid)
                    .flat_map(|entry| &entry.tags)
                    .find(|row| row.part == part.part)
                    .and_then(|row| row.tag.as_deref())
                    .and_then(tags::parse_tag)
            },
        )
        .ok(),
        None => request.prompt.clone(),
    }
}

fn user_body(profile: Profile, n: u64, texts: &[String]) -> Value {
    match profile {
        Profile::OpenCode => {
            json!({"info":{"id":format!("m{n}"),"role":"user","time":{"created":1}},
            "parts":texts.iter().enumerate().map(|(i, text)| json!({"id":format!("p{n}r{i}"),"type":"text","text":text})).collect::<Vec<_>>()})
        }
        Profile::Pi => {
            json!({"type":"message","id":format!("m{n}"),"parentId":format!("m{}", n.saturating_sub(1)),
            "timestamp":"2026-05-01T16:52:33.700Z","message":{"role":"user",
            "content":texts.iter().map(|text| json!({"type":"text","text":text})).collect::<Vec<_>>()}})
        }
        Profile::Broca | Profile::Anthropic => json!({"role":"user",
            "content":texts.iter().map(|text| json!({"type":"text","text":text})).collect::<Vec<_>>()}),
    }
}

fn is_user(profile: Profile, message: &Value) -> bool {
    let role = match profile {
        Profile::OpenCode => message.pointer("/info/role"),
        Profile::Pi => message.pointer("/message/role"),
        _ => message.get("role"),
    };
    role.and_then(Value::as_str) == Some("user")
}

impl Review {
    pub(super) fn collect_sends(&mut self, sends: &[Value], entries: &[ReadMessage]) {
        for params in sends.iter().skip(self.consumed_sends) {
            *self.counts.entry("sends".into()).or_default() += 1;
            if let Some(text) = rendered_send(params, entries) {
                self.queue.push_back(text);
            }
        }
        self.consumed_sends = sends.len();
    }

    /// The runner's message `n` when it carries a reminder echo or a user's
    /// paste of one, else `None` for the ordinary fixture message.
    pub(super) fn message(&mut self, profile: Profile, n: u64, salt: u64) -> Option<ReadMessage> {
        if !self.echoes {
            return None;
        }
        let user_slot = if profile == Profile::OpenCode {
            n.is_multiple_of(5)
        } else {
            n.is_multiple_of(4)
        };
        let tool_slot = matches!(profile, Profile::Anthropic | Profile::Pi) && n % 8 == 2;
        let authored = format!("user {n}.{salt} ") + &"durable words ".repeat(12);
        let mid = format!("m{n}");
        let mut entry = if user_slot && !self.queue.is_empty() {
            let text = self.queue.pop_front().unwrap();
            self.delivered.push(text.clone());
            let texts = if n % 3 == 1 {
                *self.counts.entry("mixed_echoes".into()).or_default() += 1;
                vec![text, authored]
            } else {
                *self.counts.entry("steer_echoes".into()).or_default() += 1;
                vec![text]
            };
            self.echo_parts.insert((n, mid.clone(), "0".into()));
            let rows = (0..texts.len() as u64)
                .map(|part| tags::PartTag::tagged(part.to_string(), tag(n, part)))
                .collect();
            ReadMessage::new(n, mid, user_body(profile, n, &texts)).with_tags(rows)
        } else if user_slot && n.is_multiple_of(7) && !self.delivered.is_empty() {
            // The user pastes the exact text of a reminder delivered earlier.
            let text = self.delivered.last().unwrap().clone();
            *self.counts.entry("pastes".into()).or_default() += 1;
            self.pasted_parts.insert((n, mid.clone(), "0".into()));
            ReadMessage::new(n, mid, user_body(profile, n, &[text]))
                .with_tags(vec![tags::PartTag::tagged("0", tag(n, 0))])
        } else if tool_slot && !self.queue.is_empty() {
            let text = self.queue.pop_front().unwrap();
            self.delivered.push(text.clone());
            *self.counts.entry("tool_result_echoes".into()).or_default() += 1;
            let mut entry = message(profile, n, salt);
            if profile == Profile::Pi {
                entry.message["message"]["content"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"type":"text","text":text}));
                entry.tags.push(tags::PartTag::untagged("1"));
                self.echo_parts.insert((n, mid, "1".into()));
            } else {
                let output = entry.message["content"][0]["content"].take();
                entry.message["content"][0]["content"] =
                    json!([{"type":"text","text":output},{"type":"text","text":text}]);
            }
            entry.written_at = Some(now_ms().max(0) as u64);
            return Some(entry);
        } else {
            return None;
        };
        entry.written_at = Some(now_ms().max(0) as u64);
        Some(entry)
    }

    pub(super) fn acknowledge(&mut self, step: usize, version: u64) {
        self.acks.push((step, version));
    }

    /// Record a newly published view. `log` holds the operations so far, the
    /// last being the one that published it; `coverage` and `generation` are
    /// the provider's historian coverage and resync generation at that point.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn record_view(
        &mut self,
        profile: Profile,
        version: u64,
        view: &view::CompactionView,
        entries: &[ReadMessage],
        log: &[String],
        coverage: Option<u64>,
        generation: u64,
        model: &str,
    ) {
        let step = log.len();
        let context = log
            .iter()
            .rev()
            .take(3)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join(" <- ");
        let mut parts = BTreeMap::new();
        self.check_served_history(profile, version, &context, entries, model);
        // Outside this view's historian coverage, a one-message empty
        // replacement is a whole-message cleanup drop. Inside its coverage,
        // the same shape can be a summary segment split at a restart point;
        // shorter later summaries may uncover those source bytes again.
        let removed: Vec<view::ViewRange> = view
            .ranges
            .iter()
            .filter_map(|range| match range {
                view::ViewRange::Replace { from, to, bytes }
                    if *to == from + 1
                        && bytes == "[]"
                        && coverage.is_none_or(|covered| *from > covered) =>
                {
                    let entry = entries.iter().find(|entry| entry.ordinal == *from)?;
                    let drops = entry
                        .tags
                        .iter()
                        .map(|row| view::PartEdit::drop(*from, &entry.mid, &row.part))
                        .collect();
                    Some(view::ViewRange::keep_with_edits(*from, *to, drops))
                }
                _ => None,
            })
            .collect();
        for range in view.ranges.iter().chain(&removed) {
            let view::ViewRange::Keep { from, to, edits } = range else {
                continue;
            };
            for entry in entries
                .iter()
                .filter(|e| e.ordinal >= *from && e.ordinal < *to)
            {
                let digest = contract::digest::content_digest(&entry.message);
                let sources = parts_of(&entry.message);
                let dropped_parts = entry
                    .tags
                    .iter()
                    .filter(|row| {
                        edits.iter().any(|edit| {
                            edit.ordinal == entry.ordinal
                                && edit.mid == entry.mid
                                && edit.part == row.part
                                && edit.bytes.is_none()
                        })
                    })
                    .count();
                for (index, row) in entry.tags.iter().enumerate() {
                    let key = (entry.ordinal, entry.mid.clone(), row.part.clone());
                    let edit = edits.iter().find(|edit| {
                        edit.ordinal == entry.ordinal
                            && edit.mid == entry.mid
                            && edit.part == row.part
                    });
                    let value = edit.map(|edit| edit.bytes.clone());
                    let text_part = sources
                        .get(index)
                        .is_some_and(|part| part.is_string() || part["type"] == "text");
                    // Covered messages may be removed whole. A drop is reported for live,
                    // uncovered user text that is not a delivered reminder, unless an agent
                    // `ctx_reduce` requested it or the words are still in the model input
                    // (that exemption does not cover a user's paste of a reminder).
                    let live = coverage.is_none_or(|covered| entry.ordinal > covered);
                    // A replacement inserted at the start of the model input may still
                    // carry the part's words after the source part is dropped.
                    let still_served = sources
                        .get(index)
                        .and_then(|part| part.as_str().or_else(|| part["text"].as_str()))
                        .is_some_and(|text| {
                            let probe: String = text.chars().take(40).collect();
                            model.contains(&probe)
                        });
                    let requested = row
                        .tag
                        .as_deref()
                        .and_then(tags::parse_tag)
                        .is_some_and(|tag| self.requested.contains(&tag));
                    if matches!(value, Some(None))
                        && text_part
                        && live
                        && !requested
                        && (!still_served || self.pasted_parts.contains(&key))
                        && is_user(profile, &entry.message)
                        && !self.echo_parts.contains(&key)
                    {
                        let kind = if self.pasted_parts.contains(&key) {
                            "pasted reminder text"
                        } else {
                            "authored user text"
                        };
                        let whole = if dropped_parts == entry.tags.len() {
                            "whole message"
                        } else {
                            "single part"
                        };
                        self.violations.push(format!(
                            "AUTHORED view {version} ({context}) dropped {kind} ({whole}) at {key:?}"
                        ));
                    }
                    if self.echo_parts.contains(&key) && matches!(value, Some(None)) {
                        *self
                            .counts
                            .entry("echo_part_strips_in_views".into())
                            .or_default() += 1;
                    }
                    parts.insert(key, (digest.clone(), value));
                }
            }
        }
        self.snapshots.push(Snapshot {
            version,
            step,
            context,
            generation,
            parts,
        });
    }

    /// Observations on the history a runner sends under one view (`model`):
    /// a message with empty content (`EMPTY`; Anthropic answers HTTP 400), a
    /// tool result served without its call although the transcript holds the
    /// call (`ORPHAN`), and, for Anthropic, two adjacent assistant messages
    /// (`ADJACENT`).
    fn check_served_history(
        &mut self,
        profile: Profile,
        version: u64,
        context: &str,
        entries: &[ReadMessage],
        model: &str,
    ) {
        *self.counts.entry(format!("views_{profile:?}")).or_default() += 1;
        let served: Vec<Value> = serde_json::from_str(model).unwrap();
        for (index, message) in served.iter().enumerate() {
            let body = message.get("message").unwrap_or(message);
            let empty = message
                .get("parts")
                .or_else(|| body.get("content"))
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty);
            if empty {
                *self.counts.entry("empty_messages".into()).or_default() += 1;
                self.violations.push(format!(
                    "EMPTY view {version} ({context}) serves message {index} ({:?}) with empty content",
                    tool_arcs::role(message)
                ));
            }
        }
        if profile == Profile::Anthropic {
            for (index, pair) in served.windows(2).enumerate() {
                if pair
                    .iter()
                    .all(|message| tool_arcs::role(message) == Some("assistant"))
                {
                    *self.counts.entry("adjacent_assistants".into()).or_default() += 1;
                    self.violations.push(format!(
                        "ADJACENT view {version} ({context}) serves assistant messages {index} and {}",
                        index + 1
                    ));
                }
            }
        }
        let source: Vec<Value> = entries.iter().map(|entry| entry.message.clone()).collect();
        let (source_calls, _) = stack26_cache_review::tool_ids(&source);
        let (calls, results) = stack26_cache_review::tool_ids(&served);
        let orphans: Vec<_> = results
            .difference(&calls)
            .filter(|id| source_calls.contains(*id))
            .collect();
        if !orphans.is_empty() {
            *self.counts.entry("orphan_views".into()).or_default() += 1;
            self.violations.push(format!(
                "ORPHAN view {version} ({context}) serves results without calls {orphans:?}"
            ));
        }
    }

    /// Compare every view with the view the runner had most recently
    /// acknowledged before it was published.
    pub(super) fn check_served_edits(&mut self) {
        let by_version: BTreeMap<u64, usize> = self
            .snapshots
            .iter()
            .enumerate()
            .map(|(index, snapshot)| (snapshot.version, index))
            .collect();
        for snapshot in &self.snapshots {
            let Some(served) = self
                .acks
                .iter()
                .rev()
                .find(|(step, version)| *step < snapshot.step && *version < snapshot.version)
                .and_then(|(_, version)| by_version.get(version))
                .map(|index| &self.snapshots[*index])
            else {
                continue;
            };
            for (key, (digest, value)) in &snapshot.parts {
                let Some((served_digest, served_value)) = served.parts.get(key) else {
                    continue;
                };
                if served_digest != digest || served_value.is_none() || served_value == value {
                    continue;
                }
                let change = if value.is_none() {
                    "RESTORED source bytes"
                } else {
                    "REWROTE the edit"
                };
                let across = if served.generation == snapshot.generation {
                    "same generation".to_owned()
                } else {
                    format!(
                        "across resync g{}->g{}",
                        served.generation, snapshot.generation
                    )
                };
                self.violations.push(format!(
                    "{change} [{across}] view {} ({}) at {key:?}; acknowledged view {} ({}) served {served_value:?}; now {value:?}",
                    snapshot.version, snapshot.context, served.version, served.context
                ));
            }
        }
        *self.counts.entry("views".into()).or_default() += self.snapshots.len() as u64;
    }
}

fn parts_of(message: &Value) -> Vec<Value> {
    parts(message).unwrap().into_owned()
}

/// One differential session with the review observations; returns the
/// violations and counters instead of failing, so a campaign lists them all.
async fn review_session(
    profile: Profile,
    seed: u64,
    steps: u64,
    echoes: bool,
) -> (Vec<String>, BTreeMap<String, u64>, Vec<String>) {
    let pair = session_pair_with(profile, seed, steps, echoes).await;
    let mut review = pair.review.borrow_mut();
    review.check_served_edits();
    // Views the provider's pairing check withheld: that check is a safety
    // net, so a split it caught is still a finding.
    for split in tool_arcs::withheld::take(&pair.reference) {
        review.violations.push(format!("WITHHELD {split}"));
    }
    (
        std::mem::take(&mut review.violations),
        review.counts.clone(),
        pair.log.clone(),
    )
}

/// The randomized differential with the review observations: sessions
/// `MC_STACK24_FIRST_SEED`.. (default 1000) over all four schemas,
/// `MC_STACK24_SESSIONS` (default 400) sessions of `MC_STACK24_STEPS`
/// (default 24) steps, with runner reminder echoes when `MC_STACK24_ECHOES=1`.
/// Divergences from the oracle and review violations are listed together.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "long randomized review campaign; run explicitly with --ignored"]
async fn stack24_review_campaign() {
    let var = |name: &str, default: u64| {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(default)
    };
    let sessions = var("MC_STACK24_SESSIONS", 400);
    let steps = var("MC_STACK24_STEPS", 24);
    let first = var("MC_STACK24_FIRST_SEED", 1_000);
    let echoes = var("MC_STACK24_ECHOES", 0) == 1;
    let mut failures = Vec::new();
    let mut totals: BTreeMap<String, u64> = BTreeMap::new();
    let mut classes: BTreeMap<String, u64> = BTreeMap::new();
    let mut tasks = Vec::new();
    for index in 0..sessions {
        let profile = PROFILES[(index % 4) as usize];
        let seed = first + index;
        tasks.push((
            seed,
            profile,
            tokio::spawn(review_session(profile, seed, steps, echoes)),
        ));
        if tasks.len() == 8 || index + 1 == sessions {
            for (seed, profile, task) in std::mem::take(&mut tasks) {
                match task.await {
                    Ok((violations, counts, log)) => {
                        for (name, count) in counts {
                            *totals.entry(name).or_default() += count;
                        }
                        for step in log {
                            let class = step.split(" est=").next().unwrap_or(&step);
                            let class = if class.starts_with("notice") {
                                "notice"
                            } else {
                                class
                            };
                            *classes.entry(class.to_owned()).or_default() += 1;
                        }
                        for violation in violations {
                            failures.push(format!("seed {seed} {profile:?} REVIEW {violation}"));
                        }
                    }
                    Err(error) => {
                        let message = error
                            .try_into_panic()
                            .ok()
                            .and_then(|panic| {
                                panic
                                    .downcast_ref::<String>()
                                    .cloned()
                                    .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                            })
                            .unwrap_or_default();
                        failures.push(format!(
                            "seed {seed} {profile:?} DIVERGENCE {}",
                            message.chars().take(1_500).collect::<String>()
                        ));
                    }
                }
            }
        }
    }
    eprintln!(
        "stack24 review: {sessions} sessions from seed {first}, {steps} steps, echoes={echoes}; {} findings; counts={totals:?}; operations={classes:?}; resident skipped {} engine passes",
        failures.len(),
        resident::counters::skipped_engine_passes()
    );
    for failure in &failures {
        eprintln!("FINDING {failure}");
    }
    assert!(failures.is_empty(), "{} findings", failures.len());
}

#[tokio::test]
async fn stack24_reminder_count_matches_full_processing_seed_1301() {
    session(Profile::OpenCode, 1301, 32).await;
}

/// Repeat the seed-1301 session with answer mismatches recorded instead of
/// failing, then print each provider's reclaimable tool-output count and the
/// keys that differ. The diverging urgent `ctx_reduce` reminder reports that
/// count in its `count` slot.
#[tokio::test]
async fn stack24_seed_1301_reclaimable_outputs_match_full_processing() {
    let seed = 1301u64;
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let tiny_budget = rng.chance(10);
    let setup_lineage = (!rng.chance(25)).then_some("L");
    let inject_docs = rng.chance(30);
    let mut pair = Pair::open(Profile::OpenCode, tiny_budget, setup_lineage, inject_docs).await;
    let mostly_covered = rng.chance(50);
    pair.append(if mostly_covered {
        192 + rng.below(40)
    } else {
        16 + rng.below(40)
    });
    if mostly_covered {
        let end = pair.transcript.entries.lock().unwrap().len() as u64 - 12;
        let reference = pair.reference.clone();
        pair.both("initial mostly-covered history", |side| {
            let reference = reference.clone();
            Box::pin(async move { publish_history(side, &reference, end) })
        })
        .await;
    }
    pair.record_only = true;
    pair.notice(&mut rng, None).await;
    while pair.log.len() < 7 {
        pair.step(&mut rng).await;
    }
    let reclaimable = |side: &Side| {
        let head = load_head(side.store(), &pair.reference).unwrap().unwrap();
        let meta = side.store().load(&head.namespace()).unwrap().meta;
        let prefix = head.logical_prefix.as_ref().map(|p| p.tail_from);
        let parts = meta
            .tail_hygiene_baseline
            .map(|baseline| {
                baseline
                    .baseline_parts
                    .into_iter()
                    .filter(|part| {
                        part.kind == mc_store::TailHygienePartKind::ToolOutput && part.u_tokens > 0
                    })
                    .map(|part| part.key)
                    .collect::<BTreeSet<_>>()
            })
            .unwrap_or_default();
        (prefix, meta.coverage_ordinal, parts)
    };
    let (resident_prefix, resident_coverage, resident) = reclaimable(&pair.resident);
    let (_, oracle_coverage, oracle) = reclaimable(&pair.oracle);
    eprintln!(
        "seed 1301 steps={:?} resident prefix tail_from={resident_prefix:?} coverage={resident_coverage:?}/{oracle_coverage:?} counts={}/{} only_resident={:?} only_oracle={:?}",
        pair.log,
        resident.len(),
        oracle.len(),
        resident.difference(&oracle).collect::<Vec<_>>(),
        oracle.difference(&resident).collect::<Vec<_>>()
    );
    assert_eq!(resident, oracle, "reclaimable tool outputs diverged");
}

#[tokio::test]
async fn stack24_seed_1379_completes_without_a_tool_pairing_panic() {
    session(Profile::Anthropic, 1379, 32).await;
}

#[tokio::test]
async fn stack24_full_processing_seed_1379_control() {
    let seed = 1379u64;
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let tiny_budget = rng.chance(10);
    let setup_lineage = (!rng.chance(25)).then_some("L");
    let inject_docs = rng.chance(30);
    let mut pair = Pair::open(Profile::Anthropic, tiny_budget, setup_lineage, inject_docs).await;
    pair.resident
        .h
        .provider_store
        .async_runtime
        .resident
        .lock()
        .unwrap()
        .oracle = true;
    let mostly_covered = rng.chance(50);
    pair.append(if mostly_covered {
        192 + rng.below(40)
    } else {
        16 + rng.below(40)
    });
    if mostly_covered {
        let end = pair.transcript.entries.lock().unwrap().len() as u64 - 12;
        let reference = pair.reference.clone();
        pair.both("initial mostly-covered history", |side| {
            let reference = reference.clone();
            Box::pin(async move { publish_history(side, &reference, end) })
        })
        .await;
    }
    pair.notice(&mut rng, None).await;
    for _ in 0..32 {
        // The transcript shape before each operation locates the step that
        // leaves an invocation without its result.
        let shape: Vec<String> = pair
            .transcript
            .entries
            .lock()
            .unwrap()
            .iter()
            .rev()
            .take(6)
            .map(|entry| {
                let blocks = entry.message["content"]
                    .as_array()
                    .map(|blocks| {
                        blocks
                            .iter()
                            .map(|b| {
                                format!(
                                    "{}:{}",
                                    b["type"].as_str().unwrap_or("?"),
                                    b["id"].as_str().or(b["tool_use_id"].as_str()).unwrap_or("")
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .unwrap_or_else(|| "text".into());
                format!("{}={} [{blocks}]", entry.ordinal, entry.message["role"])
            })
            .collect();
        eprintln!("seed 1379 after {:?}: newest {shape:?}", pair.log.last());
        pair.step(&mut rng).await;
    }
}

#[tokio::test]
async fn stack24_seed_1181_reaches_late_ttl_and_matches() {
    let pair = session_pair(Profile::OpenCode, 1181, 24).await;
    eprintln!("seed 1181 operations: {:?}", pair.log);
    assert!(pair.log.iter().any(|step| step == "ride ttl_expired"));
}

async fn covered_pair() -> Pair {
    let mut pair = Pair::new(Profile::OpenCode, false).await;
    pair.append(160);
    let reference = pair.reference.clone();
    pair.both("review covered history", |side| {
        let reference = reference.clone();
        Box::pin(async move { publish_history(side, &reference, 147) })
    })
    .await;
    assert_eq!(pair.notice(&mut Rng(12), None).await, "ok");
    let ride = json!({"method":"compaction.ride","params":{
        "session_ref":pair.reference,"cause":"ceiling","deadline_ms":300_000}});
    pair.both("review freeze prefix", |side| {
        Box::pin(side.dispatch(ride.clone()))
    })
    .await;
    pair
}

#[derive(Clone, Copy, Debug)]
enum PrefixDamage {
    Missing,
    Generation,
    EditedCoveredText,
    ReorderedCoveredParts,
    DuplicateMid,
    DeletedEntry,
    StaleContextText,
}

fn damage_state(state: &mut State, damage: PrefixDamage) {
    match damage {
        PrefixDamage::Missing => state.logical_prefix = None,
        PrefixDamage::Generation => {
            if let Some(prefix) = state.logical_prefix.as_mut() {
                Arc::make_mut(prefix).generation += 1;
            }
        }
        PrefixDamage::StaleContextText => {
            if let Some(prefix) = state.logical_prefix.as_mut() {
                let source = Arc::make_mut(prefix).context_sources.get_mut(&96).unwrap();
                source.message["parts"][0]["text"] = json!("obsolete cached system text");
            }
        }
        PrefixDamage::DeletedEntry => {
            state.entries.remove(&101).unwrap();
        }
        damage => {
            let mut entry = state.entries[&101].read().unwrap();
            match damage {
                PrefixDamage::EditedCoveredText => {
                    entry.message["parts"][0]["text"] = json!("edited covered text");
                }
                PrefixDamage::ReorderedCoveredParts => {
                    entry.message["parts"].as_array_mut().unwrap().swap(0, 1);
                    entry.tags.swap(0, 1);
                }
                PrefixDamage::DuplicateMid => entry.mid = "m100".into(),
                _ => unreachable!(),
            }
            state
                .entries
                .insert(101, Arc::new(HeldEntry::from_read(&entry).unwrap()));
        }
    }
}

/// Run one rebuild pass over `side`'s conversation after `damage`. Returns
/// whether the input used the saved prefix, the input length, the held entry
/// count and the engine's answer (or its error).
fn damaged_pass(
    side: &Side,
    reference: &str,
    damage: PrefixDamage,
) -> (bool, usize, usize, String) {
    let mut state = side.h.checkout(side.store(), reference).unwrap().unwrap();
    damage_state(&mut state, damage);
    let headers = state.conditions.as_ref().unwrap();
    let notice = notice::AdvanceNotice::from_headers(headers).unwrap();
    let status = transform::compaction::Status {
        lineage_id: state.lineage.clone().unwrap(),
        newest_ordinal: state.entries.last_key_value().map(|(n, _)| *n),
        previous_usage: None,
        request_tokens: notice.est_tokens,
        context_window: 100_000,
        prefix_rebuilding: true,
        cold_prefix: false,
        pipeline_switch: false,
        last_applied_version: None,
        last_not_applied: None,
    };
    let mut engine = state.engine_with_baselines().unwrap();
    let result = side.h.async_engine(
        0,
        &side.h.async_binding(&state),
        &state,
        codec::Codec::OpencodeAiSdk,
        &status,
        &mut engine,
    );
    match result {
        Ok((input, output)) => (
            input.logical_prefix.is_some(),
            input.messages.len(),
            state.entries.len(),
            format!("{:?}", output.answer),
        ),
        Err(error) => (false, 0, state.entries.len(), format!("error {error:?}")),
    }
}

async fn damaged_prefix_uses_full_input(damage: PrefixDamage) {
    let pair = covered_pair().await;
    assert!(load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap()
        .logical_prefix
        .is_some());
    // Exercise selection itself, and compare the answer with the full-processing
    // oracle given the same damaged held entries, so a finding can say whether
    // an accepted stale prefix also changes the produced bytes.
    let (selected, input, held, resident) = damaged_pass(&pair.resident, &pair.reference, damage);
    let (_, oracle_input, _, oracle) = damaged_pass(&pair.oracle, &pair.reference, damage);
    eprintln!(
        "damage={damage:?} prefix_selected={selected} input={input} held={held} oracle_input={oracle_input} same_answer_as_full_processing={}",
        resident == oracle
    );
    if resident != oracle {
        let first = resident
            .chars()
            .zip(oracle.chars())
            .position(|(a, b)| a != b)
            .unwrap_or(resident.len().min(oracle.len()));
        eprintln!(
            "damage={damage:?} first answer difference at char {first}: resident=[{}] oracle=[{}]",
            resident
                .chars()
                .skip(first.saturating_sub(80))
                .take(240)
                .collect::<String>(),
            oracle
                .chars()
                .skip(first.saturating_sub(80))
                .take(240)
                .collect::<String>()
        );
    }
    assert!(!selected, "{damage:?}: stale prefix was accepted");
    assert_eq!(
        resident, oracle,
        "{damage:?}: fallback must return the full-input answer or refusal"
    );
    if !resident.starts_with("error ") {
        assert_eq!(input, held);
    }
}

#[tokio::test]
async fn stack24_missing_prefix_uses_full_input() {
    damaged_prefix_uses_full_input(PrefixDamage::Missing).await;
}

#[tokio::test]
async fn stack24_wrong_generation_uses_full_input() {
    damaged_prefix_uses_full_input(PrefixDamage::Generation).await;
}

#[tokio::test]
async fn stack24_edited_covered_text_uses_full_input() {
    damaged_prefix_uses_full_input(PrefixDamage::EditedCoveredText).await;
}

#[tokio::test]
async fn stack24_reordered_covered_parts_use_full_input() {
    damaged_prefix_uses_full_input(PrefixDamage::ReorderedCoveredParts).await;
}

#[tokio::test]
async fn stack24_duplicate_mid_uses_full_input() {
    damaged_prefix_uses_full_input(PrefixDamage::DuplicateMid).await;
}

#[tokio::test]
async fn stack24_deleted_covered_entry_uses_full_input() {
    damaged_prefix_uses_full_input(PrefixDamage::DeletedEntry).await;
}

#[tokio::test]
async fn stack24_stale_context_text_uses_full_input() {
    damaged_prefix_uses_full_input(PrefixDamage::StaleContextText).await;
}

/// Diagnostic: run one seeded session (`MC_STACK24_TRACE_SEED`, profile index
/// `MC_STACK24_TRACE_PROFILE`, `MC_STACK24_TRACE_STEPS` steps) and print after
/// every operation how the newest view treats source ordinal
/// `MC_STACK24_TRACE_ORDINAL`, plus the frozen-unit keys and pending-drop ids
/// that name it.
#[tokio::test]
#[ignore = "diagnostic trace of one review finding"]
async fn stack24_trace_part() {
    let var = |name: &str, default: u64| {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(default)
    };
    let seed = var("MC_STACK24_TRACE_SEED", 1005);
    let profile = PROFILES[var("MC_STACK24_TRACE_PROFILE", 1) as usize];
    let ordinal = var("MC_STACK24_TRACE_ORDINAL", 32);
    let steps = var("MC_STACK24_TRACE_STEPS", 24);
    let (mut pair, mut rng) =
        session_start(profile, seed, var("MC_STACK24_TRACE_ECHOES", 0) != 0).await;
    let needle = format!("m{ordinal}#");
    for step in 0..=steps {
        if step > 0 {
            pair.step(&mut rng).await;
        }
        let side = &pair.oracle;
        let Some(head) = load_head(side.store(), &pair.reference).unwrap() else {
            continue;
        };
        let loaded = side.store().load(&head.namespace()).unwrap();
        let state = load(side.store(), &pair.reference).unwrap().unwrap();
        let current_digest = state
            .mid_index
            .get(&format!("m{ordinal}"))
            .and_then(|at| state.entries.get(at))
            .and_then(|entry| entry.read().ok())
            .and_then(|entry| served_part_digest(&entry, "0").ok());
        let frozen_native: Vec<Value> =
            serde_json::from_str::<Vec<Value>>(&state.frozen_edits.json().unwrap())
                .unwrap()
                .into_iter()
                .filter(|part| part["mid"] == format!("m{ordinal}"))
                .collect();
        let retired_native = state
            .retired_frozen
            .views
            .iter()
            .filter_map(|(version, edits)| {
                let parts = serde_json::from_str::<Vec<Value>>(&edits.json().unwrap())
                    .unwrap()
                    .into_iter()
                    .filter(|part| part["mid"] == format!("m{ordinal}"))
                    .collect::<Vec<_>>();
                (!parts.is_empty()).then_some((*version, parts))
            })
            .collect::<Vec<_>>();
        let frozen: Vec<_> = loaded
            .core
            .frozen_units
            .iter()
            .filter(|unit| unit.key.contains(&needle))
            .map(|unit| format!("{}:{}", unit.kind, unit.key))
            .collect();
        let pending: Vec<_> = side
            .store()
            .load_pending_agent_drops(&head.namespace())
            .unwrap()
            .into_iter()
            .filter(|drop| drop.target_id.contains(&needle))
            .map(|drop| drop.target_id)
            .collect();
        let (views, _) = side.views(&pair.reference);
        let newest = views.last().map(|(version, json)| {
            let view: view::CompactionView = serde_json::from_str(json).unwrap();
            let placement = view
                .ranges
                .iter()
                .find_map(|range| match range {
                    view::ViewRange::Replace { from, to, .. }
                        if *from <= ordinal && ordinal < *to =>
                    {
                        Some(format!("replace {from}..{to}"))
                    }
                    view::ViewRange::Keep { from, to, edits }
                        if *from <= ordinal && ordinal < *to =>
                    {
                        Some(format!(
                            "keep {from}..{to} edits={:?}",
                            edits
                                .iter()
                                .filter(|edit| edit.ordinal == ordinal)
                                .map(|edit| (edit.part.clone(), edit.bytes.is_some()))
                                .collect::<Vec<_>>()
                        ))
                    }
                    _ => None,
                })
                .unwrap_or_else(|| "tail".into());
            format!("v{version} {placement}")
        });
        if step == var("MC_STACK24_TRACE_DUMP", u64::MAX) {
            if let Some((_, json)) = views.last() {
                let view: view::CompactionView = serde_json::from_str(json).unwrap();
                let model = String::from_utf8(pair.model_bytes(&view)).unwrap();
                let probe = format!("user {ordinal}.");
                eprintln!(
                    "dump ranges={:?} covers_through={} model_has_probe={} model_len={}",
                    view.ranges
                        .iter()
                        .map(|range| match range {
                            view::ViewRange::Replace { from, to, bytes } =>
                                format!("replace {from}..{to} ({} bytes)", bytes.len()),
                            view::ViewRange::Keep { from, to, edits } =>
                                format!("keep {from}..{to} ({} edits)", edits.len()),
                            _ => "other".into(),
                        })
                        .collect::<Vec<_>>(),
                    view.covers_through.ordinal,
                    model.contains(&probe),
                    model.len()
                );
                let entries = pair.transcript.entries.lock().unwrap();
                eprintln!(
                    "dump transcript last={:?} around={:?}",
                    entries.last().map(|e| e.ordinal),
                    entries
                        .iter()
                        .filter(|e| e.ordinal + 3 >= ordinal && e.ordinal <= ordinal + 3)
                        .map(|e| (
                            e.ordinal,
                            e.mid.clone(),
                            e.message.to_string().chars().take(90).collect::<String>()
                        ))
                        .collect::<Vec<_>>()
                );
            }
        }
        eprintln!(
            "trace seed {seed} {profile:?} step {step} after {:?}: lineage={:?} generation={} coverage={:?} newest={newest:?} frozen={frozen:?} pending={pending:?} acks={:?}",
            pair.log.last(),
            head.lineage,
            head.generation,
            loaded.meta.coverage_ordinal,
            pair.review.borrow().acks.iter().rev().take(2).collect::<Vec<_>>()
        );
        eprintln!("native trace step={step} applied={:?} frozen_version={:?} current_digest={current_digest:?} frozen={frozen_native:?} retired={retired_native:?} conditions={:?}", state.applied, state.frozen_edits_version, state.conditions);
    }
}

/// A notice acknowledging `applied`, at `est` estimated tokens.
async fn ack_notice(
    pair: &mut Pair,
    est: u64,
    applied: Option<u64>,
    descent: Option<String>,
) -> String {
    pair.seq += 1;
    let (last_ordinal, digest) = {
        let entries = pair.transcript.entries.lock().unwrap();
        let last = entries.last().unwrap();
        (
            last.ordinal,
            contract::digest::content_digest(&last.message),
        )
    };
    let lineage = pair.transcript.lineage.lock().unwrap().clone();
    let mut notice = notice::AdvanceNotice::new(
        &pair.reference,
        pair.seq,
        lineage.clone(),
        last_ordinal,
        digest,
        est,
        pair.model.clone(),
    )
    .with_window(100_000);
    if let Some(version) = applied {
        notice = notice.with_applied_view_version(version);
    }
    let mut headers = notice.to_headers();
    headers.insert("lineage_id".into(), lineage);
    if let Some(descent) = descent {
        headers.insert("descends_from".into(), descent);
    }
    let notice = notice::AdvanceNotice::from_headers(&headers).unwrap();
    let message = cortexkit_bus_trait::Message {
        subject: notice::event_subject("fixture", "thalamus-harness", notice::ADVANCED_EVENT),
        id: bus_id(&pair.reference, "advanced", pair.seq),
        digest: notice.digest().parse().unwrap(),
        headers,
    };
    pair.deliver(message).await
}

#[derive(Clone, Copy, Debug)]
enum Resync {
    /// The runner lost its state and continues the same messages under a new lineage.
    RestoreNewLineage,
    /// A fork descending from the newest message keeps every earlier message.
    ForkKeepingPrefix,
    /// The runner rewrote its newest message after the provider read it.
    NewestMessageRewritten,
}

/// Every part edit a view makes on source ordinals below `below`, and the
/// ordinals it keeps there. A message the view removes whole (a replace
/// range of that one message by no messages, `emptied_messages::shape`)
/// counts as kept with every part dropped, the form a view gave it before
/// such messages were removed.
fn kept_edits(pair: &Pair, version: u64, below: u64) -> (BTreeSet<u64>, PartEdits) {
    let (views, _) = pair.oracle.views(&pair.reference);
    let (_, json) = views.iter().find(|(v, _)| *v == version).unwrap();
    let view: view::CompactionView = serde_json::from_str(json).unwrap();
    let entries = pair.transcript.entries.lock().unwrap();
    let mut kept = BTreeSet::new();
    let mut edits = BTreeMap::new();
    for range in &view.ranges {
        match range {
            view::ViewRange::Keep { from, to, edits: e } => {
                kept.extend((*from..*to).filter(|n| *n < below));
                for edit in e.iter().filter(|edit| edit.ordinal < below) {
                    edits.insert((edit.ordinal, edit.part.clone()), edit.bytes.clone());
                }
            }
            view::ViewRange::Replace { from, to, bytes }
                if *to == from + 1 && bytes == "[]" && *from < below =>
            {
                let Some(entry) = entries.iter().find(|entry| entry.ordinal == *from) else {
                    continue;
                };
                kept.insert(*from);
                for row in &entry.tags {
                    edits.insert((*from, row.part.clone()), None);
                }
            }
            _ => {}
        }
    }
    (kept, edits)
}

/// A view reducing old tool output is served and acknowledged: either a
/// `compaction.ride` applies an agent's `ctx_reduce` request, or (with
/// `pressure`) the provider's own pressure-triggered reclaim does. Then
/// `resync` happens while every message below ordinal 63 stays unchanged; the
/// next view must keep serving the same edits on those messages.
async fn applied_reduction_survives(resync: Resync, pressure: bool) {
    let mut pair = Pair::new(Profile::Broca, false).await;
    pair.append(64);
    if pressure {
        // Emergency reclaim must have a reachable fixed floor: reported usage
        // alone cannot justify deleting small results when overhead already
        // exceeds the working ceiling. Keep real tool mass in this witness so
        // it still tests preservation of reductions across a resynchronization.
        let mut entries = pair.transcript.entries.lock().unwrap();
        for entry in entries.iter_mut().filter(|entry| entry.ordinal % 4 == 2) {
            entry.message["content"][0]["output"]["text"] = json!(
                format!("output {} ", entry.ordinal) + &"spent tool output line ".repeat(1_000)
            );
        }
    }
    assert_eq!(ack_notice(&mut pair, 5_000, None, None).await, "ok");
    if pressure {
        // As in differential seed 1005: a historian publication, then a
        // force-band notice that reclaims old tool output by itself.
        let reference = pair.reference.clone();
        pair.both("historian publish", |side| {
            let reference = reference.clone();
            Box::pin(async move { publish_history(side, &reference, 20) })
        })
        .await;
        pair.append(1);
        assert_eq!(ack_notice(&mut pair, 96_000, None, None).await, "ok");
    } else {
        // Message 6 is a tool result; reduce its only part by the number the
        // runner's read shows for it.
        let number = {
            let mut entries = pair.transcript.entries.lock().unwrap();
            renumber(&mut entries);
            tags::parse_tag(entries[6].tags[0].tag.as_deref().unwrap()).unwrap()
        };
        let request = json!({"name":"ctx_reduce","arguments":{"drop":number.to_string()}});
        pair.both("ctx_reduce", |side| {
            Box::pin(side.dispatch(request.clone()))
        })
        .await;
        let ride = json!({"method":"compaction.ride","params":{"session_ref":pair.reference,"cause":"ceiling","deadline_ms":300_000}});
        pair.both("ride ceiling", |side| Box::pin(side.dispatch(ride.clone())))
            .await;
    }
    let served = *pair.newest_versions().last().expect("a served view");
    let (_, served_edits) = kept_edits(&pair, served, 63);
    assert!(
        !served_edits.is_empty(),
        "precondition: the served view reduces some old part"
    );
    assert_eq!(ack_notice(&mut pair, 5_000, Some(served), None).await, "ok");
    match resync {
        Resync::RestoreNewLineage => {
            *pair.transcript.lineage.lock().unwrap() = "L-restored".into();
            // A complete turn, so the transcript does not end between a tool call
            // and its result.
            pair.append(4);
        }
        Resync::ForkKeepingPrefix => {
            let (parent, through, digest) = {
                let entries = pair.transcript.entries.lock().unwrap();
                let last = entries.last().unwrap();
                (
                    pair.transcript.lineage.lock().unwrap().clone(),
                    last.ordinal,
                    contract::digest::content_digest(&last.message),
                )
            };
            *pair.transcript.lineage.lock().unwrap() = "F-fork".into();
            pair.append_salted(4, 5_000);
            let outcome = ack_notice(
                &mut pair,
                5_000,
                Some(served),
                Some(format!("{parent}:{through}:{digest}")),
            )
            .await;
            assert_eq!(outcome, "ok");
        }
        Resync::NewestMessageRewritten => {
            let mut entries = pair.transcript.entries.lock().unwrap();
            let last = entries.last_mut().unwrap();
            *last = message(Profile::Broca, last.ordinal, 77);
        }
    }
    if !matches!(resync, Resync::ForkKeepingPrefix) {
        assert_eq!(ack_notice(&mut pair, 5_000, Some(served), None).await, "ok");
    }
    // A resync may wait for one more notice before it publishes.
    if pair.newest_versions().last() == Some(&served) {
        assert_eq!(ack_notice(&mut pair, 5_000, Some(served), None).await, "ok");
    }
    let version = *pair.newest_versions().last().unwrap();
    let (kept, edits) = kept_edits(&pair, version, 63);
    let lost: Vec<_> = served_edits
        .iter()
        .filter(|((ordinal, _), _)| kept.contains(ordinal))
        .filter(|(key, bytes)| edits.get(*key) != Some(*bytes))
        .map(|(key, bytes)| (key.clone(), bytes.is_some(), edits.get(key).cloned()))
        .collect();
    eprintln!(
        "{resync:?} pressure={pressure}: served v{version}<-v{served}; {} served edits, {} changed: {lost:?}; steps {:?}",
        served_edits.len(),
        lost.len(),
        pair.log
    );
    assert!(
        lost.is_empty(),
        "{resync:?}: view {version} changed served bytes of unchanged messages (view {served}): {lost:?}"
    );
}

#[tokio::test]
async fn stack24_restore_under_new_lineage_keeps_applied_reduction() {
    applied_reduction_survives(Resync::RestoreNewLineage, false).await;
}

#[tokio::test]
async fn stack24_fork_descent_keeps_applied_reduction() {
    applied_reduction_survives(Resync::ForkKeepingPrefix, false).await;
}

#[tokio::test]
async fn stack24_newest_message_rewrite_keeps_applied_reduction() {
    applied_reduction_survives(Resync::NewestMessageRewritten, false).await;
}

#[tokio::test]
async fn stack24_restore_under_new_lineage_keeps_force_band_reclaim() {
    applied_reduction_survives(Resync::RestoreNewLineage, true).await;
}

#[tokio::test]
async fn stack24_fork_descent_keeps_force_band_reclaim() {
    applied_reduction_survives(Resync::ForkKeepingPrefix, true).await;
}

#[tokio::test]
async fn stack24_newest_message_rewrite_keeps_force_band_reclaim() {
    applied_reduction_survives(Resync::NewestMessageRewritten, true).await;
}

/// Differential seed 1005 (OpenCode): a force-band view drops old tool output
/// at messages 32 and 33 and is acknowledged; after two fork descents and a
/// restore under a new lineage, a low-pressure notice publishes a view that
/// serves those unchanged messages' source bytes again.
#[tokio::test]
async fn stack24_seed_1005_resync_keeps_served_reductions() {
    let (violations, _, log) = review_session(Profile::OpenCode, 1005, 24, false).await;
    let restored: Vec<_> = violations
        .iter()
        .filter(|violation| violation.starts_with("RESTORED"))
        .collect();
    assert!(
        restored.is_empty(),
        "{} served reductions restored; first: {:?}; steps {log:?}",
        restored.len(),
        restored.first()
    );
}

/// Differential seed 1197 (OpenCode): a historian replacement moves coverage
/// from 90 back to 81, and, within one resync generation, the next view restores
/// source bytes for parts that an acknowledged view had dropped.
#[tokio::test]
async fn stack24_seed_1197_coverage_rewind_keeps_served_reductions() {
    let (violations, _, log) = review_session(Profile::OpenCode, 1197, 24, false).await;
    let restored: Vec<_> = violations
        .iter()
        .filter(|violation| {
            violation.starts_with("RESTORED") && violation.contains("same generation")
        })
        .collect();
    assert!(
        restored.is_empty(),
        "{} served reductions restored; first: {:?}; steps {log:?}",
        restored.len(),
        restored.first()
    );
}

/// Delayed acknowledgements and transcript rewrites must use the publication's
/// source digests, even when reminder echoes change what a reused mid contains.
#[tokio::test]
async fn stack25_delayed_acknowledgements_keep_publication_source_identities() {
    for (profile, seed) in [
        (Profile::OpenCode, 7009),
        (Profile::Pi, 7030),
        (Profile::Anthropic, 7071),
        (Profile::Pi, 7178),
        (Profile::Anthropic, 7335),
        (Profile::OpenCode, 7341),
        (Profile::Pi, 7362),
    ] {
        let (violations, _, log) = review_session(profile, seed, 32, true).await;
        let restored = violations
            .iter()
            .filter(|row| row.starts_with("RESTORED"))
            .collect::<Vec<_>>();
        assert!(
            restored.is_empty(),
            "seed {seed} {profile:?}: {restored:?}; steps={log:?}"
        );
    }
}

#[test]
fn covered_empty_history_segment_is_not_a_frozen_cleanup_edit() {
    let entry = message(Profile::Broca, 0, 0);
    let mut review = Review::default();
    let published = view::CompactionView::new(
        "fixture",
        1,
        "L",
        contract::lineage::MessageRef {
            ordinal: 0,
            mid: entry.mid.clone(),
        },
        vec![view::ViewRange::replace(0, 1, "[]")],
    );
    review.record_view(
        Profile::Broca,
        1,
        &published,
        std::slice::from_ref(&entry),
        &["summarized".into()],
        Some(0),
        0,
        "[]",
    );
    review.acknowledge(1, 1);
    let uncovered = view::CompactionView::new(
        "fixture",
        2,
        "L",
        contract::lineage::MessageRef {
            ordinal: 0,
            mid: entry.mid.clone(),
        },
        vec![view::ViewRange::keep(0, 1)],
    );
    review.record_view(
        Profile::Broca,
        2,
        &uncovered,
        std::slice::from_ref(&entry),
        &["acknowledged".into(), "shorter summary".into()],
        None,
        0,
        &json!([entry.message]).to_string(),
    );
    review.check_served_edits();
    assert!(
        review.snapshots[0].parts.is_empty(),
        "covered summary rows must not be recorded as cleanup edits"
    );
    assert!(
        review
            .violations
            .iter()
            .all(|row| !row.starts_with("RESTORED")),
        "coverage is fixed by the publishing view, not by the later uncovered boundary"
    );
}

#[test]
fn uncovered_empty_replacement_still_detects_a_restored_cleanup_drop() {
    let entry = message(Profile::Broca, 0, 0);
    let mut review = Review::default();
    let published = view::CompactionView::new(
        "fixture",
        1,
        "L",
        contract::lineage::MessageRef {
            ordinal: 0,
            mid: entry.mid.clone(),
        },
        vec![view::ViewRange::replace(0, 1, "[]")],
    );
    review.record_view(
        Profile::Broca,
        1,
        &published,
        std::slice::from_ref(&entry),
        &["cleanup".into()],
        None,
        0,
        "[]",
    );
    review.acknowledge(1, 1);
    let restored = view::CompactionView::new(
        "fixture",
        2,
        "L",
        contract::lineage::MessageRef {
            ordinal: 0,
            mid: entry.mid.clone(),
        },
        vec![view::ViewRange::keep(0, 1)],
    );
    review.record_view(
        Profile::Broca,
        2,
        &restored,
        std::slice::from_ref(&entry),
        &["acknowledged".into(), "restored".into()],
        None,
        0,
        &json!([entry.message]).to_string(),
    );
    review.check_served_edits();
    assert!(
        review
            .violations
            .iter()
            .any(|row| row.starts_with("RESTORED")),
        "uncovered cleanup removals remain frozen edits"
    );
}

#[test]
fn explicit_part_drop_remains_an_edit_even_inside_published_history_coverage() {
    let entry = message(Profile::Broca, 0, 0);
    let mut review = Review::default();
    let published = view::CompactionView::new(
        "fixture",
        1,
        "L",
        contract::lineage::MessageRef {
            ordinal: 0,
            mid: entry.mid.clone(),
        },
        vec![view::ViewRange::keep_with_edits(
            0,
            1,
            vec![view::PartEdit::drop(0, &entry.mid, "0")],
        )],
    );
    review.record_view(
        Profile::Broca,
        1,
        &published,
        std::slice::from_ref(&entry),
        &["explicit drop".into()],
        Some(0),
        0,
        "[]",
    );
    review.acknowledge(1, 1);
    let restored = view::CompactionView::new(
        "fixture",
        2,
        "L",
        contract::lineage::MessageRef {
            ordinal: 0,
            mid: entry.mid.clone(),
        },
        vec![view::ViewRange::keep(0, 1)],
    );
    review.record_view(
        Profile::Broca,
        2,
        &restored,
        std::slice::from_ref(&entry),
        &["acknowledged".into(), "uncovered".into()],
        None,
        0,
        &json!([entry.message]).to_string(),
    );
    review.check_served_edits();
    assert!(
        review
            .violations
            .iter()
            .any(|row| row.starts_with("RESTORED")),
        "explicit edits are independent of summary coverage"
    );
}
