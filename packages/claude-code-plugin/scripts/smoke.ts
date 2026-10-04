/**
 * End-to-end smoke test of the Claude Code plugin, run the way Claude Code runs it.
 *
 *   bun scripts/smoke.ts             build, then every offline check
 *   bun scripts/smoke.ts --no-build  use the existing dist/
 *   bun scripts/smoke.ts --live      also drive real `claude -p` sessions: needs a
 *                                    logged-in Claude Code and spends a few cents on Haiku
 *
 * The bundles run under `node`, not Bun, from a copy with no node_modules. Every
 * check uses its own store, log, project and Claude Code config directory; the
 * live checks need the real config directory for authentication, so they remove
 * the transcripts and session state they leave there.
 */

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
    assistantRecord,
    compactBoundaryRecord,
    compactSummaryRecord,
    textBlock,
    toJsonl,
    toolResultRecord,
    toolUseBlock,
    userRecord,
    writeTranscript,
} from "../src/test-fixtures";
import { encodeProjectDirectory } from "../src/transcript";

const PLUGIN_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(PLUGIN_ROOT, "..", "..");
const DIST = join(PLUGIN_ROOT, "dist");
const VERSION = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8")).version;
const TOOL_PREFIX = "mcp__plugin_magic-context_magic-context__";
const args = new Set(process.argv.slice(2));

// Claude Code's stream-json events and MCP results are untyped JSON.
// biome-ignore lint/suspicious/noExplicitAny: parsed JSON is inspected structurally
type Json = any;

// ── reporting ────────────────────────────────────────────────────────────────

let failures = 0;
let skips = 0;
function pass(name: string, detail = ""): void {
    console.log(`  ✔ ${name}${detail ? `  (${detail})` : ""}`);
}
function fail(name: string, detail: string): void {
    failures++;
    console.log(`  ✘ ${name}\n      ${detail.replace(/\n/g, "\n      ")}`);
}
function skip(name: string, reason: string): void {
    skips++;
    console.log(`  - ${name}: skipped, ${reason}`);
}
function check(name: string, ok: boolean, detail: string): void {
    if (ok) pass(name);
    else fail(name, detail);
}
function section(title: string): void {
    console.log(`\n${title}`);
}

// ── isolation ────────────────────────────────────────────────────────────────

const root = realpathSync(mkdtempSync(join(tmpdir(), "mc-claude-code-smoke-")));
// Session hand-off records live under the OS temp dir.
const isolatedTmp = join(root, "tmp");
mkdirSync(isolatedTmp);
const isolatedEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // A parent Claude Code session must not leak its identity into the plugin.
    for (const key of Object.keys(env)) {
        if (
            key.startsWith("CLAUDE_CODE_") ||
            key === "CLAUDECODE" ||
            key === "CLAUDE_PROJECT_DIR" ||
            key === "CLAUDE_PID"
        )
            delete env[key];
    }
    delete env.NODE_ENV;
    delete env.MAGIC_CONTEXT_TEST_DATA_DIR;
    return {
        ...env,
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        TMPDIR: isolatedTmp,
        MAGIC_CONTEXT_STORAGE_DIR: join(root, "store"),
        MAGIC_CONTEXT_LOG_PATH: join(root, "magic-context.log"),
        ...extra,
    };
};

function makeProject(name: string): string {
    const project = join(root, name);
    mkdirSync(project, { recursive: true });
    const git = (...gitArgs: string[]) =>
        spawnSync("git", gitArgs, { cwd: project, stdio: "ignore" }).status === 0;
    writeFileSync(join(project, "README.md"), `# ${name}\n`);
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "init");
    return project;
}

function hasClaude(): boolean {
    return spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
}

// ── a minimal MCP client over stdio ──────────────────────────────────────────

interface RpcResponse {
    id: number;
    result?: Json;
    error?: { code: number; message: string };
}

class McpClient {
    private child: ChildProcessWithoutNullStreams;
    private buffer = "";
    private nextId = 0;
    private waiting = new Map<number, (response: RpcResponse) => void>();
    stderr = "";
    exitCode: Promise<number | null>;

    constructor(serverPath: string, env: NodeJS.ProcessEnv, cwd: string) {
        this.child = spawn("node", ["--disable-warning=ExperimentalWarning", serverPath], {
            env,
            cwd,
        });
        this.child.stdout.on("data", (chunk) => {
            this.buffer += chunk;
            for (let end = this.buffer.indexOf("\n"); end >= 0; end = this.buffer.indexOf("\n")) {
                const line = this.buffer.slice(0, end).trim();
                this.buffer = this.buffer.slice(end + 1);
                if (!line) continue;
                const message = JSON.parse(line) as RpcResponse;
                this.waiting.get(message.id)?.(message);
                this.waiting.delete(message.id);
            }
        });
        this.child.stderr.on("data", (chunk) => {
            this.stderr += chunk;
        });
        this.exitCode = new Promise((resolve) => this.child.on("exit", resolve));
    }

    request(method: string, params: unknown = {}, timeoutMs = 20_000): Promise<RpcResponse> {
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`${method} timed out; stderr: ${this.stderr}`)),
                timeoutMs,
            );
            this.waiting.set(id, (response) => {
                clearTimeout(timer);
                resolve(response);
            });
            this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
    }

    notify(method: string): void {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    }

    async callTool(name: string, toolArgs: Record<string, unknown>) {
        const response = await this.request("tools/call", { name, arguments: toolArgs });
        if (response.error) throw new Error(`${name}: ${response.error.message}`);
        return {
            text: String(response.result.content?.[0]?.text ?? ""),
            isError: response.result.isError === true,
        };
    }

    async close(timeoutMs = 10_000): Promise<number | null> {
        this.child.stdin.end();
        const timeout = new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), timeoutMs),
        );
        const result = await Promise.race([this.exitCode, timeout]);
        if (result === "timeout") {
            this.child.kill("SIGKILL");
            return -1;
        }
        return result;
    }
}

