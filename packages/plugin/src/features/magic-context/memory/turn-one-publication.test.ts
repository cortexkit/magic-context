import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { splitFactAnchorPrefix } from "../../../hooks/magic-context/compartment-parser";
import {
    openCodeTurnTwoToolHash,
    openCodeTurnTwoToolSurface,
} from "../../../hooks/magic-context/historian-turn-two-carrier";
import { openCodeTurnOneAuthorization } from "../../../hooks/magic-context/historian-turn-two-step";
import { Database } from "../../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { initializeDatabase } from "../storage-db";
import vectors from "./turn-one-counter-vectors.json";
import {
    allocateTurnOneSend,
    blocksSentToHistorian,
    commitTurnOnePublication,
    keepPublishedFact,
    publishedFacts,
    readTurnOneFailureCount,
    recordTurnOneCounter,
    resolveTurnOneFactAnchor,
    resolveTurnOneLane,
    selectTurnOneExecution,
    type TurnOnePrintedBlock,
    type TurnOneSend,
} from "./turn-one-publication";
import { persistTurnOneAuthorization } from "./turn-two";
import { loadTurnTwoAllowlist } from "./turn-two-allowlist";
import { authorizationFixture } from "./turn-two-test-fixtures.test";

interface AnchorGolden {
    compartments: Array<[number, number]>;
    blocks: Array<[number, number]>;
    cases: Array<{
        name: string;
        line: string;
        blocks?: Array<[number, number]>;
        expect: {
            content: string;
            compartment: number | null;
            range: [number, number] | null;
            resolved: { compartment: number; blocks: Array<[number, number]> } | null;
        };
    }>;
    keep: Array<{
        name: string;
        index: number | null;
        persisted: number;
        droppedTail: boolean;
        weakFinal: number | null;
        keep: boolean;
    }>;
}

const goldens = JSON.parse(
    readFileSync(
        resolve(
            import.meta.dir,
            "../../../../../../crates/mc-module/tests/fixtures/turn-one-anchor-goldens.json",
        ),
        "utf8",
    ),
) as AnchorGolden;

function store(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    return db;
}

const PROJECT = "git:turn-one";
const SESSION = "ses-turn-one";

