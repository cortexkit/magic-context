import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "../../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { initializeDatabase } from "../storage-db";
import type { CheckReply, CheckRequest } from "./lifecycle-gates";
import { lifecycleTextHash } from "./lifecycle-text";
import { getMemoryById, insertMemory } from "./storage-memory";
import { allocateTurnOneSend, commitTurnOnePublication } from "./turn-one-publication";
import {
    freezeTurnOneProfile,
    parseTurnTwoStageEnvelope,
    recoverTurnTwoStages,
    runTurnTwo,
    sweepTurnTwoStages,
    type TurnTwoCarrier,
    TurnTwoOutcomeUnknownError,
    type TurnTwoRunInput,
    type TurnTwoStageReply,
} from "./turn-two";
import { authorizationFixture } from "./turn-two-test-fixtures.test";

const PROJECT = "git:turn-two-adversarial";
const A = authorizationFixture(
    {
        lane: "opencode-2",
        carrier: "hidden-completion",
        provider: "test",
        modelId: "A",
        variant: null,
        temperature: null,
        thinkingLevel: null,
    },
    "historian system",
);
const B = authorizationFixture(
    {
        ...A.request.requestedIdentity,
        modelId: "B",
    },
    "historian system",
);

function fixture(
    count = 3,
    filename = ":memory:",
    authorization = A,
    actual = authorization.profile,
) {
    const db = new Database(filename);
    initializeDatabase(db);
    const send = allocateTurnOneSend(db, {
        projectPath: PROJECT,
        sessionId: "adversarial",
        harness: "opencode2",
        carrier: "hidden-completion",
        lane: "enabled",
        chunkStart: 1,
        chunkEnd: 2,
    });
    authorization.persist(db, send.stageKey, actual);
    db.transaction(() =>
        commitTurnOnePublication(db, {
            send,
            projectPath: PROJECT,
            sessionId: "adversarial",
            compartments: [
                { id: 1, startMessage: 1, endMessage: 2, replyStartMessage: 1, replyEndMessage: 2 },
            ],
            blocks: [{ role: "user", startOrdinal: 1, endOrdinal: 1, parts: ["New rule."] }],
            candidateFacts: Array.from({ length: count }, (_, index) => ({
                category: "CONSTRAINTS",
                content: `New rule ${index}.`,
                anchor: { compartmentIndex: 1, startOrdinal: 1, endOrdinal: 1 },
            })),
            honourAnchors: true,
        }),
    )();
    const ids = (
        db.prepare("SELECT id FROM memory_pending_facts ORDER BY id").all() as { id: number }[]
    ).map((row) => row.id);
    return { db, send, ids };
}
function rows(f: ReturnType<typeof fixture>) {
    return f.db
        .prepare(
            "SELECT state,fact_attempts,reason,reserved_stage_key FROM memory_pending_facts ORDER BY id",
        )
        .all();
}
function answer(decisions: unknown[], scores?: unknown[], profile = A.profile): TurnTwoStageReply {
    return {
        text: JSON.stringify({ result: { step: "turn_two", decisions, scores } }),
        profile,
        lengthCapped: false,
    };
}
function passing(request: CheckRequest, authorization = A): CheckReply {
    return {
        profile: authorization.checkProfile(request.systemHash),
        usage: null,
        verdicts: (request.kind === "compatibility" ? request.pairs : request.operands).map(
            (operand) => ({
                id: operand.id,
                verdict: request.kind === "disproof" || request.kind === "support" ? "yes" : "no",
            }),
        ),
    };
}
function run(
    f: ReturnType<typeof fixture>,
    reply: TurnTwoStageReply | (() => TurnTwoStageReply),
    extra: Partial<TurnTwoRunInput> = {},
    check = async (request: CheckRequest) => passing(request),
) {
    const carrier: TurnTwoCarrier = {
        carrier: "hidden-completion",
        harness: "opencode2",
        childSessionId: "child",
        send: async () => (typeof reply === "function" ? reply() : reply),
        check,
    };
    return runTurnTwo(f.db, {
        projectPath: PROJECT,
        publicationId: f.send.publicationId,
        sessionId: "adversarial",
        lane: "enabled",
        memoryEnabled: true,
        autoPromote: true,
        validatedProfiles: A.rows,
        carrier,
        ...extra,
    });
}
function item(f: ReturnType<typeof fixture>, content = "Score me.") {
    const memory = insertMemory(f.db, { projectPath: PROJECT, category: "ARCHITECTURE", content });
    f.db
        .prepare(
            "INSERT INTO memory_classification_items(project_path,memory_id,saved_revision,source_session_id,tool_call_part_id,save_ordinal,excerpt) VALUES(?,?,1,'adversarial',?,1,'Score evidence.')",
        )
        .run(PROJECT, memory.id, `score-${memory.id}`);
    const seq = (
        f.db
            .prepare("SELECT MAX(enqueue_sequence) AS n FROM memory_classification_items")
            .get() as { n: number }
    ).n;
    return { memory, seq };
}

