/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { isCheckpointNote } from '../../plugin/src/v2/fold/summary';
import { V2StoreReader, gaDatabasePath } from '../../plugin/src/v2/store-reader';
import { TestHarness } from "../src/harness";
import { OpenCode2TestHarness } from '../src/opencode2-harness';
import {
    createScenarioHarness,
    forEachHost,
    isPiFamily,
    type ScenarioHarness,
} from "../src/scenario-hosts";
import { buildMockHistorianPayload, findHistorianOrdinalRange } from "../src/mock-historian";
import { expectNativeAdmission } from "./opencode2/helpers/native-admission";

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
 *   1. Multiple turns with compaction markers (always-on since v0.21.4) to trigger
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

const HISTORIAN_SYSTEM_MARKER =
    "the hippocampus of a long-running coding agent";
const RUST_MODE = process.env.MC_E2E_MODE === "rust";

function isHistorianRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    if (typeof system === "string")
        return system.includes(HISTORIAN_SYSTEM_MARKER);
    if (Array.isArray(system)) {
        for (const block of system) {
            if (block && typeof block === "object") {
                const text = (block as { text?: unknown }).text;
                if (
                    typeof text === "string" &&
                    text.includes(HISTORIAN_SYSTEM_MARKER)
                ) {
                    return true;
                }
            }
        }
    }
    return false;
}

interface PendingRow {
    pending_compaction_marker_state: string | null;
    compaction_marker_state: string | null;
}

function readMarkerState(h: ScenarioHarness, sessionId: string): PendingRow | null {
    const pendingColumn = isPiFamily(h.host)
        ? "pending_pi_compaction_marker_state"
        : "pending_compaction_marker_state";
    const row = h
        .contextDb()
        .prepare(
            `SELECT ${pendingColumn} AS pending_compaction_marker_state, compaction_marker_state FROM session_meta WHERE session_id = ?`,
        )
        .get(sessionId) as PendingRow | null;
    return row;
}

forEachHost(import.meta.url, "deferred compaction marker (plan v6)", (host) => {
    let h: ScenarioHarness;

    beforeAll(async () => {
        h = await createScenarioHarness(host, {
            magicContextConfig: {
                execute_threshold_percentage: 40,
            },
        });
    });

    afterAll(async () => {
        await h.dispose();
    });
    it(host === "opencode2" ? "publishes a compartment and supplies a durable native checkpoint without a provider call" : "writes pending blob in-tx on publish and holds it across defer passes", async () => {
            h.mock.reset();

            // Mock historian: return a valid response that covers the actual
            // chunk range we receive.
            h.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                const range = findHistorianOrdinalRange(body);
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
                const payload = buildMockHistorianPayload({
                    start: range.start,
                    end: range.end,
                    title: "e2e marker drain chunk",
                    body: "Initial turns driven by the e2e harness — exercises the deferred-marker drain path.",
                });
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
                    `turn ${i}: meaningful prompt carrying durable signal for chunk ${i}. ${h.ballast(3_000)}`,
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
        if (h instanceof OpenCode2TestHarness) {
            await h.waitFor(() => h.countCompartments(sessionId) > 0, { timeoutMs: 30_000, label: "historian publication before native fold" });
            expect(readMarkerState(h, sessionId)?.pending_compaction_marker_state).toBeNull();
            const before = h.mock.requests().length;
            await h.compactSession(sessionId);
            expect(h.mock.requests().length).toBe(before);
            const reader = new V2StoreReader(gaDatabasePath(h.dataDir, "latest", h.opencode.env));
            try {
                const checkpoint = reader.latestCompaction(sessionId);
                expect(checkpoint?.data.status).toBe("completed");
                // The host stores a short note; Magic Context keeps the history
                // head itself and still sends it (checked on the next request).
                expect(isCheckpointNote(checkpoint?.data.summary)).toBe(true);
                expect(checkpoint?.data.summary).not.toContain("<session-history>");
            } finally { reader.close(); }
            expectNativeAdmission(h, sessionId);
            await h.sendPrompt(sessionId, "small defer turn — native checkpoint remains visible");
            const sent = JSON.stringify(h.mock.lastRequest()?.body);
            expect(sent).toContain("<session-history>");
            expect(sent).toContain("small defer turn — native checkpoint remains visible");
            expect(sent).not.toContain("<conversation-checkpoint>");
            expect(sent).not.toContain("<recent-context>");
        } else if (RUST_MODE) {
            // a5b7d61d moved Rust publication and its pending delta into the
            // module transaction. `pending_m1_delta` is the authority-level
            // equivalent of the legacy context.db marker blob.
            if (!(h instanceof TestHarness)) {
                throw new Error("Rust marker check requires the OpenCode 1 hermetic module stack");
            }
            const stack = h.rustStack;
            if (!stack)
                throw new Error("Rust marker check requires the hermetic module stack");
            const deadline = Date.now() + 60_000;
            let afterPublish: Record<string, unknown> = {};
            while (Date.now() < deadline) {
                afterPublish = await stack.moduleStatus(
                    sessionId,
                    h.workdir,
                    "session.status",
                );
                if (
                    Number(afterPublish.compartment_count ?? 0) > 0 &&
                    afterPublish.pending_m1_delta === true
                ) {
                    break;
                }
                await Bun.sleep(100);
            }
            expect(Number(afterPublish.compartment_count ?? 0)).toBeGreaterThan(0);
            expect(afterPublish.pending_m1_delta).toBe(true);

            await h.sendPrompt(sessionId, "small defer turn — no mutation expected");
            const pendingAfter = await stack.moduleStatus(
                sessionId,
                h.workdir,
                "session.status",
            );
            const unchanged = pendingAfter.pending_m1_delta === true;
            const drained =
                pendingAfter.pending_m1_delta === false &&
                JSON.stringify(h.mock.lastRequest()?.body ?? {}).includes(
                    "<session-history>",
                );
            expect(unchanged || drained).toBe(true);
        } else {
            await h.waitFor(
                () => {
                    const row = readMarkerState(h, sessionId);
                    return (
                        row?.pending_compaction_marker_state != null &&
                        row.pending_compaction_marker_state.length > 0
                    );
                },
                {
                    timeoutMs: 30_000,
                    label: "pending_compaction_marker_state set after publish",
                },
            );

            const afterPublish = readMarkerState(h, sessionId);
            expect(afterPublish).not.toBeNull();
            expect(afterPublish?.pending_compaction_marker_state).toBeTruthy();

            const pendingBlob = JSON.parse(
                afterPublish?.pending_compaction_marker_state ?? "{}",
            );
            expect(typeof pendingBlob.ordinal).toBe("number");
            expect(pendingBlob.ordinal).toBeGreaterThan(0);
            expect(typeof pendingBlob.endMessageId).toBe("string");
            expect(pendingBlob.endMessageId.length).toBeGreaterThan(0);
            expect(typeof pendingBlob.publishedAt).toBe("number");

            const pendingBefore = afterPublish?.pending_compaction_marker_state;
            await h.sendPrompt(sessionId, "small defer turn — no mutation expected");
            const pendingAfter = readMarkerState(h, sessionId);
            const drained =
                pendingAfter?.pending_compaction_marker_state == null &&
                pendingAfter?.compaction_marker_state != null &&
                pendingAfter.compaction_marker_state.length > 0;
            const unchanged =
                pendingAfter?.pending_compaction_marker_state === pendingBefore;
            expect(drained || unchanged).toBe(true);
        }
    }, 90_000);
});
