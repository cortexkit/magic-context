/// <reference types="bun-types" />

/**
 * Focused tests for clearMessageTokensCache. The cache is consumed by the
 * transform path (see transform.ts) and invalidated from event-handler.ts on
 * message.removed / message.updated / session.compacted / session.deleted.
 *
 * These tests exercise the two invalidation modes directly so the per-message
 * path has coverage separate from the session-wide clear path.
 */

import { describe, expect, it } from "bun:test";
import { __getMessageTokensCacheForTest, clearMessageTokensCache } from "./transform";

describe("clearMessageTokensCache", () => {
    describe("#given cached tokens for two messages in one session", () => {
        it("#when called with a messageId, then only that entry is removed", () => {
            const sessionId = "ses-clear-per-message";
            const cache = __getMessageTokensCacheForTest(sessionId);
            cache.set("msg-a", { conversation: 100, toolCall: 0 });
            cache.set("msg-b", { conversation: 50, toolCall: 25 });

            clearMessageTokensCache(sessionId, "msg-a");

            expect(cache.has("msg-a")).toBe(false);
            expect(cache.has("msg-b")).toBe(true);
            expect(cache.get("msg-b")).toEqual({ conversation: 50, toolCall: 25 });
        });

        it("#when called without a messageId, then the entire session cache is cleared", () => {
            const sessionId = "ses-clear-session-wide";
            const cache = __getMessageTokensCacheForTest(sessionId);
            cache.set("msg-a", { conversation: 100, toolCall: 0 });
            cache.set("msg-b", { conversation: 50, toolCall: 25 });

            clearMessageTokensCache(sessionId);

            const after = __getMessageTokensCacheForTest(sessionId);
            expect(after.size).toBe(0);
        });
    });

    describe("#given no cached tokens for a session", () => {
        it("#when called with a messageId, then it is a no-op (no throw)", () => {
            expect(() => clearMessageTokensCache("ses-never-cached", "msg-x")).not.toThrow();
        });

        it("#when called without a messageId, then it is a no-op (no throw)", () => {
            expect(() => clearMessageTokensCache("ses-never-cached")).not.toThrow();
        });
    });

    describe("#given cached tokens for two sessions", () => {
        it("#when one session is cleared, then the other session's cache is untouched", () => {
            const s1 = "ses-isolation-1";
            const s2 = "ses-isolation-2";
            const c1 = __getMessageTokensCacheForTest(s1);
            const c2 = __getMessageTokensCacheForTest(s2);
            c1.set("m1", { conversation: 10, toolCall: 0 });
            c2.set("m2", { conversation: 20, toolCall: 0 });

            clearMessageTokensCache(s1);

            expect(__getMessageTokensCacheForTest(s1).size).toBe(0);
            expect(__getMessageTokensCacheForTest(s2).size).toBe(1);
            expect(__getMessageTokensCacheForTest(s2).get("m2")).toEqual({
                conversation: 20,
                toolCall: 0,
            });
        });
    });
});
