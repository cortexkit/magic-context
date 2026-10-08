/**
 * Measure how many bytes a real ck-mc writes per transform pass.
 *
 * Runs a private ck-subc daemon and ck-mc module against APFS clones of the stores,
 * drives transform passes through the plugin's real Rust-mode transform, and records
 * per pass: the module's disk-write counter, the WAL frames each pass appended to
 * store.db and context.db, and which table or index owns every written page.
 *
 * Nothing here opens a live store. The caller prepares PROBE_RUN with:
 *   data/cortexkit/magic-context/{store.db,context.db}   clones of the stores
 *   oc/opencode.db                                        clone of the OpenCode store
 *   bin/{ckdev-mc,ckdev-subc}                             dev-named copies under test
 * See README.md in this directory for the exact preparation commands.
 *
 * Environment:
 *   PROBE_RUN       run directory (required)
 *   PROBE_SESSION   session to replay (required)
 *   PROBE_PLAN      comma-separated pass kinds (default below)
 *   PROBE_PIN=1     hold a read snapshot on both stores so no checkpoint resets the WAL;
 *                   this makes frame attribution exact but defers checkpoint writes
 *   PROBE_BROCA=1   start the hermetic historian producer so historian runs can publish
 *   PROBE_OUT       JSONL output path (default $PROBE_RUN/passes.jsonl)
 *   PROBE_CLOCK_BASE_MS  fixed clock for the synthetic messages' ids and timestamps, so the
 *                   served_sha256 of two runs can be compared
 *   PROBE_SQL_TRACE=1  record every write statement this process (the plugin) runs against
 *                   context.db to $PROBE_RUN/sqltrace.jsonl, with the pass it ran in and the
 *                   WAL frames it appended (exact for autocommit statements under PROBE_PIN=1)
 */
import { Database as BunDatabase } from "bun:sqlite";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const TOOLS = import.meta.dir;
const RUN = mustEnv("PROBE_RUN");
const SESSION = mustEnv("PROBE_SESSION");
const PLAN = (
    process.env.PROBE_PLAN ??
    "first,defer,defer,newmsg,newmsg,newmsg,newmsg,newmsg,execute,defer,newmsg,newmsg,rebuild,defer,newmsg,wait_historian,newmsg"
).split(",");
const OUT = process.env.PROBE_OUT ?? join(RUN, "passes.jsonl");
const DATA = join(RUN, "data");
const MC_DIR = join(DATA, "cortexkit", "magic-context");
const STORE_DB = join(MC_DIR, "store.db");
const CONTEXT_DB = join(MC_DIR, "context.db");
const RUNTIME_DIR = join(DATA, "cortexkit", "run");
const CONNECTION_FILE = join(RUNTIME_DIR, "subc-connection.json");
const HOME = join(RUN, "home");

function mustEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

// The plugin reads its data paths from the environment when it is imported, so point them
// at this run directory before any plugin module is loaded.
process.env.XDG_DATA_HOME = DATA;
process.env.XDG_CONFIG_HOME = join(RUN, "plugin-config");
process.env.MAGIC_CONTEXT_STORAGE_DIR = MC_DIR;
process.env.OPENCODE_DB = join(RUN, "oc", "opencode.db");
// The plugin logger writes under the temp directory; keep it out of the operator's log.
process.env.TMPDIR = join(RUN, "tmp");
mkdirSync(process.env.TMPDIR, { recursive: true });

/** Index of the plan entry being replayed, so each SQL write-trace entry names its pass. */
let currentPass: number | string = "boot";
const SQL_TRACE = join(RUN, "sqltrace.jsonl");
const WAL_FRAME_BYTES = 4096 + 24;

/**
 * Wrap bun:sqlite so every write statement against context.db is logged. The plugin reaches
 * SQLite only through `Database` from shared/sqlite, which is bun:sqlite under Bun, so
 * patching the prototype sees every statement it runs. Frames are the growth of the
 * context.db WAL across the statement: exact for an autocommit statement while a pinned
 * reader stops the WAL from resetting, and zero for a statement inside a transaction, whose
 * frames land at its COMMIT.
 */
