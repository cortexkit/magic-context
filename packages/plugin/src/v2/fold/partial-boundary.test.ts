/// <reference types="bun-types" />

import { afterEach, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import {
    type ContextDatabase,
    closeDatabase,
    openDatabase,
} from "../../features/magic-context/storage";
import { moduleRawBlockMappings } from "../../hooks/magic-context/module-wire";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { rawMessagePage } from "../hooks/store";
import type { StoreRow, V2StoreReader } from "../store-reader";
import { hasUnsummarizedBlocks, restoreAfter } from "./partial-boundary";

const SESSION = "ses-partial-boundary";
const tempDirs: string[] = [];
const openDatabases: ContextDatabase[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    while (openDatabases.length > 0) closeDatabase(openDatabases.pop());
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
});

function contextDb(): ContextDatabase {
    const base = join(tmpdir(), "magic-context");
    mkdirSync(base, { recursive: true });
    const dir = createTestTempDirFromPath(join(base, "oc2-partial-boundary-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(join(dir, "cortexkit", "magic-context"), { recursive: true });
    const db = openDatabase();
    if (!db) throw new Error("test database unavailable");
    openDatabases.push(db);
    return db;
}

/**
 * An assistant row holding every block type an OpenCode 2 assistant row can
 * carry: reasoning, text, and a tool call whose result returns text and an image.
 * The host stores no other assistant content types; images otherwise arrive as
 * attachments on user rows.
 */
function assistantRow(toolStatus: "completed" | "running"): StoreRow {
    return {
        id: "a1",
        session_id: SESSION,
        type: "assistant",
        seq: 7,
        data: {
            content: [
                { type: "reasoning", text: "Thinking about the file." },
                { type: "text", text: "Reading it." },
                {
                    type: "tool",
                    id: "call-1",
                    name: "read",
                    state: {
                        status: toolStatus,
                        input: { path: "src/app.png" },
                        ...(toolStatus === "completed"
                            ? {
                                  content: [
                                      { type: "text", text: "image attached" },
                                      {
                                          type: "file",
                                          mime: "image/png",
                                          uri: "data:image/png;base64,AAAA",
                                      },
                                  ],
                              }
                            : {}),
                    },
                },
            ],
        },
    } as unknown as StoreRow;
}

/** A user row with text and an image attachment. */
const userRow = {
    id: "a1",
    session_id: SESSION,
    type: "user",
    seq: 7,
    data: {
        text: "Look at this screenshot.",
        files: [
            {
                mime: "image/png",
                name: "shot.png",
                data: "AAAA",
                source: { type: "inline" },
                mention: { text: "@shot.png" },
            },
        ],
    },
} as unknown as StoreRow;

const readerFor = (row: StoreRow) =>
    ({
        messageById: (sessionID: string, id: string) =>
            sessionID === SESSION && id === row.id ? row : null,
    }) as unknown as V2StoreReader;

function endAt(db: ContextDatabase, endBlockIndex: number | undefined): void {
    db.prepare("DELETE FROM compartments WHERE session_id = ?").run(SESSION);
    appendCompartments(db, SESSION, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "u1",
            endMessageId: "a1",
            ...(endBlockIndex === undefined ? {} : { endBlockIndex }),
            title: "t",
            content: "c",
        },
    ]);
}

it("numbers a stored row's blocks as the module does", () => {
    // The index a compartment stores is in this numbering, the one the plugin
    // also uses to name the module's block ids for an OpenCode 2 row. The image
    // a tool returns belongs to its result block; a user row is one text block,
    // attachments included.
    const blocks = (row: StoreRow) =>
        moduleRawBlockMappings(rawMessagePage([row], 0)[0]!).map((block) => [
            block.blockIndex,
            block.kind,
        ]);
    expect(blocks(assistantRow("completed"))).toEqual([
        [0, "reasoning"],
        [1, "text"],
        [2, "tool_call"],
        [3, "tool_result"],
    ]);
    expect(blocks(userRow)).toEqual([[0, "text"]]);
});

it("finds unsummarized blocks only when an end index stops before the row's last block", () => {
    const db = contextDb();
    const row = assistantRow("completed");
    const reader = readerFor(row);
    const floor = { kind: "summary" as const, id: "a1", seq: 7, after: 7, digest: "x" };
    for (const [endBlockIndex, uncovered] of [
        [0, true],
        [1, true],
        // Ends after the call: its result, with the image, is in no summary.
        [2, true],
        // An index on the row's last block, or no index, covers the row whole.
        [3, false],
        [undefined, false],
    ] as const) {
        endAt(db, endBlockIndex);
        expect(hasUnsummarizedBlocks(db, reader, SESSION, "a1")).toBe(uncovered);
        expect(restoreAfter(db, reader, SESSION, floor)).toBe(uncovered ? 6 : 7);
    }
    endAt(db, 0);
    expect(hasUnsummarizedBlocks(db, readerFor(userRow), SESSION, "a1")).toBe(false);
    // Only a summary floor excludes its own row; other floors are left alone.
    endAt(db, 0);
    expect(restoreAfter(db, reader, SESSION, { ...floor, kind: "checkpoint" })).toBe(7);
    expect(restoreAfter(db, reader, SESSION, { ...floor, kind: "start", after: 6 })).toBe(6);
});

it("counts a result the row gained after it was summarized as unsummarized", () => {
    const db = contextDb();
    // Summarized while the call was still running: its last block was the call (2).
    endAt(db, 2);
    expect(hasUnsummarizedBlocks(db, readerFor(assistantRow("running")), SESSION, "a1")).toBe(
        false,
    );
    // The call completed later and gained its result block (3).
    expect(hasUnsummarizedBlocks(db, readerFor(assistantRow("completed")), SESSION, "a1")).toBe(
        true,
    );
});
