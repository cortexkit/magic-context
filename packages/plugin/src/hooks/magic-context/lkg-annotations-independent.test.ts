/// <reference types="bun-types" />

import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getTagsBySession,
    openDatabase,
    queuePendingOp,
} from "../../features/magic-context/storage";
import {
    appendAutoSearchHintDecision,
    appendNoteNudgeAnchor,
    pruneNoteNudgeAnchors,
    removeAutoSearchHintDecisionByMessageId,
} from "../../features/magic-context/storage-meta-persisted";
import { markTagDropped } from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { applyPendingOperations, renderDroppedText } from "./apply-operations";
import { DegradedPassRefusalError } from "./degraded-pass-refusal";
import { getSlot, resetLkgSlotsForTest } from "./lkg-slot";
import * as noteNudger from "./note-nudger";
import { requestPendingMaterialization } from "./pending-materialization";
import { createTransform } from "./transform";
import { appendReminderToUserMessageById } from "./transform-message-helpers";

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };
type Output = Parameters<ReturnType<typeof createMessagesTransformHandler>>[1];
const note = '\n\n<instruction name="deferred_notes">saved reminder</instruction>';
const hint = "\n\n<ctx-search-hint>saved recall</ctx-search-hint>";
const originalXdgDataHome = process.env.XDG_DATA_HOME;
let tempDir: string | undefined;
let fixtureNumber = 0;

afterEach(() => {
    resetLkgSlotsForTest();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (tempDir) cleanupTestTempDir(tempDir);
    tempDir = undefined;
});

async function fixture(parts: Message["parts"], anchored = false, hideReduce = false) {
    tempDir = createTestTempDir("lkg-annotations-independent-").dir;
    process.env.XDG_DATA_HOME = tempDir;
    const db = openDatabase();
    const sessionId = `independent-annotations-${++fixtureNumber}`;
    const raw = (): Message[] => [
        {
            info: {
                id: "old",
                time: { created: 1 },
                role: "user",
                sessionID: sessionId,
                ...(hideReduce ? { tools: { ctx_reduce: false } } : {}),
            },
            parts: structuredClone(parts),
        },
        {
            info: {
                id: "answer",
                time: { created: 2 },
                role: "assistant",
                sessionID: sessionId,
                finish: "stop",
            },
            parts: [{ type: "text", text: "answer" }],
        },
        {
            info: { id: "tail", time: { created: 3 }, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "next question" }],
        },
    ];
    if (anchored) appendNoteNudgeAnchor(db, sessionId, "old", note);
    const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
    const pendingMaterializationSessions = new Set<string>();
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler,
        contextUsageMap: new Map([
            [sessionId, { usage: { percentage: 40, inputTokens: 80_000 }, updatedAt: Date.now() }],
        ]),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions,
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
        historianRunnable: false,
    });
    const onLkgReplay = mock(() => undefined);
    const handler = createMessagesTransformHandler({
        magicContext: { "experimental.chat.messages.transform": transform },
        onLkgReplay,
    });
    const serve = async () => {
        const output = { messages: raw() } as unknown as Output;
        await handler({}, output);
        expect(onLkgReplay).not.toHaveBeenCalled();
        return output.messages as unknown as Message[];
    };
    await serve();
    await serve();
    expect(getSlot(sessionId)).toBeDefined();
    const tag = (part: number) => {
        const found = getTagsBySession(db, sessionId).find(
            (entry) => entry.messageId === `old:p${part}`,
        );
        if (!found) throw new Error(`Missing tag for part ${part}`);
        return found.tagNumber;
    };
    const failAfter = async (commit: () => void) => {
        const onReplay = mock(() => undefined);
        const failing = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    commit();
                    throw new DegradedPassRefusalError("pending-operation-failure");
                },
            },
            onLkgReplay: onReplay,
        });
        const output = { messages: raw() } as unknown as Output;
        await failing({}, output);
        expect(onReplay).toHaveBeenCalledTimes(1);
        return output.messages as unknown as Message[];
    };
    const old = (messages: Message[]) => messages.find((message) => message.info.id === "old");
    const flush = () =>
        requestPendingMaterialization(pendingMaterializationSessions, sessionId, "user_flush");
    return { db, sessionId, serve, tag, failAfter, old, flush };
}