async function recoverReply(
    f: ReturnType<typeof fixture>,
    reply: TurnTwoStageReply,
    check = async (request: CheckRequest) => passing(request),
) {
    let closes = 0;
    const input = {
        projectPath: PROJECT,
        memoryEnabled: true,
        autoPromote: true,
        validatedProfiles: [...A.rows, ...B.rows],
        resolver: () => ({
            check,
            reattach: async () => ({ kind: "reply" as const, reply }),
            close: async () => {
                closes++;
            },
        }),
    };
    await recoverTurnTwoStages(f.db, input);
    await recoverTurnTwoStages(f.db, input);
    return closes;
}
function edit(f: ReturnType<typeof fixture>, factId: number) {
    const memory = insertMemory(f.db, {
        projectPath: PROJECT,
        category: "CONSTRAINTS",
        content: "Old rule. Keep rule.",
    });
    return {
        memory,
        decision: {
            fact_id: factId,
            check: "Audit fixture.",
            action: "edit",
            target_id: memory.id,
            revision: 1,
            replaced: [{ memory_id: memory.id, clause: 1, block: 1, excerpt: "New rule." }],
            kept: [{ memory_id: memory.id, clause: 2 }],
            added: [{ text: "New rule. ", block: 1, excerpt: "New rule." }],
            final_text: "New rule. Keep rule.",
        },
    };
}

