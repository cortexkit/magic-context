import { expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { isRealUserRequest } from "../../hooks/magic-context/active-anthropic-turn";
import { estimateFinalWireInputTokens } from "../../hooks/magic-context/final-wire-token-estimate";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import { toolReclaimDistanceEntries } from "../../hooks/magic-context/tool-reclaim";
import * as transformModule from "../../hooks/magic-context/transform";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import released from "../fold/__fixtures__/released-owner-rebound.json";
import { type FoldIdentity, FoldOwner } from "../fold/owner";
import { CHECKPOINT_NOTE } from "../fold/summary";
import * as readerModule from "../store-reader";
import { registerContext } from "./context";
import * as generate from "./generate";
import { HiddenChildHook } from "./hidden-child";
import { HEAD_IDS } from "./payload";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context } from "./types";

/**
 * `stored` is the text the host stored for the checkpoint, when it is not the
 * head itself (the checkpoint note); `head: false` leaves the transform's
 * output without history head messages, and `baseline` is the text of the first
 * one. `checkpointID` names the host checkpoint row the fold record answered.
 */
async function fixture(
    options: { stored?: string; head?: boolean; baseline?: string; checkpointID?: string } = {},
) {
    const parent = join(tmpdir(), "magic-context", "checkpoint-head");
    mkdirSync(parent, { recursive: true });
    const dir = createTestTempDirFromPath(join(parent, "fixture-"));
    const db = openDatabase(join(dir, "context.db"));
    if (!db) throw new Error("fixture database unavailable");
    const source = new Database(join(dir, "opencode.db"));
    source.exec(`CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
        time_created INTEGER, time_updated INTEGER, data TEXT
    ); INSERT INTO session_message VALUES ('u1','s','user',1,100,100,'{"text":"unarchived source"}');`);
    const summary = "<session-history>summary</session-history>";
    const stored = options.stored ?? summary;
    source
        .prepare("INSERT INTO session_message VALUES ('cut','s','compaction',2,200,200,?)")
        .run(JSON.stringify({ status: "completed", summary: stored, mode: "local" }));
    const config = MagicContextConfigSchema.parse({
        historian: { disable: true },
        dreamer: { disable: true },
        memory: { enabled: false },
        cache_ttl: "never",
        subc: { connection_file: join(dir, "subc-connection.json") },
    });
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        config,
    } as never);
    const gate = spyOn(storageGate, "createV2StorageGate").mockReturnValue({
        current: () => db,
        require: () => db,
        probe: async () => db,
        reason: () => null,
    });
    const path = spyOn(readerModule, "gaDatabasePath").mockReturnValue(join(dir, "opencode.db"));
    const values = new Map<string, unknown>();
    const storage = {
        get: async (key: string) => structuredClone(values.get(key)),
        set: async (key: string, value: unknown) => {
            values.set(key, structuredClone(value));
        },
    };
    const hooks = new Map<string, (draft: SessionContext) => Promise<void>>();
    let permission = false;
    let insideTransformHadRecent = false;
    let insideHostEstimate: { tokens: number; pressureTokens: number } | undefined;
    let transformInput: MessageLike[] = [];
    const transform = spyOn(transformModule, "createTransform").mockImplementation((deps) => {
        const handler = async (_input: unknown, output: any) => {
            insideTransformHadRecent = JSON.stringify(await storage.get("fold/v1/s")).includes(
                "<recent-context>",
            );
            insideHostEstimate = deps.hostInputEstimate?.("s");
            transformInput = [...output.messages];
            if (options.head !== false)
                output.messages.unshift(
                    ...HEAD_IDS.map((id) => ({
                        info: { id, role: "user", sessionID: "s", syntheticHead: true },
                        parts: [
                            {
                                type: "text",
                                text:
                                    id === HEAD_IDS[0]
                                        ? (options.baseline ?? "current baseline")
                                        : "delta",
                            },
                        ],
                    })),
                );
            deps.onPassPermission?.("s", permission);
        };
        return Object.assign(handler, {
            getRustReplayParticipant: () => null,
            disposeRust: () => {},
        }) as never;
    });
    const host = {
        location: { directory: dir },
        agent: { transform: async () => {}, reload: async () => {} },
        model: { list: () => [] },
        storage,
        event: { subscribe: async function* () {} },
        tool: { hook: async () => {} },
        session: {
            remove: async () => {},
            compact: async () => {},
            wait: async () => {},
            interrupt: async () => ({}),
            hook: async (name: string, callback: (draft: SessionContext) => Promise<void>) => {
                hooks.set(name, callback);
            },
            get: async () => ({ location: { directory: dir } }),
        },
    } as unknown as V2Context;
    let duties = await registerContext(host);
    const checkpoint = {
        id: "cut",
        role: "user",
        content: [
            {
                type: "text",
                text: `<conversation-checkpoint>\n<summary>\n${stored}\n</summary>\n<recent-context>RAW-HOST-TRANSCRIPT</recent-context>\n</conversation-checkpoint>`,
            },
        ],
    };
    const draft = (): SessionContext => ({
        sessionID: "s",
        agent: "build",
        model: { providerID: "p", id: "m", limit: { context: 32000 } },
        system: [],
        tools: {},
        options: {},
        messages: [structuredClone(checkpoint)],
    });
    await new FoldOwner(storage).supply({
        sessionID: "s",
        watermark: 1,
        runningCut: 2,
        materialize: () => summary,
        ...(options.stored === undefined ? {} : { checkpointText: options.stored }),
        checkpointID: options.checkpointID ?? "cut",
    });
    return {
        db,
        hooks,
        draft,
        source,
        storage,
        setPermission: (next: typeof permission) => {
            permission = next;
        },
        insideTransformHadRecent: () => insideTransformHadRecent,
        insideHostEstimate: () => insideHostEstimate,
        transformInput: () => transformInput,
        async restart() {
            await duties.dispose();
            hooks.clear();
            duties = await registerContext(host);
        },
        async close() {
            await duties.dispose();
            transform.mockRestore();
            load.mockRestore();
            gate.mockRestore();
            path.mockRestore();
            source.close();
            closeDatabase();
            cleanupTestTempDir(dir);
        },
    };
}