test("independent: raw same-placeholder prose must still be reduced", () => {
    expect(renderDroppedText(42, "[dropped §42§] private raw payload")).toBe("[dropped §42§]");
});

test("independent: healthy prefix-disabled replay must reduce raw same-placeholder prose", async () => {
    const f = await fixture(
        [{ type: "text", text: "[dropped §1§] private raw payload" }],
        false,
        true,
    );
    const tag = f.tag(0);
    expect(tag).toBe(1);
    markTagDropped(f.db, f.sessionId, tag, "full");
    expect(f.old(await f.serve())?.parts[0].text).toBe("[dropped §1§]");
});

test("independent: reappending a kept note on the first text part is idempotent", () => {
    const messages = [
        {
            info: { id: "old", role: "user" },
            parts: [{ type: "text", text: `[dropped §42§]${note}${hint}` }],
        },
    ];
    const before = JSON.stringify(messages);
    expect(appendReminderToUserMessageById(messages, "old", note)).toBe(true);
    expect(JSON.stringify(messages)).toBe(before);
});

test("independent: healthy drop must not retain a pasted reserved annotation", async () => {
    const f = await fixture([{ type: "text", text: `quoted example${note}${hint}` }]);
    const tag = f.tag(0);
    markTagDropped(f.db, f.sessionId, tag, "full");
    expect(f.old(await f.serve())?.parts[0].text).toBe(`[dropped §${tag}§]`);
});

test("independent: pending healthy drop must not retain a pasted reserved annotation", async () => {
    const f = await fixture([{ type: "text", text: `quoted example${note}${hint}` }]);
    const tag = f.tag(0);
    let content = `§${tag}§ quoted example${note}${hint}`;
    queuePendingOp(f.db, f.sessionId, tag, "drop");
    expect(
        applyPendingOperations(
            f.sessionId,
            f.db,
            new Map([
                [
                    tag,
                    {
                        getContent: () => content,
                        setContent: (next: string) => {
                            const changed = next !== content;
                            content = next;
                            return changed;
                        },
                    },
                ],
            ]),
            new Set(),
        ),
    ).toBe(true);
    expect(content).toBe(`[dropped §${tag}§]`);
});

test("independent: dropping a second part must not duplicate the first part's note", async () => {
    const f = await fixture(
        [
            { type: "text", text: "first body", synthetic: true },
            { type: "text", text: `quoted example${note}`, synthetic: true },
        ],
        true,
    );
    const tag = f.tag(1);
    markTagDropped(f.db, f.sessionId, tag, "full");
    const served = f.old(await f.serve());
    expect(served?.parts[1].text).toBe(`[dropped §${tag}§]`);
    expect(JSON.stringify(served).split("saved reminder").length - 1).toBe(1);
});

for (const synthetic of [false, true]) {
    test(`independent: pruned note replay equals next healthy pass synthetic=${synthetic}`, async () => {
        const f = await fixture([{ type: "text", text: "original body", synthetic }], true);
        const tag = f.tag(0);
        const replayed = await f.failAfter(() => {
            pruneNoteNudgeAnchors(f.db, f.sessionId, new Set());
            markTagDropped(f.db, f.sessionId, tag, "full");
        });
        const healthy = await f.serve();
        expect(JSON.stringify(f.old(replayed))).toBe(JSON.stringify(f.old(healthy)));
    });
}

for (const droppedPart of [0, 1]) {
    test(`independent: two-part note replay equals next healthy pass dropping part ${droppedPart}`, async () => {
        const f = await fixture(
            [
                { type: "text", text: "first body", synthetic: true },
                { type: "text", text: "second body", synthetic: true },
            ],
            true,
        );
        const tag = f.tag(droppedPart);
        const replayed = await f.failAfter(() => markTagDropped(f.db, f.sessionId, tag, "full"));
        const healthy = await f.serve();
        expect(JSON.stringify(f.old(replayed))).toBe(JSON.stringify(f.old(healthy)));
    });
}