function runHook(env: NodeJS.ProcessEnv, payload: string, hookPath = join(DIST, "hook.js")) {
    const started = Date.now();
    const result = spawnSync(
        "node",
        ["--disable-warning=ExperimentalWarning", hookPath, "session-start"],
        { input: payload, env, encoding: "utf8", timeout: 30_000 },
    );
    return { ...result, ms: Date.now() - started };
}

// ── 1. build ─────────────────────────────────────────────────────────────────

section("1. Build");
if (!args.has("--no-build")) {
    const build = spawnSync("bun", ["scripts/build.ts"], { cwd: PLUGIN_ROOT, encoding: "utf8" });
    check("bun scripts/build.ts", build.status === 0, build.stderr || build.stdout);
}
for (const file of [
    "mcp-server.js",
    "hook.js",
    "prompt-hook.js",
    "stop-hook.js",
    "embedding-worker.js",
    "migration-worker.js",
]) {
    check(`dist/${file} exists`, existsSync(join(DIST, file)), "missing; run the build");
}
{
    // Claude Code copies the plugin without node_modules: only Node builtins may be imported.
    const bare = new Set<string>();
    for (const file of readdirSync(DIST).filter((name) => name.endsWith(".js"))) {
        const source = readFileSync(join(DIST, file), "utf8");
        for (const match of source.matchAll(
            /(?:^|\n)\s*import\s[^;'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g,
        )) {
            const specifier = match[1] ?? match[2];
            if (!specifier.startsWith("node:") && !specifier.startsWith(".")) bare.add(specifier);
        }
    }
    check(
        "bundles import only Node builtins and their own chunks",
        bare.size === 0,
        `bare imports: ${[...bare].join(", ")}`,
    );
}

// ── 2. manifests ─────────────────────────────────────────────────────────────

section("2. Plugin and marketplace manifests");
const claudeAvailable = hasClaude();
if (claudeAvailable) {
    for (const [label, path] of [
        ["plugin", PLUGIN_ROOT],
        ["marketplace", REPO_ROOT],
    ] as const) {
        const result = spawnSync("claude", ["plugin", "validate", path], { encoding: "utf8" });
        check(
            `claude plugin validate (${label})`,
            result.status === 0 && /Validation passed/.test(result.stdout),
            result.stdout + result.stderr,
        );
    }
} else {
    skip("claude plugin validate", "the claude CLI is not on PATH");
}

// ── 3. MCP server ────────────────────────────────────────────────────────────

section("3. MCP server over stdio (node, default config: local embeddings not bundled)");
const project = makeProject("project");
const configDir = join(root, "claude-config");
const sessionId = randomUUID();
const marker = `kestrel-${randomUUID().slice(0, 8)}`;
writeTranscript(configDir, project, sessionId, [
    userRecord(`The staging canary host is ${marker}.internal; its window is Thursday 14:00 UTC.`),
    assistantRecord("msg_smoke_1", [textBlock(`Noted: canary ${marker}.internal.`)]),
    compactBoundaryRecord(),
    compactSummaryRecord("Summary: the user named the staging canary host."),
    userRecord("A live question about the albatross rollout."),
]);
const mcpEnv = isolatedEnv({
    CLAUDE_CODE_SESSION_ID: sessionId,
    CLAUDE_PROJECT_DIR: project,
    CLAUDE_CONFIG_DIR: configDir,
});
{
    const client = new McpClient(join(DIST, "mcp-server.js"), mcpEnv, project);
    try {
        const init = await client.request("initialize", {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "smoke", version: "0" },
        });
        check(
            "initialize",
            init.result?.protocolVersion === "2025-11-25" &&
                init.result?.serverInfo?.version === VERSION &&
                init.result?.capabilities?.tools !== undefined,
            JSON.stringify(init),
        );
        client.notify("notifications/initialized");

        const list = await client.request("tools/list");
        const names = (list.result?.tools ?? []).map((tool: { name: string }) => tool.name).sort();
        check(
            "tools/list offers ctx_expand, ctx_memory, ctx_note, ctx_search, ctx_skill",
            JSON.stringify(names) ===
                JSON.stringify(["ctx_expand", "ctx_memory", "ctx_note", "ctx_search", "ctx_skill"]),
            JSON.stringify(names),
        );

        const discover = await client.request("server/discover");
        check(
            "unimplemented methods answer -32601",
            discover.error?.code === -32601,
            JSON.stringify(discover),
        );

        const write = await client.callTool("ctx_memory", {
            action: "write",
            category: "PROJECT_RULES",
            content: `Release tags for ${marker} are signed with ops/release.asc.`,
        });
        check(
            "ctx_memory write",
            !write.isError && /Saved memory \[ID: \d+\]/.test(write.text),
            write.text,
        );

        const memorySearch = await client.callTool("ctx_search", {
            query: `how are release tags for ${marker} signed?`,
            sources: ["memory"],
        });
        check(
            "ctx_search finds the memory (lexical; no embeddings bundled)",
            memorySearch.text.includes("ops/release.asc"),
            memorySearch.text,
        );

        const note = await client.callTool("ctx_note", {
            action: "write",
            content: "Rotate the staging credentials\nafter the Thursday window",
        });
        const notes = await client.callTool("ctx_note", { action: "read" });
        check(
            "ctx_note write and read",
            !note.isError && notes.text.includes("Rotate the staging credentials"),
            `${note.text}\n${notes.text}`,
        );

        const messageSearch = await client.callTool("ctx_search", {
            query: `what is the staging canary host ${marker}?`,
            sources: ["message"],
        });
        check(
            "ctx_search finds a message Claude Code compacted away",
            messageSearch.text.includes(`${marker}.internal`) &&
                messageSearch.text.includes("ordinal=1"),
            messageSearch.text,
        );
        const liveSearch = await client.callTool("ctx_search", {
            query: "albatross rollout",
            sources: ["message"],
        });
        check(
            "ctx_search leaves out the live (uncompacted) tail",
            !liveSearch.text.includes("[message]"),
            liveSearch.text,
        );

        const expand = await client.callTool("ctx_expand", { message: 1 });
        check(
            "ctx_expand returns the original wording",
            expand.text.includes(`The staging canary host is ${marker}.internal`),
            expand.text,
        );

        const invalid = await client.callTool("ctx_memory", { action: "obliterate" });
        check(
            "invalid arguments are a tool error, not a crash",
            invalid.isError && invalid.text.startsWith("Invalid arguments"),
            invalid.text,
        );
    } catch (error) {
        fail("MCP session", `${error}\nstderr:\n${client.stderr}`);
    }
    const code = await client.close();
    check("server exits 0 when Claude Code closes stdin", code === 0, `exit ${code}`);
    check(
        "server writes nothing to stderr",
        client.stderr.trim() === "",
        client.stderr.slice(0, 2000),
    );
    const log = existsSync(join(root, "magic-context.log"))
        ? readFileSync(join(root, "magic-context.log"), "utf8")
        : "";
    check(
        "local-embedding fallback is quiet (no stale-build or crash reports)",
        !/stale plugin build|Cannot find (module|package)|uncaught/i.test(log),
        log
            .split("\n")
            .filter((line) => !line.includes("[migrations]"))
            .join("\n"),
    );
}

