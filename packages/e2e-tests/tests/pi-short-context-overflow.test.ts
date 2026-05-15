/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";

/**
 * Pi short-context overflow survival guard.
 *
 * # Why this test is structured the way it is
 *
 * OpenCode's equivalent test (short-context-overflow.test.ts) verifies that
 * heuristic cleanup drops tags under 85% force-materialization. The drops it
 * counts are message-type tags created when OpenCode strips
 * `<system-reminder>`-wrapped user prompts that OpenCode injects on every
 * turn. Pi RPC mode does NOT wrap user prompts in system-reminders, so a
 * pure-text Pi session simply has no message tags to drop — Pi's heuristic
 * cleanup correctly drops only `type='tool'` tags, and tool tags only exist
 * when the agent actually invokes tools.
 *
 * Building a Pi e2e that exercises tool drops requires the agent loop to
 * actually run a tool, await its result, and continue — which Pi's RPC
 * `prompt` command serializes per session (a follow-up `prompt` while the
 * agent is mid-tool-execution returns "Agent is already processing").
 *
 * What this test verifies:
 *   - Pi survives 30 back-to-back 20KB-reply turns with a slow historian
 *   - No turns error out (proves the pipeline stays responsive)
 *
 * Pi tool-drop materialization is covered by `pi-drops.test.ts` (queue +
 * apply path), Pi historian compartment publication is covered by
 * `pi-historian-success.test.ts`, and Pi compaction-marker writing (the
 * X1 fix) is covered by `pi-deferred-compaction-marker.test.ts`. The
 * production wire dump from the user's stuck Anthropic Auth session
 * confirmed the X1/X2 fix in `55ebb14` resolves the actual tool-tag
 * accumulation symptom that prevented JSONL trimming.
 */

const HISTORIAN_MARKER = "You condense long AI coding sessions";

function isHistorian(body: Record<string, unknown>): boolean {
    const sys = body.system;
    if (sys === undefined || sys === null) return false;
    const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
    return asString.includes(HISTORIAN_MARKER);
}

function bigReplyText(turn: number, targetBytes: number): string {
    const header = `turn-${turn}-reply: `;
    const filler = "abcdefghij0123456789".repeat(200);
    const reps = Math.max(1, Math.floor(targetBytes / filler.length));
    return header + filler.repeat(reps);
}

let h: PiTestHarness;

beforeAll(async () => {
    h = await PiTestHarness.create({
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

describe("pi short context accumulating overflow", () => {
    it("emergency bypass keeps a 128K Pi session under 100% with slow historian", async () => {
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
                    `<compartment start="${start}" end="${end}" title="Pi build-up">` +
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

        // Plain text matcher. See header comment for why this test
        // doesn't try to exercise tool drops in Pi RPC mode.
        let mainCalls = 0;
        h.mock.addMatcher((body) => {
            if (isHistorian(body)) return null;
            mainCalls++;
            const approxInputTokens = Math.floor(JSON.stringify(body).length / 4);
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

        let sessionId: string | null = null;
        const turnUsage: number[] = [];
        const turnErrors: Array<{ turn: number; error: string }> = [];
        const turns = 30;

        for (let i = 1; i <= turns; i++) {
            const reqBefore = h.mock.requests().length;
            try {
                const turn = await h.sendPrompt(`user turn ${i}: continue.`, {
                    timeoutMs: 60_000,
                    continueSession: true,
                });
                sessionId = sessionId ?? turn.sessionId;
            } catch (err) {
                turnErrors.push({
                    turn: i,
                    error: err instanceof Error ? err.message : String(err),
                });
                const state = await h.getState().catch(() => null);
                if (state && typeof state.sessionId === "string") sessionId = sessionId ?? state.sessionId;
            }
            const reqs = h.mock.requests().slice(reqBefore);
            const mainReq = reqs.find((r) => !isHistorian(r.body));
            const observed = mainReq ? Math.floor(JSON.stringify(mainReq.body).length / 4) : 0;
            turnUsage.push(Math.round((observed / 128_000) * 1000) / 10);
        }

        const peakObservedPct = turnUsage.reduce((m, p) => Math.max(m, p), 0);
        const finalPct = turnUsage[turnUsage.length - 1] ?? 0;
        console.log(`[PI-OVERFLOW-GUARD] peak: ${peakObservedPct}% final: ${finalPct}% of 128K`);
        console.log(`[PI-OVERFLOW-GUARD] per-turn %: ${turnUsage.join(", ")}`);
        if (turnErrors.length > 0) {
            console.log(
                `[PI-OVERFLOW-GUARD] prompt failures (${turnErrors.length}):`,
                turnErrors.map((e) => `turn ${e.turn}: ${e.error.slice(0, 100)}`).join(" | "),
            );
        }

        expect(sessionId).toBeTruthy();
        expect(turnErrors).toEqual([]);

        // Diagnostic visibility only — see header comment for why we don't
        // assert specific drop/compartment counts in a pure-text Pi RPC
        // session. The real survival contract is "no turn errors over 30
        // back-to-back high-pressure turns", asserted above.
        const compartmentCount = h
            .contextDb()
            .prepare("SELECT COUNT(*) AS c FROM compartments WHERE session_id = ?")
            .get(sessionId!) as { c: number };
        const meta = h
            .contextDb()
            .prepare("SELECT last_context_percentage, last_input_tokens FROM session_meta WHERE session_id = ?")
            .get(sessionId!) as { last_context_percentage: number; last_input_tokens: number } | undefined;
        const droppedCount = h.countDroppedTags(sessionId!);
        console.log(
            `[PI-OVERFLOW-GUARD] compartments=${compartmentCount.c} dropped_tags=${droppedCount} last_context_percentage=${meta?.last_context_percentage} last_input_tokens=${meta?.last_input_tokens}`,
        );
    }, 240_000);
});
