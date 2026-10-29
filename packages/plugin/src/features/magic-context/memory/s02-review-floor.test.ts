import { expect, test } from "bun:test";
import edgeCases from "../../../../../../crates/mc-store/testdata/s02-review-score-cases.json";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { mergeProjectIdentities } from "../storage-identity-merge";
import {
    applyDashboardMemoryEdit,
    applyMemoryRestore,
    previewMemoryRestore,
} from "./history-applier";
import {
    applyAgentMemoryMutation,
    applyCurateMemoryMutation,
    applyHistorianRevision,
} from "./lifecycle-applier";
import { getMemoryById, insertMemory, setMemoryClassification } from "./storage-memory";
import { recordItemScores } from "./turn-two-scoring";
import { authorizationFixture } from "./turn-two-test-fixtures.test";

function fixture() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const projectPath = "git:s02-floor";
    const rule = insertMemory(db, {
        projectPath,
        category: "PROJECT_RULES",
        content: "Never push without approval.",
    });
    const other = insertMemory(db, {
        projectPath,
        category: "PROJECT_RULES",
        content: "Use the release branch for releases.",
    });
    setMemoryClassification(db, rule.id, { safetyCritical: true, importance: 40 });
    return { db, projectPath, rule, other };
}

test("s02 review: TS score edges share exact expectations with Rust", () => {
    const f = fixture();
    try {
        for (const [i, sample] of edgeCases.entries()) {
            const memory = insertMemory(f.db, {
                projectPath: f.projectPath,
                category: "PROJECT_RULES",
                content: `Score edge ${i}.`,
            });
            if (sample.flag !== null)
                setMemoryClassification(f.db, memory.id, { safetyCritical: sample.flag });
            const item = Number(
                f.db
                    .prepare(`INSERT INTO memory_classification_items(project_path,memory_id,saved_revision,source_session_id,tool_call_part_id,save_ordinal,excerpt)
                VALUES(?,?,1,'ses',?,1,'excerpt')`)
                    .run(f.projectPath, memory.id, `edge-${i}`).lastInsertRowid,
            );
            expect(
                recordItemScores(
                    f.db,
                    [item],
                    [{ item, importance: sample.score, proposedClass: "durable" }],
                ),
            ).toBe(1);
            expect(getMemoryById(f.db, memory.id)).toMatchObject({
                safetyCritical: sample.flag === null ? null : Number(sample.flag),
                importance: sample.expected,
            });
        }
        for (const importance of [null, 0, 1, 79, 80, 81, 100]) {
            f.db
                .prepare("UPDATE memories SET importance=?,safety_critical=NULL WHERE id=?")
                .run(importance, f.rule.id);
            setMemoryClassification(f.db, f.rule.id, { safetyCritical: true });
            expect(getMemoryById(f.db, f.rule.id)).toMatchObject({
                safetyCritical: 1,
                importance: importance === 100 ? 100 : importance === 81 ? 81 : 80,
            });
        }
    } finally {
        f.db.close();
    }
});

for (const [writer, apply] of [
    ["agent", applyAgentMemoryMutation],
    ["curate", applyCurateMemoryMutation],
] as const) {
    test(`s02 P1: ${writer} merge retains safety and floor on the canonical successor`, () => {
        const f = fixture();
        try {
            const result = apply(f.db, {
                key: `${writer}-merge`,
                projectPath: f.projectPath,
                sourceSessionId: "ses-review",
                operation: "merge",
                targets: [
                    { id: f.rule.id, revision: 1 },
                    { id: f.other.id, revision: 1 },
                ],
                content: "Never push without approval. Use the release branch for releases.",
            });
            expect(result.state).toBe("applied");
            const successor = getMemoryById(f.db, result.memoryId!);
            console.log(`${writer} merge successor`, {
                safety: successor?.safetyCritical,
                importance: successor?.importance,
            });
            expect(successor).toMatchObject({ safetyCritical: 1, importance: 80 });
        } finally {
            f.db.close();
        }
    });
}

