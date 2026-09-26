/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { buildSegments, findBusts, formatBustReport } from "../src/cache-analysis";
import { TestHarness } from "../src/harness";
import { buildMockHistorianPayload, findHistorianOrdinalRange } from "../src/mock-historian";

/**
 * Adversarial cache checks for the rows Magic Context restores after a native
 * OpenCode 1 `/compact` (the rows between its stored boundary and the host's
 * retained tail). Each scenario changes the state the restored range is derived
 * from between two passes that may not bust the cache, and records whether the
 * cached prefix stayed byte-identical. Findings are printed as one JSON line per
 * scenario (prefix `ADVERSARIAL`) and then asserted.
 */

const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";
const HISTORY_SENTINEL = "HISTORY-SENTINEL-GAP-ADVERSARIAL";
const HOST_SUMMARY_SENTINEL = "HOST-SUMMARY-SENTINEL-GAP-ADVERSARIAL";

function isHistorianRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    if (typeof system === "string") return system.includes(HISTORIAN_SYSTEM_MARKER);
    if (!Array.isArray(system)) return false;
    return system.some((block) => {
        const text = (block as { text?: unknown } | null)?.text;
        return typeof text === "string" && text.includes(HISTORIAN_SYSTEM_MARKER);
    });
}

function usage(text: string, input: number) {
    return {
        text,
        usage: {
            input_tokens: input,
            output_tokens: 10,
            cache_creation_input_tokens: input > 10_000 ? input : 0,
            cache_read_input_tokens: input > 10_000 ? 0 : input,
        },
    };
}
const smallUsage = (text: string) => usage(text, 500);
const bigUsage = (text: string) => usage(text, 90_000);

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        magicContextConfig: { execute_threshold_percentage: 40 },
        openCodeConfigExtra: { compaction: { auto: false, prune: false, tail_turns: 1 } },
    });
});

afterAll(async () => {
    await h.dispose();
});

function pluginLog(): string {
    return readFileSync(join(h.dataDir, "cortexkit", "magic-context-e2e.log"), "utf8");
}

function assertOpenDatabasesAreThrowaway(): void {
    const result = spawnSync("lsof", ["-p", String(h.opencode.pid), "-Fn"], { encoding: "utf8" });
    const dataDir = realpathSync(h.dataDir);
    const databases = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("n") && /\.db(-wal|-shm)?$/.test(line))
        .map((line) => line.slice(1))
        .filter((path) => /opencode|cortexkit|magic-context|context\.db/.test(path));
    expect(databases.some((path) => path.endsWith("opencode.db"))).toBe(true);
    expect(databases.some((path) => path.endsWith("context.db"))).toBe(true);
    const outside = databases.filter(
        (path) =>
            !realpathSync(path).startsWith(dataDir) &&
            !/\/Library\/Caches\/opencode\/Cache\.db(-wal|-shm)?$/.test(path),
    );
    console.log(`ADVERSARIAL lsof pid=${h.opencode.pid} dataDir=${dataDir} dbs=${JSON.stringify(databases)}`);
    expect(outside).toEqual([]);
}

function openCodeStore(): Database {
    return new Database(join(h.dataDir, "opencode", "opencode.db"), { readonly: true });
}

function mainRequests(): Array<{ body: Record<string, unknown> }> {
    return h.requests().filter((request) => !isHistorianRequest(request.body));
}

function requestContaining(text: string): { body: Record<string, unknown> } {
    const request = mainRequests().find((candidate) => JSON.stringify(candidate.body).includes(text));
    expect(request).toBeDefined();
    return request as { body: Record<string, unknown> };
}

function cachedPrefixSha(body: Record<string, unknown>, reference: Record<string, unknown>): string {
    const referenceSegments = buildSegments(reference);
    let last = -1;
    referenceSegments.forEach((segment, index) => {
        if (segment.breakpoint) last = index;
    });
    const hash = createHash("sha256");
    for (const segment of buildSegments(body).slice(0, last + 1)) {
        hash.update(`${segment.id}:${segment.hash}\n`);
    }
    return hash.digest("hex");
}

function compare(
    label: string,
    a: { body: Record<string, unknown> },
    b: { body: Record<string, unknown> },
) {
    const busts = findBusts([a, b]);
    const result = {
        label,
        busts: busts.length,
        report: busts.length > 0 ? formatBustReport(busts).slice(0, 1_500) : "",
        prefixShaA: cachedPrefixSha(a.body, a.body),
        prefixShaB: cachedPrefixSha(b.body, a.body),
    };
    console.log(`ADVERSARIAL ${JSON.stringify(result)}`);
    return result;
}

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

