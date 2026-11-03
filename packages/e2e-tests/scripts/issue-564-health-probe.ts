import { openTestDb } from "../src/test-db";
// Probe OpenCode HTTP latency while a synthetic history backlog is embedded.
// The e2e harness starts a local mock LLM, isolated host roots and a local
// embeddings endpoint; the lsof check refuses any live-store file descriptor.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TestHarness } from "../src/harness";
import { backfillMessageFtsRowidMapBatch, recordMessageFtsRowid } from "../../plugin/src/features/magic-context/message-fts-rowid-map";
import { recordSessionProjectIdentity } from "../../plugin/src/features/magic-context/session-project-storage";
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";

const root = process.env.MC_ISSUE_564_ROOT;
if (!root || root !== process.env.TMPDIR || !root.includes("/magic-context/")) {
    throw new Error("Set TMPDIR and MC_ISSUE_564_ROOT to the same throwaway task root");
}
const embedded: string[] = [];
const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
        if (!new URL(request.url).pathname.endsWith("/embeddings")) return new Response("not found", { status: 404 });
        const body = (await request.json()) as { input?: string[] };
        const inputs = body.input ?? [];
        embedded.push(...inputs);
        return Response.json({ model: "mock-issue-564", data: inputs.map((_, index) => ({
            index, embedding: [0.5, 0.25, 0.75],
        })) });
    },
});
let h: TestHarness | undefined;
try {
    h = await TestHarness.create({ magicContextConfig: {
        embedding: { provider: "openai-compatible", endpoint: `http://127.0.0.1:${server.port}/v1`, model: "mock-issue-564" },
        memory: { enabled: false }, dreamer: { disable: true },
    } });
    const pid = h.opencode.pid;
    if (!pid) throw new Error("Missing OpenCode PID");
    const opened = execFileSync("lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8" });
    const live = [".local/share/opencode", ".local/share/cortexkit/magic-context", ".config/opencode", ".config/cortexkit", ".pi/agent"].map(path => join(homedir(), path));
    const forbidden = opened.split("\n").filter(line => line.startsWith("n/") && live.some(path => line.slice(1).startsWith(`${path}/`)));
    if (forbidden.length || !realpathSync(h.dataDir).startsWith(`${realpathSync(root)}/`)) {
        throw new Error(`Store isolation failed: ${forbidden.join(", ")} host=${h.dataDir}`);
    }
    console.log(`lsof verified pid=${pid} forbidden=0 root=${h.dataDir}`);
    const sessionId = await h.createSession();
    const db = openTestDb(h.contextDbPath());
    // Use the same synthetic source and FTS mapping that the session drain reads.
    recordSessionProjectIdentity(db, sessionId, resolveProjectIdentity(h.workdir));
    const insert = db.prepare(`INSERT INTO compartments (session_id,sequence,start_message,end_message,title,content,p1,created_at)
        VALUES (?,?,?,?,?,?,?,?)`);
    const fts = db.prepare(`INSERT INTO message_history_fts (session_id,message_ordinal,message_id,role,content)
        VALUES (?,?,?,'user',?)`);
    const text = "Synthetic archived discussion about a reversible local operation. ".repeat(12);
    db.transaction(() => {
        for (let ordinal = 1; ordinal <= 1500; ordinal++) {
            insert.run(sessionId, ordinal, ordinal, ordinal, `History ${ordinal}`, text, text, Date.now());
            const result = fts.run(sessionId, ordinal, `history-${ordinal}`, text);
            recordMessageFtsRowid(db, sessionId, ordinal, result.lastInsertRowid);
        }
    })();
    while (!backfillMessageFtsRowidMapBatch(db, 500).completed) { /* Complete the synthetic FTS mapping before embedding. */ }
    db.close();
    let maxHealthMs = 0;
    let catchupMaxHealthMs = 0;
    let catchupPhase = false;
    let healthCalls = 0;
    let stop = false;
    let drainElapsedMs = 0;
    const poll = (async () => {
        while (!stop) {
            const start = performance.now();
            const response = await fetch(`${h!.serverUrl}/health`);
            await response.text();
            const elapsed = performance.now() - start;
            maxHealthMs = Math.max(maxHealthMs, elapsed);
            if (catchupPhase) catchupMaxHealthMs = Math.max(catchupMaxHealthMs, elapsed);
            healthCalls++;
            await Bun.sleep(20);
        }
    })();
    try {
        await h.sendPrompt(sessionId, "A new message after archived history", { timeoutMs: 120_000 });
        catchupPhase = true;
        const drainStart = performance.now();
        while (performance.now() - drainStart < 90_000) {
            await Bun.sleep(1_000);
            const probe = openTestDb(h.contextDbPath(), { readonly: true });
            const row = probe.prepare("SELECT COUNT(DISTINCT compartment_id) AS n FROM compartment_chunk_embeddings WHERE session_id = ?").get(sessionId) as { n: number };
            probe.close();
            if (row.n >= 1500) break;
        }
        drainElapsedMs = performance.now() - drainStart;
    } finally {
        stop = true;
        await poll;
    }
    const inspection = openTestDb(h.contextDbPath(), { readonly: true });
    const mapping = inspection.prepare("SELECT session_id, project_path FROM session_projects WHERE session_id = ?").all(sessionId);
    const counts = inspection.prepare("SELECT (SELECT COUNT(*) FROM compartments WHERE session_id = ?) AS compartments, (SELECT COUNT(*) FROM compartment_chunk_embeddings WHERE session_id = ?) AS vectors").get(sessionId, sessionId);
    inspection.close();
    console.log(JSON.stringify({ hostPid: pid, healthCalls, maxHealthMs, catchupMaxHealthMs, drainElapsedMs, embeddedChunks: embedded.length, mapping, counts }));
} finally {
    await h?.dispose();
    server.stop(true);
}
