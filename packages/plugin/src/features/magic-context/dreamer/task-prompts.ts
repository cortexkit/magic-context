import type { DreamingTask } from "../../../config/schema/magic-context";
import type { CurateMemoryCategory } from "./curate-category-rotation";

/** Memory shape the curate prompt renders (verify now has its own runner/prompt). */
export interface CuratePromptMemory {
    id: number;
    category: string;
    content: string;
    mappedFiles: string[];
    hasNoFileSentinel: boolean;
    importance: number;
    retrievalCount: number;
    seenCount: number;
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

**Legacy categories during transition:** older memories may still carry pre-v2 category names. When you touch one, map it to its 5-category home with \`action="update"\` (or \`merge\`): WORKFLOW_RULES→PROJECT_RULES, ARCHITECTURE_DECISIONS→ARCHITECTURE, CONFIG_DEFAULTS→CONFIG_VALUES, ENVIRONMENT→CONFIG_VALUES (paths) or CONSTRAINTS, KNOWN_ISSUES→CONSTRAINTS only if it's an external-system limit. USER_DIRECTIVES / USER_PREFERENCES are NOT project categories. Do not compare project memories with the global user profile or use it to justify an archive.`;

// curate: memory-pool hygiene only. It edits the memory store via ctx_memory and
// never reads code (a separate verify task owns memory-vs-code correctness), so
// the codebase-tool framing is deliberately absent.
export const CURATE_SYSTEM_PROMPT = `You are a memory-pool curator for the magic-context system. You run during a scheduled dream window to keep a project's cross-session memory store lean and well-formed.

## Memory operations
- The scoped category snapshot arrives in the first message. Do not list or get it again; track mutation deltas.
- \`action="merge", ids=[N,M,...], content="...", category="..."\` — consolidate duplicates into one canonical memory
- \`action="update", ids=[N], content="...", superseded_by=M\` — rewrite content; name where removed detail survives when cutting more than half
- \`action="write", category="...", content="..."\` — create a memory (SPLITS ONLY — never mint new facts)
- \`action="archive", ids=[N], superseded_by=M, reason="..."\` — consolidate a redundant memory into the named active same-category survivor

## Rules
1. **Assume the pool is accurate.** A separate verify task checks memories against code. You handle QUALITY only — duplicates, wording, low-value entries — never correctness, and you do NOT read the codebase.
2. **Work methodically.** Choose your own batch size.
3. **Be conservative with archives.** Use the task's archive criteria.
4. **Present-tense operational language.** "X uses Y" not "X was changed to use Y."
5. **One rule/fact per memory.**
6. **Never mint new facts** — that is the historian's job. \`write\` is for splitting a compound memory only.

${PROJECT_MEMORY_TAXONOMY}`;

// The docs investigator can only inspect source and return section proposals.
// It keeps the "for the magic-context system" identity phrase: isMagicContextInternalAgent
// keys on it to keep MC's own guidance out of this child's system prompt.
export const MAINTAIN_DOCS_SYSTEM_PROMPT = `You are a read-only documentation investigator for the magic-context system. Use read, grep, glob and navigation tools to verify source. Never edit any file or run commands. Return only a proposed change to the project's ARCHITECTURE.md and STRUCTURE.md, not a change log. The protected regions between <!-- mc:protected START ... --> and <!-- mc:protected END --> must remain byte-identical. If the docs are accurate, return [].`;

// review-user-memories: a pure JSON reviewer of behavioral observations about the
// human user (the GLOBAL user profile, NOT project memories). It calls no tools
// and the host applies the verdict, so it needs no memory ops or taxonomy.
export const REVIEW_USER_MEMORIES_SYSTEM_PROMPT = `You are a user-profile reviewer for the magic-context system. You run during a scheduled dream window to decide which recurring behavioral observations about the human user are real, persistent patterns worth keeping in their global user profile.

You do NOT call any tools and you do NOT touch project memories — you read the candidate observations the host gives you and return a JSON verdict. Distill durable patterns; never transcribe a single moment. Phrase promoted or updated memories as concise, present-tense verb-first statements without a subject (for example, "Prefers concise explanations" or "Expects changes to be tested"). Output only the JSON the task asks for, with no surrounding prose.`;

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
            return `[${memory.id}] ${memory.category} importance=${memory.importance} retrieval_count=${memory.retrievalCount} seen_count=${memory.seenCount}\nContent: ${memory.content}\nMapped files: ${files}${memory.hasNoFileSentinel ? " (file-independent)" : ""}`;
        })
        .join("\n\n");
}

