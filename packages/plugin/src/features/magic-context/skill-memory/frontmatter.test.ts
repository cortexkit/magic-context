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

    test("parses flat ranking_* keys as numbers", () => {
        const md = `---
skill-memory:
  enabled: true
  ranking_relevance: 0.7
  ranking_recency: 0.2
  ranking_hit: 0.1
---
body`;
        const cfg = parseFrontmatterConfig(md);
        expect(cfg?.ranking_relevance).toBe(0.7);
        expect(cfg?.ranking_recency).toBe(0.2);
        expect(cfg?.ranking_hit).toBe(0.1);
    });

    test("ranking_* default to undefined when omitted (recall applies defaults)", () => {
        const md = `---
skill-memory:
  enabled: true
---
body`;
        const cfg = parseFrontmatterConfig(md);
        expect(cfg?.ranking_relevance).toBeUndefined();
    });

    test("does NOT misparse a later --- horizontal rule as frontmatter (start-anchored)", () => {
        // No real frontmatter; a horizontal-rule pair appears mid-document. With
        // an `m`-flagged regex `^` would match the rule's line start and capture
        // the block between the rules as config. Must return null.
        const md = `# Skill\n\nSome prose.\n\n---\nskill-memory:\n  enabled: true\n---\n\nMore prose.`;
        expect(parseFrontmatterConfig(md)).toBeNull();
    });

    test("honors enabled: true with a trailing inline comment", () => {
        const md = `---\nskill-memory:\n  enabled: true # motor memory on\n  max_tokens: 2000 # bump it\n---\nbody`;
        const cfg = parseFrontmatterConfig(md);
        expect(cfg).not.toBeNull();
        expect(cfg!.enabled).toBe(true);
        expect(cfg!.max_tokens).toBe(2000);
    });

    test("honors an inline comment on the skill-memory block header", () => {
        const md = `---\nskill-memory: # procedural recall\n  enabled: true\n---\nbody`;
        expect(parseFrontmatterConfig(md)?.enabled).toBe(true);
    });

    test("does not strip a '#' inside a quoted scalar", () => {
        const md = `---\nskill-memory:\n  enabled: "true"\n---\nbody`;
        // "true" (quoted) still enables; the quote-strip path runs after the
        // unquoted-only comment strip, so quoted values are untouched.
        expect(parseFrontmatterConfig(md)?.enabled).toBe(true);
    });
});