test("native synthetic provenance is the same in a live window and after checkpoint restore", async () => {
    const f = await fixture();
    try {
        f.source.exec(`INSERT INTO session_message VALUES
            ('auto','s','synthetic',3,300,300,'{"text":"integration update"}'),
            ('human','s','user',4,400,400,'{"text":"human question"}');`);
        const auto = {
            id: "auto",
            role: "user",
            content: [{ type: "text", text: "integration update" }],
        };
        const human = {
            id: "human",
            role: "user",
            content: [{ type: "text", text: "human question" }],
        };
        const turnDecisions = () =>
            ["auto", "human"].map((id) => {
                const row = f.transformInput().find((message) => message.info.id === id)!;
                return [
                    isRealUserRequest(row),
                    toolReclaimDistanceEntries([row], new Map())[0]?.userTurn,
                ];
            });
        const live = f.draft();
        live.messages.push(structuredClone(auto), structuredClone(human));
        await f.hooks.get("context")!(live);
        const liveDecisions = turnDecisions();
        expect(live.messages.find((row) => row.id === "auto")).toEqual(auto);
        expect(live.messages.find((row) => row.id === "human")).toEqual(human);

        // Move the native rows behind the same local checkpoint; the host now
        // leaves them out and the adapter rebuilds them from storage.
        f.source.exec("UPDATE session_message SET seq = 5 WHERE id = 'cut';");
        const restored = f.draft();
        await f.hooks.get("context")!(restored);
        expect(restored.messages.find((row) => row.id === "auto")).toEqual(auto);
        expect(turnDecisions()).toEqual([
            [false, false],
            [true, true],
        ]);
        expect(liveDecisions).toEqual(turnDecisions());
    } finally {
        await f.close();
    }
});

test("hidden maintenance requests skip both replay anchoring and replay capture", async () => {
    const f = await fixture();
    const owns = spyOn(HiddenChildHook.prototype, "owns").mockReturnValue(true);
    const apply = spyOn(HiddenChildHook.prototype, "apply").mockReturnValue(true);
    const anchor = spyOn(generate, "generateReplayAnchor");
    const capture = spyOn(generate.V2GenerateReplay.prototype, "capture");
    try {
        const draft = f.draft();
        const bytes = JSON.stringify(draft);
        await f.hooks.get("context")!(draft);
        expect(apply).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(draft)).toBe(bytes);
        expect(anchor).not.toHaveBeenCalled();
        expect(capture).not.toHaveBeenCalled();
    } finally {
        capture.mockRestore();
        anchor.mockRestore();
        apply.mockRestore();
        owns.mockRestore();
        await f.close();
    }
});

