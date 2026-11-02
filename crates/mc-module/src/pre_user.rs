//! What ck-mc adds to a person's message before the runner stores it (the
//! `pre_user` hook of the step-transform-provider contract): a time marker in front when the previous message
//! is more than five minutes old, and, for sessions with automatic memory, a
//! short hint after it when a search over memories, history and commits finds
//! something relevant.
//!
//! The runner stores the message with these additions, so they are written
//! once and replayed byte for byte like any other message: they never cost a
//! cache rebuild. The rules follow the plugin's `temporal-awareness.ts` and
//! `auto-search-runner.ts`.

use regex::Regex;
use std::sync::OnceLock;

use crate::search::text;

/// Text to put before and after a person's message. Both absent changes
/// nothing.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Addition {
    pub prepend: Option<String>,
    pub append: Option<String>,
}

/// Gaps shorter than this get no marker.
const THRESHOLD_MS: u64 = 5 * 60 * 1_000;

/// How long the search behind a hint may take, the query embedding
/// included. A slower search gives the message no hint; the message is never
/// held up for it.
pub const AUTO_SEARCH_TIMEOUT_MS: u64 = 1_000;

/// `<!-- +12m -->` and a newline for a gap of at least five minutes: minutes
/// under an hour, then hours and minutes, days and hours, weeks and days.
pub fn time_marker(gap_ms: u64) -> Option<String> {
    if gap_ms < THRESHOLD_MS {
        return None;
    }
    let seconds = gap_ms / 1_000;
    let (minute, hour, day, week) = (60, 60 * 60, 24 * 60 * 60, 7 * 24 * 60 * 60);
    let pair = |major: u64, major_unit: &str, minor: u64, minor_unit: &str| {
        if minor == 0 {
            format!("+{major}{major_unit}")
        } else {
            format!("+{major}{major_unit} {minor}{minor_unit}")
        }
    };
    let marker = if seconds < hour {
        format!("+{}m", seconds / minute)
    } else if seconds < day {
        pair(seconds / hour, "h", seconds % hour / minute, "m")
    } else if seconds < week {
        pair(seconds / day, "d", seconds % day / hour, "h")
    } else {
        pair(seconds / week, "w", seconds % week / day, "d")
    };
    Some(format!("<!-- {marker} -->\n"))
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_follow_the_plugin_format() {
        assert_eq!(time_marker(4 * 60 * 1_000 + 59_999), None);
        assert_eq!(
            time_marker(5 * 60 * 1_000).as_deref(),
            Some("<!-- +5m -->\n")
        );
        assert_eq!(time_marker(3_600_000).as_deref(), Some("<!-- +1h -->\n"));
        assert_eq!(
            time_marker((5 * 3_600 + 54 * 60) * 1_000).as_deref(),
            Some("<!-- +5h 54m -->\n")
        );
        assert_eq!(
            time_marker((2 * 86_400 + 3 * 3_600) * 1_000).as_deref(),
            Some("<!-- +2d 3h -->\n")
        );
        assert_eq!(
            time_marker(15 * 86_400 * 1_000).as_deref(),
            Some("<!-- +2w 1d -->\n")
        );
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
