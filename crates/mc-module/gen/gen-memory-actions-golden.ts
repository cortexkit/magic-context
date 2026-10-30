import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Database } from "../../../packages/plugin/src/shared/sqlite";
import { DREAMER_AGENT } from "../../../packages/plugin/src/agents/dreamer";
import { _setTestProviderFactoryForProject, registerProjectEmbedding } from "../../../packages/plugin/src/features/magic-context/memory/embedding";
import { tsOwnsMemory } from "../../../packages/plugin/src/features/magic-context/memory/lifecycle-applier";
import { createCtxMemoryTools } from "../../../packages/plugin/src/tools/ctx-memory/tools";

const root = resolve(import.meta.dir, "../../..");
const goldenPath = resolve(root, "crates/mc-module/testdata/memory_actions/golden.json");

// These hashes pin the TypeScript behavior that produced the committed Rust fixture.
// Updating a reference source requires reviewing the new vectors and regenerating them.
const oracleSources = [
  [
    "packages/plugin/src/tools/ctx-memory/tools.ts",
    "7a8d7b802a14469ae8ef8900b7e6833ad6a5a4bac929294e58412e38ab89359b",
  ],
  [
    "packages/plugin/src/features/magic-context/memory/lifecycle-applier.ts",
    "153a1a0290238b321567c2443f59a77df41071d53b71415c645d14097bd210ab",
  ],
  [
    "packages/plugin/src/features/magic-context/memory/storage-memory.ts",
    "61c45628a632bc6e4c32f554ab5864641d8dae979e1eb6f28f717ad47fe95a77",
  ],
  [
    "packages/plugin/src/features/magic-context/dreamer/curate-memory-safety.ts",
    "112bcf63c22dab51dfedf48a4a7616e6610a3e5c33159827a208dbba31caa190",
  ],
  [
    "packages/plugin/src/features/magic-context/dreamer/memory-claim-safety.ts",
    "ba423d5d18a7eec2be92d3aed179074230912776ba7dd766cc78afb910bd19f1",
  ],
] as const;

const cases = [
  ["primary", { action: "write", category: "CONSTRAINTS", content: "  Alpha fact.  " }],
  ["primary", { action: "write", category: "CONSTRAINTS", content: "ALPHA   fact." }],
  ["primary", { action: "update", ids: [1], content: "Updated alpha fact.", category: "invalid" }],
  ["primary", { action: "write", category: "CONSTRAINTS", content: "Beta fact." }],
  ["primary", { action: "merge", ids: [2, 1], content: "Unified fact.", reason: "combine facts" }],
  ["primary", { action: "archive", ids: [3, 3], reason: "  obsolete  " }],
  ["primary", { action: "archive", ids: [3] }],
  ["dreamer", { action: "write", category: "CONFIG_VALUES", content: "Limit is 12." }],
  ["dreamer", { action: "write", category: "CONFIG_VALUES", content: "Limit is 24." }],
  ["dreamer", { action: "archive", ids: [4], superseded_by: 5, reason: "replaced configuration" }],
  ["dreamer", { action: "update", ids: [5], content: "Limit is 48.", reason: "measured" }],
  ["primary", { action: "get", ids: [3, 999, 3] }],
  ["dreamer", { action: "list" }],
  ["primary", { action: "list" }],
  ["dreamer", { action: "archive", ids: [5], reason: "move to user profile" }],
  ["dreamer", { action: "update", ids: [5], content: "x" }],
  ["primary", { action: "update", ids: [5], content: "Limit is 48.", category: " CONFIG_VALUES " }],
  ["primary", { action: "merge", ids: [5, 5], content: "bad" }],
  ["primary", { action: "write", category: "UNKNOWN", content: "bad" }],
  ["primary", { action: "get", ids: [1.25] }],
  ["primary", { reduced: true, summary: JSON.stringify({ action: "write", category: "NAMING", content: "Symbols use camelCase." }) }],
  ["primary", { action: "update", ids: [5], category: "ARCHITECTURE", content: "Configuration is a boundary value." }],
  ["primary", { action: "write", category: "ARCHITECTURE", content: "Configuration is a boundary value." }],
  ["primary", { action: "archive", ids: [6, 999] }],
  ["primary", { action: "write", category: "CONSTRAINTS", content: "Unified fact." }],
  ["primary", { action: "write", category: "NAMING", content: "Configuration is a boundary value." }],
  ["dreamer", { action: "list", category: "NAMING", limit: 1 }],
  ["primary", { reduced: true, summary: JSON.stringify({ action: "write", category: "NAMING", content: "Must not decode.", role: "dreamer" }) }],
  ["primary", { reduced: true, summary: "not json" }],
  ["dreamer", { action: "write", category: "PROJECT_RULES", content: "Always check ownership." }],
  ["dreamer", { action: "update", ids: [7], content: "Always check the ownership." }],
  ["primary", { action: "write", category: "NAMING", content: "\uFEFF  Unicode fact.\uFEFF" }],
  ["primary", { action: "update", ids: [8], content: "\uFEFFUnicode\u0085fact.\uFEFF" }],
  ["primary", { action: "get", ids: [8] }],
] as const;

