import { existsSync } from "node:fs";
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

/**
 * Name-based skill-path resolution — walks known skill directories in opencode
 * discovery order, returning the first match. This is the cold-start fallback
 * when the "Base directory for this skill:" provenance line is absent or
 * truncated from the skill tool output (MAX_BYTES=51200 cutoff).
 *
 * Search order matches opencode's `discoverSkills()`:
 *   - Project-dir ancestors first (project shadows global — finding U3).
 *     When `projectDirectory` is non-null, walks UP the ancestor chain from
 *     that directory (each level checking the 4 project patterns in order —
 *     nearest dir first), stopping at the worktree root (a `.git` entry),
 *     $HOME (exclusive), or the filesystem root, whichever comes first.
 *     The worktree root level is inclusive — skills at the git root are
 *     discoverable from any subdirectory. No fixed depth cap; the loop
 *     terminates naturally when it hits a boundary.
 *   - Global dirs second (always checked, regardless of projectDirectory).
 *
 * When `projectDirectory` is null, project-tier candidates are SKIPPED
 * entirely — only global dirs are searched. Callers should pass null when
 * the directory is a guess (e.g. Desktop-launched session without an
 * authoritative sessionDirectoryBySession entry); a wrong dir could resolve
 * a same-named project skill and poison the registry.
 *
 * Does NOT read SKILL.md content — callers are responsible for their own
 * frontmatter parsing.
 */
export function resolveSkillPathByName(
    skillName: string,
    projectDirectory: string | null,
): {
    resolvedPath: string;
    tier: "project" | "global";
    skillSource: SkillProvenance["skillSource"];
} | null {
    const home = (process.env.HOME ?? process.env.USERPROFILE ?? "").replace(/\\/g, "/");
    const projectPatterns = [
        ".opencode/skill",
        ".opencode/skills",
        ".agents/skills",
        ".claude/skills",
    ] as const;
    const globalDirs = [
        `${home}/.config/opencode/skills/${skillName}`, // Global.Path.config + {skill,skills}/**/SKILL.md
        `${home}/.config/opencode/skill/${skillName}`, // singular — OPENCODE_SKILL_PATTERN covers both
        `${home}/.agents/skills/${skillName}`, // AGENTS_EXTERNAL_DIR
        `${home}/.claude/skills/${skillName}`, // CLAUDE_EXTERNAL_DIR
    ];

    // ── Project-tier ancestor walk ──────────────────────────────────────
    if (projectDirectory !== null) {
        const normalizedHome = home.endsWith("/") ? home.slice(0, -1) : home;
        let current = projectDirectory;
        while (current.length > 0) {
            // Stop at $HOME (exclusive) or filesystem root (absolute backstops)
            if (current === normalizedHome || current === "/") break;

            for (const pat of projectPatterns) {
                const dir = `${current}/${pat}/${skillName}`;
                const candidate = `${dir}/SKILL.md`;
                if (existsSync(candidate)) {
                    return {
                        resolvedPath: candidate,
                        tier: deriveSkillTier(dir),
                        skillSource: deriveSkillSource(dir),
                    };
                }
            }

            // Stop at the worktree root (detected by presence of .git).
            // Check AFTER patterns above so the worktree root level is inclusive.
            if (existsSync(`${current}/.git`)) break;

            // Walk up: strip last path segment (or empty string if none left)
            const sep = current.lastIndexOf("/");
            current = sep > 0 ? current.slice(0, sep) : "";
        }
    }

    // ── Global dirs (always checked) ────────────────────────────────────
    for (const dir of globalDirs) {
        const candidate = `${dir}/SKILL.md`;
        if (existsSync(candidate)) {
            return {
                resolvedPath: candidate,
                tier: deriveSkillTier(dir),
                skillSource: deriveSkillSource(dir),
            };
        }
    }

    return null;
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
