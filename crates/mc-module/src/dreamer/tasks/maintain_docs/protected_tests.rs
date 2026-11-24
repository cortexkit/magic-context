//! The protected-region checks, ported from the 0.49 plugin's
//! `protected-regions.test.ts`: the module refuses a change where the plugin
//! repaired it, so each repaired case is a refused one here.

use super::*;

const START_LINE: &str =
    "<!-- mc:protected START — hand-authored cache-stability core. Only humans edit. -->";
const END_LINE: &str = "<!-- mc:protected END -->";

fn doc(before: &str, body: &str, after: &str) -> String {
    format!("{before}\n{START_LINE}\n{body}\n{END_LINE}\n{after}")
}

#[test]
fn a_text_without_markers_has_no_region() {
    assert!(blocks("# Hello\n\nWorld").is_empty());
}

#[test]
fn a_region_runs_from_its_start_line_through_its_end_line() {
    let text = doc("intro", "cache core", "outro");
    assert_eq!(
        blocks(&text),
        [Block {
            start_line: START_LINE.into(),
            block: format!("{START_LINE}\ncache core\n{END_LINE}"),
        }]
    );
}

#[test]
fn mentioning_the_end_marker_does_not_close_a_region() {
    let original = "<!-- mc:protected START — preserve through mc:protected END -->\nHand authored.\nThe mc:protected END marker follows.\nOriginal.\n<!-- mc:protected END -->";
    assert!(!kept(
        original,
        &original.replace("Hand authored.", "Overwritten.")
    ));
    assert!(!kept(
        original,
        &original.replace("Original.", "Overwritten.")
    ));
}

#[test]
fn edits_outside_an_untouched_region_keep_it() {
    let original = doc("intro", "cache core", "outro");
    assert!(kept(&original, &doc("intro", "cache core", "outro")));
    assert!(kept(&original, &doc("intro v2", "cache core", "outro v2")));
}

#[test]
fn a_changed_byte_inside_a_region_is_refused() {
    let original = doc("intro", "cache core", "outro");
    assert!(!kept(&original, &doc("intro v2", "cache CORE", "outro v2")));
    assert!(!kept(&original, &doc("intro", "cache core ", "outro")));
}

#[test]
fn removed_markers_are_refused() {
    let original = doc("intro", "cache core", "outro");
    assert!(!kept(&original, "intro v2\nno markers\noutro v2"));
}

#[test]
fn a_text_without_regions_takes_any_change_but_a_new_region() {
    let original = "# STRUCTURE\n\nNo protected blocks here.";
    assert!(kept(original, "# STRUCTURE\n\nUpdated tree."));
    assert!(!kept(original, &doc("# STRUCTURE", "new", "")));
}

#[test]
fn each_of_several_regions_is_checked() {
    let start_a = "<!-- mc:protected START block A -->";
    let start_b = "<!-- mc:protected START block B -->";
    let original = [
        "head", start_a, "body A", END_LINE, "mid", start_b, "body B", END_LINE, "tail",
    ]
    .join("\n");
    let tampered = [
        "head edited",
        start_a,
        "body A TAMPERED",
        END_LINE,
        "mid edited",
        start_b,
        "body B",
        END_LINE,
        "tail edited",
    ]
    .join("\n");
    assert!(!kept(&original, &tampered));
    let edited_outside = [
        "head edited",
        start_a,
        "body A",
        END_LINE,
        "mid edited",
        start_b,
        "body B",
        END_LINE,
        "tail edited",
    ]
    .join("\n");
    assert!(kept(&original, &edited_outside));
    let one_missing = [start_a, "body A", END_LINE, "mid", "tail"].join("\n");
    assert!(!kept(&original, &one_missing));
}

#[test]
fn a_start_without_an_end_opens_no_region() {
    assert!(blocks(&format!("intro\n{START_LINE}\nunterminated")).is_empty());
}
