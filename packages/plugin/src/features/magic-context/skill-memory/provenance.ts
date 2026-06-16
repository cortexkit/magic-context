import { fileURLToPath } from "node:url";

export interface SkillProvenance {
    resolvedPath: string;
    tier: "project" | "global";
    skillSource: "opencode-project" | "opencode-global" | "claude-skills" | "agents-skills";
    skillId: string;
    loadedAt: number;
}

// Matches: "Base directory for this skill: file:///abs/path/to/skill/dir"
// Uses fileURLToPath (not naive regex capture) for cross-platform correctness.
const BASE_DIR_REGEX = /Base directory for this skill: (file:\/\/\/[^\n\r]+)/m;

export function parseSkillProvenance(output: string, skillId: string): SkillProvenance | null {
    const match = output.match(BASE_DIR_REGEX);
    if (!match) return null;

    const fileUrl = match[1].trim();
    let absDir: string;
    try {
        absDir = fileURLToPath(new URL(fileUrl));
    } catch {
        return null;
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
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    if (
        absDir.startsWith(`${home}/.config/opencode/skills/`) ||
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
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    if (absDir.startsWith(`${home}/.config/opencode/skills/`)) return "opencode-global";
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
