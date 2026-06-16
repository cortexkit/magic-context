import type { DreamingTask } from "../../../config/schema/magic-context";

/** Memory shape the curate prompt renders (verify now has its own runner/prompt). */
export interface CuratePromptMemory {
    id: number;
    category: string;
    content: string;
    mappedFiles: string[];
    hasNoFileSentinel: boolean;
}

// ── System Prompt ──────────────────────────────────────────────────────────

// Generic agent-registration base. Every dreamer task overrides `system:` with a
// focused per-task prompt below, so this is only the fallback identity OpenCode/Pi
// register the hidden agent with — kept minimal so a task never inherits another
// task's instructions.
export const DREAMER_SYSTEM_PROMPT = `You are a background maintenance agent for the magic-context system, running during a scheduled dream window. Your task and its full instructions arrive in the message below. Never read or quote secrets from .env, credentials, or key files, and never commit — the user handles git.`;

// The 5-category project-memory taxonomy, shared by the tasks that actually touch
// project memories (curate). Kept as one constant so the wording can't drift.
const PROJECT_MEMORY_TAXONOMY = `## Memory taxonomy (5 categories)

Project memory uses exactly 5 categories. Every memory belongs to one:
- **PROJECT_RULES** — durable process/workflow rules for this repo (releases, commits, testing, debugging conventions).
- **ARCHITECTURE** — load-bearing design decisions and WHY they hold (not WHAT a file does).
- **CONSTRAINTS** — hard limits imposed by EXTERNAL systems (APIs, providers, platforms, protocols). Not our own code's behavior.
- **CONFIG_VALUES** — stable configuration keys/values and conventions. Not transient measurements (test counts, sizes, versions).
- **NAMING** — naming conventions and canonical names. Not inventories.

**Legacy categories during transition:** older memories may still carry pre-v2 category names. When you touch one, map it to its 5-category home with \`action="update"\` (or \`merge\`): WORKFLOW_RULES→PROJECT_RULES, ARCHITECTURE_DECISIONS→ARCHITECTURE, CONFIG_DEFAULTS→CONFIG_VALUES, ENVIRONMENT→CONFIG_VALUES (paths) or CONSTRAINTS, KNOWN_ISSUES→CONSTRAINTS only if it's an external-system limit (otherwise archive — our own fixed bugs are not world facts). USER_DIRECTIVES / USER_PREFERENCES are NOT project categories — they live in the global user profile; archive project copies only when they add zero project-specific detail.`;

// curate: memory-pool hygiene only. It edits the memory store via ctx_memory and
// never reads code (a separate verify task owns memory-vs-code correctness), so
// the codebase-tool framing is deliberately absent.
export const CURATE_SYSTEM_PROMPT = `You are a memory-pool curator for the magic-context system. You run during a scheduled dream window to keep a project's cross-session memory store lean and well-formed.

## Memory operations (ctx_memory)
- \`action="list"\` — browse active memories, optionally filter by category
- \`action="merge", ids=[N,M,...], content="...", category="..."\` — consolidate duplicates into one canonical memory
- \`action="update", ids=[N], content="..."\` — rewrite a memory's content
- \`action="write", category="...", content="..."\` — create a memory (SPLITS ONLY — never mint new facts)
- \`action="archive", ids=[N], reason="..."\` — soft-archive a stale or low-value memory

## Rules
1. **Assume the pool is accurate.** A separate verify task checks memories against code. You handle QUALITY only — duplicates, wording, low-value entries — never correctness, and you do NOT read the codebase.
2. **Work methodically.** Choose your own batch size.
3. **Be conservative with archives.** Use the task's archive criteria.
4. **Present-tense operational language.** "X uses Y" not "X was changed to use Y."
5. **One rule/fact per memory.**
6. **Never mint new facts** — that is the historian's job. \`write\` is for splitting a compound memory only.

${PROJECT_MEMORY_TAXONOMY}`;

