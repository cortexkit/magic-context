/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestHarness } from "../src/harness";
import { buildMockHistorianPayload } from "../src/mock-historian";

/**
 * Subagent-specific behavior.
 *
 * Subagents (child sessions with a non-empty `parentID`) run in REDUCED mode.
 * The plugin's live invariants for subagents are:
 *
 *  1. **isSubagent persisted on session.created** — the event handler reads
 *     `parentID` from the `session.created` event and writes
 *     `session_meta.is_subagent = 1`. Without this row, all downstream gates
 *     mis-classify the session as a primary agent.
 *
 *  2. **No historian / compartments** — subagents skip the compartment phase
 *     entirely. `fullFeatureMode = false` short-circuits `runCompartmentPhase`
 *     and `prepareCompartmentInjection` in `transform.ts`.
 *
 *  3. **§N§ prefix injection (Unit B)** — subagents share the process-global
 *     `ctx_reduce` tool, so when `ctx_reduce` is enabled they DO get §N§
 *     prefixes + a minimal guidance block and self-manage their tool bloat.
 *     (A ctx_reduce-disabled subagent gets no prefix — nothing to act on.)
 *
 *  4. **No Channel 2 nudge, no note-nudges, no compartments** — the
 *     synthetic-user ceiling nudge stays primary-only (`fullFeatureMode`).
 *     Subagents rely on Channel 1 + the ≥85% tiered emergency floor.
 *
 *  5. **Tiered emergency drop at ≥85%** — the subagent tool floor. At the
 *     force-materialize pass, `planEmergencyDrop` evicts tool tags T3→T2→T1
 *     to a target headroom (routine age-drops were removed). Without this,
 *     subagent context grows until provider overflow.
 *
 *  6. **Subagents tolerate overflow errors** — when a subagent hits the
 *     provider's context limit, the plugin doesn't spin up historian to
 *     recover. It records the overflow and lets the error propagate so
 *     OpenCode's retry / parent-agent fallback can handle it.
 *
 * Scenarios below target each invariant directly.
 */

const HISTORIAN_MARKER = "the hippocampus of a long-running coding agent";

function isHistorianRequest(body: Record<string, unknown>): boolean {
    const sys = body.system;
    if (typeof sys === "string") return sys.includes(HISTORIAN_MARKER);
    if (Array.isArray(sys)) {
        for (const block of sys) {
            if (block && typeof block === "object") {
                const text = (block as { text?: unknown }).text;
                if (typeof text === "string" && text.includes(HISTORIAN_MARKER)) {
                    return true;
                }
            }
        }
    }
    return false;
}

/**
 * Detects whether an outgoing provider request carries a §N§ tag prefix on any
 * user-message text. Subagents MUST NOT have this injected even though their
 * tags are still tracked in context.db.
 */
function hasTagPrefixedUserMessage(body: Record<string, unknown>): boolean {
    const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
    if (!messages) return false;
    for (const m of messages) {
        if (m.role !== "user") continue;
        const content = m.content;
        if (typeof content === "string" && /§\d+§/.test(content)) return true;
        if (Array.isArray(content)) {
            for (const block of content) {
                const text = (block as { text?: unknown }).text;
                if (typeof text === "string" && /§\d+§/.test(text)) return true;
            }
        }
    }
    return false;
}

