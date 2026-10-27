/// <reference types="bun-types" />

/**
 * Cache-invariant suite — the durable guard against prompt-cache regressions.
 *
 * Motivation: a stale-ctx_reduce strip regression shipped because the existing
 * cache-stability test only drove LOW-PRESSURE PURE-DEFER turns. The bug needed
 * three things that test never combined: conversation GROWTH + an EXECUTE pass
 * (to freeze drop state) + a SUBSEQUENT DEFER pass (where a volatile boundary
 * re-stripped a mid-prefix message). The wire byte-diff caught it in production;
 * nothing in CI did.
 *
 * This suite drives the plugin into those exact states and asserts — using the
 * SAME bust definition the production diagnostic (analyze-cache-busts.ts) uses,
 * ported to `src/cache-analysis.ts` — that DEFER passes never bust the cached
 * prefix. A "bust" = a wire segment BEFORE the final cache_control breakpoint
 * changed between two consecutive requests (i.e. the plugin rewrote bytes that
 * were supposed to stay cached).
 *
 * Invariant classes covered here (the replay class — the regression's family):
 *   A1  low-pressure pure-defer growth stays byte-stable
 *   A2  defer passes AFTER an execute pass + growth stay byte-stable
 *   A3  an aged ctx_reduce call never vanishes mid-prefix on a defer pass
 *       (the exact regression shape)
 *
 * The m[0]/m[1] taxonomy, supersede-delta, boundary, pressure, and restart
 * classes are layered on in sibling describe blocks as the suite grows.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { join, resolve as pathResolve } from 'node:path';
import { computeNormalizedHash } from "../../plugin/src/features/magic-context/memory/normalize-hash";
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import {
    extractM0,
    extractM1,
    findBusts,
    formatBustReport,
    mainAgentRequests,
} from "../src/cache-analysis";
import { TestHarness } from "../src/harness";
import { findHistorianOrdinalRange } from '../src/mock-historian';
import {
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";
import { openTestDb } from "../src/test-db";
import type { MockUsage } from "../src/mock-provider/server";

const RUST_MODE = process.env.MC_E2E_MODE === "rust";
const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";

function wireValueText(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value);
}

function isHistorianRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    if (typeof system === "string") return system.includes(HISTORIAN_SYSTEM_MARKER);
    if (Array.isArray(system)) {
        return system.some(
            (b) =>
                b &&
                typeof b === "object" &&
                typeof (b as { text?: unknown }).text === "string" &&
                ((b as { text: string }).text).includes(HISTORIAN_SYSTEM_MARKER),
        );
    }
    return false;
}

/** Route historian requests to a valid single-compartment response covering the chunk. */
function installHistorianMatcher(h: ScenarioHarness): void {
    h.mock.addMatcher((body) => {
        if (!isHistorianRequest(body)) return null;
        const range = findHistorianOrdinalRange(body);
        const usage = {
            input_tokens: 500,
            output_tokens: 200,
            cache_creation_input_tokens: 500,
            cache_read_input_tokens: 0,
        };
        if (!range) {
            return {
                text: "<output><compartments></compartments><facts></facts><unprocessed_from>1</unprocessed_from></output>",
                usage,
            };
        }
        const payload = [
            "<output>",
            "<compartments>",
            `<compartment start="${range.start}" end="${range.end}" title="cache-invariant chunk" importance="50" episode_type="feature">`,
            "<p1>Driven by the cache-invariant harness: durable signal exercising historian publish and the m[0]/m[1] SOFT-delta taxonomy.</p1>",
            "<p2>Cache-invariant harness chunk exercising historian publish.</p2>",
            "<p3>cache-invariant harness chunk</p3>",
            "<p4/>",
            "</compartment>",
            "</compartments>",
            "<facts></facts>",
            "<events></events>",
            `<unprocessed_from>${range.end + 1}</unprocessed_from>`,
            "</output>",
        ].join("\n");
        return { text: payload, usage };
    });
}

const MODEL_LIMIT = 100_000;

// Below execute_threshold (20% of 100k = 20k) → defer pass.
const DEFER_USAGE: MockUsage = {
    input_tokens: 2_000,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 2_000,
};

// Above execute_threshold → the next pass is an execute pass.
const EXECUTE_USAGE: MockUsage = {
    input_tokens: 30_000,
    output_tokens: 20,
    cache_creation_input_tokens: 30_000,
    cache_read_input_tokens: 0,
};

// High enough to trip the historian trigger (threshold-relative pressure).
const HISTORIAN_TRIGGER_USAGE: MockUsage = {
    input_tokens: 90_000,
    output_tokens: 20,
    cache_creation_input_tokens: 90_000,
    cache_read_input_tokens: 0,
};

let h: ScenarioHarness;

function setDefer(text: string): void {
    h.mock.setDefault({ text, usage: DEFER_USAGE });
}

/** Project identity the plugin resolves at runtime for the harness workdir. */
function projectIdentity(): string {
    return resolveProjectIdentity(h.host === "omp" ? h.workdir : realpathSync(pathResolve(h.workdir)));
}