// maintain-docs: edits ARCHITECTURE.md / STRUCTURE.md only. It needs codebase
// read + doc-write tools and the protected-region rule, and NONE of the memory
// machinery.
export const MAINTAIN_DOCS_SYSTEM_PROMPT = `You are a documentation maintainer for the magic-context system. You run during a scheduled dream window to keep a project's root \`ARCHITECTURE.md\` and \`STRUCTURE.md\` synchronized with the actual code.

## Tools
- Read files, grep, glob, bash — explore the codebase to verify current state.
- Write / edit — update the two docs (project root only, never \`.planning/\`).

## Rules
- **NEVER touch protected regions.** Any content between \`<!-- mc:protected START ... -->\` and \`<!-- mc:protected END -->\` is hand-authored and cache-critical. Reproduce it BYTE-FOR-BYTE — do not edit, reword, reorder, summarize, trim, or drop a single line, and keep the marker comments. Only a human edits that region.
- **Preserve an existing doc's structure, voice, and density.** When a doc already exists, it is the source of truth for shape: keep its headings, ordering, level of detail, and writing style. Make the SMALLEST edits that bring it back in sync with the code. NEVER reshape hand-written prose into a generic template, collapse a dense section into bullet stubs, or drop hard-won detail (specific invariants, edge cases, mechanism descriptions) because it does not fit a standard layout. A doc denser and more specific than a template is BETTER, not worse: leave it that way.
- **Be prescriptive** ("Use X pattern", not "X pattern is used"). **Current state only** — no temporal language, no history.
- **Verify before writing** — read the actual files, never guess. All file paths in the docs must point to files that exist.`;

// review-user-memories: a pure JSON reviewer of behavioral observations about the
// human user (the GLOBAL user profile, NOT project memories). It calls no tools
// and the host applies the verdict, so it needs no memory ops or taxonomy.
export const REVIEW_USER_MEMORIES_SYSTEM_PROMPT = `You are a user-profile reviewer for the magic-context system. You run during a scheduled dream window to decide which recurring behavioral observations about the human user are real, persistent patterns worth keeping in their global user profile.

You do NOT call any tools and you do NOT touch project memories — you read the candidate observations the host gives you and return a JSON verdict. Distill durable patterns; never transcribe a single moment. Output only the JSON the task asks for, with no surrounding prose.`;

// refresh-primers: a read-only code investigator that answers ONE standing
// question about the current codebase. It runs on the locked
// dreamer-primer-investigator agent (read-only tools only), so the prompt frames
// investigation + grounding and never mentions write/memory tools.
export const PRIMER_INVESTIGATOR_SYSTEM_PROMPT = `You are a read-only code investigator for the magic-context system. You run during a scheduled dream window to answer a single standing question about THIS codebase by reading its current source.

## Tools (read-only)
\`read\`, \`grep\`, \`glob\`, \`aft_outline\`, \`aft_zoom\`, \`aft_search\`. You have no write, edit, bash, or memory tools — you investigate and report, you change nothing.

## Rules
- **Ground every claim in code you actually opened this run.** Open the files the question points at and verify against them. A paraphrase that reads no files is not an answer.
- **Answer directly and concretely** — name paths, symbols, and mechanisms, in present tense.`;

// ── Curate ─────────────────────────────────────────────────────────────────

function renderMemoryList(memories: CuratePromptMemory[]): string {
    return memories
        .map((memory) => {
            const files = memory.mappedFiles.length
                ? memory.mappedFiles.join(", ")
                : "(none mapped yet)";
            return `[${memory.id}] ${memory.category}\nContent: ${memory.content}\nMapped files: ${files}${memory.hasNoFileSentinel ? " (file-independent)" : ""}`;
        })
        .join("\n\n");
}

function formatUserProfileList(
    userMemories?: Array<{ id: number; content: string }>,
): string | undefined {
    if (!userMemories || userMemories.length === 0) return undefined;
    return userMemories.map((um) => `- [U${um.id}] ${um.content}`).join("\n");
}

