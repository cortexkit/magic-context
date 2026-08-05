import { describe, expect, test } from "bun:test";
import {
    AGENTIC_DREAM_TASKS,
    CANONICAL_DREAM_TASKS,
} from "../../features/magic-context/dreamer/task-registry";
import { DreamTasksSchema } from "./magic-context";

describe("distill-skill-memory dreamer task", () => {
    test("distill-skill-memory is a canonical dream task", () => {
        expect(CANONICAL_DREAM_TASKS).toContain("distill-skill-memory");
    });

    test("distill-skill-memory is agentic (prompt-driven)", () => {
        expect(AGENTIC_DREAM_TASKS).toContain("distill-skill-memory");
    });

    test("DreamTasksSchema accepts a distill-skill-memory config", () => {
        // v2 model: tasks are per-key objects on DreamTasksSchema, not a string
        // enum. Validity is "the key parses with a schedule", not enum membership.
        const parsed = DreamTasksSchema.parse({
            "distill-skill-memory": { schedule: "0 4 * * *" },
        });
        expect(parsed["distill-skill-memory"].schedule).toBe("0 4 * * *");
    });

    test("distill-skill-memory defaults to OFF (empty schedule = opt-in)", () => {
        // v2 model: a task is opt-in when its default schedule is "" (disabled).
        // Parse an explicit tasks object so the per-key defaults fire.
        const parsed = DreamTasksSchema.parse({});
        expect(parsed["distill-skill-memory"].schedule).toBe("");
    });

    test("maintain-docs is also opt-in (empty default schedule) — precedent", () => {
        const parsed = DreamTasksSchema.parse({});
        expect(parsed["maintain-docs"].schedule).toBe("");
    });
});
