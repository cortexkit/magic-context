/**
 * classify-memories prompt + manifest parser (non-agentic single-shot transform).
 *
 * classify scores each memory's importance (1-100), scope, and shareability from
 * the memory TEXT alone (no code inspection). The reworked task is a PURE
 * transform: the host renders one prompt, the zero-tool dreamer-classifier agent
 * emits ONE XML manifest, and the host batch-applies the columns via
 * setMemoryClassification (cache-neutral). No per-memory tool calls.
 *
 * Importance/scope/shareability GUIDANCE is the harness-validated text (DS4F:
 * 229 importances assigned, correct discrimination, 4/4 private controls held).
 */

import {
    assertManifestCoversExactly,
    assertNoDuplicateManifestIds,
    assertParsedManifestNonEmpty,
    describeUnrecognizedManifestShape,
    extractCompleteManifestBody,
} from "./manifest-parser";

export interface ClassifyPromptMemory {
    id: number;
    category: string;
    content: string;
    importance: number;
    scope: "project" | "ecosystem" | "universe";
    shareable: number | boolean;
}

/** A few already-classified memories shown as scoring ANCHORS in Stage 3 (large
 *  pools), so the model calibrates the new/changed memories against the existing
 *  distribution instead of re-scoring in a vacuum. */
export interface ClassifyAnchorMemory {
    id: number;
    category: string;
    content: string;
    importance: number;
}

const SCORING_GUIDANCE = `### How to score importance (1-100)
Importance decides which memories survive when the injected memory block is over budget: high scores stay in context, low scores drop first. So the score is only useful if it **discriminates** — if most memories land in the same band, you have not classified them, you have just labelled them.

Use judgment, not a formula. Blend:
- **Durability / decay-rate value:** Will this fact still matter weeks from now, across sessions?
- **Operational impact:** Would missing this fact cause wrong code, wasted time, broken workflows, or violated constraints?

Most memories are ordinary working facts — they belong in the middle, not the top. Reserve the high band for the genuinely load-bearing handful a teammate would be sunk without; push routine observations, one-off details, and now-obvious facts down. A "real, true fact" is not automatically important — truth is not importance.

Rough anchors (not quotas — spread naturally within them): transient/obvious observations 1-30, ordinary helpful project facts 40-65, load-bearing rules/architecture/constraints 70-100. A constraint that is a genuine must/never/always rule the project actively depends on floors around 60; but not every memory in a category is load-bearing — a niche, dated, or narrowly-scoped external quirk can sit lower even if it is a "constraint". Score the fact, not the label. If you assigned most of the pool to one band, re-read and differentiate.

One hard floor: an operating rule whose VIOLATION causes a public-facing or irreversible mistake — posting under the wrong identity, committing/pushing without approval, leaking private content, running destructive commands — scores at least 80. These rules only work if they are always in view; a mid-band score silently drops them from context exactly when the pool grows, and the violation happens. Judge by consequence-of-forgetting, not by how mundane the rule text reads.

### Scope
- \`project\` — only meaningful inside this repository/product (default when uncertain).
- \`ecosystem\` — useful to sibling projects in the same stack, harness, provider, or company ecosystem.
- \`universe\` — broadly true outside this codebase (protocol/platform/API facts), still written as a concise memory.

### Shareability
Shareability is about EXPOSURE, not scope: **would a teammate working on THIS SAME project benefit from seeing this memory, and is it free of anything personal, local, or sensitive?** If yes, set \`shareable="true"\`. This is the COMMON case — most project knowledge is exactly what you'd hand a new teammate: architecture, design rules, conventions, constraints, file locations, hard-won gotchas. Mark those shareable even though they are specific to this repo's internals.

Keep \`shareable="false"\` only for what is tied to the USER or their machine rather than the project: personal/absolute paths, usernames, local or private endpoints (e.g. localhost), credentials/secrets/tokens, customer data, machine-specific config, and personal working-style preferences. A fact's scope does NOT decide shareability. The host also fails closed and forces secret/credential/personal-path text to private regardless.`;

const OUTPUT_CONTRACT = `Output ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:
<classify>
<memory id="N" importance="80" scope="project" shareable="true" safety_critical="true"/>
<memory id="M" importance="20" scope="universe" shareable="false" safety_critical="false"/>
</classify>

Rules:
- Every memory in the pool below MUST appear exactly once.
- importance is an integer 1-100; scope is one of project|ecosystem|universe; shareable is true|false.
- Set safety_critical to true for the operating rules covered by the hard floor above, false otherwise.`;

export const CLASSIFY_SYSTEM_PROMPT = `You are a memory classifier for the magic-context system. You classify project memories by metadata only. You do NOT rewrite, merge, archive, verify, or create memories, and you do NOT read code — you judge each memory from its own text.

${SCORING_GUIDANCE}

${OUTPUT_CONTRACT}`;

