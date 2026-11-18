/// <reference types="bun-types" />
// With Magic Context's compaction off, OpenCode 2 owns the context window. After
// the host compacts, its checkpoint and the tail it kept are the request, and
// Magic Context only adds its compaction-off head (project docs, memories, user
// profile) in front. Rows from before the checkpoint must not come back: a
// request that never shrinks makes the host compact again on every step. Nothing
// else on the hook's path may refuse or reshape that request because of the
// checkpoint either: a failed pass sends the host's own request, and a draft
// without the checkpoint row still gets the head. With compaction on, a failed
// pass is still refused.
import { expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";
import * as payloadModule from "./payload";
import { HEAD_IDS } from "./payload";
import { V2ContextRefusal } from "./refusal";
import type { V2Message } from "./types";

const OFF = { compaction: { enabled: false } };
const HOST_SUMMARY = "Host summary of the earlier conversation.";
const DOCS = "Architecture notes rendered into the compaction-off head.";

const isHead = (message: V2Message) => (HEAD_IDS as readonly string[]).includes(String(message.id));

/** Put the project's docs where the head renders them from: the fixture's root. */
function writeDocs() {
    writeFileSync(
        join(dirname(process.env.HOME as string), "ARCHITECTURE.md"),
        `# Architecture\n\n${DOCS}\n`,
    );
}

/** Make the hook's own adaptation of the host's messages fail on the next pass. */
function failNextAdaptation() {
    return spyOn(payloadModule, "adaptPayload").mockImplementationOnce(() => {
        throw new Error("adaptation failed");
    });
}

test("compaction off: the host's checkpoint and the tail it kept are served unchanged, with no row from before the checkpoint", async () => {
    const f = await oc2ContextFixture(9440, {
        area: "compaction-off-checkpoint",
        temporal: false,
        configOverrides: OFF,
    });
    writeDocs();
    try {
        await f.pass();
        await f.hostFold(HOST_SUMMARY, 3);
        const served = await f.pass();

        const tail = f.rows.slice(-3).map((row) => row.id);
        const beforeCheckpoint = new Set(f.rows.slice(0, -3).map((row) => row.id));
        // The host sends its checkpoint followed by the rows it kept.
        expect(served.inputIds).toEqual([f.checkpoint?.id as string, ...tail]);
        expect(
            served.draft.messages.filter(
                (message) => typeof message.id === "string" && beforeCheckpoint.has(message.id),
            ),
        ).toEqual([]);
        // Behind Magic Context's head, the host's messages go out byte for byte.
        expect(JSON.stringify(served.draft.messages.filter((message) => !isHead(message)))).toBe(
            JSON.stringify(served.input),
        );
        expect(JSON.stringify(served.draft.messages.filter(isHead))).toContain(DOCS);
    } finally {
        await f.cleanup();
    }
}, 60_000);

test("compaction off: a pass that fails after a host checkpoint sends the host's own request", async () => {
    const f = await oc2ContextFixture(9441, {
        area: "compaction-off-checkpoint",
        temporal: false,
        configOverrides: OFF,
    });
    try {
        await f.pass();
        await f.hostFold(HOST_SUMMARY, 3);
        const failure = failNextAdaptation();
        try {
            // Refusing here would stop the host's own request over a restore
            // that compaction off never makes.
            const out = await f.pass();
            expect(failure).toHaveBeenCalled();
            expect(JSON.stringify(out.draft.messages)).toBe(JSON.stringify(out.input));
        } finally {
            failure.mockRestore();
        }
    } finally {
        await f.cleanup();
    }
}, 60_000);

test("compaction on: a pass that fails after a host checkpoint is still refused", async () => {
    const f = await oc2ContextFixture(9442, { area: "compaction-off-checkpoint", temporal: false });
    try {
        await f.pass();
        await f.fold(3);
        await f.pass();
        f.respond();
        f.user("Continue after the checkpoint.", 1000);
        const failure = failNextAdaptation();
        try {
            const out = await f.attempt();
            expect(failure).toHaveBeenCalled();
            expect(out.error).toBeInstanceOf(V2ContextRefusal);
        } finally {
            failure.mockRestore();
        }
    } finally {
        await f.cleanup();
    }
}, 60_000);

test("compaction off: a draft without the host's checkpoint row still gets the head, with the host's messages unchanged", async () => {
    const f = await oc2ContextFixture(9443, {
        area: "compaction-off-checkpoint",
        temporal: false,
        configOverrides: OFF,
    });
    writeDocs();
    try {
        await f.pass();
        await f.hostFold(HOST_SUMMARY, 3);
        const checkpointID = f.checkpoint?.id;
        expect(checkpointID).toBeDefined();
        // Nothing is restored in this mode, so the pass has no checkpoint to
        // check the draft against and goes on to add the head.
        const served = await f.pass((draft) => {
            draft.messages = draft.messages.filter((message) => message.id !== checkpointID);
        });
        expect(served.input.some((message) => message.id === checkpointID)).toBe(false);
        expect(JSON.stringify(served.draft.messages.filter(isHead))).toContain(DOCS);
        expect(JSON.stringify(served.draft.messages.filter((message) => !isHead(message)))).toBe(
            JSON.stringify(served.input),
        );
    } finally {
        await f.cleanup();
    }
}, 60_000);
