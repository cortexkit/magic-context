/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { buildSegments, findBusts } from "../src/cache-analysis";
import { TestHarness } from "../src/harness";
import { buildMockHistorianPayload, findHistorianOrdinalRange } from "../src/mock-historian";

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
 *
 * The turns between Magic Context's boundary and the host's retained tail are in no
 * compartment and no longer loaded by the host. Magic Context reads them back from
 * the host's store and serves them raw, in place of the compaction request, until
 * the historian covers them; the restored range replays byte-identically on the
 * passes after it, across a restart too.
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

beforeAll(async () => {
    h = await TestHarness.create({
        magicContextConfig: { execute_threshold_percentage: 40 },
        // Keep only the newest turn after the summary, so the stored boundary sits
        // before the host window (a large session's usual shape). A retained tail
        // that reaches back past the boundary lets the trim cut the summary rows.
        openCodeConfigExtra: { compaction: { auto: false, prune: false, tail_turns: 1 } },
    });
});

afterAll(async () => {
    await h.dispose();
});

function readBaseline(sessionId: string): {
    boundary: string | null;
    hasM0: boolean;
    materializedAt: number;
} {
    const row = h
        .contextDb()
        .prepare(
            "SELECT cached_m0_last_baseline_end_message_id AS boundary, cached_m0_bytes IS NOT NULL AS has_m0, cached_m0_materialized_at AS at FROM session_meta WHERE session_id = ?",
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

function latestCompartmentEnd(sessionId: string): string | null {
    const row = h
        .contextDb()
        .prepare(
            "SELECT end_message_id AS id FROM compartments WHERE session_id = ? ORDER BY sequence DESC LIMIT 1",
        )
        .get(sessionId) as { id: string | null } | null;
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

/**
 * Every OpenCode or Magic Context store the OpenCode process holds open must live
 * under the harness data dir. (The embedding runtime also opens its own telemetry
 * database under the user's Library; that is neither store and is not checked.)
 */
function assertOpenDatabasesAreThrowaway(): void {
    const result = spawnSync("lsof", ["-p", String(h.opencode.pid), "-Fn"], {
        encoding: "utf8",
    });
    const dataDir = realpathSync(h.dataDir);
    const databases = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("n") && /\.db(-wal|-shm)?$/.test(line))
        .map((line) => line.slice(1))
        .filter((path) => /opencode|cortexkit|magic-context|context\.db/.test(path));
    expect(databases.some((path) => path.endsWith("opencode.db"))).toBe(true);
    expect(databases.some((path) => path.endsWith("context.db"))).toBe(true);
    // The macOS network stack keeps its own URL cache per executable name
    // (~/Library/Caches/opencode/Cache.db). It is neither an OpenCode nor a Magic
    // Context store, and the child's environment cannot move it.
    const outside = databases.filter(
        (path) =>
            !realpathSync(path).startsWith(dataDir) &&
            !/\/Library\/Caches\/opencode\/Cache\.db(-wal|-shm)?$/.test(path),
    );
    expect(outside).toEqual([]);
}

function openCodeStore(): Database {
    return new Database(join(h.dataDir, "opencode", "opencode.db"), { readonly: true });
}

/** The newest native compaction request of a session and the retained tail it names. */
function compactionRequest(sessionId: string): { id: string; tailStartId: string } | null {
    const db = openCodeStore();
    try {
        const row = db
            .prepare(
                `SELECT message_id AS id, json_extract(data, '$.tail_start_id') AS tail FROM part
                  WHERE session_id = ? AND json_extract(data, '$.type') = 'compaction'
                  ORDER BY time_created DESC, id DESC LIMIT 1`,
            )
            .get(sessionId) as { id: string; tail: string | null } | null;
        return row && typeof row.tail === "string" ? { id: row.id, tailStartId: row.tail } : null;
    } finally {
        db.close();
    }
}

/** Each user row's `turn N:` label, in stored order, with its row id. */
function userTurnLabels(sessionId: string): Array<{ id: string; label: string }> {
    const db = openCodeStore();
    try {
        const rows = db
            .prepare(
                `SELECT m.id AS id, p.data AS part FROM message m
                   JOIN part p ON p.message_id = m.id
                  WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user'
                    AND json_extract(p.data, '$.type') = 'text'
                  ORDER BY m.time_created ASC, m.id ASC, p.id ASC`,
            )
            .all(sessionId) as Array<{ id: string; part: string }>;
        const labels: Array<{ id: string; label: string }> = [];
        for (const row of rows) {
            const text = (JSON.parse(row.part) as { text?: string }).text ?? "";
            const label = /^turn \d+:/.exec(text)?.[0];
            if (label && !labels.some((entry) => entry.id === row.id)) {
                labels.push({ id: row.id, label });
            }
        }
        return labels;
    } finally {
        db.close();
    }
}

/**
 * The turns a compaction hid: user turns strictly after `boundaryId` and strictly
 * before the retained tail's first row.
 */
function hiddenTurns(sessionId: string, boundaryId: string, tailStartId: string): string[] {
    const labels = userTurnLabels(sessionId);
    const ids = labels.map((entry) => entry.id);
    const all = ((): string[] => {
        const db = openCodeStore();
        try {
            return (
                db
                    .prepare(
                        "SELECT id FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
                    )
                    .all(sessionId) as Array<{ id: string }>
            ).map((row) => row.id);
        } finally {
            db.close();
        }
    })();
    const lower = all.indexOf(boundaryId);
    const upper = all.indexOf(tailStartId);
    expect(lower).toBeGreaterThan(-1);
    expect(upper).toBeGreaterThan(-1);
    return labels
        .filter((entry) => {
            const at = all.indexOf(entry.id);
            return at > lower && at < upper && ids.includes(entry.id);
        })
        .map((entry) => entry.label);
}

function labelFor(sessionId: string, messageId: string): string {
    const label = userTurnLabels(sessionId).find((entry) => entry.id === messageId)?.label;
    expect(label).toBeDefined();
    return label as string;
}

function mainRequests(): Array<{ body: Record<string, unknown> }> {
    return h.requests().filter((request) => !isHistorianRequest(request.body));
}

function requestContaining(text: string): { body: Record<string, unknown> } {
    const request = mainRequests().find((candidate) => JSON.stringify(candidate.body).includes(text));
    expect(request).toBeDefined();
    return request as { body: Record<string, unknown> };
}

/**
 * sha256 over a request's cacheable prefix: every wire segment (system blocks, then
 * messages, `cache_control` markers and the billing nonce normalised out) up to and
 * including the last cache breakpoint of `reference`.
 */
function cachedPrefixSha(
    body: Record<string, unknown>,
    reference: Record<string, unknown>,
): { sha: string; segments: number } {
    const referenceSegments = buildSegments(reference);
    let last = -1;
    referenceSegments.forEach((segment, index) => {
        if (segment.breakpoint) last = index;
    });
    expect(last).toBeGreaterThan(0);
    const segments = buildSegments(body).slice(0, last + 1);
    const hash = createHash("sha256");
    for (const segment of segments) hash.update(`${segment.id}:${segment.hash}\n`);
    return { sha: hash.digest("hex"), segments: segments.length };
}

/**
 * The provider content blocks from the one carrying `fromLabel` up to (not including)
 * the message carrying `toLabel`, with `cache_control` markers removed. Blocks, not
 * messages: the provider merges adjacent user messages, so the history head can share
 * a message with the first restored turn.
 */
function wireSlice(body: Record<string, unknown>, fromLabel: string, toLabel: string): string[] {
    const blocks: string[] = [];
    let started = false;
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
        const { role, content } = message as { role: string; content: unknown };
        const parts = Array.isArray(content) ? content : [{ type: "text", text: content }];
        const serialized = parts.map((part) =>
            JSON.stringify(part, (key, value) => (key === "cache_control" ? undefined : value)),
        );
        if (started && serialized.some((part) => part.includes(toLabel))) return blocks;
        for (const part of serialized) {
            if (!started && part.includes(fromLabel)) started = true;
            if (started) blocks.push(`${role}:${part}`);
        }
    }
    expect({ fromLabel, toLabel, closed: false }).toEqual({ fromLabel, toLabel, closed: true });
    return blocks;
}

/** Every label present in `served`, in the given order. */
function expectInOrder(served: string, labels: string[]): void {
    let cursor = -1;
    for (const label of labels) {
        const at = served.indexOf(label, cursor + 1);
        expect({ label, found: at > cursor }).toEqual({ label, found: true });
        cursor = at;
    }
}

function installMocks(): void {
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
}

function compartmentsSettled(sessionId: string, atLeast: number): boolean {
    const row = h
        .contextDb()
        .prepare(
            "SELECT (SELECT COUNT(*) FROM compartments WHERE session_id = ?) AS c, compartment_in_progress AS busy FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId, sessionId) as { c: number; busy: number } | null;
    return (row?.c ?? 0) >= atLeast && row?.busy === 0;
}

function compartmentCount(sessionId: string): number {
    const row = h
        .contextDb()
        .prepare("SELECT COUNT(*) AS c FROM compartments WHERE session_id = ?")
        .get(sessionId) as { c: number } | null;
    return row?.c ?? 0;
}

/**
 * Build a session whose history the historian has summarised and whose served
 * request carries that history, then run OpenCode's own `/compact` on it.
 */
async function compactedSession(): Promise<{
    sessionId: string;
    hashBeforeCompaction: string;
    logOffsetBeforeCompaction: number;
}> {
    installMocks();
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
    await h.waitFor(() => compartmentsSettled(sessionId, 1), {
        timeoutMs: 60_000,
        label: "compartment published",
    });

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
    expect(mainRequestBodies().at(-1)).toContain(HISTORY_SENTINEL);

    // Native compaction. The mock answers the summary request.
    h.mock.setDefault(smallUsage(HOST_SUMMARY_SENTINEL));
    await h.waitForMockQuiescence({ label: "quiet before compaction" });
    const hashBeforeCompaction = readSystemHash(sessionId);
    expect(hashBeforeCompaction).not.toBe("");
    const logOffsetBeforeCompaction = pluginLog().length;
    await h.compactSession(sessionId);
    await h.waitForMockQuiescence({ label: "quiet after compaction" });
    return { sessionId, hashBeforeCompaction, logOffsetBeforeCompaction };
}

it(
    "re-anchors the baseline once and restores the hidden turns on the first pass after /compact",
    async () => {
        const { sessionId, hashBeforeCompaction, logOffsetBeforeCompaction } =
            await compactedSession();

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
        const passA = requestContaining(AFTER_COMPACTION_PROMPT);
        const first = JSON.stringify(passA.body);

        // The first pass after the compaction folded: the cached baseline is newer
        // than the host summary, and its boundary is the latest compartment end.
        const summary = hostSummaryRow(sessionId);
        expect(summary).not.toBeNull();
        const after = readBaseline(sessionId);
        expect(after.hasM0).toBe(true);
        expect(after.materializedAt).toBeGreaterThan(summary?.completedAt ?? Number.POSITIVE_INFINITY);
        expect(after.boundary).toBe(latestCompartmentEnd(sessionId));

        // Which history is rendered does not change: the compartments stay in m[0]
        // and the host summary row is still left off the wire.
        expect(first).toContain(HISTORY_SENTINEL);
        expect(first).not.toContain(HOST_SUMMARY_SENTINEL);
        // The real turn's system prompt is handled as usual: it still carries Magic
        // Context's guidance, so recognising the compaction request did not swallow
        // the next system-prompt hook call.
        expect(first).toContain("## Magic Context");

        // The transform recognised the host's own compaction pair at the window head.
        expect(pluginLog()).toContain(
            `native host compaction heads the window (request ${summary?.parentId}, summary ${summary?.id},`,
        );

        // The turns between the Magic Context boundary and the host's retained tail
        // are served raw, in stored order, after the history head and before the
        // retained turn; the compaction request (which only asks for a summary) is not.
        const request = compactionRequest(sessionId);
        expect(request).not.toBeNull();
        expect(request?.id).toBe(summary?.parentId);
        const hidden = hiddenTurns(sessionId, after.boundary as string, request?.tailStartId as string);
        expect(hidden.length).toBeGreaterThan(0);
        const retained = labelFor(sessionId, request?.tailStartId as string);
        expectInOrder(first, [HISTORY_SENTINEL, ...hidden, retained, AFTER_COMPACTION_PROMPT]);
        // The restored turns go on the wire exactly as the host served them before
        // the compaction: same messages, same bytes (cache markers aside).
        const beforeCompactionRequest = mainRequests()
            .filter((candidate) => !JSON.stringify(candidate.body).includes("context summarization agent"))
            .filter((candidate) => JSON.stringify(candidate.body).includes(retained))
            .find((candidate) => !JSON.stringify(candidate.body).includes(AFTER_COMPACTION_PROMPT));
        expect(beforeCompactionRequest).toBeDefined();
        expect(wireSlice(passA.body, hidden[0] as string, retained)).toEqual(
            wireSlice(beforeCompactionRequest?.body ?? {}, hidden[0] as string, retained),
        );
        expect(first).not.toContain("What did we do so far?");

        // Exactly one fold after the compaction: the next pass replays it.
        const secondPrompt = "second prompt after the native compaction";
        await h.sendPrompt(sessionId, secondPrompt);
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

        // The defer pass after the first post-compaction pass keeps the cached prefix
        // byte-identical, restored turns included.
        const passB = requestContaining(secondPrompt);
        expect(findBusts([passA, passB])).toEqual([]);
        expect(cachedPrefixSha(passB.body, passA.body)).toEqual(
            cachedPrefixSha(passA.body, passA.body),
        );
        expectInOrder(JSON.stringify(passB.body), [HISTORY_SENTINEL, ...hidden, retained]);

        // The compaction marked the historian due for the rows it hid.
        expect(pluginLog().slice(logOffsetBeforeCompaction)).toContain(
            "historian marked due to cover the rows the compaction hid",
        );

        // Once the historian publishes over the hidden turns, a pass that rebuilds the
        // prefix serves them as history and no longer raw. Newer turns push the hidden
        // ones out of the protected tail; executing passes let the historian run and
        // then fold what it published.
        const compartmentsBefore = compartmentCount(sessionId);
        h.mock.setDefault(bigUsage("big"));
        for (let turn = 1; turn <= 6; turn++) {
            await h.sendPrompt(
                sessionId,
                `catch-up ${turn}: newer work after the compaction. ${h.ballast(3_000)}`,
            );
        }
        await h.waitFor(() => compartmentsSettled(sessionId, compartmentsBefore + 1), {
            timeoutMs: 90_000,
            label: "compartment published over the hidden turns",
        });
        let latest = "";
        for (let turn = 1; turn <= 4; turn++) {
            await h.sendPrompt(sessionId, `settle ${turn}: executing follow-up.`);
            latest = mainRequestBodies().at(-1) ?? "";
            if (hidden.every((label) => !latest.includes(label))) break;
        }
        for (const label of hidden) expect(latest).not.toContain(label);
        // The compartment published over the hidden turns is rendered with the rest of
        // the history.
        const sentinels = (body: string) => body.split(HISTORY_SENTINEL).length - 1;
        expect(sentinels(latest)).toBeGreaterThan(sentinels(first));

        assertOpenDatabasesAreThrowaway();
    },
    420_000,
);

it(
    "replays the restored turns byte-identically across a restart after the first pass",
    async () => {
        const { sessionId } = await compactedSession();

        h.mock.setDefault(smallUsage("after-compaction"));
        const promptA = "restart variant: first prompt after the native compaction";
        await h.sendPrompt(sessionId, promptA);
        const passA = requestContaining(promptA);
        const request = compactionRequest(sessionId);
        const boundary = readBaseline(sessionId).boundary;
        expect(request).not.toBeNull();
        expect(boundary).not.toBeNull();
        const hidden = hiddenTurns(sessionId, boundary as string, request?.tailStartId as string);
        expect(hidden.length).toBeGreaterThan(0);
        expectInOrder(JSON.stringify(passA.body), [
            HISTORY_SENTINEL,
            ...hidden,
            labelFor(sessionId, request?.tailStartId as string),
            promptA,
        ]);

        // A new process has none of the previous one's kept rows; it rebuilds the
        // range from the persisted boundary and the compaction request alone.
        await h.restart();
        assertOpenDatabasesAreThrowaway();
        const promptB = "restart variant: second prompt after the restart";
        await h.sendPrompt(sessionId, promptB);
        const passB = requestContaining(promptB);
        expect(findBusts([passA, passB])).toEqual([]);
        expect(cachedPrefixSha(passB.body, passA.body)).toEqual(
            cachedPrefixSha(passA.body, passA.body),
        );
    },
    420_000,
);

it(
    "replays the restored turns byte-identically across a restart when the host changed them in between",
    async () => {
        const { sessionId } = await compactedSession();

        h.mock.setDefault(smallUsage("after-compaction"));
        const promptA = "store-change variant: first prompt after the native compaction";
        await h.sendPrompt(sessionId, promptA);
        const passA = requestContaining(promptA);
        const request = compactionRequest(sessionId);
        const boundary = readBaseline(sessionId).boundary;
        const hidden = hiddenTurns(sessionId, boundary as string, request?.tailStartId as string);
        expect(hidden.length).toBeGreaterThan(1);
        const hiddenIds = userTurnLabels(sessionId)
            .filter((entry) => hidden.includes(entry.label))
            .map((entry) => entry.id);

        // Edit the first hidden turn's text and delete the second hidden turn,
        // through the host's own API, while the restored range is being served.
        const store = openCodeStore();
        const part = store
            .prepare(
                "SELECT id, data FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text' ORDER BY id LIMIT 1",
            )
            .get(hiddenIds[0] as string) as { id: string; data: string };
        store.close();
        const edited = await fetch(
            `${h.opencode.url}/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(hiddenIds[0] as string)}/part/${encodeURIComponent(part.id)}`,
            {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    ...(JSON.parse(part.data) as Record<string, unknown>),
                    id: part.id,
                    sessionID: sessionId,
                    messageID: hiddenIds[0],
                    text: "EDITED-HIDDEN-TURN after it was served",
                }),
            },
        );
        expect(edited.ok).toBe(true);
        const removed = await fetch(
            `${h.opencode.url}/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(hiddenIds[1] as string)}`,
            { method: "DELETE" },
        );
        expect(removed.ok).toBe(true);
        await h.waitForMockQuiescence({ label: "quiet after the store change" });

        await h.restart();
        assertOpenDatabasesAreThrowaway();
        const promptB = "store-change variant: first prompt after the restart";
        await h.sendPrompt(sessionId, promptB);
        const passB = requestContaining(promptB);
        expect(findBusts([passA, passB])).toEqual([]);
        expect(cachedPrefixSha(passB.body, passA.body)).toEqual(
            cachedPrefixSha(passA.body, passA.body),
        );
        expect(JSON.stringify(passB.body)).not.toContain("EDITED-HIDDEN-TURN");
    },
    420_000,
);
