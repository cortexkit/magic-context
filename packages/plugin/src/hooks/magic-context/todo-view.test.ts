import { describe, expect, it } from "bun:test";
import {
    buildSyntheticTodoPart,
    computeSyntheticCallId,
    isSyntheticTodoPart,
    normalizeTodoStateJson,
} from "./todo-view";

describe("normalizeTodoStateJson", () => {
    it("returns null for non-array input", () => {
        expect(normalizeTodoStateJson(null)).toBeNull();
        expect(normalizeTodoStateJson(undefined)).toBeNull();
        expect(normalizeTodoStateJson("not an array")).toBeNull();
        expect(normalizeTodoStateJson({ todos: [] })).toBeNull();
    });

    it("returns empty array JSON for empty input", () => {
        expect(normalizeTodoStateJson([])).toBe("[]");
    });

    it("preserves todos with all required fields and order", () => {
        const todos = [
            { content: "First", status: "in_progress", priority: "high" },
            { content: "Second", status: "pending", priority: "medium" },
        ];
        const json = normalizeTodoStateJson(todos);
        expect(JSON.parse(json ?? "null")).toEqual(todos);
    });

    it("strips extra fields like id", () => {
        const todos = [{ id: "1", content: "Task", status: "pending", priority: "high" }];
        const json = normalizeTodoStateJson(todos);
        const parsed = JSON.parse(json ?? "null");
        expect(parsed).toEqual([{ content: "Task", status: "pending", priority: "high" }]);
        expect(parsed[0].id).toBeUndefined();
    });

    it("defaults missing priority to medium", () => {
        const json = normalizeTodoStateJson([{ content: "Task", status: "pending" }]);
        expect(JSON.parse(json ?? "null")).toEqual([
            { content: "Task", status: "pending", priority: "medium" },
        ]);
    });

    it("keeps custom status values such as blocked as written", () => {
        expect(normalizeTodoStateJson([{ content: "Waiting", status: "blocked" }])).toBe(
            '[{"content":"Waiting","status":"blocked","priority":"medium"}]',
        );
        expect(
            normalizeTodoStateJson([{ content: "Interop", status: "done", priority: "low" }]),
        ).toBe('[{"content":"Interop","status":"done","priority":"low"}]');
    });

    it("keeps custom priority values as written, including an empty one", () => {
        expect(
            normalizeTodoStateJson([{ content: "Urgent", status: "pending", priority: "urgent" }]),
        ).toBe('[{"content":"Urgent","status":"pending","priority":"urgent"}]');
        expect(
            normalizeTodoStateJson([{ content: "Unranked", status: "pending", priority: "" }]),
        ).toBe('[{"content":"Unranked","status":"pending","priority":""}]');
    });

    it("rejects items it can't read", () => {
        expect(normalizeTodoStateJson([{ content: "Empty status", status: "" }])).toBeNull();
        expect(normalizeTodoStateJson([{ content: "No status" }])).toBeNull();
        expect(normalizeTodoStateJson([{ content: 7, status: "pending" }])).toBeNull();
        expect(normalizeTodoStateJson([{ status: "pending" }])).toBeNull();
        expect(
            normalizeTodoStateJson([{ content: "Bad priority", status: "pending", priority: 7 }]),
        ).toBeNull();
        expect(
            normalizeTodoStateJson([{ content: "Null priority", status: "pending", priority: null }]),
        ).toBeNull();
        expect(normalizeTodoStateJson(["not an object"])).toBeNull();
    });

    it("keeps the JSON and call id of built-in lists byte-identical to earlier releases", () => {
        // Pinned from the release that accepted only the built-in values. Stored
        // snapshots and the synthetic call ids derived from them must not change.
        const json = normalizeTodoStateJson([
            { content: "Plan", status: "pending", priority: "high" },
            { content: "Build", status: "in_progress" },
            { content: "Ship", status: "completed", priority: "low", id: "x" },
            { content: "Drop", status: "cancelled", priority: "medium" },
        ]);
        expect(json).toBe(
            '[{"content":"Plan","status":"pending","priority":"high"},' +
                '{"content":"Build","status":"in_progress","priority":"medium"},' +
                '{"content":"Ship","status":"completed","priority":"low"},' +
                '{"content":"Drop","status":"cancelled","priority":"medium"}]',
        );
        expect(computeSyntheticCallId(json ?? "")).toBe("mc_synthetic_todo_0a023787097b0328");
        expect(buildSyntheticTodoPart(json ?? "")?.callID).toBe(
            "mc_synthetic_todo_0a023787097b0328",
        );
        expect(buildSyntheticTodoPart(json ?? "")?.state.title).toBe("3 todos");
    });

    it("rejects whole array if any item is malformed", () => {
        const todos = [
            { content: "Valid", status: "pending", priority: "high" },
            { content: "No status" },
        ];
        expect(normalizeTodoStateJson(todos)).toBeNull();
    });

    it("produces stable output for same input", () => {
        const todos = [{ content: "X", status: "pending", priority: "low" }];
        expect(normalizeTodoStateJson(todos)).toBe(normalizeTodoStateJson(todos));
    });
});

