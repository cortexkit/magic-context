import { describe, expect, test } from "bun:test";
import { parseFrontmatterConfig } from "./frontmatter";

describe("parseFrontmatterConfig", () => {
    test("returns null when no frontmatter present", () => {
        expect(parseFrontmatterConfig("# Skill\nNo frontmatter here.")).toBeNull();
    });

    test("returns null when frontmatter has no skill-memory block", () => {
        const content = `---\ntitle: My Skill\n---\n# Skill`;
        expect(parseFrontmatterConfig(content)).toBeNull();
    });

    test("returns null when skill-memory.enabled is false or absent", () => {
        const content = `---\nskill-memory:\n  enabled: false\n---\n# Skill`;
        expect(parseFrontmatterConfig(content)).toBeNull();
    });

    test("returns config when skill-memory.enabled is true", () => {
        const content = `---\nskill-memory:\n  enabled: true\n  max_tokens: 2000\n  dedup_threshold: 0.88\n---\n# Skill`;
        const config = parseFrontmatterConfig(content);
        expect(config).not.toBeNull();
        expect(config!.enabled).toBe(true);
        expect(config!.max_tokens).toBe(2000);
        expect(config!.dedup_threshold).toBe(0.88);
    });

    test("uses defaults when optional fields are absent", () => {
        const content = `---\nskill-memory:\n  enabled: true\n---\n# Skill`;
        const config = parseFrontmatterConfig(content);
        expect(config!.max_tokens).toBe(1500);
        expect(config!.max_pinned_tokens).toBe(4000);
        expect(config!.dedup_threshold).toBe(0.92);
    });

    test("returns null on malformed YAML (non-choke)", () => {
        const content = `---\nskill-memory:\n  enabled: [invalid yaml\n---\n# Skill`;
        // Must not throw — malformed config = inert
        expect(() => parseFrontmatterConfig(content)).not.toThrow();
        expect(parseFrontmatterConfig(content)).toBeNull();
    });

    test("returns null when skill-memory block is not an object", () => {
        const content = `---\nskill-memory: true\n---\n# Skill`;
        expect(parseFrontmatterConfig(content)).toBeNull();
    });
});