describe("T3 adversarial authorization", () => {
    for (const [field, value] of [
        ["modelId", "unallowlisted"],
        ["lane", "opencode-1"],
        ["carrier", "opencode-session"],
        ["provider", "other"],
        ["variant", "other"],
        ["temperature", 0],
        ["thinkingLevel", "high"],
        ["systemHash", lifecycleTextHash("other")],
        ["schemaHash", lifecycleTextHash("other")],
        ["toolHash", lifecycleTextHash("other")],
    ] as const) {
        test(`identity gate: substituted ${field} refuses every action and scores before item resolution`, async () => {
            for (const action of [
                "new",
                "conflict",
                "covered",
                "edit",
                "merge",
                "replaces",
                "abstain",
                "retire",
                "promote_rule",
            ]) {
                const f = fixture(1);
                try {
                    const scored = item(f);
                    await run(
                        f,
                        answer(
                            [
                                {
                                    fact_id: f.ids[0],
                                    check: "Audit fixture.",
                                    action,
                                    target_id: scored.memory.id,
                                },
                            ],
                            [{ item: scored.seq, importance: 1, class: "stable" }],
                            { ...A.profile, [field]: value },
                        ),
                    );
                    expect(rows(f)).toEqual([
                        {
                            state: "retryable",
                            fact_attempts: 1,
                            reason: "identity_mismatch",
                            reserved_stage_key: null,
                        },
                    ]);
                    expect(
                        f.db.prepare("SELECT state FROM memory_classification_items").all(),
                    ).toEqual([{ state: "pending" }]);
                    expect(getMemoryById(f.db, scored.memory.id)?.importance).toBe(
                        scored.memory.importance,
                    );
                    expect(f.db.prepare("SELECT COUNT(*) AS n FROM memory_history").get()).toEqual({
                        n: 0,
                    });
                } finally {
                    f.db.close();
                }
            }
        });
    }

    test("identity gate: turn one A then allowlisted B precedes malformed decisions and preserves frozen A", async () => {
        const f = fixture();
        try {
            const before = f.db
                .prepare(
                    "SELECT reported_profile_json FROM memory_stage_attempts WHERE stage_key=?",
                )
                .get(f.send.stageKey);
            const result = await run(f, () => {
                throw new TurnTwoOutcomeUnknownError();
            });
            const closes = await recoverReply(
                f,
                answer(
                    [null, { fact_id: f.ids[0], check: "Audit fixture.", action: "invented" }],
                    [],
                    B.profile,
                ),
            );
            expect(rows(f)).toEqual(
                f.ids.map(() => ({
                    state: "retryable",
                    fact_attempts: 1,
                    reason: "identity_mismatch",
                    reserved_stage_key: null,
                })),
            );
            expect(
                f.db
                    .prepare("SELECT state FROM memory_stage_attempts WHERE stage_key=?")
                    .get(result.stageKey!),
            ).toEqual({ state: "identity_mismatch" });
            expect(
                f.db
                    .prepare(
                        "SELECT reported_profile_json FROM memory_stage_attempts WHERE stage_key=?",
                    )
                    .get(f.send.stageKey),
            ).toEqual(before);
            expect(() => freezeTurnOneProfile(f.db, f.send.stageKey, B.profile)).toThrow(
                "immutable",
            );
            expect(closes).toBe(1);
        } finally {
            f.db.close();
        }
    });

    test("identity gate: ordered new keeps receipt when a later edit check answers as B", async () => {
        const f = fixture();
        try {
            const e = edit(f, f.ids[1]!);
            await run(f, () => {
                throw new TurnTwoOutcomeUnknownError();
            });
            const closes = await recoverReply(
                f,
                answer([
                    { fact_id: f.ids[0], check: "Audit fixture.", action: "new" },
                    e.decision,
                    { fact_id: f.ids[2], check: "Audit fixture.", action: "new" },
                ]),
                async (request) => passing(request, B),
            );
            expect(rows(f)).toEqual([
                {
                    state: "applied",
                    fact_attempts: 0,
                    reason: "inserted",
                    reserved_stage_key: null,
                },
                ...[1, 2].map(() => ({
                    state: "retryable",
                    fact_attempts: 1,
                    reason: "identity_mismatch",
                    reserved_stage_key: null,
                })),
            ]);
            expect(getMemoryById(f.db, e.memory.id)?.content).toBe("Old rule. Keep rule.");
            expect(f.db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 2 });
            expect(closes).toBe(1);
        } finally {
            f.db.close();
        }
    });
});

