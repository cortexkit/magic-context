import { describe, expect, test } from "bun:test";
import { DEFAULT_DREAMER_TASKS, DREAMER_TASKS, DreamingTaskSchema } from "./magic-context";

describe("distill-skill-memory dreamer task", () => {
    test("distill-skill-memory is in DREAMER_TASKS enum", () => {
        expect(DREAMER_TASKS).toContain("distill-skill-memory");
    });

    test("distill-skill-memory is NOT in DEFAULT_DREAMER_TASKS (opt-in)", () => {
        expect(DEFAULT_DREAMER_TASKS).not.toContain("distill-skill-memory");
    });

    test("DreamingTaskSchema accepts distill-skill-memory", () => {
        expect(() => DreamingTaskSchema.parse("distill-skill-memory")).not.toThrow();
    });

    test("maintain-docs is also not in DEFAULT_DREAMER_TASKS (precedent)", () => {
        // Verify the existing asymmetry pattern we're following
        expect(DEFAULT_DREAMER_TASKS).not.toContain("maintain-docs");
        expect(DREAMER_TASKS).toContain("maintain-docs");
    });
});
