import {
    __resetNotificationStateForTests,
    drainNotifications,
} from "../../shared/rpc-notifications";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    acquireCompartmentLease,
    releaseCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import {
    getCompartments,
    getSessionFacts,
    replaceAllCompartmentState,
    replaceAllCompartments,
} from "../../features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import {
    getMemoriesByProject,
    insertMemory,
} from "../../features/magic-context/memory/storage-memory";
import {
    acquireWrapupInProgress,
    closeDatabase,
    getHistorianFailureState,
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
    incrementHistorianFailure,
    loadProtectedTailMeta,
    openDatabase,
    recordOverflowDetected,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { rebaseSessionCoordinates } from "../../features/magic-context/store-generation-rebase";
import { createTagger } from "../../features/magic-context/tagger";
import type { PluginContext } from "../../plugin/types";
import * as shared from "../../shared";
import { Database, withPrivilegedWriter, withSqliteTransformPass } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "./compartment-prompt";
import {
    executeContextRecomp as executeContextRecompImpl,
    executeContextRecompWithResult as executeContextRecompWithResultImpl,
    getActiveCompartmentRun,
    registerActiveCompartmentRun,
    runCompartmentAgent as runCompartmentAgentImpl,
    startCompartmentAgent as startCompartmentAgentImpl,
} from "./compartment-runner";
import { resolveHistorianProducerWindow } from "./historian-prompt-fit";
import { renderHistorianMemoryBlock } from "./inject-compartments";
import { producerPromptFailureReason } from "./producer-window-guard";
import {
    clearProducerModelObservations,
    observeProducerModelsForTest,
    prepareProducerFixture,
} from "./producer-window-test-support";
import {
    hasRunnableCompartmentWindow,
    resolveOpenCodeProtectedTailBoundary,
} from "./protected-tail-boundary";
import { readRawSessionMessages } from "./read-session-chunk";
import { estimateTokens } from "./read-session-formatting";
import { __ignoredNotificationTest } from "./send-session-notification";
import { tagMessages } from "./tag-messages";

const runCompartmentAgent: typeof runCompartmentAgentImpl = async (deps) =>
    runCompartmentAgentImpl(await prepareProducerFixture(deps));
const executeContextRecomp: typeof executeContextRecompImpl = async (deps, options) =>
    executeContextRecompImpl(await prepareProducerFixture(deps), options);
const executeContextRecompWithResult: typeof executeContextRecompWithResultImpl = async (
    deps,
    options,
) => executeContextRecompWithResultImpl(await prepareProducerFixture(deps), options);
const startCompartmentAgent: typeof startCompartmentAgentImpl = (deps, runAgent) =>
    startCompartmentAgentImpl(
        runAgent ? deps : { ...deps, model: deps.model ?? "test/fixture-historian" },
        runAgent,
    );

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(async () => {
    await observeProducerModelsForTest(["test/fixture-historian"]);
    // These fixtures end on real user rows, so the notice hold would queue.
    // This file tests recomp behavior, not that gate.
    __ignoredNotificationTest.setHoldDetector(() => false);
});

async function runCompartmentAgentWithLease(
    deps: Parameters<typeof runCompartmentAgent>[0],
): Promise<void> {
    const holderId = `test-holder-${Math.random()}`;
    expect(acquireCompartmentLease(deps.db, deps.sessionId, holderId)).not.toBeNull();
    try {
        await runCompartmentAgent({ ...deps, compartmentLeaseHolderId: holderId });
    } finally {
        releaseCompartmentLease(deps.db, deps.sessionId, holderId);
    }
}

afterEach(() => {
    clearProducerModelObservations();
    __ignoredNotificationTest.reset();
    __resetNotificationStateForTests();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            // Ignore EBUSY on Windows
        }
    }
    tempDirs.length = 0;

    // Clean up historian debug dumps created during tests
    const dumpDir = join(tmpdir(), "magic-context-historian");
    try {
        rmSync(dumpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        // Ignore EBUSY on Windows
    }
});

