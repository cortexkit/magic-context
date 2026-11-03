import { describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { deleteSessionScopedRows } from "../storage-session-tables";
import { applyMemoryAdmission } from "./lifecycle-applier";
import { MAX_STAGE2_ATTEMPTS, RETRY_BACKLOG_PER_RUN } from "./lifecycle-constants";
import {
    CHECK_SYSTEM_PROMPTS,
    CheckOutcomeUnknownError,
    type CheckReply,
    type CheckRequest,
    type ReportedProfile,
} from "./lifecycle-gates";
import { lifecycleTextHash } from "./lifecycle-text";
import { getMemoryById, insertMemory } from "./storage-memory";
import { saveEmbedding } from "./storage-memory-embeddings";
import {
    allocateTurnOneSend,
    commitTurnOnePublication,
    type TurnOnePrintedBlock,
} from "./turn-one-publication";
import {
    runTurnTwo,
    TURN_TWO_PROMPT_MAX,
    TURN_TWO_UNKNOWN_MAX_VISITS,
    type TurnTwoCarrier,
    TurnTwoOutcomeUnknownError,
    type TurnTwoReattach,
    type TurnTwoRecoveryResolver,
    type TurnTwoRunInput,
    type TurnTwoStageReply,
} from "./turn-two";
import {
    __turnTwoChildrenTest,
    registerTurnTwoChild,
    retainedTurnTwoChild,
} from "./turn-two-children";
import { coverageNotice, LEXICAL_ONLY_NOTICE, parseTurnTwoEnvelope } from "./turn-two-envelope";
import { authorizationFixture } from "./turn-two-test-fixtures.test";

const PROJECT = "git:turn-two";
const AUTHORIZATION = authorizationFixture(
    {
        lane: "opencode-1",
        carrier: "hidden-completion",
        provider: "test",
        modelId: "validated-model",
        variant: null,
        temperature: 0,
        thinkingLevel: null,
    },
    "historian system prompt",
);
const PROFILE = AUTHORIZATION.profile;
const VALIDATED = AUTHORIZATION.rows;

function store(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    return db;
}

interface SeedFact {
    content: string;
    category?: string;
    /** The fact's source block; omitted for an unknown anchor. */
    block?: { ordinal: number; role?: string; parts: string[] };
}

let sessionCounter = 0;
/** Commit one turn-one publication with anchored candidates; returns its id and fact ids. */
function publish(
    db: Database,
    facts: SeedFact[],
    sessionId = `ses-${++sessionCounter}`,
    projectPath = PROJECT,
): { publicationId: string; factIds: number[]; sessionId: string } {
    const send = allocateTurnOneSend(db, {
        projectPath,
        sessionId,
        harness: "opencode",
        carrier: "test",
        lane: "enabled",
        chunkStart: 1,
        chunkEnd: 1000,
    });
    AUTHORIZATION.persist(db, send.stageKey);
    const blocks: TurnOnePrintedBlock[] = facts.flatMap((fact) =>
        fact.block
            ? [
                  {
                      role: fact.block.role ?? "user",
                      startOrdinal: fact.block.ordinal,
                      endOrdinal: fact.block.ordinal,
                      parts: fact.block.parts,
                  },
              ]
            : [],
    );
    db.transaction(() =>
        commitTurnOnePublication(db, {
            send,
            projectPath,
            sessionId,
            compartments: [
                {
                    id: 1000 + sessionCounter,
                    startMessage: 1,
                    endMessage: 1000,
                    replyStartMessage: 1,
                    replyEndMessage: 1000,
                },
            ],
            blocks,
            candidateFacts: facts.map((fact) => ({
                category: fact.category ?? "CONSTRAINTS",
                content: fact.content,
                ...(fact.block
                    ? {
                          anchor: {
                              compartmentIndex: 1,
                              startOrdinal: fact.block.ordinal,
                              endOrdinal: fact.block.ordinal,
                          },
                      }
                    : {}),
            })),
            honourAnchors: true,
        }),
    )();
    const factIds = (
        db
            .prepare(
                "SELECT id FROM memory_pending_facts WHERE publication_id=? ORDER BY fact_index",
            )
            .all(send.publicationId) as Array<{ id: number }>
    ).map((row) => row.id);
    return { publicationId: send.publicationId, factIds, sessionId };
}

type ReplyScript = (prompt: string, send: number) => TurnTwoStageReply | Error | "unknown";
type CheckScript = (request: CheckRequest) => CheckReply | Error | "unknown";

function passingVerdicts(request: CheckRequest): CheckReply {
    const passing = request.kind === "disproof" || request.kind === "support" ? "yes" : "no";
    return {
        verdicts: (request.kind === "compatibility" ? request.pairs : request.operands).map(
            (operand) => ({ id: operand.id, verdict: passing as "yes" | "no" }),
        ),
        profile: AUTHORIZATION.checkProfile(request.systemHash),
        usage: { tokens: 7 },
    };
}

interface Stub {
    carrier: TurnTwoCarrier;
    prompts: string[];
    checks: CheckRequest[];
}
function stubCarrier(
    reply: ReplyScript,
    checkScript: CheckScript = passingVerdicts,
    child: string | null = "child-1",
): Stub {
    const prompts: string[] = [];
    const checks: CheckRequest[] = [];
    return {
        prompts,
        checks,
        carrier: {
            carrier: "stub",
            harness: "opencode",
            childSessionId: child,
            async send(prompt) {
                prompts.push(prompt);
                const result = reply(prompt, prompts.length);
                if (result === "unknown") throw new TurnTwoOutcomeUnknownError();
                if (result instanceof Error) throw result;
                return result;
            },
            async check(request) {
                checks.push(request);
                const result = checkScript(request);
                if (result === "unknown") throw new CheckOutcomeUnknownError();
                if (result instanceof Error) throw result;
                return result;
            },
        },
    };
}

function reply(
    decisions: unknown[],
    scores?: unknown[],
    profile: ReportedProfile | null = PROFILE,
): TurnTwoStageReply {
    return {
        text: JSON.stringify({
            result: { step: "turn_two", decisions, ...(scores ? { scores } : {}) },
        }),
        lengthCapped: false,
        profile,
        usage: { tokens: 11 },
    };
}

function run(
    db: Database,
    publicationId: string,
    carrier: TurnTwoCarrier,
    extra: Partial<TurnTwoRunInput> = {},
) {
    return runTurnTwo(db, {
        projectPath: PROJECT,
        publicationId,
        sessionId: "ses-owner",
        lane: "enabled",
        carrier,
        memoryEnabled: true,
        autoPromote: true,
        validatedProfiles: VALIDATED,
        ...extra,
    });
}

function fact(db: Database, id: number) {
    return db
        .prepare(
            "SELECT state,fact_attempts,reason,matched_memory_id,mapping_json,reserved_stage_key FROM memory_pending_facts WHERE id=?",
        )
        .get(id) as {
        state: string;
        fact_attempts: number;
        reason: string | null;
        matched_memory_id: number | null;
        mapping_json: string | null;
        reserved_stage_key: string | null;
    };
}

function factIdsIn(prompt: string): number[] {
    return [...prompt.matchAll(/^## Fact (\d+)/gm)].map((match) => Number(match[1]));
}

const count = (db: Database, sql: string, ...args: unknown[]) =>
    (db.prepare(sql).get(...(args as never[])) as { n: number }).n;

/** A memory "Old rule. Keep rule." and an edit fact evidenced by "New rule." */
function editFixture(db: Database) {
    const memory = insertMemory(db, {
        projectPath: PROJECT,
        category: "CONSTRAINTS",
        content: "Old rule. Keep rule.",
    });
    const published = publish(db, [
        { content: "New rule replaces the old one", block: { ordinal: 42, parts: ["New rule."] } },
    ]);
    const decision = {
        fact_id: published.factIds[0],
        check: "Audit fixture.",
        action: "edit",
        target_id: memory.id,
        revision: 1,
        removed: [],
        replaced: [{ memory_id: memory.id, clause: 1, block: 42, excerpt: "New rule." }],
        kept: [{ memory_id: memory.id, clause: 2 }],
        added: [{ text: "New rule. ", block: 42, excerpt: "New rule." }],
        final_text: "New rule. Keep rule.",
    };
    return { memory, published, decision };
}

describe("turn two pre-send skips", () => {
    test("a dormant lane or a carrier without a retained child sends nothing and consumes no attempt", async () => {
        const db = store();
        try {
            const { publicationId, factIds } = publish(db, [{ content: "Fact one" }]);
            const stub = stubCarrier(() => reply([]));
            expect(await run(db, publicationId, stub.carrier, { lane: "dormant" })).toMatchObject({
                status: "skipped",
                reason: "lane_dormant",
            });
            expect(
                await run(db, publicationId, { ...stub.carrier, childSessionId: null }),
            ).toMatchObject({ status: "skipped", reason: "carrier_cannot_continue" });
            expect(stub.prompts).toEqual([]);
            expect(fact(db, factIds[0]!)).toMatchObject({ state: "retryable", fact_attempts: 0 });
            expect(
                count(db, "SELECT COUNT(*) AS n FROM memory_stage_attempts WHERE stage='turn_two'"),
            ).toBe(0);
        } finally {
            db.close();
        }
    });

    test("authority_elsewhere makes no provider call and leaves the candidates retryable for the authority", async () => {
        const db = store();
        try {
            const { publicationId, factIds } = publish(db, [{ content: "Fact one" }]);
            db.exec(
                "CREATE TABLE IF NOT EXISTS authority_managed (project_path TEXT PRIMARY KEY, context_store_uuid TEXT NOT NULL, marked_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS authority_repair_pending (project_path TEXT PRIMARY KEY, started_at INTEGER NOT NULL)",
            );
            db.prepare(
                "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, 'module-store', 1)",
            ).run(PROJECT);
            const memories = db.prepare("SELECT * FROM memories").all();
            const stub = stubCarrier(() =>
                reply([{ fact_id: factIds[0], check: "Audit fixture.", action: "new" }]),
            );
            expect(await run(db, publicationId, stub.carrier)).toMatchObject({
                status: "skipped",
                reason: "authority_elsewhere",
                childInFlight: false,
            });
            expect(stub.prompts).toEqual([]);
            expect(stub.checks).toEqual([]);
            expect(fact(db, factIds[0]!)).toMatchObject({
                state: "retryable",
                fact_attempts: 0,
                reason: "authority_elsewhere",
            });
            expect(db.prepare("SELECT * FROM memories").all()).toEqual(memories);
        } finally {
            db.close();
        }
    });
});

describe("turn two fact selection", () => {
    test("backlog reservation protects the oldest facts from a full fresh batch", async () => {
        const db = store();
        try {
            const old = publish(
                db,
                [0, 1, 2].map((n) => ({ content: `${n} ${"old ".repeat(3750)}` })),
            );
            const fresh = publish(
                db,
                [0, 1, 2, 3].map((n) => ({ content: `${n} ${"fresh ".repeat(6333)}` })),
            );
            const stub = stubCarrier((prompt) =>
                reply(
                    factIdsIn(prompt).map((id) => ({
                        fact_id: id,
                        check: "Audit fixture.",
                        action: "abstain",
                    })),
                ),
            );
            await run(db, fresh.publicationId, stub.carrier);
            expect(factIdsIn(stub.prompts[0]!)).toEqual([
                ...fresh.factIds.slice(0, 3),
                ...old.factIds.slice(0, 2),
            ]);
            expect(stub.prompts[0]!.length).toBeLessThanOrEqual(TURN_TWO_PROMPT_MAX);
            for (const id of [old.factIds[2]!, fresh.factIds[3]!])
                expect(fact(db, id)).toMatchObject({
                    state: "retryable",
                    fact_attempts: 0,
                    reserved_stage_key: null,
                });
            expect(stub.prompts[0]).toContain("no later request is guaranteed");
        } finally {
            db.close();
        }
    });
    test("a 9-fact backlog sends the 8 oldest by (publication commit order, fact id); the ninth consumes nothing", async () => {
        const db = store();
        try {
            const backlog: number[] = [];
            // Two facts per publication, so commit order and fact id both order the backlog.
            for (let index = 0; index < 4; index++)
                backlog.push(
                    ...publish(db, [
                        { content: `Backlog ${index}a` },
                        { content: `Backlog ${index}b` },
                    ]).factIds,
                );
            backlog.push(...publish(db, [{ content: "Backlog 4a" }]).factIds);
            const current = publish(db, []);
            const stub = stubCarrier((prompt) =>
                reply(
                    factIdsIn(prompt).map((id) => ({
                        fact_id: id,
                        check: "Audit fixture.",
                        action: "abstain",
                    })),
                ),
            );
            await run(db, current.publicationId, stub.carrier);
            expect(backlog).toHaveLength(RETRY_BACKLOG_PER_RUN + 1);
            expect(factIdsIn(stub.prompts[0]!)).toEqual(backlog.slice(0, RETRY_BACKLOG_PER_RUN));
            expect(fact(db, backlog[8]!)).toMatchObject({ state: "retryable", fact_attempts: 0 });
            expect(stub.prompts[0]).toContain("(backlog)");
        } finally {
            db.close();
        }
    });

    test("decided_pending, applied and covered facts are never sent", async () => {
        const db = store();
        try {
            const first = publish(db, [
                { content: "Pending fact" },
                { content: "Applied fact" },
                { content: "Covered fact" },
            ]);
            const states = ["decided_pending", "applied", "covered"];
            for (const [index, id] of first.factIds.entries())
                db.prepare("UPDATE memory_pending_facts SET state=? WHERE id=?").run(
                    states[index]!,
                    id,
                );
            const stub = stubCarrier(() => reply([]));
            for (let runIndex = 0; runIndex < 2; runIndex++) {
                const next = publish(db, []);
                expect(await run(db, next.publicationId, stub.carrier)).toMatchObject({
                    status: "nothing_to_send",
                });
            }
            expect(stub.prompts).toEqual([]);
        } finally {
            db.close();
        }
    });
});

describe("turn two envelope outcomes", () => {
    test("extra fact ids are observable without losing valid decisions", async () => {
        const db = store();
        try {
            const current = publish(db, [{ content: "Use a serial queue." }]);
            const logs: string[] = [];
            const stub = stubCarrier(() =>
                reply([
                    { fact_id: current.factIds[0], check: "Audit fixture.", action: "abstain" },
                    { fact_id: 9999, check: "Audit fixture.", action: "new" },
                ]),
            );
            await run(db, current.publicationId, stub.carrier, { log: (line) => logs.push(line) });
            const row = db
                .prepare("SELECT reply_json FROM memory_stage_attempts WHERE stage='turn_two'")
                .get() as { reply_json: string };
            expect(JSON.parse(row.reply_json)).toMatchObject({
                envelopeValid: true,
                schemaValid: false,
                extraFactIds: [9999],
            });
            expect(logs).toContain("turn two: ignored extra fact ids: 9999");
            expect(fact(db, current.factIds[0]!)).toMatchObject({
                state: "decided_pending",
                reason: "abstain",
            });
        } finally {
            db.close();
        }
    });
    for (const [name, script] of [
        ["unparseable", () => ({ text: "not json", lengthCapped: false, profile: PROFILE })],
        ["length-capped", () => ({ ...reply([]), lengthCapped: true })],
        ["unwrapped", () => ({ text: '{"decisions":[]}', lengthCapped: false, profile: PROFILE })],
        [
            "wrong-step",
            () => ({
                text: '{"result":{"step":"turn_one","decisions":[]}}',
                lengthCapped: false,
                profile: PROFILE,
            }),
        ],
        [
            "tool-bearing",
            () => ({
                ...reply([{ fact_id: 1, check: "Audit fixture.", action: "new" }]),
                toolActivity: true,
            }),
        ],
        [
            "schema-invalid",
            () => ({ text: '{"verdict":1}', lengthCapped: false, profile: PROFILE }),
        ],
    ] as Array<[string, ReplyScript]>)
        test(`a ${name} envelope leaves every fact of the send retryable with one attempt consumed`, async () => {
            const db = store();
            try {
                const { publicationId, factIds } = publish(db, [
                    { content: "One" },
                    { content: "Two" },
                ]);
                const stub = stubCarrier(script);
                expect(await run(db, publicationId, stub.carrier)).toMatchObject({
                    status: "resolved",
                    childInFlight: false,
                });
                for (const id of factIds)
                    expect(fact(db, id)).toMatchObject({ state: "retryable", fact_attempts: 1 });
                expect(count(db, "SELECT COUNT(*) AS n FROM memories")).toBe(0);
            } finally {
                db.close();
            }
        });

    test("one malformed decision makes only that fact decided_pending; its sibling resolves", async () => {
        const db = store();
        try {
            const { publicationId, factIds } = publish(db, [
                { content: "Malformed one" },
                { content: "Admitted sibling" },
                { content: "Never decided" },
            ]);
            const stub = stubCarrier(() =>
                reply([
                    { fact_id: factIds[0], check: "Audit fixture.", action: "covered" },
                    { fact_id: factIds[1], check: "Audit fixture.", action: "new" },
                ]),
            );
            await run(db, publicationId, stub.carrier);
            expect(fact(db, factIds[0]!)).toMatchObject({
                state: "decided_pending",
                fact_attempts: 0,
                reason: "malformed_decision",
            });
            expect(fact(db, factIds[1]!)).toMatchObject({ state: "applied", reason: "inserted" });
            expect(fact(db, factIds[2]!)).toMatchObject({
                state: "decided_pending",
                fact_attempts: 0,
                reason: "missing_decision",
            });
            const later = stubCarrier(() => reply([]));
            await run(db, publish(db, []).publicationId, later.carrier);
            expect(later.prompts).toEqual([]);
            expect(
                db.prepare("SELECT content,expires_at IS NULL AS no_expiry FROM memories").all(),
            ).toEqual([{ content: "Admitted sibling", no_expiry: 1 }]);
        } finally {
            db.close();
        }
    });

    test("a stage-2 transport failure retries every fact once; the cap makes it decided_pending", async () => {
        const db = store();
        try {
            const { publicationId, factIds } = publish(db, [{ content: "Retry me" }]);
            db.prepare("UPDATE memory_pending_facts SET fact_attempts=? WHERE id=?").run(
                MAX_STAGE2_ATTEMPTS - 2,
                factIds[0]!,
            );
            const stub = stubCarrier(() => new Error("provider 500"));
            expect(await run(db, publicationId, stub.carrier)).toMatchObject({
                status: "failed",
                reason: "stage2_transport",
            });
            expect(fact(db, factIds[0]!)).toMatchObject({
                state: "retryable",
                fact_attempts: MAX_STAGE2_ATTEMPTS - 1,
            });
            await run(db, publish(db, []).publicationId, stub.carrier);
            expect(fact(db, factIds[0]!)).toMatchObject({
                state: "decided_pending",
                fact_attempts: MAX_STAGE2_ATTEMPTS,
            });
            expect(stub.prompts).toHaveLength(2);
        } finally {
            db.close();
        }
    });
});

describe("turn two decision matrix", () => {
    test("covered records its mapping on the fact only; a recitation stays decided_pending", async () => {
        const db = store();
        try {
            const memory = insertMemory(db, {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content: "Limit is 32 KiB. Keep it.",
            });
            const before = db.prepare("SELECT * FROM memories").all();
            const { publicationId, factIds } = publish(db, [
                { content: "The limit is 32 KiB", block: { ordinal: 3, parts: ["limit 32 KiB"] } },
                {
                    content: "Assistant said the limit",
                    block: { ordinal: 4, role: "assistant", parts: ["Limit is 32 KiB."] },
                },
                {
                    content: "Quoted the memory",
                    block: { ordinal: 5, parts: ["Limit is 32 KiB."] },
                },
            ]);
            const covered = (id: number, extra = {}) => ({
                fact_id: id,
                check: "Audit fixture.",
                action: "covered",
                target_id: memory.id,
                revision: 1,
                clauses: [1],
                ...extra,
            });
            const stub = stubCarrier(() =>
                reply([
                    covered(factIds[0]!),
                    covered(factIds[1]!),
                    covered(factIds[2]!, { excerpt: "Limit is 32 KiB." }),
                ]),
            );
            await run(db, publicationId, stub.carrier);
            expect(fact(db, factIds[0]!)).toMatchObject({
                state: "covered",
                matched_memory_id: memory.id,
                mapping_json: JSON.stringify({ memoryId: memory.id, revision: 1, clauses: [1] }),
            });
            expect(fact(db, factIds[1]!)).toMatchObject({
                state: "decided_pending",
                reason: "recitation",
                mapping_json: null,
            });
            expect(fact(db, factIds[2]!)).toMatchObject({
                state: "decided_pending",
                reason: "recitation",
                mapping_json: null,
            });
            expect(db.prepare("SELECT * FROM memories").all()).toEqual(before);
            expect(count(db, "SELECT COUNT(*) AS n FROM memory_clause_evidence")).toBe(0);
            // A covered fact is terminal: a later run does not send it.
            const later = stubCarrier(() => reply([]));
            await run(db, publish(db, []).publicationId, later.carrier);
            expect(later.prompts).toEqual([]);
        } finally {
            db.close();
        }
    });

    test("conflict admits with a non-successor pair link; under auto_promote false it records the disagreement only", async () => {
        const db = store();
        try {
            const target = insertMemory(db, {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content: "TTL is five minutes.",
            });
            const first = publish(db, [{ content: "TTL is ten minutes." }]);
            await run(
                db,
                first.publicationId,
                stubCarrier(() =>
                    reply([
                        {
                            fact_id: first.factIds[0],
                            check: "Audit fixture.",
                            action: "conflict",
                            target_id: target.id,
                        },
                    ]),
                ).carrier,
            );
            const admitted = fact(db, first.factIds[0]!);
            expect(admitted).toMatchObject({ state: "applied" });
            expect(db.prepare("SELECT left_id,right_id FROM memory_conflict_links").all()).toEqual([
                { left_id: target.id, right_id: admitted.matched_memory_id },
            ]);
            expect(count(db, "SELECT COUNT(*) AS n FROM memory_successor_links")).toBe(0);
            expect(getMemoryById(db, target.id)?.content).toBe("TTL is five minutes.");

            const second = publish(db, [{ content: "TTL is twenty minutes." }]);
            await run(
                db,
                second.publicationId,
                stubCarrier(() =>
                    reply([
                        {
                            fact_id: second.factIds[0],
                            check: "Audit fixture.",
                            action: "conflict",
                            target_id: target.id,
                        },
                    ]),
                ).carrier,
                { autoPromote: false },
            );
            expect(fact(db, second.factIds[0]!)).toMatchObject({
                state: "decided_pending",
                reason: "auto_promote_disabled",
                matched_memory_id: target.id,
                mapping_json: JSON.stringify({ conflictWith: target.id }),
            });
            expect(count(db, "SELECT COUNT(*) AS n FROM memories")).toBe(2);
        } finally {
            db.close();
        }
    });

    test("retirement and standing-rule promotion are dropped and logged without proposals", async () => {
        const db = store();
        try {
            const target = insertMemory(db, {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content: "Stale rule.",
            });
            const before = db.prepare("SELECT * FROM memories").all();
            const { publicationId, factIds } = publish(db, [
                { content: "Retire" },
                { content: "Promote" },
                { content: "Retire nothing" },
            ]);
            const logs: string[] = [];
            const carrier = stubCarrier(() =>
                reply([
                    {
                        fact_id: factIds[0],
                        check: "Audit fixture.",
                        action: "retire",
                        target_id: target.id,
                    },
                    {
                        fact_id: factIds[1],
                        check: "Audit fixture.",
                        action: "promote_rule",
                        target_id: target.id,
                    },
                    { fact_id: factIds[2], check: "Audit fixture.", action: "retire" },
                ]),
            );
            await run(db, publicationId, carrier.carrier, { log: (message) => logs.push(message) });
            expect(carrier.prompts[0]).not.toContain("abstain, retire");
            expect(carrier.prompts[0]).not.toContain("promote_rule");
            for (const [index, id] of factIds.slice(0, 2).entries())
                expect(fact(db, id)).toMatchObject({
                    state: "decided_pending",
                    reason: index === 0 ? "retire_dropped" : "promote_rule_dropped",
                });
            expect(logs.some((line) => line.includes("dropped retire"))).toBe(true);
            expect(logs.some((line) => line.includes("dropped promote_rule"))).toBe(true);
            expect(fact(db, factIds[2]!)).toMatchObject({
                state: "decided_pending",
                reason: "malformed_decision",
            });
            expect(
                db
                    .prepare(
                        "SELECT writer,operation,target_ids_json FROM memory_tool_proposals ORDER BY id",
                    )
                    .all(),
            ).toEqual([]);
            expect(db.prepare("SELECT * FROM memories").all()).toEqual(before);
            expect(count(db, "SELECT COUNT(*) AS n FROM memory_history")).toBe(0);
        } finally {
            db.close();
        }
    });
});

describe("turn two gated edits", () => {
    test("shared evidence renders once while fact-local edit citations stay enforced", async () => {
        const db = store();
        try {
            const memory = insertMemory(db, {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content: "Old rule. Keep rule.",
            });
            const current = publish(db, [
                {
                    content: "New rule replaces the old one",
                    block: { ordinal: 43, parts: ["Unrelated evidence."] },
                },
                {
                    content: "New rule replaces the old one",
                    block: { ordinal: 42, parts: ["New rule."] },
                },
                {
                    content: "New rule replaces the old one",
                    block: { ordinal: 42, parts: ["New rule."] },
                },
            ]);
            const edit = (id: number) => ({
                fact_id: id,
                check: "Audit fixture.",
                action: "edit",
                target_id: memory.id,
                revision: 1,
                removed: [],
                replaced: [{ memory_id: memory.id, clause: 1, block: 42, excerpt: "New rule." }],
                kept: [{ memory_id: memory.id, clause: 2 }],
                added: [{ text: "New rule. ", block: 42, excerpt: "New rule." }],
                final_text: "New rule. Keep rule.",
            });
            const stub = stubCarrier(() =>
                reply([
                    edit(current.factIds[0]!),
                    edit(current.factIds[1]!),
                    { fact_id: current.factIds[2], check: "Audit fixture.", action: "abstain" },
                ]),
            );
            await run(db, current.publicationId, stub.carrier);
            const prompt = stub.prompts[0]!;
            expect(prompt.split("[42] user: New rule.")).toHaveLength(2);
            expect(prompt.split(`- #${memory.id} rev 1`)).toHaveLength(2);
            expect(prompt.match(/^Source block refs: source:/gm)).toHaveLength(3);
            expect(prompt).toContain("Source block refs:");
            expect(fact(db, current.factIds[0]!)).toMatchObject({
                state: "decided_pending",
                reason: "evidence_or_window",
            });
            expect(fact(db, current.factIds[1]!)).toMatchObject({ state: "applied" });
            expect(getMemoryById(db, memory.id)?.content).toBe("New rule. Keep rule.");
        } finally {
            db.close();
        }
    });
    test("a merge that loses a source identifier or number is refused before any check or write", async () => {
        const db = store();
        try {
            const survivor = insertMemory(db, {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content: "Keep rule. ",
            });
            const source = insertMemory(db, {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content: "retry_limit is 17.",
            });
            const before = db.prepare("SELECT * FROM memories ORDER BY id").all();
            const published = publish(db, [
                {
                    content: "Use bounded retries.",
                    block: { ordinal: 42, parts: ["Use bounded retries."] },
                },
            ]);
            const stub = stubCarrier(() =>
                reply([
                    {
                        fact_id: published.factIds[0],
                        check: "Audit fixture.",
                        action: "merge",
                        sources: [
                            { id: survivor.id, revision: 1 },
                            { id: source.id, revision: 1 },
                        ],
                        survivor_id: survivor.id,
                        removed: [],
                        replaced: [
                            {
                                memory_id: source.id,
                                clause: 1,
                                block: 42,
                                excerpt: "Use bounded retries.",
                            },
                        ],
                        kept: [{ memory_id: survivor.id, clause: 1 }],
                        added: [
                            {
                                text: "Use bounded retries.",
                                block: 42,
                                excerpt: "Use bounded retries.",
                            },
                        ],
                        final_text: "Keep rule. Use bounded retries.",
                    },
                ]),
            );
            await run(db, published.publicationId, stub.carrier);
            expect(fact(db, published.factIds[0]!)).toMatchObject({
                state: "decided_pending",
                reason: "dropped_token",
            });
            expect(stub.checks).toHaveLength(0);
            expect(db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(before);
            for (const table of [
                "memory_history",
                "memory_successor_links",
                "memory_tool_proposals",
            ])
                expect(count(db, `SELECT COUNT(*) AS n FROM ${table}`)).toBe(0);
        } finally {
            db.close();
        }
    });
    if (process.env.MC_NOPROP_REVIEW === "1") {
        test("noprop merge refuses source-token loss even when the evidence repeats them", async () => {
            const db = store();
            try {
                const survivor = insertMemory(db, {
                    projectPath: PROJECT,
                    category: "CONSTRAINTS",
                    content: "Keep rule. ",
                });
                const source = insertMemory(db, {
                    projectPath: PROJECT,
                    category: "CONSTRAINTS",
                    content: "retry_limit is 17.",
                });
                const excerpt = "retry_limit was 17; now use bounded retries.";
                const before = db.prepare("SELECT * FROM memories ORDER BY id").all();
                const published = publish(db, [
                    { content: "Use bounded retries.", block: { ordinal: 42, parts: [excerpt] } },
                ]);
                const stub = stubCarrier(() =>
                    reply([
                        {
                            fact_id: published.factIds[0],
                            check: "Audit fixture.",
                            action: "merge",
                            sources: [
                                { id: survivor.id, revision: 1 },
                                { id: source.id, revision: 1 },
                            ],
                            survivor_id: survivor.id,
                            removed: [],
                            replaced: [{ memory_id: source.id, clause: 1, block: 42, excerpt }],
                            kept: [{ memory_id: survivor.id, clause: 1 }],
                            added: [{ text: "Use bounded retries.", block: 42, excerpt }],
                            final_text: "Keep rule. Use bounded retries.",
                        },
                    ]),
                );
                await run(db, published.publicationId, stub.carrier);
                expect(fact(db, published.factIds[0]!)).toMatchObject({
                    state: "decided_pending",
                    reason: "dropped_token",
                });
                expect(db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(before);
                expect(stub.checks).toHaveLength(0);
                for (const table of [
                    "memory_history",
                    "memory_successor_links",
                    "memory_tool_proposals",
                ])
                    expect(count(db, `SELECT COUNT(*) AS n FROM ${table}`)).toBe(0);
            } finally {
                db.close();
            }
        });
    }

    test("a green edit makes exactly 4 checks and applies once with history, no mutation-log row and fresh FTS", async () => {
        const db = store();
        try {
            const { memory, published, decision } = editFixture(db);
            saveEmbedding(db, memory.id, new Float32Array([1, 0]), "model-a");
            const epochs = db.prepare("SELECT * FROM project_state").all();
            const stub = stubCarrier(() => reply([decision]));
            expect(await run(db, published.publicationId, stub.carrier)).toMatchObject({
                status: "resolved",
                childInFlight: false,
            });
            expect(stub.checks.map((check) => check.kind).sort()).toEqual([
                "compatibility",
                "disproof",
                "kept-clause",
                "support",
            ]);
            expect(fact(db, published.factIds[0]!)).toMatchObject({
                state: "applied",
                reason: "edit",
            });
            const row = db
                .prepare("SELECT content,revision FROM memories WHERE id=?")
                .get(memory.id);
            expect(row).toEqual({ content: "New rule. Keep rule.", revision: 2 });
            expect(db.prepare("SELECT previous_text FROM memory_history").all()).toEqual([
                { previous_text: "Old rule. Keep rule." },
            ]);
            // Automated edits reach a prompt only at the next HARD fold (S3 contract).
            expect(count(db, "SELECT COUNT(*) AS n FROM memory_mutation_log")).toBe(0);
            expect(db.prepare("SELECT * FROM project_state").all()).toEqual(epochs);
            expect(
                count(
                    db,
                    "SELECT COUNT(*) AS n FROM memory_embeddings WHERE memory_id=?",
                    memory.id,
                ),
            ).toBe(0);
            expect(
                db
                    .prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?")
                    .all('"New"'),
            ).toHaveLength(1);
            expect(
                db
                    .prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?")
                    .all('"Old"'),
            ).toHaveLength(0);
            expect(db.prepare("SELECT state,usage_json FROM memory_check_attempts").all()).toEqual(
                Array(4).fill({ state: "resolved", usage_json: '{"tokens":7}' }),
            );
        } finally {
            db.close();
        }
    });

    for (const [name, verdict] of [
        [
            "failing",
            (request: CheckRequest) => ({
                ...passingVerdicts(request),
                verdicts: passingVerdicts(request).verdicts.map((entry) => ({
                    ...entry,
                    verdict: (entry.verdict === "yes" ? "no" : "yes") as "yes" | "no",
                })),
            }),
        ],
        [
            "unclear",
            (request: CheckRequest) => ({
                ...passingVerdicts(request),
                verdicts: passingVerdicts(request).verdicts.map((entry) => ({
                    ...entry,
                    verdict: "unclear" as const,
                })),
            }),
        ],
        ["malformed", (request: CheckRequest) => ({ ...passingVerdicts(request), verdicts: [] })],
    ] as Array<[string, CheckScript]>)
        test(`a ${name} check verdict refuses: decided_pending, attempts unchanged, row byte-identical, never resent`, async () => {
            const db = store();
            try {
                const { memory, published, decision } = editFixture(db);
                const before = db.prepare("SELECT * FROM memories WHERE id=?").get(memory.id);
                const stub = stubCarrier(() => reply([decision]), verdict);
                await run(db, published.publicationId, stub.carrier);
                expect(fact(db, published.factIds[0]!)).toMatchObject({
                    state: "decided_pending",
                    fact_attempts: 0,
                });
                expect(db.prepare("SELECT * FROM memories WHERE id=?").get(memory.id)).toEqual(
                    before,
                );
                expect(count(db, "SELECT COUNT(*) AS n FROM memory_history")).toBe(0);
                const later = stubCarrier(() => reply([]));
                await run(db, publish(db, []).publicationId, later.carrier);
                expect(later.prompts).toEqual([]);
            } finally {
                db.close();
            }
        });

    test("a check timeout retries the fact once; the next run resends and resolves it; it is not sent again", async () => {
        const db = store();
        try {
            const { memory, published, decision } = editFixture(db);
            const first = stubCarrier(
                () => reply([decision]),
                () => new Error("check timed out"),
            );
            await run(db, published.publicationId, first.carrier);
            expect(fact(db, published.factIds[0]!)).toMatchObject({
                state: "retryable",
                fact_attempts: 1,
                reason: "check_transport",
            });
            const second = stubCarrier((prompt) =>
                reply(factIdsIn(prompt).map((id) => ({ ...decision, fact_id: id }))),
            );
            await run(db, publish(db, []).publicationId, second.carrier);
            expect(second.prompts).toHaveLength(1);
            expect(factIdsIn(second.prompts[0]!)).toEqual([published.factIds[0]!]);
            expect(fact(db, published.factIds[0]!)).toMatchObject({ state: "applied" });
            expect(getMemoryById(db, memory.id)?.content).toBe("New rule. Keep rule.");
            const third = stubCarrier(() => reply([]));
            await run(db, publish(db, []).publicationId, third.carrier);
            expect(third.prompts).toEqual([]);
        } finally {
            db.close();
        }
    });

    test("a CAS loss consumes one attempt and writes no row, history or link", async () => {
        const db = store();
        try {
            const { memory, published, decision } = editFixture(db);
            const stub = stubCarrier(() => {
                // Another writer revises the target after the decision read revision 1.
                db.prepare("UPDATE memories SET revision=2 WHERE id=?").run(memory.id);
                return reply([decision]);
            });
            await run(db, published.publicationId, stub.carrier);
            expect(fact(db, published.factIds[0]!)).toMatchObject({
                state: "retryable",
                fact_attempts: 1,
                reason: "cas_loss",
            });
            expect(stub.checks).toEqual([]);
            expect(getMemoryById(db, memory.id)?.content).toBe("Old rule. Keep rule.");
            expect(count(db, "SELECT COUNT(*) AS n FROM memory_history")).toBe(0);
            expect(count(db, "SELECT COUNT(*) AS n FROM memory_journal")).toBe(0);
        } finally {
            db.close();
        }
    });

    test("an unmatched identity retries every action without admitting its new sibling; the cap makes both pending for good", async () => {
        const db = store();
        try {
            const { memory, published, decision } = editFixture(db);
            const sibling = publish(db, [{ content: "A brand new fact" }]);
            const fallback = { ...PROFILE, modelId: "fallback-model" };
            const runOnce = async (
                publicationId: string,
                profile: ReportedProfile,
                validated = VALIDATED,
            ) => {
                const stub = stubCarrier((prompt) =>
                    reply(
                        factIdsIn(prompt).map((id) =>
                            id === published.factIds[0]
                                ? { ...decision, fact_id: id }
                                : { fact_id: id, check: "Audit fixture.", action: "new" },
                        ),
                        undefined,
                        profile,
                    ),
                );
                await run(db, publicationId, stub.carrier, { validatedProfiles: validated });
                return stub;
            };
            const first = await runOnce(sibling.publicationId, fallback);
            expect(first.checks).toEqual([]);
            expect(fact(db, published.factIds[0]!)).toMatchObject({
                state: "retryable",
                fact_attempts: 1,
                reason: "identity_mismatch",
            });
            expect(fact(db, sibling.factIds[0]!)).toMatchObject({
                state: "retryable",
                fact_attempts: 1,
                reason: "identity_mismatch",
            });
            expect(getMemoryById(db, memory.id)?.content).toBe("Old rule. Keep rule.");
            // A differing variant on the configured model id also defers.
            await runOnce(publish(db, []).publicationId, { ...PROFILE, variant: "high" });
            await runOnce(publish(db, []).publicationId, { ...PROFILE, temperature: 1 });
            expect(fact(db, published.factIds[0]!)).toMatchObject({
                state: "decided_pending",
                fact_attempts: MAX_STAGE2_ATTEMPTS,
            });
            // Validating that tuple later sends the fact zero times.
            const fourth = await runOnce(publish(db, []).publicationId, fallback, [
                ...VALIDATED,
                ...VALIDATED.map((profile) => ({ ...profile, modelId: "fallback-model" })),
            ]);
            expect(fourth.prompts).toEqual([]);
            expect(getMemoryById(db, memory.id)?.content).toBe("Old rule. Keep rule.");
        } finally {
            db.close();
        }
    });

    test("a cross-session backlog fact resolves its cited ordinal only within its own blocks", async () => {
        const db = store();
        try {
            const memory = insertMemory(db, {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content: "Old rule. Keep rule.",
            });
            // Session A's fact cites ordinal 42; session B's run also has an ordinal 42.
            const sessionA = publish(db, [
                {
                    content: "New rule replaces the old one",
                    block: { ordinal: 42, parts: ["New rule."] },
                },
            ]);
            db.prepare("UPDATE memory_pending_facts SET fact_attempts=1 WHERE id=?").run(
                sessionA.factIds[0]!,
            );
            const sessionB = publish(db, [
                {
                    content: "Unrelated",
                    block: { ordinal: 42, parts: ["Something else entirely."] },
                },
            ]);
            const stub = stubCarrier((prompt) =>
                reply(
                    factIdsIn(prompt).map((id) =>
                        id === sessionA.factIds[0]
                            ? {
                                  fact_id: id,
                                  check: "Audit fixture.",
                                  action: "edit",
                                  target_id: memory.id,
                                  revision: 1,
                                  removed: [],
                                  replaced: [
                                      {
                                          memory_id: memory.id,
                                          clause: 1,
                                          block: 42,
                                          excerpt: "New rule.",
                                      },
                                  ],
                                  kept: [{ memory_id: memory.id, clause: 2 }],
                                  added: [{ text: "New rule. ", block: 42, excerpt: "New rule." }],
                                  final_text: "New rule. Keep rule.",
                              }
                            : { fact_id: id, check: "Audit fixture.", action: "abstain" },
                    ),
                ),
            );
            await run(db, sessionB.publicationId, stub.carrier);
            expect(stub.prompts[0]).toContain(`from session ${sessionA.sessionId}`);
            expect(fact(db, sessionA.factIds[0]!)).toMatchObject({ state: "applied" });
            const spans = JSON.parse(
                (
                    db.prepare("SELECT evidence_json FROM memory_history").get() as {
                        evidence_json: string;
                    }
                ).evidence_json,
            ) as Array<{ text: string }>;
            expect(spans.map((span) => span.text)).toEqual(["New rule.", "New rule."]);
        } finally {
            db.close();
        }
    });
});

describe("turn two narrow checks", () => {
    test("each check request holds only its fixed system prompt, operands and input, never the historian's", async () => {
        const db = store();
        try {
            const { published, decision } = editFixture(db);
            const other = publish(
                db,
                [{ content: "SECRET other candidate text" }],
                published.sessionId,
            );
            const stub = stubCarrier((prompt) =>
                reply(
                    factIdsIn(prompt).map((id) =>
                        id === published.factIds[0]
                            ? { ...decision, fact_id: id }
                            : { fact_id: id, check: "Audit fixture.", action: "abstain" },
                    ),
                ),
            );
            await run(db, other.publicationId, stub.carrier);
            expect(stub.checks).toHaveLength(4);
            for (const request of stub.checks) {
                expect(Object.keys(request).sort()).toEqual(
                    ["input", "key", "kind", "operands", "pairs", "system", "systemHash"].sort(),
                );
                expect(request.system).toBe(CHECK_SYSTEM_PROMPTS[request.kind]);
                expect(request.systemHash).toBe(
                    lifecycleTextHash(CHECK_SYSTEM_PROMPTS[request.kind]),
                );
                expect(request.systemHash).not.toBe(PROFILE.systemHash);
                expect(JSON.stringify(request)).not.toContain("SECRET");
                expect(JSON.stringify(request)).not.toContain("## Fact");
            }
            // The golden check prompts are pinned by hash.
            expect(
                Object.fromEntries(
                    Object.entries(CHECK_SYSTEM_PROMPTS).map(([kind, system]) => [
                        kind,
                        lifecycleTextHash(system).slice(0, 16),
                    ]),
                ),
            ).toEqual({
                disproof: "4095e6562973ff12",
                support: "1cb083b67add7897",
                "kept-clause": "bcb0eeb523595fc5",
                compatibility: "a1b70c1eab9d8330",
            });
        } finally {
            db.close();
        }
    });

    test("two compatibility calls get distinct keys and recovery reattaches each without collision", async () => {
        const db = store();
        try {
            const memory = insertMemory(db, {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content: "Old rule. Keep rule.",
            });
            const published = publish(db, [
                {
                    content: "Two new rules",
                    block: { ordinal: 42, parts: ["First new rule. Second new rule."] },
                },
            ]);
            const decision = {
                fact_id: published.factIds[0],
                check: "Audit fixture.",
                action: "edit",
                target_id: memory.id,
                revision: 1,
                removed: [],
                replaced: [
                    { memory_id: memory.id, clause: 1, block: 42, excerpt: "First new rule." },
                ],
                kept: [{ memory_id: memory.id, clause: 2 }],
                added: [
                    { text: "First new rule. ", block: 42, excerpt: "First new rule." },
                    { text: "Second new rule. ", block: 42, excerpt: "Second new rule." },
                ],
                final_text: "First new rule. Second new rule. Keep rule.",
            };
            // The first compatibility answer is lost in a crash; the run stops there.
            let compatibility = 0;
            const stub = stubCarrier(
                () => reply([decision]),
                (request) => {
                    if (request.kind === "compatibility" && ++compatibility === 2) return "unknown";
                    return passingVerdicts(request);
                },
            );
            expect(await run(db, published.publicationId, stub.carrier)).toMatchObject({
                status: "in_flight",
                childInFlight: true,
            });
            const compat = stub.checks.filter((check) => check.kind === "compatibility");
            expect(compat).toHaveLength(2);
            expect(compat[0]!.key).not.toBe(compat[1]!.key);
            expect(compat[0]!.pairs.map((pair) => pair.id)).not.toEqual(
                compat[1]!.pairs.map((pair) => pair.id),
            );
            expect(fact(db, published.factIds[0]!)).toMatchObject({
                state: "in_flight",
                fact_attempts: 0,
            });
            // A concurrent publication sends none of the reserved facts.
            const concurrent = stubCarrier(() => reply([]));
            await run(db, publish(db, []).publicationId, concurrent.carrier);
            expect(concurrent.prompts).toEqual([]);
            // Recovery reattaches the dispatched check by its own key and sends nothing new.
            const reattached: string[] = [];
            const resolver: TurnTwoRecoveryResolver = () => ({
                reattach: async () => ({ kind: "unknown" }),
                check: async (request) => {
                    throw new Error(`unexpected fresh check ${request.kind}`);
                },
                reattachCheck: async (request) => {
                    reattached.push(request.key);
                    return passingVerdicts(request);
                },
            });
            const later = stubCarrier(() => reply([]));
            await run(db, publish(db, []).publicationId, later.carrier, { recover: resolver });
            expect(reattached).toEqual([compat[1]!.key]);
            expect(later.prompts).toEqual([]);
            expect(fact(db, published.factIds[0]!)).toMatchObject({
                state: "applied",
                fact_attempts: 0,
            });
            expect(getMemoryById(db, memory.id)?.content).toBe(
                "First new rule. Second new rule. Keep rule.",
            );
            expect(count(db, "SELECT COUNT(*) AS n FROM memory_history")).toBe(1);
        } finally {
            db.close();
        }
    });
});

describe("turn two crash recovery", () => {
    for (const enforcedJson of [false, undefined]) {
        test(`best-effort edit applies through recovery with enforcedJson ${enforcedJson}`, async () => {
            const db = store();
            try {
                const { memory, published, decision } = editFixture(db);
                const first = stubCarrier(() => "unknown");
                const result = await run(db, published.publicationId, {
                    ...first.carrier,
                    enforcedJson,
                });
                expect(result.status).toBe("in_flight");
                const later = stubCarrier(() => reply([]));
                const keys: string[] = [];
                let closed = 0;
                await run(db, publish(db, []).publicationId, later.carrier, {
                    recover: (record) => ({
                        reattach: async () => {
                            keys.push(record.stageKey);
                            return { kind: "reply", reply: reply([decision]) };
                        },
                        check: async (request) => passingVerdicts(request),
                        close: async () => {
                            closed++;
                        },
                    }),
                });
                expect(keys).toEqual([result.stageKey!]);
                expect(first.prompts).toHaveLength(1);
                expect(later.prompts).toEqual([]);
                expect(closed).toBe(1);
                expect(fact(db, published.factIds[0]!)).toMatchObject({
                    state: "applied",
                    fact_attempts: 0,
                });
                expect(getMemoryById(db, memory.id)?.content).toBe("New rule. Keep rule.");
            } finally {
                db.close();
            }
        });
    }
    test("after turn one's commit the candidates survive and a later publication's run sends them once", async () => {
        const db = store();
        try {
            const crashed = publish(db, [{ content: "Survives the crash" }]);
            const stub = stubCarrier((prompt) =>
                reply(
                    factIdsIn(prompt).map((id) => ({
                        fact_id: id,
                        check: "Audit fixture.",
                        action: "new",
                    })),
                ),
            );
            await run(db, publish(db, []).publicationId, stub.carrier);
            await run(db, publish(db, []).publicationId, stub.carrier);
            expect(stub.prompts).toHaveLength(1);
            expect(fact(db, crashed.factIds[0]!)).toMatchObject({ state: "applied" });
            expect(
                count(db, "SELECT COUNT(*) AS n FROM memory_stage_attempts WHERE stage='turn_one'"),
            ).toBe(3);
        } finally {
            db.close();
        }
    });

    test("an unacknowledged send keeps the facts in flight; recovery reattaches the original key and run_attempt without a second send", async () => {
        const db = store();
        try {
            const { publicationId, factIds } = publish(db, [{ content: "Lost reply" }]);
            const stub = stubCarrier(() => "unknown");
            expect(await run(db, publicationId, stub.carrier)).toMatchObject({
                status: "in_flight",
                childInFlight: true,
            });
            const stage = db
                .prepare(
                    "SELECT stage_key,run_attempt,state FROM memory_stage_attempts WHERE stage='turn_two'",
                )
                .get() as { stage_key: string; run_attempt: number; state: string };
            expect(fact(db, factIds[0]!)).toMatchObject({
                state: "in_flight",
                fact_attempts: 0,
                reserved_stage_key: stage.stage_key,
            });
            const outcomes: TurnTwoReattach[] = [
                { kind: "unknown" },
                {
                    kind: "reply",
                    reply: reply([{ fact_id: factIds[0], check: "Audit fixture.", action: "new" }]),
                },
            ];
            const seen: string[] = [];
            let closed = 0;
            const resolver: TurnTwoRecoveryResolver = (record) => ({
                reattach: async () => {
                    seen.push(`${record.stageKey}#${record.runAttempt}#${record.childSessionId}`);
                    return outcomes.shift()!;
                },
                check: passingVerdicts as never,
                close: async () => {
                    closed++;
                },
            });
            const later = stubCarrier(() => reply([]));
            await run(db, publish(db, []).publicationId, later.carrier, { recover: resolver });
            expect(fact(db, factIds[0]!)).toMatchObject({ state: "in_flight", fact_attempts: 0 });
            await run(db, publish(db, []).publicationId, later.carrier, { recover: resolver });
            expect(seen).toEqual(Array(2).fill(`${stage.stage_key}#${stage.run_attempt}#child-1`));
            expect(fact(db, factIds[0]!)).toMatchObject({ state: "applied", fact_attempts: 0 });
            expect(later.prompts).toEqual([]);
            expect(stub.prompts).toHaveLength(1);
            expect(closed).toBe(1);
            expect(
                count(
                    db,
                    "SELECT COUNT(*) AS n FROM memory_stage_attempts WHERE stage='turn_two' AND publication_id=?",
                    publicationId,
                ),
            ).toBe(1);
        } finally {
            db.close();
        }
    });

    test("a crash at the resolving commit applies the operation exactly once on recovery", async () => {
        const db = store();
        try {
            const existing = insertMemory(db, {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content: "Seen before",
            });
            const { memory, published, decision } = editFixture(db);
            const twin = publish(db, [{ content: "Seen before" }]);
            // Make every resolving transaction fail, as if the process died at COMMIT.
            db.exec(
                "CREATE TRIGGER crash_receipts BEFORE INSERT ON memory_decision_receipts BEGIN SELECT RAISE(ABORT, 'crash'); END",
            );
            const stub = stubCarrier((prompt) =>
                reply(
                    factIdsIn(prompt).map((id) =>
                        id === published.factIds[0]
                            ? { ...decision, fact_id: id }
                            : { fact_id: id, check: "Audit fixture.", action: "new" },
                    ),
                ),
            );
            await expect(run(db, twin.publicationId, stub.carrier)).rejects.toThrow("crash");
            expect(fact(db, published.factIds[0]!)).toMatchObject({ state: "in_flight" });
            expect(fact(db, twin.factIds[0]!)).toMatchObject({ state: "in_flight" });
            expect(getMemoryById(db, existing.id)?.seenCount).toBe(1);
            expect(count(db, "SELECT COUNT(*) AS n FROM memory_history")).toBe(0);
            db.exec("DROP TRIGGER crash_receipts");
            const resolver: TurnTwoRecoveryResolver = () => ({
                reattach: async () => {
                    throw new Error("a recorded reply needs no reattach");
                },
                check: async (request) => passingVerdicts(request),
            });
            for (let attempt = 0; attempt < 2; attempt++) {
                await run(db, publish(db, []).publicationId, stubCarrier(() => reply([])).carrier, {
                    recover: resolver,
                });
                // Recovery records the edit and admission once each, including on its second run.
                expect(
                    db
                        .prepare(
                            "SELECT j.operation,h.memory_id AS memoryId,COUNT(*) AS n FROM memory_history h JOIN memory_journal j ON j.decision_key=h.decision_key GROUP BY j.operation,h.memory_id ORDER BY j.operation",
                        )
                        .all(),
                ).toEqual([
                    { operation: "edit", memoryId: memory.id, n: 1 },
                    { operation: "new", memoryId: existing.id, n: 1 },
                ]);
            }
            expect(stub.prompts).toHaveLength(1);
            expect(fact(db, published.factIds[0]!)).toMatchObject({ state: "applied" });
            expect(fact(db, twin.factIds[0]!)).toMatchObject({
                state: "applied",
                reason: "live_match",
            });
            expect(count(db, "SELECT COUNT(*) AS n FROM memory_history")).toBe(2);
            expect(getMemoryById(db, existing.id)?.seenCount).toBe(2);
            expect(getMemoryById(db, memory.id)?.content).toBe("New rule. Keep rule.");
        } finally {
            db.close();
        }
    });

    test("a carrier that reports the child gone retries the fact (+1); a later run on another chunk decides it from its stored blocks", async () => {
        const db = store();
        try {
            const { memory, published, decision } = editFixture(db);
            await run(db, published.publicationId, stubCarrier(() => "unknown").carrier);
            const resolver: TurnTwoRecoveryResolver = () => ({
                reattach: async () => ({ kind: "gone" }),
                check: passingVerdicts as never,
            });
            const next = stubCarrier((prompt) =>
                reply(factIdsIn(prompt).map((id) => ({ ...decision, fact_id: id }))),
            );
            await run(db, publish(db, []).publicationId, next.carrier, { recover: resolver });
            expect(next.prompts).toHaveLength(1);
            expect(next.prompts[0]).toContain("[42] user: New rule.");
            expect(fact(db, published.factIds[0]!)).toMatchObject({
                state: "applied",
                fact_attempts: 1,
            });
            expect(getMemoryById(db, memory.id)?.content).toBe("New rule. Keep rule.");
        } finally {
            db.close();
        }
    });

    test("deleting the child's session releases its in-flight facts (+1, pending at the cap) without resetting attempts", async () => {
        const db = store();
        runMigrations(db);
        try {
            const { publicationId, factIds } = publish(db, [
                { content: "Released" },
                { content: "Capped" },
            ]);
            db.prepare("UPDATE memory_pending_facts SET fact_attempts=? WHERE id=?").run(
                MAX_STAGE2_ATTEMPTS - 1,
                factIds[1]!,
            );
            await run(
                db,
                publicationId,
                stubCarrier(() => "unknown", passingVerdicts, "child-gone").carrier,
            );
            deleteSessionScopedRows(db, ["child-gone"]);
            expect(fact(db, factIds[0]!)).toMatchObject({
                state: "retryable",
                fact_attempts: 1,
                reason: "session_deleted",
            });
            expect(fact(db, factIds[1]!)).toMatchObject({
                state: "decided_pending",
                fact_attempts: MAX_STAGE2_ATTEMPTS,
            });
            const later = stubCarrier((prompt) =>
                reply(
                    factIdsIn(prompt).map((id) => ({
                        fact_id: id,
                        check: "Audit fixture.",
                        action: "new",
                    })),
                ),
            );
            await run(db, publish(db, [], "ses-other").publicationId, later.carrier);
            expect(factIdsIn(later.prompts[0]!)).toEqual([factIds[0]!]);
            expect(fact(db, factIds[0]!)).toMatchObject({ state: "applied", fact_attempts: 1 });
        } finally {
            db.close();
        }
    });
});

describe("turn two retrieval", () => {
    test("the top lexical hit outside the semantic top-k is in the prompt", async () => {
        const db = store();
        try {
            const project = "git:turn-two-retrieval";
            const lexical = insertMemory(db, {
                projectPath: project,
                category: "CONSTRAINTS",
                content: "zebracorn deployment window",
            });
            for (let index = 0; index < 14; index++) {
                const semantic = insertMemory(db, {
                    projectPath: project,
                    category: "CONSTRAINTS",
                    content: `Semantic neighbour ${index}`,
                });
                saveEmbedding(db, semantic.id, new Float32Array([1, index / 100]), "model-a");
            }
            saveEmbedding(db, lexical.id, new Float32Array([-1, 0]), "model-a");
            const send = allocateTurnOneSend(db, {
                projectPath: project,
                sessionId: "ses-r",
                harness: "opencode",
                carrier: "test",
                lane: "enabled",
                chunkStart: 1,
                chunkEnd: 2,
            });
            AUTHORIZATION.persist(db, send.stageKey);
            db.transaction(() =>
                commitTurnOnePublication(db, {
                    send,
                    projectPath: project,
                    sessionId: "ses-r",
                    compartments: [],
                    blocks: [],
                    candidateFacts: [{ category: "CONSTRAINTS", content: "zebracorn deployment" }],
                    honourAnchors: true,
                }),
            )();
            const prompts = async (embedQuery: TurnTwoRunInput["embedQuery"]) => {
                db.prepare(
                    "UPDATE memory_pending_facts SET state='retryable',reserved_stage_key=NULL",
                ).run();
                const stub = stubCarrier(() => reply([]));
                await run(db, send.publicationId, stub.carrier, {
                    projectPath: project,
                    embedQuery,
                });
                return stub.prompts[0]!;
            };
            const semanticPrompt = await prompts(async () => ({
                vector: new Float32Array([1, 0]),
                modelId: "model-a",
            }));
            expect(semanticPrompt).toContain(`#${lexical.id} rev 1`);
            expect(semanticPrompt).not.toContain(LEXICAL_ONLY_NOTICE);
            expect(semanticPrompt.match(/^- #\d+ rev/gm)).toHaveLength(3);
            const noEmbeddings = await prompts(undefined);
            expect(noEmbeddings).toContain(LEXICAL_ONLY_NOTICE);
            const otherModel = await prompts(async () => ({
                vector: new Float32Array([1, 0]),
                modelId: "model-b",
            }));
            expect(otherModel).toContain(LEXICAL_ONLY_NOTICE);
            expect(otherModel).toContain(`#${lexical.id} rev 1`);
        } finally {
            db.close();
        }
    });
});

describe("turn two agent-memory scoring", () => {
    function save(db: Database, sessionId: string, ordinal: number, part: string) {
        return applyMemoryAdmission(db, {
            key: `save:${part}`,
            operation: "agent_save",
            input: {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content: `Saved ${part}`,
                sourceSessionId: sessionId,
            },
            classificationAnchor: { toolCallPartId: part, saveOrdinal: ordinal },
        });
    }
    function publishThrough(db: Database, sessionId: string, end: number) {
        db.prepare(
            "INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at) VALUES(?,?,?,?,'t','c',1)",
        ).run(sessionId, end, 1, end);
    }
    const excerpts = (sessionId: string, from: number, to: number) => ({
        text: `${sessionId}:${from}-${to}`,
        ordinals: Array.from({ length: to - from + 1 }, (_, index) => from + index),
    });

    test("scores at or below the stage watermark only; importance is copied and the class stays on the item", async () => {
        const db = store();
        try {
            const saved = save(db, "ses-save", 10, "p1");
            const live = save(db, "ses-live", 10, "p-live");
            publishThrough(db, "ses-save", 14);
            publishThrough(db, "ses-live", 10);
            expect(getMemoryById(db, saved.memoryId!)?.importance).toBe(50);
            let late: number | undefined;
            const stub = stubCarrier((prompt) => {
                // Enqueued while the send is in flight: above the stage's watermark.
                late = save(db, "ses-save", 11, "p-late").memoryId;
                const items = [...prompt.matchAll(/^### Item (\d+)/gm)].map((match) =>
                    Number(match[1]),
                );
                return reply(
                    [],
                    [...items, 3].map((item) => ({ item, importance: 80, class: "durable" })),
                );
            });
            await run(db, publish(db, []).publicationId, stub.carrier, { readExcerpt: excerpts });
            expect(stub.prompts[0]).toContain("ses-save:8-14");
            expect(
                db
                    .prepare(
                        "SELECT memory_id,state,importance,proposed_class,clipping_json FROM memory_classification_items ORDER BY enqueue_sequence",
                    )
                    .all(),
            ).toEqual([
                {
                    memory_id: saved.memoryId,
                    state: "scored",
                    importance: 80,
                    proposed_class: "durable",
                    clipping_json: '{"from":8,"to":14}',
                },
                {
                    memory_id: live.memoryId,
                    state: "pending",
                    importance: null,
                    proposed_class: null,
                    clipping_json: null,
                },
                {
                    memory_id: late,
                    state: "pending",
                    importance: null,
                    proposed_class: null,
                    clipping_json: null,
                },
            ]);
            expect(getMemoryById(db, saved.memoryId!)?.importance).toBe(80);
            expect(getMemoryById(db, late!)?.importance).toBe(50);
            expect(count(db, "SELECT COUNT(*) AS n FROM memory_mutation_log")).toBe(0);
            // A second score for the same item is discarded.
            const again = stubCarrier(() =>
                reply([], [{ item: 1, importance: 10, class: "ephemeral" }]),
            );
            await run(db, publish(db, []).publicationId, again.carrier, { readExcerpt: excerpts });
            expect(getMemoryById(db, saved.memoryId!)?.importance).toBe(80);
        } finally {
            db.close();
        }
    });

    test("a turn-two failure leaves the item pending; a later run scores it from the stored excerpt", async () => {
        const db = store();
        try {
            const saved = save(db, "ses-save", 1, "p1");
            publishThrough(db, "ses-save", 5);
            await run(
                db,
                publish(db, []).publicationId,
                stubCarrier(() => new Error("down")).carrier,
                {
                    readExcerpt: excerpts,
                },
            );
            expect(
                db
                    .prepare("SELECT state,excerpt,clipping_json FROM memory_classification_items")
                    .get(),
            ).toEqual({
                state: "pending",
                excerpt: "ses-save:1-5",
                clipping_json: '{"from":1,"to":5,"sessionStart":1}',
            });
            const later = stubCarrier(() =>
                reply([], [{ item: 1, importance: 70, class: "durable" }]),
            );
            await run(db, publish(db, []).publicationId, later.carrier, {
                readExcerpt: () => null,
            });
            expect(later.prompts[0]).toContain("ses-save:1-5");
            expect(getMemoryById(db, saved.memoryId!)?.importance).toBe(70);
        } finally {
            db.close();
        }
    });

    test("an item whose window is unreadable stays pending and is not sent", async () => {
        const db = store();
        try {
            save(db, "ses-save", 3, "p1");
            publishThrough(db, "ses-save", 9);
            const stub = stubCarrier(() => reply([]));
            expect(
                await run(db, publish(db, []).publicationId, stub.carrier, {
                    readExcerpt: () => null,
                }),
            ).toMatchObject({ status: "nothing_to_send" });
            expect(stub.prompts).toEqual([]);
        } finally {
            db.close();
        }
    });
});

describe("turn two bounds and isolation", () => {
    test("deleting the parent session closes a child kept open for turn two", async () => {
        const db = store();
        runMigrations(db);
        try {
            let closed = 0;
            registerTurnTwoChild({
                childSessionId: "child-kept",
                parentSessionId: "ses-parent-deleted",
                harness: "opencode",
                handle: {},
                active: false,
                close: async () => {
                    closed++;
                },
            });
            deleteSessionScopedRows(db, ["ses-parent-deleted"]);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(closed).toBe(1);
            expect(retainedTurnTwoChild("child-kept")).toBeUndefined();
        } finally {
            __turnTwoChildrenTest.clear();
            db.close();
        }
    });

    test("an oversized batch sends a smaller one with a coverage notice; the rest wait unreserved", async () => {
        const db = store();
        try {
            // Each fact's own block makes its rendering about half the size bound.
            const half = "x ".repeat(Math.ceil(TURN_TWO_PROMPT_MAX / 4));
            const { publicationId, factIds } = publish(db, [
                { content: "First large fact", block: { ordinal: 1, parts: [half] } },
                { content: "Second large fact", block: { ordinal: 2, parts: [half] } },
                { content: "Third large fact", block: { ordinal: 3, parts: [half] } },
            ]);
            const stub = stubCarrier((prompt) =>
                reply(
                    factIdsIn(prompt).map((id) => ({
                        fact_id: id,
                        check: "Audit fixture.",
                        action: "abstain",
                    })),
                ),
            );
            await run(db, publicationId, stub.carrier);
            const sent = factIdsIn(stub.prompts[0]!);
            expect(sent.length).toBeGreaterThan(0);
            expect(sent.length).toBeLessThan(3);
            expect(stub.prompts[0]!.length).toBeLessThanOrEqual(TURN_TWO_PROMPT_MAX);
            expect(stub.prompts[0]).toContain(coverageNotice(3 - sent.length, 0));
            for (const id of factIds.filter((id) => !sent.includes(id)))
                expect(fact(db, id)).toMatchObject({ state: "retryable", fact_attempts: 0 });
        } finally {
            db.close();
        }
    });

    test("a stage whose recovery throws does not stop new sends and is given up after the visit bound", async () => {
        const db = store();
        try {
            const stuck = publish(db, [{ content: "Resolution always throws" }]);
            await run(db, stuck.publicationId, stubCarrier(() => "unknown").carrier);
            // A deterministic failure while resolving this fact's decision.
            db.exec(
                `CREATE TRIGGER broken_fact BEFORE INSERT ON memory_decision_receipts WHEN NEW.fact_id = ${stuck.factIds[0]} AND NEW.receipt_json LIKE '%abstain%' BEGIN SELECT RAISE(ABORT, 'broken'); END`,
            );
            const resolver: TurnTwoRecoveryResolver = () => ({
                reattach: async () => ({
                    kind: "reply",
                    reply: reply([
                        { fact_id: stuck.factIds[0], check: "Audit fixture.", action: "abstain" },
                    ]),
                }),
                check: passingVerdicts as never,
            });
            const sentFacts: number[][] = [];
            for (let visit = 0; visit < TURN_TWO_UNKNOWN_MAX_VISITS; visit++) {
                const fresh = publish(db, [{ content: `Fresh fact ${visit}` }]);
                const carrier = stubCarrier((prompt) => {
                    sentFacts.push(factIdsIn(prompt));
                    return reply(
                        factIdsIn(prompt)
                            .filter((id) => id !== stuck.factIds[0])
                            .map((id) => ({
                                fact_id: id,
                                check: "Audit fixture.",
                                action: "abstain",
                            })),
                    );
                }).carrier;
                await run(db, fresh.publicationId, carrier, { recover: resolver });
                expect(fact(db, fresh.factIds[0]!)).toMatchObject({ state: "decided_pending" });
            }
            expect(sentFacts).toHaveLength(TURN_TWO_UNKNOWN_MAX_VISITS);
            // Given up on the last visit (+1), then resent once as backlog and
            // decided there (no decision for it in that reply).
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS n FROM memory_decision_receipts WHERE fact_id=? AND receipt_json LIKE '%recovery_error%'",
                    )
                    .get(stuck.factIds[0]!),
            ).toEqual({ n: 1 });
            expect(sentFacts.at(-1)).toContain(stuck.factIds[0]!);
            expect(fact(db, stuck.factIds[0]!)).toMatchObject({
                state: "decided_pending",
                fact_attempts: 1,
                reason: "missing_decision",
            });
        } finally {
            db.close();
        }
    });
});

describe("turn two decided prefix on new", () => {
    function parse(decision: unknown) {
        return parseTurnTwoEnvelope(
            JSON.stringify({ result: { step: "turn_two", decisions: [decision] } }),
            false,
        );
    }

    test("parser accepts decided true and false on new", () => {
        for (const decided of [true, false]) {
            const parsed = parse({
                fact_id: 1,
                check: "Audit fixture.",
                action: "new",
                decided,
            });
            expect(parsed.ok).toBe(true);
            if (!parsed.ok) continue;
            expect(parsed.decisions.get(1)).toEqual({
                factId: 1,
                ordinal: 0,
                action: "new",
                check: "Audit fixture.",
                decided,
            });
            expect(parsed.schemaValid).toBe(true);
        }
    });

    test("parser refuses decided on covered, edit, abstain and conflict", () => {
        for (const decision of [
            {
                fact_id: 1,
                check: "Audit fixture.",
                action: "covered",
                target_id: 7,
                revision: 1,
                clauses: [1],
                decided: true,
            },
            {
                fact_id: 1,
                check: "Audit fixture.",
                action: "edit",
                target_id: 7,
                revision: 1,
                removed: [],
                replaced: [],
                added: [],
                kept: [],
                final_text: "New rule.",
                decided: false,
            },
            { fact_id: 1, check: "Audit fixture.", action: "abstain", decided: true },
            {
                fact_id: 1,
                check: "Audit fixture.",
                action: "conflict",
                target_id: 7,
                decided: true,
            },
        ]) {
            const parsed = parse(decision);
            expect(parsed.ok).toBe(true);
            if (!parsed.ok) continue;
            expect(parsed.decisions.get(1)).toBe("malformed");
            expect(parsed.schemaValid).toBe(false);
        }
    });

    test("parser refuses a non-boolean decided on new", () => {
        for (const decided of ["yes", 1, 0, null]) {
            const parsed = parse({
                fact_id: 1,
                check: "Audit fixture.",
                action: "new",
                decided,
            });
            expect(parsed.ok).toBe(true);
            if (!parsed.ok) continue;
            expect(parsed.decisions.get(1)).toBe("malformed");
            expect(parsed.schemaValid).toBe(false);
        }
    });

    test("publication stores Decided: text once for decided true", async () => {
        const db = store();
        try {
            const { publicationId, factIds } = publish(db, [
                { content: "Retry backoff: 30 s." },
                { content: "Decided: Queue depth: 4." },
            ]);
            const stub = stubCarrier(() =>
                reply([
                    {
                        fact_id: factIds[0],
                        check: "Audit fixture.",
                        action: "new",
                        decided: true,
                    },
                    {
                        fact_id: factIds[1],
                        check: "Audit fixture.",
                        action: "new",
                        decided: true,
                    },
                ]),
            );
            await run(db, publicationId, stub.carrier);
            expect(db.prepare("SELECT content FROM memories ORDER BY id").all()).toEqual([
                { content: "Decided: Retry backoff: 30 s." },
                { content: "Decided: Queue depth: 4." },
            ]);
        } finally {
            db.close();
        }
    });

    test("absent or false decided stores the text unchanged", async () => {
        const db = store();
        try {
            const { publicationId, factIds } = publish(db, [
                { content: "Plain rule one." },
                { content: "Plain rule two." },
            ]);
            const stub = stubCarrier(() =>
                reply([
                    { fact_id: factIds[0], check: "Audit fixture.", action: "new" },
                    {
                        fact_id: factIds[1],
                        check: "Audit fixture.",
                        action: "new",
                        decided: false,
                    },
                ]),
            );
            await run(db, publicationId, stub.carrier);
            expect(db.prepare("SELECT content FROM memories ORDER BY id").all()).toEqual([
                { content: "Plain rule one." },
                { content: "Plain rule two." },
            ]);
        } finally {
            db.close();
        }
    });
});
