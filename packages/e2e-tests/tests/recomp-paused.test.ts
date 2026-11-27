/// <reference types="bun-types" />

import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRawSessionMessageIdOrdinalsFromDb } from "../../plugin/src/hooks/magic-context/read-session-raw";
import { MagicContextRpcClient } from "../../plugin/src/shared/rpc-client";
import { TestHarness } from "../src/harness";
import { buildMockHistorianPayload, findHistorianOrdinalRange } from "../src/mock-historian";
import { PiTestHarness } from "../src/pi-harness";
import { childEnv, resolvePiHostInvocation } from "../src/pi-runner/spawn";
import { stageNoiseTailFixture } from "../src/recomp-noise-fixture";
import { forEachHost } from "../src/scenario-hosts";
import { cleanupE2ETempDir, createE2ETempDir } from "../src/temp-dir";
import { openTestDb } from "../src/test-db";

const historianModel = "recomp-historian";
const probe = "Recomp wire probe: continue the ledger.";
const ordinaryReply = {
    text: "The ledger entry is recorded.",
    usage: { input_tokens: 150, output_tokens: 15 },
};

function snapshot(h: TestHarness | PiTestHarness, session: string) {
    const db = h.contextDb();
    return {
        compartments: db
            .prepare("SELECT * FROM compartments WHERE session_id = ? ORDER BY sequence")
            .all(session),
        cache: db
            .prepare(`SELECT cached_m0_bytes, cached_m1_bytes, cached_m0_last_baseline_end_message_id,
            pending_compaction_marker_state FROM session_meta WHERE session_id = ?`)
            .get(session),
        mutationCount: db
            .prepare("SELECT COUNT(*) AS n FROM m0_mutation_log WHERE session_id = ?")
            .get(session),
    };
}

function assertIsolated(h: TestHarness | PiTestHarness) {
    const pid = h instanceof PiTestHarness ? h.hostPid : h.opencode.pid;
    if (!pid) throw new Error("running host has no pid");
    const opened = execFileSync("lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8" });
    const databases = [
        ...new Set(
            opened
                .split("\n")
                .filter((line) => /^n\/.*\.db(?:-wal|-shm)?$/.test(line))
                .map((line) => line.slice(1)),
        ),
    ];
    expect(databases).toContain(h.contextDbPath());
    expect(databases.every((path) => path.startsWith(`${h.dataDir}/`))).toBe(true);
    console.log(`lsof -p ${pid}: ${JSON.stringify(databases)}`);
}

function hostLog(h: TestHarness | PiTestHarness) {
    return h instanceof PiTestHarness
        ? join(childEnv(h.env).TMPDIR!, "pi", "magic-context", "magic-context.log")
        : join(h.dataDir, "cortexkit", "magic-context-e2e.log");
}

async function expectNoLegacyAfterCarry(h: TestHarness | PiTestHarness, sessionId: string) {
    const expected = "Nothing to upgrade: this session has no legacy compartments.";
    if (h instanceof PiTestHarness) {
        const state = await h.getState();
        if (!state.sessionFile) throw new Error("Pi session journal not found");
        const start = readFileSync(state.sessionFile, "utf8").length;
        await h.invokeExtensionCommand("ctx-recomp --upgrade");
        expect(readFileSync(state.sessionFile, "utf8").slice(start)).toContain(expected);
    } else {
        const response = await fetch(`${h.serverUrl}/session/${sessionId}/command`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ command: "ctx-recomp", arguments: "--upgrade" }),
        });
        expect(response.status).toBe(204);
        const transcript = await fetch(`${h.serverUrl}/session/${sessionId}/message`);
        expect(transcript.ok).toBe(true);
        expect(await transcript.text()).toContain(expected);
    }
    console.log(`ctx-recomp --upgrade: ${expected}`);
}

