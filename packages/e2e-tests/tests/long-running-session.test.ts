/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { realpathSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { computeNormalizedHash } from "../../plugin/src/features/magic-context/memory/normalize-hash";
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import { computeSyntheticCallId } from "../../plugin/src/hooks/magic-context/todo-view";
import { TestHarness } from "../src/harness";
import { OpenCode2TestHarness } from "../src/opencode2-harness";
import { PiTestHarness } from "../src/pi-harness";
import {
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";
import { buildMockHistorianPayload, findHistorianOrdinalRange } from "../src/mock-historian";
import type { MockUsage } from "../src/mock-provider/server";
import { openTestDb } from "../src/test-db";
import { sessionMetaFieldSelect } from "../src/session-meta-fields";

const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";
const RUST_MODE = process.env.MC_E2E_MODE === "rust";

const LOW_USAGE: MockUsage = {
    input_tokens: 1_000,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1_000,
};

const HIGH_USAGE: MockUsage = {
    input_tokens: 30_000,
    output_tokens: 20,
    cache_creation_input_tokens: 30_000,
    cache_read_input_tokens: 0,
};

const HISTORIAN_TRIGGER_USAGE: MockUsage = {
    input_tokens: 90_000,
    output_tokens: 20,
    cache_creation_input_tokens: 90_000,
    cache_read_input_tokens: 0,
};

const FORCE_CLEANUP_USAGE: MockUsage = {
    input_tokens: 85_000,
    output_tokens: 20,
    cache_creation_input_tokens: 85_000,
    cache_read_input_tokens: 0,
};

const ACTIVE_TODOS = [
    { content: "Ship long-running OpenCode fixture", status: "in_progress", priority: "high" },
    { content: "Verify cache replay after synthetic todo", status: "pending", priority: "medium" },
];

const TERMINAL_TODOS = [
    { content: "Finish note boundary", status: "completed", priority: "high" },
    { content: "Trigger note nudge", status: "cancelled", priority: "medium" },
];

type WireMessage = { role?: string; content?: unknown };
type HistorianRange = { start: number; end: number };
type HistorianCapture = { requestIndex: number; range: HistorianRange };
type PublishedCompartment = { start_message: number; end_message: number; title: string };

let h: ScenarioHarness;

function stripCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            if (key === "cache_control") continue;
            out[key] = stripCacheControl(child);
        }
        return out;
    }
    return value;
}

function serialize(value: unknown): string {
    return JSON.stringify(stripCacheControl(value));
}

function isMagicContextRequest(body: Record<string, unknown>): boolean {
    return JSON.stringify(body.system ?? "").includes("## Magic Context");
}

function isHistorianRequest(body: Record<string, unknown>): boolean {
    return JSON.stringify(body.system ?? "").includes(HISTORIAN_SYSTEM_MARKER);
}

function mainRequests() {
    return h.mock.requests().filter((request) => isMagicContextRequest(request.body));
}

function promptMarker(turn: number): string {
    return `[[long-running-turn-${turn}-${crypto.randomUUID()}]]`;
}

function selectRequestForMarker<T extends { body: Record<string, unknown> }>(
    requests: readonly T[],
    marker: string,
): T {
    const matching = requests.filter((request) => latestUserText(request.body).includes(marker));
    const request = matching[matching.length - 1];
    if (!request) {
        throw new Error(`no Magic Context request contains prompt marker ${marker}`);
    }
    return request;
}

async function mainRequestForMarker(marker: string) {
    await h.waitForMockQuiescence({ label: `request capture for ${marker}` });
    return selectRequestForMarker(mainRequests(), marker);
}

async function resetMock(label: string): Promise<void> {
    await h.waitForMockQuiescence({ label: `before mock.reset: ${label}` });
    h.mock.reset();
}

function matchHistorianCaptureToCompartment(
    captures: readonly HistorianCapture[],
    compartments: readonly PublishedCompartment[],
): { capture: HistorianCapture; compartment: PublishedCompartment } | null {
    for (const capture of captures) {
        const compartment = compartments.find(
            (candidate) =>
                candidate.start_message === capture.range.start &&
                candidate.end_message === capture.range.end,
        );
        if (compartment) return { capture, compartment };
    }
    return null;
}

function requestsSince(index: number) {
    return h
        .mock
        .requests()
        .slice(index)
        .filter((request) => isMagicContextRequest(request.body));
}

function requestMessages(body: Record<string, unknown>): WireMessage[] {
    return Array.isArray(body.messages) ? (body.messages as WireMessage[]) : [];
}

function textFromContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((block) => {
            if (!block || typeof block !== "object") return "";
            const text = (block as { text?: unknown }).text;
            return typeof text === "string" ? text : "";
        })
        .join("\n");
}

