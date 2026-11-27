import { expect, spyOn, test } from "bun:test";
import * as transformModule from "../../hooks/magic-context/transform";
import { getV2StoreReaderDebugCounters, V2StoreReader } from "../store-reader";
import {
    installTransientFailure,
    type Oc2ContextFixture,
    oc2ContextFixture,
} from "./__tests__/oc2-context.fixture";
import { deliverSynthetic } from "./channel2";
import { STORAGE_NOTICE_PREFIX } from "./storage-notice";

const sideQuestion = "One quick side question.";
const sideMessage = { role: "user", content: [{ type: "text", text: sideQuestion }] };

test("an interrupted main turn cannot replace the managed prefix for a side question", async () => {
    const f = await oc2ContextFixture(981, { area: "generate-refusal" });
    const interrupt = spyOn(f.hostSession, "interrupt");
    const latest = spyOn(V2StoreReader.prototype, "latestAssistant");
    try {
        const served = await f.pass();
        expect(served.draft.messages).not.toEqual(served.input);
        const matchingPrefix = [...served.draft.messages, sideMessage];
        expect((await f.generate(sideQuestion)).messages).toEqual(matchingPrefix);

        latest.mockImplementation(() => {
            throw new Error("cannot read latest usage");
        });
        const refused = await f.attempt();
        expect(refused.error).toBeUndefined();
        expect(refused.logs).toContainEqual(expect.stringContaining("arm=usage-unavailable"));
        expect(interrupt).toHaveBeenCalledWith({ sessionID: f.session });
        expect(refused.draft.messages).toEqual(refused.input);
        expect((await f.generate(sideQuestion)).messages).toEqual(matchingPrefix);

        f.edit(f.rows[0]!.id, "The host history no longer matches the managed prefix.");
        f.user("This new turn does not reach the provider either.", 1000);
        const changed = await f.attempt();
        expect(changed.error).toBeUndefined();
        expect(interrupt).toHaveBeenCalledTimes(2);
        const unmatched = await f.generate(sideQuestion);
        expect(unmatched.messages).toEqual([...changed.input, sideMessage]);
        expect(f.sessionLogs().at(-1)).toContain("generate replay apply skipped:");
    } finally {
        latest.mockRestore();
        interrupt.mockRestore();
        await f.cleanup();
    }
});

test("a transform that interrupts and returns cannot replace the side-question prefix", async () => {
    const f = await oc2ContextFixture(9811, { area: "generate-refusal" });
    const interrupt = spyOn(f.hostSession, "interrupt");
    const create = transformModule.createTransform;
    let refuse = false;
    const standIn = spyOn(transformModule, "createTransform").mockImplementation((deps) => {
        const real = create(deps);
        const run: typeof real = Object.assign(async (...args: Parameters<typeof real>) => {
            if (!refuse) return real(...args);
            await deps.hostRefuse!(undefined, f.session);
        }, real);
        return run;
    });
    try {
        const served = await f.pass();
        expect(served.draft.messages).not.toEqual(served.input);
        refuse = true;
        const turn = await f.attempt();
        expect(turn.error).toBeUndefined();
        expect(turn.logs).toContainEqual(expect.stringContaining("arm=transform-fail-closed"));
        expect(interrupt).toHaveBeenCalledTimes(1);
        expect((await f.generate(sideQuestion)).messages).toEqual([
            ...served.draft.messages,
            sideMessage,
        ]);
    } finally {
        standIn.mockRestore();
        interrupt.mockRestore();
        await f.cleanup();
    }
});

test("an interrupted storage-notice turn cannot replace the side-question prefix", async () => {
    const f = await oc2ContextFixture(9812, { area: "generate-refusal" });
    const interrupt = spyOn(f.hostSession, "interrupt");
    try {
        const served = await f.pass();
        const text = `${STORAGE_NOTICE_PREFIX}Storage is unavailable.`;
        const id = await deliverSynthetic(
            {
                storage: f.hostStorage,
                session: { ...f.hostSession, synthetic: async () => ({}) },
            },
            f.session,
            text,
        );
        const turn = await f.pass((draft) => {
            // A storage wake comes after the previous turn settled, and the
            // host has already promoted its notice from the inbox into history.
            const last = f.rows.at(-1)!;
            const insert = f.raw.prepare(
                "INSERT INTO session_message(id,session_id,type,seq,time_created,data) VALUES (?,?,?,?,?,?)",
            );
            insert.run(
                `idle-${id}`,
                f.session,
                "idle",
                last.seq + 1,
                last.created + 1,
                JSON.stringify({ outcome: "interrupted", time: { created: last.created + 1 } }),
            );
            insert.run(
                id,
                f.session,
                "synthetic",
                last.seq + 2,
                last.created + 2,
                JSON.stringify({ text, time: { created: last.created + 2 } }),
            );
            draft.messages.push({ id, role: "user", content: [{ type: "text", text }] });
        });
        expect(turn.logs).toContainEqual(expect.stringContaining("arm=storage-notice-turn"));
        expect(interrupt).toHaveBeenCalledTimes(1);
        expect((await f.generate(sideQuestion)).messages).toEqual([
            ...served.draft.messages,
            sideMessage,
        ]);
    } finally {
        interrupt.mockRestore();
        await f.cleanup();
    }
});

