import type { DreamingTask } from "../../../config/schema/magic-context";

// ── System Prompt ──────────────────────────────────────────────────────────

export const DREAMER_SYSTEM_PROMPT = `You are a memory maintenance agent for the magic-context system.
You run during scheduled dream windows to maintain a project's cross-session memory store and codebase documentation.

## Available Tools

**Memory operations** (ctx_memory with extended dreamer actions):
- \`action="list"\` — browse all active memories, optionally filter by category
- \`action="update", id=N, content="..."\` — rewrite a memory's content
- \`action="merge", ids=[N,M,...], content="...", category="..."\` — consolidate duplicates into one canonical memory
- \`action="archive", id=N, reason="..."\` — archive a stale memory with provenance
- \`action="write", category="...", content="..."\` — create a new memory
- \`action="delete", id=N\` — permanently remove a memory

**Codebase tools** (standard OpenCode tools):
- Read files, grep, glob, bash — for verification against actual code

## Rules

1. **Work methodically.** Decide your own batch size based on the task — process as many items per round as makes sense.
2. **Always verify against actual files** before declaring a memory stale or updating it.
3. **Be conservative with archives.** Only archive when the codebase clearly contradicts the memory.
4. **Explain reasoning briefly** before each action — one line is enough.
5. **Use present-tense operational language** in all memory rewrites. "X uses Y" not "X was changed to use Y."
6. **One rule/fact per memory.** Split compound memories during improvement.
7. **Never read or quote secrets** from .env, credentials, keys, or similar sensitive files.
8. **Do not commit changes.** The user handles git operations.`;

// ── Consolidate ────────────────────────────────────────────────────────────

export function buildConsolidatePrompt(projectPath: string): string {
    return `## Task: Consolidate Duplicate Memories

**Project:** ${projectPath}

### Goal
Find semantically duplicate or overlapping memories and merge each cluster into one canonical memory.

### Process

1. **List all active memories** with \`ctx_memory(action="list")\`.
2. **Group by category first**, then scan within each category for:
   - Near-identical wording (e.g. "Use SQLite for memory" vs "Use SQLite for persistent memory")
   - Same fact stated from different angles
   - Superset/subset pairs where one memory contains everything the other says
3. **For each duplicate cluster**, decide on one canonical wording that:
   - Preserves all unique information from the cluster
   - Uses terse present-tense operational language
   - Keeps file paths, config keys, and values verbatim when they matter
4. **Merge** with \`ctx_memory(action="merge", ids=[...], content="...", category="...")\`.
5. **Do NOT merge across categories** — a USER_DIRECTIVE and a WORKFLOW_RULE may look similar but serve different purposes.

### What makes a good canonical memory
- One fact per memory. If a merged result has two distinct rules, write one memory and create a second with \`action="write"\`.
- Present tense: "Historian uses raw OpenCode message ordinals" not "We switched historian to raw ordinals."
- Drop session-local context: "in this session", "after the refactor", "commit abc123" — unless the commit hash itself is the point.

### Success criteria
- No two active memories in the same category say essentially the same thing.
- Merged memories are terse and actionable.
- Archive provenance is recorded (merge tracks source IDs).`;
}

// ── Verify ─────────────────────────────────────────────────────────────────

export function buildVerifyPrompt(projectPath: string): string {
    return `## Task: Verify Memories Against Codebase

**Project:** ${projectPath}

### Goal
Check verifiable memories against actual repository state. Update stale wording, archive memories that are no longer true.

### Process

1. **List all active memories** with \`ctx_memory(action="list")\`.
2. **Categorize by verifiability:**
   - **CONFIG_DEFAULTS**: grep schema/config files for actual default values
   - **ARCHITECTURE_DECISIONS**: check if referenced files, functions, modules still exist
   - **ENVIRONMENT**: verify paths, storage locations, log file names
   - **NAMING**: check if naming conventions match actual code
   - **CONSTRAINTS**: spot-check if enforcement code or rules still exist
   - **KNOWN_ISSUES**: check if the issue has been fixed
   - **USER_DIRECTIVES / USER_PREFERENCES**: skip — these are user intent, not codebase facts
   - **WORKFLOW_RULES**: verify only if they reference specific files or tools
3. **For each verifiable memory:**
   - Read the actual file or grep for the pattern
   - If the memory is correct: leave it alone
   - If the wording is stale but the fact is true: \`ctx_memory(action="update", id=N, content="corrected wording")\`
   - If the memory is clearly wrong: \`ctx_memory(action="archive", id=N, reason="...")\`
4. **Be conservative.** If you cannot find the referenced code but it might be in a location you haven't checked, do NOT archive. Move on.

### Verification examples
- Memory: "history_budget_percentage defaults to 0.15" → grep schema for \`history_budget_percentage\`, check \`.default(...)\`
- Memory: "Durable state lives in ~/.local/share/opencode/storage/plugin/magic-context/context.db" → check storage-db.ts for the path construction
- Memory: "ctx_search searches memories, facts, and history" → grep for ctx_search tool definition and unified search implementation

### Success criteria
- All CONFIG_DEFAULTS memories match actual schema defaults.
- No memories reference files or paths that no longer exist.
- Updated memories use current naming and paths.`;
}

