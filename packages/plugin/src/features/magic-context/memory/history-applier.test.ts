import { expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { createTestTempDir } from "../../../shared/test-temp-dir";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    applyDashboardMemoryEdit,
    applyMemoryRestore,
    listMemoryHistory,
    makeMemoryHistoryDecision,
    memoryHistorySnapshot,
    normalizeMemoryHistorySnapshot,
    previewMemoryRestore,
    recordMemoryHistoryDecision,
} from "./history-applier";
import { memoryHistoryRpc } from "./history-rpc";
import {
    applyCurateMemoryMutation,
    applyHistorianRevision,
    applyMemoryAdmission,
} from "./lifecycle-applier";
import type { RevisionDecision } from "./lifecycle-gates";
import { lifecycleTextHash } from "./lifecycle-text";
import { getMemoryById, insertMemory, setMemoryClassification } from "./storage-memory";
import { authorizationFixture } from "./turn-two-test-fixtures.test";

function fixture() {
    const { dir: directory, cleanup } = createTestTempDir("memory-history-undo-");
    const path = join(directory, "context.db");
    let db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    const projectPath = "git:history";
    db.exec(
        "INSERT INTO session_meta(session_id,cached_m0_materialized_at,cached_m0_max_mutation_id,cached_m0_max_memory_mutation_id) VALUES('undo',123,7,8); INSERT INTO session_render_cache(session_id,cache_key,value) VALUES('undo','cached_m0_bytes',X'010203'),('undo','cached_m1_bytes',X'040506')",
    );
    const cache = () => ({
        meta: db.prepare("SELECT * FROM session_meta WHERE session_id='undo'").get(),
        payloads: db
            .prepare(
                "SELECT * FROM session_render_cache WHERE session_id='undo' ORDER BY cache_key",
            )
            .all(),
    });
    const cached = cache();
    const add = (content = "config.ts uses cache_ttl=5m.") =>
        insertMemory(db, { projectPath, category: "CONFIG_VALUES", content });
    return {
        get db() {
            return db;
        },
        projectPath,
        add,
        cache,
        cached,
        reopen() {
            db.close();
            db = new Database(path);
        },
        close() {
            db.close();
            cleanup();
        },
    };
}
function edit(
    f: ReturnType<typeof fixture>,
    id: number,
    operationId: string,
    content: string,
    revision = memoryHistorySnapshot(f.db, id)!.revision,
) {
    return applyDashboardMemoryEdit(
        f.db,
        {
            projectPath: f.projectPath,
            operationId,
            expectedRevisions: [{ memoryId: id, revision }],
            changes: [{ memoryId: id, content }],
        },
        1000,
    );
}

test("history restore records a new revision and replays the durable receipt after reopen", () => {
    const f = fixture();
    try {
        const row = f.add();
        const changed = edit(f, row.id, "edit", "config.ts uses cache_ttl=10m.");
        expect(changed.state).toBe("applied");
        const preview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: changed.decisionKey!,
        });
        expect(preview.state).toBe("ready");
        const request = {
            projectPath: f.projectPath,
            decisionKey: changed.decisionKey!,
            operationId: "undo",
            expectedRevisions: preview.expectedRevisions,
        };
        const receipt = applyMemoryRestore(f.db, request, 2000);
        expect(receipt.state).toBe("applied");
        expect(memoryHistorySnapshot(f.db, row.id)?.revision).toBe(3);
        expect(memoryHistorySnapshot(f.db, row.id)?.content).toBe(row.content);
        f.reopen();
        expect(applyMemoryRestore(f.db, request, 3000)).toEqual(receipt);
        expect(listMemoryHistory(f.db, { projectPath: f.projectPath }).decisions).toHaveLength(2);
        expect(
            f.db
                .prepare("SELECT project_memory_epoch n FROM project_state WHERE project_path=?")
                .get(f.projectPath),
        ).toEqual({ n: 2 });
        expect(
            applyMemoryRestore(f.db, {
                ...request,
                expectedRevisions: [{ memoryId: row.id, revision: 3 }],
            }).reason,
        ).toBe("operation_id_reused");
    } finally {
        f.close();
    }
});

