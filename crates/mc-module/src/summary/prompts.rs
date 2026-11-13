//! The summarizer's texts, rendered from the memory profile a session
//! resolved: the system prompt both turns run under (`historian/system`), the
//! first turn's instruction asking for anchored facts (`historian/turn-one`),
//! the second turn's instruction (`historian/turn-two`), and the profile's
//! calibration examples. The output contracts inside them are Magic Context's
//! own frames, spliced in by the renderer; the rest of the first turn's user
//! prompt and the second turn's checks are the module's own text.
//!
//! Rendering a profile happens once per profile digest per process; every
//! later run shares the result.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use super::prompt::ReferenceSeed;
use crate::memory_profile::{prompt_profile, render, MemoryContext, FRAMES};

/// The runtime value the second turn's instruction names: the fact ids the
/// reply must decide, as a JSON array.
const ALLOWED_FACT_IDS: &str = "⟦allowed_fact_ids⟧";

#[derive(Debug, PartialEq, Eq)]
pub struct SummaryPrompts {
    /// The profile digest the texts were rendered from.
    pub digest: String,
    pub system: String,
    pub turn_one: String,
    turn_two: String,
    /// The profile's calibration examples (`calibration.file`), and how many
    /// one run shows. A profile without any shows none.
    pub seeds: Vec<ReferenceSeed>,
    pub seeds_per_call: usize,
}

impl SummaryPrompts {
    /// The texts for a session with this memory context. Fails only when the
    /// profile can't be rendered; the run then fails with that reason.
    pub fn for_context(context: Option<&MemoryContext>) -> Result<Arc<Self>, String> {
        let profile = prompt_profile(context).map_err(|refusal| format!("{refusal:?}"))?;
        static CACHE: OnceLock<Mutex<HashMap<String, Arc<SummaryPrompts>>>> = OnceLock::new();
        let cache = CACHE.get_or_init(Default::default);
        if let Some(prompts) = cache.lock().unwrap().get(&profile.digest) {
            return Ok(prompts.clone());
        }
        let render = |document: &str| {
            render(&profile, document, FRAMES)
                .map_err(|refusal| format!("{} {document}: {refusal:?}", profile.name))
        };
        let turn_two = render("historian/turn-two")?;
        if !turn_two.contains(ALLOWED_FACT_IDS) {
            return Err(format!(
                "{} historian/turn-two names no {ALLOWED_FACT_IDS}",
                profile.name
            ));
        }
        // A child profile replaces its parent's calibration through
        // `overrides`.
        let calibration = [
            &profile.body["overrides"]["calibration"],
            &profile.body["calibration"],
        ]
        .into_iter()
        .find(|calibration| calibration["file"].is_string());
        let (seeds, seeds_per_call) = match calibration {
            Some(calibration) => {
                let file = profile
                    .member(calibration, "file")
                    .map_err(|refusal| format!("{} calibration: {refusal:?}", profile.name))?;
                let seeds: Vec<ReferenceSeed> = serde_json::from_str(file)
                    .map_err(|error| format!("{} calibration: {error}", profile.name))?;
                (
                    seeds,
                    calibration["per_call"].as_u64().unwrap_or(0) as usize,
                )
            }
            None => (Vec::new(), 0),
        };
        let prompts = Arc::new(Self {
            digest: profile.digest.clone(),
            system: render("historian/system")?,
            turn_one: render("historian/turn-one")?,
            turn_two,
            seeds,
            seeds_per_call,
        });
        cache
            .lock()
            .unwrap()
            .insert(profile.digest.clone(), prompts.clone());
        Ok(prompts)
    }

    /// The bundled coding profile's texts, which every test without a memory
    /// context runs with.
    #[cfg(test)]
    pub fn bundled() -> Arc<Self> {
        Self::for_context(None).expect("the bundled profile renders")
    }

    /// The 0.49 plugin's texts, which the tests ported from the plugin
    /// compare against.
    #[cfg(test)]
    pub fn plugin() -> Self {
        Self {
            digest: "plugin".into(),
            system: include_str!("../../testdata/two-pass/system.md").into(),
            turn_one: include_str!("../../testdata/two-pass/turn-one.md").into(),
            turn_two: include_str!("../../testdata/two-pass/turn-two.md")
                .replace("{{ALLOWED_FACT_IDS}}", ALLOWED_FACT_IDS),
            seeds: serde_json::from_str(include_str!("../../testdata/reference-seeds.json"))
                .expect("parse reference-seeds.json"),
            seeds_per_call: 3,
        }
    }

    /// The second turn's instruction for these fact ids.
    pub fn turn_two(&self, fact_ids: &[i64]) -> String {
        self.turn_two.replacen(
            ALLOWED_FACT_IDS,
            &serde_json::to_string(fact_ids).expect("ids serialize"),
            1,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_profile_renders_every_summarizer_text() {
        let prompts = SummaryPrompts::bundled();
        for text in [&prompts.system, &prompts.turn_one] {
            assert!(!text.contains('⟦'), "unexpanded marker");
        }
        let turn_two = prompts.turn_two(&[4, 9]);
        assert!(turn_two.contains("allowed_fact_ids: [4,9]"), "{turn_two}");
        assert!(!turn_two.contains('⟦'));
        // The coding profile's calibration corpus, three examples per run.
        assert_eq!(prompts.seeds.len(), 60);
        assert_eq!(prompts.seeds_per_call, 3);
        // The texts carry this step's rulings.
        assert!(prompts
            .system
            .contains("A fact that ends on a date carries that date."));
        assert!(turn_two.contains("give that date as `expires`"));
    }

    #[test]
    fn a_profile_renders_once_and_unchosen_profiles_use_the_bundled_one() {
        let first = SummaryPrompts::bundled();
        assert!(Arc::ptr_eq(&first, &SummaryPrompts::bundled()));
        let mut context = crate::memory_profile::resolve(
            &crate::memory_context::ContextAnswer::NotAnswering,
            &crate::memory_context::ContextAnswer::NotAnswering,
            &[],
        );
        assert!(Arc::ptr_eq(
            &first,
            &SummaryPrompts::for_context(Some(&context)).unwrap()
        ));
        // A context naming a profile version this build doesn't have.
        context.profile.digest = Some("sha256:elsewhere".into());
        assert!(Arc::ptr_eq(
            &first,
            &SummaryPrompts::for_context(Some(&context)).unwrap()
        ));
    }
}