// ── 3b. operation skills ─────────────────────────────────────────────────────

section("3b. Operation skills over MCP (ctx_skill)");
{
    mkdirSync(join(project, "web"), { recursive: true });
    writeFileSync(join(project, "web", "app.js"), "// save button handler\n");
    const client = new McpClient(join(DIST, "mcp-server.js"), mcpEnv, project);
    try {
        await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
        const saved = await client.callTool("ctx_skill", {
            action: "save",
            name: "notes-page",
            title: "备注页",
            description: "Saving notes from the notes page.",
            scope: "web",
            operations: [
                {
                    id: "save-note",
                    trigger: { kind: "button", label: "保存备注", location: "web/app.js:1" },
                    intents: ["保存备注", "save a note"],
                    action: { summary: "POSTs the note and appends it to the list" },
                    apis: [{ method: "POST", endpoint: "/api/notes", request: "{ text }" }],
                    writes: [{ target: "data/notes.json", fields: "text, createdAt" }],
                    state: [{ target: "state.notes", change: "push the saved note" }],
                    save_and_linkage: "toast, list re-renders",
                    files_to_modify: ["web/app.js"],
                    steps: ['curl -X POST <base>/api/notes -d \'{"text":"<text>"}\''],
                    verification: { method: "curl + read data/notes.json" },
                },
            ],
        });
        check(
            "ctx_skill save writes a native skill into the project",
            !saved.isError &&
                existsSync(join(project, ".claude", "skills", "notes-page", "SKILL.md")) &&
                existsSync(join(project, ".claude", "skills", "notes-page", "flow.json")),
            saved.text,
        );
        const found = await client.callTool("ctx_skill", {
            action: "find",
            query: "帮我用保存备注按钮存一条",
        });
        check(
            "ctx_skill find maps a request to the recorded action",
            found.text.includes('operation "save-note"') &&
                found.text.includes("`POST /api/notes`"),
            found.text,
        );
        writeFileSync(join(project, "web", "app.js"), "// save button handler, changed\n");
        const stale = await client.callTool("ctx_skill", { action: "find", query: "保存备注" });
        check(
            "a changed file is reported against the operation",
            stale.text.includes("Changed since verification:** `web/app.js`"),
            stale.text,
        );
    } catch (error) {
        fail("ctx_skill over MCP", `${error}\n${client.stderr}`);
    }
    await client.close();
    const startup = runHook(
        isolatedEnv({ CLAUDE_CONFIG_DIR: configDir }),
        JSON.stringify({ session_id: sessionId, cwd: project, source: "startup" }),
    );
    check(
        "session start lists the project's operations",
        startup.stdout.includes("<project-skills>") &&
            startup.stdout.includes('save-note: button \\"保存备注\\" → POST /api/notes'),
        startup.stdout.slice(0, 3000),
    );
    const prompted = (prompt: string) =>
        spawnSync("node", [join(DIST, "prompt-hook.js")], {
            input: JSON.stringify({
                session_id: randomUUID(),
                cwd: project,
                hook_event_name: "UserPromptSubmit",
                prompt,
            }),
            env: isolatedEnv(),
            encoding: "utf8",
        });
    const named = prompted("帮我用保存备注按钮存一条：周五发版");
    let injected = "";
    try {
        injected = JSON.parse(named.stdout).hookSpecificOutput.additionalContext;
    } catch {}
    check(
        "a prompt naming a button gets its recorded operation injected",
        named.status === 0 &&
            injected.startsWith("<operation-skill>") &&
            injected.includes("`POST /api/notes`"),
        named.stdout + named.stderr,
    );
    const unrelated = prompted("explain the build script");
    check(
        "an unrelated prompt gets nothing",
        unrelated.status === 0 && unrelated.stdout === "",
        unrelated.stdout + unrelated.stderr,
    );
}

