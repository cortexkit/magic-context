import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import ts from "typescript";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    type AutoSearchHintDecision,
    appendAutoSearchHintDecision,
    getAutoSearchHintDecisions,
} from "../../features/magic-context/storage-meta-persisted";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta-session";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { createCtxSearchTools } from "../../tools/ctx-search/tools";
import { clearAutoSearchTimeoutForSession } from "./auto-search-deadline";
import { runAutoSearchHint } from "./auto-search-runner";
import { persistAutoSearchDecision } from "./auto-search-worker-client";

const root = join(tmpdir(), "magic-context", "bg_a0f7b373d3df719d");
mkdirSync(root, { recursive: true });
const dbs: Database[] = [];
const workers: Worker[] = [];
function fixture() {
    setHarness("pi");
    const path = join(createTestTempDirFromPath(join(root, "re-review-")), "context.db");
    const db = new Database(path);
    dbs.push(db);
    initializeDatabase(db);
    runMigrations(db);
    return { db, path };
}
afterEach(async () => {
    clearAutoSearchTimeoutForSession();
    for (const worker of workers.splice(0)) await worker.terminate();
    for (const db of dbs.splice(0)) db.close();
    _resetHarnessForTesting();
});
function messages() {
    return [
        { info: { id: "user", role: "user" }, parts: [{ type: "text", text: "question" }] },
        { info: { id: "assistant", role: "assistant" }, parts: [{ type: "text", text: "answer" }] },
    ];
}

// Execute the actual old getter/validator, not a reimplementation of its semantics.
// Pin the comparison master so a subsequent fix cannot silently change this reader.
function olderGetter() {
    // The getter as it stood at master 41eedb38, kept as a fixture because CI's
    // shallow clone has no history to read it from.
    const source = readFileSync(
        fileURLToPath(
            new URL("./__fixtures__/storage-meta-persisted.41eedb38.ts.txt", import.meta.url),
        ),
        "utf8",
    );
    const parsed = ts.createSourceFile("old.ts", source, ts.ScriptTarget.Latest, true);
    const names = new Set([
        "AUTO_SEARCH_NO_HINT_REASONS",
        "isValidAutoSearchHintDecision",
        "parseJsonArray",
        "getAutoSearchHintDecisions",
    ]);
    const selected = parsed.statements.filter((node) =>
        ts.isFunctionDeclaration(node)
            ? names.has(node.name?.text ?? "")
            : ts.isVariableStatement(node) &&
              node.declarationList.declarations.some((item) =>
                  names.has(item.name.getText(parsed)),
              ),
    );
    expect(selected.length).toBe(4);
    const javascript = ts.transpileModule(
        selected.map((node) => node.getText(parsed).replace(/^export /, "")).join("\n"),
        {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
        },
    ).outputText;
    return new Function(`${javascript}\nreturn getAutoSearchHintDecisions;`)() as (
        db: Database,
        sessionId: string,
    ) => AutoSearchHintDecision[];
}

// These five findings required the worker to write a decision or backfill while
// ranking. Those operations are no longer part of the search protocol. Send the
// former commands to the real reader to prove they cannot publish or recreate rows.
for (const finding of [
    "older-reader provisional",
    "late accepted ack",
    "pending hint cleanup",
    "reused skip rowid",
    "backfill writer lease",
]) {
    test(`re-review replacement: ${finding} worker writes no decision rows`, async () => {
        const { db, path } = fixture();
        const sessionId = `reader-${finding}`;
        getOrCreateSessionMeta(db, sessionId);
        insertMemory(db, {
            projectPath: "git:reader",
            category: "ARCHITECTURE_DECISIONS",
            content: "historian cache wiring details",
        });
        const worker = new Worker(new URL("./auto-search-worker.ts", import.meta.url), {
            workerData: {
                path,
                sessionId,
                harness: "pi",
                projectPath: "git:reader",
                query: "historian cache wiring",
                options: { sources: ["memory"] },
                embeddingRuntimeEnabled: false,
                snapshot: null,
                decision: {
                    messageId: "user",
                    decision: "hint",
                    text: "unserved",
                    publication: { token: "old-command", state: "provisional" },
                },
                skipDecision: { messageId: "old-user", decision: "no-hint", reason: "timeout" },
            },
        });
        workers.push(worker);
        const reply = await new Promise<{ kind: string; results: unknown[] }>((resolve, reject) => {
            worker.once("message", resolve);
            worker.once("error", reject);
        });
        expect(reply.kind).toBe("result");
        expect(reply.results.length).toBe(1);
        expect(getAutoSearchHintDecisions(db, sessionId)).toEqual([]);
        expect(olderGetter()(db, sessionId)).toEqual([]);
        expect(db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get()).toEqual({ n: 0 });
    });
}

test("owner decisions retain master's exact JSON and older-reader replay", async () => {
    const { db } = fixture();
    const decision = { messageId: "user", decision: "hint" as const, text: "served" };
    expect((await persistAutoSearchDecision(db, "owner", decision, performance.now()))?.ok).toBe(
        true,
    );
    expect(olderGetter()(db, "owner")).toEqual([decision]);
    expect(
        db
            .prepare(
                "SELECT auto_search_hint_decisions AS decisions FROM session_meta WHERE session_id='owner'",
            )
            .get(),
    ).toEqual({ decisions: '[{"decision":"hint","messageId":"user","text":"served"}]' });
});

test("re-review control: exhausted publication budget returns no hint without waiting for a writer", async () => {
    const { db, path } = fixture();
    const writer = new Database(path);
    dbs.push(writer);
    writer.exec("BEGIN IMMEDIATE");
    try {
        const start = performance.now();
        const result = await persistAutoSearchDecision(
            db,
            "spent",
            {
                messageId: "user",
                decision: "hint",
                text: "never published",
            },
            start - 3001,
        );
        expect(result).toBeNull();
        expect(performance.now() - start).toBeLessThan(100);
    } finally {
        writer.exec("ROLLBACK");
    }
});

test("re-review control: publication metadata is absent from public decisions, served bytes and ctx_search", async () => {
    const { db } = fixture();
    const sessionId = "metadata-public-surface";
    const projectPath = "git:publication-surface";
    insertMemory(db, {
        projectPath,
        category: "ARCHITECTURE_DECISIONS",
        content: "historian cache wiring details",
    });
    const decision = {
        messageId: "user",
        decision: "hint" as const,
        text: "\n\n<ctx-search-hint>accepted</ctx-search-hint>",
    };
    appendAutoSearchHintDecision(db, sessionId, decision);
    expect(getAutoSearchHintDecisions(db, sessionId)).toEqual([decision]);
    const output = messages();
    await runAutoSearchHint({
        db,
        sessionId,
        messages: output,
        options: { enabled: true, projectPath, minPromptChars: 1, scoreThreshold: 0 },
    });
    expect(output[0].parts[0].text).toBe(`question${decision.text}`);
    const tools = createCtxSearchTools({
        db,
        resolveProjectPath: () => projectPath,
        memoryEnabled: true,
        embeddingEnabled: false,
        readMessages: () => [],
    });
    const result = await tools.ctx_search.execute(
        { query: "historian cache wiring", sources: ["memory"] },
        { sessionID: sessionId, directory: root } as never,
    );
    expect(result).toContain("historian cache wiring details");
    expect(result).not.toContain("internal-marker-7e41");
    expect(result).not.toContain("publication");
});
