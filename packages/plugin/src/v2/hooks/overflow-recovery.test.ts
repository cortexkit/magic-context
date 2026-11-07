import { afterEach, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { V2OverflowRecovery } from "./overflow-recovery";

const originalHome = process.env.XDG_DATA_HOME;
const roots: string[] = [];
afterEach(() => {
    closeDatabase();
    if (originalHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalHome;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const model = { providerID: "openai", id: "mock-model" };
const error = {
    type: "provider.invalid-request",
    message: "context_length_exceeded: Your input exceeds the context window of this model",
    status: 200,
};
const numbered = {
    message:
        "This model's maximum context length is 100000 tokens. Please reduce the length of the messages.",
};
function setup(compactionOff = false) {
    const root = createTestTempDirFromPath(join(tmpdir(), "v2-overflow-recovery-"));
    roots.push(root);
    process.env.XDG_DATA_HOME = root;
    const db = openDatabase();
    if (!db) throw new Error("test database unavailable");
    const hidden = new Set<string>();
    const usage: number[] = [];
    const recovery = new V2OverflowRecovery({
        database: () => db,
        compactionOff,
        isHidden: (id) => hidden.has(id),
        onInputTokens: (_id, tokens) => usage.push(tokens),
    });
    getOrCreateSessionMeta(db, "ses");
    db.exec("CREATE TEMP TABLE arm_count (value INTEGER); INSERT INTO arm_count VALUES (0)");
    db.exec(
        "CREATE TEMP TRIGGER count_arms AFTER UPDATE OF needs_emergency_recovery ON session_meta WHEN NEW.needs_emergency_recovery = 1 BEGIN UPDATE arm_count SET value = value + 1; END",
    );
    const state = () =>
        db
            .prepare(
                "SELECT needs_emergency_recovery, detected_context_limit, detected_context_limit_model_key FROM session_meta WHERE session_id = 'ses'",
            )
            .get();
    const arms = () => (db.prepare("SELECT value FROM arm_count").get() as { value: number }).value;
    const begin = (assistantMessageID = "step", selected = model) =>
        recovery.begin({ sessionID: "ses", kind: "primary", model: selected, assistantMessageID });
    return { recovery, hidden, usage, state, arms, begin };
}

it("arms once across HTTP, step, execution and compatible session error observations", () => {
    const f = setup();
    f.begin();
    f.recovery.observe({ sessionID: "ses", model, error: JSON.stringify({ error }), status: 400 });
    f.begin();
    const read = () => ({ id: "step", model, error });
    f.recovery.observeTerminal(
        {
            type: "session.step.failed",
            data: { sessionID: "ses", assistantMessageID: "step", error },
        },
        read,
    );
    f.recovery.observeTerminal(
        { type: "session.execution.failed", data: { sessionID: "ses", error } },
        read,
    );
    f.recovery.observeTerminal({ type: "session.error", data: { sessionID: "ses", error } }, read);
    expect(f.arms()).toBe(1);
    expect(f.state()).toMatchObject({ needs_emergency_recovery: 1, detected_context_limit: 0 });
    f.begin("next-step");
    f.recovery.observe({ sessionID: "ses", model, error });
    expect(f.arms()).toBe(2);
});

it.each([
    "session.step.failed",
    "session.execution.failed",
    "session.error",
])("arms from %s without an HTTP rejection", (type) => {
    const f = setup();
    f.begin();
    f.recovery.observeTerminal(
        {
            type,
            data: { sessionID: "ses", assistantMessageID: "step", error },
        },
        () => ({ id: "step", model, error }),
    );
    expect(f.arms()).toBe(1);
    expect(f.state()).toMatchObject({ needs_emergency_recovery: 1, detected_context_limit: 0 });
});

it("resolves a stored failing step when no HTTP request snapshot was observed", () => {
    const f = setup();
    f.recovery.observeTerminal(
        { type: "session.execution.failed", data: { sessionID: "ses", error: numbered } },
        () => ({ id: "new-step", model, error: numbered }),
    );
    expect(f.arms()).toBe(1);
    expect(f.state()).toMatchObject({
        needs_emergency_recovery: 1,
        detected_context_limit: 100_000,
        detected_context_limit_model_key: "openai/mock-model",
    });
});

it("binds a request to its failing step, not a previous accepted reply", () => {
    const f = setup();
    f.recovery.begin({ sessionID: "ses", model, kind: "primary" });
    f.recovery.observeTerminal(
        {
            type: "session.step.failed",
            data: { sessionID: "ses", assistantMessageID: "new-step", error },
        },
        () => ({ id: "new-step", model, error }),
    );
    expect(f.arms()).toBe(1);
});

it("does not read failed-step metadata for ordinary errors or duplicate reports", () => {
    const f = setup();
    f.begin();
    const unexpectedRead = () => {
        throw new Error("unexpected store read");
    };
    f.recovery.observeTerminal(
        {
            type: "session.step.failed",
            data: { sessionID: "ses", error: { message: "service unavailable" } },
        },
        unexpectedRead,
    );
    f.recovery.observe({ sessionID: "ses", model, error });
    f.recovery.observeTerminal(
        { type: "session.execution.failed", data: { sessionID: "ses", error } },
        unexpectedRead,
    );
    expect(f.arms()).toBe(1);
});

it("does not attribute an old-model or old-step failure to a newer request", () => {
    const f = setup();
    f.begin("new-step", { providerID: "other", id: "new-model" });
    f.recovery.observeTerminal(
        {
            type: "session.step.failed",
            data: { sessionID: "ses", assistantMessageID: "old-step", error: numbered },
        },
        () => ({ id: "old-step", model, error: numbered }),
    );
    f.recovery.observe({ sessionID: "ses", model, error: numbered });
    f.recovery.observeTerminal(
        { type: "session.execution.failed", data: { sessionID: "ses", error: numbered } },
        () => ({ id: "new-step", model: { providerID: "other", id: "new-model" } }),
    );
    expect(f.arms()).toBe(0);
    expect(f.state()).toMatchObject({ needs_emergency_recovery: 0, detected_context_limit: 0 });
    f.begin("current-step");
    f.recovery.observeTerminal(
        {
            type: "session.step.failed",
            data: { sessionID: "ses", assistantMessageID: "old-step", error },
        },
        () => ({ id: "old-step", model, error }),
    );
    expect(f.arms()).toBe(0);
});

it("never records overflow for registered hidden children or auxiliary requests", () => {
    const f = setup();
    for (const role of ["historian", "dreamer", "mapper"]) {
        f.recovery.begin({
            sessionID: role,
            model,
            kind: "primary",
            assistantMessageID: "hidden-step",
        });
        f.hidden.add(role);
        f.recovery.observe({ sessionID: role, model, error: numbered });
        f.recovery.observeTerminal(
            { type: "session.execution.failed", data: { sessionID: role, error } },
            () => ({ id: "hidden-step", model, error }),
        );
    }
    f.recovery.begin({ sessionID: "ses", kind: "utility", model });
    f.recovery.observe({ sessionID: "ses", model, error: numbered });
    expect(f.arms()).toBe(0);
    expect(f.state()).toMatchObject({ needs_emergency_recovery: 0, detected_context_limit: 0 });
});

it("compaction off learns only provider-reported limits and never arms recovery", () => {
    const f = setup(true);
    f.begin();
    f.recovery.observe({ sessionID: "ses", model, error });
    expect(f.state()).toMatchObject({ needs_emergency_recovery: 0, detected_context_limit: 0 });
    f.begin("numbered-step");
    f.recovery.observeTerminal(
        {
            type: "session.step.failed",
            data: { sessionID: "ses", assistantMessageID: "numbered-step", error: numbered },
        },
        () => ({ id: "numbered-step", model, error: numbered }),
    );
    expect(f.state()).toMatchObject({
        needs_emergency_recovery: 0,
        detected_context_limit: 100_000,
        detected_context_limit_model_key: "openai/mock-model",
    });
    expect(f.arms()).toBe(0);
    expect(f.usage).toEqual([]);
});

it("rate limits and non-overflow provider errors never arm", () => {
    const f = setup();
    f.begin();
    f.recovery.observe({ sessionID: "ses", model, error: numbered, status: 429 });
    f.recovery.observe({
        sessionID: "ses",
        model,
        error: { ...numbered, type: "provider.rate-limit" },
    });
    f.recovery.observe({
        sessionID: "ses",
        model,
        error: { name: "APIError", data: { ...numbered, statusCode: 429 } },
    });
    f.recovery.observeTerminal(
        {
            type: "session.step.failed",
            data: {
                sessionID: "ses",
                assistantMessageID: "step",
                error: { ...error, status: 429 },
            },
        },
        () => ({ id: "step", model }),
    );
    f.recovery.observe({
        sessionID: "ses",
        model,
        error: { message: "Service unavailable", status: 503 },
    });
    expect(f.arms()).toBe(0);
    expect(f.state()).toMatchObject({ needs_emergency_recovery: 0, detected_context_limit: 0 });
});
