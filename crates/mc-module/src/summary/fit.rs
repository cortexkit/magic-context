//! Size a summarizer prompt to the summarizer model's window before it is
//! sent, as the plugin's `historian-prompt-fit.ts`.
//!
//! A prompt has fixed parts (system prompt, seed examples, the session's
//! earlier summaries as references, the project-memory block, instructions)
//! plus the chunk of messages to summarize. A chunk sized as a share of the
//! window alone can make the whole prompt too large, and then every run is
//! refused and the session is never summarized again. So the fixed parts and
//! the output are reserved first, and the chunk gets what remains. When the
//! requested chunk does not fit, the fixed context is trimmed in this order:
//! older diverse references, then recent references oldest first, then
//! project-memory lines lowest priority first, then seed examples. Only when
//! everything is trimmed does the chunk shrink; when not even a minimal chunk
//! fits, the run is refused.

use super::prompt::{
    build_compartment_agent_prompt, order_historian_memories, render_historian_memory_block,
    render_seed_examples_block, render_session_references_block_window, select_seeds,
    select_session_reference_indices, CompartmentPromptInputs, ReferenceCompartment,
};
use crate::calibration::LocalMass;
use crate::context_db::StoredMemory;
use crate::summary::index::SummaryIndex;

/// Smallest chunk worth a run: below it the fixed parts take the whole window
/// and a run could not summarize even one ordinary message.
const MIN_CHUNK_TOKENS: u64 = 1_000;
/// Local tokens held back from the chunk: the fixed parts and the chunk are
/// counted apart, and their joins can differ by a few tokens.
const SLACK_TOKENS: u64 = 64;
/// A share of the input limit left unused, so an estimate slightly under the
/// provider's count is not refused (`PRODUCER_WINDOW_REFUSAL_MARGIN`).
const REFUSAL_MARGIN: f64 = 0.03;
/// Output takes at most this share of a model's window
/// (`OUTPUT_RESERVE_CAP_RATIO`).
const OUTPUT_SHARE_CAP: f64 = 0.25;

/// A model a run may be sent to.
#[derive(Clone, Copy, Debug)]
pub struct Window {
    pub counter: crate::count::Counter,
    /// Its context window in tokens.
    pub context_window: u64,
}

impl Window {
    /// The output a run asks for on this model: `cap`, but at most a quarter
    /// of its window.
    pub fn output_tokens(self, cap: u64) -> u64 {
        cap.min((self.context_window as f64 * OUTPUT_SHARE_CAP) as u64)
    }

    /// Whether a prompt of `system` and `prompt` fits this model next to
    /// `output` tokens of reply, measured as [`fit`] measures it. The check
    /// every prompt passes right before it is sent.
    pub fn admits(self, output: u64, system: &str, prompt: &str) -> bool {
        let Some(limit) = self.input_limit(output) else {
            return true;
        };
        let tokens = self.counter.calibration().provider_mass(
            LocalMass {
                system: self.counter.count(system) as f64,
                prose: self.counter.count(prompt) as f64,
                tools: 0.0,
            },
            true,
        );
        tokens.is_finite() && tokens <= limit as f64
    }

    /// The prompt tokens the model takes next to `output` tokens of reply.
    fn input_limit(self, output: u64) -> Option<u64> {
        let shared = self
            .context_window
            .checked_sub(output)
            .filter(|&left| left > 0)?;
        let limit = (shared as f64 * (1.0 - REFUSAL_MARGIN)).floor() as u64;
        (limit > 0).then_some(limit)
    }
}

