import { describe, expect, test } from "bun:test";

// Test the intent injection logic in isolation (pure function).
// Import from the dedicated module, not from index.ts (which is the plugin entry point).
import { injectSkillIntentParam } from "./skill-tool-definition";

type OutputShape = Parameters<typeof injectSkillIntentParam>[1];

describe("skill tool definition intent injection", () => {
    test("assigns output.jsonSchema for the skill tool (current opencode: jsonSchema starts undefined)", () => {
        const output: OutputShape = {
            description: "Load a specialized skill",
            parameters: {}, // Effect Schema — opencode's tool.definition hook passes this; we leave it alone
            jsonSchema: undefined,
        };
        injectSkillIntentParam("skill", output);
        // New contract: opencode advertises the model-facing schema from
        // `output.jsonSchema ?? fromSchema(output.parameters)`. The skill
        // tool's `jsonSchema` is currently undefined, so we MUST assign one.
        expect(output.jsonSchema).toBeDefined();
        const js = output.jsonSchema as NonNullable<OutputShape["jsonSchema"]>;
        expect(js.type).toBe("object");
        expect(js.properties).toBeDefined();
        // Mirrors the skill tool's real param: a single required `name` string.
        expect(js.properties.name).toBeDefined();
        expect((js.properties.name as { type?: string }).type).toBe("string");
        // The injected `intent` is present and is a string.
        expect(js.properties.intent).toBeDefined();
        expect((js.properties.intent as { type?: string }).type).toBe("string");
        // `name` is required; `intent` is optional.
        expect(js.required).toEqual(["name"]);
        expect(js.required).not.toContain("intent");
    });

    test("does not touch output.jsonSchema for non-skill tool ids", () => {
        const output: OutputShape = {
            description: "Read a file",
            parameters: {},
            jsonSchema: undefined,
        };
        injectSkillIntentParam("read", output);
        expect(output.jsonSchema).toBeUndefined();
    });

    test("extends an existing output.jsonSchema in place (forward-compat)", () => {
        const output: OutputShape = {
            description: "Skill",
            parameters: {},
            jsonSchema: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "The name of the skill from available_skills",
                    },
                },
                required: ["name"],
            },
        };
        injectSkillIntentParam("skill", output);
        const js = output.jsonSchema as NonNullable<OutputShape["jsonSchema"]>;
        // Preserves the existing properties (does not clobber `name`).
        expect(js.properties.name).toBeDefined();
        expect((js.properties.name as { type?: string }).type).toBe("string");
        // Adds `intent` alongside.
        expect(js.properties.intent).toBeDefined();
        expect((js.properties.intent as { type?: string }).type).toBe("string");
        // Required list untouched.
        expect(js.required).toEqual(["name"]);
    });

    test("is idempotent — calling twice does not double-add intent", () => {
        const output: OutputShape = {
            description: "Skill",
            parameters: {},
            jsonSchema: undefined,
        };
        injectSkillIntentParam("skill", output);
        const first = JSON.stringify(output.jsonSchema);
        injectSkillIntentParam("skill", output);
        const second = JSON.stringify(output.jsonSchema);
        expect(second).toBe(first);
        const js = output.jsonSchema as NonNullable<OutputShape["jsonSchema"]>;
        const intentKeys = Object.keys(js.properties).filter((k) => k === "intent");
        expect(intentKeys.length).toBe(1);
    });

    test("intent description mentions skill-memory recall (drives the recall surface)", () => {
        const output: OutputShape = {
            description: "Skill",
            parameters: {},
            jsonSchema: undefined,
        };
        injectSkillIntentParam("skill", output);
        const js = output.jsonSchema as NonNullable<OutputShape["jsonSchema"]>;
        const desc = (js.properties.intent as { description?: string }).description ?? "";
        expect(desc).toContain("skill-memory recall");
    });
});
