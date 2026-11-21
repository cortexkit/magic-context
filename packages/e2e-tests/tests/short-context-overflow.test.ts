/// <reference types="bun-types" />

/**
 * Short-context emergency-drop regression test.
 *
 * Scenario: 128K context, fast main agent, slow historian (3s delay), no user
 * pauses between turns. Each turn reads a distinct ~20KB file, so the force-band
 * drop has actual tool results to reclaim. Assistant prose isn't a candidate,
 * and the mock never asks Magic Context to drop anything via ctx_reduce.
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
 *   - Automatic tool drops materialize while the historian is slow
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

import { afterAll, beforeAll, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";
import { buildMockHistorianPayload } from "../src/mock-historian";

const HISTORIAN_MARKER = "the hippocampus of a long-running coding agent";

function isHistorian(body: Record<string, unknown>): boolean {
    const sys = body.system;
    if (sys === undefined || sys === null) return false;
    const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
    return asString.includes(HISTORIAN_MARKER);
}

function readMarker(turn: number): string {
    return `fixture output for turn ${turn}:`;
}

function bigFileText(turn: number, targetBytes: number): string {
    const header = `${readMarker(turn)}\n`;
    // Unique records carry real content mass without tripping OMP's repeated-cycle guard.
    const records: string[] = [];
    let length = header.length;
    for (let record = 0; length < targetBytes; record++) {
        const text = `Record ${turn}-${record}: inspected boundary ${record * 7919} and retained decision ${record * 104729}.\n`;
        records.push(text);
        length += text.length;
    }
    return (header + records.join("")).slice(0, targetBytes);
}

forEachHost(import.meta.url, "short context accumulating overflow", (host) => {
    let h: ScenarioHarness;

    beforeAll(async () => {
        h = await createScenarioHarness(host, {
            modelContextLimit: 128_000,
            magicContextConfig: {
                execute_threshold_percentage: 40,
                dreamer: { disable: true },
                // This drill measures emergency pressure, not embedding startup latency.
                memory: { auto_search: { enabled: false }, git_commit_indexing: { enabled: false } },
                embedding: { provider: "off" },
            },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });
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
                    text: buildMockHistorianPayload({
                        start,
                        end,
                        title: "Build-up",
                        body: "Summary.",
                    }),
                    usage: {
                        input_tokens: 500,
                        output_tokens: 50,
                        cache_creation_input_tokens: 500,
                        cache_read_input_tokens: 0,
                    },
                    delayMs: 3_000,
                };
            });

            let activeTurn:
                | { number: number; prompt: string; file: string; readIssued: boolean }
                | undefined;
            h.mock.addMatcher((body) => {
                if (isHistorian(body)) return null;
                const approxInputTokens = Math.floor(JSON.stringify(body).length / 4);
                const usage = { input_tokens: approxInputTokens, output_tokens: 20 };
                const tools = Array.isArray(body.tools) ? (body.tools as Array<{ name: string }>) : [];
                const read = tools.find(({ name }) => name === "read" || name === "_read");
                if (
                    activeTurn && !activeTurn.readIssued && read &&
                    JSON.stringify(body.messages)?.includes(activeTurn.prompt)
                ) {
                    activeTurn.readIssued = true;
                    return {
                        content: [{
                            type: "tool_use",
                            id: `toolu_overflow_read_${activeTurn.number}`,
                            name: read.name,
                            input: host === "opencode"
                                ? { filePath: activeTurn.file }
                                : { path: activeTurn.file },
                        }],
                        stop_reason: "tool_use",
                        usage,
                    };
                }
                return { text: "Continuing.", usage };
            });

            const sessionId = await h.createSession();
            const turnUsage: number[] = [];
            const turnErrors: Array<{ turn: number; error: string }> = [];
            const TURNS = 30;
            for (let i = 1; i <= TURNS; i++) {
                const prompt = `user turn ${i}: continue.`;
                const file = join(h.workdir, `fixture-log-${i}.txt`);
                writeFileSync(file, bigFileText(i, 20_000));
                activeTurn = { number: i, prompt, file, readIssued: false };
                const reqBefore = h.mock.requests().length;
                try {
                    await h.sendPrompt(sessionId, prompt, {
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
                const mainReqs = reqs.filter((r) => !isHistorian(r.body) &&
                    JSON.stringify(r.body.messages)?.includes(prompt));
                if (!mainReqs.some((r) => JSON.stringify(r.body.messages).includes(readMarker(i)))) {
                    turnErrors.push({ turn: i, error: "No mock provider request carried the read result" });
                }
                // The request immediately after the read can be larger than the
                // first request of the turn, so measure both steps.
                const observed = Math.max(0, ...mainReqs.map((r) => Math.floor(JSON.stringify(r.body).length / 4)));
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
            expect(h.mock.requests().filter((r) => isHistorian(r.body)).length).toBeGreaterThan(0);
            h.assertHistorianRequestsUseMock();

            // An arbitrary dropped tag could just be a stripped system reminder.
            // Require an actual tool result from this session to have been dropped.
            const ctx = h.contextDb();
            const row = ctx
                .prepare("SELECT COUNT(*) AS c FROM tags WHERE session_id = ? AND harness = ? AND type = 'tool' AND status = 'dropped'")
                .get(sessionId, h.harnessId) as { c: number } | undefined;
            const droppedCount = row?.c ?? 0;
            console.log(`[OVERFLOW-GUARD] dropped tool tags: ${droppedCount}`);
            expect(droppedCount).toBeGreaterThan(0);

            // No measured request may reach the context limit.
            expect(peakObservedPct).toBeLessThan(100);
        },
        // Bumped from 240s → 600s for CI: this test does ~30 escalating-load
        // turns to drive a 128K-context session into the force band. On idle local
        // hardware this finishes in ~30s, but on GitHub-hosted runners with CPU
        // contention it can take longer.
        600_000,
    );
});
