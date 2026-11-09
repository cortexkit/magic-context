import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DREAMER_AGENT } from "../agents/dreamer";
import { archiveExpiredMemories } from "../features/magic-context/dreamer/expire-memories";
import { acquireLeaseWithAcquisition } from "../features/magic-context/dreamer/lease";
import { applyVerifyManifest } from "../features/magic-context/dreamer/verify";
import {
    applyAgentMemoryMutation,
    applyMemoryAdmission,
    getMemoryRevision,
    recordAutomatedMemoryEdit,
} from "../features/magic-context/memory/lifecycle-applier";
import { computeNormalizedHash } from "../features/magic-context/memory/normalize-hash";
import { promoteSessionFactsDurable } from "../features/magic-context/memory/promotion";
import {
    getMemoryById,
    insertMemory,
    updateMemoryContent,
} from "../features/magic-context/memory/storage-memory";
import {
    allocateTurnOneSend,
    commitTurnOnePublication,
} from "../features/magic-context/memory/turn-one-publication";
import { runMigrations } from "../features/magic-context/migrations";
import { getOrCreateSessionMeta, queueMemoryMutation } from "../features/magic-context/storage";
import { initializeDatabase } from "../features/magic-context/storage-db";
import { bumpProjectMemoryEpoch } from "../features/magic-context/storage-project-state";
import { getVisibleMemoryIds } from "../hooks/magic-context/inject-compartments";
import { createCtxMemoryTools } from "../tools/ctx-memory/tools";
import { Database } from "./sqlite";
import { createTestTempDirFromPath } from "./test-temp-dir";

/**
 * Shared regressions for the memory projection of one session's prompt. OpenCode
 * and Pi register them with their own drivers, so both renderers are held to the
 * same contract:
 *   - only a HARD fold reads canonical memory rows or unscoped mutation logs;
 *   - a busting SOFT pass replays the fold's memory bytes and appends only this
 *     session's own agent fragments and dashboard payloads; a defer replays stored bytes;
 *   - automated writers and other sessions reach the prompt at its next HARD fold.
 */

/** Thrown when a gated pass reads memories or the mutation log (rows or heads). */
import {
    applyMemoryRestore,
    listMemoryHistory,
    normalizeMemoryHistorySnapshot,
    previewMemoryRestore,
} from "../features/magic-context/memory/history-applier";

/**
 * The gate blocks canonical memory rows and log heads, including MAX(id). Only
 * the exact immutable dashboard payload query is allowed during an authorized
 * SOFT; a defer permits neither table. Search is tested separately.
 */
export const MEMORY_LOADER_BLOCKED = "memory loader called on a gated pass";
export function isDashboardPayloadRead(sql: string): boolean {
    return (
        sql.replace(/\s+/g, " ").trim().toLowerCase() ===
        "select id, project_path, target_memory_id, mutation_type, superseded_by_id, category, new_content, operation_id from memory_mutation_log where id > ? and operation_id like 'dashboard:%' and (project_path = ? or target_memory_id in (select value from json_each(?))) order by id"
    );
}

function readsMemoryTables(sql: string): boolean {
    return /\b(?:FROM|JOIN)\s+(?:memories|memory_mutation_log)\b/i.test(sql);
}

export interface ProjectionFixture {
    db: Database;
    directory: string;
    projectPath: string;
    /** Two sessions of the same project. */
    sessions: readonly [string, string];
    /** A SOFT may read dashboard payloads, but never canonical rows or log heads. */
    gate: { blocking: boolean; allowDashboardPayloads: boolean; blocked: string[] };
    close: () => void;
}

/**
 * Every statement that loads memory or mutation-log rows is wrapped when it is
 * prepared, so statements a module caches per database are covered too. The
 * wrapper is installed before any memory code runs on this connection.
 */
function installLoaderGate(db: Database, gate: ProjectionFixture["gate"]): void {
    const prepare = db.prepare.bind(db);
    Object.defineProperty(db, "prepare", {
        configurable: true,
        writable: true,
        value: (sql: string) => {
            const statement = prepare(sql);
            if (!readsMemoryTables(sql)) return statement;
            for (const method of ["all", "get", "iterate", "values"] as const) {
                const original = (statement as unknown as Record<string, unknown>)[method];
                if (typeof original !== "function") continue;
                const bound = (original as (...args: unknown[]) => unknown).bind(statement);
                Object.defineProperty(statement, method, {
                    configurable: true,
                    value: (...args: unknown[]) => {
                        if (
                            gate.blocking &&
                            !(gate.allowDashboardPayloads && isDashboardPayloadRead(sql))
                        ) {
                            gate.blocked.push(sql);
                            throw new Error(`${MEMORY_LOADER_BLOCKED}: ${sql}`);
                        }
                        return bound(...args);
                    },
                });
            }
            return statement;
        },
    });
}

