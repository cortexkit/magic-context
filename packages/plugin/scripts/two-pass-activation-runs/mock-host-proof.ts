import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { Database } from "../../src/shared/sqlite";
import { initializeDatabase } from "../../src/features/magic-context/storage-db";
import { insertMemory } from "../../src/features/magic-context/memory/storage-memory";
import { resolveProjectIdentityForSession } from "../../src/features/magic-context/memory/project-identity";
import { memoryHistorySnapshot } from "../../src/features/magic-context/memory/history-applier";
import { buildTurnOneAuthorizationRequest } from "../../src/features/magic-context/memory/turn-two";
import { historianSystemPrompt } from "../../src/hooks/magic-context/compartment-prompt";
import { HISTORIAN_FORMAT_INSTRUCTION } from "../../src/features/magic-context/memory/turn-one-publication";
import { CampaignLedger, type Profile } from "../two-pass-live-replay/artifact-schema";
import { attestHost, disposableEnvironment } from "../two-pass-live-replay/host-drivers";
import { callMeter, readPluginStore, underRoot } from "./activation-driver";
import { hostAdapter, type HostLane } from "./host-adapters";
import { historianMockReply, mockProvider } from "./mock-provider";
import { sumProviderSteps, type DispatchReceipt } from "./provider-meter";

