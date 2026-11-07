/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import { TestHarness } from "../src/harness";
import { markerWorkerBundleFixture } from "../src/marker-worker-bundle-fixture";
import { buildMockHistorianPayload, findHistorianOrdinalRange } from "../src/mock-historian";
import { assertOpenPaths } from "../src/opencode2-runner/spawn";
import { sessionMetaFieldValueSql } from "../src/session-meta-fields";

/**
 * A native OpenCode compaction (`/compact`) on a Magic Context session.
 *
 * After the compaction the host serves [compaction request, summary, retained
 * tail, new rows] and loads nothing older, so the stored baseline boundary names
 * a row before that window. The first pass after the compaction must re-anchor
 * the baseline (fold, and record the latest compartment end as the boundary)
 * exactly once, without changing which history is rendered.
 *
 * On OpenCode 1.18 the compaction request also runs this session's system-prompt
 * hook with the compaction agent's prompt, so a system-hash fold usually lands on
 * the same pass. The host-compaction trigger does not depend on that.
 */

const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";
const HISTORY_SENTINEL = "HISTORY-SENTINEL-NATIVE-COMPACTION";
const HOST_SUMMARY_SENTINEL = "HOST-SUMMARY-SENTINEL-NATIVE-COMPACTION";
const AFTER_COMPACTION_PROMPT = "first prompt after the native compaction";

function isHistorianRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    if (typeof system === "string") return system.includes(HISTORIAN_SYSTEM_MARKER);
    if (!Array.isArray(system)) return false;
    return system.some((block) => {
        const text = (block as { text?: unknown } | null)?.text;
        return typeof text === "string" && text.includes(HISTORIAN_SYSTEM_MARKER);
    });
}

function smallUsage(text: string) {
    return {
        text,
        usage: {
            input_tokens: 500,
            output_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 500,
        },
    };
}

function bigUsage(text: string) {
    return {
        text,
        usage: {
            input_tokens: 90_000,
            output_tokens: 20,
            cache_creation_input_tokens: 90_000,
            cache_read_input_tokens: 0,
        },
    };
}

let h: TestHarness;
let bundle: ReturnType<typeof markerWorkerBundleFixture>;

beforeAll(async () => {
    bundle = markerWorkerBundleFixture();
    const previousEntry = process.env.MC_E2E_PLUGIN_ENTRY;
    process.env.MC_E2E_PLUGIN_ENTRY = bundle.entry;
    try {
        h = await TestHarness.create({
            magicContextConfig: { execute_threshold_percentage: 40 },
            // Keep only the newest turn after the summary, so the stored boundary sits
            // before the host window (a large session's usual shape). A retained tail
            // that reaches back past the boundary lets the trim cut the summary rows.
            openCodeConfigExtra: { compaction: { auto: false, prune: false, tail_turns: 1 } },
        });
    } finally {
        if (previousEntry === undefined) delete process.env.MC_E2E_PLUGIN_ENTRY;
        else process.env.MC_E2E_PLUGIN_ENTRY = previousEntry;
    }
});

afterAll(async () => {
    await h?.dispose();
    bundle?.dispose();
});

function readBaseline(sessionId: string): {
    boundary: string | null;
    hasM0: boolean;
    materializedAt: number;
} {
    const row = h
        .contextDb()
        .prepare(
            `SELECT cached_m0_last_baseline_end_message_id AS boundary, ${sessionMetaFieldValueSql("cached_m0_bytes")} IS NOT NULL AS has_m0, cached_m0_materialized_at AS at FROM session_meta WHERE session_id = ?`,
        )
        .get(sessionId) as { boundary: string | null; has_m0: number; at: number | null } | null;
    return {
        boundary: row?.boundary ?? null,
        hasM0: row?.has_m0 === 1,
        materializedAt: row?.at ?? 0,
    };
}

