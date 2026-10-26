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
import { insertMemory } from "../../plugin/src/features/magic-context/memory/storage-memory";
import { getMemoryVerifications, recordMemoryVerifications } from "../../plugin/src/features/magic-context/memory/storage-memory-verifications";
import { closeDatabase, openDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { MockProvider } from "../src/mock-provider/server";
import { resolvePiHostInvocation } from "../src/pi-runner/spawn";
import { verifyPromptIds } from "./dreamer-timeout-support";

test.skipIf(process.env.MC_E2E_MAPPER_STEP_PROBE !== "1")(
    "real Pi verify-broad completes a 70-read batch under the mapper step cap",
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
        const ids = Array.from({ length: 20 }, (_, index) => {
            const memory = insertMemory(db, { projectPath: identity, category: "ARCHITECTURE", content: `Fixture claim ${index}.` });
            recordMemoryVerifications(db, memory.id, ["fact.txt"], 1000);
            return memory.id;
        });
        let pid: number | undefined;
        let calls = 0;
        let finalizes = 0;
        let checkedIsolation = false;
        const runner = new PiSubagentRunner({
            invocation,
            subagentExtensions: [resolve(import.meta.dir, "../../pi-plugin/dist/subagent-entry.js")],
        });
        const originalRun = runner.run.bind(runner);
        runner.run = (options) => originalRun({ ...options, onProgress: (event) => {
            if (event.type === "spawned") { pid = event.pid; checkedIsolation = false; }
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
                expect(batch).toHaveLength(10);
                return { text: `<verify>${batch.map((id) => `<verified id="${id}"/>`).join("")}</verify>`, usage: { input_tokens: 10, output_tokens: 30 } };
            }
            expect(batch).toHaveLength(10);
            // Seventy serial source lookups exceed the former 60-step cap but
            // should finish below the mapper's new 400-step limit.
            if (calls < 70) {
                calls++;
                return { content: [{ type: "tool_use", id: `toolu_lookup_${calls}`, name: "read", input: { path: "fact.txt" } }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 10 } };
            }
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
            expect(finalizes).toBe(0);
            expect(calls).toBe(70);
            expect(result.failed).toEqual([]);
            const stored = getMemoryVerifications(db, ids);
            expect(ids.filter((id) => (stored.get(id)?.verifiedAt ?? 0) > 1000)).toHaveLength(20);
            expect(JSON.stringify(getDreamRuns(db, identity))).not.toContain("MC-D10");
        } finally {
            __test.reset();
            closeDatabase();
            await mock.stop();
        }
    }, 120000,
);
