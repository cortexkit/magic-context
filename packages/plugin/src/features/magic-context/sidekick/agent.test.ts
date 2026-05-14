/// <reference types="bun-types" />

import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { SidekickConfig } from "../../../config/schema/magic-context";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { runSidekick } from "./agent";

const baseConfig: SidekickConfig = {
    enabled: true,
    timeout_ms: 5_000,
};

function createSidekickClient(
    args: { createSessionId?: string | null; messages?: unknown[] } = {},
): PluginContext["client"] {
    return {
        session: {
            create: mock(async () =>
                args.createSessionId === null
                    ? { data: {} }
                    : { data: { id: args.createSessionId ?? "sidekick-child" } },
            ),
            prompt: mock(async () => undefined),
            messages: mock(async () => ({
                data: args.messages ?? [
                    {
                        info: { role: "assistant", time: { created: Date.now() } },
                        parts: [{ type: "text", text: "Relevant memory briefing" }],
                    },
                ],
            })),
            delete: mock(async () => ({ data: undefined })),
        },
    } as unknown as PluginContext["client"];
}

afterEach(() => {
    mock.restore();
});

afterAll(() => {
    mock.restore();
});

describe("runSidekick", () => {
    it("creates a child session, prompts the sidekick agent, and deletes the child session", async () => {
        const client = createSidekickClient();
        const promptSyncSpy = spyOn(shared, "promptSyncWithModelSuggestionRetry").mockResolvedValue(
            undefined,
        );

        const result = await runSidekick({
            client,
            sessionId: "ses-parent",
            projectPath: "/repo/project",
            sessionDirectory: "/repo/project",
            userMessage: "Implement sidekick and keep Bun workflow rules.",
            config: baseConfig,
        });

        expect(result).toBe("Relevant memory briefing");
        expect(client.session.create).toHaveBeenCalledWith({
            body: { parentID: "ses-parent", title: "magic-context-sidekick" },
            query: { directory: "/repo/project" },
        });
        expect(promptSyncSpy).toHaveBeenCalledWith(
            client,
            {
                path: { id: "sidekick-child" },
                query: { directory: "/repo/project" },
                body: {
                    agent: "sidekick",
                    system: expect.stringContaining('ctx_search(query="'),
                    parts: [
                        {
                            type: "text",
                            text: "Implement sidekick and keep Bun workflow rules.",
                            synthetic: true,
                        },
                    ],
                },
            },
            {
                timeoutMs: 5_000,
                fallbackModels: expect.any(Array),
                callContext: "sidekick",
            },
        );
        expect(client.session.messages).toHaveBeenCalledWith({
            path: { id: "sidekick-child" },
            query: { directory: "/repo/project" },
        });
        expect(client.session.delete).toHaveBeenCalledWith({
            path: { id: "sidekick-child" },
        });
    });

    it("strips thinking blocks from the final output", async () => {
        const client = createSidekickClient({
            messages: [
                {
                    info: { role: "assistant", time: { created: Date.now() } },
                    parts: [{ type: "text", text: "<think>hidden</think>Focused result" }],
                },
            ],
        });
        spyOn(shared, "promptSyncWithModelSuggestionRetry").mockResolvedValue(undefined);

        const result = await runSidekick({
            client,
            projectPath: "/repo/project",
            userMessage: "Implement sidekick.",
            config: baseConfig,
        });

        expect(result).toBe("Focused result");
    });

    it("returns null when the child session cannot be created", async () => {
        const client = createSidekickClient({ createSessionId: null });

        const result = await runSidekick({
            client,
            projectPath: "/repo/project",
            userMessage: "Implement sidekick.",
            config: baseConfig,
        });

        expect(result).toBeNull();
        expect(client.session.delete).not.toHaveBeenCalled();
    });

    it("returns null when prompting fails and still deletes the child session", async () => {
        const client = createSidekickClient();
        spyOn(shared, "promptSyncWithModelSuggestionRetry").mockRejectedValue(
            new Error("prompt timed out after 5000ms"),
        );

        const result = await runSidekick({
            client,
            projectPath: "/repo/project",
            userMessage: "Implement sidekick.",
            config: baseConfig,
        });

        expect(result).toBeNull();
        expect(client.session.delete).toHaveBeenCalledTimes(1);
    });

    it("uses config system_prompt when provided", async () => {
        const client = createSidekickClient();
        const promptSyncSpy = spyOn(shared, "promptSyncWithModelSuggestionRetry").mockResolvedValue(
            undefined,
        );

        await runSidekick({
            client,
            projectPath: "/repo/project",
            userMessage: "Implement sidekick.",
            config: {
                ...baseConfig,
                system_prompt: "Custom sidekick system prompt",
            },
        });

        expect(promptSyncSpy.mock.calls[0]?.[1]).toEqual(
            expect.objectContaining({
                body: expect.objectContaining({
                    system: "Custom sidekick system prompt",
                }),
            }),
        );
    });
});
