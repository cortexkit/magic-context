import { getProtectionWindowForSession } from "../../features/magic-context/protection-window";
import { createTagger } from "../../features/magic-context/tagger";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import { registerIssue423Tests } from "./issue-423-test-support.test";
import {
    clearProducerModelObservations,
    prepareProducerFixture,
} from "./producer-window-test-support";
import { tagMessages } from "./tag-messages";

// Deliberately cover the initial tool mass so the first pass has no candidates;
// the later >=95% pass yields the window and can prove the episode latch still arms.
const ISSUE_423_PROTECTED_TOKENS = 1_000_000;

registerIssue423Tests("opencode", {
    raw: (fixture) => fixture.raw,
    cleanup(db, sessionId, fixture, percentage) {
        const tagger = createTagger();
        tagger.initFromDb(sessionId, db);
        const tagged = tagMessages(sessionId, fixture.opencode, tagger, db);
        const protectionWindow = getProtectionWindowForSession(
            db,
            sessionId,
            ISSUE_423_PROTECTED_TOKENS,
        );
        const result = applyHeuristicCleanup(
            sessionId,
            db,
            tagged.targets,
            tagged.messageTagNumbers,
            {
                protectedTagNumbers: protectionWindow.protectedTagNumbers,
                protectedCutoff: protectionWindow.cutoff,
                routine: false,
                emergency: {
                    currentTotalInputTokens: percentage * 2040,
                    ceilingTokens: 204000 * 0.65,
                    usagePercentage: percentage,
                },
            },
        );
        tagged.batch.finalize();
        return result.emergencyDroppedTools;
    },
    anthropicMessages: (fixture) =>
        fixture.opencode.map((message) => ({
            info: { id: message.info.id, role: message.info.role },
            parts: message.parts.flatMap((part) => {
                if (part === null || typeof part !== "object") return [];
                const block = part as {
                    type?: unknown;
                    tool?: unknown;
                    callID?: unknown;
                    args?: unknown;
                    state?: { input?: unknown; output?: unknown };
                };
                if (block.type !== "tool" && block.type !== "tool-invocation") {
                    return [structuredClone(part)];
                }
                if (typeof block.callID !== "string") return [];
                if (message.info.role === "assistant") {
                    return [
                        {
                            type: "tool_use",
                            id: block.callID,
                            name: block.tool,
                            input: block.args ?? block.state?.input ?? {},
                        },
                    ];
                }
                return [
                    {
                        type: "tool_result",
                        tool_use_id: block.callID,
                        content: block.state?.output ?? "",
                    },
                ];
            }),
        })),
});

import { mock } from "bun:test";
import type { PluginContext } from "../../plugin/types";
import { runCompartmentAgent } from "./compartment-runner";
import { registerIssue423HistorianTest } from "./issue-423-test-support.test";

registerIssue423HistorianTest(
    "opencode",
    async ({ db, sessionId, boundary, xml, holderId }) => {
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: process.cwd() } })),
                create: mock(async () => ({ data: { id: `${sessionId}-child` } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [{ type: "text", text: xml }],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];
        try {
            await runCompartmentAgent(
                await prepareProducerFixture({
                    historianTurnTwo: "off",
                    client,
                    db,
                    sessionId,
                    directory: process.cwd(),
                    historianChunkTokens: 20000,
                    boundarySnapshot: boundary,
                    compartmentLeaseHolderId: holderId,
                    memoryEnabled: false,
                }),
            );
        } finally {
            clearProducerModelObservations();
        }
    },
    (fixture) => fixture.raw,
);
