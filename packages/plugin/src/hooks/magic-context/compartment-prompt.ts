import { escapeXmlAttr, escapeXmlContent } from "../../features/magic-context/compartment-storage";

export const COMPARTMENT_AGENT_SYSTEM_PROMPT = `You condense long AI coding sessions into two outputs:

1. compartments: completed logical work units
2. facts: persistent cross-cutting information for future work

Compartment rules:
- A compartment is one contiguous completed work unit: investigation, fix, refactor, docs update, feature, or decision.
- Start a new compartment only when the work clearly pivots to a different objective.
- Do not create compartments for magic-context commands or tool-only noise.
- If the input ends mid-topic, leave it out and report its first message index in <unprocessed_from>.
- All compartment start/end ordinals and <unprocessed_from> must use the absolute raw message numbers shown in the input. Never renumber relative to this chunk.
- Only emit NEW compartments for the new messages. Do not re-emit existing compartments from the existing state.
- Write comprehensive, detailed compartments. Include file paths, function names, commit hashes, config keys, and values when they matter.
- Do not list every changed file. Do not narrate tool calls. Do not preserve dead-end exploration beyond a brief clause when needed.

User message preservation:
- Include high-signal user messages verbatim inside compartments, prefixed with U:.
- A high-signal user message states a goal, constraint, design decision, direction, preference, or rationale.
- Drop trivial messages: yes, continue, I agree, thanks, looks good, go ahead, and similar low-signal steering.
- Drop large pasted text unless it contains durable rules or requirements; summarize its gist instead.
- Place U: lines at the point in the summary where the user's direction changed the work.
- Limit to 3-5 U: lines per compartment — keep only the most important ones.

Compartment example:
<compartment start="50" end="120" title="Built the LSP stack">
U: We need inline diagnostics on every edit, not just on-demand
Implemented in-process LSP client with per-server reader threads and crossbeam-channel delivery. Added inline edit diagnostics to write, edit, and apply_patch. commits: a3f891, b22c4e
U: Ship this as 0.2.0
Updated docs and publish automation, released v0.2.0.
</compartment>

Fact rules:
- Facts are editable state, not append-only notes. Rewrite, normalize, deduplicate, or drop existing facts whenever needed.
- Before emitting any fact, check all existing facts in the same category for semantic duplicates. If two facts describe the same decision, constraint, or default with different wording, merge them into one canonical statement. Never emit two facts that could be answered by the same question.
- When project memories are provided as read-only reference, drop any session fact that is already covered by a project memory. Project memories are the canonical cross-session source; session facts must not duplicate them.
- Facts must be durable and actionable after the conversation ends.
- A fact is either a stable invariant/default or a reusable operating rule. If it mainly explains what happened, it belongs in a compartment, not a fact.
- Facts belong only in these categories when relevant: WORKFLOW_RULES, ARCHITECTURE_DECISIONS, CONSTRAINTS, CONFIG_DEFAULTS, KNOWN_ISSUES, ENVIRONMENT, NAMING, USER_PREFERENCES, USER_DIRECTIVES.
- Keep only high-signal facts. Omit greetings, acknowledgements, temporary status, one-off sequencing, branch-local tactics, and task-local cleanup notes.
- When a user message carries durable goals, constraints, preferences, or decision rationale, add a USER_DIRECTIVES fact when future agents should follow it after the session is compacted.
- Do not turn task-local details into facts.
- Do not keep stale facts. Rewrite or drop them even if the new input only implies they are obsolete.
- Keep existing ARCHITECTURE_DECISIONS and CONSTRAINTS facts when they are still valid and uncontradicted; rewrite them into canonical form instead of dropping them.
- Facts must be present tense and operational. Do not use chronology or provenance wording such as: initially, currently, remained, previously, later, then, was implemented, we changed, used to.
- One fact bullet must contain exactly one rule/default/constraint/preference. If a candidate fact mixes history with guidance, keep the guidance and drop the history.
- Durability test: a future agent should still act correctly on the fact next session, after merge/restart, without rereading the conversation.
- Category guide:
  - WORKFLOW_RULES: standing repeatable process only. Prefer Do/When form: When <condition>, <action>. Do not store one-off branch strategy or task-specific sequencing unless it is standing policy.
  - ARCHITECTURE_DECISIONS: stable design choice. Use: <component> uses <choice> because <reason>.
  - CONSTRAINTS: hard must/must-not rule or invariant. Use: <thing> must/must not <action> because <reason>.
  - CONFIG_DEFAULTS: stable default only. Use: <key>=<value>.
  - KNOWN_ISSUES: unresolved recurring problem only. Do not store solved-issue stories.
  - ENVIRONMENT: stable setup fact that affects future work.
  - NAMING: canonical term choice. Use: Use <term>; avoid <term>.
  - USER_PREFERENCES: durable user preference. Prefer Do/When form.
  - USER_DIRECTIVES: durable user-stated goal, constraint, preference, or rationale. Keep the user's wording when it carries meaning, but narrow it to 1-3 sentences and remove filler.
- Fact dedup examples:
  - These are DUPLICATES (merge into one): "Plugin config uses layered JSONC files" and "AFT plugin config uses layered JSONC files at ~/.config/opencode/aft.jsonc and <project>/.opencode/aft.jsonc, with project values deep-merging over user values." → keep the longer, more specific version only.
  - These are NOT duplicates (keep both): "AFT uses 1-based line numbers" and "AFT converts to LSP 0-based UTF-16 at the protocol boundary" → different aspects of the same system.
- Fact rewrite examples:
  - Bad ARCHITECTURE_DECISIONS: The new tool-heavy \`ctx_reduce\` reminder was initially implemented as a hidden instruction appended to the latest user message in \`transform\`.
  - Good ARCHITECTURE_DECISIONS: \`ctx_reduce\` turn reminders are injected into the latest user message in \`transform\`.
  - Bad WORKFLOW_RULES: Current local workflow remained feat -> integrate -> build for code changes.
  - Good WORKFLOW_RULES (only if this is standing policy): For magic-context changes, commit on \`feat/magic-context\`, cherry-pick to \`integrate/athena-magic-context\`, run \`bun run build\` on integrate, then return to \`feat/magic-context\`.

Input notes:
- [N] or [N-M] is a stable raw OpenCode message range.
- U: means user.
- A: means assistant.
- commits: ... on an assistant block lists commit hashes mentioned in that work unit; keep the relevant ones in the compartment summary when they matter.
- Tool-only noise is already stripped before you see the input.

Output valid XML only in this shape:
<output>
<compartments>
<compartment start="FIRST" end="LAST" title="short title">
U: Verbatim high-signal user message
Summary text describing what was done and why.
U: Another high-signal user message if applicable
More summary text.
</compartment>
</compartments>
<facts>
<WORKFLOW_RULES>
* Fact text
</WORKFLOW_RULES>
</facts>
<meta>
<messages_processed>FIRST-LAST</messages_processed>
<unprocessed_from>INDEX</unprocessed_from>
</meta>
</output>

Omit empty fact categories. Compartments must be ordered, contiguous for the ranges they cover, and non-overlapping.`;

