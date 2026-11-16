/// <reference types="bun-types" />

/**
 * Issue 930: what the incremental historian does after the model answers with
 * compartment ranges that do not map to the chunk it was given.
 *
 * The reported session's historian was asked for raw lines 407-432 and named
 * 202-280 instead, a range the session had already summarized. These tests
 * record the current behaviour with a stored compartment 1-4 in front of a
 * chunk that starts at 5, and a model that copies the stored range back:
 *
 * - one run sends the chunk, then a repair prompt carrying the validation
 *   error, and records one failure when the repair is just as wrong;
 * - nothing is published and nothing is skipped, so the next run reads a chunk
 *   that starts at the same message, with the same stored range shown again as a
 *   session reference;
 * - unlike a run whose valid answer made no progress, a run rejected by
 *   validation does not make the next run wait for new history.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { acquireCompartmentLease } from "../../features/magic-context/compartment-lease";
import {
    getCompartments,
    replaceAllCompartmentState,
} from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import { getHistorianFailureState } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import type { PluginContext } from "../../plugin/types";
import { Database } from "../../shared/sqlite";
import { runCompartmentAgent } from "./compartment-runner-incremental";
import { shouldWaitForNewHistorianHistory } from "./historian-history-wait";
import {
    clearProducerModelObservations,
    prepareProducerFixture,
} from "./producer-window-test-support";
import { createDefaultBoundarySnapshotForTests } from "./protected-tail-boundary";
import { setRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";

const cleanups: Array<() => void> = [];
afterEach(() => {
    for (const cleanup of cleanups.reverse()) cleanup();
    cleanups.length = 0;
    clearProducerModelObservations();
});

function message(ordinal: number): RawMessage {
    return {
        ordinal,
        id: `m${ordinal}`,
        role: ordinal % 2 === 1 ? "user" : "assistant",
        parts: [
            {
                type: "text",
                text: `Message ${ordinal}: investigate why the summary of older history keeps failing.`,
            },
        ],
    };
}

/** The stored compartment's own range, as the model wrongly copies it back. */
const COPIED_RANGE_OUTPUT =
    '<compartment start="1" end="4" title="Earlier work"><p1>Copied the earlier summary.</p1></compartment>';

interface HistorianRunRow {
    status: string;
    failure_reason: string | null;
    chunk_start_ordinal: number | null;
    chunk_end_ordinal: number | null;
}

async function fixture() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const sessionId = `issue-930-${crypto.randomUUID()}`;
    const messages = Array.from({ length: 24 }, (_, index) => message(index + 1));
    const unregister = setRawMessageProvider(sessionId, { readMessages: () => messages });
    cleanups.push(() => db.close(), unregister);
    replaceAllCompartmentState(
        db,
        sessionId,
        [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 4,
                startMessageId: "m1",
                endMessageId: "m4",
                title: "Earlier work",
                content: "Summarized the first four messages.",
                p1: "Summarized the first four messages.",
                p2: "First four messages.",
                p3: "Earlier work.",
                p4: "earlier",
            },
        ],
        [],
    );
    const holder = "issue-930-historian";
    expect(acquireCompartmentLease(db, sessionId, holder)).not.toBeNull();
    const prompts: string[] = [];
    const client = {
        session: {
            get: mock(async () => ({ data: { directory: process.cwd() } })),
            create: mock(async () => ({ data: { id: "historian-child" } })),
            prompt: mock(
                async (args: {
                    path?: { id?: string };
                    body?: { parts?: Array<{ text?: string }> };
                }) => {
                    if (args.path?.id === "historian-child") {
                        prompts.push(args.body?.parts?.[0]?.text ?? "");
                    }
                    return {};
                },
            ),
            messages: mock(async () => ({
                data: [
                    {
                        info: { role: "assistant" },
                        parts: [{ type: "text", text: COPIED_RANGE_OUTPUT }],
                    },
                ],
            })),
            delete: mock(async () => ({})),
        },
    } as unknown as PluginContext["client"];
    // The transform starts a new run at 95% after any recorded failure (see
    // startRecoveryRun in transform.ts). Like that run, these runs do not
    // bypass the per-session limit on how much raw history the historian may
    // summarize per time window (forceDrainQuota is left off).
    const run = async () =>
        runCompartmentAgent(
            await prepareProducerFixture({
                db,
                sessionId,
                client,
                directory: process.cwd(),
                historianChunkTokens: 20_000,
                boundarySnapshot: {
                    ...createDefaultBoundarySnapshotForTests(sessionId),
                    usagePercentage: 95,
                },
                compartmentLeaseHolderId: holder,
                memoryEnabled: false,
            }),
        );
    const runs = () =>
        db
            .prepare(
                "SELECT status, failure_reason, chunk_start_ordinal, chunk_end_ordinal FROM historian_runs WHERE session_id = ? ORDER BY id",
            )
            .all(sessionId) as HistorianRunRow[];
    return { db, sessionId, messages, prompts, run, runs };
}

describe("issue 930: historian answer whose ranges do not map to the chunk", () => {
    it("repairs once inside the run, then records one failure and publishes nothing", async () => {
        const { db, sessionId, prompts, run, runs } = await fixture();

        await run();

        // The first prompt shows the stored compartment with its raw range, in
        // the same attribute form the model must use for the new chunk.
        expect(prompts).toHaveLength(2);
        expect(prompts[0]).toContain('<compartment start="1" end="4"');
        expect(prompts[0]).toContain("Messages 5-");
        // The repair prompt is the second model call of the same run.
        expect(prompts[1]).toContain("Your previous XML response was invalid");
        expect(prompts[1]).toContain(
            "Validation error: Historian returned invalid compartment output: Compartment range 1-4 does not map to raw session lines 5-",
        );

        const failure = getHistorianFailureState(db, sessionId);
        expect(failure.failureCount).toBe(1);
        expect(failure.lastError).toContain(
            "Compartment range 1-4 does not map to raw session lines 5-",
        );
        expect(getCompartments(db, sessionId).map((c) => [c.startMessage, c.endMessage])).toEqual([
            [1, 4],
        ]);
        const [row] = runs();
        expect(row?.status).toBe("failed");
        expect(row?.chunk_start_ordinal).toBe(5);
    });

    it("starts the next run at the same message, shows the same reference, and does not wait for new history", async () => {
        const { db, sessionId, messages, prompts, run, runs } = await fixture();

        await run();
        // A validation failure does not arm the wait that a valid answer making
        // no forward progress arms (historian-history-wait.ts).
        expect(
            shouldWaitForNewHistorianHistory({
                ...createDefaultBoundarySnapshotForTests(sessionId),
                usagePercentage: 95,
            }),
        ).toBe(false);

        await run();
        // Nothing new arrived, yet the second run paid for both model calls again.
        expect(prompts).toHaveLength(4);
        expect(prompts[2]).toContain('<compartment start="1" end="4"');

        // New history moves the chunk's end, never its start.
        messages.push(message(25), message(26));
        await run();
        expect(prompts).toHaveLength(6);

        const rows = runs();
        expect(rows.map((row) => row.status)).toEqual(["failed", "failed", "failed"]);
        expect(rows.map((row) => row.chunk_start_ordinal)).toEqual([5, 5, 5]);
        expect(rows[2]!.chunk_end_ordinal!).toBeGreaterThanOrEqual(rows[0]!.chunk_end_ordinal!);
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(3);
        expect(getCompartments(db, sessionId)).toHaveLength(1);
    });
});
