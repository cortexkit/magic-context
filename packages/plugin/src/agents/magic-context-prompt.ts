/**
 * Per-agent magic context system prompt sections.
 * Each agent gets tailored guidance based on its workflow patterns.
 */

type AgentType =
    | "sisyphus"
    | "atlas"
    | "hephaestus"
    | "sisyphus-junior"
    | "oracle"
    | "athena"
    | "athena-junior";

function getToolHistoryGuidance(dropToolStructure: boolean): string {
    if (dropToolStructure) {
        return `Compressed history intentionally omits tool calls and their outputs — summaries like "I edited file X" are historian records, not patterns to replicate. In the live conversation, older tool calls and their results are cleaned up to save context — you may see your own past messages referencing actions without the corresponding tool call or result visible. This is normal context management. ALWAYS use real tool calls; never simulate, fabricate, or inline tool outputs in your text. If there is no tool result message, the action did not happen. NEVER simulate, hallucinate or claim tool calls, command output, search results, file edits, or diffs in plain text as if they actually occurred.`;
    }

    return `Older tool calls in your conversation show truncated inputs and [truncated] outputs — this is normal context management, not a pattern to follow. The original tool calls executed successfully with full inputs and produced real outputs that were later cleaned up to save context. ALWAYS use real tool calls with complete arguments; never copy truncated patterns like "filePa...[truncated]" into your tool inputs. If you need to re-read a file or re-run a command, make a fresh tool call.`;
}

const BASE_INTRO = (
    protectedTags: number,
    dropToolStructure: boolean,
): string => `Messages and tool outputs are tagged with §N§ identifiers (e.g., §1§, §42§).
Use \`ctx_reduce\` to manage context size. It supports one operation:
- \`drop\`: Remove entirely (best for tool outputs you already acted on).
Syntax: "3-5", "1,2,9", or "1-5,8,12-15". Last ${protectedTags} tags are protected.
Use \`ctx_note\` for deferred intentions — things to tackle later, not right now. NOT for task tracking (use todos). Notes survive context compression and you'll be reminded at natural work boundaries (after commits, historian runs, todo completion).
Use \`ctx_memory\` to manage cross-session project memories. Write new memories or delete stale ones. Memories persist across sessions and are automatically injected into new sessions.
**Save to memory proactively**: If you spent multiple turns finding something (a file path, a DB location, a config pattern, a workaround), save it with \`ctx_memory\` so future sessions don't repeat the search. Examples:
- Found a project's source code path after searching → \`ctx_memory(action="write", category="ENVIRONMENT", content="OpenCode source is at ~/Work/OSS/opencode")\`
- Discovered a non-obvious build/test command → \`ctx_memory(action="write", category="WORKFLOW_RULES", content="Always use scripts/release.sh for releases")\`
- Learned a constraint the hard way → \`ctx_memory(action="write", category="CONSTRAINTS", content="Dashboard Tauri build needs RGBA PNGs, not grayscale")\`
Use \`ctx_search\` to search across project memories, session facts, and conversation history from one query.
Use \`ctx_expand\` to decompress a compartment range to see the original conversation transcript. Use \`start\`/\`end\` from \`<compartment start="N" end="M">\` attributes. Returns the compacted U:/A: transcript for that message range, capped at ~15K tokens.
**Search before asking the user**: If you can't remember or don't know something that might have been discussed before or stored in project memory, use \`ctx_search\` before asking the user. Examples:
- Can't remember where a related codebase or dependency lives → \`ctx_search(query="opencode source code path")\`
- Forgot a prior architectural decision or constraint → \`ctx_search(query="why did we choose SQLite over postgres")\`
- Need a config value, API key location, or environment detail → \`ctx_search(query="embedding provider configuration")\`
- Looking for how something was implemented previously → \`ctx_search(query="how does the dreamer lease work")\`
- Want to recall what was decided in an earlier conversation → \`ctx_search(query="dashboard release signing setup")\`
\`ctx_search\` returns ranked results from memories, session facts, and raw message history. Use message ordinals from results with \`ctx_expand\` to retrieve surrounding conversation context.
${getToolHistoryGuidance(dropToolStructure)}
NEVER drop large ranges blindly (e.g., "1-50"). Review each tag before deciding.
NEVER drop user messages — they are short and will be summarized by compartmentalization automatically. Dropping them loses context the historian needs.
NEVER drop assistant text messages unless they are exceptionally large. Your conversation messages are lightweight; only large tool outputs are worth dropping.
Before your turn finishes, consider using \`ctx_reduce\` to drop large tool outputs you no longer need.`;

/** Intro when ctx_reduce is disabled — no drop guidance, no ctx_reduce references,
 *  and no tag system description. When `ctx_reduce_enabled: false`, transform.ts
 *  skips §N§ prefix injection entirely, so the agent never sees tags — describing
 *  a tagging system they can't observe just wastes tokens and (empirically) primes
 *  some models to emit malformed `§N">§` tokens at the start of their own text. */