function writeContextDb<T>(fn: (db: Database) => T): T {
    const dbPath = h.contextDbPath();
    const db = openTestDb(dbPath);
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/** Seed an active project-scoped memory directly. Returns its row id. */
function seedMemory(content: string, category = "PROJECT_RULES"): number {
    return writeContextDb((db) => {
        const now = Date.now();
        const info = db
            .prepare(
                `INSERT INTO memories (
                    project_path, category, content, normalized_hash,
                    source_session_id, source_type, seen_count, retrieval_count,
                    first_seen_at, created_at, updated_at, last_seen_at, status
                ) VALUES (?, ?, ?, ?, NULL, 'historian', 5, 0, ?, ?, ?, ?, 'active')`,
            )
            .run(projectIdentity(), category, content, computeNormalizedHash(content), now, now, now, now);
        return Number(info.lastInsertRowid);
    });
}

/**
 * Queue a non-additive memory mutation (the supersede-delta path). Mirrors the
 * production `queueMemoryMutation` columns exactly — this is what `ctx_memory`
 * update/archive/delete records instead of bumping the project epoch, so the
 * change reconciles via the m[1] <memory-updates> delta rather than a HARD m[0]
 * refold. For `update` we also flip the underlying row content so a later m[0]
 * re-materialize would reconcile to the new value.
 */
function queueMemoryUpdate(targetId: number, newContent: string): void {
    writeContextDb((db) => {
        db.prepare(
            `INSERT INTO memory_mutation_log
                (project_path, mutation_type, target_memory_id, superseded_by_id, category, new_content, queued_at)
             VALUES (?, 'update', ?, NULL, NULL, ?, ?)`,
        ).run(projectIdentity(), targetId, newContent, Date.now());
        db.prepare("UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?").run(
            newContent,
            computeNormalizedHash(newContent),
            Date.now(),
            targetId,
        );
    });
}

/**
 * Bump the project memory epoch, as an external (dashboard) memory mutation
 * does. It no longer forces an m[0] rebuild in TypeScript mode; only the
 * Rust-mode branch below still uses it, to show the bump stays inert there.
 */
function bumpProjectEpoch(): void {
    writeContextDb((db) => {
        db.prepare(
            `INSERT INTO project_state (project_path, project_memory_epoch)
             VALUES (?, 1)
             ON CONFLICT(project_path) DO UPDATE SET project_memory_epoch = project_memory_epoch + 1`,
        ).run(projectIdentity());
    });
}

/** Open OpenCode 2's throwaway host store (the copy the plugin re-reads usage from). */
function openOpenCode2HostDb(): Database {
    const env = (h as unknown as { opencode: { env: { OPENCODE_DB: string } } }).opencode.env;
    return openTestDb(join(h.dataDir, "opencode", env.OPENCODE_DB));
}

/**
 * The completion time the host stored for the session's latest assistant
 * reply, or undefined while it is not stored yet.
 */
async function latestAssistantCompletion(sessionId: string): Promise<number | undefined> {
    if (h.host === "opencode2") {
        const hostDb = openOpenCode2HostDb();
        try {
            const row = hostDb
                .prepare(
                    "SELECT json_extract(data, '$.time.completed') AS completed FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 1",
                )
                .get(sessionId) as { completed: unknown } | null;
            return typeof row?.completed === "number" ? row.completed : undefined;
        } finally {
            hostDb.close();
        }
    }
    if (h instanceof TestHarness) {
        // The harness's SdkClient type lists only the calls it makes itself; the
        // OpenCode SDK client it wraps also lists a session's messages.
        const client = h.client as unknown as {
            session: { messages(opts: { path: { id: string } }): Promise<{ data?: unknown }> };
        };
        const response = await client.session.messages({ path: { id: sessionId } });
        const messages = (response.data ?? []) as Array<{
            info: { role: string; time?: { completed?: number } };
        }>;
        const assistant = messages.filter((message) => message.info.role === "assistant").at(-1);
        return assistant?.info.time?.completed;
    }
    throw new Error(`no view of the host's reply completion time on ${h.host}`);
}

/** Hosts whose stored reply completion time the test can read. */
function hostCompletionVisible(): boolean {
    return h.host === "opencode2" || h instanceof TestHarness;
}

/**
 * Wait until the plugin has stored the response clock of the turn that just
 * finished.
 *
 * A host reports a turn as finished (OpenCode 1's prompt response, OpenCode 2's
 * session wait) before the plugin's completion handler has stored that reply's
 * completion time: OpenCode 1 stores it from a `message.updated` event and
 * OpenCode 2 from its `session.execution.succeeded` subscriber, and both run
 * asynchronously. Aging the clock before that write lands does not stick: the
 * handler then stores a fresh clock for the reply (its completion time, or on
 * OpenCode 1 the handler's own time when the update carries none), which is
 * newer than the aged value, so the next pass sees a warm cache and never folds.
 *
 * Where the host's stored completion time is visible, the clock must equal it
 * exactly. That excludes an earlier write for the same reply that stamped the
 * handler's own time instead. Elsewhere, it must be newer than the moment the
 * provider received this turn's request, which every earlier turn's clock
 * predates.
 */
async function waitForResponseClock(sessionId: string): Promise<void> {
    const turnRequest = mainAgentRequests(h.mock.requests()).at(-1);
    if (!turnRequest) throw new Error("no main-agent request to measure the response clock against");
    let completed: number | undefined;
    if (hostCompletionVisible()) {
        // The reply this turn produced: completed after its request reached the provider.
        const deadline = Date.now() + 30_000;
        for (;;) {
            const value = await latestAssistantCompletion(sessionId);
            if (value !== undefined && value > turnRequest.receivedAt) {
                completed = value;
                break;
            }
            if (Date.now() > deadline) {
                throw new Error(
                    `host never stored this turn's reply completion (latest=${value}, request at ${turnRequest.receivedAt})`,
                );
            }
            await Bun.sleep(20);
        }
    }
    await h.waitFor(
        () => {
            const row = writeContextDb((db) =>
                db
                    .prepare("SELECT last_response_time AS clock FROM session_meta WHERE session_id = ? AND harness = ?")
                    .get(sessionId, h.harnessId),
            ) as { clock: number } | null;
            const clock = row?.clock ?? 0;
            return completed !== undefined ? clock === completed : clock > turnRequest.receivedAt;
        },
        { timeoutMs: 30_000, intervalMs: 20, label: "plugin stores the last reply's response clock" },
    );
}

/**
 * Age the session past its prompt-cache TTL: the idle-expiry rebuild, a
 * genuine HARD trigger. An external (dashboard) memory change no longer forces
 * a HARD of its own; it waits for the next natural rebuild, and an expired
 * cache is one. The fold clock moves with the response clock, so the last
 * response stays newer than the last fold and the next pass treats the expiry
 * as unconsumed. The aging waits for the plugin to store the last reply's
 * response clock first, or that late write would undo it.
 */
async function expireCache(sessionId: string): Promise<void> {
    await waitForResponseClock(sessionId);
    const idle = 16.5 * 60 * 60 * 1000;
    writeContextDb((db) => {
        const result = db
            .prepare(
                "UPDATE session_meta SET last_response_time = last_response_time - ?, cached_m0_materialized_at = cached_m0_materialized_at - ? WHERE session_id = ? AND harness = ? AND last_response_time > 0",
            )
            .run(idle, idle, sessionId, h.harnessId);
        expect(result.changes).toBe(1);
    });
    if (h.host === "opencode2") {
        // OpenCode 2 re-reads the last reply's completion time before scheduling;
        // age that host copy too, or it replaces the aged response clock.
        const hostDb = openOpenCode2HostDb();
        try {
            hostDb
                .prepare(
                    "UPDATE session_message SET data = json_set(data, '$.time.completed', json_extract(data, '$.time.completed') - ?) WHERE session_id = ? AND type = 'assistant'",
                )
                .run(idle, sessionId);
        } finally {
            hostDb.close();
        }
    }
}

/** Emit a single ctx_reduce tool call on the first main-agent request that exposes it. */
function emitCtxReduceOnce(drop: string): void {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (emitted) return null;
        const sys = JSON.stringify(body.system ?? "");
        if (!sys.includes("## Magic Context")) return null;
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const name = tools
            .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : null))
            .find((n) => typeof n === "string" && /ctx_reduce/.test(n)) as string | undefined;
        if (!name) return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `toolu_ci_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                    name,
                    input: { drop },
                },
            ],
            stop_reason: "tool_use" as const,
            usage: DEFER_USAGE,
        };
    });
}

function emitMemoryToolOnce(input: Record<string, unknown>): () => boolean {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (emitted || !JSON.stringify(body.system ?? "").includes("## Magic Context")) return null;
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const name = tools
            .map((tool) =>
                tool && typeof tool === "object" ? (tool as { name?: unknown }).name : null,
            )
            // Oh My Pi prefixes extension tools with "_".
            .find((value) => value === "ctx_memory" || value === "_ctx_memory");
        if (typeof name !== "string") return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `toolu_memory_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                    name,
                    input,
                },
            ],
            stop_reason: "tool_use" as const,
            usage: DEFER_USAGE,
        };
    });
    return () => emitted;
}

