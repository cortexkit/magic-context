//! Protected regions of a project document: from the line holding
//! `mc:protected START` through the line holding `mc:protected END`. People
//! maintain them by hand, and the docs-upkeep task may change nothing in
//! them. Ported from the 0.49 plugin's `protected-regions.ts`.

const START: &str = "<!-- mc:protected START";
const END: &str = "<!-- mc:protected END -->";

/// One protected region: its whole start-marker line, and its bytes from
/// that line through the end-marker line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Block {
    pub start_line: String,
    pub block: String,
}

/// Every protected region of `text`, in order. A start marker with no end
/// marker after it opens no region.
pub(crate) fn blocks(text: &str) -> Vec<Block> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut found = Vec::new();
    let mut at = 0;
    while at < lines.len() {
        if lines[at]
            .trim()
            .strip_prefix(START)
            .is_some_and(|suffix| suffix.starts_with(char::is_whitespace) || suffix == "-->")
        {
            let start = at;
            // A start comment can describe the closing marker without ending the region.
            at += 1;
            while at < lines.len() && lines[at].trim() != END {
                at += 1;
            }
            if at >= lines.len() {
                break;
            }
            found.push(Block {
                start_line: lines[start].to_owned(),
                block: lines[start..=at].join("\n"),
            });
        }
        at += 1;
    }
    found
}

/// Whether `before` and `after` hold the same protected regions, byte for
/// byte and in the same order.
pub(crate) fn kept(before: &str, after: &str) -> bool {
    blocks(before) == blocks(after)
}

#[cfg(test)]
#[path = "protected_tests.rs"]
mod tests;
