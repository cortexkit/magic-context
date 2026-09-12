/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getActiveTagsBySession,
    getTagsBySession,
    getTailHygieneTags,
    insertTag,
    markWhitespaceAssistantTagInert,
} from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import type { Database as DatabaseType } from "../../shared/sqlite";
import { Database } from "../../shared/sqlite";
import { stripDroppedPlaceholderMessages } from "./strip-content";
import { type MessageLike, tagMessages } from "./tag-messages";
import { measureTailHygiene } from "./tail-hygiene-walk";

function openTestDb(): DatabaseType {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function assistant(id: string, parts: unknown[], sessionId: string): MessageLike {
    return {
        info: { id, role: "assistant", sessionID: sessionId },
        parts,
    };
}

function textOf(message: MessageLike, index = 0): string {
    return (message.parts[index] as { text: string }).text;
}

describe("whitespace-only assistant tag transition", () => {
    it("replays an existing whitespace prefix on defer and busting passes", () => {
        const db = openTestDb();
        const sessionId = "ses-whitespace-transition";
        insertTag(db, sessionId, "assistant-blank:p0", "message", 2, 1, 0, null, 0, null, null, {
            tokenCount: 0,
            inputTokenCount: null,
            reasoningTokenCount: null,
        });
        const previousServe = "§1§  \t";

        for (const passClass of ["defer", "bust"] as const) {
            const tagger = createTagger();
            const message = assistant(
                "assistant-blank",
                [{ type: "text", text: " \t" }],
                sessionId,
            );

            tagMessages(sessionId, [message], tagger, db);

            expect(passClass).toMatch(/^(defer|bust)$/);
            expect(textOf(message)).toBe(previousServe);
        }
    });

    it("retires an existing whitespace row from active accounting without wire oscillation", () => {
        const db = openTestDb();
        const sessionId = "ses-whitespace-accounting";
        insertTag(db, sessionId, "assistant-blank:p0", "message", 1, 7, 0, null, 0, null, null, {
            tokenCount: 9,
            inputTokenCount: null,
            reasoningTokenCount: null,
        });
        const served: string[] = [];

        for (let pass = 0; pass < 2; pass += 1) {
            const tagger = createTagger();
            tagger.initFromDb(sessionId, db);
            const message = assistant("assistant-blank", [{ type: "text", text: " " }], sessionId);
            tagMessages(sessionId, [message], tagger, db);
            served.push(textOf(message));

            const hygiene = measureTailHygiene({
                messages: [message],
                tags: getTailHygieneTags(db, sessionId),
                protectedTagNumbers: new Set(),
            });
            expect(hygiene.u).toBe(0);
            expect(getActiveTagsBySession(db, sessionId)).toEqual([]);
        }

        expect(served).toEqual(["§7§  ", "§7§  "]);
        expect(getTagsBySession(db, sessionId)).toMatchObject([
            { tagNumber: 7, status: "compacted" },
        ]);
    });

    it("keeps an inert prefix pinned when a stale source-less assignment occupies the remapped id", () => {
        const db = openTestDb();
        const sessionId = "ses-whitespace-remap-pin";
        insertTag(db, sessionId, "assistant-remap:p0", "message", 1, 1);
        markWhitespaceAssistantTagInert(db, sessionId, 1, "assistant-remap:p0");
        insertTag(db, sessionId, "assistant-other:p0", "message", 1, 2);
        const previousServe = "§1§  ";

        for (let pass = 0; pass < 2; pass += 1) {
            const tagger = createTagger();
            tagger.initFromDb(sessionId, db);
            // Model the stale part-id binding that OpenCode can retain while reverting a part.
            tagger.bindTag(sessionId, "assistant-remap:p1", 2);
            const message = assistant(
                "assistant-remap",
                [
                    { type: "thinking", thinking: "signed", signature: "sig" },
                    { type: "text", text: " " },
                ],
                sessionId,
            );

            tagMessages(sessionId, [message], tagger, db);

            expect(textOf(message, 1)).toBe(previousServe);
            expect(textOf(message, 1)).not.toContain("§2§");
        }

        const rows = getTagsBySession(db, sessionId);
        expect(rows.find((tag) => tag.tagNumber === 1)?.messageId).toBe(
            "__mc_whitespace_assistant_inert__:1",
        );
        expect(rows.find((tag) => tag.tagNumber === 2)).toMatchObject({
            messageId: "assistant-other:p0",
            status: "active",
        });
    });

    it("keeps two inert prefixes in one message on their own parts after a part-id remap", () => {
        const db = openTestDb();
        const sessionId = "ses-whitespace-remap-pair";
        // Two whitespace framing parts tagged before deploy, at part indexes 0 and 2.
        insertTag(db, sessionId, "assistant-pair:p0", "message", 1, 4);
        markWhitespaceAssistantTagInert(db, sessionId, 4, "assistant-pair:p0");
        insertTag(db, sessionId, "assistant-pair:p2", "message", 1, 5);
        markWhitespaceAssistantTagInert(db, sessionId, 5, "assistant-pair:p2");

        for (let pass = 0; pass < 3; pass += 1) {
            const tagger = createTagger();
            tagger.initFromDb(sessionId, db);
            // OpenCode re-assigned part ids and a real text part now precedes the
            // framing, so current text ordinals (1, 2) no longer match the stored
            // ones (0, 1): the ordinal fallback offers the SECOND inert row for the
            // FIRST framing part. Each framing part must keep its own digits.
            const message = assistant(
                "assistant-pair",
                [
                    { type: "text", text: "real answer" },
                    { type: "text", text: " " },
                    { type: "thinking", thinking: "signed", signature: "sig" },
                    { type: "text", text: " " },
                ],
                sessionId,
            );

            tagMessages(sessionId, [message], tagger, db);

            expect(textOf(message, 1)).toBe("§4§  ");
            expect(textOf(message, 3)).toBe("§5§  ");
            expect(textOf(message, 0)).not.toContain("§4§");
            expect(textOf(message, 0)).not.toContain("§5§");
        }
    });

    it("does not move an inert thinking-frame prefix onto a newly appended post-step blank", () => {
        const db = openTestDb();
        const sessionId = "ses-whitespace-late-post-step";
        insertTag(db, sessionId, "assistant-late:p0", "message", 1, 6);
        markWhitespaceAssistantTagInert(db, sessionId, 6, "assistant-late:p0");
        const message = assistant(
            "assistant-late",
            [
                { type: "thinking", thinking: "signed", signature: "sig" },
                { type: "step-finish" },
                { type: "text", text: "" },
            ],
            sessionId,
        );
        const tagger = createTagger();
        tagger.initFromDb(sessionId, db);

        tagMessages(sessionId, [message], tagger, db);

        expect(textOf(message, 2)).toBe("");
        expect(tagger.getTag(sessionId, "assistant-late:p2", "message")).toBeUndefined();
    });

    it("mints a fresh tag when real text reaches an ordinal formerly occupied by inert whitespace", () => {
        const db = openTestDb();
        const sessionId = "ses-whitespace-remap-real";
        insertTag(db, sessionId, "assistant-remap-real:p0", "message", 1, 1);
        markWhitespaceAssistantTagInert(db, sessionId, 1, "assistant-remap-real:p0");
        // Simulate a stale row whose message id moved from whitespace at p0 to the later p1 part.
        db.prepare("UPDATE tags SET message_id = ? WHERE session_id = ? AND tag_number = 1").run(
            "assistant-remap-real:p1",
            sessionId,
        );

        const real = assistant(
            "assistant-remap-real",
            [
                { type: "thinking", thinking: "signed", signature: "sig" },
                { type: "text", text: "real answer" },
            ],
            sessionId,
        );
        tagMessages(sessionId, [real], createTagger(), db);

        expect(textOf(real, 1)).toBe("§2§ real answer");
        expect(
            getTagsBySession(db, sessionId).map((tag) => ({
                tagNumber: tag.tagNumber,
                status: tag.status,
            })),
        ).toEqual([
            { tagNumber: 1, status: "compacted" },
            { tagNumber: 2, status: "active" },
        ]);
    });

    it("never rebinds an inert whitespace tag when real text later occupies that part id", () => {
        const db = openTestDb();
        const sessionId = "ses-whitespace-no-rebind";
        insertTag(db, sessionId, "assistant-changing:p0", "message", 1, 1, 0, null, 0, null, null, {
            tokenCount: 0,
            inputTokenCount: null,
            reasoningTokenCount: null,
        });

        const blank = assistant("assistant-changing", [{ type: "text", text: " " }], sessionId);
        tagMessages(sessionId, [blank], createTagger(), db);
        expect(textOf(blank)).toBe("§1§  ");

        for (let pass = 0; pass < 2; pass += 1) {
            const tagger = createTagger();
            tagger.initFromDb(sessionId, db);
            const real = assistant(
                "assistant-changing",
                [{ type: "text", text: "real answer" }],
                sessionId,
            );
            tagMessages(sessionId, [real], tagger, db);
            expect(textOf(real)).toBe("§2§ real answer");
        }

        expect(
            getTagsBySession(db, sessionId).map((tag) => ({
                tagNumber: tag.tagNumber,
                status: tag.status,
            })),
        ).toEqual([
            { tagNumber: 1, status: "compacted" },
            { tagNumber: 2, status: "active" },
        ]);
    });

    it("keeps leading whitespace before signed thinking byte-identical for both capabilities", () => {
        for (const acceptsEmptySentinels of [true, false] as const) {
            const db = openTestDb();
            const sessionId = `ses-leading-whitespace-${acceptsEmptySentinels}`;
            const message = assistant(
                "assistant-leading",
                [
                    { type: "text", text: " " },
                    { type: "thinking", thinking: "signed", signature: "sig" },
                ],
                sessionId,
            );
            const before = JSON.stringify(message.parts);

            tagMessages(sessionId, [message], createTagger(), db);
            stripDroppedPlaceholderMessages([message], acceptsEmptySentinels);

            expect(JSON.stringify(message.parts)).toBe(before);
            expect(getTagsBySession(db, sessionId)).toEqual([]);
        }
    });

    it("preserves capability-specific wholly blank assistant canonicalization", () => {
        for (const [acceptsEmptySentinels, expected] of [
            [true, ""],
            [false, "[dropped]"],
        ] as const) {
            const db = openTestDb();
            const sessionId = `ses-wholly-blank-${acceptsEmptySentinels}`;
            const message = assistant(
                "assistant-wholly-blank",
                [{ type: "text", text: " \t" }],
                sessionId,
            );

            tagMessages(sessionId, [message], createTagger(), db);
            stripDroppedPlaceholderMessages([message], acceptsEmptySentinels);

            expect(message.parts).toEqual([{ type: "text", text: expected }]);
            expect(getTagsBySession(db, sessionId)).toEqual([]);
        }
    });
});
