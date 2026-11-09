#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { OpenCode } from "@opencode/client";
import { inspectOpenFiles, spawnOpencode2, waitForPluginActive } from "../src/opencode2-runner/spawn";
import { chatUsage, readUsage, toolOutputBytes, writeEvidence, type Pass } from "./evidence";
import { fakeProvider } from "./fake";
import { Guard } from "./guard";
import { composition, instructionRows, instructionSchema } from "./composition";
import { createRun, installHost } from "./setup";
import { agents, batchPrompt, PLAYBOOK } from "./workload";

const startedAt = Date.now();
const { values } = parseArgs({ options: {
    fake: { type: "boolean", default: false }, "step-cap": { type: "string", default: "400" },
    "dollar-cap": { type: "string", default: "8" }, "input-limit": { type: "string", default: "302222" },
    "context-limit": { type: "string", default: "1000000" }, "output-limit": { type: "string", default: "32768" },
    "batch-steps": { type: "string", default: "220" }, "timeout-minutes": { type: "string", default: "120" },
    "batch-count": { type: "string", default: "4" },
    // The reporter's threshold. A lower one reaches the near-limit state in fewer, cheaper steps.
    "threshold-tokens": { type: "string", default: "250000" },
    // Toggle the MCP server every N head steps for the whole run (0 = only steps 2, 4, 6 and batch boundaries).
    "mcp-every": { type: "string", default: "0" },
    // Tools the MCP server lists; more tools make each catalog row as large as a real server's.
    "mcp-tools": { type: "string", default: "2" },
    cli: { type: "string" }, "ai-root": { type: "string" },
    "evidence-dir": { type: "string" },
} });
const positive = (key: keyof typeof values): number => {
    const value = Number(values[key]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid --${key}`);
    return value;
};
const stepCap = positive("step-cap");
const dollarCap = positive("dollar-cap");
const inputLimit = positive("input-limit");
const contextLimit = positive("context-limit");
const outputLimit = positive("output-limit");
const batchSteps = positive("batch-steps");
const batchCount = positive("batch-count");
const timeout = positive("timeout-minutes") * 60000;
const thresholdTokens = positive("threshold-tokens");
const mcpEvery = Number(values["mcp-every"]);
if (!Number.isInteger(mcpEvery) || mcpEvery < 0) throw new Error("Invalid --mcp-every");
const mcpTools = positive("mcp-tools");
if (!Number.isInteger(mcpTools)) throw new Error("Invalid --mcp-tools");
if (![stepCap, inputLimit, contextLimit, outputLimit, batchSteps, batchCount].every(Number.isInteger)) throw new Error("Steps and token limits must be integers");
if (contextLimit <= outputLimit || inputLimit > contextLimit) throw new Error("Invalid model geometry");
if (values["evidence-dir"] && !values.fake) throw new Error("--evidence-dir is only available for fake proofs; live artifacts stay private");
if (values["evidence-dir"] && existsSync(values["evidence-dir"]) && readdirSync(values["evidence-dir"]).length)
    throw new Error("Choose an empty --evidence-dir so artifacts from different runs cannot mix");
const key = values.fake ? "mock-key" : process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error("Set DEEPSEEK_API_KEY (the harness never accepts it as an argument)");
const redact = (text: string) => key === "mock-key" ? text : text.replaceAll(key, "[REDACTED]");
const fixture = createRun();
process.env.MAGIC_CONTEXT_LOG_PATH = fixture.env.MAGIC_CONTEXT_LOG_PATH;
const tokenizer = await import("../../plugin/src/hooks/magic-context/read-session-formatting");
if (!await tokenizer.preloadTokenizer()) throw new Error("The final-wire tokenizer must be available for composition accounting");
const countTokens = tokenizer.createTokenCountMemo(10000, 32 * 1024 * 1024);
console.log(`Run root: ${fixture.root}`);
const selected = values.cli ? { cli: resolve(values.cli), version: "explicit" } : await installHost(fixture);
if (values["ai-root"]) process.env.MC_E2E_OPENCODE2_AI_ROOT = resolve(values["ai-root"]);
const version = spawnSync(selected.cli, ["--version"], { env: fixture.env, encoding: "utf8" });
if (version.status !== 0 || !/^opencode v2\.2\.\d+$/.test(version.stdout.trim())) throw new Error("Expected an isolated OpenCode 2.2.x binary");
const fake = values.fake ? await fakeProvider() : null;
const hostDB = join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!);
const guard = new Guard(stepCap, dollarCap, (inputLimit * 0.15 + outputLimit * 0.60) / 1_000_000);
const passes: Pass[] = [];
const previous = new Map<string, { messages: string[]; head: string }>();
let logOffset = 0;
let wireCount = 0;
let turns = 0;
let batchMessages = 0;
let stopReason = "";
let batch = 1;
let batchEnd = Math.min(batchSteps, Math.max(1, stepCap - batchCount + 1));
let revision = 0;
let midTurnChanged = false;
const instructionChanges: Array<{ revision: number; reason: string; afterStep: number }> = [];
const mcpRevisionFile = join(fixture.root, "mcp-revision.txt");
writeFileSync(mcpRevisionFile, "1");
const mcpChanges: Array<{ reason: string; afterStep: number; connected: boolean }> = [];
let churnMcp: (reason: string) => Promise<void> = async () => {};
let mcpPending = Promise.resolve();
const midTurnMcpSteps = new Set([2, 4, 6]);
const changeInstructions = (reason: string) => {
    revision++;
    writeFileSync(join(fixture.cwd, "AGENTS.md"), agents(revision));
    instructionChanges.push({ revision, reason, afterStep: guard.mainPasses });
};
mkdirSync(join(fixture.root, "passes"));
mkdirSync(join(fixture.root, "wire"));
mkdirSync(join(fixture.root, "instructions"));
writeFileSync(join(fixture.cwd, "PLAYBOOK.md"), PLAYBOOK);
changeInstructions("initial");
const controlToken = crypto.randomUUID();
const controller = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (["/pass", "/wire", "/result"].includes(path)) {
        if (request.headers.get("authorization") !== `Bearer ${controlToken}`) return new Response(null, { status: 403 });
    }
    if (path === "/result") {
        const result = await request.json() as { callID: string; usage?: Record<string, unknown>; status: number };
        writeFileSync(join(fixture.root, "wire", `${result.callID}.usage.json`), JSON.stringify(result), { mode: 0o600 });
        if (result.usage) guard.result(result.callID, chatUsage(result.usage));
        return Response.json({ ok: true });
    }
    if (path === "/wire") {
        const event = await request.json() as { sessionID: string; kind: string; body: string; url: string; model: unknown };
        const rows = readUsage(hostDB);
        if (event.kind === "primary" && event.sessionID === guard.mainID && guard.mainPasses >= batchEnd && batch < batchCount) {
            guard.reason = "batch_boundary";
            return new Response("batch boundary", { status: 429 });
        }
        const callID = String(++wireCount).padStart(5, "0");
        if (!guard.authorize(event.sessionID, rows, event.kind, callID)) {
            wireCount--;
            return new Response("guard", { status: 429 });
        }
        const file = `wire/${callID}.json`;
        writeFileSync(join(fixture.root, file), redact(event.body), { mode: 0o600 });
        writeFileSync(join(fixture.root, "wire", `${callID}.meta.json`), JSON.stringify({
            sessionID: event.sessionID, kind: event.kind, model: event.model, url: event.url, at: Date.now(),
        }), { mode: 0o600 });
        if (event.kind === "primary") {
            const pass = [...passes].reverse().find((pass) => pass.sessionID === event.sessionID
                && pass.usageBefore === rows.filter((row) => row.session_id === event.sessionID).length);
            if (pass) {
                pass.wireFile = file;
                pass.bytes = Buffer.byteLength(event.body);
                pass.toolBytes = toolOutputBytes(JSON.parse(event.body));
                const storedInstructions = instructionRows(hostDB, event.sessionID);
                pass.composition = composition(JSON.parse(event.body), pass.draft!, storedInstructions, countTokens);
                pass.composition.dbSnapshot = `instructions/${callID}.json`;
                writeFileSync(join(fixture.root, pass.composition.dbSnapshot), JSON.stringify(storedInstructions, null, 2), { mode: 0o600 });
            }
        }
        if (!midTurnChanged && event.kind === "primary" && event.sessionID === guard.mainID && guard.mainPasses >= Math.min(3, batchEnd)) {
            midTurnChanged = true;
            changeInstructions("mid-turn");
        }
        if (event.kind === "primary" && event.sessionID === guard.mainID
            && (midTurnMcpSteps.delete(guard.mainPasses) || (mcpEvery > 0 && guard.mainPasses > 6 && guard.mainPasses % mcpEvery === 0))) {
            mcpPending = mcpPending.then(() => churnMcp("mid-turn")).catch((error) => {
                guard.reason = "mcp_error";
                console.error(redact(String(error)));
            });
        }
        return Response.json({ callID });
    }
    if (path === "/pass") {
        await mcpPending;
        const draft = await request.json() as { sessionID: string; messages: unknown[]; [key: string]: unknown };
        const rows = readUsage(hostDB);
        const number = passes.length + 1;
        const file = `passes/${String(number).padStart(5, "0")}.json`;
        const logFile = `passes/${String(number).padStart(5, "0")}.log`;
        const raw = readFileSync(fixture.env.MAGIC_CONTEXT_LOG_PATH!, "utf8");
        const log = redact(raw.slice(logOffset));
        logOffset = raw.length;
        const messages = draft.messages.map((message) => JSON.stringify(message));
        const head = JSON.stringify({ system: draft.system, tools: draft.tools });
        const old = previous.get(draft.sessionID);
        const prefixRewrite = !!old && (head !== old.head || old.messages.some((message, index) => message !== messages[index]));
        previous.set(draft.sessionID, { messages, head });
        const serialized = redact(JSON.stringify(draft, null, 2));
        writeFileSync(join(fixture.root, file), serialized, { mode: 0o600 });
        writeFileSync(join(fixture.root, logFile), log, { mode: 0o600 });
        passes.push({ number, sessionID: draft.sessionID, usageBefore: rows.filter((row) => row.session_id === draft.sessionID).length,
            at: Date.now(), file, logFile, log, bytes: Buffer.byteLength(JSON.stringify(draft)),
            toolBytes: toolOutputBytes(draft), prefixRewrite, draft });
        return Response.json({ ok: true });
    }
    if (fake && path === "/chat/completions") {
        const body = await request.json() as Record<string, unknown>;
        return fake.respond(body);
    }
    return new Response("No route", { status: 404 });
} });
fixture.env.MC886_CONTROL_URL = `http://127.0.0.1:${controller.port}`;
fixture.env.MC886_CONTROL_TOKEN = controlToken;
let host: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
let startupDiagnostics = () => "Host handoff not reached";
try {
    host = await spawnOpencode2({ cli: selected.cli, existingIsolation: fixture, serviceMode: true, waitForTransport: true,
        onHandoff: (handoff) => { startupDiagnostics = handoff.stderr; },
        providerID: "deepseek", defaultModelID: "deepseek-flash", modelContextLimit: contextLimit,
        modelOutputLimit: outputLimit, modelInputLimit: inputLimit,
        providerSettings: { baseURL: fake ? fixture.env.MC886_CONTROL_URL : "https://api.deepseek.com", apiKey: key },
        ...(fake ? { existingMock: { mock: fake.mock, baseURL: fixture.env.MC886_CONTROL_URL! } } : {}),
        preserveMagicContextDefaults: true,
        magicContextConfig: { execute_threshold_tokens: { default: thresholdTokens }, execute_threshold_percentage: 80,
            protected_tokens: 16000, history_budget_percentage: 0.1,
            historian: { opencode: { model: "deepseek/deepseek-flash" } } },
        probePlugin: join(import.meta.dir, "probe"),
        extraConfig: { permission: { "*": "allow" }, enabled_providers: ["deepseek"],
            mcp: { servers: { issue886: { type: "local", codemode: true, protocol: "legacy",
                command: [process.execPath, join(import.meta.dir, "mcp-server.ts"), mcpRevisionFile, String(mcpTools)] } } } },
    });
    const client = OpenCode.make({ baseUrl: host.url,
        headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
    const session = await client.session.create({ location: { directory: fixture.cwd },
        model: { providerID: "deepseek", id: "deepseek-flash" } });
    guard.mainID = session.id;
    await waitForPluginActive(client, fixture.cwd);
    let mcpConnected = true;
    let mcpRevision = 1;
    const mcpInput = { server: "issue886", location: { directory: fixture.cwd } };
    await client.mcp.connect(mcpInput);
    const assertMcpConnected = async () => {
        const server = (await client.mcp.list({ location: mcpInput.location })).data.find((server) => server.name === "issue886");
        if (server?.status.status !== "connected") throw new Error(`Local MCP did not connect: ${JSON.stringify(server)}`);
    };
    await assertMcpConnected();
    churnMcp = async (reason) => {
        if (mcpConnected) await client.mcp.disconnect(mcpInput);
        else {
            writeFileSync(mcpRevisionFile, String(++mcpRevision));
            await client.mcp.connect(mcpInput);
            await assertMcpConnected();
        }
        mcpConnected = !mcpConnected;
        mcpChanges.push({ reason, afterStep: guard.mainPasses, connected: mcpConnected });
    };
    const recordOpenFiles = () => {
        const paths = inspectOpenFiles(host!.pid!, fixture.root, fixture.env);
        const raw = spawnSync("lsof", ["-p", String(host!.pid)], { encoding: "utf8" });
        if (raw.status !== 0) throw new Error("lsof host inventory failed");
        const dbPaths = paths.filter((path) => /\.(db|sqlite)(-(wal|shm))?$/.test(path));
        if (!dbPaths.length || dbPaths.some((path) => !path.startsWith(`${fixture.root}/`))) throw new Error("Non-throwaway database descriptor");
        writeFileSync(join(fixture.root, "lsof.txt"), raw.stdout, { mode: 0o600 });
        writeFileSync(join(fixture.root, "db-paths.json"), JSON.stringify(dbPaths, null, 2));
    };
    recordOpenFiles();
    const deadline = Date.now() + timeout;
    let batchStart = guard.mainPasses;
    while (!guard.reason && Date.now() < deadline) {
        const newBatch = turns === 0 || guard.mainPasses === batchStart;
        const prompt = newBatch ? batchPrompt(batch, batchEnd - batchStart)
            : `Continue the batch ${batch}. Re-read PLAYBOOK.md before acting; keep building and testing with shell only.`;
        if (newBatch) batchMessages++;
        await client.session.prompt({ sessionID: session.id, text: prompt });
        turns++;
        let idle = false;
        let waitError: unknown;
        // The client's transport ends a long wait with its own timeout while the turn is still
        // running, so a transport timeout before the run's deadline means "wait again".
        const waiting = (async () => {
            while (!idle && !guard.reason && Date.now() < deadline) {
                try {
                    await client.session.wait({ sessionID: session.id },
                        { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
                    idle = true;
                } catch (error) {
                    if (/timed out/i.test(String(error)) && !guard.reason && Date.now() < deadline) continue;
                    waitError = error;
                    idle = true;
                }
            }
        })();
        while (!idle && !guard.reason && Date.now() < deadline) await Bun.sleep(100);
        if (!idle) {
            stopReason = guard.reason || "timeout";
            guard.reason = stopReason;
            await client.session.interrupt({ sessionID: session.id });
        }
        await waiting;
        if (waitError && !guard.reason) throw waitError;
        if (guard.reason === "batch_boundary" || (idle && guard.mainPasses >= batchEnd && batch < batchCount)) {
            guard.reason = "";
            stopReason = "";
            batch++;
            batchStart = guard.mainPasses;
            batchEnd = Math.min(stepCap, batchStart + Math.max(1, Math.ceil((stepCap - batchStart) / (batchCount - batch + 1))));
            changeInstructions("between-batches");
            await mcpPending;
            await churnMcp("between-batches");
        }
    }
    stopReason ||= guard.reason || "timeout";
    writeFileSync(join(fixture.root, "instruction-schema.json"), JSON.stringify(instructionSchema(hostDB), null, 2));
    writeFileSync(join(fixture.root, "instruction-rows.json"), JSON.stringify(instructionRows(hostDB, session.id), null, 2));
    const last = [...passes].reverse().find((pass) => pass.wireFile && pass.sessionID === session.id);
    if (last) writeFileSync(join(fixture.root, "last-pass.json"), redact(JSON.stringify({
        draft: last.draft, wire: JSON.parse(readFileSync(join(fixture.root, last.wireFile!), "utf8")),
    }, null, 2)), { mode: 0o600 });
    recordOpenFiles();
} catch (error) {
    stopReason = guard.reason || "error";
    writeFileSync(join(fixture.root, "error.txt"), redact(String(error)), { mode: 0o600 });
    console.error(redact(error instanceof Error ? error.stack ?? error.message : String(error)));
    if (!host) {
        writeFileSync(join(fixture.root, "host.log"), redact(startupDiagnostics()), { mode: 0o600 });
        console.error(redact(startupDiagnostics()));
    }
    if (!guard.reason) process.exitCode = 1;
} finally {
    guard.reason ||= stopReason || "shutdown";
    if (host) {
        writeFileSync(join(fixture.root, "host.log"), redact(`${host.stdout()}\n${host.stderr()}`), { mode: 0o600 });
        try { await host.stop(); } catch (error) {
            console.error(redact(String(error)));
            process.exitCode = 1;
        }
    } else if (fake) await fake.mock.stop();
    controller.stop(true);
    if (!["step_cap", "spend_guard"].includes(stopReason)) process.exitCode = 1;
    const summary = writeEvidence(fixture.root, passes, readUsage(hostDB), guard.mainID, stopReason, {
        fake: values.fake, hostVersion: version.stdout.trim(), stepCap, dollarCap, inputLimit, contextLimit,
        elapsedSeconds: (Date.now() - startedAt) / 1000,
        outputLimit, turns, wireBodies: wireCount, maximumReservedCallUSD: guard.maxCallCost,
        runRoot: fixture.root, authorizedHeadRequests: guard.mainPasses,
        batches: batchMessages, batchCount, instructionChanges, mcpChanges, tokenizerFingerprint: tokenizer.getTokenEstimatorFingerprint(),
        liveWireDump: "OpenCode session http.request hook (body only, no headers)",
        unpersistedProviderCostUSD: guard.extraCost(readUsage(hostDB)),
        outstandingReservedUSD: guard.outstandingCost(readUsage(hostDB)),
    }, redact);
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Artifacts retained: ${fixture.root}`);
    if (values["evidence-dir"]) {
        const destination = resolve(values["evidence-dir"]);
        mkdirSync(destination, { recursive: true });
        for (const name of ["steps.csv", "summary.json", "summary.md", "usage.json", "lsof.txt", "db-paths.json", "host.log", "magic-context.log", "error.txt", "passes", "wire", "instructions", "instruction-schema.json", "instruction-rows.json", "last-pass.json"]) {
            if (existsSync(join(fixture.root, name))) cpSync(join(fixture.root, name), join(destination, name), { recursive: true });
        }
    }
}
