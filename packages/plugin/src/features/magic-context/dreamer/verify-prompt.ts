/**
 * verify prompt + manifest parser.
 *
 * verify checks each in-scope project memory against the CURRENT source and
 * emits ONE XML manifest (verified / update / archive / skip). The agent reads code
 * and changes nothing; the HOST parses the manifest and applies the DB writes
 * (so the agent never needs a mutation tool). Calibrated in the shadow harness
 * with planted ground-truth controls (4/4: caught a stale number → update, a
 * wrong tool-count → archive, a same-session change → archive, and kept the
 * correct control verified). See .alfonso/plans/dreamer-v2-rework.md.
 *
 * The DANGEROUS failure mode is WRONG ARCHIVAL (deleting a TRUE memory), so the
 * prompt and the host apply both bias hard toward keeping memories.
 */

import {
    assertNoDuplicateManifestIds,
    assertParsedManifestNonEmpty,
    describeUnrecognizedManifestShape,
    extractCompleteManifestBody,
} from "./manifest-parser";

export const VERIFY_SYSTEM_PROMPT = `You are a memory verifier for the magic-context system. You verify project memories against the CURRENT code.

Each memory below comes with its backing file(s) — the code it makes a claim about. For EACH memory: read its backing files (you may read more if needed) and decide whether the memory is still accurate.

Tools (read-only): read, grep, glob, aft_search, aft_outline, aft_zoom. You read code to check claims; you change nothing.

Decide ONE of four outcomes per memory:
- VERIFIED — still accurate. Keep it as-is.
- UPDATE — a CODE FACT is still true but a file-falsifiable DETAIL drifted (a renamed symbol, moved file, changed number/name). Provide corrected content in terse present tense ("X uses Y", not "X was changed to Y"). Only update for genuine drift, not style. If a legitimate update intentionally consolidates the old claim into much shorter content, set consolidation="true" explicitly.
- ARCHIVE — a CODE FACT is positively falsified: the code clearly contradicts it, or the API/symbol/path it describes no longer exists.
- SKIP — the claim is not a code fact, or code cannot decide it. Keep it unchanged and do not claim verification.

UPDATE and ARCHIVE are ONLY for claims a repository file can falsify, such as an API that no longer exists, a path that moved, or a constant that changed. Behavioral directives (when to act, how to work, who decides, tool-usage discipline) can only be VERIFIED or SKIPPED. A named path inside a directive does not make the directive a code fact, and a file's failure to corroborate a behavioral rule is never grounds to update or archive it.

BE CONSERVATIVE ABOUT ARCHIVING. Wrong archival of a TRUE memory is the worst possible outcome — far worse than leaving a slightly-stale memory. If you cannot find the code, or you are unsure, or it might still be true somewhere you didn't look: mark it VERIFIED or SKIPPED, never archived. Archive ONLY when you have positive evidence the code contradicts a code fact.

Output ONE XML manifest at the very end and NOTHING else — no narration, no per-memory commentary, no reasoning:
<verify>
<verified id="N" files="path/a.ts,path/b.ts"/>
<update id="M" files="path/c.ts">corrected present-tense content</update>
<update id="C" files="path/d.ts" consolidation="true">intentionally consolidated content</update>
<archive id="K" reason="specific evidence the code contradicts it"/>
<skip id="S" reason="behavioral directive; code cannot decide it"/>
</verify>

Rules:
- Every input memory id MUST appear exactly once, in exactly one of verified/update/archive/skip.
- files = the COMPLETE current backing set (repo-relative, comma-separated). It may differ from the given mapping if a file moved — record what you actually verified against.
- Default to VERIFIED. skip when code cannot decide the claim. update and archive are the exceptions, not the norm.`;

export interface VerifyPromptMemory {
    id: number;
    category: string;
    content: string;
    mappedFiles: string[];
}

export function buildVerifyPrompt(projectPath: string, memories: VerifyPromptMemory[]): string {
    const list = memories
        .map(
            (m) =>
                `[${m.id}] ${m.category}\nContent: ${m.content}\nBacking files: ${m.mappedFiles.join(", ")}`,
        )
        .join("\n\n");
    return `## Verify these memories against the code

Project: ${projectPath}

Read each memory's backing files, decide verified / update / archive / skip (default verified; behavioral directives only permit verified or skip), then output ONE <verify> manifest covering every id.

<memories>
${list}
</memories>`;
}

