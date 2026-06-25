/**
 * Minimal YAML frontmatter parser for the `skill-memory:` block.
 * Does NOT depend on a full YAML library — parses only the specific
 * `skill-memory:` sub-block using line-by-line key:value extraction.
 * Malformed or absent blocks return null (inert). A bad config in one
 * skill cannot break other skills.
 */

export interface SkillMemoryConfig {
    enabled: true;
    max_tokens: number;
    max_pinned_tokens: number;
    dedup_threshold: number;
    ranking_relevance?: number;
    ranking_recency?: number;
    ranking_hit?: number;
}

// Anchored to the very start of the file (NO `m` flag): frontmatter is only
// valid as the first bytes of the document. With `m`, `^` matches any line
// start, so a later `--- ... ---` block (e.g. a markdown horizontal rule) could
// be misparsed as config. A leading UTF-8 BOM and leading whitespace/blank
// lines are tolerated (`\uFEFF?\s*`) so an editor-saved SKILL.md with a BOM or a
// stray blank first line still parses; this stays start-anchored because `\s*`
// only spans leading whitespace before the first `---`, never a mid-document rule.
const FRONTMATTER_REGEX = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---/;

export function parseFrontmatterConfig(content: string): SkillMemoryConfig | null {
    try {
        const fmMatch = content.match(FRONTMATTER_REGEX);
        if (!fmMatch) return null;

        const fmText = fmMatch[1];
        const skillMemoryBlock = extractSkillMemoryBlock(fmText);
        if (!skillMemoryBlock) return null;

        const enabled = skillMemoryBlock.enabled;
        if (enabled !== true && enabled !== "true") return null;

        return {
            enabled: true,
            max_tokens: toNumber(skillMemoryBlock.max_tokens, 1500),
            max_pinned_tokens: toNumber(skillMemoryBlock.max_pinned_tokens, 4000),
            dedup_threshold: toNumber(skillMemoryBlock.dedup_threshold, 0.92),
            ranking_relevance: toOptionalNumber(skillMemoryBlock.ranking_relevance),
            ranking_recency: toOptionalNumber(skillMemoryBlock.ranking_recency),
            ranking_hit: toOptionalNumber(skillMemoryBlock.ranking_hit),
        };
    } catch {
        // Non-choke: malformed config = inert
        return null;
    }
}

function toNumber(value: unknown, defaultValue: number): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return defaultValue;
}

function toOptionalNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

/**
 * Extract the `skill-memory:` sub-block from YAML frontmatter text.
 * Returns a flat key→value map of the block's immediate children.
 * Returns null if the block is absent or not an object.
 */
function extractSkillMemoryBlock(fmText: string): Record<string, unknown> | null {
    const lines = fmText.split(/\r?\n/);
    let inSkillMemory = false;
    const result: Record<string, unknown> = {};
    let found = false;

    for (const line of lines) {
        if (!inSkillMemory) {
            // Inline flow-mapping form on the header line:
            //   `skill-memory: { enabled: true, max_tokens: 2000 }`
            // This is the form the ctx_skill_recall remediation message and the
            // root docs advertise, so it MUST parse — otherwise a user following
            // the guidance silently gets an inert config. Parse the {...} body
            // into the same flat map the block form produces, then stop (a flow
            // mapping is self-contained on one line).
            const inlineMatch = line.match(/^skill-memory:\s*\{(.*)\}\s*(#.*)?$/);
            if (inlineMatch) {
                found = true;
                for (const pair of splitFlowEntries(inlineMatch[1])) {
                    const sep = pair.indexOf(":");
                    if (sep < 0) continue;
                    const key = pair.slice(0, sep).trim();
                    if (!/^\w+$/.test(key)) continue;
                    result[key] = parseYamlScalar(pair.slice(sep + 1).trim());
                }
                break;
            }
            // Tolerate a trailing inline comment after the block header
            // (`skill-memory:   # motor memory`), which is valid YAML.
            if (/^skill-memory:\s*(#.*)?$/.test(line)) {
                inSkillMemory = true;
                found = true;
            }
            continue;
        }
        // End of skill-memory block: a line that starts without indentation
        if (/^\S/.test(line)) break;
        // Parse indented key: value lines
        const kvMatch = line.match(/^\s{2,}(\w+):\s*(.*)$/);
        if (kvMatch) {
            const key = kvMatch[1];
            const rawVal = kvMatch[2].trim();
            result[key] = parseYamlScalar(rawVal);
        }
    }

    return found ? result : null;
}

/**
 * Split a YAML flow-mapping body (the text inside `{...}`) on top-level commas,
 * leaving quoted segments intact. Minimal — the skill-memory config is a flat
 * map of scalar values, so we don't need nested {}/[] handling.
 */
function splitFlowEntries(body: string): string[] {
    const entries: string[] = [];
    let current = "";
    let quote: '"' | "'" | null = null;
    for (const ch of body) {
        if (quote) {
            current += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === ",") {
            entries.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    if (current.trim()) entries.push(current);
    return entries;
}

function parseYamlScalar(raw: string): unknown {
    // Strip an inline `# comment` for UNQUOTED scalars (YAML requires whitespace
    // before the `#`). Quoted values keep their content verbatim so a literal
    // "#" inside quotes survives. Without this, `enabled: true # on` would parse
    // as the string "true # on" and silently fail the strict true/false check.
    const isQuoted =
        (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"));
    if (!isQuoted) {
        const commentIdx = raw.search(/\s#/);
        if (commentIdx >= 0) raw = raw.slice(0, commentIdx).trim();
    }

    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw === "null" || raw === "~") return null;
    const num = Number(raw);
    if (raw !== "" && Number.isFinite(num)) return num;
    // Strip surrounding quotes
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        return raw.slice(1, -1);
    }
    return raw;
}
