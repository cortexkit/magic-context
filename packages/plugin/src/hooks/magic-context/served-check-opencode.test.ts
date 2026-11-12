/// <reference types="bun-types" />
// The served check through OpenCode 1's production wrapper and transform: an
// ordinary turn logs nothing, a last-good replay that serves exactly the
// request before it plus the host's new messages logs nothing, and a replay
// that serves a drop the request before it did not carry is a mixed replay.
// A pass that changes the served request although it was not allowed to
// rebuild it is shown by the two known, still unfixed signed-thinking defects;
// their tests are in compaction-marker-drain-busy-review.test.ts and
// signed-thinking-prefix-edits.test.ts.
import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { getTagsBySession, openDatabase } from "../../features/magic-context/storage";
import { closeDatabase } from "../../features/magic-context/storage-db";
import { markTagDropped } from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import * as loggerModule from "../../shared/logger";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { getServedCheckCountersForTest } from "./served-check";
import { createTransform } from "./transform";

const MODEL = { providerID: "anthropic", modelID: "claude-sonnet-4" };
const dirs: string[] = [];
const originalXdg = process.env.XDG_DATA_HOME;

afterEach(() => {
    resetLkgSlotsForTest();
    closeDatabase();
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    for (const dir of dirs.splice(0)) cleanupTestTempDir(dir);
});

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

const EVENT = /^served check: (a pass without|a replay differed|a change in front|content changed)/;

function session(sessionId: string) {
    const { dir } = createTestTempDir("mc-served-check-oc1-");
    dirs.push(dir);
    process.env.XDG_DATA_HOME = join(dir, "data");
    const db = openDatabase();
    let failNext = false;
    let replays = 0;
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: { shouldExecute: () => "defer" },
        contextUsageMap: new Map([
            [sessionId, { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() }],
        ]),
        liveModelBySession: new Map([[sessionId, MODEL]]),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        protectedTokens: 1,
        historianRunnable: false,
        directory: dir,
    } as never);
    const handler = createMessagesTransformHandler({
        magicContext: {
            "experimental.chat.messages.transform": async (input, output) => {
                if (failNext) {
                    failNext = false;
                    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
                }
                await transform(input as never, output as never);
            },
        },
        onLkgReplay: () => {
            replays += 1;
        },
    });
    const source: Message[] = [];
    let clock = 1;
    return {
        db,
        get replays() {
            return replays;
        },
        failNextPass() {
            failNext = true;
        },
        user(text: string) {
            source.push({
                info: {
                    id: `u${clock}`,
                    role: "user",
                    sessionID: sessionId,
                    time: { created: clock++ },
                },
                parts: [{ type: "text", text }],
            });
        },
        step(n: number) {
            source.push({
                info: {
                    id: `step-${n}`,
                    role: "assistant",
                    sessionID: sessionId,
                    time: { created: clock++ },
                    finish: "stop",
                    ...MODEL,
                },
                parts: [
                    {
                        type: "tool",
                        callID: `call-${n}`,
                        tool: "bash",
                        state: {
                            status: "completed",
                            input: { command: `seq ${n}` },
                            output: `${n}\n${"line\n".repeat(200)}`,
                        },
                    },
                    { type: "text", text: `step ${n} done` },
                ],
            });
        },
        async pass(): Promise<string[]> {
            const lines: string[] = [];
            const spy = spyOn(loggerModule, "sessionLog").mockImplementation((_id, message) => {
                lines.push(String(message));
            });
            try {
                await handler({}, { messages: structuredClone(source) } as never);
            } finally {
                spy.mockRestore();
            }
            // A healthy pass saves its last-good request from a deferred callback.
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
            return lines.filter((line) => EVENT.test(line));
        },
    };
}

test("OpenCode 1: an ordinary turn and a replay of the request before it log nothing; a replay carrying a drop that request did not is a mixed replay", async () => {
    const sessionId = "served-check-oc1";
    const s = session(sessionId);
    s.user("run some commands");
    expect(await s.pass()).toEqual([]);
    for (let n = 1; n <= 3; n++) {
        s.step(n);
        s.user(`next ${n}`);
        expect(await s.pass()).toEqual([]);
    }
    expect(getServedCheckCountersForTest(sessionId)).toMatchObject({ unknown: 1, appendOnly: 3 });

    // A busy store refuses the pass and the wrapper replays the request
    // before it, with the host's new message after it.
    s.user("one more");
    s.failNextPass();
    expect(await s.pass()).toEqual([]);
    expect(s.replays).toBe(1);

    // Another process's pass committed a drop of the first tool output, which
    // this process never served. The next refused pass replays the saved
    // request with that drop applied: neither the request before it nor a
    // rebuild.
    const tool = getTagsBySession(s.db, sessionId).find((tag) => tag.type === "tool");
    if (!tool) throw new Error("the first step's tool output was not tagged");
    markTagDropped(s.db, sessionId, tool.tagNumber);
    s.user("and another");
    s.failNextPass();
    const events = await s.pass();
    expect(s.replays).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toStartWith(
        "served check: a replay differed from the request served before it ",
    );
});
