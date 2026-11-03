/**
 * Tests for the turn-one publication record: rollback with the compartment
 * transaction, publication reuse, commit order across processes, which printed lines
 * count as sent, and the TypeScript side of the shared anchor fuzz corpus. Each test
 * named "review witness" reproduces one fixed defect, named in the test, so it cannot
 * return: a send left `dispatched` after a later attempt published, and an
 * uncommitted publication left behind by session deletion
 * (.cortexkit/internal-docs/investigations/reports/memory-s5-review.md).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "../../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { deleteSessionScopedRows } from "../storage-session-tables";
import {
    allocateTurnOneSend,
    blocksSentToHistorian,
    commitTurnOnePublication,
    type TurnOneSend,
} from "./turn-one-publication";

const PROJECT = "git:turn-one-review";

function store(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function allocate(db: Database, sessionId: string, harness = "opencode"): TurnOneSend {
    return allocateTurnOneSend(db, {
        projectPath: PROJECT,
        sessionId,
        harness,
        carrier: "opencode-session",
        lane: "dormant",
        chunkStart: 1,
        chunkEnd: 9,
    });
}

function commit(
    db: Database,
    send: TurnOneSend,
    sessionId: string,
    facts: Array<{ category: string; content: string }> = [],
) {
    return commitTurnOnePublication(db, {
        send,
        projectPath: PROJECT,
        sessionId,
        compartments: [
            { id: 7, startMessage: 1, endMessage: 4, replyStartMessage: 1, replyEndMessage: 4 },
        ],
        blocks: [],
        candidateFacts: facts,
        honourAnchors: false,
    });
}

function count(db: Database, sql: string, ...params: unknown[]): number {
    return (db.prepare(sql).get(...(params as [])) as { n: number }).n;
}

describe("turn-one publication review", () => {
    test("candidates commit and roll back with the publication; a later commit writes each fact once", () => {
        const db = store();
        try {
            db.prepare(
                "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, 'module-store', 1)",
            ).run(PROJECT);
            const memoriesBefore = count(db, "SELECT COUNT(*) AS n FROM memories");
            const facts = [
                { category: "CONSTRAINTS", content: "Uploads are capped at 64 KiB." },
                { category: "NAMING", content: "The gateway is called edge." },
            ];
            const send = allocate(db, "ses-a");
            // A failure later in the compartment transaction rolls the commit back.
            expect(() =>
                db
                    .transaction(() => {
                        commit(db, send, "ses-a", facts);
                        throw new Error("publish failed after the publication commit");
                    })
                    .immediate(),
            ).toThrow(/publish failed/);
            expect(count(db, "SELECT COUNT(*) AS n FROM memory_pending_facts")).toBe(0);
            expect(count(db, "SELECT COUNT(*) AS n FROM memory_activity_ledger")).toBe(0);
            expect(
                count(
                    db,
                    "SELECT COUNT(*) AS n FROM memory_publications WHERE commit_order IS NULL",
                ),
            ).toBe(1);

            const retry = allocate(db, "ses-a");
            expect(retry.publicationId).toBe(send.publicationId);
            db.transaction(() => commit(db, retry, "ses-a", facts)).immediate();
            expect(
                db
                    .prepare(
                        "SELECT content, state, reason, fact_attempts FROM memory_pending_facts ORDER BY fact_index",
                    )
                    .all(),
            ).toEqual(
                facts.map((fact) => ({
                    content: fact.content,
                    state: "retryable",
                    reason: "authority_elsewhere",
                    fact_attempts: 0,
                })),
            );
            expect(count(db, "SELECT COUNT(*) AS n FROM memories")).toBe(memoriesBefore);
        } finally {
            db.close();
        }
    });

    test("an uncommitted publication is reused only by the same session and harness", () => {
        const db = store();
        try {
            const opencode = allocate(db, "ses-shared", "opencode");
            // A Pi run on the same session id must not take over the OpenCode send's
            // publication: whichever committed second would fail its whole publish.
            const pi = allocate(db, "ses-shared", "pi");
            expect(pi.publicationId).not.toBe(opencode.publicationId);
            expect(allocate(db, "ses-shared", "opencode").publicationId).toBe(
                opencode.publicationId,
            );
            expect(allocate(db, "ses-shared", "pi").publicationId).toBe(pi.publicationId);
        } finally {
            db.close();
        }
    });

    test("OpenCode and Pi processes publishing on one session id keep commit order unique and each publication committed once", async () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "turn-one-two-process-"));
        try {
            const path = join(dir, "context.db");
            const setup = new Database(path);
            initializeDatabase(setup);
            setup.exec("PRAGMA journal_mode=WAL");
            setup.close();
            const moduleUrl = resolve(import.meta.dir, "turn-one-publication.ts");
            const sqliteUrl = resolve(import.meta.dir, "../../../shared/sqlite.ts");
            const worker = join(dir, "worker.ts");
            // Each worker allocates a send, sometimes "crashes" before committing (the
            // next round reuses the publication), and otherwise commits it inside an
            // immediate transaction, as the runners do.
            writeFileSync(
                worker,
                `import { Database } from ${JSON.stringify(sqliteUrl)};
import { allocateTurnOneSend, commitTurnOnePublication } from ${JSON.stringify(moduleUrl)};
const [path, harness, rounds] = process.argv.slice(2);
const db = new Database(path);
db.exec("PRAGMA busy_timeout=20000");
let committed = 0;
for (let round = 0; round < Number(rounds); round += 1) {
    const send = allocateTurnOneSend(db, { projectPath: "git:turn-one-review", sessionId: "ses-shared", harness, carrier: harness, lane: "dormant", chunkStart: round, chunkEnd: round + 3 });
    if (round % 3 === 1) continue;
    db.transaction(() => commitTurnOnePublication(db, { send, projectPath: "git:turn-one-review", sessionId: "ses-shared", compartments: [{ id: 100000 + round * 10 + (harness === "pi" ? 1 : 0), startMessage: round, endMessage: round + 3, replyStartMessage: round, replyEndMessage: round + 3 }], blocks: [], candidateFacts: [{ category: "CONSTRAINTS", content: harness + " fact " + round }], honourAnchors: false })).immediate();
    committed += 1;
}
db.close();
console.log("committed " + committed);
`,
            );
            const rounds = 40;
            const children = ["opencode", "pi"].map((harness) =>
                Bun.spawn([process.execPath, worker, path, harness, String(rounds)], {
                    stdout: "pipe",
                    stderr: "pipe",
                    windowsHide: true,
                }),
            );
            const results = await Promise.all(
                children.map(async (child) => ({
                    code: await child.exited,
                    out: await new Response(child.stdout).text(),
                    err: await new Response(child.stderr).text(),
                })),
            );
            for (const result of results) {
                expect(result.err).toBe("");
                expect(result.code).toBe(0);
            }
            const db = new Database(path);
            try {
                const orders = (
                    db
                        .prepare(
                            "SELECT commit_order FROM memory_publications WHERE commit_order IS NOT NULL ORDER BY commit_order",
                        )
                        .all() as Array<{ commit_order: number }>
                ).map((row) => row.commit_order);
                const perHarness = Array.from({ length: rounds }, (_, round) => round).filter(
                    (round) => round % 3 !== 1,
                ).length;
                expect(orders).toEqual(Array.from({ length: perHarness * 2 }, (_, at) => at + 1));
                // Every committed publication has exactly one published send, and its
                // sends all come from one harness.
                expect(
                    db
                        .prepare(
                            `SELECT p.publication_id FROM memory_publications p
                             WHERE p.commit_order IS NOT NULL AND (
                               (SELECT COUNT(*) FROM memory_stage_attempts s WHERE s.publication_id=p.publication_id AND s.state='published') != 1
                               OR (SELECT COUNT(DISTINCT harness) FROM memory_stage_attempts s WHERE s.publication_id=p.publication_id) != 1)`,
                        )
                        .all(),
                ).toEqual([]);
                expect(count(db, "SELECT COUNT(*) AS n FROM memory_pending_facts")).toBe(
                    perHarness * 2,
                );
                // At most one uncommitted publication per harness is left behind.
                expect(
                    count(
                        db,
                        "SELECT COUNT(*) AS n FROM memory_publications WHERE commit_order IS NULL",
                    ),
                ).toBeLessThanOrEqual(2);
            } finally {
                db.close();
            }
        } finally {
            cleanupTestTempDir(dir);
        }
    }, 60_000);

    test("only blocks whose complete line precedes the cut reach the historian", () => {
        const text = "[1] U: alpha\n[2] A: beta\n[3] U: gamma";
        const blocks = [
            { id: 1, textEnd: 12 },
            { id: 2, textEnd: 24 },
            { id: 3, textEnd: 36 },
        ];
        const marker = "\n[… tokens truncated by Magic Context to fit the historian window …]";
        // Cut inside the second line: its prefix matches but the line is incomplete.
        expect(
            blocksSentToHistorian(blocks, text, `${text.slice(0, 20)}${marker}`).map(
                (block) => block.id,
            ),
        ).toEqual([1]);
        // Cut exactly at the end of the second line: the marker's "\n[" also matches
        // the start of the third line, which must still be excluded.
        expect(
            blocksSentToHistorian(blocks, text, `${text.slice(0, 24)}${marker}`).map(
                (block) => block.id,
            ),
        ).toEqual([1, 2]);
        // When the text sent no longer starts with the original source (here one extra
        // leading character), no block counts as sent.
        expect(blocksSentToHistorian(blocks, text, `X${text}`)).toEqual([]);
    });

    test("review witness: a session's deletion leaves no uncommitted publication behind", () => {
        const db = store();
        try {
            allocate(db, "ses-deleted");
            allocate(db, "ses-deleted");
            deleteSessionScopedRows(db, ["ses-deleted"]);
            expect(
                count(
                    db,
                    "SELECT COUNT(*) AS n FROM memory_stage_attempts WHERE session_id=?",
                    "ses-deleted",
                ),
            ).toBe(0);
            expect(
                count(
                    db,
                    "SELECT COUNT(*) AS n FROM memory_publications WHERE source_session_id=? AND commit_order IS NULL",
                    "ses-deleted",
                ),
            ).toBe(0);
        } finally {
            db.close();
        }
    });

    test("review witness: a send superseded by a later published attempt does not stay dispatched", () => {
        const db = store();
        try {
            for (let attempt = 0; attempt < 5; attempt += 1) allocate(db, "ses-retry");
            const send = allocate(db, "ses-retry");
            db.transaction(() => commit(db, send, "ses-retry")).immediate();
            expect(
                db
                    .prepare(
                        "SELECT run_attempt, state FROM memory_stage_attempts WHERE publication_id=? AND state='dispatched' ORDER BY run_attempt",
                    )
                    .all(send.publicationId),
            ).toEqual([]);
        } finally {
            db.close();
        }
    });
});

describe("turn-one anchor fuzz corpus shared with the Rust validator", () => {
    test("the committed corpus is what the TypeScript parser and resolver produce today", async () => {
        const generator = (await import(
            resolve(
                import.meta.dir,
                "../../../../test-fixtures/runtime/gen-turn-one-anchor-fuzz.ts",
            )
        )) as {
            generateCorpus: () => Promise<unknown>;
            CORPUS_PATH: string;
        };
        const committed = JSON.parse(readFileSync(generator.CORPUS_PATH, "utf8"));
        expect(await generator.generateCorpus()).toEqual(committed);
    });
});
