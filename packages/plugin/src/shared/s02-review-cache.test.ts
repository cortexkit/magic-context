import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectM0M1Pi } from "../../../pi-plugin/src/inject-compartments-pi";
import { classifySafetyFixture } from "../features/magic-context/dreamer/safety-critical-classify.fixture";
import { applyAgentMemoryMutation } from "../features/magic-context/memory/lifecycle-applier";
import { getMemoryById, insertMemory } from "../features/magic-context/memory/storage-memory";
import { recordItemScores } from "../features/magic-context/memory/turn-two-scoring";
import { runMigrations } from "../features/magic-context/migrations";
import { getOrCreateSessionMeta } from "../features/magic-context/storage";
import { initializeDatabase } from "../features/magic-context/storage-db";
import { injectM0M1 } from "../hooks/magic-context/inject-compartments";
import { Database } from "./sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "./test-temp-dir";

const enabled = process.env.MC_S02_REVIEW === "1";
const parent = process.env.S02_PARENT === "1";
const results: unknown[] = [];
const clock = Date.now;

// Both OpenCode generations inject m[0]/m[1] through injectM0M1; Pi uses injectM0M1Pi.
for (const host of ["OC1", "OC2", "Pi"] as const) {
    test.skipIf(!enabled)(
        `s02 review ${host}: 320 randomized classify/floor replay passes`,
        async () => {
            const root = join(tmpdir(), "magic-context", "two-pass-s02-review");
            mkdirSync(root, { recursive: true });
            let replays = 0;
            let softs = 0;
            let hards = 0;
            let classifications = 0;
            try {
                Date.now = () => 1_800_000_000_000;
                for (const seed of [0x941aac21, 0x287cf89b, 0xb41c137e, 0x1799fdd3]) {
                    const home = createTestTempDirFromPath(join(root, `${host}-`));
                    const db = new Database(join(home, "context.db"));
                    const project = "git:s02-review-cache";
                    const session = `s02-${host}-${seed}`;
                    try {
                        initializeDatabase(db);
                        runMigrations(db);
                        getOrCreateSessionMeta(db, session);
                        for (let i = 0; i < 32; i++)
                            insertMemory(db, {
                                projectPath: project,
                                category: "PROJECT_RULES",
                                content: `Never push without approval: rule ${i}. ${"Detailed constraint. ".repeat((i % 7) + 1)}`,
                                importance: 20 + i,
                            });
                        db.exec("UPDATE memories SET classified_at=7 WHERE id%2=0");
                        expect(
                            applyAgentMemoryMutation(db, {
                                key: "initial-fragment",
                                projectPath: project,
                                sourceSessionId: session,
                                operation: "update",
                                targets: [{ id: 1, revision: 1 }],
                                content: "Never push without approval: updated first rule.",
                            }).state,
                        ).toBe("applied");
                        db.exec("UPDATE memories SET classified_at=7 WHERE id<=2");
                        let state = seed >>> 0;
                        const next = () => {
                            state ^= state << 13;
                            state ^= state >>> 17;
                            state ^= state << 5;
                            return state >>> 0;
                        };
                        let budget = 700;
                        const pass = (busting: boolean, expired = false) => {
                            const hardSignals = {
                                systemHash: "system",
                                modelKey: "anthropic/claude",
                                cacheExpired: expired,
                                lastResponseTime: expired ? Date.now() + 60_000 : 1,
                            };
                            if (host === "Pi") {
                                const messages: Parameters<typeof injectM0M1Pi>[2] = [];
                                const result = injectM0M1Pi(
                                    {
                                        sessionId: session,
                                        projectIdentity: project,
                                        projectDirectory: home,
                                        injectDocs: false,
                                        injectionBudgetTokens: budget,
                                        historyBudgetTokens: 16000,
                                        hardSignals,
                                    },
                                    db,
                                    messages,
                                    undefined,
                                    busting,
                                );
                                return {
                                    bytes: JSON.stringify(messages),
                                    rebuilt: result.m0Materialized,
                                };
                            }
                            const result = injectM0M1({
                                db,
                                state: getOrCreateSessionMeta(db, session),
                                sessionId: session,
                                projectPath: project,
                                projectDirectory: home,
                                injectDocs: false,
                                memoryInjectionBudgetTokens: budget,
                                historyBudgetTokens: 16000,
                                hardSignals,
                                isCacheBustingPass: busting,
                            });
                            return {
                                bytes: JSON.stringify(result.preparedMessages),
                                rebuilt: result.m0RematerializedThisPass,
                            };
                        };
                        let previous = pass(true);
                        expect(previous.rebuilt).toBe(true);
                        expect(previous.bytes).toContain("Never push");
                        expect(
                            applyAgentMemoryMutation(db, {
                                key: "initial-m1",
                                projectPath: project,
                                sourceSessionId: session,
                                operation: "update",
                                targets: [{ id: 2, revision: 1 }],
                                content:
                                    "Never push without approval: agent delta before classify.",
                            }).state,
                        ).toBe("applied");
                        db.exec("UPDATE memories SET classified_at=7 WHERE id<=2");
                        previous = pass(true);
                        expect(previous.rebuilt).toBe(false);
                        expect(previous.bytes).toContain("agent delta before classify");
                        results.push({
                            host,
                            seed,
                            step: -1,
                            kind: 2,
                            bytes: previous.bytes,
                            rebuilt: true,
                        });
                        for (let step = 0; step < 80; step++) {
                            const id = 1 + (next() % 32);
                            if (step % 4 === 0) {
                                db.prepare(
                                    "UPDATE memories SET safety_critical=NULL WHERE id=?",
                                ).run(id);
                                const classified = await classifySafetyFixture(db, project);
                                classifications += classified.result.classified;
                                if (!parent) expect(getMemoryById(db, id)?.safetyCritical).toBe(1);
                            }
                            const item = Number(
                                db
                                    .prepare(`INSERT INTO memory_classification_items
                            (project_path,memory_id,saved_revision,source_session_id,tool_call_part_id,save_ordinal,excerpt)
                            VALUES(?,?,?,?,?,1,'score excerpt')`)
                                    .run(project, id, step + 100, session, `score-${step}`)
                                    .lastInsertRowid,
                            );
                            expect(
                                recordItemScores(
                                    db,
                                    [item],
                                    [
                                        {
                                            item,
                                            importance: (next() % 100) + 1,
                                            proposedClass: "durable",
                                        },
                                    ],
                                ),
                            ).toBe(1);
                            expect(
                                db
                                    .prepare(
                                        "SELECT project_memory_epoch n FROM project_state WHERE project_path=?",
                                    )
                                    .get(project),
                            ).toBeNull();
                            const kind = step === 79 ? 2 : next() % 3;
                            if (kind === 2) budget = [500, 700, 1200, 8000][next() % 4]!;
                            const served = pass(kind !== 0, kind === 2);
                            expect(served.rebuilt, `${host}/${seed}/${step}`).toBe(kind === 2);
                            if (kind !== 2)
                                expect(
                                    served.bytes,
                                    `${host}/${seed}/${step}: automation leaked on replay`,
                                ).toBe(previous.bytes);
                            results.push({
                                host,
                                seed,
                                step,
                                kind,
                                bytes: served.bytes,
                                rebuilt: served.rebuilt,
                            });
                            if (kind === 0) replays++;
                            else if (kind === 1) softs++;
                            else hards++;
                            previous = served;
                        }
                    } finally {
                        db.close();
                        cleanupTestTempDir(home);
                    }
                }
                console.log(
                    `s02 ${host}: passes=320 defer=${replays} SOFT=${softs} natural HARD=${hards} classified=${classifications} parent=${parent}`,
                );
                if (process.env.S02_CACHE_OUT)
                    writeFileSync(process.env.S02_CACHE_OUT, JSON.stringify(results));
            } finally {
                Date.now = clock;
            }
        },
        120_000,
    );
}