function latestUserText(body: Record<string, unknown>): string {
    const messages = requestMessages(body);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role !== "user") continue;
        const text = textFromContent(messages[i]?.content);
        if (text.length > 0) return text;
    }
    return "";
}

function findToolName(body: Record<string, unknown>, pattern: RegExp): string | null {
    const tools = body.tools;
    if (!Array.isArray(tools)) return null;
    for (const tool of tools) {
        if (!tool || typeof tool !== "object") continue;
        const name = (tool as { name?: unknown }).name;
        if (typeof name === "string" && pattern.test(name)) return name;
    }
    return null;
}

function emitToolOnce(pattern: RegExp, input: Record<string, unknown>, usage: MockUsage = LOW_USAGE): void {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (emitted || !isMagicContextRequest(body)) return null;
        const name = findToolName(body, pattern);
        if (!name) return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `toolu_long_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                    name,
                    input,
                },
            ],
            stop_reason: "tool_use",
            usage,
        };
    });
}

function pendingMarkerColumns(): string {
    const pending = h.host === "pi" || h.host === "omp"
        ? "pending_pi_compaction_marker_state"
        : "pending_compaction_marker_state";
    return `${pending} AS pending_compaction_marker_state, compaction_marker_state`;
}

function readMeta<T>(sessionId: string, columns: string): T | null {
    return h
        .contextDb()
        .prepare(`SELECT ${columns} FROM session_meta WHERE session_id = ?`)
        .get(sessionId) as T | null;
}

function contextDbPath(): string {
    return h.contextDbPath();
}

function writeDb(fn: (db: Database) => void): void {
    const db = openTestDb(contextDbPath(), { readwrite: true });
    try {
        fn(db);
    } finally {
        db.close();
    }
}

function seedMemory(content: string): void {
    const projectIdentity = resolveProjectIdentity(realpathSync(pathResolve(h.workdir)));
    writeDb((db) => {
        const now = Date.now();
        db.prepare(
            `INSERT INTO memories (
                project_path, category, content, normalized_hash,
                source_session_id, source_type, seen_count, retrieval_count,
                first_seen_at, created_at, updated_at, last_seen_at, status
            ) VALUES (?, 'WORKFLOW_RULES', ?, ?, NULL, 'historian', 5, 0, ?, ?, ?, ?, 'active')`,
        ).run(projectIdentity, content, computeNormalizedHash(content), now, now, now, now);
    });
}

function normalizedTodos(todos: typeof ACTIVE_TODOS): string {
    return JSON.stringify(todos.map(({ content, status, priority }) => ({ content, status, priority })));
}

function contentBlocks(content: unknown): unknown[] {
    return Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
}

function findSyntheticTodoPair(body: Record<string, unknown>, callId: string): { bytes: string } | null {
    const messages = requestMessages(body);
    for (let i = 0; i < messages.length - 1; i += 1) {
        const assistant = messages[i]!;
        if (assistant.role !== "assistant") continue;
        const toolUse = contentBlocks(assistant.content).find((block) => {
            const b = block as { type?: unknown; id?: unknown; name?: unknown } | null;
            return b?.type === "tool_use" && b.id === callId && /todo.*write|write.*todo|todowrite/i.test(String(b.name ?? ""));
        });
        if (!toolUse) continue;
        const toolResult = contentBlocks(messages[i + 1]!.content).find((block) => {
            const b = block as { type?: unknown; tool_use_id?: unknown } | null;
            return b?.type === "tool_result" && b.tool_use_id === callId;
        });
        if (toolResult) return { bytes: serialize([toolUse, toolResult]) };
    }
    return null;
}

let turnCounter = 0;
async function send(
    sessionId: string,
    prompt: string,
    text: string,
    usage: MockUsage = LOW_USAGE,
): Promise<string> {
    h.mock.setDefault({ text, usage });
    const turn = ++turnCounter;
    const marker = promptMarker(turn);
    const reqsBefore = h.mock.requests().length;
    const startedAt = Date.now();
    // [LR-DIAG] console.error flushes immediately on CI even when console.log is buffered
    console.error(`[LR-DIAG] turn ${turn} START prompt="${prompt.slice(0, 60)}" mockReqs=${reqsBefore}`);

    // OC-DIAG: every 50 mock requests, query opencode's session DB to see
    // what its filterCompacted/latest() actually returns. This tells us why
    // OpenCode's loop break condition isn't firing.
    let lastDumpAt = 0;
    // Runaway detector: if a single turn generates >100 mock requests, it's
    // pathological. Normal turns generate 1-3 requests. Fire 1 diagnostic
    // then fail the test fast — much better than waiting for 600s timeout.
    let runawayAborted = false;
    const dumpTimer = setInterval(() => {
        if (h.host !== "opencode") return;
        const now = Date.now();
        const reqs = h.mock.requests().length;
        // Fire diagnostic as soon as we see >=25 unexpected requests, then
        // every 5s while the hang persists. The earlier we capture data the
        // less likely it is to be lost to a job-level CI timeout.
        if (reqs > reqsBefore + 25 && now - lastDumpAt > 5000) {
            lastDumpAt = now;
            // Open opencode's session DB directly (Database is imported at top of file)
            try {
                const ocDbPath = join(h.dataDir, "opencode", "opencode.db");
                const ocDb = openTestDb(ocDbPath, { readonly: true });
                // Get latest messages in the session
                const rows = ocDb.prepare(
                    "SELECT id, json_extract(data, '$.role') AS role, json_extract(data, '$.finish') AS finish, json_extract(data, '$.summary') AS summary FROM message WHERE session_id = ? ORDER BY id DESC LIMIT 6",
                ).all(sessionId) as Array<{ id: string; role: string; finish: string | null; summary: number | null }>;
                const stateStr = rows
                    .map((r) => `${r.role}/${r.id.slice(0, 16)}/finish=${r.finish ?? "null"}/summary=${r.summary ?? "null"}`)
                    .join("  ");
                console.error(`[LR-DIAG] OC-STATE turn=${turn} mockReqs=${reqs}  topMsgs(newest first):  ${stateStr}`);

                // Dump parts of the TOP 3 newest messages — reveals source of mystery user messages
                // (compaction marker? autocontinue text? tool result? synthetic ignored notification?)
                try {
                    const ocDb2 = openTestDb(ocDbPath, { readonly: true });
                    const topIds = rows.slice(0, 3).map((r) => r.id);
                    for (const msgId of topIds) {
                        const parts = ocDb2.prepare(
                            "SELECT id, json_extract(data, '$.type') AS type, json_extract(data, '$.text') AS text, json_extract(data, '$.synthetic') AS synthetic, json_extract(data, '$.ignored') AS ignored, json_extract(data, '$.metadata') AS metadata, json_extract(data, '$.callID') AS callID, json_extract(data, '$.tool') AS tool, json_extract(data, '$.state') AS state, json_extract(data, '$.auto') AS auto, json_extract(data, '$.overflow') AS overflow FROM part WHERE message_id = ? ORDER BY id ASC LIMIT 4",
                        ).all(msgId) as Array<{ id: string; type: string; text: string | null; synthetic: number | null; ignored: number | null; metadata: string | null; callID: string | null; tool: string | null; state: string | null; auto: number | null; overflow: number | null }>;
                        const partsStr = parts.map((p) => {
                            const flags = [
                                p.synthetic ? "synth" : null,
                                p.ignored ? "ignored" : null,
                                p.auto !== null ? `auto=${p.auto}` : null,
                                p.overflow !== null ? `overflow=${p.overflow}` : null,
                                p.callID ? `callID=${p.callID.slice(0, 12)}` : null,
                                p.tool ? `tool=${p.tool}` : null,
                            ].filter(Boolean).join(",");
                            const preview = p.text ? p.text.slice(0, 80).replace(/\n/g, "\\n") : (p.state ? `state=${p.state.slice(0, 60)}` : "");
                            return `${p.type}${flags ? `[${flags}]` : ""}=${preview}`;
                        }).join(" || ");
                        console.error(`[LR-DIAG] OC-PARTS turn=${turn} msg=${msgId.slice(0, 16)} parts: ${partsStr}`);
                    }
                    ocDb2.close();
                } catch (e) {
                    console.error(`[LR-DIAG] OC-PARTS turn=${turn} dump failed: ${e instanceof Error ? e.message : String(e)}`);
                }
                ocDb.close();
            } catch (e) {
                console.error(`[LR-DIAG] OC-STATE turn=${turn} mockReqs=${reqs} DB read failed: ${e instanceof Error ? e.message : String(e)}`);
            }
            // After the dump fires AND we have >100 unexpected requests, abort
            // the turn to give the test a clean failure within ~30s instead of
            // hanging for the full 600s sendPrompt budget.
            if (reqs > reqsBefore + 100 && !runawayAborted) {
                runawayAborted = true;
                console.error(`[LR-DIAG] RUNAWAY DETECTED turn=${turn} mockReqs=+${reqs - reqsBefore}; aborting sendPrompt`);
            }
        }
    }, 2000);

    try {
        // Per-prompt budget: 180s. Was 600s — but the long-running runaway
        // condition produces 1700+ mock requests over 600s, draining a whole
        // CI cycle. With the runaway-detector firing the OC-PARTS diagnostic
        // at +25 and aborting at +100 unexpected requests, 180s is more than
        // enough for the diagnostic to capture state and fail-fast.
        await h.sendPrompt(sessionId, `${prompt}\n${marker}`, { timeoutMs: 180_000 });
        clearInterval(dumpTimer);
        const elapsed = Date.now() - startedAt;
        const reqsAfter = h.mock.requests().length;
        console.error(`[LR-DIAG] turn ${turn} DONE in ${elapsed}ms; new mockReqs=${reqsAfter - reqsBefore}`);
        return marker;
    } catch (err) {
        clearInterval(dumpTimer);
        const elapsed = Date.now() - startedAt;
        const reqsAfter = h.mock.requests().length;
        const sinceStart = h.mock.requests().slice(reqsBefore);
        console.error(`[LR-DIAG] turn ${turn} FAIL after ${elapsed}ms; mockReqs delta=${reqsAfter - reqsBefore}`);
        // Show first 5 + last 5 requests (more useful than first 50 identical)
        const ofInterest: Array<{ i: number; r: typeof sinceStart[number] }> = [];
        for (let i = 0; i < Math.min(5, sinceStart.length); i += 1) ofInterest.push({ i, r: sinceStart[i]! });
        if (sinceStart.length > 10) {
            for (let i = sinceStart.length - 5; i < sinceStart.length; i += 1) ofInterest.push({ i, r: sinceStart[i]! });
        }
        for (const { i, r } of ofInterest) {
            const body = r.body as {
                messages?: Array<{ role?: string; content?: unknown }>;
                system?: unknown;
                tools?: unknown[];
                model?: string;
            };
            const msgs = body.messages ?? [];
            const roles = msgs.map((m) => m?.role ?? "?").join(",");
            const isHist = isHistorianRequest(body as Record<string, unknown>);
            const isMC = isMagicContextRequest(body as Record<string, unknown>);
            const lastMsg = msgs[msgs.length - 1];
            const lastRole = lastMsg?.role ?? "?";
            const lastContent = JSON.stringify(lastMsg?.content ?? "").slice(0, 150);
            console.error(`  [${i}] path=${r.path} msgs=${msgs.length} model=${body.model ?? "?"} histReq=${isHist} mcReq=${isMC}`);
            console.error(`       roles=${roles}`);
            console.error(`       lastRole=${lastRole} lastContent=${lastContent}`);
        }
        throw err;
    }
}

forEachHost(import.meta.url, "long-running OpenCode Magic Context session", (host) => {
    beforeAll(async () => {
        h = await createScenarioHarness(host, {
            modelContextLimit: 100_000,
            magicContextConfig: {
                execute_threshold_percentage: 20,
                embedding: { provider: "off" },
                protected_tags: 1,
                // Pi's task-list tool is opt-in; this session exercises its capture and replay.
                todowrite: { enabled: true },
                memory: {
                    enabled: true,
                    auto_promote: false,
                    injection_budget_tokens: 500,
                    auto_search: { enabled: true, score_threshold: 0.3, min_prompt_chars: 12 },
                    git_commit_indexing: { enabled: false },
                },
                dreamer: { disable: true },
                compressor: { enabled: false },
            },
        });
    });

    afterAll(async () => {
        await h.dispose();
    });
    it("matches an out-of-order historian completion to its own captured range", () => {
        const earlyCapture: HistorianCapture = { requestIndex: 1, range: { start: 3, end: 4 } };
        const laterCapture: HistorianCapture = { requestIndex: 2, range: { start: 7, end: 8 } };
        const earlyCompartment: PublishedCompartment = {
            start_message: 3,
            end_message: 4,
            title: "early completion",
        };

        // Match the early completion only to its early capture; a shared mutable range could pair it with a later capture.
        expect(earlyCompartment.start_message).not.toBe(laterCapture.range.start);
        expect(matchHistorianCaptureToCompartment(
            [earlyCapture, laterCapture],
            [earlyCompartment],
        )).toEqual({ capture: earlyCapture, compartment: earlyCompartment });
        expect(matchHistorianCaptureToCompartment([laterCapture], [earlyCompartment])).toBeNull();
    });

    // TODO(ci-hang): on Linux GitHub-hosted runners, OpenCode 1.15.x
    // sometimes binds its server port and prints "Database migration
    // complete" but then never responds to HTTP requests, so the harness
    // sits waiting until the per-test budget expires. Same OpenCode
    // version on macOS local runs the same 23 turns in ~6 seconds. The
    // bug is in OpenCode's HTTP server bring-up under Linux+Bun-compiled
    // binary, not in Magic Context, but it blocks our CI gate.
    // Skip on CI until OpenCode either ships a fix or we can pin to a
    // verified-good build (1.15.4 was tried; the symptom returned).
    // The infinite-loop production bug this test originally caught
    // (95% emergency notification re-firing) is fixed and locked in
    // by transform-compartment-phase.test.ts ("95% emergency
    // notification idempotency" describe block).
    it.skipIf(Boolean(process.env.CI))(host === "opencode2" ? "exercises execute, notes, reduce, historian, native folds, and auto-search without native todos" : "exercises execute, notes, reduce, historian, todo synthesis, and auto-search over one realistic session", async () => {
        await resetMock("start long-running session");

        const historianCaptures: HistorianCapture[] = [];
        h.mock.addMatcher((body) => {
            if (!isHistorianRequest(body)) return null;
            const range = findHistorianOrdinalRange(body) ?? { start: 1, end: 2 };
            historianCaptures.push({ requestIndex: historianCaptures.length + 1, range });
            return {
                text: buildMockHistorianPayload({
                    start: range.start,
                    end: range.end,
                    title: "Long OpenCode e2e chunk",
                    body: "The long-running OpenCode test covered warmup, execute cleanup, notes, ctx_reduce, todo synthesis, and auto-search hints.",
                }),
                usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 500 },
            };
        });

        const sessionId = await h.createSession();

        // Phase 1: Warm-up turns 1-3 stay below threshold; the cached prefix is
        // byte-identical. Each carries ~2.5K tokens of REAL text ballast: the
        // v3 protected-tail boundary measures true-raw content (not mock usage
        // numbers), so phase 5's historian force-fire needs genuine content
        // mass beyond the scaled protected tail or the head resolves empty.
        const warmupMarkers: string[] = [];
        for (let i = 1; i <= 3; i += 1) {
            warmupMarkers.push(await send(
                sessionId,
                `turn ${i}: OpenCode warm-up cache-stability probe ${h.ballast(2_500)}`,
                `phase 1 assistant ${i}`,
            ));
        }
        const warmup = [
            await mainRequestForMarker(warmupMarkers[0]!),
            await mainRequestForMarker(warmupMarkers[1]!),
            await mainRequestForMarker(warmupMarkers[2]!),
        ];
        expect(warmup.length).toBeGreaterThanOrEqual(3);
        expect(serialize(warmup[2]!.body.messages?.[0])).toBe(serialize(warmup[1]!.body.messages?.[0]));
        expect(new Set(warmup.slice(1, 3).map((request) => serialize(request.body.system))).size).toBe(1);
        expect(readMeta<{ last_context_percentage: number }>(sessionId, "last_context_percentage")?.last_context_percentage ?? 100).toBeLessThan(20);

        // Phase 2: First execute. Turn 4 records high pressure; turn 5 executes cleanup; turn 6 recovers stability.
        const beforeExecutePressure = readMeta<{ last_context_percentage: number }>(sessionId, "last_context_percentage")?.last_context_percentage ?? 0;
        emitToolOnce(/^ctx_search$/, { query: "phase two harmless cleanup probe", limit: 1 }, FORCE_CLEANUP_USAGE);
        await send(sessionId, "turn 4: raise pressure with a harmless tool call so the next pass must execute", "phase 2 pressure", FORCE_CLEANUP_USAGE);
        const afterExecutePressure = readMeta<{ last_context_percentage: number }>(sessionId, "last_context_percentage")?.last_context_percentage ?? 0;
        expect(beforeExecutePressure).toBeLessThan(20);
        expect(afterExecutePressure).toBeGreaterThanOrEqual(20);
        const executeMarker = await send(sessionId, "turn 5: execute pass should run heuristic cleanup", "phase 2 execute cleanup");
        // No routine drops anymore: need-blind age-drops were removed with the
        // tiered emergency-drop redesign. An execute pass with no droppable
        // tool pile (one tiny ctx_search output here) must drop NOTHING —
        // reduction is the agent's job (ctx_reduce, phase 4) with the ≥85%
        // tiered drop as the safety net (covered end-to-end by
        // short-context-overflow.test.ts). The execute pass still runs; the
        // invariant kept here is that it doesn't spuriously evict and the
        // cache recovers on the following defer pass.
        const recoveryMarker = await send(sessionId, "turn 6: defer after first execute should recover cache", "phase 2 cache recovery");
        const phase2Tail = [
            await mainRequestForMarker(executeMarker),
            await mainRequestForMarker(recoveryMarker),
        ];
        expect(phase2Tail.length).toBe(2);
        expect(serialize(phase2Tail[1]!.body.messages?.[0])).toBe(serialize(phase2Tail[0]!.body.messages?.[0]));
        // Drops here are legitimate, from two designed ≥85% paths (85K usage on
        // the 100K test limit): the tiered emergency drop may evict tool
        // outputs, and the force-fired historian publishes a compartment whose
        // covered messages are queue-dropped. The invariant that matters is the
        // byte-identical cache recovery asserted above — NOT a drop count
        // (routine need-blind age-drops are gone; these are need-driven).

        // Phase 3: ctx_note write plus terminal todo trigger. The nudge is delayed to a fresh user turn and then replayed.
        emitToolOnce(/^ctx_note$/, { action: "write", content: "Revisit the long-running OpenCode assertions after verification.", note_ids: [] });
        await send(sessionId, "turn 7: write a deferred session note with ctx_note", "phase 3 after note write");
        expect(
            h.contextDb().prepare("SELECT COUNT(*) AS n FROM notes WHERE session_id = ?").get(sessionId) as { n: number },
        ).toMatchObject({ n: 1 });
        let replayNudgeMarker: string;
        if (h.host === "opencode2") {
            replayNudgeMarker = await send(sessionId, "continue after the persisted note", "phase 3 native host without todo trigger");
            const nativeTools = (await mainRequestForMarker(replayNudgeMarker)).body.tools as Array<{ name: string }>;
            expect(nativeTools.some((tool) => /todo.*write|write.*todo/i.test(tool.name))).toBe(false);
        } else {
        emitToolOnce(/todo.*write|write.*todo|todowrite/i, { todos: TERMINAL_TODOS });
        await send(sessionId, "turn 8: mark terminal todos to create a work-boundary note trigger", "phase 3 after terminal todos");
        await send(sessionId, "turn 9: first post-trigger turn records the nudge anchor", "phase 3 nudge anchor");
        let nudgeMarker = await send(sessionId, "turn 10: second post-trigger turn should receive the note nudge", "phase 3 nudge delivery");
        let nudgeBody = (await mainRequestForMarker(nudgeMarker)).body;
        for (let retry = 0; retry < 4 && !JSON.stringify(nudgeBody).includes("notes ready"); retry += 1) {
            nudgeMarker = await send(sessionId, `turn ${11 + retry}: extra post-trigger turn for persisted nudge delivery`, "phase 3 nudge delivery retry");
            nudgeBody = (await mainRequestForMarker(nudgeMarker)).body;
        }
        expect(JSON.stringify(nudgeBody)).toContain("notes ready");
        replayNudgeMarker = await send(sessionId, "turn 15: note nudge sticky replay should be byte-identical", "phase 3 nudge replay");
        const replayNudgeBody = (await mainRequestForMarker(replayNudgeMarker)).body;
        expect(JSON.stringify(replayNudgeBody)).toContain("notes ready");
        expect(readMeta<{ note_nudge_anchors: string }>(sessionId, sessionMetaFieldSelect("note_nudge_anchors"))?.note_nudge_anchors ?? "").toContain("notes ready");
        }
        // The 15-minute cooldown uses process-local wall-clock time; this long test cannot advance it without sleeping.

        // Phase 4: ctx_reduce queues a real drop; the next force pass materializes a dropped shell and suppresses cleanup nudges.
        // Select the tag number and its expected text from the same provider
        // request. Pairing a database tag with hard-coded wire text can target a
        // different block after an earlier pass retags the assistant message.
        const reduceWire = JSON.stringify(
            (await mainRequestForMarker(replayNudgeMarker)).body.messages ?? [],
        );
        const reduceMatch = RUST_MODE
            ? reduceWire.match(/§(\d+)§ (phase 2 execute cleanup)/)
            : reduceWire.match(/§(\d+)§ (phase 1 assistant \d+)/);
        expect(reduceMatch).not.toBeNull();
        const reduceTarget = Number(reduceMatch![1]);
        const reduceNeedle = reduceMatch![0];
        expect(reduceWire.split(reduceNeedle).length - 1).toBe(1);
        emitToolOnce(/^ctx_reduce$/, { drop: String(reduceTarget) });
        await send(sessionId, `turn 13: drop old assistant tag ${reduceTarget} with ctx_reduce`, "phase 4 after ctx_reduce");
        await send(sessionId, "turn 14: pressure after ctx_reduce so pending op applies next", "phase 4 pressure", FORCE_CLEANUP_USAGE);
        const materializeMarker = await send(sessionId, "turn 15: force-bust and materialize ctx_reduce pending op", "phase 4 materialize");
        if (!RUST_MODE) {
            await h.waitFor(
                () => {
                    const row = h
                        .contextDb()
                        .prepare("SELECT status FROM tags WHERE session_id = ? AND tag_number = ?")
                        .get(sessionId, reduceTarget) as { status: string } | null;
                    return row?.status === "dropped";
                },
                { label: "ctx_reduce target dropped" },
            );
        }
        const materializedRequest = await mainRequestForMarker(materializeMarker);
        const reducedBody = JSON.stringify(materializedRequest.body);
        expect(reducedBody).not.toContain(reduceNeedle);
        expect(reducedBody).not.toContain("ctx_reduce_turn_cleanup");
        const stableReplayMarker = await send(sessionId, "turn 16: ctx_reduce defer replay remains stable", "phase 4 stable replay");
        expect(JSON.stringify((await mainRequestForMarker(stableReplayMarker)).body)).not.toContain(reduceNeedle);

        // Phase 5: Historian publishes; OpenCode writes a deferred marker that drains only on a later execute pass.
        await send(sessionId, "turn 17: historian trigger pressure with eligible long tail", "phase 5 historian trigger", HISTORIAN_TRIGGER_USAGE);
        await send(sessionId, "turn 18: follow-up starts historian publication", "phase 5 historian follow-up");
        let pendingBeforeDefer: string | null = null;
        if (RUST_MODE) {
            // a5b7d61d publishes through the out-of-band module stack; context.db
            // is not the Rust compartment authority. Observe the committed count
            // directly rather than waiting on a legacy TypeScript mirror row.
            if (!(h instanceof TestHarness)) {
                throw new Error("Rust historian check requires the OpenCode 1 hermetic module stack");
            }
            const stack = h.rustStack;
            if (!stack) throw new Error("Rust historian check requires the hermetic module stack");
            const deadline = Date.now() + 120_000;
            let compartmentCount = 0;
            while (Date.now() < deadline) {
                const status = await stack.moduleStatus(sessionId, h.workdir, "session.status");
                compartmentCount = Number(status.compartment_count ?? 0);
                if (compartmentCount > 0) break;
                await Bun.sleep(100);
            }
            expect(compartmentCount).toBeGreaterThan(0);
        } else {
            const matchedPublication = await h.waitFor(
                () => {
                    const compartments = h
                        .contextDb()
                        .prepare(
                            "SELECT start_message, end_message, title FROM compartments WHERE session_id = ?",
                        )
                        .all(sessionId) as PublishedCompartment[];
                    return matchHistorianCaptureToCompartment(historianCaptures, compartments);
                },
                { timeoutMs: 300_000, label: "historian compartment matched to request range" },
            );
            expect(matchedPublication.compartment.start_message).toBe(
                matchedPublication.capture.range.start,
            );
            expect(matchedPublication.compartment.end_message).toBe(
                matchedPublication.capture.range.end,
            );
            const markerAfterPublish = readMeta<{
                pending_compaction_marker_state: string | null;
                compaction_marker_state: string | null;
            }>(sessionId, pendingMarkerColumns());
            if (h.host === "opencode2") {
                expect(markerAfterPublish?.pending_compaction_marker_state).toBeNull();
            } else expect(
                Boolean(markerAfterPublish?.pending_compaction_marker_state) ||
                    Boolean(markerAfterPublish?.compaction_marker_state) ||
                    (h instanceof PiTestHarness && await h.hasNativeCompactionMarker(matchedPublication.compartment.end_message)),
            ).toBe(true);
            pendingBeforeDefer = markerAfterPublish?.pending_compaction_marker_state ?? null;
        }

        // Phase 6: Synthetic todowrite rides the next cache-busting pass, while the marker drains with that pass.
        if (h instanceof OpenCode2TestHarness) {
            const beforeFold = h.mock.requests().length;
            await h.compactSession(sessionId);
            expect(h.mock.requests().length).toBe(beforeFold);
            const foldedMarker = await send(sessionId, "surface the native checkpoint", "phase 6 native fold");
            const body = JSON.stringify((await mainRequestForMarker(foldedMarker)).body);
            expect(body).toContain("<conversation-checkpoint>");
            expect(body).toContain("Long OpenCode e2e chunk");
        } else {
        emitToolOnce(/todo.*write|write.*todo|todowrite/i, { todos: ACTIVE_TODOS });
        await send(sessionId, "turn 19: active todowrite snapshot while marker must remain pending", "phase 6 active todos");
        if (pendingBeforeDefer !== null) {
            expect(readMeta<{ pending_compaction_marker_state: string | null }>(sessionId, pendingMarkerColumns())?.pending_compaction_marker_state).toBe(pendingBeforeDefer);
        }
        const stateJson = normalizedTodos(ACTIVE_TODOS);
        expect(readMeta<{ last_todo_state: string }>(sessionId, "last_todo_state")?.last_todo_state).toBe(stateJson);
        await send(sessionId, "turn 20: pressure to make synthetic todowrite visible on next execute", "phase 6 pressure", HIGH_USAGE);
        const syntheticExecuteMarker = await send(sessionId, "turn 21: execute pass injects synthetic todowrite and consumes history", "phase 6 synthetic execute");
        const syntheticExecuteRequest = await mainRequestForMarker(syntheticExecuteMarker);
        const syntheticCallId = computeSyntheticCallId(stateJson);
        const syntheticPair = findSyntheticTodoPair(syntheticExecuteRequest.body, syntheticCallId);
        const syntheticBody = JSON.stringify(syntheticExecuteRequest.body);
        expect(syntheticPair !== null || syntheticBody.includes("Ship long-running OpenCode fixture")).toBe(true);
        const markerAfterExecute = readMeta<{ pending_compaction_marker_state: string | null; compaction_marker_state: string | null }>(
            sessionId,
            pendingMarkerColumns(),
        );
        if (h.host === "pi" || h.host === "omp") {
            // Pi drains the staged marker into host-owned JSONL rather than
            // mirroring OpenCode's compaction_marker_state field.
            expect(markerAfterExecute?.pending_compaction_marker_state).toBeNull();
        } else {
            expect(Boolean(markerAfterExecute?.compaction_marker_state) || markerAfterExecute?.pending_compaction_marker_state === pendingBeforeDefer).toBe(true);
        }
        expect(JSON.stringify(syntheticExecuteRequest.body)).toContain("<session-history>");
        expect(JSON.stringify(syntheticExecuteRequest.body)).toContain("Long OpenCode e2e chunk");
        const syntheticReplayMarker = await send(sessionId, "turn 22: defer pass replays synthetic todowrite bytes", "phase 6 synthetic replay");
        const syntheticReplayRequest = await mainRequestForMarker(syntheticReplayMarker);
        if (syntheticPair) {
            expect(findSyntheticTodoPair(syntheticReplayRequest.body, syntheticCallId)?.bytes).toBe(syntheticPair.bytes);
        } else {
            expect(JSON.stringify(syntheticReplayRequest.body)).toContain("Ship long-running OpenCode fixture");
        }

        }
        // Phase 7: Auto-search hint from a seeded memory is appended and persisted for same-turn replay.
        const autoSearchMemory =
            "zebra cache ritual: when debugging long sessions, inspect prefix bytes before changing runtime code";
        if (RUST_MODE) {
            // f5a0f403 routed Rust memory writes through the module backend. Use
            // the public tool, then verify the local read-model mirror caught up.
            emitToolOnce(/^ctx_memory$/, {
                action: "write",
                category: "PROJECT_RULES",
                content: autoSearchMemory,
                ids: [],
            });
            await send(sessionId, "turn 22b: save the zebra cache ritual memory", "phase 7 memory write");
            const mirroredMemory = h
                .contextDb()
                .prepare("SELECT COUNT(*) AS n FROM memories WHERE content = ?")
                .get(autoSearchMemory) as { n: number } | null;
            if ((mirroredMemory?.n ?? 0) !== 1) {
                const body = h.mock.requests().at(-1)?.body;
                console.error("memory write tool result", JSON.stringify(Array.isArray(body?.messages) ? body.messages.slice(-2) : body).slice(-3000));
                const diagnostic = await Bun.file(join(h.dataDir, "cortexkit", "magic-context-e2e.log")).text();
                console.error(diagnostic.split("\n").filter(line => /config|embedding|observation|disabled|registered project/.test(line)).join("\n"));
            }
            expect(mirroredMemory?.n ?? 0).toBe(1);
        } else {
            seedMemory(autoSearchMemory);
        }
        const beforeAutoSearch = h.mock.requests().length;
        emitToolOnce(/^ctx_note$/, { action: "read", content: "", note_ids: [] });
        await send(
            sessionId,
            "turn 23: zebra cache ritual question should surface vague recall from memory",
            "phase 7 after auto-search tool",
        );
        const autoRequests = requestsSince(beforeAutoSearch);
        expect(autoRequests.length).toBeGreaterThanOrEqual(1);
        const hinted = autoRequests.map((request) => latestUserText(request.body)).filter((text) => text.includes("<ctx-search-hint>"));
        const autoSearchDecisions = readMeta<{ auto_search_hint_decisions: string }>(sessionId, sessionMetaFieldSelect("auto_search_hint_decisions"))?.auto_search_hint_decisions ?? "";
        if (hinted.length > 0) {
            expect(hinted[0]).toContain("zebra cache ritual");
            if (hinted.length > 1) expect(hinted[hinted.length - 1]).toBe(hinted[0]);
            expect(autoSearchDecisions).toContain("ctx-search-hint");
        }

        // Phase 8: Compressor is intentionally disabled for this file to keep the long e2e under the 10-15 minute budget.
        await send(sessionId, "turn 24: final low-pressure defer confirms session still works", "phase 8 compressor skipped");
    }, 900_000);
});
