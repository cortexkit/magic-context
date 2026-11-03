import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    acquireCompartmentLease,
    releaseCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import {
    getCompartments,
    replaceAllCompartments,
} from "../../features/magic-context/compartment-storage";
import {
    closeDatabase,
    getHistorianFailureState,
    getOrCreateSessionMeta,
    loadProtectedTailMeta,
    openDatabase,
} from "../../features/magic-context/storage";
import type { PluginContext } from "../../plugin/types";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    clearHistorianAlertState,
    nonNarrativeStoredGapRanges,
    runCompartmentAgent,
    STORED_COMPARTMENT_FAILURE_BACKOFF_MS,
} from "./compartment-runner-incremental";
import { validateStoredCompartments } from "./compartment-runner-validation";
import { clearInjectionCache, injectM0M1 } from "./inject-compartments";
import { encodeOpenCodeMessagesToCk } from "./module-wire";
import {
    clearProducerModelObservations,
    observeProducerModelsForTest,
    prepareProducerFixture,
} from "./producer-window-test-support";
import { withRawMessageProvider } from "./read-session-chunk";
import { areRustHistorianSyntheticParts, type RawMessage } from "./read-session-raw";
import { __ignoredNotificationTest } from "./send-session-notification";
import type { MessageLike } from "./transform-operations";

const sessionId = "ses-rust-switchback";
const originalDataHome = process.env.XDG_DATA_HOME;
let root: string;

beforeEach(async () => {
    root = createTestTempDirFromPath(join(tmpdir(), "mc-rust-switchback-"));
    process.env.XDG_DATA_HOME = root;
    await observeProducerModelsForTest(["test/fixture-historian"]);
    __ignoredNotificationTest.setHoldDetector(() => false);
});

afterEach(() => {
    clearProducerModelObservations();
    __ignoredNotificationTest.reset();
    clearHistorianAlertState(sessionId);
    clearInjectionCache(sessionId);
    closeDatabase();
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    rmSync(root, { recursive: true, force: true });
});

const notice = {
    type: "text",
    synthetic: true,
    text: "<system-reminder> [BACKGROUND BASH COMPLETED] done </system-reminder>",
};
const storedRanges = [
    {
        sequence: 0,
        startMessage: 1,
        endMessage: 2,
        startMessageId: "m1",
        endMessageId: "m2",
        title: "First",
        content: "First Rust summary",
    },
    {
        sequence: 1,
        startMessage: 4,
        endMessage: 4,
        startMessageId: "m4",
        endMessageId: "m4",
        title: "Second",
        content: "Second Rust summary",
    },
];

function gapRanges(rows: RawMessage[]) {
    const db = openDatabase();
    return withRawMessageProvider(
        sessionId,
        {
            readMessages: () => rows,
            getMessageCount: () => 4,
            readMessagePage: (after, limit, through) =>
                rows.filter((row) => row.ordinal > after && row.ordinal <= through).slice(0, limit),
        },
        () => nonNarrativeStoredGapRanges(db, sessionId, storedRanges),
    );
}

function gap(parts: unknown[], role = "user"): RawMessage {
    return { id: "m3", ordinal: 3, role, parts };
}

test("stored Rust gaps reject an ordinary non-synthetic user row", () => {
    expect(gapRanges([gap([{ type: "text", text: "Do not lose this human request" }])])).toEqual(
        [],
    );
});

test("stored Rust gaps reject one non-synthetic part among synthetic parts", () => {
    expect(gapRanges([gap([notice, { type: "file", url: "file:///human.txt" }])])).toEqual([]);
});

test("stored Rust gaps reject empty and compaction-only rows", () => {
    expect(gapRanges([gap([])])).toEqual([]);
    expect(gapRanges([gap([{ type: "compaction", synthetic: true }])])).toEqual([]);
});

test("stored Rust gaps require every ordinal and every row to match", () => {
    expect(gapRanges([])).toEqual([]);
    const db = openDatabase();
    const rows = [
        gap([notice]),
        { ...gap([{ type: "text", text: "human" }]), id: "m4", ordinal: 4 },
    ];
    const ranges = [
        { startMessage: 1, endMessage: 2 },
        { startMessage: 5, endMessage: 5 },
    ];
    withRawMessageProvider(sessionId, { readMessages: () => rows }, () => {
        expect(nonNarrativeStoredGapRanges(db, sessionId, ranges)).toEqual([]);
    });
});

