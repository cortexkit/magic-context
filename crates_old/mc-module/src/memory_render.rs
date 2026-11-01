//! The `<project-memory>` baseline block and the `<memory-updates>` corrections block.
//!
//! Faithful port of the memory render in `inject-compartments.ts`
//! (`renderMemoryLineV2` / `renderMemoryBlockV2` / `renderMemoryUpdatesBlock`). Pure
//! over the stored rows:
//!  - the baseline block groups memories by category and renders compact `#id: fact`
//!    lines; the TypeScript trim measures the complete grouped block so category-tag
//!    overhead matches the bytes it actually injects.
//!  - the corrections block renders the coalesced mutation set as a forward delta the
//!    model trusts over the (stale-but-cached) baseline: `<updated>` for a content
//!    change, `<superseded by=>` when the replacement is itself in the baseline else
//!    `<removed>`, `<removed>` for an archive/delete.
//!
//! Routing + timing (which memories are in the baseline, when the corrections fold in)
//! is the slice-4d integration decision, already ruled; the byte render here is pure.

use crate::decay_render::{render_decayed_compartments, DecayRenderCompartment};
use mc_store::{
    StoredMemory, StoredMemoryMutation, WorkspaceMembership, MEMORY_VISIBILITY_MUTATION_CATEGORY,
};
use std::cmp::Ordering;
use std::collections::HashSet;

/// The body for an empty session history. The `<session-history>` tag is always present
/// (never omitted) so the provider prompt-cache has a stable breakpoint to anchor on —
/// an absent block would shift the bytes after it and bust the cache.
pub const M0_EMPTY_BODY: &str = "<session-history></session-history>";
/// The non-empty placeholder emitted for the m1 delta block when it has no new content.
/// The m1 block is never fully empty because the provider prompt-cache needs a stable
/// breakpoint to anchor on, so even an empty update still emits this marker.
pub const M1_PLACEHOLDER: &str =
    "<session-history-since>(no new content since last materialization)</session-history-since>";
/// Default history budget when a caller doesn't supply one.
pub const DEFAULT_HISTORY_BUDGET_TOKENS: f64 = 60_000.0;

fn escape_xml_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn escape_xml_content(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn render_user_profile_content(content: &str) -> String {
    let Some(remainder) = content.strip_prefix("User ") else {
        return content.to_string();
    };
    let mut characters = remainder.chars();
    let Some(first) = characters.next() else {
        return String::new();
    };
    first.to_uppercase().chain(characters).collect()
}

/// The five canonical V2 memory categories, in render order. This is the single
/// source of truth for the accepted write categories (see crate::MEMORY_CATEGORIES).
pub(crate) const MEMORY_CATEGORY_ORDER: [&str; 5] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
];