test("a served last-good replay is saved for the next side question", async () => {
    const f = await oc2ContextFixture(9813, { area: "generate-refusal" });
    const failure = installTransientFailure();
    try {
        await f.pass();
        f.respond();
        f.user("Continue from the reply.", 1000);
        failure.state.failNext = true;
        const replay = await f.pass();
        expect(replay.logs).toContainEqual(expect.stringContaining("lkg_replay_served"));
        expect((await f.generate(sideQuestion)).messages).toEqual([
            ...replay.draft.messages,
            sideMessage,
        ]);

        // An edit to the user row appended by the replay must break its anchor.
        // The prior managed request anchored before this row would still match.
        f.edit(f.rows.at(-1)!.id, "The host edited the resumed question.");
        const afterEdit = await f.generate(sideQuestion);
        expect(afterEdit.messages).not.toEqual([...replay.draft.messages, sideMessage]);
        expect(f.sessionLogs().at(-1)).toContain("generate replay apply skipped: history-mismatch");
    } finally {
        failure.restore();
        await f.cleanup();
    }
});

const noticeText = `${STORAGE_NOTICE_PREFIX}Storage is unavailable.`;
const copyId = "msg_forkEvent_90";
const storageDraft = (id: string, role = "user", text = noticeText) => ({
    id,
    role,
    content: [{ type: "text", text }],
});

function storeRow(f: Oc2ContextFixture, id: string, type: string, seq: number, data = {}) {
    f.raw
        .prepare(
            "INSERT INTO session_message(id,session_id,type,seq,time_created,data) VALUES (?,?,?,?,?,?)",
        )
        .run(
            id,
            f.session,
            type,
            seq,
            Date.now(),
            JSON.stringify({ time: { created: Date.now() }, ...data }),
        );
}

function admitNotice(f: Oc2ContextFixture) {
    return deliverSynthetic(
        { storage: f.hostStorage, session: { ...f.hostSession, synthetic: async () => ({}) } },
        f.session,
        noticeText,
    );
}

test.each([
    "notice wake",
    "fork copy",
])("disposing the plugin releases the host reader used by a %s", async (source) => {
    const before = getV2StoreReaderDebugCounters().openReaders;
    const f = await oc2ContextFixture(9814, { area: "generate-refusal" });
    try {
        if (source === "notice wake") {
            const id = await admitNotice(f);
            f.respond();
            storeRow(f, "idle", "idle", 80, { outcome: "succeeded" });
            storeRow(f, id, "synthetic", 90, { text: noticeText });
            await f.pass((draft) => {
                draft.messages.push(storageDraft(id));
            });
        } else {
            storeRow(f, copyId, "synthetic", 90, { text: noticeText });
            const draft = await f.generate(sideQuestion, (draft) => {
                draft.messages.push(storageDraft(copyId));
            });
            expect(draft.messages.some((m) => m.id === copyId)).toBe(false);
        }
    } finally {
        await f.cleanup();
    }
    expect(getV2StoreReaderDebugCounters().openReaders).toBe(before);
});

