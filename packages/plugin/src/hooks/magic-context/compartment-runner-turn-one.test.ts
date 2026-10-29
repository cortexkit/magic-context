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
import {
    getMemoriesByProject,
    insertMemory,
} from "../../features/magic-context/memory/storage-memory";
import {
    HISTORIAN_FORMAT_INSTRUCTION,
    sweepDormantTurnTwo,
} from "../../features/magic-context/memory/turn-one-publication";
import { __turnTwoChildrenTest } from "../../features/magic-context/memory/turn-two-children";
import { authorizationFixture } from "../../features/magic-context/memory/turn-two-test-fixtures.test";
import {
    closeDatabase,
    getHistorianFailureState,
    openDatabase,
} from "../../features/magic-context/storage";
import { readSessionMeta } from "../../features/magic-context/storage-meta-session";
import type { PluginContext } from "../../plugin/types";
import { __resetNotificationStateForTests } from "../../shared/rpc-notifications";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT,
    COMPARTMENT_AGENT_SYSTEM_PROMPT,
} from "./compartment-prompt";
import { runCompartmentAgent as runCompartmentAgentImpl } from "./compartment-runner";
import { createV1HiddenCompletionExecutor } from "./compartment-runner-historian";
import { settleHistorianTurnTwoRuns } from "./historian-turn-two-step";
import {
    clearProducerModelObservations,
    observeProducerModelsForTest,
    prepareProducerFixture,
} from "./producer-window-test-support";
import { __ignoredNotificationTest } from "./send-session-notification";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const combinedFixture = authorizationFixture(
    {
        lane: "opencode-1",
        carrier: "opencode-session",
        provider: "test",
        modelId: "fixture-historian",
        variant: null,
        temperature: null,
        thinkingLevel: null,
    },
    COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT,
    [],
    HISTORIAN_FORMAT_INSTRUCTION,
);

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
function createOpenCodeSession(sessionId: string): void {
    const messages = [
        { id: "m-1", role: "user", text: "zero" },
        { id: "m-2", role: "assistant", text: "one" },
        { id: "m-3", role: "user", text: "Cap the upload at 64 KiB." },
        { id: "m-4", role: "assistant", text: "Done." },
        { id: "m-5", role: "user", text: "protected 1" },
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
                        parts: [
                            {
                                type: "text",
                                text: sentPrompts(prompt)
                                    .at(-1)
                                    ?.includes(HISTORIAN_FORMAT_INSTRUCTION)
                                    ? combinedFixture.turnOne(replies())
                                    : replies(),
                            },
                        ],
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
                memoryLifecycleValidatedProfiles:
                    extra.memoryLifecycleLane === "enabled"
                        ? authorizationFixture(
                              {
                                  lane: "opencode-1",
                                  carrier: extra.hiddenCompletionExecutor
                                      ? "hidden-completion"
                                      : "opencode-session",
                                  provider: "test",
                                  modelId: "fixture-historian",
                                  variant: null,
                                  temperature: null,
                                  thinkingLevel: null,
                              },
                              COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT,
                              [],
                              HISTORIAN_FORMAT_INSTRUCTION,
                          ).rows
                        : undefined,
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
            "SELECT publication_id, run_attempt, stage, session_id, state FROM memory_stage_attempts WHERE stage='turn_one' AND publication_id NOT LIKE 't1fail:%' ORDER BY run_attempt",
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

const REPLY_WITH_MISLABELLED_TAIL = `<output><compartments>
<compartment start="3" end="3" title="Head"><p1>Retained head.</p1></compartment>
<compartment start="4" end="4" title="Tail"><p1>Discarded tail.</p1></compartment>
</compartments><facts><CONSTRAINTS>
* [at_compartment=1 messages=4] Uploads are capped at 64 KiB.
</CONSTRAINTS></facts></output>`;

describe("historian turn one on a dormant lane (production default)", () => {
    it("one-pass still promotes a kept-label fact citing the discarded tail", async () => {
        useTempDataHome("turn-one-dormant-tail-");
        const sessionId = "ses-dormant-tail";
        const directory = "/tmp/turn-one-dormant-tail";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        seedPriorCompartment(db, sessionId);
        const { client } = historianClient(directory, () => REPLY_WITH_MISLABELLED_TAIL);
        await runHistorian(db, sessionId, client, directory, {
            memoryLifecycleValidatedProfiles: [],
        });
        expect(
            getCompartments(db, sessionId).map((row) => [row.startMessage, row.endMessage]),
        ).toEqual([
            [1, 2],
            [3, 3],
        ]);
        expect(
            getMemoriesByProject(db, resolveProjectIdentity(directory)).map(
                (memory) => memory.content,
            ),
        ).toEqual(["Uploads are capped at 64 KiB."]);
        expect(pendingFacts(db)).toEqual([]);
    });
    it("empty allowlist sends the XML artifact, parses and promotes, and commits the publication once", async () => {
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
        const executor = createV1HiddenCompletionExecutor(client, db, directory);
        const open = mock(executor.open.bind(executor));

        await runHistorian(db, sessionId, client, directory, {
            memoryLifecycleValidatedProfiles: [],
            hiddenCompletionExecutor: { ...executor, open },
        });

        expect(open.mock.calls[0]?.[0].system).toBe(COMPARTMENT_AGENT_SYSTEM_PROMPT);
        expect(open.mock.calls[0]?.[0].agent).toBe("historian");

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
    it("two-pass excludes the same mislabelled tail that one-pass still promotes", async () => {
        useTempDataHome("turn-one-enabled-tail-");
        const sessionId = "ses-enabled-tail";
        const directory = "/tmp/turn-one-enabled-tail";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        seedPriorCompartment(db, sessionId);
        const { client } = historianClient(directory, () => REPLY_WITH_MISLABELLED_TAIL);
        await runHistorian(db, sessionId, client, directory, { memoryLifecycleLane: "enabled" });
        expect(
            getCompartments(db, sessionId).map((row) => [row.startMessage, row.endMessage]),
        ).toEqual([
            [1, 2],
            [3, 3],
        ]);
        expect(pendingFacts(db)).toEqual([]);
        expect(getMemoriesByProject(db, resolveProjectIdentity(directory))).toEqual([]);
    });
    it("invalid trial sends nothing even when the allowlist matches", async () => {
        useTempDataHome("turn-one-invalid-trial-");
        const sessionId = "ses-invalid-trial";
        const directory = "/tmp/turn-one-invalid-trial";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        seedPriorCompartment(db, sessionId);
        const fixture = authorizationFixture(
            {
                lane: "opencode-1",
                carrier: "opencode-session",
                provider: "test",
                modelId: "fixture-historian",
                variant: null,
                temperature: null,
                thinkingLevel: null,
            },
            COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT,
            [],
            HISTORIAN_FORMAT_INSTRUCTION,
        );
        const { client, prompt } = historianClient(directory, () => REPLY_WITH_FACTS);
        for (const candidate of [
            fixture.request.requestedIdentity,
            { ...fixture.request.requestedIdentity, lane: "omp" as const },
            { ...fixture.request.requestedIdentity, carrier: "pi-historian-rpc" as const },
        ]) {
            await runHistorian(db, sessionId, client, directory, {
                memoryLifecycleAllowlist: {
                    entries: [fixture.request.requestedIdentity],
                    validatedProfiles: fixture.rows,
                },
                memoryLifecycleTrialAuthorization: { candidate, attestedRoot: directory },
            });
        }
        expect(sentPrompts(prompt)).toEqual([]);
        expect(getCompartments(db, sessionId)).toHaveLength(1);
        expect(publications(db)).toEqual([]);
        expect(pendingFacts(db)).toEqual([]);
        expect(getMemoriesByProject(db, resolveProjectIdentity(directory))).toEqual([]);
    });

    it("three enabled parse failures survive restart and a growing chunk before dormant fallback", async () => {
        useTempDataHome("turn-one-counter-");
        const sessionId = "ses-counter";
        const directory = "/tmp/turn-one-counter";
        createOpenCodeSession(sessionId);
        let db = openDatabase();
        seedPriorCompartment(db, sessionId);
        let reply = "not compartment XML";
        const { client, prompt } = historianClient(directory, () => reply);
        const options = { memoryLifecycleLane: "enabled" as const, forceDrainQuota: true };
        await runHistorian(db, sessionId, client, directory, options);
        await runHistorian(db, sessionId, client, directory, options);
        expect(sentPrompts(prompt)).toHaveLength(2);
        closeDatabase();
        db = openDatabase();
        const raw = new Database(join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db"));
        try {
            raw.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
                "m-10",
                sessionId,
                10,
                10,
                JSON.stringify({ id: "m-10", role: "user", sessionID: sessionId }),
            );
            raw.prepare(
                "INSERT INTO part (message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)",
            ).run(
                "m-10",
                sessionId,
                10,
                10,
                JSON.stringify({ type: "text", text: "Appended tail" }),
            );
        } finally {
            raw.close();
        }
        await runHistorian(db, sessionId, client, directory, options);
        expect(sentPrompts(prompt)).toHaveLength(3);
        expect(getCompartments(db, sessionId)).toHaveLength(1);
        expect(pendingFacts(db)).toEqual([]);
        const failures = db
            .prepare(
                "SELECT publication_id,run_attempt,stage_key,request_json FROM memory_stage_attempts WHERE state='parse_failed' ORDER BY run_attempt",
            )
            .all() as Array<{
            publication_id: string;
            run_attempt: number;
            stage_key: string;
            request_json: string;
        }>;
        expect(failures).toHaveLength(3);
        expect(new Set(failures.map((row) => row.publication_id)).size).toBe(1);
        expect(failures.map((row) => row.run_attempt)).toEqual([1, 2, 3]);
        expect(failures.map((row) => JSON.parse(row.request_json).firstMessageId)).toEqual([
            "m-3",
            "m-3",
            "m-3",
        ]);
        expect(sentPrompts(prompt)[2]).not.toBe(sentPrompts(prompt)[1]);
        reply = REPLY_WITH_FACTS.replace('end="4"', 'end="5"');
        await runHistorian(db, sessionId, client, directory, options);
        expect(sentPrompts(prompt)).toHaveLength(4);
        expect(sentPrompts(prompt)[3]).not.toContain(HISTORIAN_FORMAT_INSTRUCTION);
        expect(getCompartments(db, sessionId)).toHaveLength(2);
        expect(pendingFacts(db)).toEqual([]);
        expect(
            db
                .prepare(
                    "SELECT run_attempt FROM memory_stage_attempts WHERE state='counter_reset'",
                )
                .all(),
        ).toEqual([{ run_attempt: 4 }]);
    });
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
    it("an enabled turn-one timeout retains its stage without retrying the provider send", async () => {
        useTempDataHome("turn-one-unknown-timeout-");
        const sessionId = "ses-unknown-timeout";
        const directory = "/tmp/turn-one-unknown-timeout";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        seedPriorCompartment(db, sessionId);
        const { client, events } = twoTurnClient(directory, null);
        const original = createV1HiddenCompletionExecutor(client, db, directory);
        let released = 0;
        const executor = {
            ...original,
            close: async (...input: Parameters<typeof original.close>) => {
                released++;
                await original.close(...input);
            },
            attempt: async (...input: Parameters<typeof original.attempt>) => {
                await original.attempt(...input);
                throw new Error("provider timed out");
            },
        };
        await runHistorian(db, sessionId, client, directory, {
            memoryLifecycleLane: "enabled",
            hiddenCompletionExecutor: executor,
        });
        expect(events).toEqual(["prompt:ses-child-1:1"]);
        expect(
            db.prepare("SELECT state FROM memory_stage_attempts WHERE stage='turn_one'").get(),
        ).toEqual({ state: "sending" });
        expect(getCompartments(db, sessionId)).toHaveLength(1);
        expect(pendingFacts(db)).toEqual([]);
        await sweepDormantTurnTwo(db, resolveProjectIdentity(directory));
        expect(released).toBe(1);
        expect(
            db.prepare("SELECT state FROM memory_stage_attempts WHERE stage='turn_one'").get(),
        ).toEqual({ state: "revoked" });
    });
    it("OpenCode turn-one reply revoked in flight publishes nothing and releases once", async () => {
        useTempDataHome("turn-one-revoked-");
        const sessionId = "ses-turn-one-revoked";
        const directory = "/tmp/turn-one-revoked";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        seedPriorCompartment(db, sessionId);
        let enabled = true;
        const { client, events } = twoTurnClient(directory, null);
        const messages = client.session.messages.bind(client.session);
        client.session.messages = (async (...input: Parameters<typeof messages>) => {
            enabled = false;
            return messages(...input);
        }) as typeof client.session.messages;
        await runHistorian(db, sessionId, client, directory, {
            memoryLifecycleLane: "enabled",
            historianTurnTwoIsEnabled: () => enabled,
        });
        expect(getCompartments(db, sessionId)).toHaveLength(1);
        expect(pendingFacts(db)).toEqual([]);
        expect(publications(db).map((row) => row.commit_order)).toEqual([null]);
        expect(events).toEqual(["prompt:ses-child-1:1", "delete:ses-child-1"]);
    });
    for (const outcome of ["reply", "expired"] as const)
        it(`OpenCode unknown turn one reattaches without resending then resolves ${outcome}`, async () => {
            useTempDataHome(`turn-one-reattach-${outcome}-`);
            const sessionId = `ses-reattach-${outcome}`;
            const directory = `/tmp/turn-one-reattach-${outcome}`;
            createOpenCodeSession(sessionId);
            const db = openDatabase();
            seedPriorCompartment(db, sessionId);
            const { client, events } = twoTurnClient(directory, (prompt) =>
                JSON.stringify({
                    result: {
                        step: "turn_two",
                        decisions: [...prompt.matchAll(/^## Fact (\d+)/gm)].map((m) => ({
                            fact_id: Number(m[1]),
                            check: "Audit fixture.",
                            action: "abstain",
                        })),
                    },
                }),
            );
            const original = createV1HiddenCompletionExecutor(client, db, directory);
            let first = true;
            let state: "active" | "terminal" | "unavailable" = "active";
            const executor = {
                ...original,
                collect: async (...input: Parameters<typeof original.collect>) => {
                    if (first) {
                        first = false;
                        throw new Error("historian response read failed");
                    }
                    return original.collect(...input);
                },
                recoveryState: async () => state,
                recover: async (id: string) => original.collect({ id, childSessionId: id }, 50),
            };
            const options = {
                memoryLifecycleLane: "enabled" as const,
                hiddenCompletionExecutor: executor,
                forceDrainQuota: true,
            };
            await runHistorian(db, sessionId, client, directory, options);
            const stage = db
                .prepare("SELECT stage_key FROM memory_stage_attempts WHERE state='sending'")
                .get();
            expect(stage).not.toBeNull();
            await runHistorian(db, sessionId, client, directory, options);
            expect(events).toEqual(["prompt:ses-child-1:1"]);
            expect(getCompartments(db, sessionId)).toHaveLength(1);
            expect(pendingFacts(db)).toEqual([]);
            state = outcome === "reply" ? "terminal" : "unavailable";
            await runHistorian(db, sessionId, client, directory, options);
            await settleHistorianTurnTwoRuns();
            expect(
                db
                    .prepare("SELECT stage_key FROM memory_stage_attempts WHERE stage='turn_one'")
                    .all(),
            ).toEqual([stage]);
            expect(getCompartments(db, sessionId)).toHaveLength(outcome === "reply" ? 2 : 1);
            expect(events).toEqual(
                outcome === "reply"
                    ? ["prompt:ses-child-1:1", "prompt:ses-child-1:2", "delete:ses-child-1"]
                    : ["prompt:ses-child-1:1", "delete:ses-child-1"],
            );
        });

    it("automatic authorization persists requested bytes and freezes a known answering fallback", async () => {
        useTempDataHome("turn-one-frozen-fallback-");
        const sessionId = "ses-frozen-fallback";
        const directory = "/tmp/turn-one-frozen-fallback";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        seedPriorCompartment(db, sessionId);
        const requested = authorizationFixture(
            {
                lane: "opencode-1",
                carrier: "opencode-session",
                provider: "test",
                modelId: "fixture-historian",
                variant: null,
                temperature: null,
                thinkingLevel: null,
            },
            COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT,
            [],
            HISTORIAN_FORMAT_INSTRUCTION,
        );
        const fallback = authorizationFixture(
            { ...requested.request.requestedIdentity, modelId: "known-fallback" },
            COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT,
            [],
            HISTORIAN_FORMAT_INSTRUCTION,
        );
        const { client } = twoTurnClient(
            directory,
            (prompt) =>
                JSON.stringify({
                    result: {
                        step: "turn_two",
                        decisions: [...prompt.matchAll(/^## Fact (\d+)/gm)].map((match) => ({
                            fact_id: Number(match[1]),
                            check: "Audit fixture.",
                            action: "abstain",
                        })),
                    },
                }),
            undefined,
            "known-fallback",
        );
        await runHistorian(db, sessionId, client, directory, {
            memoryLifecycleAllowlist: {
                entries: [requested.request.requestedIdentity, fallback.request.requestedIdentity],
                validatedProfiles: [...requested.rows, ...fallback.rows],
            },
        });
        await settleHistorianTurnTwoRuns();
        const row = db
            .prepare(
                "SELECT request_json,reported_profile_json FROM memory_stage_attempts WHERE stage='turn_one'",
            )
            .get() as { request_json: string; reported_profile_json: string };
        const request = JSON.parse(row.request_json);
        expect(request.requestedIdentity).toEqual(requested.request.requestedIdentity);
        expect(request.system).toBe(COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT);
        expect(request.formatInstruction).toBe(HISTORIAN_FORMAT_INSTRUCTION);
        expect(request.prompt).toContain(HISTORIAN_FORMAT_INSTRUCTION);
        expect(JSON.parse(row.reported_profile_json)).toEqual(fallback.profile);
        expect(
            db.prepare("SELECT state FROM memory_stage_attempts WHERE stage='turn_two'").get(),
        ).toEqual({ state: "resolved" });
        expect(getMemoriesByProject(db, resolveProjectIdentity(directory))).toEqual([]);
    });
    it("OpenCode late reply after off applies nothing, charges nothing and releases once", async () => {
        useTempDataHome("turn-two-live-off-");
        const sessionId = "ses-live-off";
        const directory = "/tmp/turn-two-live-off";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        seedPriorCompartment(db, sessionId);
        let enabled = true;
        const { client, events } = twoTurnClient(directory, (prompt) => {
            enabled = false;
            return JSON.stringify({
                result: {
                    step: "turn_two",
                    decisions: [...prompt.matchAll(/^## Fact (\d+)/gm)].map((m) => ({
                        fact_id: Number(m[1]),
                        check: "Audit fixture.",
                        action: "new",
                    })),
                },
            });
        });
        await runHistorian(db, sessionId, client, directory, {
            memoryLifecycleLane: "enabled",
            historianTurnTwoIsEnabled: () => enabled,
        });
        await settleHistorianTurnTwoRuns();
        expect(getMemoriesByProject(db, resolveProjectIdentity(directory))).toEqual([]);
        expect(db.prepare("SELECT state,fact_attempts FROM memory_pending_facts").all()).toEqual([
            { state: "retryable", fact_attempts: 0 },
            { state: "retryable", fact_attempts: 0 },
        ]);
        expect(events.filter((event) => event.startsWith("delete:"))).toEqual([
            "delete:ses-child-1",
        ]);
    });

    it("one dormant OpenCode firing sweeps a sending stage without charging an attempt", async () => {
        useTempDataHome("turn-two-dormant-sweep-");
        const sessionId = "ses-dormant-sweep";
        const directory = "/tmp/turn-two-dormant-sweep";
        createOpenCodeSession(sessionId);
        const db = openDatabase();
        seedPriorCompartment(db, sessionId);
        const { client, events } = twoTurnClient(directory, null);
        await runHistorian(db, sessionId, client, directory, { memoryLifecycleLane: "enabled" });
        await settleHistorianTurnTwoRuns();
        expect(
            db.prepare("SELECT state FROM memory_stage_attempts WHERE stage='turn_two'").get(),
        ).toEqual({ state: "sending" });
        await runHistorian(db, sessionId, client, directory, { historianTurnTwo: "off" });
        expect(db.prepare("SELECT state,fact_attempts FROM memory_pending_facts").all()).toEqual([
            { state: "retryable", fact_attempts: 0 },
            { state: "retryable", fact_attempts: 0 },
        ]);
        expect(events.filter((event) => event.startsWith("delete:"))).toEqual([
            "delete:ses-child-1",
        ]);
        expect(getMemoriesByProject(db, resolveProjectIdentity(directory))).toEqual([]);
    });

    /**
     * A host whose hidden children answer turn one with `REPLY_WITH_FACTS` and a
     * later prompt in the same child with `turnTwo(prompt)`. `events` records every
     * prompt and delete in order, by child session id.
     */
    function twoTurnClient(
        directory: string,
        turnTwo: ((prompt: string) => string) | null,
        beforeTurnTwo?: Promise<void>,
        answeredModel = "fixture-historian",
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
                        if (turn === 1)
                            replies.set(
                                id,
                                text.includes(HISTORIAN_FORMAT_INSTRUCTION)
                                    ? combinedFixture.turnOne(REPLY_WITH_FACTS)
                                    : REPLY_WITH_FACTS,
                            );
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
                                modelID: answeredModel,
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
                result: {
                    step: "turn_two",
                    decisions: ids.map((id) => ({
                        fact_id: id,
                        check: "Audit fixture.",
                        action: "new",
                    })),
                },
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
                    result: {
                        step: "turn_two",
                        decisions: [...prompt.matchAll(/^## Fact (\d+)/gm)].map((match) => ({
                            fact_id: Number(match[1]),
                            check: "Audit fixture.",
                            action: "abstain",
                        })),
                    },
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
