import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
    HiddenCompletion,
    HiddenCompletionExecutor,
} from "../../../hooks/magic-context/compartment-runner-types";
import { Database } from "../../../shared/sqlite";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { insertMemory, recordMemoryMapping } from "../memory";
import { runMigrations } from "../migrations";
import * as capabilities from "../smart-notes/capabilities";
import { markSmartNoteCheckStatus } from "../smart-notes/storage";
import * as wakePlane from "../smart-notes/wake-plane";
import { initializeDatabase } from "../storage-db";
import { addNote } from "../storage-notes";
import { getSubagentInvocations } from "../storage-subagent-invocations";
import { evaluateSmartNotes } from "./evaluate-smart-notes";
import { acquireLease } from "./lease";
import { mapMemories } from "./map-memories";
import { createDreamTaskExecutor } from "./task-executor";
import { leaseKeyFor } from "./task-registry";
import { runVerify } from "./verify";

const databases: Database[] = [];
const directories: string[] = [];

afterEach(() => {
    mock.restore();
    for (const db of databases.splice(0)) db.close();
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
    const db = new Database(":memory:");
    databases.push(db);
    initializeDatabase(db);
    runMigrations(db);
    const directory = createTestTempDirFromPath(path.join(tmpdir(), "mc-completion-usage-"));
    directories.push(directory);
    mkdirSync(path.join(directory, "src"));
    writeFileSync(path.join(directory, "src/fact.ts"), "export const fact = true;");
    return { db, directory };
}

function carrier(
    answer: string | ((turn: number) => string),
    harness: HiddenCompletionExecutor["capabilities"]["harness"] = "opencode2",
): HiddenCompletionExecutor {
    let turn = 0;
    let text = "";
    return {
        capabilities: { tools: true, harness },
        async open() {
            return { id: "usage-child", childSessionId: "usage-child" };
        },
        async attempt() {
            text = typeof answer === "string" ? answer : answer(++turn);
        },
        async collect(): Promise<HiddenCompletion> {
            return {
                text,
                // OpenCode 2 projects assistant text/tool parts without token fields.
                messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }],
                usage: { input: 101, output: 23, cacheRead: 7, cacheWrite: 5 },
                lengthCapped: false,
            };
        },
        async close() {},
    };
}

function expectUsage(db: Database, task: string, multiplier = 1) {
    const rows = getSubagentInvocations(db, "parent");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
        task,
        harness: "opencode2",
        status: "completed",
        inputTokens: 101 * multiplier,
        outputTokens: 23 * multiplier,
        cacheReadTokens: 7 * multiplier,
        cacheWriteTokens: 5 * multiplier,
    });
}

for (const task of ["map-memories", "verify", "verify-broad"] as const) {
    test(`OpenCode 2 ${task} records completion usage without message token fields`, async () => {
        const { db, directory } = fixture();
        const memory = insertMemory(db, {
            projectPath: directory,
            category: "ARCHITECTURE",
            content: "The fact lives in src/fact.ts.",
        });
        const leaseKey = leaseKeyFor(task, directory);
        expect(acquireLease(db, "holder", leaseKey)).toBe(true);
        const args = {
            db,
            projectIdentity: directory,
            sessionDirectory: directory,
            parentSessionId: "parent",
            holderId: "holder",
            leaseKey,
            deadline: Date.now() + 600_000,
            forceBroad: task === "verify-broad",
            hiddenCompletionExecutor: carrier(
                task === "map-memories"
                    ? `<mappings><memory id="${memory.id}" files="src/fact.ts"/></mappings>`
                    : `<verify><verified id="${memory.id}" files="src/fact.ts"/></verify>`,
            ),
        };
        if (task !== "map-memories") {
            recordMemoryMapping(db, memory.id, ["src/fact.ts"], 1);
            expect((await runVerify(args)).verified).toBe(1);
        } else {
            expect((await mapMemories(args)).mapped).toBe(1);
        }
        expectUsage(db, task);
    });
}

test("OpenCode 2 curate records completion usage across batches", async () => {
    const { db, directory } = fixture();
    for (let i = 0; i < 3; i++) {
        insertMemory(db, {
            projectPath: directory,
            category: "PROJECT_RULES",
            content: `Rule ${i}: ${"meaningful context ".repeat(170)}`,
        });
    }
    const executor = createDreamTaskExecutor({
        sessionDirectory: directory,
        parentSessionId: "parent",
        openOpenCodeDb: () => null,
        resolveRetrospectiveUsableInputTokens: () => 2000,
        hiddenCompletionExecutor: carrier("No duplicates in this snapshot."),
    });
    const result = await executor(
        { task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 20 },
        {
            db,
            projectIdentity: directory,
            holderId: "holder",
            leaseKey: leaseKeyFor("curate", directory),
        },
    );
    expect(result.status).toBe("completed");
    expectUsage(db, "curate", 3);
});