describe("executeContextRecomp", () => {
    it("rebuilds from raw history and ignores broken stored compartments as source truth", async () => {
        useTempDataHome("magic-recomp-rebuild-");
        createOpenCodeDb("ses-recomp", [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "eligible three" },
            { id: "m-4", role: "assistant", text: "eligible four" },
            { id: "m-5", role: "user", text: "protected 1" },
            { id: "m-6", role: "user", text: "protected 2" },
            { id: "m-7", role: "user", text: "protected 3" },
            { id: "m-8", role: "user", text: "protected 4" },
            { id: "m-9", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        replaceAllCompartments(db, "ses-recomp", [
            {
                sequence: 0,
                startMessage: 3,
                endMessage: 4,
                startMessageId: "m-3",
                endMessageId: "m-4",
                title: "broken",
                content: "broken summary",
            },
        ]);
        replaceAllCompartmentState(
            db,
            "ses-recomp",
            [
                {
                    sequence: 0,
                    startMessage: 3,
                    endMessage: 4,
                    startMessageId: "m-3",
                    endMessageId: "m-4",
                    title: "broken",
                    content: "broken summary",
                },
            ],
            [{ category: "WORKFLOW_RULES", content: "Old fact." }],
        );

        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/recomp" } })),
                create: mock(async () => ({ data: { id: "ses-agent-recomp" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<compartment start="1" end="4" title="Recovered history"><p1>Recovered summary</p1></compartment>\n<CONSTRAINTS>\n* Rebuilt fact.\n</CONSTRAINTS>`,
                                },
                            ],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        const result = await executeContextRecomp({
            client,
            db,
            sessionId: "ses-recomp",
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        expect(result).toContain("Rebuilt 1 compartment across 1 historian pass");
        expect(result).toContain("Covered raw history 1-4");
        expect(getRpcNotificationTexts(client.session.prompt as ReturnType<typeof mock>)).toContain(
            "## Magic Recomp\n\nHistorian pass 1, attempt 1 started for messages 1-4.",
        );
        expect(getCompartments(db, "ses-recomp")).toEqual([
            expect.objectContaining({
                startMessage: 1,
                endMessage: 4,
                startMessageId: "m-1",
                endMessageId: "m-4",
                title: "Recovered history",
            }),
        ]);
        // v2: recomp is structural only — it does NOT write session_facts
        // (facts are a promoted-memory concern, and recomp must not re-emit
        // facts that could degrade curated memories).
        expect(getSessionFacts(db, "ses-recomp")).toHaveLength(0);
    });

    it("aborts after winning the recomp lease if a wrapup marker appeared meanwhile", async () => {
        useTempDataHome("magic-recomp-wrapup-race-");
        const sessionId = "ses-recomp-wrapup-race";
        createOpenCodeDb(sessionId, [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);

        const client = {
            session: {
                get: mock(async () => {
                    throw new Error("recomp runner should not start under a live wrapup");
                }),
                create: mock(async () => ({ data: { id: "unused" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({ data: [] })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        const result = await executeContextRecompWithResult(
            {
                client,
                db,
                sessionId,
                historianChunkTokens: 10_000,
                directory: "/tmp",
            },
            {
                onLeaseAcquired: () => {
                    const acquired = acquireWrapupInProgress(db, sessionId, {
                        holderId: "wrapup-holder",
                        messagesToKeep: 5,
                        anchorRawMessageCount: 7,
                        targetEligibleEndOrdinal: 3,
                        lastCompartmentEnd: -1,
                        chunkIndex: 0,
                        expectedChunks: 1,
                    });
                    expect(acquired.ok).toBe(true);
                },
            },
        );

        expect(result.published).toBe(false);
        expect(result.message).toContain("/ctx-wrapup is already compacting");
        expect(client.session.get).not.toHaveBeenCalled();
        expect(getCompartments(db, sessionId)).toHaveLength(0);
        expect(
            db
                .prepare("SELECT 1 FROM compartment_state_lease WHERE session_id = ?")
                .get(sessionId) ?? null,
        ).toBeNull();
    });

    it.each([
        1, 2,
    ])("keeps old state before progress and promotes validated progress when historian pass %i fails", async (failingPass) => {
        useTempDataHome("magic-recomp-fail-closed-");
        createOpenCodeDb("ses-recomp-fail", [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "eligible three" },
            { id: "m-4", role: "assistant", text: "eligible four" },
            { id: "m-5", role: "user", text: "eligible five" },
            { id: "m-6", role: "assistant", text: "eligible six" },
            { id: "m-7", role: "user", text: "protected 1" },
            { id: "m-8", role: "user", text: "protected 2" },
            { id: "m-9", role: "user", text: "protected 3" },
            { id: "m-10", role: "user", text: "protected 4" },
            { id: "m-11", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        replaceAllCompartments(db, "ses-recomp-fail", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "m-1",
                endMessageId: "m-2",
                title: "published",
                content: "published summary",
            },
        ]);
        replaceAllCompartmentState(
            db,
            "ses-recomp-fail",
            [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "m-1",
                    endMessageId: "m-2",
                    title: "published",
                    content: "published summary",
                },
            ],
            [{ category: "WORKFLOW_RULES", content: "Published fact." }],
        );

        let historianAttempt = 0;
        const messages = mock(async () => {
            historianAttempt += 1;
            const callIndex = historianAttempt;
            if (callIndex === 1) {
                return {
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<compartment start="1" end="2" title="Chunk one"><p1>Chunk one summary</p1></compartment>\n<WORKFLOW_RULES>\n* Candidate fact.\n</WORKFLOW_RULES>\n<unprocessed_from>3</unprocessed_from>`,
                                },
                            ],
                        },
                    ],
                };
            }
            return { data: [] };
        });
        const prompt = mock(async () => {
            const callIndex = prompt.mock.calls.length;
            if (callIndex >= failingPass) {
                throw new Error("historian pass failed");
            }
            return {};
        });

        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/recomp-fail" } })),
                create: mock(async () => ({ data: { id: "ses-agent-recomp-fail" } })),
                prompt,
                messages,
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        const result = await executeContextRecomp({
            client,
            db,
            sessionId: "ses-recomp-fail",
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        // Only historian requests use prompt now; progress no longer consumes mock calls.
        expect(result).toContain("(MC-R01)");
        expect(getCompartments(db, "ses-recomp-fail")).toEqual([
            expect.objectContaining({
                startMessage: 1,
                endMessage: 2,
                title: failingPass === 1 ? "published" : "Chunk one",
                content: failingPass === 1 ? "published summary" : "Chunk one summary",
            }),
        ]);
        // Recomp publishes structure only; a published replacement has no legacy session facts.
        expect(getSessionFacts(db, "ses-recomp-fail")).toEqual(
            failingPass === 1
                ? [
                      expect.objectContaining({
                          category: "WORKFLOW_RULES",
                          content: "Published fact.",
                      }),
                  ]
                : [],
        );
    });

    it("retries once when historian skips a visible message and then publishes the repaired recomp result", async () => {
        useTempDataHome("magic-recomp-repair-retry-");
        createOpenCodeDb("ses-recomp-retry", [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "eligible three" },
            { id: "m-4", role: "assistant", text: "eligible four" },
            { id: "m-5", role: "user", text: "protected 1" },
            { id: "m-6", role: "user", text: "protected 2" },
            { id: "m-7", role: "user", text: "protected 3" },
            { id: "m-8", role: "user", text: "protected 4" },
            { id: "m-9", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();

        const prompt = mock(async () => ({}));
        // Two distinct `session.messages` consumers now share this mock:
        //  - the HISTORIAN output fetch (targets the agent session, passes
        //    `query.directory`)
        //  - notification model-pinning via resolvePromptContext (targets the
        //    MAIN session, `query.limit` only, NO directory)
        // Discriminate on `query.directory` so the historian-pass counter only
        // advances on real historian fetches; prompt-context reads resolve to
        // null (empty data) → no pin, harmless.
        let historianFetches = 0;
        const messages = mock(async (input: { query?: { directory?: string } }) => {
            if (!input?.query?.directory) return { data: [] };
            historianFetches += 1;
            if (historianFetches === 1) {
                return {
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<compartment start="1" end="1" title="Part one"><p1>One</p1></compartment>\n<compartment start="3" end="4" title="Part two"><p1>Two</p1></compartment>`,
                                },
                            ],
                        },
                    ],
                };
            }

            return {
                data: [
                    {
                        info: { role: "assistant", time: { created: 2 } },
                        parts: [
                            {
                                type: "text",
                                text: `<compartment start="1" end="4" title="Recovered history"><p1>Recovered summary</p1></compartment>\n<CONSTRAINTS>\n* Rebuilt fact.\n</CONSTRAINTS>`,
                            },
                        ],
                    },
                ],
            };
        });

        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/recomp-retry" } })),
                create: mock(async () => ({ data: { id: "ses-agent-retry" } })),
                prompt,
                messages,
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        const result = await executeContextRecomp({
            client,
            db,
            sessionId: "ses-recomp-retry",
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        // The narrative gap rejects, and the repair attempt covers the same raw chunk.
        expect(result).toContain("Rebuilt 1 compartment across 1 historian pass");
        expect(historianFetches).toBe(2);
        expect(getHistorianPromptCount(prompt)).toBe(2);
        expect(getRpcNotificationTexts(prompt)).toEqual(
            expect.arrayContaining([
                "## Magic Recomp\n\nHistorian pass 1, attempt 1 started for messages 1-4.",
                expect.stringContaining(
                    "History compression is retrying this pass. History compression could not be rebuilt. Run /ctx-recomp again. (MC-R01)",
                ),
            ]),
        );
        expect(getCompartments(db, "ses-recomp-retry")).toEqual([
            expect.objectContaining({
                startMessage: 1,
                endMessage: 4,
                title: "Recovered history",
            }),
        ]);
    });

    it("retries flat v1 output and publishes the repaired tiered result", async () => {
        useTempDataHome("magic-recomp-flat-repair-");
        const sessionId = "ses-recomp-flat-repair";
        createOpenCodeDb(sessionId, [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "eligible three" },
            { id: "m-4", role: "assistant", text: "eligible four" },
            { id: "m-5", role: "user", text: "protected 1" },
            { id: "m-6", role: "user", text: "protected 2" },
            { id: "m-7", role: "user", text: "protected 3" },
            { id: "m-8", role: "user", text: "protected 4" },
            { id: "m-9", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        let historianFetches = 0;
        const messages = mock(async (input: { query?: { directory?: string } }) => {
            if (!input.query?.directory) return { data: [] };
            historianFetches += 1;
            const text =
                historianFetches === 1
                    ? `<output><compartment start="1" end="4" title="flat">flat summary</compartment></output>`
                    : `<output><compartment start="1" end="4" title="repaired"><p1>tiered summary</p1></compartment></output>`;
            return {
                data: [
                    {
                        info: { role: "assistant", time: { created: historianFetches } },
                        parts: [{ type: "text", text }],
                    },
                ],
            };
        });
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/flat-repair" } })),
                create: mock(async () => ({ data: { id: `ses-agent-${historianFetches}` } })),
                prompt: mock(async () => ({})),
                messages,
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        const result = await executeContextRecomp({
            client,
            db,
            sessionId,
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        expect(result).toContain("## Magic Recomp — Complete");
        expect(historianFetches).toBe(2);
        expect(getCompartments(db, sessionId)).toEqual([
            expect.objectContaining({ title: "repaired", p1: "tiered summary", legacy: 0 }),
        ]);
    });

    it("reports a published recomp complete and signaled when post-publish project registration throws", async () => {
        useTempDataHome("magic-recomp-post-publish-throw-");
        const sessionId = "ses-recomp-post-publish-throw";
        createOpenCodeDb(sessionId, [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "eligible three" },
            { id: "m-4", role: "assistant", text: "eligible four" },
            { id: "m-5", role: "user", text: "protected 1" },
            { id: "m-6", role: "user", text: "protected 2" },
            { id: "m-7", role: "user", text: "protected 3" },
            { id: "m-8", role: "user", text: "protected 4" },
            { id: "m-9", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/post-publish-throw" } })),
                create: mock(async () => ({ data: { id: "ses-agent-post-publish" } })),
                prompt: mock(async () => ({})),
                messages: mock(async (input: { query?: { directory?: string } }) => {
                    if (!input.query?.directory) return { data: [] };
                    return {
                        data: [
                            {
                                info: { role: "assistant", time: { created: 1 } },
                                parts: [
                                    {
                                        type: "text",
                                        text: `<output><compartment start="1" end="4" title="rebuilt"><p1>summary</p1></compartment></output>`,
                                    },
                                ],
                            },
                        ],
                    };
                }),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];
        const onPublished = mock(() => undefined);

        const result = await executeContextRecomp({
            client,
            db,
            sessionId,
            historianChunkTokens: 10_000,
            directory: "/tmp",
            ensureProjectRegistered: async () => {
                throw new Error("embedding provider unavailable");
            },
            onCompartmentStatePublished: onPublished,
        });

        expect(result).toContain("## Magic Recomp — Complete");
        expect(onPublished).toHaveBeenCalledWith(sessionId);
        expect(getCompartments(db, sessionId)).toEqual([
            expect.objectContaining({ title: "rebuilt", endMessage: 4 }),
        ]);
    });

    it("records exhausted flat v1 output without writing legacy rows", async () => {
        useTempDataHome("magic-recomp-flat-exhausted-");
        const sessionId = "ses-recomp-flat-exhausted";
        createOpenCodeDb(sessionId, [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/flat-exhausted" } })),
                create: mock(async () => ({ data: { id: "ses-agent-flat" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<output><compartment start="1" end="2" title="flat">flat summary</compartment></output>`,
                                },
                            ],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        const result = await executeContextRecomp({
            client,
            db,
            sessionId,
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        expect(result).toContain("(MC-R01)");
        expect(getCompartments(db, sessionId)).toHaveLength(0);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM compartments WHERE session_id = ? AND legacy = 1",
                )
                .get(sessionId),
        ).toEqual({ count: 0 });
        expect(
            db
                .prepare(
                    "SELECT status, failure_reason FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
                )
                .get(sessionId),
        ).toEqual({
            status: "failed",
            failure_reason: expect.stringContaining("missing the tiered paraphrase structure"),
        });
    });

    it("accepts full-state historian output on a later recomp pass", async () => {
        useTempDataHome("magic-recomp-full-state-");
        createOpenCodeDb("ses-recomp-full-state", [
            { id: "m-1", role: "user", text: "one" },
            { id: "m-2", role: "assistant", text: "two" },
            { id: "m-3", role: "user", text: "three" },
            { id: "m-4", role: "user", text: "protected 1" },
            { id: "m-5", role: "user", text: "protected 2" },
            { id: "m-6", role: "user", text: "protected 3" },
            { id: "m-7", role: "user", text: "protected 4" },
            { id: "m-8", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();

        const prompt = mock(async () => ({}));
        // Discriminate historian-output fetches (pass `query.directory`) from
        // notification model-pinning reads (resolvePromptContext: `query.limit`
        // only, no directory) so the historian-pass counter is accurate.
        let historianFetches = 0;
        const messages = mock(async (input: { query?: { directory?: string } }) => {
            if (!input?.query?.directory) return { data: [] };
            historianFetches += 1;
            if (historianFetches === 1) {
                return {
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<compartment start="1" end="2" title="Pass one"><p1>Initial summary</p1></compartment>`,
                                },
                            ],
                        },
                    ],
                };
            }

            return {
                data: [
                    {
                        info: { role: "assistant", time: { created: 2 } },
                        parts: [
                            {
                                type: "text",
                                text: `<compartment start="3" end="3" title="Pass two"><p1>Next summary</p1></compartment>\n<PROJECT_RULES>\n* Rewritten fact.\n</PROJECT_RULES>`,
                            },
                        ],
                    },
                ],
            };
        });

        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/recomp-full-state" } })),
                create: mock(async () => ({ data: { id: "ses-agent-recomp-full-state" } })),
                prompt,
                messages,
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        const result = await executeContextRecomp({
            client,
            db,
            sessionId: "ses-recomp-full-state",
            // Budget sized so chunking packs ~2 messages per pass with the real
            // Claude tokenizer (ai-tokenizer). The previous value of 7 relied on
            // the `/3.5` heuristic fallback and no longer reproduces a 2-pass
            // split with accurate tokenization.
            historianChunkTokens: 13,
            directory: "/tmp",
        });

        expect(result).toContain("Rebuilt 2 compartments across 2 historian passes");
        expect(getCompartments(db, "ses-recomp-full-state")).toEqual([
            expect.objectContaining({
                startMessage: 1,
                endMessage: 2,
                content: "Initial summary",
            }),
            expect.objectContaining({ startMessage: 3, endMessage: 3, content: "Next summary" }),
        ]);
        // v2: recomp is structural only — no session_facts written.
        expect(getSessionFacts(db, "ses-recomp-full-state")).toHaveLength(0);
    });

    it("returns a timeout failure and keeps progress visible when a historian pass hangs", async () => {
        useTempDataHome("magic-recomp-timeout-");
        createOpenCodeDb("ses-recomp-timeout", [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "eligible three" },
            { id: "m-4", role: "assistant", text: "eligible four" },
            { id: "m-5", role: "user", text: "protected 1" },
            { id: "m-6", role: "user", text: "protected 2" },
            { id: "m-7", role: "user", text: "protected 3" },
            { id: "m-8", role: "user", text: "protected 4" },
            { id: "m-9", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();

        const prompt = mock(async (input: { body?: { noReply?: boolean } }) => {
            if (input.body?.noReply === true) {
                return {};
            }
            return {};
        });
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/recomp-timeout" } })),
                create: mock(async () => ({ data: { id: "ses-agent-timeout" } })),
                prompt,
                messages: mock(async () => ({ data: [] })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        const promptSyncSpy = spyOn(shared, "promptSyncWithModelSuggestionRetry").mockRejectedValue(
            new Error("prompt timed out after 300000ms"),
        );

        let result = "";
        try {
            result = await withImmediateTimeouts(async () => {
                return executeContextRecomp({
                    client,
                    db,
                    sessionId: "ses-recomp-timeout",
                    historianChunkTokens: 10_000,
                    historianTimeoutMs: 300_000,
                    directory: "/tmp",
                });
            });
        } finally {
            promptSyncSpy.mockRestore();
        }

        expect(result).toContain("(MC-R01)");
        expect(getRpcNotificationTexts(prompt)).toContain(
            "## Magic Recomp\n\nHistorian pass 1, attempt 1 started for messages 1-4.",
        );
        expect(getCompartments(db, "ses-recomp-timeout")).toHaveLength(0);
    });

    it("shrinks the failing chunk after invalid repair output and continues recomp", async () => {
        useTempDataHome("magic-recomp-smaller-chunk-");
        createOpenCodeDb("ses-recomp-smaller", [
            { id: "m-1", role: "user", text: "eligible one with a bit more text" },
            { id: "m-2", role: "assistant", text: "eligible two with a bit more text" },
            { id: "m-3", role: "user", text: "eligible three with a bit more text" },
            { id: "m-4", role: "assistant", text: "eligible four with a bit more text" },
            { id: "m-5", role: "user", text: "eligible five with a bit more text" },
            { id: "m-6", role: "assistant", text: "eligible six with a bit more text" },
            { id: "m-7", role: "user", text: "protected 1" },
            { id: "m-8", role: "user", text: "protected 2" },
            { id: "m-9", role: "user", text: "protected 3" },
            { id: "m-10", role: "user", text: "protected 4" },
            { id: "m-11", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();

        let lastHistorianPrompt = "";
        let historianAttempt = 0;
        const prompt = mock(
            async (input: { body?: { noReply?: boolean; parts?: Array<{ text?: string }> } }) => {
                if (input.body?.noReply !== true) {
                    lastHistorianPrompt = input.body?.parts?.[0]?.text ?? "";
                }
                return {};
            },
        );
        const messages = mock(async () => {
            historianAttempt += 1;
            const ordinals = [...lastHistorianPrompt.matchAll(/\[(\d+)(?:-(\d+))?\]/g)]
                .flatMap((match) => [match[1], match[2] ?? match[1]])
                .map((value) => Number(value))
                .filter((value) => Number.isFinite(value));
            const chunkStart = ordinals.length > 0 ? Math.min(...ordinals) : 1;
            const chunkEnd = ordinals.length > 0 ? Math.max(...ordinals) : 1;

            if (chunkStart === 1 && chunkEnd === 6) {
                return {
                    data: [
                        {
                            info: { role: "assistant", time: { created: historianAttempt } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<compartment start="1" end="1" title="Bad one"><p1>One</p1></compartment>\n<compartment start="3" end="6" title="Bad two"><p1>Two</p1></compartment>`,
                                },
                            ],
                        },
                    ],
                };
            }

            return {
                data: [
                    {
                        info: { role: "assistant", time: { created: historianAttempt } },
                        parts: [
                            {
                                type: "text",
                                text: `<compartment start="${chunkStart}" end="${chunkEnd}" title="Chunk ${chunkStart}-${chunkEnd}"><p1>Chunk ${chunkStart}-${chunkEnd} summary</p1></compartment>\n<WORKFLOW_RULES>\n* Final fact.\n</WORKFLOW_RULES>`,
                            },
                        ],
                    },
                ],
            };
        });

        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/recomp-smaller" } })),
                create: mock(async () => ({ data: { id: "ses-agent-smaller" } })),
                prompt,
                messages,
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        const result = await executeContextRecomp({
            client,
            db,
            sessionId: "ses-recomp-smaller",
            historianChunkTokens: 80,
            directory: "/tmp",
        });

        // Both full-size attempts omit narrative ordinal 2, so recomp must shrink
        // the chunk rather than absorbing the gap.
        expect(result).toContain("## Magic Recomp");
        expect(result).toContain("Covered raw history 1-6");
        expect(getRpcNotificationTexts(prompt)).toEqual(
            expect.arrayContaining([
                "## Magic Recomp\n\nHistorian pass 1, attempt 1 started for messages 1-6.",
            ]),
        );
        expect(getCompartments(db, "ses-recomp-smaller")).toEqual([
            expect.objectContaining({ startMessage: 1, endMessage: 3 }),
            expect.objectContaining({ startMessage: 4, endMessage: 6 }),
        ]);
    });

    it("fails closed when shrinking cannot produce a smaller effective chunk", async () => {
        useTempDataHome("magic-recomp-no-smaller-");
        createOpenCodeDb("ses-recomp-no-smaller", [
            { id: "m-1", role: "assistant", text: "one" },
            { id: "m-2", role: "assistant", text: "two" },
            { id: "m-3", role: "assistant", text: "three" },
            { id: "m-4", role: "assistant", text: "four" },
            { id: "m-5", role: "assistant", text: "five" },
            { id: "m-6", role: "assistant", text: "six" },
            { id: "m-7", role: "user", text: "protected 1" },
            { id: "m-8", role: "user", text: "protected 2" },
            { id: "m-9", role: "user", text: "protected 3" },
            { id: "m-10", role: "user", text: "protected 4" },
            { id: "m-11", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();

        let lastHistorianPrompt = "";
        const prompt = mock(
            async (input: { body?: { noReply?: boolean; parts?: Array<{ text?: string }> } }) => {
                if (input.body?.noReply !== true) {
                    lastHistorianPrompt = input.body?.parts?.[0]?.text ?? "";
                }
                return {};
            },
        );
        const messages = mock(async () => {
            const ordinals = [...lastHistorianPrompt.matchAll(/\[(\d+)(?:-(\d+))?\]/g)]
                .flatMap((match) => [match[1], match[2] ?? match[1]])
                .map((value) => Number(value))
                .filter((value) => Number.isFinite(value));
            const chunkStart = ordinals.length > 0 ? Math.min(...ordinals) : 1;
            const chunkEnd = ordinals.length > 0 ? Math.max(...ordinals) : 1;

            return {
                data: [
                    {
                        info: { role: "assistant", time: { created: messages.mock.calls.length } },
                        parts: [
                            {
                                type: "text",
                                text: `<compartment start="${chunkStart}" end="${chunkStart + 2}" title="Bad one"><p1>One</p1></compartment>\n<compartment start="${chunkStart + 1}" end="${chunkEnd}" title="Bad two"><p1>Two</p1></compartment>`,
                            },
                        ],
                    },
                ],
            };
        });
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/recomp-no-smaller" } })),
                create: mock(async () => ({ data: { id: "ses-agent-no-smaller" } })),
                prompt,
                messages,
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        const result = await executeContextRecomp({
            client,
            db,
            sessionId: "ses-recomp-no-smaller",
            historianChunkTokens: 80,
            directory: "/tmp",
        });

        // Overlapping compartments are NOT healed by gap healing, so retry/shrink triggers.
        expect(result).toContain("(MC-R01)");
        expect(getRpcNotificationTexts(prompt)).toEqual(
            expect.arrayContaining([
                "## Magic Recomp\n\nHistorian pass 1, attempt 1 started for messages 1-6.",
                expect.stringContaining(
                    "History compression is retrying this pass. History compression could not be rebuilt. Run /ctx-recomp again. (MC-R01)",
                ),
            ]),
        );
        expect(
            getRpcNotificationTexts(prompt).some((text) =>
                text.includes("Retrying with a smaller chunk ending at"),
            ),
        ).toBe(false);
        expect(getCompartments(db, "ses-recomp-no-smaller")).toHaveLength(0);
        expect(getSessionFacts(db, "ses-recomp-no-smaller")).toHaveLength(0);
    });

    it("resets to the original token budget after a successful smaller-chunk pass", async () => {
        useTempDataHome("magic-recomp-budget-reset-");
        createOpenCodeDb("ses-recomp-budget-reset", [
            { id: "m-1", role: "user", text: "short one" },
            { id: "m-2", role: "assistant", text: "short two" },
            { id: "m-3", role: "user", text: "short three" },
            { id: "m-4", role: "assistant", text: "short four" },
            { id: "m-5", role: "user", text: "short five" },
            { id: "m-6", role: "assistant", text: "short six" },
            {
                id: "m-7",
                role: "user",
                text: "this message is intentionally much longer so only the original budget can still include it after the smaller split succeeds",
            },
            { id: "m-8", role: "user", text: "protected 1" },
            { id: "m-9", role: "user", text: "protected 2" },
            { id: "m-10", role: "user", text: "protected 3" },
            { id: "m-11", role: "user", text: "protected 4" },
            { id: "m-12", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();

        let lastHistorianPrompt = "";
        const prompt = mock(
            async (input: { body?: { noReply?: boolean; parts?: Array<{ text?: string }> } }) => {
                if (input.body?.noReply !== true) {
                    lastHistorianPrompt = input.body?.parts?.[0]?.text ?? "";
                }
                return {};
            },
        );
        const messages = mock(async () => {
            const ordinals = [...lastHistorianPrompt.matchAll(/\[(\d+)(?:-(\d+))?\]/g)]
                .flatMap((match) => [match[1], match[2] ?? match[1]])
                .map((value) => Number(value))
                .filter((value) => Number.isFinite(value));
            const chunkStart = ordinals.length > 0 ? Math.min(...ordinals) : 1;
            const chunkEnd = ordinals.length > 0 ? Math.max(...ordinals) : 1;

            if (chunkStart === 1 && chunkEnd === 6) {
                return {
                    data: [
                        {
                            info: {
                                role: "assistant",
                                time: { created: messages.mock.calls.length },
                            },
                            parts: [
                                {
                                    type: "text",
                                    text: `<compartment start="1" end="1" title="Bad one"><p1>One</p1></compartment>\n<compartment start="3" end="6" title="Bad two"><p1>Two</p1></compartment>`,
                                },
                            ],
                        },
                    ],
                };
            }

            return {
                data: [
                    {
                        info: { role: "assistant", time: { created: messages.mock.calls.length } },
                        parts: [
                            {
                                type: "text",
                                text: `<compartment start="${chunkStart}" end="${chunkEnd}" title="Chunk ${chunkStart}-${chunkEnd}"><p1>Chunk ${chunkStart}-${chunkEnd} summary</p1></compartment>\n<WORKFLOW_RULES>\n* Final fact.\n</WORKFLOW_RULES>`,
                            },
                        ],
                    },
                ],
            };
        });
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/recomp-budget-reset" } })),
                create: mock(async () => ({ data: { id: "ses-agent-budget-reset" } })),
                prompt,
                messages,
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        const result = await executeContextRecomp({
            client,
            db,
            sessionId: "ses-recomp-budget-reset",
            historianChunkTokens: 60,
            directory: "/tmp",
        });

        // Invalid full-size attempts force a smaller chunk; a successful smaller
        // pass must not permanently reduce the budget for the following pass.
        expect(result).toContain("Covered raw history 1-7");
        expect(getRpcNotificationTexts(prompt)).toEqual(
            expect.arrayContaining([
                "## Magic Recomp\n\nHistorian pass 1, attempt 1 started for messages 1-6.",
                "## Magic Recomp\n\nHistorian pass 2, attempt 1 started for messages 5-7.",
            ]),
        );
    });
});

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function createOpenCodeDb(
    sessionId: string,
    messages: Array<{
        id: string;
        role: string;
        text?: string;
        toolOnly?: boolean;
        parts?: unknown[];
    }>,
): void {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
      CREATE TABLE IF NOT EXISTS message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS part (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);

        const insertMessage = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        const insertPart = db.prepare(
            "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );

        messages.forEach((message, index) => {
            const timestamp = index + 1;
            insertMessage.run(
                message.id,
                sessionId,
                timestamp,
                timestamp,
                JSON.stringify({ id: message.id, role: message.role, sessionID: sessionId }),
            );
            if (message.parts) {
                for (const part of message.parts) {
                    insertPart.run(
                        message.id,
                        sessionId,
                        timestamp,
                        timestamp,
                        JSON.stringify(part),
                    );
                }
                return;
            }
            if (message.toolOnly) {
                insertPart.run(
                    message.id,
                    sessionId,
                    timestamp,
                    timestamp,
                    JSON.stringify({ type: "tool", callID: `call-${index}` }),
                );
            }
            if (message.text) {
                insertPart.run(
                    message.id,
                    sessionId,
                    timestamp,
                    timestamp,
                    JSON.stringify({ type: "text", text: message.text }),
                );
            }
        });
    } finally {
        closeQuietly(db);
    }
}

function getRpcNotificationTexts(promptMock: ReturnType<typeof mock>): string[] {
    const ignored = promptMock.mock.calls
        .map((call) => call[0] as { body?: { noReply?: boolean } })
        .filter((input) => input.body?.noReply === true);
    expect(ignored).toEqual([]);
    return drainNotifications()
        .filter((notice) => notice.type === "toast")
        .map((notice) => String(notice.payload.message));
}

function getHistorianPromptCount(promptMock: ReturnType<typeof mock>): number {
    return promptMock.mock.calls
        .map((call) => call[0] as { body?: { noReply?: boolean } })
        .filter((input) => input.body?.noReply !== true).length;
}

async function withImmediateTimeouts<T>(callback: () => Promise<T>): Promise<T> {
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => {
        queueMicrotask(() => {
            if (typeof handler === "function") {
                handler(...args);
            }
        });
        return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    try {
        return await callback();
    } finally {
        globalThis.setTimeout = originalSetTimeout;
    }
}

function _getHistorianDumpContents(sessionId: string): string[] {
    const dumpDir = join(tmpdir(), "magic-context-historian");
    try {
        return readdirSync(dumpDir)
            .filter((name) => name.includes(sessionId))
            .map((name) => readFileSync(join(dumpDir, name), "utf8"));
    } catch {
        return [];
    }
}

describe("runCompartmentAgent", () => {
    it("keeps historian writes outside the foreground pass that launched it", async () => {
        useTempDataHome("compartment-runner-background-scope-");
        const db = openDatabase();
        const sessionId = "ses-background-scope";
        getOrCreateSessionMeta(db, sessionId);
        let attempts = 0;
        let callbacks = 0;
        let failure: unknown;
        await withSqliteTransformPass(async () => {
            startCompartmentAgent(
                {
                    client: {} as PluginContext["client"],
                    db,
                    sessionId,
                    historianChunkTokens: 10000,
                    directory: "/tmp",
                },
                async () => {
                    await Promise.resolve();
                    const exec = spyOn(db, "exec").mockImplementation(() => {
                        attempts++;
                        throw Object.assign(new Error("background busy"), { code: "SQLITE_BUSY" });
                    });
                    const wait = spyOn(Atomics, "wait").mockReturnValue("timed-out");
                    try {
                        withPrivilegedWriter(db, () => {
                            callbacks++;
                        });
                    } catch (error) {
                        failure = error;
                    } finally {
                        exec.mockRestore();
                        wait.mockRestore();
                    }
                },
            );
            await getActiveCompartmentRun(sessionId)?.promise;
        });
        expect(attempts).toBe(1);
        expect(callbacks).toBe(0);
        expect((failure as Error).message).toBe("background busy");
    });
    it("clears compartment-in-progress when another process holds the lease", () => {
        useTempDataHome("compartment-runner-lease-denied-");
        const db = openDatabase();
        const holderId = "external-holder";
        expect(acquireCompartmentLease(db, "ses-lease-denied", holderId)).not.toBeNull();
        updateSessionMeta(db, "ses-lease-denied", { compartmentInProgress: true });

        try {
            startCompartmentAgent({
                client: {} as PluginContext["client"],
                db,
                sessionId: "ses-lease-denied",
                historianChunkTokens: 10_000,
                directory: "/tmp",
            });

            expect(getActiveCompartmentRun("ses-lease-denied")).toBeUndefined();
            expect(getOrCreateSessionMeta(db, "ses-lease-denied").compartmentInProgress).toBe(
                false,
            );
        } finally {
            releaseCompartmentLease(db, "ses-lease-denied", holderId);
        }
    });

    it("skips trigger-fired compartment starts while /ctx-wrapup is active", () => {
        useTempDataHome("compartment-runner-wrapup-active-");
        const db = openDatabase();
        const sessionId = "ses-wrapup-active-skip";
        acquireWrapupInProgress(db, sessionId, {
            holderId: "wrapup-holder",
            messagesToKeep: 20,
            anchorRawMessageCount: 100,
            targetEligibleEndOrdinal: 80,
            lastCompartmentEnd: 0,
            chunkIndex: 0,
            expectedChunks: 1,
        });
        updateSessionMeta(db, sessionId, { compartmentInProgress: true });

        startCompartmentAgent({
            client: {} as PluginContext["client"],
            db,
            sessionId,
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        const leaseRow = db
            .prepare(
                "SELECT holder_id AS holderId FROM compartment_state_lease WHERE session_id = ?",
            )
            .get(sessionId) as { holderId: string } | null;
        expect(leaseRow).toBeNull();
        expect(getActiveCompartmentRun(sessionId)).toBeUndefined();
        expect(getOrCreateSessionMeta(db, sessionId).compartmentInProgress).toBe(false);
    });

    it("allows trigger-fired compartment starts after an expired /ctx-wrapup marker", async () => {
        useTempDataHome("compartment-runner-wrapup-expired-");
        const sessionId = "ses-wrapup-expired-start";
        createOpenCodeDb(sessionId, [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        acquireWrapupInProgress(
            db,
            sessionId,
            {
                holderId: "expired-wrapup-holder",
                messagesToKeep: 20,
                anchorRawMessageCount: 100,
                targetEligibleEndOrdinal: 80,
                lastCompartmentEnd: 0,
                chunkIndex: 0,
                expectedChunks: 1,
            },
            Date.now() - 10 * 60_000,
        );
        updateSessionMeta(db, sessionId, { compartmentInProgress: true });
        const createSession = mock(async () => ({ data: { id: "ses-agent-expired" } }));
        const prompt = mock(async () => ({}));
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/wrapup-expired" } })),
                create: createSession,
                prompt,
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: '<compartment start="1" end="2" title="Expired marker"><p1>Expired marker run.</p1></compartment>',
                                },
                            ],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        startCompartmentAgent({
            client,
            db,
            sessionId,
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });
        const active = getActiveCompartmentRun(sessionId);
        expect(active).toBeDefined();
        await active?.promise;

        expect(createSession).toHaveBeenCalledTimes(1);
        expect(prompt).toHaveBeenCalled();
    });

    it("records opencode_db_missing as a historian no-fire instead of silently returning", async () => {
        useTempDataHome("compartment-runner-missing-opencode-db-");
        const db = openDatabase();

        await runCompartmentAgentWithLease({
            client: {} as PluginContext["client"],
            db,
            sessionId: "ses-missing-opencode-db",
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        expect(getOrCreateSessionMeta(db, "ses-missing-opencode-db").compartmentInProgress).toBe(
            false,
        );
        expect(
            db
                .prepare(
                    "SELECT status, failure_reason FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
                )
                .get("ses-missing-opencode-db"),
        ).toEqual({ status: "noop", failure_reason: "opencode_db_missing" });
    });

    it("clears compartment-in-progress after successful compartment generation", async () => {
        useTempDataHome("compartment-runner-reset-");
        createOpenCodeDb("ses-1", [
            { id: "m-1", role: "user", text: "First" },
            { id: "m-2", role: "assistant", text: "Second" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        updateSessionMeta(db, "ses-1", {
            timesExecuteThresholdReached: 3,
            compartmentInProgress: true,
        });

        const getSession = mock(async () => ({ data: { directory: "/tmp/parent" } }));
        const createSession = mock(
            async (_input: {
                body: { parentID: string; title: string };
                query: { directory: string };
            }) => ({ data: { id: "ses-agent" } }),
        );
        const promptSession = mock(
            async (_input: { body: { agent: string; parts: Array<{ text: string }> } }) => ({}),
        );
        const messages = mock(async () => ({
            data: [
                {
                    info: { role: "assistant", time: { created: 1 } },
                    parts: [
                        {
                            type: "text",
                            text: `<compartment start="1" end="2" title="Docs and setup"><p1>Summary content</p1></compartment>\n<WORKFLOW_RULES>\n* Commit to feat first\n</WORKFLOW_RULES>`,
                        },
                    ],
                },
            ],
        }));
        const deleteSession = mock(async () => ({}));

        const client = {
            session: {
                get: getSession,
                create: createSession,
                prompt: promptSession,
                messages,
                delete: deleteSession,
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-1",
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        const meta = getOrCreateSessionMeta(db, "ses-1");
        expect(meta.compartmentInProgress).toBe(false);
        const compartments = getCompartments(db, "ses-1");
        expect(compartments).toHaveLength(1);
        expect(compartments[0]?.startMessageId).toBe("m-1");
        expect(compartments[0]?.endMessageId).toBe("m-2");
        expect(createSession.mock.calls[0]?.[0]).toEqual({
            body: { parentID: "ses-1", title: "magic-context-compartment" },
            query: { directory: "/tmp/parent" },
        });
        expect(promptSession.mock.calls[0]?.[0]?.body.agent).toBe("historian");
        expect(
            db.prepare("SELECT harness FROM historian_runs WHERE session_id = ?").all("ses-1"),
        ).toEqual([{ harness: "opencode" }]);
    });

    it("keeps both chunk-edge compartments when emergency recovery is armed", async () => {
        useTempDataHome("compartment-runner-emergency-discard-last-");
        const sessionId = "ses-emergency-discard-last";
        createOpenCodeDb(sessionId, [
            { id: "m-1", role: "user", text: "First eligible message" },
            { id: "m-2", role: "assistant", text: "Second eligible message" },
            { id: "m-3", role: "user", text: "Third eligible message" },
            { id: "m-4", role: "assistant", text: "Fourth eligible message" },
            { id: "m-5", role: "user", text: "protected 1" },
            { id: "m-6", role: "user", text: "protected 2" },
            { id: "m-7", role: "user", text: "protected 3" },
            { id: "m-8", role: "user", text: "protected 4" },
            { id: "m-9", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        recordOverflowDetected(db, sessionId, 4_096, "anthropic/test");

        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/emergency-discard-last" } })),
                create: mock(async () => ({ data: { id: "ses-agent-emergency-discard-last" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<compartment start="1" end="2" title="First"><p1>First summary</p1></compartment>\n<compartment start="3" end="4" title="Second"><p1>Second summary</p1></compartment>`,
                                },
                            ],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId,
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        expect(getCompartments(db, sessionId).map((compartment) => compartment.endMessage)).toEqual(
            [2, 4],
        );
        expect(
            db
                .prepare(
                    "SELECT discarded_last FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
                )
                .get(sessionId),
        ).toEqual({ discarded_last: 0 });
    });

    it("keeps a committed publish succeeded and signaled when post-commit project registration throws", async () => {
        useTempDataHome("compartment-runner-post-commit-registration-throw-");
        createOpenCodeDb("ses-post-commit-registration", [
            { id: "m-1", role: "user", text: "First" },
            { id: "m-2", role: "assistant", text: "Second" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        const projectDirectory = "/tmp/post-commit-registration";
        const onPublished = mock(() => undefined);
        const ensureProjectRegistered = mock(async () => {
            throw new Error("embedding provider unavailable");
        });

        const client = {
            session: {
                get: mock(async () => ({ data: { directory: projectDirectory } })),
                create: mock(async () => ({ data: { id: "ses-agent-post-commit" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<compartment start="1" end="2" title="Published"><p1>Summary</p1></compartment>\n<PROJECT_RULES>\n* Durable fact survives registration outage.\n</PROJECT_RULES>`,
                                },
                            ],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-post-commit-registration",
            historianChunkTokens: 10_000,
            directory: "/tmp",
            ensureProjectRegistered,
            onCompartmentStatePublished: onPublished,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getCompartments(db, "ses-post-commit-registration")).toHaveLength(1);
        expect(loadProtectedTailMeta(db, "ses-post-commit-registration").priorBoundaryOrdinal).toBe(
            3,
        );
        expect(onPublished).toHaveBeenCalledWith("ses-post-commit-registration");
        expect(
            getOrCreateSessionMeta(db, "ses-post-commit-registration").compartmentInProgress,
        ).toBe(false);
        expect(
            getMemoriesByProject(db, resolveProjectIdentity(projectDirectory)).map(
                (memory) => memory.content,
            ),
        ).toContain("Durable fact survives registration outage.");
        expect(
            db
                .prepare(
                    "SELECT status FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
                )
                .get("ses-post-commit-registration"),
        ).toEqual({ status: "success" });
    });

    for (const variant of [
        {
            name: "the compaction-marker update throws",
            // Caught where it is raised, so the steps after it still run.
            laterStepsRun: true,
            deps: () => ({
                compactionMarkerStrategy: {
                    publish: () => {
                        throw Object.assign(new Error("database is locked"), {
                            code: "SQLITE_BUSY",
                        });
                    },
                },
            }),
        },
        {
            // Not caught where it is raised, so this exercises the run's outer handler.
            name: "the deferred-marker signal throws",
            laterStepsRun: false,
            deps: () => ({
                preserveInjectionCacheUntilConsumed: true,
                onDeferredMarkerPending: () => {
                    throw new Error("signal consumer failed");
                },
            }),
        },
    ]) {
        it(`keeps a committed publish succeeded when ${variant.name} after COMMIT`, async () => {
            useTempDataHome("compartment-runner-post-commit-step-throw-");
            const sessionId = "ses-post-commit-step";
            createOpenCodeDb(sessionId, [
                { id: "m-1", role: "user", text: "First" },
                { id: "m-2", role: "assistant", text: "Second" },
                { id: "m-3", role: "user", text: "protected 1" },
                { id: "m-4", role: "user", text: "protected 2" },
                { id: "m-5", role: "user", text: "protected 3" },
                { id: "m-6", role: "user", text: "protected 4" },
                { id: "m-7", role: "user", text: "protected 5" },
            ]);
            const db = openDatabase();
            const onPublished = mock(() => undefined);
            const prompt = mock(async () => ({}));
            const client = {
                session: {
                    get: mock(async () => ({ data: { directory: "/tmp/post-commit-step" } })),
                    create: mock(async () => ({ data: { id: "ses-agent-post-commit-step" } })),
                    prompt,
                    messages: mock(async () => ({
                        data: [
                            {
                                info: { role: "assistant", time: { created: 1 } },
                                parts: [
                                    {
                                        type: "text",
                                        text: `<compartment start="1" end="2" title="Published"><p1>Summary</p1></compartment>`,
                                    },
                                ],
                            },
                        ],
                    })),
                    delete: mock(async () => ({})),
                },
            } as unknown as PluginContext["client"];

            await runCompartmentAgentWithLease({
                client,
                db,
                sessionId,
                historianChunkTokens: 10_000,
                directory: "/tmp",
                onCompartmentStatePublished: onPublished,
                ...variant.deps(),
            });

            expect(getCompartments(db, sessionId)).toHaveLength(1);
            expect(onPublished).toHaveBeenCalledWith(sessionId);
            // A post-publish step failing must not count as a historian failure or be
            // announced as one.
            expect(getHistorianFailureState(db, sessionId).failureCount).toBe(0);
            expect(getRpcNotificationTexts(prompt).join("\n")).not.toContain("failed");
            expect(getOrCreateSessionMeta(db, sessionId).compartmentInProgress).toBe(false);
            const run = db
                .prepare(
                    "SELECT status, compartments_produced FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
                )
                .get(sessionId) as { status: string; compartments_produced: number };
            expect(run.status).toBe("success");
            if (variant.laterStepsRun) expect(run.compartments_produced).toBe(1);
        });
    }

    it("rolls back compartments and boundary when durable fact insertion fails inside publish tx", async () => {
        useTempDataHome("compartment-runner-fact-insert-rollback-");
        createOpenCodeDb("ses-fact-insert-rollback", [
            { id: "m-1", role: "user", text: "First" },
            { id: "m-2", role: "assistant", text: "Second" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        db.exec(
            "CREATE TRIGGER fail_memory_insert BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'memory insert fail'); END;",
        );
        const onPublished = mock(() => undefined);

        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/fact-insert-rollback" } })),
                create: mock(async () => ({ data: { id: "ses-agent-fact-insert" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<compartment start="1" end="2" title="Should roll back"><p1>Summary</p1></compartment>\n<PROJECT_RULES>\n* This fact insert fails.\n</PROJECT_RULES>`,
                                },
                            ],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-fact-insert-rollback",
            historianChunkTokens: 10_000,
            directory: "/tmp",
            onCompartmentStatePublished: onPublished,
        });

        expect(getCompartments(db, "ses-fact-insert-rollback")).toEqual([]);
        expect(
            getMemoriesByProject(db, resolveProjectIdentity("/tmp/fact-insert-rollback")),
        ).toEqual([]);
        expect(loadProtectedTailMeta(db, "ses-fact-insert-rollback").priorBoundaryOrdinal).toBe(1);
        expect(onPublished).not.toHaveBeenCalled();
        expect(
            db
                .prepare(
                    "SELECT status FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
                )
                .get("ses-fact-insert-rollback"),
        ).toEqual({ status: "failed" });
    });

    it("retries transient historian prompt failures on the same child session", async () => {
        useTempDataHome("compartment-runner-retry-");
        createOpenCodeDb("ses-retry", [
            { id: "m-1", role: "user", text: "First" },
            { id: "m-2", role: "assistant", text: "Second" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();

        const createSession = mock(async () => ({ data: { id: "ses-agent-retry" } }));
        const promptSession = mock(async () => ({}));
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/retry" } })),
                create: createSession,
                prompt: promptSession,
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<compartment start="1" end="2" title="Recovered"><p1>Summary</p1></compartment>`,
                                },
                            ],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        let promptSyncCallCount = 0;
        const promptSyncSpy = spyOn(
            shared,
            "promptSyncWithModelSuggestionRetry",
        ).mockImplementation(async () => {
            promptSyncCallCount += 1;
            if (promptSyncCallCount < 3) {
                throw new Error("429 rate limit");
            }
        });

        try {
            await withImmediateTimeouts(async () => {
                await runCompartmentAgentWithLease({
                    client,
                    db,
                    sessionId: "ses-retry",
                    historianChunkTokens: 10_000,
                    directory: "/tmp",
                });
            });
        } finally {
            promptSyncSpy.mockRestore();
        }

        expect(createSession).toHaveBeenCalledTimes(1);
        expect(promptSyncCallCount).toBe(3);
        expect(getCompartments(db, "ses-retry")).toEqual([
            expect.objectContaining({ title: "Recovered", startMessage: 1, endMessage: 2 }),
        ]);
    });

    it("refuses a producer source far beyond the known window but admits one within the margin", async () => {
        useTempDataHome("compartment-runner-producer-window-");
        const source = "producer source token ".repeat(2_000);
        const makeMessages = (prefix: string) => [
            { id: `${prefix}-1`, role: "user", text: source },
            { id: `${prefix}-2`, role: "assistant", text: "Second eligible message" },
            { id: `${prefix}-3`, role: "user", text: "protected 1" },
            { id: `${prefix}-4`, role: "user", text: "protected 2" },
            { id: `${prefix}-5`, role: "user", text: "protected 3" },
            { id: `${prefix}-6`, role: "user", text: "protected 4" },
            { id: `${prefix}-7`, role: "user", text: "protected 5" },
        ];
        createOpenCodeDb("ses-window-refuse", makeMessages("refuse"));
        createOpenCodeDb("ses-window-admit", makeMessages("admit"));
        const db = openDatabase();
        const createSession = mock(async () => ({ data: { id: "ses-agent-window" } }));
        const promptSession = mock(async () => ({}));
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/producer-window" } })),
                create: createSession,
                prompt: promptSession,
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: '<compartment start="1" end="2" title="Window edge"><p1>Summary</p1></compartment>',
                                },
                            ],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-window-refuse",
            historianChunkTokens: 100_000,
            historianContextLimit: 33_000,
            historianMaxOutputTokens: 32_000,
            model: "test/model",
            directory: "/tmp",
        });

        expect(createSession).toHaveBeenCalledTimes(0);
        expect(promptSession).toHaveBeenCalledTimes(0);
        // A window that cannot hold even the fixed prompt parts is a failure the
        // next run cannot fix, so it is recorded (and backed off on), but no drain
        // budget is spent because nothing was read or sent.
        expect(getHistorianFailureState(db, "ses-window-refuse").lastError).toContain(
            "producer_prompt_unfit",
        );
        expect(loadProtectedTailMeta(db, "ses-window-refuse").protectedTailDrainTokens).toBe(0);

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-window-admit",
            historianChunkTokens: 100_000,
            historianContextLimit: 1_000_000,
            historianMaxOutputTokens: 32_000,
            model: "test/model",
            directory: "/tmp",
        });

        expect(createSession).toHaveBeenCalledTimes(1);
        expect(promptSession).toHaveBeenCalledTimes(1);
    });

    it("does not reserve an unsent default output cap for a 64k producer", async () => {
        // With no configured output cap and no catalog output metadata, the
        // hidden carrier sends no cap; reserving 32k would reject every run.
        // The window is 64k because an uncalibrated model counts the ~15k-token
        // historian system prompt at twice its size, so a 32k window cannot hold
        // a historian prompt at all; with a 32k reserve this one cannot either.
        useTempDataHome("compartment-runner-producer-window-default-");
        createOpenCodeDb("ses-window-default", [
            { id: "default-1", role: "user", text: "producer source token ".repeat(2_000) },
            { id: "default-2", role: "assistant", text: "Second eligible message" },
            { id: "default-3", role: "user", text: "protected 1" },
            { id: "default-4", role: "user", text: "protected 2" },
            { id: "default-5", role: "user", text: "protected 3" },
            { id: "default-6", role: "user", text: "protected 4" },
            { id: "default-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        const createSession = mock(async () => ({ data: { id: "ses-agent-window-default" } }));
        const promptSession = mock(async () => ({}));
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/producer-window-default" } })),
                create: createSession,
                prompt: promptSession,
                messages: mock(async () => ({ data: [] })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-window-default",
            historianChunkTokens: 100_000,
            historianContextLimit: 64_001,
            model: "test/model",
            directory: "/tmp",
        });

        expect(createSession).toHaveBeenCalledTimes(1);
        expect(promptSession).toHaveBeenCalledTimes(1);
        // The mock returns no assistant output, so the run fails after sending;
        // what matters is that the prompt was admitted and sent.
        expect(getHistorianFailureState(db, "ses-window-default").lastError ?? "").not.toMatch(
            /producer_prompt/,
        );
    });

    it("records length-capped reasoning-only output with the actionable error and drain backoff", async () => {
        useTempDataHome("compartment-runner-length-capped-reasoning-");
        const sessionId = "ses-length-capped-reasoning";
        createOpenCodeDb(sessionId, [
            { id: "m-1", role: "user", text: "First" },
            { id: "m-2", role: "assistant", text: "Second" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        const prompt = mock(async () => ({}));
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/length-capped-reasoning" } })),
                create: mock(async () => ({ data: { id: "ses-agent-length-capped-reasoning" } })),
                prompt,
                messages: mock(async () => ({
                    data: [
                        {
                            info: {
                                role: "assistant",
                                time: { created: 1 },
                                finish_reason: "length",
                                tokens: { output: 8192 },
                            },
                            parts: [
                                {
                                    type: "reasoning",
                                    text: '<compartment start="1" end="2" title="Unusable"><p1>Reasoning-only output</p1></compartment>',
                                },
                            ],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId,
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        const error =
            'historian ran out of output budget while reasoning (length-capped at 8192 tokens, no text; tokens={"input":null,"output":8192,"reasoning":null,"cache_read":null,"cache_write":null,"max_tokens":null,"finish_reason":"length"}) — set historian.maxTokens or route historian.model to a low-reasoning lane/variant';
        expect(getCompartments(db, sessionId)).toHaveLength(0);
        expect(getHistorianFailureState(db, sessionId)).toMatchObject({
            failureCount: 1,
            lastError: error,
        });
        // An unusable response records a drain-failure timestamp so emergency drain
        // retries wait instead of immediately retrying the same broken historian.
        expect(loadProtectedTailMeta(db, sessionId).historianDrainFailureAt).toBeGreaterThan(0);
    });

    it("publishes valid compartment markup from reasoning-only historian output", async () => {
        useTempDataHome("compartment-runner-reasoning-fallback-");
        const sessionId = "ses-reasoning-fallback";
        createOpenCodeDb(sessionId, [
            { id: "m-1", role: "user", text: "First" },
            { id: "m-2", role: "assistant", text: "Second" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/reasoning-fallback" } })),
                create: mock(async () => ({ data: { id: "ses-agent-reasoning-fallback" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "thinking",
                                    text: '<compartment start="1" end="2" title="Recovered from reasoning"><p1>Validated summary</p1></compartment>',
                                },
                            ],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId,
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        expect(getCompartments(db, sessionId)).toEqual([
            expect.objectContaining({
                startMessage: 1,
                endMessage: 2,
                title: "Recovered from reasoning",
                p1: "Validated summary",
            }),
        ]);
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(0);
    });

    it("rejects invalid reasoning-only historian output through the normal repair path", async () => {
        useTempDataHome("compartment-runner-invalid-reasoning-");
        const sessionId = "ses-invalid-reasoning";
        createOpenCodeDb(sessionId, [
            { id: "m-1", role: "user", text: "First" },
            { id: "m-2", role: "assistant", text: "Second" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        const prompt = mock(async () => ({}));
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/invalid-reasoning" } })),
                create: mock(async () => ({ data: { id: "ses-agent-invalid-reasoning" } })),
                prompt,
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [{ type: "reasoning", text: "not compartment markup" }],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId,
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        expect(getHistorianPromptCount(prompt)).toBe(2);
        expect(getCompartments(db, sessionId)).toHaveLength(0);
        expect(getHistorianFailureState(db, sessionId)).toMatchObject({
            failureCount: 1,
            lastError: "Historian returned no usable compartments.",
        });
    });

    it("falls back to the primary session model after historian and repair output both fail validation", async () => {
        useTempDataHome("compartment-runner-fallback-");
        createOpenCodeDb("ses-fallback", [
            { id: "m-1", role: "user", text: "First" },
            { id: "m-2", role: "assistant", text: "Second" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();

        const promptSession = mock(async () => ({}));
        const messages = mock(async () => {
            const callIndex = messages.mock.calls.length;
            if (callIndex < 3) {
                return {
                    data: [
                        {
                            info: { role: "assistant", time: { created: callIndex } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<compartment start="3" end="4" title="Bad"><p1>Bad</p1></compartment>`,
                                },
                            ],
                        },
                    ],
                };
            }

            return {
                data: [
                    {
                        info: { role: "assistant", time: { created: callIndex } },
                        parts: [
                            {
                                type: "text",
                                text: `<compartment start="1" end="2" title="Fallback"><p1>Recovered</p1></compartment>`,
                            },
                        ],
                    },
                ],
            };
        });
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/fallback" } })),
                create: mock(async () => ({
                    data: { id: `ses-agent-${messages.mock.calls.length}` },
                })),
                prompt: promptSession,
                messages,
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-fallback",
            historianChunkTokens: 10_000,
            directory: "/tmp",
            fallbackModelId: "openai/gpt-4o",
        });

        const fallbackPrompts = promptSession.mock.calls as unknown as Array<
            [
                {
                    body?: {
                        agent?: string;
                        model?: { providerID: string; modelID: string };
                    };
                },
            ]
        >;
        expect(fallbackPrompts[0]?.[0]?.body?.agent).toBe("historian");
        expect(fallbackPrompts[1]?.[0]?.body?.agent).toBe("historian");
        // Fallback now includes both agent (for system prompt) and model (for override)
        expect(fallbackPrompts[2]?.[0]?.body?.agent).toBe("historian");
        expect(fallbackPrompts[2]?.[0]?.body?.model).toEqual({
            providerID: "openai",
            modelID: "gpt-4o",
        });
        expect(getCompartments(db, "ses-fallback")).toEqual([
            expect.objectContaining({ title: "Fallback", startMessage: 1, endMessage: 2 }),
        ]);
    });

    it("escalates through configured fallback_models before the session-model last resort", async () => {
        useTempDataHome("compartment-runner-chain-");
        createOpenCodeDb("ses-chain", [
            { id: "m-1", role: "user", text: "First" },
            { id: "m-2", role: "assistant", text: "Second" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();

        // Primary (call 0) + repair (call 1) both return invalid output → escalate.
        // First configured fallback "anthropic/claude-sonnet-4-6" (call 2) returns
        // a VALID compartment. The session-model last resort "openai/gpt-4o" must
        // therefore NEVER be reached.
        const promptSession = mock(async () => ({}));
        const messages = mock(async () => {
            const callIndex = messages.mock.calls.length;
            if (callIndex < 3) {
                return {
                    data: [
                        {
                            info: { role: "assistant", time: { created: callIndex } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<compartment start="9" end="9" title="Bad"><p1>Out of range</p1></compartment>`,
                                },
                            ],
                        },
                    ],
                };
            }
            return {
                data: [
                    {
                        info: { role: "assistant", time: { created: callIndex } },
                        parts: [
                            {
                                type: "text",
                                text: `<compartment start="1" end="2" title="ChainFallback"><p1>Recovered via sonnet</p1></compartment>`,
                            },
                        ],
                    },
                ],
            };
        });
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/chain" } })),
                create: mock(async () => ({
                    data: { id: `ses-agent-${messages.mock.calls.length}` },
                })),
                prompt: promptSession,
                messages,
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-chain",
            historianChunkTokens: 10_000,
            directory: "/tmp",
            fallbackModels: ["anthropic/claude-sonnet-4-6"],
            fallbackModelId: "openai/gpt-4o",
        });

        const calls = promptSession.mock.calls as unknown as Array<
            [{ body?: { model?: { providerID: string; modelID: string } } }]
        >;
        // Primary and repair use an explicitly selected model with a known window; an unspecified agent default has no observable window for admission.
        expect(calls[0]?.[0]?.body?.model).toEqual({
            providerID: "test",
            modelID: "fixture-historian",
        });
        expect(calls[1]?.[0]?.body?.model).toEqual({
            providerID: "test",
            modelID: "fixture-historian",
        });
        // Call 2: the FIRST configured fallback (sonnet), not the session model.
        expect(calls[2]?.[0]?.body?.model).toEqual({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
        });
        // Session-model last resort (gpt-4o) must never be reached.
        const usedGpt4o = calls.some(
            (c) =>
                c[0]?.body?.model?.providerID === "openai" &&
                c[0]?.body?.model?.modelID === "gpt-4o",
        );
        expect(usedGpt4o).toBe(false);
        expect(getCompartments(db, "ses-chain")).toEqual([
            expect.objectContaining({ title: "ChainFallback", startMessage: 1, endMessage: 2 }),
        ]);
    });

    it("starts new summarization after the last stored raw compartment end", async () => {
        useTempDataHome("compartment-runner-offset-");
        createOpenCodeDb("ses-2", [
            { id: "m-1", role: "user", text: "zero" },
            { id: "m-2", role: "assistant", text: "one" },
            { id: "m-3", role: "user", text: "two" },
            { id: "m-4", role: "assistant", text: "three" },
            { id: "m-5", role: "user", text: "protected 1" },
            { id: "m-6", role: "user", text: "protected 2" },
            { id: "m-7", role: "user", text: "protected 3" },
            { id: "m-8", role: "user", text: "protected 4" },
            { id: "m-9", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        replaceAllCompartments(db, "ses-2", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "m-1",
                endMessageId: "m-2",
                title: 'Earlier "work"',
                content: "Old summary",
            },
        ]);
        replaceAllCompartmentState(
            db,
            "ses-2",
            [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "m-1",
                    endMessageId: "m-2",
                    title: 'Earlier "work"',
                    content: "Old summary",
                },
            ],
            [{ category: "WORKFLOW_RULES", content: "Commit to feat first." }],
        );

        const getSession = mock(async () => ({ data: { directory: "/tmp/parent-2" } }));
        const createSession = mock(
            async (_input: {
                body: { parentID: string; title: string };
                query: { directory: string };
            }) => ({ data: { id: "ses-agent-2" } }),
        );
        const promptSession = mock(async (input: { body: { parts: Array<{ text: string }> } }) => ({
            promptText: input.body.parts[0]?.text,
        }));
        const messages = mock(async () => ({
            data: [
                {
                    info: { role: "assistant", time: { created: 1 } },
                    parts: [
                        {
                            type: "text",
                            text: `<compartment start="3" end="4" title="Later work"><p1>Later summary</p1></compartment>`,
                        },
                    ],
                },
            ],
        }));
        const deleteSession = mock(async () => ({}));

        const client = {
            session: {
                get: getSession,
                create: createSession,
                prompt: promptSession,
                messages,
                delete: deleteSession,
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-2",
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        const sentPrompt = promptSession.mock.calls[0]?.[0]?.body.parts[0]?.text ?? "";
        expect(sentPrompt).toContain("Messages 3-4:");
        expect(sentPrompt).toContain("[3] U: two");
        expect(sentPrompt).toContain("[4] A: three");
        expect(sentPrompt).not.toContain("msg_");
        // v2: the unbounded existing_state dump is gone. Prior compartments now
        // appear in <session_references> (3 diverse older + 4 recent examples),
        // and facts are no longer dumped/replaced — they dedup against
        // <project-memory>. The prior compartment is still shown for continuity.
        expect(sentPrompt).toContain("<session_references>");
        expect(sentPrompt).toContain('start="1" end="2"');
        expect(sentPrompt).toContain('title="Earlier &quot;work&quot;"');
        // v2: no existing_state fact-normalization block, no raw session_facts dump.
        expect(sentPrompt).not.toContain(
            "Existing state (read-only context for continuity and fact normalization",
        );
        expect(sentPrompt).not.toContain(
            "Rewrite all facts below into canonical present-tense operational form",
        );
        // The chunk only covers messages 3-4, so message 1's raw text never appears.
        expect(sentPrompt).not.toContain("[1] U: zero");

        const compartments = getCompartments(db, "ses-2");
        expect(compartments).toHaveLength(2);
        expect(compartments[1]?.startMessage).toBe(3);
        expect(compartments[1]?.endMessage).toBe(4);
        expect(compartments[1]?.startMessageId).toBe("m-3");
        expect(compartments[1]?.endMessageId).toBe("m-4");
        expect(createSession.mock.calls[0]?.[0]).toEqual({
            body: { parentID: "ses-2", title: "magic-context-compartment" },
            query: { directory: "/tmp/parent-2" },
        });
    });

    it("queues drops for text, file, and tool tags covered by stored compartments", async () => {
        useTempDataHome("compartment-runner-tag-drops-");
        createOpenCodeDb("ses-tag-drops", [
            {
                id: "m-1",
                role: "user",
                parts: [
                    { type: "text", text: "User note" },
                    { type: "file", url: "file:///tmp/demo.txt" },
                ],
            },
            {
                id: "m-2",
                role: "assistant",
                parts: [
                    { type: "text", text: "Assistant context" },
                    { type: "tool", callID: "call-1", state: { output: "Tool output" } },
                ],
            },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        const messages = [
            {
                info: { id: "m-1", role: "user", sessionID: "ses-tag-drops" },
                parts: [
                    { type: "text", text: "User note" },
                    { type: "file", url: "file:///tmp/demo.txt" },
                ],
            },
            {
                info: { id: "m-2", role: "assistant" },
                parts: [
                    { type: "text", text: "Assistant context" },
                    { type: "tool", callID: "call-1", state: { output: "Tool output" } },
                ],
            },
        ];
        tagMessages("ses-tag-drops", messages, createTagger(), db);

        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/tag-drops" } })),
                create: mock(async () => ({ data: { id: "ses-agent-tag-drops" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<compartment start="1" end="2" title="Stored history"><p1>Stored summary</p1></compartment>`,
                                },
                            ],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-tag-drops",
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        const activeTagIds = getTagsBySession(db, "ses-tag-drops")
            .filter((tag) => tag.status === "active")
            .map((tag) => tag.tagNumber)
            .sort((left, right) => left - right);
        const pendingDropIds = getPendingOps(db, "ses-tag-drops")
            .map((op) => op.tagId)
            .sort((left, right) => left - right);

        expect(activeTagIds).toHaveLength(4);
        expect(pendingDropIds).toEqual(activeTagIds);
    });

    it("returns early without calling historian when only protected tail history remains", async () => {
        //#given: 3 messages, all 3 user turns — protected tail starts at ordinal 1, no eligible prefix
        useTempDataHome("compartment-runner-protected-only-");
        createOpenCodeDb("ses-protected-only", [
            { id: "m-1", role: "user", text: "recent 1" },
            { id: "m-2", role: "user", text: "recent 2" },
            { id: "m-3", role: "user", text: "recent 3" },
        ]);
        const db = openDatabase();

        const createSession = mock(async () => ({ data: { id: "ses-agent" } }));
        const promptSession = mock(async () => ({}));
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp" } })),
                create: createSession,
                prompt: promptSession,
                messages: mock(async () => ({ data: [] })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        //#when
        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-protected-only",
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        //#then: historian was never invoked
        expect(createSession).not.toHaveBeenCalled();
        expect(promptSession).not.toHaveBeenCalled();
    });

    it("sends only the eligible prefix (before protected tail) to historian", async () => {
        //#given: 6 user turns — first is eligible, last 5 are protected
        useTempDataHome("compartment-runner-eligible-prefix-");
        createOpenCodeDb("ses-eligible-prefix", [
            { id: "m-1", role: "user", text: "eligible turn" },
            { id: "m-2", role: "assistant", text: "done" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();

        const getSession = mock(async () => ({ data: { directory: "/tmp" } }));
        const createSession = mock(async () => ({ data: { id: "ses-agent-ep" } }));
        const promptSession = mock(
            async (_input: { body: { parts: Array<{ text: string }> } }) => ({}),
        );
        const messages = mock(async () => ({
            data: [
                {
                    info: { role: "assistant", time: { created: 1 } },
                    parts: [
                        {
                            type: "text",
                            text: `<compartment start="1" end="2" title="Eligible work"><p1>Summary</p1></compartment>`,
                        },
                    ],
                },
            ],
        }));
        const deleteSession = mock(async () => ({}));
        const client = {
            session: {
                get: getSession,
                create: createSession,
                prompt: promptSession,
                messages,
                delete: deleteSession,
            },
        } as unknown as PluginContext["client"];

        //#when
        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-eligible-prefix",
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        //#then: historian prompt only contains the eligible prefix (m-1, m-2)
        const sentPrompt = promptSession.mock.calls[0]?.[0]?.body.parts[0]?.text ?? "";
        expect(sentPrompt).toContain("eligible turn");
        expect(sentPrompt).not.toContain("protected 1");
        expect(sentPrompt).not.toContain("protected 2");
        expect(sentPrompt).not.toContain("protected 3");
    });

    it("skips historian and alerts when stored compartments are already invalid", async () => {
        useTempDataHome("compartment-runner-invalid-existing-");
        createOpenCodeDb("ses-invalid-existing", [
            { id: "m-1", role: "user", text: "one" },
            { id: "m-2", role: "assistant", text: "two" },
            { id: "m-3", role: "user", text: "three" },
            { id: "m-4", role: "assistant", text: "four" },
            { id: "m-5", role: "user", text: "protected 1" },
            { id: "m-6", role: "user", text: "protected 2" },
            { id: "m-7", role: "user", text: "protected 3" },
            { id: "m-8", role: "user", text: "protected 4" },
            { id: "m-9", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        replaceAllCompartments(db, "ses-invalid-existing", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "m-1",
                endMessageId: "m-2",
                title: "first",
                content: "first summary",
            },
            {
                sequence: 1,
                startMessage: 4,
                endMessage: 4,
                startMessageId: "m-4",
                endMessageId: "m-4",
                title: "gap",
                content: "gap summary",
            },
        ]);

        const createSession = mock(async () => ({ data: { id: "ses-agent" } }));
        const promptSession = mock(async () => ({}));
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp" } })),
                create: createSession,
                prompt: promptSession,
                messages: mock(async () => ({ data: [] })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-invalid-existing",
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        expect(createSession).not.toHaveBeenCalled();
        expect(getCompartments(db, "ses-invalid-existing")).toHaveLength(2);
        // First failure on a fresh session → transient/reassuring framing (the
        // escalated "needs attention" + error detail only appears once failures
        // persist past HISTORIAN_PERSISTENT_FAILURE_THRESHOLD).
        expect(
            String(
                drainNotifications(0, "ses-invalid-existing").find((n) => n.type === "toast")
                    ?.payload.message,
            ).toLowerCase(),
        ).toContain("(mc-h01)");
    });

    it("rejects invalid historian output without replacing compartments or facts", async () => {
        useTempDataHome("compartment-runner-invalid-output-");
        createOpenCodeDb("ses-invalid-output", [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        replaceAllCompartmentState(
            db,
            "ses-invalid-output",
            [],
            [{ category: "CONSTRAINTS", content: "Existing fact stays." }],
        );

        const promptSession = mock(async () => ({}));
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp" } })),
                create: mock(async () => ({ data: { id: "ses-agent" } })),
                prompt: promptSession,
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<compartment start="1" end="1" title="Part one"><p1>One</p1></compartment>\n<compartment start="3" end="3" title="Part two"><p1>Two</p1></compartment>`,
                                },
                            ],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-invalid-output",
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        expect(getCompartments(db, "ses-invalid-output")).toHaveLength(0);
        expect(getSessionFacts(db, "ses-invalid-output")).toEqual([
            expect.objectContaining({ category: "CONSTRAINTS", content: "Existing fact stays." }),
        ]);
        // First failure → transient framing (no raw error / no action ask yet).
        expect(
            String(
                drainNotifications(0, "ses-invalid-output").find((n) => n.type === "toast")?.payload
                    .message,
            ).toLowerCase(),
        ).toContain("(mc-h01)");
    });

    it("alerts when historian model execution fails", async () => {
        useTempDataHome("compartment-runner-model-failure-");
        createOpenCodeDb("ses-model-failure", [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();

        const promptSession = mock(async (input: { body?: { noReply?: boolean } }) => {
            if (input.body?.noReply === true) {
                return {};
            }
            throw new Error("historian model unavailable");
        });
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp" } })),
                create: mock(async () => ({ data: { id: "ses-agent" } })),
                prompt: promptSession,
                messages: mock(async () => ({ data: [] })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-model-failure",
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        expect(getCompartments(db, "ses-model-failure")).toHaveLength(0);
        // First failure → transient framing. The raw error ("historian model
        // unavailable") is still recorded in historian_failure_state for the
        // escalated notice + doctor diagnostics; it just isn't surfaced to the
        // user on a single transient blip.
        expect(
            String(
                drainNotifications(0, "ses-model-failure").find((n) => n.type === "toast")?.payload
                    .message,
            ).toLowerCase(),
        ).toContain("(mc-h01)");
    });

    it("escalates the historian alert to an actionable notice after persistent failures", async () => {
        useTempDataHome("compartment-runner-persistent-failure-");
        createOpenCodeDb("ses-persistent-failure", [
            { id: "m-1", role: "user", text: "eligible one" },
            { id: "m-2", role: "assistant", text: "eligible two" },
            { id: "m-3", role: "user", text: "protected 1" },
            { id: "m-4", role: "user", text: "protected 2" },
            { id: "m-5", role: "user", text: "protected 3" },
            { id: "m-6", role: "user", text: "protected 4" },
            { id: "m-7", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        // Pre-seed prior failures so this run crosses the persistent threshold.
        incrementHistorianFailure(db, "ses-persistent-failure", "earlier failure");
        incrementHistorianFailure(db, "ses-persistent-failure", "earlier failure");

        const promptSession = mock(async (input: { body?: { noReply?: boolean } }) => {
            if (input.body?.noReply === true) return {};
            throw new Error("historian model unavailable");
        });
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp" } })),
                create: mock(async () => ({ data: { id: "ses-agent" } })),
                prompt: promptSession,
                messages: mock(async () => ({ data: [] })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-persistent-failure",
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        const notice = String(
            drainNotifications(0, "ses-persistent-failure").find((n) => n.type === "toast")?.payload
                .message,
        );
        expect(notice).toContain("(MC-H01)");
        expect(notice).not.toContain("magic-context.jsonc");
        expect(notice).not.toContain("historian model unavailable");
    });

    it("re-reads narrative-gap ordinals after validation rejection", async () => {
        useTempDataHome("compartment-runner-gap-reread-");
        const sessionId = "ses-gap-reread";
        createOpenCodeDb(sessionId, [
            { id: "m-1", role: "user", text: "narrative 1" },
            { id: "m-2", role: "assistant", text: "narrative 2" },
            { id: "m-3", role: "user", text: "narrative 3" },
            { id: "m-4", role: "assistant", text: "narrative 4" },
            { id: "m-5", role: "user", text: "narrative 5" },
            { id: "m-6", role: "assistant", text: "narrative 6" },
            { id: "m-7", role: "assistant", text: "narrative 7" },
            { id: "m-8", role: "user", text: "protected 1" },
            { id: "m-9", role: "user", text: "protected 2" },
            { id: "m-10", role: "user", text: "protected 3" },
            { id: "m-11", role: "user", text: "protected 4" },
            { id: "m-12", role: "user", text: "protected 5" },
        ]);
        const db = openDatabase();
        const prompt = mock(async () => ({}));
        let historianFetches = 0;
        const messages = mock(async (input: { query?: { directory?: string } }) => {
            if (!input.query?.directory) return { data: [] };
            historianFetches += 1;
            const text =
                historianFetches <= 2
                    ? '<output><compartment start="1" end="1" title="first"><p1>First</p1></compartment><compartment start="7" end="7" title="second"><p1>Second</p1></compartment></output>'
                    : '<output><compartment start="1" end="7" title="re-read"><p1>All narrative preserved</p1></compartment></output>';
            return {
                data: [
                    {
                        info: { role: "assistant", time: { created: historianFetches } },
                        parts: [{ type: "text", text }],
                    },
                ],
            };
        });
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/gap-reread" } })),
                create: mock(async () => ({ data: { id: `ses-agent-${historianFetches}` } })),
                prompt,
                messages,
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId,
            historianChunkTokens: 10_000,
            directory: "/tmp",
            forceDrainQuota: true,
        });

        expect(historianFetches).toBe(2);
        expect(getCompartments(db, sessionId)).toHaveLength(0);
        expect(loadProtectedTailMeta(db, sessionId).priorBoundaryOrdinal).toBe(1);

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId,
            historianChunkTokens: 10_000,
            directory: "/tmp",
            forceDrainQuota: true,
        });

        const historianPrompts = prompt.mock.calls
            .map(
                (call) =>
                    call[0] as {
                        body?: { noReply?: boolean; parts?: Array<{ text?: string }> };
                    },
            )
            .filter((input) => input.body?.noReply !== true)
            .map((input) => input.body?.parts?.[0]?.text ?? "");
        expect(historianFetches).toBe(3);
        expect(historianPrompts[2]).toContain("Messages 1-7");
        expect(historianPrompts[2]).toContain("narrative 2");
        expect(historianPrompts[2]).toContain("narrative 6");
        expect(getCompartments(db, sessionId)).toEqual([
            expect.objectContaining({ startMessage: 1, endMessage: 7, title: "re-read" }),
        ]);
        expect(loadProtectedTailMeta(db, sessionId).priorBoundaryOrdinal).toBe(8);
    });

    // Regression: production livelock (ses_157f877e2ffepme9doYf3RTnRx). In an
    // active session the protected tail's newest message changes every turn, so
    // the trigger-time boundary snapshot fails validation on the "last ordinal
    // id changed" check by the time the historian runs — even though the eligible
    // HEAD it would compact is untouched. The runner used to no-op forever while
    // the trigger refired each turn and queued drop ops starved. It must now
    // re-resolve the boundary at run time and make real progress.
    it("refreshes a stale-tail boundary snapshot at run time instead of no-op'ing forever", async () => {
        useTempDataHome("compartment-runner-stale-tail-refresh-");
        createOpenCodeDb("ses-stale-tail", [
            { id: "m-1", role: "user", text: `eligible head one ${"detail ".repeat(150)}` },
            { id: "m-2", role: "assistant", text: `eligible head two ${"detail ".repeat(150)}` },
            { id: "m-3", role: "user", text: `tail ${"context ".repeat(3000)}` },
        ]);
        const db = openDatabase();

        // Tag the eligible head so a successful publish also queues drop ops —
        // proving the stale→refresh→publish chain that feeds drop application.
        tagMessages(
            "ses-stale-tail",
            [
                {
                    info: { id: "m-1", role: "user", sessionID: "ses-stale-tail" },
                    parts: [{ type: "text", text: `eligible head one ${"detail ".repeat(150)}` }],
                },
                {
                    info: { id: "m-2", role: "assistant", sessionID: "ses-stale-tail" },
                    parts: [{ type: "text", text: `eligible head two ${"detail ".repeat(150)}` }],
                },
            ],
            createTagger(),
            db,
        );

        // Resolve a genuine snapshot (correct fingerprint + ids), then corrupt
        // ONLY the recorded last-tail id to simulate the live tail advancing
        // between trigger and run. Every other check (offset, protectedTailStart,
        // eligibleEnd, eligible-range fingerprint) still passes — exactly the
        // production failure mode.
        const realSnapshot = resolveOpenCodeProtectedTailBoundary({
            db,
            sessionId: "ses-stale-tail",
            mode: "trigger",
            contextLimit: 8_000,
            executeThresholdPercentage: 65,
            usage: { percentage: 95, inputTokens: 7_600 },
            usageSource: "live",
        });
        expect(hasRunnableCompartmentWindow(realSnapshot)).toBe(true);
        expect(realSnapshot.offset).toBe(1);
        expect(realSnapshot.eligibleEndOrdinal).toBeGreaterThan(realSnapshot.offset);
        expect(realSnapshot.rawRangeFingerprint.length).toBeGreaterThan(0);
        const staleSnapshot = {
            ...realSnapshot,
            rawLastMessageIdAtTrigger: "m-vanished-live-tail",
        };

        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/stale-tail" } })),
                create: mock(async () => ({ data: { id: "ses-agent-stale-tail" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: '<compartment start="1" end="2" title="Eligible head"><p1>Head summary</p1></compartment>',
                                },
                            ],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId: "ses-stale-tail",
            historianChunkTokens: 10_000,
            directory: "/tmp",
            boundarySnapshot: staleSnapshot,
            currentContextLimit: 8_000,
        });

        // Re-derived and PUBLISHED rather than no-op'ing: progress is made.
        const compartments = getCompartments(db, "ses-stale-tail");
        expect(compartments).toHaveLength(1);
        expect(compartments[0]?.startMessage).toBe(1);
        expect(compartments[0]?.endMessage).toBe(2);
        // And the published compartment queued drops for its covered tags, so the
        // accumulated pending ops can finally drain (no starvation).
        expect(getPendingOps(db, "ses-stale-tail").length).toBeGreaterThan(0);
        expect(getOrCreateSessionMeta(db, "ses-stale-tail").compartmentInProgress).toBe(false);
    });

    // Regression: a synchronous runner no-op (stale/empty snapshot, nothing to
    // compact) must NOT leave the rest of the transform pass believing a historian
    // is in progress. startCompartmentAgent registers the run in `activeRuns`
    // BEFORE the (microtask-scheduled) promise.finally can clear it; postprocess
    // reads `getActiveCompartmentRun` synchronously in the same pass and would
    // defer queued drop ops for a run that already finished. The no-op must clear
    // the registration synchronously.
    it("clears the scheduled active-run registration when a background runner no-ops", async () => {
        useTempDataHome("compartment-runner-sync-noop-clear-");
        createOpenCodeDb("ses-sync-noop", [
            { id: "m-1", role: "user", text: "only protected 1" },
            { id: "m-2", role: "user", text: "only protected 2" },
            { id: "m-3", role: "user", text: "only protected 3" },
        ]);
        const db = openDatabase();

        // protectedTailStart === offset (1) → "nothing to compact" no-op, which
        // returns synchronously before any await. Empty fingerprint skips the
        // validation branch so we land squarely on the nothing-to-compact path.
        const noopSnapshot = {
            sessionId: "ses-sync-noop",
            mode: "trigger" as const,
            offset: 1,
            offsetMessageId: "m-1",
            protectedTailStart: 1,
            protectedTailStartMessageId: "m-1",
            eligibleEndOrdinal: 1,
            eligibleEndMessageId: null,
            rawMessageCountAtTrigger: 3,
            rawLastMessageIdAtTrigger: "m-3",
            N: 1_000,
            usagePercentage: 10,
            usageInputTokens: 1_000,
            usageSource: "live" as const,
            contextLimit: 128_000,
            executeThresholdPercentage: 65,
            triggerBudget: 5_000,
            priorBoundaryOrdinal: 1,
            migrationFloorActive: false,
            providerShapeVersion: "opencode-v1" as const,
            cacheNamespace: "test:ses-sync-noop",
            createdAt: Date.now(),
            rawRangeFingerprint: "",
            trueRawEligibleTokens: 0,
            oversizeAtomicUnit: false,
            boundaryReason: "size-walk",
        };

        const client = {
            session: {
                get: mock(async () => ({ data: { directory: "/tmp/sync-noop" } })),
                create: mock(async () => ({ data: { id: "ses-agent-sync-noop" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({ data: [] })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        startCompartmentAgent({
            client,
            db,
            sessionId: "ses-sync-noop",
            historianChunkTokens: 10_000,
            directory: "/tmp",
            boundarySnapshot: noopSnapshot,
            currentContextLimit: 128_000,
        });

        // Startup is deferred, so even a no-op owns a registration until it has
        // inspected the history. Once it finishes, later passes can apply drops.
        const scheduled = getActiveCompartmentRun("ses-sync-noop");
        expect(scheduled).toBeDefined();
        await scheduled?.promise;
        expect(getOrCreateSessionMeta(db, "ses-sync-noop").compartmentInProgress).toBe(false);
        expect(getActiveCompartmentRun("ses-sync-noop")).toBeUndefined();
    });
});

describe("registerActiveCompartmentRun", () => {
    it("surfaces via getActiveCompartmentRun while the promise is pending, and clears itself when it settles", async () => {
        const sessionId = "ses-register-active";
        expect(getActiveCompartmentRun(sessionId)).toBeUndefined();

        let resolveCompressor: (() => void) | undefined;
        const pending = new Promise<void>((resolve) => {
            resolveCompressor = resolve;
        });

        registerActiveCompartmentRun(sessionId, pending);

        // While the compressor is still running, a later historian-start check
        // must see the active run and know to bail out. This is the whole
        // point of the race fix — without registration, historian could start
        // on top of the compressor and both would write compartments.
        expect(getActiveCompartmentRun(sessionId)).toBeDefined();

        resolveCompressor?.();
        await pending;
        // Give the .finally() callback a tick to run.
        await new Promise((r) => setTimeout(r, 0));

        expect(getActiveCompartmentRun(sessionId)).toBeUndefined();
    });

    it("clears itself when the underlying promise settles (including swallowed failures)", async () => {
        // Real callers attach their own .catch before handing the promise in
        // (see transform-compartment-phase.ts: the compressor path ends its
        // .catch by logging, then registerActiveCompartmentRun receives that
        // already-resolved-to-undefined promise). So the active-runs map never
        // sees an unhandled rejection; it just needs to clear on settle.
        const sessionId = "ses-register-active-reject";
        let rejectCompressor: ((err: unknown) => void) | undefined;
        const pending = new Promise<void>((_, reject) => {
            rejectCompressor = reject;
        }).catch(() => {
            // Simulate the caller-side swallow (matches real compressor dispatch).
        });

        registerActiveCompartmentRun(sessionId, pending);
        expect(getActiveCompartmentRun(sessionId)).toBeDefined();

        rejectCompressor?.(new Error("simulated compressor failure"));
        await getActiveCompartmentRun(sessionId);
        await new Promise((r) => setTimeout(r, 0));

        expect(getActiveCompartmentRun(sessionId)).toBeUndefined();
    });

    it("does not delete a replacement run when the original settles", async () => {
        // Edge case: if two registrations happen back-to-back (which
        // shouldn't normally occur — caller is expected to check first —
        // but defensive behavior matters), the second registration must
        // survive after the first one settles.
        const sessionId = "ses-register-active-replace";

        let resolveFirst: (() => void) | undefined;
        const first = new Promise<void>((resolve) => {
            resolveFirst = resolve;
        });
        registerActiveCompartmentRun(sessionId, first);

        const second = new Promise<void>((resolve) => {
            // Never resolve during test
            void resolve;
        });
        registerActiveCompartmentRun(sessionId, second);

        resolveFirst?.();
        await first;
        await new Promise((r) => setTimeout(r, 0));

        // The second registration must still be surfaced — the first's
        // finally must not have stomped it.
        expect(getActiveCompartmentRun(sessionId)).toBeDefined();
    });
});

it("rolls back protected-tail drain reservation when publish throws after historian success", async () => {
    useTempDataHome("compartment-runner-drain-rollback-");
    createOpenCodeDb("ses-drain-rollback", [
        { id: "m-1", role: "user", text: "first small head" },
        { id: "m-2", role: "assistant", text: "second" },
        { id: "m-3", role: "user", text: "tail ".repeat(3000) },
    ]);
    const db = openDatabase();
    db.exec(
        "CREATE TRIGGER fail_compartment_insert BEFORE INSERT ON compartments BEGIN SELECT RAISE(ABORT, 'append fail'); END;",
    );
    const boundarySnapshot = {
        sessionId: "ses-drain-rollback",
        mode: "trigger" as const,
        offset: 1,
        rawMessageCountAtTrigger: 3,
        rawLastMessageIdAtTrigger: "m-3",
        protectedTailStart: 3,
        eligibleEndOrdinal: 3,
        N: 1_000,
        usagePercentage: 95,
        usageInputTokens: 7_600,
        usageSource: "live" as const,
        contextLimit: 8_000,
        executeThresholdPercentage: 65,
        triggerBudget: 5_200,
        providerShapeVersion: "opencode-v1",
        cacheNamespace: "test:ses-drain-rollback",
        createdAt: Date.now(),
        rawRangeFingerprint: "",
        trueRawEligibleTokens: 500,
        oversizeAtomicUnit: false,
        boundaryReason: "size-walk",
    };

    const client = {
        session: {
            get: mock(async () => ({ data: { directory: "/tmp/parent" } })),
            create: mock(async () => ({ data: { id: "ses-agent" } })),
            prompt: mock(async () => ({})),
            messages: mock(async () => ({
                data: [
                    {
                        info: { role: "assistant", time: { created: 1 } },
                        parts: [
                            {
                                type: "text",
                                text: '<compartment start="1" end="2" title="Done"><p1>Summary</p1></compartment>',
                            },
                        ],
                    },
                ],
            })),
            delete: mock(async () => ({})),
        },
    } as unknown as PluginContext["client"];

    await runCompartmentAgentWithLease({
        client,
        db,
        sessionId: "ses-drain-rollback",
        historianChunkTokens: 10_000,
        directory: "/tmp",
        boundarySnapshot,
        currentContextLimit: 8_000,
    });

    expect(loadProtectedTailMeta(db, "ses-drain-rollback").protectedTailDrainTokens).toBe(0);
});

describe("stored compartments a store-projection rebase left unresolved", () => {
    const twelveMessages = Array.from({ length: 12 }, (_, index) => ({
        id: `m-${index + 1}`,
        // The last five user turns form the protected tail, leaving 1-7 eligible.
        role: index >= 7 || index % 2 === 0 ? "user" : "assistant",
        text: index >= 7 ? `protected ${index + 1}` : `message ${index + 1}`,
    }));

    /**
     * The issue 531 shape at small scale: the middle compartment's start anchor
     * was a native-compaction boundary the host's store conversion removed, so
     * the rebase marked it unresolved and left its stale end (5) overlapping
     * the next compartment, which the rebase moved to start at 5.
     */
    function seedStuckCompartments(
        db: ReturnType<typeof openDatabase>,
        sessionId: string,
        middle: { start: number; end: number; startId: string; endId: string },
        next: { start: number; end: number; startId: string; endId: string },
    ): void {
        replaceAllCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "m-1",
                endMessageId: "m-2",
                title: "first",
                content: "first summary",
            },
            {
                sequence: 1,
                startMessage: middle.start,
                endMessage: middle.end,
                startMessageId: middle.startId,
                endMessageId: middle.endId,
                title: "middle",
                content: "middle summary",
            },
            {
                sequence: 2,
                startMessage: next.start,
                endMessage: next.end,
                startMessageId: next.startId,
                endMessageId: next.endId,
                title: "next",
                content: "next summary",
            },
        ]);
        db.prepare(
            "UPDATE compartments SET rebase_status = 'unresolved' WHERE session_id = ? AND sequence = 1",
        ).run(sessionId);
        db.prepare(
            "UPDATE session_meta SET coordinate_generation = 'v2', coordinate_rebase_notice = ? WHERE session_id = ?",
        ).run(
            JSON.stringify({
                generation: "v2",
                previousGeneration: "v1",
                at: 1,
                unresolvedCompartments: 1,
            }),
            sessionId,
        );
    }

    function historianClient(label: string, output: string) {
        const prompt = mock(async () => ({}));
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: `/tmp/${label}` } })),
                create: mock(async () => ({ data: { id: `ses-agent-${label}` } })),
                prompt,
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [{ type: "text", text: output }],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];
        return { client, prompt };
    }

    const nextCompartmentMarkup =
        '<compartment start="7" end="7" title="Seventh"><p1>Seventh summary</p1></compartment>';

    it("places the unresolved compartment from its neighbours before the run and publishes", async () => {
        useTempDataHome("compartment-runner-531-repair-");
        const sessionId = "ses-531-historian-repair";
        createOpenCodeDb(sessionId, twelveMessages);
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        seedStuckCompartments(
            db,
            sessionId,
            { start: 3, end: 5, startId: "m-native-compaction-boundary", endId: "m-4" },
            { start: 5, end: 6, startId: "m-5", endId: "m-6" },
        );
        const { client } = historianClient("531-repair", nextCompartmentMarkup);

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId,
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        expect(
            getCompartments(db, sessionId).map((row) => [
                row.startMessage,
                row.endMessage,
                row.rebaseStatus,
            ]),
        ).toEqual([
            [1, 2, "ok"],
            [3, 4, "ok"],
            [5, 6, "ok"],
            [7, 7, "ok"],
        ]);
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(0);
    });

    it("publishes on a session the stamped-session repair already fixed", async () => {
        useTempDataHome("compartment-runner-531-healed-");
        const sessionId = "ses-531-historian-healed";
        createOpenCodeDb(sessionId, twelveMessages);
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        seedStuckCompartments(
            db,
            sessionId,
            { start: 3, end: 5, startId: "m-native-compaction-boundary", endId: "m-4" },
            { start: 5, end: 6, startId: "m-5", endId: "m-6" },
        );

        // The first transform pass after the upgrade runs the one-time repair.
        const repair = rebaseSessionCoordinates({
            db,
            sessionId,
            generation: "v2",
            readMessages: readRawSessionMessages,
        });
        expect(repair.status).toBe("repaired");
        expect(
            getCompartments(db, sessionId).map((row) => [row.startMessage, row.endMessage]),
        ).toEqual([
            [1, 2],
            [3, 4],
            [5, 6],
        ]);

        const { client } = historianClient("531-healed", nextCompartmentMarkup);
        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId,
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        expect(getCompartments(db, sessionId).map((row) => row.endMessage)).toEqual([2, 4, 6, 7]);
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(0);
    });

    it("names /ctx-recomp when the neighbours cannot place it, and backs off instead of retrying every trigger", async () => {
        useTempDataHome("compartment-runner-531-unrecoverable-");
        const sessionId = "ses-531-historian-unrecoverable";
        createOpenCodeDb(sessionId, twelveMessages);
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        // Both anchors are gone and the neighbours abut (2 then 3), so the only
        // range the neighbours allow is empty: the row cannot be placed.
        seedStuckCompartments(
            db,
            sessionId,
            { start: 3, end: 5, startId: "m-gone-start", endId: "m-gone-end" },
            { start: 3, end: 6, startId: "m-3", endId: "m-6" },
        );
        const { client, prompt } = historianClient("531-unrecoverable", nextCompartmentMarkup);

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId,
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        const failure = getHistorianFailureState(db, sessionId);
        expect(failure.failureCount).toBe(1);
        expect(failure.lastError).toBe("invalid range 3-2");
        expect(getHistorianPromptCount(prompt)).toBe(0);
        const notices = getRpcNotificationTexts(prompt);
        expect(notices.some((text) => text.includes("(MC-H03)"))).toBe(true);
        expect(notices.some((text) => text.includes("Run /ctx-recomp to rebuild them."))).toBe(
            true,
        );
        expect(notices.some((text) => text.includes("retry automatically"))).toBe(false);
        expect(loadProtectedTailMeta(db, sessionId).historianDrainFailureAt).toBeGreaterThan(0);

        // The next trigger inside the backoff does not fail again.
        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId,
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(1);
        expect(getHistorianPromptCount(prompt)).toBe(0);
    });
});

describe("historian prompt sized to the producer window", () => {
    const sevenMessages = (prefix: string, firstText: string) => [
        { id: `${prefix}-1`, role: "user", text: firstText },
        { id: `${prefix}-2`, role: "assistant", text: "Second eligible message" },
        { id: `${prefix}-3`, role: "user", text: "protected 1" },
        { id: `${prefix}-4`, role: "user", text: "protected 2" },
        { id: `${prefix}-5`, role: "user", text: "protected 3" },
        { id: `${prefix}-6`, role: "user", text: "protected 4" },
        { id: `${prefix}-7`, role: "user", text: "protected 5" },
    ];
    const markup =
        '<compartment start="1" end="2" title="Sized"><p1>Summary of both messages.</p1></compartment>';

    function sizedClient(label: string) {
        const prompt = mock(async () => ({}));
        const create = mock(async () => ({ data: { id: `ses-agent-${label}` } }));
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: `/tmp/${label}` } })),
                create,
                prompt,
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [{ type: "text", text: markup }],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];
        return { client, prompt, create };
    }

    it("counts a window too small for the fixed prompt as one failure and backs off until the window changes", async () => {
        useTempDataHome("compartment-runner-prompt-unfit-backoff-");
        const sessionId = "ses-prompt-unfit-backoff";
        createOpenCodeDb(sessionId, sevenMessages("unfit", "First eligible message"));
        const db = openDatabase();
        const { client, prompt, create } = sizedClient("unfit");
        // 33k window with a 32k output reserve leaves ~1k input: not even the
        // historian system prompt fits.
        const tooSmall = {
            client,
            db,
            sessionId,
            historianChunkTokens: 10_000,
            historianContextLimit: 33_000,
            historianMaxOutputTokens: 32_000,
            model: "test/model",
            directory: "/tmp",
        };

        await runCompartmentAgentWithLease(tooSmall);
        const first = getHistorianFailureState(db, sessionId);
        expect(first.failureCount).toBe(1);
        expect(first.lastError).toContain("producer_prompt_unfit");
        expect(create).toHaveBeenCalledTimes(0);
        const firstNotices = getRpcNotificationTexts(prompt);
        expect(firstNotices.filter((text) => text.includes("(MC-H05)"))).toHaveLength(1);

        // Nothing changed, so the next triggers neither fail again, notify, nor
        // open a child session.
        await runCompartmentAgentWithLease(tooSmall);
        await runCompartmentAgentWithLease(tooSmall);
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(1);
        // Delivery is at-least-once, so the queue still holds the first notice
        // until a client acknowledges it; no second notice joined it.
        expect(
            getRpcNotificationTexts(prompt).filter((text) => text.includes("(MC-H05)")),
        ).toHaveLength(1);
        expect(create).toHaveBeenCalledTimes(0);

        // A larger window changes the outcome, so the historian runs again.
        await runCompartmentAgentWithLease({ ...tooSmall, historianContextLimit: 1_000_000 });
        expect(create).toHaveBeenCalledTimes(1);
        expect(getHistorianPromptCount(prompt)).toBe(1);
        expect(
            getCompartments(db, sessionId).map((row) => [row.startMessage, row.endMessage]),
        ).toEqual([[1, 2]]);
    });

    it("trims the memory block so the chunk fits a window the full prompt would overflow", async () => {
        useTempDataHome("compartment-runner-prompt-fit-memory-");
        const sessionId = "ses-prompt-fit-memory";
        createOpenCodeDb(
            sessionId,
            sevenMessages("memory", `${"session source token ".repeat(1_500)}SOURCE_END`),
        );
        const db = openDatabase();
        const projectPath = resolveProjectIdentity("/tmp");
        const memoryCount = 400;
        for (let index = 0; index < memoryCount; index += 1) {
            insertMemory(db, {
                projectPath,
                category: "ARCHITECTURE",
                content: `Remembered architecture fact number ${index}: ${"the module keeps a durable ledger of every decision it made ".repeat(4)}`,
            });
        }
        const { client, prompt, create } = sizedClient("memory");
        const contextLimit = 100_000;
        const model = "test/fixture-historian";

        // Control: the untrimmed prompt cannot fit this window, so before the
        // prompt was sized the transport refused it on every run.
        const memories = getMemoriesByProject(db, projectPath, ["active", "permanent"]);
        expect(memories).toHaveLength(memoryCount);
        await observeProducerModelsForTest([model], contextLimit);
        const window = resolveHistorianProducerWindow(model, undefined, contextLimit);
        const fullBlock = renderHistorianMemoryBlock(memories);
        const admit = (user: string) =>
            producerPromptFailureReason({
                sourceLocal: estimateTokens(user),
                systemLocal: estimateTokens(COMPARTMENT_AGENT_SYSTEM_PROMPT),
                toolsLocal: 0,
                modelKey: model,
                contextLimitTokens: window.contextLimitTokens,
                inputLimitTokens: window.inputLimitTokens,
                maxOutputTokens: window.maxOutputTokens,
            });
        expect(admit(`${fullBlock}\n\n${"session source token ".repeat(1_500)}`)).toContain(
            "producer_prompt_exceeds_window",
        );

        await runCompartmentAgentWithLease({
            client,
            db,
            sessionId,
            historianChunkTokens: 10_000,
            historianContextLimit: contextLimit,
            model,
            directory: "/tmp",
        });

        expect(create).toHaveBeenCalledTimes(1);
        const sent = prompt.mock.calls
            .map(
                (call) =>
                    call[0] as { body?: { noReply?: boolean; parts?: Array<{ text?: string }> } },
            )
            .filter((input) => input.body?.noReply !== true)
            .map((input) => input.body?.parts?.map((part) => part.text ?? "").join("\n") ?? "");
        expect(sent).toHaveLength(1);
        const user = sent[0] ?? "";
        // The whole chunk went out; the memory block made room for it.
        expect(user).toContain("SOURCE_END");
        expect(user).toContain("<project-memory>");
        const keptLines = user.split("\n").filter((line) => line.startsWith("- Remembered"));
        expect(keptLines.length).toBeGreaterThan(0);
        expect(keptLines.length).toBeLessThan(memoryCount);
        expect(admit(user)).toBeNull();
        expect(
            getCompartments(db, sessionId).map((row) => [row.startMessage, row.endMessage]),
        ).toEqual([[1, 2]]);
        expect(getHistorianFailureState(db, sessionId).failureCount).toBe(0);
    });
});