export function buildCuratePrompt(args: {
    projectPath: string;
    memories: CuratePromptMemory[];
    userProfile?: string;
}): string {
    // adapted from validated shadow-trial prompt; further tuning happens in the harness
    return `## Task: Curate Project Memory Pool (hygiene)

**Project:** ${args.projectPath}

The memories below are assumed ACCURATE (a separate verify task keeps them true). Your job is pool QUALITY: remove duplicates, tighten wording, and archive low-value entries that waste the ~6000-token injection budget. Explain each action in one line first. Do NOT mint new facts (that is the historian's job).

Work ALL THREE phases below in order (A → B → C) over the whole pool. Do NOT stop after consolidating — a run that only merges and never improves or archives is incomplete.

### Phase A — Consolidate duplicates
Group by category, then merge near-identical / superset-subset / same-fact-different-angle clusters into one canonical memory with \`ctx_memory(action="merge", ids=[...], content="...", category="...")\`. Preserve every unique detail; terse present tense; paths/keys verbatim. Every id in a merge MUST share the same category — the system rejects cross-category merges. If two similar memories sit in different categories they are NOT duplicates (one is miscategorized — archive the redundant one in Phase C instead). One fact per memory.

### Phase B — Improve wording
Rewrite narrative/historical → operational present tense ("X uses Y because Z", not "we switched to Y"); drop session-local context and commit hashes (unless the hash is the point); add specifics where vague. \`write\` is for SPLITS ONLY (update the original down to its first fact, write the second) — a healthy run is net-neutral or net-shrinking, never net-adds facts.

### Phase C — Archive stale / low-value
Archive (with a specific reason) memories that: restate code without rationale · are redundant with a better memory · are stale implementation detail (line numbers/internals) · low signal (seen_count=1, retrieval_count=0, no constraint language) · bare config value · transient measurement · a solved bug in OUR OWN code · redundant with the global user profile (zero added project detail).
KEEP (overrides archive): constraint/rule language (must/never/always) · explains WHY (because/so that/to prevent) · EXTERNAL-system limit (CONSTRAINTS: archive only if word-for-word duplicated) · path/config WITH context · retrieval_count>0 · priority/philosophy.
${args.userProfile ? `\n### Global user profile (for the redundancy check)\n${args.userProfile}\n` : ""}
### Memory pool
${renderMemoryList(args.memories)}`;
}

// ── Retrospective ───────────────────────────────────────────────────────────

export interface RetrospectivePromptEvent {
    sessionId: string;
    kind: string;
    fields: Record<string, string>;
    createdAt: number;
}

export const RETROSPECTIVE_SYSTEM_PROMPT = `You are a retrospective learning agent for Magic Context.

You learn only from recurring user-friction moments where the user had to correct, re-explain, or recover from the assistant's repeated behavior. You receive a pre-rendered friction window from the host and may use ctx_search to look for corroborating prior patterns.

Rules:
1. Pattern, not one-off: extract only recurring behavior that is likely to happen again. Zero learnings is fine.
2. Distill, do not transcribe: never quote the user, never include dates, and never preserve session-local anger.
3. Root cause + correction: the learning must tell a future agent what to do differently.
4. Privacy by host-apply: do not call memory-writing tools. Emit only the XML schema requested by the prompt.`;

/** Tiny system prompt for the cheap LLM gate (turn 1): it reads only U: lines
 *  and answers "n" or "y: <ordinals>". Kept minimal so the gate is cheap. */
export const FRICTION_GATE_SYSTEM_PROMPT =
    "You are a conservative friction detector for a coding agent. You read recent user message lines and decide whether the user was correcting, re-explaining to, or frustrated with the assistant. Output exactly one line and nothing else.";

export function buildFrictionGatePrompt(args: { userLines: string[] }): string {
    return `Decide whether these user lines show the user correcting, re-explaining to, or expressing frustration at the ASSISTANT's behavior — a moment a future assistant should learn from.

Fire (y) when the user: corrects a mistake the assistant made, repeats an instruction the assistant didn't follow, tells the assistant to stop or revert an unwanted action, or shows frustration at repeated assistant behavior.
Do NOT fire (n) for: a normal request or question; the user changing their own mind or fixing their own earlier message ("actually, use X instead — my mistake"); reporting a bug/error/test failure to investigate; a calm one-off "do X instead". The words "no", "not", "error", "fail", "wrong" inside an otherwise-normal sentence are not friction.

Return exactly one line: "n", or "y: <line numbers>". Be conservative.

${args.userLines.join("\n")}`;
}

function renderRetrospectiveEvents(events: RetrospectivePromptEvent[]): string {
    if (events.length === 0) return "(no corroborating historian events)";
    return events
        .map((event) => {
            const fields = Object.entries(event.fields)
                .map(([key, value]) => `${key}: ${value}`)
                .join("; ");
            return `- ${new Date(event.createdAt).toISOString()} session=${event.sessionId} kind=${event.kind}${fields ? ` — ${fields}` : ""}`;
        })
        .join("\n");
}

export function buildRetrospectivePrompt(args: {
    projectPath: string;
    frictionWindow: string;
    events: RetrospectivePromptEvent[];
}): string {
    return `## Task: Retrospective Learning

**Project:** ${args.projectPath}

The host detected possible user friction in the pre-rendered window below. Use it plus ctx_search (if helpful) to decide whether there is a recurring root cause and recurring assistant behavior worth remembering.

### Friction window
${args.frictionWindow}

### Corroborating historian events
${renderRetrospectiveEvents(args.events)}

### Extraction rules
- Extract only durable, recurring learnings. A single annoyed/corrective message is noise.
- Write actionable present-tense corrections for future agents.
- Do NOT quote the user, include dates, or preserve anger/frustration wording.
- Write in plain prose with NO quotation marks at all — not around the user's words, and not around illustrative trigger words. Describe trigger conditions directly (write: when the user asks you to investigate or diagnose without requesting a fix — not: when the user says "investigate"). A learning containing any quotation marks is rejected.
- Use route="memory" for project-specific agent behavior/rules, with category one of PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, NAMING.
- Use route="observation" only for recurring user workflow/preferences that belong in the global user profile.
- Zero learnings is acceptable and should be represented by an empty learnings block.

Return only XML in this exact shape:
<learnings>
  <learning route="memory" category="PROJECT_RULES">one durable actionable correction</learning>
  <learning route="observation">one recurring user preference</learning>
</learnings>`;
}

// ── Maintain Docs ──────────────────────────────────────────────────────────

export function buildMaintainDocsPrompt(
    projectPath: string,
    lastDreamAt: string | null,
    existingDocs: { architecture: boolean; structure: boolean },
): string {
    const hasAny = existingDocs.architecture || existingDocs.structure;
    const gitSinceClause = lastDreamAt
        ? `Run \`git log --oneline --since="${new Date(Number(lastDreamAt)).toISOString()}"\` to see what changed since the last dream.`
        : "No previous dream timestamp — treat this as a full analysis.";

    const modeIntro = hasAny
        ? `Some docs already exist and are the source of truth for shape. Make SURGICAL \`edit\` changes to only the sections affected by recent code changes; preserve every other section, the existing structure, and the existing density verbatim. Do NOT regenerate a whole file, do NOT reshape prose into a template, and do NOT use the templates below (they are for creation only). If nothing material changed, change nothing.`
        : `No docs exist yet. Create both ARCHITECTURE.md and STRUCTURE.md from scratch using the templates below as a STARTING shape, then go deeper than the template wherever the code warrants it.`;

    return `## Task: Maintain Codebase Documentation

**Project:** ${projectPath}
**Last dream:** ${lastDreamAt ? new Date(Number(lastDreamAt)).toISOString() : "never"}
**Existing docs:** ARCHITECTURE.md: ${existingDocs.architecture ? "exists" : "missing"}, STRUCTURE.md: ${existingDocs.structure ? "exists" : "missing"}

### Goal
Keep ARCHITECTURE.md and STRUCTURE.md at the project root synchronized with the actual codebase.

${modeIntro}

### Process

1. **Check what changed.** ${gitSinceClause}
2. **Read existing docs** (if they exist) IN FULL to understand their current structure, depth, and voice; you will preserve all of it except what code changes force you to touch.
3. **Explore the codebase** to verify and update:
   - Directory structure: \`find . -type d -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -60\`
   - Entry points: \`ls src/index.* src/main.* 2>/dev/null\`
   - Key imports: \`grep -r "^import\\|^export" src/ --include="*.ts" | head -80\`
4. **Apply the change.** If the doc EXISTS: use \`edit\` for the specific sections that drifted, never rewrite the whole file with \`write\`. If the doc is MISSING: create it with \`write\`. Always at project root, NOT \`.planning/\`.

### Rules
- **NEVER touch protected regions**: any content between \`<!-- mc:protected START ... -->\` and \`<!-- mc:protected END -->\` is hand-authored and cache-critical. Reproduce it BYTE-FOR-BYTE in your rewrite — do not edit, reword, reorder, summarize, trim, or drop a single line of it, and keep the marker comments themselves. Only a human edits that region.
- **Preserve existing structure and density**: when a doc exists, keep its headings, ordering, level of detail, and voice. Make the smallest edits that re-sync it with the code. NEVER flatten dense hand-written prose into the generic template, collapse a detailed section into bullet stubs, or drop specific invariants/edge-cases/mechanism detail because it does not match a standard layout. Denser and more specific than the template is BETTER.
- **Be prescriptive**: "Use X pattern" not "X pattern is used"
- **Always include file paths** in backticks
- **Write current state only**: no temporal language, no history
- **Verify before writing**: read actual files, don't guess
- **Never read .env, credentials, or key files** — note existence only
- **Do not commit** — the user handles git

${!existingDocs.architecture ? ARCHITECTURE_TEMPLATE : ""}
${!existingDocs.structure ? STRUCTURE_TEMPLATE : ""}

### Success criteria
- ARCHITECTURE.md accurately describes current layers, data flows, entry points, and abstractions
- STRUCTURE.md accurately describes directory layout with guidance for where to add new code
- All file paths in docs point to files that actually exist
- Docs are at project root: \`${projectPath}/ARCHITECTURE.md\` and \`${projectPath}/STRUCTURE.md\``;
}

