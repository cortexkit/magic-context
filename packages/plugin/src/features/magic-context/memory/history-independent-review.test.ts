import { expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { createTestTempDir } from "../../../shared/test-temp-dir";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { getProjectEmbeddings, resetEmbeddingCacheForTests } from "./embedding-cache";
import {
    applyDashboardMemoryEdit,
    applyMemoryRestore,
    listMemoryHistory,
    memoryHistorySnapshot,
    previewMemoryRestore,
} from "./history-applier";
import type { MemoryEditRequest } from "./history-contract";
import { memoryHistoryRpc } from "./history-rpc";
import { applyCurateMemoryMutation } from "./lifecycle-applier";
import { insertMemory } from "./storage-memory";
import { saveEmbedding } from "./storage-memory-embeddings";

function fixture(projectPath = "git:independent-review") {
    const { dir, cleanup } = createTestTempDir("independent-history-review-");
    const path = join(dir, "context.db");
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    const row = insertMemory(db, {
        projectPath,
        category: "CONFIG_VALUES",
        content: "Original config rule.",
    });
    const request = (
        operationId: string,
        revision: number,
        content: string,
    ): MemoryEditRequest => ({
        projectPath,
        operationId,
        expectedRevisions: [{ memoryId: row.id, revision }],
        changes: [{ memoryId: row.id, content }],
    });
    return {
        db,
        path,
        dir,
        projectPath,
        row,
        request,
        close() {
            db.close();
            cleanup();
        },
    };
}

test("review undo refuses a newer singleton revision even after preview refresh", () => {
    const f = fixture();
    try {
        const first = applyDashboardMemoryEdit(
            f.db,
            f.request("first", 1, "First correction."),
            1000,
        );
        expect(first.state).toBe("applied");
        const later = applyDashboardMemoryEdit(
            f.db,
            f.request("later", 2, "Later independent correction."),
            2000,
        );
        expect(later.state).toBe("applied");
        const preview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: first.decisionKey!,
        });
        const before = memoryHistorySnapshot(f.db, f.row.id);
        const undo = applyMemoryRestore(
            f.db,
            {
                projectPath: f.projectPath,
                decisionKey: first.decisionKey!,
                operationId: "undo-first",
                expectedRevisions: preview.expectedRevisions,
            },
            3000,
        );
        expect(undo.state).toBe("conflict");
        expect(undo.reason).toBe("stale_revision");
        expect(memoryHistorySnapshot(f.db, f.row.id)).toEqual(before);
    } finally {
        f.close();
    }
});