test("stored Rust gaps mirror the module codec without a role or text restriction", () => {
    const cases = [
        [notice],
        [notice, { type: "compaction" }],
        [{ type: "tool", syntheticTodoMarker: true }],
        [{ type: "file", synthetic: true, url: "file:///synthetic.txt" }],
    ];
    for (const role of ["user", "assistant"]) {
        for (const parts of cases) {
            expect(areRustHistorianSyntheticParts(parts)).toBe(true);
            expect(
                encodeOpenCodeMessagesToCk([{ info: { id: "m3", role }, parts }])[0]?.ck.meta,
            ).toMatchObject({ synthetic: true });
            expect(gapRanges([gap(parts, role)])).toEqual([{ start: 3, end: 3 }]);
        }
    }
    for (const parts of [[null], [notice, null], [{ type: "text", synthetic: "true" }]]) {
        expect(areRustHistorianSyntheticParts(parts)).toBe(false);
    }
});

test("stored Rust gaps include a skipped leading row without changing coverage", () => {
    const db = openDatabase();
    const rows = [{ ...gap([notice]), id: "m1", ordinal: 1 }];
    withRawMessageProvider(sessionId, { readMessages: () => rows }, () => {
        const ranges = [{ startMessage: 2, endMessage: 4 }];
        expect(nonNarrativeStoredGapRanges(db, sessionId, ranges)).toEqual([{ start: 1, end: 1 }]);
        expect(
            validateStoredCompartments(ranges, nonNarrativeStoredGapRanges(db, sessionId, ranges)),
        ).toBeNull();
    });
});

test("leading gap compatibility does not widen the existing v2 tool-only exception", () => {
    const db = openDatabase();
    getOrCreateSessionMeta(db, sessionId);
    db.prepare("UPDATE session_meta SET coordinate_rebase_notice = ? WHERE session_id = ?").run(
        JSON.stringify({ generation: "v2" }),
        sessionId,
    );
    const tool = { type: "tool", tool: "bash" };
    withRawMessageProvider(
        sessionId,
        {
            readMessages: () => [{ ...gap([tool]), ordinal: 1 }],
        },
        () => {
            expect(
                nonNarrativeStoredGapRanges(db, sessionId, [{ startMessage: 2, endMessage: 4 }]),
            ).toEqual([]);
        },
    );
    expect(gapRanges([gap([tool])])).toEqual([{ start: 3, end: 3 }]);
});

function fixture() {
    const path = join(root, "opencode", "opencode.db");
    mkdirSync(dirname(path), { recursive: true });
    const raw = new Database(path);
    raw.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
    const messages: MessageLike[] = Array.from({ length: 12 }, (_, index) => ({
        info: { id: `m${index + 1}`, role: index >= 7 || index % 2 === 0 ? "user" : "assistant" },
        parts: [index === 2 ? notice : { type: "text", text: `message ${index + 1}` }],
    }));
    for (const [index, message] of messages.entries()) {
        raw.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
            message.info.id!,
            sessionId,
            index + 1,
            index + 1,
            JSON.stringify(message.info),
        );
        raw.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
            `p${index + 1}`,
            message.info.id!,
            sessionId,
            index + 1,
            index + 1,
            JSON.stringify(message.parts[0]),
        );
    }
    raw.close();
    const db = openDatabase();
    getOrCreateSessionMeta(db, sessionId);
    replaceAllCompartments(db, sessionId, storedRanges);
    const prompt = mock(async () => ({}));
    const published = mock(() => {});
    const client = {
        session: {
            create: mock(async () => ({ data: { id: "child" } })),
            get: mock(async () => ({ data: { directory: root } })),
            prompt,
            messages: mock(async () => ({
                data: [
                    {
                        info: { role: "assistant", time: { created: 1 } },
                        parts: [
                            {
                                type: "text",
                                text: '<compartment start="5" end="7" title="TS continuation"><p1>New TS summary</p1></compartment>',
                            },
                        ],
                    },
                ],
            })),
            delete: mock(async () => ({})),
        },
    } as unknown as PluginContext["client"];
    const run = async () => {
        const holderId = "switchback-test-holder";
        expect(acquireCompartmentLease(db, sessionId, holderId)).not.toBeNull();
        try {
            await runCompartmentAgent(
                await prepareProducerFixture({
                    historianTurnTwo: "off",
                    client,
                    db,
                    sessionId,
                    directory: root,
                    historianChunkTokens: 10_000,
                    memoryEnabled: false,
                    onCompartmentStatePublished: published,
                    compartmentLeaseHolderId: holderId,
                }),
            );
        } finally {
            releaseCompartmentLease(db, sessionId, holderId);
        }
    };
    return { db, messages, prompt, published, run };
}

