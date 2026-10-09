/** Synthetic-only auto-search profile. Never accepts a store path or reads host configuration. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getLogFilePath } from "../../src/shared/logger";
import { initializeDatabase } from "../../src/features/magic-context/storage-db";
import { runMigrations } from "../../src/features/magic-context/migrations";
import { insertMemory } from "../../src/features/magic-context/memory/storage-memory";
import { saveEmbedding } from "../../src/features/magic-context/memory/storage-memory-embeddings";
import { registerProjectEmbedding, embedTextForProject, unregisterProjectEmbedding } from "../../src/features/magic-context/memory/embedding";
import { unifiedSearch } from "../../src/features/magic-context/search";
import { withAutoSearchDeadline } from "../../src/hooks/magic-context/auto-search-deadline";
import { runAutoSearchHint } from "../../src/hooks/magic-context/auto-search-runner";
import { buildAutoSearchHint } from "../../src/hooks/magic-context/auto-search-hint";
import { searchAutoHint } from "../../src/hooks/magic-context/auto-search-worker-client";
import { Database } from "../../src/shared/sqlite";
import { createDatabaseTimer } from "../../../pi-plugin/scripts/experiments/perf/instrumentation";

const parent = join(tmpdir(), "magic-context", "auto-search-deadline");
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, "profile-"));
const logArgument = process.argv.find((value) => value.startsWith("--log-path="))?.slice("--log-path=".length);
process.env.MAGIC_CONTEXT_LOG_PATH = logArgument ?? join(root, "plugin.log");
const resolvedLogPath = resolve(getLogFilePath());
if (!resolvedLogPath.startsWith(`${resolve(root)}/`)) {
    throw new Error("fixture-log-containment: logger path must stay under its throwaway root");
}
if (process.argv.includes("--check-log-path")) {
    console.log(`Bun ${Bun.version}: fixture-log-containment passed (1 check)`);
    process.exit(0);
}
const db = new Database(join(root, "context.db"));
initializeDatabase(db);
runMigrations(db);
const projectPath = "git:synthetic-profile";
const sessionId = "synthetic-session";
const vector = new Float32Array(4096); vector[0] = 1;
let latency = 250;
let requests = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { input: string[] };
    requests++;
    await Bun.sleep(latency);
    return Response.json({ data: body.input.map((_text, index) => ({ index, embedding: Array.from(vector) })) });
} });
const snapshot = registerProjectEmbedding(db, projectPath, { provider: "openai-compatible", endpoint: `http://127.0.0.1:${server.port}/v1`, model: "fixture" }, { memoryEnabled: true, gitCommitEnabled: true }, root);
const insertTag = db.prepare("INSERT INTO tags (session_id,message_id,type,tag_number) VALUES (?,?,?,?)");
const insertMessage = db.prepare("INSERT INTO message_history_fts (session_id,message_ordinal,message_id,role,content) VALUES (?,?,?,?,?)");
const insertMap = db.prepare("INSERT INTO message_fts_rowid_map (session_id,message_ordinal,fts_rowid) VALUES (?,?,?)");
const insertCommit = db.prepare("INSERT INTO git_commits (sha,project_path,short_sha,message,committed_at,indexed_at) VALUES (?,?,?,?,?,?)");
const insertCommitVector = db.prepare("INSERT INTO git_commit_embeddings VALUES (?,?,?,?)");
const insertCompartment = db.prepare("INSERT INTO compartments (session_id,sequence,start_message,end_message,title,content,created_at) VALUES (?,?,?,?,?,?,?)");
const insertChunk = db.prepare("INSERT INTO compartment_chunk_embeddings (compartment_id,session_id,project_path,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
db.transaction(() => {
    for (let i=1; i<=200000; i++) insertTag.run(sessionId, `msg-${Math.ceil(i/3.3)}`, "text", i);
    for (let i=1; i<=60000; i++) {
        const content = `historian cache wiring current status ${i} ` + "TypeScript query embedding timeout SQLite context budget tool result. ".repeat(24);
        const row = insertMessage.run(sessionId, i, `msg-${i}`, "user", content);
        insertMap.run(sessionId, i, row.lastInsertRowid);
    }
    for (let i=0; i<1300; i++) {
        const memory = insertMemory(db, { projectPath, category: "ARCHITECTURE_DECISIONS", content: `historian cache wiring memory ${i}`, importance: 3 });
        saveEmbedding(db, memory.id, vector, snapshot.modelId);
    }
    for (let i=0; i<500; i++) {
        insertCommit.run(`sha-${i}`, projectPath, `sha-${i}`, `historian cache wiring commit ${i}`, 1700000000000, 1700000000000);
        insertCommitVector.run(`sha-${i}`, Buffer.from(vector.buffer), snapshot.modelId, 1700000000000);
        const compartment = insertCompartment.run(sessionId, i, i*120+1, (i+1)*120, `historian cache wiring compartment ${i}`, "fixture summary", 1700000000000);
        insertChunk.run(compartment.lastInsertRowid, sessionId, projectPath, i*120+1, (i+1)*120, `hash-${i}`, snapshot.chunkModelId, vector.length, Buffer.from(vector.buffer), 1700000000000);
    }
}).immediate();
const timer = createDatabaseTimer(db);
const query = "historian cache wiring";
let embeddingMs = 0;
const options = { limit: 10, memoryEnabled: true, embeddingEnabled: true, gitCommitsEnabled: true, countRetrievals: false, measurementDisabled: true, sources: ["memory", "message", "git_commit"] as ("memory"|"message"|"git_commit")[], isEmbeddingRuntimeEnabled: () => true, embedQuery: async (text: string, signal?: AbortSignal) => {
    const start=performance.now();
    let recorded = false;
    const record = () => { if (!recorded) { recorded = true; embeddingMs += performance.now() - start; } };
    signal?.addEventListener("abort", record, { once: true });
    try { return await embedTextForProject(projectPath, text, signal, "query"); }
    finally { record(); signal?.removeEventListener("abort", record); }
} };
const samples: unknown[] = [];
for (const providerMs of [250, 6000]) {
    latency = providerMs;
    timer.reset(); embeddingMs=0;
    const start=performance.now();
    const results = await withAutoSearchDeadline((signal) => unifiedSearch(timer.database, sessionId, projectPath, query, { ...options, signal }));
    const baselineMs=performance.now()-start;
    await Bun.sleep(0);
    const baselineEmbeddingMs=embeddingMs;
    const queries=timer.queries();
    const sqlLane = (pattern: RegExp) => queries.filter(row=>pattern.test(row.sql)).reduce((sum,row)=>sum+row.elapsedMs,0);
    const sourceTotals: Record<string, number> = {};
    for (const source of ["memory", "message", "git_commit"] as const) {
        const sourceStart = performance.now();
        await unifiedSearch(db, sessionId, projectPath, query, { ...options, sources: [source], embedQuery: async () => ({ vector, modelId: snapshot.modelId, chunkModelId: snapshot.chunkModelId, generation: snapshot.generation }) });
        sourceTotals[source] = performance.now() - sourceStart;
    }
    const workerStart=performance.now();
    const workerResults = await withAutoSearchDeadline(signal=>searchAutoHint(db,sessionId,projectPath,query,{...options,signal}));
    const workerMs=performance.now()-workerStart;
    if (results && workerResults && JSON.stringify(buildAutoSearchHint(results))!==JSON.stringify(buildAutoSearchHint(workerResults))) throw new Error("hint bytes differ");
    const messages = [{info:{id:`turn-${providerMs}`,role:"user"},parts:[{type:"text",text:query}]}];
    const stageStart=performance.now();
    await runAutoSearchHint({db, sessionId,messages,options:{enabled:true,scoreThreshold:0.6,minPromptChars:1,projectPath}});
    const stageMs=performance.now()-stageStart;
    const retryStart=performance.now();
    await runAutoSearchHint({db, sessionId,messages,options:{enabled:true,scoreThreshold:0.6,minPromptChars:1,projectPath}});
    samples.push({providerMs, baselineMs, embeddingMs:baselineEmbeddingMs, workerMs, stageMs, retryMs:performance.now()-retryStart, hintServed:messages[0].parts[0].text.includes("<ctx-search-hint>"), sourceTotals, lanes:{mapProofMs:sqlLane(/EXCEPT/),messageFtsMs:sqlLane(/FROM message_history_fts WHERE/)-sqlLane(/EXCEPT/),memoryFtsMs:sqlLane(/memories_fts/),memoryVectorAndPoolMs:sqlLane(/FROM memories\b|FROM memory_embeddings/),historyVectorMs:sqlLane(/compartment_chunk_embeddings/),gitFtsMs:sqlLane(/git_commits_fts/),gitVectorAndPoolMs:sqlLane(/FROM git_commits\b|FROM git_commit_embeddings/),tagReads:queries.filter(row=>/FROM tags\b/.test(row.sql)).length},queries});
}
const report={runtime:`Bun ${Bun.version}`,fixture:{tags:200000,messages:60000,memories:1300,commits:500,chunks:500,dims:4096},root,requests,samples};
writeFileSync(join(root,"profile.json"),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
unregisterProjectEmbedding(projectPath); db.close(); server.stop(true);
