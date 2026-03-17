import { describe, expect, it } from "bun:test";
import {
    resolveCacheTtl,
    resolveContextLimit,
    resolveModelKey,
    resolveSessionId,
} from "./event-resolvers";

describe("event-resolvers", () => {
    describe("resolveContextLimit", () => {
        it("returns model-specific cache limit for non-anthropic providers", () => {
            //#given
            const config = {
                modelContextLimitsCache: new Map([["openai/gpt-4o", 300_000]]),
            };

            //#when
            const limit = resolveContextLimit("openai", "gpt-4o", config);

            //#then
            expect(limit).toBe(300_000);
        });

        it("returns model-specific cache limit for anthropic when user overrides", () => {
            //#given — user explicitly sets a custom limit in their provider config
            const config = {
                modelContextLimitsCache: new Map([["anthropic/claude-opus-4-6", 500_000]]),
            };

            //#when
            const limit = resolveContextLimit("anthropic", "claude-opus-4-6", config);

            //#then
            expect(limit).toBe(500_000);
        });

        it("defaults anthropic to 1M when no cache entry exists", () => {
            //#given
            const config = {
                modelContextLimitsCache: new Map<string, number>(),
            };

            //#when
            const limit = resolveContextLimit("anthropic", "claude-opus-4-5", config);

            //#then
            expect(limit).toBe(1_000_000);
        });

        it("returns default for missing provider", () => {
            //#given
            const config = { modelContextLimitsCache: new Map<string, number>() };

            //#when
            const limit = resolveContextLimit(undefined, "gpt-4o", config);

            //#then
            expect(limit).toBe(200_000);
        });
    });

    describe("resolveCacheTtl", () => {
        it("returns direct string ttl for string config", () => {
            //#when
            const ttl = resolveCacheTtl("5m", "openai/gpt-4o");

            //#then
            expect(ttl).toBe("5m");
        });

        it("resolves provider/model and bare-model overrides", () => {
            //#given
            const cacheTtl = {
                default: "5m",
                "openai/gpt-4o": "1m",
                "gpt-4o-mini": "2m",
            };

            //#when
            const providerModel = resolveCacheTtl(cacheTtl, "openai/gpt-4o");
            const bareModel = resolveCacheTtl(cacheTtl, "openai/gpt-4o-mini");

            //#then
            expect(providerModel).toBe("1m");
            expect(bareModel).toBe("2m");
        });
    });

    describe("resolveModelKey", () => {
        it("returns provider/model when both parts exist", () => {
            expect(resolveModelKey("openai", "gpt-4o")).toBe("openai/gpt-4o");
        });

        it("returns undefined when either part is missing", () => {
            expect(resolveModelKey(undefined, "gpt-4o")).toBeUndefined();
            expect(resolveModelKey("openai", undefined)).toBeUndefined();
        });
    });

    describe("resolveSessionId", () => {
        it("prefers properties.sessionID when present", () => {
            const sessionId = resolveSessionId({
                sessionID: "ses-direct",
                info: { id: "ses-info" },
            });
            expect(sessionId).toBe("ses-direct");
        });

        it("falls back to info.sessionID and info.id", () => {
            expect(resolveSessionId({ info: { sessionID: "ses-info" } })).toBe("ses-info");
            expect(resolveSessionId({ info: { id: "ses-id" } })).toBe("ses-id");
        });
    });
});
