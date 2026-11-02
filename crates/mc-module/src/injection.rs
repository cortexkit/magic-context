//! Text that a harness or plugin injects into a message (a `<system-reminder>`
//! block, an oh-my-opencode directive, a skill reminder) and that is spent once
//! the model has read it. The injection-strip lane removes it from messages
//! outside the protected tail. A port of the plugin's
//! `system-injection-stripper.ts`, which is the reference: its regions, its
//! order and its trimming.

use std::sync::OnceLock;

use regex::Regex;

/// Text that marks an injected region.
const MARKERS: &[&str] = &[
    "<!-- OMO_INTERNAL_INITIATOR -->",
    "[SYSTEM DIRECTIVE: MAGIC-CONTEXT",
    "[SYSTEM DIRECTIVE: OH-MY-OPENCODE",
    "[Category+Skill Reminder]",
    "[EDIT ERROR - IMMEDIATE ACTION REQUIRED]",
    "[task CALL FAILED - IMMEDIATE RETRY REQUIRED]",
    "[EMERGENCY CONTEXT WINDOW WARNING]",
    "Unstable background agent appears idle",
    "**THE SUBAGENT JUST CLAIMED THIS TASK IS DONE.",
];

fn system_reminder() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?is)<system-reminder>.*?</system-reminder>").unwrap())
}

/// OpenCode up to 1.17.8 wrapped a message the user sent while the agent was
/// still running in this exact reminder (1.17.9 removed the wrapper). Its body
/// is the user's own words, so it is never an injection: stripping it would
/// drop the user's instruction for good. The trailer anchors the match, so a
/// reminder the user's text itself quotes stays inside the kept block.
fn steering_wrapper() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?s)<system-reminder>\nThe user sent the following message:\n.*?\n\nPlease address this message and continue with your tasks\.\n</system-reminder>",
        )
        .unwrap()
    })
}

/// `text` without its injected regions, trimmed, or `None` when it holds
/// none. An empty result means the message held nothing else. Each steering
/// wrapper is kept as it is; only the text around it is stripped.
pub fn strip(text: &str) -> Option<String> {
    let wrappers: Vec<regex::Match<'_>> = steering_wrapper().find_iter(text).collect();
    if wrappers.is_empty() {
        return strip_regions(text);
    }
    let mut result = String::with_capacity(text.len());
    let mut changed = false;
    let mut keep_or_strip = |segment: &str, result: &mut String| match strip_regions(segment) {
        Some(stripped) => {
            result.push_str(&stripped);
            changed = true;
        }
        None => result.push_str(segment),
    };
    let mut cursor = 0;
    for wrapper in wrappers {
        keep_or_strip(&text[cursor..wrapper.start()], &mut result);
        result.push_str(wrapper.as_str());
        cursor = wrapper.end();
    }
    keep_or_strip(&text[cursor..], &mut result);
    changed.then(|| result.trim().to_owned())
}

fn strip_regions(text: &str) -> Option<String> {
    let injected =
        MARKERS.iter().any(|marker| text.contains(marker)) || system_reminder().is_match(text);
    if !injected {
        return None;
    }
    let mut cleaned = system_reminder().replace_all(text, "").into_owned();
    cleaned = cleaned.replace("<!-- OMO_INTERNAL_INITIATOR -->", "");
    // An oh-my directive runs from its bracket to the first blank line that
    // does not continue a list.
    let mut from = 0;
    while let Some(start) = next_directive(&cleaned, from) {
        let Some(close) = cleaned[start..].find(']') else {
            from = start + 1;
            continue;
        };
        let end = directive_end(&cleaned, start + close + 1);
        cleaned.replace_range(start..end, "");
        from = start;
    }
    // Every other marker starts a block that runs to the next blank line.
    for marker in MARKERS {
        if marker.starts_with("<!-- ") || marker.starts_with("[SYSTEM DIRECTIVE") {
            continue;
        }
        let Some(start) = cleaned.find(marker) else {
            continue;
        };
        let end = cleaned[start + marker.len()..]
            .find("\n\n")
            .map_or(cleaned.len(), |offset| start + marker.len() + offset);
        cleaned.replace_range(start..end, "");
    }
    Some(cleaned.trim().to_owned())
}

fn next_directive(text: &str, from: usize) -> Option<usize> {
    [
        "[SYSTEM DIRECTIVE: OH-MY-OPENCODE",
        "[SYSTEM DIRECTIVE: OH-MY-CLAUDE",
    ]
    .iter()
    .filter_map(|marker| text[from..].find(marker).map(|offset| from + offset))
    .min()
}

