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
/// The frame the second turn's instruction ends its numbered decision rules
/// with; the workspace rule follows it.
const DECISIONS_FRAME: &str = "historian/turn-two.decisions";
/// The decision rule a project in a workspace of two or more projects is
/// sent: when a new memory may be stored for the whole workspace.
const WORKSPACE_FRAME: &str = "historian/turn-two.decisions.workspace";

/// The workspace the second turn's workspace rule names: its display name
/// and its projects' names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceRule {
    pub name: String,
    pub projects: Vec<String>,
}

impl WorkspaceRule {
    /// The rule's text: the frame with the workspace's name, how many
    /// projects it holds and their names, sorted and comma-separated.
    pub fn text(&self) -> String {
        let mut projects = self.projects.clone();
        projects.sort();
        fill(
            frame(WORKSPACE_FRAME),
            &[
                ("workspace.name", &self.name),
                ("workspace.count", &projects.len().to_string()),
                ("workspace.projects", &projects.join(", ")),
            ],
        )
    }
}

/// An MC frame's text, without the newline that ends its file.
fn frame(name: &str) -> &'static str {
    let (_, text) = FRAMES
        .iter()
        .find(|(full, _)| *full == name)
        .unwrap_or_else(|| panic!("no MC frame {name}"));
    text.strip_suffix('\n').unwrap_or(text)
}

/// Replace each runtime marker `⟦name⟧` in `template` with its value, in one
/// pass, so a value that looks like a marker stays as written.
fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('⟦') {
        out.push_str(&rest[..start]);
        let marker = &rest[start..];
        let found = values.iter().find_map(|(name, value)| {
            let written = format!("⟦{name}⟧");
            marker
                .starts_with(&written)
                .then_some((written.len(), *value))
        });
        match found {
            Some((length, value)) => {
                out.push_str(value);
                rest = &marker[length..];
            }
            None => {
                out.push('⟦');
                rest = &marker['⟦'.len_utf8()..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[derive(Debug, PartialEq, Eq)]
pub struct SummaryPrompts {
    /// The profile digest the texts were rendered from.
    pub digest: String,
    pub system: String,
    pub turn_one: String,
    turn_two: String,
    /// Where the decisions frame ends in `turn_two`: the workspace rule goes
    /// there.
    decisions_end: usize,
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
        let decisions_end = decisions_end(&turn_two).ok_or_else(|| {
            format!(
                "{} historian/turn-two does not carry {DECISIONS_FRAME}",
                profile.name
            )
        })?;
        let calibration = &profile.body["calibration"];
        let (seeds, seeds_per_call) = match calibration["file"].is_string().then_some(calibration) {
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
            decisions_end,
            seeds,
            seeds_per_call,
        });
        // Two runs may render the same profile at once; the first one stored
        // is the one every caller shares.
        Ok(cache
            .lock()
            .unwrap()
            .entry(profile.digest.clone())
            .or_insert(prompts)
            .clone())
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
        let turn_two = include_str!("../../testdata/two-pass/turn-two.md")
            .replace("{{ALLOWED_FACT_IDS}}", ALLOWED_FACT_IDS);
        Self {
            digest: "plugin".into(),
            system: include_str!("../../testdata/two-pass/system.md").into(),
            turn_one: include_str!("../../testdata/two-pass/turn-one.md").into(),
            decisions_end: decisions_end(&turn_two).unwrap_or(turn_two.len()),
            turn_two,
            seeds: serde_json::from_str(include_str!("../../testdata/reference-seeds.json"))
                .expect("parse reference-seeds.json"),
            seeds_per_call: 3,
        }
    }

    /// The second turn's instruction for these fact ids.
    pub fn turn_two(&self, fact_ids: &[i64]) -> String {
        self.turn_two_in(fact_ids, None)
    }

    /// The second turn's instruction for these fact ids, with the workspace
    /// rule right after the decisions frame when `workspace` is given.
    pub fn turn_two_in(&self, fact_ids: &[i64], workspace: Option<&WorkspaceRule>) -> String {
        let mut text = self.turn_two.clone();
        if let Some(workspace) = workspace {
            text.insert_str(self.decisions_end, &format!("\n{}", workspace.text()));
        }
        // The fact ids are filled in after the rule goes in, and only where
        // the decisions frame names them, so a workspace or project name
        // can't take their place.
        text.replacen(
            ALLOWED_FACT_IDS,
            &serde_json::to_string(fact_ids).expect("ids serialize"),
            1,
        )
    }
}

/// Where the decisions frame's last line ends in a rendered second-turn
/// instruction, if it carries the frame. The frame's text ends with an empty
/// line, which stays after the workspace rule.
fn decisions_end(turn_two: &str) -> Option<usize> {
    let decisions = frame(DECISIONS_FRAME).trim_end_matches('\n');
    turn_two
        .rfind(decisions)
        .map(|start| start + decisions.len())
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
    fn the_workspace_rule_follows_the_decisions_frame_with_its_markers_filled() {
        let prompts = SummaryPrompts::bundled();
        let rule = WorkspaceRule {
            name: "CortexKit".into(),
            projects: vec!["subc".into(), "entorhinal".into(), "magic-context".into()],
        };
        let plain = prompts.turn_two(&[4, 9]);
        let with = prompts.turn_two_in(&[4, 9], Some(&rule));
        let decisions =
            frame(DECISIONS_FRAME)
                .trim_end_matches('\n')
                .replacen(ALLOWED_FACT_IDS, "[4,9]", 1);
        assert!(
            with.contains(&format!(
                "{decisions}\n6. This project belongs to the workspace CortexKit, which holds 3 projects: entorhinal, magic-context, subc. A memory stored for the workspace appears in every one of those projects' sessions."
            )),
            "{with}"
        );
        // The instruction still ends as it did: with the decisions frame's
        // empty last line, now after the rule.
        assert!(with
            .ends_with("A neighbour marked `(workspace)` is already stored for the workspace.\n"));
        assert!(plain.ends_with("eligible targets.\n"));
        assert!(!with.contains('⟦'), "{with}");
        // The rule is the only difference, and without a workspace the
        // instruction is the one sent before.
        assert_eq!(with.replacen(&format!("\n{}", rule.text()), "", 1), plain);
        assert_eq!(prompts.turn_two_in(&[4, 9], None), plain);
    }

    #[test]
    fn a_name_that_looks_like_a_marker_is_kept_as_written() {
        let rule = WorkspaceRule {
            name: "⟦workspace.count⟧".into(),
            projects: vec!["⟦allowed_fact_ids⟧".into(), "b".into()],
        };
        let text = SummaryPrompts::bundled().turn_two_in(&[1], Some(&rule));
        assert!(text.contains(
            "the workspace ⟦workspace.count⟧, which holds 2 projects: b, ⟦allowed_fact_ids⟧."
        ));
        assert!(text.contains("allowed_fact_ids: [1]"));
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