async function runMemoryTool(
    sessionId: string,
    input: Record<string, unknown>,
    prompt: string,
): Promise<void> {
    h.mock.reset();
    const wasEmitted = emitMemoryToolOnce(input);
    setDefer("memory tool follow-up");
    await h.sendPrompt(sessionId, prompt);
    expect(wasEmitted()).toBe(true);
}

function memoryIdContaining(body: Record<string, unknown>, content: string): number {
    const m0 = extractM0(body) ?? "";
    const escaped = content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = m0.match(new RegExp(`#(\\d+)(?: \\[[^\n]+\\])?: ${escaped}`));
    if (!match) throw new Error(`no rendered memory id found for ${JSON.stringify(content)}`);
    return Number(match[1]);
}


async function waitForRustCompartment(sessionId: string): Promise<void> {
    if (!(h instanceof TestHarness)) {
        throw new Error("Rust compartment wait requires the OpenCode 1 hermetic module stack");
    }
    const stack = h.rustStack;
    if (!stack) throw new Error("Rust compartment wait requires the hermetic module stack");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        const status = await stack.moduleStatus(sessionId, h.workdir, "session.status");
        if (Number(status.compartment_count ?? 0) > 0) return;
        await Bun.sleep(100);
    }
    throw new Error("waitForRustCompartment timed out after 60000ms");
}

async function waitForLeaseFree(sessionId: string, label: string): Promise<void> {
    await h.waitFor(
        () => {
            try {
                const lease = h.contextDb()
                    .prepare("SELECT holder_id FROM compartment_state_lease WHERE session_id = ?")
                    .get(sessionId) as { holder_id: string } | null;
                return lease === null ? true : null;
            } catch {
                return true;
            }
        },
        { timeoutMs: 60_000, label },
    );
}

function assertNoBusts(label: string): void {
    const requests = mainAgentRequests(h.mock.requests());
    const busts = findBusts(requests);
    if (busts.length > 0) {
        // Surface the exact wire divergence so a CI failure is actionable.
        console.error(`[cache-invariant:${label}] ${busts.length} bust(s):\n${formatBustReport(busts)}`);
    }
    expect({ label, busts: busts.length }).toEqual({ label, busts: 0 });
}

