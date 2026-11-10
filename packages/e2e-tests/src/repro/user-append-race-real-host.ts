/**
 * Real-host probe: does a user message that arrives while a tool-result step is
 * the newest message get appended inside the provider user message that the
 * previous request already served?
 *
 * Run after `bun run build`, with TMPDIR pointing at a throwaway root:
 *   TMPDIR=$TMPDIR/magic-context/<task>/ MC_E2E_KEEP=1 \
 *     bun packages/e2e-tests/src/repro/user-append-race-real-host.ts --mode ts --delay 2500
 * Modes: `none` (no Magic Context), `ts`, `rust` (sets MC_E2E_MODE=rust, which
 * starts the hermetic ck-subc + ck-mc stack). `--delay 0` is the timing control.
 *
 * OpenCode stamps a user message's `time.created` before its `chat.message`
 * plugin hooks run, and persists the row afterwards. The probe plugin holds
 * `chat.message` for `--delay` ms for the marked late message only, which
 * reproduces the production stamp-to-persist latency deterministically. The
 * host, provider conversion and Magic Context run unmodified.
 */
import { openTestDb } from "../test-db";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestHarness } from "../harness";
import { PLUGIN_ENTRY } from "../opencode-runner/spawn";

const arg = (key: string, fallback: string) => {
    const i = process.argv.indexOf(`--${key}`);
    return i < 0 ? fallback : (process.argv[i + 1] ?? fallback);
};
const mode = arg("mode", "ts") as "none" | "ts" | "rust";
const delayMs = Number(arg("delay", "2500"));
if (!["none", "ts", "rust"].includes(mode)) throw new Error(`unknown --mode ${mode}`);
if (!(process.env.TMPDIR ?? "").includes("/magic-context/"))
    throw new Error("Set TMPDIR to a throwaway $TMPDIR/magic-context/<task>/ root");
if (mode === "rust") process.env.MC_E2E_MODE = "rust";
else delete process.env.MC_E2E_MODE;

const version = Bun.spawnSync(["opencode", "--version"]).stdout.toString().trim();
if (!version.startsWith("1.18.")) throw new Error(`Expected OpenCode 1.18.x on PATH, got ${version}`);

const root = process.env.TMPDIR!;
const traceFile = join(root, `trace-${mode}-${delayMs}-${Date.now()}.jsonl`);
const wrapper = join(root, `probe-plugin-${mode}-${Date.now()}.mjs`);
// The wrapper delays only the marked late message and records what the host
// handed to the transform and what the transform handed back, by message id.
writeFileSync(
    wrapper,
    `import { appendFileSync } from "node:fs";
${mode === "none" ? "" : `import mc from ${JSON.stringify(`file://${PLUGIN_ENTRY}`)};`}
const trace = (row) => appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ wall: Date.now(), ...row }) + "\\n");
const shape = (messages) => messages.map((m) => ({ id: m.info.id, role: m.info.role, created: m.info.time?.created,
  parts: m.parts.map((p) => p.type === "text" ? "text:" + String(p.text).slice(0, 40) : p.type) }));
export default {
  id: "user-append-race-probe",
  server: async (ctx) => {
    const hooks = ${mode === "none" ? "{}" : "await mc.server(ctx)"};
    const chatMessage = hooks["chat.message"];
    hooks["chat.message"] = async (input, output) => {
      const late = output.parts.some((p) => p.type === "text" && String(p.text).includes("LATE_USER"));
      if (late) {
        trace({ kind: "late_stamped", id: output.message.id, created: output.message.time.created });
        await new Promise((r) => setTimeout(r, ${delayMs}));
        trace({ kind: "late_released", id: output.message.id });
      }
      return chatMessage?.(input, output);
    };
    const transform = hooks["experimental.chat.messages.transform"];
    hooks["experimental.chat.messages.transform"] = async (input, output) => {
      trace({ kind: "transform_in", messages: shape(output.messages) });
      await transform?.(input, output);
      trace({ kind: "transform_out", messages: shape(output.messages) });
    };
    return hooks;
  },
};
`,
);
process.env.MC_E2E_PLUGIN_ENTRY = wrapper;

