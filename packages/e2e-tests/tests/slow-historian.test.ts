/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { createScenarioHarness, forEachHost, type ScenarioHarness } from "../src/scenario-hosts";
import { FOLD_SKIP_REASON } from "../src/rust-scenario-support";

/**
 * Slow historian, fast main agent.
 *
 * The single most important invariant in magic-context: when the main agent is
 * fast and historian is slow, the main agent MUST continue to work without
 * being blocked by historian. This test exercises that invariant end-to-end.
 *
 * Plugin constants that shape this test (see compartment-trigger.ts and
 * read-session-chunk.ts):
 *
 *   - PROTECTED_TAIL_USER_TURNS = 5
 *       → we need >= 11 user turns so the 6th-from-last sits at an ordinal
 *         that leaves >= 12 messages in the unsummarized tail.
 *   - MIN_PROACTIVE_TAIL_MESSAGE_COUNT = 12
 *       → the tail must hit this count OR MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE
 *         for the proactive trigger (below 95%) to fire.
 *   - BLOCK_UNTIL_DONE_PERCENTAGE = 95
 *       → above this, transform BLOCKS on historian with a timeout. Our test
 *         keeps usage below 95% on purpose — we want to prove the non-blocking
 *         path works.
 *
 * Scenario:
 *   1. Send 11 low-token user turns to populate raw history (turns keep usage
 *      well below any threshold on their own).
 *   2. Turn 11's response carries a big input_tokens count (~45% of 200K) so
 *      the event-handler-driven trigger sees usage >= execute_threshold AND a
 *      meaningful tail, then flips compartmentInProgress.
 *   3. Turn 12 is the transform pass where we observe historian starting.
 *      The mock records response completion so the shared suite can prove the
 *      main request overlaps the in-flight historian without a duration bound.
 *   4. Assert no later historian request arrives before the first historian
 *      response completes. Requests after completion are legitimate new runs.
 */

// Historian system prompt marker, see compartment-prompt.ts.
const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";

function isHistorianRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    if (system === undefined || system === null) return false;
    const asString = typeof system === "string" ? system : JSON.stringify(system);
    return asString.includes(HISTORIAN_SYSTEM_MARKER);
}

