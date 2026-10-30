import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { Database } from "../../src/shared/sqlite";
import { attestHost, attestProcessTree, type Isolation } from "../two-pass-live-replay/host-drivers";
import { assertObservedPluginStore, processActivationTransport, redact, type ActivationHost, type ActivationTransport, type CallBound } from "./activation-driver";
import { mockMeteringProxy } from "./provider-meter";
import { readHostEvents, stageEventObserver } from "./event-observer";
import { redactedLines } from "./credential-protocol";

export type HostLane = "opencode-1" | "opencode-2" | "omp";
export interface HostAdapterOptions {
    sourceRoot: string;
    mockProviderURL: string;
    modelId: string;
    providerId?: string;
    providerPackage?: string;
    piApi?: string;
    piAuth?: "apiKey" | "oauth";
    classify?(path: string, body: string): CallBound["kind"];
    magicContext: Record<string, unknown>;
    outputCeiling: number;
    timeoutMs?: number;
    startupTimeoutMs?: number;
    expectTurnTwo?: boolean;
    /** Synthetic probes can add a second foreground turn and explicitly request wrapup. */
    forceWrapup?: boolean;
    /** Reference a variable only in the host child, never serialize its value into config. */
    providerKeyEnv?: `${string}_API_KEY`;
    grantFree?: boolean;
    /** Credential probes return provider requests and host events, but skip persisted activation-stage checks. */
    foregroundOnly?: boolean;
    paidProvider?: boolean;
    onProviderAttempt?(providerHost: string): void;
    onProcessObserved?(pid: number): void;
}