export function createProjectionFixture(
    label: string,
    open?: (path: string) => Database,
): ProjectionFixture {
    const directory = createTestTempDirFromPath(join(tmpdir(), `mc-memory-projection-${label}-`));
    const path = join(directory, "context.db");
    const db = open ? open(path) : new Database(path);
    if (!open) {
        initializeDatabase(db);
        runMigrations(db);
    }
    const gate = { blocking: false, allowDashboardPayloads: false, blocked: [] as string[] };
    installLoaderGate(db, gate);
    const sessions = [`${label}-a`, `${label}-b`] as const;
    for (const session of sessions) getOrCreateSessionMeta(db, session);
    return {
        db,
        directory,
        projectPath: "git:memory-projection",
        sessions,
        gate,
        close: () => {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        },
    };
}

export interface ProjectionOptions {
    memoryBudget?: number;
    historyBudget?: number;
    /**
     * Report a model switch on this pass: a genuine HARD trigger, since the new
     * model has its own provider cache. An expired provider cache is not one.
     */
    genuineHard?: boolean;
}

const modelGenerations = new WeakMap<ProjectionFixture, Map<string, number>>();

/**
 * The model key a driver reports for one session's pass. A `genuineHard` pass
 * switches the session to a new model, and later passes keep reporting it, so
 * the switch folds once, as a real switch does.
 */
export function projectionModelKey(
    f: ProjectionFixture,
    sessionId: string,
    render: ProjectionOptions = {},
): string {
    let sessions = modelGenerations.get(f);
    if (!sessions) {
        sessions = new Map();
        modelGenerations.set(f, sessions);
    }
    let generation = sessions.get(sessionId) ?? 0;
    if (render.genuineHard) sessions.set(sessionId, ++generation);
    return generation === 0 ? "anthropic/claude" : `anthropic/claude-${generation}`;
}

export interface ServedPair {
    m0: string;
    m1: string;
    /** Whether this pass folded a new m[0]. */
    materialized: boolean;
}

export interface ProjectionDriver {
    host: string;
    open?: (path: string) => Database;
    /** A forced HARD fold for one session (the first render, or a test-forced rebuild). */
    hard: (f: ProjectionFixture, sessionId: string, options?: ProjectionOptions) => void;
    /** One transform pass: busting (a SOFT unless a HARD trigger fires) or a defer. */
    pass: (
        f: ProjectionFixture,
        sessionId: string,
        busting: boolean,
        options?: ProjectionOptions,
    ) => ServedPair;
}

function memory(f: ProjectionFixture, content: string, importance = 50) {
    return insertMemory(f.db, {
        projectPath: f.projectPath,
        category: "ARCHITECTURE",
        content,
        importance,
    });
}

function agentSave(f: ProjectionFixture, sessionId: string, content: string): number {
    const receipt = applyMemoryAdmission(f.db, {
        key: `save:${sessionId}:${content}`,
        operation: "agent_save",
        input: {
            projectPath: f.projectPath,
            category: "ARCHITECTURE",
            content,
            sourceSessionId: sessionId,
            sourceType: "agent",
        },
    });
    expect(receipt.state).toBe("applied");
    return receipt.memoryId!;
}

function agentUpdate(f: ProjectionFixture, sessionId: string, id: number, content: string): void {
    const receipt = applyAgentMemoryMutation(f.db, {
        key: `update:${sessionId}:${id}:${content.length}:${content.slice(0, 24)}`,
        projectPath: f.projectPath,
        sourceSessionId: sessionId,
        operation: "update",
        targets: [{ id, revision: getMemoryRevision(f.db, id)! }],
        content,
    });
    expect(receipt.state).toBe("applied");
}

function agentMerge(f: ProjectionFixture, sessionId: string, ids: number[], content: string): void {
    const receipt = applyAgentMemoryMutation(f.db, {
        key: `merge:${sessionId}:${ids.join(",")}`,
        projectPath: f.projectPath,
        sourceSessionId: sessionId,
        operation: "merge",
        targets: ids.map((id) => ({ id, revision: getMemoryRevision(f.db, id)! })),
        content,
    });
    expect(receipt.state).toBe("applied");
}

/** A gated automated content correction (dreamer verify): row and history, no log row. */
function automatedEdit(f: ProjectionFixture, id: number, content: string): void {
    const before = getMemoryById(f.db, id)!;
    updateMemoryContent(f.db, id, content, computeNormalizedHash(content));
    recordAutomatedMemoryEdit(f.db, { writer: "verify", before, reason: "verify_update" });
}

/** Block row/head reads; callers testing a permitted delta refresh opt in with `allowDashboardPayloads`. */
function gated<T>(f: ProjectionFixture, body: () => T, allowDashboardPayloads = false): T {
    f.gate.blocking = true;
    f.gate.allowDashboardPayloads = allowDashboardPayloads;
    try {
        return body();
    } finally {
        f.gate.blocking = false;
        f.gate.allowDashboardPayloads = false;
    }
}