test("checkpoint strip uses this pass's final permission, persists once, and replays on defers", async () => {
    const f = await fixture();
    try {
        const context = f.hooks.get("context")!;
        const deferred = f.draft();
        await context(deferred);
        expect(JSON.stringify(deferred.messages[0])).toContain("RAW-HOST-TRANSCRIPT");
        const originalHead = JSON.stringify(deferred.messages[0]);
        for (let pass = 0; pass < 3; pass++) {
            const replay = f.draft();
            await context(replay);
            expect(JSON.stringify(replay.messages[0])).toBe(originalHead);
        }
        f.setPermission(true);
        const rebuilding = f.draft();
        await context(rebuilding);
        expect(f.insideTransformHadRecent()).toBe(true);
        expect(JSON.stringify(rebuilding.messages[0])).not.toContain("<recent-context>");
        expect(JSON.stringify(await f.storage.get("fold/v1/s"))).not.toContain(
            "RAW-HOST-TRANSCRIPT",
        );
        const head = JSON.stringify(rebuilding.messages[0]);
        f.setPermission(false);
        for (let pass = 0; pass < 3; pass++) {
            const replay = f.draft();
            await context(replay);
            expect(JSON.stringify(replay.messages[0])).toBe(head);
            expect(JSON.stringify(replay.messages)).toContain("unarchived source");
        }
        f.source.prepare("DELETE FROM session_message WHERE id = 'cut'").run();
        const reverted = f.draft();
        reverted.messages = [
            { id: "u1", role: "user", content: [{ type: "text", text: "unarchived source" }] },
        ];
        await context(reverted);
        expect(reverted.messages.some((message) => message.id === "cut")).toBe(false);
    } finally {
        await f.close();
    }
});

test("compaction summary overrides the host keepID with an own undefined key", async () => {
    const f = await fixture();
    try {
        appendCompartments(f.db, "s", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "u1",
                endMessageId: "u1",
                title: "Earlier conversation",
                content: "Earlier conversation summary.",
                p1: "Earlier conversation summary.",
                p2: "Earlier conversation summary.",
                p3: "Earlier conversation summary.",
                p4: "Earlier conversation summary.",
            },
        ]);
        const draft = f.draft();
        await f.hooks.get("compaction")!(draft);
        // The host stores the fixed note; Magic Context's own fold record keeps
        // the history head the checkpoint stands for. This request has no running
        // checkpoint row, so the record the fixture bound to the stored
        // checkpoint stays, and its head is the text it stored.
        expect(draft.result?.summary).toBe(CHECKPOINT_NOTE);
        const owned = (await f.storage.get("fold/v1/s")) as FoldIdentity;
        expect(owned.head ?? owned.submitted).toContain("session-history");
        expect(Object.hasOwn(draft.result?.metadata ?? {}, "keepID")).toBe(true);
        expect({ keepID: "host-default", ...draft.result?.metadata }.keepID).toBeUndefined();
        expect(JSON.parse(JSON.stringify(draft.result)).metadata).toEqual({});
    } finally {
        await f.close();
    }
});

test("a checkpoint that stores the note is served and measured with the head its owner recorded", async () => {
    // One pass over a checkpoint that stores the head itself, as every checkpoint
    // did before the note, and one over a checkpoint that stores the note: the
    // served messages and the checkpoint estimate the scheduler reads must match.
    const served = async (options: { stored?: string; head: boolean }) => {
        const f = await fixture(options);
        try {
            const draft = f.draft();
            await f.hooks.get("context")!(draft);
            return { messages: JSON.stringify(draft.messages), estimate: f.insideHostEstimate() };
        } finally {
            await f.close();
        }
    };
    // With a history head message the checkpoint's summary is replaced by it;
    // without one the checkpoint itself is the only account of earlier history.
    for (const head of [true, false]) {
        const before = await served({ head });
        const note = await served({ stored: CHECKPOINT_NOTE, head });
        expect(before.estimate).toBeDefined();
        expect(note.messages).not.toContain("Magic Context added a compaction marker");
        expect(note.messages).toBe(before.messages);
        expect(note.estimate).toEqual(before.estimate);
    }
});

