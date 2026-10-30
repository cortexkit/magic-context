import { openTestDb } from "../test-db";
/** Real-host wire proof for Magic Context's old-reasoning removal (age lane and drop lane).
 *
 * Usage:
 *   bun packages/e2e-tests/src/repro/reasoning-removal-real-host.ts \
 *     --opencode /absolute/opencode-1.18.30 --out "$TMPDIR/magic-context/reasoning-removal/<run>"
 *
 * One isolated OpenCode 1.18.30 `serve` per scenario, with the locally built Magic Context
 * plugin and a fixture plugin listed before it. The fixture prepends a long single-turn tool
 * loop (assistant steps with provider-signed or encrypted reasoning plus completed tool calls)
 * to every request, so Magic Context sees the same host history on every pass. Every model
 * endpoint is a loopback recorder that rejects the request after the host serialized it:
 * captures prove wire shape and replay stability, not provider acceptance.
 *
 * Scenarios:
 *   age    clear_reasoning_age=10: the session's first (rebuilding) pass must remove old
 *          reasoning; the next defer passes must serve byte-identical history.
 *   drop   clear_reasoning_age=100000 (age lane idle): a queued ctx_reduce-style drop applies
 *          on a /ctx-flush pass; the reasoning it invalidated must leave the wire, without any
 *          "[cleared]" text, and the next defer pass must replay identically.
 *   worker OpenAI only, 300 steps with ~3 KB encrypted reasoning each: the request must shrink
 *          on the first pass and keep the newest tool result. worker-control is the same
 *          session with the age lane idle, for the size comparison.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareContextDatabase } from "../prepare-context-db";

const arg = (key: string) => {
    const i = process.argv.indexOf(`--${key}`);
    if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing --${key}`);
    return process.argv[i + 1] as string;
};
const out = resolve(arg("out"));
if (existsSync(out)) throw new Error("Use a new output root");
if (!out.includes("/magic-context/")) throw new Error("Output root must be under $TMPDIR/magic-context/");
const binary = resolve(arg("opencode"));
const only = process.argv.includes("--only") ? arg("only").split(",") : null;
const repoRoot = resolve(import.meta.dir, "../../../..");
const pluginEntry = join(repoRoot, "packages/plugin/dist/index.js");

interface Route {
    id: string;
    npm: string;
    model: string;
    meta: (step: number) => Record<string, unknown>;
}
const enc = (step: number, size: number) => `ENC_${step}_${"x".repeat(size)}`;
const routes: Route[] = [
    {
        id: "anthropic",
        npm: "@ai-sdk/anthropic",
        model: "claude-sonnet-5",
        meta: (s) => ({ anthropic: { signature: `SIG_${s}` } }),
    },
    {
        id: "vertex-eu-anthropic",
        npm: "@ai-sdk/google-vertex/anthropic",
        model: "claude-sonnet-5",
        meta: (s) => ({ anthropic: { signature: `SIG_${s}` } }),
    },
    {
        id: "openai",
        npm: "@ai-sdk/openai",
        model: "gpt-5",
        meta: (s) => ({ openai: { itemId: `rs_${s}`, reasoningEncryptedContent: enc(s, 256) } }),
    },
    {
        id: "google",
        npm: "@ai-sdk/google",
        model: "gemini-2.5-pro",
        meta: (s) => ({ google: { thoughtSignature: `TSIG_${s}` } }),
    },
];

const captures: Array<{ path: string; body: Record<string, unknown> }> = [];
const mock = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
        const text = await req.text();
        try {
            captures.push({ path: new URL(req.url).pathname, body: JSON.parse(text) });
        } catch {
            captures.push({ path: new URL(req.url).pathname, body: { raw: text } });
        }
        return Response.json(
            { type: "error", error: { type: "invalid_request_error", message: "recorder" } },
            { status: 400 },
        );
    },
});
const baseURL = `http://127.0.0.1:${mock.port}`;

function fixturePlugin(path: string, steps: number, encSize: number) {
    writeFileSync(
        path,
        `const STEPS = ${steps};
const ENC_SIZE = ${encSize};
const meta = (providerID, s) =>
  providerID === 'openai' ? { openai: { itemId: 'rs_' + s, reasoningEncryptedContent: 'ENC_' + s + '_' + 'x'.repeat(ENC_SIZE) } } :
  providerID === 'google' ? { google: { thoughtSignature: 'TSIG_' + s } } :
  { anthropic: { signature: 'SIG_' + s } };
export const Fixture = async () => ({
  config: async (config) => {
    const v = config.provider?.['vertex-eu-anthropic'];
    if (v) v.options.generateAuthToken = async () => 'mock-only';
  },
  'experimental.chat.messages.transform': async (_, output) => {
    const first = output.messages[0];
    const providerID = output.messages.findLast((m) => m.info.role === 'user')?.info.model?.providerID ?? 'anthropic';
    const modelID = output.messages.findLast((m) => m.info.role === 'user')?.info.model?.modelID ?? '';
    const sessionID = first?.info.sessionID;
    const injected = [{ info: { id: 'msg_fx_user', sessionID, role: 'user', time: { created: 1 }, agent: 'build', model: { providerID, modelID } },
      parts: [{ id: 'prt_fx_user', sessionID, messageID: 'msg_fx_user', type: 'text', text: 'FIXTURE_TASK do the work' }] }];
    for (let s = 0; s < STEPS; s++) {
      const id = 'msg_fx_a' + String(s).padStart(4, '0');
      const p = (n) => ({ id: 'prt_fx_' + s + '_' + n, sessionID, messageID: id });
      injected.push({
        info: { id, sessionID, role: 'assistant', parentID: 'msg_fx_user', providerID, modelID, mode: 'build', agent: 'build',
          path: { cwd: '/', root: '/' }, time: { created: 10 + s, completed: 11 + s }, finish: 'tool-calls',
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
        parts: [
          { ...p('a'), type: 'step-start' },
          { ...p('b'), type: 'reasoning', text: 'REASONING_' + s + ' ' + 'r'.repeat(200), metadata: meta(providerID, s), time: { start: 1, end: 2 } },
          { ...p('c'), type: 'tool', callID: 'call_fx_' + s, tool: 'bash',
            state: { status: 'completed', input: { command: 'echo ' + s }, output: 'TOOL_OUT_' + s + ' ' + 'o'.repeat(1200),
              title: 'echo', metadata: {}, time: { start: 1, end: 2 } } },
          { ...p('d'), type: 'step-finish', reason: 'tool-calls', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
        ],
      });
    }
    output.messages.unshift(...injected);
  },
});
`,
    );
}

interface PassCapture {
    label: string;
    body: Record<string, unknown> | null;
    bytes: number;
}

function wireSegments(body: Record<string, unknown> | null): string[] {
    if (!body) return [];
    const items = (body.input ?? body.messages ?? body.contents) as unknown[] | undefined;
    return Array.isArray(items) ? items.map((item) => JSON.stringify(item)) : [];
}

/**
 * Serialized history before the segment holding the last fixture tool result.
 * That segment is excluded because Anthropic-shaped wires merge the newest tool
 * results with the next real user prompt, which differs on every pass.
 */
