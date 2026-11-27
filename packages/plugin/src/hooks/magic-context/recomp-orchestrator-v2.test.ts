/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { releaseCompartmentLease } from "../../features/magic-context/compartment-lease";
import {
    appendCompartments,
    getCompartments,
    getRecompPartialRange,
    getRecompStaging,
    saveRecompStagingPass,
    setRecompPartialRange,
} from "../../features/magic-context/compartment-storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import * as historian from "./compartment-runner-historian";
import { executeContextRecompWithResult } from "./compartment-runner";
import type { HiddenCompletionExecutor } from "./compartment-runner-types";
import * as validation from "./compartment-runner-validation";
import * as fitting from "./historian-prompt-fit";
import { createLiveSessionState } from "./live-session-state";
import * as rawSession from "./read-session-chunk";
import {
    buildRecompDeps,
    type ManagedRecompContext,
    runManagedRecomp,
} from "./recomp-orchestrator";

// OpenCode 2 gives a plugin no SDK client. Recomp used to reach for one
// (`client.session.get`) and never passed the historian the hidden-completion
// executor that host provides, so every run failed with MC-R01.

function executorCoveringRequestedRange(
    answer: (start: number, end: number) => number | null = (_start, end) => end,
): HiddenCompletionExecutor & {
    opened: string[];
    maxOutputCaps: Array<number | undefined>;
    requestedStarts: number[];
} {
    const opened: string[] = [];
    const maxOutputCaps: Array<number | undefined> = [];
    const requestedStarts: number[] = [];
    let prompt = "";
    return {
        opened,
        maxOutputCaps,
        requestedStarts,
        capabilities: { tools: false, harness: "opencode" },
        open: async (run) => {
            opened.push(run.kind);
            maxOutputCaps.push(run.maxOutputTokens);
            return { id: `child-${opened.length}`, childSessionId: `child-${opened.length}` };
        },
        attempt: async (_handle, request) => {
            prompt = JSON.stringify(request);
        },
        collect: async () => {
            const range = prompt.match(/Messages (\d+)-(\d+):/);
            if (!range) throw new Error("historian prompt carried no message range");
            const start = Number(range[1]);
            const chunkEnd = Number(range[2]);
            requestedStarts.push(start);
            const end = answer(start, chunkEnd);
            return {
                text:
                    end === null
                        ? "Invalid history response"
                        : `<output><compartment start="${start}" end="${end}" title="Rebuilt"><p1>Rebuilt ${start}-${end}.</p1></compartment><unprocessed_from>${end + 1}</unprocessed_from></output>`,
                reasoning: null,
                lengthCapped: false,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            };
        },
        close: async () => {},
    };
}

function context(
    db: Database,
    executor: HiddenCompletionExecutor,
    historianMaxOutputTokens?: number,
): ManagedRecompContext {
    return {
        client: undefined as never,
        hiddenCompletionExecutor: executor,
        db,
        liveSessionState: createLiveSessionState(),
        directory: "/tmp/project",
        historianChunkTokens: 10_000,
        historianTimeoutMs: 1_000,
        historianMaxOutputTokens,
        memoryEnabled: false,
        autoPromote: false,
        fallbackModels: [],
        userMemoriesEnabled: false,
        getNotificationParams: () => ({}),
    };
}

async function withMessages<T>(
    sessionId: string,
    count: number,
    run: () => Promise<T>,
    omitIds: number[] = [],
): Promise<T> {
    const raw = Array.from({ length: count }, (_, index) => ({
        ordinal: index + 1,
        id: omitIds.includes(index + 1) ? `replacement-${index + 1}` : `m-${index + 1}`,
        role: "user",
        parts: [{ type: "text", text: `message ${index + 1} alpha beta gamma delta` }],
    }));
    const unregister = rawSession.setRawMessageProvider(sessionId, {
        readMessages: () => raw,
        getMessageCount: () => raw.length,
    });
    try {
        return await run();
    } finally {
        unregister();
    }
}

