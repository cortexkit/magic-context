/**
 * Injects an optional `intent` parameter into the `skill` tool's schema.
 * Called from the `tool.definition` hook.
 *
 * opencode advertises the model-facing schema for a tool via
 *   fromTool = tool.jsonSchema ?? fromSchema(tool.parameters)
 * The `output` of the `tool.definition` hook has shape
 *   { description, parameters: <Effect Schema.Decoder>, jsonSchema: <JSONSchema7 | undefined> }.
 *
 * For the `skill` tool:
 *   - `output.parameters` is an Effect Schema (a Decoder object) — not a plain JSON Schema.
 *     Mutating `.properties.intent` on it is a no-op for the model-facing schema.
 *   - `output.jsonSchema` is currently `undefined` (the skill tool never sets it and
 *     `Tool.define` does not synthesize one), so opencode derives the model-facing
 *     schema from the Effect `parameters` — which only has `name`. Our mutation is
 *     invisible to the model. The model sees a `skill` tool with ONLY `name`.
 *
 * The fix: ASSIGN `output.jsonSchema` with a JSON Schema object that mirrors the
 * skill tool's real params (a single required `name` string) plus the optional
 * `intent`. This makes `output.jsonSchema !== tool.jsonSchema` (the new reference
 * satisfies opencode's registry gate `output.parameters === tool.parameters ||
 * output.jsonSchema !== tool.jsonSchema`), so the new schema is what opencode
 * advertises to the model. We deliberately leave `output.parameters` untouched
 * — the Effect schema still governs execute-time validation, which strips
 * `intent` via `onExcessProperty: "ignore"` so the existing `tool.execute.before`
 * capture path keeps working unchanged.
 *
 * If a future opencode version starts precomputing a `jsonSchema` for the skill
 * tool, we extend it in place rather than clobbering it.
 *
 * Lives here (not in index.ts) to avoid leaking an internal helper through the
 * plugin entry point. index.ts imports and calls it directly.
 */
export function injectSkillIntentParam(
    toolID: string,
    output: {
        parameters?: unknown;
        jsonSchema?: {
            type?: string;
            properties?: Record<string, unknown>;
            required?: string[];
            additionalProperties?: boolean;
        };
    },
): void {
    if (toolID !== "skill") return;
    const INTENT_PROP = {
        type: "string",
        description:
            "Optional: describe what you are trying to accomplish with this skill (used for skill-memory recall). E.g. 'fix a flaky test in the auth module'.",
    };
    // Forward-compat + idempotency: if opencode (a future version) already provides a
    // jsonSchema object, extend it in place rather than clobbering it.
    const existing = output.jsonSchema;
    if (
        existing &&
        typeof existing === "object" &&
        existing.properties &&
        typeof existing.properties === "object"
    ) {
        if (!("intent" in existing.properties)) {
            existing.properties.intent = INTENT_PROP;
        }
        return;
    }
    // Current opencode: the skill tool has no precomputed jsonSchema (undefined), so opencode
    // would derive the model-facing schema from the Effect `parameters` (name only). Construct
    // a jsonSchema mirroring the skill tool's real params (name, required) PLUS the optional intent.
    output.jsonSchema = {
        type: "object",
        properties: {
            name: {
                type: "string",
                description: "The name of the skill from available_skills",
            },
            intent: INTENT_PROP,
        },
        required: ["name"],
        additionalProperties: false,
    };
}