/** Stored rows strictly between two ids, oldest first. */
function rowsBetween(
    sessionId: string,
    afterId: string,
    beforeId: string,
): Array<{ id: string; role: string; text: string }> {
    const db = openCodeStore();
    try {
        const all = db
            .prepare(
                "SELECT id, json_extract(data, '$.role') AS role FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
            )
            .all(sessionId) as Array<{ id: string; role: string }>;
        const lower = all.findIndex((row) => row.id === afterId);
        const upper = all.findIndex((row) => row.id === beforeId);
        return all.slice(lower + 1, upper).map((row) => {
            const part = db
                .prepare(
                    "SELECT data FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text' ORDER BY id LIMIT 1",
                )
                .get(row.id) as { data: string } | null;
            const text = part ? ((JSON.parse(part.data) as { text?: string }).text ?? "") : "";
            return { ...row, text: text.slice(0, 40) };
        });
    } finally {
        db.close();
    }
}

function readBaseline(sessionId: string): { boundary: string | null; hasM0: boolean } {
    const row = h
        .contextDb()
        .prepare(
            "SELECT cached_m0_last_baseline_end_message_id AS boundary, cached_m0_bytes IS NOT NULL AS has_m0 FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as { boundary: string | null; has_m0: number } | null;
    return { boundary: row?.boundary ?? null, hasM0: row?.has_m0 === 1 };
}

function compartmentState(sessionId: string): { count: number; busy: number; lastEnd: string | null } {
    const row = h
        .contextDb()
        .prepare(
            `SELECT (SELECT COUNT(*) FROM compartments WHERE session_id = ?) AS c,
                    (SELECT end_message_id FROM compartments WHERE session_id = ? ORDER BY sequence DESC LIMIT 1) AS last,
                    compartment_in_progress AS busy FROM session_meta WHERE session_id = ?`,
        )
        .get(sessionId, sessionId, sessionId) as { c: number; busy: number; last: string | null } | null;
    return { count: row?.c ?? 0, busy: row?.busy ?? 0, lastEnd: row?.last ?? null };
}

/** `coverAtMost` limits each historian answer to that many ordinals of its range. */
function installMocks(coverAtMost?: number): void {
    h.mock.reset();
    h.mock.addMatcher((body) => {
        if (!isHistorianRequest(body)) return null;
        const range = findHistorianOrdinalRange(body);
        const text = range
            ? buildMockHistorianPayload({
                  start: range.start,
                  end: coverAtMost ? Math.min(range.end, range.start + coverAtMost - 1) : range.end,
                  title: "adversarial chunk",
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
    h.mock.setDefault(usage("fill", 1_000));
}

function gapLog(sessionId: string, offset: number): string[] {
    return pluginLog()
        .slice(offset)
        .split("\n")
        .filter((line) => line.includes(sessionId) && /host compaction gap|rematerialized=true|historian marked due/.test(line))
        .map((line) => line.slice(0, 300));
}

/** A session the historian summarised before a native `/compact`. */
async function compactedSession(): Promise<string> {
    installMocks();
    const sessionId = await h.createSession();
    for (let i = 1; i <= 10; i++) {
        await h.sendPrompt(sessionId, `turn ${i}: durable signal for chunk ${i}. ${h.ballast(3_000)}`);
    }
    assertOpenDatabasesAreThrowaway();
    h.mock.setDefault(bigUsage("big"));
    await h.sendPrompt(sessionId, "turn 11: trigger turn with real content.");
    await h.sendPrompt(sessionId, "turn 12: post-trigger follow-up.");
    await h.waitFor(() => compartmentState(sessionId).count >= 1 && compartmentState(sessionId).busy === 0, {
        timeoutMs: 60_000,
        label: "compartment published",
    });
    for (let turn = 13; turn <= 20; turn++) {
        await h.sendPrompt(sessionId, `turn ${turn}: executing follow-up.`);
        const served = JSON.stringify(mainRequests().at(-1)?.body ?? {});
        if (served.includes(HISTORY_SENTINEL) && readBaseline(sessionId).boundary !== null) break;
    }
    expect(readBaseline(sessionId).boundary).not.toBeNull();
    h.mock.setDefault(smallUsage(HOST_SUMMARY_SENTINEL));
    await h.waitForMockQuiescence({ label: "quiet before compaction" });
    await h.compactSession(sessionId);
    await h.waitForMockQuiescence({ label: "quiet after compaction" });
    return sessionId;
}

it(
    "a gap row deleted through the host API: defer pass, then the first pass after a restart",
    async () => {
        const sessionId = await compactedSession();
        const offset = pluginLog().length;
        h.mock.setDefault(smallUsage("after-compaction"));
        const promptA = "delete variant: first prompt after the native compaction";
        await h.sendPrompt(sessionId, promptA);
        const passA = requestContaining(promptA);

        const request = compactionRequest(sessionId);
        const boundary = readBaseline(sessionId).boundary;
        expect(request).not.toBeNull();
        expect(boundary).not.toBeNull();
        const gap = rowsBetween(sessionId, boundary as string, request?.tailStartId as string);
        console.log(`ADVERSARIAL gap rows ${JSON.stringify(gap)}`);
        const victim = gap.filter((row) => row.role === "assistant").at(-1);
        expect(victim).toBeDefined();
        const victimText = gap.find((row) => row.role === "user")?.text ?? "";
        expect(JSON.stringify(passA.body)).toContain(victimText.slice(0, 20));

        const response = await fetch(
            `${h.opencode.url}/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(victim?.id as string)}`,
            { method: "DELETE" },
        );
        console.log(`ADVERSARIAL delete ${victim?.id} -> HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
        expect(response.ok).toBe(true);
        await h.waitForMockQuiescence({ label: "quiet after delete" });

        const promptB = "delete variant: defer pass after the delete";
        await h.sendPrompt(sessionId, promptB);
        const passB = requestContaining(promptB);
        const inProcess = compare("delete: A -> B (same process, defer)", passA, passB);

        await h.restart();
        assertOpenDatabasesAreThrowaway();
        const promptC = "delete variant: first pass after the restart";
        await h.sendPrompt(sessionId, promptC);
        const passC = requestContaining(promptC);
        const afterRestart = compare("delete: B -> C (first pass after restart)", passB, passC);
        console.log(`ADVERSARIAL delete log ${JSON.stringify(gapLog(sessionId, 0).slice(-12))}`);
        void offset;

        expect({ inProcess: inProcess.busts, afterRestart: afterRestart.busts }).toEqual({
            inProcess: 0,
            afterRestart: 0,
        });
    },
    600_000,
);

it(
    "a gap row edited through the host API: an execute pass that busts nothing else",
    async () => {
        const sessionId = await compactedSession();
        h.mock.setDefault(smallUsage("after-compaction"));
        await h.sendPrompt(sessionId, "edit variant A: first prompt after the native compaction");
        await h.waitFor(() => compartmentState(sessionId).busy === 0, {
            timeoutMs: 90_000,
            label: "historian idle after the compaction",
        });
        await h.waitForMockQuiescence({ label: "quiet after A" });
        // Answers above the execute threshold and below the force band: the passes
        // after them may bust, and one with nothing to apply does not.
        h.mock.setDefault(usage("mid", 45_000));
        await h.sendPrompt(sessionId, "edit variant P0: answer reports usage over the threshold");
        await h.sendPrompt(sessionId, "edit variant P1: first executing pass");
        await h.waitFor(() => compartmentState(sessionId).busy === 0, { timeoutMs: 90_000, label: "idle P1" });
        await h.waitForMockQuiescence({ label: "quiet after P1" });
        await h.sendPrompt(sessionId, "edit variant P2: executing pass with nothing to apply");
        const p1 = requestContaining("edit variant P1:");
        const p2 = requestContaining("edit variant P2:");
        const control = compare("edit: P1 -> P2 (execute, no store change)", p1, p2);

        const request = compactionRequest(sessionId);
        const boundary = readBaseline(sessionId).boundary;
        const gap = rowsBetween(sessionId, boundary as string, request?.tailStartId as string);
        const victim = gap.find((row) => row.role === "user");
        console.log(`ADVERSARIAL edit gap ${JSON.stringify(gap.map((row) => row.text))}`);
        expect(victim).toBeDefined();
        const store = openCodeStore();
        const part = store
            .prepare(
                "SELECT id, data FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text' ORDER BY id LIMIT 1",
            )
            .get(victim?.id as string) as { id: string; data: string };
        store.close();
        const edited = {
            ...(JSON.parse(part.data) as Record<string, unknown>),
            id: part.id,
            sessionID: sessionId,
            messageID: victim?.id,
            text: "EDITED-GAP-ROW: this stored row changed after it was served",
        };
        const response = await fetch(
            `${h.opencode.url}/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(victim?.id as string)}/part/${encodeURIComponent(part.id)}`,
            { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(edited) },
        );
        console.log(`ADVERSARIAL edit ${victim?.id} -> HTTP ${response.status}`);
        expect(response.ok).toBe(true);

        await h.sendPrompt(sessionId, "edit variant P3: executing pass after the edit");
        const p3 = requestContaining("edit variant P3:");
        const afterEdit = compare("edit: P2 -> P3 (execute, gap row edited)", p2, p3);
        const p3HasEdit = JSON.stringify(p3.body).includes("EDITED-GAP-ROW");
        const lines = pluginLog()
            .split("\n")
            .filter((line) => line.includes(sessionId) && /scheduler:|host compaction gap|rematerialized|WILL|HARD fold/.test(line))
            .map((line) => line.slice(60, 300));
        console.log(`ADVERSARIAL edit log ${JSON.stringify(lines.slice(-14))}`);
        console.log(`ADVERSARIAL edit P3 serves the edit: ${p3HasEdit}`);
        expect({ control: control.busts, afterEdit: afterEdit.busts }).toEqual({ control: 0, afterEdit: 0 });
    },
    600_000,
);

it(
    "a session /compacted before its first compartment: the first published compartment reaches the wire only on a busting pass",
    async () => {
        // The historian's first compartment covers only the oldest rows, so it ends
        // inside the range the compaction hid.
        installMocks(4);
        const sessionId = await h.createSession();
        for (let i = 1; i <= 8; i++) {
            await h.sendPrompt(sessionId, `young ${i}: early work ${i}. ${h.ballast(3_000)}`);
        }
        expect(compartmentState(sessionId).count).toBe(0);
        h.mock.setDefault(smallUsage(HOST_SUMMARY_SENTINEL));
        await h.waitForMockQuiescence({ label: "quiet before compaction" });
        await h.compactSession(sessionId);
        await h.waitForMockQuiescence({ label: "quiet after compaction" });

        h.mock.setDefault(smallUsage("after-compaction"));
        await h.sendPrompt(sessionId, "young A: first prompt after the native compaction");
        const afterA = { baseline: readBaseline(sessionId), compartments: compartmentState(sessionId) };
        console.log(`ADVERSARIAL young after A ${JSON.stringify(afterA)}`);

        // Newer turns give the historian a protected head to summarise; its size
        // trigger starts it in the background. Every answer reports small usage, so
        // every pass here defers.
        let publishedAfter = 0;
        for (let i = 1; i <= 16 && publishedAfter === 0; i++) {
            await h.sendPrompt(sessionId, `young new ${i}: newer work ${i}. ${h.ballast(12_000)}`);
            if (compartmentState(sessionId).count > 0) publishedAfter = i;
        }
        if (publishedAfter === 0) {
            h.mock.setDefault(usage("mid", 45_000));
            await h.sendPrompt(sessionId, "young new 17: turn whose answer reports high usage.");
            h.mock.setDefault(smallUsage("small-again"));
            await h.sendPrompt(sessionId, "young new 18: executing pass that starts the historian.");
            publishedAfter = 18;
        }
        await h.waitFor(
            () => compartmentState(sessionId).count >= 1 && compartmentState(sessionId).busy === 0,
            { timeoutMs: 90_000, label: "first compartment published" },
        );
        await h.waitForMockQuiescence({ label: "quiet after historian" });
        const afterPublish = { publishedAfter, baseline: readBaseline(sessionId), compartments: compartmentState(sessionId) };
        console.log(`ADVERSARIAL young after publish ${JSON.stringify(afterPublish)}`);

        const before = mainRequests().at(-1) as { body: Record<string, unknown> };
        await h.sendPrompt(sessionId, "young T3: first pass after the background publish.");
        const passT3 = requestContaining("young T3:");
        await h.sendPrompt(sessionId, "young T4: second pass after the background publish.");
        const passT4 = requestContaining("young T4:");
        const t2t3 = compare("young: last pass before -> T3 (after background publish)", before, passT3);
        const t3t4 = compare("young: T3 -> T4", passT3, passT4);
        const lines = pluginLog()
            .split("\n")
            .filter((line) => line.includes(sessionId) && /scheduler:|host compaction gap|rematerialized|compartment agent|starting agent|published/.test(line))
            .map((line) => line.slice(60, 330));
        console.log(`ADVERSARIAL young log ${JSON.stringify(lines.slice(-14))}`);
        assertOpenDatabasesAreThrowaway();

        expect({ t2t3: t2t3.busts, t3t4: t3t4.busts }).toEqual({ t2t3: 0, t3t4: 0 });
    },
    600_000,
);