const h = await TestHarness.create({
    expectedMagicContextState: mode === "none" ? "configured-disabled" : "enabled",
    magicContextConfig: { historian: { disable: true }, dreamer: { disable: true } },
});
const result: Record<string, unknown> = { mode, delayMs, version, traceFile };
try {
    const lsof = Bun.spawnSync(["lsof", "-p", String(h.opencode.pid)]).stdout.toString();
    const dbFiles = lsof.split("\n").filter((l) => /REG/.test(l) && /\.db(?:-|\s|$)/.test(l));
    const base = h.dataDir.replace(/\/data$/, "");
    if (!dbFiles.length || dbFiles.some((l) => !l.includes(base)))
        throw new Error(`Host opened a database outside ${base}:\n${dbFiles.join("\n")}`);
    result.lsofDatabases = dbFiles.map((l) => l.split(/\s+/).at(-1));
    writeFileSync(join(root, `lsof-${mode}-${delayMs}.txt`), lsof);

    const target = join(h.workdir, "race.txt");
    writeFileSync(target, "race target\n");
    const sessionId = await h.createSession();
    const url = h.serverUrl;
    const model = { providerID: "mock-anthropic", modelID: "mock-sonnet" };
    const postAsync = (text: string) =>
        fetch(`${url}/session/${sessionId}/prompt_async?directory=${encodeURIComponent(h.workdir)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model, parts: [{ type: "text", text }] }),
        });

    let lateSent: Promise<Response> | undefined;
    const toolUse = (id: string) => ({
        content: [{ type: "tool_use", id, name: "read", input: { filePath: target } }],
        stop_reason: "tool_use" as const,
        usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0 },
    });
    h.mock.reset();
    h.mock.addMatcher((body) => {
        const text = JSON.stringify(body.messages ?? []);
        if (!text.includes("RACE_START") || !Array.isArray(body.tools) || body.tools.length === 0)
            return null;
        if (!text.includes("toolu_race_1")) {
            // Step 1 is in flight. The late message is stamped now, before the
            // next step's assistant exists, while the tool step is the tail.
            lateSent ??= postAsync("LATE_USER first we need to figure out the other issue.");
            return { ...toolUse("toolu_race_1"), delayMs: 400 };
        }
        if (!text.includes("toolu_race_2")) return { ...toolUse("toolu_race_2"), delayMs: delayMs + 1500 };
        return { text: "RACE_DONE", usage: { input_tokens: 100, output_tokens: 5 } };
    });
    h.mock.setDefault({ text: "title", usage: { input_tokens: 10, output_tokens: 2 } });

    await postAsync("RACE_START read the file please.");
    // The third main request is the first one whose history carries the second tool call.
    await h.waitFor(
        () =>
            h.mock
                .requests()
                .some(
                    (r) =>
                        r.responseCompletedAt !== undefined &&
                        JSON.stringify(r.body.messages ?? []).includes("toolu_race_2"),
                ),
        { label: "third main request", timeoutMs: 60_000 },
    );
    await lateSent;
    await h.waitForMockQuiescence({ quietMs: 1500, label: "race done" });

    const main = h.mock
        .requests()
        .filter((r) => Array.isArray(r.body.tools) && (r.body.tools as unknown[]).length > 0)
        .filter((r) => JSON.stringify(r.body.messages ?? []).includes("RACE_START"));
    const strip = (block: unknown) => {
        const { cache_control: _ignored, ...rest } = block as Record<string, unknown>;
        return JSON.stringify(rest);
    };
    const blocks = (m: { content: unknown }) =>
        (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as unknown[])).map(strip);
    const summary = main.map((r) =>
        (r.body.messages ?? []).map((m) => ({
            role: m.role,
            blocks: (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Array<Record<string, unknown>>)).map(
                (b) => `${b.type}:${String(b.text ?? b.tool_use_id ?? b.id ?? "").slice(0, 32)}`,
            ),
        })),
    );
    result.requests = summary;
    // The comparison that matters: the previous request's final provider message
    // at the same index in the next request.
    const comparisons = [];
    for (let i = 1; i < main.length; i++) {
        const prev = main[i - 1]!.body.messages!;
        const next = main[i]!.body.messages!;
        const k = prev.length - 1;
        const before = blocks(prev[k]!);
        const after = next[k] ? blocks(next[k]!) : [];
        const prefixUnchanged = prev.slice(0, k).every((m, j) => JSON.stringify(blocks(m)) === JSON.stringify(blocks(next[j]!)));
        comparisons.push({
            pair: `${i}->${i + 1}`,
            servedTailIndex: k,
            prefixUnchanged,
            servedTailUnchanged: JSON.stringify(before) === JSON.stringify(after),
            appendedBlocks: after.length > before.length && JSON.stringify(after.slice(0, before.length)) === JSON.stringify(before)
                ? after.slice(before.length).map((b) => b.slice(0, 80))
                : [],
        });
    }
    result.comparisons = comparisons;

    const db = openTestDb(join(h.dataDir, "opencode", "opencode.db"), { readonly: true });
    result.storedOrder = db
        .query(
            "SELECT id, time_created, json_extract(data,'$.role') AS role, json_extract(data,'$.parentID') AS parent FROM message WHERE session_id = ? ORDER BY time_created, id",
        )
        .all(sessionId);
    result.firstPartWrite = db
        .query(
            "SELECT m.id, MIN(p.time_created) - m.time_created AS stamp_to_part_ms FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = ? AND json_extract(m.data,'$.role')='user' GROUP BY m.id",
        )
        .all(sessionId);
    db.close();
} finally {
    writeFileSync(join(root, `result-${mode}-${delayMs}.json`), JSON.stringify(result, null, 2));
    await h.dispose();
}
console.log(JSON.stringify({ mode, delayMs, comparisons: result.comparisons, storedOrder: result.storedOrder }, null, 1));