const BASE_INTRO_NO_REDUCE = (
    dropToolStructure: boolean,
): string => `Use \`ctx_note\` for deferred intentions — things to tackle later, not right now. NOT for task tracking (use todos). Notes survive context compression and you'll be reminded at natural work boundaries (after commits, historian runs, todo completion).
Use \`ctx_memory\` to manage cross-session project memories. Write new memories or delete stale ones. Memories persist across sessions and are automatically injected into new sessions.
**Save to memory proactively**: If you spent multiple turns finding something (a file path, a DB location, a config pattern, a workaround), save it with \`ctx_memory\` so future sessions don't repeat the search. Examples:
- Found a project's source code path after searching → \`ctx_memory(action="write", category="ENVIRONMENT", content="OpenCode source is at ~/Work/OSS/opencode")\`
- Discovered a non-obvious build/test command → \`ctx_memory(action="write", category="WORKFLOW_RULES", content="Always use scripts/release.sh for releases")\`
- Learned a constraint the hard way → \`ctx_memory(action="write", category="CONSTRAINTS", content="Dashboard Tauri build needs RGBA PNGs, not grayscale")\`
Use \`ctx_search\` to search across project memories, session facts, and conversation history from one query.
Use \`ctx_expand\` to decompress a compartment range to see the original conversation transcript. Use \`start\`/\`end\` from \`<compartment start="N" end="M">\` attributes. Returns the compacted U:/A: transcript for that message range, capped at ~15K tokens.
**Search before asking the user**: If you can't remember or don't know something that might have been discussed before or stored in project memory, use \`ctx_search\` before asking the user. Examples:
- Can't remember where a related codebase or dependency lives → \`ctx_search(query="opencode source code path")\`
- Forgot a prior architectural decision or constraint → \`ctx_search(query="why did we choose SQLite over postgres")\`
- Need a config value, API key location, or environment detail → \`ctx_search(query="embedding provider configuration")\`
- Looking for how something was implemented previously → \`ctx_search(query="how does the dreamer lease work")\`
- Want to recall what was decided in an earlier conversation → \`ctx_search(query="dashboard release signing setup")\`
\`ctx_search\` returns ranked results from memories, session facts, and raw message history. Use message ordinals from results with \`ctx_expand\` to retrieve surrounding conversation context.
${getToolHistoryGuidance(dropToolStructure)}`;

const SISYPHUS_SECTION = `
### Reduction Triggers
- After collecting background agent results (explore/librarian) — drop raw outputs once you extracted what you need.
- After delegation results are verified — drop full agent output, keep your verification summary.
- After completing a todo phase — drop tool outputs from that phase.

### What to Drop
- Large explore/librarian tool outputs after synthesis.
- Large background task outputs after verification.
- Large file reads and grep results already acted on.

### What to Keep
- ALL user messages and assistant conversation text — these are cheap and compartmentalized automatically.
- Current todo list and active task context.
- Recent errors and unresolved decisions.`;

const ATLAS_SECTION = `
### Reduction Triggers (CRITICAL — you run long sessions)
- After EACH wave/phase completes — reduce BEFORE starting the next wave. This is your most important reduction point.
- After delegation results are verified — the full output is no longer needed.
- Between major context switches — when moving to a new task area.

### What to Drop
- Large delegation tool outputs from completed waves.
- Large verification results from passed checks.
- Large file reads and test outputs from finished tasks.

### What to Keep
- ALL user messages and assistant conversation text — these are cheap and compartmentalized automatically.
- The work plan and current wave/phase status.
- Incomplete todos and their context.
- Recent failures that need retry.`;

const HEPHAESTUS_SECTION = `
### Reduction Triggers
- After processing file reads — you already used the content for your implementation.
- After grep/search results are consumed — drop raw outputs once you found what you need.
- After test runs are analyzed — keep only pass/fail results, drop raw output.
- Between logical implementation steps.

### What to Drop
- Large file reads after you edited the file (your edit reflects the current state).
- Large grep/search results after you identified what you need.
- Large build/test output after you fixed the issues.
- Old LSP diagnostics after fixes applied.

### What to Keep
- ALL user messages and assistant conversation text — these are cheap and compartmentalized automatically.
- Current files being edited and their recent state.
- Active errors and failing tests.
- Task requirements and constraints from your prompt.`;

const SISYPHUS_JUNIOR_SECTION = `
### Reduction Triggers
- After file reads used for implementation — drop once you acted on the content.
- After search results processed — drop raw grep/glob outputs.
- After each logical implementation step completed.

### What to Drop
- Large tool outputs (file reads, grep, build logs) you already acted on.
- NEVER drop your task prompt or initial requirements.

### What to Keep
- ALL user messages and assistant conversation text — these are cheap and compartmentalized automatically.
- Your task requirements (initial prompt).
- Current implementation context and recent edits.
- Recent errors and test results.`;

