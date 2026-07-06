import { describe, expect, test } from "bun:test";
import { parseSkillProvenance } from "./provenance";

// Build fixture paths from process.env.HOME to avoid hardcoded /home/icetea paths
// that break on Mac, CI, or root environments.
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "/home/user";

describe("parseSkillProvenance", () => {
    test("parses Base directory line from skill output (global skill)", () => {
        const output = `# Skill Content\nSome content here.\nBase directory for this skill: file://${HOME}/.config/opencode/skills/trilium`;
        const result = parseSkillProvenance(output, "trilium");
        expect(result).not.toBeNull();
        expect(result!.resolvedPath).toBe(`${HOME}/.config/opencode/skills/trilium/SKILL.md`);
        expect(result!.tier).toBe("global");
        expect(result!.skillSource).toBe("opencode-global");
    });

    test("parses Base directory line from skill output (project skill)", () => {
        const output = `# Skill Content\nBase directory for this skill: file://${HOME}/projects/magic-context/.agents/skills/find-docs`;
        const result = parseSkillProvenance(output, "find-docs");
        expect(result).not.toBeNull();
        expect(result!.resolvedPath).toBe(
            `${HOME}/projects/magic-context/.agents/skills/find-docs/SKILL.md`,
        );
        expect(result!.tier).toBe("project");
        expect(result!.skillSource).toBe("agents-skills");
    });

    test("returns null when Base directory line is absent", () => {
        const output = "# Skill Content\nNo base directory line here.";
        expect(parseSkillProvenance(output, "some-skill")).toBeNull();
    });

    test("handles ~/.claude/skills/ as global tier", () => {
        const output = `Base directory for this skill: file://${HOME}/.claude/skills/my-skill`;
        const result = parseSkillProvenance(output, "my-skill");
        expect(result!.tier).toBe("global");
        expect(result!.skillSource).toBe("claude-skills");
    });

    test("handles ~/.agents/skills/ as global tier", () => {
        const output = `Base directory for this skill: file://${HOME}/.agents/skills/my-skill`;
        const result = parseSkillProvenance(output, "my-skill");
        expect(result!.tier).toBe("global");
        expect(result!.skillSource).toBe("agents-skills");
    });

    test("handles .opencode/skills/ as project tier", () => {
        const output = `Base directory for this skill: file://${HOME}/projects/foo/.opencode/skills/my-skill`;
        const result = parseSkillProvenance(output, "my-skill");
        expect(result!.tier).toBe("project");
        expect(result!.skillSource).toBe("opencode-project");
    });

    test("handles the SINGULAR ~/.config/opencode/skill/ global path (OPENCODE_SKILL_PATTERN covers both)", () => {
        // Regression: opencode's pattern is {skill,skills}/**/SKILL.md, so the
        // global config dir resolves under singular `skill/` too. Before the fix,
        // deriveSkillTier classified it as project → notes written to the wrong
        // partition + cold recall couldn't find SKILL.md.
        const output = `Base directory for this skill: file://${HOME}/.config/opencode/skill/my-skill`;
        const result = parseSkillProvenance(output, "my-skill");
        expect(result!.tier).toBe("global");
        expect(result!.skillSource).toBe("opencode-global");
    });

    test("handles the plural ~/.config/opencode/skills/ global path", () => {
        const output = `Base directory for this skill: file://${HOME}/.config/opencode/skills/my-skill`;
        const result = parseSkillProvenance(output, "my-skill");
        expect(result!.tier).toBe("global");
        expect(result!.skillSource).toBe("opencode-global");
    });

    test("takes the LAST line-anchored match when skill CONTENT echoes the marker phrase", () => {
        // A skill that documents skill-memory itself could contain the marker
        // phrase in its body. opencode appends the REAL provenance line last, so
        // last-match must win — a first-match parse would resolve the bogus URL.
        const output =
            `# Skill: skill-memory internals\n` +
            `Example: Base directory for this skill: file:///decoy/path/evil-skill\n` +
            `more prose\n` +
            `Base directory for this skill: file://${HOME}/.config/opencode/skills/real-skill`;
        const result = parseSkillProvenance(output, "real-skill");
        expect(result!.resolvedPath).toBe(`${HOME}/.config/opencode/skills/real-skill/SKILL.md`);
        expect(result!.tier).toBe("global");
    });

    test("ignores a mid-line (non-line-anchored) marker mention", () => {
        // "see the Base directory for this skill: file:///x" embedded mid-sentence
        // (not at column 0) must NOT be captured.
        const output = `Note: see the Base directory for this skill: file:///wrong/x for details.\nBase directory for this skill: file://${HOME}/.config/opencode/skills/right`;
        const result = parseSkillProvenance(output, "right");
        expect(result!.resolvedPath).toBe(`${HOME}/.config/opencode/skills/right/SKILL.md`);
    });

    test("parses a PLAIN filesystem path (opencode #33580 — no file:// prefix)", () => {
        const output = `# Skill: council\nsome content\nBase directory for this skill: ${HOME}/.config/opencode/skills/council`;
        const result = parseSkillProvenance(output, "council");
        expect(result).not.toBeNull();
        expect(result!.resolvedPath).toBe(`${HOME}/.config/opencode/skills/council/SKILL.md`);
        expect(result!.tier).toBe("global");
        expect(result!.skillSource).toBe("opencode-global");
    });

    test("parses a PLAIN filesystem path for a PROJECT skill", () => {
        const output = `Base directory for this skill: ${HOME}/projects/foo/.opencode/skills/my-skill`;
        const result = parseSkillProvenance(output, "my-skill");
        expect(result!.resolvedPath).toBe(
            `${HOME}/projects/foo/.opencode/skills/my-skill/SKILL.md`,
        );
        expect(result!.tier).toBe("project");
        expect(result!.skillSource).toBe("opencode-project");
    });

    test("takes the LAST match with a plain-path decoy followed by the real plain line", () => {
        const output =
            `# Skill: skill-memory internals\n` +
            `Example: Base directory for this skill: /decoy/evil\n` +
            `more prose\n` +
            `Base directory for this skill: ${HOME}/.config/opencode/skills/real`;
        const result = parseSkillProvenance(output, "real");
        expect(result!.resolvedPath).toBe(`${HOME}/.config/opencode/skills/real/SKILL.md`);
    });

    test("ignores a mid-line (non-line-anchored) plain-path mention", () => {
        const output = `Note: see Base directory for this skill: /wrong/x for details.\nBase directory for this skill: ${HOME}/.config/opencode/skills/right`;
        const result = parseSkillProvenance(output, "right");
        expect(result!.resolvedPath).toBe(`${HOME}/.config/opencode/skills/right/SKILL.md`);
    });
});
