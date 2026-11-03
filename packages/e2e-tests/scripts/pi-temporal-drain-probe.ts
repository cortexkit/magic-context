import { openTestDb } from "../src/test-db";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MockProvider } from "../src/mock-provider/server";
import { PI_CLI, PI_PACKAGE_JSON } from "../src/pi-runner/spawn";
import { sessionMetaFieldSelect } from "../src/session-meta-fields";

const handoff = process.argv.includes("--handoff");

const base = join(tmpdir(), "magic-context/pi-temporal-drain");
mkdirSync(base, { recursive: true });
const root = realpathSync(mkdtempSync(join(base, "host-")));
const env: Record<string, string> = { PATH: process.env.PATH!, HOME: root, TMPDIR: root, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", MC_TEMPORAL_ROOT: root };
env.MC_TEMPORAL_REPO = resolve(import.meta.dir, "../../..");
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "MAGIC_CONTEXT_STORAGE_DIR", "PI_CODING_AGENT_DIR"]) {
    env[key] = join(root, key === "MAGIC_CONTEXT_STORAGE_DIR" ? "storage" : key);
    mkdirSync(env[key], { recursive: true });
}
env.OPENCODE_DB = join(root, "opencode.db");
const sessionFile = join(root, "session.jsonl");
// This is a new journal, never a copy of any live host store.
const sessionId = crypto.randomUUID();
const entries: unknown[] = [{ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: root }];
let parentId: string | null = null;
for (let ordinal = 1; ordinal <= 320; ordinal++) {
    const timestamp = Date.UTC(2026, 0, 1) + ordinal * 600_000;
    const id = `seed${ordinal.toString().padStart(4, "0")}`;
    let message: Record<string, unknown>;
    if (ordinal >= 256 && ordinal <= 277) {
        const callId = `call-${Math.floor((ordinal - 256) / 2) + 1}`;
        message = ordinal % 2 === 0
            ? { role: "assistant", content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "/tmp/fixture" } }] }
            : { role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text: "covered tool payload " + "x".repeat(900) }], isError: false };
    } else if (ordinal === 308 || ordinal % 2 === 1) {
        message = { role: "user", content: [{ type: "text", text: (ordinal === 308 ? "FIRST_KEPT_USER " : "user history ") + ordinal + "u".repeat(420) }] };
    } else {
        message = { role: "assistant", content: [{ type: "text", text: "assistant history " + ordinal + "a".repeat(420) }] };
    }
    if (message.role === "assistant") Object.assign(message, { api: "openai-responses", provider: "mock", model: "mock-model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" });
    message.timestamp = timestamp;
    entries.push({ type: "message", id, parentId, timestamp: new Date(timestamp).toISOString(), message });
    parentId = id;
}
writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
const mock = new MockProvider();
const { baseURL } = await mock.start();
mock.enqueue({ text: "baseline answer", usage: { input_tokens: handoff ? 10_000 : 70_000, output_tokens: 10 } });
mock.enqueue({ text: "drain answer", usage: { input_tokens: 10_000, output_tokens: 10 } });
mock.setDefault({ text: "deferred answer", usage: { input_tokens: 10_000, output_tokens: 10 } });
writeFileSync(join(env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { mock: { api: "openai-responses", baseUrl: baseURL, apiKey: "mock-key", models: [{ id: "mock-model", name: "Mock", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
writeFileSync(join(env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
const extension = resolve(import.meta.dir, "../../pi-plugin/scripts/temporal-drain-extension.ts");
let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
const events: unknown[] = [];
let stderr = "";
try {
    const spawn = (legacy: boolean) => Bun.spawn([process.execPath, PI_CLI, "--mode", "rpc", "--provider", "mock", "--model", "mock-model", "--session", sessionFile, "-e", extension], { cwd: root, env: { ...env, MC_TEMPORAL_LEGACY: legacy ? "1" : "0", MC_TEMPORAL_START_PASS: handoff && !legacy ? "2" : "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child = spawn(handoff);
    let stderrTask = new Response(child.stderr).text().then((text) => { stderr += text; });
    let iterator = child.stdout.getReader();
    let pending = "";
    async function turn(message: string) {
        child!.stdin.write(JSON.stringify({ type: "prompt", message }) + "\n");
        while (true) {
            const newline = pending.indexOf("\n");
            if (newline >= 0) {
                const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
                let event: { type?: string; success?: boolean; error?: string };
                try { event = JSON.parse(line); } catch { continue; }
                events.push(event);
                if (event.type === "response" && event.success === false) throw new Error(event.error);
                if (event.type === "agent_end") return;
            } else {
                const next = await iterator.read();
                if (next.done) throw new Error("Pi exited before agent_end");
                pending += Buffer.from(next.value).toString();
            }
        }
    }
    await turn("baseline turn");
    const isolatedDatabases: string[] = [];
    const isolation = (name: string) => {
        const lsof = Bun.spawnSync(["lsof", "-p", String(child!.pid)]).stdout.toString();
        writeFileSync(join(root, name + "-lsof.txt"), lsof);
        const databases = lsof.split("\n").filter((line) => /\.db(?:\s|$|-)/.test(line));
        if (!databases.length || databases.some((line) => !line.includes(root + "/"))) throw new Error("Database isolation failed: " + databases.join("\n"));
        isolatedDatabases.push(...databases);
    };
    isolation(handoff ? "old" : "host");
    let oldPrefix: unknown;
    if (handoff) {
        child.kill(); await child.exited; await stderrTask;
        const db = openTestDb(join(root, "storage/context.db"), { readonly: true });
        if (db.query("SELECT name FROM sqlite_master WHERE name='temporal_decisions'").get()) throw new Error("Old host unexpectedly installed temporal decisions");
        if ((db.query("SELECT MAX(version) AS v FROM schema_migrations WHERE version<10000").get() as { v: number }).v !== 94) throw new Error("Old host did not create the pre-v95 schema");
        oldPrefix = db.query(`SELECT ${sessionMetaFieldSelect("cached_m0_bytes", "cached_m0_bytes", db)},${sessionMetaFieldSelect("cached_m1_bytes", "cached_m1_bytes", db)} FROM session_meta WHERE session_id=?`).get(sessionId);
        db.close();
        child = spawn(false);
        stderrTask = new Response(child.stderr).text().then((text) => { stderr += text; });
        iterator = child.stdout.getReader(); pending = "";
        await turn("deferred handoff turn");
        isolation("new");
    } else {
        await turn("drain turn");
        await turn("deferred turn");
    }
    const requests = mock.requests();
    writeFileSync(join(root, "requests.json"), JSON.stringify(requests, null, 2));
    if (requests.length !== (handoff ? 2 : 3)) throw new Error(`Unexpected provider request count ${requests.length}`);
    // Responses transport has no moving Anthropic cache_control breakpoint;
    // compare the actual input objects, without normalizing any content bytes.
    const drain = (requests[handoff ? 0 : 1].body as { input: unknown[] }).input;
    const replay = (requests[handoff ? 1 : 2].body as { input: unknown[] }).input.slice(0, drain.length);
    const text = JSON.stringify(drain);
    if (!text.includes("FIRST_KEPT_USER") || !text.includes("<!-- +10m -->")) throw new Error("The retained user's marker was not exercised");
    const raw = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (!handoff && !raw.some((entry) => entry.type === "compaction" && entry.fromHook && entry.firstKeptEntryId === "seed0308")) throw new Error("No physical marker drain occurred");
    if (JSON.stringify(drain) !== JSON.stringify(replay)) throw new Error(handoff ? "Old/new handoff wire prefix changed" : "Drain/defer wire prefix changed");
    if (handoff) {
        const db = openTestDb(join(root, "storage/context.db"), { readonly: true });
        const after = db.query(`SELECT ${sessionMetaFieldSelect("cached_m0_bytes", "cached_m0_bytes", db)},${sessionMetaFieldSelect("cached_m1_bytes", "cached_m1_bytes", db)} FROM session_meta WHERE session_id=?`).get(sessionId);
        if ((db.query("SELECT MAX(version) AS v FROM schema_migrations WHERE version<10000").get() as { v: number }).v !== 95) throw new Error("New host did not migrate the schema to v95");
        db.close();
        if (JSON.stringify(after) !== JSON.stringify(oldPrefix)) throw new Error("Handoff rebuilt the frozen history prefix");
    }
    const sha = createHash("sha256").update(JSON.stringify(drain)).digest("hex");
    console.log(JSON.stringify({ root, handoff, host: JSON.parse(readFileSync(PI_PACKAGE_JSON, "utf8")).version, requests: requests.length, comparedMessages: drain.length, comparedBytes: Buffer.byteLength(JSON.stringify(drain)), sha256: sha, isolatedDatabases }, null, 2));
    child.kill(); await child.exited; await stderrTask;
} finally {
    child?.kill();
    writeFileSync(join(root, "events.json"), JSON.stringify(events, null, 2));
    writeFileSync(join(root, "stderr.txt"), stderr);
    await mock.stop();
}