function renderPool(memories: ClassifyPromptMemory[]): string {
    return memories
        .map(
            (m) =>
                `[${m.id}] ${m.category} (current: importance=${m.importance} scope=${m.scope} shareable=${Boolean(m.shareable)})\n${m.content}`,
        )
        .join("\n\n");
}

function renderAnchors(anchors: ClassifyAnchorMemory[]): string {
    if (anchors.length === 0) return "";
    const list = anchors
        .map((a) => `[${a.id}] ${a.category} importance=${a.importance}\n${a.content}`)
        .join("\n\n");
    return `### Already-classified reference memories (calibrate against these — do NOT re-score them, they are NOT in your output)
${list}

`;
}

/**
 * Build the classify prompt for a batch. `anchors` (optional) are existing
 * classified memories shown for distribution calibration in large pools; they
 * are NOT scored and must NOT appear in the manifest.
 */
export function buildClassifyPrompt(args: {
    projectPath: string;
    memories: ClassifyPromptMemory[];
    anchors?: ClassifyAnchorMemory[];
}): string {
    return `## Task: Classify Project Memories

**Project:** ${args.projectPath}

Score EVERY memory in the pool below. Emit one <classify> manifest covering every id.

${renderAnchors(args.anchors ?? [])}### Memory pool to classify
${renderPool(args.memories)}`;
}

export interface ParsedClassification {
    id: number;
    importance?: number;
    scope?: "project" | "ecosystem" | "universe";
    shareable?: boolean;
    safety_critical?: boolean;
}

const SCOPES = new Set(["project", "ecosystem", "universe"]);

function classifyBody(text: string): string {
    try {
        return extractCompleteManifestBody(text, "classify");
    } catch (error) {
        const described = describeUnrecognizedManifestShape(text, "classify", "memory");
        if (!described.startsWith("parsed zero entries")) throw new Error(described);
        throw error;
    }
}

/** Parse the agent's complete `<classify>` manifest. A missing root close tag is
 *  treated as truncation and rejects the whole batch. A well-formed root with
 *  no `<memory>` entries is a format miss, not success. */
export function parseClassifyManifest(text: string): ParsedClassification[] {
    const out: ParsedClassification[] = [];
    const body = classifyBody(text);
    for (const m of body.matchAll(/<memory\b([^>]*)\/?>/g)) {
        const attrs = m[1];
        const idMatch = attrs.match(/\bid\s*=\s*"(\d+)"/);
        if (!idMatch) throw new Error("classify manifest entry missing numeric id");
        const id = Number.parseInt(idMatch[1], 10);
        if (!Number.isInteger(id)) throw new Error("classify manifest entry missing numeric id");

        const entry: ParsedClassification = { id };
        const impMatch = attrs.match(/\bimportance\s*=\s*"(\d+)"/);
        if (impMatch) {
            const imp = Number.parseInt(impMatch[1], 10);
            if (Number.isInteger(imp)) entry.importance = Math.max(1, Math.min(100, imp));
        }
        const scopeMatch = attrs.match(/\bscope\s*=\s*"([a-z]+)"/i);
        if (scopeMatch) {
            const scope = scopeMatch[1].toLowerCase();
            if (!SCOPES.has(scope)) throw new Error(`classify manifest invalid scope ${scope}`);
            entry.scope = scope as ParsedClassification["scope"];
        }
        const shareMatch = attrs.match(/\bshareable\s*=\s*"(true|false|1|0)"/i);
        if (shareMatch) {
            const v = shareMatch[1].toLowerCase();
            entry.shareable = v === "true" || v === "1";
        }
        const safetyMatch = attrs.match(/\bsafety_critical\s*=\s*"([^"]*)"/i);
        if (safetyMatch) {
            if (!/^(true|false)$/i.test(safetyMatch[1]))
                throw new Error(`classify manifest invalid safety_critical ${safetyMatch[1]}`);
            entry.safety_critical = safetyMatch[1].toLowerCase() === "true";
        }
        if (
            entry.importance === undefined &&
            !entry.scope &&
            entry.shareable === undefined &&
            entry.safety_critical === undefined
        ) {
            throw new Error(`classify manifest entry ${id} missing classification fields`);
        }
        out.push(entry);
    }
    if (out.length === 0 && body.trim().length > 0) {
        throw new Error(describeUnrecognizedManifestShape(text, "classify", "memory"));
    }
    assertNoDuplicateManifestIds(
        out.map((entry) => entry.id),
        "classify",
    );
    return out;
}

/** Retry-time contract: non-empty parse + exact id coverage. Apply still
 *  re-asserts coverage as the final belt. */
export function validateClassifyManifest(
    text: string,
    expectedIds: ReadonlySet<number>,
): ParsedClassification[] {
    const parsed = parseClassifyManifest(text);
    assertParsedManifestNonEmpty(parsed.length, expectedIds.size, text, "classify", "memory");
    assertManifestCoversExactly(
        parsed.map((entry) => entry.id),
        expectedIds,
        "classify",
    );
    return parsed;
}