test("OpenCode 1 TS historian publishes after Rust synthetic-only stored gaps", async () => {
    const { db, run, published } = fixture();
    expect(validateStoredCompartments(getCompartments(db, sessionId))).toBe(
        "gap before message 4 (expected 3)",
    );
    await run();
    expect(getHistorianFailureState(db, sessionId).lastError).toBeNull();
    expect(published).toHaveBeenCalledTimes(1);
    expect(getCompartments(db, sessionId).map((row) => [row.startMessage, row.endMessage])).toEqual(
        [
            [1, 2],
            [4, 4],
            [5, 7],
        ],
    );
});

test("Rust switch-back gap acceptance keeps every defer wire byte-identical without rebuilding", async () => {
    const { db, messages, run } = fixture();
    const pass = (bust: boolean) => {
        const output = structuredClone(messages);
        const result = injectM0M1({
            db,
            sessionId,
            messages: output,
            state: getOrCreateSessionMeta(db, sessionId),
            projectPath: root,
            projectDirectory: root,
            injectDocs: false,
            historyBudgetTokens: 98_000,
            isCacheBustingPass: bust,
            hardSignals: {
                systemHash: "system",
                modelKey: "test/model",
                cacheExpired: false,
                lastResponseTime: 0,
            },
        });
        expect(result.prefixTrimStatus).toBe("applied");
        expect(output.some((message) => message.info.id === "m3")).toBe(false);
        // pass(false) reuses the cached prefix: even after the historian publishes,
        // message m5 must stay raw until a cache-busting pass adopts the new summary.
        expect(output.some((message) => message.info.id === "m5")).toBe(true);
        return { bytes: JSON.stringify(output), rebuilt: result.m0RematerializedThisPass };
    };
    const passes = [pass(true), pass(false), pass(false)];
    const changesBefore = db.prepare("SELECT total_changes() AS n").get() as { n: number };
    nonNarrativeStoredGapRanges(db, sessionId, getCompartments(db, sessionId));
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changesBefore);
    await run();
    passes.push(pass(false), pass(false), pass(false));
    expect(passes.map((item) => item.rebuilt)).toEqual([true, false, false, false, false, false]);
    for (const [index, item] of passes.entries()) {
        if (index > 0) expect(item.bytes).toBe(passes[index - 1]!.bytes);
    }
    if (process.env.MC_SWITCHBACK_TRACE) {
        writeFileSync(process.env.MC_SWITCHBACK_TRACE, JSON.stringify(passes));
        console.log(
            `switch-back passes=${passes.length} rebuilds=${passes.filter((item) => item.rebuilt).length} bytes=${passes[0]!.bytes.length}`,
        );
    }
});

test("non-repairable stored validation backs off and logs once per session failure class", async () => {
    const { db, run, prompt } = fixture();
    const raw = new Database(join(root, "opencode", "opencode.db"));
    raw.prepare("UPDATE part SET data = ? WHERE message_id = 'm3'").run(
        JSON.stringify({ type: "text", text: "human request" }),
    );
    raw.close();
    const log = spyOn(logger, "sessionLog");
    const clock = spyOn(Date, "now");
    const now = Date.now();
    clock.mockReturnValue(now);
    try {
        await run();
        const failureAt = loadProtectedTailMeta(db, sessionId).historianDrainFailureAt;
        expect(failureAt).toBe(now);
        await run();
        await run();
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(1);
        expect(loadProtectedTailMeta(db, sessionId).historianDrainFailureAt).toBe(failureAt);
        clock.mockReturnValue(now + STORED_COMPARTMENT_FAILURE_BACKOFF_MS + 1);
        await run();
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(2);
        const failureLogs = () =>
            log.mock.calls.filter(
                ([id, text]) =>
                    id === sessionId && String(text).includes("source=existing-validation"),
            );
        expect(failureLogs()).toHaveLength(1);
        db.prepare(
            "UPDATE compartments SET start_message = 5, end_message = 5 WHERE session_id = ? AND sequence = 1",
        ).run(sessionId);
        await run();
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(3);
        expect(failureLogs()).toHaveLength(1);
        // A different failure class is diagnosed even inside the old backoff.
        db.prepare(
            "UPDATE compartments SET start_message = 2 WHERE session_id = ? AND sequence = 1",
        ).run(sessionId);
        await run();
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(4);
        expect(failureLogs()).toHaveLength(2);
        await run();
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(4);
        expect(failureLogs()).toHaveLength(2);
        expect(prompt).not.toHaveBeenCalled();
    } finally {
        log.mockRestore();
        clock.mockRestore();
    }
});