fn memory_render_order(left: &StoredMemory, right: &StoredMemory) -> Ordering {
    let left_priority = MEMORY_CATEGORY_ORDER
        .iter()
        .position(|category| *category == left.category);
    let right_priority = MEMORY_CATEGORY_ORDER
        .iter()
        .position(|category| *category == right.category);
    match (left_priority, right_priority) {
        (Some(left_rank), Some(right_rank)) => left_rank
            .cmp(&right_rank)
            .then_with(|| left.id.cmp(&right.id)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => left
            .category
            .cmp(&right.category)
            .then_with(|| left.id.cmp(&right.id)),
    }
}

/// Render one compact memory fact line. Importance still controls selection, but is
/// deliberately absent from the wire so classification-only updates do not change bytes.
pub fn render_memory_line(memory: &StoredMemory, source_name: Option<&str>) -> String {
    let source = source_name
        .filter(|name| !name.is_empty())
        .map(|name| format!(" [{}]", escape_xml_content(name)))
        .unwrap_or_default();
    let mut end = memory.content.len().min(64 * 1024);
    while !memory.content.is_char_boundary(end) {
        end -= 1;
    }
    let content = escape_xml_content(&memory.content[..end]).replace('\n', "\n  ");
    if memory.id > 0 {
        format!("#{}{source}: {content}", memory.id)
    } else {
        format!("-{source}: {content}")
    }
}

/// Render the `<project-memory>` (or workspace-`wrapper`) block from an already-selected
/// memory set. Categories are canonical-first, then non-taxonomy categories alphabetically;
/// `source_name_by_id` supplies per-memory repo attribution for a workspace union.
pub fn workspace_source_names(
    memories: &[StoredMemory],
    membership: &WorkspaceMembership,
) -> std::collections::HashMap<i64, String> {
    memories
        .iter()
        .filter(|memory| memory.project_path != membership.own_identity)
        .filter_map(|memory| {
            membership
                .display_name_by_path
                .get(&memory.project_path)
                .filter(|name| !name.is_empty())
                .map(|name| (memory.id, name.clone()))
        })
        .collect()
}

pub fn render_memory_block(
    memories: &[StoredMemory],
    wrapper: &str,
    source_name_by_id: &std::collections::HashMap<i64, String>,
) -> String {
    if memories.is_empty() {
        return String::new();
    }
    let mut ordered: Vec<&StoredMemory> = memories.iter().collect();
    ordered.sort_by(|left, right| memory_render_order(left, right));

    let mut lines = Vec::with_capacity(memories.len() * 2 + 3);
    lines.push(format!("<{wrapper}>"));
    let mut open_category: Option<&str> = None;
    for memory in ordered {
        if open_category != Some(memory.category.as_str()) {
            if let Some(category) = open_category {
                lines.push(format!("</{}>", escape_xml_attr(category)));
            }
            open_category = Some(&memory.category);
            lines.push(format!("<{}>", escape_xml_attr(&memory.category)));
        }
        lines.push(render_memory_line(
            memory,
            source_name_by_id.get(&memory.id).map(String::as_str),
        ));
    }
    if let Some(category) = open_category {
        lines.push(format!("</{}>", escape_xml_attr(category)));
    }
    lines.push(format!("</{wrapper}>"));
    lines.join("\n")
}

/// Render the `<user-profile>` baseline block: one `- <content>` line per user memory
/// (already budget-trimmed by the caller). Empty set → empty string.
pub fn render_user_profile_block(profile_lines: &[String], wrapper: &str) -> String {
    if profile_lines.is_empty() {
        return String::new();
    }
    let mut lines = Vec::with_capacity(profile_lines.len() + 2);
    lines.push(format!("<{wrapper}>"));
    for content in profile_lines {
        lines.push(format!(
            "- {}",
            escape_xml_content(&render_user_profile_content(content))
        ));
    }
    lines.push(format!("</{wrapper}>"));
    lines.join("\n")
}

/// Render covered system-role messages as m0 text. The caller supplies content that has
/// already been deduplicated in first-ordinal order; this function deliberately does not
/// escape it so the prompt bytes inside each entry remain the original system content.
pub fn render_covered_system_messages_block(messages: &[String]) -> String {
    if messages.is_empty() {
        return String::new();
    }
    let mut block = String::from("<covered-system-messages>");
    for content in messages {
        block.push_str("\n<covered-system-message>");
        block.push_str(content);
        block.push_str("</covered-system-message>");
    }
    block.push_str("\n</covered-system-messages>");
    block
}

/// Inputs to [`render_m0`] after the caller has already chosen and token-budget-trimmed
/// each sub-block. This renderer only assembles those blocks in order with framing; it
/// does not decide which rows or history compartments fit the budget.
pub struct M0Inputs<'a> {
    /// The pre-rendered `<project-docs>` block (empty string when absent).
    pub project_docs: &'a str,
    /// User-profile memory contents (trimmed); rendered as `- <content>` lines.
    pub user_profile: &'a [String],
    /// System-role prompt fragments whose ordinals are already covered by m0, deduplicated
    /// and ordered by their first appearance before being passed in by the caller.
    pub covered_system_messages: &'a [String],
    /// The compartment history (trimmed/ordered chronological), decay-rendered here.
    pub compartments: &'a [DecayRenderCompartment],
    /// The project memories (selected + ordered + trimmed) for the `<project-memory>` block.
    pub memories: &'a [StoredMemory],
    /// Map from memory id to its source project name, for memories that come from OTHER
    /// projects sharing a workspace with this one (empty when every memory is the
    /// current project's own).
    pub source_name_by_id: &'a std::collections::HashMap<i64, String>,
    /// The history budget in tokens (before the pressure multiplier).
    pub history_budget_tokens: f64,
    /// The drift-pressure multiplier (≥1): a tighter effective budget → more decay
    /// demotion. Maps to `effective_budget = budget / max(1, multiplier)`, keeping the
    /// decay curve the single source of pressure math.
    pub decay_pressure_multiplier: f64,
}