// ── Templates ──────────────────────────────────────────────────────────────

const ARCHITECTURE_TEMPLATE = `
### ARCHITECTURE.md Template (use when creating from scratch)

\`\`\`markdown
# Architecture

## Pattern Overview

**Overall:** [Pattern name — e.g., Plugin-based hook system]

**Key Characteristics:**
- [Characteristic 1]
- [Characteristic 2]

## Layers

**[Layer Name]:**
- Purpose: [What this layer does]
- Location: \\\`[path]\\\`
- Contains: [Types of code]
- Depends on: [What it uses]
- Used by: [What uses it]

## Data Flow

**[Flow Name]:** (e.g., "Transform Pipeline", "Memory Promotion")

1. [Step 1] — \\\`[file]\\\`
2. [Step 2] — \\\`[file]\\\`
3. [Step 3] — \\\`[file]\\\`

## Key Abstractions

**[Abstraction Name]:**
- Purpose: [What it represents]
- Location: \\\`[file paths]\\\`
- Pattern: [Pattern used]

## Entry Points

**[Entry Point]:**
- Location: \\\`[path]\\\`
- Triggers: [What invokes it]
- Responsibilities: [What it does]

## Error Handling

**Strategy:** [Approach — e.g., fail closed, sentinel throws, try/catch with logging]

## Cross-Cutting Concerns

**Logging:** [Approach]
**Caching:** [Approach]
**Storage:** [Approach]
\`\`\``;

