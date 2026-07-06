import { fileURLToPath } from "node:url";

export interface SkillProvenance {
    resolvedPath: string;
    tier: "project" | "global";
    skillSource: "opencode-project" | "opencode-global" | "claude-skills" | "agents-skills";
    skillId: string;
    loadedAt: number;
}

// Matches: "Base directory for this skill: <path-or-file-url>"
// opencode #33580 changed the emit from a file:// URL to a PLAIN filesystem
// path, so we accept BOTH forms. Anchored to line-start (^…/gm) + last-match:
// opencode appends this provenance line at the END of the tool output, so if
// the skill's own CONTENT contains the phrase at column 0, last-match ensures
// the real trailing line wins; line-anchoring rejects mid-prose mentions.
const BASE_DIR_REGEX = /^Base directory for this skill: (.+)$/gm;

export function parseSkillProvenance(output: string, skillId: string): SkillProvenance | null {
    const matches = [...output.matchAll(BASE_DIR_REGEX)];
    if (matches.length === 0) return null;

    const raw = matches[matches.length - 1][1].trim();
    if (!raw) return null;

    let absDir: string;
    if (raw.startsWith("file://")) {
        // Legacy opencode (pre-#33580) emitted a file:// URL. Use fileURLToPath
        // (not naive slice) for cross-platform + percent-decoding correctness.
        try {
            absDir = fileURLToPath(new URL(raw)).replace(/\\/g, "/");
        } catch {
            return null;
        }
    } else {
        // Current opencode (#33580) emits a plain filesystem path. Normalize
        // OS-native backslashes to forward slashes so the tier/source
        // startsWith/includes checks below match on every platform.
        absDir = raw.replace(/\\/g, "/");
    }

    const resolvedPath = `${absDir}/SKILL.md`;
    const tier = deriveSkillTier(absDir);
    const skillSource = deriveSkillSource(absDir);

    return { resolvedPath, tier, skillSource, skillId, loadedAt: Date.now() };
}

export function deriveSkillTier(absDir: string): "project" | "global" {
    // Global dirs (discovered via Global.Path.config or EXTERNAL_DIR constants):
    //   ~/.config/opencode/skills/ — via config.directories() + {skill,skills}/**/SKILL.md
    //   ~/.agents/skills/          — via AGENTS_EXTERNAL_DIR + skills/**/SKILL.md
    //   ~/.claude/skills/          — via CLAUDE_EXTERNAL_DIR + skills/**/SKILL.md
    const home = (process.env.HOME ?? process.env.USERPROFILE ?? "").replace(/\\/g, "/");
    if (
        // opencode's OPENCODE_SKILL_PATTERN is `{skill,skills}/**/SKILL.md`, so
        // the global config dir resolves under BOTH singular and plural.
        absDir.startsWith(`${home}/.config/opencode/skills/`) ||
        absDir.startsWith(`${home}/.config/opencode/skill/`) ||
        absDir.startsWith(`${home}/.agents/skills/`) ||
        absDir.startsWith(`${home}/.claude/skills/`)
    ) {
        return "global";
    }
    return "project";
}

export function deriveSkillSource(
    absDir: string,
): "opencode-project" | "opencode-global" | "claude-skills" | "agents-skills" {
    const home = (process.env.HOME ?? process.env.USERPROFILE ?? "").replace(/\\/g, "/");
    if (
        absDir.startsWith(`${home}/.config/opencode/skills/`) ||
        absDir.startsWith(`${home}/.config/opencode/skill/`)
    )
        return "opencode-global";
    if (absDir.startsWith(`${home}/.claude/skills/`)) return "claude-skills";
    if (absDir.includes("/.agents/skills/")) return "agents-skills";
    // Both singular .opencode/skill/ and plural .opencode/skills/ are valid —
    // opencode's OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md" covers both.
    if (absDir.includes("/.opencode/skill/") || absDir.includes("/.opencode/skills/")) {
        return "opencode-project";
    }
    return "opencode-project"; // default for unknown project-local paths
}

// ── Session-scoped skill-load registry ─────────────────────────────────────
// Key: `${sessionId}:${skillId}` — populated in tool.execute.after when
// input.tool === "skill". Cleaned up in onSessionDeleted.
// NOT persisted. No leak.

export type SkillLoadRegistry = Map<
    string,
    SkillProvenance & { frontmatterConfig: import("./frontmatter").SkillMemoryConfig | null }
>;

export function createSkillLoadRegistry(): SkillLoadRegistry {
    return new Map();
}

export function registryKey(sessionId: string, skillId: string): string {
    return `${sessionId}:${skillId}`;
}

export function getSkillLoad(
    registry: SkillLoadRegistry,
    sessionId: string,
    skillId: string,
):
    | (SkillProvenance & {
          frontmatterConfig: import("./frontmatter").SkillMemoryConfig | null;
      })
    | undefined {
    return registry.get(registryKey(sessionId, skillId));
}