/// Compose the m0 baseline: `<project-docs>` + `<user-profile>` +
/// `<covered-system-messages>` + `<session-history>` + `<project-memory>`, joined by
/// blank lines and trimmed. The session-history block is always present (empty history
/// uses the `M0_EMPTY_BODY` placeholder — see its doc for why); the other blocks are
/// omitted when empty. `estimate_tokens` is used inside the decay renderer for its
/// budget-fit check (injected; under a loose budget the render is pure and
/// estimator-independent). This function only composes; sub-block budget trims happen in
/// the caller (they need the token estimator, a separate subsystem).
pub fn render_m0(inputs: &M0Inputs, estimate_tokens: impl Fn(&str) -> usize) -> String {
    let effective_budget = inputs.history_budget_tokens / inputs.decay_pressure_multiplier.max(1.0);
    let history =
        render_decayed_compartments(inputs.compartments, effective_budget, estimate_tokens);
    render_m0_with_history(inputs, &history)
}

pub(crate) fn render_m0_with_history(inputs: &M0Inputs, session_history: &str) -> String {
    let mut sections: Vec<String> = Vec::new();
    if !inputs.project_docs.is_empty() {
        sections.push(inputs.project_docs.to_string());
    }
    let user_profile = render_user_profile_block(inputs.user_profile, "user-profile");
    if !user_profile.is_empty() {
        sections.push(user_profile);
    }
    let covered_systems = render_covered_system_messages_block(inputs.covered_system_messages);
    if !covered_systems.is_empty() {
        sections.push(covered_systems);
    }

    sections.push(if session_history.is_empty() {
        M0_EMPTY_BODY.to_string()
    } else {
        format!("<session-history>\n{session_history}\n</session-history>")
    });

    let memories_block =
        render_memory_block(inputs.memories, "project-memory", inputs.source_name_by_id);
    if !memories_block.is_empty() {
        sections.push(memories_block);
    }
    sections.join("\n\n").trim().to_string()
}

/// Assemble the m1 delta body from its (already-rendered) sub-blocks, in order:
/// `<memory-updates>` → `<new-compartments>` → `<new-memories>` → `<new-user-profile>`,
/// joining the non-empty pieces with newlines and wrapping them in
/// `<session-history-since>`. Each piece is an empty string when absent (no rows / no
/// change). When ALL are empty, returns the `placeholder` instead — m1 is the volatile
/// half of the cached prefix and must never be fully empty, because the provider cache
/// anchors a breakpoint at the m1 block and an empty block would shift it.
pub fn assemble_m1(
    memory_updates: &str,
    new_compartments: &str,
    new_memories: &str,
    new_user_profile: &str,
    placeholder: &str,
) -> String {
    let mut blocks: Vec<&str> = Vec::with_capacity(4);
    for piece in [
        memory_updates,
        new_compartments,
        new_memories,
        new_user_profile,
    ] {
        if !piece.is_empty() {
            blocks.push(piece);
        }
    }
    if blocks.is_empty() {
        return placeholder.to_string();
    }
    format!(
        "<session-history-since>\n{}\n</session-history-since>",
        blocks.join("\n")
    )
}

