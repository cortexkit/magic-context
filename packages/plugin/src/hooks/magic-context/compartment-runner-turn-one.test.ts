/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    acquireCompartmentLease,
    releaseCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import {
    getCompartments,
    replaceAllCompartments,
} from "../../features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { rememberPinnedProjectIdentity } from "../../features/magic-context/memory/project-identity-cache";
import { __resetSessionIdentityDecisionsForTests } from "../../features/magic-context/memory/session-identity-decision";
import {
    getMemoriesByProject,
    insertMemory,
} from "../../features/magic-context/memory/storage-memory";
import { __turnTwoChildrenTest } from "../../features/magic-context/memory/turn-two-children";
import {
    getRecordedSessionProjectIdentity,
    recordSessionProjectIdentity,
} from "../../features/magic-context/session-project-storage";
import {
    closeDatabase,
    getHistorianFailureState,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { readSessionMeta } from "../../features/magic-context/storage-meta-session";
import type { PluginContext } from "../../plugin/types";
import { __resetNotificationStateForTests } from "../../shared/rpc-notifications";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { runCompartmentAgent as runCompartmentAgentImpl } from "./compartment-runner";
import { settleHistorianTurnTwoRuns } from "./historian-turn-two-step";
import {
    clearProducerModelObservations,
    observeProducerModelsForTest,
    prepareProducerFixture,
} from "./producer-window-test-support";
import { __ignoredNotificationTest } from "./send-session-notification";
import { createTransform } from "./transform";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(async () => {
    await observeProducerModelsForTest(["test/fixture-historian"]);
    // These fixtures end on real user messages, which would make the notification
    // hold detector queue notices; turn it off so notices go out immediately.
    __ignoredNotificationTest.setHoldDetector(() => false);
});

afterEach(async () => {
    // Turn two runs as its own task after a run; let it finish before the store closes.
    await settleHistorianTurnTwoRuns();
    __turnTwoChildrenTest.clear();
    clearProducerModelObservations();
    __ignoredNotificationTest.reset();
    __resetNotificationStateForTests();
    __resetSessionIdentityDecisionsForTests();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    tempDirs.length = 0;
    rmSync(join(tmpdir(), "magic-context-historian"), {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
    });
});

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

/** Two summarised messages, two eligible ones, and a five-message protected tail. */
function createOpenCodeSession(sessionId: string, protectedBallast = ""): void {
    const messages = [
        { id: "m-1", role: "user", text: "zero" },
        { id: "m-2", role: "assistant", text: "one" },
        { id: "m-3", role: "user", text: "Cap the upload at 64 KiB." },
        { id: "m-4", role: "assistant", text: "Done." },
        { id: "m-5", role: "user", text: `protected 1${protectedBallast}` },
        { id: "m-6", role: "user", text: "protected 2" },
        { id: "m-7", role: "user", text: "protected 3" },
        { id: "m-8", role: "user", text: "protected 4" },
        { id: "m-9", role: "user", text: "protected 5" },
    ];
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS part (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        `);
        messages.forEach((message, index) => {
            const at = index + 1;
            db.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(
                message.id,
                sessionId,
                at,
                at,
                JSON.stringify({ id: message.id, role: message.role, sessionID: sessionId }),
            );
            db.prepare(
                "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(
                message.id,
                sessionId,
                at,
                at,
                JSON.stringify({ type: "text", text: message.text }),
            );
        });
    } finally {
        closeQuietly(db);
    }
}

function seedPriorCompartment(db: Database, sessionId: string): number {
    replaceAllCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "m-1",
            endMessageId: "m-2",
            title: "Earlier work",
            content: "Old summary",
        },
    ]);
    return getCompartments(db, sessionId)[0]!.id;
}

function historianClient(directory: string, replies: () => string) {
    const prompt = mock(async (_input: { body: { parts: Array<{ text: string }> } }) => ({}));
    const client = {
        session: {
            get: mock(async () => ({ data: { directory } })),
            create: mock(async () => ({ data: { id: `ses-agent-${Math.random()}` } })),
            prompt,
            messages: mock(async () => ({
                data: [
                    {
                        info: { role: "assistant", time: { created: 1 } },
                        parts: [{ type: "text", text: replies() }],
                    },
                ],
            })),
            delete: mock(async () => ({})),
        },
    } as unknown as PluginContext["client"];
    return { client, prompt };
}

async function runHistorian(
    db: Database,
    sessionId: string,
    client: PluginContext["client"],
    directory: string,
    extra: Partial<Parameters<typeof runCompartmentAgentImpl>[0]> = {},
): Promise<void> {
    const holderId = `test-holder-${Math.random()}`;
    expect(acquireCompartmentLease(db, sessionId, holderId)).not.toBeNull();
    try {
        await runCompartmentAgentImpl(
            await prepareProducerFixture({
                client,
                db,
                sessionId,
                historianChunkTokens: 10_000,
                directory,
                compartmentLeaseHolderId: holderId,
                ...extra,
            }),
        );
    } finally {
        releaseCompartmentLease(db, sessionId, holderId);
    }
}

function sentPrompts(prompt: ReturnType<typeof mock>): string[] {
    return prompt.mock.calls
        .map((call) => call[0] as { body?: { noReply?: boolean; parts?: Array<{ text: string }> } })
        .filter((input) => input.body?.noReply !== true)
        .map((input) => input.body?.parts?.[0]?.text ?? "");
}

function markModuleAuthority(db: Database, projectPath: string): void {
    db.prepare(
        "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?, 'module-store', 1)",
    ).run(projectPath);
}

function pendingFacts(db: Database) {
    return db
        .prepare(
            "SELECT project_path, fact_index, compartment_id, category, content, anchor_known, state, fact_attempts, reason FROM memory_pending_facts ORDER BY id",
        )
        .all();
}

function publications(db: Database) {
    return db
        .prepare(
            "SELECT publication_id, source_session_id, commit_order FROM memory_publications ORDER BY rowid",
        )
        .all() as Array<{
        publication_id: string;
        source_session_id: string;
        commit_order: number | null;
    }>;
}

function turnOneSends(db: Database) {
    return db
        .prepare(
            "SELECT publication_id, run_attempt, stage, session_id, state FROM memory_stage_attempts WHERE stage='turn_one' ORDER BY run_attempt",
        )
        .all() as Array<{
        publication_id: string;
        run_attempt: number;
        stage: string;
        session_id: string;
        state: string;
    }>;
}

const REPLY_WITH_FACTS = `<output><compartments>
<compartment start="3" end="4" title="Upload cap"><p1>Capped uploads.</p1></compartment>
</compartments>
<facts>
<CONSTRAINTS>
* [at_compartment=1 messages=3] Uploads are capped at 64 KiB.
* [at_compartment=unknown] Uploads go through the gateway.
</CONSTRAINTS>
</facts>
</output>`;

describe("historian turn one on a dormant lane (production default)", () => {
    it("review witness: a blocking historian on a move pass promotes into the served block's project", async () => {
        useTempDataHome("review-historian-move-");
        const sessionId = "ses-review-historian-move";
        const a = join(process.env.XDG_DATA_HOME!, "project-a");
        const b = join(process.env.XDG_DATA_HOME!, "project-b");
        mkdirSync(join(a, ".git"), { recursive: true });
        mkdirSync(join(b, ".git"), { recursive: true });
        rememberPinnedProjectIdentity(a, "pj-REVIEW-HIST-A");
        rememberPinnedProjectIdentity(b, "pj-REVIEW-HIST-B");
        const protectedBallast = " ballast".repeat(60_000);
        createOpenCodeSession(sessionId, protectedBallast);
        const db = openDatabase();
        seedPriorCompartment(db, sessionId);
        insertMemory(db, {
            projectPath: "pj-REVIEW-HIST-B",
            category: "NAMING",
            content: "review project beta block memory",
        });
        const { client, prompt } = historianClient(b, () => REPLY_WITH_FACTS);
        const deps = {
            db,
            client,
            tagger: createTagger(),
            scheduler: { shouldExecute: () => "defer" as const },
            contextUsageMap: new Map(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
            historianRunnable: false,
            historianModel: "test/fixture-historian",
            getHistorianChunkTokens: () => 10_000,
            directory: a,
            sessionDirectoryBySession: new Map([[sessionId, a]]),
            memoryConfig: { enabled: true, injectionBudgetTokens: 500, autoPromote: true },
        };
        const raw = [
            "zero",
            "one",
            "Cap the upload at 64 KiB.",
            "Done.",
            `protected 1${protectedBallast}`,
            "protected 2",
            "protected 3",
            "protected 4",
            "protected 5",
        ].map((text, index) => ({
            info: {
                id: `m-${index + 1}`,
                role: index === 1 || index === 3 ? "assistant" : "user",
                sessionID: sessionId,
            },
            parts: [{ type: "text", text }],
        }));
        const transform = createTransform(deps);
        await transform({}, { messages: structuredClone(raw) });
        deps.sessionDirectoryBySession.set(sessionId, b);
        deps.historianRunnable = true;
        deps.contextUsageMap.set(sessionId, {
            usage: { percentage: 96, inputTokens: 960_000 },
            updatedAt: Date.now(),
            hasUsageTokens: true,
        });
        // Resume a saved run request at pressure that waits for promotion before serving the new project's block.
        updateSessionMeta(db, sessionId, { compartmentInProgress: true });
        const moved = { messages: structuredClone(raw) };
        await transform({}, moved);
        expect(sentPrompts(prompt)).toHaveLength(1);
        expect(JSON.stringify(moved.messages)).toContain("review project beta block memory");
        expect(readSessionMeta(db, sessionId)?.cachedM0ProjectIdentity).toBe("pj-REVIEW-HIST-B");
        expect({
            owner: getRecordedSessionProjectIdentity(db, sessionId),
            publications: db.prepare("SELECT DISTINCT project_path FROM memory_publications").all(),
            promoted: getMemoriesByProject(db, "pj-REVIEW-HIST-B").map((memory) => memory.content),
            oldProject: getMemoriesByProject(db, "pj-REVIEW-HIST-A").map(
                (memory) => memory.content,
            ),
        }).toEqual({
            owner: "pj-REVIEW-HIST-B",
            publications: [{ project_path: "pj-REVIEW-HIST-B" }],
            promoted: expect.arrayContaining([
                "Uploads are capped at 64 KiB.",
                "Uploads go through the gateway.",
            ]),
            oldProject: [],
        });
    });

    it("keeps today's prompt and promotion, and commits the publication once with its activity", async () => {
        useTempDataHome("turn-one-dormant-ts-");
        const sessionId = "ses-dormant-ts";
        const directory = "/tmp/turn-one-dormant-ts";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        const projectPath = resolveProjectIdentity(directory);
        seedPriorCompartment(db, sessionId);
        insertMemory(db, {
            projectPath,
            category: "NAMING",
            content: "Existing memory shown to the historian.",
            sourceType: "historian",
        });
        const { client, prompt } = historianClient(directory, () => REPLY_WITH_FACTS);

        await runHistorian(db, sessionId, client, directory);

        const [sent] = sentPrompts(prompt);
        expect(sent).toContain("Existing memory shown to the historian.");
        expect(sent).not.toContain("<fact_anchors>");
        // Promotion through the lifecycle applier: both facts become memories, the
        // anchor prefix is not part of the stored text, and no candidate is written.
        expect(
            getMemoriesByProject(db, projectPath)
                .map((memory) => memory.content)
                .sort(),
        ).toEqual([
            "Existing memory shown to the historian.",
            "Uploads are capped at 64 KiB.",
            "Uploads go through the gateway.",
        ]);
        expect(pendingFacts(db)).toEqual([]);

        const [publication] = publications(db);
        expect(publications(db)).toHaveLength(1);
        expect(publication).toMatchObject({ source_session_id: sessionId, commit_order: 1 });
        expect(turnOneSends(db)).toEqual([
            {
                publication_id: publication!.publication_id,
                run_attempt: 1,
                stage: "turn_one",
                session_id: sessionId,
                state: "published",
            },
        ]);
        const newRow = getCompartments(db, sessionId)[1]!;
        expect(
            db.prepare("SELECT publication_id, compartment_id FROM memory_activity_ledger").all(),
        ).toEqual([{ publication_id: publication!.publication_id, compartment_id: newRow.id }]);
    });

    it("uses the recorded session decision for the memory pool and promotion", async () => {
        useTempDataHome("turn-one-session-identity-");
        const sessionId = "ses-session-identity";
        const directory = join(process.env.XDG_DATA_HOME!, "project");
        mkdirSync(directory);
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        const fallback = resolveProjectIdentity(directory);
        const projectPath = "pj-historian-session";
        recordSessionProjectIdentity(db, sessionId, projectPath);
        seedPriorCompartment(db, sessionId);
        insertMemory(db, {
            projectPath,
            category: "NAMING",
            content: "Only the session decision can see this memory.",
            sourceType: "historian",
        });
        const { client, prompt } = historianClient(directory, () => REPLY_WITH_FACTS);
        await runHistorian(db, sessionId, client, directory);
        expect(sentPrompts(prompt)[0]).toContain("Only the session decision can see this memory.");
        expect(
            getMemoriesByProject(db, projectPath)
                .map((memory) => memory.content)
                .sort(),
        ).toEqual([
            "Only the session decision can see this memory.",
            "Uploads are capped at 64 KiB.",
            "Uploads go through the gateway.",
        ]);
        expect(getMemoriesByProject(db, fallback)).toHaveLength(0);
        expect(db.prepare("SELECT DISTINCT project_path FROM memory_publications").all()).toEqual([
            { project_path: projectPath },
        ]);
    });

    it("records every fact as an authority_elsewhere candidate when the module owns memory", async () => {
        useTempDataHome("turn-one-dormant-module-");
        const sessionId = "ses-dormant-module";
        const directory = "/tmp/turn-one-dormant-module";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        const projectPath = resolveProjectIdentity(directory);
        seedPriorCompartment(db, sessionId);
        markModuleAuthority(db, projectPath);
        const memoriesBefore = db.prepare("SELECT * FROM memories").all();
        const { client } = historianClient(directory, () => REPLY_WITH_FACTS);

        await runHistorian(db, sessionId, client, directory);

        expect(getCompartments(db, sessionId)).toHaveLength(2);
        expect(db.prepare("SELECT * FROM memories").all()).toEqual(memoriesBefore);
        // One row per fact, each with an unknown anchor (a dormant lane does not
        // honour anchors), retryable with no attempt consumed.
        expect(pendingFacts(db)).toEqual(
            ["Uploads are capped at 64 KiB.", "Uploads go through the gateway."].map(
                (content, factIndex) => ({
                    project_path: projectPath,
                    fact_index: factIndex,
                    compartment_id: null,
                    category: "CONSTRAINTS",
                    content,
                    anchor_known: 0,
                    state: "retryable",
                    fact_attempts: 0,
                    reason: "authority_elsewhere",
                }),
            ),
        );
        expect(db.prepare("SELECT COUNT(*) AS n FROM memory_fact_blocks").get()).toEqual({ n: 0 });
        expect(publications(db).map((row) => row.commit_order)).toEqual([1]);
    });

    it("writes no candidates where today's promotion is off", async () => {
        useTempDataHome("turn-one-dormant-module-autopromote-off-");
        const sessionId = "ses-dormant-module-off";
        const directory = "/tmp/turn-one-dormant-module-off";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        seedPriorCompartment(db, sessionId);
        markModuleAuthority(db, resolveProjectIdentity(directory));
        const { client } = historianClient(directory, () => REPLY_WITH_FACTS);

        await runHistorian(db, sessionId, client, directory, { autoPromote: false });

        expect(getCompartments(db, sessionId)).toHaveLength(2);
        expect(pendingFacts(db)).toEqual([]);
        expect(publications(db).map((row) => row.commit_order)).toEqual([1]);
    });
});

describe("historian turn one on an enabled lane", () => {
    it("omits the memory block and binds anchored candidates to this reply's durable compartment", async () => {
        useTempDataHome("turn-one-enabled-");
        const sessionId = "ses-enabled";
        const directory = "/tmp/turn-one-enabled";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        const projectPath = resolveProjectIdentity(directory);
        const olderRowId = seedPriorCompartment(db, sessionId);
        insertMemory(db, {
            projectPath,
            category: "NAMING",
            content: "Existing memory hidden from turn one.",
            sourceType: "historian",
        });
        const { client, prompt } = historianClient(directory, () => REPLY_WITH_FACTS);

        await runHistorian(db, sessionId, client, directory, { memoryLifecycleLane: "enabled" });

        const [sent] = sentPrompts(prompt);
        expect(sent).not.toContain("Existing memory hidden from turn one.");
        expect(sent).toContain("<fact_anchors>required</fact_anchors>");
        expect(sent).toContain("[3] U: Cap the upload at 64 KiB.");

        const newRow = getCompartments(db, sessionId)[1]!;
        expect(newRow.id).not.toBe(olderRowId);
        // The candidate facts turn one published. Turn two (which reconciles them) runs
        // as a separate task scheduled after the compartment run settles, so right
        // after `runHistorian` returns it has not started and the facts are still as
        // published. Turn two itself is covered in "historian turn two on an enabled
        // lane" below.
        expect(pendingFacts(db)).toEqual([
            {
                project_path: projectPath,
                fact_index: 0,
                compartment_id: newRow.id,
                category: "CONSTRAINTS",
                content: "Uploads are capped at 64 KiB.",
                anchor_known: 1,
                state: "retryable",
                fact_attempts: 0,
                reason: null,
            },
            {
                project_path: projectPath,
                fact_index: 1,
                compartment_id: null,
                category: "CONSTRAINTS",
                content: "Uploads go through the gateway.",
                anchor_known: 0,
                state: "retryable",
                fact_attempts: 0,
                reason: null,
            },
        ]);
        const [publication] = publications(db);
        expect(
            db
                .prepare(
                    "SELECT publication_id, source_session_id, start_ordinal, end_ordinal, role, parts_json, joined_text FROM memory_fact_blocks",
                )
                .all(),
        ).toEqual([
            {
                publication_id: publication!.publication_id,
                source_session_id: sessionId,
                start_ordinal: 3,
                end_ordinal: 3,
                role: "U",
                parts_json: JSON.stringify(["Cap the upload at 64 KiB."]),
                joined_text: "Cap the upload at 64 KiB.",
            },
        ]);
        // Turn one promotes nothing on an enabled lane; the facts wait as candidates.
        expect(getMemoriesByProject(db, projectPath).map((memory) => memory.content)).toEqual([
            "Existing memory hidden from turn one.",
        ]);
        expect(db.prepare("SELECT compartment_id FROM memory_activity_ledger").all()).toEqual([
            { compartment_id: newRow.id },
        ]);
    });

    it("commits candidates with the compartments as authority_elsewhere under module authority", async () => {
        useTempDataHome("turn-one-enabled-module-");
        const sessionId = "ses-enabled-module";
        const directory = "/tmp/turn-one-enabled-module";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        const projectPath = resolveProjectIdentity(directory);
        seedPriorCompartment(db, sessionId);
        markModuleAuthority(db, projectPath);
        const memoriesBefore = db.prepare("SELECT * FROM memories").all();
        const { client } = historianClient(directory, () => REPLY_WITH_FACTS);

        await runHistorian(db, sessionId, client, directory, { memoryLifecycleLane: "enabled" });

        const newRow = getCompartments(db, sessionId)[1]!;
        expect(
            pendingFacts(db).map((row) => ({
                compartment_id: (row as { compartment_id: number | null }).compartment_id,
                state: (row as { state: string }).state,
                fact_attempts: (row as { fact_attempts: number }).fact_attempts,
                reason: (row as { reason: string | null }).reason,
            })),
        ).toEqual([
            {
                compartment_id: newRow.id,
                state: "retryable",
                fact_attempts: 0,
                reason: "authority_elsewhere",
            },
            {
                compartment_id: null,
                state: "retryable",
                fact_attempts: 0,
                reason: "authority_elsewhere",
            },
        ]);
        expect(db.prepare("SELECT * FROM memories").all()).toEqual(memoriesBefore);
    });

    it("reuses the publication id after a run that never published, and publishes once", async () => {
        useTempDataHome("turn-one-enabled-retry-");
        const sessionId = "ses-enabled-retry";
        const directory = "/tmp/turn-one-enabled-retry";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        seedPriorCompartment(db, sessionId);
        let reply = "no compartments here";
        const { client } = historianClient(directory, () => reply);

        await runHistorian(db, sessionId, client, directory, {
            memoryLifecycleLane: "enabled",
            forceDrainQuota: true,
        });
        expect(getCompartments(db, sessionId)).toHaveLength(1);
        const [abandoned] = publications(db);
        expect(abandoned).toMatchObject({ commit_order: null });
        expect(pendingFacts(db)).toEqual([]);
        expect(db.prepare("SELECT COUNT(*) AS n FROM memory_activity_ledger").get()).toEqual({
            n: 0,
        });

        reply = REPLY_WITH_FACTS;
        await runHistorian(db, sessionId, client, directory, {
            memoryLifecycleLane: "enabled",
            forceDrainQuota: true,
        });

        expect(publications(db)).toEqual([{ ...abandoned!, commit_order: 1 }]);
        expect(
            turnOneSends(db).map((send) => [send.publication_id, send.run_attempt, send.state]),
        ).toEqual([
            [abandoned!.publication_id, 1, "superseded"],
            [abandoned!.publication_id, 2, "published"],
        ]);
        expect(pendingFacts(db)).toHaveLength(2);
        expect(db.prepare("SELECT COUNT(*) AS n FROM memory_activity_ledger").get()).toEqual({
            n: 1,
        });
    });
});

describe("historian turn one when the store is busy before dispatch", () => {
    it("skips the run without counting a failure when turn one's send cannot be recorded, and retries on the next trigger", async () => {
        useTempDataHome("turn-one-busy-");
        const sessionId = "ses-busy";
        const directory = "/tmp/turn-one-busy";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        seedPriorCompartment(db, sessionId);
        const { client, prompt } = historianClient(directory, () => REPLY_WITH_FACTS);

        // Every statement that would record the send reports a store that stayed busy
        // past its timeout, as SQLite does when another writer holds the lock.
        const prepare = db.prepare.bind(db);
        Object.defineProperty(db, "prepare", {
            configurable: true,
            writable: true,
            value: (sql: string) => {
                if (/INSERT INTO memory_stage_attempts/.test(sql)) {
                    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
                }
                return prepare(sql);
            },
        });
        try {
            await runHistorian(db, sessionId, client, directory, { forceDrainQuota: true });
        } finally {
            Object.defineProperty(db, "prepare", {
                configurable: true,
                writable: true,
                value: prepare,
            });
        }

        expect(sentPrompts(prompt)).toEqual([]);
        expect(getCompartments(db, sessionId)).toHaveLength(1);
        expect(publications(db)).toEqual([]);
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(0);
        expect(
            db
                .prepare(
                    "SELECT historian_drain_failure_at AS at, compartment_in_progress AS busy FROM session_meta WHERE session_id = ?",
                )
                .get(sessionId),
        ).toEqual({ at: 0, busy: 0 });
        expect(
            db
                .prepare(
                    "SELECT status, failure_reason FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
                )
                .get(sessionId),
        ).toEqual({ status: "noop", failure_reason: "turn_one_send_store_busy" });

        // The next trigger runs normally.
        await runHistorian(db, sessionId, client, directory, { forceDrainQuota: true });
        expect(sentPrompts(prompt)).toHaveLength(1);
        expect(getCompartments(db, sessionId)).toHaveLength(2);
        expect(publications(db).map((row) => row.commit_order)).toEqual([1]);
    });
});

describe("historian turn two on an enabled lane", () => {
    /**
     * A host whose hidden children answer turn one with `REPLY_WITH_FACTS` and a
     * later prompt in the same child with `turnTwo(prompt)`. `events` records every
     * prompt and delete in order, by child session id.
     */
    function twoTurnClient(
        directory: string,
        turnTwo: ((prompt: string) => string) | null,
        beforeTurnTwo?: Promise<void>,
    ) {
        const events: string[] = [];
        const replies = new Map<string, string>();
        const prompts = new Map<string, number>();
        let created = 0;
        const client = {
            session: {
                get: mock(async () => ({ data: { directory } })),
                create: mock(async () => ({ data: { id: `ses-child-${++created}` } })),
                prompt: mock(
                    async (input: {
                        path: { id: string };
                        body: { parts: Array<{ text: string }> };
                    }) => {
                        const id = input.path.id;
                        const turn = (prompts.get(id) ?? 0) + 1;
                        prompts.set(id, turn);
                        events.push(`prompt:${id}:${turn}`);
                        const text = input.body.parts[0]?.text ?? "";
                        if (turn === 1) replies.set(id, REPLY_WITH_FACTS);
                        else {
                            await beforeTurnTwo;
                            if (turnTwo) replies.set(id, turnTwo(text));
                        }
                        return {};
                    },
                ),
                messages: mock(async (input: { path: { id: string } }) => ({
                    data: [
                        {
                            info: {
                                role: "assistant",
                                time: { created: prompts.get(input.path.id) ?? 0 },
                                providerID: "test",
                                modelID: "fixture-historian",
                            },
                            parts: [{ type: "text", text: replies.get(input.path.id) ?? "" }],
                        },
                    ],
                })),
                delete: mock(async (input: { path: { id: string } }) => {
                    events.push(`delete:${input.path.id}`);
                    return {};
                }),
            },
        } as unknown as PluginContext["client"];
        return { client, events };
    }

    it("sends turn two on turn one's child and closes the child only after turn two resolved", async () => {
        useTempDataHome("turn-two-same-child-");
        const sessionId = "ses-turn-two";
        const directory = "/tmp/turn-two-same-child";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        const projectPath = resolveProjectIdentity(directory);
        seedPriorCompartment(db, sessionId);
        let turnTwoPrompt = "";
        const { client, events } = twoTurnClient(directory, (prompt) => {
            turnTwoPrompt = prompt;
            const ids = [...prompt.matchAll(/^## Fact (\d+)/gm)].map((match) => Number(match[1]));
            return JSON.stringify({
                decisions: ids.map((id) => ({ fact_id: id, action: "new" })),
            });
        });

        await runHistorian(db, sessionId, client, directory, { memoryLifecycleLane: "enabled" });
        await settleHistorianTurnTwoRuns();

        // Turn one and turn two go to the same child, and it is deleted only after
        // turn two; closing it in turn one's `finally` would put the delete first.
        expect(events).toEqual([
            "prompt:ses-child-1:1",
            "prompt:ses-child-1:2",
            "delete:ses-child-1",
        ]);
        expect(turnTwoPrompt).toContain("[3] U: Cap the upload at 64 KiB.");
        expect(
            db
                .prepare(
                    "SELECT stage, child_session_id, state FROM memory_stage_attempts WHERE stage='turn_two'",
                )
                .all(),
        ).toEqual([{ stage: "turn_two", child_session_id: "ses-child-1", state: "resolved" }]);
        expect((pendingFacts(db) as Array<{ state: string }>).map((row) => row.state)).toEqual([
            "applied",
            "applied",
        ]);
        expect(
            getMemoriesByProject(db, projectPath)
                .map((memory) => memory.content)
                .sort(),
        ).toEqual(["Uploads are capped at 64 KiB.", "Uploads go through the gateway."]);
    });

    it("runs turn two after the compartment run settles, outside its lease and in-progress flag", async () => {
        useTempDataHome("turn-two-after-run-");
        const sessionId = "ses-turn-two-after-run";
        const directory = "/tmp/turn-two-after-run";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        seedPriorCompartment(db, sessionId);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { client, events } = twoTurnClient(
            directory,
            (prompt) =>
                JSON.stringify({
                    decisions: [...prompt.matchAll(/^## Fact (\d+)/gm)].map((match) => ({
                        fact_id: Number(match[1]),
                        action: "abstain",
                    })),
                }),
            gate,
        );

        await runHistorian(db, sessionId, client, directory, { memoryLifecycleLane: "enabled" });
        // The run has settled while turn two has not answered: a transform joining
        // the run at high pressure no longer waits for turn two.
        for (let tick = 0; tick < 20 && !events.includes("prompt:ses-child-1:2"); tick++)
            await new Promise((resolve) => setTimeout(resolve, 5));
        expect(events).toEqual(["prompt:ses-child-1:1", "prompt:ses-child-1:2"]);
        expect(readSessionMeta(db, sessionId).compartmentInProgress).toBe(false);
        // Another run can take the session's compartment lease meanwhile.
        const holder = `next-run-${Math.random()}`;
        expect(acquireCompartmentLease(db, sessionId, holder)).not.toBeNull();
        releaseCompartmentLease(db, sessionId, holder);

        release();
        await settleHistorianTurnTwoRuns();
        expect(events.at(-1)).toBe("delete:ses-child-1");
        expect((pendingFacts(db) as Array<{ state: string }>).map((row) => row.state)).toEqual([
            "decided_pending",
            "decided_pending",
        ]);
    });

    it("keeps the child open while turn two is in flight", async () => {
        useTempDataHome("turn-two-in-flight-");
        const sessionId = "ses-turn-two-open";
        const directory = "/tmp/turn-two-in-flight";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        seedPriorCompartment(db, sessionId);
        // The host accepts turn two but has not answered it yet.
        const { client, events } = twoTurnClient(directory, null);

        await runHistorian(db, sessionId, client, directory, { memoryLifecycleLane: "enabled" });
        await settleHistorianTurnTwoRuns();

        expect(events).toEqual(["prompt:ses-child-1:1", "prompt:ses-child-1:2"]);
        expect(
            (pendingFacts(db) as Array<{ state: string; fact_attempts: number }>).map((row) => [
                row.state,
                row.fact_attempts,
            ]),
        ).toEqual([
            ["in_flight", 0],
            ["in_flight", 0],
        ]);
    });

    it("sends no turn two on a dormant lane", async () => {
        useTempDataHome("turn-two-dormant-");
        const sessionId = "ses-turn-two-dormant";
        const directory = "/tmp/turn-two-dormant";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        seedPriorCompartment(db, sessionId);
        const { client, events } = twoTurnClient(directory, () => {
            throw new Error("a dormant lane must not send turn two");
        });

        await runHistorian(db, sessionId, client, directory);

        expect(events).toEqual(["prompt:ses-child-1:1", "delete:ses-child-1"]);
        expect(
            db
                .prepare("SELECT COUNT(*) AS n FROM memory_stage_attempts WHERE stage='turn_two'")
                .get(),
        ).toEqual({ n: 0 });
    });
});
