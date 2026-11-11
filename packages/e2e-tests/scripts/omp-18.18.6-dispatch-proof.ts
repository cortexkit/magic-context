/**
 * Run the published OMP CLI, not a serializer mock. The version is pinned because
 * this proof diagnoses the request shape reported on 18.18.6; @latest can silently
 * change both the host transform and the wire serializer under the comparison.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { driveOmpNativeInputs } from "./omp-native-input-proof";

const root = resolve(import.meta.dir, "../../..");
const host = resolve(process.argv[2] ?? "target/scratch/omp-683-host");
const out = resolve(process.argv[3] ?? "target/scratch/omp-683-proof");
if (existsSync(out))
  throw new Error("Use a new output directory so each proof has a fresh isolated home");
const plugin = resolve(process.argv[4] ?? join(root, "packages/pi-plugin/dist/index.js"));
const scenario = process.argv[5] ?? "stock";
const steps = Number(process.env.MC_PROOF_STEPS ?? 1);
const auth = process.env.MC_PROOF_AUTH ?? "apiKey";
const nativeInputs = process.env.MC_PROOF_NATIVE_INPUTS === "1";
if (nativeInputs && steps !== 1) throw new Error("Native-input proof uses one primary turn");
if (auth !== "apiKey" && auth !== "oauth") throw new Error("Unknown proof auth mode");
if (![1, 3, 4].includes(steps)) throw new Error("Proof steps must be 1, 3 or 4");
if (
  !["stock", "large-system", "late-extension", "simple-english", "superpowers"].includes(scenario)
)
  throw new Error("Unknown proof scenario");
const version = JSON.parse(
  readFileSync(join(host, "node_modules/@oh-my-pi/pi-coding-agent/package.json"), "utf8"),
).version;
if (version !== "18.18.6") throw new Error(`Expected OMP 18.18.6, got ${version}`);
const cli = join(host, "node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
const results: unknown[] = [];
for (const api of ["google-generative-ai", "anthropic-messages"]) {
  const base = join(out, api);
  mkdirSync(base, { recursive: true });
  // Runtime homes must be outside a checkout, or identity resolution can select
  // the repository containing the fixture instead of an independent directory.
  const runtimeRoot = realpathSync(mkdtempSync(join(tmpdir(), "mc-omp683-")));
  for (let ancestor = runtimeRoot; ; ancestor = dirname(ancestor)) {
    if (existsSync(join(ancestor, ".git"))) throw new Error("Runtime home has a Git ancestor");
    if (dirname(ancestor) === ancestor) break;
  }
  const dirs = Object.fromEntries(
    ["home", "config", "data", "cache", "state", "runtime", "tmp", "work", "agent"].map((key) => [
      key,
      join(runtimeRoot, "tmp", key),
    ]),
  );
  dirs.tmp = join(runtimeRoot, "tmp");
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const requests: string[] = [];
  let primarySeen = 0;
  let childPid: number | undefined;
  const databasePaths = new Set<string>();
  const inspectDatabases = (pid: number): void => {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      let path: string;
      try {
        path = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (!/\.db(?:-wal|-shm)?$/u.test(path)) continue;
      databasePaths.add(path);
      if (!path.startsWith(`${dirs.tmp}/`))
        throw new Error(`Database escaped throwaway root: ${path}`);
    }
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return Response.json({ data: [] });
      const bytes = await request.text();
      if (childPid) inspectDatabases(childPid);
      requests.push(bytes);
      writeFileSync(join(base, `request-${requests.length}.json`), bytes);
      const primary = bytes.includes("Say OMP_PROOF_OK and stop.");
      if (primary) primarySeen++;
      const toolTurn = primary && primarySeen < steps;
      const toolId = `proof_call_${primarySeen}`;
      const events =
        api === "google-generative-ai"
          ? `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: toolTurn ? [{ functionCall: { id: toolId, name: "proof_wait", args: {} } }] : [{ text: "OMP_PROOF_OK" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105 } })}\n\n`
          : [
              [
                "message_start",
                {
                  type: "message_start",
                  message: {
                    id: "msg_proof",
                    type: "message",
                    role: "assistant",
                    model: "mock-model",
                    content: [],
                    usage: { input_tokens: 100, output_tokens: 0 },
                  },
                },
              ],
              [
                "content_block_start",
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: toolTurn
                    ? { type: "tool_use", id: toolId, name: "proof_wait", input: {} }
                    : { type: "text", text: "" },
                },
              ],
              [
                "content_block_delta",
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: toolTurn
                    ? { type: "input_json_delta", partial_json: "{}" }
                    : { type: "text_delta", text: "OMP_PROOF_OK" },
                },
              ],
              ["content_block_stop", { type: "content_block_stop", index: 0 }],
              [
                "message_delta",
                {
                  type: "message_delta",
                  delta: { stop_reason: toolTurn ? "tool_use" : "end_turn", stop_sequence: null },
                  usage: { output_tokens: 5 },
                },
              ],
              ["message_stop", { type: "message_stop" }],
            ]
              .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
              .join("");
      return new Response(events, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  writeFileSync(
    join(dirs.agent, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          api,
          auth,
          baseUrl: `http://127.0.0.1:${server.port}`,
          apiKey: "not-a-real-key",
          models: [
            {
              id: "mock-model",
              name: "Proof model",
              input: ["text"],
              contextWindow: 200000,
              maxTokens: 1024,
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  writeFileSync(
    join(dirs.agent, "config.yml"),
    JSON.stringify({
      compaction: { enabled: false },
      memory: { backend: "off" },
      retry: { enabled: false },
      tools: { xdev: false, intentTracing: false },
      enableInstallTelemetry: false,
    }),
  );
  mkdirSync(join(dirs.config, "cortexkit"), { recursive: true });
  writeFileSync(
    join(dirs.config, "cortexkit/magic-context.jsonc"),
    JSON.stringify({
      enabled: true,
      dreamer: { disable: true },
      embedding: { provider: "off" },
      memory: { enabled: false },
      auto_update: false,
    }),
  );
  const env = {
    ...process.env,
    HOME: dirs.home,
    CFFIXED_USER_HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    XDG_RUNTIME_DIR: dirs.runtime,
    TMPDIR: dirs.tmp,
    PI_CODING_AGENT_DIR: dirs.agent,
    OPENCODE_DB: join(dirs.data, "opencode/opencode.db"),
    MAGIC_CONTEXT_STORAGE_DIR: join(dirs.data, "cortexkit/magic-context"),
    MAGIC_CONTEXT_LOG_SYNC: "1",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  };
  writeFileSync(
    join(base, "isolation.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(env).filter(([key]) =>
          [
            "HOME",
            "CFFIXED_USER_HOME",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
            "XDG_STATE_HOME",
            "XDG_RUNTIME_DIR",
            "TMPDIR",
            "PI_CODING_AGENT_DIR",
            "OPENCODE_DB",
            "MAGIC_CONTEXT_STORAGE_DIR",
          ].includes(key),
        ),
      ),
      null,
      2,
    ),
  );
  const recorder = join(base, "recorder");
  mkdirSync(recorder, { recursive: true });
  writeFileSync(
    join(recorder, "package.json"),
    JSON.stringify({
      name: "aaaa-dispatch-proof-recorder",
      version: "1.0.0",
      type: "module",
      pi: { extensions: ["./index.ts"] },
      omp: { extensions: ["./index.ts"] },
    }),
  );
  writeFileSync(
    join(recorder, "index.ts"),
    `import { writeFileSync } from "node:fs"; export default function(api) { api.on("before_provider_request", event => { writeFileSync(${JSON.stringify(join(base, "proposed-request.json"))}, JSON.stringify(event.payload)); }); ${steps > 1 ? 'api.registerTool({ name: "proof_wait", label: "Proof wait", description: "Return a deterministic local test result", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }) });' : ""} }`,
  );
  execFileSync(process.execPath, [cli, "plugin", "install", recorder], {
    env,
    cwd: dirs.work,
    encoding: "utf8",
    timeout: 90_000,
  });
  // Native npm/link plugins load before marketplace extensions. An explicit -e
  // loads Magic Context after Superpowers, so its bootstrap becomes managed text
  // instead of exercising the late, foreign row that caused dispatch refusals.
  execFileSync(process.execPath, [cli, "plugin", "install", dirname(dirname(plugin))], {
    env,
    cwd: dirs.work,
    encoding: "utf8",
    timeout: 90_000,
  });
  if (scenario === "simple-english" || scenario === "superpowers") {
    const source = resolve(
      `target/scratch/${scenario}-${scenario === "superpowers" ? "7.0.2" : "2.1.1"}`,
    );
    const marketplace = scenario === "superpowers" ? "superpowers-dev" : "simple-english";
    const installLogs: string[] = [];
    for (const args of [
      ["plugin", "marketplace", "add", source],
      ["plugin", "install", `${scenario}@${marketplace}`],
      ["plugin", "list", "--json"],
    ]) {
      installLogs.push(
        execFileSync(process.execPath, [cli, ...args], {
          env,
          cwd: dirs.work,
          encoding: "utf8",
          timeout: 90_000,
        }),
      );
    }
    writeFileSync(join(base, "plugin-install.log"), installLogs.join("\n"));
  }
  let stdout = "",
    stderr = "";
  const extra: string[] = [];
  if (scenario === "large-system") {
    const systemPrompt = join(base, "large-system.md");
    writeFileSync(systemPrompt, "You are a helpful coding assistant.\n".repeat(6170));
    extra.push("--system-prompt", systemPrompt);
  }
  if (scenario === "late-extension") {
    const extension = join(base, "late-extension.ts");
    writeFileSync(
      extension,
      `export default function(api) { api.on("context", event => ({ messages: [...event.messages, { role: "user", content: "Unmanaged extra context from a later extension.", timestamp: Date.now() }] })); }`,
    );
    extra.push("-e", extension);
  }
  const child = spawn(
    process.execPath,
    [
      cli,
      ...(nativeInputs ? ["--mode", "rpc"] : ["--print", "--mode", "json"]),
      ...(steps === 1 && !nativeInputs ? ["--no-session"] : []),
      "--provider",
      "mock",
      "--model",
      "mock/mock-model",
      ...extra,
      ...(!nativeInputs ? ["Say OMP_PROOF_OK and stop."] : []),
    ],
    { cwd: dirs.work, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  childPid = child.pid;
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  let nativeFailure: string | undefined;
  const nativeTask = nativeInputs
    ? driveOmpNativeInputs(child, dirs.work, base).catch((error) => {
        nativeFailure = String(error);
        child.kill("SIGTERM");
      })
    : Promise.resolve();
  if (!nativeInputs) child.stdin.end();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
  const code = await new Promise<number | null>((res, rej) => {
    child.on("error", rej);
    child.on("close", res);
  });
  await nativeTask;
  clearTimeout(timeout);
  server.stop(true);
  writeFileSync(join(base, "stdout.jsonl"), stdout);
  writeFileSync(join(base, "stderr.log"), stderr);
  const logPaths = readdirSync(dirs.tmp, { recursive: true }).filter(
    (path) => typeof path === "string" && path.endsWith("magic-context.log"),
  ) as string[];
  const logs = logPaths.map((path) => readFileSync(join(dirs.tmp, path), "utf8")).join("\n");
  writeFileSync(join(base, "magic-context.log"), logs);
  if (nativeFailure) throw new Error(nativeFailure);
  const replied = stdout.split("\n").some((line) => {
    try {
      const event = JSON.parse(line);
      return (
        event.type === "message_end" &&
        event.message?.role === "assistant" &&
        event.message.stopReason === "stop" &&
        event.message.content?.some((block: { text?: string }) => block.text === "OMP_PROOF_OK")
      );
    } catch {
      return false;
    }
  });
  // OMP may compress skill descriptions in an independent startup request.
  // Count the genuine prompted turn separately without mistaking it for a reply.
  const primary = requests.filter((bytes) => bytes.includes("Say OMP_PROOF_OK and stop."));
  if (
    nativeInputs &&
    (logs.includes("OMP structural comparison skipped") ||
      !primary[0]?.includes("NATIVE_BASH_EXECUTION_683") ||
      !primary[0]?.includes("NATIVE_FILE_MENTION_683"))
  )
    throw new Error("Native-input proof did not exercise the guarded real shell/file shapes");
  if (primary.length) writeFileSync(join(base, "primary-request.json"), primary[0]);
  primary.forEach((bytes, index) =>
    writeFileSync(join(base, `primary-request-${index + 1}.json`), bytes),
  );
  const prefixes: string[] = [];
  if (steps > 1 && primary.length === steps) {
    if (scenario === "superpowers" && logs.split("foreign context rows accepted:").length - 1 !== 1)
      throw new Error("Foreign-row notice was not emitted exactly once for the session");
    const before = JSON.parse(primary[steps - 2]);
    const after = JSON.parse(primary[steps - 1]);
    const field = api === "google-generative-ai" ? "contents" : "messages";
    // OMP pi-ai 18.18.6 providers/anthropic.ts:588-625 hashes the body into OAuth system[0].text's
    // cch field, independent of Magic Context/Superpowers. API-key checks the full prefix; OAuth tools+rows.
    const prefixOf = (body: Record<string, unknown>, messages: unknown) =>
      JSON.stringify({
        system:
          api === "anthropic-messages" && auth === "oauth"
            ? undefined
            : (body.system ?? body.systemInstruction),
        tools: body.tools,
        messages,
      });
    const prefix = prefixOf(before, before[field]);
    const repeated = prefixOf(after, after[field].slice(0, before[field].length));
    if (prefix !== repeated)
      throw new Error("Consecutive defer passes rewrote the already-sent prefix");
    prefixes.push(createHash("sha256").update(prefix).digest("hex"));
    const opening = String(
      api === "google-generative-ai" ? after[field][0].parts[0].text : after[field][0].content,
    );
    if (/§\d+§/u.test(opening)) throw new Error("Foreign bootstrap acquired a Magic Context tag");
    const db = new Database(join(env.MAGIC_CONTEXT_STORAGE_DIR, "context.db"), { readonly: true });
    const chunks = db.query("SELECT body FROM lkg_slot_chunks ORDER BY chunk").all() as {
      body: string;
    }[];
    const envelopes = db.query("SELECT trailing_blank_decisions FROM session_meta").all();
    db.close();
    if (chunks.length === 0) throw new Error("Durable last-known-good prefix was not recorded");
    const persisted = JSON.stringify({ chunks, envelopes });
    if (persisted.includes("superpowers:using-superpowers bootstrap for pi"))
      throw new Error("Foreign bootstrap entered served/LKG persistence");
    const served = (envelopes as { trailing_blank_decisions: string }[]).flatMap(
      (row) => JSON.parse(row.trailing_blank_decisions).piServedTagNumbers ?? [],
    );
    if (JSON.stringify(served) !== JSON.stringify(Array.from({ length: steps }, (_, i) => i + 1)))
      throw new Error("Foreign bootstrap shifted the persisted served numbers");
    if (steps === 4) {
      const decisions = logs.split("\n").filter((line) => line.includes("transform: usage="));
      if (
        !decisions.slice(-2).every((line) => line.includes("decision=defer")) ||
        decisions.length < 4
      )
        throw new Error("The prefix comparison did not cover consecutive defer decisions");
    }
    writeFileSync(
      join(base, "persistence.json"),
      JSON.stringify(
        { lkgChunks: chunks.length, envelopes, foreignBootstrapPersisted: false },
        null,
        2,
      ),
    );
  }
  const result = {
    version,
    api,
    scenario,
    auth,
    nativeInputs,
    code,
    requests: primary.length,
    startupRequests: requests.length - primary.length,
    refused:
      stdout.includes("prepared turn structure") || stderr.includes("prepared turn structure"),
    replied,
    prefixHashes: prefixes,
    databasePaths: [...databasePaths],
    tail: primary.length
      ? (JSON.parse(primary[0]).contents ?? JSON.parse(primary[0]).messages).at(-1)
      : undefined,
  };
  results.push(result);
  console.log(
    JSON.stringify({ ...result, databasePaths: undefined, databaseCount: databasePaths.size }),
  );
  const expectRefusal =
    scenario === "late-extension" ||
    (scenario === "superpowers" && process.env.MC_PROOF_EXPECT_REFUSAL === "1");
  rmSync(runtimeRoot, { recursive: true, force: true });
  if (
    expectRefusal
      ? !result.refused || replied || primary.length !== 0
      : result.refused || !replied || primary.length !== steps || databasePaths.size === 0
  )
    throw new Error(`Unexpected proof result: ${JSON.stringify(result)}`);
}
writeFileSync(join(out, "summary.json"), JSON.stringify(results, null, 2));
