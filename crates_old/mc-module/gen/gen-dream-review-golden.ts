// Generates crates/mc-module/testdata/dream_tasks/review_user_memories.json: what
// the TypeScript dreamer's review-user-memories task decides and writes for a
// fixed candidate pool and a fixed reviewer answer. The Rust review host must
// prune, promote, update, dismiss and consume exactly the same rows.
//
//   bun crates/mc-module/gen/gen-dream-review-golden.ts          # write
//   bun crates/mc-module/gen/gen-dream-review-golden.ts --check  # compare

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { HiddenCompletionExecutor } from "../../../packages/plugin/src/hooks/magic-context/compartment-runner-types";
import { Database } from "../../../packages/plugin/src/shared/sqlite";
import { acquireLease } from "../../../packages/plugin/src/features/magic-context/dreamer/lease";
import { reviewUserMemories } from "../../../packages/plugin/src/features/magic-context/user-memory/review-user-memories";

const root = resolve(import.meta.dir, "../../..");
const goldenPath = resolve(root, "crates/mc-module/testdata/dream_tasks/review_user_memories.json");

// The Rust test fixture's clock reads 1000 ms; both sides write with this time.
const NOW = 1000;
const LEASE = "user-memories";

interface Candidate {
    id: number;
    content: string;
    session_id: string;
    created_at: number;
    source_compartment_start: number | null;
    source_compartment_end: number | null;
}

const pool: Candidate[] = [
    { id: 1, content: "Prefers bounded checks", session_id: "source-1", created_at: 900, source_compartment_start: 10, source_compartment_end: 20 },
    { id: 2, content: "Prefers bounded verification", session_id: "source-2", created_at: 900, source_compartment_start: 30, source_compartment_end: 40 },
    { id: 3, content: "Wants concise reports", session_id: "source-3", created_at: 900, source_compartment_start: 50, source_compartment_end: 60 },
    { id: 4, content: "Reviews diffs before merging", session_id: "source-4", created_at: 900, source_compartment_start: null, source_compartment_end: null },
    // Older than the 30-day candidate TTL: pruned before any review.
    { id: 5, content: "One-off frustration", session_id: "source-5", created_at: -3_000_000_000, source_compartment_start: null, source_compartment_end: null },
];

const profile = [
    { id: 1, content: "Prefers long reports", status: "active", promoted_at: 1, created_at: 1, updated_at: 1 },
    { id: 2, content: "Likes guesses", status: "active", promoted_at: 1, created_at: 1, updated_at: 1 },
];

export const cases = [
    {
        name: "promote_update_dismiss_and_consume_used_candidates",
        threshold: 3,
        candidates: pool,
        // Candidate 99 does not exist; candidates 2 and 3 are consumed because a
        // promotion and an update used them, although the answer omits them.
        answer: '{"promote":[{"content":"  Prefers bounded checks  ","candidate_ids":[1,2]},{"content":"Reviews diffs before merging","candidate_ids":[4,99]},{"content":"   ","candidate_ids":[3]}],"update_existing":[{"memory_id":1,"content":"Prefers concise reports","candidate_ids":[3]},{"memory_id":0,"content":"ignored"}],"dismiss_existing":[{"memory_id":2,"reason":"unsupported"}],"consume_candidate_ids":[1]}',
    },
    {
        name: "fenced_answer_consumes_without_profile_change",
        threshold: 3,
        candidates: pool,
        answer: 'Verdict:\n```json\n{"promote":[],"update_existing":[],"dismiss_existing":[],"consume_candidate_ids":[1,2,3,4]}\n```',
    },
    {
        name: "below_threshold_after_pruning_asks_no_model",
        threshold: 3,
        candidates: [pool[0], pool[1], pool[4]],
        answer: null,
    },
] as const;

async function runCase(c: (typeof cases)[number]): Promise<unknown> {
    const db = new Database(":memory:");
    db.exec(
        (await readFile(resolve(root, "crates/mc-store/testdata/context_schema/schema.sql"), "utf8")).replaceAll(
            ":applied_at",
            "1",
        ),
    );
    const insert = db.prepare(
        "INSERT INTO user_memory_candidates(id,content,session_id,created_at,source_compartment_start,source_compartment_end) VALUES (?,?,?,?,?,?)",
    );
    for (const row of c.candidates) {
        insert.run(row.id, row.content, row.session_id, row.created_at, row.source_compartment_start, row.source_compartment_end);
    }
    const memory = db.prepare(
        "INSERT INTO user_memories(id,content,status,promoted_at,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    );
    for (const row of profile) {
        memory.run(row.id, row.content, row.status, row.promoted_at, row.created_at, row.updated_at);
    }
    if (!acquireLease(db, "holder", LEASE)) throw new Error("fixture lease refused");
    let modelCalls = 0;
    const executor: HiddenCompletionExecutor = {
        capabilities: { tools: false, harness: "opencode" },
        async open() {
            modelCalls += 1;
            return { id: "review-child", childSessionId: "review-child" };
        },
        async attempt() {},
        async collect() {
            return {
                text: c.answer,
                reasoning: null,
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                lengthCapped: false,
            };
        },
        async close() {},
    } as HiddenCompletionExecutor;
    const result = await reviewUserMemories({
        db,
        hiddenCompletionExecutor: executor,
        parentSessionId: undefined,
        sessionDirectory: "/fixture",
        holderId: "holder",
        leaseKey: LEASE,
        deadline: NOW + 60_000,
        promotionThreshold: c.threshold,
    });
    return {
        ...c,
        profile,
        modelCalls,
        result,
        userMemories: db
            .prepare(
                "SELECT id,content,status,promoted_at,source_candidate_ids,source_candidate_provenance,created_at,updated_at FROM user_memories ORDER BY id",
            )
            .all(),
        remainingCandidateIds: (db.prepare("SELECT id FROM user_memory_candidates ORDER BY id").all() as { id: number }[]).map(
            (row) => row.id,
        ),
        profileVersion:
            (
                db
                    .prepare("SELECT project_user_profile_version AS v FROM project_state WHERE project_path='__global__'")
                    .get() as { v: number } | null
            )?.v ?? 0,
    };
}

Date.now = () => NOW;
const out = [];
for (const c of cases) out.push(await runCase(c));
const rendered = `${JSON.stringify(out, null, 2)}\n`;
if (process.argv.includes("--check")) {
    if ((await readFile(goldenPath, "utf8")) !== rendered) {
        throw new Error(
            "review-user-memories golden drifted from the TypeScript dreamer; regenerate with bun crates/mc-module/gen/gen-dream-review-golden.ts",
        );
    }
    console.log("review-user-memories golden matches the TypeScript dreamer");
} else {
    await mkdir(dirname(goldenPath), { recursive: true });
    await writeFile(goldenPath, rendered);
    console.log(`wrote ${goldenPath}`);
}