test("review receipt insertion failure rolls back rows history and epoch atomically", () => {
    const f = fixture();
    try {
        const before = memoryHistorySnapshot(f.db, f.row.id);
        f.db.exec(
            "CREATE TRIGGER interrupt_receipt BEFORE INSERT ON memory_decision_receipts BEGIN SELECT RAISE(ABORT,'simulated crash before receipt'); END",
        );
        const request = f.request("interrupted", 1, "Correction before a lost receipt.");
        expect(() => applyDashboardMemoryEdit(f.db, request, 1000)).toThrow(
            "simulated crash before receipt",
        );
        expect(memoryHistorySnapshot(f.db, f.row.id)).toEqual(before);
        for (const table of [
            "memory_history",
            "memory_journal",
            "memory_decision_receipts",
            "project_state",
        ])
            expect(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
        f.db.exec("DROP TRIGGER interrupt_receipt");
        expect(applyDashboardMemoryEdit(f.db, request, 2000).state).toBe("applied");
        expect(memoryHistorySnapshot(f.db, f.row.id)?.revision).toBe(2);
    } finally {
        f.close();
    }
});

test("review SIGKILL between canonical writes and receipt leaves a retryable atomic rollback", () => {
    const f = fixture();
    try {
        const before = memoryHistorySnapshot(f.db, f.row.id);
        const request = f.request("killed-writer", 1, "An interrupted canonical correction.");
        const child = Bun.spawnSync(
            [
                "bun",
                "-e",
                `
            const { Database } = await import("./packages/plugin/src/shared/sqlite.ts");
            const { applyDashboardMemoryEdit } = await import("./packages/plugin/src/features/magic-context/memory/history-applier.ts");
            const db = new Database(process.env.REVIEW_CRASH_DB);
            const prepare = db.prepare.bind(db);
            db.prepare = (sql) => {
                const statement = prepare(sql);
                if (sql.startsWith("INSERT INTO memory_decision_receipts"))
                    statement.run = () => { process.kill(process.pid, "SIGKILL"); throw new Error("kill did not stop writer"); };
                return statement;
            };
            applyDashboardMemoryEdit(db, JSON.parse(process.env.REVIEW_CRASH_REQUEST), 1000);
            throw new Error("receipt interceptor was not reached");
        `,
            ],
            {
                windowsHide: true,
                cwd: new URL("../../../../../../", import.meta.url).pathname,
                env: {
                    ...process.env,
                    REVIEW_CRASH_DB: f.path,
                    REVIEW_CRASH_REQUEST: JSON.stringify(request),
                },
            },
        );
        expect(child.signalCode, child.stderr.toString()).toBe("SIGKILL");
        expect(memoryHistorySnapshot(f.db, f.row.id)).toEqual(before);
        for (const table of [
            "memory_history",
            "memory_journal",
            "memory_decision_receipts",
            "project_state",
        ])
            expect(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
        expect(applyDashboardMemoryEdit(f.db, request, 2000).state).toBe("applied");
        expect(memoryHistorySnapshot(f.db, f.row.id)?.revision).toBe(2);
    } finally {
        f.close();
    }
});

test.each([
    "git:independent-review",
    "pj-independent-review",
])("review dashboard epoch for %s advances exactly once per edit and not on replay or automation", (projectPath) => {
    const f = fixture(projectPath);
    try {
        const epoch = () =>
            (
                f.db
                    .prepare(
                        "SELECT project_memory_epoch n FROM project_state WHERE project_path=?",
                    )
                    .get(f.projectPath) as { n: number } | null
            )?.n ?? 0;
        expect(epoch()).toBe(0);
        const request = f.request("external", 1, "External correction.");
        const applied = applyDashboardMemoryEdit(f.db, request, 1000);
        expect(applied.state).toBe("applied");
        expect(epoch()).toBe(1);
        expect(applyDashboardMemoryEdit(f.db, request, 2000)).toEqual(applied);
        expect(epoch()).toBe(1);
        const automation = applyCurateMemoryMutation(f.db, {
            key: "automation",
            projectPath: f.projectPath,
            sourceSessionId: "",
            operation: "update",
            targets: [{ id: f.row.id, revision: 2 }],
            content: "Automated correction.",
        });
        expect(automation.state).toBe("applied");
        expect(epoch()).toBe(1);
    } finally {
        f.close();
    }
});

test("review merge undo and redo retain one complete decision and reconcile links", () => {
    const f = fixture();
    try {
        const second = insertMemory(f.db, {
            projectPath: f.projectPath,
            category: "CONFIG_VALUES",
            content: "Second config rule.",
        });
        const merge = applyCurateMemoryMutation(f.db, {
            key: "merge",
            projectPath: f.projectPath,
            sourceSessionId: "",
            operation: "merge",
            targets: [
                { id: f.row.id, revision: 1 },
                { id: second.id, revision: 1 },
            ],
            content: "Combined config rules.",
        });
        expect(merge.state).toBe("applied");
        const undoPreview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: "merge",
        });
        expect(undoPreview.expectedRevisions).toHaveLength(3);
        const undo = applyMemoryRestore(
            f.db,
            {
                projectPath: f.projectPath,
                decisionKey: "merge",
                operationId: "undo",
                expectedRevisions: undoPreview.expectedRevisions,
            },
            2000,
        );
        expect(undo.state).toBe("applied");
        expect(f.db.prepare("SELECT COUNT(*) n FROM memory_successor_links").get()).toEqual({
            n: 0,
        });
        const redoPreview = previewMemoryRestore(f.db, {
            projectPath: f.projectPath,
            decisionKey: undo.restoredDecisionKey!,
        });
        const redo = applyMemoryRestore(
            f.db,
            {
                projectPath: f.projectPath,
                decisionKey: undo.restoredDecisionKey!,
                operationId: "redo",
                expectedRevisions: redoPreview.expectedRevisions,
            },
            3000,
        );
        expect(redo.state).toBe("applied");
        expect(f.db.prepare("SELECT COUNT(*) n FROM memory_successor_links").get()).toEqual({
            n: 2,
        });
        expect(memoryHistorySnapshot(f.db, merge.memoryId!)?.status).toBe("active");
        expect(memoryHistorySnapshot(f.db, f.row.id)?.supersededByMemoryId).toBe(merge.memoryId!);
    } finally {
        f.close();
    }
});

