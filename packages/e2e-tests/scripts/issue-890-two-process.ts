import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../plugin/src/shared/sqlite";
import { ROOT_KEYS, inspectOpenFiles, spawnOpencode2, waitForPluginActive } from "../src/opencode2-runner/spawn";

// Investigation of a report that every Magic Context hidden run (summarizer,
// dreamer) fails with `hidden_prompt_unrecognized` when two OpenCode 2 processes
// share one session store, as under OpenChamber.
//
// What a successful run proves, on a real OpenCode 2 host with a loopback model:
//   1. Two servers (one `--service`, one plain `serve`) load Magic Context on the
//      same throwaway store; the summarizer fires automatically from a session
//      driven through the second server and publishes compartments.
//   2. A summarizer child held in flight on the first server still completes while
//      three newer servers start one after another and each lists and reads that
//      child, so a restarted sibling server does not take over another process's
//      child turn.
//   3. With ISSUE_890_FAILOVER_PLUGIN set (see issue-890-two-process.sh), the
//      retry plugin OpenChamber generates absorbs a simulated HTTP 429 and the run
//      still succeeds.
//   4. Positive control: a prompt altered on its way to the child produces the exact
//      refusal the reporter quoted, never reaches the model, and the failed child is
//      deleted afterwards (unless ISSUE_890_KEEP=1 keeps it).
// The script throws if any step does not hold, and writes an evidence JSON file
// (ISSUE_890_OUTPUT, default under the throwaway root) with traces and logs.
//
// Run it through issue-890-two-process.sh, which installs the pinned host and sets
// MC_E2E_OPENCODE2_CLI and MC_E2E_OPENCODE2_AI_ROOT. Every host root (data,
// config, state, runtime, temp and the OpenCode database) is a fresh directory
// under $TMPDIR/magic-context/issue-890/, shared only by the hosts this script
// starts; no live store is opened and no real provider credentials are used.
const base = join(tmpdir(), "magic-context", "issue-890");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "two-process-"));
const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    OPENCODE_DB: "opencode2.db",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    MAGIC_CONTEXT_LOG_SYNC: "1",
};
for (const key of ROOT_KEYS) mkdirSync(env[key] = join(root, key));
env.TMPDIR = root;
env.CFFIXED_USER_HOME = env.HOME;
env.MAGIC_CONTEXT_STORAGE_DIR = join(env.XDG_DATA_HOME!, "cortexkit", "magic-context");
env.MAGIC_CONTEXT_LOG_PATH = join(root, "a.log");
const callbackRequests: unknown[] = [];
const callback = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    callbackRequests.push(await request.json());
    return Response.json({ action: "retry" });
} });
env.OPENCHAMBER_AGENT_TOOL_URL = `http://127.0.0.1:${callback.port}`;
env.OPENCHAMBER_AGENT_TOOL_TOKEN = "fixture-token";
const cwd = join(root, "work");
mkdirSync(cwd);
for (const args of [["init", "-q"], ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "fixture"]]) {
    const result = spawnSync("git", args, { cwd });
    if (result.status !== 0) throw new Error(result.stderr.toString());
}
const probe = join(root, "probe");
if (!existsSync(resolve(import.meta.dir, "../../plugin/dist/v2/server.js")))
    throw new Error("Build packages/plugin before running the investigation");
const built = await Bun.build({ entrypoints: [join(import.meta.dir, "issue-890-two-process-probe.ts")],
    outdir: probe, naming: "server.js", target: "bun", format: "esm",
    plugins: [{ name: "shipped-adapter", setup(build) {
        build.onResolve({ filter: /^\.\.\/\.\.\/plugin\/src\/v2\/server$/ }, () => ({
            path: resolve(import.meta.dir, "../../plugin/dist/v2/server.js"), external: true,
        }));
    } }],
    define: { "process.env.NODE_ENV": '"production"' }, external: ["bun:sqlite", "node:sqlite"] });