const STRUCTURE_TEMPLATE = `
### STRUCTURE.md Template (use when creating from scratch)

\`\`\`markdown
# Codebase Structure

## Directory Layout

\\\`\\\`\\\`
[project-root]/
├── [dir]/          # [Purpose]
├── [dir]/          # [Purpose]
└── [file]          # [Purpose]
\\\`\\\`\\\`

## Directory Purposes

**[Directory Name]:**
- Purpose: [What lives here]
- Contains: [Types of files]
- Key files: \\\`[important files]\\\`

## Key File Locations

**Entry Points:** \\\`[path]\\\`: [Purpose]
**Configuration:** \\\`[path]\\\`: [Purpose]
**Core Logic:** \\\`[path]\\\`: [Purpose]
**Tests:** \\\`[path]\\\`: [Purpose]

## Naming Conventions

**Files:** [Pattern]: [Example]
**Directories:** [Pattern]: [Example]

## Where to Add New Code

**New hook:** \\\`src/hooks/[hook-name]/\\\` — follow existing hook structure
**New tool:** \\\`src/tools/[tool-name]/\\\` — register in tool-registry.ts
**New feature module:** \\\`src/features/[feature-name]/\\\`
**New agent:** \\\`src/agents/[agent-name].ts\\\`
**Shared utilities:** \\\`src/shared/\\\`
**Tests:** co-located with source as \\\`*.test.ts\\\`
\`\`\``;