function readSystemHash(sessionId: string): string {
    const row = h
        .contextDb()
        .prepare("SELECT system_prompt_hash AS hash FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { hash: string | number | null } | null;
    return row?.hash == null ? "" : String(row.hash);
}

/**
 * The end of the newest compartment published by `at` (ms). The historian keeps
 * running after a fold, so a compartment it publishes later shows in the history
 * delta message (m[1]), not in the folded baseline (m[0]), and must not count
 * against the fold's boundary.
 */
function compartmentEndAt(sessionId: string, at: number): string | null {
    const row = h
        .contextDb()
        .prepare(
            "SELECT end_message_id AS id FROM compartments WHERE session_id = ? AND created_at <= ? ORDER BY sequence DESC LIMIT 1",
        )
        .get(sessionId, at) as { id: string | null } | null;
    return row?.id ?? null;
}

/** The host's own summary row for the newest native compaction, from OpenCode's store. */
function hostSummaryRow(
    sessionId: string,
): { id: string; parentId: string; completedAt: number } | null {
    const db = new Database(join(h.dataDir, "opencode", "opencode.db"), { readonly: true });
    try {
        const row = db
            .prepare(
                `SELECT id, json_extract(data, '$.parentID') AS parent,
                        json_extract(data, '$.time.completed') AS completed FROM message
                  WHERE session_id = ? AND json_extract(data, '$.summary') = 1
                    AND json_extract(data, '$.mode') = 'compaction'
                  ORDER BY time_created DESC, id DESC LIMIT 1`,
            )
            .get(sessionId) as { id: string; parent: string; completed: number | null } | null;
        return row && typeof row.completed === "number"
            ? { id: row.id, parentId: row.parent, completedAt: row.completed }
            : null;
    } finally {
        db.close();
    }
}

function pluginLog(): string {
    return readFileSync(join(h.dataDir, "cortexkit", "magic-context-e2e.log"), "utf8");
}

function mainRequestBodies(): string[] {
    return h
        .requests()
        .filter((request) => !isHistorianRequest(request.body))
        .map((request) => JSON.stringify(request.body));
}

function assertThrowawayDatabasePaths(databases: string[], dataDir: string): void {
    const canonicalData = realpathSync(dataDir);
    const paths = databases.map((path) => realpathSync(path));
    expect(paths.some((path) => path.endsWith("opencode.db") && path.startsWith(`${canonicalData}/`))).toBe(true);
    expect(paths.some((path) => path.endsWith("context.db") && path.startsWith(`${canonicalData}/`))).toBe(true);
    // CFFIXED_USER_HOME puts ONNX telemetry under private HOME, still inside the fixture root.
    const root = realpathSync(dirname(dataDir));
    assertOpenPaths(paths, root);
}

function assertOpenDatabasesAreThrowaway(): void {
    const result = spawnSync("lsof", ["-p", String(h.opencode.pid), "-Fn"], {
        encoding: "utf8",
        windowsHide: true,
    });
    const dataDir = realpathSync(h.dataDir);
    const databases = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("n") && /\.db(-wal|-shm)?$/.test(line))
        .map((line) => line.slice(1));
    assertThrowawayDatabasePaths(databases, dataDir);
}

it("native compaction database fence rejects a database outside the complete throwaway root", () => {
    const fixture = createTestTempDir("native-compaction-fence-");
    try {
        const root = join(fixture.dir, "host");
        const data = join(root, "data");
        mkdirSync(data, { recursive: true });
        const paths = [join(data, "opencode.db"), join(data, "context.db"), join(root, "onnxruntime.db")];
        const outside = join(fixture.dir, "outside.db");
        for (const path of [...paths, outside]) writeFileSync(path, "path-fence fixture");
        expect(() => assertThrowawayDatabasePaths(paths, data)).not.toThrow();
        expect(() => assertThrowawayDatabasePaths([...paths, outside], data)).toThrow("forbidden");
    } finally {
        fixture.cleanup();
    }
});

