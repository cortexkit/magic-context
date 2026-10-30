import { openTestDb } from "../src/test-db";
// TMPDIR and MC_PREFIX_PROBE_ROOT must name the same throwaway directory: the harness
// allocates every host store below it, and this probe checks open files against it.
import { execFileSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { OpenCode } from "@opencode/client";
import { closeCompactionMarkerDb, injectCompactionMarker, prepareCompactionMarkerCandidates } from "../../plugin/src/features/magic-context/compaction-marker";
import { MARKER_SUMMARY_TEXT } from "../../plugin/src/hooks/magic-context/compaction-marker-manager";
import { clearCachedM0M1 } from "../../plugin/src/features/magic-context/storage";
import { setPersistedCompactionMarkerState } from "../../plugin/src/features/magic-context/storage-meta-persisted";
import { TestHarness } from "../src/harness";
import { createIsolatedEnv } from "../src/opencode-runner/spawn";
import { cleanupE2ETempDir } from "../src/temp-dir";
import { sessionMetaFieldSelect } from "../src/session-meta-fields";
import { OpenCode2TestHarness } from "../src/opencode2-harness";
import { PiTestHarness } from "../src/pi-harness";
import { resolvePiPackageJson } from "../src/pi-runner/spawn";
import { CLI as OC2_CLI, waitForPluginLog } from "../src/opencode2-runner/spawn";
import type { CapturedRequest } from "../src/mock-provider/server";

type Harness = TestHarness | OpenCode2TestHarness | PiTestHarness;
const kind = process.argv[2];
const mutation = process.argv[3] === "mutation";
const stock = process.argv[3] === "stock";
const off = process.argv[3] === "off";
const servedPrefixProbe = off || process.env.MC_SERVED_PREFIX_PROBE === "1";
if (!["opencode", "opencode2", "pi", "omp"].includes(kind!)) throw new Error("Expected opencode, opencode2, pi or omp");
const root = process.env.MC_PREFIX_PROBE_ROOT;
if (!root || root !== process.env.TMPDIR || !root.includes("/magic-context/"))
    throw new Error("TMPDIR and MC_PREFIX_PROBE_ROOT must name one private magic-context task root");
// A standalone probe nested below a worktree must not inherit that enclosing
// repository's ownership or project identity.
process.env.GIT_CEILING_DIRECTORIES = [realpathSync(root), process.env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(delimiter);
const MODEL = "claude-opus-5-5";
const usage = { input_tokens: 15_000, output_tokens: 50, cache_creation_input_tokens: 15_000 };
const config = {
    ...(stock ? { enabled: false } : {}),
    ...(off ? { compaction: { enabled: false } } : {}),
    signed_thinking_hold: "on", transform_mode: "ts", cache_ttl: "13h",
    protected_tokens: 4000, protected_tags: undefined, execute_threshold_percentage: 65,
    historian: { disable: true }, dreamer: { disable: true },
    memory: { enabled: false, auto_search: { enabled: false }, auto_promote: false }, compressor: { enabled: false },
};
const primary = (body: Record<string, unknown>) => (body.tools as Array<{ name: string }> | undefined)?.some(t => stock || off ? /^(?:bash|shell)$/.test(t.name.replace(/^_/, "")) : t.name.replace(/^_/, "") === "ctx_reduce") === true;
const options = { modelContextLimit: 100_000, magicContextConfig: config, expectMagicContext: !stock,
    mockModelID: MODEL, prefixBinding: true, thinkingScope: (body: Record<string, unknown>) => primary(body) ? "primary" : undefined };
const report: Record<string, unknown> = { kind, mutation, stock, off, servedPrefixProbe, model: MODEL };
let h: Harness | undefined;
let ownedOpenCodeEnv: ReturnType<typeof createIsolatedEnv> | undefined;
let session = "";
let stage = "warm";
let step = 0;
const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const rows = (sql: string) => h!.contextDb().prepare(sql).all(session) as Array<Record<string, unknown>>;
const meta = () => rows("SELECT held_release FROM session_meta WHERE session_id = ?")[0]?.held_release;

function isolation(host: Harness) {
    const pid = host instanceof PiTestHarness ? host.hostPid : host.opencode.pid;
    check(pid, "Host PID unavailable");
    const storeRoot = host instanceof PiTestHarness ? host.env.baseDir : host instanceof OpenCode2TestHarness ? host.opencode.root : host.opencode.env.dataDir;
    const inside = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);
    check(inside(realpathSync(storeRoot), realpathSync(root!)), `Store root escaped: ${storeRoot}`);
    const ancestry = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
    const pids = new Set<number>([Number(pid), process.pid]);
    for (let size = -1; size !== pids.size;) {
        size = pids.size;
        for (const [child, parent] of ancestry) if (pids.has(parent)) pids.add(child);
    }
    const inventoryFiles: string[] = [];
    const liveRoots = [".local/share/opencode", ".local/share/cortexkit/magic-context", ".config/opencode", ".config/cortexkit", ".pi/agent"].map(p => join(process.env.MC_PREFIX_LIVE_HOME ?? homedir(), p));
    for (const sampledPid of pids) {
    let inventory: string;
    try { inventory = execFileSync("lsof", ["-Fn", "-p", String(sampledPid)], { encoding: "utf8" }); }
    catch (error) {
        try { process.kill(sampledPid, 0); } catch { continue; }
        throw error;
    }
    for (const line of inventory.split("\n")) {
        if (!line.startsWith("n/")) continue;
        const path = line.slice(1);
        const canonical = existsSync(path) ? realpathSync(path) : path;
        check(!liveRoots.some(p => inside(canonical, p) || inside(path, p)), `Live path opened: ${path}`);
        if (/\.(?:db|sqlite)(?:-wal|-shm)?$/.test(path)) check(inside(canonical, realpathSync(root!)), `Database escaped: ${path}`);
    }
    const inventoryPath = join(root!, `${kind}-${mutation ? "mutation" : off ? "off" : "clean"}-${sampledPid}-lsof.txt`);
    writeFileSync(inventoryPath, inventory);
    inventoryFiles.push(inventoryPath);
    }
    return { pid, root: storeRoot, inventoryFiles };
}

async function flush(host: Harness): Promise<void> {
    if (host instanceof PiTestHarness) return host.invokeExtensionCommand("ctx-flush");
    if (host instanceof OpenCode2TestHarness) {
        const client = OpenCode.make({ baseUrl: host.serverUrl, headers: { authorization: `Basic ${btoa(`opencode:${host.opencode.password}`)}` } });
        await client.session.command({ sessionID: session, name: "ctx-flush", text: "" });
    } else {
        const response = await fetch(`${host.serverUrl}/session/${session}/command?directory=${encodeURIComponent(host.workdir)}`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "ctx-flush", arguments: "" }),
        });
        check(response.ok, `Flush failed: ${response.status} ${await response.text()}`);
    }
}

