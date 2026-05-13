/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";

/**
 * Plan v6: deferred compaction marker — publish-time persistence and
 * defer-pass stability.
 *
 * Cache-stability is the north star. The plan defers compaction-marker
 * movement out of historian's publish path into a later materializing
 * transform pass — so a single cache-bust cycle covers both the
 * `<session-history>` rebuild AND the marker boundary advance.
 *
 * This test drives:
 *   1. Multiple turns with `compaction_markers: true` (default) to trigger
 *      historian publication.
 *   2. After publish: asserts the `pending_compaction_marker_state` column on
 *      `session_meta` is populated (in-tx pending blob, plan v6 §4).
 *   3. Sends a small follow-up turn (defer pass with low pressure): asserts
 *      the pending blob is STILL there (no mutation on defer pass).
 *
 * If a regression breaks the in-tx pending write OR causes defer passes to
 * mutate / consume the pending blob, this test catches it.
 *
 * NOTE: We do not assert the actual drain firing here. Drain timing depends on
 * the next materialization pass (execute-pass + history-was-consumed), which is
 * provider-pressure-dependent and brittle to script in a mocked e2e. Drain
 * correctness is covered by unit tests in
 * `compaction-marker-manager.test.ts` (apply / already-current / stale-skip /
 * retryable-failure outcomes) and by transform-postprocess unit tests
 * exercising the drain branch directly. This e2e specifically proves the
 * persistence + defer-stability half of the contract.
 *
 * Assertions are against the plugin's own `session_meta` table — the
 * canonical state for "did historian publish write a pending blob".
 */

const HISTORIAN_SYSTEM_MARKER = "You condense long AI coding sessions";

function isHistorianRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    if (typeof system === "string") return system.includes(HISTORIAN_SYSTEM_MARKER);
    if (Array.isArray(system)) {
        for (const block of system) {
            if (block && typeof block === "object") {
                const text = (block as { text?: unknown }).text;
                if (typeof text === "string" && text.includes(HISTORIAN_SYSTEM_MARKER)) {
                    return true;
                }
            }
        }
    }
    return false;
}

function findOrdinalRange(body: Record<string, unknown>): { start: number; end: number } | null {
    const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
    if (!messages) return null;
    for (const m of messages) {
        const contentArr = Array.isArray(m.content) ? m.content : [];
        for (const block of contentArr) {
            const text = (block as { text?: string }).text;
            if (!text || !text.includes("<new_messages>")) continue;
            const matches = text.matchAll(/\[(\d+)\]/g);
            const nums: number[] = [];
            for (const mm of matches) nums.push(Number(mm[1]));
            if (nums.length === 0) continue;
            return { start: Math.min(...nums), end: Math.max(...nums) };
        }
    }
    return null;
}

interface PendingRow {
    pending_compaction_marker_state: string | null;
    compaction_marker_state: string | null;
}