test("s02 P1: identity collision cannot copy a low score onto a safety-critical target", () => {
    const f = fixture();
    try {
        const source = insertMemory(f.db, {
            projectPath: "dir:old-s02",
            category: "PROJECT_RULES",
            content: f.rule.content,
        });
        setMemoryClassification(f.db, source.id, { importance: 20, safetyCritical: false });
        f.db.prepare("UPDATE memories SET classified_at=1 WHERE id=?").run(f.rule.id);
        f.db.prepare("UPDATE memories SET classified_at=2 WHERE id=?").run(source.id);
        mergeProjectIdentities(f.db, "dir:old-s02", f.projectPath, { now: 100 });
        const target = getMemoryById(f.db, f.rule.id);
        expect(target?.safetyCritical).toBe(1);
        console.log("identity collision target", {
            safety: target?.safetyCritical,
            importance: target?.importance,
        });
        expect(target?.importance).toBeGreaterThanOrEqual(80);
    } finally {
        f.db.close();
    }
});

test("s02 review: update, dashboard edit, archive and audited undo preserve an assessed floor", () => {
    const f = fixture();
    try {
        expect(
            applyAgentMemoryMutation(f.db, {
                key: "edit",
                projectPath: f.projectPath,
                sourceSessionId: "ses-review",
                operation: "update",
                targets: [{ id: f.rule.id, revision: 1 }],
                content: "Never push without explicit approval.",
            }).state,
        ).toBe("applied");
        expect(
            applyDashboardMemoryEdit(
                f.db,
                {
                    projectPath: f.projectPath,
                    operationId: "dashboard",
                    expectedRevisions: [{ memoryId: f.rule.id, revision: 2 }],
                    changes: [
                        {
                            memoryId: f.rule.id,
                            content: "Never push unless the user explicitly approves.",
                        },
                    ],
                },
                100,
            ).state,
        ).toBe("applied");
        expect(
            applyAgentMemoryMutation(f.db, {
                key: "archive",
                projectPath: f.projectPath,
                sourceSessionId: "ses-review",
                operation: "archive",
                targets: [{ id: f.rule.id, revision: 3 }],
                reason: "archive for restore probe",
            }).state,
        ).toBe("applied");
        const preview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: "archive",
        });
        expect(preview.state).toBe("ready");
        expect(
            applyMemoryRestore(
                f.db,
                {
                    projectPath: f.projectPath,
                    decisionKey: "archive",
                    operationId: "undo-archive",
                    expectedRevisions: preview.expectedRevisions,
                },
                200,
            ).state,
        ).toBe("applied");
        expect(getMemoryById(f.db, f.rule.id)).toMatchObject({
            safetyCritical: 1,
            importance: 80,
            status: "active",
        });
    } finally {
        f.db.close();
    }
});

test("s02 P1: historian merge carries a retained safety clause into the survivor assessment", async () => {
    const f = fixture();
    try {
        const text = "Use the release branch for explicit releases.";
        const evidence = { blockStartOrdinal: 42, excerpt: text };
        const authorization = authorizationFixture(
            {
                lane: "opencode-1",
                carrier: "hidden-completion",
                provider: "review",
                modelId: "review",
                variant: null,
                temperature: 0,
                thinkingLevel: null,
            },
            "historian",
        );
        const profile = authorization.profile;
        const sources = [f.rule.id, f.other.id].map((id) => ({
            ...getMemoryById(f.db, id)!,
            revision: 1,
        }));
        const receipt = await applyHistorianRevision(
            f.db,
            {
                key: "historian-merge",
                action: "merge",
                projectPath: f.projectPath,
                expectedSources: sources.map((s) => ({ id: s.id, revision: s.revision })),
                survivorId: f.other.id,
                finalText: `${text} ${f.rule.content}`,
                changes: [{ memoryId: f.other.id, ordinal: 1, replacement: true, evidence }],
                added: [{ text: `${text} `, evidence }],
            },
            {
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
                        parts: [text],
                        joinedText: text,
                    },
                ],
                sources,
                historianProfile: profile,
                validatedProfiles: authorization.rows,
            },
            { sessionId: "ses-review", harness: "review" },
            async (request) => ({
                profile: authorization.checkProfile(request.systemHash),
                usage: { tokens: 1 },
                verdicts: (request.kind === "compatibility" ? request.pairs : request.operands).map(
                    (operand) => ({
                        id: operand.id,
                        verdict:
                            request.kind === "disproof" || request.kind === "support"
                                ? ("yes" as const)
                                : ("no" as const),
                    }),
                ),
            }),
        );
        expect(receipt).toMatchObject({ state: "applied", reason: "merge" });
        const survivor = getMemoryById(f.db, f.other.id);
        console.log("historian merge survivor", {
            safety: survivor?.safetyCritical,
            importance: survivor?.importance,
        });
        expect(survivor).toMatchObject({ safetyCritical: 1, importance: 80 });
    } finally {
        f.db.close();
    }
});
