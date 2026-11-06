import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Keep configuration, log and SQLite probes away from the operator's stores.
const root = mkdtempSync(join(tmpdir(), "mc-perf-v2-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    process.env[key] = join(root, key);
    mkdirSync(process.env[key]!, { recursive: true });
}
process.env.MAGIC_CONTEXT_STORAGE_DIR = join(root, "mc");
const { V2StoreReader, V2StoreReaderPool, getV2StoreReaderDebugCounters } = await import("../../src/v2/store-reader");
const { isAdmittedSynthetic, syntheticCandidates } = await import("../../src/v2/hooks/channel2");
const { startUpdateChecks } = await import("../../src/v2/hooks/update-check");
const { FoldOwner } = await import("../../src/v2/fold/owner");
const { adaptPayload } = await import("../../src/v2/hooks/payload");
const { generateReplayAnchor, V2GenerateReplay } = await import("../../src/v2/hooks/generate");
const { RestoredRowCache } = await import("../../src/v2/hooks/restore-rows");
const { recordV2ToolDefinitions } = await import("../../src/v2/hooks/context");
const { sanitizeDiagnosticText, sanitizeConfigValue } = await import("../../src/shared/redaction");
const { loadPluginConfigDetailed } = await import("../../src/config");
const { MagicContextRpcClient } = await import("../../src/shared/rpc-client");
const { MagicContextRpcServer } = await import("../../src/shared/rpc-server");
const { setupWithJsx } = await import("../../src/v2/tui/index");
import type { V2TuiContext } from "../../src/v2/tui/types";
type Draft = Parameters<typeof adaptPayload>[0];

async function measure(name: string, passes: number, run: () => unknown) {
    await run();
    const start = performance.now();
    for (let i = 0; i < passes; i++) await run();
    console.log(`${name}: ${((performance.now() - start) / passes).toFixed(3)} ms/pass (${passes} passes)`);
}

const versionDB = new Database(":memory:");
const sqliteVersion = versionDB.query<{ v: string }, []>("select sqlite_version() as v").get()?.v;
versionDB.close();
console.log(`bun=${Bun.version} sqlite=${sqliteVersion} platform=${process.platform}`);
try {
    for (const size of [1000, 10000, 60000]) {
        const path = join(root, `${size}.db`);
        const writer = new Database(path);
        writer.exec(`PRAGMA journal_mode=WAL;
            CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
            CREATE INDEX session_message_session_seq ON session_message(session_id, seq);
            CREATE INDEX session_message_session_type_seq ON session_message(session_id, type, seq);
            CREATE TABLE session_v2(id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT);`);
        const insert = writer.prepare("INSERT INTO session_message VALUES (?, 's', ?, ?, 0, 0, ?)");
        const text = "A realistic message with code and tool output. ".repeat(24);
        writer.transaction(() => {
            for (let i = 1; i <= size; i++) insert.run(`m${i}`, i % 2 ? "user" : "assistant", i, JSON.stringify({ content: [{ type: "text", text }], tokens: { input: 1000 }, finish: "stop" }));
        })();
        const reader = new V2StoreReader(path);
        const storageDB = new Database(join(root, `${size}-storage.db`));
        storageDB.exec("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT)");
        const get = storageDB.query("SELECT value FROM kv WHERE key = ?");
        const set = storageDB.query("INSERT OR REPLACE INTO kv VALUES (?, ?)");
        let reads = 0, writes = 0;
        const storage = {
            get: async (key: string) => { reads++; const row = get.get(key) as { value: string } | null; return row ? JSON.parse(row.value) : undefined; },
            set: async (key: string, value: unknown) => { writes++; set.run(key, JSON.stringify(value)); },
        };
        await measure(`V2-1 ${size} admission reads`, 3, async () => { for (let i = 1; i <= size; i++) await isAdmittedSynthetic({ storage }, "s", `m${i}`); });
        console.log(`V2-1 storage reads=${reads}`);
        reads = 0;
        await measure(`V2-1 ${size} SQL candidate filter`, 3, async () => {
            const candidates = syntheticCandidates({ storage }, "s", reader.syntheticMessageIDs("s"));
            for (let i = 1; i <= size; i++) { const id = `m${i}`; if (candidates.has(id)) await isAdmittedSynthetic({ storage }, "s", id); }
        });
        console.log(`V2-1 filtered storage reads=${reads}`);
        await measure(`V2-2 ${size} reopen+point`, 100, () => { const r = new V2StoreReader(path); try { return r.sequenceForId("s", "m1"); } finally { r.close(); } });
        await measure(`V2-2 ${size} held+point`, 100, () => reader.sequenceForId("s", "m1"));
        const pool = new V2StoreReaderPool();
        await measure(`V2-2 ${size} pooled lease+point`, 100, () => { const r = pool.open(path); try { return r.sequenceForId("s", "m1"); } finally { r.close(); } });
        await measure(`V2-4 ${size} stamps`, 5, () => reader.spanRowStamps("s", 0, size));
        const cast = writer.query("SELECT seq, id, time_updated, length(CAST(data AS BLOB)) AS bytes FROM session_message WHERE session_id='s' ORDER BY seq");
        const octet = writer.query("SELECT seq, id, time_updated, octet_length(data) AS bytes FROM session_message WHERE session_id='s' ORDER BY seq");
        await measure(`V2-4 ${size} CAST query`, 5, () => cast.all());
        await measure(`V2-4 ${size} octet query`, 5, () => octet.all());
        const restored = new RestoredRowCache();
        restored.rows(reader, "s", 0, size);
        const beforeRestore = getV2StoreReaderDebugCounters().decodedRows;
        await measure(`V2-4 ${size} warm restore`, 3, () => restored.rows(reader, "s", 0, size));
        console.log(`V2-4 warm restore decoded rows=${getV2StoreReaderDebugCounters().decodedRows - beforeRestore}`);
        const draft: Draft = { sessionID: "s", model: { providerID: "p", id: "m" }, agent: "build", system: [], tools: {}, options: {}, messages: Array.from({ length: size }, (_, i) => ({ id: `m${i}`, role: "user", content: [{ type: "text", text }] })) };
        await measure(`V2-6 ${size} adapt+commit`, 3, () => adaptPayload({ ...draft, messages: [...draft.messages] }).commit());
        const replay = new V2GenerateReplay();
        await measure(`V2-6/7 ${size} replay capture`, 3, () => replay.capture(draft, generateReplayAnchor(draft.messages)));
        console.log(`V2-7 ${size} retained replay serialized messages=${Buffer.byteLength(JSON.stringify(draft.messages))} bytes/session (not a heap estimate)`);
        const memoryReplay = new V2GenerateReplay();
        Bun.gc(true);
        const heapBefore = process.memoryUsage().heapUsed;
        memoryReplay.capture(draft, generateReplayAnchor(draft.messages));
        Bun.gc(true);
        const heapCaptured = process.memoryUsage().heapUsed;
        memoryReplay.forget("s");
        Bun.gc(true);
        console.log(`V2-7 ${size} capture heap delta=${heapCaptured - heapBefore} bytes; forget released=${heapCaptured - process.memoryUsage().heapUsed} bytes (GC-sensitive)`);
        const owner = new FoldOwner(storage);
        const summary = text.repeat(10);
        const rendered = { id: "cut", role: "user", content: [{ type: "text", text: summary }] };
        await owner.supply({ sessionID: "s", watermark: size, materialize: () => summary });
        await owner.observe({ sessionID: "s", cutSeq: size + 1, summary, rendered, onHard: () => {} });
        const beforeWrites = writes;
        await measure(`V2-8 ${size} unchanged observe`, 20, () => owner.observe({ sessionID: "s", cutSeq: size + 1, summary, rendered, onHard: () => {} }));
        console.log(`V2-8 unchanged writes=${writes - beforeWrites}`);
        await measure(`V2-9 ${size} poll pair reopen`, 100, () => { const r = new V2StoreReader(path); try { r.latestAssistant("s"); r.latestIdle("s"); } finally { r.close(); } });
        await measure(`V2-9 ${size} poll pair pooled`, 100, () => { const r = pool.open(path); try { r.latestAssistant("s"); r.latestIdle("s"); } finally { r.close(); } });
        await measure(`V2-14 ${size} ordinal`, 20, () => reader.messageOrdinalById("s", `m${size}`));
        await measure(`V2-14 ${size} late ordinal range`, 20, () => reader.messageIdOrdinals("s", size - 99, size));
        await measure(`V2-14 ${size} latestAssistant`, 100, () => reader.latestAssistant("s"));
        await measure(`V2-14 ${size} latestCompaction`, 100, () => reader.latestCompaction("s"));
        console.log(`V2-14 plan=${JSON.stringify(writer.query("EXPLAIN QUERY PLAN SELECT id FROM session_message WHERE session_id='s' AND type IN ('user','assistant') ORDER BY seq LIMIT 100 OFFSET 59900").all())}`);
        reads = 0;
        await measure(`V2-3 ${size} events`, 1, async () => {
            await storage.set("version-check-at", Date.now());
            const checks = startUpdateChecks({ storage, event: { subscribe: async function* () { for (let i = 0; i < size; i++) yield {}; } } }, async () => null);
            await checks.done;
        });
        console.log(`V2-3 storage reads=${reads}`);
        pool.close(); reader.close(); writer.close(); storageDB.close();
    }
    const toolDraft: Draft = { sessionID: "t", model: { providerID: "perf", id: "m" }, agent: "build", system: [], messages: [], options: {}, tools: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`t${i}`, { description: "tool description ".repeat(40), input: { type: "object", properties: Object.fromEntries(Array.from({ length: 20 }, (_, j) => [`p${j}`, { type: "string", description: "parameter documentation" }])) } }])) };
    class Asset { bytes = new Uint8Array(1024 * 1024); }
    const mediaDraft = { ...toolDraft, tools: {}, messages: Array.from({ length: 10 }, (_, i) => ({ id: `asset${i}`, role: "user", content: [{ type: "media", media: new Asset() }] })) };
    await measure("V2-6 10 class-backed 1MiB assets adapt+commit", 5, () => adaptPayload({ ...mediaDraft, messages: [...mediaDraft.messages] }).commit());
    await measure("V2-11 40 tools/20 properties", 100, () => recordV2ToolDefinitions(toolDraft));
    await measure("V2-12 22 log lines", 100, () => { for (let i = 0; i < 22; i++) sanitizeDiagnosticText("[transform] timing /tmp/example 1.25 ms"); });
    await measure("V2-12 50 objects", 100, () => sanitizeConfigValue(Array.from({ length: 50 }, () => ({ path: "/tmp/example", message: "safe diagnostic text" }))));
    const configDir = join(root, "project"); mkdirSync(join(configDir, ".cortexkit"), { recursive: true });
    writeFileSync(join(configDir, ".cortexkit/magic-context.jsonc"), '{"dreamer":{"disable":true}}');
    await measure("V2-13 three boot loads", 20, () => { for (let i = 0; i < 3; i++) loadPluginConfigDetailed(configDir, false); });
    const rpc = new MagicContextRpcClient(join(root, "mc"), configDir);
    await measure("V2-5 unavailable startup RPC", 1, () => rpc.call("config.get", {}).catch(() => null));
    const tuiSource = readFileSync(new URL("../../src/tui/index.tsx", import.meta.url), "utf8");
    const register = "api.slots.register(sidebarSlot)";
    const begin = tuiSource.indexOf("initRpcClient(directory)");
    const startup = tuiSource.slice(begin, tuiSource.indexOf(register, begin) + register.length);
    for (const [label, fragment] of [["baseline await", startup.replace("void refreshToastDurationMs()", "await refreshToastDurationMs()")], ["current", startup]]) {
        let registeredAt = -1;
        const start = performance.now();
        // Evaluate the actual registration block, giving RPC a controlled 50ms delay.
        const run = new Function("initRpcClient", "directory", "refreshToastDurationMs", "createSidebarContentSlot", "api", `return (async () => { ${fragment} })()`);
        await run(() => {}, configDir, () => new Promise(resolve => setTimeout(resolve, 50)), () => ({}), { slots: { register() { registeredAt = performance.now() - start; } } });
        if (registeredAt < 0) throw new Error("Startup probe did not register the sidebar");
        console.log(`V2-5 ${label} registration with 50ms RPC: ${registeredAt.toFixed(3)} ms`);
    }
    const rpcServer = new MagicContextRpcServer(join(root, "mc"), configDir);
    let snapshots = 0;
    rpcServer.handle("sidebar-snapshot", async () => { snapshots++; return { sessionId: "s" }; });
    await rpcServer.start();
    let listener: ((event: { details: unknown }) => void) | undefined;
    const tui: V2TuiContext = {
        location: { directory: configDir }, renderer: { requestRender() {} },
        data: { location: { default: () => ({ directory: configDir }) }, listen: (handler) => { listener = handler; return () => {}; } },
        keymap: { layer() {} },
        storage: { memory: <T extends object>(_key: string, options: { initial: T }) => [options.initial, (mutation: (draft: T) => void) => mutation(options.initial)] as const },
        ui: { router: { current: () => ({ type: "session", sessionID: "s" }) }, slot: () => () => {}, toast: { show() {} }, dialog: { async alert() {}, async confirm() { return false; } } },
    };
    const cleanup = await setupWithJsx(tui, () => null);
    try {
        for (const size of [1000, 10000, 60000]) {
            const start = performance.now(), before = snapshots;
            for (let i = 0; i < size; i++) listener?.({ details: { type: "session.status", data: { sessionID: "s" } } });
            // Drain local RPC I/O once, rather than measuring only its scheduling.
            await rpc.resolveEndpoint();
            await new Promise(resolve => setTimeout(resolve, 100));
            console.log(`V2-10 ${size} event burst: ${(performance.now() - start - 100).toFixed(3)} ms dispatch/I/O, ${snapshots - before} snapshot RPCs`);
        }
    } finally { cleanup(); rpcServer.stop(); }
    if (process.argv[2]) {
        for (const [label, path] of [["baseline bundle", process.argv[2]], ["current bundle", new URL("../../dist/index.js", import.meta.url).pathname]]) {
            const times: number[] = [];
            for (let i = 0; i < 5; i++) {
                const child = spawnSync(process.execPath, ["-e", `const t=performance.now(); await import(${JSON.stringify(resolve(path!))}); console.log(performance.now()-t)`], { env: process.env, encoding: "utf8", timeout: 30000 });
                if (child.status !== 0) throw new Error(child.stderr);
                times.push(Number(child.stdout.trim()));
            }
            times.sort((a,b) => a-b);
            console.log(`V2-16 ${label} cold import median=${times[2]?.toFixed(3)} ms, runs=${times.map(t=>t.toFixed(3)).join(",")}`);
        }
    } else console.log("V2-16: pass a preserved baseline dist/index.js to compare cold bundle imports");
    console.log("V2-15 Windows tasklist unavailable on this platform; no Windows cost inferred.");
} finally { rmSync(root, { recursive: true, force: true }); }