test("a new legacy checkpoint cannot inherit a reverted checkpoint's head at the same sequence", async () => {
    const logs = spyOn(logger, "sessionLog");
    const f = await fixture({ stored: CHECKPOINT_NOTE, head: false, checkpointID: "cut" });
    try {
        const earlier = f.draft();
        await f.hooks.get("context")!(earlier);
        const oldHead = "<session-history>summary</session-history>";
        expect(JSON.stringify(earlier.messages)).toContain(oldHead);
        expect(((await f.storage.get("fold/v1/s")) as FoldIdentity).rendered?.id).toBe("cut");

        f.source.exec(`DELETE FROM session_message WHERE id = 'cut';
            INSERT INTO session_message VALUES ('replacement','s','compaction',2,300,300,
                '{"status":"running","reason":"auto","mode":"local"}');`);
        const compaction = f.draft();
        compaction.messages = [
            { id: "u1", role: "user", content: [{ type: "text", text: "unarchived source" }] },
        ];
        await f.hooks.get("compaction")!(compaction);
        expect(compaction.result?.summary).toBe(CHECKPOINT_NOTE);
        f.source
            .prepare("UPDATE session_message SET data = ? WHERE id = 'replacement'")
            .run(JSON.stringify({ status: "completed", summary: CHECKPOINT_NOTE, mode: "local" }));

        const pass = async () => {
            const outgoing = f.draft();
            outgoing.messages[0]!.id = "replacement";
            await f.hooks.get("context")!(outgoing);
            return JSON.stringify(outgoing.messages);
        };
        const recovered = await pass();
        expect(recovered).not.toContain(oldHead);
        expect(recovered).not.toContain("<conversation-checkpoint>");
        expect(recovered).toContain("unarchived source");
        expect(await pass()).toBe(recovered);
        await f.restart();
        expect(await pass()).toBe(recovered);
        const lines = logs.mock.calls.map((args) => args.map(String).join(" "));
        expect(lines.filter((line) => line.includes("HARD reason=boot_recovery"))).toHaveLength(1);
    } finally {
        logs.mockRestore();
        await f.close();
    }
});

test("upgrading after the released owner served a reverted head recovers on the next context pass", async () => {
    const f = await fixture({ stored: CHECKPOINT_NOTE, head: false });
    const logs = spyOn(logger, "sessionLog");
    try {
        await f.storage.set("fold/v1/s", released.a);
        const first = f.draft();
        await f.hooks.get("context")!(first);
        expect(JSON.stringify(first.messages)).toContain(released.a.head);

        f.source.exec("DELETE FROM session_message WHERE id = 'cut'");
        f.source
            .prepare(
                "INSERT INTO session_message VALUES ('replacement','s','compaction',2,300,300,?)",
            )
            .run(JSON.stringify({ status: "completed", summary: CHECKPOINT_NOTE, mode: "local" }));
        // The released owner already answered and observed the replacement.
        await f.storage.set("fold/v1/s", released.rebound);
        await f.restart();
        const pass = async () => {
            const draft = f.draft();
            draft.messages = [structuredClone(released.rebound.rendered)];
            await f.hooks.get("context")!(draft);
            return JSON.stringify(draft.messages);
        };
        const recovered = await pass();
        expect(recovered).not.toContain(released.a.head);
        expect(recovered).toContain("unarchived source");
        expect(await pass()).toBe(recovered);
        expect(
            logs.mock.calls.filter((args) => args[1] === "HARD reason=boot_recovery"),
        ).toHaveLength(1);
    } finally {
        logs.mockRestore();
        await f.close();
    }
});

test("a rebuilt fold record still never serves the checkpoint note as history in a window without a head message", async () => {
    // After a revert the host can give a new checkpoint the sequence number of
    // a checkpoint Magic Context already recorded. FoldOwner.supply then reuses
    // that record for the new checkpoint, and FoldOwner.observe discards it on
    // the first pass because its saved rendered message has another id. The
    // record observe rebuilds holds only the text the host stored. A checkpoint
    // that stores the head itself still serves that head; one that stores the
    // note must not serve the note as the account of earlier history.
    const served = async (stored?: string) => {
        const f = await fixture({ ...(stored === undefined ? {} : { stored }), head: false });
        try {
            const record = (await f.storage.get("fold/v1/s")) as FoldIdentity;
            await f.storage.set("fold/v1/s", {
                ...record,
                rendered: {
                    id: "reverted-cut",
                    role: "user",
                    content: [{ type: "text", text: "checkpoint removed by a revert" }],
                },
            });
            const draft = f.draft();
            await f.hooks.get("context")!(draft);
            return JSON.stringify(draft.messages);
        } finally {
            await f.close();
        }
    };
    expect(await served()).toContain("<session-history>summary</session-history>");
    expect(await served(CHECKPOINT_NOTE)).not.toContain("Magic Context added a compaction marker");
});