test("history restore restores the three-state safety assessment from its pre-image", () => {
    const f = fixture();
    try {
        const row = f.add();
        const before = memoryHistorySnapshot(f.db, row.id)!;
        expect(before.safetyCritical).toBeNull();
        setMemoryClassification(f.db, row.id, { safetyCritical: true });
        f.db.prepare("UPDATE memories SET revision=revision+1 WHERE id=?").run(row.id);
        const after = memoryHistorySnapshot(f.db, row.id)!;
        recordMemoryHistoryDecision(
            f.db,
            makeMemoryHistoryDecision({
                key: "safety-assessment",
                projectPath: f.projectPath,
                writer: "dreamer",
                operation: "classify",
                reason: "safety assessment",
                now: 1000,
                before: [before],
                after: [after],
                sourceIds: [row.id],
            }),
        );
        const preview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: "safety-assessment",
        });
        expect(preview.state).toBe("ready");
        const result = applyMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: "safety-assessment",
            operationId: "undo-safety",
            expectedRevisions: preview.expectedRevisions,
        });
        expect(result.state).toBe("applied");
        expect(memoryHistorySnapshot(f.db, row.id)?.safetyCritical).toBeNull();
        expect(memoryHistorySnapshot(f.db, row.id)?.importance).toBe(before.importance);
    } finally {
        f.close();
    }
});

test("history restore CAS refuses a stale participant without changing canonical rows", () => {
    const f = fixture();
    try {
        const row = f.add();
        const change = edit(f, row.id, "change", "config.ts uses cache_ttl=10m.");
        const preview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: change.decisionKey!,
        });
        edit(f, row.id, "later", "config.ts uses cache_ttl=20m.");
        const before = memoryHistorySnapshot(f.db, row.id);
        const receipt = applyMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: change.decisionKey!,
            operationId: "stale",
            expectedRevisions: preview.expectedRevisions,
        });
        expect(receipt.state).toBe("conflict");
        expect(receipt.reason).toBe("stale_revision");
        expect(memoryHistorySnapshot(f.db, row.id)).toEqual(before);
    } finally {
        f.close();
    }
});

test("history restore detects duplicate hashes including archived nonparticipants", () => {
    const f = fixture();
    try {
        const row = f.add();
        const change = edit(f, row.id, "change", "config.ts uses cache_ttl=10m.");
        const duplicate = f.add(row.content);
        f.db.prepare("UPDATE memories SET status='archived' WHERE id=?").run(duplicate.id);
        const preview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: change.decisionKey!,
        });
        expect(preview.state).toBe("conflict");
        expect(preview.reason).toBe("duplicate_content");
        const receipt = applyMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: change.decisionKey!,
            operationId: "duplicate",
            expectedRevisions: [{ memoryId: row.id, revision: 2 }],
        });
        expect(receipt.state).toBe("conflict");
        expect(receipt.conflicts[0]?.duplicateId).toBe(duplicate.id);
    } finally {
        f.close();
    }
});

