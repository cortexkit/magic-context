/// <reference types="bun-types" />

/**
 * Tests for historian turn-one anchors, run through the production OpenCode runner:
 * out-of-order compartments, ranges outside or across compartments, and facts of a
 * reply whose last compartment is discarded. The "review witness" test reproduces a
 * fixed defect (a discarded-tail fact recorded twice once the tail was re-derived;
 * .cortexkit/internal-docs/investigations/reports/memory-s5-review.md) so it cannot return.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
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
import { HISTORIAN_FORMAT_INSTRUCTION } from "../../features/magic-context/memory/turn-one-publication";
import { authorizationFixture } from "../../features/magic-context/memory/turn-two-test-fixtures.test";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import type { PluginContext } from "../../plugin/types";
import { __resetNotificationStateForTests } from "../../shared/rpc-notifications";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT } from "./compartment-prompt";
import { runCompartmentAgent } from "./compartment-runner";
import { settleHistorianTurnTwoRuns } from "./historian-turn-two-step";
import {
    clearProducerModelObservations,
    observeProducerModelsForTest,
    prepareProducerFixture,
} from "./producer-window-test-support";
import { __ignoredNotificationTest } from "./send-session-notification";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(async () => {
    await observeProducerModelsForTest(["test/fixture-historian"]);
    __ignoredNotificationTest.setHoldDetector(() => false);
});

afterEach(async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            settleHistorianTurnTwoRuns(),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error("historian turn-two teardown timed out")),
                    3000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
    clearProducerModelObservations();
    __ignoredNotificationTest.reset();
    __resetNotificationStateForTests();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    tempDirs.length = 0;
});

/**
 * Messages 1-2 are already summarised, 3-12 alternate user and assistant so each is
 * its own printed line, and 13-17 are the protected tail.
 */
function createSession(sessionId: string): Database {
    const dir = createTestTempDirFromPath(join(tmpdir(), "turn-one-review-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    const rawPath = join(dir, "opencode", "opencode.db");
    mkdirSync(dirname(rawPath), { recursive: true });
    const raw = new Database(rawPath);
    try {
        raw.exec(`
            CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE part (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        `);
        for (let ordinal = 1; ordinal <= 17; ordinal += 1) {
            const id = `m-${ordinal}`;
            const role = ordinal <= 12 && ordinal % 2 === 0 ? "assistant" : "user";
            const text = ordinal >= 13 ? `protected ${ordinal}` : `message ${ordinal} text`;
            raw.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(
                id,
                sessionId,
                ordinal,
                ordinal,
                JSON.stringify({ id, role, sessionID: sessionId }),
            );
            raw.prepare(
                "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(id, sessionId, ordinal, ordinal, JSON.stringify({ type: "text", text }));
        }
    } finally {
        closeQuietly(raw);
    }
    const db = openDatabase();
    replaceAllCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "m-1",
            endMessageId: "m-2",
            title: "Earlier work",
            content: "Old summary",
        },
    ]);
    return db;
}

async function runEnabledHistorian(
    db: Database,
    sessionId: string,
    directory: string,
    reply: string,
): Promise<void> {
    const authorization = authorizationFixture(
        {
            lane: "opencode-1",
            carrier: "opencode-session",
            provider: "test",
            modelId: "fixture-historian",
            variant: null,
            temperature: null,
            thinkingLevel: null,
        },
        COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT,
        [],
        HISTORIAN_FORMAT_INSTRUCTION,
    );
    const client = {
        session: {
            get: mock(async () => ({ data: { directory } })),
            create: mock(async () => ({ data: { id: `ses-agent-${Math.random()}` } })),
            prompt: mock(async () => ({})),
            messages: mock(async () => ({
                data: [
                    {
                        info: { role: "assistant", time: { created: 1 } },
                        parts: [{ type: "text", text: authorization.turnOne(reply) }],
                    },
                ],
            })),
            delete: mock(async () => ({})),
        },
    } as unknown as PluginContext["client"];
    const holderId = `review-holder-${Math.random()}`;
    expect(acquireCompartmentLease(db, sessionId, holderId)).not.toBeNull();
    try {
        await runCompartmentAgent(
            await prepareProducerFixture({
                client,
                db,
                sessionId,
                historianChunkTokens: 10_000,
                directory,
                compartmentLeaseHolderId: holderId,
                forceDrainQuota: true,
                memoryLifecycleLane: "enabled",
                memoryLifecycleValidatedProfiles: authorization.rows,
            }),
        );
    } finally {
        releaseCompartmentLease(db, sessionId, holderId);
    }
}

function compartmentXml(start: number, end: number, title: string): string {
    return `<compartment start="${start}" end="${end}" title="${title}"><p1>${title} summary.</p1><p2>${title}.</p2><p3>${title}.</p3><p4/></compartment>`;
}

function candidates(db: Database) {
    return db
        .prepare(
            "SELECT content, compartment_id, anchor_known FROM memory_pending_facts ORDER BY id",
        )
        .all() as Array<{ content: string; compartment_id: number | null; anchor_known: number }>;
}

