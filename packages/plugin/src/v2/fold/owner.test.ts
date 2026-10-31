import { expect, test } from "bun:test";
import * as ownerModule from "./owner";
import { FoldOwner, foldDigest } from "./owner";

function fixture() {
    const data = new Map<string, unknown>();
    const storage = {
        get: async (key: string) => structuredClone(data.get(key)),
        set: async (key: string, value: unknown) => {
            data.set(key, structuredClone(value));
        },
    };
    const owner = new FoldOwner(storage);
    let materializations = 0;
    const supply = (watermark: number, runningCut?: number) =>
        owner.supply({
            sessionID: "s",
            watermark,
            runningCut,
            materialize: () => `baseline ${++materializations}`,
        });
    const rendered = (summary: string) => ({
        id: "cut",
        role: "user",
        content: [
            {
                type: "text",
                text: `<conversation-checkpoint><summary>${summary}</summary><recent-context>host recent</recent-context></conversation-checkpoint>`,
            },
        ],
    });
    return { storage, owner, supply, rendered, count: () => materializations };
}

test("R3a same-watermark provisional firing replays submitted SHA without materializing", async () => {
    const f = fixture();
    const first = await f.supply(12);
    expect((await f.supply(12)).submittedSha).toBe(first.submittedSha);
    expect(f.count()).toBe(1);
});
test("R3a later provisional watermark supersedes the earlier fold", async () => {
    const f = fixture();
    const first = await f.supply(12);
    const second = await f.supply(18);
    expect(second.submittedSha).not.toBe(first.submittedSha);
    expect((await f.owner.read("s"))?.watermark).toBe(18);
    expect(f.count()).toBe(2);
});
test("R3a boot rebinds persisted provisional to actual cut and pins render separately", async () => {
    const f = fixture();
    const pending = await f.supply(12);
    const restarted = new FoldOwner(f.storage);
    const hard: string[] = [];
    const rendered = f.rendered(pending.submitted);
    const bound = await restarted.observe({
        sessionID: "s",
        cutSeq: 29,
        summary: pending.submitted,
        rendered,
        onHard: (reason) => hard.push(reason),
    });
    expect(bound.cutSeq).toBe(29);
    expect(bound.submittedSha).toBe(foldDigest(pending.submitted));
    expect(bound.renderedSha).toBe(foldDigest(JSON.stringify(rendered)));
    expect(bound.renderedSha).not.toBe(bound.submittedSha);
    expect(hard).toEqual([]);
    expect(f.count()).toBe(1);
});
test("R3a cut before provisional watermark is a HARD divergence and is not bound", async () => {
    const f = fixture();
    const pending = await f.supply(18);
    const hard: string[] = [];
    const state = await f.owner.observe({
        sessionID: "s",
        cutSeq: 17,
        summary: pending.submitted,
        rendered: f.rendered(pending.submitted),
        onHard: (reason) => hard.push(reason),
    });
    expect(hard).toEqual(["host_cut_before_watermark"]);
    expect(state.cutSeq).toBeUndefined();
    expect(state.rendered).toBeUndefined();
});
test("I8 mutated host render forces one HARD and never replaces the pinned identity", async () => {
    const f = fixture();
    const pending = await f.supply(12, 20);
    const original = f.rendered(pending.submitted);
    const hard: string[] = [];
    const observe = (summary: string) =>
        f.owner.observe({
            sessionID: "s",
            cutSeq: 20,
            summary,
            rendered: f.rendered(summary),
            onHard: (reason) => hard.push(reason),
        });
    await observe(pending.submitted);
    await observe("mutated");
    const state = await observe("mutated");
    expect(hard).toEqual(["host_rerender"]);
    expect(state.rendered).toEqual(original);
    expect(state.submitted).toBe(pending.submitted);
});
test("R3 local same-cut replay and later-cut fresh materialization", async () => {
    const f = fixture();
    const first = await f.supply(12, 20);
    expect((await f.supply(12, 20)).submittedSha).toBe(first.submittedSha);
    expect(f.count()).toBe(1);
    expect((await f.supply(12, 30)).submittedSha).not.toBe(first.submittedSha);
    expect(f.count()).toBe(2);
});

