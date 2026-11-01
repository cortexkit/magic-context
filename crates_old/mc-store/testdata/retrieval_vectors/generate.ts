import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sandbox = mkdtempSync(join(tmpdir(), "mc-vectors-"));
// Migration and logger dependencies must never open the user's data directories.
for (const key of ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) process.env[key] = sandbox;
process.env.MAGIC_CONTEXT_LOG_PATH = join(sandbox, "magic-context.log");
process.env.NODE_ENV = "test";

try {
    const root = fileURLToPath(new URL("../../../..", import.meta.url));
    const moduleAt = (path: string) => import(join(root, "packages/plugin/src", path));
    const { Database } = await moduleAt("shared/sqlite.ts");
    const { setHarness } = await moduleAt("shared/harness.ts");
    setHarness("opencode");
    const memory = await moduleAt("features/magic-context/memory/storage-memory-embeddings.ts");
    const commits = await moduleAt("features/magic-context/git-commits/storage-git-commit-embeddings.ts");
    const chunks = await moduleAt("features/magic-context/compartment-chunk-embedding.ts");
    const { cosineSimilarity } = await moduleAt("features/magic-context/memory/cosine-similarity.ts");
    const { computeNormalizedHash } = await moduleAt("features/magic-context/memory/normalize-hash.ts");
    const project = "/fixture/project";
    const model = "embedding-provider:fixture-a";
    const chunkModel = `${model}:raw-window-fixture`;
    const vectors = [[0.33333333, 1e-8, -0.25, 2], [1, 0, 1, 0], [1, 0, 1, 0], [0, 0, 0, 0]];
    const query = new Float32Array([0.33333333, 1e-8, -0.25, 2]);
    const texts = ["  Mixed\u00a0CASE\ufeff memory  ", "Second memory", "Third memory", "Zero norm"];
    const windows = chunks.chunkCanonicalText("[0] U: remember vectors\n[1] A: use float32 bytes", 0, 1, 512);
    const inspect = process.argv[2] === "--inspect";
    const dbPath = resolve(process.argv[inspect ? 3 : 2]);
    const output = resolve(process.argv[inspect ? 4 : 3]);
    const db = new Database(dbPath);
    if (!inspect) {
        const { initializeDatabase } = await moduleAt("features/magic-context/storage-db.ts");
        const { runMigrations } = await moduleAt("features/magic-context/migrations.ts");
        initializeDatabase(db);
        runMigrations(db);
        texts.forEach((text, index) => db.prepare(`INSERT INTO memories
            (id,project_path,category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at)
            VALUES(?,?,?,?,?,1,1,1,1)`).run(index + 1, project, "fact", text, computeNormalizedHash(text)));
        db.prepare(`INSERT INTO git_commits(sha,project_path,short_sha,message,committed_at,indexed_at)
            VALUES('sha-a',?,'sha-a','Commit message',10,1)`).run(project);
        db.prepare(`INSERT INTO compartments(id,session_id,sequence,start_message,end_message,title,content,created_at)
            VALUES(1,'session-a',1,0,1,'Vector fixture','Summary',1)`).run();
        db.prepare(`INSERT INTO session_projects(session_id,harness,project_path,updated_at)
            VALUES('session-a','opencode',?,1)`).run(project);
        db.prepare(`INSERT INTO message_fts_rowid_map(session_id,message_ordinal,fts_rowid,message_time_ms)
            VALUES('session-a',0,100,100),('session-a',1,101,200)`).run();
        for (let i = 0; i < vectors.length; i++) {
            // A subarray catches serializers that accidentally copy the whole backing buffer.
            const backing = new Float32Array([999, ...vectors[i], 999]);
            if (!memory.saveEmbeddingIfHashMatches(db, i + 1, backing.subarray(1, 5), model, computeNormalizedHash(texts[i]))) {
                throw new Error("hash-guarded fixture write refused");
            }
        }
        memory.saveEmbedding(db, 1, new Float32Array([0, 1, 0, 0]), "other-model");
        const clock = Date.now;
        try {
            Date.now = () => 123;
            commits.saveCommitEmbedding(db, "sha-a", new Float32Array(vectors[1]), model);
        } finally {
            Date.now = clock;
        }
        chunks.replaceCompartmentChunkEmbeddings(db, windows.map((window: any) => ({
            compartmentId: 1, sessionId: "session-a", projectPath: project,
            window, modelId: chunkModel, vector: new Float32Array(vectors[0]), createdAt: 123,
        })));
    }
    const memoryVectors = [...memory.loadAllEmbeddings(db, project, model)].map(([id, row]: any) => ({ id, values: [...row.embedding] }));
    const commitVectors = [...commits.loadProjectCommitEmbeddings(db, project, model)].map(([id, vector]: any) => ({ id, values: [...vector] }));
    const chunkVectors = (await chunks.loadCompartmentChunkEmbeddingsForSearch(db, "session-a", project, chunkModel))
        .map((row: any) => ({ id: row.windowIndex, values: [...row.vector] }));
    const rank = (rows: {id: number | string; values: number[]}[]) => rows.map(row => ({
        id: row.id, score: cosineSimilarity(query, new Float32Array(row.values)),
    })).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const rows = {
        memory: db.prepare("SELECT memory_id,model_id,lower(hex(embedding)) AS blob FROM memory_embeddings ORDER BY memory_id,model_id").all(),
        commit: db.prepare("SELECT sha,model_id,created_at,lower(hex(embedding)) AS blob FROM git_commit_embeddings ORDER BY sha,model_id").all(),
        chunk: db.prepare(`SELECT compartment_id,session_id,project_path,harness,window_index,start_ordinal,end_ordinal,
            chunk_hash,model_id,dims,created_at,lower(hex(vector)) AS blob FROM compartment_chunk_embeddings ORDER BY compartment_id,model_id,window_index`).all(),
    };
    const datedChunks = [];
    for (const [from, to] of [[100, 100], [150, 150], [200, 200], [201, 300], [0, 99]]) {
        const dated = await chunks.loadCompartmentChunkEmbeddingsForSearch(db, "session-a", project, chunkModel, { from, to });
        datedChunks.push({
            from, to, rows: dated.map((row: any) => ({ compartmentId: row.compartmentId, title: row.title,
                startOrdinal: row.startOrdinal, endOrdinal: row.endOrdinal, windowIndex: row.windowIndex,
                windowStartOrdinal: row.windowStartOrdinal, windowEndOrdinal: row.windowEndOrdinal,
                values: [...row.vector] })),
        });
    }
    writeFileSync(output, JSON.stringify({ project, model, chunkModel, query: [...query], texts, windows,
        vectors: vectors.map(v => [...new Float32Array(v)]), rows,
        decoded: { memory: memoryVectors, commit: commitVectors, chunk: chunkVectors },
        rankings: { memory: rank(memoryVectors), commit: rank(commitVectors), chunk: rank(chunkVectors) },
        coverage: memory.getMemoryEmbedCoverage(db, project, model),
        datedChunks,
        cosineEdges: [cosineSimilarity(new Float32Array(0), new Float32Array(0)),
            cosineSimilarity(query, new Float32Array(2)), cosineSimilarity(query, new Float32Array(4))],
    }, null, 2));
    db.close();
    console.log(`Bun ${Bun.version}: real TypeScript vector stores and cosine, ${memoryVectors.length + commitVectors.length + chunkVectors.length} vectors`);
} finally {
    rmSync(sandbox, { recursive: true, force: true });
}