if (import.meta.main) {
    const [operation, laneArg, root, install, carrierArg] = process.argv.slice(2);
    if (!["opencode-1", "opencode-2", "omp"].includes(laneArg)) throw new Error("proof_lane");
    const lane = laneArg as HostLane;
    if (lane === "opencode-1" && !["hidden-completion", "opencode-session"].includes(carrierArg)) throw new Error("pin_opencode_1_carrier");
    const carrier = lane === "omp" ? "pi-historian-rpc" : lane === "opencode-2" ? "hidden-completion" : carrierArg as "hidden-completion" | "opencode-session";
    if (carrierArg && carrierArg !== carrier) throw new Error("proof_carrier_mismatch");
    const env = disposableEnvironment(root);
    underRoot(root, install);
    const entry = buildTurnOneAuthorizationRequest({ lane, carrier, provider: "mock", modelId: "mock-model", variant: null, temperature: null, thinkingLevel: null },
        { system: historianSystemPrompt(true), formatInstruction: HISTORIAN_FORMAT_INSTRUCTION, toolSurface: [], checkToolSurface: [] }).requestedIdentity;
    if (operation === "prepare" || operation === "reset") {
        if (operation === "reset") {
            rmSync(env.MAGIC_CONTEXT_STORAGE_DIR, { recursive: true, force: true });
            rmSync(join(root, "host"), { recursive: true, force: true });
            if (lane === "omp") rmSync(join(root, "omp-agent"), { recursive: true, force: true });
            rmSync(join(root, "magic-context.log"), { force: true });
        }
        writeFileSync(join(install, "packages/plugin/src/features/magic-context/memory/turn-two-allowlist.json"), JSON.stringify({ version: 1, entries: [entry] }));
        mkdirSync(env.MAGIC_CONTEXT_STORAGE_DIR, { recursive: true });
        mkdirSync(join(root, "work"), { recursive: true });
        const project = resolveProjectIdentityForSession(join(root, "work"), false);
        if (!project) throw new Error("fixture_project_identity_unobservable");
        const db = new Database(join(env.MAGIC_CONTEXT_STORAGE_DIR, "context.db"));
        try {
            initializeDatabase(db);
            if (!db.prepare("SELECT id FROM memories WHERE project_path=? AND content=?").get(project, "Chunk size: 32 KiB, not 64 KiB."))
                insertMemory(db, { projectPath: project, category: "CONFIG_VALUES", content: "Chunk size: 32 KiB, not 64 KiB.", importance: 80, sourceType: "historian" });
            const seed = db.prepare("SELECT id FROM memories WHERE project_path=? AND content=?").get(project, "Chunk size: 32 KiB, not 64 KiB.") as { id: number };
            if (!memoryHistorySnapshot(db, seed.id)) throw new Error("fixture_seed_not_history_compatible");
        } finally { db.close(); }
        console.log(JSON.stringify({ preparedCandidate: entry, storePath: join(env.MAGIC_CONTEXT_STORAGE_DIR, "context.db") }));
    } else if (operation === "run") {
        const interfaces = networkInterfaces();
        if (process.platform !== "linux" || !interfaces.lo || Object.keys(interfaces).some((name) => name !== "lo"))
            throw new Error("mock_proof_requires_isolated_loopback_network");
        rmSync(join(root, "mock-proof.json"), { force: true });
        const networkIsolation = { interfaces, routes: readFileSync("/proc/net/route", "utf8") };
        const mock = mockProvider(historianMockReply, (requests) => writeFileSync(join(root, "mock-capture.json"), JSON.stringify(requests, null, 2)));
        const ledger = new CampaignLedger();
        const profile: Profile = { id: `mock-${lane}`, family: "mock", entry, modelRoute: "mock/mock-model", priceClass: "paid",
            tariff: { inputUSDPerMillion: 1, outputUSDPerMillion: 1, source: "Synthetic mock accounting, not provider pricing or actual spending" }, configurationSource: "mock fixture", variantSource: "mock fixture" };
        const adapter = hostAdapter(lane, { sourceRoot: install, mockProviderURL: mock.url, modelId: "mock-model", outputCeiling: 8192,
            timeoutMs: 60_000, forceWrapup: true, magicContext: { historian: { [lane === "omp" ? "omp" : "opencode"]: { model: "mock/mock-model" }, turn_two: "allowlist", two_pass: false },
                memory: { enabled: true, auto_promote: true, auto_search: { enabled: false }, git_commit_indexing: { enabled: false } }, embedding: { provider: "off" } } });
        const pluginEntrypoint = join(install, lane === "omp" ? "packages/pi-plugin/dist/index.js" : lane === "opencode-2" ? "packages/plugin/dist/v2/server.js" : "packages/plugin/dist/index.js");
        let host: Awaited<ReturnType<typeof adapter.start>> | undefined;
        try {
            host = await adapter.start({ installRoot: install, pluginEntrypoint, env, meter: callMeter(ledger, profile) });
            const before = await attestHost(root, env, host.pid);
            if (before.proof.tool !== "lsof -Fpn") throw new Error("proof_requires_lsof_not_proc_fallback");
            writeFileSync(join(root, "lsof-before.json"), JSON.stringify(before, null, 2));
            const session = await host.runSession("Use 64 KiB chunks, not 32 KiB. Record the corrected project chunk size.");
            if (host.carrier !== carrier) throw new Error("observed_carrier_mismatch");
            const after = await attestHost(root, env, host.pid);
            if (after.proof.tool !== "lsof -Fpn") throw new Error("proof_requires_lsof_not_proc_fallback");
            if (mock.requests.length < 4 || mock.requests.length !== ledger.rows.length || ledger.rows.some((row) => !row.settled))
                throw new Error("unmetered_or_uncaptured_dispatch");
            const recorded = session as { requests: DispatchReceipt[]; hostEvents: Array<{ event?: { type?: string } }> };
            if (!recorded.hostEvents.length || recorded.hostEvents.some((row) => row.event?.type === "observer.stream_error"))
                throw new Error("host_event_observation_failed");
            const historianPrefix = historianSystemPrompt(true).slice(0, 128);
            const historianRequests = mock.requests.filter((request) => {
                const blocks = request.body.system ?? request.body.messages?.filter((message: { role: string }) => message.role === "system").map((message: { content: unknown }) => message.content);
                const text = (value: any): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(text).join("\n") : typeof value?.text === "string" ? value.text : "";
                return text(blocks).includes(historianPrefix);
            });
            if (historianRequests.length < 2 || historianRequests.some((request) => request.body.tools !== undefined && (!Array.isArray(request.body.tools) || request.body.tools.length !== 0)))
                throw new Error("historian_provider_tool_surface_not_empty");
            const expectedUsage = mock.requests.reduce((total, request) => ({ inputTokens: total.inputTokens + request.inputTokens,
                outputTokens: total.outputTokens + request.outputTokens }), { inputTokens: 0, outputTokens: 0 });
            const meteredUsage = sumProviderSteps(recorded.requests.flatMap((request) => request.steps ?? []));
            if (meteredUsage.inputTokens !== expectedUsage.inputTokens || meteredUsage.outputTokens !== expectedUsage.outputTokens)
                throw new Error("provider_steps_not_summed");
            if (Math.abs(ledger.rows.reduce((total, row) => total + row.charged, 0) - (expectedUsage.inputTokens + expectedUsage.outputTokens) / 1e6) > 1e-9)
                throw new Error("provider_steps_not_charged");
            if (host.storePath === null) throw new Error("plugin_store_unobservable");
            const store = readPluginStore(root, host.storePath);
            const seed = (store.memories as Array<{ content: string; project_path: string }>).find((row) => row.content === "Chunk size: 32 KiB, not 64 KiB.");
            if (!seed || !store.receipts.length || (store.receipts as Array<{ project_path: string }>).some((row) => row.project_path !== seed.project_path))
                throw new Error("contradicted_seed_project_mismatch");
            const result = { lane, pid: host.pid, carrier: host.carrier, storePath: host.storePath, before, after, session,
                store,
                capturedRequests: mock.requests, ledger: ledger.rows,
                usage: expectedUsage, meteredUsage, historianRequestCount: historianRequests.length,
                actualUSDSpent: 0, network: "observed-loopback-only", networkIsolation, credentials: "mock-only" };
            writeFileSync(join(root, "mock-proof.json"), JSON.stringify(result, null, 2));
            console.log(JSON.stringify({ lane, pid: host.pid, carrier: host.carrier, storePath: host.storePath,
                requests: mock.requests.length, ledgerRows: ledger.rows.length, usage: result.usage,
                before: before.proof, after: after.proof, artifact: join(root, "mock-proof.json") }));
        } finally {
            if (host) {
                try { writeFileSync(join(root, "lsof-after.json"), JSON.stringify(await attestHost(root, env, host.pid), null, 2)); }
                finally { await host.stop(); }
            }
            writeFileSync(join(root, "mock-ledger.json"), JSON.stringify(ledger.rows, null, 2));
            mock.close();
        }
    } else throw new Error("proof_operation");
}