test("history merge restore refuses a later survivor edit and reconciles a complete unchanged merge", () => {
    const f = fixture();
    try {
        const first = f.add();
        const second = f.add("config.ts sets connect_timeout=5s.");
        const receipt = applyCurateMemoryMutation(f.db, {
            key: "merge",
            projectPath: f.projectPath,
            sourceSessionId: "",
            operation: "merge",
            targets: [
                { id: first.id, revision: 1 },
                { id: second.id, revision: 1 },
            ],
            content: "config.ts sets cache_ttl=5m and connect_timeout=5s.",
        });
        const decision = listMemoryHistory(f.db, {
            projectPath: f.projectPath,
            memoryId: second.id,
        }).decisions[0]!;
        expect(decision.rows).toHaveLength(3);
        const later = edit(
            f,
            receipt.memoryId!,
            "later",
            "config.ts sets cache_ttl=20m and connect_timeout=5s.",
        );
        expect(
            previewMemoryRestore(f.db, { projectPath: f.projectPath, decisionKey: "merge" }).reason,
        ).toBe("successor_changed");
        const laterPreview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: later.decisionKey!,
        });
        expect(
            applyMemoryRestore(f.db, {
                projectPath: f.projectPath,
                decisionKey: later.decisionKey!,
                operationId: "undo-later",
                expectedRevisions: laterPreview.expectedRevisions,
            }).state,
        ).toBe("applied");
        const preview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: "merge",
        });
        expect(
            applyMemoryRestore(f.db, {
                projectPath: f.projectPath,
                decisionKey: "merge",
                operationId: "undo-merge",
                expectedRevisions: preview.expectedRevisions,
            }).state,
        ).toBe("applied");
        expect(memoryHistorySnapshot(f.db, first.id)?.supersededByMemoryId).toBeNull();
        expect(memoryHistorySnapshot(f.db, second.id)?.status).toBe("active");
        expect(memoryHistorySnapshot(f.db, receipt.memoryId!)?.status).toBe("archived");
        expect(
            f.db
                .prepare("SELECT COUNT(*) n FROM memory_successor_links WHERE decision_key='merge'")
                .get(),
        ).toEqual({ n: 0 });
    } finally {
        f.close();
    }
});

for (const format of ["sql", "memory"] as const)
    test(`history normalizes complete legacy ${format} snapshot pairs`, () => {
        const f = fixture();
        try {
            const row = f.add();
            const before =
                format === "sql"
                    ? f.db.prepare("SELECT * FROM memories WHERE id=?").get(row.id)
                    : getMemoryById(f.db, row.id);
            const receipt = edit(f, row.id, "legacy", "config.ts uses cache_ttl=10m.");
            const after =
                format === "sql"
                    ? f.db.prepare("SELECT * FROM memories WHERE id=?").get(row.id)
                    : getMemoryById(f.db, row.id);
            f.db
                .prepare(
                    "UPDATE memory_history SET before_json=?,after_json=? WHERE decision_key=?",
                )
                .run(JSON.stringify(before), JSON.stringify(after), receipt.decisionKey!);
            f.db
                .prepare(
                    "UPDATE memory_journal SET before_json=NULL,after_json=NULL WHERE decision_key=?",
                )
                .run(receipt.decisionKey!);
            const decision = listMemoryHistory(f.db, { projectPath: f.projectPath }).decisions[0]!;
            expect(decision.restorable).toBe(true);
            expect(decision.rows[0]?.before?.content).toBe(row.content);
            const preview = previewMemoryRestore(f.db, {
                projectPath: f.projectPath,
                decisionKey: receipt.decisionKey!,
            });
            expect(
                applyMemoryRestore(f.db, {
                    projectPath: f.projectPath,
                    decisionKey: receipt.decisionKey!,
                    operationId: "undo",
                    expectedRevisions: preview.expectedRevisions,
                }).state,
            ).toBe("applied");
        } finally {
            f.close();
        }
    });

test("history restore clears derived data and never resurrects historical sharing grants", () => {
    const f = fixture();
    try {
        const row = f.add();
        f.db.prepare("UPDATE memories SET shareable=1,classified_at=42 WHERE id=?").run(row.id);
        const change = edit(f, row.id, "edit", "config.ts uses cache_ttl=10m.");
        // A later classifier may grant sharing for the corrected text, not the text being restored.
        f.db.prepare("UPDATE memories SET shareable=1,classified_at=77 WHERE id=?").run(row.id);
        f.db
            .prepare(
                "INSERT INTO memory_embeddings(memory_id,embedding,model_id) VALUES(?,X'010203','test')",
            )
            .run(row.id);
        const preview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: change.decisionKey!,
        });
        const restored = applyMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: change.decisionKey!,
            operationId: "restore",
            expectedRevisions: preview.expectedRevisions,
        });
        expect(restored.state).toBe("applied");
        expect(memoryHistorySnapshot(f.db, row.id)?.shareable).toBe(0);
        expect(f.db.prepare("SELECT classified_at FROM memories WHERE id=?").get(row.id)).toEqual({
            classified_at: null,
        });
        expect(
            f.db.prepare("SELECT COUNT(*) n FROM memory_embeddings WHERE memory_id=?").get(row.id),
        ).toEqual({ n: 0 });
    } finally {
        f.close();
    }
});

