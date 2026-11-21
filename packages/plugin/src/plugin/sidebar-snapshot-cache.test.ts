import { afterEach, describe, expect, test } from "bun:test";
import type { SidebarSnapshot } from "../shared/rpc-types";
import {
    applyStickySnapshotCache,
    clearSidebarSnapshotCache,
    resetSidebarSnapshotCache,
} from "./sidebar-snapshot-cache";

afterEach(() => {
    resetSidebarSnapshotCache();
});

function makeSnapshot(overrides: Partial<SidebarSnapshot> = {}): SidebarSnapshot {
    return {
        sessionId: "ses_test",
        usagePercentage: 0,
        inputTokens: 0,
        contextLimit: 0,
        systemPromptTokens: 0,
        compartmentCount: 0,
        memoryCount: 0,
        memoryBlockCount: 0,
        pendingOpsCount: 0,
        historianRunning: false,
        compartmentInProgress: false,
        sessionNoteCount: 0,
        readySmartNoteCount: 0,
        cacheTtl: "5m",
        lastDreamerRunAt: null,
        projectIdentity: null,
        compartmentTokens: 0,
        factTokens: 0,
        memoryTokens: 0,
        conversationTokens: 0,
        toolCallTokens: 0,
        toolDefinitionTokens: 0,
        executeThreshold: 65,
        ...overrides,
    };
}