export interface ParsedVerifyManifest {
    verified: Array<{ id: number; files: string[] }>;
    updated: Array<{ id: number; files: string[]; content: string; consolidation: boolean }>;
    archived: Array<{ id: number; reason: string }>;
    skipped: Array<{ id: number; reason: string }>;
}

function attrOf(s: string, name: string): string | null {
    const m = s.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
    return m ? m[1] : null;
}

function filesOf(s: string): string[] {
    return (attrOf(s, "files") ?? "")
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
}

function verifyIds(parsed: ParsedVerifyManifest): number[] {
    return [...parsed.verified, ...parsed.updated, ...parsed.archived, ...parsed.skipped].map(
        (entry) => entry.id,
    );
}

function verifyBody(text: string): string {
    try {
        return extractCompleteManifestBody(text, "verify");
    } catch (error) {
        const described = describeUnrecognizedManifestShape(text, "verify", "verified");
        if (!described.startsWith("parsed zero entries")) throw new Error(described);
        throw error;
    }
}

/** Parse the agent's complete `<verify>` manifest. The root close tag is
 *  mandatory so truncated output cannot apply a partial set of verdicts.
 *  A well-formed root with no recognized entries is a format miss, not success. */
export function parseVerifyManifest(text: string): ParsedVerifyManifest {
    const out: ParsedVerifyManifest = { verified: [], updated: [], archived: [], skipped: [] };
    const body = verifyBody(text);

    for (const m of body.matchAll(/<verified\b([^>]*)\/?>/g)) {
        const id = Number.parseInt(attrOf(m[1], "id") ?? "", 10);
        if (!Number.isInteger(id)) throw new Error("verify manifest entry missing numeric id");
        out.verified.push({ id, files: filesOf(m[1]) });
    }
    for (const m of body.matchAll(/<update\b([^>]*?)(?:\/>|>([\s\S]*?)<\/update>)/g)) {
        const id = Number.parseInt(attrOf(m[1], "id") ?? "", 10);
        if (!Number.isInteger(id)) throw new Error("verify manifest entry missing numeric id");
        out.updated.push({
            id,
            files: filesOf(m[1]),
            content: (m[2] ?? "").trim(),
            consolidation: attrOf(m[1], "consolidation")?.toLowerCase() === "true",
        });
    }
    for (const m of body.matchAll(/<archive\b([^>]*)\/?>/g)) {
        const id = Number.parseInt(attrOf(m[1], "id") ?? "", 10);
        if (!Number.isInteger(id)) throw new Error("verify manifest entry missing numeric id");
        out.archived.push({ id, reason: attrOf(m[1], "reason") ?? "" });
    }
    for (const m of body.matchAll(/<skip\b([^>]*)\/?>/g)) {
        const id = Number.parseInt(attrOf(m[1], "id") ?? "", 10);
        if (!Number.isInteger(id)) throw new Error("verify manifest entry missing numeric id");
        out.skipped.push({ id, reason: attrOf(m[1], "reason") ?? "" });
    }
    if (verifyIds(out).length === 0 && body.trim().length > 0) {
        throw new Error(describeUnrecognizedManifestShape(text, "verify", "verified"));
    }
    return out;
}

/** Retry responses must contain a non-empty manifest with syntactically valid
 *  entries and a closing root element, so the response is complete rather than
 *  truncated. The verifier commits valid expected ids and leaves omissions for
 *  the per-memory gate to select next run. Duplicate expected ids are rejected;
 *  duplicate unknown ids are ignored. */
export function validateVerifyManifest(
    text: string,
    expectedIds: ReadonlySet<number>,
): ParsedVerifyManifest {
    const parsed = parseVerifyManifest(text);
    const ids = verifyIds(parsed);
    assertParsedManifestNonEmpty(ids.length, expectedIds.size, text, "verify", "verified");
    assertNoDuplicateManifestIds(
        ids.filter((id) => expectedIds.has(id)),
        "verify",
    );
    return parsed;
}
