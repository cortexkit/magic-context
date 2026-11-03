/**
 * Independent review of memory slice S6 (historian turn two), commit dafaede1.
 * Report: .cortexkit/internal-docs/investigations/reports/memory-s6-review.md.
 *
 * Part of the normal suite:
 * - `review witness: …` tests assert behaviour the spec or the rulings require. They
 *   failed at dafaede1, and each one is the evidence for a finding in the report that
 *   has since been fixed.
 * - `review probe: …` tests passed at dafaede1 and stay as permanent regression tests
 *   for checks the report marks as holding (gates, recovery after SIGKILL,
 *   projection visibility, the commit-time CAS recheck).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORIAN_TRUNCATION_MARKER } from "../../../hooks/magic-context/producer-window-guard";
import { Database } from "../../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { applyMemoryAdmission } from "./lifecycle-applier";
import { MAX_STAGE2_ATTEMPTS } from "./lifecycle-constants";
import {
    type CheckReply,
    type CheckRequest,
    type GateContext,
    planMemoryRevision,
    type RevisionDecision,
} from "./lifecycle-gates";
import { splitMemoryClauses } from "./lifecycle-text";
import { getMemoryById, insertMemory } from "./storage-memory";
import { saveEmbedding } from "./storage-memory-embeddings";
import {
    allocateTurnOneSend,
    commitTurnOnePublication,
    type TurnOnePrintedBlock,
} from "./turn-one-publication";
import {
    runTurnTwo,
    type TurnTwoCarrier,
    TurnTwoOutcomeUnknownError,
    type TurnTwoRecoveryResolver,
    type TurnTwoRunInput,
    type TurnTwoStageReply,
} from "./turn-two";
import { retrieveTurnTwoNeighbours } from "./turn-two-retrieval";
import { authorizationFixture } from "./turn-two-test-fixtures.test";

const PROJECT = "git:turn-two-review";
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
    runMigrations(db);
    return db;
}

let sessionCounter = 0;
/** Commit one turn-one publication; returns its id and fact ids. */
function publish(
    db: Database,
    facts: Array<{ content: string; block?: { ordinal: number; parts: string[] } }>,
): { publicationId: string; factIds: number[] } {
    const sessionId = `ses-review-${++sessionCounter}`;
    const send = allocateTurnOneSend(db, {
        projectPath: PROJECT,
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
                      role: "user",
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
            projectPath: PROJECT,
            sessionId,
            compartments: [
                {
                    id: 5000 + sessionCounter,
                    startMessage: 1,
                    endMessage: 1000,
                    replyStartMessage: 1,
                    replyEndMessage: 1000,
                },
            ],
            blocks,
            candidateFacts: facts.map((fact) => ({
                category: "CONSTRAINTS",
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
    return { publicationId: send.publicationId, factIds };
}

function passingVerdicts(request: CheckRequest): CheckReply {
    const passing = request.kind === "disproof" || request.kind === "support" ? "yes" : "no";
    return {
        verdicts: (request.kind === "compatibility" ? request.pairs : request.operands).map(
            (operand) => ({ id: operand.id, verdict: passing as "yes" | "no" }),
        ),
        profile: AUTHORIZATION.checkProfile(request.systemHash),
        usage: null,
    };
}

function reply(decisions: unknown[], scores?: unknown[]): TurnTwoStageReply {
    return {
        text: JSON.stringify({
            result: { step: "turn_two", decisions, ...(scores ? { scores } : {}) },
        }),
        lengthCapped: false,
        profile: PROFILE,
    };
}

function stub(answer: (prompt: string) => TurnTwoStageReply | "unknown") {
    const prompts: string[] = [];
    const carrier: TurnTwoCarrier = {
        carrier: "stub",
        harness: "opencode",
        enforcedJson: true,
        childSessionId: "child-review",
        async send(prompt) {
            prompts.push(prompt);
            const result = answer(prompt);
            if (result === "unknown") throw new TurnTwoOutcomeUnknownError();
            return result;
        },
        async check(request) {
            return passingVerdicts(request);
        },
    };
    return { carrier, prompts };
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

function factRow(db: Database, id: number) {
    return db
        .prepare("SELECT state,fact_attempts,reason FROM memory_pending_facts WHERE id=?")
        .get(id) as { state: string; fact_attempts: number; reason: string | null };
}

const factIdsIn = (prompt: string) =>
    [...prompt.matchAll(/^## Fact (\d+)/gm)].map((match) => Number(match[1]));

/** A memory "Old rule. Keep rule." and an edit decision evidenced by "New rule." */
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

/** One agent save with a classification item whose excerpt is already due. */
function dueItem(db: Database, part: string): number {
    const saved = applyMemoryAdmission(db, {
        key: `save:${part}`,
        operation: "agent_save",
        input: {
            projectPath: PROJECT,
            category: "CONSTRAINTS",
            content: `Saved ${part}`,
            sourceSessionId: "ses-save",
        },
        classificationAnchor: { toolCallPartId: part, saveOrdinal: 10 },
    });
    db.prepare(
        "INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at) VALUES('ses-save',1,1,20,'t','c',1)",
    ).run();
    return saved.memoryId!;
}
const excerpts = (sessionId: string, from: number, to: number) => ({
    text: `${sessionId}:${from}-${to}`,
    ordinals: Array.from({ length: to - from + 1 }, (_, index) => from + index),
});

describe("S6 review witnesses (failed at dafaede1)", () => {
    test("review witness: a turn-two send the child never answered does not stay in_flight forever", async () => {
        // The production OpenCode carrier and recovery, over a host that accepted the
        // turn-two prompt but whose child still shows turn one's reply (the prompt was
        // lost, or the provider produced no text). At dafaede1 the runner test in
        // compartment-runner-turn-one.test.ts expected facts to be left in this state.
        const { createOpenCodeTurnTwoCarrier, createOpenCodeTurnTwoRecovery } = await import(
            "../../../hooks/magic-context/historian-turn-two-carrier"
        );
        const db = store();
        try {
            const turnOneText = "<compartments>turn one reply</compartments>";
            let closed = 0;
            const executor = {
                capabilities: { tools: false, harness: "opencode" as const },
                open: async () => ({ id: "check", childSessionId: "check" }),
                attempt: async () => {},
                collect: async () => ({
                    text: turnOneText,
                    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    lengthCapped: false,
                }),
                close: async () => {
                    closed++;
                },
            };
            const handle = { id: "child-1", childSessionId: "child-1" };
            const carrier = createOpenCodeTurnTwoCarrier({
                child: {
                    executor: executor as never,
                    handle,
                    agent: "historian",
                    system: "historian system prompt",
                    directory: "/review",
                    turnOneText,
                    close: async () => {},
                },
                parentSessionId: "ses-owner",
                harness: "opencode",
                carrier: "hidden-completion",
                enforcedJson: true,
                turnOneText,
                timeoutMs: 1000,
            });
            const { publicationId, factIds } = publish(db, [{ content: "Never answered" }]);
            expect(await run(db, publicationId, carrier)).toMatchObject({
                status: "in_flight",
                childInFlight: true,
            });
            // Five later historian runs, each recovering this stage a day after the send.
            const recover = createOpenCodeTurnTwoRecovery({
                executor: executor as never,
                carrier: "hidden-completion",
                harness: "opencode",
                directory: "/review",
                timeoutMs: 1000,
                now: () => Date.now() + 86_400_000,
            });
            for (let index = 0; index < 5; index++)
                await run(db, publish(db, []).publicationId, stub(() => reply([])).carrier, {
                    recover,
                });
            // Required: the stage is eventually given up (+1 attempt, then retried or
            // left decided_pending) and its child closed. At dafaede1 the fact is
            // still in_flight with 0 attempts and the child was never closed.
            expect(factRow(db, factIds[0]!).state).not.toBe("in_flight");
            expect(closed).toBeGreaterThan(0);
        } finally {
            db.close();
        }
    }, 30_000);

    test("review witness: an items-only send with an unknown outcome is recovered and its child closed", async () => {
        const db = store();
        try {
            dueItem(db, "p-items-only");
            const first = stub(() => "unknown");
            const result = await run(db, publish(db, []).publicationId, first.carrier, {
                readExcerpt: excerpts,
            });
            // No fact was reserved, yet the caller is told to keep the child open.
            expect(result).toMatchObject({ status: "in_flight", childInFlight: true });
            let reattached = 0;
            let closed = 0;
            const recover: TurnTwoRecoveryResolver = () => ({
                reattach: async () => {
                    reattached++;
                    return { kind: "gone" };
                },
                check: async (request) => passingVerdicts(request),
                close: async () => {
                    closed++;
                },
            });
            for (let index = 0; index < 3; index++)
                await run(db, publish(db, []).publicationId, stub(() => reply([])).carrier, {
                    recover,
                    readExcerpt: excerpts,
                });
            // Required: the retained child is reachable by recovery and closed. At
            // dafaede1 recovery only visits stages with an in_flight fact, so this
            // stage is never visited and the child is never closed.
            expect(reattached + closed).toBeGreaterThan(0);
        } finally {
            db.close();
        }
    }, 30_000);

    test("review witness: an agent-memory item the historian never scores is not re-sent without bound", async () => {
        const db = store();
        try {
            dueItem(db, "p-never-scored");
            const prompts: string[] = [];
            for (let index = 0; index < 6; index++) {
                // The model answers with no score (or an invalid one) every time.
                const carrier = stub((prompt) => {
                    prompts.push(prompt);
                    return reply([], [{ item: 1, importance: 0, class: "durable" }]);
                }).carrier;
                await run(db, publish(db, []).publicationId, carrier, {
                    readExcerpt: excerpts,
                });
            }
            // Every one of these is a paid turn-two send carrying no fact at all.
            expect(prompts.every((prompt) => factIdsIn(prompt).length === 0)).toBe(true);
            // Required: items have an attempt bound like facts. At dafaede1: 6 sends.
            expect(prompts.length).toBeLessThanOrEqual(MAX_STAGE2_ATTEMPTS);
        } finally {
            db.close();
        }
    }, 30_000);

    test("review witness: an authority_elsewhere receipt from a resolving transaction cannot pin the fact in_flight on its resend", async () => {
        const db = store();
        try {
            const { publicationId, factIds } = publish(db, [{ content: "Admitted later" }]);
            // The module takes the project's memory authority while turn two is in
            // inference (an authority repair starts), and gives it back afterwards.
            const first = stub((prompt) => {
                db.prepare(
                    "INSERT INTO authority_repair_pending(project_path,started_at) VALUES(?,1)",
                ).run(PROJECT);
                return reply(
                    factIdsIn(prompt).map((id) => ({
                        fact_id: id,
                        check: "Audit fixture.",
                        action: "new",
                    })),
                );
            });
            await run(db, publicationId, first.carrier);
            expect(factRow(db, factIds[0]!)).toMatchObject({
                state: "retryable",
                fact_attempts: 0,
                reason: "authority_elsewhere",
            });
            db.prepare("DELETE FROM authority_repair_pending").run();
            // The same answer on the resend reuses the decision key (same fact, same
            // fact_attempts, same position, no targets).
            for (let index = 0; index < 3; index++)
                await run(
                    db,
                    publish(db, []).publicationId,
                    stub((prompt) =>
                        reply(
                            factIdsIn(prompt).map((id) => ({
                                fact_id: id,
                                check: "Audit fixture.",
                                action: "new",
                            })),
                        ),
                    ).carrier,
                );
            // Required: the fact is admitted (or at least leaves in_flight). At
            // dafaede1 the recorded `retryable` receipt answers the reused key, the
            // fact stays in_flight for good and every run keeps the child open.
            expect(factRow(db, factIds[0]!).state).not.toBe("in_flight");
        } finally {
            db.close();
        }
    }, 30_000);

    test("review witness: with a partial semantic lane, free shortlist slots still take lexical hits", async () => {
        const db = store();
        try {
            const lexical: number[] = [];
            for (let index = 0; index < 5; index++)
                lexical.push(
                    insertMemory(db, {
                        projectPath: PROJECT,
                        category: "CONSTRAINTS",
                        content: `quokkagate upload limit variant ${index}`,
                    }).id,
                );
            // One embedded memory: the semantic lane exists but ranks a single row.
            const embedded = insertMemory(db, {
                projectPath: PROJECT,
                category: "CONSTRAINTS",
                content: "Unrelated embedded memory",
            });
            saveEmbedding(db, embedded.id, new Float32Array([1, 0]), "model-a");
            const result = await retrieveTurnTwoNeighbours(
                db,
                PROJECT,
                "quokkagate upload limit",
                async () => ({ vector: new Float32Array([1, 0]), modelId: "model-a" }),
            );
            expect(result.lexicalOnly).toBe(false);
            expect(result.neighbours).toHaveLength(3);
            expect(
                result.neighbours.every(
                    (memory) => lexical.includes(memory.id) || memory.id === embedded.id,
                ),
            ).toBe(true);
        } finally {
            db.close();
        }
    }, 30_000);
});

// Memory #17639 from the v6 merge trial (.cortexkit/internal-docs/investigations/reports/historian-merge-turn-trial-v6-sonnet.md:71).
// It splits into four clauses; the fourth ("that is the gap to close with a host-runner
// default.") is stale, because the passage below says the host default already exists.
const GAP_MEMORY =
    "Rust transform mode must not require Broca (or any other CK module) to be running: every module under CK/subc stays decoupled unless coupling is necessary. Historian and dreamer completions in rust mode run by default in the same harness as the parent session (the host runs the prompt, e.g. OpenCode/Pi child session or the v2 child carrier), and route to the Broca runner only when the user configures it (Ufuk ruling, 2026-09-17). Today `crates/mc-module/src/historian_producer.rs` opens a route straight to `broca` (DEFAULT_RUNNER_MODULE_ID) — that is the gap to close with a host-runner default.";
// The transcript passage that closes that gap: by default the host runs the historian.
const PASSAGE =
    "ck-mc's historian talks to Broca directly with its own messages, and only when a user sets the historian to run on Broca; the default runs it in the host.";

describe("S6 review probes (passed at dafaede1)", () => {
    function gate(parts: string[]): GateContext {
        return {
            enabled: true,
            enforcedJson: true,
            memoryEnabled: true,
            autoPromote: true,
            anchorKnown: true,
            blocks: [
                {
                    startOrdinal: 7,
                    endOrdinal: 7,
                    role: "user",
                    parts,
                    joinedText: parts.join(" / "),
                },
            ],
            sources: [
                {
                    id: 17639,
                    revision: 1,
                    projectPath: PROJECT,
                    status: "active",
                    content: GAP_MEMORY,
                },
            ],
            historianProfile: PROFILE,
            validatedProfiles: VALIDATED,
        };
    }
    function c4Repair(
        excerpt: string,
        addedText: string,
        addedExcerpt = excerpt,
    ): RevisionDecision {
        const clauses = splitMemoryClauses(GAP_MEMORY);
        return {
            key: "review-17639",
            action: "edit",
            projectPath: PROJECT,
            expectedSources: [{ id: 17639, revision: 1 }],
            survivorId: 17639,
            finalText:
                clauses
                    .slice(0, 3)
                    .map((clause) => clause.text)
                    .join("") + addedText,
            changes: [
                {
                    memoryId: 17639,
                    ordinal: 4,
                    replacement: true,
                    evidence: { blockStartOrdinal: 7, excerpt },
                },
            ],
            added: [{ text: addedText, evidence: { blockStartOrdinal: 7, excerpt: addedExcerpt } }],
        };
    }

    test("review probe: #17639 c4 repair passes the deterministic gates; the quote gate is truncation-aware", () => {
        const closed = "the default runs the historian in the host.";
        // Full passage: a verbatim excerpt is accepted and four narrow checks are planned.
        const full = planMemoryRevision(
            c4Repair("the default runs it in the host", closed),
            gate([PASSAGE]),
        );
        expect(full.ok).toBe(true);
        if (full.ok)
            expect(full.checks.map((check) => check.kind).sort()).toEqual([
                "compatibility",
                "disproof",
                "kept-clause",
                "support",
            ]);
        // The block was cut by the historian window guard inside "host".
        const cut = `${PASSAGE.slice(0, PASSAGE.indexOf("host."))}ho${HISTORIAN_TRUNCATION_MARKER}`;
        // An excerpt may match up to the cut mark ...
        expect(
            planMemoryRevision(c4Repair("the default runs it in the ho", closed), gate([cut])).ok,
        ).toBe(true);
        // ... but never across it, and never quote the marker itself.
        expect(
            planMemoryRevision(c4Repair("the default runs it in the host", closed), gate([cut])),
        ).toEqual({ ok: false, reason: "evidence_or_window" });
        expect(
            planMemoryRevision(
                c4Repair(`the default runs it in the ho${HISTORIAN_TRUNCATION_MARKER}`, closed),
                gate([cut]),
            ),
        ).toEqual({ ok: false, reason: "evidence_or_window" });
        // An added clause may not invent a date the evidence lacks.
        expect(
            planMemoryRevision(
                c4Repair("the default runs it in the host", "Closed on 2026-10-01."),
                gate([PASSAGE]),
            ),
        ).toEqual({ ok: false, reason: "new_token" });
        // Removing the third clause (which names a file path, a backticked identifier and
        // a constant) on evidence that names none of them is refused: code paths and
        // identifiers must be preserved.
        const dropC3: RevisionDecision = {
            ...c4Repair("the default runs it in the host", closed),
            finalText: splitMemoryClauses(GAP_MEMORY)
                .filter((clause) => clause.ordinal !== 3)
                .map((clause) => clause.text)
                .join(""),
            changes: [
                {
                    memoryId: 17639,
                    ordinal: 3,
                    replacement: false,
                    evidence: {
                        blockStartOrdinal: 7,
                        excerpt: "the default runs it in the host",
                    },
                },
            ],
            added: [],
        };
        expect(planMemoryRevision(dropC3, gate([PASSAGE]))).toEqual({
            ok: false,
            reason: "dropped_token",
        });
        // The trial's wrong answer (keep the stale fourth clause and append the new fact)
        // changes no clause, so it is refused as append-only.
        expect(
            planMemoryRevision(
                { ...c4Repair("x", closed), changes: [], finalText: `${GAP_MEMORY} ${closed}` },
                gate([PASSAGE]),
            ),
        ).toEqual({ ok: false, reason: "append_only" });
    }, 30_000);
});

describe("S6 review probes: commit-time CAS (passed at dafaede1)", () => {
    test("review probe: a target revised while the narrow checks are in flight is not overwritten", async () => {
        const db = store();
        try {
            const { memory, published, decision } = editFixture(db);
            let revised = false;
            const carrier: TurnTwoCarrier = {
                ...stub(() => reply([decision])).carrier,
                async check(request) {
                    // An agent edit lands after the pre-plan check and before the
                    // resolving transaction (revision 1 -> 2, new text).
                    if (!revised) {
                        revised = true;
                        db.prepare(
                            "UPDATE memories SET content='Agent text. Keep rule.',revision=2 WHERE id=?",
                        ).run(memory.id);
                    }
                    return passingVerdicts(request);
                },
            };
            await run(db, published.publicationId, carrier);
            expect(getMemoryById(db, memory.id)?.content).toBe("Agent text. Keep rule.");
            expect(factRow(db, published.factIds[0]!)).toMatchObject({
                state: "retryable",
                fact_attempts: 1,
                reason: "cas_loss",
            });
            expect(
                (db.prepare("SELECT COUNT(*) AS n FROM memory_history").get() as { n: number }).n,
            ).toBe(0);
        } finally {
            db.close();
        }
    }, 30_000);
});

describe("S6 review probes: SIGKILL recovery (passed at dafaede1)", () => {
    const SRC = join(import.meta.dir, "../../..");
    const CHILD = `
const [root, dbPath, mode, json] = process.argv.slice(2);
const { Database } = await import(root + "/shared/sqlite.ts");
const { runTurnTwo } = await import(root + "/features/magic-context/memory/turn-two.ts");
const input = JSON.parse(json);
const db = new Database(dbPath);
const kill = (at) => { if (mode === at) process.kill(process.pid, "SIGKILL"); };
const carrier = {
    carrier: "hidden-completion",
    harness: "opencode",
    enforcedJson: true,
    childSessionId: "child-kill",
    baseline: "turn-one-hash",
    async send() {
        kill("send");
        return { text: JSON.stringify({ result: { step: "turn_two", decisions: [input.decision] } }), lengthCapped: false, profile: input.profile };
    },
    async check(request) {
        kill("check");
        const passing = request.kind === "disproof" || request.kind === "support" ? "yes" : "no";
        return {
            verdicts: (request.kind === "compatibility" ? request.pairs : request.operands).map((o) => ({ id: o.id, verdict: passing })),
            profile: input.validated.find(row => row.systemHash === request.systemHash),
            usage: null,
        };
    },
};
await runTurnTwo(db, {
    projectPath: input.project, publicationId: input.publicationId, sessionId: "ses-owner", lane: "enabled",
    carrier, memoryEnabled: true, autoPromote: true, validatedProfiles: input.validated,
});
db.close();
process.exit(0);
`;

    function crash(mode: "send" | "check") {
        const root = join(tmpdir(), "magic-context", "s6-review");
        mkdirSync(root, { recursive: true });
        const dir = createTestTempDirFromPath(join(root, `sigkill-${mode}-`));
        const dbPath = join(dir, "context.db");
        const script = join(dir, "child.ts");
        writeFileSync(script, CHILD);
        let db = new Database(dbPath);
        initializeDatabase(db);
        runMigrations(db);
        const fixture = editFixture(db);
        db.close();
        const child = spawnSync(
            process.execPath,
            [
                script,
                SRC,
                dbPath,
                mode,
                JSON.stringify({
                    project: PROJECT,
                    publicationId: fixture.published.publicationId,
                    decision: fixture.decision,
                    profile: PROFILE,
                    validated: VALIDATED,
                }),
            ],
            { encoding: "utf8", windowsHide: true },
        );
        db = new Database(dbPath);
        return { db, dir, child, ...fixture };
    }

    const historyCount = (db: Database) =>
        (db.prepare("SELECT COUNT(*) AS n FROM memory_history").get() as { n: number }).n;

    test("review probe: SIGKILL during the turn-two send; recovery reattaches the reply by stage key and applies once", async () => {
        const { db, dir, child, memory, published, decision } = crash("send");
        try {
            expect(child.signal).toBe("SIGKILL");
            expect(factRow(db, published.factIds[0]!)).toMatchObject({
                state: "in_flight",
                fact_attempts: 0,
            });
            expect(
                db
                    .prepare(
                        "SELECT state,reply_json,classification_watermark IS NOT NULL AS watermarked FROM memory_stage_attempts WHERE stage='turn_two'",
                    )
                    .get(),
            ).toEqual({ state: "sending", reply_json: null, watermarked: 1 });
            const reattached: string[] = [];
            let closed = 0;
            const recover: TurnTwoRecoveryResolver = (record) => ({
                reattach: async () => {
                    reattached.push(record.stageKey);
                    return { kind: "reply", reply: reply([decision]) };
                },
                check: async (request) => passingVerdicts(request),
                close: async () => {
                    closed++;
                },
            });
            const later = stub(() => reply([]));
            for (let index = 0; index < 2; index++)
                await run(db, publish(db, []).publicationId, later.carrier, { recover });
            expect(reattached).toHaveLength(1);
            expect(later.prompts).toEqual([]);
            expect(factRow(db, published.factIds[0]!)).toMatchObject({
                state: "applied",
                fact_attempts: 0,
            });
            expect(getMemoryById(db, memory.id)?.content).toBe("New rule. Keep rule.");
            expect(historyCount(db)).toBe(1);
            expect(closed).toBe(1);
        } finally {
            db.close();
            cleanupTestTempDir(dir);
        }
    }, 30_000);

    test("review probe: SIGKILL during a narrow check; recovery charges one attempt, the resend applies once", async () => {
        const { db, dir, child, memory, published, decision } = crash("check");
        try {
            expect(child.signal).toBe("SIGKILL");
            expect(factRow(db, published.factIds[0]!)).toMatchObject({
                state: "in_flight",
                fact_attempts: 0,
            });
            expect(db.prepare("SELECT state FROM memory_check_attempts").all()).toEqual([
                { state: "in_flight" },
            ]);
            // Like createOpenCodeTurnTwoRecovery: a check child opened by the killed process
            // cannot be reached again, so reattaching it fails as a transport error.
            const recover: TurnTwoRecoveryResolver = () => ({
                reattach: async () => {
                    throw new Error("a recorded reply needs no reattach");
                },
                reattachCheck: () => Promise.reject(new Error("not recoverable")),
                check: () => Promise.reject(new Error("recovered stage cannot open checks")),
            });
            // This run first recovers the killed stage (the fact becomes retryable, one
            // attempt charged) and then sends the fact again as backlog.
            const resend = stub((prompt) =>
                reply(factIdsIn(prompt).map((id) => ({ ...decision, fact_id: id }))),
            );
            await run(db, publish(db, []).publicationId, resend.carrier, { recover });
            expect(
                db
                    .prepare(
                        "SELECT receipt_json FROM memory_decision_receipts WHERE fact_id=? AND receipt_json LIKE '%check_transport%'",
                    )
                    .all(published.factIds[0]!),
            ).toHaveLength(1);
            expect(resend.prompts).toHaveLength(1);
            // A further run sends no prompt: the fact is already applied.
            const later = stub(() => reply([]));
            await run(db, publish(db, []).publicationId, later.carrier, { recover });
            expect(later.prompts).toEqual([]);
            expect(factRow(db, published.factIds[0]!)).toMatchObject({
                state: "applied",
                fact_attempts: 1,
            });
            expect(getMemoryById(db, memory.id)?.content).toBe("New rule. Keep rule.");
            expect(historyCount(db)).toBe(1);
            expect(
                (
                    db.prepare("SELECT COUNT(*) AS n FROM memory_mutation_log").get() as {
                        n: number;
                    }
                ).n,
            ).toBe(0);
        } finally {
            db.close();
            cleanupTestTempDir(dir);
        }
    }, 30_000);
});

describe("S6 review probes: projection (passed at dafaede1)", () => {
    test("review probe: an applied turn-two edit is invisible on SOFT and defer passes and appears at the next genuine HARD (OpenCode)", async () => {
        const { createProjectionFixture } = await import(
            "../../../shared/memory-projection-fixtures.test"
        );
        const { injectM0M1, materializeM0 } = await import(
            "../../../hooks/magic-context/inject-compartments"
        );
        const { getOrCreateSessionMeta } = await import("../storage");
        const f = createProjectionFixture("s6-review");
        try {
            const [session] = f.sessions;
            const options = (cacheExpired = false) => ({
                db: f.db,
                state: getOrCreateSessionMeta(f.db, session),
                sessionId: session,
                projectPath: f.projectPath,
                projectDirectory: f.directory,
                injectDocs: false,
                hardSignals: {
                    systemHash: "system",
                    modelKey: "anthropic/claude",
                    cacheExpired,
                    lastResponseTime: cacheExpired ? Date.now() + 60_000 : 1,
                },
            });
            const pass = (busting: boolean, cacheExpired = false) => {
                const result = injectM0M1({
                    ...options(cacheExpired),
                    isCacheBustingPass: busting,
                });
                return {
                    m0: result.m0Bytes?.toString("utf8") ?? "",
                    m1: result.m1Text ?? "",
                    materialized: result.m0RematerializedThisPass,
                };
            };
            const memory = insertMemory(f.db, {
                projectPath: f.projectPath,
                category: "CONSTRAINTS",
                content: "Old rule. Keep rule.",
            });
            materializeM0(options());
            const before = pass(true);
            expect(before.m0).toContain("Old rule. Keep rule.");
            // Turn two, lane enabled in this test, applies the edit.
            const send = allocateTurnOneSend(f.db, {
                projectPath: f.projectPath,
                sessionId: session,
                harness: "opencode",
                carrier: "test",
                lane: "enabled",
                chunkStart: 1,
                chunkEnd: 50,
            });
            AUTHORIZATION.persist(f.db, send.stageKey);
            f.db.transaction(() =>
                commitTurnOnePublication(f.db, {
                    send,
                    projectPath: f.projectPath,
                    sessionId: session,
                    compartments: [
                        {
                            id: 1,
                            startMessage: 1,
                            endMessage: 50,
                            replyStartMessage: 1,
                            replyEndMessage: 50,
                        },
                    ],
                    blocks: [
                        {
                            role: "user",
                            startOrdinal: 42,
                            endOrdinal: 42,
                            parts: ["New rule."],
                        },
                    ],
                    candidateFacts: [
                        {
                            category: "CONSTRAINTS",
                            content: "New rule replaces the old one",
                            anchor: { compartmentIndex: 1, startOrdinal: 42, endOrdinal: 42 },
                        },
                    ],
                    honourAnchors: true,
                }),
            )();
            const logBefore = (
                f.db.prepare("SELECT COUNT(*) AS n FROM memory_mutation_log").get() as {
                    n: number;
                }
            ).n;
            const result = await runTurnTwo(f.db, {
                projectPath: f.projectPath,
                publicationId: send.publicationId,
                sessionId: session,
                lane: "enabled",
                carrier: stub((prompt) =>
                    reply(
                        factIdsIn(prompt).map((id) => ({
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
                        })),
                    ),
                ).carrier,
                memoryEnabled: true,
                autoPromote: true,
                validatedProfiles: VALIDATED,
            });
            expect(result.status).toBe("resolved");
            expect(getMemoryById(f.db, memory.id)?.content).toBe("New rule. Keep rule.");
            expect(
                (
                    f.db.prepare("SELECT COUNT(*) AS n FROM memory_mutation_log").get() as {
                        n: number;
                    }
                ).n,
            ).toBe(logBefore);
            // SOFT and defer passes read no memory row and serve the old bytes.
            f.gate.blocking = true;
            try {
                for (const busting of [true, false, true, false]) {
                    f.gate.allowDashboardPayloads = busting;
                    const served = pass(busting);
                    expect(served.m0).toBe(before.m0);
                    expect(served.m1).toBe(before.m1);
                    expect(served.materialized).toBe(false);
                }
            } finally {
                f.gate.blocking = false;
                f.gate.allowDashboardPayloads = false;
            }
            expect(f.gate.blocked).toEqual([]);
            // A genuine HARD trigger (provider cache expiry) shows the edit.
            const hard = pass(true, true);
            expect(hard.materialized).toBe(true);
            expect(hard.m0).toContain("New rule. Keep rule.");
            expect(hard.m0).not.toContain("Old rule.");
        } finally {
            f.close();
        }
    }, 30_000);
});
