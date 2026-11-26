import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { NativeFoldReplay } from "../fold/native-replay";
import { oc2ContextFixture, prose } from "./__tests__/oc2-context.fixture";

// A compartment can end inside a stored message: it records the index of the
// last block it summarizes (`end_block_index`), and the message's later blocks
// are in no summary. The historian anchors that index at a message's last
// block, so blocks remain only when a message gains blocks after it was
// summarized, for example a tool call that completes later and so gains its
// result. The shared transform keeps such a boundary message raw, which is how
// its unsummarized blocks reach the model. After a host checkpoint the
// OpenCode 2 adapter restores the stored rows the checkpoint replaced; it must
// restore that boundary message too, or its unsummarized blocks vanish from
// every later request although nothing was deleted from the store.

const options = {
    area: "oc2-partial-boundary",
    instructions: false,
    temporal: false,
    cacheTtl: "never",
};

const MARKER = "UNSUMMARIZED_TOOL_SUFFIX_MARKER";

type Fixture = Awaited<ReturnType<typeof oc2ContextFixture>>;
type Pass = Awaited<ReturnType<Fixture["pass"]>>;

const count = (text: string, needle: string) => text.split(needle).length - 1;
const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The served messages that render stored row `id`: its message and the tool results after it. */
function rowBytes(pass: Pass, id: string): string {
    const messages = pass.draft.messages;
    const start = messages.findIndex((message) => message.id === id);
    if (start < 0) return "";
    let end = start + 1;
    while (end < messages.length && messages[end]!.role === "tool" && !messages[end]!.id) end++;
    return JSON.stringify(messages.slice(start, end));
}

/**
 * A session whose newest compartment ends in row 25, a tool step stored as a
 * text block (0), a tool call (1) and its result (2). Rows 0-24 are the
 * fixture's turns. `endBlockIndex` 0 leaves the call and result unsummarized,
 * 1 leaves only the result, 2 (the last block) and undefined cover the row.
 */
async function boundarySession(seed: number, endBlockIndex: number | undefined) {
    const f = await oc2ContextFixture(seed, options);
    f.respondWithTool({ name: "read", input: { path: "src/app.ts" }, output: MARKER });
    f.user(`${seed}: continue ${prose}`, 60000);
    f.respond();
    f.compartment(25, endBlockIndex);
    return { f, boundary: f.rows[25]!.id };
}

/**
 * Serve the session until its request is steady. The pass that first folds a
 * mid-row end into the history head cuts the boundary row whole, and the pass
 * after it puts the row back; that is a separate defect of the shared
 * transform, so the comparisons here start from the steady request.
 */
async function steady(f: Fixture): Promise<Pass> {
    await f.pass();
    const served = await f.pass();
    expect((await f.pass()).bytes).toBe(served.bytes);
    return served;
}

type Checkpoint = "manual" | "automatic" | "legacy" | "ordinary";

async function checkpoint(f: Fixture, kind: Checkpoint): Promise<void> {
    if (kind === "manual" || kind === "ordinary") await f.nativeFold(3, 0, "", "manual");
    else if (kind === "automatic") await f.nativeFold(3, 0, "");
    else await f.fold(0);
    // Without its admission record the checkpoint is an unadmitted local one,
    // which a new process restores by ordinary reconstruction from the store.
    if (kind === "ordinary") {
        await f.hostStorage.set(`native-fold/v3/${encodeURIComponent(f.session)}`, undefined);
        await f.restart();
    }
}

/** The request after a checkpoint, a defer after it and a pass in a new plugin process. */
async function afterCheckpoint(f: Fixture, kind: Checkpoint) {
    await checkpoint(f, kind);
    // Which restore served the pass: the native replay of an admitted fold, or
    // reconstruction from the store's rows.
    const native = spyOn(NativeFoldReplay.prototype, "restore");
    let after: Pass;
    let nativeRestores: number;
    try {
        after = await f.pass();
        nativeRestores = native.mock.calls.length;
    } finally {
        native.mockRestore();
    }
    expect(nativeRestores > 0).toBe(kind === "manual" || kind === "automatic");
    const defer = await f.pass();
    await f.restart();
    const restarted = await f.pass();
    return { after, defer, restarted };
}

