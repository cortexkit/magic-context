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
});