function installSqlTrace(): void {
    const walSize = (): number => statSync(`${CONTEXT_DB}-wal`, { throwIfNoEntry: false })?.size ?? 0;
    const byteLength = (value: unknown): number =>
        typeof value === "string" ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.length : 8;
    const columnsOf = (sql: string): string[] => {
        const set = sql.match(/\bSET\b([\s\S]*?)(\bWHERE\b|$)/i)?.[1];
        if (set) return [...set.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map((m) => m[1]);
        const insert = sql.match(/\bINTO\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)/i)?.[1];
        return insert ? insert.split(",").map((c) => c.trim()) : [];
    };
    // For every bound string of 64 KiB or more, how much of it the same statement's previous
    // run already wrote: the common prefix, and how many 64 KiB positional chunks differ. This
    // is what a chunked layout for the plugin's large columns would have to rewrite.
    const CHUNK_CHARS = 64 * 1024;
    const previousLarge = new Map<string, string>();
    const largeDiffs = (sql: string, values: unknown[]): unknown[] =>
        values.flatMap((value, index) => {
            if (typeof value !== "string" || value.length < CHUNK_CHARS) return [];
            const key = `${sql}\u0000${index}`;
            const previous = previousLarge.get(key);
            previousLarge.set(key, value);
            if (previous === undefined) return [{ index, chars: value.length, previous_chars: null }];
            let common = 0;
            const limit = Math.min(previous.length, value.length);
            while (common < limit && previous.charCodeAt(common) === value.charCodeAt(common)) common++;
            const chunks = Math.ceil(value.length / CHUNK_CHARS);
            let changedChunks = 0;
            for (let chunk = 0; chunk < chunks; chunk++) {
                const start = chunk * CHUNK_CHARS;
                if (value.slice(start, start + CHUNK_CHARS) !== previous.slice(start, start + CHUNK_CHARS)) changedChunks++;
            }
            return [{ index, chars: value.length, previous_chars: previous.length, common_prefix_chars: common, chunks, changed_chunks: changedChunks }];
        });
    const log = (db: BunDatabase, sql: string, args: unknown[], run: () => unknown): unknown => {
        const before = walSize();
        const inTransaction = db.inTransaction;
        const result = run() as { changes?: number } | undefined;
        const flat = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
        const large = largeDiffs(sql, flat);
        appendFileSync(
            SQL_TRACE,
            `${JSON.stringify({
                pass: currentPass,
                table: sql.match(/\b(?:INTO|UPDATE|FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/i)?.[1] ?? "?",
                in_transaction: inTransaction,
                frames: (walSize() - before) / WAL_FRAME_BYTES,
                param_bytes: flat.reduce((sum: number, value) => sum + byteLength(value), 0),
                columns: columnsOf(sql),
                changes: result?.changes ?? null,
                large,
                sql: sql.replace(/\s+/g, " ").slice(0, 160),
            })}\n`,
        );
        return result;
    };
    const isWrite = (db: BunDatabase, sql: string): boolean =>
        db.filename.endsWith("context.db") && /^\s*(INSERT|UPDATE|REPLACE|DELETE)\b/i.test(sql);
    // biome-ignore lint/suspicious/noExplicitAny: patching bun:sqlite's runtime prototype.
    const proto = BunDatabase.prototype as any;
    // biome-ignore lint/suspicious/noExplicitAny: bun:sqlite statements are patched in place.
    const wrap = (db: BunDatabase, sql: string, statement: any): any => {
        if (!isWrite(db, sql) || statement.__probeTraced) return statement;
        const run = statement.run.bind(statement);
        statement.run = (...args: unknown[]) => log(db, sql, args, () => run(...args));
        statement.__probeTraced = true;
        return statement;
    };
    for (const method of ["prepare", "query"] as const) {
        const original = proto[method];
        proto[method] = function (this: BunDatabase, sql: string, ...rest: unknown[]) {
            return wrap(this, sql, original.call(this, sql, ...rest));
        };
    }
    const originalRun = proto.run;
    proto.run = function (this: BunDatabase, sql: string, ...args: unknown[]) {
        if (!isWrite(this, sql)) return originalRun.call(this, sql, ...args);
        return log(this, sql, args, () => originalRun.call(this, sql, ...args));
    };
}