test("history authority refusal does not become a local SQL fallback", async () => {
    const f = fixture();
    try {
        const row = f.add();
        const change = edit(f, row.id, "edit", "config.ts uses cache_ttl=10m.");
        f.db
            .prepare(
                "INSERT INTO authority_managed(project_path,context_store_uuid,marked_at) VALUES(?,'history-test',0)",
            )
            .run(f.projectPath);
        const before = memoryHistorySnapshot(f.db, row.id);
        expect(
            applyMemoryRestore(f.db, {
                projectPath: f.projectPath,
                decisionKey: change.decisionKey!,
                operationId: "restore",
                expectedRevisions: [{ memoryId: row.id, revision: 2 }],
            }).reason,
        ).toBe("authority_unavailable");
        await expect(
            memoryHistoryRpc({ db: f.db }, "memory.restore", {
                projectPath: f.projectPath,
                decisionKey: change.decisionKey!,
                operationId: "module",
                expectedRevisions: [{ memoryId: row.id, revision: 2 }],
            }),
        ).rejects.toThrow("authority_unavailable");
        expect(memoryHistorySnapshot(f.db, row.id)).toEqual(before);
    } finally {
        f.close();
    }
});

test("history cursor binds its filter and never splits a multi-row decision", () => {
    const f = fixture();
    try {
        const row = f.add();
        for (let index = 0; index < 3; index++)
            edit(f, row.id, `edit-${index}`, `config.ts uses cache_ttl=${index + 10}m.`);
        const first = listMemoryHistory(f.db, { projectPath: f.projectPath, limit: 1 });
        expect(first.decisions).toHaveLength(1);
        expect(first.nextCursor).not.toBeNull();
        expect(
            listMemoryHistory(f.db, {
                projectPath: f.projectPath,
                limit: 1,
                cursor: first.nextCursor!,
            }).decisions[0]?.decisionKey,
        ).not.toBe(first.decisions[0]?.decisionKey);
        expect(() =>
            listMemoryHistory(f.db, { projectPath: "git:other", cursor: first.nextCursor! }),
        ).toThrow("invalid_request");
        expect(
            normalizeMemoryHistorySnapshot({
                version: 99,
                snapshot: memoryHistorySnapshot(f.db, row.id),
            }),
        ).toBeNull();
    } finally {
        f.close();
    }
});

test("history incomplete decisions remain readable but cannot authorize restoration", () => {
    const f = fixture();
    try {
        const row = f.add();
        const editReceipt = edit(f, row.id, "partial", "config.ts uses cache_ttl=10m.");
        f.db
            .prepare(
                "UPDATE memory_journal SET before_json=NULL,after_json=NULL WHERE decision_key=?",
            )
            .run(editReceipt.decisionKey!);
        f.db
            .prepare("UPDATE memory_history SET after_json=NULL WHERE decision_key=?")
            .run(editReceipt.decisionKey!);
        const page = listMemoryHistory(f.db, { projectPath: f.projectPath });
        expect(page.decisions).toHaveLength(1);
        expect(page.decisions[0]?.restorable).toBe(false);
        const before = memoryHistorySnapshot(f.db, row.id);
        const receipt = applyMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: editReceipt.decisionKey!,
            operationId: "partial-undo",
            expectedRevisions: [{ memoryId: row.id, revision: 2 }],
        });
        expect(receipt.state).toBe("refused");
        expect(receipt.reason).toBe("incomplete_decision");
        expect(memoryHistorySnapshot(f.db, row.id)).toEqual(before);
    } finally {
        f.close();
    }
});