function historianOrdinalRange(
    body: Record<string, unknown>,
): { start: number; end: number } | null {
    const messages = (body.messages as Array<{ content: unknown }> | undefined) ?? [];
    for (const message of messages) {
        const blocks = Array.isArray(message.content) ? message.content : [];
        for (const block of blocks) {
            const text = (block as { text?: unknown }).text;
            if (typeof text !== "string" || !text.includes("<new_messages>")) continue;
            const start = text.indexOf("<new_messages>");
            const end = text.indexOf("</new_messages>");
            const scope = end > start ? text.slice(start, end) : text.slice(start);
            const ordinals = [...scope.matchAll(/^\[(\d+)\] [UA]:/gm)].map((match) =>
                Number(match[1]),
            );
            if (ordinals.length > 0)
                return { start: Math.min(...ordinals), end: Math.max(...ordinals) };
        }
    }
    return null;
}

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        modelContextLimit: 200_000,
        magicContextConfig: {
            execute_threshold_percentage: 40,
            // Reasonable protected-tail that still leaves older tags eligible
            // for dropping once we cross execute threshold.
            protected_tags: 5,
            // Keep noise out of the test — no compaction markers (they touch
            // opencode.db and aren't part of the subagent invariant set), no
            // No dreamer or auto-search hints in subagent mode.
            dreamer: { disable: true },
        },
    });
});

afterAll(async () => {
    await h?.dispose();
});

afterEach(() => {
    h?.mock.reset();
});