/// What a run needs to fit.
pub struct Input<'a> {
    pub session_id: &'a str,
    /// The first ordinal of the chunk: it selects the seed examples.
    pub chunk_start: u64,
    /// The highest ordinal the chunk may end at: it sizes the
    /// `Messages X-Y:` header.
    pub last_ordinal: u64,
    /// The earlier summaries the prompt shows as references, as
    /// [`chosen_references`] picks them, oldest first.
    pub references: &'a [ReferenceCompartment],
    pub memories: &'a [StoredMemory],
    pub memory_enabled: bool,
    /// The two-pass historian's first turn: no memory block, and the anchor
    /// instruction instead.
    pub anchored_facts: bool,
    /// The system prompt the run sends, language directive included.
    pub system_prompt: &'a str,
    /// The profile texts: the first turn's instruction and the calibration
    /// examples.
    pub prompts: &'a super::prompts::SummaryPrompts,
    /// The models the same prompt may be sent to, the first one first.
    pub windows: &'a [Window],
    /// The output each run asks for at most.
    pub output_cap: u64,
    /// The chunk the caller would use without a window, in local tokens.
    pub requested_chunk_tokens: u64,
}

/// The fixed blocks and chunk budget chosen to fit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fit {
    /// Chunk budget in local tokens.
    pub chunk_tokens: u64,
    pub seed_examples: String,
    pub session_references: String,
    pub project_memory: String,
    /// True when any fixed context was trimmed to make room.
    pub trimmed: bool,
}

/// The positions, among `summaries`, of the summaries a run's prompt shows
/// as references. The choice reads only whether each has content and its
/// importance, so a run reads the bodies of the chosen ones alone.
pub fn chosen_references(
    summaries: &[SummaryIndex],
    prompts: &super::prompts::SummaryPrompts,
    session_id: &str,
    chunk_start: u64,
) -> Vec<usize> {
    let seeds = select_seeds(
        &prompts.seeds,
        session_id,
        chunk_start as i64,
        prompts.seeds_per_call,
    );
    let candidates: Vec<(bool, i32)> = summaries
        .iter()
        .map(|summary| (summary.has_content, summary.importance))
        .collect();
    select_session_reference_indices(&candidates, &seeds, session_id, chunk_start as i64)
}

