import { registerIssue424Tests } from "./issue-424-test-support.test";

registerIssue424Tests("opencode", (fixture) => fixture.raw);

import { mock } from "bun:test";
import type { PluginContext } from "../../plugin/types";
import { runCompartmentAgent } from "./compartment-runner";
import { registerIssue424CapacityTests } from "./issue-424-capacity-test-support.test";
import {
    clearProducerModelObservations,
    prepareProducerFixture,
} from "./producer-window-test-support";

registerIssue424CapacityTests(
    "opencode",
    (fixture) => fixture.raw,
    async ({
        db,
        sessionId,
        boundary,
        xml,
        holderId,
        historianChunkTokens,
        historianContextLimit,
        maxOutputTokens,
    }) => {
        const prompts: string[] = [];
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: process.cwd() } })),
                create: mock(async () => ({ data: { id: `${sessionId}-child` } })),
                prompt: mock(async (args: { body: { parts: Array<{ text?: string }> } }) => {
                    prompts.push(args.body.parts.map((part) => part.text ?? "").join("\n"));
                    return {};
                }),
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
                    historianChunkTokens,
                    historianContextLimit,
                    historianMaxOutputTokens: maxOutputTokens,
                    boundarySnapshot: boundary,
                    compartmentLeaseHolderId: holderId,
                    memoryEnabled: false,
                }),
            );
        } finally {
            clearProducerModelObservations();
        }
        return prompts;
    },
);