describe("turn-one selection and durable counter", () => {
    for (const harness of ["opencode", "opencode2"])
        for (const provider of ["test", "opencode"]) {
            test(`carrier surface extraction preserves ${harness}/${provider} hash and persisted bytes`, () => {
                const carrier = harness === "opencode" ? "opencode-session" : "hidden-completion";
                const input = {
                    harness,
                    carrier,
                    provider,
                    agent: "historian",
                    observedToolSurface: provider === "test" ? [] : ["read"],
                };
                const beforeExtraction =
                    provider === "test"
                        ? "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
                        : harness === "opencode"
                          ? "2d8ae24172e9dd76cba9ceb476941d7b82f3de88a9941b021cffbbd0b39b6133"
                          : "8a2d0b87e8c712cc8e06c5c3f8de5e7f9dc8edcca03079a7aec0cb6436294927";
                expect(openCodeTurnTwoToolHash(input)).toBe(beforeExtraction);
                const request = openCodeTurnOneAuthorization({
                    harness,
                    carrier,
                    model: `${provider}/model`,
                    system: "combined",
                });
                const db = store();
                try {
                    const send = allocate(db);
                    persistTurnOneAuthorization(db, send.stageKey, request);
                    const row = db
                        .prepare("SELECT request_json FROM memory_stage_attempts WHERE stage_key=?")
                        .get(send.stageKey) as { request_json: string };
                    expect(JSON.parse(row.request_json).toolSurface).toEqual(
                        openCodeTurnTwoToolSurface(input),
                    );
                    expect(JSON.parse(row.request_json).checkToolSurface).toEqual(
                        openCodeTurnTwoToolSurface(input),
                    );
                    expect(JSON.parse(row.request_json).requestedIdentity.historianToolHash).toBe(
                        beforeExtraction,
                    );
                } finally {
                    db.close();
                }
            });
        }
    const fixture = authorizationFixture(
        {
            lane: "opencode-1",
            carrier: "opencode-session",
            provider: "test",
            modelId: "model",
            variant: null,
            temperature: null,
            thinkingLevel: null,
        },
        "combined system",
        [],
    );
    test("trial selection is exclusive and requires the attested non-symlinked disposable store", () => {
        const base = join(realpathSync(tmpdir()), "magic-context");
        mkdirSync(base, { recursive: true });
        const root = createTestTempDirFromPath(join(base, "turn-one-trial-"));
        const alias = `${root}-alias`;
        const db = new Database(join(root, "store.db"));
        initializeDatabase(db);
        try {
            symlinkSync(root, alias, "dir");
            const input = {
                projectPath: PROJECT,
                request: fixture.request,
                canContinue: true,
                allowlist: loadTurnTwoAllowlist({
                    version: 1,
                    entries: [fixture.request.requestedIdentity],
                }),
            };
            expect(
                selectTurnOneExecution(db, {
                    ...input,
                    trialAuthorization: {
                        candidate: fixture.request.requestedIdentity,
                        attestedRoot: root,
                    },
                }),
            ).toMatchObject({ lane: "enabled", refused: false });
            for (const trialAuthorization of [
                { candidate: fixture.request.requestedIdentity, attestedRoot: alias },
                {
                    candidate: { ...fixture.request.requestedIdentity, lane: "omp" as const },
                    attestedRoot: root,
                },
                {
                    candidate: {
                        ...fixture.request.requestedIdentity,
                        carrier: "hidden-completion" as const,
                    },
                    attestedRoot: root,
                },
                { candidate: fixture.request.requestedIdentity, attestedRoot: process.cwd() },
            ])
                expect(selectTurnOneExecution(db, { ...input, trialAuthorization })).toMatchObject({
                    refused: true,
                });
        } finally {
            db.close();
            rmSync(alias, { force: true });
            cleanupTestTempDir(root);
        }
    });
    for (const turnTwo of ["allowlist", "off"] as const)
        for (const twoPass of [false, true]) {
            test(`automatic selection with turn_two=${turnTwo} and two_pass=${twoPass}`, () => {
                const db = store();
                try {
                    const selection = selectTurnOneExecution(db, {
                        projectPath: PROJECT,
                        request: fixture.request,
                        turnTwo,
                        twoPass,
                        canContinue: true,
                        allowlist: loadTurnTwoAllowlist({
                            version: 1,
                            entries: [fixture.request.requestedIdentity],
                        }),
                    });
                    expect(selection.lane).toBe(
                        turnTwo === "allowlist" && !twoPass ? "enabled" : "dormant",
                    );
                } finally {
                    db.close();
                }
            });
        }
    test("counter writes S1 rows and follows failure, failure, reset, failure", () => {
        const db = store();
        try {
            for (const event of vectors.sequences[0]!.rows) {
                recordTurnOneCounter(db, {
                    projectPath: "/fixture-project",
                    key: vectors.key,
                    harness: "opencode2",
                    carrier: "hidden-completion",
                    state: event.row.state as "parse_failed" | "counter_reset",
                });
                expect(readTurnOneFailureCount(db, "/fixture-project", vectors.key)).toBe(
                    event.expectedCount,
                );
            }
            const actual = db
                .prepare("SELECT * FROM memory_stage_attempts ORDER BY run_attempt")
                .all() as Array<Record<string, unknown>>;
            expect(actual).toHaveLength(4);
            for (const [index, row] of actual.entries()) {
                const expected = vectors.sequences[0]!.rows[index]!.row;
                expect({
                    ...row,
                    request_json: JSON.parse(row.request_json as string),
                }).toMatchObject({ ...expected, started_at: row.started_at });
            }
            expect(db.prepare("SELECT COUNT(*) AS n FROM memory_publications").get()).toEqual({
                n: 0,
            });
        } finally {
            db.close();
        }
    });
});

function allocate(db: Database, sessionId = SESSION): TurnOneSend {
    return allocateTurnOneSend(db, {
        projectPath: PROJECT,
        sessionId,
        harness: "opencode",
        carrier: "opencode-session",
        lane: "enabled",
        chunkStart: 10,
        chunkEnd: 22,
    });
}

const BLOCKS: TurnOnePrintedBlock[] = [
    { role: "U", startOrdinal: 10, endOrdinal: 10, parts: ["cap is 64 KiB"] },
    { role: "A", startOrdinal: 11, endOrdinal: 12, parts: ["TC: read a / b", "kept 64 KiB"] },
    { role: "U", startOrdinal: 13, endOrdinal: 14, parts: ["ttl five minutes"] },
];