it(
    "re-anchors the baseline once on the first pass after /compact",
    async () => {
        h.mock.reset();
        h.mock.addMatcher((body) => {
            if (!isHistorianRequest(body)) return null;
            const range = findHistorianOrdinalRange(body);
            const text = range
                ? buildMockHistorianPayload({
                      start: range.start,
                      end: range.end,
                      title: "native compaction chunk",
                      body: `${HISTORY_SENTINEL}: the early turns of this session.`,
                  })
                : "<output><compartments></compartments><facts></facts><unprocessed_from>1</unprocessed_from></output>";
            return {
                text,
                usage: {
                    input_tokens: 500,
                    output_tokens: 200,
                    cache_creation_input_tokens: 500,
                    cache_read_input_tokens: 0,
                },
            };
        });
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
        for (let i = 1; i <= 10; i++) {
            await h.sendPrompt(
                sessionId,
                `turn ${i}: meaningful prompt carrying durable signal for chunk ${i}. ${h.ballast(3_000)}`,
            );
        }
        assertOpenDatabasesAreThrowaway();

        // Cross the execute threshold so the historian runs and later passes
        // fold its compartment into the served history.
        h.mock.setDefault(bigUsage("big"));
        await h.sendPrompt(sessionId, "turn 11: trigger turn with real content.");
        await h.sendPrompt(sessionId, "turn 12: post-trigger follow-up.");
        await h.waitFor(
            () => {
                const row = h
                    .contextDb()
                    .prepare(
                        "SELECT (SELECT COUNT(*) FROM compartments WHERE session_id = ?) AS c, compartment_in_progress AS busy FROM session_meta WHERE session_id = ?",
                    )
                    .get(sessionId, sessionId) as { c: number; busy: number } | null;
                return (row?.c ?? 0) >= 1 && row?.busy === 0;
            },
            { timeoutMs: 60_000, label: "compartment published" },
        );

        // Keep executing until the served request carries the compartment and
        // the baseline records the boundary it covers.
        for (let turn = 13; turn <= 20; turn++) {
            await h.sendPrompt(sessionId, `turn ${turn}: executing follow-up.`);
            const served = mainRequestBodies().at(-1) ?? "";
            if (served.includes(HISTORY_SENTINEL) && readBaseline(sessionId).boundary !== null) {
                break;
            }
        }
        const beforeCompaction = readBaseline(sessionId);
        expect(beforeCompaction.hasM0).toBe(true);
        expect(beforeCompaction.boundary).not.toBeNull();
        expect(mainRequestBodies().at(-1), pluginLog().slice(-40000)).toContain(HISTORY_SENTINEL);

        // Missing marker-candidate discovery must not replace new history with an old request.
        await h.waitFor(() => pluginLog().includes("candidate worker unavailable"), {
            timeoutMs: 5_000, label: "missing marker worker diagnostic",
        });
        expect(pluginLog().match(/\[ERROR\] compaction-marker: candidate worker unavailable/g)).toHaveLength(1);
        expect(pluginLog()).not.toContain("transform refused degraded pass");
        expect(pluginLog()).not.toContain("compaction-marker-drain-failure");
        const markerState = () => h.contextDb().prepare(
            "SELECT NULLIF(compaction_marker_state,'') AS marker, NULLIF(pending_compaction_marker_state,'') AS pending FROM session_meta WHERE session_id=?",
        ).get(sessionId) as { marker: string | null; pending: string | null };
        expect(markerState().marker).toBeNull();
        expect(markerState().pending).not.toBeNull();

        // Put the candidate worker back and require the pending compaction marker to advance
        // while ordinary new prompts continue to write messages to the host store.
        bundle.restoreWorker();
        let rebuildingPasses = 0;
        for (; rebuildingPasses < 4 && markerState().marker === null; rebuildingPasses++) {
            const prompt = `marker recovery rebuilding pass ${rebuildingPasses + 1}`;
            await h.sendPrompt(sessionId, prompt);
            expect(mainRequestBodies().at(-1)).toContain(prompt);
            expect(mainRequestBodies().at(-1)).toContain(HISTORY_SENTINEL);
        }
        expect(markerState().marker, pluginLog().slice(-40000)).not.toBeNull();
        console.log(`marker worker recovery: advanced after ${rebuildingPasses} rebuilding passes with new messages`);

        // Native compaction. The mock answers the summary request.
        h.mock.setDefault(smallUsage(HOST_SUMMARY_SENTINEL));
        await h.waitForMockQuiescence({ label: "quiet before compaction" });
        const hashBeforeCompaction = readSystemHash(sessionId);
        expect(hashBeforeCompaction).not.toBe("");
        const logOffsetBeforeCompaction = pluginLog().length;
        await h.compactSession(sessionId);
        await h.waitForMockQuiescence({ label: "quiet after compaction" });

        // Building the compaction request runs this session's system-prompt hook with
        // the compaction agent's prompt. That prompt must not become the session's
        // stored hash, or the next real pass would see it flip back and fold again.
        expect(readSystemHash(sessionId)).toBe(hashBeforeCompaction);
        const summaryRequest = mainRequestBodies().find((body) =>
            body.includes("context summarization agent"),
        );
        expect(summaryRequest).toBeDefined();
        // The summary still covers Magic Context's history: the compartments ride
        // m[0] in the conversation handed to the compaction agent.
        expect(summaryRequest).toContain(HISTORY_SENTINEL);

        h.mock.setDefault(smallUsage("after-compaction"));
        await h.sendPrompt(sessionId, AFTER_COMPACTION_PROMPT);
        const served = mainRequestBodies().filter((body) => body.includes(AFTER_COMPACTION_PROMPT));
        expect(served.length).toBeGreaterThan(0);
        const first = served[0] as string;

        // The first pass after the compaction folded: the cached baseline is newer
        // than the host summary, and its boundary is the end of the newest
        // compartment that existed when it folded.
        const summary = hostSummaryRow(sessionId);
        expect(summary).not.toBeNull();
        const after = readBaseline(sessionId);
        expect(after.hasM0).toBe(true);
        expect(after.materializedAt).toBeGreaterThan(summary?.completedAt ?? Number.POSITIVE_INFINITY);
        expect(after.boundary, pluginLog().slice(-40000)).toBe(
            compartmentEndAt(sessionId, after.materializedAt),
        );

        // Which history is rendered does not change: the compartments stay in m[0]
        // and the host summary row is still left off the wire.
        expect(first).toContain(HISTORY_SENTINEL);
        expect(first).not.toContain(HOST_SUMMARY_SENTINEL);
        // The real turn's system prompt is handled as usual: it still carries Magic
        // Context's guidance, so recognising the compaction request did not swallow
        // the next system-prompt hook call.
        expect(first).toContain("## Magic Context");

        // The transform recognised the host's own compaction pair at the window head.
        // The plugin buffers log writes for up to half a second, so each log check
        // waits for its line; a missing line still fails on the assertion after it.
        const headLine = `native host compaction heads the window (request ${summary?.parentId}, summary ${summary?.id},`;
        await h.waitFor(() => pluginLog().includes(headLine), { timeoutMs: 5000, label: "host compaction head log line" }).catch(() => undefined);
        expect(pluginLog()).toContain(headLine);

        // Exactly one fold after the compaction: the next pass replays it.
        const logOffsetBeforeSecondPrompt = pluginLog().length;
        await h.sendPrompt(sessionId, "second prompt after the native compaction");
        // A pass's lines are buffered together, so once its scheduler line is on
        // disk the rest of that pass's lines are too.
        const secondPassLogged = () =>
            pluginLog().slice(logOffsetBeforeSecondPrompt).includes(`[magic-context][${sessionId}] transform scheduler:`);
        await h.waitFor(secondPassLogged, { timeoutMs: 5000, label: "second pass scheduler log line" }).catch(() => undefined);
        const lines = pluginLog().split("\n");
        const compactedAt = lines.findIndex((line) => line.includes("compaction-marker: removed on session cleanup"));
        expect(compactedAt).toBeGreaterThan(-1);
        const foldsAfter = lines
            .slice(compactedAt)
            .filter((line) => line.includes(sessionId) && line.includes("rematerialized=true"));
        expect(foldsAfter).toHaveLength(1);

        // Across the compaction request and the passes after it, one HARD fold in
        // total, and it is the host-compaction trigger, not a system-hash flip.
        const foldsSinceCompaction = pluginLog()
            .slice(logOffsetBeforeCompaction)
            .split("\n")
            .filter((line) => line.includes(sessionId) && line.includes("rematerialized=true"));
        expect(foldsSinceCompaction).toHaveLength(1);
        expect(foldsSinceCompaction[0]).toContain("reason=host_compaction");
        expect(readSystemHash(sessionId)).toBe(hashBeforeCompaction);

        assertOpenDatabasesAreThrowaway();
    },
    240_000,
);
