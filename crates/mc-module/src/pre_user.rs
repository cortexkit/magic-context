//! What ck-mc adds to a person's message before the runner stores it (the
//! `pre_user` hook of the step-transform-provider contract): for sessions
//! with automatic memory, a short hint after it when a search over memories,
//! history and commits finds something relevant.
//!
//! The runner stores the message with the hint, so it is written once and
//! replayed byte for byte like any other message: it never costs a cache
//! rebuild. The rules follow the plugin's `auto-search-runner.ts`.

use regex::Regex;
use std::sync::OnceLock;

use crate::search::text;

/// Text to put after a person's message. Absent changes nothing.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Addition {
    pub append: Option<String>,
}

/// How long the search behind a hint may take, the query embedding
/// included. A slower search gives the message no hint; the message is never
/// held up for it.
pub const AUTO_SEARCH_TIMEOUT_MS: u64 = 1_000;

/// Whether the message already carries a memory hint, which a second one
/// would only repeat.
pub fn has_hint(text: &str) -> bool {
    text.contains("<ctx-search-hint>") || text.contains("<ctx-search-auto>")
}

/// What the person typed, for searching: system reminders, comments, markup
/// and tag numbers removed, as the plugin cleans a prompt before embedding
/// it, so plugin text never reaches the search or the embedding endpoint.
pub fn prompt_text(raw: &str) -> String {
    static COMMENT: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    static NUMBER: OnceLock<Regex> = OnceLock::new();
    static TRAILING: OnceLock<Regex> = OnceLock::new();
    static BLANK_LINES: OnceLock<Regex> = OnceLock::new();
    let compile = |cell: &'static OnceLock<Regex>, pattern: &str| -> &'static Regex {
        cell.get_or_init(|| Regex::new(pattern).expect("prompt pattern"))
    };
    let text = text::remove_system_reminders(raw);
    let text = compile(&COMMENT, r"(?s)<!--.*?-->").replace_all(&text, "");
    let text = compile(&TAG, r"</?[a-zA-Z][^<>]*>").replace_all(&text, "");
    let text = compile(&NUMBER, r"§\d+§\s*").replace_all(&text, "");
    let text = compile(&TRAILING, r"[ \t]+\n").replace_all(&text, "\n");
    let text = compile(&BLANK_LINES, r"\n{3,}").replace_all(&text, "\n\n");
    text.trim().to_owned()
}

/// Text blocks eligible for additions before the runner stores a prompt,
/// with the message's time from the runner's machine when it sends one.
pub(crate) fn person_blocks(
    subject: &cortexkit_role_step_transform_provider::hook::Subject,
) -> Option<(&[String], Option<u64>)> {
    match subject {
        cortexkit_role_step_transform_provider::hook::Subject::PreUser {
            blocks,
            delivery: None,
            mark: None,
            at_ms,
        } if !blocks.is_empty() => Some((blocks, *at_ms)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surface_delivered_or_marked_prompts_are_not_person_messages() {
        use cortexkit_role_step_transform_provider::hook::Subject;
        use serde_json::json;
        let human: Subject =
            serde_json::from_value(json!({"hook":"pre_user","blocks":["Fix the parser"]})).unwrap();
        assert_eq!(person_blocks(&human).map(|(_, at)| at), Some(None));
        let stamped: Subject = serde_json::from_value(
            json!({"hook":"pre_user","blocks":["Fix the parser"],"at_ms":42}),
        )
        .unwrap();
        assert_eq!(person_blocks(&stamped).map(|(_, at)| at), Some(Some(42)));
        for extra in [
            json!({"delivery":"steer"}),
            json!({"delivery":"queue"}),
            json!({"mark":{"kind":"notice"}}),
        ] {
            let mut value = json!({"hook":"pre_user","blocks":["Fix the parser"]});
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let subject: Subject = serde_json::from_value(value).unwrap();
            assert!(person_blocks(&subject).is_none());
        }
    }

    #[test]
    fn prompts_lose_plugin_text() {
        assert_eq!(
            prompt_text("<system-reminder>a <system-reminder>b</system-reminder> c</system-reminder>Fix <b>the</b> parser<!-- +5m -->"),
            "Fix the parser"
        );
        assert_eq!(prompt_text("§12§ hello"), "hello");
        assert!(has_hint("x\n\n<ctx-search-hint>\n…"));
    }
}