const malformedEnvelopes: Array<[string, (valid: TurnTwoStageReply) => TurnTwoStageReply]> = [
    ["free text", (r) => ({ ...r, text: `Here is the answer: ${r.text}` })],
    ["fenced JSON", (r) => ({ ...r, text: `\`\`\`json\n${r.text}\n\`\`\`` })],
    ["partial JSON", (r) => ({ ...r, text: r.text.slice(0, -2) })],
    ["multiple JSON", (r) => ({ ...r, text: `${r.text}\n${r.text}` })],
    ["truncation", (r) => ({ ...r, lengthCapped: true })],
    ["tool activity", (r) => ({ ...r, toolActivity: true })],
    ["wrong step", (r) => ({ ...r, text: r.text.replace("turn_two", "turn_one") })],
    ["missing step", (r) => ({ ...r, text: r.text.replace('"step":"turn_two",', "") })],
    [
        "nonarray decisions",
        (r) => ({ ...r, text: '{"result":{"step":"turn_two","decisions":{}}}' }),
    ],
    [
        "nonarray scores",
        (r) => ({ ...r, text: '{"result":{"step":"turn_two","decisions":[],"scores":{}}}' }),
    ],
];
describe("T3 adversarial parser", () => {
    for (const [name, corrupt] of malformedEnvelopes) {
        test(`parser guard: ${name} applies nothing and charges each fact once`, async () => {
            const f = fixture();
            try {
                const score = item(f);
                await run(
                    f,
                    corrupt(
                        answer(
                            f.ids.map((fact_id) => ({ fact_id, action: "new" })),
                            [{ item: score.seq, importance: 90, class: "stable" }],
                        ),
                    ),
                );
                expect(rows(f).map((row) => ({ ...(row as object), reason: undefined }))).toEqual(
                    f.ids.map(() => ({
                        state: "retryable",
                        fact_attempts: 1,
                        reason: undefined,
                        reserved_stage_key: null,
                    })),
                );
                expect(f.db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 1 });
                expect(f.db.prepare("SELECT state FROM memory_classification_items").get()).toEqual(
                    { state: "pending" },
                );
            } finally {
                f.db.close();
            }
        });
    }
    for (const [name, bad] of [
        [
            "unknown action",
            (id: number) => ({ fact_id: id, check: "Audit fixture.", action: "invented" }),
        ],
        ["unknown ID", () => ({ fact_id: 9999, check: "Audit fixture.", action: "new" })],
        ["unattributable", () => null],
        [
            "duplicate",
            (id: number) => [
                { fact_id: id, check: "Audit fixture.", action: "new" },
                { fact_id: id, check: "Audit fixture.", action: "new" },
            ],
        ],
        ["retire", (id: number) => ({ fact_id: id, check: "Audit fixture.", action: "retire" })],
        [
            "promote_rule",
            (id: number) => ({ fact_id: id, check: "Audit fixture.", action: "promote_rule" }),
        ],
    ] as const) {
        test(`parser guard: mixed ${name} keeps valid siblings and scores, malformed and missing are terminal`, async () => {
            const f = fixture();
            try {
                const score = item(f);
                const invalid = bad(f.ids[1]!);
                const reply = answer(
                    [
                        { fact_id: f.ids[0], check: "Audit fixture.", action: "new" },
                        ...(Array.isArray(invalid) ? invalid : [invalid]),
                    ],
                    [{ item: score.seq, importance: 90, class: "stable" }],
                );
                expect(parseTurnTwoStageEnvelope(reply, f.ids, [score.seq])).toMatchObject({
                    ok: true,
                    schemaValid: false,
                });
                await run(f, reply);
                expect(rows(f).map((row) => (row as { state: string }).state)).toEqual([
                    "applied",
                    "decided_pending",
                    "decided_pending",
                ]);
                expect(
                    rows(f).map((row) => (row as { fact_attempts: number }).fact_attempts),
                ).toEqual([0, 0, 0]);
                expect(getMemoryById(f.db, score.memory.id)?.importance).toBe(90);
                expect(f.db.prepare("SELECT state FROM memory_classification_items").get()).toEqual(
                    { state: "scored" },
                );
            } finally {
                f.db.close();
            }
        });
    }
    for (const [name, score] of [
        ["malformed", (seq: number) => ({ item: seq, importance: "90", class: "stable" })],
        ["out-of-range", (seq: number) => ({ item: seq, importance: 101, class: "stable" })],
        [
            "duplicate",
            (seq: number) => [
                { item: seq, importance: 90, class: "stable" },
                { item: seq, importance: 91, class: "stable" },
            ],
        ],
        ["unsent-item", () => ({ item: 9999, importance: 90, class: "stable" })],
    ] as const) {
        test(`${name === "unsent-item" ? "reservation" : "parser"} guard: ${name} score cannot rescore memory`, async () => {
            const f = fixture(1);
            try {
                const scored = item(f);
                const invalid =
                    name === "unsent-item"
                        ? { item: scored.seq, importance: 90, class: "stable" }
                        : score(scored.seq);
                if (name === "unsent-item")
                    f.db.prepare("UPDATE memory_classification_items SET excerpt=NULL").run();
                await run(
                    f,
                    answer(
                        [{ fact_id: f.ids[0], check: "Audit fixture.", action: "new" }],
                        Array.isArray(invalid) ? invalid : [invalid],
                    ),
                );
                expect(rows(f)).toMatchObject([{ state: "applied" }]);
                expect(getMemoryById(f.db, scored.memory.id)?.importance).toBe(
                    scored.memory.importance,
                );
                expect(f.db.prepare("SELECT state FROM memory_classification_items").get()).toEqual(
                    { state: "pending" },
                );
            } finally {
                f.db.close();
            }
        });
    }
    test("parser guard: null check entry becomes malformed_check, not a throw or retry", async () => {
        const f = fixture(1);
        try {
            const e = edit(f, f.ids[0]!);
            await run(f, answer([e.decision]), {}, async (request) => ({
                ...passing(request),
                verdicts: [null] as never,
            }));
            expect(rows(f)).toMatchObject([
                { state: "decided_pending", reason: "malformed_check", fact_attempts: 0 },
            ]);
            expect(getMemoryById(f.db, e.memory.id)?.content).toBe("Old rule. Keep rule.");
        } finally {
            f.db.close();
        }
    });
});

