/// <reference types="bun-types" />

/**
 * The `historian.turn_two` switch is re-read after the provider replies.
 *
 * A historian run keeps one child alive across two replies. If the user switches
 * turn two to `"off"` while the first reply is settling, the run has to revoke it
 * instead of applying decisions the user just turned off. That is why the hosts
 * pass a callback the runner calls after each reply, and not only the value they
 * sampled when the run was scheduled.
 *
 * This file proves it with a real `LiveConfigReader` over a real config file that
 * is rewritten mid-run, so the callback reads the switch exactly the way the
 * hosts' production wiring does. The runner suites only cover fixtures that hand
 * it a plain boolean.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginConfigDetailed } from "../../config";
import { historianRunConfig } from "../../config/live-run-config";
import { LiveConfigReader } from "../../config/live-snapshot";
import {
    acquireCompartmentLease,
    releaseCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import {
    getCompartments,
    replaceAllCompartments,
} from "../../features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { getMemoriesByProject } from "../../features/magic-context/memory/storage-memory";
import { HISTORIAN_FORMAT_INSTRUCTION } from "../../features/magic-context/memory/turn-one-publication";
import { authorizationFixture } from "../../features/magic-context/memory/turn-two-test-fixtures.test";
import {
    closeDatabase,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import type { PluginContext } from "../../plugin/types";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { openCode2TurnTwoDeps } from "../../v2/hooks/context";
import { COMPARTMENT_AGENT_COMBINED_SYSTEM_PROMPT } from "./compartment-prompt";
import * as runnerModule from "./compartment-runner";
import { runCompartmentAgent } from "./compartment-runner";
import { settleHistorianTurnTwoRuns } from "./historian-turn-two-step";
import { createMagicContextHook } from "./hook";
import { createLiveSessionState } from "./live-session-state";
import {
    clearProducerModelObservations,
    observeProducerModelsForTest,
    prepareProducerFixture,
} from "./producer-window-test-support";
import { __ignoredNotificationTest } from "./send-session-notification";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

const SESSION = "ses-live-switch";
let DIRECTORY = "";

const HISTORIAN_MODEL = "test/fixture-historian";

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

/** A throwaway project directory, used for both the run and the live reader. */
function useProjectDirectory(prefix: string): string {
    DIRECTORY = tempDir(prefix);
    return DIRECTORY;
}

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

/** A throwaway user-config home, so the reader watches a file only this test writes. */
function useTempConfigHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_CONFIG_HOME = dir;
}