for (const method of ["memory.edit", "memory.restore"] as const)
    test(`review ${method} invalidates the warm semantic embedding cache`, async () => {
        const f = fixture();
        resetEmbeddingCacheForTests();
        try {
            const edited =
                method === "memory.restore"
                    ? applyDashboardMemoryEdit(
                          f.db,
                          f.request("before-undo", 1, "Changed meaning."),
                          1000,
                      )
                    : null;
            saveEmbedding(f.db, f.row.id, new Float32Array([1, 0]), "review:model");
            expect(getProjectEmbeddings(f.db, f.projectPath, "review:model").has(f.row.id)).toBe(
                true,
            );
            const request =
                method === "memory.edit"
                    ? f.request("external", 1, "Unrelated new meaning.")
                    : {
                          projectPath: f.projectPath,
                          decisionKey: edited!.decisionKey!,
                          operationId: "undo",
                          expectedRevisions: [{ memoryId: f.row.id, revision: 2 }],
                      };
            const receipt = await memoryHistoryRpc({ db: f.db }, method, {
                ...request,
            });
            expect(receipt.state).toBe("applied");
            expect(
                f.db
                    .prepare("SELECT COUNT(*) n FROM memory_embeddings WHERE memory_id=?")
                    .get(f.row.id),
            ).toEqual({ n: 0 });
            expect(getProjectEmbeddings(f.db, f.projectPath, "review:model").has(f.row.id)).toBe(
                false,
            );
        } finally {
            resetEmbeddingCacheForTests();
            f.close();
        }
    });

const binary = process.env.MC_MEMORY_HISTORY_PARITY_BIN;
for (const engine of ["TS", "Rust"] as const)
    (engine === "TS" || binary ? test : test.skip)(
        `review ${engine} refuses legacy Rust before-only history while keeping it readable`,
        () => {
            const f = fixture();
            try {
                const old = f.db
                    .prepare("SELECT * FROM memories WHERE id=?")
                    .get(f.row.id) as Record<string, unknown>;
                delete old.revision;
                const edit = applyDashboardMemoryEdit(
                    f.db,
                    f.request("legacy", 1, "A correction from an older writer."),
                    1000,
                );
                f.db
                    .prepare(
                        "UPDATE memory_history SET before_json=?,after_json=NULL WHERE decision_key=?",
                    )
                    .run(JSON.stringify(old), edit.decisionKey!);
                f.db
                    .prepare(
                        "UPDATE memory_journal SET before_json=NULL,after_json=NULL WHERE decision_key=?",
                    )
                    .run(edit.decisionKey!);
                const page = listMemoryHistory(f.db, { projectPath: f.projectPath });
                expect(page.decisions).toHaveLength(1);
                expect(page.decisions[0]?.restorable).toBe(false);
                const request = {
                    projectPath: f.projectPath,
                    decisionKey: edit.decisionKey!,
                    operationId: "undo-legacy",
                    expectedRevisions: [{ memoryId: f.row.id, revision: 2 }],
                };
                let receipt: ReturnType<typeof applyMemoryRestore>;
                if (engine === "TS") receipt = applyMemoryRestore(f.db, request, 2000);
                else {
                    const run = Bun.spawnSync([binary!], {
                        windowsHide: true,
                        stdin: Buffer.from(
                            JSON.stringify({ database: f.path, request, now: 2000 }),
                        ),
                    });
                    expect(run.exitCode, run.stderr.toString()).toBe(0);
                    receipt = JSON.parse(run.stdout.toString()).receipt;
                }
                expect(receipt.state).toBe("refused");
                expect(receipt.reason).toBe("incomplete_decision");
                expect(memoryHistorySnapshot(f.db, f.row.id)?.revision).toBe(2);
            } finally {
                f.close();
            }
        },
    );