test("history project ownership is checked transactionally for every bulk participant", () => {
    const f = fixture();
    try {
        const first = f.add();
        const foreign = insertMemory(f.db, {
            projectPath: "git:foreign",
            category: "CONFIG_VALUES",
            content: "foreign project value",
        });
        const before = memoryHistorySnapshot(f.db, first.id);
        const receipt = applyDashboardMemoryEdit(f.db, {
            projectPath: f.projectPath,
            operationId: "foreign-bulk",
            expectedRevisions: [
                { memoryId: first.id, revision: 1 },
                { memoryId: foreign.id, revision: 1 },
            ],
            changes: [
                { memoryId: first.id, status: "archived" },
                { memoryId: foreign.id, status: "archived" },
            ],
        });
        expect(receipt.state).toBe("refused");
        expect(receipt.reason).toBe("target_not_owned");
        expect(memoryHistorySnapshot(f.db, first.id)).toEqual(before);
        expect(memoryHistorySnapshot(f.db, foreign.id)?.status).toBe("active");
    } finally {
        f.close();
    }
});

test("history restore operation IDs cannot be reused across edit and restore kinds", () => {
    const f = fixture();
    try {
        const row = f.add();
        const changed = edit(f, row.id, "same-operation", "config.ts uses cache_ttl=10m.");
        const receipt = applyMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: changed.decisionKey!,
            operationId: "same-operation",
            expectedRevisions: [{ memoryId: row.id, revision: 2 }],
        });
        expect(receipt.state).toBe("refused");
        expect(receipt.reason).toBe("operation_id_reused");
        expect(memoryHistorySnapshot(f.db, row.id)?.revision).toBe(2);
    } finally {
        f.close();
    }
});

test("history write methods reject mixed edit and restore payloads", () => {
    const f = fixture();
    try {
        const row = f.add();
        const request = {
            projectPath: f.projectPath,
            operationId: "mixed",
            expectedRevisions: [{ memoryId: row.id, revision: 1 }],
            changes: [{ memoryId: row.id, status: "archived" as const }],
            decisionKey: "other",
        };
        expect(() => applyDashboardMemoryEdit(f.db, request)).toThrow("invalid_request");
        expect(memoryHistorySnapshot(f.db, row.id)?.revision).toBe(1);
    } finally {
        f.close();
    }
});

test("history merge link guard rejects relationships changed by another decision", () => {
    const f = fixture();
    try {
        const first = f.add();
        const second = f.add("config.ts sets another timeout.");
        applyCurateMemoryMutation(f.db, {
            key: "link-merge",
            projectPath: f.projectPath,
            sourceSessionId: "",
            operation: "merge",
            targets: [
                { id: first.id, revision: 1 },
                { id: second.id, revision: 1 },
            ],
            content: "config.ts sets cache_ttl=5m and another timeout.",
        });
        f.db
            .prepare("UPDATE memory_successor_links SET decision_key='unrelated' WHERE source_id=?")
            .run(first.id);
        expect(
            previewMemoryRestore(f.db, { projectPath: f.projectPath, decisionKey: "link-merge" })
                .reason,
        ).toBe("successor_changed");
        expect(memoryHistorySnapshot(f.db, first.id)?.status).toBe("archived");
    } finally {
        f.close();
    }
});