test("unchanged observations preserve persisted identity without rewriting it", async () => {
    const f = fixture();
    let writes = 0;
    const owner = new FoldOwner({
        get: f.storage.get,
        set: async (key, value) => {
            writes++;
            await f.storage.set(key, value);
        },
    });
    const pending = await f.supply(12);
    const args = {
        sessionID: "s",
        cutSeq: 20,
        summary: pending.submitted,
        rendered: f.rendered(pending.submitted),
        onHard: () => {},
    };
    const first = await owner.observe(args);
    expect(writes).toBe(1);
    const persisted = await owner.read("s");
    for (let i = 0; i < 10; i++) expect(await owner.observe(args)).toEqual(first);
    expect(writes).toBe(1);
    expect(await owner.read("s")).toEqual(persisted);
    await owner.observe({ ...args, summary: "different", rendered: f.rendered("different") });
    expect(writes).toBe(2);
});

test("checkpoint recent-context strip is persisted and replayed after restart without a rerender bust", async () => {
    const f = fixture();
    const pending = await f.supply(12);
    const incoming = {
        ...f.rendered(pending.submitted),
        metadata: { keepID: "u1", recent: "host recent", other: "preserved" },
    };
    const observe = (owner: FoldOwner) =>
        owner.observe({
            sessionID: "s",
            cutSeq: 20,
            summary: pending.submitted,
            rendered: incoming,
            onHard: () => {
                throw new Error("unchanged host checkpoint must not bust again");
            },
        });
    await observe(f.owner);
    const stripped = await f.owner.stripRecentContext("s", "cut");
    expect(JSON.stringify(stripped?.rendered)).not.toContain("<recent-context>");
    expect(stripped?.withoutRecentContext).toBe("cut");
    expect(stripped?.rendered?.metadata).toEqual({ keepID: "u1", other: "preserved" });
    const restarted = new FoldOwner(f.storage);
    for (let pass = 0; pass < 3; pass++) {
        expect((await observe(restarted)).rendered).toEqual(stripped?.rendered);
    }
    expect(incoming.content[0]?.text).toContain("<recent-context>");
});

test("a different host checkpoint id cannot replay the pinned wrapper of a reverted row", async () => {
    const f = fixture();
    const pending = await f.supply(12);
    await f.owner.observe({
        sessionID: "s",
        cutSeq: 20,
        summary: pending.submitted,
        rendered: f.rendered(pending.submitted),
        onHard: () => {},
    });
    const replacement = { ...f.rendered("new summary"), id: "new-cut" };
    const state = await f.owner.observe({
        sessionID: "s",
        cutSeq: 20,
        summary: "new summary",
        rendered: replacement,
        onHard: () => {},
    });
    expect(state.rendered).toEqual(replacement);
    expect(await f.owner.stripRecentContext("s", "cut")).toBeUndefined();
    expect((await f.owner.read("s"))?.rendered).toEqual(replacement);
});

test("stripping a pinned checkpoint does not reprice a previously rejected host summary", async () => {
    const f = fixture();
    const pending = await f.supply(12);
    const hard: string[] = [];
    const observe = (summary: string) =>
        f.owner.observe({
            sessionID: "s",
            cutSeq: 20,
            summary,
            rendered: f.rendered(summary),
            onHard: (reason) => hard.push(reason),
        });
    await observe(pending.submitted);
    await observe("changed host summary");
    await f.owner.stripRecentContext("s", "cut");
    const stripped = await f.owner.read("s");
    for (let pass = 0; pass < 3; pass++) {
        expect((await observe("changed host summary")).rendered).toEqual(stripped?.rendered);
    }
    expect(hard).toEqual(["host_rerender"]);
});

test("stripping the host suffix preserves summary tags and other message parts", () => {
    const summary = "summary with <recent-context>quoted</recent-context> and </summary> tags";
    const message = {
        id: "c",
        role: "user",
        content: [
            {
                type: "text",
                text: `<conversation-checkpoint>\n<summary>\n${summary}\n</summary>\n<recent-context>raw </summary> transcript</recent-context>\n</conversation-checkpoint>`,
            },
            { type: "image", data: "untouched" },
        ],
    };
    expect(ownerModule.stripCheckpointRecentContext(message, summary)).toBe(true);
    expect(message.content[0]?.text).toBe(
        `<conversation-checkpoint>\n<summary>\n${summary}\n</summary>\n</conversation-checkpoint>`,
    );
    expect(message.content[1]).toEqual({ type: "image", data: "untouched" });
    expect(ownerModule.stripCheckpointRecentContext(message, summary)).toBe(false);
});
