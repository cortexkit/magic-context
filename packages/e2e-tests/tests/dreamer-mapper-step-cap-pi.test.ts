/// <reference types="bun-types" />
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { __test, registerPiDreamerProject, runPiDreamForProject } from "../../pi-plugin/src/dreamer";
import { PiSubagentRunner } from "../../pi-plugin/src/subagent-runner";
import { DreamerConfigSchema } from "../../plugin/src/config/schema/magic-context";
import { getDreamRuns } from "../../plugin/src/features/magic-context/dreamer/storage-dream-runs";
import { CANONICAL_DREAM_TASKS } from "../../plugin/src/features/magic-context/dreamer/task-registry";
import { TOKEN_BUDGET_TOOL_REFUSAL } from "../../plugin/src/features/magic-context/dreamer/token-budget";
import { insertMemory } from "../../plugin/src/features/magic-context/memory/storage-memory";
import { getMemoryVerifications, recordMemoryVerifications } from "../../plugin/src/features/magic-context/memory/storage-memory-verifications";
import { closeDatabase, openDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { MockProvider } from "../src/mock-provider/server";
import { resolvePiHostInvocation } from "../src/pi-runner/spawn";
import { verifyPromptIds } from "./dreamer-timeout-support";

test.skipIf(process.env.MC_E2E_MAPPER_STEP_PROBE !== "1")(
    "real Pi verify-broad banks a partial manifest after refusing two reads at the step reserve",
    async () => {
        const root = realpathSync(tmpdir());
        expect(root).toContain("/magic-context/mapper-step-cap/");
        for (const key of ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "OPENCODE_DB", "MAGIC_CONTEXT_STORAGE_DIR", "PI_CODING_AGENT_DIR"])
            expect(resolve(process.env[key] ?? "").startsWith(`${root}/`)).toBe(true);
        const agentDir = process.env.PI_CODING_AGENT_DIR!;
        mkdirSync(agentDir, { recursive: true });
        const work = join(root, "work");
        mkdirSync(work, { recursive: true });
        writeFileSync(join(work, "fact.txt"), "The fixture is implemented here.\n");
        const invocation = resolvePiHostInvocation();
        console.log(`Pi host version ${JSON.parse(readFileSync(invocation.packageJson, "utf8")).version}`);
        const mock = new MockProvider();
        const { baseURL } = await mock.start();
        writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
            anthropic: { baseUrl: baseURL, apiKey: "test-key-not-real", modelOverrides: { "claude-haiku-4-5": { reasoning: false, contextWindow: 200000 } } },
        } }));
        const db = openDatabase();
        if (!db) throw new Error("No throwaway database");
        const identity = "git:mapper-step-cap-probe";
        const ids = Array.from({ length: 5 }, (_, index) => {
            const memory = insertMemory(db, { projectPath: identity, category: "ARCHITECTURE", content: `Fixture claim ${index}.` });
            recordMemoryVerifications(db, memory.id, ["fact.txt"], 1000);
            return memory.id;
        });
        let pid: number | undefined;
        let calls = 0;
        let finalizes = 0;
        let checkedIsolation = false;
        const triggerIds = ["toolu_trigger_1", "toolu_trigger_2"];
        const refusals: string[] = [];
        const acknowledgement = join(root, "finalize-ack");
        const barrier = join(root, "finalize-barrier.js");
        // Hold both reads until Pi has accepted the wrap-up message (the
        // "You're out of token budget" instruction the plugin sends when the
        // step reserve is reached). The real guard then handles the reads.
        // This controls the handoff without refusing any tool in the fixture.
        writeFileSync(barrier, `
import { existsSync, watch } from "node:fs";
export default (pi) => pi.on("tool_call", async (event) => {
    if (!${JSON.stringify(triggerIds)}.includes(event.toolCallId)) return;
    const path = ${JSON.stringify(acknowledgement)};
    await new Promise((resolve, reject) => {
        const finish = () => {
            if (!existsSync(path)) return;
            clearTimeout(timeout);
            watcher.close();
            resolve();
        };
        const watcher = watch(${JSON.stringify(root)}, finish);
        const timeout = setTimeout(() => {
            watcher.close();
            reject(new Error("Pi did not acknowledge the finalize steer"));
        }, 5000);
        finish();
    });
});
`);
        const runner = new PiSubagentRunner({
            invocation,
            subagentExtensions: [barrier, resolve(import.meta.dir, "../../pi-plugin/dist/subagent-entry.js")],
        });
        const originalRun = runner.run.bind(runner);
        runner.run = (options) => originalRun({ ...options, onProgress: (event) => {
            if (event.type === "spawned") { pid = event.pid; checkedIsolation = false; }
            if (event.type === "raw_event") {
                const raw = event.event as { type?: string; id?: string; success?: boolean; toolCallId?: string; result?: { content?: { text?: string }[] } };
                if (raw.type === "response" && raw.id === "dreamer-finalize" && raw.success === true) {
                    writeFileSync(acknowledgement, "");
                }
                if (raw.type === "tool_execution_end" && raw.toolCallId &&
                    raw.result?.content?.some((part) => part.text === TOKEN_BUDGET_TOOL_REFUSAL)) {
                    refusals.push(raw.toolCallId);
                }
            }
            options.onProgress?.(event);
        } });
        __test.setPiSubagentRunnerFactory(() => runner);
        __test.setStartDreamScheduleTimerFactory(async () => () => {});
        mock.addMatcher((body) => {
            if (pid && !checkedIsolation) {
                const opened = execFileSync("lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8" });
                const paths = opened.split("\n").filter((line) => /^n.*\.db(?:-wal|-shm)?$/.test(line)).map((line) => line.slice(1));
                expect(paths.length).toBeGreaterThan(0);
                expect(paths.every((path) => path.startsWith(`${root}/`))).toBe(true);
                console.log(`mapper-step-cap lsof pid=${pid} db=${JSON.stringify(paths)}`);
                checkedIsolation = true;
            }
            const batch = verifyPromptIds(body);
            if (batch.length === 0) throw new Error("Mock received no verify batch");
            const finalize = JSON.stringify(body).includes("You're out of token budget");
            if (finalize) {
                finalizes++;
                expect(batch).toHaveLength(5);
                return { text: `<verify>${batch.slice(0, 2).map((id) => `<verified id="${id}"/>`).join("")}</verify>`, usage: { input_tokens: 10, output_tokens: 30 } };
            }
            // Reach the step reserve without approaching the token cap. The
            // trigger reply issues two reads before Pi delivers the wrap-up
            // message to the model.
            if (batch.length === 5) {
                calls++;
                expect(calls).toBeLessThanOrEqual(58);
                const callIds = calls === 58 ? triggerIds : [`toolu_lookup_${calls}`];
                return { content: callIds.map((id) => ({ type: "tool_use", id, name: "read", input: { path: "fact.txt" } })), stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 10 } };
            }
            // The next batch must contain exactly the omitted claims.
            expect([...batch].sort((a, b) => a - b)).toEqual(ids.slice(2).sort((a, b) => a - b));
            expect(getMemoryVerifications(db, ids).get(ids[0]!)?.verifiedAt).toBeGreaterThan(1000);
            return { text: `<verify>${batch.map((id) => `<verified id="${id}"/>`).join("")}</verify>`, usage: { input_tokens: 10, output_tokens: 30 } };
        });
        const config = DreamerConfigSchema.parse({
            tasks: Object.fromEntries(CANONICAL_DREAM_TASKS.map((task) => [task, { schedule: task === "verify-broad" ? "0 3 * * *" : "" }])),
            pi: { model: "anthropic/claude-haiku-4-5" },
        });
        try {
            const owner = {};
            registerPiDreamerProject({ db, projectDir: work, projectIdentity: identity, registrationOwner: owner, config, harness: "pi", embeddingConfig: { provider: "off" }, memoryEnabled: true, gitCommitIndexing: { enabled: false, since_days: 30, max_commits: 200 } });
            const result = await runPiDreamForProject(identity, "verify-broad", owner);
            console.log(`mapper-step-cap Pi ${JSON.stringify({ calls, finalizes, result, runs: getDreamRuns(db, identity) })}`);
            expect(finalizes).toBe(1);
            expect(calls).toBe(58);
            expect(refusals).toEqual(triggerIds);
            expect(result.failed).toEqual([]);
            expect(ids.filter((id) => (getMemoryVerifications(db, ids).get(id)?.verifiedAt ?? 0) > 1000)).toHaveLength(2);
            expect(JSON.parse(getDreamRuns(db, identity)[0]!.tasks_json)[0]).toMatchObject({ status: "completed", tokenBudget: { finalizeFired: true, banked: 2 } });
            await runPiDreamForProject(identity, "verify-broad", owner);
            expect(ids.filter((id) => (getMemoryVerifications(db, ids).get(id)?.verifiedAt ?? 0) > 1000)).toHaveLength(5);
            expect(JSON.stringify(getDreamRuns(db, identity))).not.toContain("MC-D10");
        } finally {
            __test.reset();
            closeDatabase();
            await mock.stop();
        }
    }, 120000,
);