for (const operation of ["new", "conflict"] as const)
    for (const liveMatch of [false, true])
        test(`memory.restore RPC undoes ${operation} admission with liveMatch=${liveMatch}`, async () => {
            const f = fixture();
            try {
                const target = f.add("The conflicting old configuration.");
                const match = liveMatch ? f.add() : null;
                for (const row of [target, match])
                    if (row)
                        f.db
                            .prepare("INSERT INTO memory_clause_evidence VALUES(?,1,1,?,?)")
                            .run(
                                row.id,
                                lifecycleTextHash(row.content),
                                JSON.stringify({ original: row.id }),
                            );
                const before = match ? memoryHistorySnapshot(f.db, match.id)! : null;
                const input = {
                    projectPath: f.projectPath,
                    category: "CONFIG_VALUES" as const,
                    content: "config.ts uses cache_ttl=5m.",
                };
                const saved = applyMemoryAdmission(f.db, {
                    key: "admission",
                    operation,
                    input,
                    conflictTargetId: target.id,
                });
                expect(saved.state).toBe("applied");
                if (match)
                    expect(
                        f.db
                            .prepare(
                                "SELECT evidence_json FROM memory_clause_evidence WHERE memory_id=? AND revision=2",
                            )
                            .all(match.id),
                    ).toEqual([{ evidence_json: JSON.stringify({ original: match.id }) }]);
                const decision = listMemoryHistory(f.db, { projectPath: f.projectPath })
                    .decisions[0]!;
                expect(decision).toMatchObject({ decisionKey: "admission", restorable: true });
                expect(decision.rows[0]?.before).toEqual(before);
                const preview = await memoryHistoryRpc({ db: f.db }, "memory.restore.preview", {
                    projectPath: f.projectPath,
                    decisionKey: "admission",
                });
                expect(preview.state).toBe("ready");
                const request = {
                    projectPath: f.projectPath,
                    decisionKey: "admission",
                    operationId: "undo-admission",
                    expectedRevisions: preview.expectedRevisions,
                };
                const restored = await memoryHistoryRpc({ db: f.db }, "memory.restore", request);
                expect(restored.state).toBe("applied");
                const current = memoryHistorySnapshot(f.db, saved.memoryId!)!;
                expect(current.status).toBe(liveMatch ? "active" : "archived");
                expect(current.revision).toBe(liveMatch ? 3 : 2);
                expect(current.seenCount).toBe(before?.seenCount ?? 1);
                if (match)
                    expect(
                        f.db
                            .prepare(
                                "SELECT evidence_json FROM memory_clause_evidence WHERE memory_id=? AND revision=3",
                            )
                            .all(match.id),
                    ).toEqual([{ evidence_json: JSON.stringify({ original: match.id }) }]);
                expect(memoryHistorySnapshot(f.db, target.id)?.revision).toBe(
                    operation === "conflict" ? 3 : 1,
                );
                expect(f.db.prepare("SELECT * FROM memory_conflict_links").all()).toEqual([]);
                expect(f.cache()).toEqual(f.cached);
                f.reopen();
                expect(await memoryHistoryRpc({ db: f.db }, "memory.restore", request)).toEqual(
                    restored,
                );
                expect(memoryHistorySnapshot(f.db, saved.memoryId!)!.revision).toBe(
                    current.revision,
                );
            } finally {
                f.close();
            }
        });