// ── 4. SessionStart hook ─────────────────────────────────────────────────────

section("4. SessionStart hook (node)");
{
    const env = isolatedEnv({ CLAUDE_CONFIG_DIR: configDir });
    const payload = (source: string) =>
        JSON.stringify({
            session_id: sessionId,
            transcript_path: join(configDir, "missing.jsonl"),
            cwd: project,
            hook_event_name: "SessionStart",
            source,
        });
    const startup = runHook(env, payload("startup"));
    let context = "";
    try {
        context = JSON.parse(startup.stdout).hookSpecificOutput.additionalContext;
    } catch {}
    check(
        "startup injects project memory and session notes",
        startup.status === 0 &&
            context.includes("<project-memory>") &&
            context.includes("ops/release.asc") &&
            context.includes("Rotate the staging credentials"),
        `exit ${startup.status}\n${startup.stdout}\n${startup.stderr}`,
    );
    check("hook finishes well inside its 15 s timeout", startup.ms < 5000, `${startup.ms} ms`);

    const compact = runHook(env, payload("compact"));
    check(
        "compact points the model at the recall tools",
        compact.status === 0 && compact.stdout.includes("just compacted"),
        compact.stdout + compact.stderr,
    );

    const garbage = runHook(env, "this is not json");
    check(
        "malformed input exits 0 without output",
        garbage.status === 0 && garbage.stdout === "",
        `exit ${garbage.status}: ${garbage.stdout}`,
    );

    const blocked = join(root, "not-a-directory");
    writeFileSync(blocked, "");
    const broken = runHook(isolatedEnv({ MAGIC_CONTEXT_STORAGE_DIR: blocked }), payload("startup"));
    check(
        "unusable storage becomes a one-line notice, exit 0",
        broken.status === 0 && broken.stdout.includes('"systemMessage"'),
        `exit ${broken.status}: ${broken.stdout}${broken.stderr}`,
    );

    // Stop: verified work makes the session's own model capture, once.
    const work = join(root, "stop-transcript.jsonl");
    writeFileSync(
        work,
        toJsonl([
            userRecord("make the save button trim the text"),
            assistantRecord("m1", [toolUseBlock("e1", "Edit", { file_path: "web/app.js" })]),
            toolResultRecord("e1", "ok"),
            assistantRecord("m2", [toolUseBlock("b1", "Bash", { command: "curl ..." })]),
            toolResultRecord("b1", "201"),
        ]),
    );
    const stop = (active: boolean) =>
        spawnSync("node", [join(DIST, "stop-hook.js")], {
            input: JSON.stringify({
                session_id: randomUUID(),
                transcript_path: work,
                hook_event_name: "Stop",
                stop_hook_active: active,
            }),
            env: isolatedEnv({ MAGIC_CONTEXT_CAPTURE_AFTER: "2" }),
            encoding: "utf8",
        });
    const capture = stop(false);
    let decision: Json = {};
    try {
        decision = JSON.parse(capture.stdout);
    } catch {}
    check(
        "Stop hook asks the session's own model to capture verified work",
        capture.status === 0 &&
            decision.decision === "block" &&
            String(decision.reason).includes("ctx_skill"),
        capture.stdout + capture.stderr,
    );
    const extended = stop(true);
    check(
        "Stop hook never extends a stop it already extended",
        extended.status === 0 && extended.stdout === "",
        extended.stdout,
    );
}

// ── 5. /clear and /resume ────────────────────────────────────────────────────

section("5. Session switch without a server restart (/clear, /resume)");
{
    // Claude Code keeps the MCP server across /clear; the hook tells it the new
    // session through a record keyed by Claude Code's PID. Here this script is
    // the server's parent, so it plays Claude Code's PID.
    const cleared = randomUUID();
    const hookEnv = isolatedEnv({ CLAUDE_CONFIG_DIR: configDir });
    const recorded = runHook(
        { ...hookEnv, CLAUDE_PID: String(process.pid) },
        JSON.stringify({ session_id: cleared, cwd: project, source: "clear" }),
    );
    check("SessionStart(clear) succeeds", recorded.status === 0, recorded.stderr);

    // The server still carries the session id it was started with.
    const client = new McpClient(join(DIST, "mcp-server.js"), mcpEnv, project);
    try {
        await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
        const write = await client.callTool("ctx_note", {
            action: "write",
            content: "Filed after the clear",
        });
        check("ctx_note after /clear", !write.isError, write.text);
    } catch (error) {
        fail("ctx_note after /clear", `${error}\n${client.stderr}`);
    }
    await client.close();

    const context = (id: string) =>
        runHook(hookEnv, JSON.stringify({ session_id: id, cwd: project, source: "resume" })).stdout;
    check(
        "the note belongs to the session the process switched to",
        context(cleared).includes("Filed after the clear") &&
            !context(sessionId).includes("Filed after the clear"),
        context(cleared),
    );
}

// ── 6. marketplace install ───────────────────────────────────────────────────