test("OpenCode 2 retrospective records completion usage for both turns", async () => {
    const { db, directory } = fixture();
    const executor = createDreamTaskExecutor({
        sessionDirectory: directory,
        parentSessionId: "parent",
        openOpenCodeDb: () => null,
        hiddenCompletionExecutor: carrier((turn) =>
            turn === 1 ? "y: 1" : "<learnings></learnings>",
        ),
        retrospectiveRawProvider: {
            listProjectSessions: () => [{ sessionId: "s1" }],
            readUserMessagesSince: () => ({
                messages: [
                    {
                        sessionId: "s1",
                        ordinal: 3,
                        role: "user",
                        text: "Please correct the earlier response.",
                        followsAssistantReply: true,
                        ts: Date.now() - 1000,
                    },
                ],
                truncated: false,
            }),
            readUserMessagesBefore: () => [],
        },
    });
    const result = await executor(
        { task: "retrospective", schedule: "0 5 * * *", timeoutMinutes: 20 },
        {
            db,
            projectIdentity: directory,
            holderId: "holder",
            leaseKey: leaseKeyFor("retrospective", directory),
        },
    );
    expect(result.status).toBe("completed");
    expectUsage(db, "retrospective", 2);
});

test("OpenCode 2 evaluate-smart-notes records compiler completion usage", async () => {
    const { db, directory } = fixture();
    spyOn(wakePlane, "wakePlaneStatus").mockResolvedValue("absent");
    spyOn(capabilities, "readSmartNoteGithubToken").mockResolvedValue(null);
    addNote(db, "smart", {
        projectPath: directory,
        content: "Review the release.",
        surfaceCondition: "The release is ready.",
    });
    const leaseKey = leaseKeyFor("evaluate-smart-notes", directory);
    expect(acquireLease(db, "holder", leaseKey)).toBe(true);
    const result = await evaluateSmartNotes({
        db,
        projectIdentity: directory,
        sessionDirectory: directory,
        parentSessionId: "parent",
        holderId: "holder",
        leaseKey,
        deadline: Date.now() + 60_000,
        hiddenCompletionExecutor: carrier(
            JSON.stringify({
                compiled_check: "function check() { return { met: false }; }",
                manifest: { capabilities: [] },
                check_cron: "* * * * *",
            }),
        ),
    });
    expect(result.ran).toBe(true);
    expect(result.surfaced).toBe(0);
    expectUsage(db, "evaluate-smart-notes");
});

test("OpenCode 2 evaluate-smart-notes records confirmation completion usage", async () => {
    const { db, directory } = fixture();
    spyOn(wakePlane, "wakePlaneStatus").mockResolvedValue("absent");
    spyOn(capabilities, "readSmartNoteGithubToken").mockResolvedValue(null);
    const note = addNote(db, "smart", {
        projectPath: directory,
        content: "Review the release.",
        surfaceCondition: "The release is ready.",
    });
    markSmartNoteCheckStatus(db, note.id, "fallback", Date.now());
    db.prepare("UPDATE notes SET check_next_due_at = ? WHERE id = ?").run(
        Date.now() + 60_000,
        note.id,
    );
    const leaseKey = leaseKeyFor("evaluate-smart-notes", directory);
    expect(acquireLease(db, "holder", leaseKey)).toBe(true);
    const result = await evaluateSmartNotes({
        db,
        projectIdentity: directory,
        sessionDirectory: directory,
        parentSessionId: "parent",
        holderId: "holder",
        leaseKey,
        deadline: Date.now() + 60_000,
        hiddenCompletionExecutor: carrier('{"met":true}'),
    });
    expect(result.surfaced).toBe(1);
    expectUsage(db, "evaluate-smart-notes");
});

for (const harness of ["opencode", "pi"] as const) {
    test(`${harness} mapping keeps message-based usage instead of completion usage`, async () => {
        const { db, directory } = fixture();
        const memory = insertMemory(db, {
            projectPath: directory,
            category: "ARCHITECTURE",
            content: "The fact lives in src/fact.ts.",
        });
        const leaseKey = leaseKeyFor("map-memories", directory);
        expect(acquireLease(db, "holder", leaseKey)).toBe(true);
        const executor = carrier(
            `<mappings><memory id="${memory.id}" files="src/fact.ts"/></mappings>`,
            harness,
        );
        const collect = executor.collect;
        executor.collect = async (handle, limit) => {
            const completion = await collect(handle, limit);
            const message = completion.messages?.[0] as { info: Record<string, unknown> };
            message.info.tokens = { input: 41, output: 17, cache: { read: 3, write: 2 } };
            return completion;
        };
        expect(
            (
                await mapMemories({
                    db,
                    projectIdentity: directory,
                    sessionDirectory: directory,
                    parentSessionId: "parent",
                    holderId: "holder",
                    leaseKey,
                    deadline: Date.now() + 600_000,
                    hiddenCompletionExecutor: executor,
                })
            ).mapped,
        ).toBe(1);
        expect(getSubagentInvocations(db, "parent")[0]).toMatchObject({
            inputTokens: 41,
            outputTokens: 17,
            cacheReadTokens: 3,
            cacheWriteTokens: 2,
        });
    });
}
