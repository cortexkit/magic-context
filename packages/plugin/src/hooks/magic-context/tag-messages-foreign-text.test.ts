/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import { getPendingOps, queuePendingOp } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getSourceContents } from "../../features/magic-context/storage-source";
import {
    getTagById,
    getTagsBySession,
    updateCavemanDepth,
    updateTagStatus,
} from "../../features/magic-context/storage-tags";
import { createTagger, type Tagger } from "../../features/magic-context/tagger";
import type { Database as DatabaseType } from "../../shared/sqlite";
import { Database } from "../../shared/sqlite";
import { cavemanCompress } from "./caveman";
import {
    clearLegacyForeignTextTagsForTest,
    collectForeignTextParts,
    isLegacyForeignTextTag,
} from "./foreign-text-parts";
import { type MessageLike, tagMessages } from "./tag-messages";

const SESSION = "ses-foreign-text";

function openTestDb(): DatabaseType {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function stored(id: string, text: string): Record<string, unknown> {
    return { id, type: "text", text };
}

function appended(text: string): Record<string, unknown> {
    // Exactly the shape the other plugin appends: no id or any other field.
    return { type: "text", text };
}

function texts(message: MessageLike): string[] {
    return message.parts.map((part) => (part as { text?: string }).text ?? "");
}

/**
 * One transform pass over fresh copies of `parts`, as OpenCode 1 rebuilds them
 * from storage on every loop step. `foreign: false` reproduces the release
 * before the rule (no capture), to seed legacy rows.
 */
function pass(
    db: DatabaseType,
    tagger: Tagger,
    parts: Record<string, unknown>[],
    options: { foreign?: boolean; replaysCaveman?: boolean } = {},
): MessageLike {
    const message: MessageLike = {
        info: { id: "u", role: "user", sessionID: SESSION },
        parts: structuredClone(parts),
    };
    const messages = [message];
    tagger.initFromDb(SESSION, db);
    const result = tagMessages(
        SESSION,
        messages,
        tagger,
        db,
        options.foreign === false
            ? {}
            : {
                  foreignTextParts: collectForeignTextParts(messages),
                  replaysCaveman: options.replaysCaveman,
              },
    );
    result.batch.finalize();
    return message;
}

afterEach(() => {
    clearLegacyForeignTextTagsForTest();
});

describe("text parts another plugin appends to a stored OpenCode 1 message", () => {
    it("serves an appended part whose text changes exactly as the plugin left it, untagged, on both passes", () => {
        const db = openTestDb();
        const tagger = createTagger();

        const first = pass(db, tagger, [stored("prt_1", "hello"), appended("<marker a/>")]);
        const second = pass(db, tagger, [stored("prt_1", "hello"), appended("<marker b/>")]);

        expect(texts(first)).toEqual(["§1§ hello", "<marker a/>"]);
        expect(texts(second)).toEqual(["§1§ hello", "<marker b/>"]);
        expect(getTagsBySession(db, SESSION).map((tag) => tag.messageId)).toEqual(["u:p0"]);
        expect([...getSourceContents(db, SESSION, [1, 2]).keys()]).toEqual([1]);
    });

    it("leaves id-less parts of a message with no stored part to the existing rule", () => {
        const db = openTestDb();
        const message = pass(db, createTagger(), [appended("fixture text")]);

        expect(texts(message)).toEqual(["§1§ fixture text"]);
    });
});

describe("a tag an older release put on the appended part", () => {
    function seedLegacy(db: DatabaseType, tagger: Tagger, marker = "<marker a/>"): void {
        const seeded = pass(db, tagger, [stored("prt_1", "hello"), appended(marker)], {
            foreign: false,
        });
        expect(texts(seeded)).toEqual(["§1§ hello", `§2§ ${marker}`]);
    }

    it("replays the same bytes across defer passes while the marker is unchanged", () => {
        const db = openTestDb();
        const tagger = createTagger();
        seedLegacy(db, tagger);

        for (let index = 0; index < 2; index += 1) {
            const message = pass(db, tagger, [stored("prt_1", "hello"), appended("<marker a/>")]);
            expect(texts(message)).toEqual(["§1§ hello", "§2§ <marker a/>"]);
        }
        // Nothing is retired or rewritten: the row and its saved copy stay as they were.
        expect(getTagById(db, SESSION, 2)).toMatchObject({ status: "active", messageId: "u:p1" });
        expect(getSourceContents(db, SESSION, [2]).get(2)).toBe("<marker a/>");
        expect(isLegacyForeignTextTag(SESSION, 2)).toBe(true);
    });

    it("puts the prefix on the changed marker and never restores the saved one", () => {
        const db = openTestDb();
        const tagger = createTagger();
        seedLegacy(db, tagger);

        const changed = pass(db, tagger, [stored("prt_1", "hello"), appended("<marker b/>")]);
        const back = pass(db, tagger, [stored("prt_1", "hello"), appended("<marker a/>")]);

        expect(texts(changed)).toEqual(["§1§ hello", "§2§ <marker b/>"]);
        expect(texts(back)).toEqual(["§1§ hello", "§2§ <marker a/>"]);
    });

    it("keeps serving the drop placeholder for a legacy tag the old release dropped, whatever the marker says", () => {
        const db = openTestDb();
        const tagger = createTagger();
        seedLegacy(db, tagger);
        updateTagStatus(db, SESSION, 2, "dropped");

        for (const marker of ["<marker a/>", "<marker b/>", "<marker a/>"]) {
            const message = pass(db, tagger, [stored("prt_1", "hello"), appended(marker)]);
            expect(texts(message)).toEqual(["§1§ hello", "[dropped §2§]"]);
        }
        expect(getTagById(db, SESSION, 2)?.status).toBe("dropped");
    });

    it("serves a compressed legacy tag's caveman bytes while the marker is unchanged, and the prefix on a changed one", () => {
        const marker =
            "<marker>The quick brown fox is really just very quickly jumping over the extremely lazy dog.</marker>";
        const changed = `${marker} again`;
        for (const replaysCaveman of [true, false]) {
            const db = openTestDb();
            const tagger = createTagger();
            seedLegacy(db, tagger, marker);
            updateCavemanDepth(db, SESSION, 2, 1);

            const same = pass(db, tagger, [stored("prt_1", "hello"), appended(marker)], {
                replaysCaveman,
            });
            const moved = pass(db, tagger, [stored("prt_1", "hello"), appended(changed)], {
                replaysCaveman,
            });

            // A fresh session is on the original caveman rules, which the old
            // replay served without a prefix. Without replay the old release
            // served the prefixed saved copy.
            const compressed = cavemanCompress(marker, "lite", "ascii-v1");
            expect(compressed).not.toBe(marker);
            expect(texts(same)[1]).toBe(replaysCaveman ? compressed : `§2§ ${marker}`);
            expect(texts(moved)[1]).toBe(`§2§ ${changed}`);
        }
    });

    it("discards a drop already queued for the legacy tag before the drain can land it", () => {
        const db = openTestDb();
        const tagger = createTagger();
        seedLegacy(db, tagger);
        queuePendingOp(db, SESSION, 2, "drop", Date.now());
        queuePendingOp(db, SESSION, 1, "drop", Date.now());

        pass(db, tagger, [stored("prt_1", "hello"), appended("<marker a/>")]);

        expect(getPendingOps(db, SESSION).map((op) => op.tagId)).toEqual([1]);
    });
});

describe("tag identity around appended parts", () => {
    it("a: an appended part on a position bound to a stored part's tag never gets that part's text", () => {
        const db = openTestDb();
        const tagger = createTagger();
        pass(db, tagger, [stored("prt_1", "one"), stored("prt_2", "two")]);

        const message = pass(db, tagger, [stored("prt_1", "one"), appended("<marker/>")]);

        expect(texts(message)).toEqual(["§1§ one", "§2§ <marker/>"]);
    });

    it("b: the ordinal fallback never hands an appended part's legacy tag to a stored part", () => {
        const db = openTestDb();
        const tagger = createTagger();
        const file = { id: "prt_f", type: "file", url: "file:///a.png", mime: "image/png" };
        pass(db, tagger, [stored("prt_1", "one"), file, appended("<marker/>")], {
            foreign: false,
        });

        // The stored file part became text: its position has no tag, so the
        // fallback looks at the message's second text tag, the marker's.
        const message = pass(db, tagger, [
            stored("prt_1", "one"),
            stored("prt_t", "new"),
            appended("<marker/>"),
        ]);

        expect(texts(message)).toEqual(["§1§ one", "§3§ new", "§2§ <marker/>"]);
        expect(getTagById(db, SESSION, 2)?.messageId).toBe("u:p2");
    });

    it("c: a part inserted between stored parts leaves each stored part on its own tag and text", () => {
        const db = openTestDb();
        const tagger = createTagger();
        const withMarker = (marker: string) => [
            stored("prt_1", "one"),
            appended(marker),
            stored("prt_2", "two"),
        ];

        const first = pass(db, tagger, withMarker("<marker a/>"));
        const second = pass(db, tagger, withMarker("<marker b/>"));
        const without = pass(db, tagger, [stored("prt_1", "one"), stored("prt_2", "two")]);

        expect(texts(first)).toEqual(["§1§ one", "<marker a/>", "§2§ two"]);
        expect(texts(second)).toEqual(["§1§ one", "<marker b/>", "§2§ two"]);
        expect(texts(without)).toEqual(["§1§ one", "§2§ two"]);
    });
});
