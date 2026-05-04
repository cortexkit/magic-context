/// <reference types="bun-types" />

/**
 * Context-overflow recovery (issue #32 regression test).
 *
 * Scenario: a model with a MISDETECTED context limit — the plugin (and
 * everything downstream) believes the model has a 128K window, but the real
 * provider limit is 120K. This is the exact trap from issue #32 where
 * `lemonade/GLM-4.7-Flash-GGUF` (a local GGUF model) is not in models.dev,
 * so `resolveContextLimit()` falls back to the 128K default while the real
 * runtime limit is smaller.
 *
 * ## What this verifies (end-to-end)
 *
 * 1. **Detection** — When the provider returns an overflow error, the plugin
 *    parses it against the shared overflow pattern set and records:
 *       - `session_meta.needs_emergency_recovery = 1`
 *       - `session_meta.detected_context_limit = <real limit parsed from error>`
 *
 * 2. **Pressure correction** — The very next transform pass resolves context
 *    limit from `session_meta.detected_context_limit` (the persisted real
 *    limit) instead of the models.dev / default fallback, so pressure math
 *    finally reflects reality.
 *
 * 3. **Recovery** — The emergency recovery flag forces the percentage to 95%
 *    even if the model's self-reported usage still looks low, which fires
 *    the existing 95% emergency path (abort + historian + aggressive drops).
 *
 * 4. **Completion** — When historian successfully publishes a compartment,
 *    the recovery flag is cleared so future turns aren't stuck at 95%.
 *    `detected_context_limit` remains — it's the authoritative real limit
 *    and remains valuable for future pressure math.
 *
 * ## Why this is an e2e test, not a unit test
 *
 * Unit tests already cover the pattern matcher, storage helpers, and the
 * `resolveContextLimit` session-override path individually. What this test
 * verifies is the integration: that the `session.error` event from OpenCode
 * actually reaches our handler, the persisted state is actually read by the
 * next transform, and the historian actually clears the flag.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";

const HISTORIAN_MARKER = "You condense long AI coding sessions";

function isHistorian(body: Record<string, unknown>): boolean {
    const sys = body.system;
    const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
    return asString.includes(HISTORIAN_MARKER);
}

interface SessionMetaRow {
    needs_emergency_recovery: number | null;
    detected_context_limit: number | null;
}

let h: TestHarness;

beforeAll(async () => {
    // modelContextLimit is what the plugin *believes* — the default. The
    // mock provider then tells it the real limit is smaller via the overflow
    // error (matching the issue #32 scenario where lemonade accepts the
    // request at the plugin's default 128k but rejects somewhere under that).
    h = await TestHarness.create({
        modelContextLimit: 128_000,
        magicContextConfig: {
            execute_threshold_percentage: 40,
            compaction_markers: true,
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("context overflow recovery", () => {
    it(
        "detects provider overflow, persists real limit, triggers emergency recovery, clears flag on historian success",
        async () => {
            h.mock.reset();

            // Phase 1: answer main-agent turns normally so we have some
            // history to compartmentalize before overflow hits.
            let mainCalls = 0;
            let mainShouldOverflow = false;
            let historianCalls = 0;
            h.mock.addMatcher((body) => {
                if (isHistorian(body)) return null;
                mainCalls++;

                // On the Nth main request, return a context-overflow error
                // with a reported real limit of 120000. This mimics
                // lemonade/LMStudio-style errors — non-SSE JSON body with an
                // Anthropic-shaped error envelope and a message string that
                // matches the overflow regex set and carries the real limit.
                if (mainShouldOverflow) {
                    mainShouldOverflow = false;
                    return {
                        error: {
                            status: 400,
                            type: "invalid_request_error",
                            // Matches the Groq pattern:
                            //   /reduce the length of the messages/i
                            // and the extractor pulls out 120000 as the real limit.
                            message:
                                "This model's maximum context length is 120000 tokens. Please reduce the length of the messages.",
                        },
                    };
                }

                return {
                    text: `assistant turn ${mainCalls}`,
                    usage: {
                        input_tokens: 500 + mainCalls * 100,
                        output_tokens: 50,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                };
            });

            h.mock.addMatcher((body) => {
                if (!isHistorian(body)) return null;
                historianCalls++;
                const msgs = body.messages as Array<{ content?: unknown }> | undefined;
                const flat = JSON.stringify(msgs ?? []);
                const rangeHdr = flat.match(/Messages (\d+)-(\d+):/);
                const start = rangeHdr ? Number(rangeHdr[1]) : 0;
                const end = rangeHdr ? Number(rangeHdr[2]) : 0;
                return {
                    text:
                        `<output><compartments>` +
                        `<compartment start="${start}" end="${end}" title="Overflow recovery">` +
                        `Summary.</compartment></compartments><facts></facts>` +
                        `<unprocessed_from>${end + 1}</unprocessed_from></output>`,
                    usage: {
                        input_tokens: 500,
                        output_tokens: 50,
                        cache_creation_input_tokens: 500,
                        cache_read_input_tokens: 0,
                    },
                };
            });

            const sessionId = await h.createSession();

            // Build a few turns of history so historian has something to
            // compartmentalize once triggered.
            for (let i = 1; i <= 6; i++) {
                await h.sendPrompt(sessionId, `user turn ${i}: some work`, { timeoutMs: 30_000 });
            }

            const ctx = h.contextDb();
            const readState = (): SessionMetaRow => {
                const row = ctx
                    .prepare(
                        "SELECT needs_emergency_recovery, detected_context_limit FROM session_meta WHERE session_id = ?",
                    )
                    .get(sessionId) as SessionMetaRow | undefined;
                return row ?? { needs_emergency_recovery: null, detected_context_limit: null };
            };

            // Baseline: no overflow state yet.
            const before = readState();
            expect(before.needs_emergency_recovery ?? 0).toBe(0);
            expect(before.detected_context_limit).toBeFalsy();

            const historianBeforeOverflow = historianCalls;

            // Flip the switch: the next main request will return a context-overflow
            // error from the provider.
            mainShouldOverflow = true;

            // Fire the turn that will overflow. The full recovery cycle —
            // detection → bump percentage to 95% → historian → clear flag —
            // completes inside this single prompt's lifecycle because the
            // emergency path is intentionally synchronous (historian runs
            // inline at 95%). The SDK will still throw because the provider
            // returned 400, but the plugin has already recorded and recovered
            // from the overflow by the time the error propagates back.
            try {
                await h.sendPrompt(sessionId, "user turn that will overflow", {
                    timeoutMs: 30_000,
                });
            } catch {
                // expected — provider returned 400
            }

            // Wait for the recovery cycle to complete. End state evidence:
            //   - detected_context_limit persisted (proves detection worked)
            //   - needs_emergency_recovery cleared to 0 (proves historian ran
            //     the recovery path to completion — clearEmergencyRecovery
            //     only fires inside the successful-publication transaction)
            //   - at least one compartment was written (proves historian
            //     published, not just attempted)
            //   - at least one new historian HTTP request was received
            //     (proves the emergency path triggered the historian)
            let afterRecovery: SessionMetaRow;
            try {
                afterRecovery = await h.waitFor(
                    () => {
                        const s = readState();
                        if (s.detected_context_limit !== 120000) return false;
                        if ((s.needs_emergency_recovery ?? 0) !== 0) return false;
                        if (historianCalls <= historianBeforeOverflow) return false;
                        if (h.countCompartments(sessionId) < 1) return false;
                        return s;
                    },
                    {
                        timeoutMs: 15_000,
                        intervalMs: 100,
                        label: "overflow detected, recovery completed, flag cleared",
                    },
                );
            } catch (err) {
                const stderrTail = h.opencode.stderr().slice(-2000);
                const currentState = readState();
                throw new Error(
                    `overflow recovery did not complete: ${String(err)}\n` +
                        `\ncurrent state: ${JSON.stringify(currentState)}\n` +
                        `historian calls: ${historianCalls} (was ${historianBeforeOverflow})\n` +
                        `compartments: ${h.countCompartments(sessionId)}\n` +
                        `\nopencode stderr tail:\n${stderrTail}`,
                );
            }

            // Final state assertions — documents the intended post-recovery shape.
            expect(afterRecovery.detected_context_limit).toBe(120000);
            expect(afterRecovery.needs_emergency_recovery).toBe(0);
            expect(h.countCompartments(sessionId)).toBeGreaterThanOrEqual(1);
            // At least one historian call during recovery.
            expect(historianCalls).toBeGreaterThan(historianBeforeOverflow);
        },
        120_000,
    );

    it(
        "ignores non-overflow errors (rate limits, auth)",
        async () => {
            h.mock.reset();

            h.mock.addMatcher((body) => {
                if (isHistorian(body)) return null;
                return {
                    error: {
                        status: 429,
                        type: "rate_limit_error",
                        message: "Rate limit exceeded. Please try again later.",
                    },
                };
            });

            const sessionId = await h.createSession();

            try {
                await h.sendPrompt(sessionId, "this will rate-limit", { timeoutMs: 15_000 });
            } catch {
                // expected
            }

            // Give the event bus time to deliver.
            await Bun.sleep(1_500);

            const ctx = h.contextDb();
            const row = ctx
                .prepare(
                    "SELECT needs_emergency_recovery, detected_context_limit FROM session_meta WHERE session_id = ?",
                )
                .get(sessionId) as SessionMetaRow | undefined;

            // Rate-limit errors must NOT trigger recovery. This guards against
            // an overly broad pattern match in overflow-detection.ts.
            expect(row?.needs_emergency_recovery ?? 0).toBe(0);
            expect(row?.detected_context_limit ?? null).toBeFalsy();
        },
        30_000,
    );
});
