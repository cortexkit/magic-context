/** Isolated OpenCode 1.18.30 arrival-window probe.
 * Run after building: bun packages/e2e-tests/src/repro/incomplete-user-real-host.ts --out /tmp/magic-context/arrival-<unique>
 * SQLite triggers measure actual writes, not event delivery. The instrumented
 * plugin records Magic Context's synchronous event prefix and an async elapsed
 * upper bound. SQLite timings exclude preparation and instrumentation overhead.
 */
import { Database } from "bun:sqlite";
import { openTestDb } from "../test-db";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareContextDatabase } from "../prepare-context-db";

const arg = (key: string, fallback?: string) => {
    const i = process.argv.indexOf(`--${key}`);
    const value = i < 0 ? fallback : process.argv[i + 1];
    if (!value) throw new Error(`Missing --${key}`);
    return value;
};
const out = resolve(arg("out"));
if (existsSync(out) || !out.includes("/magic-context/"))
    throw new Error("Use a new throwaway /magic-context/ root");
const binary = arg("opencode", `${process.env.HOME}/.opencode/bin/opencode`);
const entry = resolve(arg("plugin", join(import.meta.dir, "../../../plugin/dist/index.js")));
const repeats = Number(arg("repeats", "10"));
const version = Bun.spawnSync([binary, "--version"]).stdout.toString().trim();
if (version !== "1.18.30") throw new Error(`Expected 1.18.30, got ${version}`);
const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";