/// Render the `<new-compartments>` block: each new compartment at full-fidelity P1 (no
/// decay applies to a newly-added compartment until it folds into the baseline), joined
/// by a blank line. An empty slice returns an empty string so the caller can omit the
/// block.
/// Render the `<new-compartments>` block: each unfolded compartment at a FIXED tier (1),
/// with NO clock/age/pressure input, so the bytes are a pure function of the compartment
/// ROW fields. This row-purity is load-bearing for the m1 digest: `m1_revision_signal`
/// uses `max_compartment_seq` as the complete m1-SOFT leg for compartments BECAUSE the
/// only way these bytes change without a new sequence (a row mutation) routes to a HARD.
/// If you add a time/age/pressure-varying input here, that completeness breaks — re-read
/// the COMPLETENESS INVARIANT on `m1_revision_signal` before doing so.
pub fn render_new_compartments(
    compartments: &[&crate::decay_render::DecayRenderCompartment],
) -> String {
    if compartments.is_empty() {
        return String::new();
    }
    let bodies: Vec<String> = compartments
        .iter()
        .map(|c| crate::decay_render::render_compartment_at_tier(c, 1))
        .filter(|body| !body.is_empty())
        .collect();
    if bodies.is_empty() {
        return String::new();
    }
    format!(
        "<new-compartments>\n{}\n</new-compartments>",
        bodies.join("\n\n")
    )
}