section("6. Install through the marketplace (isolated CLAUDE_CONFIG_DIR)");
if (claudeAvailable) {
    const installConfig = join(root, "claude-install");
    mkdirSync(installConfig);
    const claude = (...claudeArgs: string[]) =>
        spawnSync("claude", claudeArgs, {
            encoding: "utf8",
            env: { ...isolatedEnv(), CLAUDE_CONFIG_DIR: installConfig },
            timeout: 120_000,
        });
    const add = claude("plugin", "marketplace", "add", REPO_ROOT);
    check("claude plugin marketplace add", add.status === 0, add.stdout + add.stderr);
    const install = claude("plugin", "install", "magic-context@cortexkit");
    check(
        "claude plugin install magic-context@cortexkit",
        install.status === 0,
        install.stdout + install.stderr,
    );

    let installPath = "";
    try {
        const installed = JSON.parse(
            readFileSync(join(installConfig, "plugins", "installed_plugins.json"), "utf8"),
        );
        installPath = installed.plugins["magic-context@cortexkit"][0].installPath;
    } catch {}
    check(
        "installed copy carries dist/ and no node_modules",
        installPath !== "" &&
            existsSync(join(installPath, "dist", "mcp-server.js")) &&
            !existsSync(join(installPath, "node_modules")),
        `installPath=${installPath}`,
    );
    if (installPath) {
        const client = new McpClient(join(installPath, "dist", "mcp-server.js"), mcpEnv, project);
        try {
            await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
            const list = await client.request("tools/list");
            const found = await client.callTool("ctx_search", {
                query: `release tags for ${marker}`,
                sources: ["memory"],
            });
            check(
                "installed copy serves the same store",
                list.result?.tools?.length === 5 && found.text.includes("ops/release.asc"),
                found.text,
            );
        } catch (error) {
            fail("installed copy", `${error}\n${client.stderr}`);
        }
        await client.close();
        const hook = runHook(
            isolatedEnv(),
            JSON.stringify({ session_id: sessionId, cwd: project, source: "startup" }),
            join(installPath, "dist", "hook.js"),
        );
        check(
            "installed hook injects memory",
            hook.status === 0 && hook.stdout.includes("ops/release.asc"),
            hook.stdout + hook.stderr,
        );
    }
} else {
    skip("marketplace install", "the claude CLI is not on PATH");
}

// ── demo app for the live operation-skill checks ─────────────────────────────

const DEMO_SERVER = [
    'import { createServer } from "node:http";',
    'import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    "const root = dirname(fileURLToPath(import.meta.url));",
    'const dataFile = join(root, "data", "notes.json");',
    'const readNotes = () => (existsSync(dataFile) ? JSON.parse(readFileSync(dataFile, "utf8")) : []);',
    "const writeNotes = (notes) => {",
    "    mkdirSync(dirname(dataFile), { recursive: true });",
    "    writeFileSync(dataFile, JSON.stringify(notes, null, 2));",
    "};",
    "",
    "const server = createServer((req, res) => {",
    "    const send = (status, body) => {",
    '        res.writeHead(status, { "content-type": "application/json" });',
    "        res.end(JSON.stringify(body));",
    "    };",
    '    if (req.url !== "/api/notes") return send(404, { error: "not found" });',
    '    if (req.method === "GET") return send(200, readNotes());',
    '    if (req.method === "DELETE") {',
    "        writeNotes([]);",
    "        return send(200, { cleared: true });",
    "    }",
    '    if (req.method === "POST") {',
    '        let raw = "";',
    '        req.on("data", (chunk) => (raw += chunk));',
    '        req.on("end", () => {',
    "            let text;",
    "            try {",
    '                text = JSON.parse(raw || "{}").text;',
    "            } catch {",
    '                return send(400, { error: "invalid JSON" });',
    "            }",
    '            if (!text) return send(400, { error: "text is required" });',
    "            const note = { id: Date.now(), text, createdAt: new Date().toISOString() };",
    "            writeNotes([...readNotes(), note]);",
    "            send(201, note);",
    "        });",
    "        return;",
    "    }",
    '    send(405, { error: "method not allowed" });',
    "});",
    'server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {',
    '    console.log("LISTENING " + server.address().port);',
    "});",
    "",
].join("\n");

const DEMO_PAGE = [
    "<!doctype html>",
    '<html lang="zh">',
    "<body>",
    '  <textarea id="note-text" placeholder="写点什么"></textarea>',
    '  <button id="save-note">保存备注</button>',
    '  <button id="clear-notes">清空备注</button>',
    '  <ul id="note-list"></ul>',
    '  <div id="toast"></div>',
    '  <script src="app.js"></script>',
    "</body>",
    "</html>",
    "",
].join("\n");

const DEMO_APP = [
    "// Notes page: the API is served by ../server.mjs under /api/notes.",
    "const state = { notes: [] };",
    "",
    "async function api(method, body) {",
    '    const res = await fetch("/api/notes", {',
    "        method,",
    '        headers: { "content-type": "application/json" },',
    "        body: body ? JSON.stringify(body) : undefined,",
    "    });",
    "    if (!res.ok) throw new Error(await res.text());",
    "    return res.json();",
    "}",
    "",
    "function render() {",
    '    document.getElementById("note-list").innerHTML = state.notes',
    '        .map((note) => "<li>" + note.text + "</li>")',
    '        .join("");',
    "}",
    "",
    "function toast(message) {",
    '    document.getElementById("toast").textContent = message;',
    "}",
    "",
    'document.getElementById("save-note").addEventListener("click", async () => {',
    '    const input = document.getElementById("note-text");',
    '    const note = await api("POST", { text: input.value });',
    "    state.notes.push(note);",
    "    render();",
    '    toast("已保存");',
    '    input.value = "";',
    "});",
    "",
    'document.getElementById("clear-notes").addEventListener("click", async () => {',
    '    if (!confirm("确定清空所有备注？")) return;',
    '    await api("DELETE");',
    "    state.notes = [];",
    "    render();",
    '    toast("已清空");',
    "});",
    "",
    'api("GET").then((notes) => {',
    "    state.notes = notes;",
    "    render();",
    "});",
    "",
].join("\n");