async function historianOperation(
    f: ReturnType<typeof fixture>,
    action: RevisionDecision["action"],
) {
    const first = f.add("Old rule.");
    const sources = [first];
    if (action === "merge") sources.push(f.add("Other rule."));
    for (const [index, source] of sources.entries()) {
        f.db
            .prepare(
                "UPDATE memories SET status='permanent',metadata_json=?,safety_critical=?,importance=90 WHERE id=?",
            )
            .run(JSON.stringify({ original: index }), index === 0 ? 1 : 0, source.id);
        f.db
            .prepare("INSERT INTO memory_clause_evidence VALUES(?,1,1,?,?)")
            .run(
                source.id,
                lifecycleTextHash(source.content),
                JSON.stringify({ original: source.id }),
            );
    }
    const before = sources.map((source) => memoryHistorySnapshot(f.db, source.id)!);
    const evidence = { blockStartOrdinal: 42, excerpt: "New rule." };
    const authorization = authorizationFixture(
        {
            lane: "opencode-1",
            carrier: "hidden-completion",
            provider: "test",
            modelId: "undo",
            variant: null,
            temperature: 0,
            thinkingLevel: null,
        },
        "historian",
    );
    const profile = authorization.profile;
    const decision: RevisionDecision = {
        key: "historian-operation",
        action,
        projectPath: f.projectPath,
        expectedSources: before.map((row) => ({ id: row.id, revision: row.revision })),
        survivorId: first.id,
        finalText: "New rule.",
        changes: before.map((row) => ({
            memoryId: row.id,
            ordinal: 1,
            replacement: true,
            evidence,
        })),
        added: [{ text: "New rule.", evidence }],
    };
    const receipt = await applyHistorianRevision(
        f.db,
        decision,
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
                    parts: ["New rule."],
                    joinedText: "New rule.",
                },
            ],
            sources: before.map((row) => ({
                ...getMemoryById(f.db, row.id)!,
                revision: row.revision,
            })),
            historianProfile: profile,
            validatedProfiles: authorization.rows,
        },
        { sessionId: "undo", harness: "opencode" },
        async (request) => ({
            profile: authorization.checkProfile(request.systemHash),
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
    expect(receipt.state).toBe("applied");
    return { before, receipt, decision };
}

for (const action of ["edit", "merge", "replaces"] as const)
    test(`memory.restore RPC reverses historian ${action} as one unit and keeps old decisions stale`, async () => {
        const f = fixture();
        try {
            const { before, receipt, decision } = await historianOperation(f, action);
            const preview = previewMemoryRestore(f.db, {
                projectPath: f.projectPath,
                decisionKey: decision.key,
            });
            expect(preview.state).toBe("ready");
            const request = {
                projectPath: f.projectPath,
                decisionKey: decision.key,
                operationId: "undo",
                expectedRevisions: preview.expectedRevisions,
            };
            const restored = await memoryHistoryRpc({ db: f.db }, "memory.restore", request);
            expect(restored.state).toBe("applied");
            for (const original of before) {
                const current = memoryHistorySnapshot(f.db, original.id)!;
                for (const field of [
                    "content",
                    "status",
                    "supersededByMemoryId",
                    "mergedFrom",
                    "metadataJson",
                    "safetyCritical",
                    "importance",
                    "sourceType",
                    "sourceSessionId",
                ] as const)
                    expect(current[field]).toEqual(original[field]);
                expect(current.revision).toBe(3);
                expect(
                    f.db
                        .prepare(
                            "SELECT evidence_json FROM memory_clause_evidence WHERE memory_id=? AND revision=?",
                        )
                        .all(original.id, current.revision),
                ).toEqual([{ evidence_json: JSON.stringify({ original: original.id }) }]);
            }
            expect(f.db.prepare("SELECT * FROM memory_successor_links").all()).toEqual([]);
            expect(f.cache()).toEqual(f.cached);
            if (action === "replaces") {
                expect(memoryHistorySnapshot(f.db, receipt.memoryId!)?.status).toBe("archived");
                expect(memoryHistorySnapshot(f.db, receipt.memoryId!)?.revision).toBe(2);
            }
            const unchanged = f.db.prepare("SELECT * FROM memories ORDER BY id").all();
            const stale = applyCurateMemoryMutation(f.db, {
                key: "pre-operation-decision",
                projectPath: f.projectPath,
                sourceSessionId: "",
                operation: "update",
                targets: [{ id: before[0]!.id, revision: 1 }],
                content: "Stale rule.",
            });
            expect(stale.reason).toBe("stale_revision");
            expect(f.db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(unchanged);
            expect(await memoryHistoryRpc({ db: f.db }, "memory.restore", request)).toEqual(
                restored,
            );
        } finally {
            f.close();
        }
    });

function auditedState(db: Database) {
    return Object.fromEntries(
        [
            "memories",
            "memory_history",
            "memory_journal",
            "memory_decision_receipts",
            "memory_successor_links",
            "memory_conflict_links",
            "memory_clause_evidence",
            "memory_mutation_log",
            "project_state",
        ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    );
}

test("memory.restore RPC rolls back every row, link, evidence and receipt on an injected failure", async () => {
    const f = fixture();
    try {
        const { decision } = await historianOperation(f, "merge");
        const preview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: decision.key,
        });
        const request = {
            projectPath: f.projectPath,
            decisionKey: decision.key,
            operationId: "rollback",
            expectedRevisions: preview.expectedRevisions,
        };
        const before = auditedState(f.db);
        f.db.exec(
            "CREATE TRIGGER fail_restore BEFORE INSERT ON memory_history BEGIN SELECT RAISE(ABORT, 'injected restore failure'); END",
        );
        await expect(memoryHistoryRpc({ db: f.db }, "memory.restore", request)).rejects.toThrow(
            "injected restore failure",
        );
        expect(auditedState(f.db)).toEqual(before);
        f.db.exec("DROP TRIGGER fail_restore");
        expect((await memoryHistoryRpc({ db: f.db }, "memory.restore", request)).state).toBe(
            "applied",
        );
    } finally {
        f.close();
    }
});

test("memory.restore RPC refuses a stale merge participant without partial writes", async () => {
    const f = fixture();
    try {
        const { before, decision } = await historianOperation(f, "merge");
        const preview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: decision.key,
        });
        f.db.prepare("UPDATE memories SET revision=revision+1 WHERE id=?").run(before[1]!.id);
        const unchanged = auditedState(f.db);
        const receipt = await memoryHistoryRpc({ db: f.db }, "memory.restore", {
            projectPath: f.projectPath,
            decisionKey: decision.key,
            operationId: "stale-merge",
            expectedRevisions: preview.expectedRevisions,
        });
        expect(receipt).toMatchObject({ state: "conflict", reason: "stale_revision" });
        // A refused operation may persist its receipt, but cannot change any canonical or history row.
        const after = auditedState(f.db);
        after.memory_decision_receipts = unchanged.memory_decision_receipts;
        expect(after).toEqual(unchanged);
    } finally {
        f.close();
    }
});