/// Render the `<memory-updates>` corrections block from the coalesced mutation set.
/// `resolvable_ids` contains memories visible in either the m0 baseline or this same m1
/// delta. A supersede preserves its lineage whenever the replacement is present in one of
/// those layers; otherwise it degrades to a removal. Empty mutation set → empty string.
pub fn render_memory_updates(
    mutations: &[StoredMemoryMutation],
    resolvable_ids: &HashSet<i64>,
) -> String {
    if mutations.is_empty() {
        return String::new();
    }
    let mut lines =
        vec!["These memories changed since the snapshot below — trust these:".to_string()];
    for m in mutations {
        match m.mutation_type.as_str() {
            "update" => {
                let category_attr = match &m.category {
                    Some(category)
                        if category != MEMORY_VISIBILITY_MUTATION_CATEGORY
                            && !category.is_empty() =>
                    {
                        format!(" category=\"{}\"", escape_xml_attr(category))
                    }
                    _ => String::new(),
                };
                lines.push(format!(
                    "  <updated id=\"{}\"{}>{}</updated>",
                    m.target_memory_id,
                    category_attr,
                    escape_xml_content(m.new_content.as_deref().unwrap_or(""))
                ));
            }
            "superseded" => match m.superseded_by_id {
                Some(by) if resolvable_ids.contains(&by) => lines.push(format!(
                    "  <superseded id=\"{}\" by=\"{by}\"/>",
                    m.target_memory_id
                )),
                _ => lines.push(format!("  <removed id=\"{}\"/>", m.target_memory_id)),
            },
            // archive / delete (and any non-update, non-resolvable-superseded)
            _ => lines.push(format!("  <removed id=\"{}\"/>", m.target_memory_id)),
        }
    }
    format!("<memory-updates>\n{}\n</memory-updates>", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    fn mem(id: i64, category: &str, content: &str, importance: Option<i32>) -> StoredMemory {
        StoredMemory {
            id,
            category: category.to_string(),
            content: content.to_string(),
            importance,
            status: "active".to_string(),
            ..Default::default()
        }
    }
    fn mutation(
        id: i64,
        kind: &str,
        target: i64,
        content: &str,
        by: Option<i64>,
    ) -> StoredMemoryMutation {
        StoredMemoryMutation {
            id,
            mutation_type: kind.to_string(),
            target_memory_id: target,
            superseded_by_id: by,
            new_content: Some(content.to_string()),
            ..Default::default()
        }
    }

    /// CONSUMER CONTRACT (Thalamus marker planner, ck_map.rs last_cacheable_ck_block):
    /// the m0 message must ALWAYS carry at least one non-empty text block. Their
    /// cache-marker placement skips Media/Reasoning/Opaque blocks and EMPTY text
    /// blocks; an m0 whose text came out empty (or media-only, once the mural image
    /// part ships) would silently lose its cache breakpoint — no error, just a dead
    /// prefix cache on the CC leg. render_m0 guarantees this structurally via the
    /// unconditional session-history section (M0_EMPTY_BODY when no compartments),
    /// so even the emptiest possible inputs produce non-empty bytes. This test pins
    /// that floor; if someone makes the session-history section conditional, this
    /// fails before the marker planner goes quiet in production.
    #[test]
    fn render_m0_never_empty_even_with_all_inputs_empty() {
        let rendered = render_m0(
            &M0Inputs {
                project_docs: "",
                user_profile: &[],
                covered_system_messages: &[],
                compartments: &[],
                memories: &[],
                source_name_by_id: &Default::default(),
                history_budget_tokens: 0.0,
                decay_pressure_multiplier: 1.0,
            },
            |_| 0,
        );
        assert!(
            !rendered.trim().is_empty(),
            "m0 must never render empty: the marker planner needs a non-empty text block"
        );
        assert_eq!(rendered, M0_EMPTY_BODY);
    }

    #[test]
    fn workspace_sources_attribute_only_foreign_memories() {
        let mut own = mem(1, "ARCHITECTURE", "own", Some(80));
        own.project_path = "shadow:owner".to_string();
        let mut foreign = mem(2, "CONSTRAINTS", "foreign", Some(70));
        foreign.project_path = "shadow:foreign".to_string();
        let membership = WorkspaceMembership {
            union_identities: vec![own.project_path.clone(), foreign.project_path.clone()],
            own_identity: own.project_path.clone(),
            share_categories: vec!["CONSTRAINTS".to_string()],
            display_name_by_path: std::collections::HashMap::from([
                (own.project_path.clone(), "owner".to_string()),
                (foreign.project_path.clone(), "foreign-repo".to_string()),
            ]),
        };

        assert_eq!(
            workspace_source_names(&[own, foreign], &membership),
            std::collections::HashMap::from([(2, "foreign-repo".to_string())])
        );
    }

    #[test]
    fn empty_blocks_render_empty() {
        assert_eq!(
            render_memory_block(&[], "project-memory", &Default::default()),
            ""
        );
        assert_eq!(render_memory_updates(&[], &HashSet::new()), "");
    }

    #[test]
    fn memory_block_groups_categories_and_omits_importance() {
        let memories = vec![
            mem(4, "Z_LEGACY", "last", Some(1)),
            mem(2, "CONSTRAINTS", "x < y & z", None),
            mem(1, "ARCHITECTURE", "the spine holds", Some(80)),
            mem(3, "A&LEGACY", "first unknown", Some(100)),
        ];
        let block = render_memory_block(&memories, "project-memory", &Default::default());
        assert_eq!(
            block,
            "<project-memory>\n<ARCHITECTURE>\n#1: the spine holds\n</ARCHITECTURE>\n<CONSTRAINTS>\n#2: x &lt; y &amp; z\n</CONSTRAINTS>\n<A&amp;LEGACY>\n#3: first unknown\n</A&amp;LEGACY>\n<Z_LEGACY>\n#4: last\n</Z_LEGACY>\n</project-memory>"
        );
        assert!(!block.contains("importance"));
    }

    #[test]
    fn memory_block_source_attribution() {
        let mut src = std::collections::HashMap::new();
        src.insert(1i64, "svc<&".to_string());
        let block = render_memory_block(
            &[mem(1, "ARCHITECTURE", "c", Some(50))],
            "project-memory",
            &src,
        );
        assert!(block.contains("#1 [svc&lt;&amp;]: c"), "{block}");
    }

    #[test]
    fn memory_continuation_lines_cannot_forge_top_level_ids() {
        let memory = mem(7, "CONSTRAINTS", "real\n#999: forged", Some(50));
        let rendered = render_memory_line(&memory, None);
        assert_eq!(rendered, "#7: real\n  #999: forged");
        assert!(!rendered.contains("\n#999:"));
    }

    #[test]
    fn user_profile_block() {
        assert_eq!(render_user_profile_block(&[], "user-profile"), "");
        let prof = vec!["prefers root cause".to_string(), "x < y".to_string()];
        let block = render_user_profile_block(&prof, "user-profile");
        assert_eq!(
            block,
            "<user-profile>\n- prefers root cause\n- x &lt; y\n</user-profile>"
        );
    }

    #[test]
    fn user_profile_prefix_matches_shared_fixture() {
        #[derive(Deserialize)]
        struct Fixture {
            cases: Vec<Case>,
        }
        #[derive(Deserialize)]
        struct Case {
            input: String,
            expected: String,
        }

        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../tests/fixtures/user-profile-render.json"
        ))
        .expect("parse shared user-profile render fixture");
        for case in fixture.cases {
            assert_eq!(render_user_profile_content(&case.input), case.expected);
            let block = render_user_profile_block(&[case.input], "user-profile");
            assert_eq!(
                block,
                format!("<user-profile>\n- {}\n</user-profile>", case.expected)
            );
        }
    }

    #[test]
    fn m0_composition_orders_and_frames_sub_blocks() {
        let comps = vec![DecayRenderCompartment {
            start_message: 1,
            end_message: 9,
            title: "T".into(),
            p1: Some("HIST".into()),
            importance: Some(50),
            ..Default::default()
        }];
        let inputs = M0Inputs {
            project_docs: "<project-docs>\n<file name=\"A.md\">x</file>\n</project-docs>",
            user_profile: &["likes tests".to_string()],
            covered_system_messages: &[],
            compartments: &comps,
            memories: &[mem(1, "ARCHITECTURE", "m1", Some(80))],
            source_name_by_id: &Default::default(),
            history_budget_tokens: 60_000.0,
            decay_pressure_multiplier: 1.0,
        };
        let m0 = render_m0(&inputs, |_| 0);
        // order: project-docs, user-profile, session-history, project-memory
        let i_docs = m0.find("<project-docs>").unwrap();
        let i_prof = m0.find("<user-profile>").unwrap();
        let i_hist = m0.find("<session-history>").unwrap();
        let i_mem = m0.find("<project-memory>").unwrap();
        assert!(
            i_docs < i_prof && i_prof < i_hist && i_hist < i_mem,
            "sub-block order: {m0}"
        );
        assert!(m0.contains("## 1-9 · T\nHIST"), "history rendered: {m0}");
    }

    #[test]
    fn covered_system_block_omits_empty_and_preserves_content() {
        assert_eq!(render_covered_system_messages_block(&[]), "");
        let block = render_covered_system_messages_block(&[
            "raw <system> bytes".to_string(),
            "second\nline".to_string(),
        ]);
        assert_eq!(
            block,
            "<covered-system-messages>\n<covered-system-message>raw <system> bytes</covered-system-message>\n<covered-system-message>second\nline</covered-system-message>\n</covered-system-messages>"
        );
    }

    #[test]
    fn m0_empty_history_uses_placeholder_not_absent() {
        let inputs = M0Inputs {
            project_docs: "",
            user_profile: &[],
            covered_system_messages: &[],
            compartments: &[],
            memories: &[],
            source_name_by_id: &Default::default(),
            history_budget_tokens: 60_000.0,
            decay_pressure_multiplier: 1.0,
        };
        // no docs/profile/memory + no compartments → just the empty-history placeholder
        assert_eq!(render_m0(&inputs, |_| 0), M0_EMPTY_BODY);
    }

    #[test]
    fn m1_placeholder_matches_typescript_wire() {
        assert_eq!(
            M1_PLACEHOLDER,
            "<session-history-since>(no new content since last materialization)</session-history-since>"
        );
    }

    #[test]
    fn m1_assembly_order_and_placeholder() {
        // all empty → the placeholder (m1 never fully empty)
        assert_eq!(assemble_m1("", "", "", "", "(none)"), "(none)");

        // present blocks render in production order, joined by \n, wrapped
        let m1 = assemble_m1(
            "<memory-updates>U</memory-updates>",
            "<new-compartments>C</new-compartments>",
            "<new-memories>M</new-memories>",
            "<new-user-profile>P</new-user-profile>",
            "(none)",
        );
        assert_eq!(
            m1,
            "<session-history-since>\n<memory-updates>U</memory-updates>\n<new-compartments>C</new-compartments>\n<new-memories>M</new-memories>\n<new-user-profile>P</new-user-profile>\n</session-history-since>"
        );

        // a subset (memory-updates + new-memories) skips the empty ones, keeps order
        let partial = assemble_m1("UPD", "", "MEM", "", "(none)");
        assert_eq!(
            partial,
            "<session-history-since>\nUPD\nMEM\n</session-history-since>"
        );
    }

    #[test]
    fn new_compartments_render_at_p1() {
        use crate::decay_render::DecayRenderCompartment;
        assert_eq!(render_new_compartments(&[]), "");
        let c = DecayRenderCompartment {
            start_message: 1,
            end_message: 9,
            title: "New".into(),
            p1: Some("FULL P1".into()),
            p2: Some("dense".into()),
            importance: Some(50),
            ..Default::default()
        };
        let block = render_new_compartments(&[&c]);
        assert!(block.starts_with("<new-compartments>\n"));
        assert!(block.ends_with("\n</new-compartments>"));
        // P1 (full), never a decayed tier, for a brand-new compartment
        assert!(block.contains("## 1-9 · New\nFULL P1"), "{block}");
    }

    #[test]
    fn memory_updates_three_branches() {
        let resolvable: HashSet<i64> = [1, 2, 9].into_iter().collect();
        let muts = vec![
            mutation(10, "update", 1, "new content", None),
            mutation(11, "superseded", 2, "", Some(9)), // 9 in baseline → <superseded by>
            mutation(12, "superseded", 3, "", Some(99)), // 99 NOT in baseline → <removed>
            mutation(13, "archive", 4, "", None),
        ];
        let block = render_memory_updates(&muts, &resolvable);
        assert!(block.starts_with("<memory-updates>\nThese memories changed"));
        assert!(block.contains("<updated id=\"1\">new content</updated>"));
        assert!(block.contains("<superseded id=\"2\" by=\"9\"/>"));
        assert!(
            block.contains("<removed id=\"3\"/>"),
            "unresolvable supersede → removed: {block}"
        );
        assert!(
            block.contains("<removed id=\"4\"/>"),
            "archive → removed: {block}"
        );
    }

    // --- differential golden vs the TS reference render ---

    #[derive(Deserialize)]
    struct RawMem {
        id: i64,
        category: String,
        content: String,
        importance: Option<i32>,
        #[serde(default)]
        source_name: Option<String>,
    }
    #[derive(Deserialize)]
    struct RawMut {
        id: i64,
        #[serde(rename = "type")]
        mutation_type: String,
        target: i64,
        #[serde(default)]
        content: String,
        by: Option<i64>,
    }
    #[derive(Deserialize)]
    struct MemCase {
        memories: Vec<RawMem>,
        block: String,
    }
    #[derive(Deserialize)]
    struct UpdCase {
        mutations: Vec<RawMut>,
        rendered_ids: Vec<i64>,
        block: String,
    }
    #[derive(Deserialize)]
    struct MemGolden {
        memory_block_cases: Vec<MemCase>,
        memory_updates_cases: Vec<UpdCase>,
    }

    #[test]
    fn memory_render_golden_matches_reference() {
        let raw = include_str!("../testdata/memory-render-golden.json");
        let golden: MemGolden = serde_json::from_str(raw).expect("parse memory-render-golden.json");
        assert!(!golden.memory_block_cases.is_empty());

        for (n, c) in golden.memory_block_cases.iter().enumerate() {
            let memories: Vec<StoredMemory> = c
                .memories
                .iter()
                .map(|r| mem(r.id, &r.category, &r.content, r.importance))
                .collect();
            let sources = c
                .memories
                .iter()
                .filter_map(|memory| {
                    memory
                        .source_name
                        .as_ref()
                        .map(|source| (memory.id, source.clone()))
                })
                .collect();
            let got = render_memory_block(&memories, "project-memory", &sources);
            assert_eq!(got, c.block, "memory block mismatch case {n}");
        }
        for (n, c) in golden.memory_updates_cases.iter().enumerate() {
            let muts: Vec<StoredMemoryMutation> = c
                .mutations
                .iter()
                .map(|r| mutation(r.id, &r.mutation_type, r.target, &r.content, r.by))
                .collect();
            let rendered: HashSet<i64> = c.rendered_ids.iter().copied().collect();
            let got = render_memory_updates(&muts, &rendered);
            assert_eq!(got, c.block, "memory updates mismatch case {n}");
        }
    }
}