/** Install pinned hosts under the isolated root; never use a host already installed on the machine. */
export function hostAdapter(lane: HostLane, options: HostAdapterOptions): ActivationTransport {
    const installer = join(import.meta.dir, "install-host.ts");
    const providerId = options.providerId ?? "mock";
    let proxy: Awaited<ReturnType<typeof mockMeteringProxy>> | undefined;
    let hostEnv: Record<string, string>;
    let work: string;
    let version = "";
    let versionOutput = "";
    let observer: ReturnType<typeof stageEventObserver>;
    let secrets: string[] = [];
    let hostPid: number | undefined;
    const processProofs = new Map<number, Isolation>();
    const logFilters: ReturnType<typeof redactedLines>[] = [];
    const binary = (root: string) => join(root, "host-dist/node_modules/.bin", lane === "omp" ? "omp" : "opencode");
    const entrypoint = (root: string) => join(root, lane === "omp" ? "packages/pi-plugin/dist/index.js" : lane === "opencode-2" ? "packages/plugin/dist/v2/server.js" : "packages/plugin/dist/index.js");
    return processActivationTransport({
        stage: (root) => ({ argv: [process.execPath, installer, "stage", options.sourceRoot, root, lane], cwd: root }),
        build: (root) => ({ argv: [process.execPath, installer, "build", options.sourceRoot, root, lane], cwd: root }),
        entrypoint,
        async launch(input) {
            if (process.platform === "darwin") throw new Error("mac_native_host_not_authorized");
            secrets = Object.entries(input.env).filter(([key]) => key.endsWith("_API_KEY")).map(([, value]) => value);
            if (options.providerKeyEnv && !input.env[options.providerKeyEnv]) throw new Error("host_provider_credential_required");
            const root = resolve(input.env.OPENCODE_DB, "../..");
            work = join(root, "work");
            for (const path of [work, ...["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "MAGIC_CONTEXT_STORAGE_DIR"].map((key) => input.env[key]), join(root, "host"), join(root, "tmp")])
                mkdirSync(path, { recursive: true });
            Object.assign(input.env, {
                HOME: join(root, "home"), TMPDIR: join(root, "tmp"), XDG_CACHE_HOME: join(root, "cache"),
                OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
                OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_CONFIG_DIR: input.env.XDG_CONFIG_HOME,
                MAGIC_CONTEXT_LOG_PATH: join(root, "magic-context.log"), MAGIC_CONTEXT_LOG_SYNC: "1",
                PI_CODING_AGENT_DIR: join(root, "omp-agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
            });
            hostEnv = input.env;
            const versionEnv = Object.fromEntries(Object.entries(hostEnv).filter(([key]) => !key.endsWith("_API_KEY")));
            const result = spawnSync(binary(input.installRoot), ["--version"], { cwd: work, env: { PATH: process.env.PATH, ...versionEnv }, encoding: "utf8" });
            versionOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
            version = versionOutput.match(/\d+\.\d+\.\d+/)?.[0] ?? "";
            if (result.status !== 0 || (lane === "opencode-1" ? !/^1\.18\.(3[1-9]|[4-9]\d|\d{3,})$/.test(version) : lane === "opencode-2" ? version !== "2.0.22" : !/18\.12\.\d+/.test(version)))
                throw new Error("host_version_not_pinned");
            proxy = await mockMeteringProxy({ upstream: options.mockProviderURL, meter: input.meter,
                secrets, forwardCredentials: !!options.providerKeyEnv || !!options.grantFree, paidProvider: options.paidProvider,
                onProviderAttempt: options.onProviderAttempt,
                outputCeiling: options.outputCeiling,
                // Prompt text can mention another stage; it is not evidence of this dispatch's purpose.
                classify: options.classify ?? (() => "unclassified"),
                async beforeDispatch() {
                    if (!hostPid) throw new Error("provider_process_unobserved");
                    for (const proof of await attestProcessTree(root, hostEnv, hostPid)) {
                        options.onProcessObserved?.(proof.proof.pid);
                        if (!processProofs.has(proof.proof.pid)) processProofs.set(proof.proof.pid, proof);
                    }
                },
            });
            observer = stageEventObserver(root, lane);
            input.env.MC_HOST_EVENT_JSONL = observer.eventsPath;
            writeConfigs(lane, input.installRoot, work, hostEnv, proxy.url, options, observer);
            return { argv: lane === "omp" ? [binary(input.installRoot), "--mode", "rpc", "--extension", entrypoint(input.installRoot), "--extension", observer.entrypoint]
                : [binary(input.installRoot), "serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], cwd: work };
        },
        async connect(input) {
            hostPid = input.pid;
            const root = resolve(input.env.OPENCODE_DB, "../..");
            for (const stream of [input.stdout, input.stderr]) {
                const filter = redactedLines(secrets, (line) => appendFileSync(join(root, "mock-host.log"), line));
                logFilters.push(filter);
                stream.on("data", (chunk) => filter.write(chunk));
            }
            const storePath = join(hostEnv.MAGIC_CONTEXT_STORAGE_DIR, "context.db");
            const events: unknown[] = [];
            let observedCarrier: ActivationHost["carrier"] = "unobservable";
            let observedStore: string | null = null;
            let sessionId = "";
            let prompt: (text: string) => Promise<unknown>;
            if (lane === "omp") {
                const lines = createInterface({ input: input.stdout });
                const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
                const settled: Array<() => void> = [];
                lines.on("line", (line) => {
                    try {
                        const value = JSON.parse(line);
                        events.push(redact(value, secrets));
                        if (value.type === "agent_end") settled.splice(0).forEach((done) => done());
                        if (value.id && pending.has(value.id)) {
                            const call = pending.get(value.id)!; pending.delete(value.id);
                            if (value.success === false) call.reject(new Error("omp_rpc_failed")); else call.resolve(value);
                        }
                    } catch { /* Non-JSON stdout is not a session response. */ }
                });
                input.stderr.resume();
                let sequence = 0;
                const rpc = (type: string, fields: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
                    const id = `activation-${++sequence}`;
                    pending.set(id, { resolve, reject });
                    input.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
                    setTimeout(() => { if (pending.delete(id)) reject(new Error("omp_rpc_timeout")); }, options.timeoutMs ?? 120_000).unref();
                });
                const state = await rpc("get_state");
                sessionId = state.data?.sessionId ?? "";
                const waitSettled = async () => {
                    const end = Date.now() + (options.timeoutMs ?? 120_000);
                    for (;;) {
                        if (Date.now() >= end) throw new Error("omp_settlement_timeout");
                        const value = (await rpc("get_state")).data;
                        if (typeof value?.isSettled !== "boolean" || typeof value?.hasPendingAsyncWork !== "boolean")
                            throw new Error("omp_settlement_unobservable");
                        if (value.isSettled && !value.isStreaming && !value.hasPendingAsyncWork) return {
                            sessionId: value.sessionId, isSettled: value.isSettled,
                            isStreaming: value.isStreaming, hasPendingAsyncWork: value.hasPendingAsyncWork,
                        };
                        await new Promise((resolve) => setTimeout(resolve, 50));
                    }
                };
                let started = false;
                prompt = async (message) => {
                    if (started) await rpc("new_session");
                    started = true;
                    sessionId = (await rpc("get_state")).data?.sessionId ?? "";
                    if (!sessionId) throw new Error("omp_session_id_unobservable");
                    const end = new Promise<void>((resolve) => settled.push(resolve));
                    await rpc("prompt", { message });
                    await deadline(end, options.timeoutMs ?? 120_000);
                    await waitSettled();
                    if (options.forceWrapup) {
                        const secondEnd = new Promise<void>((resolve) => settled.push(resolve));
                        await rpc("prompt", { message: "Confirm the corrected project setting." });
                        await deadline(secondEnd, options.timeoutMs ?? 120_000);
                        await waitSettled();
                        await rpc("prompt", { message: "/ctx-wrapup 1" });
                    }
                    return { messages: await rpc("get_messages"), state: await waitSettled() };
                };
            } else {
                let handoff = "";
                const endpoint = new Promise<{ url: string; password?: string }>((resolve) => {
                    const consume = (chunk: Buffer) => {
                        handoff += chunk.toString();
                        const url = handoff.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
                        const password = handoff.match(/password[\s:=]+([^\s"',]+)/i)?.[1];
                        if (url && (lane === "opencode-1" || password)) resolve({ url, password });
                    };
                    input.stdout.on("data", consume); input.stderr.on("data", consume);
                });
                const host = await deadline(endpoint, 60_000);
                const api = async (path: string, body?: unknown, timeout = options.timeoutMs ?? 120_000) => {
                    const url = new URL(`${host.url}${lane === "opencode-2" ? "/api" : ""}${path}`);
                    url.searchParams.set("directory", work);
                    const reply = await fetch(url, { method: body === undefined ? "GET" : "POST",
                        headers: { "content-type": "application/json", ...(host.password ? { authorization: `Basic ${Buffer.from(`opencode:${host.password}`).toString("base64")}` } : {}) },
                        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
                    if (!reply.ok) {
                        if (proxy?.budgetStop) throw proxy.budgetStop;
                        throw new Error("host_session_rpc_failed");
                    }
                    if (reply.status === 204) return null;
                    const value = await reply.json();
                    if (lane === "opencode-2") {
                        if (!value || typeof value !== "object" || !("data" in value)) throw new Error("host_rpc_envelope_unobservable");
                        return value.data;
                    }
                    return value;
                };
                await api("/session", undefined, options.startupTimeoutMs ?? 300_000);
                prompt = async (text) => {
                    const session = await api("/session", lane === "opencode-2" ? {
                        location: { directory: work }, model: { providerID: providerId, id: options.modelId },
                    } : {}) as { id?: string };
                    sessionId = session.id ?? "";
                    if (!sessionId) throw new Error("session_id_unobservable");
                    const route = `/session/${sessionId}/${lane === "opencode-2" ? "prompt" : "message"}`;
                    const result = await api(route, lane === "opencode-2" ? { text } : {
                        model: { providerID: providerId, modelID: options.modelId }, parts: [{ type: "text", text }],
                    });
                    if (lane === "opencode-2") await api(`/experimental/session/${sessionId}/wait`, {});
                    if (options.forceWrapup) {
                        await api(route, lane === "opencode-2" ? { text: "Confirm the corrected project setting." } : { model: { providerID: providerId, modelID: options.modelId }, parts: [{ type: "text", text: "Confirm the corrected project setting." }] });
                        if (lane === "opencode-2") await api(`/experimental/session/${sessionId}/wait`, {});
                        await api(`/session/${sessionId}/command`, lane === "opencode-2" ? { name: "ctx-wrapup", text: "1" } : { command: "ctx-wrapup", arguments: "1", agent: "build", model: `${providerId}/${options.modelId}`, parts: [] });
                    }
                    return result;
                };
            }
            return {
                lane, get carrier() { return observedCarrier; }, get storePath() { return observedStore; },
                async runSession(text) {
                    const before = existsSync(storePath) ? stageRows(storePath).map((row) => row.stage_key) : [];
                    const eventStart = readHostEvents(observer.eventsPath).length;
                    const requestStart = proxy!.receipts.length;
                    let foreground: unknown;
                    try { foreground = await prompt(text); }
                    catch (error) { if (proxy?.budgetStop) throw proxy.budgetStop; throw error; }
                    if (proxy?.budgetStop) throw proxy.budgetStop;
                    if (options.foregroundOnly) return redact({ version, versionOutput, foreground,
                        requests: proxy!.receipts.slice(requestStart), hostEvents: readHostEvents(observer.eventsPath).slice(eventStart) }, secrets);
                    let stages: any[] = [];
                    await waitFor(() => {
                        if (proxy?.budgetStop) throw proxy.budgetStop;
                        stages = stageRows(storePath).filter((row) => !before.includes(row.stage_key));
                        const first = stages.filter((row) => row.stage === "turn_one");
                        const second = stages.filter((row) => row.stage === "turn_two");
                        return first.some((row) => row.state === "published") &&
                            (options.expectTurnTwo === false || second.some((row) => row.state === "resolved")) &&
                            stages.every((row) => !["dispatched", "reserved", "sending", "replied"].includes(row.state));
                    }, options.timeoutMs ?? 120_000);
                    const carriers = [...new Set(stages.filter((row) => row.stage === "turn_one" || row.stage === "turn_two").map((row) => row.carrier))];
                    if (carriers.length !== 1 || !["hidden-completion", "opencode-session", "pi-historian-rpc"].includes(carriers[0]) ||
                        (lane === "opencode-2" && carriers[0] !== "hidden-completion") || (lane === "omp" && carriers[0] !== "pi-historian-rpc"))
                        throw new Error("carrier_unobservable_or_mismatched");
                    observedCarrier = carriers[0];
                    const firstChild = stages.find((row) => row.stage === "turn_one")?.child_session_id;
                    sessionId = stages.find((row) => row.stage === "turn_one")?.session_id ?? sessionId;
                    if (options.expectTurnTwo !== false && (!firstChild || stages.some((row) => row.stage === "turn_two" && row.child_session_id !== firstChild)))
                        throw new Error("historian_child_not_retained");
                    const after = await attestHost(root, hostEnv, input.pid);
                    observedStore = assertObservedPluginStore(after, storePath);
                    const requests = proxy!.receipts.slice(requestStart);
                    if (!requests.length || proxy!.failures.length) throw new Error("mock_did_not_capture_all_dispatches");
                    const hostEvents = readHostEvents(observer.eventsPath).slice(eventStart);
                    let ompRpcInventory: unknown;
                    if (lane === "omp") {
                        const childPid = Number(firstChild?.split(":")[2]);
                        const marker = readFileSync(hostEnv.MAGIC_CONTEXT_LOG_PATH, "utf8").split("\n")
                            .filter((line) => line.includes("[omp-retained-rpc] "))
                            .map((line) => JSON.parse(line.slice(line.indexOf("[omp-retained-rpc] ") + "[omp-retained-rpc] ".length)))
                            .find((entry) => entry.pid === childPid);
                        if (!marker || marker.protocolVersion !== 2 || marker.tools.length !== 0 || !processProofs.has(childPid))
                            throw new Error("omp_retained_inventory_unobservable");
                        ompRpcInventory = marker;
                    }
                    return redact({ version, versionOutput, sessionId, foreground, carrier: observedCarrier, historian: { stages, completedStages: true,
                        schedulerIdle: { status: "unobservable", reason: "The plugin does not export its deferred-task queue. Published/resolved rows prove only the observed lifecycle stages completed." } },
                        requests, events, hostEvents, ompRpcInventory, processProofs: [...processProofs.values()], isolation: after,
                        cacheRebuild: { status: "unobservable", reason: "Host events are recorded, but their contracts do not attribute a cache rebuild to Magic Context. No absence claim is made." },
                    }, secrets);
                },
            };
        },
        async stopped() {
            try { if (proxy) { await proxy.close(); proxy = undefined; } }
            finally { for (const filter of logFilters.splice(0)) filter.end(); secrets.fill(""); secrets = []; }
        },
    });
}

export const openCode1Adapter = (options: HostAdapterOptions) => hostAdapter("opencode-1", options);
export const openCode2Adapter = (options: HostAdapterOptions) => hostAdapter("opencode-2", options);
export const ohMyPiAdapter = (options: HostAdapterOptions) => hostAdapter("omp", options);

function stageRows(path: string): any[] {
    const db = new Database(path, { readonly: true });
    try { return db.prepare("SELECT * FROM memory_stage_attempts ORDER BY started_at,stage_key").all(); }
    finally { db.close(); }
}
async function waitFor(predicate: () => boolean, timeout: number) {
    const end = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() >= end) throw new Error("historian_or_host_settlement_timeout");
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
async function deadline<T>(promise: Promise<T>, timeout: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("host_rpc_timeout")), timeout); })]); }
    finally { clearTimeout(timer!); }
}

function writeConfigs(lane: HostLane, install: string, work: string, env: Record<string, string>, endpoint: string, options: HostAdapterOptions, observer: ReturnType<typeof stageEventObserver>) {
    const providerId = options.providerId ?? "mock";
    const model = `${providerId}/${options.modelId}`;
    const plugin = lane === "opencode-2" ? join(install, "packages/plugin") : pathToFileURL(join(install, "packages/plugin/dist/index.js")).href;
    const limits = { context: 200_000, output: options.outputCeiling };
    // OpenCode's grant-free Zen path uses the public marker, not an account credential.
    const apiKey = options.grantFree ? "public" : options.providerKeyEnv ? (lane === "omp" ? options.providerKeyEnv : `{env:${options.providerKeyEnv}}`) : "mock-only-key";
    const config = lane === "opencode-2" ? { plugins: [plugin, observer.directory], model,
        providers: { [providerId]: { package: options.providerPackage ?? "@ai-sdk/openai-compatible", settings: { baseURL: `${endpoint}/v1`, apiKey }, models: { [options.modelId]: { name: options.modelId, limit: limits } } } },
        compaction: { auto: false },
    } : { plugin: [plugin, pathToFileURL(observer.entrypoint).href], model, small_model: model, enabled_providers: [providerId], autoupdate: false,
        provider: { [providerId]: { npm: options.providerPackage ?? "@ai-sdk/openai-compatible", options: { baseURL: `${endpoint}/v1`, apiKey }, models: { [options.modelId]: { name: options.modelId, limit: limits } } } },
        compaction: { auto: false, prune: false }, agent: { title: { disable: true }, summary: { disable: true } },
    };
    if (lane === "omp") {
        mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
        writeFileSync(join(env.PI_CODING_AGENT_DIR, "config.yml"), JSON.stringify({ defaultProvider: providerId, defaultModel: options.modelId,
            enabledModels: [model], retry: { enabled: false }, compaction: { enabled: false }, quietStartup: true, enableInstallTelemetry: false, tools: { xdev: false, intentTracing: false } }));
        const models = JSON.stringify({ providers: { [providerId]: { api: options.piApi ?? "anthropic-messages", baseUrl: endpoint, apiKey,
            ...(options.piAuth ? { auth: options.piAuth } : {}),
            models: [{ id: options.modelId, name: options.modelId, input: ["text"], contextWindow: 200_000, maxTokens: options.outputCeiling, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
        // OMP 18.12 reads YAML first; updating only JSON leaves a previously imported endpoint active.
        writeFileSync(join(env.PI_CODING_AGENT_DIR, "models.yml"), models);
        writeFileSync(join(env.PI_CODING_AGENT_DIR, "models.json"), models);
    } else if (lane === "opencode-2") writeFileSync(join(work, "opencode.json"), JSON.stringify(config));
    else {
        if (existsSync(join(work, "opencode.json"))) unlinkSync(join(work, "opencode.json"));
        writeFileSync(join(env.XDG_CONFIG_HOME, "opencode.json"), JSON.stringify(config));
    }
    const settings = { enabled: true, memory: { enabled: true, auto_search: { enabled: false }, git_commit_indexing: { enabled: false } },
        embedding: { provider: "off" }, dreamer: { disable: true }, historian: { [lane === "omp" ? "omp" : "opencode"]: { model } }, ...options.magicContext };
    mkdirSync(join(env.XDG_CONFIG_HOME, "cortexkit"), { recursive: true });
    writeFileSync(join(env.XDG_CONFIG_HOME, "cortexkit/magic-context.jsonc"), JSON.stringify(settings));
}
