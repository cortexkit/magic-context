import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseSkillProvenance, resolveSkillPathByName } from "./provenance";

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

describe("resolveSkillPathByName", () => {
    let projectDir: string;
    let skillDir: string;

    beforeAll(() => {
        projectDir = `${tmpdir()}/skill-resolve-test-${Date.now()}`;
        skillDir = `${projectDir}/.opencode/skills/test-skill`;
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
            `${skillDir}/SKILL.md`,
            "---\nskill-memory:\n  enabled: true\n---\n\n# Test Skill\n",
        );
    });

    afterAll(() => {
        rmSync(projectDir, { recursive: true, force: true });
    });

    test("finds a project-local skill on disk", () => {
        const result = resolveSkillPathByName("test-skill", projectDir);
        expect(result).not.toBeNull();
        expect(result!.resolvedPath).toBe(`${skillDir}/SKILL.md`);
        expect(result!.tier).toBe("project");
        expect(result!.skillSource).toBe("opencode-project");
    });

    test("returns null when no SKILL.md exists for the name", () => {
        const result = resolveSkillPathByName("nonexistent-skill", projectDir);
        expect(result).toBeNull();
    });

    test("returns null for empty project dir (no skill dirs)", () => {
        const emptyDir = `${tmpdir()}/skill-resolve-empty-${Date.now()}`;
        mkdirSync(emptyDir, { recursive: true });
        try {
            const result = resolveSkillPathByName("any-skill", emptyDir);
            expect(result).toBeNull();
        } finally {
            rmSync(emptyDir, { recursive: true, force: true });
        }
    });

    test("project shadows global when both contain same-named skill", () => {
        // Override HOME to a tmpdir that simulates global skill dirs.
        const savedHome = process.env.HOME;
        const globalHome = `${tmpdir()}/skill-resolve-global-home-${Date.now()}`;
        const projectDir = `${tmpdir()}/skill-resolve-proj-${Date.now()}`;
        try {
            // Global: ~/.config/opencode/skills/shadow-skill/SKILL.md
            const globalSkillDir = `${globalHome}/.config/opencode/skills/shadow-skill`;
            mkdirSync(globalSkillDir, { recursive: true });
            writeFileSync(`${globalSkillDir}/SKILL.md`, "---\n---\n\n# Global shadow\n");
            // Project: .opencode/skills/shadow-skill/SKILL.md
            const projectSkillDir = `${projectDir}/.opencode/skills/shadow-skill`;
            mkdirSync(projectSkillDir, { recursive: true });
            writeFileSync(`${projectSkillDir}/SKILL.md`, "---\n---\n\n# Project shadow\n");

            process.env.HOME = globalHome;
            const result = resolveSkillPathByName("shadow-skill", projectDir);
            expect(result).not.toBeNull();
            // Project-first ordering: project path wins, not global
            expect(result!.resolvedPath).toBe(`${projectSkillDir}/SKILL.md`);
            expect(result!.tier).toBe("project");
        } finally {
            process.env.HOME = savedHome;
            rmSync(globalHome, { recursive: true, force: true });
            rmSync(projectDir, { recursive: true, force: true });
        }
    });

    test("handles singular .opencode/skill/ path (project tier)", () => {
        const dir = `${projectDir}/.opencode/skill/singular-skill`;
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${dir}/SKILL.md`, "---\n---\n\n# Singular\n");
        try {
            const result = resolveSkillPathByName("singular-skill", projectDir);
            expect(result).not.toBeNull();
            expect(result!.resolvedPath).toBe(`${dir}/SKILL.md`);
            expect(result!.tier).toBe("project");
            expect(result!.skillSource).toBe("opencode-project");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("handles project .claude/skills/ path (project tier)", () => {
        // deriveSkillSource uses startsWith(HOME/.claude/skills/) — only global
        // claude paths get skillSource="claude-skills". Project-local .claude/skills/
        // fall through to the default "opencode-project".
        const dir = `${projectDir}/.claude/skills/claude-proj-skill`;
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${dir}/SKILL.md`, "---\n---\n\n# Claude project\n");
        try {
            const result = resolveSkillPathByName("claude-proj-skill", projectDir);
            expect(result).not.toBeNull();
            expect(result!.resolvedPath).toBe(`${dir}/SKILL.md`);
            expect(result!.tier).toBe("project");
            expect(result!.skillSource).toBe("opencode-project");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("handles global ~/.claude/skills/ path (global tier, claude-skills source)", () => {
        const savedHome = process.env.HOME;
        const globalHome = `${tmpdir()}/skill-resolve-claude-global-${Date.now()}`;
        try {
            const dir = `${globalHome}/.claude/skills/claude-global-skill`;
            mkdirSync(dir, { recursive: true });
            writeFileSync(`${dir}/SKILL.md`, "---\n---\n\n# Claude global\n");

            process.env.HOME = globalHome;
            const result = resolveSkillPathByName("claude-global-skill", "/tmp/nonexistent");
            expect(result).not.toBeNull();
            expect(result!.resolvedPath).toBe(`${dir}/SKILL.md`);
            expect(result!.tier).toBe("global");
            expect(result!.skillSource).toBe("claude-skills");
        } finally {
            process.env.HOME = savedHome;
            rmSync(globalHome, { recursive: true, force: true });
        }
    });

    test("handles global ~/.config/opencode/skill/ (singular) path", () => {
        const savedHome = process.env.HOME;
        const globalHome = `${tmpdir()}/skill-resolve-singular-global-${Date.now()}`;
        try {
            const dir = `${globalHome}/.config/opencode/skill/singular-global-skill`;
            mkdirSync(dir, { recursive: true });
            writeFileSync(`${dir}/SKILL.md`, "---\n---\n\n# Singular global\n");

            process.env.HOME = globalHome;
            const result = resolveSkillPathByName("singular-global-skill", "/tmp/nonexistent");
            expect(result).not.toBeNull();
            expect(result!.resolvedPath).toBe(`${dir}/SKILL.md`);
            expect(result!.tier).toBe("global");
            expect(result!.skillSource).toBe("opencode-global");
        } finally {
            process.env.HOME = savedHome;
            rmSync(globalHome, { recursive: true, force: true });
        }
    });
});