// ── Archive Stale ──────────────────────────────────────────────────────────

export function buildArchiveStalePrompt(
    projectPath: string,
    userMemories?: Array<{ id: number; content: string }>,
): string {
    const userProfileBlock =
        userMemories && userMemories.length > 0
            ? `
### Global User Profile (already injected into ALL sessions across ALL projects)
These user memories are ALREADY available to the agent globally. Project memories that merely restate the same preference/rule are redundant and should be archived — but ONLY if the project memory adds ZERO project-specific detail beyond what the global memory already says.

${userMemories.map((um) => `- [U${um.id}] ${um.content}`).join("\n")}
`
            : "";

    return `## Task: Archive Stale Memories

**Project:** ${projectPath}

### Goal
Find and archive memories that waste the limited injection budget (~6000 tokens, fits ~150 memories).
${userProfileBlock}
### Archive criteria (archive IF any apply)

1. **Code restatement without rationale** — merely describes what code does without explaining WHY or what would break if changed.
   - Archive: "Tag assignment uses one DB transaction" (obvious from code)
   - Keep: "Tag assignment uses one DB transaction because tags rows and session_meta.counter must stay in sync" (explains the constraint)

2. **Redundant with other memories** — same information expressed differently. Keep the better-worded one.

3. **Stale implementation detail** — references specific functions, line numbers, or internal structures that change frequently and are better found by reading code.
   - Archive: "Function X is called at line 289 of file Y"
   - Keep: "Feature X requires Y to be initialized before Z" (design constraint)

4. **Low retrieval signal** — seen_count=1, retrieval_count=0, and no constraint language. These were promoted once but never needed again.

5. **Redundant with global user profile** — ONLY if the project memory adds ZERO project-specific detail beyond what the global memory already says. A project memory that applies a global principle to a specific context (e.g., "cache awareness is highest priority" applies a general principle to THIS project's north star) is NOT redundant — it narrows the global principle.

6. **Bare config defaults** — single-line values like \`enabled=true\` or \`experimental.X=false\` with no surrounding explanation or rationale.

7. **Completed one-time instructions** — imperative USER_DIRECTIVES like "Add X", "Create Y", "Publish as Z" where the action has clearly been done.

### Keep criteria (keep IF ANY apply — these OVERRIDE archive criteria)

1. **Contains constraint/rule** — uses "must", "never", "always", "cannot", "should not". CONSTRAINTS category gets extra protection: only archive if the EXACT same constraint exists word-for-word in another memory.
2. **Captures non-obvious design reasoning** — explains WHY, not just WHAT. Look for "because", "so that", "to prevent", "to avoid".
3. **Project-specific behavioral rule** — even if it sounds generic, if it's in USER_DIRECTIVES it was explicitly stated by the user for this project. Only archive if: (a) the action is clearly completed, or (b) it is 100% identical in scope to a global user memory.
4. **Post-failure learning** — memories that encode lessons learned from real bugs, regressions, or user corrections. These prevent re-encountering the same problem.
5. **Environment/path information** — saves agent from hunting for locations.
6. **Config defaults with context** — prevents wrong assumptions. Archive ONLY bare values with no surrounding explanation.
7. **Known issues** — prevents re-encountering solved problems. NEVER archive KNOWN_ISSUES.
8. **High retrieval signal** — retrieval_count > 0 means the agent actually searched for this.
9. **Priority/philosophy statements** — "X is the highest priority" or "north star" type directives that shape all decisions.

### Process

1. **List all active memories** with \`ctx_memory(action="list")\`.
2. **Apply the archive and keep criteria above to each memory.**
3. **Verify each candidate** against the codebase before archiving:
   - Check if the file/tool/path actually exists
   - For USER_DIRECTIVES: verify the instructed action was completed
   - If the reference is ambiguous, leave it alone
4. **Archive** with \`ctx_memory(action="archive", id=N, reason="...")\`. Always include a specific reason.

### Category-specific rules
- **CONSTRAINTS**: archive ONLY when provably redundant with another specific constraint (not just thematically similar). Each constraint typically guards against a specific bug — losing it means the bug can return.
- **USER_DIRECTIVES**: archive ONLY completed one-time tasks or exact duplicates of global user profile entries. Keep ongoing behavioral rules even if they have low retrieval.
- **KNOWN_ISSUES**: NEVER archive — these prevent re-encountering bugs.
- **ARCHITECTURE_DECISIONS**: archive code restatements freely, keep anything with "because", "so that", "to prevent", "to avoid".
- **CONFIG_DEFAULTS**: archive bare values with no context, keep values that include rationale or prevent wrong assumptions.

### Success criteria
- No active memories reference non-existent files, tools, or paths.
- No completed one-time instructions remain in USER_DIRECTIVES.
- ARCHITECTURE_DECISIONS contains design reasoning, not code restatements.
- CONSTRAINTS are preserved unless provably duplicated.
- Every archived memory has a specific reason.
- Conservative — when in doubt, leave it active.`;
}