/** Bind the fixture's fold record to a checkpoint a revert removed. */
async function rebindToRevertedCheckpoint(f: Awaited<ReturnType<typeof fixture>>) {
    const record = (await f.storage.get("fold/v1/s")) as FoldIdentity;
    await f.storage.set("fold/v1/s", {
        ...record,
        rendered: {
            id: "reverted-cut",
            role: "user",
            content: [{ type: "text", text: "checkpoint removed by a revert" }],
        },
    });
}

test("a note checkpoint whose rebuilt record has no head serves restored history, folds once, then replays", async () => {
    // The path the rebuilt-record witness above takes: observe rebuilds the
    // record from the host row and requests a fold (HARD) once; the checkpoint is
    // never served, so the restored rows and the pass's own history head stand
    // in for it on this pass and every later one.
    const logs = spyOn(logger, "sessionLog");
    const f = await fixture({ stored: CHECKPOINT_NOTE, head: false });
    try {
        await rebindToRevertedCheckpoint(f);
        const passes: string[] = [];
        for (let pass = 0; pass < 4; pass++) {
            const draft = f.draft();
            await f.hooks.get("context")!(draft);
            passes.push(JSON.stringify(draft.messages));
        }
        expect(passes[0]).not.toContain("<conversation-checkpoint>");
        expect(passes[0]).toContain("unarchived source");
        for (const later of passes.slice(1)) expect(later).toBe(passes[0]!);
        const lines = logs.mock.calls.map((args) => args.map(String).join(" "));
        expect(lines.filter((line) => line.includes("HARD reason=boot_recovery"))).toHaveLength(1);
        expect(
            lines.filter((line) => line.includes("note checkpoint without a recorded head")),
        ).toHaveLength(4);
        expect(((await f.storage.get("fold/v1/s")) as FoldIdentity).head).toBeUndefined();
    } finally {
        logs.mockRestore();
        await f.close();
    }
});

test("a note checkpoint keeps serving the head recorded for its own row", async () => {
    for (const head of [true, false]) {
        const f = await fixture({ stored: CHECKPOINT_NOTE, head, checkpointID: "cut" });
        try {
            const first = f.draft();
            await f.hooks.get("context")!(first);
            const served = JSON.stringify(first.messages);
            expect(served).toContain("<conversation-checkpoint>");
            expect(served).not.toContain("Magic Context added a compaction marker");
            expect(served).toContain(
                head ? "current baseline" : "<session-history>summary</session-history>",
            );
            const replay = f.draft();
            await f.hooks.get("context")!(replay);
            expect(JSON.stringify(replay.messages)).toBe(served);
        } finally {
            await f.close();
        }
    }
});

test("the served history head replaces the checkpoint summary literally, `$` sequences included", async () => {
    const baseline =
        "<session-history>cost $& and $1 and $' and $$ stay as written</session-history>";
    const f = await fixture({ baseline });
    try {
        const draft = f.draft();
        await f.hooks.get("context")!(draft);
        const text = String(draft.messages[0]?.content[0]?.text);
        expect(text).toContain(`<summary>\n${baseline}\n</summary>`);
    } finally {
        await f.close();
    }
});

function measuredCheckpointDraft(draft: SessionContext): SessionContext {
    draft.model = { ...draft.model, providerID: "openai", id: "gpt-5.5" };
    return draft;
}

test("an oversized deferred checkpoint is refused, then an overflow permission repairs it before egress", async () => {
    const f = await fixture();
    const logs = spyOn(logger, "sessionLog");
    try {
        const oversized = () => {
            const draft = measuredCheckpointDraft(f.draft());
            draft.messages[0]!.content[0]!.text = String(
                draft.messages[0]!.content[0]!.text,
            ).replace("RAW-HOST-TRANSCRIPT", "oversized raw transcript ".repeat(40000));
            return draft;
        };
        await expect(f.hooks.get("context")!(oversized())).rejects.toThrow("Context full");
        expect(
            logs.mock.calls.some(([, message]) => message.includes("arm=checkpoint-over-window")),
        ).toBe(true);
        expect(f.insideHostEstimate()!.tokens).toBeGreaterThan(32000);
        expect(JSON.stringify(await f.storage.get("fold/v1/s"))).toContain("<recent-context>");
        f.setPermission(true);
        const repaired = oversized();
        await f.hooks.get("context")!(repaired);
        expect(JSON.stringify(repaired.messages[0])).not.toContain("<recent-context>");
        expect(JSON.stringify(repaired.messages)).toContain("unarchived source");
    } finally {
        logs.mockRestore();
        await f.close();
    }
});