for (const alreadyDropped of [false, true]) {
    for (const annotation of ["note", "hint"] as const) {
        test(`independent: frozen ${annotation} survives fallback and defer until SOFT normalizes, alreadyDropped=${alreadyDropped}`, async () => {
            const f = await fixture(
                [{ type: "text", text: "original body", synthetic: true }],
                annotation === "note",
            );
            const tag = f.tag(0);
            if (annotation === "hint") {
                appendAutoSearchHintDecision(f.db, f.sessionId, {
                    messageId: "old",
                    decision: "hint",
                    text: hint,
                });
            }
            if (alreadyDropped) markTagDropped(f.db, f.sessionId, tag, "full");
            const captured = await f.serve();
            expect(f.old(captured)?.parts[0].text).toContain(annotation === "note" ? note : hint);
            const replayed = await f.failAfter(() => {
                if (annotation === "note") pruneNoteNudgeAnchors(f.db, f.sessionId, new Set());
                else removeAutoSearchHintDecisionByMessageId(f.db, f.sessionId, "old");
                markTagDropped(f.db, f.sessionId, tag, "full");
            });
            // Frozen replay policy: retirement cannot rewrite served annotations on
            // a cache-preserving pass. The permitted rebuild that follows the user's
            // flush below may normalize the retired suffix away.
            expect(f.old(replayed)?.parts[0].text).toBe(
                `[dropped §${tag}§]${annotation === "note" ? note : hint}`,
            );
            const deferred = await f.serve();
            expect(JSON.stringify(f.old(deferred))).toBe(JSON.stringify(f.old(replayed)));
            f.flush();
            const soft = await f.serve();
            expect(f.old(soft)?.parts[0].text).toBe(`[dropped §${tag}§]`);
        });
    }
}

test("independent: pruned note stays frozen on defer and normalizes on a permitted SOFT flush", async () => {
    const f = await fixture([{ type: "text", text: "original body", synthetic: true }], true);
    const tag = f.tag(0);
    const replayed = await f.failAfter(() => {
        pruneNoteNudgeAnchors(f.db, f.sessionId, new Set());
        markTagDropped(f.db, f.sessionId, tag, "full");
    });
    // Frozen replay policy retains served annotations through cache-preserving
    // passes; only the permitted rebuild after the user's flush below
    // normalizes the retired note to a plain drop.
    expect(f.old(replayed)?.parts[0].text).toBe(`[dropped §${tag}§]${note}`);
    const deferred = await f.serve();
    expect(JSON.stringify(f.old(deferred))).toBe(JSON.stringify(f.old(replayed)));
    f.flush();
    const soft = await f.serve();
    expect(f.old(soft)?.parts[0].text).toBe(`[dropped §${tag}§]`);
});

for (const synthetic of [false, true]) {
    test(`independent: late-published drop fallback matches the next healthy early replay synthetic=${synthetic}`, async () => {
        const f = await fixture([{ type: "text", text: "source notification", synthetic }], true);
        const tag = f.tag(0);
        // Model a drop published by another writer after early status replay,
        // but before the final healthy sweep reconciles visible committed drops.
        const publication = spyOn(noteNudger, "peekNoteNudgeText").mockImplementation(() => {
            markTagDropped(f.db, f.sessionId, tag, "full");
            return null;
        });
        try {
            await f.serve();
            expect(publication).toHaveBeenCalled();
        } finally {
            publication.mockRestore();
        }
        const replayed = await f.failAfter(() => undefined);
        // A late publication can leave its captured pass inconsistent. Recovery
        // must match the next healthy early drop replay, not that older capture.
        const nextHealthy = await f.serve();
        expect(f.old(nextHealthy)?.parts[0].text).toContain(`[dropped §${tag}§]`);
        expect(f.old(nextHealthy)?.parts[0].text).not.toContain("source notification");
        expect(JSON.stringify(f.old(replayed))).toBe(JSON.stringify(f.old(nextHealthy)));
    });
}