async function run(mode: "none" | "mc") {
    const root = join(out, mode);
    const dirs = Object.fromEntries(
        ["home", "config", "data", "cache", "state", "runtime", "work", "tmp"].map((k) => [
            k,
            join(root, k),
        ]),
    ) as Record<string, string>;
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
    const traces = join(root, "trace.jsonl");
    const wrapper = join(root, "probe.mjs");
    writeFileSync(
        wrapper,
        `import plugin from ${JSON.stringify(`file://${entry}`)};
import { appendFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
const pending = [];
const prepare = Database.prototype.prepare;
const wrapped = new WeakSet();
Database.prototype.prepare = function(sql,...args) {
 const statement = prepare.call(this,sql,...args);
 const table = ['session_meta','tags','last_known_good','projects','project_roots','schema_migrations_meta','session_projects'].find(t=>new RegExp('\\\\b'+t+'\\\\b','i').test(sql));
 if (table && !wrapped.has(statement)) {
  wrapped.add(statement);
  for (const method of ['run','get','all']) {
   const original = statement[method];
   statement[method] = function(...params) {
    const start = performance.now(); const wall = Date.now();
    try { return original.apply(this,params); }
    finally { pending.push({kind:'sqlite',table,method,wall,ms:performance.now()-start}); }
   };
  }
 }
 return statement;
};
export default async (ctx) => {
 const hooks = await plugin.server(ctx);
 const event = hooks.event;
 const transform = hooks['experimental.chat.messages.transform'];
 let replaySnapshot;
 hooks.event = (input) => {
   const start = performance.now();
   const result = event?.(input);
   const row = {kind:'event', start, end:performance.now(), wall:Date.now(), type:input.event.type, id:input.event.properties?.info?.id};
   pending.push(row);
   return Promise.resolve(result).finally(() => { row.totalMs = performance.now()-start; });
 };
 hooks['experimental.chat.messages.transform'] = async (input, output) => {
   if (output.messages.at(-1)?.parts.some(p=>p.type==='text' && p.text==='CONTROL_PURE_REPLAY')) {
     replaySnapshot ??= structuredClone(output.messages);
     output.messages.splice(0,output.messages.length,...structuredClone(replaySnapshot));
   }
   const tail = output.messages.slice(-3).map(m => ({id:m.info.id,role:m.info.role,parts:m.parts.map(p=>p.type)}));
   pending.push({kind:'transform', wall:Date.now(), tail});
   try { return await transform(input,output); }
   catch(e) { pending.push({kind:'refusal',wall:Date.now(),name:e.name,message:e.message}); throw e; }
   finally { appendFileSync(${JSON.stringify(traces)},pending.splice(0).map(x=>JSON.stringify(x)).join('\\n')+'\\n'); }
 };
 return hooks;
};`,
    );
    const captures: Array<{ wall: number; raw: string }> = [];
    let schedule: (() => void) | undefined;
    const mock = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
            const raw = await req.text();
            captures.push({ wall: Date.now(), raw });
            const events = [
                [
                    "message_start",
                    {
                        type: "message_start",
                        message: {
                            id: "msg_mock",
                            type: "message",
                            role: "assistant",
                            model: "mock-sonnet",
                            content: [],
                            stop_reason: null,
                            stop_sequence: null,
                            usage: { input_tokens: 100, output_tokens: 0 },
                        },
                    },
                ],
                [
                    "content_block_start",
                    {
                        type: "content_block_start",
                        index: 0,
                        content_block: { type: "text", text: "" },
                    },
                ],
                [
                    "content_block_delta",
                    {
                        type: "content_block_delta",
                        index: 0,
                        delta: { type: "text_delta", text: "MOCK_ANSWER" },
                    },
                ],
                ["content_block_stop", { type: "content_block_stop", index: 0 }],
                [
                    "message_delta",
                    {
                        type: "message_delta",
                        delta: { stop_reason: "end_turn", stop_sequence: null },
                        usage: { output_tokens: 4 },
                    },
                ],
                ["message_stop", { type: "message_stop" }],
            ];
            const stream = new ReadableStream({
                async start(c) {
                    await Bun.sleep(25);
                    for (const [event, data] of events)
                        c.enqueue(
                            new TextEncoder().encode(
                                `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                            ),
                        );
                    c.close();
                    const send = schedule;
                    schedule = undefined;
                    send?.();
                },
            });
            return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        },
    });
    writeFileSync(
        join(dirs.config!, "opencode.json"),
        JSON.stringify({
            plugin: mode === "mc" ? [`file://${wrapper}`] : [],
            provider: {
                "mock-anthropic": {
                    npm: "@ai-sdk/anthropic",
                    options: { apiKey: "mock", baseURL: `http://127.0.0.1:${mock.port}` },
                    models: {
                        "mock-sonnet": {
                            name: "mock-sonnet",
                            tool_call: true,
                            limit: { context: 200000, output: 2048 },
                        },
                    },
                },
            },
            enabled_providers: ["mock-anthropic"],
            model: "mock-anthropic/mock-sonnet",
            small_model: "mock-anthropic/mock-sonnet",
            autoupdate: false,
            share: "disabled",
            compaction: { auto: false, prune: false },
        }),
    );
    mkdirSync(join(dirs.config!, "cortexkit"), { recursive: true });
    writeFileSync(
        join(dirs.config!, "cortexkit", "magic-context.jsonc"),
        JSON.stringify({
            dreamer: { disable: true },
            historian: { opencode: { model: "mock-anthropic/mock-sonnet" } },
        }),
    );
    if (mode === "mc") prepareContextDatabase(dirs.data!);
    const dbPath = join(dirs.data!, "opencode", "arrival.db");
    const env: Record<string, string> = {
        PATH: process.env.PATH!,
        HOME: dirs.home!,
        XDG_CONFIG_HOME: dirs.config!,
        XDG_DATA_HOME: dirs.data!,
        XDG_CACHE_HOME: dirs.cache!,
        XDG_STATE_HOME: dirs.state!,
        XDG_RUNTIME_DIR: dirs.runtime!,
        OPENCODE_CONFIG_DIR: dirs.config!,
        OPENCODE_DB: dbPath,
        MAGIC_CONTEXT_STORAGE_DIR: join(dirs.data!, "cortexkit/magic-context"),
        MAGIC_CONTEXT_LOG_PATH: join(root, "mc.log"),
        TMPDIR: dirs.tmp!,
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
    };
    const port = 20000 + Math.floor(Math.random() * 30000);
    const child = spawn(
        binary,
        ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"],
        { cwd: dirs.work, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let logs = "";
    child.stdout?.on("data", (x) => (logs += x));
    child.stderr?.on("data", (x) => {
        logs += x;
        writeFileSync(join(root, "host.log"), logs);
    });
    const url = `http://127.0.0.1:${port}`;
    const api = async (path: string, body?: unknown) => {
        const response = await fetch(`${url}${path}?directory=${encodeURIComponent(dirs.work!)}`, {
            method: body ? "POST" : "GET",
            headers: { "content-type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(30000),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    };
    const samples: unknown[] = [];
    try {
        let ready = false;
        for (let n = 0; n < 120 && !ready; n++) {
            try {
                ready = (await api("/session")).status === 200;
            } catch {}
            if (!ready) await Bun.sleep(500);
        }
        if (!ready) throw new Error("Host not ready");
        const db = new Database(dbPath);
        db.exec(`PRAGMA busy_timeout=10000;
CREATE TABLE arrival_probe(kind TEXT, id TEXT, owner TEXT, ms REAL);
CREATE TRIGGER arrival_message AFTER INSERT ON message BEGIN INSERT INTO arrival_probe VALUES ('message',NEW.id,NEW.id,(julianday('now')-2440587.5)*86400000); END;
CREATE TRIGGER arrival_part AFTER INSERT ON part BEGIN INSERT INTO arrival_probe VALUES ('part',NEW.id,NEW.message_id,(julianday('now')-2440587.5)*86400000); END;`);
        db.close();
        const proof = Bun.spawnSync(["lsof", "-p", String(child.pid)]).stdout.toString();
        writeFileSync(join(root, "lsof.txt"), proof);
        const files = proof.split("\n").filter((l) => /REG/.test(l) && /\.db(?:-|\s|$)/.test(l));
        if (!files.length || files.some((l) => !l.includes(root)))
            throw new Error("Host opened a database outside its throwaway root");
        for (const delay of [0, 1, 2, 5, 10, 20, 50]) {
            for (let repeat = 0; repeat < repeats; repeat++) {
                const session = (await api("/session", { title: `arrival-${delay}-${repeat}` }))
                    .body;
                const prompt = (text: string) =>
                    api(`/session/${session.id}/message`, {
                        model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
                        parts: [
                            { type: "text", text },
                            { type: "file", mime: "image/png", url: png },
                        ],
                    });
                let second: Promise<unknown> | undefined;
                let release!: () => void;
                const sent = new Promise<void>((r) => (release = r));
                schedule = () => {
                    setTimeout(() => {
                        second = prompt("NEW_QUESTION");
                        release();
                    }, delay);
                };
                const first = await prompt("OLD_QUESTION");
                await Promise.race([
                    sent,
                    Bun.sleep(10000).then(() => {
                        throw new Error(`Mock did not finish: ${JSON.stringify(first)}`);
                    }),
                ]);
                const next = await second;
                await Bun.sleep(50);
                samples.push({ delay, repeat, session: session.id, first, next });
            }
        }
        if (mode === "mc") {
            // A deliberately split arrival is a deterministic control, separate
            // from the unmodified timing sweep above: the persisted user row has
            // no parts yet, exactly the input the racing loop can observe.
            const session = (await api("/session", { title: "split-arrival-control" })).body;
            await api(`/session/${session.id}/message`, {
                model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
                parts: [{ type: "text", text: "CONTROL_OLD_QUESTION" }],
            });
            const before = captures.length;
            const response = await api(`/session/${session.id}/message`, {
                model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
                parts: [],
            });
            const history = await api(`/session/${session.id}/message`);
            const visible = JSON.stringify(history.body).includes(
                "Your message hadn't finished arriving. Send it again.",
            );
            if (captures.length !== before || !visible)
                throw new Error(
                    `Split-arrival refusal failed: ${JSON.stringify({ response, visible, sent: captures.length - before })}`,
                );
            samples.push({
                control: "split-arrival",
                response,
                visible,
                providerRequests: captures.length - before,
            });
            const replaySession = (await api("/session", { title: "pure-replay-control" })).body;
            const replayStart = captures.length;
            for (let i = 0; i < 3; i++)
                await api(`/session/${replaySession.id}/message`, {
                    model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
                    parts: [{ type: "text", text: "CONTROL_PURE_REPLAY" }],
                });
            const passes = captures.slice(replayStart);
            if (passes.length !== 3 || passes[1]!.raw !== passes[2]!.raw)
                throw new Error("Normal defer passes were not byte-identical pure replay");
            samples.push({
                control: "pure-replay",
                byteIdentical: true,
                bytes: passes[1]!.raw.length,
                sha256: new Bun.CryptoHasher("sha256").update(passes[1]!.raw).digest("hex"),
            });
        }
        const reader = openTestDb(dbPath, { readonly: true });
        const gaps = reader
            .query(
                `SELECT m.id,m.ms AS start_ms,MIN(p.ms)-m.ms AS gap_ms FROM arrival_probe m JOIN message h ON h.id=m.id JOIN arrival_probe p ON p.owner=m.id AND p.kind='part' WHERE m.kind='message' AND json_extract(h.data,'$.role')='user' GROUP BY m.id ORDER BY m.ms`,
            )
            .all();
        reader.close();
        const trace = existsSync(traces)
            ? readFileSync(traces, "utf8")
                  .trim()
                  .split("\n")
                  .map((l) => JSON.parse(l))
            : [];
        if (mode === "mc" && !trace.some((x) => x.kind === "transform"))
            throw new Error("MC transform was not reached; invalid comparison");
        const emptyTails = trace.filter(
            (x) =>
                x.kind === "transform" &&
                x.tail.at(-1)?.role === "user" &&
                x.tail.at(-1)?.parts.length === 0,
        );
        const summary = {
            mode,
            version,
            gaps,
            emptyTails,
            refusals: trace.filter((x) => x.kind === "refusal"),
            sqlite: trace.filter((x) => x.kind === "sqlite"),
            eventSyncMs: trace
                .filter((x) => x.kind === "event")
                .map((x) => ({ ...x, ms: x.end - x.start })),
        };
        writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2));
        return summary;
    } finally {
        schedule = undefined;
        child.kill("SIGTERM");
        const exited = new Promise<void>((r) =>
            child.exitCode !== null || child.signalCode !== null
                ? r()
                : child.once("exit", () => r()),
        );
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(killTimer);
        mock.stop(true);
        writeFileSync(join(root, "host.log"), logs);
        writeFileSync(join(root, "samples.json"), JSON.stringify(samples, null, 2));
        writeFileSync(join(root, "wire.json"), JSON.stringify(captures, null, 2));
    }
}
const summaries = [];
for (const mode of ["none", "mc"] as const) summaries.push(await run(mode));
writeFileSync(join(out, "summary.json"), JSON.stringify(summaries, null, 2));
console.log(
    JSON.stringify({
        out,
        modes: summaries.map((s) => ({
            mode: s.mode,
            gaps: s.gaps.length,
            emptyTails: s.emptyTails.length,
            refusals: s.refusals.length,
        })),
    }),
);