describe("historian turn one review: anchors through the production runner", () => {
    it("binds anchors of out-of-order compartments by range and never to a compartment that does not contain the cited lines", async () => {
        const sessionId = "ses-review-out-of-order";
        const directory = "/tmp/turn-one-review-out-of-order";
        const db = createSession(sessionId);
        // Emitted out of order; 7-12 stay as lookahead, so discard-last does not apply.
        const reply = `<output><compartments>
${compartmentXml(5, 6, "Later")}
${compartmentXml(3, 4, "Earlier")}
</compartments>
<facts>
<CONSTRAINTS>
* [at_compartment=1 messages=5] Fact from the later compartment.
* [at_compartment=2 messages=3-4] Fact from the earlier compartment.
* [at_compartment=1 messages=3] Fact citing lines outside the named compartment.
* [at_compartment=2 messages=4-5] Fact citing lines across two compartments.
* [at_compartment=2 messages=3,4] Fact citing separate earlier source ranges.
* [at_compartment=1 messages=5,3] Fact whose second range is outside the named compartment.
* [at_compartment=3 messages=7] Fact naming a compartment that was never emitted.
</CONSTRAINTS>
</facts>
<meta><unprocessed_from>7</unprocessed_from></meta>
</output>`;

        await runEnabledHistorian(db, sessionId, directory, reply);

        const rows = getCompartments(db, sessionId);
        expect(rows.map((row) => [row.startMessage, row.endMessage])).toEqual([
            [1, 2],
            [3, 4],
            [5, 6],
        ]);
        const [, earlier, later] = rows;
        expect(candidates(db)).toEqual([
            {
                content: "Fact from the later compartment.",
                compartment_id: later!.id,
                anchor_known: 1,
            },
            {
                content: "Fact from the earlier compartment.",
                compartment_id: earlier!.id,
                anchor_known: 1,
            },
            {
                content: "Fact citing lines outside the named compartment.",
                compartment_id: null,
                anchor_known: 0,
            },
            {
                content: "Fact citing lines across two compartments.",
                compartment_id: null,
                anchor_known: 0,
            },
            {
                content: "Fact citing separate earlier source ranges.",
                compartment_id: earlier!.id,
                anchor_known: 1,
            },
            {
                content: "Fact whose second range is outside the named compartment.",
                compartment_id: null,
                anchor_known: 0,
            },
            // "Fact naming a compartment that was never emitted" is not recorded: an
            // index past the published compartments is dropped (keepPublishedFact).
        ]);
        // Each citation range is one source block, even when it spans several printed lines.
        expect(
            db
                .prepare(
                    `SELECT f.content, b.start_ordinal, b.end_ordinal FROM memory_fact_block_links l
                     JOIN memory_pending_facts f ON f.id=l.fact_id JOIN memory_fact_blocks b ON b.id=l.block_id
                     ORDER BY f.id, b.start_ordinal`,
                )
                .all(),
        ).toEqual([
            { content: "Fact from the later compartment.", start_ordinal: 5, end_ordinal: 5 },
            { content: "Fact from the earlier compartment.", start_ordinal: 3, end_ordinal: 4 },
            {
                content: "Fact citing separate earlier source ranges.",
                start_ordinal: 3,
                end_ordinal: 3,
            },
            {
                content: "Fact citing separate earlier source ranges.",
                start_ordinal: 4,
                end_ordinal: 4,
            },
        ]);
    });

    it("review witness: a fact anchored to the discarded tail compartment is recorded once, not again when the tail is re-derived", async () => {
        const sessionId = "ses-review-discard-last";
        const directory = "/tmp/turn-one-review-discard-last";
        const db = createSession(sessionId);
        // The reply's last compartment (7-12) ends at the end of the messages the
        // historian was sent, so it had no lookahead: the runner discards it, and the
        // next run summarises messages 7-12 again. The model cites the same source
        // lines both times.
        const first = `<output><compartments>
${compartmentXml(3, 6, "Head")}
${compartmentXml(7, 12, "Tail")}
</compartments>
<facts>
<CONSTRAINTS>
* [at_compartment=1 messages=5] Fact from the head.
* [at_compartment=2 messages=9] Fact from the tail.
</CONSTRAINTS>
</facts>
</output>`;
        await runEnabledHistorian(db, sessionId, directory, first);
        expect(
            getCompartments(db, sessionId).map((row) => [row.startMessage, row.endMessage]),
        ).toEqual([
            [1, 2],
            [3, 6],
        ]);

        const second = `<output><compartments>
${compartmentXml(7, 8, "Tail again")}
</compartments>
<facts>
<CONSTRAINTS>
* [at_compartment=1 messages=8] Fact from the tail.
</CONSTRAINTS>
</facts>
<meta><unprocessed_from>9</unprocessed_from></meta>
</output>`;
        await runEnabledHistorian(db, sessionId, directory, second);

        const tail = candidates(db).filter((row) => row.content === "Fact from the tail.");
        expect(tail).toHaveLength(1);
    });
});