test("memory.restore RPC refuses a changed conflict endpoint without archiving the admission", async () => {
    const f = fixture();
    try {
        const target = f.add();
        const admission = applyMemoryAdmission(f.db, {
            key: "conflict",
            operation: "conflict",
            conflictTargetId: target.id,
            input: {
                projectPath: f.projectPath,
                category: "CONFIG_VALUES",
                content: "A contradictory configuration.",
            },
        });
        const preview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: "conflict",
        });
        edit(f, target.id, "changed-target", "The old configuration has changed.");
        const before = auditedState(f.db);
        const receipt = await memoryHistoryRpc({ db: f.db }, "memory.restore", {
            projectPath: f.projectPath,
            decisionKey: "conflict",
            operationId: "stale-conflict",
            expectedRevisions: preview.expectedRevisions,
        });
        expect(receipt).toMatchObject({ state: "conflict", reason: "stale_revision" });
        const after = auditedState(f.db);
        after.memory_decision_receipts = before.memory_decision_receipts;
        expect(after).toEqual(before);
        expect(memoryHistorySnapshot(f.db, admission.memoryId!)?.status).toBe("active");
    } finally {
        f.close();
    }
});

test("admission removal and recreation never reuse a revision", async () => {
    const f = fixture();
    try {
        const admitted = applyMemoryAdmission(f.db, {
            key: "new",
            operation: "new",
            input: {
                projectPath: f.projectPath,
                category: "CONFIG_VALUES",
                content: "A newly admitted rule.",
            },
        });
        const undo = await memoryHistoryRpc({ db: f.db }, "memory.restore", {
            projectPath: f.projectPath,
            decisionKey: "new",
            operationId: "remove",
            expectedRevisions: [{ memoryId: admitted.memoryId!, revision: 1 }],
        });
        expect(undo.state).toBe("applied");
        expect(memoryHistorySnapshot(f.db, admitted.memoryId!)?.status).toBe("archived");
        expect(memoryHistorySnapshot(f.db, admitted.memoryId!)?.revision).toBe(2);
        const recreated = await memoryHistoryRpc({ db: f.db }, "memory.restore", {
            projectPath: f.projectPath,
            decisionKey: undo.restoredDecisionKey as string,
            operationId: "recreate",
            expectedRevisions: [{ memoryId: admitted.memoryId!, revision: 2 }],
        });
        expect(recreated.state).toBe("applied");
        expect(memoryHistorySnapshot(f.db, admitted.memoryId!)?.status).toBe("active");
        expect(memoryHistorySnapshot(f.db, admitted.memoryId!)?.revision).toBe(3);
        const stale = applyCurateMemoryMutation(f.db, {
            key: "captured-before-removal",
            projectPath: f.projectPath,
            sourceSessionId: "",
            operation: "update",
            targets: [{ id: admitted.memoryId!, revision: 1 }],
            content: "Stale text.",
        });
        expect(stale.reason).toBe("stale_revision");
    } finally {
        f.close();
    }
});
