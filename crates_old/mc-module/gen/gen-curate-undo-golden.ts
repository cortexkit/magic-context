// Capture real TypeScript curate edits for the Rust audited-undo integration test.
// No model runs: a disabled fixture embedder leaves invalidated live rows pending.
// bun crates/mc-module/gen/gen-curate-undo-golden.ts [--check]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DREAMER_AGENT } from "../../../packages/plugin/src/agents/dreamer";
import {
    _setTestProviderFactoryForProject,
    registerProjectEmbedding,
} from "../../../packages/plugin/src/features/magic-context/memory/embedding";
import { computeNormalizedHash } from "../../../packages/plugin/src/features/magic-context/memory/normalize-hash";
import { Database } from "../../../packages/plugin/src/shared/sqlite";
import { createCtxMemoryTools } from "../../../packages/plugin/src/tools/ctx-memory/tools";

const root = resolve(import.meta.dir, "../../..");
const path = resolve(root, "crates/mc-module/testdata/memory_actions/curate_undo.json");
const tables = [
    "memories", "memory_embeddings", "memory_verifications", "memory_history",
    "memory_journal", "memory_successor_links", "memory_mutation_log", "project_state",
] as const;
const operations = [
    { action: "update", ids: [1], content: "Architecture entry one describes the enduring component boundary more clearly." },
    { action: "merge", ids: [2, 3], content: "The component boundary separates transport from durable storage.", category: "ARCHITECTURE" },
    { action: "archive", ids: [4, 5], superseded_by: 6, reason: "Redundant boundary details survive in the active entry." },
] as const;

function state(db: Database) {
    return Object.fromEntries(tables.map((table) => [table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) =>
            Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([key, value]) =>
                [key, value instanceof Uint8Array ? Array.from(value) : value]))),
    ]));
}

Date.now = () => 1000;
_setTestProviderFactoryForProject(() => ({
    modelId: "model", initialize: async () => false,
    embed: async () => { throw new Error("fixture must not embed"); },
    embedBatch: async () => { throw new Error("fixture must not embed"); },
    dispose: async () => {}, isLoaded: () => false,
}));
const schema = (await readFile(resolve(root, "crates/mc-store/testdata/context_schema/schema.sql"), "utf8"))
    .replaceAll(":applied_at", "1000");
const cases = [];
for (const args of operations) {
    const db = new Database(":memory:");
    db.exec(schema);
    for (let id = 1; id <= 7; id++) {
        const content = `Architecture entry ${id} describes the project's durable component boundary.`;
        db.prepare("INSERT INTO memories(id,project_path,category,content,normalized_hash,source_session_id,first_seen_at,created_at,updated_at,last_seen_at,metadata_json) VALUES(?,?,'ARCHITECTURE',?,?,'source',1,1,1,1,'{}')")
            .run(id, id === 7 ? "foreign" : "project", content, computeNormalizedHash(content));
        db.prepare("INSERT INTO memory_embeddings(memory_id,embedding,model_id) VALUES(?,?,'model')").run(id, new Uint8Array(8));
    }
    db.prepare("INSERT INTO project_state(project_path,project_memory_epoch) VALUES('project',9)").run();
    db.exec("UPDATE memories SET shareable=1,classified_at=1,verification_status='verified',verified_at=1,mural_cue='old cue',mural_cue_hash='old hash',mural_cue_at=1,verify_result='verified',verify_files_json='[\"boundary.ts\"]',verify_commit='old commit'; INSERT INTO memory_verifications(memory_id,file_path,verified_at) SELECT id,'boundary.ts',1 FROM memories;");
    registerProjectEmbedding(db, "project", { provider: "local", model: "model" } as any,
        { memoryEnabled: true, gitCommitEnabled: false }, "project");
    const before = state(db);
    const tool = createCtxMemoryTools({ db, resolveProjectPath: () => "project" } as any).ctx_memory;
    const reply = await tool.execute(args as any, {
        agent: DREAMER_AGENT, sessionID: "session", directory: "/fixture",
    } as any);
    await new Promise((done) => setTimeout(done, 0));
    if (!/^(Updated|Merged|Archived)/.test(reply)) throw new Error(reply);
    const key = (db.prepare("SELECT decision_key FROM memory_journal").get() as { decision_key: string }).decision_key;
    cases.push({ args, key, before, edited: state(db) });
    db.close();
}
// Only the random per-invocation decision key is normalized. IDs and times are fixed.
const rendered = `${JSON.stringify(cases, null, 2)}\n`;
if (process.argv.includes("--check")) {
    // Compare after replacing the independently generated invocation keys.
    const normalize = (raw: string) => JSON.stringify(JSON.parse(raw).map((entry: any) =>
        JSON.parse(JSON.stringify(entry).split(entry.key).join("<curate-edit>"))));
    if (normalize(await readFile(path, "utf8")) !== normalize(rendered)) {
        throw new Error("curate undo oracle drift: inspect the TS edit before regenerating");
    }
    console.log(`curate undo oracle matches ${cases.length} TypeScript edits`);
} else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, rendered);
    console.log(`wrote ${cases.length} TypeScript curate undo inputs to ${path}`);
}