describe("buildSyntheticTodoPart", () => {
    const validState = JSON.stringify([
        { content: "Active task", status: "in_progress", priority: "high" },
        { content: "Done task", status: "completed", priority: "medium" },
    ]);

    it("returns null for empty state JSON", () => {
        expect(buildSyntheticTodoPart("")).toBeNull();
    });

    it("returns null for invalid JSON", () => {
        expect(buildSyntheticTodoPart("not json")).toBeNull();
    });

    it("returns null when all todos are terminal", () => {
        const state = JSON.stringify([
            { content: "A", status: "completed", priority: "high" },
            { content: "B", status: "cancelled", priority: "low" },
        ]);
        expect(buildSyntheticTodoPart(state)).toBeNull();
    });

    it("returns null for empty array", () => {
        expect(buildSyntheticTodoPart("[]")).toBeNull();
    });

    it("returns null when a stored item can't be read", () => {
        expect(
            buildSyntheticTodoPart(JSON.stringify([{ content: "Empty status", status: "" }])),
        ).toBeNull();
    });

    it("treats custom statuses as open and counts them in the title", () => {
        const blockedAndDone = buildSyntheticTodoPart(
            JSON.stringify([
                { content: "Waiting on review", status: "blocked", priority: "high" },
                { content: "Done", status: "completed", priority: "low" },
            ]),
        );
        expect(blockedAndDone?.state.title).toBe("1 todos");
        expect(blockedAndDone?.state.input.todos[0]).toEqual({
            content: "Waiting on review",
            status: "blocked",
            priority: "high",
        });

        // Only completed and cancelled are terminal, so a blocked item keeps the
        // reminder alive; cancelled still counts in the title, as in OpenCode.
        const blockedAndCancelled = buildSyntheticTodoPart(
            JSON.stringify([
                { content: "Waiting", status: "blocked", priority: "urgent" },
                { content: "Dropped", status: "cancelled", priority: "low" },
            ]),
        );
        expect(blockedAndCancelled?.state.title).toBe("2 todos");
    });

    it("produces a valid OpenCode tool part shape", () => {
        const part = buildSyntheticTodoPart(validState);
        expect(part).not.toBeNull();
        if (!part) throw new Error("part null");
        expect(part.type).toBe("tool");
        expect(part.tool).toBe("todowrite");
        expect(part.callID).toMatch(/^mc_synthetic_todo_[0-9a-f]{16}$/);
        expect(part.state.status).toBe("completed");
        expect(part.state.input.todos).toHaveLength(2);
        expect(part.state.metadata.todos).toHaveLength(2);
        expect(part.state.metadata.truncated).toBe(false);
        expect(part.syntheticTodoMarker).toBe(true);
    });

    it("output field is JSON-stringified todos with 2-space indent (matches OpenCode todo.ts)", () => {
        const part = buildSyntheticTodoPart(validState);
        if (!part) throw new Error("part null");
        const todos = JSON.parse(validState);
        expect(part.state.output).toBe(JSON.stringify(todos, null, 2));
    });

    it("title reflects active count only", () => {
        const part = buildSyntheticTodoPart(validState);
        if (!part) throw new Error("part null");
        // 1 active todo (in_progress); the completed one doesn't count
        expect(part.state.title).toBe("1 todos");
    });

    it("time start equals end (synthetic signal)", () => {
        const part = buildSyntheticTodoPart(validState);
        if (!part) throw new Error("part null");
        expect(part.state.time.start).toBe(part.state.time.end);
    });

    it("produces deterministic callID for same state (cache stability)", () => {
        const a = buildSyntheticTodoPart(validState);
        const b = buildSyntheticTodoPart(validState);
        expect(a?.callID).toBe(b?.callID);
    });

    it("produces different callID for different state", () => {
        const otherState = JSON.stringify([
            { content: "Different", status: "pending", priority: "low" },
        ]);
        const a = buildSyntheticTodoPart(validState);
        const b = buildSyntheticTodoPart(otherState);
        expect(a?.callID).not.toBe(b?.callID);
    });
});

describe("computeSyntheticCallId", () => {
    it("returns a 16-hex-char id with the synthetic prefix", () => {
        const id = computeSyntheticCallId("[]");
        expect(id).toMatch(/^mc_synthetic_todo_[0-9a-f]{16}$/);
    });

    it("is deterministic for same input", () => {
        expect(computeSyntheticCallId("foo")).toBe(computeSyntheticCallId("foo"));
    });

    it("differs for different input", () => {
        expect(computeSyntheticCallId("foo")).not.toBe(computeSyntheticCallId("bar"));
    });

    it("produces an id format that does not collide with provider formats", () => {
        const id = computeSyntheticCallId("any");
        // Anthropic uses toolu_*, OpenAI uses call_* — synthetic must not start with either
        expect(id.startsWith("toolu_")).toBe(false);
        expect(id.startsWith("call_")).toBe(false);
    });
});

describe("isSyntheticTodoPart", () => {
    it("detects parts with the syntheticTodoMarker flag", () => {
        const validState = JSON.stringify([
            { content: "X", status: "in_progress", priority: "high" },
        ]);
        const part = buildSyntheticTodoPart(validState);
        expect(isSyntheticTodoPart(part)).toBe(true);
    });

    it("detects synthetic parts by callID prefix even without the marker", () => {
        const part = {
            type: "tool",
            tool: "todowrite",
            callID: "mc_synthetic_todo_0123456789abcdef",
        };
        expect(isSyntheticTodoPart(part)).toBe(true);
    });

    it("rejects real tool parts", () => {
        const realPart = {
            type: "tool",
            tool: "todowrite",
            callID: "toolu_01N63ZiXgCock1HUZHeRFtLP",
            state: { status: "completed" },
        };
        expect(isSyntheticTodoPart(realPart)).toBe(false);
    });

    it("rejects non-objects and unrelated shapes", () => {
        expect(isSyntheticTodoPart(null)).toBe(false);
        expect(isSyntheticTodoPart(undefined)).toBe(false);
        expect(isSyntheticTodoPart("string")).toBe(false);
        expect(isSyntheticTodoPart({ type: "text", text: "hi" })).toBe(false);
    });
});
