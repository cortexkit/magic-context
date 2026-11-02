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
    select_session_references, CompartmentPromptInputs, ReferenceCompartment, SEED_FLOOR,
};
use crate::calibration::{DecisionCalibration, LocalMass};
use crate::context_db::{StoredCompartment, StoredMemory};

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
    pub calibration: DecisionCalibration,
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
        let tokens = self.calibration.provider_mass(
            LocalMass {
                system: mc_tokenizer::estimate_tokens(system) as f64,
                prose: mc_tokenizer::estimate_tokens(prompt) as f64,
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
    pub summaries: &'a [StoredCompartment],
    pub memories: &'a [StoredMemory],
    pub memory_enabled: bool,
    /// The system prompt the run sends, language directive included.
    pub system_prompt: &'a str,
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

/// Fit the prompt to every model in `input.windows`. `Err` names why not
/// even a minimal chunk fits; the reason stays the same until the model,
/// its window or the prompt change.
pub fn fit(input: &Input<'_>) -> Result<Fit, String> {
    let seeds = select_seeds(input.session_id, input.chunk_start as i64, SEED_FLOOR);
    let references: Vec<ReferenceCompartment> = input
        .summaries
        .iter()
        .map(ReferenceCompartment::from)
        .collect();
    let references = select_session_references(
        &references,
        &seeds,
        input.session_id,
        input.chunk_start as i64,
    );
    let memories = if input.memory_enabled {
        order_historian_memories(input.memories)
    } else {
        Vec::new()
    };
    let render = |refs: usize, memory_count: usize, seed_count: usize| {
        (
            render_seed_examples_block(&seeds[..seed_count]),
            render_session_references_block_window(&references, refs),
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
    let system_tokens = mc_tokenizer::estimate_tokens(input.system_prompt) as f64;
    let fixed_tokens = |refs: usize, memory_count: usize, seed_count: usize| -> u64 {
        let (seed_examples, session_references, project_memory) =
            render(refs, memory_count, seed_count);
        let prompt = build_compartment_agent_prompt(&CompartmentPromptInputs {
            seed_examples: &seed_examples,
            session_references: &session_references,
            project_memory: &project_memory,
            input_source: &header,
            memory_enabled: input.memory_enabled,
            user_observations_requested: false,
            extraction_free: false,
        });
        mc_tokenizer::estimate_tokens(&prompt) as u64
    };
    let limits: Vec<(DecisionCalibration, u64)> = input
        .windows
        .iter()
        .filter_map(|window| {
            window
                .input_limit(window.output_tokens(input.output_cap))
                .map(|limit| (window.calibration, limit))
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
        let fixed = fixed_tokens(refs, memory_count, seed_count);
        let mut room = u64::MAX;
        for (calibration, limit) in &limits {
            let fits = |prose: u64| {
                let tokens = calibration.provider_mass(
                    LocalMass {
                        system: system_tokens,
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

    fn summary(sequence: i64) -> StoredCompartment {
        StoredCompartment {
            sequence,
            start_message: sequence * 10 + 1,
            end_message: sequence * 10 + 10,
            start_message_id: format!("m{}", sequence * 10 + 1),
            end_message_id: format!("m{}", sequence * 10 + 10),
            title: format!("Summary {sequence}"),
            content: "x ".repeat(400),
            p1: Some("x ".repeat(400)),
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

    fn input<'a>(
        summaries: &'a [StoredCompartment],
        memories: &'a [StoredMemory],
        windows: &'a [Window],
    ) -> Input<'a> {
        Input {
            session_id: "s1",
            chunk_start: 101,
            last_ordinal: 200,
            summaries,
            memories,
            memory_enabled: true,
            system_prompt: "system",
            windows,
            output_cap: 32_000,
            requested_chunk_tokens: 20_000,
        }
    }

    fn window(context_window: u64) -> Window {
        Window {
            calibration: DecisionCalibration::for_model(Some("anthropic/claude-sonnet-5-5")),
            context_window,
        }
    }

    #[test]
    fn a_large_window_keeps_everything() {
        let summaries: Vec<_> = (0..10).map(summary).collect();
        let memories: Vec<_> = (1..=20).map(memory).collect();
        let windows = [window(400_000)];
        let fit = fit(&input(&summaries, &memories, &windows)).unwrap();
        assert!(!fit.trimmed);
        assert_eq!(fit.chunk_tokens, 20_000);
        assert!(fit.project_memory.contains("Rule 20"));
    }

    #[test]
    fn a_small_window_trims_references_then_memories_then_shrinks_the_chunk() {
        let summaries: Vec<_> = (0..10).map(summary).collect();
        let memories: Vec<_> = (1..=200).map(memory).collect();
        let windows = [window(40_000)];
        let fit = fit(&input(&summaries, &memories, &windows)).unwrap();
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
}