function fixturePrefix(body: Record<string, unknown> | null): string {
    const segments = wireSegments(body);
    let last = -1;
    segments.forEach((segment, index) => {
        if (segment.includes("TOOL_OUT_")) last = index;
    });
    return segments.slice(0, Math.max(0, last)).join("\n");
}

function count(text: string, needle: RegExp): number {
    return (text.match(needle) ?? []).length;
}

async function runScenario(name: "age" | "drop" | "worker" | "worker-control", route: Route) {
    const root = join(out, `${name}-${route.id}`);
    const dirs = Object.fromEntries(
        ["home", "config", "data", "cache", "state", "runtime", "work", "tmp"].map((k) => [k, join(root, k)]),
    ) as Record<string, string>;
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
    const worker = name === "worker" || name === "worker-control";
    const steps = worker ? 300 : 40;
    const encSize = worker ? 3000 : 256;
    const fixture = join(root, "fixture-plugin.mjs");
    fixturePlugin(fixture, steps, encSize);
    const provider = {
        [route.id]: {
            npm: route.npm,
            env: [],
            options: { apiKey: "mock-only", baseURL, project: "mock-project", location: "eu", name: route.id },
            models: {
                [route.model]: {
                    name: route.model,
                    reasoning: true,
                    tool_call: true,
                    limit: { context: 2_000_000, output: 2048 },
                    options: { store: false },
                },
            },
        },
    };
    writeFileSync(
        join(dirs.config, "opencode.json"),
        JSON.stringify({
            plugin: [`file://${fixture}`, `file://${pluginEntry}`],
            provider,
            enabled_providers: [route.id],
            model: `${route.id}/${route.model}`,
            small_model: `${route.id}/${route.model}`,
            autoupdate: false,
            share: "disabled",
            compaction: { auto: false, prune: false },
        }),
    );
    mkdirSync(join(dirs.config, "cortexkit"), { recursive: true });
    writeFileSync(
        join(dirs.config, "cortexkit", "magic-context.jsonc"),
        JSON.stringify({
            clear_reasoning_age: name === "drop" || name === "worker-control" ? 100000 : 10,
            execute_threshold_percentage: 80,
            dreamer: { disable: true },
            historian: { opencode: { model: `${route.id}/${route.model}` } },
        }),
    );
    prepareContextDatabase(dirs.data);
    const contextDb = join(dirs.data, "cortexkit", "magic-context", "context.db");
    const env: Record<string, string> = {
        PATH: process.env.PATH as string,
        HOME: dirs.home,
        XDG_CONFIG_HOME: dirs.config,
        XDG_DATA_HOME: dirs.data,
        XDG_CACHE_HOME: dirs.cache,
        XDG_STATE_HOME: dirs.state,
        XDG_RUNTIME_DIR: dirs.runtime,
        OPENCODE_CONFIG_DIR: dirs.config,
        OPENCODE_DB: join(dirs.data, "opencode", "wire.db"),
        MAGIC_CONTEXT_STORAGE_DIR: join(dirs.data, "cortexkit", "magic-context"),
        MAGIC_CONTEXT_LOG_PATH: join(root, "mc.log"),
        TMPDIR: dirs.tmp,
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
    };
    const version = Bun.spawnSync([binary, "--version"], { env }).stdout.toString().trim();
    if (version !== "1.18.30") throw new Error(`Expected 1.18.30, got ${version}`);
    const port = 22000 + Math.floor(Math.random() * 20000);
    const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
        cwd: dirs.work,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout?.on("data", (c) => (logs += c));
    child.stderr?.on("data", (c) => (logs += c));
    const url = `http://127.0.0.1:${port}`;
    const isolation = (file: string) => {
        const p = Bun.spawnSync(["lsof", "-p", String(child.pid)]);
        const text = p.stdout.toString();
        writeFileSync(join(root, file), text);
        const rows = text.split("\n").filter((l) => /REG/.test(l) && /\.db(?:-|\s|$)/.test(l));
        if (!rows.length || rows.some((l) => !l.includes(root))) throw new Error(`Database isolation failed: ${rows.join(" | ")}`);
        return rows.map((l) => l.split(/\s+/).slice(8).join(" "));
    };
    const api = async (path: string, body: unknown) => {
        const res = await fetch(`${url}${path}?directory=${encodeURIComponent(dirs.work)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120000),
        });
        return { status: res.status, value: await res.json().catch(() => null) };
    };
    const passes: PassCapture[] = [];
    let dbFiles: string[] = [];
    try {
        let ready = false;
        for (let i = 0; i < 120 && !ready; i++) {
            try {
                ready = (await fetch(`${url}/session`, { signal: AbortSignal.timeout(1000) })).ok;
            } catch {}
            if (!ready) await Bun.sleep(500);
        }
        if (!ready) throw new Error("host did not start");
        const session = (await api("/session", { title: "reasoning removal proof" })).value as { id: string };
        const prompt = async (label: string) => {
            const start = captures.length;
            await api(`/session/${session.id}/message`, {
                model: { providerID: route.id, modelID: route.model },
                agent: "build",
                parts: [{ type: "text", text: `${label} continue` }],
            });
            const mine = captures.slice(start).filter((c) => JSON.stringify(c.body).includes("FIXTURE_TASK"));
            const body = mine.at(-1)?.body ?? null;
            passes.push({ label, body, bytes: body ? JSON.stringify(body).length : 0 });
        };
        await prompt("pass-1");
        await prompt("pass-2");
        if (name === "drop") {
            const db = openTestDb(contextDb);
            // The host may still hold a write lock from the previous pass.
            db.exec("PRAGMA busy_timeout = 15000");
            const tag = db
                .query("SELECT tag_number AS n FROM tags WHERE session_id = ? AND type = 'tool' AND message_id = ?")
                .get(session.id, "call_fx_5") as { n: number } | null;
            if (!tag) throw new Error("fixture tool tag not found");
            db.query("INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, 'drop', ?)").run(
                session.id,
                tag.n,
                Date.now(),
            );
            db.close();
            await api(`/session/${session.id}/command`, { command: "ctx-flush", arguments: "" });
            await prompt("pass-3-flush");
            await prompt("pass-4");
        } else {
            await prompt("pass-3");
        }
        dbFiles = isolation("lsof-after.txt");
    } finally {
        child.kill("SIGTERM");
        await new Promise<void>((r) => (child.exitCode !== null ? r() : child.once("exit", () => r())));
        writeFileSync(join(root, "host.log"), logs);
        writeFileSync(join(root, "passes.json"), JSON.stringify(passes, null, 1));
    }
    const summary = passes.map((pass) => {
        const wire = JSON.stringify(pass.body ?? {});
        return {
            label: pass.label,
            captured: pass.body !== null,
            bytes: pass.bytes,
            reasoningMarkers: count(wire, /REASONING_\d+/g),
            encryptedPayloads: count(wire, /ENC_\d+_/g),
            signatures: count(wire, /"T?SIG_\d+"/g),
            clearedLiterals: count(wire, /\[cleared\]/g),
            toolOutputs: count(wire, /TOOL_OUT_\d+/g),
            newestToolResult: wire.includes(`TOOL_OUT_${steps - 1} `),
            newestReasoning: wire.includes(`REASONING_${steps - 1} `),
            prefixSha: new Bun.CryptoHasher("sha256").update(fixturePrefix(pass.body)).digest("hex").slice(0, 16),
        };
    });
    return { scenario: name, route: route.id, version, dbFiles, passes: summary };
}

const results = [];
try {
    for (const route of routes) {
        for (const scenario of ["age", "drop"] as const) {
            if (only && !only.includes(`${scenario}:${route.id}`)) continue;
            results.push(await runScenario(scenario, route));
        }
    }
    const openai = routes.find((r) => r.id === "openai") as Route;
    if (!only || only.includes("worker:openai")) {
        results.push(await runScenario("worker", openai));
        // Same shape with the age lane idle: what the request would carry today.
        results.push(await runScenario("worker-control", openai));
    }
} finally {
    mock.stop(true);
    writeFileSync(join(out, "summary.json"), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results, null, 2));
