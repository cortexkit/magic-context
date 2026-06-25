import { describe, expect, test } from "bun:test";
import {
    createIntentByCallIdMap,
    getAndDeleteIntent,
    intentKey,
    pruneIntentsForSession,
    stashIntent,
} from "./hook-handlers";

describe("intentByCallId stash map", () => {
    test("stashIntent stores intent keyed by callId", () => {
        const map = createIntentByCallIdMap();
        stashIntent(map, "call-1", "fix the bug in auth");
        expect(getAndDeleteIntent(map, "call-1")).toBe("fix the bug in auth");
    });

    test("getAndDeleteIntent removes the entry (finally-delete semantics)", () => {
        const map = createIntentByCallIdMap();
        stashIntent(map, "call-2", "some intent");
        getAndDeleteIntent(map, "call-2");
        expect(getAndDeleteIntent(map, "call-2")).toBeNull();
    });

    test("stashIntent evicts entries older than 60s (TTL backstop)", () => {
        const map = createIntentByCallIdMap();
        // Manually insert a stale entry (65s > 60s TTL, clearly expired regardless of boundary strictness)
        map.set("stale-call", { intent: "old intent", ts: Date.now() - 65_000 });
        stashIntent(map, "new-call", "new intent"); // triggers sweep
        expect(map.has("stale-call")).toBe(false);
        expect(map.has("new-call")).toBe(true);
    });

    test("stashIntent hard-caps map at 256 entries (evicts oldest)", () => {
        const map = createIntentByCallIdMap();
        // Fill to 256
        for (let i = 0; i < 256; i++) {
            map.set(`call-${i}`, { intent: `intent-${i}`, ts: Date.now() - i });
        }
        // Adding one more should evict the oldest
        stashIntent(map, "call-overflow", "overflow intent");
        expect(map.size).toBeLessThanOrEqual(256);
        expect(map.has("call-overflow")).toBe(true);
    });

    test("pruneIntentsForSession removes ONLY the deleted session's entries", () => {
        // Regression (P1): a bare-callID key + .clear() on session delete wiped
        // EVERY concurrent session's in-flight intents. Keying by
        // `${sessionId}:${callId}` + prefix-prune isolates the delete.
        const map = createIntentByCallIdMap();
        stashIntent(map, intentKey("ses-A", "call-1"), "A intent");
        stashIntent(map, intentKey("ses-B", "call-1"), "B intent");
        stashIntent(map, intentKey("ses-B", "call-2"), "B intent 2");

        pruneIntentsForSession(map, "ses-A");

        // ses-A's entry is gone; ses-B's two survive (callID "call-1" collides
        // across sessions but the composite key keeps them distinct).
        expect(getAndDeleteIntent(map, intentKey("ses-A", "call-1"))).toBeNull();
        expect(getAndDeleteIntent(map, intentKey("ses-B", "call-1"))).toBe("B intent");
        expect(getAndDeleteIntent(map, intentKey("ses-B", "call-2"))).toBe("B intent 2");
    });
});