export function buildCuratePrompt(args: {
    projectPath: string;
    category: CurateMemoryCategory;
    memories: CuratePromptMemory[];
    crossChunkCandidates?: string[];
    injectionBudgetTokens?: number;
}): string {
    // adapted from validated shadow-trial prompt; further tuning happens in the harness
    return `## Task: Curate Project Memory Pool (hygiene)

**Project:** ${args.projectPath}

This run covers the whole of the \`${args.category}\` category (the other categories run in later windows).

The memories below are assumed ACCURATE (a separate verify task keeps them true). Your job is pool QUALITY: remove duplicates, tighten wording, and consolidate redundant entries that waste the ${args.injectionBudgetTokens ?? 4000}-token injection budget. Explain each action in one line first. Do NOT mint new facts (that is the historian's job).

Work ALL THREE phases below in order (A → B → C) over this category. Do NOT stop after consolidating — a run that only merges and never improves or archives is incomplete.

### Phase A — Consolidate duplicates
Group by category, then merge near-identical / superset-subset / same-fact-different-angle clusters into one canonical memory with \`ctx_memory(action="merge", ids=[...], content="...", category="...")\`. Preserve every unique detail; terse present tense; paths/keys verbatim. Every id in a merge MUST share the same category — the system rejects cross-category merges. If two similar memories sit in different categories they are NOT duplicates; do not archive either as a consolidation. One fact per memory.

### Phase B — Improve wording
Rewrite narrative/historical → operational present tense ("X uses Y because Z", not "we switched to Y"); drop session-local context and commit hashes (unless the hash is the point); add specifics where vague. A rewrite that removes more than half the content must name the active same-category memory preserving that detail with \`superseded_by\`. \`write\` is for SPLITS ONLY (update the original down to its first fact, write the second) — a healthy run is net-neutral or net-shrinking, never net-adds facts.

### Phase C — Archive only into a surviving project memory
Archive a redundant memory only when a better ACTIVE memory in the same project and category preserves its information; name that survivor with \`superseded_by\`. A bare "redundant" verdict is deletion and will be refused. Leave standalone low-value or stale entries unchanged for a human to review. The global user profile describes the operator and is never a substitute for project knowledge, so it cannot justify an archive.
KEEP (overrides archive): constraint/rule language (must/never/always) · explains WHY (because/so that/to prevent) · EXTERNAL-system limit (CONSTRAINTS: archive only if word-for-word duplicated) · path/config WITH context · retrieval_count>0 · priority/philosophy.

### Cross-chunk duplicate candidates (normalized content matches)
${args.crossChunkCandidates?.join("\n") || "(none)"}

### Category snapshot (do not re-enumerate)
${renderMemoryList(args.memories)}`;
}