(binary ? test : test.skip)(
    "review Rust undo refuses a newer singleton revision even after preview refresh",
    () => {
        const f = fixture();
        try {
            const first = applyDashboardMemoryEdit(
                f.db,
                f.request("first", 1, "First correction."),
                1000,
            );
            expect(
                applyDashboardMemoryEdit(
                    f.db,
                    f.request("later", 2, "Later independent correction."),
                    2000,
                ).state,
            ).toBe("applied");
            const request = {
                projectPath: f.projectPath,
                decisionKey: first.decisionKey!,
                operationId: "undo-first",
                expectedRevisions: [{ memoryId: f.row.id, revision: 3 }],
            };
            const run = Bun.spawnSync([binary!], {
                windowsHide: true,
                stdin: Buffer.from(JSON.stringify({ database: f.path, request, now: 3000 })),
            });
            expect(run.exitCode, run.stderr.toString()).toBe(0);
            const receipt = JSON.parse(run.stdout.toString()).receipt;
            expect(receipt.state).toBe("conflict");
            expect(receipt.reason).toBe("stale_revision");
            expect(memoryHistorySnapshot(f.db, f.row.id)?.content).toBe(
                "Later independent correction.",
            );
        } finally {
            f.close();
        }
    },
);
for (const [name, content] of [
    ["ordinary", '  A new rule with Σ and "quotes".  '],
    ["BOM whitespace", "\uFEFFA config rule.\uFEFF"],
    ["NEL non-whitespace", "\u0085A config rule.\u0085"],
    ["Unicode length", "é".repeat(10_001)],
] as const) {
    (binary ? test : test.skip)(
        `review independently compares persisted TS and Rust bytes for ${name}`,
        () => {
            const f = fixture();
            let rust: Database | undefined;
            try {
                const rustPath = join(f.dir, "rust.db");
                copyFileSync(f.path, rustPath);
                const request = f.request("parity", 1, content);
                const tsReceipt = applyDashboardMemoryEdit(f.db, request, 1000);
                expect(tsReceipt.state).toBe("applied");
                const run = Bun.spawnSync([binary!], {
                    windowsHide: true,
                    stdin: Buffer.from(JSON.stringify({ database: rustPath, request, now: 1000 })),
                });
                expect(run.exitCode, run.stderr.toString()).toBe(0);
                const rustReceipt = JSON.parse(run.stdout.toString()).receipt;
                expect(rustReceipt).toEqual(tsReceipt);
                rust = new Database(rustPath);
                // Read the actual persisted TEXT, without either writer's canonical serializer.
                for (const [table, columns] of [
                    ["memory_history", "before_json, after_json"],
                    ["memory_journal", "before_json, after_json, receipt_json"],
                    ["memory_decision_receipts", "receipt_json"],
                    ["memories", "content, normalized_hash, revision"],
                ])
                    expect(rust.prepare(`SELECT ${columns} FROM ${table}`).all()).toEqual(
                        f.db.prepare(`SELECT ${columns} FROM ${table}`).all(),
                    );
            } finally {
                rust?.close();
                f.close();
            }
        },
    );
}
