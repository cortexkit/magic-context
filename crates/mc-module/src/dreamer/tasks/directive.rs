//! Workflow directives describe how to act, not facts the code decides.

use std::sync::OnceLock;

use regex::RegexSet;

use super::verify::manifest::js_trim;

/// The plugin's project-rule patterns use JavaScript whitespace, ASCII
/// word boundaries, and ASCII digits. Mapping and verification must agree:
/// files named in a directive are subjects to act on, not backing code.
pub(super) fn directive_shaped_rule(category: &str, content: &str) -> bool {
    if category != "swe:project-rules" {
        return false;
    }
    static PATTERNS: OnceLock<RegexSet> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            RegexSet::new([
                r"(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:you\s+|we\s+)?(?:must(?:\s+not)?|never|always|do\s+not|don't|shall\s+not)\b",
                r"\b(?:you|we|agents?|masons?|workers?|operators?|users?|maintainers?)\s+(?:must(?:\s+not)?|should(?:\s+not)?|need\s+to|shall(?:\s+not)?|cannot|can't|may\s+not)\b",
                r"\bwhen\s+(?:you(?:'re|\s+are)?|we(?:'re|\s+are)?|told|asked|requested|working|debugging|reviewing|checking|verifying|investigating|using|running|editing|changing)\b",
                r"(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:please\s+)?(?:run|use|check|ask|avoid|prefer|ensure|keep|follow|brief|report|inspect|search|open|read|review|validate|confirm|delegate|stop|start|remember)\b",
                r"\b(?:the\s+)?(?:user|operator|maintainer|owner)\s+(?:decides|chooses|approves|has\s+(?:the\s+)?final\s+say)\b",
            ].map(|pattern| {
                format!("(?i){pattern}")
                    .replace("\\b", r"(?-u:\b)")
                    .replace("\\d", "[0-9]")
                    .replace(
                        "\\s",
                        r"[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]",
                    )
            }))
            .expect("the fixed directive patterns compile")
        })
        .is_match(js_trim(content))
}