const children: ChildProcess[] = [];
function cleanup(): void {
    for (const child of children) child.kill("SIGTERM");
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

function python(script: string, args: string[]): unknown {
    const result = spawnSync("python3", [join(TOOLS, script), ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${script} failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
}

function written(pid: number): number {
    const out = python("rusage.py", [String(pid)]) as Record<string, { written: number }>;
    return out[String(pid)].written;
}

/** Bytes of every non-database file under the data home: logs, sentinels, state files. */
function sideFileBytes(): number {
    let total = 0;
    const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            const stat = statSync(path, { throwIfNoEntry: false });
            if (!stat) continue;
            if (stat.isDirectory()) walk(path);
            else if (!/\.db(-wal|-shm)?$/.test(name)) total += stat.size;
        }
    };
    walk(DATA);
    return total;
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
    const started = Date.now();
    return new Promise((resolveWait, reject) => {
        const tick = (): void => {
            if (predicate()) return resolveWait();
            if (Date.now() - started > timeoutMs) return reject(new Error(`timeout: ${label}`));
            setTimeout(tick, 100);
        };
        tick();
    });
}

function startProcess(label: string, cmd: string, args: string[], env: Record<string, string>): ChildProcess {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    const log = join(RUN, `${label}.log`);
    child.stdout?.on("data", (chunk) => appendFileSync(log, chunk));
    child.stderr?.on("data", (chunk) => appendFileSync(log, chunk));
    children.push(child);
    return child;
}

async function main(): Promise<void> {
    if (process.env.PROBE_SQL_TRACE === "1") installSqlTrace();
    mkdirSync(RUNTIME_DIR, { recursive: true });
    mkdirSync(HOME, { recursive: true });
    const daemonConfig = join(DATA, "cortexkit", "_daemon-config");
    mkdirSync(join(daemonConfig, "cortexkit"), { recursive: true });
    // No configured modules: the daemon does not launch ck-mc; this script does.
    writeFileSync(join(daemonConfig, "cortexkit", "subc.jsonc"), JSON.stringify({ version: 1, modules: {} }));
    const moduleConfig = join(DATA, "module-config", "cortexkit");
    mkdirSync(moduleConfig, { recursive: true });
    // A minimal module config: historian runs go to the local test producer, and no
    // embedding or model endpoint from the operator's config can be reached.
    // The model name only has to exist for the historian to fire; the hermetic producer answers.
    writeFileSync(
        join(moduleConfig, "magic-context.jsonc"),
        JSON.stringify({ historian: { runner: "broca", module_model: "probe/historian" } }),
    );

    let reader: ChildProcess | null = null;
    if (process.env.PROBE_PIN === "1") {
        reader = startProcess("pin", "python3", [join(TOOLS, "pin.py"), STORE_DB, CONTEXT_DB], {});
        children.push(reader);
        await waitFor(() => existsSync(join(RUN, "pin.ready")), "pinned reader");
    }

    const daemon = startProcess("daemon", join(RUN, "bin", "ckdev-subc"), [], {
        HOME,
        XDG_RUNTIME_DIR: RUNTIME_DIR,
        XDG_CONFIG_HOME: daemonConfig,
        XDG_DATA_HOME: DATA,
        SUBC_PORT: "0",
        NO_COLOR: "1",
        SUBC_MODULE_ID: "",
        SUBC_LAUNCH_NONCE: "",
    });
    await waitFor(() => existsSync(CONNECTION_FILE), "daemon connection file");
    await Bun.sleep(200);
    const moduleStartFrames = frames();
    const module = startProcess("module", join(RUN, "bin", "ckdev-mc"), ["--subc", CONNECTION_FILE], {
        HOME,
        NO_COLOR: "1",
        SUBC_MODULE_ID: "magic-context",
        SUBC_LAUNCH_NONCE: "",
        XDG_CONFIG_HOME: join(DATA, "module-config"),
        XDG_DATA_HOME: DATA,
        MAGIC_CONTEXT_STORAGE_DIR: MC_DIR,
    });
    if (process.env.PROBE_BROCA === "1") {
        startProcess("broca", process.execPath, [join(REPO, "packages/e2e-tests/src/rust-runner/fake-broca.ts")], {
            HOME,
            BROCA_CONNECTION_FILE: CONNECTION_FILE,
            BROCA_LOG_PATH: join(RUN, "broca-internal.log"),
            XDG_DATA_HOME: DATA,
            SUBC_MODULE_ID: "",
            SUBC_LAUNCH_NONCE: "",
            NO_COLOR: "1",
        });
    }

    const { SubcModuleTransport } = await import(
        "../../packages/plugin/src/hooks/magic-context/module-transport"
    );
    const { createRustModeTransform } = await import(
        "../../packages/plugin/src/hooks/magic-context/rust-mode-transform"
    );
    const { Database } = await import("../../packages/plugin/src/shared/sqlite");
    const { getOrCreateSessionMeta } = await import(
        "../../packages/plugin/src/features/magic-context/storage-meta-session"
    );

    const { createTagger } = await import("../../packages/plugin/src/features/magic-context/tagger");

    const transport = new SubcModuleTransport(CONNECTION_FILE);
    // The session's own project directory: project identity decides which compartments and
    // memories the module reads, so a stand-in root makes it rebuild the session from zero.
    // ck-mc only reads this directory; every write goes to the cloned stores.
    const projectRoot = process.env.PROBE_PROJECT_ROOT ?? join(RUN, "project");
    mkdirSync(projectRoot, { recursive: true });
    await waitFor(() => true, "noop");
    for (let attempt = 0; ; attempt++) {
        try {
            await transport.call({
                sessionId: SESSION,
                projectRoot,
                method: "session.status",
                body: { method: "session.status", v: 1, session_id: SESSION },
            });
            break;
        } catch (error) {
            if (attempt > 300) throw error;
            await Bun.sleep(200);
        }
    }
    record({ kind: "module_start", note: "module boot and first status call", ...diff(moduleStartFrames, frames(), module.pid!, null) });

    const loadStarted = Date.now();
    // OpenCode hands the transform hook parts that carry their row identity (id, messageID,
    // sessionID) alongside the stored JSON; the module fingerprints blocks with them, so the
    // replayed array must carry them too or every pass reports identity drift.
    const opencode = new Database(process.env.OPENCODE_DB!);
    const messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = [];
    const byId = new Map<string, (typeof messages)[number]>();
    for (const row of opencode
        .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC")
        .all(SESSION) as Array<{ id: string; data: string }>) {
        const message = { info: { ...JSON.parse(row.data), id: row.id, sessionID: SESSION }, parts: [] };
        messages.push(message);
        byId.set(row.id, message);
    }
    for (const row of opencode
        .prepare("SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY message_id ASC, id ASC")
        .all(SESSION) as Array<{ id: string; message_id: string; data: string }>) {
        byId.get(row.message_id)?.parts.push({
            ...JSON.parse(row.data),
            id: row.id,
            messageID: row.message_id,
            sessionID: SESSION,
        });
    }
    // OpenCode hands the hook only the messages since the newest finished compaction: the
    // compaction request (a user message with a compaction part) whose summary reply exists.
    // Replaying the whole session instead makes the module treat the session as new.
    const summarized = new Set(
        messages.filter((m) => m.info.summary === true).map((m) => String(m.info.parentID)),
    );
    const cut = messages.findLastIndex(
        (m) =>
            m.info.role === "user" &&
            summarized.has(String(m.info.id)) &&
            m.parts.some((part) => part.type === "compaction"),
    );
    if (cut > 0) messages.splice(0, cut);
    console.log(`loaded ${messages.length} messages (from index ${cut}) in ${Date.now() - loadStarted} ms`);
    // The plugin's own OpenCode reader serves raw reads and ordinals from the run's clone of
    // opencode.db; synthetic steps are inserted into that clone so both views agree.
    function persist(message: { info: Record<string, unknown>; parts: Array<Record<string, unknown>> }): void {
        const { id, ...info } = message.info;
        const created = (info.time as { created: number }).created;
        opencode
            .prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
            .run(String(id), SESSION, created, created, JSON.stringify(info));
        for (const part of message.parts) {
            const { id: partId, ...data } = part;
            opencode
                .prepare(
                    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
                )
                .run(String(partId), String(id), SESSION, created, created, JSON.stringify(data));
        }
    }

    const lastAssistant = [...messages].reverse().find((m) => m.info.role === "assistant");
    const model = {
        providerID: String(lastAssistant?.info.providerID ?? "anthropic"),
        modelID: String(lastAssistant?.info.modelID ?? "claude-opus-5-5"),
    };
    const db = new Database(CONTEXT_DB);
    const contextUsageMap = new Map<string, unknown>();
    let lastResponse: Record<string, unknown> = {};
    const call = transport.call.bind(transport);
    transport.call = async (args: { method: string }) => {
        const response = await call(args as never);
        if (args.method === "transform") lastResponse = (response ?? {}) as Record<string, unknown>;
        return response;
    };
    const deps = {
        tagger: createTagger(),
        scheduler: {},
        contextUsageMap,
        db,
        protectedTokens: 4,
        clearReasoningAge: 50,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        directory: projectRoot,
        projectPath: projectRoot,
        memoryConfig: { enabled: false, injectionBudgetTokens: 1000, autoPromote: false },
        liveModelBySession: new Map([[SESSION, model]]),
        sessionDirectoryBySession: new Map(),
        transformMode: "rust",
        rustModeModuleClient: transport,
        // Any configured name arms the historian; the hermetic producer answers whatever it is.
        historianModel: "probe/historian",
    };
    const transform = createRustModeTransform(deps as never, { moduleClient: transport, projectRoot } as never);

    let synthetic = 0;
    function appendSynthetic(modelID = model.modelID): void {
        // One agent step shaped like the session's own traffic: an assistant message that
        // ran a read tool and got a few kilobytes back.
        synthetic += 1;
        // PROBE_CLOCK_BASE_MS pins the synthetic messages' ids and timestamps, so two runs of
        // the same plan on the same clone serve comparable bytes across binaries.
        const now = process.env.PROBE_CLOCK_BASE_MS
            ? Number(process.env.PROBE_CLOCK_BASE_MS) + synthetic * 60_000
            : Date.now();
        const id = `msg_probe${String(now).padStart(16, "0")}${String(synthetic).padStart(4, "0")}`;
        const message = {
            info: {
                id,
                role: "assistant",
                sessionID: SESSION,
                parentID: lastAssistant?.info.parentID,
                providerID: model.providerID,
                modelID,
                time: { created: now, completed: now + 1 },
                tokens: { input: 1, output: 200, reasoning: 0, cache: { read: 400_000, write: 1000 } },
            },
            parts: [
                { id: `prt_probe_a${synthetic}`, type: "step-start", messageID: id, sessionID: SESSION },
                {
                    id: `prt_probe_b${synthetic}`,
                    type: "tool",
                    callID: `call_probe_${synthetic}`,
                    tool: "read",
                    messageID: id,
                    sessionID: SESSION,
                    state: {
                        status: "completed",
                        input: { filePath: `src/probe_${synthetic}.rs` },
                        output: `probe output ${synthetic}\n${"fn line() {}\n".repeat(250)}`,
                        title: `src/probe_${synthetic}.rs`,
                        metadata: {},
                        time: { start: now, end: now + 1 },
                    },
                },
                { id: `prt_probe_c${synthetic}`, type: "step-finish", reason: "tool-calls", messageID: id, sessionID: SESSION },
            ],
        };
        persist(message);
        messages.push(message);
    }

    function setUsage(percentage: number, lastResponseTime: number): void {
        contextUsageMap.set(SESSION, {
            usage: { percentage, inputTokens: Math.round(percentage * 10_000) },
            updatedAt: lastResponseTime,
            lastResponseTime,
            hasUsageTokens: true,
        });
    }

    for (const [index, kind] of PLAN.entries()) {
        currentPass = index;
        const before = frames();
        const beforeSide = sideFileBytes();
        const now = Date.now();
        let lastResponseTime = now - 10_000;
        let percentage = 40;
        if (kind === "newmsg") appendSynthetic();
        if (kind === "execute") percentage = 80;
        // A model switch changes the render identity, which makes the module HARD-rebuild.
        if (kind === "hard") {
            model.modelID = `${model.modelID}-probe`;
            appendSynthetic(model.modelID);
        }
        // High pressure arms the historian; wait_historian then lets its run publish.
        if (kind === "historian") percentage = 85;
        if (kind === "rebuild") lastResponseTime = now - 6 * 60 * 60 * 1000;
        if (kind === "wait_historian") {
            // Give a historian run time to publish; the pass below observes the publish.
            await Bun.sleep(Number(process.env.PROBE_HISTORIAN_WAIT_MS ?? 20_000));
        }
        setUsage(percentage, lastResponseTime);
        const meta = getOrCreateSessionMeta(db, SESSION);
        meta.lastResponseTime = lastResponseTime;
        const output: { messages: unknown[] } = { messages: [] };
        const started = performance.now();
        let error: string | null = null;
        try {
            await transform.run(SESSION, messages as never, output, meta);
        } catch (caught) {
            error = String(caught);
        }
        const wallMs = performance.now() - started;
        // Let asynchronous follow-up work (historian scheduling, state writes) land.
        await Bun.sleep(Number(process.env.PROBE_SETTLE_MS ?? 1500));
        const after = frames();
        record({
            index,
            kind,
            wall_ms: Math.round(wallMs),
            error,
            served_messages: output.messages.length,
            // Byte identity of what the host would send: equal hashes across two binaries on
            // the same clone and plan are the wire-invariance evidence.
            served_sha256: new Bun.CryptoHasher("sha256").update(JSON.stringify(output.messages)).digest("hex"),
            response: summarize(lastResponse),
            side_file_bytes: sideFileBytes() - beforeSide,
            ...diff(before, after, module.pid!, daemon.pid!),
        });
    }
    currentPass = "end";
    if (process.env.PROBE_PIN === "1") {
        record({
            kind: "run_total_context_db",
            context_all: python("walattr.py", [CONTEXT_DB, "0", "--map"]),
            store_all: python("walattr.py", [STORE_DB, "0", "--map"]),
        });
    }
    transform.clearSession?.(SESSION);
    db.close();
}

interface FrameMark {
    store: number;
    context: number;
    module?: number;
    daemon?: number;
}

function walFrames(db: string): number {
    return (python("walattr.py", [db, "0"]) as { end_frame: number }).end_frame;
}

function frames(): FrameMark {
    return { store: walFrames(STORE_DB), context: walFrames(CONTEXT_DB) };
}

const moduleWritten = new Map<string, number>();
function diff(before: FrameMark, after: FrameMark, modulePid: number, daemonPid: number | null): Record<string, unknown> {
    const store = python("walattr.py", [STORE_DB, String(before.store), "--map"]);
    // Mapping context.db pages means a dbstat walk of a multi-gigabyte file, so passes record
    // only frame counts there; the run ends with one mapped attribution of every frame.
    const context = python("walattr.py", [CONTEXT_DB, String(before.context)]);
    const moduleNow = written(modulePid);
    const moduleDelta = moduleNow - (moduleWritten.get("module") ?? 0);
    moduleWritten.set("module", moduleNow);
    let daemonDelta: number | null = null;
    if (daemonPid !== null) {
        const daemonNow = written(daemonPid);
        daemonDelta = daemonNow - (moduleWritten.get("daemon") ?? daemonNow);
        moduleWritten.set("daemon", daemonNow);
    }
    const row = python("rowinfo.py", [STORE_DB, SESSION]);
    return { module_bytes_written: moduleDelta, daemon_bytes_written: daemonDelta, store, context, row };
}

function summarize(response: Record<string, unknown>): Record<string, unknown> {
    const pick: Record<string, unknown> = {};
    for (const key of ["decision", "pass_plan", "applied", "row_version", "defer_reason", "status", "error"]) {
        if (key in response) pick[key] = response[key];
    }
    const timings = response.timings as Record<string, unknown> | undefined;
    if (timings) pick.store_commit_ms = timings.store_commit;
    const diagnostics = response.diagnostics as Record<string, unknown> | undefined;
    if (diagnostics) pick.diagnostics_keys = Object.keys(diagnostics).slice(0, 20);
    pick.keys = Object.keys(response).slice(0, 40);
    return pick;
}

function record(entry: Record<string, unknown>): void {
    appendFileSync(OUT, `${JSON.stringify(entry)}\n`);
    const store = entry.store as { wal_bytes?: number } | undefined;
    console.log(
        `${String(entry.kind).padEnd(15)} module_written=${entry.module_bytes_written} store_wal=${store?.wal_bytes} row=${JSON.stringify(entry.row)}`,
    );
}

main().then(
    () => process.exit(0),
    (error) => {
        console.error(error);
        process.exit(1);
    },
);
