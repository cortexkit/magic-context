/// <reference types="bun-types" />

import { beforeEach, describe, expect, it, mock } from "bun:test";

const createMagicContextHookMock = mock(() => ({ mocked: true }));

mock.module("../../hooks/magic-context", () => ({
    createMagicContextHook: createMagicContextHookMock,
}));

describe("createSessionHooks", () => {
    beforeEach(() => {
        createMagicContextHookMock.mockClear();
    });

    it("threads notification config into the magic-context hook", async () => {
        const { createSessionHooks } = await import("./create-session-hooks");

        createSessionHooks({
            ctx: {
                client: {},
                directory: "/tmp/project",
            } as never,
            liveSessionState: {
                liveModelBySession: new Map(),
                variantBySession: new Map(),
                agentBySession: new Map(),
            },
            pluginConfig: {
                enabled: true,
                protected_tags: 10,
                cache_ttl: "5m",
                toast_duration_ms: 30_000,
            } as never,
        });

        expect(createMagicContextHookMock).toHaveBeenCalledTimes(1);
        const args = createMagicContextHookMock.mock.calls[0]?.[0] as {
            config?: { toast_duration_ms?: number };
        };
        expect(args.config?.toast_duration_ms).toBe(30_000);
    });
});