describe("T3 reservation and revision guards", () => {
    test("source-revision guard: stale edit consumes an attempt without changing its target", async () => {
        const f = fixture(1);
        try {
            const e = edit(f, f.ids[0]!);
            f.db.prepare("UPDATE memories SET revision=revision+1 WHERE id=?").run(e.memory.id);
            await run(f, answer([e.decision]));
            expect(rows(f)).toMatchObject([
                { state: "retryable", fact_attempts: 1, reason: "cas_loss" },
            ]);
            expect(getMemoryById(f.db, e.memory.id)?.content).toBe("Old rule. Keep rule.");
        } finally {
            f.db.close();
        }
    });
    for (const release of ["fact", "stage"]) {
        test(`reservation guard: reply after ${release} release changes no memory or score`, async () => {
            const f = fixture(1);
            try {
                const scored = item(f);
                await run(f, () => {
                    if (release === "stage")
                        f.db
                            .prepare(
                                "UPDATE memory_stage_attempts SET state='revoked' WHERE stage='turn_two'",
                            )
                            .run();
                    else
                        f.db
                            .prepare(
                                "UPDATE memory_pending_facts SET state='retryable',reserved_stage_key=NULL",
                            )
                            .run();
                    return answer(
                        [{ fact_id: f.ids[0], check: "Audit fixture.", action: "new" }],
                        [{ item: scored.seq, importance: 90, class: "stable" }],
                    );
                });
                expect(f.db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 1 });
                expect(f.db.prepare("SELECT state FROM memory_classification_items").get()).toEqual(
                    { state: "pending" },
                );
            } finally {
                f.db.close();
            }
        });
    }
    test("reservation guard: unknown outcome reattaches the same stage key without attempts or another send", async () => {
        const f = fixture(1);
        try {
            let sends = 0;
            let closes = 0;
            const initial = await run(f, () => {
                sends++;
                throw new TurnTwoOutcomeUnknownError();
            });
            expect(rows(f)).toMatchObject([{ state: "in_flight", fact_attempts: 0 }]);
            let attached = "";
            await recoverTurnTwoStages(f.db, {
                projectPath: PROJECT,
                memoryEnabled: true,
                autoPromote: true,
                validatedProfiles: A.rows,
                resolver: (record) => {
                    attached = record.stageKey;
                    return {
                        check: async (r) => passing(r),
                        reattach: async () => ({
                            kind: "reply",
                            reply: answer([
                                { fact_id: f.ids[0], check: "Audit fixture.", action: "new" },
                            ]),
                        }),
                        close: async () => {
                            closes++;
                        },
                    };
                },
            });
            expect(attached).toBe(initial.stageKey!);
            expect(sends).toBe(1);
            expect(closes).toBe(1);
            expect(rows(f)).toMatchObject([{ state: "applied", fact_attempts: 0 }]);
        } finally {
            f.db.close();
        }
    });
    test("reservation guard: C4 sweep revokes without attempts, applies nothing and releases once", async () => {
        const f = fixture();
        try {
            await run(f, () => {
                throw new TurnTwoOutcomeUnknownError();
            });
            let releases = 0,
                closes = 0;
            const resolver = () => ({
                check: async (r: CheckRequest) => passing(r),
                reattach: async () => ({ kind: "gone" as const }),
                onRelease: () => {
                    releases++;
                },
                close: async () => {
                    closes++;
                },
            });
            await sweepTurnTwoStages(f.db, { projectPath: PROJECT, resolver });
            await sweepTurnTwoStages(f.db, { projectPath: PROJECT, resolver });
            expect(rows(f)).toEqual(
                f.ids.map(() => ({
                    state: "retryable",
                    fact_attempts: 0,
                    reason: "turn_two_revoked",
                    reserved_stage_key: null,
                })),
            );
            expect(f.db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 0 });
            expect([releases, closes]).toEqual([1, 1]);
        } finally {
            f.db.close();
        }
    });
});