function tempDir(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

/**
 * Write the user-level config file the live reader watches. `historian.turn_two`
 * is user-only, so a project file would be stripped and never reach the reader.
 */
function writeTurnTwo(turnTwo: "allowlist" | "off"): void {
    const userDirectory = join(process.env.XDG_CONFIG_HOME!, "cortexkit");
    mkdirSync(userDirectory, { recursive: true });
    writeFileSync(
        join(userDirectory, "magic-context.jsonc"),
        JSON.stringify({ historian: { turn_two: turnTwo } }),
    );
}

/** The reader shape the hosts build, polled before it is asked for its value. */
function liveReader(directory: string) {
    const reader = new LiveConfigReader(
        directory,
        loadPluginConfigDetailed(directory, false).config,
        () => loadPluginConfigDetailed(directory, false).config,
        () => {},
    );
    reader.poll();
    return reader;
}

/** `true` while turn two is on, read the way a host's callback reads it. */
function readSwitch(reader: ReturnType<typeof liveReader>): boolean {
    return reader.poll().effective.historian?.turn_two !== "off";
}

beforeEach(async () => {
    await observeProducerModelsForTest([HISTORIAN_MODEL]);
    __ignoredNotificationTest.setHoldDetector(() => false);
});

afterEach(async () => {
    await settleHistorianTurnTwoRuns();
    clearProducerModelObservations();
    __ignoredNotificationTest.reset();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    tempDirs.length = 0;
});

function createOpenCodeSession(sessionId: string): void {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(join(dbPath, ".."), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS part (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        `);
        [
            { id: "m-1", role: "user", text: "zero" },
            { id: "m-2", role: "assistant", text: "one" },
            { id: "m-3", role: "user", text: "Cap the upload at 64 KiB." },
            { id: "m-4", role: "assistant", text: "Done." },
            ...[5, 6, 7, 8, 9].map((n) => ({ id: `m-${n}`, role: "user", text: `protected ${n}` })),
        ].forEach((message, index) => {
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

function seedPriorCompartment(db: Database, sessionId: string): void {
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
}

/**
 * A host whose child answers turn one with XML and a later prompt in the same
 * child with a turn-two reply that asks to keep every fact. `events` records each
 * prompt and delete in order.
 */
function twoTurnClient(directory: string) {
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
                    const factIds = [...text.matchAll(/^## Fact (\d+)/gm)].map((m) => Number(m[1]));
                    replies.set(
                        id,
                        turn === 1
                            ? text.includes(HISTORIAN_FORMAT_INSTRUCTION)
                                ? combinedFixture.turnOne(REPLY_WITH_FACTS)
                                : REPLY_WITH_FACTS
                            : JSON.stringify({
                                  result: {
                                      step: "turn_two",
                                      decisions: factIds.map((factId) => ({
                                          fact_id: factId,
                                          check: "Audit fixture.",
                                          action: "new",
                                      })),
                                  },
                              }),
                    );
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

function pendingFacts(db: Database) {
    return db.prepare("SELECT state, fact_attempts FROM memory_pending_facts ORDER BY id").all();
}

describe("the OpenCode 1 runner re-reads the switch after turn one's reply", () => {
    it("a reload to off during the run leaves the facts unapplied", async () => {
        useTempDataHome("turn-two-live-switch-");
        useTempConfigHome("turn-two-live-config-");
        useProjectDirectory("turn-two-live-project-");
        createOpenCodeSession(SESSION);
        const db = openDatabase();
        seedPriorCompartment(db, SESSION);

        // The reader production builds, over a real config file. The run's own
        // directory is the same one, so the reader answers about this project.
        writeTurnTwo("allowlist");
        const reader = liveReader(DIRECTORY);
        expect(readSwitch(reader)).toBe(true);

        const { client, events } = twoTurnClient(DIRECTORY);
        // Flip the switch only once turn one has answered. Reading the file at
        // start time would prove nothing about a reload made mid-run.
        const messages = client.session.messages.bind(client.session);
        client.session.messages = (async (...input: Parameters<typeof messages>) => {
            const result = await messages(...input);
            writeTurnTwo("off");
            return result;
        }) as typeof client.session.messages;

        const holder = "holder-live";
        expect(acquireCompartmentLease(db, SESSION, holder)).not.toBeNull();
        try {
            await runCompartmentAgent(
                await prepareProducerFixture({
                    client,
                    db,
                    sessionId: SESSION,
                    historianChunkTokens: 10_000,
                    directory: DIRECTORY,
                    compartmentLeaseHolderId: holder,
                    memoryLifecycleLane: "enabled",
                    historianTwoPass: false,
                    historianTurnTwo: "allowlist",
                    forceDrainQuota: true,
                    // Turn two applies only for an allowlisted identity, exactly as
                    // the wiring tests establish; this row set is that allowlist.
                    memoryLifecycleValidatedProfiles: combinedFixture.rows,
                    // What the hosts now pass: re-read, never the start-time value.
                    historianTurnTwoIsEnabled: () => readSwitch(reader),
                }),
            );
        } finally {
            releaseCompartmentLease(db, SESSION, holder);
        }
        await settleHistorianTurnTwoRuns();

        // The file really moved, so the callback could not have answered from boot.
        expect(reader.poll().effective.historian?.turn_two).toBe("off");
        // The run revoked before publishing: nothing from the reply was applied,
        // no candidate was written, and the child was released once.
        expect(getCompartments(db, SESSION)).toHaveLength(1);
        expect(getMemoriesByProject(db, resolveProjectIdentity(DIRECTORY))).toEqual([]);
        expect(pendingFacts(db)).toEqual([]);
        expect(events.filter((event) => event.startsWith("delete:"))).toHaveLength(1);
    });

    it("with the switch left on, the same run applies the facts", async () => {
        useTempDataHome("turn-two-live-switch-on-");
        useTempConfigHome("turn-two-live-config-on-");
        useProjectDirectory("turn-two-live-project-on-");
        createOpenCodeSession(SESSION);
        const db = openDatabase();
        seedPriorCompartment(db, SESSION);
        writeTurnTwo("allowlist");
        const reader = liveReader(DIRECTORY);
        const { client } = twoTurnClient(DIRECTORY);
        const holder = "holder-live-on";
        expect(acquireCompartmentLease(db, SESSION, holder)).not.toBeNull();
        try {
            await runCompartmentAgent(
                await prepareProducerFixture({
                    client,
                    db,
                    sessionId: SESSION,
                    historianChunkTokens: 10_000,
                    directory: DIRECTORY,
                    compartmentLeaseHolderId: holder,
                    memoryLifecycleLane: "enabled",
                    historianTwoPass: false,
                    historianTurnTwo: "allowlist",
                    forceDrainQuota: true,
                    // Turn two applies only for an allowlisted identity, exactly as
                    // the wiring tests establish; this row set is that allowlist.
                    memoryLifecycleValidatedProfiles: combinedFixture.rows,
                    historianTurnTwoIsEnabled: () => readSwitch(reader),
                }),
            );
        } finally {
            releaseCompartmentLease(db, SESSION, holder);
        }
        await settleHistorianTurnTwoRuns();
        expect(
            getMemoriesByProject(db, resolveProjectIdentity(DIRECTORY))
                .map((memory) => memory.content)
                .sort(),
        ).toEqual(["Uploads are capped at 64 KiB.", "Uploads go through the gateway."]);
    });
});

describe("the OpenCode 1 host builds a live callback from its own config sampling", () => {
    it("the callback the hook passes the runner follows a real reload", async () => {
        useTempConfigHome("turn-two-live-hook-config-");
        useProjectDirectory("turn-two-live-hook-project-");
        writeTurnTwo("allowlist");
        const reader = liveReader(DIRECTORY);
        const config = loadPluginConfigDetailed(DIRECTORY, false).config;
        createOpenCodeSession(SESSION);
        const db = openDatabase();
        seedPriorCompartment(db, SESSION);
        updateSessionMeta(db, SESSION, { compartmentInProgress: true });
        const captured: HiddenCompartmentRunnerDeps[] = [];
        const start = spyOn(runnerModule, "startCompartmentAgent").mockImplementation(
            (deps: HiddenCompartmentRunnerDeps) => {
                captured.push(deps);
            },
        );
        try {
            const hook = createMagicContextHook({
                client: {
                    session: {
                        list: async () => ({ data: [] }),
                        get: async () => ({ data: { directory: DIRECTORY } }),
                        create: async () => ({ data: { id: "ses-child" } }),
                        prompt: async () => ({}),
                        promptAsync: async () => ({}),
                        messages: async () => ({ data: [] }),
                        delete: async () => ({}),
                    },
                } as unknown as PluginContext["client"],
                tagger: createTagger(),
                scheduler: { shouldExecute: () => "defer" },
                compactionHandler: { onCompacted: () => {} },
                directory: DIRECTORY,
                config,
                // What `create-session-hooks.ts` wires in production: the same live
                // reader, polled again on every sample.
                sampleHistorianConfig: () => reader.poll().effective,
                contextUsageMap: new Map([
                    [
                        SESSION,
                        {
                            usage: { percentage: 25, inputTokens: 50_000 },
                            updatedAt: Date.now(),
                        },
                    ],
                ]),
                liveSessionState: createLiveSessionState(),
            } as never);
            expect(hook).not.toBeNull();
            await hook!["experimental.chat.messages.transform"]!({}, {
                messages: [
                    { id: "m-1", role: "user", text: "zero" },
                    { id: "m-2", role: "assistant", text: "one" },
                    { id: "m-3", role: "user", text: "Cap the upload at 64 KiB." },
                    { id: "m-4", role: "assistant", text: "Done." },
                ].map((message) => ({
                    info: { id: message.id, role: message.role, sessionID: SESSION },
                    parts: [{ type: "text", text: message.text }],
                })),
            } as never);
            expect(captured.length).toBeGreaterThan(0);
            const deps = captured.at(-1)!;
            // The host forwards a callback, not just the value it sampled.
            expect(typeof deps.historianTurnTwoIsEnabled).toBe("function");
            expect(deps.historianTurnTwoIsEnabled?.()).toBe(true);
            // A real reload to the user config is visible through that callback.
            writeTurnTwo("off");
            expect(deps.historianTurnTwoIsEnabled?.()).toBe(false);
        } finally {
            start.mockRestore();
        }
    });
});

describe("the OpenCode 2 host re-samples the switch through its live reader", () => {
    it("the turn-two deps its transform receives follow a real reload", () => {
        useTempConfigHome("turn-two-live-v2-config-");
        useProjectDirectory("turn-two-live-v2-project-");
        writeTurnTwo("allowlist");
        const boot = loadPluginConfigDetailed(DIRECTORY, false).config;
        const reader = new LiveConfigReader(
            DIRECTORY,
            boot,
            () => loadPluginConfigDetailed(DIRECTORY, false).config,
            () => {},
        );
        reader.poll();
        // `openCode2TurnTwoDeps` builds exactly the two fields the transform gets.
        const deps = openCode2TurnTwoDeps(boot, () => {
            return historianRunConfig(boot, reader.poll().effective).historian?.turn_two;
        });
        expect(deps.historianTurnTwo).toBe("allowlist");
        expect(typeof deps.historianTurnTwoIsEnabled).toBe("function");
        expect(deps.historianTurnTwoIsEnabled?.()).toBe(true);
        writeTurnTwo("off");
        expect(deps.historianTurnTwoIsEnabled?.()).toBe(false);
    });
});
