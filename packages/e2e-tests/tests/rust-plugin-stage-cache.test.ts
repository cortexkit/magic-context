import { expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { insertMemory } from "../../plugin/src/features/magic-context/memory";
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import { computeCueContentHash, setMuralCue } from "../../plugin/src/features/magic-context/mural/storage-mural-cues";
import { getOrCreateSessionMeta, updateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";
import { recordDetectedContextLimit } from "../../plugin/src/features/magic-context/storage-meta-persisted";
import { recordToolDefinition } from "../../plugin/src/features/magic-context/tool-definition-tokens";
import { refreshModelLimitsFromApi } from "../../plugin/src/shared/models-dev-cache";
import { Database } from "../../plugin/src/shared/sqlite";
import * as logger from "../../plugin/src/shared/logger";
import { SubcModuleTransport } from "../../plugin/src/hooks/magic-context/module-transport";
import { setRawMessageProvider } from "../../plugin/src/hooks/magic-context/read-session-chunk";
import { createRustModeTransform } from "../../plugin/src/hooks/magic-context/rust-mode-transform";
import type { TransformDeps } from "../../plugin/src/hooks/magic-context/transform";
import type { MessageLike } from "../../plugin/src/hooks/magic-context/transform-operations";
import { RustTestHarness } from "../src/rust-harness";

// Opt-in: this measurement requires the preserved pre-change adapter and bundle.
// Ordinary hermetic shards need neither artifact and already cover the contract.
test.skipIf(!process.env.MC_RUST_STAGE_BASELINE)("old/new Rust adapters serve identical bytes through a hermetic module and isolated OpenCode 1.18", async () => {
    const baselinePath = process.env.MC_RUST_STAGE_BASELINE!;
    const oldFactory: typeof createRustModeTransform = (await import(baselinePath)).createRustModeTransform;
    const requestedRoot = resolve(process.env.MC_RUST_STAGE_ROOT ?? join(tmpdir(), "magic-context/rust-plugin-stage-cache"));
    mkdirSync(requestedRoot, { recursive: true });
    const root = realpathSync(requestedRoot);
    const version = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim();
    expect(version).toMatch(/^1\./);
    console.log(`RUST_STAGE_HOST OpenCode=${version} Bun=${Bun.version} root=${root}`);
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot, { recursive: true });
    execFileSync("git", ["init", "--quiet", projectRoot]);
    execFileSync("git", ["-C", projectRoot, "config", "remote.origin.url", "https://example.invalid/rust-stage-fixture.git"]);
    const projectIdentity = resolveProjectIdentity(projectRoot)!;
    const originalEntry = process.env.MC_E2E_PLUGIN_ENTRY;
    const outputs: string[][] = [];
    const summaries: unknown[] = [];
    const sessionId = "ses_rust_stage_fixture";
    const todoJson = '[{"content":"Finish the fixture","status":"in_progress","priority":"high"}]';
    const logSpy = spyOn(logger, "sessionLog").mockImplementation(() => {});
    const stageStats = (lines: string[]) => Object.fromEntries(["todo_probe", "todo_verdict", "mural_resolve"].map((stage) => {
        const samples = lines.map((line) => Number(line.match(new RegExp(`(?:stages=| )${stage}:([\\d.]+)`))?.[1])).sort((a, b) => a - b);
        return [stage, { passes: samples.length, median: samples[Math.floor(samples.length / 2)], p90: samples[Math.floor(samples.length * 0.9)], max: samples.at(-1) }];
    }));
    try {
        for (const [label, factory] of [["before", oldFactory], ["after", createRustModeTransform]] as const) {
            process.env.MC_E2E_PLUGIN_ENTRY = label === "before"
                ? process.env.MC_RUST_STAGE_BASELINE_BUNDLE!
                : resolve(import.meta.dir, "../../plugin/dist/index.js");
            const fixtureRoot = join(root, label);
            const env = { configDir: join(fixtureRoot, "config"), dataDir: join(fixtureRoot, "data"),
                cacheDir: join(fixtureRoot, "cache"), workdir: projectRoot };
            for (const path of Object.values(env)) mkdirSync(path, { recursive: true });
            const h = await RustTestHarness.create({ existingEnv: env, startHistorianProducer: false,
                magicContextConfig: { mural: { enabled: true }, memory: { enabled: true, injection_budget_tokens: 1 },
                    historian: { disable: true }, compressor: { enabled: false } },
            });
            let db: Database | undefined;
            let unregister: (() => void) | undefined;
            try {
                const hostSession = await h.createSession();
                const sdk = await import("@opencode-ai/sdk");
                const client = sdk.createOpencodeClient({ baseUrl: h.opencode.url });
                await refreshModelLimitsFromApi(client);
                db = new Database(join(env.dataDir, "cortexkit/magic-context/context.db"));
                for (let index = 0; index < 100; index++) {
                    const content = `Memory ${index}: ${"stable constraint ".repeat(20)}`;
                    const memory = insertMemory(db, { projectPath: projectIdentity, category: "CONSTRAINTS", content });
                    setMuralCue(db, projectIdentity, memory.id, `Cue ${index}`, computeCueContentHash(content));
                }
                // Both arms must see the same database inputs, including the
                // reinforcement timestamps that break memory-selection ties.
                db.prepare(`UPDATE memories SET created_at = 1000000 + id,
                    first_seen_at = 1000000 + id, last_seen_at = 1000000 + id,
                    updated_at = 1000000 + id, mural_cue_at = 1000000 + id
                    WHERE project_path = ?`).run(projectIdentity);
                const rows = Array.from({ length: 2_000 }, (_, index) => ({ id: `msg_fixture_${String(index).padStart(5, "0")}`,
                    timeCreated: index + 1, contributesOrdinal: true, hasValidInfo: true,
                    ordinal: index + 1, role: index % 2 ? "assistant" : "user", parts: [], }));
                unregister = setRawMessageProvider(sessionId, { readMessages: () => rows, getStoredMessageCount: () => rows.length });
                const input = rows.map((row, index) => ({ info: { id: row.id, sessionID: sessionId,
                    role: index % 2 ? "assistant" : "user", agent: "build",
                    ...(index % 2 ? { providerID: "mock-anthropic", modelID: "mock-sonnet" } : {}),
                }, parts: [{ type: "text", text: `fixture message ${index}: ${"ballast ".repeat(8)}` }] })) as MessageLike[];
                input[999].parts = [{ type: "tool", tool: "todowrite", callID: "toolu_origin_todo", state: {
                    status: "completed", input: { todos: JSON.parse(todoJson) }, output: todoJson, title: "1 todos",
                    metadata: { todos: JSON.parse(todoJson) }, time: { start: 1, end: 2 },
                } }];
                updateSessionMeta(db, sessionId, { lastTodoState: todoJson, systemPromptHash: "fixture-system", systemPromptTokens: 100 });
                recordDetectedContextLimit(db, sessionId, 200_000, "mock-anthropic/mock-sonnet");
                recordToolDefinition("mock-anthropic", "mock-sonnet", undefined, "read", "read fixture", { type: "object" });
                const transport = new SubcModuleTransport(h.subc.connectionFile);
                const deps: TransformDeps = { db, tagger: {} as never, scheduler: {} as never, contextUsageMap: new Map(),
                    historyRefreshSessions: new Set(), pendingMaterializationSessions: new Set(), lastHeuristicsTurnId: new Map(),
                    directory: projectRoot, projectPath: projectIdentity, protectedTokens: 4, clearReasoningAge: 50,
                    memoryConfig: { enabled: true, injectionBudgetTokens: 1, autoPromote: false }, muralEnabled: true,
                    historianRunner: "broca", transformMode: "rust", rustModeModuleClient: transport,
                    liveModelBySession: new Map([[sessionId, { providerID: "mock-anthropic", modelID: "mock-sonnet" }]]),
                    sessionDirectoryBySession: new Map([[sessionId, projectRoot]]),
                    client: { app: client.app, session: { get: () => client.session.get({ path: { id: hostSession } }) } } as never,
                };
                const transform = factory(deps, { moduleClient: transport, scheduleLkgCapture: (capture) => capture() });
                const served: string[] = [];
                const logStart = logSpy.mock.calls.length;
                for (let pass = 0; pass < 48; pass++) {
                    if (pass % 3 === 0) transform.invalidateWireState(sessionId);
                    if (pass === 8) {
                        // The priced rebuild no longer has the origin tool call in its input.
                        input.splice(0, 1000);
                        updateSessionMeta(db, sessionId, { systemPromptHash: "fixture-system-after-bust" });
                        deps.pendingMaterializationSessions.add(sessionId);
                    }
                    if (pass === 24) updateSessionMeta(db, sessionId, { lastTodoState: "" });
                    if (pass >= 24) deps.contextUsageMap.set(sessionId, {
                        usage: { inputTokens: 180_000, percentage: 90 }, updatedAt: Date.now(),
                    });
                    const output = { messages: [...input] as unknown[] };
                    await transform.run(sessionId, input, output, getOrCreateSessionMeta(db, sessionId));
                    expect(transform.getState(sessionId).failureCount).toBe(0);
                    served.push(JSON.stringify(output.messages));
                    // The outer transform consumes one-shot materialization requests;
                    // this directly invoked adapter fixture supplies that caller lifecycle.
                    deps.pendingMaterializationSessions.delete(sessionId);
                }
                expect(served[8]).not.toContain('"callID":"toolu_origin_todo"');
                expect(served[8]).toContain('"syntheticTodoMarker":true');
                expect(served[0]).toContain("data:image/png;base64,");
                outputs.push(served);
                const adapterLines = logSpy.mock.calls.slice(logStart).filter(([id, line]) => id === sessionId && line.startsWith("rust pass:")).map(([, line]) => line);
                expect(adapterLines).toHaveLength(48);
                writeFileSync(join(root, `${label}-adapter.log`), adapterLines.join("\n"));
                const adapterStages = stageStats(adapterLines);
                const pressureStages = stageStats(adapterLines.slice(24));
                const adapterProbes = adapterLines.filter((line) => line.includes("todo_probe_required:1")).length;
                transform.dispose();

                // These passes go through the actual OpenCode process's hooks, SDK,
                // transport and serializer, not the directly invoked fixture adapter.
                for (let pass = 0; pass < 16; pass++) await h.sendPrompt(hostSession, `host stage pass ${pass}`);
                await h.waitForRustPasses(16);
                const logs = h.diagnosticLog();
                writeFileSync(join(root, `${label}-plugin.log`), logs);
                const inventory = execFileSync("lsof", ["-p", String(h.opencode.pid), "-Fn"], { encoding: "utf8" });
                writeFileSync(join(root, `${label}-lsof.txt`), inventory);
                const databases = inventory.split("\n").filter((line) => /^n.*(?:\.db|\.sqlite)(?:-wal|-shm)?$/.test(line)).map((line) => line.slice(1));
                expect(databases.some((path) => path.endsWith("opencode.db"))).toBe(true);
                expect(databases.some((path) => path.endsWith("context.db"))).toBe(true);
                expect(databases.every((path) => path.startsWith(`${root}/`))).toBe(true);
                const processEnv = execFileSync("ps", ["eww", "-p", String(h.opencode.pid), "-o", "command="], { encoding: "utf8" });
                const isolation: Record<string, string> = {};
                for (const key of ["HOME", "CFFIXED_USER_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "OPENCODE_DB", "MAGIC_CONTEXT_STORAGE_DIR"]) {
                    const value = processEnv.match(new RegExp(`(?:^| )${key}=([^ ]+)`))?.[1];
                    expect(value?.startsWith(`${root}/`)).toBe(true);
                    isolation[key] = value!;
                }
                writeFileSync(join(root, `${label}-isolation.json`), JSON.stringify({ pid: h.opencode.pid, isolation, databases }, null, 2));
                const stages = Object.fromEntries(["todo_probe", "todo_verdict", "mural_resolve"].map((stage) => {
                    const samples = logs.split("\n").filter((line) => line.includes(`[${hostSession}]`) && line.includes("rust pass:"))
                        .map((line) => Number(line.match(new RegExp(`(?:stages=| )${stage}:([\\d.]+)`))?.[1])).sort((a, b) => a - b);
                    expect(samples.length).toBeGreaterThanOrEqual(16);
                    return [stage, { passes: samples.length, median: samples[Math.floor(samples.length / 2)], p90: samples[Math.floor(samples.length * 0.9)], max: samples.at(-1) }];
                }));
                summaries.push({ label, stages, adapterStages, pressureStages, adapterProbes, databases, modulePasses: served.length });
            } finally {
                writeFileSync(join(root, `${label}-final-plugin.log`), h.diagnosticLog());
                writeFileSync(join(root, `${label}-final-module.log`), h.subc.moduleLog());
                unregister?.();
                db?.close();
                await h.dispose();
            }
        }
        expect(outputs[1]).toEqual(outputs[0]);
        writeFileSync(join(root, "summary.json"), JSON.stringify({ version, differentialPasses: 48, summaries }, null, 2));
        console.log(`RUST_STAGE_HOST_RESULT ${JSON.stringify({ version, differentialPasses: 48, summaries })}`);
    } finally {
        logSpy.mockRestore();
        if (originalEntry === undefined) delete process.env.MC_E2E_PLUGIN_ENTRY;
        else process.env.MC_E2E_PLUGIN_ENTRY = originalEntry;
    }
}, 900_000);