test.each([
    ["unreadable idle", 90],
    ["missing notice", undefined],
    ["notice at the latest idle sequence", 80],
    ["notice older than the latest idle", 79],
] as const)("a storage wake is refused with %s even when the draft has a later user row", async (reason, noticeSeq) => {
    const f = await oc2ContextFixture(9815, { area: "generate-refusal" });
    const interrupt = spyOn(f.hostSession, "interrupt");
    const latestIdle = spyOn(V2StoreReader.prototype, "latestIdle");
    try {
        const id = await admitNotice(f);
        storeRow(f, "idle", "idle", 80, { outcome: "interrupted" });
        storeRow(f, "later-user", "user", 81, { text: "New input in the draft." });
        if (noticeSeq !== undefined) storeRow(f, id, "synthetic", noticeSeq, { text: noticeText });
        if (reason === "unreadable idle")
            latestIdle.mockImplementation(() => {
                throw new Error("idle record read failed");
            });
        const turn = await f.pass((draft) => {
            draft.messages.push(
                storageDraft("later-user", "user", "New input in the draft."),
                storageDraft(id),
            );
        });
        expect(interrupt).toHaveBeenCalledTimes(1);
        expect(turn.logs).toContainEqual(expect.stringContaining("arm=storage-notice-turn"));
        if (reason === "unreadable idle" || reason === "missing notice") {
            expect(turn.logs).toContainEqual(
                expect.stringContaining("v2 storage notice step refused:"),
            );
        }
    } finally {
        latestIdle.mockRestore();
        interrupt.mockRestore();
        await f.cleanup();
    }
});

test("generate strips a storage notice even when compaction is off", async () => {
    const f = await oc2ContextFixture(9816, {
        area: "generate-refusal",
        configOverrides: { compaction: { enabled: false } },
    });
    try {
        const id = await admitNotice(f);
        const control = await f.generate(sideQuestion);
        const actual = await f.generate(sideQuestion, (draft) => {
            draft.messages.push(storageDraft(id));
        });
        expect(actual.messages).toEqual(control.messages);
    } finally {
        await f.cleanup();
    }
});

test("a failed generate notice lookup leaves the side question and its draft intact", async () => {
    const f = await oc2ContextFixture(9817, {
        area: "generate-refusal",
        configOverrides: { compaction: { enabled: false } },
    });
    const read = spyOn(V2StoreReader.prototype, "messageById");
    try {
        const id = await admitNotice(f);
        const control = await f.generate(sideQuestion);
        const candidate = storageDraft(copyId);
        read.mockImplementation(() => {
            throw new Error("notice row read failed");
        });
        const start = f.sessionLogs().length;
        const generated = await f.generate(sideQuestion, (draft) => {
            draft.messages.push(storageDraft(id), candidate);
        });
        expect(generated.messages).toEqual([
            ...control.messages.slice(0, -1),
            storageDraft(id),
            candidate,
            sideMessage,
        ]);
        expect(
            f
                .sessionLogs()
                .slice(start)
                .filter((line) => line.includes("v2 side question:")),
        ).toEqual([expect.stringContaining("notice row read failed")]);
    } finally {
        read.mockRestore();
        await f.cleanup();
    }
});

test("a storage wake does not send a checkpoint that restores only the previous reply", async () => {
    const f = await oc2ContextFixture(9818, { area: "generate-refusal" });
    const interrupt = spyOn(f.hostSession, "interrupt");
    try {
        await f.pass();
        f.respond();
        await f.fold(0);
        expect(f.checkpoint?.role).toBe("user");
        const id = await admitNotice(f);
        storeRow(f, "idle", "idle", f.rows.at(-1)!.seq, { outcome: "succeeded" });
        storeRow(f, id, "synthetic", 90, { text: noticeText });
        const turn = await f.pass((draft) => {
            expect(draft.messages.map((m) => m.id)).toEqual([f.checkpoint?.id]);
            draft.messages.push(storageDraft(id));
        });
        expect(interrupt).toHaveBeenCalledTimes(1);
        expect(turn.logs).toContainEqual(expect.stringContaining("arm=storage-notice-turn"));
    } finally {
        interrupt.mockRestore();
        await f.cleanup();
    }
});

test("a storage wake is refused if looking up another notice-shaped row fails", async () => {
    const f = await oc2ContextFixture(9819, { area: "generate-refusal" });
    const interrupt = spyOn(f.hostSession, "interrupt");
    const read = spyOn(V2StoreReader.prototype, "messageById");
    try {
        const id = await admitNotice(f);
        storeRow(f, "idle", "idle", 80, { outcome: "interrupted" });
        storeRow(f, id, "synthetic", 90, { text: noticeText });
        read.mockImplementation(() => {
            throw new Error("cannot read a notice-shaped row");
        });
        const turn = await f.pass((draft) => {
            draft.messages.push(storageDraft(copyId), storageDraft(id));
        });
        expect(interrupt).toHaveBeenCalledTimes(1);
        expect(turn.logs).toContainEqual(
            expect.stringContaining("v2 storage notice step refused:"),
        );
    } finally {
        read.mockRestore();
        interrupt.mockRestore();
        await f.cleanup();
    }
});