function changePrefix(body: Record<string, unknown>): Record<string, unknown> {
    if (!primary(body)) return body;
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    if (!messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === "thinking"))) return body;
    const copy = structuredClone(body);
    for (const message of copy.messages as typeof messages) {
        if (typeof message.content === "string") { message.content = `X${message.content.slice(1)}`; break; }
        if (Array.isArray(message.content)) {
            const text = message.content.find(b => b.type === "text" && typeof b.text === "string" && b.text.length);
            if (text) { text.text = `X${text.text.slice(1)}`; break; }
        }
    }
    return copy;
}

function thinkingBlocks(body: Record<string, unknown>) {
    return (body.messages as Array<{ content: unknown }>).flatMap(message =>
        Array.isArray(message.content) ? message.content.filter(block => block.type === "thinking" || block.type === "redacted_thinking") : [],
    );
}

try {
    process.env.MC_E2E_PRIVATE_TMPDIR = join(root, "host-tmp");
    mkdirSync(process.env.MC_E2E_PRIVATE_TMPDIR, { recursive: true });
    process.env.MAGIC_CONTEXT_LOG_PATH = join(root, `${kind}-${mutation ? "mutation" : "clean"}.log`);
    report.version = kind === "opencode" ? execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim()
        : kind === "opencode2" ? JSON.parse(readFileSync(join(realpathSync(OC2_CLI), "..", "..", "package.json"), "utf8")).version
        : JSON.parse(readFileSync(resolvePiPackageJson(kind === "omp" ? "omp" : "pi"), "utf8")).version;
    if (kind === "opencode") check(/^1\.18\./.test(String(report.version)), "OpenCode 1.18.x required");
    if (kind === "omp") check(/^18\.(?:8|11)\./.test(String(report.version)), "OMP 18.8.x or 18.11.x required");
    if (kind === "opencode") {
        ownedOpenCodeEnv = createIsolatedEnv();
        // Give the throwaway project its own identity before plugin boot, rather
        // than inheriting an enclosing checkout or requiring global Git config.
        const cwd = ownedOpenCodeEnv.workdir;
        execFileSync("git", ["init", "--quiet"], { cwd });
        execFileSync("git", ["-c", "user.name=Context probe", "-c", "user.email=probe@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "Initialize probe"], { cwd });
        execFileSync("git", ["remote", "add", "origin", "https://example.invalid/context-probe.git"], { cwd });
    }
    h = kind === "opencode" ? await TestHarness.create({ ...options, existingEnv: ownedOpenCodeEnv, ...(stock ? { expectedMagicContextState: "configured-disabled" as const } : {}), mockProviderID: "anthropic", prepareContextDatabase: true })
        : kind === "opencode2" ? await OpenCode2TestHarness.create(options)
        : await PiTestHarness.create({ ...options, host: kind === "omp" ? "omp" : "pi", reasoning: true });
    report.isolation = [isolation(h)];
    session = await h.createSession();
    report.session = session;
    if (servedPrefixProbe && !off && h instanceof TestHarness) {
        h.mock.setDefault({ text: "Marker seed complete.", usage });
        await h.sendPrompt(session, "PREFIX-RECORD seed a real marker boundary", { timeoutMs: 60_000 });
        const path = join(h.opencode.env.dataDir, "opencode", "opencode.db");
        const native = new Database(path, { readonly: true });
        let boundary: string;
        try {
            const row = native.prepare("SELECT id FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY time_created, id LIMIT 1").get(session) as { id: string } | null;
            check(row, "Seed produced no real host user boundary"); boundary = row!.id;
        } finally { native.close(); }
        const previous = process.env.OPENCODE_DB;
        closeCompactionMarkerDb();
        try {
            process.env.OPENCODE_DB = path;
            check(await prepareCompactionMarkerCandidates(session), "Marker candidate preparation failed");
            const marker = injectCompactionMarker({ sessionId: session, endOrdinal: 1, endMessageId: boundary, summaryText: MARKER_SUMMARY_TEXT, directory: h.workdir });
            check(marker, "Real marker injection failed");
            const writer = openTestDb(h.contextDbPath());
            try { setPersistedCompactionMarkerState(writer, session, { ...marker!, boundaryOrdinal: 1, targetEndMessageId: boundary }); }
            finally { writer.close(); }
        } finally {
            closeCompactionMarkerDb();
            if (previous === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = previous;
        }
        await flush(h);
        (report.isolation as unknown[]).push(isolation(h));
    }
    if (mutation) h.mock.setRequestTransform(changePrefix);
    h.mock.addMatcher(body => {
        if (!primary(body)) return { text: "auxiliary", usage };
        step++;
        const thinking = { type: "thinking", thinking: `Inspect the next result in full, step ${stage}-${step}.`, signature: "mint-me" };
        if (stage === "release" || (stage === "warm" && step > 5) || (stage === "loop" && step > 5))
            return { content: [thinking, { type: "text", text: "Turn complete." }], usage };
        const tools = body.tools as Array<{ name: string }>;
        const tool = tools.find(t => /^(?:bash|shell)$/.test(t.name.replace(/^_/, "")));
        check(tool, "Host has no shell tool");
        return { content: [thinking, { type: "tool_use", id: `${stage}-${step}`, name: tool!.name,
            input: { command: `python3 -c "print('\\n'.join('${stage}-${step} line %04d abcdefghijklmnopqrstuvwxyz0123456789' % i for i in range(160)))"`, ...(kind === "omp" ? {} : { description: "Produce a deterministic tool result" }) } }],
            stop_reason: "tool_use", usage, ...(stage === "loop" && step === 2 ? { delayMs: 1500 } : {}) };
    });
    let promptError: unknown;
    try { await h.sendPrompt(session, "PREFIX-RESTART warm tool history", { timeoutMs: 60_000 }); }
    catch (error) { promptError = String(error); }
    if (off) {
        check(!promptError, `Compaction-off warm prompt failed: ${promptError}`);
        const record = rows("SELECT served_prefix FROM session_meta WHERE session_id = ?")[0]?.served_prefix;
        check(record, "Compaction-off never wrote a served record");
        report.servedPrefixBefore = JSON.parse(String(record));
        stage = "loop"; step = 0;
        const turn = h.sendPrompt(session, "PREFIX-RECORD compaction-off loop", { timeoutMs: 90_000 });
        void turn.catch(() => {});
        await h.waitFor(() => step >= 2, { timeoutMs: 20_000, label: "signed off-mode loop" });
        const writer = openTestDb(h.contextDbPath());
        try {
            writer.prepare("UPDATE session_meta SET served_prefix = 'invalid' WHERE session_id = ?").run(session);
            writer.exec("CREATE TRIGGER fail_served_prefix BEFORE UPDATE OF served_prefix ON session_meta BEGIN SELECT RAISE(ABORT, 'record unavailable'); END");
        } finally { writer.close(); }
        await turn;
        await h.restart();
        (report.isolation as unknown[]).push(isolation(h));
        stage = "release"; step = 0;
        await h.sendPrompt(session, "PREFIX-RECORD off-mode failed write after restart", { timeoutMs: 90_000 });
        const requests = h.mock.requests().filter(r => primary(r.body));
        check(requests.length >= 10 && requests.every(r => r.thinkingChecked === "prefix-binding" && !r.thinkingViolation && r.responseStatus === 200), "Off-mode prefix fallback was unengaged or invalid");
        const headTexts = (report.servedPrefixBefore as { head: Array<{ role?: string; info?: { role?: string }; content?: unknown; parts?: unknown[] }> }).head
            .filter(message => (message.info?.role ?? message.role) === "user")
            .flatMap(message => typeof message.content === "string" ? [message.content] : ((message.parts ?? message.content ?? []) as Array<{ type?: string; text?: string }>).filter(part => part.type === "text").map(part => part.text))
            .filter((text): text is string => typeof text === "string" && text.length > 0);
        // Empty injected messages may be omitted by the host serializer;
        // every nonempty recorded text must remain in the provider request.
        check(headTexts.length > 0, "Off-mode record has no visible header text");
        check(requests.every(r => headTexts.every(text => JSON.stringify(r.body.messages).includes(JSON.stringify(text).slice(1, -1)))), "Off-mode prefix failure reached raw-input fallthrough");
        report.checkedRequests = requests.length; report.violations = [];
    } else if (stock) {
        check(!promptError, `Stock control failed: ${promptError}`);
        check(h.mock.requests().filter(r => primary(r.body)).every(r => !r.thinkingViolation && r.responseStatus === 200), "Stock host changed thinking prefix");
        report.violations = [];
    } else if (mutation) {
        const rejected = h.mock.requests().filter(r => r.thinkingViolation);
        check(rejected.length >= 1 && rejected.every(r => r.responseStatus === 400), "Transport mutation did not record a provider violation with status 400");
        report.violations = rejected.map(r => ({ error: r.thinkingViolation, status: r.responseStatus }));
        report.promptError = promptError;
    } else {
        check(!promptError, `Warm prompt failed: ${promptError}`);
        if (servedPrefixProbe && h instanceof TestHarness) {
            const record = rows("SELECT served_prefix FROM session_meta WHERE session_id = ?")[0]?.served_prefix;
            report.warmPrefix = record ? JSON.parse(String(record)) : null;
            report.warmMarkerState = Object.fromEntries(Object.entries(rows("SELECT * FROM session_meta WHERE session_id = ?")[0] ?? {}).filter(([key]) => /compaction_marker|held_release/.test(key)));
            check(record && JSON.parse(String(record)).summary, "Warm request never recorded the real marker summary");
        }
        const tag = rows("SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number LIMIT 1")[0];
        check(tag, "Warm turn produced no tagged tool arc");
        stage = "loop"; step = 0;
        const loopRequestOffset = h.mock.requests().length;
        const turn = h.sendPrompt(session, "PREFIX-RESTART primary tool loop", { timeoutMs: 60_000 });
        void turn.catch(() => {});
        await h.waitFor(() => step >= 2, { timeoutMs: 20_000, label: "second signed tool-loop request" });
        if (servedPrefixProbe) {
            const text = rows("SELECT served_prefix FROM session_meta WHERE session_id = ?")[0]?.served_prefix;
            check(text, "Loop did not write its served prefix record");
            report.servedPrefixBefore = JSON.parse(String(text));
        }
        const writer = openTestDb(h.contextDbPath());
        try {
            writer.prepare("INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', ?, ?)")
                .run(session, tag!.tag_number as number, Date.now(), h.harnessId);
            if (servedPrefixProbe) {
                clearCachedM0M1(writer, session);
                if (h instanceof TestHarness) setPersistedCompactionMarkerState(writer, session, null);
            }
        } finally { writer.close(); }
        await flush(h);
        await turn;
        const loopRequests = h.mock.requests().slice(loopRequestOffset).filter(r => primary(r.body));
        check(loopRequests.length >= 6, "Unengaged strip probe: missing loop requests");
        const olderThinking = thinkingBlocks(loopRequests[0]!.body);
        check(olderThinking.length > 0, "Unengaged strip probe: no completed-turn thinking");
        for (const request of loopRequests) {
            const kept = thinkingBlocks(request.body);
            check(olderThinking.every(block => kept.some(candidate =>
                candidate.type === block.type && candidate.signature === block.signature &&
                candidate.thinking === block.thinking && candidate.data === block.data,
            )), "Held pass stripped or changed completed-turn thinking");
        }
        report.heldThinking = { blocks: olderThinking.length, requests: loopRequests.length };
        check(meta(), "Held flush has no durable obligation");
        check(rows("SELECT tag_id FROM pending_ops WHERE session_id = ?").length > 0, "Queued drop was not held");
        report.heldRelease = meta();
        if (servedPrefixProbe) {
            const text = rows("SELECT served_prefix FROM session_meta WHERE session_id = ?")[0]?.served_prefix;
            check(JSON.stringify(JSON.parse(String(text))) === JSON.stringify(report.servedPrefixBefore), "Held pass replaced its served prefix record");
            report.servedPrefixHeld = JSON.parse(String(text));
            if (h instanceof TestHarness) check((report.servedPrefixHeld as { summary: unknown }).summary, "Marker fixture did not serve a recorded summary");
        }
        await h.restart();
        (report.isolation as unknown[]).push(isolation(h));
        stage = "release"; step = 0;
        await h.sendPrompt(session, "PREFIX-RESTART next real user after restart", { timeoutMs: 180_000 });
        if (servedPrefixProbe) {
            const text = rows("SELECT served_prefix FROM session_meta WHERE session_id = ?")[0]?.served_prefix;
            report.servedPrefixReleased = JSON.parse(String(text));
            check((report.servedPrefixReleased as { turn: unknown }).turn !== (report.servedPrefixBefore as { turn: unknown }).turn, "New user did not publish a fresh served record");
        }
        report.releaseTags = rows("SELECT tag_number, type, status, byte_size, input_byte_size, tool_name FROM tags WHERE session_id = ? ORDER BY tag_number");
        report.releaseProtection = Object.fromEntries(Object.entries(rows("SELECT * FROM session_meta WHERE session_id = ?")[0] ?? {}).filter(([key]) => /protect|floor|tokens|pending|held_release|is_subagent/.test(key)));
        check(meta() === null, "Restart release did not drain its obligation");
        check(rows("SELECT tag_id FROM pending_ops WHERE session_id = ?").length === 0, "Restart release did not land the queued drop");
        const logEnv = h instanceof OpenCode2TestHarness ? h.opencode.env : { MAGIC_CONTEXT_LOG_PATH: process.env.MAGIC_CONTEXT_LOG_PATH };
        const log = await waitForPluginLog(logEnv, "edit admission: release reason=user_flush");
        const held = log.split("\n").filter(line => /held lane=.*coords=.*boundary=.*held_edits=[1-9]/.test(line));
        check(held.length > 0, "Unengaged probe: no held-edit line");
        check(log.includes("edit admission: release reason=user_flush"), "Release lost its original flush reason");
        if (servedPrefixProbe) check(!log.includes("held lane=served_prefix"), "Clean record replay degraded into a refused prefix pass");
        report.heldEdits = held;
        const requests = h.mock.requests().filter(r => primary(r.body));
        check(requests.length >= 6, "Unengaged probe: missing tool-loop requests");
        check(requests.every(r => r.thinkingChecked === "prefix-binding"), "Unengaged probe: an unchecked primary request");
        check(requests.every(r => r.body.model === MODEL && r.body.thinking !== undefined), "Unengaged probe: prefix-bound model or reasoning disabled");
        check(requests.every(r => !r.thinkingViolation && r.responseStatus === 200), "Provider rejected a clean run");
        report.checkedRequests = requests.length;
        report.violations = [];
    }
    report.passed = true;
} catch (error) {
    report.error = String(error);
    report.diagnostics = h?.diagnostics();
    throw error;
} finally {
    if (h instanceof TestHarness) {
        const db = new Database(join(h.opencode.env.dataDir, "opencode", "opencode.db"), { readonly: true });
        try {
            report.storedParts = db.prepare("SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY id").all(session);
            report.storedMessages = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id").all(session);
        }
        finally { db.close(); }
        if (!stock) {
            const row = rows(`SELECT *, ${sessionMetaFieldSelect("trailing_blank_decisions")}, ${sessionMetaFieldSelect("merged_reasoning_stripped_ids")} FROM session_meta WHERE session_id = ?`)[0] ?? {};
            report.frozenDecisions = Object.fromEntries(Object.entries(row).filter(([key]) => /trailing_blank_decisions|merged_reasoning/.test(key)));
        }
    }
    report.requests = h?.mock.requests().map((r: CapturedRequest) => ({ body: r.body, checked: r.thinkingChecked, violation: r.thinkingViolation, status: r.responseStatus }));
    writeFileSync(join(root, `${kind}-${mutation ? "mutation" : "clean"}.json`), JSON.stringify(report, null, 2));
    await h?.dispose();
    if (ownedOpenCodeEnv && existsSync(dirname(ownedOpenCodeEnv.configDir))) cleanupE2ETempDir(dirname(ownedOpenCodeEnv.configDir));
}
console.log(JSON.stringify({ kind, mutation, version: report.version, checked: report.checkedRequests, violations: report.violations, passed: true }));