// ── Improve ────────────────────────────────────────────────────────────────

export function buildImprovePrompt(projectPath: string): string {
    return `## Task: Improve Memory Quality

**Project:** ${projectPath}

### Goal
Rewrite verbose, narrative, or poorly-structured memories into terse operational statements.

### Process

1. **List all active memories** with \`ctx_memory(action="list")\`.
2. **Identify improvement candidates:**
   - Narrative/historical wording: "We decided to..." → "X uses Y because Z"
   - Compound memories with multiple unrelated facts → split into separate memories
   - Vague memories without file paths or specifics → add paths if you can find them, or archive if meaningless
   - Session-local language: "in this session", "after the refactor" → remove temporal context
   - Redundant qualifiers: "It's important to note that..." → drop
3. **Rewrite** with \`ctx_memory(action="update", id=N, content="...")\`.
4. **Split compound memories:** If one memory contains two distinct facts, update it to keep the first fact and \`action="write"\` a new memory for the second.

### Good memory format
\`\`\`
Category: CONFIG_DEFAULTS
Content: execute_threshold_percentage defaults to 65 and accepts a scalar or { default, <model-key> } map for per-model overrides.
\`\`\`

### Bad memory format (before improvement)
\`\`\`
Category: CONFIG_DEFAULTS  
Content: We changed the execute threshold to be configurable in the session where we were working on per-model thresholds. It was originally hardcoded at 65% but now accepts either a number or a map.
\`\`\`

### Rules
- Present tense, operational voice: "X does Y" not "X was changed to do Y"
- Keep file paths, function names, config keys verbatim
- Drop commit hashes unless the hash itself is the memory's point
- One fact per memory. Two facts = two memories.

### Success criteria
- No memories use narrative/historical language.
- No compound memories with unrelated facts.
- All memories are terse and directly actionable.`;
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
        ? `Some docs already exist. Update only the sections affected by recent changes. Do NOT rewrite unchanged sections.`
        : `No docs exist yet. Create both ARCHITECTURE.md and STRUCTURE.md from scratch using the templates below.`;

    return `## Task: Maintain Codebase Documentation

**Project:** ${projectPath}
**Last dream:** ${lastDreamAt ? new Date(Number(lastDreamAt)).toISOString() : "never"}
**Existing docs:** ARCHITECTURE.md: ${existingDocs.architecture ? "exists" : "missing"}, STRUCTURE.md: ${existingDocs.structure ? "exists" : "missing"}

### Goal
Keep ARCHITECTURE.md and STRUCTURE.md at the project root synchronized with the actual codebase.

${modeIntro}

### Process

1. **Check what changed.** ${gitSinceClause}
2. **Read existing docs** (if they exist) to understand current state.
3. **Explore the codebase** to verify and update:
   - Directory structure: \`find . -type d -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -60\`
   - Entry points: \`ls src/index.* src/main.* 2>/dev/null\`
   - Key imports: \`grep -r "^import\\|^export" src/ --include="*.ts" | head -80\`
4. **Write or update** using the Write tool. Always write to project root, NOT to .planning/.

### Rules
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

// ── Dispatcher ─────────────────────────────────────────────────────────────

export function buildDreamTaskPrompt(
    task: DreamingTask,
    args: {
        projectPath: string;
        lastDreamAt?: string | null;
        existingDocs?: { architecture: boolean; structure: boolean };
        userMemories?: Array<{ id: number; content: string }>;
    },
): string {
    switch (task) {
        case "consolidate":
            return buildConsolidatePrompt(args.projectPath);
        case "verify":
            return buildVerifyPrompt(args.projectPath);
        case "archive-stale":
            return buildArchiveStalePrompt(args.projectPath, args.userMemories);
        case "improve":
            return buildImprovePrompt(args.projectPath);
        case "maintain-docs":
            return buildMaintainDocsPrompt(
                args.projectPath,
                args.lastDreamAt ?? null,
                args.existingDocs ?? { architecture: false, structure: false },
            );
    }
}