fn directive_end(text: &str, body_start: usize) -> usize {
    let mut from = body_start;
    while let Some(offset) = text[from..].find("\n\n") {
        let boundary = from + offset;
        let next = text[boundary + 2..].trim_start().chars().next();
        if !matches!(next, Some('-' | '*')) {
            return boundary;
        }
        from = boundary + 2;
    }
    text.len()
}

/// What stripping does to a numbered text part.
#[derive(Debug, PartialEq, Eq)]
pub enum Stripped {
    /// Nothing but injected text: the part becomes its drop placeholder.
    Empty,
    /// The part's final text, its tag prefix included, as the plugin leaves
    /// it.
    Text(String),
}

/// Strip a numbered text part. The plugin strips the text as the model sees
/// it, prefix included, so the result keeps the prefix with the plugin's
/// exact spacing; a `replace` value is final, so the prefix has to be in it.
/// `None` when the part holds no injected text.
pub fn strip_part(tag: u64, text: &str) -> Option<Stripped> {
    let prefix = format!("§{tag}§");
    let stripped = strip(&format!("{prefix} {text}"))?;
    let rest = stripped.strip_prefix(&prefix).unwrap_or(&stripped);
    Some(if rest.trim().is_empty() {
        Stripped::Empty
    } else {
        Stripped::Text(stripped)
    })
}

/// A text part's text without its injected regions and without its prefix,
/// as the plugin stores it after stripping (`replaceSourceContent` with
/// `stripTagPrefix`): what later compression starts from. `None` when the part
/// holds no injected text.
pub fn stripped_source(tag: u64, text: &str) -> Option<String> {
    let prefix = format!("§{tag}§");
    let stripped = strip(&format!("{prefix} {text}"))?;
    Some(
        stripped
            .strip_prefix(&prefix)
            .unwrap_or(&stripped)
            .trim_start()
            .to_owned(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wrapped(text: &str) -> String {
        [
            "<system-reminder>",
            "The user sent the following message:",
            text,
            "",
            "Please address this message and continue with your tasks.",
            "</system-reminder>",
        ]
        .join("\n")
    }

    // The cases of the plugin's `steering-wrapper-strip.test.ts`.
    #[test]
    fn the_steering_wrapper_is_the_users_own_message_and_stays() {
        assert_eq!(strip(&format!("§3§ {}", wrapped("use staging"))), None);
        let quoted = wrapped("quote: <system-reminder>x</system-reminder> then go");
        assert_eq!(strip(&quoted), None);
        let both = format!(
            "{}\n\n<system-reminder>\nPlan mode is active.\n</system-reminder>",
            wrapped("use staging")
        );
        assert_eq!(strip(&both), Some(wrapped("use staging")));
    }

    #[test]
    fn a_lone_reminder_strips_to_nothing_and_plain_text_is_left_alone() {
        assert_eq!(
            strip("<system-reminder>internal</system-reminder>"),
            Some(String::new())
        );
        assert_eq!(strip("plain user text"), None);
    }

    #[test]
    fn directives_and_marker_blocks_run_to_the_next_blank_line() {
        let text = "Do the thing.\n\n[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO]\nKeep going\n- item\n\n- still the list\n\nAfter.";
        assert_eq!(strip(text).as_deref(), Some("Do the thing.\n\n\n\nAfter."));
        let marker = "Fix it.\n\n[Category+Skill Reminder]\nuse the skill\n\nThanks.";
        assert_eq!(strip(marker).as_deref(), Some("Fix it.\n\n\n\nThanks."));
    }

    #[test]
    fn a_part_keeps_its_prefix_with_the_plugins_spacing() {
        assert_eq!(
            strip_part(5, "<system-reminder>x</system-reminder>"),
            Some(Stripped::Empty)
        );
        assert_eq!(
            strip_part(5, "hello\n<system-reminder>x</system-reminder>"),
            Some(Stripped::Text("§5§ hello".into()))
        );
        // Leading space before the kept text stays, as in the plugin, which
        // trims the whole prefixed text.
        assert_eq!(
            strip_part(5, "<system-reminder>x</system-reminder>  hello"),
            Some(Stripped::Text("§5§   hello".into()))
        );
        assert_eq!(strip_part(5, "nothing injected"), None);
    }
}