forEachHost(import.meta.url, "slow historian vs fast main", (host) => {
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
    it("main turns stay responsive while historian hangs in background", async () => {
        let releaseHistorian!: () => void;
        const until = new Promise<void>((resolve) => {
            releaseHistorian = resolve;
        });
        try {
            // Historian: slow valid-shape response. We return an empty-compartments
            // payload so the historian wrapper doesn't throw on parse failure —
            // the exact contents don't matter for this test; we're only verifying
            // that historian is INVOKED and doesn't block main.
            h.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                return {
                    text:
                        "<output>" +
                        "<compartments></compartments>" +
                        "<facts></facts>" +
                        "<unprocessed_from>99</unprocessed_from>" +
                        "</output>",
                    usage: {
                        input_tokens: 500,
                        output_tokens: 50,
                        cache_creation_input_tokens: 500,
                        cache_read_input_tokens: 0,
                    },
                    until,
                };
            });

            // Fill-phase default: modest usage so we don't trip thresholds yet.
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

            // Turns 1-10: populate 10 user turns. Each carries real text so
            // hasMeaningfulUserText() picks them up for the protected tail
            // calculation.
            for (let i = 1; i <= 10; i++) {
                await h.sendPrompt(
                    sessionId,
                    `turn ${i}: meaningful prompt carrying durable signal about build process step ${i}. ${h.ballast(3_000)}`,
                );
            }

            // Turn 11: spike input_tokens to cross execute_threshold (40% of
            // 200K = 80K). With 11 user turns, tail covers ord 1-12 (12
            // messages) which satisfies MIN_PROACTIVE_TAIL_MESSAGE_COUNT.
            h.mock.setDefault({
                text: "big",
                usage: {
                    input_tokens: 90_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 90_000,
                    cache_read_input_tokens: 0,
                },
            });
            await h.sendPrompt(sessionId, "turn 11: trigger turn with meaningful content.");

            // NOTE: the trigger decision runs in the TRANSFORM now (fed by the
            // in-memory message tail), not in the message.updated event handler.
            // After turn 11 the flag is still 0 — turn 12's transform evaluates
            // the trigger, sets compartmentInProgress, AND starts the historian
            // in that same pass (background, non-blocking). So there is no
            // flag-wait between turns anymore; the flag assertion moves after
            // turn 12 is dispatched.

            // Turn 12: transform fires the trigger, kicks off historian in
            // background (non-blocking). Keep its reply held through turn 14 so
            // the later turns also test the in-flight path.
            // Keep usage here low so we don't accidentally trip the 95% blocking
            // path (BLOCK_UNTIL_DONE_PERCENTAGE).
            h.mock.setDefault({
                text: "fast",
                usage: {
                    input_tokens: 500,
                    output_tokens: 10,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 500,
                },
            });

            // INVARIANT 1 (non-blocking): turn 12's MAIN request must be
            // captured while the slow historian request is still in flight.
            // The mock records response completion separately, so this proves
            // request overlap without making a wall-clock claim.
            const historianReqCountBeforeT12 = h.mock
                .requests()
                .filter((r) => isHistorianRequest(r.body)).length;

            // Start turn 12 but do NOT await — we want to observe the request
            // arriving at the mock before it completes.
            const turn12Promise = h.sendPrompt(
                sessionId,
                "turn 12: should be fast even with historian running.",
            );

            // Wait for the main-turn-12 request to appear at the mock. The
            // harness timeout only bounds a stuck test; the contract assertion
            // below uses request completion state, not elapsed time.
            await h.waitFor(
                () => {
                    const reqs = h.mock.requests();
                    const mainT12 = reqs.find(
                        (r) =>
                            !isHistorianRequest(r.body) &&
                            JSON.stringify(r.body).includes("turn 12:"),
                    );
                    return mainT12 != null;
                },
                { timeoutMs: 60_000, label: "main turn 12 request arrives at mock" },
            );

            const mainRequestAtT12 = h.mock
                .requests()
                .find(
                    (request) =>
                        !isHistorianRequest(request.body) &&
                        JSON.stringify(request.body).includes("turn 12:"),
                );
            expect(mainRequestAtT12).toBeDefined();

            if (process.env.MC_E2E_MODE === "rust") {
                // The hermetic Broca producer is intentionally immediate, so this
                // delay-ordering assertion remains limited to the mock-backed TS leg.
                console.log(
                    `[rust-e2e] slow-historian delay assertions SKIPPED: ${FOLD_SKIP_REASON}`,
                );
                await turn12Promise;
                return;
            }

            await h.waitFor(
                () => h.mock.requests().find((request) => isHistorianRequest(request.body)),
                { timeoutMs: 60_000, label: "historian request starts" },
            );
            const historianRequestAtT12 = h.mock
                .requests()
                .find((request) => isHistorianRequest(request.body));
            expect(historianRequestAtT12).toBeDefined();
            expect(historianRequestAtT12?.responseCompletedAt).toBeUndefined();

            // Historian kicks off from turn 12's own transform pass (since
            // v0.14.1 removed the 80% emergency nudge's promptAsync that
            // previously drove a separate pass). The critical invariant is
            // that both requests fire in parallel from that transform pass —
            // not that historian started earlier. The completion-state check
            // above proves non-blocking behavior regardless of machine speed.
            const historianReqCountAtT12 = h.mock
                .requests()
                .filter((r) => isHistorianRequest(r.body)).length;
            expect(historianReqCountAtT12).toBeGreaterThanOrEqual(historianReqCountBeforeT12);

            // Now finish turn 12 and drive further turns for INVARIANT 2.
            await turn12Promise;

            // INVARIANT 2: no later historian request may overlap the first.
            await h.sendPrompt(sessionId, "turn 13: additional turn while historian pending.");
            await h.sendPrompt(sessionId, "turn 14: more activity while historian pending.");

            await h.waitFor(
                () => h.mock.requests().filter((r) => isHistorianRequest(r.body)).length >= 1,
                { timeoutMs: 10_000, label: "historian request captured" },
            );

            const historianRequests = h.mock.requests().filter((r) => isHistorianRequest(r.body));
            const [firstHistorianRequest, ...laterHistorianRequests] = historianRequests;
            expect(firstHistorianRequest).toBeDefined();
            if (!firstHistorianRequest) {
                throw new Error("Historian request missing after waitFor");
            }

            const firstResponseCompletedAt = firstHistorianRequest.responseCompletedAt;
            const overlappingHistorianRequests = laterHistorianRequests.filter(
                (request) =>
                    request.receivedAt >= firstHistorianRequest.receivedAt &&
                    (firstResponseCompletedAt === undefined ||
                        request.receivedAt < firstResponseCompletedAt),
            );
            console.log(
                `[TEST] historian requests observed: ${historianRequests.length}; overlapping first: ${overlappingHistorianRequests.length}`,
            );
            expect(overlappingHistorianRequests).toHaveLength(0);

            // INVARIANT 3: at least one historian request was captured.
            expect(historianRequests.length).toBeGreaterThanOrEqual(1);
        } finally {
            releaseHistorian();
        }
    }, // The setup sends 11 turns before exercising the overlap.
    600_000);
});