function makeDemoApp(directory: string): string {
    mkdirSync(join(directory, "web"), { recursive: true });
    writeFileSync(join(directory, "server.mjs"), DEMO_SERVER);
    writeFileSync(join(directory, "web", "index.html"), DEMO_PAGE);
    writeFileSync(join(directory, "web", "app.js"), DEMO_APP);
    writeFileSync(
        join(directory, "package.json"),
        `${JSON.stringify({ name: "notes-app", private: true, type: "module" }, null, 2)}\n`,
    );
    spawnSync("git", ["init", "-q"], { cwd: directory });
    return directory;
}

function startDemoServer(directory: string): Promise<{ port: number; stop: () => void }> {
    const child = spawn("node", ["server.mjs"], {
        cwd: directory,
        env: { ...process.env, PORT: "0" },
    });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("demo server did not start")), 10_000);
        child.stdout.on("data", (chunk) => {
            const port = String(chunk).match(/LISTENING (\d+)/)?.[1];
            if (!port) return;
            clearTimeout(timer);
            resolve({ port: Number(port), stop: () => child.kill() });
        });
        child.on("exit", (code) => reject(new Error(`demo server exited ${code}`)));
    });
}

function readSkills(directory: string): Json[] {
    const skillsDir = join(directory, ".claude", "skills");
    if (!existsSync(skillsDir)) return [];
    return readdirSync(skillsDir).flatMap((name) => {
        try {
            const flow = JSON.parse(readFileSync(join(skillsDir, name, "flow.json"), "utf8"));
            return flow.schema === "magic-context/operation-skill@1" ? [flow] : [];
        } catch {
            return [];
        }
    });
}

