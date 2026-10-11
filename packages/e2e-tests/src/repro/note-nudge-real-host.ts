/** OpenCode 1.18.x wire proof for note-nudge first-serve/cache-bust fencing.
 * Build the plugin, then run with --opencode <binary> --out <new throwaway root>.
 * A fixture freezes the raw host window, not the transformed/provider output,
 * so repeated requests exercise the production transform and SDK serializer.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MockProvider } from "../mock-provider/server";
import { prepareContextDatabase } from "../prepare-context-db";

const arg = (name: string) => {
    const i = Bun.argv.indexOf(`--${name}`);
    if (i < 0 || !Bun.argv[i + 1]) throw new Error(`Missing --${name}`);
    return Bun.argv[i + 1]!;
};
const root = resolve(arg("out"));
if (existsSync(root) || !root.includes("/magic-context/")) throw new Error("Use a new throwaway /magic-context/ root");
const binary = resolve(arg("opencode"));
const dirs = Object.fromEntries(["home", "config", "data", "cache", "state", "runtime", "work", "tmp"].map((name) => [name, join(root, name)])) as Record<string, string>;
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const env = {
    PATH: process.env.PATH!, HOME: dirs.home!, CFFIXED_USER_HOME: dirs.home!,
    XDG_CONFIG_HOME: dirs.config!, XDG_DATA_HOME: dirs.data!, XDG_CACHE_HOME: dirs.cache!,
    XDG_STATE_HOME: dirs.state!, XDG_RUNTIME_DIR: dirs.runtime!, TMPDIR: dirs.tmp!,
    OPENCODE_CONFIG_DIR: dirs.config!, OPENCODE_DB: join(dirs.data!, "opencode", "nudge.db"),
    MAGIC_CONTEXT_STORAGE_DIR: join(dirs.data!, "cortexkit", "magic-context"),
    MAGIC_CONTEXT_LOG_PATH: join(root, "mc.log"),
    OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
};
const version = Bun.spawnSync([binary, "--version"], { env }).stdout.toString().trim();
if (!/^1\./.test(version)) throw new Error(`Expected OpenCode 1.x, got ${version}`);
const mock = new MockProvider();
const { baseURL } = await mock.start();
mock.setDefault({ text: "MOCK_ANSWER", usage: { input_tokens: 1000, output_tokens: 10 } });
const controlPath = join(root, "control.json");
const snapshotPath = join(root, "raw-window.json");
const fixture = join(root, "fixture.mjs");
const source = resolve(import.meta.dir, "../../../plugin/src");
const entry = resolve(import.meta.dir, "../../../plugin/dist/index.js");
writeFileSync(fixture, `
import plugin from ${JSON.stringify(`file://${entry}`)};
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { openDatabase } from ${JSON.stringify(`file://${source}/features/magic-context/storage-db.ts`)};
import { addNote } from ${JSON.stringify(`file://${source}/features/magic-context/storage-notes.ts`)};
import { onNoteTrigger } from ${JSON.stringify(`file://${source}/hooks/magic-context/note-nudger.ts`)};
import { setPersistedNoteNudgeTriggerMessageId } from ${JSON.stringify(`file://${source}/features/magic-context/storage-meta-persisted.ts`)};
export default async ctx => {
  const hooks = await plugin.server(ctx);
  const transform = hooks['experimental.chat.messages.transform'];
  hooks['experimental.chat.messages.transform'] = async (input, output) => {
    const control = existsSync(${JSON.stringify(controlPath)}) ? JSON.parse(readFileSync(${JSON.stringify(controlPath)}, 'utf8')) : {};
    if (control.snapshot) writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify(output.messages));
    if (control.freeze) output.messages.splice(0, output.messages.length, ...JSON.parse(readFileSync(${JSON.stringify(snapshotPath)}, 'utf8')));
    if (control.arm) {
      const db = openDatabase(process.env.MAGIC_CONTEXT_STORAGE_DIR + '/context.db');
      const sid = output.messages.at(-1).info.sessionID;
      addNote(db, 'session', { sessionId: sid, content: 'Deferred fixture work' });
      onNoteTrigger(db, sid, 'historian_complete');
      setPersistedNoteNudgeTriggerMessageId(db, sid, output.messages.find(m => m.info.role === 'user').info.id);
      if (control.bust) db.prepare("UPDATE session_meta SET cached_m0_system_hash = 'fixture-old-system' WHERE session_id = ?").run(sid);
    }
    return transform(input, output);
  };
  return hooks;
};
`);
writeFileSync(join(dirs.config!, "opencode.json"), JSON.stringify({
    plugin: [`file://${fixture}`],
    provider: { "mock-anthropic": { npm: "@ai-sdk/anthropic", options: { apiKey: "mock", baseURL }, models: { "mock-sonnet": { name: "mock-sonnet", tool_call: true, limit: { context: 200000, output: 2048 } } } } },
    enabled_providers: ["mock-anthropic"], model: "mock-anthropic/mock-sonnet", small_model: "mock-anthropic/mock-sonnet",
    autoupdate: false, share: "disabled", compaction: { auto: false, prune: false },
}));
mkdirSync(join(dirs.config!, "cortexkit"), { recursive: true });
writeFileSync(join(dirs.config!, "cortexkit", "magic-context.jsonc"), JSON.stringify({
    transform_mode: "ts", execute_threshold_percentage: 90,
    dreamer: { disable: true }, historian: { disable: true },
    memory: { auto_search: { enabled: false } }, compressor: { enabled: false },
}));
Object.assign(process.env, env);
prepareContextDatabase(dirs.data!);
const port = 20000 + Math.floor(Math.random() * 30000);
const url = `http://127.0.0.1:${port}`;
let child: ChildProcess;
const control = (value: Record<string, boolean>) => writeFileSync(controlPath, JSON.stringify(value));
const api = async (path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}?directory=${encodeURIComponent(dirs.work!)}`, {
        method: body ? "POST" : "GET", headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
    return response.json();
};
const isolation: unknown[] = [];
const boot = async () => {
    child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], { cwd: dirs.work, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (x) => writeFileSync(join(root, `host-${child.pid}.log`), x, { flag: "a" }));
    child.stderr?.on("data", (x) => writeFileSync(join(root, `host-${child.pid}.log`), x, { flag: "a" }));
    const deadline = Date.now() + 60000;
    while (true) {
        try { await api("/session"); break; } catch (error) {
            if (child.exitCode !== null || Date.now() >= deadline) throw error;
            await Bun.sleep(100);
        }
    }
};
const inventory = () => {
    const result = Bun.spawnSync(["lsof", "-nP", "-p", String(child.pid)]);
    if (result.exitCode !== 0) throw new Error("lsof inventory failed");
    const text = result.stdout.toString();
    writeFileSync(join(root, `lsof-${child.pid}.txt`), text);
    const dbs = text.split("\n").filter((line) => /REG/.test(line) && /\.db(?:-|\s|$)/.test(line));
    if (!dbs.some((line) => line.includes(env.OPENCODE_DB)) || dbs.some((line) => !line.includes(root))) throw new Error(`Host database isolation failed: ${dbs}`);
    isolation.push({ pid: child.pid, databases: dbs });
};
const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
};
const send = async (sid: string, text: string) => {
    const count = mock.requests().length;
    const response = await api(`/session/${sid}/message`, { model: { providerID: "mock-anthropic", modelID: "mock-sonnet" }, parts: [{ type: "text", text }] });
    if (response.info?.error) throw new Error(JSON.stringify(response.info.error));
    const captures = mock.requests().slice(count);
    if (captures.length !== 1 || !captures[0]?.rawBody) throw new Error(`Expected one wire body, got ${captures.length}`);
    writeFileSync(join(root, `request-${mock.requests().length}.json`), captures[0].rawBody);
    return captures[0].body.messages as unknown[];
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Anthropic's SDK moves ephemeral breakpoints when a real assistant/user tail
// grows. That provider metadata is not prompt content. Only this fresh-tail
// comparison omits it; frozen-window requests above must match in full.
const payload = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(payload);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cache_control").map(([key, item]) => [key, payload(item)]));
    return value;
};
const checks: unknown[] = [];
try {
    await boot();
    for (const bust of [true, false]) {
        control({});
        const session = await api("/session", { title: bust ? "rebuild-note" : "late-note" });
        await send(session.id, "old real user prompt");
        control({ snapshot: true, arm: bust, bust });
        const first = await send(session.id, '<system-reminder><channel-notice room="fleet">Hold launches.</channel-notice></system-reminder>');
        inventory();
        const hasNudge = JSON.stringify(first).includes("deferred_notes");
        if (hasNudge !== bust) throw new Error(`Rebuild delivery mismatch: bust=${bust}, nudge=${hasNudge}`);
        control({ freeze: true, arm: !bust });
        const second = await send(session.id, "ignored by frozen-window fixture");
        control({ freeze: true });
        const third = await send(session.id, "ignored by frozen-window fixture");
        if (hash(first) !== hash(second) || hash(first) !== hash(third)) throw new Error("Defer rewrote previously served messages");
        if (!bust) {
            await stop(); await boot();
            const restarted = await send(session.id, "ignored by frozen-window fixture after restart");
            inventory();
            if (hash(restarted) !== hash(first)) throw new Error("Restart appended to a previously served user");
            control({});
            const fresh = await send(session.id, "next genuinely new user");
            if (!JSON.stringify(fresh.at(-1)).includes("deferred_notes")) throw new Error("New user did not receive pending nudge");
            // OpenCode's real history grew while the fixture was frozen. Compare
            // each earlier captured segment, not the new API-message tail.
            if (hash(payload(fresh.slice(0, first.length))) !== hash(payload(first))) throw new Error("Fresh delivery rewrote earlier prompt payloads");
        }
        checks.push({ scenario: bust ? "rebuild-then-defer" : "late-trigger-and-restart", wireMessagesSha256: hash(first), consecutiveIdentical: 3 });
    }
    const log = readFileSync(env.MAGIC_CONTEXT_LOG_PATH, "utf8");
    if (!log.includes("reason=system_hash executed=true") || !log.includes("decision=defer")) throw new Error("Required HARD/defer paths were not reached");
    const result = { version, checks, isolation };
    writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
    console.log(`NOTE_NUDGE_HOST_RESULT=${JSON.stringify(result)}`);
} finally {
    await stop(); await mock.stop();
}