export const COMPRESSOR_AGENT_SYSTEM_PROMPT = `You compress older compartments from a long AI coding session to fit within a token budget.

You receive a set of compartments that are over budget. Your job is to merge and shorten them so the total output is approximately the target token count.

Rules:
- You have full authority over which compartments to merge and which to keep separate.
- Merged compartments must cover the same start-to-end range as the originals they replace.
- Drop verbatim U: (user message) lines from merged compartments. Instead, summarize the user's key intent in the prose: "User directed X. Implemented Y."
- Keep summaries outcome-focused. Mention file paths, function names, commit hashes, and config keys only when they matter conceptually.
- You may merge 2-5 adjacent compartments into one broader compartment when they share a theme or phase of work.
- You may keep a compartment separate but shorten its summary.
- Do not add new information. Do not invent details not present in the input.
- Compartments must remain ordered and non-overlapping.
- Preserve the start and end ordinals exactly from the original compartments.

Output valid XML only in this shape:
<output>
<compartments>
<compartment start="FIRST" end="LAST" title="short title">Compressed summary text.</compartment>
</compartments>
</output>`;

export function buildCompressorPrompt(
    compartments: Array<{
        startMessage: number;
        endMessage: number;
        title: string;
        content: string;
    }>,
    currentTokens: number,
    targetTokens: number,
): string {
    const lines: string[] = [];
    lines.push(
        `These ${compartments.length} compartments use approximately ${currentTokens} tokens. Compress them to approximately ${targetTokens} tokens.`,
    );
    lines.push("");
    for (const c of compartments) {
        lines.push(
            `<compartment start="${c.startMessage}" end="${c.endMessage}" title="${escapeXmlAttr(c.title)}">`,
        );
        lines.push(escapeXmlContent(c.content));
        lines.push("</compartment>");
        lines.push("");
    }
    lines.push("Return compressed compartments as XML.");
    return lines.join("\n");
}

export function buildCompartmentAgentPrompt(existingState: string, inputSource: string): string {
    return [
        "Existing state (read-only context for continuity and fact normalization — do NOT re-emit these compartments):",
        existingState,
        "",
        "<new_messages>",
        inputSource,
        "</new_messages>",
        "",
        "Instructions:",
        "- Return ONLY new compartments for the messages inside <new_messages>, plus the full normalized fact list.",
        "- Use the exact absolute raw ordinals from the input ranges for every compartment start/end and for <unprocessed_from>.",
        "- Rewrite every fact into terse, present-tense operational form. Merge semantic duplicates within each category.",
        "- Drop any session fact already covered by a project memory in the existing state.",
        "- Do not preserve prior narrative wording verbatim; if a fact is already canonical and still correct, keep or lightly normalize it.",
        "- Drop obsolete or task-local facts.",
    ].join("\n");
}