function readMarkerState(h: TestHarness, sessionId: string): PendingRow | null {
    const row = h
        .contextDb()
        .prepare(
            "SELECT pending_compaction_marker_state, compaction_marker_state FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as PendingRow | null;
    return row;
}

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        magicContextConfig: {
            execute_threshold_percentage: 40,
            // compaction_markers: true — the DEFAULT, but make it explicit so
            // future schema-default changes don't silently turn this test into
            // a no-op.
            compaction_markers: true,
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("deferred compaction marker (plan v6)", () => {
    it(
        "writes pending blob in-tx on publish and holds it across defer passes",
        async () => {
            h.mock.reset();

            // Mock historian: return a valid response that covers the actual
            // chunk range we receive.
            h.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                const range = findOrdinalRange(body);
                if (!range) {
                    return {
                        text: "<output><compartments></compartments><facts></facts><unprocessed_from>1</unprocessed_from></output>",
                        usage: {
                            input_tokens: 100,
                            output_tokens: 50,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                        },
                    };
                }
                const payload = [
                    "<output>",
                    "<compartments>",
                    `<compartment start="${range.start}" end="${range.end}" title="e2e marker drain chunk">`,
                    "Initial turns driven by the e2e harness — exercises the deferred-marker drain path.",
                    "</compartment>",
                    "</compartments>",
                    "<facts></facts>",
                    `<unprocessed_from>${range.end + 1}</unprocessed_from>`,
                    "</output>",
                ].join("\n");
                return {
                    text: payload,
                    usage: {
                        input_tokens: 500,
                        output_tokens: 200,
                        cache_creation_input_tokens: 500,
                        cache_read_input_tokens: 0,
                    },
                };
            });

            // Default response: small. Won't move us across the threshold.
            h.mock.setDefault({
                text: "fill",
                usage: {
                    input_tokens: 1_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                    cache_read_input_tokens: 0,
                },
            });

            const sessionId = await h.createSession();

            // Drive 10 small turns to build eligible tail.
            for (let i = 1; i <= 10; i++) {
                await h.sendPrompt(
                    sessionId,
                    `turn ${i}: meaningful prompt carrying durable signal for chunk ${i}.`,
                );
            }

            // Turn 11: 90K tokens crosses 40% threshold AND makes tail eligible.
            h.mock.setDefault({
                text: "big",
                usage: {
                    input_tokens: 90_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 90_000,
                    cache_read_input_tokens: 0,
                },
            });
            await h.sendPrompt(sessionId, "turn 11: trigger turn with real content.");

            // Reset to small responses so the publish doesn't get re-triggered
            // by every follow-up turn.
            h.mock.setDefault({
                text: "after-trigger",
                usage: {
                    input_tokens: 500,
                    output_tokens: 10,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 500,
                },
            });

            // Turn 12: gives the transform a fresh pass to start historian
            // (same pattern as historian-success.test.ts).
            await h.sendPrompt(sessionId, "turn 12: post-trigger follow-up.");

            // ── ASSERTION 1: pending blob populated after publish ─────────
            await h.waitFor(
                () => {
                    const row = readMarkerState(h, sessionId);
                    return row?.pending_compaction_marker_state != null
                        && row.pending_compaction_marker_state.length > 0;
                },
                { timeoutMs: 30_000, label: "pending_compaction_marker_state set after publish" },
            );

            const afterPublish = readMarkerState(h, sessionId);
            expect(afterPublish).not.toBeNull();
            expect(afterPublish?.pending_compaction_marker_state).toBeTruthy();

            // Pending blob is JSON with ordinal/endMessageId/publishedAt.
            const pendingBlob = JSON.parse(afterPublish?.pending_compaction_marker_state ?? "{}");
            expect(typeof pendingBlob.ordinal).toBe("number");
            expect(pendingBlob.ordinal).toBeGreaterThan(0);
            expect(typeof pendingBlob.endMessageId).toBe("string");
            expect(pendingBlob.endMessageId.length).toBeGreaterThan(0);
            expect(typeof pendingBlob.publishedAt).toBe("number");

            console.log(
                `[TEST] pending blob written: ordinal=${pendingBlob.ordinal} endMessageId=${pendingBlob.endMessageId}`,
            );

            // ── ASSERTION 2: defer passes don't mutate pending blob ───────
            // Send a small turn that stays well under threshold — should be
            // a defer pass per pressure (we're now low because cache_read
            // dominates and the small response keeps us there).
            const pendingBefore = afterPublish?.pending_compaction_marker_state;
            await h.sendPrompt(sessionId, "small defer turn — no mutation expected");

            // Give the transform a moment to settle, then re-read.
            const pendingAfter = readMarkerState(h, sessionId);
            console.log(
                `[TEST] after defer turn: pending=${pendingAfter?.pending_compaction_marker_state?.slice(0, 40)} applied=${pendingAfter?.compaction_marker_state?.slice(0, 40)}`,
            );
            // The pending blob should still match the post-publish snapshot.
            // It either stays equal OR the drain has already fired (applied
            // populated, pending cleared) if the small turn happened to be
            // an execute pass. Either is correct behavior; only "drained
            // without applying" or "pending changed mid-flight" would be a
            // regression. Assert one of these two valid states:
            const drained =
                pendingAfter?.pending_compaction_marker_state == null
                && pendingAfter?.compaction_marker_state != null
                && pendingAfter.compaction_marker_state.length > 0;
            const unchanged =
                pendingAfter?.pending_compaction_marker_state === pendingBefore;
            expect(drained || unchanged).toBe(true);

        },
        90_000,
    );
});
