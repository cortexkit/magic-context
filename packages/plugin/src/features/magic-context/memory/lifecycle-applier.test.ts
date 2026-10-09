import { describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { initializeDatabase } from "../storage-db";
import {
    applyHistorianRevision,
    applyMemoryAdmission,
    memoryAdoptionClass,
    proposeMemoryMutation,
} from "./lifecycle-applier";
import { checkMemoryRevision } from "./lifecycle-check-ledger";
import { CHECK_SYSTEM_PROMPTS, type GateContext, type RevisionDecision } from "./lifecycle-gates";
import { lifecycleTextHash } from "./lifecycle-text";
import { promoteSessionFactsDurable } from "./promotion";
import { getMemoryById, insertMemory } from "./storage-memory";

function store() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    return db;
}
const input = {
    projectPath: "p",
    category: "NAMING" as const,
    content: "Use stable names",
    sourceSessionId: "s",
};
function renderingState(db: Database) {
    return {
        mutations: db.prepare("SELECT * FROM memory_mutation_log").all(),
        epochs: db.prepare("SELECT * FROM project_state").all(),
    };
}

describe("memory lifecycle applier", () => {
    test("new and live match receipts are atomic idempotent and never log mutations or bump epoch", () => {
        const db = store();
        try {
            const before = renderingState(db);
            const saved = applyMemoryAdmission(db, { key: "first", operation: "new", input });
            expect(saved).toMatchObject({ state: "applied", reason: "inserted", inserted: true });
            expect(applyMemoryAdmission(db, { key: "first", operation: "new", input })).toEqual(
                saved,
            );
            const live = applyMemoryAdmission(db, { key: "second", operation: "new", input });
            expect(live).toMatchObject({
                state: "applied",
                reason: "live_match",
                inserted: false,
                memoryId: saved.memoryId,
            });
            applyMemoryAdmission(db, { key: "second", operation: "new", input });
            expect(getMemoryById(db, saved.memoryId!)?.seenCount).toBe(2);
            expect(renderingState(db)).toEqual(before);
            expect(db.prepare("SELECT COUNT(*) AS n FROM memory_journal").get()).toEqual({ n: 2 });
        } finally {
            db.close();
        }
    });
    test("archived and cross-category promotions are decided_pending with the match id", () => {
        const db = store();
        try {
            const archived = insertMemory(db, input);
            db.prepare("UPDATE memories SET status='archived' WHERE id=?").run(archived.id);
            const before = db.prepare("SELECT * FROM memories").all();
            const promotion = promoteSessionFactsDurable(db, "s", "p", [
                { category: "NAMING", content: input.content },
            ]);
            expect(promotion).toMatchObject({
                factsPromoted: 0,
                newMemoryRefs: [],
                receipts: [
                    { state: "decided_pending", reason: "archived_match", memoryId: archived.id },
                ],
            });
            expect(db.prepare("SELECT * FROM memories").all()).toEqual(before);
            const foreign = insertMemory(db, {
                ...input,
                category: "CONSTRAINTS",
                content: "Different category bytes",
            });
            expect(
                applyMemoryAdmission(db, {
                    key: "cross",
                    operation: "new",
                    input: { ...input, content: foreign.content },
                }),
            ).toMatchObject({
                state: "decided_pending",
                reason: "cross_category_match",
                memoryId: foreign.id,
            });
            expect(getMemoryById(db, foreign.id)?.seenCount).toBe(1);
        } finally {
            db.close();
        }
    });
    test("agent_save records one classification item with default score and never loses it on rollback", () => {
        const db = store();
        try {
            const request = {
                key: "save",
                operation: "agent_save" as const,
                input: { ...input, importance: 90 },
                classificationAnchor: { toolCallPartId: "part", saveOrdinal: 42 },
            };
            expect(() =>
                db.transaction(() => {
                    applyMemoryAdmission(db, request);
                    throw Error("crash");
                })(),
            ).toThrow("crash");
            expect(db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 0 });
            expect(
                db.prepare("SELECT COUNT(*) AS n FROM memory_classification_items").get(),
            ).toEqual({ n: 0 });
            const receipt = applyMemoryAdmission(db, request);
            applyMemoryAdmission(db, request);
            expect(getMemoryById(db, receipt.memoryId!)?.importance).toBe(50);
            expect(getMemoryById(db, receipt.memoryId!)?.sourceType).toBe("agent");
            expect(
                db
                    .prepare(
                        "SELECT saved_revision,save_ordinal,importance,proposed_class FROM memory_classification_items",
                    )
                    .all(),
            ).toEqual([
                { saved_revision: 1, save_ordinal: 42, importance: null, proposed_class: null },
            ]);
        } finally {
            db.close();
        }
    });
    test("dormant agent_save has no classification item", () => {
        const db = store();
        try {
            applyMemoryAdmission(db, { key: "save", operation: "agent_save", input });
            expect(
                db.prepare("SELECT COUNT(*) AS n FROM memory_classification_items").get(),
            ).toEqual({ n: 0 });
        } finally {
            db.close();
        }
    });
    test("curate proposals preserve canonical rows rendering history links and embeddings", () => {
        const db = store();
        try {
            const memory = insertMemory(db, input);
            const rows = db.prepare("SELECT * FROM memories").all();
            const before = renderingState(db);
            for (const writer of ["curate"] as const)
                for (const operation of ["archive", "merge", "update"] as const) {
                    expect(
                        proposeMemoryMutation(db, {
                            projectPath: "p",
                            sourceSessionId: "s",
                            key: `${writer}:${operation}`,
                            writer,
                            operation,
                            targetIds: [memory.id],
                            proposal: { content: "replacement" },
                        }),
                    ).toMatchObject({
                        state: "decided_pending",
                        reason: "MEMORY_PENDING_PROPOSAL",
                    });
                }
            expect(db.prepare("SELECT * FROM memories").all()).toEqual(rows);
            expect(renderingState(db)).toEqual(before);
            expect(db.prepare("SELECT COUNT(*) AS n FROM memory_tool_proposals").get()).toEqual({
                n: 3,
            });
            expect(db.prepare("SELECT COUNT(*) AS n FROM memory_history").get()).toEqual({ n: 0 });
        } finally {
            db.close();
        }
    });
    test("adoption classes are fixed and admissions are not mutations", () => {
        expect(
            ["edit", "merge", "replaces", "dashboard_content", "dashboard_archive"].map(
                memoryAdoptionClass,
            ),
        ).toEqual(Array(5).fill("live"));
        expect(
            [
                "undo",
                "importance",
                "class",
                "restore",
                "unarchive",
                "category",
                "pin",
                "verification",
            ].map(memoryAdoptionClass),
        ).toEqual(Array(8).fill("deferred"));
        expect(["new", "conflict", "agent_save", "seen_count"].map(memoryAdoptionClass)).toEqual(
            Array(4).fill(null),
        );
    });
    test("production revisions remain pending until projection exists with no canonical writes", async () => {
        const db = store();
        try {
            const memory = insertMemory(db, { ...input, content: "Old rule. Keep rule." });
            const before = db.prepare("SELECT * FROM memories").all();
            const evidence = { blockStartOrdinal: 42, excerpt: "New rule." };
            const profile = {
                provider: "test",
                modelId: "reported",
                variant: null,
                temperature: 0,
                systemHash: "historian",
            };
            const decision: RevisionDecision = {
                key: "edit",
                action: "edit",
                projectPath: "p",
                expectedSources: [{ id: memory.id, revision: 1 }],
                survivorId: memory.id,
                finalText: "New rule. Keep rule.",
                changes: [{ memoryId: memory.id, ordinal: 1, replacement: true, evidence }],
                added: [{ text: "New rule. ", evidence }],
            };
            const context: GateContext = {
                memoryEnabled: true,
                autoPromote: true,
                enabled: true,
                enforcedJson: true,
                anchorKnown: true,
                blocks: [
                    {
                        startOrdinal: 42,
                        endOrdinal: 42,
                        role: "user",
                        parts: ["New rule."],
                        joinedText: "New rule.",
                    },
                ],
                sources: [{ ...memory, revision: 1 }],
                historianProfile: profile,
                validatedProfiles: [
                    profile,
                    ...Object.values(CHECK_SYSTEM_PROMPTS).map((system) => ({
                        ...profile,
                        systemHash: lifecycleTextHash(system),
                    })),
                ],
            };
            let calls = 0;
            const receipt = await applyHistorianRevision(
                db,
                decision,
                context,
                { sessionId: "s", harness: "opencode" },
                async () => {
                    calls++;
                    throw Error("must not send");
                },
            );
            expect(receipt).toMatchObject({
                state: "decided_pending",
                reason: "projection_pending",
            });
            expect(calls).toBe(0);
            const send = async (
                request: Parameters<Parameters<typeof checkMemoryRevision>[4]>[0],
            ) => {
                calls++;
                return {
                    profile: { ...profile, systemHash: request.systemHash },
                    usage: { tokens: 10 },
                    verdicts: (request.kind === "compatibility"
                        ? request.pairs
                        : request.operands
                    ).map((operand) => ({
                        id: operand.id,
                        verdict: (request.kind === "disproof" || request.kind === "support"
                            ? "yes"
                            : "no") as "yes" | "no",
                    })),
                };
            };
            expect(
                await checkMemoryRevision(
                    db,
                    { sessionId: "s", harness: "opencode" },
                    decision,
                    context,
                    send,
                ),
            ).toEqual({ ok: true });
            expect(calls).toBe(4);
            expect(
                await checkMemoryRevision(
                    db,
                    { sessionId: "s", harness: "opencode" },
                    decision,
                    context,
                    send,
                ),
            ).toEqual({ ok: true });
            expect(calls).toBe(4);
            expect(db.prepare("SELECT state,usage_json FROM memory_check_attempts").all()).toEqual(
                Array(4).fill({ state: "resolved", usage_json: '{"tokens":10}' }),
            );
            expect(db.prepare("SELECT * FROM memories").all()).toEqual(before);
            expect(db.prepare("SELECT COUNT(*) AS n FROM memory_history").get()).toEqual({ n: 0 });
        } finally {
            db.close();
        }
    });
});