forEachHost(import.meta.url, "recomp pause and resume", (host) => {
    it("keeps the full next request byte-identical to a control and resumes after the staged prefix", async () => {
        const magicContextConfig = {
            execute_threshold_percentage: 95,
            memory: { enabled: false },
            dreamer: { disable: true },
            historian: { two_pass: false },
        };
        const h =
            host === "pi"
                ? await PiTestHarness.create({ host, magicContextConfig })
                : await TestHarness.create({
                      magicContextConfig,
                      historianMockModel: { id: historianModel, contextLimit: 200_000 },
                      openCodeConfigExtra: {
                          agent: { title: { disable: true }, summary: { disable: true } },
                      },
                  });
        const histories = new Array<number>();
        let phase: "build" | "pause" | "resume" = "build";
        let stagedEnd = 0;
        const isHistorian = (body: Record<string, unknown>) =>
            host === "pi"
                ? JSON.stringify(body.system).includes(
                      "the hippocampus of a long-running coding agent",
                  )
                : body.model === historianModel;
        h.mock.setDefault(ordinaryReply);
        h.mock.addMatcher((body) => {
            if (!isHistorian(body)) return null;
            const range = findHistorianOrdinalRange(body);
            if (!range) throw new Error("recomp historian request did not carry raw ordinals");
            if (phase !== "build") histories.push(range.start);
            if (phase === "pause" && range.start > 1)
                return { ...ordinaryReply, text: "No usable summary output." };
            const end = phase === "pause" ? Math.min(range.end, 4) : range.end;
            if (phase === "pause") stagedEnd = end;
            return {
                ...ordinaryReply,
                text: buildMockHistorianPayload({
                    start: range.start,
                    end,
                    title: `Ledger ${range.start}-${end}`,
                    body: `The ledger covers messages ${range.start} through ${end}.`,
                }),
            };
        });

        try {
            if (h instanceof PiTestHarness) {
                const invocation = resolvePiHostInvocation("pi");
                console.log(
                    `Pi host: ${invocation.packageJson} v${JSON.parse(readFileSync(invocation.packageJson, "utf8")).version}`,
                );
            }
            const log = hostLog(h);
            const outcomeLines = () => {
                try {
                    return readFileSync(log, "utf8")
                        .split("\n")
                        .filter((line) => line.includes("recomp finished"));
                } catch {
                    return [];
                }
            };
            const recomp = async (session: string, expected: "Complete" | "Paused") => {
                const before = outcomeLines().length;
                if (h instanceof PiTestHarness) {
                    await h.invokeExtensionCommand("ctx-recomp");
                    await h.invokeExtensionCommand("ctx-recomp");
                } else {
                    const rpc = new MagicContextRpcClient(
                        join(h.dataDir, "cortexkit", "magic-context"),
                        h.workdir,
                    );
                    expect((await rpc.call("recomp", { sessionId: session })).ok).toBe(true);
                }
                const outcome = await h.waitFor(() => outcomeLines()[before], {
                    label: `recomp ${expected}`,
                });
                console.log(outcome);
                expect(outcome).toContain(`## Magic Recomp — ${expected}`);
                return outcome;
            };
            const build = async () => {
                const session = await h.createSession();
                for (let i = 0; i < 8; i++)
                    await h.sendPrompt(session, `Ledger entry ${i}: record the progress.`);
                await recomp(session, "Complete");
                await h.sendPrompt(
                    session,
                    "Settle the rebuilt history before the next ledger entry.",
                );
                expect(snapshot(h, session).compartments.length).toBeGreaterThan(0);
                return session;
            };
            const capture = async (session: string) => {
                const before = h.mock.requests().length;
                await h.sendPrompt(session, probe);
                const requests = h.mock
                    .requests()
                    .slice(before)
                    .filter(
                        (req) => !isHistorian(req.body) && JSON.stringify(req.body).includes(probe),
                    );
                expect(requests).toHaveLength(1);
                expect(requests[0]?.rawBody).toBeString();
                return requests[0]!.rawBody!;
            };
            const control = await build();
            assertIsolated(h);
            const expected = await capture(control);
            if (h instanceof PiTestHarness) await h.newSession();
            const exercised = await build();
            const before = snapshot(h, exercised);
            const piMarker = async () => {
                if (!(h instanceof PiTestHarness)) return [];
                const state = await h.getState();
                if (!state.sessionFile) throw new Error("Pi session journal not found");
                return readFileSync(state.sessionFile, "utf8")
                    .split("\n")
                    .filter((line) => line.includes('"type":"compaction"'));
            };
            const ocMarker = () => {
                if (!(h instanceof TestHarness)) return [];
                const db = openTestDb(join(h.dataDir, "opencode", "opencode.db"), {
                    readonly: true,
                });
                try {
                    return db
                        .prepare(
                            "SELECT data FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'compaction' ORDER BY id",
                        )
                        .all(exercised);
                } finally {
                    db.close();
                }
            };
            const piBefore = await piMarker();
            const ocBefore = ocMarker();
            phase = "pause";
            const paused = await recomp(exercised, "Paused");
            expect(paused).toContain("published=false");
            expect(paused).toContain(
                `Your current history is unchanged. Run /ctx-recomp again to continue from message ${stagedEnd + 1}.`,
            );
            expect(snapshot(h, exercised)).toEqual(before);
            expect(await piMarker()).toEqual(piBefore);
            expect(ocMarker()).toEqual(ocBefore);
            expect(
                h
                    .contextDb()
                    .prepare("SELECT end_message FROM recomp_compartments WHERE session_id = ?")
                    .all(exercised),
            ).toEqual([{ end_message: stagedEnd }]);
            expect(await capture(exercised)).toBe(expected);

            phase = "resume";
            histories.length = 0;
            const completed = await recomp(exercised, "Complete");
            expect(completed).toContain("published=true");
            expect(completed).toContain("Resumed from previous interrupted run.");
            expect(histories[0]).toBe(stagedEnd + 1);
            expect(histories.every((start) => start > stagedEnd)).toBe(true);
            expect(
                h
                    .contextDb()
                    .prepare("SELECT 1 FROM recomp_compartments WHERE session_id = ?")
                    .all(exercised),
            ).toEqual([]);
            assertIsolated(h);
        } finally {
            await h.dispose();
        }
    }, 300_000);

    it.each([
        "carry",
        "discard",
    ] as const)("keeps the full provider body after noise-tail %s", async (kind) => {
        const fixture = createE2ETempDir("recomp-tail-");
        const magicContextConfig = { memory: { enabled: false }, dreamer: { disable: true } };
        let h: TestHarness | PiTestHarness | undefined;
        try {
            if (host === "pi") {
                const extension = join(fixture, "noise-tail.mjs");
                writeFileSync(
                    extension,
                    `export default function(pi) {
                        pi.registerCommand("e2e-append-noise", { description: "Append a content-free assistant row", handler(_args, ctx) {
                            const branch = ctx.sessionManager.getBranch();
                            const last = branch.findLast(entry => entry.type === "message");
                            if (last?.message.role !== "assistant") throw new Error("Missing assistant fixture row");
                            ctx.sessionManager.appendMessage({ ...last.message, content: [] });
                        }});
                    }`,
                );
                h = await PiTestHarness.create({
                    host,
                    magicContextConfig,
                    mockDefault: ordinaryReply,
                    extensionsBeforeMagicContext: [extension],
                });
            } else {
                h = await TestHarness.create({
                    magicContextConfig,
                    historianMockModel: { id: historianModel, contextLimit: 200_000 },
                    openCodeConfigExtra: {
                        agent: { title: { disable: true }, summary: { disable: true } },
                    },
                    mockDefault: ordinaryReply,
                });
            }
            const harness = h;
            const aligned = kind === "carry";
            const seed = async (staged: boolean) => {
                const session = await harness.createSession();
                for (let i = 0; i < 5; i++)
                    await harness.sendPrompt(session, `Noise fixture ledger ${i}`);
                let rawIds: string[];
                if (harness instanceof PiTestHarness) {
                    await harness.invokeExtensionCommand("e2e-append-noise");
                    const state = await harness.getState();
                    if (!state.sessionFile) throw new Error("Pi session journal not found");
                    rawIds = readFileSync(state.sessionFile, "utf8")
                        .split("\n")
                        .filter(Boolean)
                        .map((line) => JSON.parse(line) as { type: string; id: string })
                        .filter((entry) => entry.type === "message")
                        .map((entry) => entry.id);
                } else {
                    const raw = openTestDb(join(harness.dataDir, "opencode", "opencode.db"), {
                        create: false,
                    });
                    try {
                        rawIds = [
                            ...readRawSessionMessageIdOrdinalsFromDb(raw as never, session).keys(),
                        ];
                        const last = rawIds.at(-1);
                        if (!last) throw new Error("Missing assistant fixture row");
                        const result = raw
                            .prepare(`UPDATE part SET data=json_set(data,'$.text','')
                                WHERE message_id = ? AND json_extract(data,'$.type') = 'text'`)
                            .run(last);
                        expect(result.changes).toBeGreaterThan(0);
                    } finally {
                        raw.close();
                    }
                }
                return {
                    session,
                    ...stageNoiseTailFixture(
                        harness.contextDbPath(),
                        session,
                        rawIds,
                        staged,
                        aligned,
                    ),
                };
            };
            const control = await seed(false);
            const capture = async (session: string) => {
                const from = harness.mock.requests().length;
                await harness.sendPrompt(session, probe);
                const requests = harness.mock
                    .requests()
                    .slice(from)
                    .filter(
                        ({ body }) =>
                            body.model !== historianModel && JSON.stringify(body).includes(probe),
                    );
                expect(requests).toHaveLength(1);
                expect(requests[0]?.rawBody).toBeString();
                return requests[0]!.rawBody;
            };
            assertIsolated(harness);
            await harness.restart();
            assertIsolated(harness);
            const expected = await capture(control.session);
            if (harness instanceof PiTestHarness) await harness.newSession();
            const rebuilt = await seed(true);
            await harness.restart();
            assertIsolated(harness);
            const before = snapshot(harness, rebuilt.session);
            const from = harness.mock.requests().length;
            if (harness instanceof PiTestHarness) {
                await harness.invokeExtensionCommand("ctx-recomp");
                await harness.invokeExtensionCommand("ctx-recomp");
            } else {
                const rpc = new MagicContextRpcClient(
                    join(harness.dataDir, "cortexkit", "magic-context"),
                    harness.workdir,
                );
                expect((await rpc.call("recomp", { sessionId: rebuilt.session })).ok).toBe(true);
            }
            const outcome = await harness.waitFor(
                () => {
                    return readFileSync(hostLog(harness), "utf8")
                        .split("\n")
                        .find(
                            (line) =>
                                line.includes(rebuilt.session) && line.includes("recomp finished"),
                        );
                },
                { label: `recomp noise-tail ${kind}` },
            );
            console.log(outcome);
            expect(harness.mock.requests().slice(from)).toEqual([]);
            if (aligned) {
                expect(outcome).toContain(
                    "recomp finished (published=true): ## Magic Recomp — Complete",
                );
                expect(outcome).toContain(
                    `Kept 1 existing history block through message ${rebuilt.tail.endMessage}.`,
                );
            } else {
                expect(outcome).toContain(
                    "recomp finished (published=false): ## Magic Recomp — Failed",
                );
                expect(outcome).toContain(
                    "The unfinished rebuild was discarded. Your current history is unchanged.",
                );
                expect(snapshot(harness, rebuilt.session)).toEqual(before);
            }
            expect(
                harness
                    .contextDb()
                    .prepare("SELECT 1 FROM recomp_compartments WHERE session_id = ?")
                    .all(rebuilt.session),
            ).toEqual([]);
            expect(await capture(rebuilt.session)).toBe(expected);
            if (aligned) {
                await expectNoLegacyAfterCarry(harness, rebuilt.session);
                expect(
                    harness
                        .contextDb()
                        .prepare(
                            "SELECT end_message_id AS endId, episode_type AS kind, legacy FROM compartments WHERE session_id = ? ORDER BY sequence",
                        )
                        .all(rebuilt.session),
                ).toEqual([
                    { endId: rebuilt.prefix.endMessageId, kind: null, legacy: 0 },
                    { endId: rebuilt.tail.endMessageId, kind: "filtered-noise", legacy: 0 },
                ]);
            }
        } finally {
            await h?.dispose();
            cleanupE2ETempDir(fixture);
        }
    }, 300_000);
});