/// Fit the prompt to every model in `input.windows`. `Err` names why not
/// even a minimal chunk fits; the reason stays the same until the model,
/// its window or the prompt change.
pub fn fit(input: &Input<'_>) -> Result<Fit, String> {
    let seeds = select_seeds(
        &input.prompts.seeds,
        input.session_id,
        input.chunk_start as i64,
        input.prompts.seeds_per_call,
    );
    let references = input.references;
    // Anchored facts are compared with memory by the second turn, so the
    // first turn carries no memory block.
    let memories = if input.memory_enabled && !input.anchored_facts {
        order_historian_memories(input.memories)
    } else {
        Vec::new()
    };
    let render = |refs: usize, memory_count: usize, seed_count: usize| {
        (
            render_seed_examples_block(&seeds[..seed_count]),
            render_session_references_block_window(references, refs),
            render_historian_memory_block(&memories[..memory_count]),
        )
    };
    let accept = |refs: usize, memory_count: usize, seed_count: usize, chunk_tokens: u64| {
        let (seed_examples, session_references, project_memory) =
            render(refs, memory_count, seed_count);
        Fit {
            chunk_tokens,
            seed_examples,
            session_references,
            project_memory,
            trimmed: refs < references.len()
                || memory_count < memories.len()
                || seed_count < seeds.len(),
        }
    };
    let header = format!("Messages {}-{}:\n\n", input.chunk_start, input.last_ordinal);
    let fixed_prompt = |refs: usize, memory_count: usize, seed_count: usize| -> String {
        let (seed_examples, session_references, project_memory) =
            render(refs, memory_count, seed_count);
        build_compartment_agent_prompt(&CompartmentPromptInputs {
            seed_examples: &seed_examples,
            session_references: &session_references,
            project_memory: &project_memory,
            input_source: &header,
            memory_enabled: input.memory_enabled,
            user_observations_requested: false,
            extraction_free: false,
            anchored_facts: input.anchored_facts,
            turn_one_instruction: &input.prompts.turn_one,
        })
    };
    let limits: Vec<(crate::count::Counter, u64, f64)> = input
        .windows
        .iter()
        .filter_map(|window| {
            window
                .input_limit(window.output_tokens(input.output_cap))
                .map(|limit| {
                    (
                        window.counter,
                        limit,
                        window.counter.count(input.system_prompt) as f64,
                    )
                })
        })
        .collect();
    if limits.is_empty() {
        // No model with a known window: the prompt goes out as built.
        return Ok(accept(
            references.len(),
            memories.len(),
            seeds.len(),
            input.requested_chunk_tokens,
        ));
    }
    // The largest chunk that keeps the prompt within every model's limit, or
    // `None` when the fixed parts alone do not fit one of them.
    let room = |refs: usize, memory_count: usize, seed_count: usize| -> Option<u64> {
        let prompt = fixed_prompt(refs, memory_count, seed_count);
        let mut room = u64::MAX;
        for (counter, limit, system_tokens) in &limits {
            let fixed = counter.count(&prompt);
            let calibration = counter.calibration();
            let fits = |prose: u64| {
                let tokens = calibration.provider_mass(
                    LocalMass {
                        system: *system_tokens,
                        prose: prose as f64,
                        tools: 0.0,
                    },
                    true,
                );
                tokens.is_finite() && tokens > 0.0 && tokens <= *limit as f64
            };
            if !fits(fixed) {
                return None;
            }
            let (mut lo, mut hi) = (0u64, 1u64);
            while fits(fixed.saturating_add(hi)) && hi < u64::MAX / 2 {
                lo = hi;
                hi *= 2;
            }
            while hi - lo > 1 {
                let mid = lo + (hi - lo) / 2;
                if fits(fixed + mid) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            room = room.min(lo);
        }
        Some(room.saturating_sub(SLACK_TOKENS))
    };
    let requested = input.requested_chunk_tokens;
    let has_room = |refs: usize, memory_count: usize, seed_count: usize| {
        room(refs, memory_count, seed_count).is_some_and(|room| room >= requested)
    };
    // 1. Older diverse references first, then recent ones oldest first.
    for refs in (0..=references.len()).rev() {
        if has_room(refs, memories.len(), seeds.len()) {
            return Ok(accept(refs, memories.len(), seeds.len(), requested));
        }
    }
    // 2. Memory lines, lowest priority first. Fewer lines never need more
    //    room, so the longest prefix that fits is found by bisection.
    if !memories.is_empty() && has_room(0, 0, seeds.len()) {
        let (mut lo, mut hi) = (0usize, memories.len());
        while hi - lo > 1 {
            let mid = lo + (hi - lo) / 2;
            if has_room(0, mid, seeds.len()) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        return Ok(accept(0, lo, seeds.len(), requested));
    }
    // 3. Seed examples.
    for seed_count in (0..=seeds.len()).rev() {
        if has_room(0, 0, seed_count) {
            return Ok(accept(0, 0, seed_count, requested));
        }
    }
    // 4. Everything trimmed: the chunk takes what room is left.
    let floor = requested.min(MIN_CHUNK_TOKENS);
    match room(0, 0, 0) {
        Some(room) if room >= floor && room > 0 => Ok(accept(0, 0, 0, requested.min(room))),
        _ => Err(format!(
            "producer_prompt_exceeds_window: the summarizer's fixed prompt leaves no room for {floor} tokens of messages"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::context_db::StoredCompartment;
    use sha2::{Digest, Sha256};

    fn summary(sequence: i64) -> StoredCompartment {
        StoredCompartment {
            sequence,
            start_message: sequence * 10 + 1,
            end_message: sequence * 10 + 10,
            start_message_id: format!("m{}", sequence * 10 + 1),
            end_message_id: format!("m{}", sequence * 10 + 10),
            title: format!("Summary {sequence}"),
            content: "x ".repeat(400).into(),
            p1: Some("x ".repeat(400).into()),
            importance: 50,
            ..StoredCompartment::default()
        }
    }

    fn memory(id: i64) -> StoredMemory {
        StoredMemory {
            id,
            project_path: "p".into(),
            category: "PROJECT_RULES".into(),
            content: format!("Rule {id}: {}", "y ".repeat(60)),
            status: "active".into(),
            ..StoredMemory::default()
        }
    }

    fn prompts() -> &'static crate::summary::prompts::SummaryPrompts {
        static PROMPTS: std::sync::OnceLock<
            std::sync::Arc<crate::summary::prompts::SummaryPrompts>,
        > = std::sync::OnceLock::new();
        PROMPTS.get_or_init(crate::summary::prompts::SummaryPrompts::bundled)
    }

    /// The references a run over these summaries shows, chosen as a run
    /// chooses them for the chunk [`input`] starts at.
    fn references(summaries: &[StoredCompartment]) -> Vec<ReferenceCompartment> {
        let index: Vec<SummaryIndex> = summaries.iter().map(SummaryIndex::from).collect();
        chosen_references(&index, prompts(), "s1", 101)
            .into_iter()
            .map(|position| ReferenceCompartment::from(&summaries[position]))
            .collect()
    }

    fn input<'a>(
        references: &'a [ReferenceCompartment],
        memories: &'a [StoredMemory],
        windows: &'a [Window],
    ) -> Input<'a> {
        Input {
            session_id: "s1",
            chunk_start: 101,
            last_ordinal: 200,
            references,
            memories,
            memory_enabled: true,
            anchored_facts: false,
            system_prompt: "system",
            prompts: prompts(),
            windows,
            output_cap: 32_000,
            requested_chunk_tokens: 20_000,
        }
    }

    fn window(context_window: u64) -> Window {
        Window {
            counter: crate::count::Counter::for_model(Some("anthropic/claude-sonnet-5-5")),
            context_window,
        }
    }

    #[test]
    fn a_large_window_keeps_everything() {
        let summaries: Vec<_> = (0..10).map(summary).collect();
        let references = references(&summaries);
        let memories: Vec<_> = (1..=20).map(memory).collect();
        let windows = [window(400_000)];
        let fit = fit(&input(&references, &memories, &windows)).unwrap();
        assert!(!fit.trimmed);
        assert_eq!(fit.chunk_tokens, 20_000);
        assert!(fit.project_memory.contains("Rule 20"));
    }

    #[test]
    fn a_small_window_trims_references_then_memories_then_shrinks_the_chunk() {
        let summaries: Vec<_> = (0..10).map(summary).collect();
        let references = references(&summaries);
        let memories: Vec<_> = (1..=200).map(memory).collect();
        let windows = [window(40_000)];
        let fit = fit(&input(&references, &memories, &windows)).unwrap();
        assert!(fit.trimmed);
        // References go before memories.
        assert!(fit.session_references.is_empty());
        assert!(fit.chunk_tokens <= 20_000);
        assert!(fit.chunk_tokens >= MIN_CHUNK_TOKENS);
    }

    #[test]
    fn a_window_too_small_for_any_chunk_is_refused_by_name() {
        let windows = [window(1_500)];
        let error = fit(&input(&[], &[], &windows)).unwrap_err();
        assert!(
            error.starts_with("producer_prompt_exceeds_window"),
            "{error}"
        );
    }

    #[test]
    fn an_unknown_window_leaves_the_prompt_as_built() {
        let memories: Vec<_> = (1..=5).map(memory).collect();
        let fit = fit(&input(&[], &memories, &[])).unwrap();
        assert!(!fit.trimmed);
        assert_eq!(fit.chunk_tokens, 20_000);
    }
    #[test]
    fn exact_opus_prompt_fit_never_uses_the_unknown_ratio() {
        let counter = crate::count::Counter::for_model(Some("anthropic/claude-opus-5-5"));
        let calibration = counter.calibration();
        assert!(calibration.seeded);
        assert_eq!(
            (
                calibration.system_ratio,
                calibration.tools_ratio,
                calibration.prose_ratio
            ),
            (1.0, 1.0, 1.0)
        );
        let system = "You are a careful coding assistant.";
        let prompt =
            "Inspect src/session.rs and keep the cached prefix byte-identical. ".repeat(200);
        let count = cortexkit_tokens::count(cortexkit_tokens::Family::ClaudeV5, system).unwrap()
            + cortexkit_tokens::count(cortexkit_tokens::Family::ClaudeV5, &prompt).unwrap();
        let window = Window {
            counter,
            context_window: count + count / 4,
        };
        assert!(window.admits(0, system, &prompt));
        assert!(!Window {
            context_window: count,
            ..window
        }
        .admits(0, system, &prompt));
        let windows = [Window {
            counter,
            context_window: 80_000,
        }];
        let fitted = fit(&input(&[], &[], &windows)).unwrap();
        assert_eq!(fitted.chunk_tokens, 20_000);
        assert!(!fitted.trimmed);
    }

    /// A summary of every kind a session holds, at many importances: tiered
    /// with `p1` equal to its body, tiered with a different `p1`, legacy
    /// (a body and no tiers), and empty.
    fn varied(sequence: i64) -> StoredCompartment {
        let mut row = StoredCompartment {
            sequence,
            start_message: sequence * 10 + 1,
            end_message: sequence * 10 + 10,
            title: format!("Work {sequence} & <review>"),
            content: format!("Body {sequence}: kept \"the\" prefix.").into(),
            importance: ((sequence * 37) % 100 + 1) as i32,
            episode_type: (sequence % 3 == 0).then(|| "bug".to_owned()),
            ..StoredCompartment::default()
        };
        match sequence % 5 {
            0 => {}
            1 => {
                row.title = String::new();
                row.content = "".into();
            }
            2 => row.p1 = Some(format!("Detail {sequence} differs from the body.").into()),
            _ => {
                row.p1 = Some(row.content.clone());
                row.p2 = Some(format!("Short {sequence}."));
                row.p3 = Some(format!("Shorter {sequence}."));
                row.p4 = (sequence % 2 == 0).then(|| format!("Cue {sequence}."));
            }
        }
        row
    }

    /// The prompt a run builds from what it fitted, as `run.rs` builds it.
    fn run_prompt(fitted: &Fit) -> String {
        build_compartment_agent_prompt(&CompartmentPromptInputs {
            seed_examples: &fitted.seed_examples,
            session_references: &fitted.session_references,
            project_memory: &fitted.project_memory,
            input_source: "Messages 101-200:\n\n[101] U: keep the prefix\n",
            memory_enabled: true,
            user_observations_requested: false,
            extraction_free: false,
            anchored_facts: false,
            turn_one_instruction: &prompts().turn_one,
        })
    }

    /// Choosing references on their index entries and reading only the
    /// chosen bodies picks the summaries choosing among every body picked,
    /// and the summarizer gets the same prompt bytes. The hashes were taken
    /// from the version that handed every summary's body to the run, with
    /// these summaries, memories and windows: one that keeps every
    /// reference, one that trims some, and one that trims them all.
    #[test]
    fn references_chosen_from_the_index_send_the_same_prompt_as_before() {
        let summaries: Vec<_> = (0..60).map(varied).collect();
        let memories: Vec<_> = (1..=5).map(memory).collect();
        let chosen = references(&summaries);
        let every_body: Vec<ReferenceCompartment> =
            summaries.iter().map(ReferenceCompartment::from).collect();
        let seeds = select_seeds(&prompts().seeds, "s1", 101, prompts().seeds_per_call);
        assert_eq!(
            chosen,
            super::super::prompt::select_session_references(&every_body, &seeds, "s1", 101)
        );
        let hashes: Vec<String> = [400_000, 32_000, 24_000]
            .into_iter()
            .map(|context_window| {
                let windows = [window(context_window)];
                let fitted = fit(&input(&chosen, &memories, &windows)).unwrap();
                format!("{:x}", Sha256::digest(run_prompt(&fitted).as_bytes()))
            })
            .collect();
        assert_eq!(
            hashes,
            [
                "33cf478b05c956bd3c4d520967c04d3753c7282f5cde3e0e9524d2c856285537",
                "e85781760a1f87473a0d50ea025bc60aacf296f46e2f823d59da4eda9459ff71",
                "1ae116163ec6ae1384ca1fa66654bca59d0a3918cdcaec2dfeb61f29aa3e72d5",
            ]
        );
    }
}