async function runLiveChecks(): Promise<void> {
    const liveProject = makeProject("live-project");
    const realConfig = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    const pluginDataDir = join(realConfig, "plugins", "data", "magic-context-inline");
    const pluginDataExisted = existsSync(pluginDataDir);
    const sessionIds = new Set<string>();
    const projects = [liveProject];
    const liveEnv = isolatedEnv({ MAGIC_CONTEXT_STORAGE_DIR: join(root, "live-store") });
    const keyPath = `ops/keys/${randomUUID().slice(0, 8)}.asc`;
    const host = `heron-${randomUUID().slice(0, 6)}.internal`;

    const claude = (
        prompt: string,
        extra: string[] = [],
        options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
    ) => {
        const result = spawnSync(
            "claude",
            [
                "-p",
                "--plugin-dir",
                PLUGIN_ROOT,
                "--model",
                "haiku",
                "--output-format",
                "stream-json",
                "--verbose",
                ...extra,
                "--",
                prompt,
            ],
            {
                cwd: options.cwd ?? liveProject,
                env: { ...liveEnv, ...options.env },
                encoding: "utf8",
                timeout: options.timeoutMs ?? 300_000,
            },
        );
        const events = result.stdout
            .split("\n")
            .filter((line) => line.trim().startsWith("{"))
            .map((line) => JSON.parse(line));
        for (const event of events) if (event.session_id) sessionIds.add(event.session_id);
        const toolUses = events.flatMap((event) =>
            event.type === "assistant"
                ? event.message.content.filter((block: Json) => block.type === "tool_use")
                : [],
        );
        const toolResults = events.flatMap((event) =>
            event.type === "user" && Array.isArray(event.message?.content)
                ? event.message.content.filter((block: Json) => block.type === "tool_result")
                : [],
        );
        const final = events.find((event) => event.type === "result");
        return {
            status: result.status,
            stderr: result.stderr,
            events,
            toolUses,
            toolResults,
            final,
        };
    };
    const resultText = (block: Json): string =>
        typeof block.content === "string"
            ? block.content
            : (block.content ?? []).map((part: Json) => part.text ?? "").join("");

    const runs: ReturnType<typeof claude>[] = [];

    /**
     * A real frontend with a backend that writes data: the model captures its
     * buttons as operation skills, a fresh session then performs an operation from
     * the skill alone, and a change verified in a third session makes the Stop
     * hook ask the session's own model to keep the skill current.
     */
    async function runOperationSkillChecks(): Promise<void> {
        const demo = makeDemoApp(join(root, "notes-app"));
        projects.push(demo);
        const server = await startDemoServer(demo);
        const base = `http://127.0.0.1:${server.port}`;
        try {
            const captured = claude(
                `/magic-context:capture-skill web/ 前端。后端 server.mjs 已经在 ${base} 运行；用 curl 实际调用接口验证每个写入操作，验证通过后再保存。`,
                [
                    "--allowedTools",
                    `Read,Grep,Glob,Bash(curl:*),Bash(cat:*),${TOOL_PREFIX}ctx_skill`,
                ],
                { cwd: demo, timeoutMs: 600_000 },
            );
            runs.push(captured);
            const skills = readSkills(demo);
            const operations = skills.flatMap((skill) => skill.operations ?? []);
            const save = operations.find((operation: Json) =>
                (operation.apis ?? []).some(
                    (api: Json) =>
                        /\/api\/notes/.test(api.endpoint) && /post/i.test(api.method ?? ""),
                ),
            );
            check(
                "the skill records how to get the app ready (setup)",
                skills.some((skill) => (skill.setup ?? []).length > 0),
                JSON.stringify(skills.map((skill) => skill.setup ?? null)),
            );
            check(
                "the model turns the frontend's save button into a verified operation skill",
                save !== undefined &&
                    (save.writes ?? []).some((write: Json) => /notes/.test(write.target)) &&
                    String(save.verification?.method ?? "").length > 0 &&
                    skills.every((skill) =>
                        existsSync(join(demo, ".claude", "skills", skill.name, "SKILL.md")),
                    ),
                `${JSON.stringify(skills).slice(0, 2500)}\n${captured.final?.result ?? captured.stderr}`,
            );
            pass(
                "captured operations",
                operations
                    .map(
                        (operation: Json) =>
                            `${operation.trigger?.label} → ${operation.apis?.[0]?.endpoint ?? "-"}`,
                    )
                    .join("; "),
            );

            // A fresh session performs the operation from the skill alone.
            const marker = `备注-${randomUUID().slice(0, 6)}`;
            const reused = claude(
                `用「保存备注」按钮保存一条备注，内容是：${marker}`,
                [
                    "--include-hook-events",
                    "--allowedTools",
                    `Bash(curl:*),Skill,${TOOL_PREFIX}ctx_skill`,
                ],
                { cwd: demo },
            );
            runs.push(reused);
            const notesFile = join(demo, "data", "notes.json");
            const stored = existsSync(notesFile) ? readFileSync(notesFile, "utf8") : "";
            check(
                "a new session performs the recorded operation and the data is written",
                stored.includes(marker),
                `${stored.slice(0, 500)}\n${reused.final?.result}`,
            );
            const injected = reused.events.some(
                (event: Json) =>
                    event.type === "system" && JSON.stringify(event).includes("<operation-skill>"),
            );
            check(
                "the prompt hook hands the session the recorded operation",
                injected,
                reused.events
                    .filter((event: Json) => event.type === "system")
                    .map((event: Json) => JSON.stringify(event).slice(0, 300))
                    .join("\n"),
            );
            const lookedUp =
                injected ||
                reused.toolUses.some(
                    (use: Json) => use.name === `${TOOL_PREFIX}ctx_skill` || use.name === "Skill",
                );
            const reread = reused.toolUses.filter(
                (use: Json) =>
                    ["Read", "Grep", "Glob"].includes(use.name) &&
                    /web\/|server\.mjs/.test(JSON.stringify(use.input)),
            );
            check(
                "it used the skill and did not re-analyse the source",
                lookedUp && reread.length === 0,
                reused.toolUses
                    .map((use: Json) => `${use.name} ${JSON.stringify(use.input).slice(0, 120)}`)
                    .join("\n"),
            );

            // Verified work in a third session: the Stop hook asks this session's model to capture.
            const before = JSON.stringify(readSkills(demo));
            const changed = claude(
                `在 web/app.js 的保存备注逻辑里，提交前先对内容 trim()，内容为空时不提交。改完后用 curl 调用后端（${base}/api/notes）验证保存仍然正常。`,
                [
                    "--allowedTools",
                    `Read,Edit,Grep,Glob,Bash(curl:*),Bash(node:*),${TOOL_PREFIX}ctx_skill,${TOOL_PREFIX}ctx_memory`,
                ],
                { cwd: demo, env: { MAGIC_CONTEXT_CAPTURE_AFTER: "2" }, timeoutMs: 600_000 },
            );
            runs.push(changed);
            const feedbackIndex = changed.events.findIndex(
                (event: Json) =>
                    event.type === "user" &&
                    Array.isArray(event.message?.content) &&
                    event.message.content.some(
                        (block: Json) =>
                            block.type === "text" &&
                            String(block.text).includes("Magic Context capture"),
                    ),
            );
            const afterFeedback = feedbackIndex < 0 ? [] : changed.events.slice(feedbackIndex + 1);
            const captureTools = afterFeedback.flatMap((event: Json) =>
                event.type === "assistant"
                    ? event.message.content
                          .filter((block: Json) => block.type === "tool_use")
                          .map((block: Json) => block.name)
                    : [],
            );
            check(
                "after verified work the Stop hook has the session's own model capture it",
                feedbackIndex >= 0 &&
                    captureTools.some((name: string) => /ctx_(skill|memory)$/.test(name)),
                `feedback at ${feedbackIndex}; tools after it: ${captureTools.join(", ")}; final: ${changed.final?.result}`,
            );
            check(
                "the operation skill is updated to the changed flow",
                JSON.stringify(readSkills(demo)) !== before,
                JSON.stringify(readSkills(demo)).slice(0, 1500),
            );
        } finally {
            server.stop();
        }
    }

    try {
        // Session 1: the model records a project rule.
        const first = claude(
            `Use the ctx_memory tool to save this project rule: "Release tags are signed with the key in ${keyPath}; never push an unsigned tag." Then reply DONE.`,
            ["--allowedTools", `${TOOL_PREFIX}ctx_memory`],
        );
        const init = first.events.find(
            (event) => event.type === "system" && event.subtype === "init",
        );
        check(
            "Claude Code connects the plugin's MCP server",
            init?.mcp_servers?.some(
                (server: Json) =>
                    server.name === "plugin:magic-context:magic-context" &&
                    server.status === "connected",
            ) === true,
            JSON.stringify(init?.mcp_servers),
        );
        const startHook = first.events.find(
            (event) =>
                event.subtype === "hook_response" && event.hook_name === "SessionStart:startup",
        );
        check(
            "SessionStart hook runs and returns context",
            startHook?.exit_code === 0 && String(startHook.output).includes("additionalContext"),
            JSON.stringify(startHook),
        );
        check(
            "session 1 saves the rule with ctx_memory",
            first.toolUses.some((use: Json) => use.name === `${TOOL_PREFIX}ctx_memory`) &&
                first.toolResults.some((block: Json) => resultText(block).includes("Saved memory")),
            JSON.stringify(first.toolResults).slice(0, 1000) + first.stderr,
        );

        // Session 2: a new session knows the rule without any tool call.
        const second = claude(
            "Without using any tools: what key file must release tags in this project be signed with? Answer with the path.",
            ["--disallowedTools", `Bash,Read,Grep,Glob,${TOOL_PREFIX}ctx_search`],
        );
        check(
            "session 2 recalls it from the injected memory",
            String(second.final?.result ?? "").includes(keyPath) && second.toolUses.length === 0,
            `${second.final?.result}\ntools: ${second.toolUses.map((use: Json) => use.name)}`,
        );

        // Session 3: a fact said in conversation survives Claude Code's own compaction.
        const told = claude(
            `For this conversation only (do not save it anywhere): the canary host this sprint is ${host}. Reply OK.`,
        );
        const sid = told.final?.session_id as string | undefined;
        if (!sid) throw new Error(`no session id: ${told.stderr}`);
        claude("Unrelated: in one sentence, what does git rebase do?", ["--resume", sid]);
        const compacted = claude("/compact", ["--resume", sid]);
        const compactHook = compacted.events.find(
            (event) =>
                event.subtype === "hook_response" && event.hook_name === "SessionStart:compact",
        );
        check(
            "after /compact the hook re-injects context",
            compactHook?.exit_code === 0 && String(compactHook.output).includes("just compacted"),
            JSON.stringify(compactHook ?? compacted.events.map((event) => event.subtype)),
        );
        const recalled = claude(
            "Call ctx_search with sources [\"message\"] and the query 'what is the canary host this sprint?', then call ctx_expand with message set to the ordinal of the best hit. Reply with the host name.",
            [
                "--resume",
                sid,
                "--allowedTools",
                `${TOOL_PREFIX}ctx_search,${TOOL_PREFIX}ctx_expand`,
            ],
        );
        // Tool results in call order: the search first, then any expand.
        const resultsByTool = (run: typeof recalled, tool: string) =>
            run.toolUses
                .filter((use: Json) => use.name === `${TOOL_PREFIX}${tool}`)
                .map((use: Json) =>
                    resultText(
                        run.toolResults.find((block: Json) => block.tool_use_id === use.id) ?? {},
                    ),
                )
                .join("\n");
        const searchResult = resultsByTool(recalled, "ctx_search");
        check(
            "ctx_search finds the message Claude Code compacted away",
            searchResult.includes(host),
            searchResult.slice(0, 1500) || JSON.stringify(recalled.toolUses),
        );
        // Haiku sometimes answers from the search hit and skips the expand call;
        // then ask for that one call explicitly.
        let expandResult = resultsByTool(recalled, "ctx_expand");
        runs.push(first, second, told, compacted, recalled);
        if (!expandResult) {
            const ordinal = searchResult.match(/ordinal=(\d+)/)?.[1] ?? "1";
            const expanded = claude(
                `Call the ctx_expand tool with message=${ordinal} and nothing else, then reply with the host name it shows.`,
                ["--resume", sid, "--allowedTools", `${TOOL_PREFIX}ctx_expand`],
            );
            runs.push(expanded);
            expandResult = resultsByTool(expanded, "ctx_expand");
        }
        check(
            "ctx_expand returns the compacted message's original wording",
            expandResult.includes(`the canary host this sprint is ${host}`),
            expandResult.slice(0, 1500),
        );
        await runOperationSkillChecks();
        const cost = runs
            .map((run) => Number(run.final?.total_cost_usd ?? 0))
            .reduce((sum, value) => sum + value, 0);
        pass("live checks finished", `about $${cost.toFixed(3)}`);
    } catch (error) {
        fail("live sessions", String(error));
    } finally {
        // Remove what the live sessions left in the real Claude Code config dir.
        for (const directory of new Set(projects.flatMap((dir) => [dir, realpathSync(dir)]))) {
            rmSync(join(realConfig, "projects", encodeProjectDirectory(directory)), {
                recursive: true,
                force: true,
            });
        }
        for (const id of sessionIds) {
            if (/^[A-Za-z0-9-]+$/.test(id)) {
                rmSync(join(realConfig, "session-env", id), { recursive: true, force: true });
            }
        }
        if (!pluginDataExisted) rmSync(pluginDataDir, { recursive: true, force: true });
    }
}

// ── 7. live Claude Code sessions ─────────────────────────────────────────────

section("7. Live Claude Code sessions (--live)");
if (!args.has("--live")) {
    skip("live sessions", "pass --live to run real `claude -p` sessions (Haiku)");
} else if (!claudeAvailable) {
    skip("live sessions", "the claude CLI is not on PATH");
} else {
    await runLiveChecks();
}

// ── summary ──────────────────────────────────────────────────────────────────

if (failures === 0) rmSync(root, { recursive: true, force: true });
else console.log(`\nKept ${root} for inspection.`);
console.log(
    `\n${failures === 0 ? "SMOKE PASSED" : `SMOKE FAILED: ${failures} check(s)`}${skips ? `, ${skips} skipped` : ""}`,
);
process.exit(failures === 0 ? 0 : 1);
