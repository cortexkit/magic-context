import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeTodoStateJson } from "../hooks/magic-context/todo-view";
import {
    isSuccessfulProviderCompletion,
    providerResponseFailed,
} from "./provider-response-completion";

// These saved cases distinguish failed model-provider replies from successful
// ones and convert supported todo lists into the same JSON representation.
// Their expected values do not depend on how external model runners encode messages.
function fixture<T>(name: string): T {
    return JSON.parse(
        readFileSync(resolve(import.meta.dir, `../../test-fixtures/runtime/${name}`), "utf8"),
    ) as T;
}

describe("standalone completion and todo policy fixtures", () => {
    it("classifies provider responses against the committed usage oracle", () => {
        const vectors = fixture<{
            response_completion: Array<{
                label: string;
                finish: string | null;
                error: boolean;
                completed_at: number | null;
                failed: boolean;
                successful: boolean;
            }>;
        }>("runner-usage-policy-vectors.json");
        expect(vectors.response_completion.length).toBeGreaterThan(0);
        for (const vector of vectors.response_completion) {
            const input = {
                finish: vector.finish ?? undefined,
                error: vector.error ? { message: "provider error" } : undefined,
                completedAt: vector.completed_at ?? undefined,
            };
            expect(providerResponseFailed(input), vector.label).toBe(vector.failed);
            expect(isSuccessfulProviderCompletion(input), vector.label).toBe(vector.successful);
        }
    });

    it("normalizes the transcript's todowrite and the todo_state.set todos to the same state", () => {
        const todo = fixture<{
            todo_state_set: { todos: unknown };
            expected_state_json: string;
            transcript: Array<{
                message: {
                    content: Array<{
                        type: string;
                        tool_name?: string;
                        input?: { todos?: unknown };
                    }>;
                };
            }>;
        }>("runner-todo-transcript.json");
        expect(normalizeTodoStateJson(todo.todo_state_set.todos)).toBe(todo.expected_state_json);
        const call = todo.transcript
            .flatMap((entry) => entry.message.content)
            .find((block) => block.type === "tool_call" && block.tool_name === "todowrite");
        expect(call).toBeDefined();
        expect(normalizeTodoStateJson(call?.input?.todos)).toBe(todo.expected_state_json);
    });
});
