// Generates crates/mc-module/testdata/dream_tasks/primers.json: what the
// TypeScript dreamer's promote-primers and refresh-primers tasks decide and
// write, in sequence on one database: promotion with no embedding provider
// (normalized-question clusters), a refresh whose investigator used no tools,
// then a refresh whose investigator read code. The Rust primer host must write
// the same primer and candidate rows.
//
//   bun crates/mc-module/gen/gen-dream-primers-golden.ts          # write
//   bun crates/mc-module/gen/gen-dream-primers-golden.ts --check  # compare

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { HiddenCompletionExecutor } from "../../../packages/plugin/src/hooks/magic-context/compartment-runner-types";
import { Database } from "../../../packages/plugin/src/shared/sqlite";
import { acquireLease } from "../../../packages/plugin/src/features/magic-context/dreamer/lease";
import { promotePrimers } from "../../../packages/plugin/src/features/magic-context/dreamer/promote-primers";
import { refreshPrimers } from "../../../packages/plugin/src/features/magic-context/dreamer/refresh-primers";

const root = resolve(import.meta.dir, "../../..");
const goldenPath = resolve(root, "crates/mc-module/testdata/dream_tasks/primers.json");

const DAY_MS = 24 * 60 * 60 * 1000;
// The Rust primer host fixture's clock.
const NOW = 20 * DAY_MS;
const PROJECT = "project";
const LEASE = "memory:project";

/** The Rust primer host fixture's candidates, plus one past the 90-day TTL. */
const candidates = [
    ...Array.from({ length: 7 }, (_, index) => {
        const id = index + 1;
        const question = id > 3 && id < 7 ? "Second subsystem" : "How does routing work";
        return {
            id,
            project_path: id === 7 ? "foreign" : PROJECT,
            session_id: `source-${id}`,
            question,
            normalized_question: question.toLowerCase(),
            message_id: `m${id}`,
            source_message_time: (12 + ((id - 1) % 3) * 4) * DAY_MS,
        };
    }),
    {
        id: 8,
        project_path: PROJECT,
        session_id: "source-8",
        question: "Expired question",
        normalized_question: "expired question",
        message_id: "m8",
        source_message_time: NOW - 100 * DAY_MS,
    },
];

const db = new Database(":memory:");
db.exec(
    (await readFile(resolve(root, "crates/mc-store/testdata/context_schema/schema.sql"), "utf8")).replaceAll(
        ":applied_at",
        "1",
    ),
);
for (const c of candidates) {
    db.prepare(
        "INSERT INTO primer_candidates(id,project_path,harness,session_id,question,normalized_question,source_compartment_start,source_compartment_end,source_start_message_id,source_end_message_id,source_message_time,created_at) VALUES (?,?,'opencode',?,?,?,1,3,?,?,?,1)",
    ).run(c.id, c.project_path, c.session_id, c.question, c.normalized_question, c.message_id, c.message_id, c.source_message_time);
}
Date.now = () => NOW;
if (!acquireLease(db, "holder", LEASE)) throw new Error("fixture lease refused");

function snapshot() {
    return {
        primers: db
            .prepare(
                "SELECT id,project_path,question,answer,status,total_support,last_observed_at,answer_refreshed_at,source_candidate_ids,source_candidate_provenance,question_embedding IS NULL AS no_embedding,created_at,updated_at FROM primers ORDER BY id",
            )
            .all(),
        candidateIds: (db.prepare("SELECT id FROM primer_candidates ORDER BY id").all() as { id: number }[]).map((r) => r.id),
    };
}

const steps = [];
const promoted = await promotePrimers({
    db,
    projectIdentity: PROJECT,
    sessionDirectory: "/fixture",
    holderId: "holder",
    leaseKey: LEASE,
    deadline: NOW + 60_000,
});
steps.push({ step: "promote", result: promoted, ...snapshot() });

const answer = JSON.stringify({ answer: "Routing is dispatched by lib.rs." });
for (const tools of [false, true]) {
    let calls = 0;
    const executor = {
        capabilities: { tools: true, harness: "opencode" },
        async open() {
            return { id: "primer-child", childSessionId: "primer-child" };
        },
        async attempt() {},
        async collect() {
            calls += 1;
            return {
                text: answer,
                reasoning: null,
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                lengthCapped: false,
                messages: [
                    {
                        info: { role: "assistant" },
                        parts: tools
                            ? [{ type: "tool", tool: "read", state: { status: "completed", input: { filePath: "lib.rs" }, output: "current implementation" } }]
                            : [{ type: "text", text: answer }],
                    },
                ],
            };
        },
        async close() {},
    } as unknown as HiddenCompletionExecutor;
    const result = await refreshPrimers({
        db,
        hiddenCompletionExecutor: executor,
        projectIdentity: PROJECT,
        parentSessionId: undefined,
        sessionDirectory: "/fixture",
        holderId: "holder",
        leaseKey: LEASE,
        deadline: NOW + 60_000,
    });
    steps.push({ step: tools ? "refresh_with_tools" : "refresh_without_tools", tools, answer, modelCalls: calls, result, ...snapshot() });
}

const out = { now: NOW, candidates, steps };
const rendered = `${JSON.stringify(out, null, 2)}\n`;
if (process.argv.includes("--check")) {
    if ((await readFile(goldenPath, "utf8")) !== rendered) {
        throw new Error(
            "primers golden drifted from the TypeScript dreamer; regenerate with bun crates/mc-module/gen/gen-dream-primers-golden.ts",
        );
    }
    console.log("primers golden matches the TypeScript dreamer");
} else {
    await mkdir(dirname(goldenPath), { recursive: true });
    await writeFile(goldenPath, rendered);
    console.log(`wrote ${goldenPath}`);
}