/** Tables only the historian's turn-one publication writes. */
const TURN_ONE_TABLES =
    /\b(?:memory_publications|memory_stage_attempts|memory_pending_facts|memory_fact_blocks|memory_fact_block_links|memory_activity_ledger)\b/i;

/** Record every statement prepared on `db` that names a turn-one table. */
function watchTurnOneTables(db: Database): string[] {
    const seen: string[] = [];
    const prepare = db.prepare.bind(db);
    Object.defineProperty(db, "prepare", {
        configurable: true,
        writable: true,
        value: (sql: string) => {
            if (TURN_ONE_TABLES.test(sql)) seen.push(sql);
            return prepare(sql);
        },
    });
    return seen;
}

/**
 * A historian publication on the dormant lane (the production default: the existing
 * turn-one prompt and promotion): one fact promoted through
 * `promoteSessionFactsDurable`, and, when `withTurnOne` is set, every row turn one
 * records around it. These are a
 * committed publication with its send record, an anchored candidate with its stored
 * block, an unknown-anchor candidate, an activity count, and an abandoned send for
 * the other session. Production writes candidates only when the Rust module owns the
 * project's memory; this fixture writes them anyway so their presence alone is what
 * is compared.
 */
function dormantPublish(f: ProjectionFixture, withTurnOne: boolean): void {
    const [a, b] = f.sessions;
    const promotion = f.db
        .transaction(() =>
            promoteSessionFactsDurable(f.db, a, f.projectPath, [
                { category: "CONSTRAINTS", content: "Promoted at the publish." },
            ]),
        )
        .immediate();
    expect(promotion.factsPromoted).toBe(1);
    if (!withTurnOne) return;
    const allocate = (sessionId: string) =>
        allocateTurnOneSend(f.db, {
            projectPath: f.projectPath,
            sessionId,
            harness: "opencode",
            carrier: "opencode-session",
            lane: "dormant",
            chunkStart: 1,
            chunkEnd: 4,
        });
    allocate(b);
    const send = allocate(a);
    f.db
        .transaction(() =>
            commitTurnOnePublication(f.db, {
                send,
                projectPath: f.projectPath,
                sessionId: a,
                compartments: [
                    {
                        id: 9001,
                        startMessage: 1,
                        endMessage: 4,
                        replyStartMessage: 1,
                        replyEndMessage: 4,
                    },
                ],
                blocks: [{ role: "U", startOrdinal: 1, endOrdinal: 2, parts: ["Cap is 64 KiB."] }],
                candidateFacts: [
                    {
                        category: "CONSTRAINTS",
                        content: "Anchored candidate recorded by turn one.",
                        anchor: { compartmentIndex: 1, startOrdinal: 1, endOrdinal: 2 },
                    },
                    {
                        category: "NAMING",
                        content: "Unknown-anchor candidate recorded by turn one.",
                    },
                ],
                honourAnchors: true,
            }),
        )
        .immediate();
}

/** The lines of the `<memory-updates>` block in an m[1] text. */
function updateLines(m1: string): string[] {
    const start = m1.indexOf("<memory-updates>\n");
    const end = m1.indexOf("\n</memory-updates>");
    return start < 0 || end < start ? [] : m1.slice(start, end).split("\n").slice(1);
}

