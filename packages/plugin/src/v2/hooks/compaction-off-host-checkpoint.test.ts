/// <reference types="bun-types" />
// With Magic Context's compaction off, OpenCode 2 owns the context window. After
// the host compacts, its checkpoint and the tail it kept are the request, and
// Magic Context only adds its compaction-off head (project docs, memories, user
// profile) in front. Rows from before the checkpoint must not come back: a
// request that never shrinks makes the host compact again on every step.
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";
import { HEAD_IDS } from "./payload";
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