export function chunkCurateMemories(
    memories: CuratePromptMemory[],
    maxCharacters: number,
): Array<{ memories: CuratePromptMemory[]; crossChunkCandidates: string[] }> {
    const chunks: CuratePromptMemory[][] = [];
    let current: CuratePromptMemory[] = [];
    let size = 0;
    for (const memory of memories) {
        const length = renderMemoryList([memory]).length + 2;
        if (current.length && size + length > maxCharacters) {
            chunks.push(current);
            current = [];
            size = 0;
        }
        current.push(memory);
        size += length;
    }
    if (current.length) chunks.push(current);
    const keys = new Map<string, Array<{ id: number; chunk: number }>>();
    chunks.forEach((chunk, index) => {
        chunk.forEach((memory) => {
            const key = memory.content
                .toLowerCase()
                .replace(/[^\p{L}\p{N}]+/gu, " ")
                .trim();
            keys.set(key, [...(keys.get(key) ?? []), { id: memory.id, chunk: index }]);
        });
    });
    return chunks.map((chunk, index) => ({
        memories: chunk,
        crossChunkCandidates: [...keys.values()]
            .filter(
                (matches) =>
                    matches.some((match) => match.chunk === index) &&
                    matches.some((match) => match.chunk !== index),
            )
            .map((matches) => `IDs ${matches.map((match) => match.id).join(", ")}`),
    }));
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
    changeSet: string,
    existingDocs: { architecture: boolean; structure: boolean },
    budget = 12000,
    currentTokens = 0,
    currentDocs?: { architecture: string; structure: string },
): string {
    return `## Task: Propose documentation corrections

Project: ${projectPath}
Existing docs: ARCHITECTURE.md ${existingDocs.architecture ? "exists" : "missing"}; STRUCTURE.md ${existingDocs.structure ? "exists" : "missing"}.
Current combined token count: ${currentTokens}. Combined budget: ${budget} tokens.

Host-collected code changes (diff stat and hunks, or file/line ranges when oversized):
${changeSet}

Current ARCHITECTURE.md:
${currentDocs?.architecture ?? "(read from project)"}

Current STRUCTURE.md:
${currentDocs?.structure ?? "(read from project)"}

Find claims in these sections that the diff makes wrong or incomplete. Propose one focused change per claim or section. Do not investigate unrelated areas. Read the docs and relevant source with read-only tools. These files are short maps read by every agent in every session. Describe how the system works now, never what changed or when: no change log, dates, or commit lists. One short paragraph per subsystem at most. Mechanism detail belongs in docs/architecture/; you may name a docs page for it but never move that detail into these two files. Propose a change only when code contradicts the docs or a major piece is missing. Prefer rewriting a stale sentence to adding one. Propose nothing when nothing is wrong. Keep both files within the combined budget. Never touch protected regions (<!-- mc:protected START ... --> through <!-- mc:protected END -->); preserve their bytes.

Return ONLY a JSON array (or []), with each entry {"file":"ARCHITECTURE.md"|"STRUCTURE.md","action":"replace"|"add"|"remove","heading":"## Exact section heading","text":"## Full replacement section including heading and body (empty for remove)","reason":"one-line reason"}. A replacement includes the entire section, including its heading. Additions are appended at the end of the file. Do not include any unmodified sections. No file writes.`;
}

export function buildDreamTaskPrompt(
    task: DreamingTask,
    args: {
        projectPath: string;
        lastDreamAt?: string | null;
        existingDocs?: { architecture: boolean; structure: boolean };
        docsChangeSet?: string;
        docsBudget?: number;
        docsCurrentTokens?: number;
        docsContents?: { architecture: string; structure: string };
        memoryInjectionBudgetTokens?: number;
        curate?: {
            category: CurateMemoryCategory;
            memories: CuratePromptMemory[];
            crossChunkCandidates?: string[];
        };
    },
): string {
    switch (task) {
        case "curate":
            return buildCuratePrompt({
                projectPath: args.projectPath,
                category: args.curate?.category ?? "PROJECT_RULES",
                memories: args.curate?.memories ?? [],
                crossChunkCandidates: args.curate?.crossChunkCandidates,
                injectionBudgetTokens: args.memoryInjectionBudgetTokens,
            });
        case "maintain-docs":
            return buildMaintainDocsPrompt(
                args.projectPath,
                args.docsChangeSet ?? "",
                args.existingDocs ?? { architecture: false, structure: false },
                args.docsBudget,
                args.docsCurrentTokens,
                args.docsContents,
            );
    }
}
