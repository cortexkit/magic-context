import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { replaceAllCompartments } from "../../features/magic-context/compartment-storage";
import { indexMessagesAfterOrdinal } from "../../features/magic-context/message-index";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createCtxSearchTools } from "../ctx-search/tools";
import { renderSearchArchive } from "./search-archive";
import { createCtxExpandTools } from "./tools";

const toolContext = { sessionID: "ses-expand-validation" } as never;
const tools = createCtxExpandTools({ db: {} as never });

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("ctx_expand ordinal validation", () => {
    it("rejects zero and fractional message ordinals", async () => {
        expect(await tools.ctx_expand.execute({ message: 0 }, toolContext)).toBe(
            "Error: message must be a positive integer.",
        );
        expect(await tools.ctx_expand.execute({ message: 1.5 }, toolContext)).toBe(
            "Error: message must be a positive integer.",
        );
    });

    it("rejects zero and fractional range ordinals", async () => {
        const error =
            "Error: provide either message=<ordinal>, or start and end (positive integers, start <= end).";
        expect(await tools.ctx_expand.execute({ start: 0, end: 1 }, toolContext)).toBe(error);
        expect(await tools.ctx_expand.execute({ start: 1.5, end: 2 }, toolContext)).toBe(error);
        expect(await tools.ctx_expand.execute({ start: 1, end: 2.5 }, toolContext)).toBe(error);
    });
});

describe("ctx_expand required-all filler", () => {
    let db: Database;
    let expandTools: ReturnType<typeof createCtxExpandTools>;

    afterEach(() => {
        closeQuietly(db);
    });

    beforeEach(() => {
        db = createTestDb();
        expandTools = createCtxExpandTools({ db });
    });

    it("matches the clean call for every mode when unused fields are filled", async () => {
        const session = { sessionID: "ses-expand-filler" } as never;
        const rangeClean = await expandTools.ctx_expand.execute({ start: 1, end: 3 }, session);
        const rangeFiller = await expandTools.ctx_expand.execute(
            { start: 1, end: 3, message: 0, verbose: false },
            session,
        );
        const verboseClean = await expandTools.ctx_expand.execute(
            { start: 1, end: 3, verbose: true },
            session,
        );
        const verboseFiller = await expandTools.ctx_expand.execute(
            { start: 1, end: 3, verbose: true, message: 0 },
            session,
        );
        const messageClean = await expandTools.ctx_expand.execute({ message: 2 }, session);
        const messageFiller = await expandTools.ctx_expand.execute(
            { message: 2, start: 0, end: 0, verbose: false },
            session,
        );

        expect(rangeFiller).toBe(rangeClean);
        expect(verboseFiller).toBe(verboseClean);
        expect(messageFiller).toBe(messageClean);
        expect(rangeClean).toContain("No messages found in range 1-3");
        expect(verboseClean).toContain("No messages found in range 1-3");
        expect(messageClean).toContain("No message at ordinal 2");
    });
});

describe("ctx_expand search archive", () => {
    it("recovers a search citation after host history is pruned in every ordinal mode", async () => {
        const db = createTestDb();
        const sessionId = "ses-expand-pruned";
        const original = [
            {
                ordinal: 1,
                id: "old-1",
                role: "user",
                parts: [{ type: "text", text: "ckdev-mutate 0.9.2 was sent by Ada" }],
            },
            {
                ordinal: 2,
                id: "old-2",
                role: "assistant",
                parts: [{ type: "text", text: "The sender was Ada, not the current user" }],
            },
            {
                ordinal: 3,
                id: "current",
                role: "user",
                parts: [{ type: "text", text: "Unrelated surviving message" }],
            },
        ];
        indexMessagesAfterOrdinal(db, sessionId, original, 0);
        replaceAllCompartments(db, sessionId, [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 3,
                title: "Earlier conversation",
                content: "Summary",
                p1: "Summary",
            },
        ]);
        let available = original.slice(2);
        const unregister = setRawMessageProvider(sessionId, {
            readMessages: () => available,
            readMessageIdOrdinalsForRangeOffThread: async (from, to) =>
                new Map(
                    available
                        .filter((message) => message.ordinal >= from && message.ordinal <= to)
                        .map((message) => [message.id, message.ordinal]),
                ),
        });
        try {
            const context = { sessionID: sessionId } as never;
            const search = createCtxSearchTools({
                db,
                resolveProjectPath: () => "git:archive-test",
                memoryEnabled: false,
                embeddingEnabled: false,
            });
            const hit = await search.ctx_search.execute(
                { query: "ckdev-mutate", sources: ["message"], limit: 4 },
                context,
            );
            expect(hit).toContain("ordinal=1");
            expect(hit).toContain("ctx_expand returns indexed text from the search archive only");
            const expand = createCtxExpandTools({ db }).ctx_expand;
            for (const args of [
                { message: 1 },
                { start: 1, end: 3 },
                { start: 1, end: 3, verbose: true },
            ]) {
                const text = await expand.execute(args, context);
                expect(text).toStartWith("From the search archive:");
                expect(text).toContain("[1] U: ckdev-mutate 0.9.2 was sent by Ada");
                expect(text).toContain("no surrounding messages or tool output");
                expect(text).not.toContain("Unrelated surviving message");
                expect(text).not.toContain("No messages found");
            }
            expect(await expand.execute({ message: 3 }, context)).toContain("full recovery:");
            expect(await expand.execute({ start: 4, end: 5 }, context)).toContain(
                "entirely within the live tail",
            );
            available = [{ ...original[2]!, ordinal: 1 }];
            const renumbered = await expand.execute({ message: 1 }, context);
            expect(renumbered).toContain("[1] U: ckdev-mutate 0.9.2 was sent by Ada");
            expect(renumbered).not.toContain("Unrelated surviving message");
        } finally {
            unregister();
            closeQuietly(db);
        }
    });

    it("bounds archived ranges and excludes other sessions, with a continuation", () => {
        const db = createTestDb();
        const sessionId = "ses-archive-budget";
        const unregister = setRawMessageProvider(sessionId, { readMessages: () => [] });
        try {
            const messages = [1, 2, 3].map((ordinal) => ({
                ordinal,
                id: `m${ordinal}`,
                role: "user",
                parts: [{ type: "text", text: `archived text ${ordinal}` }],
            }));
            indexMessagesAfterOrdinal(db, sessionId, messages, 0);
            indexMessagesAfterOrdinal(
                db,
                "ses-other",
                [{ ...messages[0]!, parts: [{ type: "text", text: "PRIVATE OTHER SESSION" }] }],
                0,
            );
            const text = renderSearchArchive(db, sessionId, 1, 3, 1);
            expect(text).toContain("[1] U: archived text 1");
            expect(text).not.toContain("archived text 2");
            expect(text).not.toContain("PRIVATE OTHER SESSION");
            expect(text).toContain("ctx_expand(start=2, end=3)");
            expect(renderSearchArchive(db, sessionId, 4, 5, 100)).toBeNull();
        } finally {
            unregister();
            closeQuietly(db);
        }
    });
});