if (!built.success) throw new AggregateError(built.logs, "Probe build failed");
const options = {
    existingIsolation: { root, env, cwd },
    includeMagicContext: false,
    prePlugin: process.env.ISSUE_890_FAILOVER_PLUGIN,
    probePlugin: probe,
    modelContextLimit: 200_000,
    modelOutputLimit: 1024,
    historianModel: { id: "mock-historian", contextLimit: 200_000 },
    magicContextConfig: { memory: { enabled: false, auto_search: { enabled: false } }, dreamer: { disable: true },
        historian: { two_pass: false }, keep_subagents: process.env.ISSUE_890_KEEP === "1",
        protected_tokens: 4000, execute_threshold_percentage: 20 },
};
const a = await spawnOpencode2({ ...options, serviceMode: true });
let b: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
const evidence: Record<string, unknown> = { root, version: process.env.MC_E2E_OPENCODE2_VERSION };
const clientFor = (host: typeof a) => OpenCode.make({ baseUrl: host.url,
    headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
try {
    const ca = clientFor(a);
    await waitForPluginActive(ca, cwd, "mc-issue-890-probe");
    b = await spawnOpencode2({ ...options, prepareContextDatabase: false,
        existingIsolation: { root, cwd, env: { ...env, MAGIC_CONTEXT_LOG_PATH: join(root, "b.log") } },
        existingMock: { mock: a.mock, baseURL: a.mockBaseURL } });
    const cb = clientFor(b);
    await waitForPluginActive(cb, cwd, "mc-issue-890-probe");
    evidence.hosts = [{ pid: a.pid, url: a.url, mode: "service" }, { pid: b.pid, url: b.url, mode: "serve" }];
    evidence.openDatabases = [a, b].map(host => ({ pid: host.pid,
        paths: inspectOpenFiles(host.pid!, root, host.env).filter(path => /\.db(?:-wal|-shm)?$/.test(path)) }));
    let limitInjected = false;
    a.mock.addMatcher(body => {
        const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
        if (range && process.env.ISSUE_890_FAILOVER_PLUGIN && !limitInjected) {
            limitInjected = true;
            return { error: { status: 429, type: "rate_limit_error", message: "isolated provider rate limit" } };
        }
        return range ? { text: `<compartment start="${range[1]}" end="${range[2]}" title="Two processes"><p1>Isolated fixture history.</p1></compartment>`,
            usage: { input_tokens: 100, output_tokens: 40 } } : null;
    });
    a.mock.setDefault({ text: "fixture reply", usage: { input_tokens: 80000, output_tokens: 10 } });
    const session = await cb.session.create({ title: "issue 890 two processes", location: { directory: cwd },
        model: { providerID: "openai", id: "mock-model" } });
    evidence.sessionID = session.id;
    for (let index = 0; index < 8; index++) {
        await cb.session.prompt({ sessionID: session.id, text: `Source ${index}: ${"durable history ".repeat(4000)}` });
        await cb.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
    }
    // Force a rebuild as well, so a negative automatic-trigger result cannot mask the executor.
    await cb.session.command({ sessionID: session.id, name: "ctx-recomp", text: "" });
    const db = new Database(join(env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"), { readonly: true });
    try {
        const until = Date.now() + 60_000;
        do {
            const runs = db.prepare("SELECT * FROM historian_runs WHERE session_id = ?").all(session.id) as Array<{ status: string }>;
            if (runs.some(run => ["success", "failed"].includes(run.status))) break;
            await Bun.sleep(100);
        } while (Date.now() < until);
        evidence.runs = db.prepare("SELECT * FROM historian_runs WHERE session_id = ?").all(session.id);
        evidence.compartments = db.prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?").get(session.id);
    } finally { db.close(); }
    const runs = evidence.runs as Array<{ run_kind: string; status: string }>;
    if (!runs.some(run => run.run_kind === "incremental" && run.status === "success"))
        throw new Error("No successful automatic summarizer run; fixture did not exercise the requested trigger");

    // A blocked context hook makes server startup overlap a real in-flight child,
    // rather than hoping a fast loopback completion happens to lose a race.
    await b.stopHost();
    const hold = join(env.XDG_STATE_HOME!, "hold-hidden");
    writeFileSync(hold, "hold\n");
    const before = readdirSync(env.XDG_STATE_HOME!).filter(name => name.startsWith("trace-"))
        .reduce((count, name) => count + readFileSync(join(env.XDG_STATE_HOME!, name), "utf8").split("context.paused").length - 1, 0);
    await ca.session.command({ sessionID: session.id, name: "ctx-recomp", text: "" });
    const deadline = Date.now() + 20_000;
    let pausedChild: string | undefined;
    while (!pausedChild && Date.now() < deadline) {
        const lines = readdirSync(env.XDG_STATE_HOME!).filter(name => name.startsWith("trace-"))
            .flatMap(name => readFileSync(join(env.XDG_STATE_HOME!, name), "utf8").trim().split("\n").map(line => JSON.parse(line)))
            .filter(line => line.event === "context.paused");
        if (lines.length > before) pausedChild = lines.at(-1).data.sessionID;
        else await Bun.sleep(20);
    }
    if (!pausedChild) throw new Error("No in-flight hidden context to overlap startup");
    evidence.churn = [];
    for (let index = 0; index < 3; index++) {
        b = await spawnOpencode2({ ...options, prepareContextDatabase: false,
            existingIsolation: { root, cwd, env: { ...env, MAGIC_CONTEXT_LOG_PATH: join(root, `churn-${index}.log`) } },
            existingMock: { mock: a.mock, baseURL: a.mockBaseURL } });
        const client = clientFor(b);
        await waitForPluginActive(client, cwd, "mc-issue-890-probe");
        const child = await client.session.get({ sessionID: pausedChild });
        await client.session.list({});
        (evidence.churn as unknown[]).push({ pid: b.pid, childID: child.id,
            paths: inspectOpenFiles(b.pid!, root, b.env).filter(path => /\.db(?:-wal|-shm)?$/.test(path)) });
        await b.stopHost();
    }
    unlinkSync(hold);
    await ca.session.wait({ sessionID: pausedChild }, { signal: AbortSignal.timeout(30_000) });
    evidence.churnChild = pausedChild;
    evidence.churnResult = "in-flight owner completed after three newer serve processes listed/opened its child";
    evidence.callbackRequests = callbackRequests;
    if (process.env.ISSUE_890_FAILOVER_PLUGIN && callbackRequests.length === 0)
        throw new Error("Generated failover plugin did not exercise its callback");
    const normalLogs = ["a.log", "b.log", "churn-0.log", "churn-1.log", "churn-2.log"]
        .map(name => existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : "").join("\n");
    if (normalLogs.includes("hidden_prompt_unrecognized")) throw new Error("Unmodified shared-store run refused a hidden prompt");

    // A separate positive control proves the refusal diagnostic is observable.
    // Altering a fresh marker before the first context hook matches the owned-child
    // branch quoted by the reporter, but is not evidence their UI does so.
    const controlAt = Date.now();
    const providerBeforeControl = a.mock.requests().length;
    writeFileSync(join(env.XDG_STATE_HOME!, "alter-marker"), "alter\n");
    await ca.session.command({ sessionID: session.id, name: "ctx-recomp", text: "" });
    let refusal = "";
    const controlDeadline = Date.now() + 20_000;
    while (!refusal && Date.now() < controlDeadline) {
        refusal = readFileSync(join(root, "a.log"), "utf8").split("\n")
            .find(line => line.includes("hidden child refused:")) ?? "";
        if (!refusal) await Bun.sleep(20);
    }
    if (!refusal.includes("Refusing an unregistered prompt on a Magic Context hidden-run session"))
        throw new Error("Altered-marker control did not produce the exact owned-child refusal");
    if (a.mock.requests().length !== providerBeforeControl) throw new Error("Altered-marker control reached the model");
    const childID = JSON.parse(refusal.slice(refusal.indexOf("{"))).session as string;
    const hostDb = new Database(join(env.XDG_DATA_HOME!, "opencode", env.OPENCODE_DB!), { readonly: true });
    try {
        let count = 1;
        const until = Date.now() + 5_000;
        while (count && Date.now() < until) {
            // OpenCode 2 keeps sessions in `session_v2`; there is no `session` table.
            count = (hostDb.prepare("SELECT COUNT(*) AS n FROM session_v2 WHERE id = ?").get(childID) as { n: number }).n;
            if (count) await Bun.sleep(20);
        }
        evidence.control = { at: controlAt, childID, refusal, providerRequests: a.mock.requests().length - providerBeforeControl,
            remainingSessionRows: count };
        if (count !== 0 && process.env.ISSUE_890_KEEP !== "1") throw new Error("Failed child was not cleaned up");
    } finally { hostDb.close(); }
    evidence.mockRequests = a.mock.requests().length;
} catch (error) {
    evidence.error = String(error);
    throw error;
} finally {
    evidence.traces = readdirSync(env.XDG_STATE_HOME!).filter(name => name.startsWith("trace-")).map(name => ({
        name, lines: readFileSync(join(env.XDG_STATE_HOME!, name), "utf8").trim().split("\n").map(line => JSON.parse(line)) }));
    evidence.logs = readdirSync(root).filter(name => name.endsWith(".log")).map(name => ({ name,
        content: existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : "" }));
    evidence.hostLogs = [a, ...(b ? [b] : [])].map(host => ({ pid: host.pid,
        stdout: host.stdout().replaceAll(host.password, "<fixture-password>"), stderr: host.stderr().replaceAll(host.password, "<fixture-password>") }));
    const output = resolve(process.env.ISSUE_890_OUTPUT ?? join(root, "evidence.json"));
    writeFileSync(output, JSON.stringify(evidence, null, 2));
    console.log(`ISSUE_890_EVIDENCE ${output}`);
    console.log(JSON.stringify({ ...evidence, traces: undefined, logs: undefined, hostLogs: undefined }));
    try { await b?.stopHost(); } finally { try { await a.stop(); } finally { callback.stop(true); } }
}
