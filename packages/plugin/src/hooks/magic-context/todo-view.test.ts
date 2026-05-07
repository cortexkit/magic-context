/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { normalizeTodoStateJson, renderTodoBlock } from "./todo-view";

describe("todo-view", () => {
    test("empty list renders null", () => {
        expect(renderTodoBlock("[]")).toBeNull();
    });

    test("all terminal todos render null", () => {
        expect(
            renderTodoBlock(
                JSON.stringify([
                    { content: "Done", status: "completed", priority: "high" },
                    { content: "Skipped", status: "cancelled", priority: "low" },
                ]),
            ),
        ).toBeNull();
    });

    test("mixed states render active todos", () => {
        expect(
            renderTodoBlock(
                JSON.stringify([
                    { content: "Implement v3.3.1 backfill", status: "in_progress", priority: "high" },
                    { content: "Already done", status: "completed", priority: "medium" },
                    { content: "Review audit findings", status: "pending", priority: "medium" },
                    { content: "Cut release", status: "pending", priority: "low" },
                ]),
            ),
        ).toBe(
            "\n\n<current-todos>\n- [in_progress] Implement v3.3.1 backfill\n- [pending] Review audit findings\n- [pending] Cut release\n</current-todos>",
        );
    });

    test("malformed JSON renders null", () => {
        expect(renderTodoBlock("not-json")).toBeNull();
    });

    test("XML-escapes todo content", () => {
        expect(
            renderTodoBlock(
                JSON.stringify([
                    {
                        content: "Review <current-todos> & close > stale items",
                        status: "pending",
                        priority: "high",
                    },
                ]),
            ),
        ).toBe(
            "\n\n<current-todos>\n- [pending] Review &lt;current-todos&gt; &amp; close &gt; stale items\n</current-todos>",
        );
    });

    test("unknown statuses are treated as active", () => {
        expect(
            renderTodoBlock(
                JSON.stringify([{ content: "Custom state", status: "blocked", priority: "high" }]),
            ),
        ).toContain("- [blocked] Custom state");
    });

    test("normalizes state to stable field order", () => {
        expect(
            normalizeTodoStateJson([
                { status: "pending", priority: "high", content: "First", extra: true },
            ]),
        ).toBe('[{"content":"First","status":"pending","priority":"high"}]');
    });

    test("normalization rejects malformed todo arrays", () => {
        expect(normalizeTodoStateJson([{ content: "Missing priority", status: "pending" }])).toBeNull();
    });
});
