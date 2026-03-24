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

const BASE_INTRO = (
    protectedTags: number,
): string => `Messages and tool outputs are tagged with §N§ identifiers (e.g., §1§, §42§).
Use \`ctx_reduce\` to manage context size. It supports one operation:
- \`drop\`: Remove entirely (best for tool outputs you already acted on).
Syntax: "3-5", "1,2,9", or "1-5,8,12-15". Last ${protectedTags} tags are protected.
Use \`ctx_note\` for deferred intentions — things to tackle later, not right now. NOT for task tracking (use todos). Notes survive context compression and you'll be reminded at natural work boundaries (after commits, historian runs, todo completion).
Use \`ctx_memory\` to manage cross-session project memories. Write new memories, delete stale ones, or search stored memories by category. Memories persist across sessions and are automatically injected into new sessions.
Use \`ctx_expand\` to decompress a compartment range to see the original conversation transcript. Use \`start\`/\`end\` from \`<compartment start=N end=M>\` attributes. Returns the compacted U:/A: transcript for that message range, capped at ~15K tokens.
NEVER drop large ranges blindly (e.g., "1-50"). Review each tag before deciding.
NEVER drop user messages — they are short and will be summarized by compartmentalization automatically. Dropping them loses context the historian needs.
NEVER drop assistant text messages unless they are exceptionally large. Your conversation messages are lightweight; only large tool outputs are worth dropping.
Before your turn finishes, consider using \`ctx_reduce\` to drop large tool outputs you no longer need.`;

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

export function buildMagicContextSection(agent: AgentType | null, protectedTags: number): string {
    const section = agent ? AGENT_SECTIONS[agent] : GENERIC_SECTION;
    return `## Magic Context

${BASE_INTRO(protectedTags)}
${section}

Prefer many small targeted operations over one large blanket operation. Compress early and often — don't wait for warnings.`;
}