// Fixture imports must not make test data reachable from a production entry point.
test("fixture boundary guard: production sources never import turn-two test fixtures", () => {
    const packageRoot = resolve(import.meta.dir, "../../../..");
    const roots = [
        join(packageRoot, "src"),
        join(packageRoot, "scripts"),
        resolve(packageRoot, "../pi-plugin/src"),
    ];
    const offenders: string[] = [];
    const visit = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                visit(path);
                continue;
            }
            if (
                !/\.[cm]?[jt]sx?$/.test(path) ||
                /\.test\.tsx?$/.test(path) ||
                path.endsWith("turn-two-test-fixtures.test.ts")
            )
                continue;
            if (
                /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\()["'][^"']*turn-two-test-fixtures\.test["']/.test(
                    readFileSync(path, "utf8"),
                )
            )
                offenders.push(path);
        }
    };
    for (const root of roots) visit(root);
    expect(offenders).toEqual([]);
});

describe("T3 trial root authorization", () => {
    for (const variant of [
        "attested",
        "different-key",
        "other-root",
        "symlink-root",
        "non-disposable",
    ] as const) {
        test(`identity gate: trial ${variant} with an empty allowlist`, async () => {
            const base = join(realpathSync(tmpdir()), "magic-context");
            mkdirSync(base, { recursive: true });
            const root = createTestTempDirFromPath(join(base, "turn-two-trial-"));
            const other = createTestTempDirFromPath(join(base, "turn-two-other-"));
            const ordinary = createTestTempDirFromPath(
                join(realpathSync(tmpdir()), "turn-two-ordinary-"),
            );
            const link = join(other, "linked");
            symlinkSync(root, link, "dir");
            const attestedRoot =
                variant === "other-root"
                    ? other
                    : variant === "symlink-root"
                      ? link
                      : variant === "non-disposable"
                        ? ordinary
                        : root;
            const f = fixture(1, join(variant === "non-disposable" ? ordinary : root, "store.db"));
            try {
                const candidate =
                    variant === "different-key"
                        ? { ...A.request.requestedIdentity, thinkingLevel: "high" }
                        : A.request.requestedIdentity;
                await run(
                    f,
                    answer([{ fact_id: f.ids[0], check: "Audit fixture.", action: "new" }]),
                    {
                        validatedProfiles: [],
                        trialAuthorization: { candidate, attestedRoot },
                    },
                );
                expect(f.db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({
                    n: variant === "attested" ? 1 : 0,
                });
                expect(
                    f.db.prepare("SELECT COUNT(*) AS n FROM memory_pending_facts").get(),
                ).toEqual({ n: 1 });
                if (variant === "attested")
                    expect(rows(f)).toMatchObject([{ state: "applied", fact_attempts: 0 }]);
                else expect(rows(f)).not.toMatchObject([{ state: "decided_pending" }]);
            } finally {
                f.db.close();
                cleanupTestTempDir(root);
                cleanupTestTempDir(other);
                cleanupTestTempDir(ordinary);
            }
        });
    }
    for (const [lane, carrier] of [
        ["pi", "pi-historian-rpc"],
        ["omp", "pi-historian-rpc"],
    ] as const) {
        test(`identity gate: ${lane} cannot borrow ${lane === "pi" ? "omp" : "pi"} entry`, async () => {
            const own = authorizationFixture(
                { ...A.request.requestedIdentity, lane, carrier },
                "historian system",
            );
            const other = authorizationFixture(
                { ...own.request.requestedIdentity, lane: lane === "pi" ? "omp" : "pi" },
                "historian system",
            );
            const f = fixture(1, ":memory:", own);
            try {
                await run(
                    f,
                    answer(
                        [{ fact_id: f.ids[0], check: "Audit fixture.", action: "new" }],
                        [],
                        own.profile,
                    ),
                    {
                        validatedProfiles: other.rows,
                    },
                );
                expect(rows(f)).toMatchObject([
                    { state: "retryable", reason: "identity_mismatch", fact_attempts: 1 },
                ]);
                expect(f.db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 0 });
            } finally {
                f.db.close();
            }
        });
    }
});