forEachHost(import.meta.url, null, (host) => {
    beforeEach(async () => {
        h = await createScenarioHarness(host, {
            modelContextLimit: MODEL_LIMIT,
            magicContextConfig: {
                execute_threshold_percentage: 20,
                protected_tags: 1,
                dreamer: { disable: true },
                compressor: { enabled: false },
                memory: {
                    enabled: true,
                    auto_promote: false,
                    auto_search: { enabled: false },
                    git_commit_indexing: { enabled: false },
                },
            },
        });
    });

    afterEach(async () => {
        await h.dispose();
    });

    describe("cache invariants — replay class", () => {
    describe("#given a low-pressure conversation (A1)", () => {
        describe("#when several pure-defer turns grow the tail", () => {
            it("#then the cached prefix never busts across defer passes", async () => {
                //#given / #when
                const sessionId = await h.createSession();
                for (let i = 1; i <= 6; i++) {
                    setDefer(`A1 reply ${i}`);
                    await h.sendPrompt(sessionId, `A1 turn ${i}: low-pressure cache-stability probe.`);
                }

                //#then
                const requests = mainAgentRequests(h.mock.requests());
                expect(requests.length).toBeGreaterThanOrEqual(6);
                assertNoBusts("A1-low-pressure-defer");
            }, 120_000);
        });
    });

    describe("#given a conversation that crossed an execute pass (A2)", () => {
        describe("#when defer passes follow the execute pass with continued growth", () => {
            it("#then defer passes after the execute settle to a stable prefix", async () => {
                //#given — warm up, then a high-usage turn so the NEXT pass executes
                const sessionId = await h.createSession();
                setDefer("A2 warmup 1");
                await h.sendPrompt(sessionId, "A2 turn 1: warmup.");
                setDefer("A2 warmup 2");
                await h.sendPrompt(sessionId, "A2 turn 2: warmup.");

                // High usage marks the next transform as an execute pass.
                h.mock.setDefault({ text: "A2 high usage", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "A2 turn 3: high usage triggers an execute pass.");

                // Now several defer turns. The execute pass may legitimately bust
                // once (drops/markers materialize); the invariant is that the
                // DEFER passes that follow it are byte-stable.
                const firstDeferIndex = h.mock.requests().length;
                for (let i = 4; i <= 8; i++) {
                    setDefer(`A2 defer reply ${i}`);
                    await h.sendPrompt(sessionId, `A2 turn ${i}: defer growth after execute.`);
                }

                //#then — analyze only the post-execute defer window
                const deferRequests = mainAgentRequests(h.mock.requests().slice(firstDeferIndex));
                expect(deferRequests.length).toBeGreaterThanOrEqual(4);
                const busts = findBusts(deferRequests);
                if (busts.length > 0) {
                    console.error(
                        `[cache-invariant:A2-post-execute-defer] ${busts.length} bust(s):\n${formatBustReport(busts)}`,
                    );
                }
                expect(busts.length).toBe(0);
            }, 150_000);
        });
    });

    describe("#given an aged ctx_reduce call in the conversation (A3 — the regression)", () => {
        describe("#when pure-defer turns grow the tail past the protected window", () => {
            it("#then the ctx_reduce message never vanishes mid-prefix and the prefix never busts", async () => {
                //#given — a normal turn, then a turn that emits a real ctx_reduce
                // tool call, then enough defer growth to push it well past
                // protected_tags (1).
                const sessionId = await h.createSession();
                setDefer("A3 reply 1");
                await h.sendPrompt(sessionId, "A3 turn 1: establish baseline content.");

                emitCtxReduceOnce("99999");
                setDefer("A3 reply 2 (after ctx_reduce tool call)");
                await h.sendPrompt(sessionId, "A3 turn 2: this turn issues a ctx_reduce call.");

                // Capture the wire signature of the ctx_reduce call once it's on
                // the wire, then grow the conversation with pure-defer turns.
                let sawReduceOnWire = false;
                for (let i = 3; i <= 8; i++) {
                    setDefer(`A3 defer reply ${i}`);
                    await h.sendPrompt(sessionId, `A3 turn ${i}: defer growth ages the ctx_reduce call.`);
                    const body = JSON.stringify(h.mock.lastRequest()?.body ?? {});
                    if (body.includes("ctx_reduce")) sawReduceOnWire = true;
                }

                //#then — across the whole post-ctx_reduce window, zero busts.
                // Pre-fix, one of these defer passes would strip the aged
                // ctx_reduce call mid-prefix (vanish + shift) → a bust here.
                expect(sawReduceOnWire).toBe(true);
                assertNoBusts("A3-ctx_reduce-defer-growth");

                // And the ctx_reduce call must still be present on the final wire
                // (never silently removed on a defer pass).
                const finalBody = JSON.stringify(mainAgentRequests(h.mock.requests()).at(-1)?.body ?? {});
                expect(finalBody).toContain("ctx_reduce");
            }, 150_000);
        });
    });
});

describe("cache invariants — m[0]/m[1] taxonomy (B class)", () => {
    describe("#given a compartment published after m[0] materialized empty (B9 — the seq-refold regression)", () => {
        describe("#when publication surfaces and defer passes follow", () => {
            it(
                RUST_MODE
                    ? "#then the one-time renderer transition folds into m[0], then defer replay freezes"
                    : "#then m[0] stays empty/frozen (SOFT) — the compartment rides m[1], never folds into m[0]",
                async () => {
                    //#given — TypeScript materializes an empty m[0] before the
                    // compartment exists. Rust follows the same setup but may consume
                    // a renderer transition when the first compartment appears.
                    installHistorianMatcher(h);
                    const sessionId = await h.createSession();

                    // Force an early execute pass so m[0] materializes EMPTY
                    // (0 compartments yet). A high-usage turn marks the next pass as
                    // execute; the pass after it does the empty materialization.
                    setDefer("B9 warm 1");
                    await h.sendPrompt(sessionId, "B9 turn 1: warmup.");
                    h.mock.setDefault({
                        text: "B9 high",
                        usage: RUST_MODE
                            ? { input_tokens: 19_000, output_tokens: 20, cache_creation_input_tokens: 19_000, cache_read_input_tokens: 0 }
                            : EXECUTE_USAGE,
                    });
                    await h.sendPrompt(sessionId, "B9 turn 2: high usage marks the next pass execute.");
                    setDefer("B9 materialize-empty");
                    await h.sendPrompt(sessionId, "B9 turn 3: execute pass materializes empty m[0].");

                    const m0BaselineEmpty = wireValueText(
                        extractM0(mainAgentRequests(h.mock.requests()).at(-1)!.body),
                    );
                    expect(m0BaselineEmpty).toContain("<session-history></session-history>");

                    // Build an eligible tail, then trigger and run the historian.
                    for (let i = 4; i <= 11; i++) {
                        setDefer(`B9 reply ${i}`);
                        await h.sendPrompt(sessionId, `B9 turn ${i}: durable content for compartment chunk ${i}. ${h.ballast(3_000)}`);
                    }
                    // Anthropic usage buckets are disjoint. Reporting 90k in both
                    // input and cache creation makes the observed total 180k, above
                    // this model's limit. Limit recovery then changes the history
                    // budget and legitimately HARD-folds m[0] (render_config), so
                    // the test would no longer exercise an additive SOFT refresh.
                    h.mock.setDefault({
                        text: "B9 trigger",
                        usage: RUST_MODE
                            ? HISTORIAN_TRIGGER_USAGE
                            : { ...HISTORIAN_TRIGGER_USAGE, cache_creation_input_tokens: 0 },
                    });
                    await h.sendPrompt(sessionId, "B9 turn 12: high-usage historian trigger.");
                    setDefer("B9 post-trigger");
                    await h.sendPrompt(sessionId, "B9 turn 13: follow-up starts + awaits the historian publish.");

                    if (RUST_MODE) {
                        // a5b7d61d moved Rust publication to the out-of-band Broca
                        // stack. The next real turn surfaces the committed module state
                        // on the provider wire instead of waiting for a synthetic request.
                        await waitForRustCompartment(sessionId);
                        setDefer("B9 surface published Rust compartment");
                        await h.sendPrompt(sessionId, "B9 turn 14: surface the published compartment.");
                    } else {
                        await h.waitFor(() => h.countCompartments(sessionId) >= 1, {
                            timeoutMs: 60_000,
                            label: "B9 compartment publishes to DB",
                        });
                        setDefer("B9 surface published compartment");
                        await h.sendPrompt(sessionId, "B9 turn 14: surface the published compartment.");
                        if (h.host === "pi" || h.host === "omp") {
                            // Pi-family publication signals materialization after
                            // the publishing pass, so one more pass surfaces m[1].
                            await h.sendPrompt(sessionId, "B9 turn 14b: surface deferred Pi publication.");
                        }
                    }

                    //#then — TypeScript keeps the additive publication in the m[1]
                    // delta lane. Rust first consumes the pending hard transition for
                    // this newly detected renderer shape, then replays that result.
                    let requests = mainAgentRequests(h.mock.requests());
                    let surfaceReq = requests.at(-1);
                    if (h.host === "pi" || h.host === "omp") {
                        surfaceReq = requests.find((request) =>
                            wireValueText(extractM1(request.body))?.includes("<new-compartments>"),
                        );
                        for (let attempt = 0; attempt < 4 && !surfaceReq; attempt++) {
                            await waitForLeaseFree(sessionId, "historian lease free before B9 surface execute");
                            h.mock.setDefault({ text: `B9 surface ${attempt}`, usage: EXECUTE_USAGE });
                            await h.sendPrompt(sessionId, `B9 turn ${15 + attempt}: execute pass to surface.`);
                            requests = mainAgentRequests(h.mock.requests());
                            surfaceReq = requests.find((request) =>
                                wireValueText(extractM1(request.body))?.includes("<new-compartments>"),
                            );
                        }
                    }
                    expect(surfaceReq).toBeDefined();
                    expect(JSON.stringify(surfaceReq!.body)).toContain("B9 turn");
                    const m1 = wireValueText(extractM1(surfaceReq!.body));
                    const m0 = wireValueText(extractM0(surfaceReq!.body));
                    if (RUST_MODE) {
                        // 887696d9 gives each newly detected renderer shape one hard
                        // transition. cc842547 stores the consumed marker per shape, so
                        // this compartment cannot fold again or receive another replay identifier.
                        expect(m0).toContain("Hermetic Broca chunk");
                        expect(m0).not.toBe(m0BaselineEmpty!);
                        expect(m1).not.toContain("<new-compartments>");
                    } else {
                        expect(m1).toContain("<new-compartments>");
                        expect(m1).toContain("cache-invariant chunk");
                        expect(m0).not.toContain("cache-invariant chunk");
                        expect(m0).toBe(m0BaselineEmpty!);
                    }

                    const surfaceIdx = requests.indexOf(surfaceReq!);
                    setDefer("B9 replay 1");
                    await h.sendPrompt(
                        sessionId,
                        "B9 turn 15: defer replay of the surfaced compartment.",
                    );
                    setDefer("B9 replay 2");
                    await h.sendPrompt(
                        sessionId,
                        "B9 turn 16: defer replay again.",
                    );

                    // From the surface request through every subsequent defer-only
                    // replay, both message lanes must remain byte-identical. The existing
                    // delta or transition result is reused rather than rendered again.
                    const after = mainAgentRequests(h.mock.requests()).slice(surfaceIdx);
                    const m1s = new Set(after.map((r) => wireValueText(extractM1(r.body))));
                    const m0s = new Set(after.map((r) => wireValueText(extractM0(r.body))));
                    expect(m1s.size).toBe(1);
                    expect(m0s.size).toBe(1);

                    // Whole-wire no-bust is asserted only over the trailing defer
                    // pair. The surface request may legitimately bust once.
                    const replayPair = mainAgentRequests(h.mock.requests()).slice(-2);
                    const busts = findBusts(replayPair);
                    if (busts.length > 0) {
                        console.error(
                            `[cache-invariant:B9-soft-publish] ${busts.length} bust(s):\n${formatBustReport(busts)}`,
                        );
                    }
                    expect(busts.length).toBe(0);
                },
                220_000,
            );
        });
    });

    describe("#given another writer's memory added after m[0] materialized (B10 — stays out until HARD)", () => {
        describe("#when an execute (SOFT) pass follows the write", () => {
            it("#then neither m[0] nor m[1] shows it, and the next genuine HARD folds it into m[0]", async () => {
                //#given — seed a baseline memory, then force m[0] to materialize
                // WITH that memory in the baseline (early execute pass). This
                // freezes cachedM0MaxMemoryId at the baseline's id.
                const sessionId = await h.createSession();
                if (RUST_MODE) {
                    const freshRule = "B10 fresh rule: always run the full gate before a release.";
                    await runMemoryTool(
                        sessionId,
                        { action: "write", category: "PROJECT_RULES", content: freshRule },
                        "B10 Rust writer: save the release rule.",
                    );

                    // Both runtimes write the same context rows. Verify each committed
                    // write in the context sent with a fresh Rust session's provider request.
                    const readerSessionId = await h.createSession();
                    h.mock.reset();
                    setDefer("B10 Rust reader");
                    await h.sendPrompt(readerSessionId, "B10 Rust reader: load project memory.");
                    const readerM0 = extractM0(mainAgentRequests(h.mock.requests()).at(-1)!.body)!;
                    expect(readerM0).toContain(freshRule);
                    const sharedRule = "B10 shared TS-side write";
                    seedMemory(sharedRule);
                    const sharedReader = await h.createSession();
                    h.mock.reset();
                    setDefer("B10 shared-store reader");
                    await h.sendPrompt(sharedReader, "Read the TypeScript writer's memory.");
                    expect(extractM0(mainAgentRequests(h.mock.requests()).at(-1)!.body)).toContain(sharedRule);
                    return;
                }
                seedMemory("B10 baseline rule: prefer the project's own tools over shell fallbacks.");
                setDefer("B10 warm 1");
                await h.sendPrompt(sessionId, "B10 turn 1: warmup.");
                h.mock.setDefault({ text: "B10 high", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "B10 turn 2: high usage marks next pass execute.");
                setDefer("B10 materialize");
                await h.sendPrompt(sessionId, "B10 turn 3: execute pass materializes m[0] with baseline memory.");

                const m0Baseline = extractM0(mainAgentRequests(h.mock.requests()).at(-1)!.body);
                expect(m0Baseline).toContain("B10 baseline rule");

                //#when — another writer (a historian promotion here) adds a memory after
                // the baseline froze, then an execute pass runs. The execute DECISION for
                // a turn is read from the PREVIOUS turn's recorded usage, so turn 4
                // records high usage to make turn 5 the cache-busting (SOFT) pass. A
                // busting SOFT reads no memory rows: the memory waits for the next HARD.
                h.mock.setDefault({ text: "B10 pressure", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "B10 turn 4: high usage marks the next pass execute.");
                const firstAfterWrite = mainAgentRequests(h.mock.requests()).length;
                seedMemory("B10 fresh rule: always run the full gate before a release.");
                setDefer("B10 soft");
                await h.sendPrompt(sessionId, "B10 turn 5: execute pass after another writer's memory.");

                //#then — no pass after the write shows it, and m[0] is byte-identical.
                let requests = mainAgentRequests(h.mock.requests());
                for (const request of requests.slice(firstAfterWrite)) {
                    expect(extractM1(request.body) ?? "").not.toContain("B10 fresh rule");
                    expect(extractM0(request.body)).toBe(m0Baseline!);
                }

                // Trailing pure-defer replay pair must be byte-stable.
                setDefer("B10 replay 1");
                await h.sendPrompt(sessionId, "B10 turn 6: defer replay.");
                setDefer("B10 replay 2");
                await h.sendPrompt(sessionId, "B10 turn 7: defer replay again.");
                const replayPair = mainAgentRequests(h.mock.requests()).slice(-2);
                const busts = findBusts(replayPair);
                if (busts.length > 0) {
                    console.error(
                        `[cache-invariant:B10-foreign-memory] ${busts.length} bust(s):\n${formatBustReport(busts)}`,
                    );
                }
                expect(busts.length).toBe(0);
                for (const request of replayPair)
                    expect(extractM1(request.body) ?? "").not.toContain("B10 fresh rule");

                //#then — a genuine HARD trigger (an idle cache expiry) folds it into m[0].
                h.mock.setDefault({ text: "B10 hard-pressure", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "B10 turn 8: high usage marks the next pass execute.");
                await expireCache(sessionId);
                setDefer("B10 refold");
                await h.sendPrompt(sessionId, "B10 turn 9: execute pass HARD-refolds m[0].");
                requests = mainAgentRequests(h.mock.requests());
                expect(extractM0(requests.at(-1)!.body)).toContain("B10 fresh rule");
            }, 220_000);
        });
    });

    describe("#given this session's own agent memory save after m[0] materialized (B10 — agent fragment)", () => {
        describe("#when an execute (SOFT) pass follows the save", () => {
            it(
                RUST_MODE
                    ? "#then the Rust SOFT does not show it yet (fragments land in S4) and a fresh session's HARD does"
                    : "#then m[1] shows it as an <added> fragment and m[0] stays byte-identical",
                async () => {
                    const sessionId = await h.createSession();
                    const ownRule = "B10 own rule: name every cache bust in the release notes.";
                    if (RUST_MODE) {
                        // The Rust renderer replays served memory blocks and has no agent
                        // fragments yet (S4), so the agent's save waits for a HARD fold in
                        // its own session; a fresh session's first render is one.
                        setDefer("B10 own Rust warm");
                        await h.sendPrompt(sessionId, "B10 own Rust turn 1: materialize the baseline.");
                        await runMemoryTool(
                            sessionId,
                            { action: "write", category: "PROJECT_RULES", content: ownRule },
                            "B10 own Rust turn: save the release-notes rule.",
                        );
                        setDefer("B10 own Rust after save");
                        await h.sendPrompt(sessionId, "B10 own Rust turn 2: continue after the save.");
                        const last = mainAgentRequests(h.mock.requests()).at(-1)!.body;
                        expect(extractM1(last) ?? "").not.toContain(ownRule);
                        expect(extractM0(last) ?? "").not.toContain(ownRule);
                        const readerSessionId = await h.createSession();
                        h.mock.reset();
                        setDefer("B10 own Rust reader");
                        await h.sendPrompt(readerSessionId, "B10 own Rust reader: load project memory.");
                        expect(extractM0(mainAgentRequests(h.mock.requests()).at(-1)!.body)).toContain(ownRule);
                        return;
                    }
                    seedMemory("B10 own-write baseline: prefer small, reviewed changes.");
                    setDefer("B10 own warm 1");
                    await h.sendPrompt(sessionId, "B10 own turn 1: warmup.");
                    h.mock.setDefault({ text: "B10 own high", usage: EXECUTE_USAGE });
                    await h.sendPrompt(sessionId, "B10 own turn 2: high usage marks next pass execute.");
                    setDefer("B10 own materialize");
                    await h.sendPrompt(sessionId, "B10 own turn 3: execute pass materializes m[0].");
                    const m0Baseline = extractM0(mainAgentRequests(h.mock.requests()).at(-1)!.body);
                    expect(m0Baseline).toContain("B10 own-write baseline");

                    //#when — the agent itself saves a memory through ctx_memory, then an
                    // execute pass runs (turn 4 records high usage, turn 5 busts).
                    await runMemoryTool(
                        sessionId,
                        { action: "write", category: "PROJECT_RULES", content: ownRule, ids: [] },
                        "B10 own turn: save the release-notes rule.",
                    );
                    h.mock.setDefault({ text: "B10 own pressure", usage: EXECUTE_USAGE });
                    await h.sendPrompt(sessionId, "B10 own turn 4: high usage marks the next pass execute.");
                    setDefer("B10 own soft");
                    await h.sendPrompt(sessionId, "B10 own turn 5: execute pass after the agent's own save.");

                    const last = mainAgentRequests(h.mock.requests()).at(-1)!.body;
                    expect(extractM0(last)).toBe(m0Baseline!);
                    const m1 = extractM1(last) ?? "";
                    expect(m1).toContain("<memory-updates>");
                    expect(m1).toMatch(
                        new RegExp(`<added id="\\d+" category="PROJECT_RULES">${ownRule}</added>`),
                    );

                    // The fragment replays byte-identically on the defer pair.
                    setDefer("B10 own replay 1");
                    await h.sendPrompt(sessionId, "B10 own turn 6: defer replay.");
                    setDefer("B10 own replay 2");
                    await h.sendPrompt(sessionId, "B10 own turn 7: defer replay again.");
                    const replayPair = mainAgentRequests(h.mock.requests()).slice(-2);
                    expect(findBusts(replayPair).length).toBe(0);
                    for (const request of replayPair) expect(extractM1(request.body)).toBe(m1);
                },
                220_000,
            );
        });
    });

    describe("#given another writer's update to a rendered memory (B11 — stays out until HARD)", () => {
        describe("#when an execute (SOFT) pass follows the update", () => {
            it("#then m[1] is unchanged, m[0] keeps the old text, and the next genuine HARD shows the new text", async () => {
                //#given — seed a memory and materialize m[0] WITH it in the
                // baseline (so it's a rendered memory the mutation can target).
                const sessionId = await h.createSession();
                if (RUST_MODE) {
                    const original = "B11 original rule: deploys go through the staging pipeline first.";
                    await runMemoryTool(
                        sessionId,
                        { action: "write", category: "PROJECT_RULES", content: original },
                        "B11 Rust writer: save the baseline rule.",
                    );

                    const mutationSessionId = await h.createSession();
                    h.mock.reset();
                    setDefer("B11 Rust baseline materialize");
                    await h.sendPrompt(mutationSessionId, "B11 Rust turn 1: load project memory.");
                    const baselineBody = mainAgentRequests(h.mock.requests()).at(-1)!.body;
                    expect(extractM0(baselineBody)).toContain(original);
                    const rustMemoryId = memoryIdContaining(baselineBody, original);

                    const revised =
                        "B11 revised rule: deploys go straight to production with a feature flag.";
                    await runMemoryTool(
                        mutationSessionId,
                        { action: "update", ids: [rustMemoryId], content: revised },
                        "B11 Rust turn 2: revise the deployment rule.",
                    );
                    const readerSessionId = await h.createSession();
                    h.mock.reset();
                    setDefer("B11 Rust reader");
                    await h.sendPrompt(readerSessionId, "B11 Rust reader: load revised project memory.");
                    const revisedM0 = extractM0(mainAgentRequests(h.mock.requests()).at(-1)!.body)!;
                    expect(revisedM0).toContain(revised);
                    expect(revisedM0).not.toContain(original);
                    const sharedUpdate = "B11 shared TS update";
                    queueMemoryUpdate(rustMemoryId, sharedUpdate);
                    const sharedReader = await h.createSession();
                    h.mock.reset();
                    setDefer("B11 shared-store reader");
                    await h.sendPrompt(sharedReader, "Read the TypeScript writer's update.");
                    const sharedM0 = extractM0(mainAgentRequests(h.mock.requests()).at(-1)!.body)!;
                    expect(sharedM0).toContain(sharedUpdate);
                    expect(sharedM0).not.toContain(revised);
                    return;
                }
                const memId = seedMemory(
                    "B11 original rule: deploys go through the staging pipeline first.",
                );
                setDefer("B11 warm 1");
                await h.sendPrompt(sessionId, "B11 turn 1: warmup.");
                h.mock.setDefault({ text: "B11 high", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "B11 turn 2: high usage marks next pass execute.");
                setDefer("B11 materialize");
                await h.sendPrompt(sessionId, "B11 turn 3: execute pass materializes m[0] with the memory.");

                const baselineBody = mainAgentRequests(h.mock.requests()).at(-1)!.body;
                const m0Baseline = extractM0(baselineBody);
                const m1Baseline = extractM1(baselineBody);
                expect(m0Baseline).toContain("B11 original rule");

                //#when — another writer updates the rendered memory (a mutation-log row
                // and new row text), then an execute pass runs. A busting SOFT reads
                // neither memory rows nor the mutation log, so nothing changes until HARD.
                h.mock.setDefault({ text: "B11 pressure", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "B11 turn 4: high usage marks the next pass execute.");
                const firstAfterUpdate = mainAgentRequests(h.mock.requests()).length;
                queueMemoryUpdate(memId, "B11 revised rule: deploys go straight to production with a feature flag.");
                setDefer("B11 soft");
                await h.sendPrompt(sessionId, "B11 turn 5: execute pass after another writer's update.");

                //#then
                let requests = mainAgentRequests(h.mock.requests());
                for (const request of requests.slice(firstAfterUpdate)) {
                    expect(extractM1(request.body)).toBe(m1Baseline);
                    expect(extractM1(request.body) ?? "").not.toContain("<memory-updates>");
                    expect(extractM0(request.body)).toBe(m0Baseline!);
                }

                // Trailing pure-defer replay pair must be byte-stable.
                setDefer("B11 replay 1");
                await h.sendPrompt(sessionId, "B11 turn 6: defer replay.");
                setDefer("B11 replay 2");
                await h.sendPrompt(sessionId, "B11 turn 7: defer replay again.");
                const replayPair = mainAgentRequests(h.mock.requests()).slice(-2);
                const busts = findBusts(replayPair);
                if (busts.length > 0) {
                    console.error(
                        `[cache-invariant:B11-foreign-update] ${busts.length} bust(s):\n${formatBustReport(busts)}`,
                    );
                }
                expect(busts.length).toBe(0);

                //#then — a genuine HARD trigger (an idle cache expiry) shows the new text.
                h.mock.setDefault({ text: "B11 hard-pressure", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "B11 turn 8: high usage marks the next pass execute.");
                await expireCache(sessionId);
                setDefer("B11 refold");
                await h.sendPrompt(sessionId, "B11 turn 9: execute pass HARD-refolds m[0].");
                requests = mainAgentRequests(h.mock.requests());
                const refoldM0 = extractM0(requests.at(-1)!.body)!;
                expect(refoldM0).toContain("B11 revised rule");
                expect(refoldM0).not.toContain("B11 original rule");
            }, 220_000);
        });
    });

    describe("#given a genuine HARD trigger — idle cache expiry (B12 — the fold direction)", () => {
        describe("#when another writer's memory waited out a SOFT, then the cache expires", () => {
            it("#then m[0] re-materializes with the memory, m[1] stays the placeholder, and defer re-stabilizes", async () => {
                //#given — materialize an empty m[0], add a memory from another writer,
                // and run an execute (SOFT) pass: the memory stays out of the prompt.
                const sessionId = await h.createSession();
                if (RUST_MODE) {
                    const deltaRule =
                        "B12 delta rule: keep the cache prefix byte-identical across defer passes.";
                    await runMemoryTool(
                        sessionId,
                        { action: "write", category: "PROJECT_RULES", content: deltaRule },
                        "B12 Rust writer: save a delta rule.",
                    );
                    const readerSessionId = await h.createSession();
                    h.mock.reset();
                    setDefer("B12 Rust reader");
                    await h.sendPrompt(readerSessionId, "B12 Rust reader: load project memory.");
                    const moduleOwnedM0 = extractM0(
                        mainAgentRequests(h.mock.requests()).at(-1)!.body,
                    )!;
                    expect(moduleOwnedM0).toContain(deltaRule);

                    // PARITY.md assigns the effective epoch to Rust authority. Mutating
                    // the TS mirror succeeds but is intentionally inert on provider bytes;
                    // the module unit gate pins the real epoch-bump HARD fold.
                    bumpProjectEpoch();
                    setDefer("B12 Rust inert TS epoch replay");
                    await h.sendPrompt(readerSessionId, "B12 Rust reader: replay after TS mirror bump.");
                    expect(extractM0(mainAgentRequests(h.mock.requests()).at(-1)!.body)).toBe(
                        moduleOwnedM0,
                    );
                    return;
                }
                setDefer("B12 warm 1");
                await h.sendPrompt(sessionId, "B12 turn 1: warmup.");
                h.mock.setDefault({ text: "B12 high", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "B12 turn 2: high usage marks next pass execute.");
                setDefer("B12 materialize-empty");
                await h.sendPrompt(sessionId, "B12 turn 3: execute pass materializes empty m[0].");

                h.mock.setDefault({ text: "B12 pressure", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "B12 turn 4: high usage marks next pass execute.");
                seedMemory("B12 delta rule: keep the cache prefix byte-identical across defer passes.");
                setDefer("B12 soft");
                await h.sendPrompt(sessionId, "B12 turn 5: execute pass after another writer's memory.");

                let requests = mainAgentRequests(h.mock.requests());
                const surfaceReq = requests.at(-1)!;
                // Before the expiry: the memory is neither in the empty m[0] nor in m[1].
                expect(extractM0(surfaceReq.body)).toContain("<session-history></session-history>");
                expect(extractM0(surfaceReq.body)).not.toContain("B12 delta rule");
                expect(extractM1(surfaceReq.body) ?? "").not.toContain("B12 delta rule");

                //#when — a HARD trigger fires (the prompt cache expired while idle).
                // Turn 6 records high usage so turn 7 is cache-busting;
                // mustMaterialize must re-materialize m[0] on the expiry.
                h.mock.setDefault({ text: "B12 hard-pressure", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "B12 turn 6: high usage marks the next pass execute.");
                await expireCache(sessionId);
                setDefer("B12 refold");
                await h.sendPrompt(sessionId, "B12 turn 7: execute pass HARD-refolds m[0].");

                //#then — the memory has folded INTO the m[0] baseline, and m[1] is the
                // empty placeholder.
                requests = mainAgentRequests(h.mock.requests());
                const refoldReq = requests.find(
                    (r, i) =>
                        i > requests.indexOf(surfaceReq) &&
                        (extractM0(r.body)?.includes("B12 delta rule") ?? false),
                );
                expect(refoldReq).toBeDefined();
                const m0 = extractM0(refoldReq!.body)!;
                const m1 = extractM1(refoldReq!.body)!;
                // Fold invariant: the memory is now in the m[0] baseline...
                expect(m0).toContain("B12 delta rule");
                // ...and m[1] is the empty placeholder (no <new-memories>).
                expect(m1).toContain("(no new content since last materialization)");
                expect(m1).not.toContain("B12 delta rule");

                // After the one-time HARD fold, defer passes re-stabilize: the new
                // m[0]+m[1] replay byte-identical across the trailing defer pair.
                const refoldIdx = requests.indexOf(refoldReq!);
                setDefer("B12 replay 1");
                await h.sendPrompt(sessionId, "B12 turn 8: defer replay after refold.");
                setDefer("B12 replay 2");
                await h.sendPrompt(sessionId, "B12 turn 9: defer replay again.");
                const after = mainAgentRequests(h.mock.requests()).slice(refoldIdx);
                expect(new Set(after.map((r) => extractM0(r.body))).size).toBe(1);
                const replayPair = mainAgentRequests(h.mock.requests()).slice(-2);
                const busts = findBusts(replayPair);
                if (busts.length > 0) {
                    console.error(
                        `[cache-invariant:B12-hard-refold] ${busts.length} bust(s):\n${formatBustReport(busts)}`,
                    );
                }
                expect(busts.length).toBe(0);
            }, 240_000);
        });
    });
});
});
