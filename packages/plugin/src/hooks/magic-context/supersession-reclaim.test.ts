/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CTX_REDUCE_KEEP } from "../../features/magic-context/reclaim-protection";
import {
    closeDatabase,
    insertTag,
    openDatabase,
    queuePendingOp,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { buildEditSupersessionReclaim, buildSupersessionReclaimOps } from "./supersession-reclaim";
import { type MessageLike, type TagTarget, tagMessages } from "./tag-messages";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* ignore */
        }
    }
    tempDirs.length = 0;
});

function freshDb(): ReturnType<typeof openDatabase> & object {
    const dir = mkdtempSync(join(tmpdir(), "supersession-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dir;
    const db = openDatabase();
    if (!db) throw new Error("db open failed");
    return db as ReturnType<typeof openDatabase> & object;
}

const SES = "ses-1";

/** A droppable tool target; optional input for ctx_note action / edit filePath reads. */
function target(input?: Record<string, unknown>): TagTarget {
    return {
        setContent: () => true,
        drop: () => "removed",
        truncate: () => "truncated",
        editMarker: () => "truncated",
        canDrop: () => true,
        readInput: () => input ?? null,
    };
}

/** A target whose drop would reclaim nothing (absent/incomplete on this pass). */
function noDropTarget(): TagTarget {
    return { setContent: () => false, canDrop: () => false };
}

function ids(ops: ReturnType<typeof buildSupersessionReclaimOps>): number[] {
    return ops.map((o) => o.tagId).sort((a, b) => a - b);
}

describe("buildSupersessionReclaimOps", () => {
    it("keeps newest 1 todowrite, drops older ones", () => {
        const db = freshDb();
        insertTag(db, SES, "c1", "tool", 100, 1, 0, "todowrite");
        insertTag(db, SES, "c2", "tool", 100, 2, 0, "todowrite");
        insertTag(db, SES, "c3", "tool", 100, 3, 0, "todowrite");
        const targets = new Map<number, TagTarget>([
            [1, target()],
            [2, target()],
            [3, target()],
        ]);
        const ops = buildSupersessionReclaimOps({ db, sessionId: SES, targets });
        // newest (3) kept; 1 and 2 dropped.
        expect(ids(ops)).toEqual([1, 2]);
    });

    it("keeps the newest three ctx_reduce exemplars and drops older ones", () => {
        const db = freshDb();
        const targets = new Map<number, TagTarget>();
        for (let n = 1; n <= 5; n += 1) {
            insertTag(db, SES, `reduce-${n}`, "tool", 40, n, 0, "ctx_reduce");
            targets.set(n, target());
        }
        const ops = buildSupersessionReclaimOps({ db, sessionId: SES, targets });

        expect(ids(ops)).toEqual([1, 2]);
        expect(CTX_REDUCE_KEEP).toBe(3);
    });

    it("drops all zero-value meta (bash_status / bash_kill)", () => {
        const db = freshDb();
        insertTag(db, SES, "c1", "tool", 30, 1, 0, "bash_status");
        insertTag(db, SES, "c2", "tool", 30, 2, 0, "bash_kill");
        const targets = new Map<number, TagTarget>([
            [1, target()],
            [2, target()],
        ]);
        const ops = buildSupersessionReclaimOps({ db, sessionId: SES, targets });
        expect(ids(ops)).toEqual([1, 2]);
    });

    it("drops ctx_note read/dismiss but never write/update; unreadable action is safe", () => {
        const db = freshDb();
        insertTag(db, SES, "c1", "tool", 50, 1, 0, "ctx_note");
        insertTag(db, SES, "c2", "tool", 50, 2, 0, "ctx_note");
        insertTag(db, SES, "c3", "tool", 50, 3, 0, "ctx_note");
        insertTag(db, SES, "c4", "tool", 50, 4, 0, "ctx_note");
        const targets = new Map<number, TagTarget>([
            [1, target({ action: "read" })],
            [2, target({ action: "dismiss" })],
            [3, target({ action: "write" })], // intent — never dropped
            [4, target(undefined)], // unreadable action — fail safe
        ]);
        const ops = buildSupersessionReclaimOps({ db, sessionId: SES, targets });
        expect(ids(ops)).toEqual([1, 2]);
    });

    it("never targets non-superseded tools (read/grep/edit untouched)", () => {
        const db = freshDb();
        insertTag(db, SES, "c1", "tool", 800, 1, 0, "read");
        insertTag(db, SES, "c2", "tool", 800, 2, 0, "grep");
        insertTag(db, SES, "c3", "tool", 800, 3, 0, "edit");
        const targets = new Map<number, TagTarget>([
            [1, target()],
            [2, target()],
            [3, target()],
        ]);
        const ops = buildSupersessionReclaimOps({ db, sessionId: SES, targets });
        expect(ops).toHaveLength(0);
    });

    it("excludes tags already in pendingOps and tags that cannot reclaim", () => {
        const db = freshDb();
        insertTag(db, SES, "c1", "tool", 30, 1, 0, "bash_status");
        insertTag(db, SES, "c2", "tool", 30, 2, 0, "bash_status");
        insertTag(db, SES, "c3", "tool", 30, 3, 0, "bash_status");
        queuePendingOp(db, SES, 2, "drop");
        const targets = new Map<number, TagTarget>([
            [1, target()],
            [2, target()],
            [3, noDropTarget()], // would reclaim nothing
        ]);
        const ops = buildSupersessionReclaimOps({
            db,
            sessionId: SES,
            targets,
            pendingOps: [{ id: 1, sessionId: SES, tagId: 2, operation: "drop", queuedAt: 0 }],
        });
        // 2 already pending, 3 not droppable → only 1.
        expect(ids(ops)).toEqual([1]);
    });
});

describe("buildEditSupersessionReclaim (superseded-edit compression)", () => {
    it("keeps the newest edit per file, marks older edits to the same file", () => {
        const db = freshDb();
        // Two edits to file A, one edit to file B.
        insertTag(db, SES, "c1", "tool", 900, 1, 0, "edit");
        insertTag(db, SES, "c2", "tool", 900, 2, 0, "edit");
        insertTag(db, SES, "c3", "tool", 900, 3, 0, "write");
        const targets = new Map<number, TagTarget>([
            [1, target({ filePath: "A.ts", oldString: "x" })],
            [2, target({ filePath: "A.ts", oldString: "y" })], // newer edit to A
            [3, target({ filePath: "B.ts", content: "z" })],
        ]);
        const { ops, editMarkerTagIds } = buildEditSupersessionReclaim({
            db,
            sessionId: SES,
            targets,
        });
        // newest A (2) and only-B (3) kept; older A (1) compressed.
        expect(ids(ops)).toEqual([1]);
        expect([...editMarkerTagIds]).toEqual([1]);
    });

    it("never marks an edit whose filePath is unresolvable (fail safe)", () => {
        const db = freshDb();
        insertTag(db, SES, "c1", "tool", 900, 1, 0, "edit");
        insertTag(db, SES, "c2", "tool", 900, 2, 0, "edit");
        const targets = new Map<number, TagTarget>([
            [1, target(undefined)], // no input → no filePath
            [2, target(undefined)],
        ]);
        const { ops } = buildEditSupersessionReclaim({ db, sessionId: SES, targets });
        expect(ops).toHaveLength(0);
    });

    it("ignores non-edit tools entirely", () => {
        const db = freshDb();
        insertTag(db, SES, "c1", "tool", 900, 1, 0, "read");
        insertTag(db, SES, "c2", "tool", 900, 2, 0, "read");
        const targets = new Map<number, TagTarget>([
            [1, target({ filePath: "A.ts" })],
            [2, target({ filePath: "A.ts" })],
        ]);
        const { ops } = buildEditSupersessionReclaim({ db, sessionId: SES, targets });
        expect(ops).toHaveLength(0);
    });

    it("excludes non-reclaimable older edits but still marks reclaimable ones", () => {
        const db = freshDb();
        // All three edit A.ts. Newest-first: 3 (kept), 2 (older, reclaimable),
        // 1 (older, but can't reclaim → excluded).
        insertTag(db, SES, "c1", "tool", 900, 1, 0, "edit");
        insertTag(db, SES, "c2", "tool", 900, 2, 0, "edit");
        insertTag(db, SES, "c3", "tool", 900, 3, 0, "edit");
        const targets = new Map<number, TagTarget>([
            [1, { ...noDropTarget(), readInput: () => ({ filePath: "A.ts" }) }],
            [2, target({ filePath: "A.ts" })],
            [3, target({ filePath: "A.ts" })],
        ]);
        const { ops, editMarkerTagIds } = buildEditSupersessionReclaim({
            db,
            sessionId: SES,
            targets,
        });
        expect(ids(ops)).toEqual([2]);
        expect([...editMarkerTagIds]).toEqual([2]);
    });

    it("excludes older edits already queued in pendingOps", () => {
        const db = freshDb();
        insertTag(db, SES, "c1", "tool", 900, 1, 0, "edit");
        insertTag(db, SES, "c2", "tool", 900, 2, 0, "edit");
        const targets = new Map<number, TagTarget>([
            [1, target({ filePath: "A.ts" })],
            [2, target({ filePath: "A.ts" })],
        ]);
        const { ops } = buildEditSupersessionReclaim({
            db,
            sessionId: SES,
            targets,
            pendingOps: [{ id: 1, sessionId: SES, tagId: 1, operation: "drop", queuedAt: 0 }],
        });
        // older A (1) is already pending → not re-emitted.
        expect(ops).toHaveLength(0);
    });

    // Real-target integration: a COMPLETED OpenCode edit is
    // `{ type:"tool", state:{ input, output } }`, classified as a "result"
    // occurrence. The selector must still resolve its filePath (via the
    // readInput result-occurrence fallback) and compress the older one.
    it("resolves filePath from completed {type:tool} parts and marks the older edit", () => {
        const db = freshDb();
        const tagger = createTagger();
        const editPart = (callId: string) => ({
            info: { id: `m-${callId}`, role: "assistant", sessionID: SES },
            parts: [
                {
                    type: "tool",
                    tool: "edit",
                    callID: callId,
                    state: {
                        input: { filePath: "/p/spec.md", oldString: "x".repeat(80) },
                        output: "applied",
                        status: "completed",
                    },
                },
            ],
        });
        const messages = [editPart("call-a"), editPart("call-b")] as unknown as MessageLike[];
        const { targets } = tagMessages(SES, messages, tagger, db);
        const olderId = tagger.getToolTag(SES, "call-a", "m-call-a");
        const newerId = tagger.getToolTag(SES, "call-b", "m-call-b");
        expect(olderId).toBeDefined();
        expect(newerId).toBeDefined();

        const { editMarkerTagIds } = buildEditSupersessionReclaim({
            db,
            sessionId: SES,
            targets,
        });
        // newest (call-b) kept; older (call-a) compressed.
        expect([...editMarkerTagIds]).toEqual([olderId!]);
    });
});