describe("T3 persisted identity sources", () => {
    test("identity gate: requested A and frozen allowlisted fallback B applies only B's completion", async () => {
        const f = fixture(1, ":memory:", A, B.profile);
        try {
            await run(
                f,
                answer(
                    [{ fact_id: f.ids[0], check: "Audit fixture.", action: "new" }],
                    [],
                    B.profile,
                ),
                {
                    validatedProfiles: B.rows,
                },
            );
            expect(rows(f)).toMatchObject([{ state: "applied", fact_attempts: 0 }]);
        } finally {
            f.db.close();
        }
    });
    test("identity gate: frozen unallowlisted B is not authorized by requested A", async () => {
        const f = fixture(1, ":memory:", A, B.profile);
        try {
            await run(
                f,
                answer(
                    [{ fact_id: f.ids[0], check: "Audit fixture.", action: "new" }],
                    [],
                    B.profile,
                ),
            );
            expect(rows(f)).toMatchObject([
                { state: "retryable", fact_attempts: 1, reason: "identity_mismatch" },
            ]);
            expect(f.db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 0 });
        } finally {
            f.db.close();
        }
    });
    for (const field of [
        "system",
        "formatInstruction",
        "toolSurface",
        "checkToolSurface",
    ] as const) {
        test(`identity gate: recomputes persisted ${field} instead of trusting reported hashes`, async () => {
            const f = fixture(1);
            try {
                const request = {
                    ...A.request,
                    [field]: field.endsWith("Surface") ? ["substituted"] : "substituted",
                };
                f.db
                    .prepare("UPDATE memory_stage_attempts SET request_json=? WHERE stage_key=?")
                    .run(JSON.stringify(request), f.send.stageKey);
                await run(
                    f,
                    answer([{ fact_id: f.ids[0], check: "Audit fixture.", action: "new" }]),
                );
                expect(rows(f)).toMatchObject([
                    { state: "retryable", fact_attempts: 1, reason: "identity_mismatch" },
                ]);
                expect(f.db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 0 });
            } finally {
                f.db.close();
            }
        });
    }
});