async function assertOracleSourcesArePinned(): Promise<void> {
  for (const [relativePath, expectedHash] of oracleSources) {
    const content = await readFile(resolve(root, relativePath));
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(
        `pinned memory_actions TypeScript oracle changed: ${relativePath} (expected ${expectedHash}, got ${actualHash})`,
      );
    }
  }
}

async function runOracle(): Promise<unknown[]> {
  const db = new Database(":memory:");
  db.exec(
    (await readFile(resolve(root, "crates/mc-store/testdata/context_schema/schema.sql"), "utf8"))
      .replaceAll(":applied_at", "1700000000000"),
  );
  Date.now = () => 1700000000000;

  const calls: string[] = [];
  _setTestProviderFactoryForProject(() => ({
    modelId: "mock-model",
    initialize: async () => true,
    embed: async (text: string) => {
      calls.push(text);
      return new Float32Array([1, 0]);
    },
    embedBatch: async () => [],
    dispose: async () => {},
    isLoaded: () => true,
  }));
  registerProjectEmbedding(
    db,
    "project-a",
    { provider: "local", model: "mock-model" } as any,
    { memoryEnabled: true, gitCommitEnabled: false },
    "project-a",
  );
  const tool = createCtxMemoryTools({ db, resolveProjectPath: () => "project-a" } as any).ctx_memory;
  const out = [];
  for (const [role, args] of cases) {
    const reply = await tool.execute(
      args as any,
      {
        agent: role === "dreamer" ? DREAMER_AGENT : "primary",
        sessionID: "session-a",
        directory: "/fixture",
      } as any,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const memories = db.prepare("SELECT * FROM memories ORDER BY id").all();
    const history = db
      .prepare(
        "SELECT memory_id,revision,previous_text,after_text,before_json,after_json,applied_at,reason,evidence_json,source_ids_json FROM memory_history ORDER BY id",
      )
      .all();
    const mutations = db
      .prepare(
        "SELECT mutation_type,target_memory_id,superseded_by_id,category,new_content,queued_at FROM memory_mutation_log ORDER BY id",
      )
      .all();
    const fragments = db
      .prepare(
        "SELECT session_id,harness,project_path,memory_ids_json,current_id,lines,visible_texts_json,created_at FROM memory_agent_fragments ORDER BY id",
      )
      .all();
    out.push({
      role,
      args,
      reply,
      memories,
      history,
      mutations,
      fragments,
      embedCalls: [...calls],
      tsOwnsMemory: tsOwnsMemory(db, "project-a"),
    });
  }
  return out;
}

async function main(): Promise<void> {
  await assertOracleSourcesArePinned();
  const vectors = await runOracle();
  if (vectors.length !== 34) {
    throw new Error(`memory_actions TypeScript oracle produced ${vectors.length} vectors; expected 34`);
  }
  const rendered = `${JSON.stringify(vectors, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    let committed: string;
    try {
      committed = await readFile(goldenPath, "utf8");
    } catch (error) {
      throw new Error(`missing memory_actions golden fixture ${goldenPath}`, { cause: error });
    }
    if (committed !== rendered) {
      throw new Error(
        `memory_actions golden drifted from the pinned TypeScript oracle; regenerate with bun crates/mc-module/gen/gen-memory-actions-golden.ts`,
      );
    }
    console.log(`memory_actions golden matches pinned TypeScript oracle (${vectors.length} vectors)`);
    return;
  }
  await mkdir(dirname(goldenPath), { recursive: true });
  await writeFile(goldenPath, rendered);
  console.log(`wrote ${goldenPath} (${vectors.length} vectors)`);
}

await main();