const ORACLE_SECTION = `
### Reduction Triggers
- After finishing a codebase review pass — drop raw reads once your recommendation is formed.
- After comparing multiple options — keep only the decisive evidence.
- Between separate investigations in the same consultation.

### What to Drop
- Large file reads and search results already incorporated into your conclusion.
- Large background-agent outputs after you synthesized them.

### What to Keep
- ALL user messages and assistant conversation text — these are cheap and compartmentalized automatically.
- The user question and your current recommendation.
- Key evidence that directly supports the recommendation.
- Unresolved trade-offs or risks still under evaluation.`;

const ATHENA_SECTION = `
### Reduction Triggers
- After council synthesis is complete — drop individual council member outputs.
- After user accepted/rejected a council recommendation — drop the deliberation.
- Between separate council invocations on different topics.

### What to Drop
- Large individual council member response outputs after synthesis.
- Large raw exploration outputs used to frame council questions.

### What to Keep
- ALL user messages and assistant conversation text — these are cheap and compartmentalized automatically.
- Current council topic and active deliberation.
- User's original question and constraints.
- Final decisions and action items from previous councils.`;

const GENERIC_SECTION = `
### Reduction Triggers
- After reading files or search results you already acted on — drop raw outputs.
- After completing a logical step — drop intermediate outputs from that step.
- Between major context switches — when moving to a new task area.

### What to Drop
- Large file reads, grep results, and tool outputs you already used.
- Large build/test output after you analyzed and acted on it.
- Old diagnostic or exploration results that are no longer relevant.

### What to Keep
- ALL user messages and assistant conversation text — these are cheap and compartmentalized automatically.
- Your current task requirements and constraints.
- Recent errors and unresolved decisions.
- Active work context and files being edited.`;

const AGENT_SECTIONS: Record<AgentType, string> = {
    sisyphus: SISYPHUS_SECTION,
    atlas: ATLAS_SECTION,
    hephaestus: HEPHAESTUS_SECTION,
    oracle: ORACLE_SECTION,
    "sisyphus-junior": SISYPHUS_JUNIOR_SECTION,
    athena: ATHENA_SECTION,
    "athena-junior": ATHENA_SECTION,
};

/** Signature strings used to detect known agents from system prompt content.
 *  Order matters — more specific signatures are checked first.
 *  IMPORTANT: signatures must be unique to each agent's OWN prompt, not strings
 *  that appear in other agents' delegation tables (e.g., "athena-junior" appears
 *  in every agent's delegation list and must NOT be used as a signature). */
const AGENT_SIGNATURES: [AgentType, string][] = [
    ["athena-junior", "Athena in non-interactive mode"],
    ["sisyphus-junior", "Sisyphus-Junior"],
    ["sisyphus", '"Sisyphus"'],
    ["atlas", "You are Atlas"],
    ["hephaestus", "You are Hephaestus"],
    ["oracle", "strategic technical advisor"],
    ["athena", "You are Athena"],
];

/**
 * Detect which agent is active by scanning the system prompt for known signatures.
 * Returns the detected agent type or null for unknown agents.
 * Order matters — more specific signatures (e.g., "Sisyphus-Junior") are checked first.
 */
export function detectAgentFromSystemPrompt(systemPrompt: string): AgentType | null {
    for (const [agent, signature] of AGENT_SIGNATURES) {
        if (systemPrompt.includes(signature)) {
            return agent;
        }
    }
    return null;
}

const TEMPORAL_AWARENESS_GUIDANCE = `\n**Temporal awareness**: User messages may be preceded by HTML comments like \`<!-- +12m -->\`, \`<!-- +2h 15m -->\`, or \`<!-- +3d 4h -->\` indicating time elapsed since the previous message's completion. Compartments in \`<session-history>\` carry \`start-date\` and \`end-date\` attributes (YYYY-MM-DD) showing real-time boundaries. Use these when reasoning about workflow pacing, log durations, build times, or how long ago something happened.`;

export function buildMagicContextSection(
    agent: AgentType | null,
    protectedTags: number,
    ctxReduceEnabled = true,
    dreamerEnabled = false,
    dropToolStructure = true,
    temporalAwarenessEnabled = false,
): string {
    const smartNoteGuidance = dreamerEnabled
        ? `\nWhen \`surface_condition\` is provided with \`write\`, the note becomes a project-scoped smart note.\nThe dreamer evaluates smart note conditions during nightly runs and surfaces them when conditions are met.\nExample: \`ctx_note(action="write", content="Implement X because Y", surface_condition="When PR #42 is merged in this repo")\``
        : "";
    const temporalGuidance = temporalAwarenessEnabled ? TEMPORAL_AWARENESS_GUIDANCE : "";

    if (!ctxReduceEnabled) {
        return `## Magic Context\n\n${BASE_INTRO_NO_REDUCE(dropToolStructure)}${smartNoteGuidance}${temporalGuidance}`;
    }
    const section = agent ? AGENT_SECTIONS[agent] : GENERIC_SECTION;
    return `## Magic Context\n\n${BASE_INTRO(protectedTags, dropToolStructure)}${smartNoteGuidance}${temporalGuidance}\n${section}\n\nPrefer many small targeted operations over one large blanket operation. Compress early and often — don't wait for warnings.`;
}
