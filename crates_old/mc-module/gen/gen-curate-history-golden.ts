// Generates crates/mc-module/testdata/memory_actions/curate_history.json: the
// memory rows and audited history rows the TypeScript dreamer's ctx_memory tool
// writes for one curate update, one merge (sources plus survivor) and one archive.
// The Rust curate tool path must write the same rows for the same edits, so an
// edit made by either runtime can be restored from its history the same way.
//
//   bun crates/mc-module/gen/gen-curate-history-golden.ts          # write
//   bun crates/mc-module/gen/gen-curate-history-golden.ts --check  # compare

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Database } from "../../../packages/plugin/src/shared/sqlite";
import { DREAMER_AGENT } from "../../../packages/plugin/src/agents/dreamer";
import {
    _setTestProviderFactoryForProject,
    registerProjectEmbedding,
} from "../../../packages/plugin/src/features/magic-context/memory/embedding";
import { createCtxMemoryTools } from "../../../packages/plugin/src/tools/ctx-memory/tools";

const root = resolve(import.meta.dir, "../../..");
const goldenPath = resolve(root, "crates/mc-module/testdata/memory_actions/curate_history.json");

export const cases = [
    { action: "write", category: "CONFIG_VALUES", content: "Request limit is 12 per minute." },
    { action: "write", category: "CONFIG_VALUES", content: "Retries are capped at 3 attempts." },
    { action: "write", category: "CONFIG_VALUES", content: "The retry cap is 3 attempts per call." },
    { action: "write", category: "CONFIG_VALUES", content: "Timeout is 30 seconds for each request." },
    {
        action: "update",
        ids: [1],
        content: "Request limit is 12 requests per minute per project.",
        reason: "clarify the unit",
    },
    {
        action: "merge",
        ids: [2, 3],
        content: "Retries are capped at 3 attempts per call.",
        category: "CONFIG_VALUES",
        reason: "same retry cap",
    },
    { action: "archive", ids: [4], superseded_by: 1, reason: "covered by the request limit memory" },
] as const;

async function runOracle(): Promise<unknown[]> {
    const db = new Database(":memory:");
    db.exec(
        (await readFile(resolve(root, "crates/mc-store/testdata/context_schema/schema.sql"), "utf8")).replaceAll(
            ":applied_at",
            "1700000000000",
        ),
    );
    Date.now = () => 1700000000000;
    _setTestProviderFactoryForProject(() => ({
        modelId: "mock-model",
        initialize: async () => true,
        embed: async () => new Float32Array([1, 0]),
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
    for (const args of cases) {
        const reply = await tool.execute(args as any, {
            agent: DREAMER_AGENT,
            sessionID: "session-a",
            directory: "/fixture",
        } as any);
        await new Promise((resolve) => setTimeout(resolve, 0));
        out.push({
            args,
            reply,
            memories: db
                .prepare(
                    "SELECT id,category,content,status,revision,superseded_by_memory_id FROM memories ORDER BY id",
                )
                .all(),
            history: db
                .prepare(
                    "SELECT memory_id,revision,previous_text,after_text,before_json,after_json,applied_at,reason,evidence_json,source_ids_json FROM memory_history ORDER BY id",
                )
                .all(),
        });
    }
    return out;
}

const rendered = `${JSON.stringify(await runOracle(), null, 2)}\n`;
if (process.argv.includes("--check")) {
    if ((await readFile(goldenPath, "utf8")) !== rendered) {
        throw new Error(
            "curate history golden drifted from the TypeScript dreamer; regenerate with bun crates/mc-module/gen/gen-curate-history-golden.ts",
        );
    }
    console.log("curate history golden matches the TypeScript dreamer");
} else {
    await mkdir(dirname(goldenPath), { recursive: true });
    await writeFile(goldenPath, rendered);
    console.log(`wrote ${goldenPath}`);
}