describe("runManagedRecomp without an OpenCode 1 client", () => {
    // The OpenCode 2 harness owns its own compaction rows, so publication does
    // not write the OpenCode 1 marker; the test runs as that harness.
    beforeEach(() => setHarness("opencode2"));
    afterEach(() => _resetHarnessForTesting());

    it("rebuilds the whole history through the hidden executor", async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-recomp-v2-full";
        const executor = executorCoveringRequestedRange();
        try {
            const message = await withMessages(sessionId, 6, () =>
                runManagedRecomp(context(db, executor), sessionId),
            );
            expect(message).toContain("## Magic Recomp — Complete");
            expect(message).not.toContain("MC-R01");
            expect(executor.opened.length).toBeGreaterThan(0);
            expect(executor.maxOutputCaps.every((cap) => cap === undefined)).toBe(true);
            expect(getCompartments(db, sessionId).at(-1)?.content).toContain("Rebuilt");
        } finally {
            closeQuietly(db);
        }
    });

    it("passes the configured historian output cap to the hidden executor", async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-recomp-v2-output-cap";
        const executor = executorCoveringRequestedRange();
        try {
            await withMessages(sessionId, 6, () =>
                runManagedRecomp(context(db, executor, 65_536), sessionId),
            );
            expect(executor.maxOutputCaps.length).toBeGreaterThan(0);
            expect(executor.maxOutputCaps.every((cap) => cap === 65_536)).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    it("rebuilds a range through the hidden executor", async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-recomp-v2-partial";
        appendCompartments(
            db,
            sessionId,
            [
                [1, 3],
                [4, 6],
            ].map(([start, end], sequence) => ({
                sequence,
                startMessage: start as number,
                endMessage: end as number,
                startMessageId: `m-${start}`,
                endMessageId: `m-${end}`,
                title: `Original ${start}-${end}`,
                content: `Original ${start}-${end}`,
            })),
        );
        const executor = executorCoveringRequestedRange();
        try {
            const message = await withMessages(sessionId, 8, () =>
                runManagedRecomp(context(db, executor), sessionId, { range: { start: 1, end: 3 } }),
            );
            expect(message).not.toContain("MC-R01");
            expect(executor.opened.length).toBeGreaterThan(0);
            expect(getCompartments(db, sessionId).map((row) => row.title)).toEqual([
                "Rebuilt",
                "Original 4-6",
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});

const rebuiltPrefix = {
    sequence: 0,
    startMessage: 1,
    endMessage: 18,
    startMessageId: "m-1",
    endMessageId: "m-18",
    title: "Rebuilt",
    content: "Rebuilt 1-18.",
    p1: "Rebuilt 1-18.",
};

function oldSummary(start: number, end: number, sequence: number) {
    return {
        sequence,
        startMessage: start,
        endMessage: end,
        startMessageId: `m-${start}`,
        endMessageId: `m-${end}`,
        title: `Original ${start}-${end}`,
        content: `Original ${start}-${end}`,
    };
}

describe("full recomp staging", () => {
    let db: Database;
    const sessionId = "ses-recomp-v2-staging";

    beforeEach(() => {
        setHarness("opencode2");
        db = new Database(":memory:");
        initializeDatabase(db);
    });
    afterEach(() => {
        closeQuietly(db);
        _resetHarnessForTesting();
    });

    it("pauses at message 18 without rewriting twelve published summaries or their cache state", async () => {
        appendCompartments(
            db,
            sessionId,
            Array.from({ length: 12 }, (_, i) => oldSummary(i * 4 + 1, Math.min(i * 4 + 4, 46), i)),
        );
        db.prepare(`INSERT OR IGNORE INTO session_meta(session_id) VALUES (?)`).run(sessionId);
        db.prepare(
            `UPDATE session_meta SET cached_m0_bytes = 'frozen m0', cached_m1_bytes = 'frozen m1',
                cached_m0_last_baseline_end_message_id = 'm-46', needs_emergency_recovery = 1,
                pending_compaction_marker_state = '{"ordinal":46}' WHERE session_id = ?`,
        ).run(sessionId);
        const cache = () =>
            db
                .prepare(
                    `SELECT cached_m0_bytes, cached_m1_bytes, cached_m0_last_baseline_end_message_id,
                pending_compaction_marker_state, needs_emergency_recovery FROM session_meta WHERE session_id = ?`,
                )
                .get(sessionId);
        const before = { rows: getCompartments(db, sessionId), cache: cache() };
        const executor = executorCoveringRequestedRange((start) => (start === 1 ? 18 : null));
        const ctx = context(db, executor);
        const message = await withMessages(sessionId, 60, () => runManagedRecomp(ctx, sessionId));

        expect(message).toBe(
            "## Magic Recomp — Paused\n\nRebuilt messages 1-18 of 60, then stopped. History compression could not be rebuilt. (MC-R01)\nYour current history is unchanged.\nRun /ctx-recomp again to continue from message 19.",
        );
        expect(executor.requestedStarts).toContain(19);
        expect({ rows: getCompartments(db, sessionId), cache: cache() }).toEqual(before);
        expect(ctx.liveSessionState.recompProgressBySession.get(sessionId)?.phase).toBe("failed");
        expect(ctx.liveSessionState.historyRefreshSessions.has(sessionId)).toBe(false);
        expect(getRecompStaging(db, sessionId)?.lastEndMessage).toBe(18);

        // Incremental compression is free to publish while no recomp owns the lease.
        appendCompartments(db, sessionId, [oldSummary(47, 50, 12)]);
        const resumed = executorCoveringRequestedRange();
        const completed = await withMessages(sessionId, 64, () =>
            runManagedRecomp(context(db, resumed), sessionId),
        );
        expect(completed).toContain("Resumed from previous interrupted run.");
        expect(resumed.requestedStarts).toEqual([19]);
        expect(getRecompStaging(db, sessionId)).toBeNull();
        const summaries = getCompartments(db, sessionId);
        const coverage = summaries.flatMap(({ startMessage, endMessage }) =>
            Array.from({ length: endMessage - startMessage + 1 }, (_, i) => startMessage + i),
        );
        expect(coverage.at(-1)).toBe(59);
        expect([...coverage, 60, 61, 62, 63, 64]).toEqual(
            Array.from({ length: 64 }, (_, i) => i + 1),
        );

        const controlId = `${sessionId}-uninterrupted`;
        await withMessages(controlId, 64, () =>
            runManagedRecomp(
                context(
                    db,
                    executorCoveringRequestedRange((start, end) => (start === 1 ? 18 : end)),
                ),
                controlId,
            ),
        );
        const summaryBytes = (id: string) =>
            JSON.stringify(
                db
                    .prepare(
                        `SELECT sequence, start_message, end_message, start_message_id, end_message_id,
                title, content, p1, p2, p3, p4, importance, episode_type, start_block_index, end_block_index
             FROM compartments WHERE session_id = ? ORDER BY sequence`,
                    )
                    .all(id),
            );
        expect(summaryBytes(sessionId)).toBe(summaryBytes(controlId));
    });

    it.each([
        0, 16, 18,
    ])("still publishes a valid stopped prefix with live coverage ending at %i", async (liveEnd) => {
        if (liveEnd) {
            appendCompartments(db, sessionId, [
                {
                    ...oldSummary(1, liveEnd, 0),
                    endBlockIndex: liveEnd === 18 ? 0 : null,
                },
            ]);
            if (liveEnd === 16)
                db.prepare(
                    "UPDATE compartments SET end_message_id = NULL WHERE session_id = ?",
                ).run(sessionId);
        }
        const executor = executorCoveringRequestedRange((start) => (start === 1 ? 18 : null));
        const result = await withMessages(sessionId, 60, () =>
            runManagedRecomp(context(db, executor), sessionId),
        );
        expect(result).toContain("## Magic Recomp — Partial");
        expect(getCompartments(db, sessionId).map((c) => [c.title, c.endMessage])).toEqual([
            ["Rebuilt", 18],
        ]);
        expect(getRecompStaging(db, sessionId)).toBeNull();
    });

    it.each([
        { count: 17, omitted: [] },
        { count: 60, omitted: [1] },
        { count: 60, omitted: [18] },
    ])("starts at 1 rather than using a staged range no longer in the host ($count, $omitted)", async ({
        count,
        omitted,
    }) => {
        saveRecompStagingPass(
            db,
            sessionId,
            1,
            [rebuiltPrefix],
            [{ category: "test", content: "old staged fact" }],
        );
        const executor = executorCoveringRequestedRange();
        const result = await withMessages(
            sessionId,
            count,
            () => runManagedRecomp(context(db, executor), sessionId),
            omitted,
        );
        expect(result).toContain("## Magic Recomp — Complete");
        expect(result).not.toContain("Resumed");
        expect(executor.requestedStarts).toEqual([1]);
        expect(getRecompStaging(db, sessionId)).toBeNull();
    });

    it("discards a staged range when starting a full rebuild", async () => {
        saveRecompStagingPass(db, sessionId, 1, [rebuiltPrefix], []);
        setRecompPartialRange(db, sessionId, { start: 1, end: 40 });
        const executor = executorCoveringRequestedRange();
        const result = await withMessages(sessionId, 60, () =>
            runManagedRecomp(context(db, executor), sessionId),
        );
        expect(result).toContain("## Magic Recomp — Complete");
        expect(result).not.toContain("Resumed");
        expect(executor.requestedStarts).toEqual([1]);
        expect(getRecompPartialRange(db, sessionId)).toBeNull();
    });

    it("clears both staging tables when no raw messages remain", async () => {
        saveRecompStagingPass(
            db,
            sessionId,
            1,
            [rebuiltPrefix],
            [{ category: "test", content: "old staged fact" }],
        );
        const executor = executorCoveringRequestedRange();
        const message = await withMessages(sessionId, 0, () =>
            runManagedRecomp(context(db, executor), sessionId),
        );
        expect(message).toContain("No raw history exists");
        expect(executor.requestedStarts).toEqual([]);
        expect(getRecompStaging(db, sessionId)).toBeNull();
        expect(
            db.prepare("SELECT * FROM recomp_facts WHERE session_id = ?").all(sessionId),
        ).toEqual([]);
    });

    it("leaves a paused full prefix for the next full run when a range rebuild refuses it", async () => {
        appendCompartments(db, sessionId, [oldSummary(1, 46, 0)]);
        const stopped = executorCoveringRequestedRange((start) => (start === 1 ? 18 : null));
        expect(
            await withMessages(sessionId, 60, () =>
                runManagedRecomp(context(db, stopped), sessionId),
            ),
        ).toStartWith("## Magic Recomp — Paused");
        const staged = getRecompStaging(db, sessionId);
        expect(staged?.lastEndMessage).toBe(18);

        const range = executorCoveringRequestedRange();
        const refusal = await withMessages(sessionId, 60, () =>
            runManagedRecomp(context(db, range), sessionId, { range: { start: 1, end: 10 } }),
        );
        expect(refusal).toContain("An unfinished full recomp is already staged for this session.");
        expect(range.requestedStarts).toEqual([]);
        expect(getRecompStaging(db, sessionId)).toEqual(staged);

        const resumed = executorCoveringRequestedRange();
        const complete = await withMessages(sessionId, 60, () =>
            runManagedRecomp(context(db, resumed), sessionId),
        );
        expect(complete).toContain("Resumed from previous interrupted run.");
        expect(resumed.requestedStarts).toEqual([19]);
    });

    it.each([
        "window",
        "empty chunk",
        "unsafe chunk",
        "no progress",
    ] as const)("keeps the staged prefix and live history on the %s exit", async (exit) => {
        appendCompartments(db, sessionId, [oldSummary(1, 46, 0)]);
        saveRecompStagingPass(db, sessionId, 1, [rebuiltPrefix], []);
        const liveBefore = getCompartments(db, sessionId);
        const stagingBefore = getRecompStaging(db, sessionId);
        // The no-progress arm is defensive: the real validator rejects such a
        // model response before it reaches the runner. Inject it at that seam.
        const fit =
            exit === "window"
                ? spyOn(fitting, "fitRecompHistorianPrompt").mockReturnValue({
                      ok: false,
                      reason: "fixed instructions exceed the model window",
                  })
                : undefined;
        const coverage =
            exit === "unsafe chunk"
                ? spyOn(validation, "validateChunkCoverage").mockReturnValue(
                      "unrepresented message",
                  )
                : undefined;
        const readChunk = rawSession.readSessionChunk;
        const chunk =
            exit === "empty chunk"
                ? spyOn(rawSession, "readSessionChunk").mockImplementation((...args) => ({
                      ...readChunk(...args),
                      text: "",
                      messageCount: 0,
                  }))
                : undefined;
        const pass =
            exit === "no progress"
                ? spyOn(historian, "runValidatedHistorianPass").mockResolvedValue({
                      ok: true,
                      compartments: [{ ...rebuiltPrefix, sequence: 1, startMessage: 19 }],
                      facts: [],
                  })
                : undefined;
        try {
            const executor = executorCoveringRequestedRange();
            const result = await withMessages(sessionId, 60, () =>
                executeContextRecompWithResult(buildRecompDeps(context(db, executor), sessionId)),
            );
            expect(result.published).toBe(false);
            expect(result.message).toStartWith("## Magic Recomp — Paused");
            const reason = {
                window: "History compression is paused because the history model's context window is too small for its instructions. Set historian.model in magic-context.jsonc to a model with a larger context window. (MC-H05)",
                "empty chunk":
                    "Raw history 19-55 could not be turned into a valid historian chunk. (MC-R01)",
                "unsafe chunk": "The next chunk could not be represented safely. (MC-R01)",
                "no progress": "Recomp made no forward progress after messages 19-55. (MC-R01)",
            }[exit];
            expect(result.message).toContain(reason);
            expect(getRecompStaging(db, sessionId)).toEqual(stagingBefore);
            expect(getCompartments(db, sessionId)).toEqual(liveBefore);
        } finally {
            fit?.mockRestore();
            coverage?.mockRestore();
            chunk?.mockRestore();
            pass?.mockRestore();
        }
    });

    it("discards an invalid final set without publishing or offering it for resume", async () => {
        appendCompartments(db, sessionId, [oldSummary(1, 46, 0)]);
        const liveBefore = getCompartments(db, sessionId);
        const pass = spyOn(historian, "runValidatedHistorianPass").mockResolvedValue({
            ok: true,
            compartments: [{ ...rebuiltPrefix, startMessage: 2, endMessage: 55 }],
            facts: [],
        });
        try {
            const result = await withMessages(sessionId, 60, () =>
                executeContextRecompWithResult(
                    buildRecompDeps(context(db, executorCoveringRequestedRange()), sessionId),
                ),
            );
            expect(result).toEqual({
                published: false,
                message:
                    "## Magic Recomp — Failed\n\nHistory compression could not be rebuilt. Run /ctx-recomp again. (MC-R01)",
            });
            expect(getRecompStaging(db, sessionId)).toBeNull();
            expect(getCompartments(db, sessionId)).toEqual(liveBefore);
        } finally {
            pass.mockRestore();
        }
    });

    it.each([
        false,
        true,
    ])("keeps staging and reports Skipped on lease loss (early stop=%s)", async (early) => {
        appendCompartments(db, sessionId, [oldSummary(1, 46, 0)]);
        const liveBefore = getCompartments(db, sessionId);
        const executor = executorCoveringRequestedRange((start, end) => {
            if (early && start === 1) return 18;
            const holder = db
                .prepare("SELECT holder_id FROM compartment_state_lease WHERE session_id = ?")
                .get(sessionId) as { holder_id: string } | null;
            if (holder) releaseCompartmentLease(db, sessionId, holder.holder_id);
            return early ? null : end;
        });
        const result = await withMessages(sessionId, 60, () =>
            executeContextRecompWithResult(buildRecompDeps(context(db, executor), sessionId)),
        );
        expect(result.message).toStartWith("## Magic Recomp — Skipped");
        expect(result.published).toBe(false);
        expect(getRecompStaging(db, sessionId)?.lastEndMessage).toBe(early ? 18 : 55);
        expect(getCompartments(db, sessionId)).toEqual(liveBefore);
    });
});