test("removing recent-context never permits an oversized remaining request", async () => {
    const f = await fixture();
    const logs = spyOn(logger, "sessionLog");
    try {
        f.source
            .prepare("UPDATE session_message SET data=? WHERE id='u1'")
            .run(JSON.stringify({ text: "unsummarized user content ".repeat(40000) }));
        f.setPermission(true);
        await expect(f.hooks.get("context")!(measuredCheckpointDraft(f.draft()))).rejects.toThrow(
            "Context full",
        );
        expect(
            logs.mock.calls.some(([, message]) => message.includes("arm=checkpoint-over-window")),
        ).toBe(true);
        expect(JSON.stringify(await f.storage.get("fold/v1/s"))).not.toContain(
            "RAW-HOST-TRANSCRIPT",
        );
        expect(
            f.source.prepare("SELECT count(*) AS n FROM session_message WHERE id='u1'").get(),
        ).toEqual({ n: 1 });
    } finally {
        logs.mockRestore();
        await f.close();
    }
});

test("checkpoint review: oversized generate suffix is refused after a permitted strip", async () => {
    const f = await fixture();
    try {
        f.setPermission(true);
        const main = measuredCheckpointDraft(f.draft());
        await f.hooks.get("context")!(main);
        expect(JSON.stringify(main.messages[0])).not.toContain("<recent-context>");

        const side = measuredCheckpointDraft(f.draft());
        side.messages.push({
            role: "user",
            content: [{ type: "text", text: "side question beyond the window ".repeat(18000) }],
        });
        const generating = f.hooks.get("generate")!(side);
        await generating.then(
            () => {
                expect(JSON.stringify(side.messages[0])).not.toContain("<recent-context>");
                expect(estimateTokens(JSON.stringify(side.messages))).toBeGreaterThan(32000);
            },
            () => {},
        );
        await expect(generating).rejects.toThrow("Context full");
    } finally {
        await f.close();
    }
});

test("generate refuses an oversized checkpoint without a recent-context block or replay", async () => {
    const f = await fixture();
    const logs = spyOn(logger, "sessionLog");
    try {
        const side = measuredCheckpointDraft(f.draft());
        side.messages[0]!.content[0]!.text =
            `<conversation-checkpoint><summary>${"checkpoint summary ".repeat(40000)}</summary></conversation-checkpoint>`;
        await expect(f.hooks.get("generate")!(side)).rejects.toThrow("Context full");
        expect(
            logs.mock.calls.some(([, message]) => message.includes("arm=checkpoint-over-window")),
        ).toBe(true);
    } finally {
        logs.mockRestore();
        await f.close();
    }
});

test("generate admits an unseeded checkpoint when only the fit margin exceeds the window", async () => {
    const f = await fixture();
    try {
        const draft = f.draft();
        const text = `<conversation-checkpoint><summary>${"checkpoint summary ".repeat(10000)}</summary></conversation-checkpoint>`;
        draft.messages[0]!.content[0]!.text = text;
        const limit = draft.model.limit!.context!;
        const estimate = estimateFinalWireInputTokens({
            messages: [{ info: { role: "user" }, parts: [{ type: "text", text }] }],
            systemPromptTokens: estimateTokens("[]"),
            toolDefinitionTokens: 0,
            providerID: draft.model.providerID,
            modelID: draft.model.id,
            agentName: draft.agent,
        });
        expect(estimate.rawTokens).toBeLessThan(limit);
        expect(estimate.tokens).toBeGreaterThan(limit);
        expect(estimate.refusalGrade).toBe(false);
        await f.hooks.get("generate")!(draft);
        expect(draft.messages[0]!.content[0]!.text).toBe(text);
    } finally {
        await f.close();
    }
});

test("generate refuses an unseeded checkpoint whose local count alone dwarfs the window", async () => {
    const f = await fixture();
    try {
        const draft = f.draft();
        const text = `<conversation-checkpoint><summary>${"checkpoint summary ".repeat(40000)}</summary></conversation-checkpoint>`;
        draft.messages[0]!.content[0]!.text = text;
        expect(estimateTokens(text)).toBeGreaterThan(2 * draft.model.limit!.context!);
        await expect(f.hooks.get("generate")!(draft)).rejects.toThrow("Context full");
    } finally {
        await f.close();
    }
});