for (const [kind, endBlockIndex, seed] of [
    ["manual", 0, 61901],
    ["manual", 1, 61902],
    ["automatic", 0, 61903],
    ["legacy", 0, 61904],
    ["ordinary", 0, 61906],
] as const) {
    const left = endBlockIndex === 0 ? "tool call and result" : "tool result";
    test(`a ${kind} host checkpoint keeps the unsummarized ${left} of a partly summarized boundary row`, async () => {
        const { f, boundary } = await boundarySession(seed, endBlockIndex);
        try {
            const before = await steady(f);
            const served = rowBytes(before, boundary);
            expect(served).toContain(MARKER);
            expect(count(before.bytes, MARKER)).toBe(1);
            const { after, defer, restarted } = await afterCheckpoint(f, kind);
            // Before the fix the restore started strictly after the boundary row,
            // so the tool result was in no message and in no summary.
            expect(count(after.bytes, MARKER)).toBe(1);
            expect(rowBytes(after, boundary)).toBe(served);
            // The checkpoint replaced rows the request already served; the
            // history head is unchanged, so the request is too.
            expect(after.bytes).toBe(before.bytes);
            expect(defer.bytes).toBe(after.bytes);
            expect(restarted.bytes).toBe(after.bytes);
        } finally {
            await f.cleanup();
        }
    }, 60000);
}

test("a session cut by the released plugin restores the unsummarized blocks from its stored admission", async () => {
    const { f, boundary } = await boundarySession(61905, 0);
    try {
        const before = await steady(f);
        const id = await f.nativeFold(3, 0, "", "manual");
        // The stored admission keeps the released format: a summary floor that
        // excludes the boundary row. Nothing about the restore is stored.
        const stored = (await f.hostStorage.get(
            `native-fold/v3/${encodeURIComponent(f.session)}`,
        )) as { payload: string };
        const admission = JSON.parse(stored.payload) as {
            proof: { admissionID: string };
            replay: { floor: { kind: string; id: string; seq: number; after: number } };
        };
        expect(admission.proof.admissionID).toBe(id);
        expect(admission.replay.floor).toMatchObject({ kind: "summary", id: boundary });
        expect(admission.replay.floor.after).toBe(admission.replay.floor.seq);
        // A new plugin process reads that record before serving anything.
        await f.restart();
        const restarted = await f.pass();
        expect(count(restarted.bytes, MARKER)).toBe(1);
        expect(restarted.bytes).toBe(before.bytes);
        expect((await f.pass()).bytes).toBe(restarted.bytes);
    } finally {
        await f.cleanup();
    }
}, 60000);

// A boundary that covers its row whole, with no block index or with the index
// of the row's last block (where a summary normally ends), restores exactly what it
// restored before partly summarized rows were handled. Digests of the requests
// were captured on commit ebf0bf06ea, the last commit before that change.
const WHOLE_ROW: Record<string, Record<Checkpoint, string>> = {
    none: {
        manual: "54fbc74d28b4865b",
        automatic: "16ed9ca72b044e93",
        legacy: "992053b43a85a8ce",
        ordinary: "e6009635949306a5",
    },
    lastBlock: {
        manual: "54fbc74d28b4865b",
        automatic: "16ed9ca72b044e93",
        legacy: "992053b43a85a8ce",
        ordinary: "e6009635949306a5",
    },
};

for (const [name, endBlockIndex] of [
    ["none", undefined],
    ["lastBlock", 2],
] as const) {
    for (const [kind, seed] of [
        ["manual", 62901],
        ["automatic", 62902],
        ["legacy", 62903],
        ["ordinary", 62904],
    ] as const) {
        test(`a ${kind} host checkpoint on a whole-row boundary (${name}) serves the pinned request`, async () => {
            const { f } = await boundarySession(seed, endBlockIndex);
            try {
                await steady(f);
                const { after, defer, restarted } = await afterCheckpoint(f, kind);
                if (process.env.MC_PARTIAL_BOUNDARY_PRINT === "1")
                    console.log(`PIN ${name} ${kind} ${digest(after.bytes)}`);
                expect(digest(after.bytes)).toBe(WHOLE_ROW[name]![kind]);
                expect(defer.bytes).toBe(after.bytes);
                expect(restarted.bytes).toBe(after.bytes);
            } finally {
                await f.cleanup();
            }
        }, 60000);
    }
}