describe("applyStickySnapshotCache", () => {
    test("passes through fresh snapshot when inputTokens > 0 and caches it", () => {
        const fresh = makeSnapshot({
            inputTokens: 100_000,
            usagePercentage: 30,
            systemPromptTokens: 25_000,
            compartmentTokens: 50_000,
            conversationTokens: 25_000,
            compartmentCount: 5,
            memoryCount: 10,
        });
        const result = applyStickySnapshotCache("ses_test", fresh);
        expect(result).toEqual(fresh);
    });

    test("passes through zero snapshot when no prior cached value (true new session)", () => {
        const fresh = makeSnapshot({ inputTokens: 0 });
        const result = applyStickySnapshotCache("ses_test", fresh);
        expect(result.inputTokens).toBe(0);
    });

    test("returns hybrid (cached tokens + fresh counts) when inputTokens drops to 0 mid-turn", () => {
        // First: a good snapshot is cached.
        applyStickySnapshotCache(
            "ses_test",
            makeSnapshot({
                inputTokens: 350_000,
                usagePercentage: 35,
                systemPromptTokens: 25_000,
                compartmentTokens: 128_000,
                factTokens: 200,
                memoryTokens: 8_000,
                conversationTokens: 53_000,
                toolCallTokens: 99_000,
                toolDefinitionTokens: 32_000,
                compartmentCount: 392,
                memoryCount: 486,
            }),
        );
        // Now an in-flight pass returns 0 inputTokens but a fresh count
        // (e.g. the user just sent a message and historian is updating).
        const flickered = makeSnapshot({
            inputTokens: 0, // mid-turn flicker
            compartmentCount: 393, // a new compartment landed
            memoryCount: 487,
            historianRunning: true,
            pendingOpsCount: 12,
        });
        const result = applyStickySnapshotCache("ses_test", flickered);

        // Token-breakdown values come from the cached snapshot.
        expect(result.inputTokens).toBe(350_000);
        expect(result.usagePercentage).toBe(35);
        expect(result.systemPromptTokens).toBe(25_000);
        expect(result.compartmentTokens).toBe(128_000);
        expect(result.factTokens).toBe(200);
        expect(result.memoryTokens).toBe(8_000);
        expect(result.conversationTokens).toBe(53_000);
        expect(result.toolCallTokens).toBe(99_000);
        expect(result.toolDefinitionTokens).toBe(32_000);

        // Counts and live state come from the fresh build.
        expect(result.compartmentCount).toBe(393);
        expect(result.memoryCount).toBe(487);
        expect(result.historianRunning).toBe(true);
        expect(result.pendingOpsCount).toBe(12);
    });

    test("clears cached tokens when zero snapshot drops counts too (real reset)", () => {
        // Cache a non-zero snapshot WITH counts.
        applyStickySnapshotCache(
            "ses_test",
            makeSnapshot({
                inputTokens: 100_000,
                compartmentCount: 5,
                memoryCount: 10,
            }),
        );

        // Real reset: tokens AND counts both dropped to zero, no in-flight signal.
        const reset = applyStickySnapshotCache(
            "ses_test",
            makeSnapshot({
                inputTokens: 0,
                compartmentCount: 0,
                memoryCount: 0,
                compartmentInProgress: false,
                historianRunning: false,
            }),
        );
        expect(reset.inputTokens).toBe(0);

        // After reset, even with in-flight signal returning later, there's
        // no prior cached entry to restore.
        const later = applyStickySnapshotCache(
            "ses_test",
            makeSnapshot({ inputTokens: 0, compartmentInProgress: true }),
        );
        expect(later.inputTokens).toBe(0);
    });

    test("sticks during first-user-prompt flicker when counts survive", () => {
        // Regression: when a session is opened in TUI, sidebar shows the full
        // breakdown. Then the user types their first prompt. The transform
        // runs before the model responds, so last_input_tokens transiently
        // reads 0 — no historian, no queued ops, no compartment work in
        // progress. Authoritative counts (compartments, memories) are
        // unchanged. Previously this wiped the cache and the sidebar went
        // blank until the assistant's first message arrived.
        applyStickySnapshotCache(
            "ses_test",
            makeSnapshot({
                inputTokens: 350_000,
                usagePercentage: 35,
                systemPromptTokens: 25_000,
                compartmentTokens: 128_000,
                memoryTokens: 8_000,
                conversationTokens: 100_000,
                compartmentCount: 392,
                memoryCount: 486,
            }),
        );

        const firstPromptFlicker = makeSnapshot({
            inputTokens: 0,
            // No in-flight signals — user just typed, model hasn't responded.
            compartmentInProgress: false,
            historianRunning: false,
            pendingOpsCount: 0,
            // Counts unchanged from the cached good reading.
            compartmentCount: 392,
            memoryCount: 486,
        });
        const result = applyStickySnapshotCache("ses_test", firstPromptFlicker);

        // Breakdown survives the flicker.
        expect(result.inputTokens).toBe(350_000);
        expect(result.compartmentTokens).toBe(128_000);
        expect(result.memoryTokens).toBe(8_000);
        expect(result.conversationTokens).toBe(100_000);
    });

    test("keeps the native-window percentage with the cached tokens during the zero window", () => {
        applyStickySnapshotCache(
            "ses_test",
            makeSnapshot({
                inputTokens: 475_000,
                usagePercentage: 47.5,
                native_context_usage_percentage: 47.5,
                compaction_enabled: false,
            }),
        );
        // A fresh build in the zero window divides 0 tokens by the native window.
        const result = applyStickySnapshotCache(
            "ses_test",
            makeSnapshot({
                inputTokens: 0,
                native_context_usage_percentage: 0,
                compaction_enabled: false,
                compartmentInProgress: true,
            }),
        );
        expect(result.inputTokens).toBe(475_000);
        expect(result.native_context_usage_percentage).toBe(47.5);
    });

    test("sticks when compartment work is explicitly in progress", () => {
        applyStickySnapshotCache("ses_test", makeSnapshot({ inputTokens: 100_000 }));
        const result = applyStickySnapshotCache(
            "ses_test",
            makeSnapshot({ inputTokens: 0, compartmentInProgress: true }),
        );
        expect(result.inputTokens).toBe(100_000);
    });

    test("does not stick after fresh non-zero overwrites the cached zero state", () => {
        applyStickySnapshotCache("ses_test", makeSnapshot({ inputTokens: 100_000 }));
        // Mid-turn flicker — sticks.
        const stuck = applyStickySnapshotCache(
            "ses_test",
            makeSnapshot({ inputTokens: 0, compartmentInProgress: true }),
        );
        expect(stuck.inputTokens).toBe(100_000);
        // Fresh good reading lands — overwrites the cache.
        const fresh = applyStickySnapshotCache("ses_test", makeSnapshot({ inputTokens: 200_000 }));
        expect(fresh.inputTokens).toBe(200_000);
        // Subsequent flicker now sticks to the new value.
        const stuck2 = applyStickySnapshotCache(
            "ses_test",
            makeSnapshot({ inputTokens: 0, compartmentInProgress: true }),
        );
        expect(stuck2.inputTokens).toBe(200_000);
    });

    test("does not bleed across sessions", () => {
        applyStickySnapshotCache(
            "ses_a",
            makeSnapshot({ sessionId: "ses_a", inputTokens: 100_000 }),
        );
        const result = applyStickySnapshotCache(
            "ses_b",
            makeSnapshot({ sessionId: "ses_b", inputTokens: 0 }),
        );
        expect(result.inputTokens).toBe(0);
        expect(result.sessionId).toBe("ses_b");
    });

    test("clearSidebarSnapshotCache removes cached entry for a session", () => {
        applyStickySnapshotCache("ses_test", makeSnapshot({ inputTokens: 100_000 }));
        clearSidebarSnapshotCache("ses_test");
        const result = applyStickySnapshotCache("ses_test", makeSnapshot({ inputTokens: 0 }));
        // No prior cache after clear → passes through as new session.
        expect(result.inputTokens).toBe(0);
    });

    test("expires stale cached snapshot after age threshold", () => {
        // Manipulate the date to simulate aging beyond 5min.
        const realNow = Date.now;
        const t0 = 1_000_000_000_000;
        Date.now = () => t0;
        applyStickySnapshotCache("ses_test", makeSnapshot({ inputTokens: 100_000 }));

        // 6 minutes later, pass a zero snapshot.
        Date.now = () => t0 + 6 * 60 * 1000;
        const result = applyStickySnapshotCache("ses_test", makeSnapshot({ inputTokens: 0 }));
        expect(result.inputTokens).toBe(0);

        Date.now = realNow;
    });
});
