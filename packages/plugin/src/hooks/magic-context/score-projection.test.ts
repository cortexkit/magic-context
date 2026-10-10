import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
    injectM0M1Pi,
    materializeM0Pi,
    mustMaterializePi,
    type PiM0M1State,
    PiMaterializeContentionError,
    renderM0Pi,
} from "../../../../pi-plugin/src/inject-compartments-pi";
import { runPiHistorian } from "../../../../pi-plugin/src/pi-historian-runner";
import { acquireCompartmentLease } from "../../features/magic-context/compartment-lease";
import { getCompartments } from "../../features/magic-context/compartment-storage";
import { computeRescoreSourceIdentity } from "../../features/magic-context/rescore-identity";
import {
    getOrCreateSessionMeta,
    queueM0Mutation,
    setProjectState,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import type { SubagentRunner } from "../../shared/subagent-runner";
import fixture from "./__fixtures__/score-projection-parity.json";
import * as storedValidation from "./compartment-runner-validation";
import {
    injectM0M1,
    type M0HardSignals,
    type M0M1RenderOptions,
    type M0M1State,
    MaterializeContentionError,
    materializeM0,
    mustMaterialize,
} from "./inject-compartments";
import { createDefaultBoundarySnapshotForTests } from "./protected-tail-boundary";
import type { RawMessage } from "./read-session-raw";
import { computeRawRangeFingerprint } from "./read-session-true-raw-tokens";
import { buildReferenceBlocks } from "./reference-retrieval";
import {
    projectCompartmentScores,
    readAppliedScoreWatermark,
    readEffectiveReferenceCompartments,
} from "./score-projection";

const SESSION = "score-projection-session";
const PROJECT = "git:score-projection";
const openDbs: Database[] = [];

function makeDb(scores = fixture.baseScores): Database {
    const db = new Database(":memory:");
    openDbs.push(db);
    initializeDatabase(db);
    getOrCreateSessionMeta(db, SESSION);
    const insert = db.prepare(`INSERT INTO compartments
        (session_id, sequence, start_message, end_message, start_message_id, end_message_id,
            start_block_index, end_block_index, title, content, p1, p2, p3, p4,
            episode_type, created_at, importance, legacy)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, 'feature', 1234, ?, 0)`);
    scores.forEach((score, i) => {
        insert.run(
            SESSION,
            i,
            i * 2 + 1,
            i * 2 + 2,
            `start-${i}`,
            `end-${i}`,
            i === 0 ? 0 : null,
            i === 0 ? 1 : null,
            `row-${i}`,
            `row-${i}-P1`,
            `row-${i}-P2`,
            `row-${i}-P3`,
            `row-${i}-P4`,
            score,
        );
    });
    return db;
}

function selectScore(db: Database, rowIndex: number, score: number | null): void {
    db.transaction(() => {
        const row = getCompartments(db, SESSION)[rowIndex];
        const sequence =
            (
                db
                    .prepare(
                        "SELECT COALESCE(MAX(sequence), 0) AS n FROM compartment_score_selections WHERE session_id = ?",
                    )
                    .get(SESSION) as { n: number }
            ).n + 1;
        let revision: number | null = null;
        if (score !== null) {
            revision = Number(
                db
                    .prepare(`INSERT INTO compartment_score_revisions
                (compartment_id, session_id, source_identity, old_importance, new_importance,
                    rubric_version, prompt_hash, model, seed_ids, job_id, batch_id, attempt_id, completed_at, reason)
                VALUES (?, ?, ?, ?, ?, 1, 'prompt', 'model', '[]', 'job', 'batch', ?, 4321, 'reason')`)
                    .run(
                        row.id,
                        SESSION,
                        computeRescoreSourceIdentity(row),
                        row.importance,
                        score,
                        `attempt-${sequence}`,
                    ).lastInsertRowid,
            );
        }
        db.prepare(`INSERT INTO compartment_score_selections
            (session_id, compartment_id, sequence, revision_id, origin, job_id, batch_id, attempt_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
            SESSION,
            row.id,
            sequence,
            revision,
            score === null ? "undo" : "publication",
            score === null ? null : "job",
            score === null ? null : "batch",
            score === null ? null : `attempt-${sequence}`,
        );
    }).immediate();
}

function effectiveScores(db: Database, selector: "latest" | number = "latest"): number[] {
    return db
        .transaction(() =>
            projectCompartmentScores(
                db,
                SESSION,
                getCompartments(db, SESSION),
                selector,
            ).compartments.map((row) => row.importance),
        )
        .deferred();
}

function snapshot(db: Database): string {
    return JSON.stringify({
        meta: db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get(SESSION),
        rows: getCompartments(db, SESSION),
        history: db
            .prepare("SELECT * FROM compartment_history_versions WHERE session_id = ?")
            .get(SESSION),
        mutations: db.prepare("SELECT * FROM m0_mutation_log WHERE session_id = ?").all(SESSION),
        facts: db.prepare("SELECT * FROM session_facts WHERE session_id = ?").all(SESSION),
        embeddings: db.prepare("SELECT * FROM compartment_chunk_embeddings").all(),
        project: db.prepare("SELECT * FROM project_state").all(),
    });
}

function persistedM0(db: Database): string {
    return getOrCreateSessionMeta(db, SESSION).cachedM0Bytes!.toString("utf8");
}

function assertTiers(body: string, tiers: number[]): void {
    tiers.forEach((tier, i) => {
        for (let candidate = 1; candidate <= 4; candidate++) {
            expect(body.includes(`row-${i}-P${candidate}`)).toBe(tier === candidate);
        }
    });
}

function harness(runtime: "TS" | "Pi", db: Database) {
    let state: M0M1State = getOrCreateSessionMeta(db, SESSION);
    const options: M0M1RenderOptions = {
        db,
        sessionId: SESSION,
        state,
        projectPath: PROJECT,
        projectDirectory: "",
        injectDocs: false,
        historyBudgetTokens: fixture.historyBudgetTokens,
    };
    const pi: PiM0M1State = {
        sessionId: SESSION,
        projectIdentity: PROJECT,
        projectDirectory: "",
        injectDocs: false,
        historyBudgetTokens: fixture.historyBudgetTokens,
    };
    return {
        options,
        pi,
        restart() {
            state = getOrCreateSessionMeta(db, SESSION);
            options.state = state;
        },
        decide() {
            return runtime === "TS" ? mustMaterialize(options) : mustMaterializePi(pi, db);
        },
        signal(signals: M0HardSignals) {
            options.hardSignals = signals;
            pi.hardSignals = signals;
        },
        inject(recompute = false): { m0: string; m1: string; committed: boolean } {
            if (runtime === "TS") {
                const result = injectM0M1({ ...options, isCacheBustingPass: recompute });
                return {
                    m0: result.m0Bytes!.toString("utf8"),
                    m1: result.m1Text!,
                    committed: result.m0RematerializedThisPass,
                };
            }
            const messages: Parameters<typeof injectM0M1Pi>[2] = [];
            const result = injectM0M1Pi(pi, db, messages, undefined, recompute);
            const text = (index: number) => {
                const message = messages[index];
                if (message.role !== "user") throw new Error("Expected injected user message");
                const content = message.content;
                return typeof content === "string"
                    ? content
                    : content
                          .filter((part) => part.type === "text")
                          .map((part) => part.text)
                          .join("");
            };
            return { m0: text(0), m1: text(1), committed: result.m0Materialized };
        },
        fold(beforeCommit?: () => void) {
            return runtime === "TS"
                ? materializeM0({ ...options, beforeCacheCommitForTest: beforeCommit })
                      .snapshotMarkers
                : materializeM0Pi({ ...pi, beforeCacheCommitForTest: beforeCommit }, db)
                      .snapshotMarkers;
        },
        freshFallback() {
            options.allowFreshContentionFallback = true;
            options.beforeCacheCommitForTest = () => {
                throw new MaterializeContentionError();
            };
            pi.allowFreshContentionFallback = true;
            pi.beforeCacheCommitForTest = () => {
                throw new PiMaterializeContentionError("test contention");
            };
            return this.inject();
        },
    };
}

afterEach(() => {
    for (const db of openDbs.splice(0)) db.close();
});

for (const runtime of ["TS", "Pi"] as const) {
    describe(`${runtime} score projection`, () => {
        for (const seeded of [0, 1]) {
            it(`score publication leaves the frozen cache and raw identity unchanged (seeded=${seeded})`, () => {
                const db = makeDb();
                db.prepare(
                    "UPDATE compartment_history_versions SET seeded = ?, rewrite_version = 7 WHERE session_id = ?",
                ).run(seeded, SESSION);
                const h = harness(runtime, db);
                const first = h.inject();
                expect(h.decide().value).toBe(false);
                const before = snapshot(db);
                const identities = getCompartments(db, SESSION).map(computeRescoreSourceIdentity);
                selectScore(db, 0, 100);
                expect(effectiveScores(db)[0]).toBe(100);
                expect(snapshot(db)).toBe(before);
                expect(getCompartments(db, SESSION).map(computeRescoreSourceIdentity)).toEqual(
                    identities,
                );
                expect(h.decide().value).toBe(false);
                for (let i = 0; i < 2; i++) {
                    expect(h.inject()).toEqual({ ...first, committed: false });
                    expect(snapshot(db)).toBe(before);
                }
                h.restart();
                expect(h.inject()).toEqual({ ...first, committed: false });
                expect(readAppliedScoreWatermark(db, SESSION)).toBe(0);
            });
        }

        for (const reason of [
            "first_render",
            "missing_cache",
            "ttl_idle",
            "model_change",
            "system_hash",
            "project_memory_epoch",
            "m0_mutation",
            "host_compaction",
        ] as const) {
            if (runtime === "Pi" && reason === "host_compaction") continue;
            it(`committing ${reason} renders and persists the acquired latest selection`, () => {
                const db = makeDb();
                const h = harness(runtime, db);
                if (reason !== "first_render") h.inject();
                selectScore(db, 0, 100);
                const signals: M0HardSignals = {
                    systemHash: "",
                    modelKey: "",
                    cacheExpired: false,
                    lastResponseTime: 0,
                };
                const time = getOrCreateSessionMeta(db, SESSION).cachedM0MaterializedAt ?? 0;
                if (reason === "missing_cache") {
                    db.prepare(
                        "UPDATE session_meta SET cached_m0_bytes = NULL WHERE session_id = ?",
                    ).run(SESSION);
                    h.restart();
                }
                if (reason === "ttl_idle") {
                    signals.cacheExpired = true;
                    signals.lastResponseTime = time + 1;
                }
                if (reason === "model_change") signals.modelKey = "anthropic/claude-sonnet-4-5";
                if (reason === "system_hash") signals.systemHash = "changed-system";
                if (reason === "project_memory_epoch")
                    setProjectState(db, PROJECT, { projectMemoryEpoch: 1 });
                if (reason === "m0_mutation")
                    queueM0Mutation(db, {
                        sessionId: SESSION,
                        mutationType: "recomp_boundary_change",
                    });
                if (reason === "host_compaction")
                    signals.hostCompaction = {
                        compactionMessageId: "native",
                        summaryMessageId: "native-summary",
                        completedAt: time + 1,
                    };
                h.signal(signals);
                expect(h.decide().value).toBe(true);
                const result = h.inject();
                expect(result.committed).toBe(true);
                expect(readAppliedScoreWatermark(db, SESSION)).toBe(1);
                assertTiers(result.m0, fixture.steps[4].tiers!);
                expect(persistedM0(db)).toBe(result.m0);
                expect(getCompartments(db, SESSION).map((row) => row.importance)).toEqual(
                    fixture.baseScores,
                );
            });
        }

        it("captures L at acquisition and leaves a later publication pending", () => {
            const db = makeDb();
            const h = harness(runtime, db);
            selectScore(db, 0, 100);
            const markers = h.fold(() => selectScore(db, 2, 100));
            expect(markers.scoreSelectionWatermark).toBe(1);
            expect(readAppliedScoreWatermark(db, SESSION)).toBe(1);
            expect(effectiveScores(db, 1)).toEqual([100, 50, 50, 50, 50, 50, 50, 50]);
            expect(effectiveScores(db)).toEqual([100, 50, 100, 50, 50, 50, 50, 50]);
            assertTiers(persistedM0(db), fixture.steps[4].tiers!);
            h.restart();
            expect(h.decide().value).toBe(false);
            h.inject();
            expect(readAppliedScoreWatermark(db, SESSION)).toBe(1);
        });

        for (const applied of [false, true]) {
            it(`fresh non-persisted fallback uses committed W and writes nothing (applied=${applied})`, () => {
                const db = makeDb();
                const h = harness(runtime, db);
                if (applied) selectScore(db, 0, 100);
                const first = h.inject();
                selectScore(db, 0, null);
                if (!applied) selectScore(db, 0, 100);
                h.signal({
                    systemHash: "fallback-bust",
                    modelKey: "",
                    cacheExpired: false,
                    lastResponseTime: 0,
                });
                const before = snapshot(db);
                const fallback = h.freshFallback();
                expect(fallback.committed).toBe(false);
                expect(fallback.m0).toBe(first.m0);
                expect(fallback.m1).toBe(first.m1);
                expect(snapshot(db)).toBe(before);
                expect(readAppliedScoreWatermark(db, SESSION)).toBe(applied ? 1 : 0);
                expect(h.freshFallback().m0).toBe(first.m0);
            });
        }

        it("SOFT adds a new compartment at P1 without adopting pending scores", () => {
            const db = makeDb();
            const h = harness(runtime, db);
            const first = h.inject();
            selectScore(db, 0, 100);
            db.prepare(`INSERT INTO compartments
                (session_id, sequence, start_message, end_message, title, content, p1, p2, p3, p4, importance, legacy, created_at)
                VALUES (?, 8, 17, 18, 'new row', '', 'NEW-P1', 'NEW-P2', 'NEW-P3', 'NEW-P4', 1, 0, 2345)`).run(
                SESSION,
            );
            expect(h.decide().value).toBe(false);
            const soft = h.inject(true);
            expect(soft.committed).toBe(false);
            expect(soft.m0).toBe(first.m0);
            expect(soft.m1).toContain("NEW-P1");
            expect(soft.m1).not.toContain("NEW-P2");
            expect(readAppliedScoreWatermark(db, SESSION)).toBe(0);
        });

        it("pressure-driven committing HARD adopts pending scores", () => {
            const db = makeDb();
            const h = harness(runtime, db);
            h.inject();
            selectScore(db, 0, 100);
            const insert = db.prepare(`INSERT INTO compartments
                (session_id, sequence, start_message, end_message, title, content, p1, p2, p3, p4, importance, legacy, created_at)
                VALUES (?, ?, ?, ?, 'pressure row', '', ?, 'dense', 'brief', 'anchor', 50, 0, 2345)`);
            for (let i = 8; i < 18; i++)
                insert.run(SESSION, i, i * 2 + 1, i * 2 + 2, "large delta ".repeat(40));
            expect(h.decide().value).toBe(false);
            expect(h.inject(true).committed).toBe(true);
            expect(readAppliedScoreWatermark(db, SESSION)).toBe(1);
        });
    });
}

it("TS and Pi execute the shared C2 parity schedule with independent tier and pressure expectations", () => {
    const tsDb = makeDb();
    const piDb = makeDb();
    const ts = harness("TS", tsDb);
    const pi = harness("Pi", piDb);
    let lastFold: { m0: string; watermark: number } | undefined;
    for (const step of fixture.steps) {
        for (const [db, h] of [
            [tsDb, ts],
            [piDb, pi],
        ] as const) {
            if (step.action === "publish") selectScore(db, step.row!, step.score!);
            if (step.action === "undo") selectScore(db, step.row!, null);
            if (step.action === "change-source") {
                const row = getCompartments(db, SESSION)[step.row!];
                db.prepare("UPDATE compartments SET title = 'source changed' WHERE id = ?").run(
                    row.id,
                );
            }
            if (step.action === "fold") {
                h.fold();
                h.restart();
                assertTiers(persistedM0(db), step.tiers!);
                expect(readAppliedScoreWatermark(db, SESSION)).toBe(step.watermark!);
                // Calculate pressure from the decay formula and fixed tier costs directly;
                // importing the renderer's tier/pressure helpers would hide shared bugs.
                const bounds = [0.201, 0.729, 1.322, 2.587];
                const naturalTiers = step.effective.map((score, i) => {
                    const z = (7 - i) / (24 * 2 ** ((score - 50) / 25));
                    const band = bounds.findIndex((bound) => z < bound);
                    return band < 0 ? 5 : band + 1;
                });
                const costs = [0, 322, 109, 35, 20, 0];
                expect(
                    naturalTiers.reduce((cost, tier) => cost + costs[tier], 0) /
                        fixture.historyBudgetTokens,
                ).toBeCloseTo(step.pressure!, 8);
            }
            expect(effectiveScores(db)).toEqual(step.effective);
            expect(getCompartments(db, SESSION).map((row) => row.importance)).toEqual(
                fixture.baseScores,
            );
        }
        expect(persistedM0(tsDb)).toBe(persistedM0(piDb));
        expect(readAppliedScoreWatermark(tsDb, SESSION)).toBe(
            readAppliedScoreWatermark(piDb, SESSION),
        );
        if (step.action === "fold")
            lastFold = { m0: persistedM0(tsDb), watermark: step.watermark! };
        else if (lastFold) {
            expect(persistedM0(tsDb)).toBe(lastFold.m0);
            expect(readAppliedScoreWatermark(tsDb, SESSION)).toBe(lastFold.watermark);
        }
    }
});

it("invalid source identity and base undo do not revive an earlier selection", () => {
    const db = makeDb();
    const rows = getCompartments(db, SESSION);
    selectScore(db, 0, 100);
    selectScore(db, 0, null);
    expect(effectiveScores(db)[0]).toBe(1);
    selectScore(db, 1, 1);
    db.prepare("UPDATE compartments SET start_block_index = 3 WHERE id = ?").run(rows[1].id);
    expect(effectiveScores(db)[1]).toBe(50);
    selectScore(db, 2, 100);
    db.prepare("UPDATE compartments SET created_at = created_at + 1 WHERE id = ?").run(rows[2].id);
    expect(effectiveScores(db)[2]).toBe(50);
});

it("historian diverse references use effective bands and recent references omit importance", () => {
    const db = makeDb(Array.from({ length: 16 }, () => 50));
    const before = snapshot(db);
    const blocks = (rows: ReturnType<typeof getCompartments>) =>
        buildReferenceBlocks({ sessionId: SESSION, chunkStart: 33, sessionCompartments: rows });
    const base = blocks(getCompartments(db, SESSION));
    expect(blocks(readEffectiveReferenceCompartments(db, SESSION))).toEqual(base);
    selectScore(db, 0, 100);
    const effective = blocks(readEffectiveReferenceCompartments(db, SESSION));
    expect(effective.sessionReferences).toContain('importance="100"');
    expect(effective.sessionReferences).toContain("row-0");
    expect(effective).not.toEqual(base);
    const headers = effective.sessionReferences.match(/<compartment [^>]*>/g)!;
    expect(headers.length).toBe(7);
    expect(headers.slice(-4).every((header) => !header.includes("importance="))).toBe(true);
    expect(snapshot(db)).toBe(before);
    expect(readAppliedScoreWatermark(db, SESSION)).toBe(0);
});

it("direct Pi non-committing render uses W rather than the pending effective view", () => {
    const db = makeDb();
    const h = harness("Pi", db);
    selectScore(db, 0, 100);
    h.inject();
    const first = persistedM0(db);
    selectScore(db, 0, null);
    const before = snapshot(db);
    expect(renderM0Pi(h.pi, db)).toBe(first);
    expect(snapshot(db)).toBe(before);
});

it("score projection preserves raw boundary identity on caller-owned rows", () => {
    const db = makeDb();
    selectScore(db, 0, 100);
    const raw = getCompartments(db, SESSION);
    const identity = raw.map(computeRescoreSourceIdentity);
    const projected = db
        .transaction(() => projectCompartmentScores(db, SESSION, raw, "latest"))
        .deferred();
    expect(projected.watermark).toBe(1);
    expect(projected.compartments[0].importance).toBe(100);
    expect(projected.compartments[0]).not.toBe(raw[0]);
    expect(raw.map(computeRescoreSourceIdentity)).toEqual(identity);
    expect(raw[0].importance).toBe(1);
});

for (const runtime of ["TS", "Pi"] as const) {
    it(`${runtime} rolls bytes and watermark back together when cache commit fails`, () => {
        const db = makeDb();
        const h = harness(runtime, db);
        h.inject();
        selectScore(db, 0, 100);
        const before = snapshot(db);
        db.exec(`CREATE TEMP TRIGGER reject_score_cache_commit
            BEFORE UPDATE OF cached_m0_score_selection_watermark ON session_meta
            BEGIN SELECT RAISE(ABORT, 'test cache commit failure'); END`);
        expect(() => h.fold()).toThrow("test cache commit failure");
        expect(snapshot(db)).toBe(before);
        expect(readAppliedScoreWatermark(db, SESSION)).toBe(0);
    });
}

for (const runtime of ["TS", "Pi"] as const) {
    it(`${runtime} fresh fallback before any commit ignores pending scores and writes nothing`, () => {
        const db = makeDb();
        const h = harness(runtime, db);
        selectScore(db, 0, 100);
        const before = snapshot(db);
        const fallback = h.freshFallback();
        expect(fallback.committed).toBe(false);
        assertTiers(fallback.m0, fixture.steps[0].tiers!);
        expect(readAppliedScoreWatermark(db, SESSION)).toBe(0);
        expect(snapshot(db)).toBe(before);
    });
}

it("retained reference copies do not inherit selections after source replacement", () => {
    const db = makeDb();
    const retained = getCompartments(db, SESSION);
    selectScore(db, 0, 100);
    expect(readEffectiveReferenceCompartments(db, SESSION, retained)[0].importance).toBe(100);
    db.prepare("UPDATE compartments SET created_at = created_at + 1 WHERE id = ?").run(
        retained[0].id,
    );
    expect(readEffectiveReferenceCompartments(db, SESSION, retained)[0].importance).toBe(1);
    expect(retained[0].importance).toBe(1);
});

it("Pi historian prompt uses rescored references while boundary validation keeps raw scores", async () => {
    const db = makeDb(Array.from({ length: 16 }, () => 50));
    selectScore(db, 0, 100);
    const rawBefore = getCompartments(db, SESSION);
    const identityBefore = rawBefore.map(computeRescoreSourceIdentity);
    const messages: RawMessage[] = Array.from({ length: 40 }, (_, i) => ({
        ordinal: i + 1,
        id: i % 2 === 0 ? `start-${Math.floor(i / 2)}` : `end-${Math.floor(i / 2)}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `raw turn ${i + 1}` }],
    }));
    const boundary = {
        ...createDefaultBoundarySnapshotForTests(SESSION),
        offset: 33,
        offsetMessageId: "start-16",
        protectedTailStart: 37,
        protectedTailStartMessageId: "start-18",
        eligibleEndOrdinal: 37,
        eligibleEndMessageId: "end-17",
        rawMessageCountAtTrigger: 40,
        rawLastMessageIdAtTrigger: "end-19",
        contextLimit: 200_000,
        rawRangeFingerprint: computeRawRangeFingerprint(messages.slice(32, 36), 33, 37),
    };
    expect(boundary.rawRangeFingerprint.length).toBeGreaterThan(0);
    const holder = "score-reference-test";
    expect(acquireCompartmentLease(db, SESSION, holder)).not.toBeNull();
    const originalValidate = storedValidation.validateStoredCompartments;
    const rawInputs: number[][] = [];
    const validation = spyOn(storedValidation, "validateStoredCompartments").mockImplementation(
        (rows) => {
            rawInputs.push(rows.map((row) => row.importance ?? 50));
            return originalValidate(rows);
        },
    );
    let capturedPrompt = "";
    let calls = 0;
    let rawReads = 0;
    const abort = new AbortController();
    const runner = {
        harness: "pi",
        run: async (options: Parameters<SubagentRunner["run"]>[0]) => {
            calls++;
            capturedPrompt = options.userMessage;
            abort.abort();
            return { ok: false, error: "aborted capture-only historian", durationMs: 1 };
        },
    } as unknown as SubagentRunner;
    try {
        await runPiHistorian({
            db,
            sessionId: SESSION,
            directory: process.cwd(),
            provider: {
                readMessages: () => {
                    rawReads++;
                    return messages;
                },
            },
            runner,
            historianModel: "test/model",
            historianChunkTokens: 20_000,
            historianContextLimit: 200_000,
            producerContextLimits: new Map([["test/model", 200_000]]),
            boundarySnapshot: boundary,
            compartmentLeaseHolderId: holder,
            signal: abort.signal,
            memoryEnabled: false,
        });
        expect(calls).toBe(1);
        expect(rawReads).toBeGreaterThan(0);
        expect(rawInputs[0]).toEqual(Array.from({ length: 16 }, () => 50));
        const references =
            capturedPrompt.match(/<session_references>[\s\S]*?<\/session_references>/)?.[0] ?? "";
        expect(references).toContain('importance="100"');
        expect(references).toContain("row-0");
        const headers = references.match(/<compartment [^>]*>/g)!;
        expect(headers.length).toBe(7);
        expect(headers.slice(-4).every((header) => !header.includes("importance="))).toBe(true);
        expect(getCompartments(db, SESSION).map(computeRescoreSourceIdentity)).toEqual(
            identityBefore,
        );
        expect(readAppliedScoreWatermark(db, SESSION)).toBe(0);
    } finally {
        validation.mockRestore();
    }
});