export function registerMemoryProjectionRegressions(driver: ProjectionDriver): void {
    for (const operation of [
        "curate-update",
        "curate-merge",
        "curate-archive",
        "verify-archive",
        "verify-update",
        "expiry-archive",
    ] as const) {
        test(`${driver.host} ${operation} applies directly with undo history and waits for natural HARD`, async () => {
            const f = createProjectionFixture(`${driver.host}-${operation}`, driver.open);
            try {
                const [session] = f.sessions;
                const target = memory(f, "cache_ttl is 5 minutes in config.ts.");
                const second =
                    operation === "curate-merge"
                        ? memory(f, "config.ts declares a 5 minute cache_ttl.")
                        : null;
                const successor =
                    operation === "curate-archive"
                        ? memory(f, "config.ts now declares a longer cache_ttl.")
                        : null;
                const expiry = Date.now() + 60_000;
                if (operation === "expiry-archive")
                    f.db
                        .prepare("UPDATE memories SET expires_at=? WHERE id=?")
                        .run(expiry, target.id);
                driver.hard(f, session);
                const before = driver.pass(f, session, false);
                expect(before.m0 + before.m1).toContain(target.content);
                const leaseKey = `${operation}:${f.projectPath}`;
                const holderId = "automated-holder";
                const leaseAcquisition = acquireLeaseWithAcquisition(f.db, holderId, leaseKey)!;
                const corrected = "cache_ttl is 10 minutes in config.ts.";
                if (operation.startsWith("curate-")) {
                    const action = operation.slice(7) as "update" | "merge" | "archive";
                    const tools = createCtxMemoryTools({
                        db: f.db,
                        resolveProjectPath: () => f.projectPath,
                        memoryEnabled: true,
                        embeddingEnabled: false,
                    });
                    const result = await tools.ctx_memory!.execute(
                        {
                            action,
                            ids: second ? [target.id, second.id] : [target.id],
                            content: action === "archive" ? undefined : corrected,
                            superseded_by: successor?.id,
                            reason: "obsolete code fact",
                        },
                        {
                            sessionID: session,
                            agent: DREAMER_AGENT,
                            directory: f.directory,
                            worktree: f.directory,
                            abort: new AbortController().signal,
                            metadata: () => {},
                            ask: async () => {},
                        },
                    );
                    expect(result).toMatch(/^(Updated memory|Merged memories|Archived memor)/);
                } else if (operation.startsWith("verify-")) {
                    const verdict =
                        operation === "verify-archive"
                            ? `<archive id="${target.id}" reason="obsolete code fact"/>`
                            : `<update id="${target.id}" files="config.ts">${corrected}</update>`;
                    const result = await applyVerifyManifest(
                        {
                            db: f.db,
                            projectIdentity: f.projectPath,
                            parentSessionId: undefined,
                            sessionDirectory: f.directory,
                            holderId,
                            leaseKey,
                            leaseAcquisition,
                            deadline: Date.now() + 10_000,
                            normalizeFiles: async (files) => [...files],
                        },
                        [
                            {
                                id: target.id,
                                category: target.category,
                                content: target.content,
                                mappedFiles: ["config.ts"],
                            },
                        ],
                        `<verify>${verdict}</verify>`,
                    );
                    expect(operation === "verify-archive" ? result.archived : result.updated).toBe(
                        1,
                    );
                    expect(result.refused).toBe(0);
                } else {
                    expect(
                        await archiveExpiredMemories({
                            db: f.db,
                            projectIdentity: f.projectPath,
                            holderId,
                            leaseKey,
                            leaseAcquisition,
                            now: expiry + 1,
                        }),
                    ).toBe(1);
                }
                const history = f.db
                    .prepare(
                        "SELECT previous_text,before_json FROM memory_history WHERE memory_id=?",
                    )
                    .all(target.id) as { previous_text: string; before_json: string }[];
                expect(history).toHaveLength(1);
                expect(history[0]!.previous_text).toBe(target.content);
                expect(
                    normalizeMemoryHistorySnapshot(JSON.parse(history[0]!.before_json))?.status,
                ).toBe("active");
                if (second)
                    expect(
                        f.db
                            .prepare("SELECT previous_text FROM memory_history WHERE memory_id=?")
                            .get(second.id),
                    ).toEqual({ previous_text: second.content });
                for (const table of [
                    "memory_mutation_log",
                    "memory_agent_fragments",
                    "memory_tool_proposals",
                ])
                    expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({
                        n: 0,
                    });
                const current = getMemoryById(f.db, target.id)!;
                if (operation.endsWith("archive") || second)
                    expect(current.status).toBe("archived");
                else expect(current.content).toBe(corrected);
                expect(driver.pass(f, session, false)).toEqual(before);
                const soft = driver.pass(f, session, true);
                expect(soft.materialized).toBe(false);
                expect(soft.m0).toBe(before.m0);
                expect(soft.m1).toBe(before.m1);
                const hard = driver.pass(f, session, true, { genuineHard: true });
                expect(hard.materialized).toBe(true);
                expect(hard.m0 + hard.m1).not.toContain(target.content);
                if (!operation.endsWith("archive")) expect(hard.m0 + hard.m1).toContain(corrected);
                const decisions = listMemoryHistory(f.db, {
                    projectPath: f.projectPath,
                    memoryId: target.id,
                }).decisions;
                expect(decisions).toHaveLength(1);
                const preview = previewMemoryRestore(f.db, {
                    projectPath: f.projectPath,
                    decisionKey: decisions[0]!.decisionKey,
                });
                expect(preview.state).toBe("ready");
                const restored = applyMemoryRestore(f.db, {
                    projectPath: f.projectPath,
                    decisionKey: decisions[0]!.decisionKey,
                    operationId: `${operation}-undo`,
                    expectedRevisions: preview.expectedRevisions,
                });
                expect(restored.state).toBe("applied");
                expect(getMemoryById(f.db, target.id)?.content).toBe(target.content);
                expect(getMemoryById(f.db, target.id)?.status).toBe("active");
                if (second) expect(getMemoryById(f.db, second.id)?.status).toBe("active");
                // Audited undo queues a dashboard correction, not a baseline rebuild.
                const held = driver.pass(f, session, false);
                expect(held).toEqual({ ...hard, materialized: false });
                const admitted = driver.pass(f, session, true);
                expect(admitted.materialized).toBe(false);
                expect(admitted.m0).toBe(hard.m0);
                expect(admitted.m1).toContain(target.content);
                expect(driver.pass(f, session, false)).toEqual(admitted);
                const restoredHard = driver.pass(f, session, true, { genuineHard: true });
                expect(restoredHard.materialized).toBe(true);
                expect(restoredHard.m0).toContain(target.content);
                const epoch = f.db
                    .prepare(
                        "SELECT project_memory_epoch n FROM project_state WHERE project_path=?",
                    )
                    .get(f.projectPath);
                expect(epoch).toEqual({ n: 1 });
                expect(
                    applyMemoryRestore(f.db, {
                        projectPath: f.projectPath,
                        decisionKey: decisions[0]!.decisionKey,
                        operationId: `${operation}-undo`,
                        expectedRevisions: preview.expectedRevisions,
                    }),
                ).toEqual(restored);
                expect(
                    f.db
                        .prepare(
                            "SELECT project_memory_epoch n FROM project_state WHERE project_path=?",
                        )
                        .get(f.projectPath),
                ).toEqual({ n: 1 });
            } finally {
                f.close();
            }
        });
    }
    const create = (label: string) =>
        createProjectionFixture(`${driver.host}-${label}`, driver.open);

    // SOFT permits only immutable dashboard payloads; defer reads no memory/log
    // rows. The positive control proves that canonical HARD reads are blocked.
    test(`${driver.host} SOFT reads only dashboard payloads and defer reads no memory rows or log heads`, () => {
        const f = create("gate");
        try {
            const [a] = f.sessions;
            const baseline = memory(f, "Baseline memory served by the HARD fold.");
            driver.hard(f, a);
            const saved = agentSave(f, a, "Agent save shown on the next busting pass.");
            const elsewhere = memory(f, "Another writer's memory waits for HARD.");
            queueMemoryMutation(f.db, {
                projectPath: f.projectPath,
                mutationType: "archive",
                targetMemoryId: baseline.id,
            });
            const soft = gated(f, () => driver.pass(f, a, true), true);
            expect(soft.materialized).toBe(false);
            expect(soft.m1).toContain(
                `<added id="${saved}" category="ARCHITECTURE">Agent save shown on the next busting pass.</added>`,
            );
            expect(soft.m1).not.toContain(`id="${elsewhere.id}"`);
            expect(soft.m1).not.toContain(`<removed id="${baseline.id}"/>`);
            const defer = gated(f, () => driver.pass(f, a, false));
            expect(defer).toEqual({ ...soft, materialized: false });
            expect(f.gate.blocked).toEqual([]);
            // Positive control: the same gate stops a HARD fold, which must read rows.
            expect(() => gated(f, () => driver.hard(f, a))).toThrow(MEMORY_LOADER_BLOCKED);
            expect(f.gate.blocked.length).toBeGreaterThan(0);
        } finally {
            f.close();
        }
    });

    // Memories are project-wide but prompts are per session: one session's HARD
    // fold and agent edits never change another session's SOFT or defer bytes.
    test(`${driver.host} one session's HARD fold and agent edit leave another session's SOFT bytes unchanged`, () => {
        const f = create("two-session");
        try {
            const [a, b] = f.sessions;
            const shared = memory(f, "Shared rule, revision one.");
            const other = memory(f, "Another shared rule.");
            driver.hard(f, a);
            driver.hard(f, b);
            const bBefore = driver.pass(f, b, false);
            automatedEdit(f, shared.id, "Shared rule, revision two from verify.");
            agentUpdate(f, a, other.id, "Another shared rule, edited by session A.");
            driver.hard(f, a);
            const aAfter = driver.pass(f, a, false);
            expect(aAfter.m0).toContain("Shared rule, revision two from verify.");
            const bSoft = driver.pass(f, b, true);
            expect(bSoft.materialized).toBe(false);
            expect(bSoft.m0).toBe(bBefore.m0);
            expect(bSoft.m1).toBe(bBefore.m1);
            expect(bSoft.m1).not.toContain("edited by session A");
            expect(driver.pass(f, b, false)).toEqual(bSoft);
        } finally {
            f.close();
        }
    });

    // Agent fragments render inside their allowance. A fragment that does not fit
    // appends a short stale marker; fragments already shown never move or shrink,
    // so an over-allowance edit cannot revert an adopted correction.
    test(`${driver.host} an over-allowance agent edit appends a stale marker and keeps the shown correction`, () => {
        const f = create("overflow");
        try {
            const [a] = f.sessions;
            const target = memory(f, "TTL is five minutes.");
            const options = { memoryBudget: 400 };
            driver.hard(f, a, options);
            agentUpdate(f, a, target.id, "TTL is ten minutes.");
            const first = driver.pass(f, a, true, options);
            const shown = `<updated id="${target.id}" category="ARCHITECTURE">TTL is ten minutes.</updated>`;
            expect(first.m1).toContain(shown);
            agentUpdate(f, a, target.id, `TTL is fifteen minutes. ${"Long detail. ".repeat(200)}`);
            const second = driver.pass(f, a, true, options);
            expect(second.materialized).toBe(false);
            expect(second.m0).toBe(first.m0);
            expect(second.m1).toContain(shown);
            expect(second.m1).toContain(
                `<stale-memory ids="${target.id}" current="${target.id}" read-with="ctx_search"/>`,
            );
            expect(second.m1).not.toContain("fifteen minutes");
            expect(second.m1.indexOf(shown)).toBe(first.m1.indexOf(shown));
            expect(driver.pass(f, a, false, options)).toEqual(second);
        } finally {
            f.close();
        }
    });

    // Every agent edit that misses the allowance still leaves a visible trace. At the
    // smallest permitted memory budget, full fragments use the allowance, markers use
    // a fixed reserve, and once that is spent one aggregate line counts and lists the
    // rest. Shown fragments and markers never move or shrink as the line grows.
    test(`${driver.host} a full allowance still traces every rejected edit and never shrinks shown fragments`, () => {
        const f = create("overflow-trace");
        try {
            const [a] = f.sessions;
            const target = memory(f, "Marker baseline.");
            const options = { memoryBudget: 500 };
            driver.hard(f, a, options);
            let firstFull = "";
            let previous = "";
            for (let i = 0; i < 20; i++) {
                agentUpdate(f, a, target.id, `Adopted receipt ${i}.`);
                const served = driver.pass(f, a, true, options);
                expect(served.materialized).toBe(false);
                if (i === 0) {
                    expect(served.m1).toContain("Adopted receipt 0.");
                    firstFull = served.m1.slice(0, served.m1.indexOf("Adopted receipt 0."));
                }
                // Every shown line before the aggregate line is an unchanged prefix of
                // what the next pass serves.
                const shownBefore = updateLines(previous).filter(
                    (line) => !line.includes("<more-memory-edits"),
                );
                expect(updateLines(served.m1).slice(0, shownBefore.length)).toEqual(shownBefore);
                previous = served.m1;
            }
            const oversized = agentSave(f, a, "oversized ".repeat(500));
            const served = driver.pass(f, a, true, options);
            expect(served.materialized).toBe(false);
            expect(served.m1.startsWith(firstFull)).toBe(true);
            expect(served.m1).toContain("Adopted receipt 0.");
            expect(served.m1).toMatch(
                new RegExp(
                    `<stale-memory ids="${oversized}"|<more-memory-edits count="\\d+" ids="[^"]*\\b${oversized}\\b`,
                ),
            );
            expect(served.m1).toContain("<more-memory-edits");
            expect(driver.pass(f, a, false, options)).toEqual(served);
        } finally {
            f.close();
        }
    });

    // A merge into a survivor this session has never shown carries the survivor's text,
    // even when the merge leaves that text unchanged.
    test(`${driver.host} a merge into an unshown existing survivor shows the survivor text`, () => {
        const f = create("unshown-survivor");
        try {
            const [a] = f.sessions;
            driver.hard(f, a);
            const source = memory(f, "Foreign source.");
            const survivor = memory(f, "Existing survivor never shown.");
            agentMerge(f, a, [source.id, survivor.id], survivor.content);
            const served = driver.pass(f, a, true);
            expect(served.materialized).toBe(false);
            expect(served.m1).toContain(`<superseded id="${source.id}" by="${survivor.id}"/>`);
            expect(served.m1).toContain(survivor.content);
        } finally {
            f.close();
        }
    });

    // A merge whose survivor text this session already shows adds only the supersession.
    test(`${driver.host} a merge into a shown survivor adds only the supersession`, () => {
        const f = create("shown-survivor");
        try {
            const [a] = f.sessions;
            const survivor = memory(f, "Survivor already in m[0].");
            driver.hard(f, a);
            const source = memory(f, "Later source.");
            agentMerge(f, a, [source.id, survivor.id], survivor.content);
            const served = driver.pass(f, a, true);
            expect(served.m1).toContain(`<superseded id="${source.id}" by="${survivor.id}"/>`);
            expect(served.m1).not.toContain(`<added id="${survivor.id}"`);
        } finally {
            f.close();
        }
    });

    // The agent asked to save it, so an explicit save that matches a memory this session
    // does not show reaches the session; one it already shows adds nothing.
    test(`${driver.host} an explicit agent save of an unshown duplicate reaches its session`, () => {
        const f = create("duplicate-save");
        try {
            const [a] = f.sessions;
            const shown = memory(f, "Duplicate already shown.");
            driver.hard(f, a);
            const unshown = memory(f, "Unshown duplicate manual save.");
            expect(agentSave(f, a, unshown.content)).toBe(unshown.id);
            expect(agentSave(f, a, shown.content)).toBe(shown.id);
            const served = driver.pass(f, a, true);
            expect(served.materialized).toBe(false);
            expect(served.m1).toContain(
                `<added id="${unshown.id}" category="ARCHITECTURE">${unshown.content}</added>`,
            );
            expect(served.m1).not.toContain(`<added id="${shown.id}"`);
        } finally {
            f.close();
        }
    });

    // Automated writers apply directly to rows and stay out of the prompt until a
    // HARD fold that would have happened anyway; a genuine trigger still sees them.
    test(`${driver.host} a genuine HARD trigger shows automated memory changes held back on SOFT`, () => {
        const f = create("genuine-hard");
        try {
            const [a] = f.sessions;
            const target = memory(f, "Build uses tool version one.");
            driver.hard(f, a);
            automatedEdit(f, target.id, "Build uses tool version two.");
            const soft = driver.pass(f, a, true);
            expect(soft.materialized).toBe(false);
            expect(soft.m0).toContain("Build uses tool version one.");
            expect(`${soft.m0}${soft.m1}`).not.toContain("version two");
            const switched = driver.pass(f, a, true, { genuineHard: true });
            expect(switched.materialized).toBe(true);
            expect(switched.m0).toContain("Build uses tool version two.");
        } finally {
            f.close();
        }
    });

    // An external content repair bumps the epoch for storage coherence, but its
    // canonical text is held until an independently authorized baseline rebuild.
    test(`${driver.host} external repair waits for natural HARD`, () => {
        const f = create("external-repair");
        try {
            const [a] = f.sessions;
            const target = memory(f, "Repaired claim before repair.");
            driver.hard(f, a);
            const before = driver.pass(f, a, false);
            updateMemoryContent(
                f.db,
                target.id,
                "Repaired claim after repair.",
                computeNormalizedHash("Repaired claim after repair."),
            );
            bumpProjectMemoryEpoch(f.db, f.projectPath);
            expect(driver.pass(f, a, true)).toEqual(before);
            const repaired = driver.pass(f, a, true, { genuineHard: true });
            expect(repaired.materialized).toBe(true);
            expect(repaired.m0).toContain("Repaired claim after repair.");
        } finally {
            f.close();
        }
    });

    // B2: neither a score, status or content change written without the agent
    // path, nor a higher-priority new row, moves an admitted SOFT prefix, also
    // after the in-process state is rebuilt from storage.
    test(`${driver.host} soft_keeps_admitted_membership_and_revisions`, () => {
        const f = create("soft-keeps");
        try {
            const [a] = f.sessions;
            const kept = memory(f, "Admitted memory keeps its served text.");
            const retired = memory(f, "Admitted memory another writer retires.");
            driver.hard(f, a);
            const before = driver.pass(f, a, false);
            f.db
                .prepare(
                    "UPDATE memories SET importance = 1, content = 'Rewritten without a log row.' WHERE id = ?",
                )
                .run(kept.id);
            f.db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(retired.id);
            memory(f, "A higher-priority newcomer.", 100);
            const soft = driver.pass(f, a, true);
            expect(soft.materialized).toBe(false);
            expect(soft.m0).toBe(before.m0);
            expect(soft.m1).toBe(before.m1);
            expect(driver.pass(f, a, false)).toEqual(soft);
        } finally {
            f.close();
        }
    });

    // B2: neither pending automated edits nor agent fragments past the allowance
    // can push m[1] over a refold bound; corrections never authorize a HARD fold.
    test(`${driver.host} pending_lifecycle_cannot_manufacture_pressure_hard`, () => {
        const f = create("pressure");
        try {
            const [a] = f.sessions;
            const targets = Array.from({ length: 50 }, (_, index) =>
                memory(f, `Pressure rule ${index}.`),
            );
            const options = { historyBudget: 2_000 };
            driver.hard(f, a, options);
            for (const target of targets) {
                automatedEdit(
                    f,
                    target.id,
                    `Pressure rule ${target.id}, corrected. ${"x ".repeat(40)}`,
                );
                agentUpdate(
                    f,
                    a,
                    target.id,
                    `Pressure rule ${target.id}, agent text. ${"y ".repeat(40)}`,
                );
            }
            const soft = driver.pass(f, a, true, options);
            expect(soft.materialized).toBe(false);
            expect(soft.m1).toContain("<stale-memory");
        } finally {
            f.close();
        }
    });

    // B4: search hides a memory only while its CURRENT text is visible in full.
    // An automated edit makes the frozen prompt's text stale, so search returns
    // the current text even though the head still shows revision one.
    test(`${driver.host} current_revision_search_survives_old_prompt_exclusion`, () => {
        const f = create("search");
        try {
            const [a] = f.sessions;
            const target = memory(f, "Searchable claim, revision one.");
            driver.hard(f, a);
            driver.pass(f, a, false);
            expect(getVisibleMemoryIds(f.db, a)?.has(target.id)).toBe(true);
            automatedEdit(f, target.id, "Searchable claim, revision two.");
            expect(getVisibleMemoryIds(f.db, a)?.has(target.id) ?? false).toBe(false);
            const served = driver.pass(f, a, true);
            expect(served.m0).toContain("Searchable claim, revision one.");
            // This session's own agent edit shows the current text, so it hides again.
            agentUpdate(f, a, target.id, "Searchable claim, revision three.");
            driver.pass(f, a, true);
            expect(getVisibleMemoryIds(f.db, a)?.has(target.id)).toBe(true);
        } finally {
            f.close();
        }
    });

    // Upgrade: a cached pair written before projections existed replays its own
    // memory bytes; the first busting pass invents no stale marker and adds only
    // fragments written after it.
    test(`${driver.host} a pre-projection cached pair replays its memory bytes and appends only new fragments`, () => {
        const f = create("legacy");
        try {
            const [a] = f.sessions;
            memory(f, "Legacy baseline memory.");
            driver.hard(f, a);
            const before = driver.pass(f, a, false);
            f.db.prepare("DELETE FROM memory_applied_snapshots").run();
            f.db.prepare("DELETE FROM memory_applied_rows").run();
            const soft = driver.pass(f, a, true);
            expect(soft.materialized).toBe(false);
            expect(soft).toEqual(before);
            const saved = agentSave(f, a, "Saved after the upgrade.");
            const next = driver.pass(f, a, true);
            expect(next.m0).toBe(before.m0);
            expect(next.m1).toContain(`<added id="${saved}"`);
            expect(next.m1).not.toContain("<stale-memory");
        } finally {
            f.close();
        }
    });

    // Turn one records publications, send records, candidates, stored blocks and
    // activity counts. None of these rows may change the served pair (the m[0] bytes
    // and m[1] text a pass sends): run the same pass sequence on two stores, one of
    // which also has every turn-one row, and require identical bytes on every pass.
    // The fact promoted by the publish step is withheld on every SOFT and defer pass
    // and first appears at the HARD fold forced by provider cache expiry (a real fold
    // trigger, as opposed to the test's initial `driver.hard`).
    test(`${driver.host} turn-one publication rows never change a served pair; a dormant promotion waits for HARD`, () => {
        const plain = create("turn-one-plain");
        const recorded = create("turn-one-recorded");
        try {
            const reads = watchTurnOneTables(recorded.db);
            for (const f of [plain, recorded]) {
                memory(f, "Baseline memory served by the HARD fold.");
                driver.hard(f, f.sessions[0]);
            }
            const steps: Array<"soft" | "defer" | "publish" | "genuine-hard"> = [
                "soft",
                "defer",
                "soft",
                "defer",
                "publish",
                ...Array<"defer">(6).fill("defer"),
                "soft",
                "defer",
                "defer",
                "defer",
                "soft",
                "defer",
                "genuine-hard",
                "defer",
                "soft",
                "defer",
            ];
            let published = false;
            let hardAfterPublish = false;
            let passes = 0;
            for (const step of steps) {
                if (step === "publish") {
                    dormantPublish(plain, false);
                    dormantPublish(recorded, true);
                    published = true;
                    continue;
                }
                const watched = reads.length;
                const served = [plain, recorded].map((f) =>
                    driver.pass(
                        f,
                        f.sessions[0],
                        step !== "defer",
                        step === "genuine-hard" ? { genuineHard: true } : {},
                    ),
                );
                passes += 1;
                expect(reads.slice(watched)).toEqual([]);
                expect(served[1]).toEqual(served[0]);
                const text = `${served[0].m0}${served[0].m1}`;
                if (step === "genuine-hard") {
                    expect(served[0].materialized).toBe(true);
                    hardAfterPublish = true;
                } else {
                    expect(served[0].materialized).toBe(false);
                }
                if (published && !hardAfterPublish) {
                    expect(text).not.toContain("Promoted at the publish.");
                }
                if (hardAfterPublish) expect(served[0].m0).toContain("Promoted at the publish.");
            }
            expect(passes).toBeGreaterThanOrEqual(20);
            expect(
                recorded.db.prepare("SELECT COUNT(*) AS n FROM memory_pending_facts").get(),
            ).toEqual({ n: 2 });
        } finally {
            plain.close();
            recorded.close();
        }
    });
}