// ── Distill Skill Memory ───────────────────────────────────────────────────

function buildDistillSkillMemoryPrompt(projectPath: string): string {
    return `## Task: Distill Skill Memory

**Project:** ${projectPath}

### Goal
Maintain the skill_memory table: merge near-duplicate notes, prune stale low-hit notes,
promote recurring gotchas to pinned, enforce per-skill note caps.

### Process
1. Query skill_memory for skills with note_count > 20 (the distill threshold):
   \`\`\`sql
   SELECT skill_id, tier, project_identity, COUNT(*) as note_count
   FROM skill_memory
   WHERE project_identity = (SELECT project_identity FROM skill_memory LIMIT 1)
   GROUP BY skill_id, tier, project_identity
   HAVING note_count > 20
   ORDER BY note_count DESC
   LIMIT 5;
   \`\`\`
2. For each qualifying skill:
   a. List notes ordered by hit_count DESC, created_at DESC.
   b. Merge near-duplicate notes (same kind, similar delta — use judgment).
      Use ctx_skill_note with action="distill" and merge: [id, id].
   c. Prune notes with hit_count=0 AND created_at < now-30d (stale, never recalled).
      Use ctx_skill_note with action="distill" and prune: id.
   d. Promote notes with hit_count >= 5 to pinned=1 if not already pinned.
      Use ctx_skill_note with action="distill" and promote: id.
   e. If note count > 100 after pruning, archive oldest low-hit unpinned notes.
3. Log a quality alert if >30% of kind='gotcha' notes appear to be general observations
   (not skill-specific). Use ctx_memory to record the alert.
4. Process at most 5 skill groups per run (rotating by last_distilled_at).

### Tools available
- ctx_skill_note (with action="distill" — dreamer-only action for merge/prune/promote)
- Read, bash (for verification queries)

### Success criteria
- No skill has >100 notes in the project tier.
- Pinned notes reflect genuinely recurring gotchas (hit_count >= 5).
- Stale zero-hit notes older than 30 days are pruned.
- Quality alert logged if >30% of gotcha notes are general-quality.`;
}

// ── Dispatcher ─────────────────────────────────────────────────────────────

export function buildDreamTaskPrompt(
    task: DreamingTask,
    args: {
        projectPath: string;
        lastDreamAt?: string | null;
        existingDocs?: { architecture: boolean; structure: boolean };
        userMemories?: Array<{ id: number; content: string }>;
        curate?: {
            memories: CuratePromptMemory[];
        };
    },
): string {
    switch (task) {
        case "curate":
            return buildCuratePrompt({
                projectPath: args.projectPath,
                memories: args.curate?.memories ?? [],
                userProfile: formatUserProfileList(args.userMemories),
            });
        case "maintain-docs":
            return buildMaintainDocsPrompt(
                args.projectPath,
                args.lastDreamAt ?? null,
                args.existingDocs ?? { architecture: false, structure: false },
            );
        case "distill-skill-memory":
            return buildDistillSkillMemoryPrompt(args.projectPath);
    }
}
