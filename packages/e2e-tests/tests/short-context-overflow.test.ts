/// <reference types="bun-types" />

/**
 * Short-context emergency-drop regression test.
 *
 * Scenario: 128K context, fast main agent, slow historian (3s delay), no user
 * pauses between turns — the autonomous-loop scenario that previously caused
 * silent overflow. Each turn adds ~8KB of assistant text plus tool-like content
 * so that heuristic cleanup and compartment drops have something to reclaim.
 *
 * ## What this verifies
 *
 * BEFORE the emergency bypass fix (transform-postprocess-phase.ts), drops
 * queued by `queueDropsForCompartmentalizedMessages` would sit in pending_ops
 * indefinitely because every transform pass saw `compartmentRunning=true`.
 * The outgoing request body grew without bound and requests failed past 100%.
 *
 * AFTER the fix, when usage crosses `forceMaterializationPercentage` (85%
 * default), pending drops and heuristic cleanup run EVEN WHEN historian is
 * active. This is safe because historian reads raw opencode.db messages and
 * writes to compartments/facts/memories tables, while drops mutate tags and
 * pending_ops — disjoint data.
 *
 * ## Expected behavior
 *
 *   - Drops materialize promptly once pressure crosses 85%
 *   - Peak request stays under 100% of context
 *   - Session survives 20+ back-to-back turns with slow historian
 *
 * ## Known residual limit (not a regression)
 *
 * The plugin's protected tail (last `protected_tags` messages, default 20)
 * is never dropped because recent messages are essential context. In
 * pathological workflows where the protected tail alone exceeds context
 * (e.g., 20 messages × 60KB each > 128K), the plugin cannot prevent
 * overflow. Real workflows stay well under this limit.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";

const HISTORIAN_MARKER = "You condense long AI coding sessions";

function isHistorian(body: Record<string, unknown>): boolean {
    const sys = body.system;
    const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
    return asString.includes(HISTORIAN_MARKER);
}

function bigReplyText(turn: number, targetBytes: number): string {
    const header = `turn-${turn}-reply: `;
    const filler = "abcdefghij0123456789".repeat(200);
    const reps = Math.max(1, Math.floor(targetBytes / filler.length));
    return header + filler.repeat(reps);
}

let h: TestHarness;

beforeAll(async () => {
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

describe("short context accumulating overflow", () => {
    it(
        "emergency bypass keeps 128K session under 100% with slow historian",
        async () => {
            h.mock.reset();

            h.mock.addMatcher((body) => {
                if (!isHistorian(body)) return null;
                const msgs = body.messages as Array<{ content?: unknown }> | undefined;
                const flat = JSON.stringify(msgs ?? []);
                const rangeHdr = flat.match(/Messages (\d+)-(\d+):/);
                const start = rangeHdr ? Number(rangeHdr[1]) : 0;
                const end = rangeHdr ? Number(rangeHdr[2]) : 0;
                return {
                    text:
                        `<output><compartments>` +
                        `<compartment start="${start}" end="${end}" title="Build-up">` +
                        `Summary.</compartment></compartments><facts></facts>` +
                        `<unprocessed_from>${end + 1}</unprocessed_from></output>`,
                    usage: {
                        input_tokens: 500,
                        output_tokens: 50,
                        cache_creation_input_tokens: 500,
                        cache_read_input_tokens: 0,
                    },
                    delayMs: 3_000,
                };
            });

            let mainCalls = 0;
            h.mock.addMatcher((body) => {
                if (isHistorian(body)) return null;
                mainCalls++;
                const approxInputTokens = Math.floor(JSON.stringify(body).length / 4);
                // ~20KB per turn — enough growth to cross 85% within 25 turns
                // so the emergency bypass path is actually exercised.
                const reply = bigReplyText(mainCalls, 20_000);
                return {
                    text: reply,
                    usage: {
                        input_tokens: approxInputTokens,
                        output_tokens: Math.floor(reply.length / 4),
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                };
            });

            const sessionId = await h.createSession();
            const turnUsage: number[] = [];
            const turnErrors: Array<{ turn: number; error: string }> = [];
            const TURNS = 30;
            for (let i = 1; i <= TURNS; i++) {
                const reqBefore = h.mock.requests().length;
                try {
                    await h.sendPrompt(sessionId, `user turn ${i}: continue.`, {
                        timeoutMs: 60_000,
                    });
                } catch (err) {
                    // Track so the test fails if overflow (or any other failure)
                    // kills a turn — previously we silently swallowed this, which
                    // made the test unable to detect the very regression it claims
                    // to guard against.
                    turnErrors.push({
                        turn: i,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
                const reqs = h.mock.requests().slice(reqBefore);
                const mainReq = reqs.find((r) => !isHistorian(r.body));
                const observed = mainReq ? Math.floor(JSON.stringify(mainReq.body).length / 4) : 0;
                turnUsage.push(Math.round((observed / 128_000) * 1000) / 10);
            }

            const peakObservedPct = turnUsage.reduce((m, p) => Math.max(m, p), 0);
            const finalPct = turnUsage[turnUsage.length - 1] ?? 0;
            console.log(`[OVERFLOW-GUARD] peak: ${peakObservedPct}% final: ${finalPct}% of 128K`);
            console.log(`[OVERFLOW-GUARD] per-turn %: ${turnUsage.join(", ")}`);
            if (turnErrors.length > 0) {
                console.log(
                    `[OVERFLOW-GUARD] prompt failures (${turnErrors.length}):`,
                    turnErrors
                        .map((e) => `turn ${e.turn}: ${e.error.slice(0, 100)}`)
                        .join(" | "),
                );
            }

            // The overflow guard is meaningless if prompts were allowed to fail
            // silently. Require all 30 turns to succeed. If this assertion fires,
            // inspect `turnErrors` in the log above to see which turn(s) overflowed
            // or timed out.
            expect(turnErrors).toEqual([]);

            // Verify drops actually materialized in the DB — this is the core
            // fix: pending ops apply even when compartmentRunning at emergency.
            const ctx = h.contextDb();
            const row = ctx
                .prepare("SELECT COUNT(*) AS c FROM tags WHERE status='dropped'")
                .get() as { c: number } | undefined;
            const droppedCount = row?.c ?? 0;
            console.log(`[OVERFLOW-GUARD] dropped tags: ${droppedCount}`);
            expect(droppedCount).toBeGreaterThan(0);

            // Peak should stay under context limit with a margin.
            expect(peakObservedPct).toBeLessThan(100);
        },
        240_000,
    );
});
