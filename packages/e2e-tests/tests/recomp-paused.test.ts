/// <reference types="bun-types" />

import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MagicContextRpcClient } from "../../plugin/src/shared/rpc-client";
import { TestHarness } from "../src/harness";
import { buildMockHistorianPayload, findHistorianOrdinalRange } from "../src/mock-historian";
import { PiTestHarness } from "../src/pi-harness";
import { childEnv, resolvePiHostInvocation } from "../src/pi-runner/spawn";
import { forEachHost } from "../src/scenario-hosts";
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
            const log =
                h instanceof PiTestHarness
                    ? join(childEnv(h.env).TMPDIR!, "pi", "magic-context", "magic-context.log")
                    : join(h.dataDir, "cortexkit", "magic-context-e2e.log");
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
});
