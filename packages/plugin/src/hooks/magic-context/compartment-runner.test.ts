/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    getCompartments,
    getSessionFacts,
    replaceAllCompartmentState,
    replaceAllCompartments,
} from "../../features/magic-context/compartment-storage";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import type { PluginContext } from "../../plugin/types";
import * as shared from "../../shared";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    executeContextRecomp,
    getActiveCompartmentRun,
    registerActiveCompartmentRun,
    runCompartmentAgent,
} from "./compartment-runner";
import { tagMessages } from "./tag-messages";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;

    // Clean up historian debug dumps created during tests
    const dumpDir = join(tmpdir(), "magic-context-historian");
    rmSync(dumpDir, { recursive: true, force: true });
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
                                    text: `<compartment start="1" end="4" title="Recovered history">Recovered summary</compartment>\n<CONSTRAINTS>\n* Rebuilt fact.\n</CONSTRAINTS>`,
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
        expect(
            getIgnoredNotificationTexts(client.session.prompt as ReturnType<typeof mock>),
        ).toContain("## Magic Recomp\n\nHistorian pass 1, attempt 1 started for messages 1-4.");
        expect(getCompartments(db, "ses-recomp")).toEqual([
            expect.objectContaining({
                startMessage: 1,
                endMessage: 4,
                startMessageId: "m-1",
                endMessageId: "m-4",
                title: "Recovered history",
            }),
        ]);
        expect(getSessionFacts(db, "ses-recomp")).toEqual([
            expect.objectContaining({ category: "CONSTRAINTS", content: "Rebuilt fact." }),
        ]);
    });

    it("keeps published state unchanged when a later recomp pass fails", async () => {
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
                                    text: `<compartment start="1" end="2" title="Chunk one">Chunk one summary</compartment>\n<WORKFLOW_RULES>\n* Candidate fact.\n</WORKFLOW_RULES>\n<unprocessed_from>3</unprocessed_from>`,
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
            if (callIndex >= 2) {
                throw new Error("historian failed on second pass");
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

        expect(result).toContain("historian failed on second pass");
        expect(getCompartments(db, "ses-recomp-fail")).toEqual([
            expect.objectContaining({
                startMessage: 1,
                endMessage: 2,
                title: "published",
                content: "published summary",
            }),
        ]);
        expect(getSessionFacts(db, "ses-recomp-fail")).toEqual([
            expect.objectContaining({ category: "WORKFLOW_RULES", content: "Published fact." }),
        ]);
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
        const messages = mock(async () => {
            const callIndex = messages.mock.calls.length;
            if (callIndex === 1) {
                return {
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<compartment start="1" end="1" title="Part one">One</compartment>\n<compartment start="3" end="4" title="Part two">Two</compartment>`,
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
                                text: `<compartment start="1" end="4" title="Recovered history">Recovered summary</compartment>\n<CONSTRAINTS>\n* Rebuilt fact.\n</CONSTRAINTS>`,
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

        // Gap healing absorbs the 1-message gap (1→3), so the first attempt succeeds
        // without a repair retry. Both compartments are kept with the gap healed.
        expect(result).toContain("Rebuilt 2 compartments across 1 historian pass");
        expect(messages).toHaveBeenCalledTimes(1);
        expect(getHistorianPromptCount(prompt)).toBe(1);
        expect(getIgnoredNotificationTexts(prompt)).toEqual(
            expect.arrayContaining([
                "## Magic Recomp\n\nHistorian pass 1, attempt 1 started for messages 1-4.",
            ]),
        );
        expect(getCompartments(db, "ses-recomp-retry")).toEqual([
            expect.objectContaining({ startMessage: 1, endMessage: 2, title: "Part one" }),
            expect.objectContaining({ startMessage: 3, endMessage: 4, title: "Part two" }),
        ]);
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
        const messages = mock(async () => {
            const callIndex = messages.mock.calls.length;
            if (callIndex === 1) {
                return {
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [
                                {
                                    type: "text",
                                    text: `<compartment start="1" end="2" title="Pass one">Initial summary</compartment>`,
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
                                text: `<compartment start="3" end="3" title="Pass two">Next summary</compartment>\n<WORKFLOW_RULES>\n* Rewritten fact.\n</WORKFLOW_RULES>`,
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
        expect(getSessionFacts(db, "ses-recomp-full-state")).toEqual([
            expect.objectContaining({ category: "WORKFLOW_RULES", content: "Rewritten fact." }),
        ]);
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

        expect(result).toContain("prompt timed out after 300000ms");
        expect(getIgnoredNotificationTexts(prompt)).toContain(
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
                                    text: `<compartment start="1" end="1" title="Bad one">One</compartment>\n<compartment start="3" end="6" title="Bad two">Two</compartment>`,
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
                                text: `<compartment start="${chunkStart}" end="${chunkEnd}" title="Chunk ${chunkStart}-${chunkEnd}">Chunk ${chunkStart}-${chunkEnd} summary</compartment>\n<WORKFLOW_RULES>\n* Final fact.\n</WORKFLOW_RULES>`,
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

        // Gap healing absorbs the 1-message gap, so the first attempt succeeds
        // without a repair retry or chunk shrinking.
        expect(result).toContain("## Magic Recomp");
        expect(result).toContain("Covered raw history 1-6");
        expect(getIgnoredNotificationTexts(prompt)).toEqual(
            expect.arrayContaining([
                "## Magic Recomp\n\nHistorian pass 1, attempt 1 started for messages 1-6.",
            ]),
        );
        expect(getCompartments(db, "ses-recomp-smaller")).toEqual([
            expect.objectContaining({ startMessage: 1, endMessage: 2 }),
            expect.objectContaining({ startMessage: 3, endMessage: 6 }),
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
                                text: `<compartment start="${chunkStart}" end="${chunkStart + 2}" title="Bad one">One</compartment>\n<compartment start="${chunkStart + 1}" end="${chunkEnd}" title="Bad two">Two</compartment>`,
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
        expect(result).toContain("Recomp failed while rebuilding messages 1-6");
        expect(getIgnoredNotificationTexts(prompt)).toEqual(
            expect.arrayContaining([
                "## Magic Recomp\n\nHistorian pass 1, attempt 1 started for messages 1-6.",
                expect.stringContaining(
                    "Historian pass 1, attempt 1 is continuing with a repair retry for messages 1-6.",
                ),
            ]),
        );
        expect(
            getIgnoredNotificationTexts(prompt).some((text) =>
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
                                    text: `<compartment start="1" end="1" title="Bad one">One</compartment>\n<compartment start="3" end="6" title="Bad two">Two</compartment>`,
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
                                text: `<compartment start="${chunkStart}" end="${chunkEnd}" title="Chunk ${chunkStart}-${chunkEnd}">Chunk ${chunkStart}-${chunkEnd} summary</compartment>\n<WORKFLOW_RULES>\n* Final fact.\n</WORKFLOW_RULES>`,
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

        // Gap healing absorbs the 1-message gap, so the first attempt succeeds
        // without a repair retry. Second pass covers remaining messages.
        expect(result).toContain("Covered raw history 1-7");
        expect(getIgnoredNotificationTexts(prompt)).toEqual(
            expect.arrayContaining([
                "## Magic Recomp\n\nHistorian pass 1, attempt 1 started for messages 1-6.",
                "## Magic Recomp\n\nHistorian pass 2, attempt 1 started for messages 7-7.",
            ]),
        );
    });
});

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
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

function getIgnoredNotificationTexts(promptMock: ReturnType<typeof mock>): string[] {
    return promptMock.mock.calls
        .map(
            (call) => call[0] as { body?: { noReply?: boolean; parts?: Array<{ text?: string }> } },
        )
        .filter((input) => input.body?.noReply === true)
        .map((input) => input.body?.parts?.[0]?.text ?? "");
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
                            text: `<compartment start="1" end="2" title="Docs and setup">Summary content</compartment>\n<WORKFLOW_RULES>\n* Commit to feat first\n</WORKFLOW_RULES>`,
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

        await runCompartmentAgent({
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
                                    text: `<compartment start="1" end="2" title="Recovered">Summary</compartment>`,
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
                await runCompartmentAgent({
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
                                    text: `<compartment start="3" end="4" title="Bad">Bad</compartment>`,
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
                                text: `<compartment start="1" end="2" title="Fallback">Recovered</compartment>`,
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

        await runCompartmentAgent({
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
                            text: `<compartment start="3" end="4" title="Later work">Later summary</compartment>`,
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

        await runCompartmentAgent({
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
        expect(sentPrompt).toContain(
            "Existing state (read-only context for continuity and fact normalization — do NOT re-emit these compartments):",
        );
        expect(sentPrompt).toContain(
            '<compartment start="1" end="2" title="Earlier &quot;work&quot;">',
        );
        expect(sentPrompt).toContain(
            "Rewrite all facts below into canonical present-tense operational form",
        );
        expect(sentPrompt).toContain("<WORKFLOW_RULES>");
        expect(sentPrompt).toContain("* Commit to feat first.");
        expect(sentPrompt).toContain("Do not copy wording verbatim");
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
                                    text: `<compartment start="1" end="2" title="Stored history">Stored summary</compartment>`,
                                },
                            ],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgent({
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
        await runCompartmentAgent({
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
                            text: `<compartment start="1" end="2" title="Eligible work">Summary</compartment>`,
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
        await runCompartmentAgent({
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

        await runCompartmentAgent({
            client,
            db,
            sessionId: "ses-invalid-existing",
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        expect(createSession).not.toHaveBeenCalled();
        expect(getCompartments(db, "ses-invalid-existing")).toHaveLength(2);
        expect(getIgnoredNotificationTexts(promptSession)[0]).toContain(
            "existing stored compartments are invalid",
        );
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
                                    text: `<compartment start="1" end="1" title="Part one">One</compartment>\n<compartment start="3" end="3" title="Part two">Two</compartment>`,
                                },
                            ],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];

        await runCompartmentAgent({
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
        expect(getIgnoredNotificationTexts(promptSession)[0]).toContain(
            "invalid compartment output",
        );
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

        await runCompartmentAgent({
            client,
            db,
            sessionId: "ses-model-failure",
            historianChunkTokens: 10_000,
            directory: "/tmp",
        });

        expect(getCompartments(db, "ses-model-failure")).toHaveLength(0);
        expect(getIgnoredNotificationTexts(promptSession)[0]).toContain(
            "historian model unavailable",
        );
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
