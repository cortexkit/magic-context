use crate::ck_wire::FlatProjection;
use crate::selection::{SelItem, SelKind};
use std::collections::{HashMap, HashSet};

#[derive(Debug)]
pub(crate) struct DistanceEntry {
    pub tokens: usize,
    pub user_turn: bool,
    pub tool_output_ordinal: Option<u64>,
}

/// A free cache rebuild is not evidence that the model has moved on. An output
/// is far behind after three newer user turns OR a quarter-window of newer
/// content. Return the greatest qualifying tool-call ordinal, measured at its
/// last result. Callers select drops against the previous saved ordinal before
/// saving this boundary, so qualifying outputs survive their first rebuild.
pub(crate) fn far_behind_bookmark(entries: &[DistanceEntry], usable_window: f64) -> u64 {
    let token_distance = if usable_window.is_finite() && usable_window > 0.0 {
        usable_window * 0.25
    } else {
        f64::INFINITY
    };
    let mut newer_turns = 0;
    let mut newer_tokens = 0usize;
    let mut bookmark = 0;
    let mut seen_outputs = HashSet::new();
    for entry in entries.iter().rev() {
        if let Some(ordinal) = entry.tool_output_ordinal {
            // A multi-block output is positioned at its last result. Its own
            // remaining chunks cannot contribute to the newer-content distance.
            if seen_outputs.insert(ordinal)
                && (newer_turns >= 3 || newer_tokens as f64 >= token_distance)
            {
                bookmark = bookmark.max(ordinal);
            }
        }
        newer_turns += usize::from(entry.user_turn);
        newer_tokens = newer_tokens.saturating_add(entry.tokens);
    }
    bookmark
}

/// Only authored blocks count as user turns. Host control notices, Magic Context's
/// injected history/reduction/note reminders and tool-only user carriers do not.
pub(crate) fn tool_bookmark(
    projection: &FlatProjection,
    items: &[SelItem],
    usable_window: f64,
) -> u64 {
    let by_id: HashMap<_, _> = items.iter().map(|item| (item.id.as_str(), item)).collect();
    let call_ordinals: HashMap<_, _> = items
        .iter()
        .filter_map(|item| {
            matches!(item.kind, SelKind::ToolCall { .. })
                .then_some((item.id.as_str(), item.ordinal))
        })
        .collect();
    let mut user_messages = HashSet::new();
    let mut entries = Vec::new();
    for block in &projection.blocks {
        let item = by_id.get(block.id.as_str());
        if (block.synthetic && block.mid.starts_with("mc_"))
            || block
                .tool_call_id
                .as_deref()
                .is_some_and(crate::injection::is_synthetic_todo_id)
        {
            continue;
        }
        let text = block.scalar_text();
        let cleaned = text.as_deref().map(|text| {
            if block.runner_lane {
                text.to_owned()
            } else {
                strip_mc_text(text)
            }
        });
        let authored = matches!(block.kind_tag.as_str(), "text" | "media" | "opaque")
            && cleaned
                .as_deref()
                .is_none_or(|text| !text.trim().is_empty());
        let user_turn = block.role == "user"
            && !block.synthetic
            && authored
            && user_messages.insert(block.mid.as_str());
        let tokens = if let crate::ck_wire::CkKind::Media(media) = &block.wire_shape().kind {
            crate::image_tokens::media_image_tokens(media)
                .unwrap_or_else(|| mc_tokenizer::estimate_tokens(&block.bytes))
        } else if let (Some(original), Some(cleaned)) = (text.as_deref(), cleaned.as_deref()) {
            if cleaned != original {
                mc_tokenizer::estimate_tokens(cleaned)
            } else {
                item.and_then(|item| item.served_token_count).unwrap_or(0)
            }
        } else {
            item.and_then(|item| item.served_token_count)
                .unwrap_or_else(|| mc_tokenizer::estimate_tokens(&block.bytes))
        };
        let tool_output_ordinal = if block.kind_tag == "tool_result" && item.is_some() {
            block
                .arc_id
                .as_deref()
                .and_then(|id| call_ordinals.get(id))
                .copied()
        } else {
            None
        };
        entries.push(DistanceEntry {
            tokens,
            user_turn,
            tool_output_ordinal,
        });
    }
    far_behind_bookmark(&entries, usable_window)
}

fn strip_mc_text(text: &str) -> String {
    use regex::Regex;
    use std::sync::LazyLock;
    static REMINDERS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?s)<system-reminder>.*?</system-reminder>").unwrap());
    static NOTES: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?s)<instruction name="deferred_notes">.*?</instruction>"#).unwrap()
    });
    let text = REMINDERS.replace_all(text, |captures: &regex::Captures<'_>| {
        let reminder = &captures[0];
        let body = reminder
            .trim_start_matches("<system-reminder>")
            .trim_start();
        if body.starts_with("Your next step: call ctx_reduce on the outputs you've already used")
            || body.starts_with("Still unstamped:")
            || (body.starts_with("Housekeeping:")
                && body.contains(" are reclaimable. Stamp each output with ctx_reduce"))
            || body.contains(" are reclaimable. Make a ctx_reduce pass now")
            || body.contains(" are still unstamped. Call ctx_reduce now")
        {
            String::new()
        } else {
            reminder.to_string()
        }
    });
    NOTES.replace_all(&text, "").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(ordinal: u64, tokens: usize) -> DistanceEntry {
        DistanceEntry {
            tokens,
            user_turn: false,
            tool_output_ordinal: Some(ordinal),
        }
    }

    #[test]
    fn single_turn_loop_ages_at_exactly_one_quarter_window() {
        let mut entries = vec![output(1, 1000), output(2, 49_999)];
        assert_eq!(far_behind_bookmark(&entries, 200_000.0), 0);
        entries.push(DistanceEntry {
            tokens: 1,
            user_turn: false,
            tool_output_ordinal: None,
        });
        assert_eq!(far_behind_bookmark(&entries, 200_000.0), 1);
        assert_eq!(far_behind_bookmark(&[output(1, 100_000)], 200_000.0), 0);
    }

    #[test]
    fn three_turns_not_rebuild_count_establish_distance() {
        let mut entries = vec![output(1, 1000)];
        for _ in 0..2 {
            entries.push(DistanceEntry {
                tokens: 10,
                user_turn: true,
                tool_output_ordinal: None,
            });
        }
        for _ in 0..5 {
            assert_eq!(far_behind_bookmark(&entries, 200_000.0), 0);
        }
        entries.push(DistanceEntry {
            tokens: 10,
            user_turn: true,
            tool_output_ordinal: None,
        });
        assert_eq!(far_behind_bookmark(&entries, 200_000.0), 1);
    }

    #[test]
    fn output_cannot_age_from_its_own_trailing_chunks() {
        assert_eq!(
            far_behind_bookmark(&[output(1, 1000), output(1, 100_000)], 200_000.0),
            0
        );
    }

    #[test]
    fn mc_reminders_are_not_wake_notices() {
        assert_eq!(strip_mc_text("<system-reminder>Your next step: call ctx_reduce on the outputs you've already used.</system-reminder>"), "");
        let wake = "<system-reminder>Background task finished.</system-reminder>";
        assert_eq!(strip_mc_text(wake), wake);
    }
}