function commit(
    db: Database,
    send: TurnOneSend,
    facts: Parameters<typeof commitTurnOnePublication>[1]["candidateFacts"],
    compartmentIds: [number, number] = [101, 102],
) {
    return db
        .transaction(() =>
            commitTurnOnePublication(db, {
                send,
                projectPath: PROJECT,
                sessionId: SESSION,
                compartments: [
                    {
                        id: compartmentIds[0],
                        startMessage: 10,
                        endMessage: 12,
                        replyStartMessage: 10,
                        replyEndMessage: 12,
                    },
                    {
                        id: compartmentIds[1],
                        startMessage: 13,
                        endMessage: 14,
                        replyStartMessage: 13,
                        replyEndMessage: 14,
                    },
                ],
                blocks: BLOCKS,
                candidateFacts: facts,
                honourAnchors: true,
            }),
        )
        .immediate();
}

function count(db: Database, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("turn-one anchor goldens shared with the Rust validator", () => {
    for (const golden of goldens.cases) {
        test(golden.name, () => {
            const { content, anchor } = splitFactAnchorPrefix(golden.line);
            expect(content).toBe(golden.expect.content);
            expect(anchor?.compartmentIndex ?? null).toBe(golden.expect.compartment);
            expect(
                anchor?.startOrdinal === undefined || anchor.endOrdinal === undefined
                    ? null
                    : [anchor.startOrdinal, anchor.endOrdinal],
            ).toEqual(golden.expect.range);
            const blocks = (golden.blocks ?? goldens.blocks).map(([start, end]) => ({
                startOrdinal: start,
                endOrdinal: end,
            }));
            const resolved = resolveTurnOneFactAnchor(
                anchor,
                goldens.compartments.map(([start, end]) => ({
                    startMessage: start,
                    endMessage: end,
                })),
                blocks,
            );
            expect(
                resolved && {
                    compartment: resolved.compartmentIndex,
                    blocks: resolved.blockIndexes.map((index) => [
                        blocks[index].startOrdinal,
                        blocks[index].endOrdinal,
                    ]),
                },
            ).toEqual(golden.expect.resolved);
        });
    }
});

describe("published-fact policy shared with the Rust validator", () => {
    for (const golden of goldens.keep) {
        test(golden.name, () => {
            expect(
                keepPublishedFact(
                    golden.index ?? undefined,
                    golden.persisted,
                    golden.droppedTail,
                    golden.weakFinal,
                ),
            ).toBe(golden.keep);
        });
    }

    test("published facts keep their position in the reply", () => {
        const kept = publishedFacts(
            [
                { category: "NAMING", content: "Unanchored." },
                { category: "NAMING", content: "Tail.", anchor: { compartmentIndex: 2 } },
                { category: "NAMING", content: "Head.", anchor: { compartmentIndex: 1 } },
            ],
            1,
            true,
            null,
        );
        expect(kept.map((fact) => [fact.content, fact.factIndex])).toEqual([["Head.", 2]]);
    });
});

describe("turn-one publication", () => {
    test("a range spanning published compartments stays a candidate with an unknown anchor", () => {
        const db = store();
        try {
            const result = commit(db, allocate(db), [
                {
                    category: "CONSTRAINTS",
                    content: "Evidence spans two published compartments.",
                    anchor: { compartmentIndex: 1, startOrdinal: 11, endOrdinal: 13 },
                },
            ]);
            expect(result).toMatchObject({
                candidatesInserted: 1,
                anchoredCandidates: 0,
                blocksStored: 0,
            });
            expect(
                db
                    .prepare(
                        "SELECT content, anchor_known, compartment_id FROM memory_pending_facts",
                    )
                    .all(),
            ).toEqual([
                {
                    content: "Evidence spans two published compartments.",
                    anchor_known: 0,
                    compartment_id: null,
                },
            ]);
            expect(count(db, "memory_fact_block_links")).toBe(0);
        } finally {
            db.close();
        }
    });
    test("two-pass publication excludes cited ranges in a discarded compartment despite a kept label", () => {
        const db = store();
        try {
            const send = allocate(db);
            const result = commitTurnOnePublication(db, {
                send,
                projectPath: PROJECT,
                sessionId: SESSION,
                honourAnchors: true,
                compartments: [
                    {
                        id: 101,
                        startMessage: 10,
                        endMessage: 12,
                        replyStartMessage: 10,
                        replyEndMessage: 12,
                    },
                ],
                blocks: BLOCKS,
                candidateFacts: [
                    {
                        category: "CONSTRAINTS",
                        content: "Tail fact with a kept label",
                        anchor: { compartmentIndex: 1, startOrdinal: 13, endOrdinal: 14 },
                    },
                    {
                        category: "CONSTRAINTS",
                        content: "Retained evidence",
                        anchor: { compartmentIndex: 1, startOrdinal: 10, endOrdinal: 10 },
                    },
                    { category: "CONSTRAINTS", content: "No anchor" },
                    {
                        category: "CONSTRAINTS",
                        content: "Crosses the boundary",
                        anchor: { compartmentIndex: 1, startOrdinal: 12, endOrdinal: 13 },
                    },
                ],
            });
            expect(result.candidatesInserted).toBe(2);
            expect(
                db.prepare("SELECT content FROM memory_pending_facts ORDER BY fact_index").all(),
            ).toEqual([{ content: "Retained evidence" }, { content: "No anchor" }]);
        } finally {
            db.close();
        }
    });
    test("every production lane is dormant", () => {
        expect(resolveTurnOneLane()).toBe("dormant");
        expect(resolveTurnOneLane("enabled")).toBe("enabled");
    });

    test("allocates the publication id with turn one's send record and reuses it until it commits", () => {
        const db = store();
        try {
            const first = allocate(db);
            const retry = allocate(db);
            expect(retry.publicationId).toBe(first.publicationId);
            expect(retry.runAttempt).toBe(first.runAttempt + 1);
            const sends = db
                .prepare(
                    "SELECT publication_id, run_attempt, stage, session_id, state FROM memory_stage_attempts ORDER BY run_attempt",
                )
                .all();
            expect(sends).toEqual([
                {
                    publication_id: first.publicationId,
                    run_attempt: 1,
                    stage: "turn_one",
                    session_id: SESSION,
                    state: "superseded",
                },
                {
                    publication_id: first.publicationId,
                    run_attempt: 2,
                    stage: "turn_one",
                    session_id: SESSION,
                    state: "dispatched",
                },
            ]);
            expect(
                db
                    .prepare(
                        "SELECT commit_order, committed_at FROM memory_publications WHERE publication_id=?",
                    )
                    .get(first.publicationId),
            ).toEqual({ commit_order: null, committed_at: null });
            // Another session never inherits the id.
            expect(allocate(db, "ses-other").publicationId).not.toBe(first.publicationId);

            commit(db, retry, []);
            const next = allocate(db);
            expect(next.publicationId).not.toBe(first.publicationId);
            expect(next.runAttempt).toBe(1);
        } finally {
            db.close();
        }
    });

    test("commits a publication exactly once; a retried commit writes nothing", () => {
        const db = store();
        try {
            const send = allocate(db);
            const fact = {
                category: "CONSTRAINTS",
                content: "Cap is 64 KiB.",
                anchor: { compartmentIndex: 1, startOrdinal: 11, endOrdinal: 12 },
            };
            const result = commit(db, send, [fact]);
            expect(result).toMatchObject({
                commitOrder: 1,
                candidatesInserted: 1,
                activityIncrements: 2,
            });
            const snapshot = () => ({
                facts: count(db, "memory_pending_facts"),
                blocks: count(db, "memory_fact_blocks"),
                ledger: count(db, "memory_activity_ledger"),
                publication: db
                    .prepare("SELECT commit_order FROM memory_publications WHERE publication_id=?")
                    .get(send.publicationId),
            });
            const before = snapshot();
            expect(() => commit(db, send, [fact])).toThrow(/already committed/);
            expect(snapshot()).toEqual(before);
            expect(
                db
                    .prepare("SELECT state FROM memory_stage_attempts WHERE stage_key=?")
                    .get(send.stageKey),
            ).toEqual({ state: "published" });

            // Commit order is monotonic across publications.
            expect(commit(db, allocate(db, "ses-b"), [], [201, 202]).commitOrder).toBe(2);
        } finally {
            db.close();
        }
    });

    test("activity ledger counts each new compartment once per publication", () => {
        const db = store();
        try {
            const send = allocate(db);
            expect(commit(db, send, []).activityIncrements).toBe(2);
            expect(
                db
                    .prepare(
                        "SELECT project_path, publication_id, compartment_id FROM memory_activity_ledger ORDER BY sequence",
                    )
                    .all(),
            ).toEqual([
                { project_path: PROJECT, publication_id: send.publicationId, compartment_id: 101 },
                { project_path: PROJECT, publication_id: send.publicationId, compartment_id: 102 },
            ]);
        } finally {
            db.close();
        }
    });

    test("binds anchored candidates to the reply's durable compartment and stores each block once", () => {
        const db = store();
        try {
            const send = allocate(db);
            const result = commit(db, send, [
                {
                    category: "CONSTRAINTS",
                    content: "Cap is 64 KiB.",
                    anchor: { compartmentIndex: 1, startOrdinal: 10, endOrdinal: 12 },
                },
                {
                    category: "CONFIG_VALUES",
                    content: "Kept 64 KiB.",
                    anchor: { compartmentIndex: 1, startOrdinal: 11, endOrdinal: 12 },
                },
                {
                    category: "CONFIG_VALUES",
                    content: "TTL is five minutes.",
                    anchor: { compartmentIndex: 2, startOrdinal: 13, endOrdinal: 14 },
                },
                // Unknown anchors are never guessed.
                { category: "NAMING", content: "No anchor given." },
                // Cited evidence outside the publication is excluded, not stored as unknown.
                {
                    category: "NAMING",
                    content: "Discarded tail.",
                    anchor: { compartmentIndex: 3, startOrdinal: 15, endOrdinal: 15 },
                },
                // Not a promotable category: never a candidate.
                { category: "EPISODE", content: "Not durable." },
            ]);
            expect(result).toMatchObject({
                candidatesInserted: 4,
                anchoredCandidates: 3,
                blocksStored: 3,
                authorityElsewhere: false,
            });
            expect(
                db
                    .prepare(
                        "SELECT fact_index, compartment_id, anchor_known, state, fact_attempts, reason FROM memory_pending_facts ORDER BY fact_index",
                    )
                    .all(),
            ).toEqual([
                {
                    fact_index: 0,
                    compartment_id: 101,
                    anchor_known: 1,
                    state: "retryable",
                    fact_attempts: 0,
                    reason: null,
                },
                {
                    fact_index: 1,
                    compartment_id: 101,
                    anchor_known: 1,
                    state: "retryable",
                    fact_attempts: 0,
                    reason: null,
                },
                {
                    fact_index: 2,
                    compartment_id: 102,
                    anchor_known: 1,
                    state: "retryable",
                    fact_attempts: 0,
                    reason: null,
                },
                {
                    fact_index: 3,
                    compartment_id: null,
                    anchor_known: 0,
                    state: "retryable",
                    fact_attempts: 0,
                    reason: null,
                },
            ]);
            expect(
                db
                    .prepare(
                        "SELECT source_session_id, start_ordinal, end_ordinal, role, parts_json, joined_text FROM memory_fact_blocks ORDER BY start_ordinal",
                    )
                    .all(),
            ).toEqual([
                {
                    source_session_id: SESSION,
                    start_ordinal: 10,
                    end_ordinal: 12,
                    role: "mixed",
                    parts_json: JSON.stringify([
                        "[10] U: cap is 64 KiB",
                        "[11-12] A: TC: read a / b / kept 64 KiB",
                    ]),
                    joined_text: "[10] U: cap is 64 KiB / [11-12] A: TC: read a / b / kept 64 KiB",
                },
                {
                    source_session_id: SESSION,
                    start_ordinal: 11,
                    end_ordinal: 12,
                    role: "A",
                    parts_json: JSON.stringify(["TC: read a / b", "kept 64 KiB"]),
                    joined_text: "TC: read a / b / kept 64 KiB",
                },
                {
                    source_session_id: SESSION,
                    start_ordinal: 13,
                    end_ordinal: 14,
                    role: "U",
                    parts_json: JSON.stringify(["ttl five minutes"]),
                    joined_text: "ttl five minutes",
                },
            ]);
            expect(
                db
                    .prepare(
                        `SELECT f.fact_index, b.start_ordinal FROM memory_fact_block_links l
                         JOIN memory_pending_facts f ON f.id=l.fact_id JOIN memory_fact_blocks b ON b.id=l.block_id
                         ORDER BY f.fact_index, b.start_ordinal`,
                    )
                    .all(),
            ).toEqual([
                { fact_index: 0, start_ordinal: 10 },
                { fact_index: 1, start_ordinal: 11 },
                { fact_index: 2, start_ordinal: 13 },
            ]);
        } finally {
            db.close();
        }
    });

    test("binds nothing when the durable rows are not the reply's compartments", () => {
        const db = store();
        try {
            const send = allocate(db);
            const result = db
                .transaction(() =>
                    commitTurnOnePublication(db, {
                        send,
                        projectPath: PROJECT,
                        sessionId: SESSION,
                        // A row whose range differs from the reply's first compartment
                        // (10-12), although it covers the cited line.
                        compartments: [
                            {
                                id: 7,
                                startMessage: 10,
                                endMessage: 14,
                                replyStartMessage: 10,
                                replyEndMessage: 12,
                            },
                        ],
                        blocks: BLOCKS,
                        candidateFacts: [
                            {
                                category: "CONSTRAINTS",
                                content: "Cap is 64 KiB.",
                                anchor: { compartmentIndex: 1, startOrdinal: 10, endOrdinal: 10 },
                            },
                        ],
                        honourAnchors: true,
                    }),
                )
                .immediate();
            expect(result).toMatchObject({ candidatesInserted: 1, anchoredCandidates: 0 });
            expect(
                db.prepare("SELECT compartment_id, anchor_known FROM memory_pending_facts").get(),
            ).toEqual({ compartment_id: null, anchor_known: 0 });
            expect(count(db, "memory_fact_blocks")).toBe(0);
        } finally {
            db.close();
        }
    });

    test("under module memory authority candidates are authority_elsewhere and memories stay untouched", () => {
        const db = store();
        try {
            db.exec(
                "CREATE TABLE IF NOT EXISTS authority_managed (project_path TEXT PRIMARY KEY, context_store_uuid TEXT NOT NULL, marked_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS authority_repair_pending (project_path TEXT PRIMARY KEY, started_at INTEGER NOT NULL)",
            );
            db.prepare(
                "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, 'uuid', 1)",
            ).run(PROJECT);
            const memoriesBefore = db.prepare("SELECT * FROM memories").all();
            const send = allocate(db);
            const result = commit(db, send, [
                { category: "CONSTRAINTS", content: "Cap is 64 KiB." },
                { category: "NAMING", content: "Use stable names." },
            ]);
            expect(result).toMatchObject({ candidatesInserted: 2, authorityElsewhere: true });
            expect(
                db
                    .prepare(
                        "SELECT content, anchor_known, state, fact_attempts, reason FROM memory_pending_facts ORDER BY fact_index",
                    )
                    .all(),
            ).toEqual([
                {
                    content: "Cap is 64 KiB.",
                    anchor_known: 0,
                    state: "retryable",
                    fact_attempts: 0,
                    reason: "authority_elsewhere",
                },
                {
                    content: "Use stable names.",
                    anchor_known: 0,
                    state: "retryable",
                    fact_attempts: 0,
                    reason: "authority_elsewhere",
                },
            ]);
            expect(db.prepare("SELECT * FROM memories").all()).toEqual(memoriesBefore);
        } finally {
            db.close();
        }
    });

    test("keeps only blocks whose whole line reached the historian", () => {
        const text = "[1] U: a\n[2] A: b\n[3] U: c";
        const blocks = [
            { id: "a", textEnd: 8 },
            { id: "b", textEnd: 17 },
            { id: "c", textEnd: 26 },
        ];
        expect(blocksSentToHistorian(blocks, text, text).map((block) => block.id)).toEqual([
            "a",
            "b",
            "c",
        ]);
        expect(
            blocksSentToHistorian(blocks, text, `${text.slice(0, 17)}\n[… cut …]`).map(
                (block) => block.id,
            ),
        ).toEqual(["a", "b"]);
        expect(blocksSentToHistorian(undefined, text, text)).toEqual([]);
    });
});