describe("subagent behavior", () => {
    it("opted-in child publishes a compartment and sends its own rendered history", async () => {
        const enabled = await TestHarness.create({
            modelContextLimit: 200_000,
            magicContextConfig: {
                execute_threshold_percentage: 40,
                historian: { subagent_reconciliation: true },
                dreamer: { disable: true },
            },
        });
        try {
            enabled.mock.addMatcher((body) => {
                if (!isHistorianRequest(body)) return null;
                const range = historianOrdinalRange(body);
                return range
                    ? {
                          text: buildMockHistorianPayload({
                              ...range,
                              title: "Child reconciliation chunk",
                              body: "Child-only durable reconciliation evidence.",
                          }),
                          usage: {
                              input_tokens: 500,
                              output_tokens: 200,
                              cache_creation_input_tokens: 500,
                              cache_read_input_tokens: 0,
                          },
                      }
                    : null;
            });
            enabled.mock.setDefault({
                text: "fill",
                usage: {
                    input_tokens: 1_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 1_000,
                    cache_read_input_tokens: 0,
                },
            });
            const parent = await enabled.createSession();
            const child = await enabled.createChildSession(parent, "ordinary child");
            const sibling = await enabled.createChildSession(parent, "isolated sibling");
            await enabled.waitFor(() => enabled.isSubagent(child) === true, {
                timeoutMs: 5_000,
                label: "opted-in child identity",
            });
            for (let turn = 1; turn <= 10; turn++) {
                await enabled.sendPrompt(
                    child,
                    `child turn ${turn}: durable child-only content. ${enabled.ballast(3_000)}`,
                );
            }
            enabled.mock.setDefault({
                text: "trigger",
                usage: {
                    input_tokens: 90_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 90_000,
                },
            });
            await enabled.sendPrompt(child, "child trigger turn");
            enabled.mock.setDefault({
                text: "surface",
                usage: {
                    // Keep materialization eligible; low-pressure turns replay the frozen prefix.
                    input_tokens: 90_000,
                    output_tokens: 10,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 90_000,
                },
            });
            await enabled.sendPrompt(child, "child post-trigger turn");
            await enabled.waitFor(() => enabled.countCompartments(child) >= 1, {
                timeoutMs: 60_000,
                label: "opted-in child compartment",
            });
            // The incoming state is still 90K, so this pass may materialize.
            // Its response lowers only subsequent turns into defer.
            enabled.mock.setDefault({
                text: "defer",
                usage: {
                    input_tokens: 500,
                    output_tokens: 10,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 500,
                },
            });
            await enabled.sendPrompt(child, "child rendered-history turn");

            expect(enabled.isSubagent(child)).toBe(true);
            expect(enabled.countCompartments(child)).toBeGreaterThanOrEqual(1);
            expect(enabled.countCompartments(parent)).toBe(0);
            expect(
                enabled.requests().filter((request) => isHistorianRequest(request.body)),
            ).toHaveLength(1);
            const request = enabled
                .requests()
                .find((candidate) =>
                    JSON.stringify(candidate.body).includes("child rendered-history turn"),
                );
            expect(JSON.stringify(request?.body)).toContain("<session-history>");
            expect(JSON.stringify(request?.body)).toContain("Child reconciliation chunk");

            const historyPrefix = (body: Record<string, unknown>) => {
                // Only message content: system guidance mentions the tag literally.
                const wire = JSON.stringify(body.messages);
                // m[0] and m[1] jointly carry history; a valid cache can keep all summaries in m[1].
                const prefixes = wire.match(
                    /<session-history(?:-since)?>[\s\S]*?<\/session-history(?:-since)?>/g,
                );
                expect(prefixes).not.toBeNull();
                return prefixes!.join("\n");
            };
            const sendAndCapture = async (sessionId: string, text: string) => {
                const before = enabled.requests().length;
                await enabled.sendPrompt(sessionId, text);
                const calls = enabled
                    .requests()
                    .slice(before)
                    .filter((call) => !isHistorianRequest(call.body));
                const call = calls.find((candidate) =>
                    JSON.stringify(candidate.body).includes(text),
                );
                expect(call).toBeDefined();
                return call!.body;
            };
            // Cool down first: this response lowers NEXT turn's pressure. Only the
            // subsequent deferred passes must replay the complete m[0]/m[1] prefix.
            enabled.mock.setDefault({
                text: "defer",
                usage: {
                    input_tokens: 500,
                    output_tokens: 10,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 500,
                },
            });
            const stablePrefix = historyPrefix(
                await sendAndCapture(child, "child pressure cooled"),
            );
            for (let pass = 1; pass <= 2; pass++) {
                const deferred = await sendAndCapture(child, `child stable defer ${pass}`);
                expect(historyPrefix(deferred)).toBe(stablePrefix);
            }

            // Edit only the canonical USER config in this harness's isolated tree.
            // restart() reuses that tree; its legacy config seed is not the canonical file.
            const configPath = join(
                enabled.opencode.env.configDir,
                "cortexkit",
                "magic-context.jsonc",
            );
            const config = JSON.parse(readFileSync(configPath, "utf8"));
            await enabled.waitFor(
                () => {
                    const row = enabled
                        .contextDb()
                        .prepare(
                            "SELECT compartment_in_progress FROM session_meta WHERE session_id = ?",
                        )
                        .get(child) as { compartment_in_progress: number } | null;
                    return row?.compartment_in_progress === 0;
                },
                {
                    timeoutMs: 60_000,
                    label: "enabled child historian drained before opt-out",
                },
            );
            const compartments = enabled.countCompartments(child);
            // Enabled turns may schedule further work, including on defer. The
            // opt-out contract forbids NEW calls after this drained baseline.
            const historianCallsBeforeRestart = enabled
                .requests()
                .filter((call) => isHistorianRequest(call.body)).length;
            for (const mode of ["false", "removed"] as const) {
                if (mode === "false") config.historian.subagent_reconciliation = false;
                else delete config.historian;
                writeFileSync(configPath, JSON.stringify(config, null, 2));
                await enabled.restart();
                expect(JSON.parse(readFileSync(configPath, "utf8")).historian).toEqual(
                    config.historian,
                );
                const resumed = await sendAndCapture(child, `child resumed with historian ${mode}`);
                expect(enabled.isSubagent(child)).toBe(true);
                expect(enabled.countCompartments(child)).toBe(compartments);
                expect(
                    enabled.requests().filter((call) => isHistorianRequest(call.body)),
                ).toHaveLength(historianCallsBeforeRestart);
                expect(historyPrefix(resumed)).toContain("Child reconciliation chunk");
                expect(JSON.stringify(resumed)).not.toContain(
                    "child turn 1: durable child-only content.",
                );
                expect(enabled.isSubagent(child)).toBe(true);
                expect(enabled.countCompartments(child)).toBe(compartments);
                for (const [sessionId, label] of [
                    [parent, "parent"],
                    [sibling, "sibling"],
                ] as const) {
                    const isolated = await sendAndCapture(
                        sessionId,
                        `${label} isolation after ${mode}`,
                    );
                    expect(JSON.stringify(isolated)).not.toContain("Child reconciliation chunk");
                    expect(JSON.stringify(isolated)).not.toContain(
                        "Child-only durable reconciliation evidence.",
                    );
                    expect(enabled.countCompartments(sessionId)).toBe(0);
                }
                expect(enabled.isSubagent(parent)).toBe(false);
                expect(enabled.isSubagent(sibling)).toBe(true);
                expect(
                    enabled.requests().filter((call) => isHistorianRequest(call.body)),
                ).toHaveLength(historianCallsBeforeRestart);
            }
        } finally {
            await enabled.dispose();
        }
    }, 150_000);

    it("session.created sets is_subagent=1 when parentID is present", async () => {
        h.mock.setDefault({
            text: "ok",
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 0,
            },
        });

        const parent = await h.createSession();
        const child = await h.createChildSession(parent, "child-test");

        // The `session.created` event is delivered asynchronously from
        // OpenCode's event bus into the plugin's event handler. Wait for
        // the child's row to reflect it.
        //
        // Note on primary (parent) sessions: OpenCode emits
        // `parentID: undefined` in session.created for root sessions,
        // and `getSessionCreatedInfo` rejects payloads where parentID
        // isn't a string. Primary sessions therefore get their
        // session_meta row lazily on the first message.updated, not at
        // session.created. That's existing behavior outside this test's
        // scope — we only verify the child-side persistence here.
        await h.waitFor(() => h.isSubagent(child) === true, {
            timeoutMs: 5_000,
            label: "child is_subagent=true",
        });

        expect(h.isSubagent(child)).toBe(true);

        // After the parent sends any prompt, its row MUST exist with
        // is_subagent=false. We drive one turn to create it and verify.
        await h.sendPrompt(parent, "parent kick");
        await h.waitFor(() => h.isSubagent(parent) === false, {
            timeoutMs: 5_000,
            label: "parent is_subagent=false after first turn",
        });
        expect(h.isSubagent(parent)).toBe(false);
    }, 30_000);

    it("subagent WITH ctx_reduce enabled DOES inject §N§ tag prefixes (self-management)", async () => {
        // Unit B: subagents share the process-global ctx_reduce tool, so
        // with ctx_reduce enabled (the harness default) they get §N§
        // prefixes and self-manage their own tool-output bloat.
        h.mock.setDefault({
            text: "ok",
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 0,
            },
        });

        const parent = await h.createSession();
        const child = await h.createChildSession(parent);

        await h.waitFor(() => h.isSubagent(child) === true, {
            timeoutMs: 5_000,
            label: "child is_subagent=true",
        });

        await h.sendPrompt(child, "subagent turn 1: hello from a child session");
        await h.sendPrompt(child, "subagent turn 2: another message");

        expect(h.countTags(child)).toBeGreaterThan(0);

        const requests = h.mock.requests();
        expect(requests.length).toBeGreaterThanOrEqual(2);

        // At least one request for this child session should now carry a
        // §N§ prefix on a user message (the later turn, once tags exist).
        const tagged = requests.filter((r) => hasTagPrefixedUserMessage(r.body));
        expect(tagged.length).toBeGreaterThan(0);
    }, 30_000);

    it("subagent never triggers historian, even when usage crosses execute threshold", async () => {
        h.mock.setDefault({
            text: "fill",
            usage: {
                input_tokens: 1_000,
                output_tokens: 20,
                cache_creation_input_tokens: 1_000,
                cache_read_input_tokens: 0,
            },
        });

        const parent = await h.createSession();
        const child = await h.createChildSession(parent);

        await h.waitFor(() => h.isSubagent(child) === true, {
            timeoutMs: 5_000,
            label: "child is_subagent=true",
        });

        // Fill up some history.
        for (let i = 1; i <= 5; i++) {
            await h.sendPrompt(
                child,
                `subagent fill turn ${i}: meaningful durable content about step ${i}.`,
            );
        }

        // Spike input tokens to cross 40% of 200K (= 80K). For a primary
        // session this would trigger the historian. For a subagent,
        // compartment phase is short-circuited entirely.
        h.mock.setDefault({
            text: "spike",
            usage: {
                input_tokens: 90_000,
                output_tokens: 20,
                cache_creation_input_tokens: 90_000,
                cache_read_input_tokens: 0,
            },
        });
        await h.sendPrompt(child, "subagent spike: this would trigger historian in a primary.");

        // One more turn to let the transform process the post-spike state.
        h.mock.setDefault({
            text: "post-spike",
            usage: {
                input_tokens: 500,
                output_tokens: 10,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 500,
            },
        });
        await h.sendPrompt(child, "subagent post-spike turn.");

        // Give any async runner a chance — we shouldn't see historian fire.
        await Bun.sleep(500);

        const historianRequests = h.mock.requests().filter((r) => isHistorianRequest(r.body));
        console.log(`[TEST] historian requests during subagent run: ${historianRequests.length}`);
        expect(historianRequests.length).toBe(0);

        // No compartments should exist for the subagent.
        expect(h.countCompartments(child)).toBe(0);

        // The `compartment_in_progress` flag should NEVER have been set
        // for this subagent session.
        const row = h
            .contextDb()
            .prepare("SELECT compartment_in_progress FROM session_meta WHERE session_id = ?")
            .get(child) as { compartment_in_progress: number } | null;
        expect(row?.compartment_in_progress ?? 0).toBe(0);
    }, 60_000);

    it("subagent scheduler returns execute when usage crosses threshold (heuristic cleanup gate)", async () => {
        // Real subagents rarely use tools in the test harness because
        // emitting a `tool_use` block forces OpenCode to invoke a real
        // tool, and there's no matching tool registered in the mock
        // environment. Instead of trying to simulate tool traffic, we
        // verify the adjacent invariant: when a subagent crosses the
        // execute threshold, the plugin's scheduler returns "execute"
        // and the transform records that state in session_meta
        // (`last_context_percentage`). This is the gate that lets
        // heuristic cleanup fire for subagents — without it, subagents
        // would never drop tool tags at all.
        //
        // For the actual "tool tags get dropped" invariant, plugin-side
        // unit tests in `transform-postprocess-phase.test.ts` and
        // `heuristic-cleanup.test.ts` cover the path with full fidelity
        // — the e2e harness's job here is just to prove the subagent
        // code path reaches that gate, not to re-verify the cleanup
        // math itself.

        h.mock.setDefault({
            text: "fill",
            usage: {
                input_tokens: 1_000,
                output_tokens: 20,
                cache_creation_input_tokens: 1_000,
                cache_read_input_tokens: 0,
            },
        });

        const parent = await h.createSession();
        const child = await h.createChildSession(parent);

        await h.waitFor(() => h.isSubagent(child) === true, {
            timeoutMs: 5_000,
            label: "child is_subagent=true",
        });

        // Baseline traffic below threshold.
        await h.sendPrompt(child, "subagent turn 1: meaningful content");
        await h.sendPrompt(child, "subagent turn 2: more content");

        // Read the baseline recorded percentage.
        const baseRow = h
            .contextDb()
            .prepare("SELECT last_context_percentage FROM session_meta WHERE session_id = ?")
            .get(child) as { last_context_percentage: number } | null;
        const basePct = baseRow?.last_context_percentage ?? 0;
        console.log(`[TEST] subagent baseline percentage: ${basePct.toFixed(1)}%`);
        expect(basePct).toBeLessThan(40);

        // Spike above the execute threshold (40% of 200K = 80K).
        h.mock.setDefault({
            text: "spike",
            usage: {
                input_tokens: 90_000,
                output_tokens: 20,
                cache_creation_input_tokens: 90_000,
                cache_read_input_tokens: 0,
            },
        });
        await h.sendPrompt(child, "subagent spike: cross execute threshold");

        // Wait for the message.updated event to land and update percentage.
        await h.waitFor(
            () => {
                const row = h
                    .contextDb()
                    .prepare(
                        "SELECT last_context_percentage FROM session_meta WHERE session_id = ?",
                    )
                    .get(child) as { last_context_percentage: number } | null;
                return (row?.last_context_percentage ?? 0) >= 40;
            },
            { timeoutMs: 5_000, label: "percentage reflects spike" },
        );

        const spikedRow = h
            .contextDb()
            .prepare("SELECT last_context_percentage FROM session_meta WHERE session_id = ?")
            .get(child) as { last_context_percentage: number } | null;
        console.log(
            `[TEST] subagent post-spike percentage: ${spikedRow?.last_context_percentage.toFixed(1)}%`,
        );
        expect(spikedRow?.last_context_percentage ?? 0).toBeGreaterThanOrEqual(40);

        // Compartment state must remain untouched — this is a subagent.
        const row = h
            .contextDb()
            .prepare("SELECT compartment_in_progress FROM session_meta WHERE session_id = ?")
            .get(child) as { compartment_in_progress: number } | null;
        expect(row?.compartment_in_progress ?? 0).toBe(0);

        // Historian must not have fired for the subagent.
        const historianReqs = h.mock.requests().filter((r) => isHistorianRequest(r.body));
        expect(historianReqs.length).toBe(0);
        expect(h.countCompartments(child)).toBe(0);
    }, 60_000);

    it("subagent overflow surfaces the provider error without triggering emergency recovery", async () => {
        // Issue #32-style recovery is a PRIMARY-only path. For subagents,
        // a provider overflow should propagate cleanly — the plugin must
        // NOT mark the subagent for emergency recovery (which would try
        // to run historian on a session that can't run historian).

        h.mock.addMatcher((body) => {
            if (isHistorianRequest(body)) return null;
            return {
                error: {
                    status: 400,
                    type: "invalid_request_error",
                    message:
                        "This model's maximum context length is 120000 tokens. Please reduce the length of the messages.",
                },
            };
        });

        const parent = await h.createSession();
        const child = await h.createChildSession(parent);

        await h.waitFor(() => h.isSubagent(child) === true, {
            timeoutMs: 5_000,
            label: "child is_subagent=true",
        });

        try {
            await h.sendPrompt(child, "subagent turn that will overflow", {
                timeoutMs: 15_000,
            });
        } catch {
            // expected — provider returned 400
        }

        // Allow event bus delivery for any state the plugin may record.
        await Bun.sleep(1_000);

        // CRITICAL: the plugin must NOT have triggered emergency recovery
        // for the subagent. Emergency recovery runs historian, and
        // subagents can't run historian — this would cause a wedge.
        const row = h
            .contextDb()
            .prepare(
                "SELECT needs_emergency_recovery, compartment_in_progress FROM session_meta WHERE session_id = ?",
            )
            .get(child) as {
            needs_emergency_recovery: number | null;
            compartment_in_progress: number | null;
        } | null;

        console.log(
            `[TEST] subagent after overflow: needs_emergency_recovery=${row?.needs_emergency_recovery} compartment_in_progress=${row?.compartment_in_progress}`,
        );

        expect(row?.needs_emergency_recovery ?? 0).toBe(0);
        expect(row?.compartment_in_progress ?? 0).toBe(0);

        // Historian must not have been called at any point for the
        // subagent (parent has its own unrelated lifecycle).
        const historianReqs = h.mock.requests().filter((r) => isHistorianRequest(r.body));
        expect(historianReqs.length).toBe(0);
    }, 45_000);
});
