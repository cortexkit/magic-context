import { expect, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { closeDatabase } from "../../../plugin/src/features/magic-context/storage-db";
import { Database } from "../../../plugin/src/shared/sqlite";
import { V2StoreReader } from "../../../plugin/src/v2/store-reader";
import type { MockProvider } from "../../src/mock-provider/server";
import { stageNoiseTailFixture } from "../../src/recomp-noise-fixture";
import {
    isolation,
    inspectOpenFiles,
    spawnOpencode2,
    waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

const WINDOW = 60_000;
const TURN_TEXT = "durable history ".repeat(2500);
// The historian's own prompt is larger than the session window, as it is for
// real users with a small session model, so it runs on a second model whose
// window the enforcer below does not apply to.
const HISTORIAN_MODEL = { id: "historian-model", contextLimit: 200_000 };

type Client = ReturnType<typeof OpenCode.make>;
type Host = Awaited<ReturnType<typeof spawnOpencode2>>;

function clientFor(host: Host): Client {
    return OpenCode.make({
        baseUrl: host.url,
        headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
    });
}

function contextDbPath(host: { env: NodeJS.ProcessEnv }): string {
    return join(host.env.XDG_DATA_HOME!, "cortexkit", "magic-context", "context.db");
}

function hostDbPath(host: { env: NodeJS.ProcessEnv }): string {
    return join(host.env.XDG_DATA_HOME!, "opencode", host.env.OPENCODE_DB!);
}

function readRows<T>(path: string, sql: string, ...params: unknown[]): T[] {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        return db.prepare(sql).all(...params) as T[];
    } finally {
        db.close();
    }
}

interface CompartmentRow {
    sequence: number;
    endMessage: number;
    endMessageId: string;
}

function compartments(host: Host, sessionId: string): CompartmentRow[] {
    return readRows<CompartmentRow>(
        contextDbPath(host),
        "SELECT sequence, end_message AS endMessage, end_message_id AS endMessageId FROM compartments WHERE session_id = ? ORDER BY sequence",
        sessionId,
    );
}

function baselineBoundary(host: Host, sessionId: string): string | null {
    return (
        readRows<{ id: string | null }>(
            contextDbPath(host),
            "SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id = ?",
            sessionId,
        )[0]?.id ?? null
    );
}

async function turn(client: Client, sessionId: string, text: string): Promise<void> {
    await client.session.prompt({ sessionID: sessionId, text });
    await client.session.wait({ sessionID: sessionId }, { signal: AbortSignal.timeout(60_000) });
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, label: string): Promise<T> {
    const deadline = Date.now() + 60_000;
    let value = read();
    while (!done(value)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await Bun.sleep(100);
        value = read();
    }
    return value;
}

/** The plugin buffers its log; poll until a line appears. */
async function waitForLog(path: string, needle: string | RegExp): Promise<string> {
    return waitFor(
        () => (existsSync(path) ? readFileSync(path, "utf8") : ""),
        (text) => (typeof needle === "string" ? text.includes(needle) : needle.test(text)),
        `log line ${needle}`,
    );
}

interface Scenario {
    fixture: ReturnType<typeof isolation>;
    host: Host;
    client: Client;
    mock: MockProvider;
    mockBaseURL: string;
    sessionId: string;
    logPath: string;
}

const MAGIC_CONTEXT_CONFIG = {
    memory: { enabled: false },
    dreamer: { disable: true },
    historian: { two_pass: false },
};

/**
 * Two compartments, a baseline on the second one's end, then a host compaction.
 * The mock reports tiny usage throughout so the plugin never starts a historian
 * on its own; the compartments come only from the two /ctx-wrapup runs.
 */
async function buildSession(
    label: string,
    onHistorianRange: (start: number, end: number) => number | null,
): Promise<Scenario> {
    const fixture = isolation();
    const logPath = join(fixture.root, `${label}.log`);
    fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
    const host = await spawnOpencode2({
        existingIsolation: fixture,
        modelContextLimit: WINDOW,
        modelOutputLimit: 1_024,
        compactionAuto: false,
        magicContextConfig: MAGIC_CONTEXT_CONFIG,
        historianModel: HISTORIAN_MODEL,
    });
    const mock = host.mock;
    mock.addMatcher((body) => {
        const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
        if (!range) return null;
        const start = Number(range[1]);
        const chunkEnd = Number(range[2]);
        const end = onHistorianRange(start, chunkEnd);
        return {
            text:
                end === null
                    ? "No usable history summary."
                    : `<compartment start="${start}" end="${end}" title="History ${start}-${end}"><p1>Turns ${start} to ${end} recorded durable history.</p1></compartment>${end < chunkEnd ? `<unprocessed_from>${end + 1}</unprocessed_from>` : ""}`,
            usage: { input_tokens: 100, output_tokens: 40 },
        };
    });
    let assistantReply = 0;
    mock.addMatcher((body) =>
        body.model === "mock-model"
            ? {
                  text: `RECOMP-WIRE-ASSISTANT-${++assistantReply}#`,
                  usage: { input_tokens: 100, output_tokens: 10 },
              }
            : null,
    );
    mock.setDefault({ text: "ordinary turn", usage: { input_tokens: 100, output_tokens: 10 } });
    const client = clientFor(host);
    const session = await client.session.create({
        title: label,
        location: { directory: host.cwd },
        model: { providerID: "openai", id: "mock-model" },
    });
    await waitForPluginActive(client, host.cwd);
    const scenario: Scenario = {
        fixture,
        host,
        client,
        mock,
        mockBaseURL: host.mockBaseURL,
        sessionId: session.id,
        logPath,
    };

    for (let index = 0; index < 12; index++)
        await turn(client, session.id, `Turn ${index}: ${TURN_TEXT}`);
    await client.session.command({ sessionID: session.id, name: "ctx-wrapup", text: "2" });
    await waitFor(
        () => compartments(host, session.id),
        (rows) => rows.length >= 1,
        "first wrapup",
    );
    for (let index = 12; index < 24; index++)
        await turn(client, session.id, `Turn ${index}: ${TURN_TEXT}`);
    const before = compartments(host, session.id).length;
    await client.session.command({ sessionID: session.id, name: "ctx-wrapup", text: "2" });
    await waitFor(
        () => compartments(host, session.id),
        (rows) => rows.length > before,
        "second wrapup",
    );
    // Flush lets the next turn move the baseline to the newest compartment end.
    await client.session.command({ sessionID: session.id, name: "ctx-flush", text: "" });
    await turn(client, session.id, "Turn 24: settle the baseline");

    await client.session.compact({ sessionID: session.id });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) });
    const cuts = readRows<{ count: number }>(
        hostDbPath(host),
        "SELECT COUNT(*) AS count FROM session_message WHERE session_id = ? AND type = 'compaction'",
        session.id,
    )[0]?.count;
    expect(cuts).toBeGreaterThan(0);
    await turn(client, session.id, "Turn 25: after the host compaction");
    // Wait for any historian already running, then flush again to put the
    // baseline on the newest compartment end.
    let count = -1;
    for (;;) {
        const next = compartments(host, session.id).length;
        if (next === count) break;
        count = next;
        await Bun.sleep(1_500);
    }
    await client.session.command({ sessionID: session.id, name: "ctx-flush", text: "" });
    await turn(client, session.id, "Turn 26: settle the baseline after the compaction");
    const latest = compartments(host, session.id).at(-1);
    expect(latest?.endMessageId).toBeTruthy();
    expect(baselineBoundary(host, session.id)).toBe(latest!.endMessageId);
    return scenario;
}

async function restart(scenario: Scenario): Promise<void> {
    scenario.host = await spawnOpencode2({
        existingIsolation: scenario.fixture,
        existingMock: { mock: scenario.mock, baseURL: scenario.mockBaseURL },
        modelContextLimit: WINDOW,
        modelOutputLimit: 1_024,
        compactionAuto: false,
        magicContextConfig: MAGIC_CONTEXT_CONFIG,
        historianModel: HISTORIAN_MODEL,
    });
    scenario.client = clientFor(scenario.host);
    await waitForPluginActive(scenario.client, scenario.host.cwd);
}

function servedFor(scenario: Scenario, marker: string, from: number) {
    return scenario.mock
        .requests()
        .slice(from)
        .filter((request) => JSON.stringify(request.body).includes(marker));
}

test("a stopped recomp preserves the next request after a manual checkpoint, then resumes", async () => {
    let mode: "build" | "stop" | "resume" = "build";
    const seen: number[] = [];
    let stagedEnd = 0;
    const scenario = await buildSession("recomp-keeps-checkpoint", (start, end) => {
        if (mode === "build") return end;
        seen.push(start);
        if (mode === "resume") return end;
        if (start > 1) return null;
        stagedEnd = Math.min(18, end);
        return stagedEnd;
    });
    const { sessionId, logPath, mock } = scenario;
    const hostedDb = hostDbPath(scenario.host);
    const store = contextDbPath(scenario.host);
    const files = [hostedDb, store];
    const marker = "RECOMP-WIRE-PROBE";
    const capture = async () => {
        const from = mock.requests().length;
        await turn(scenario.client, sessionId, marker);
        const [request] = servedFor(scenario, marker, from).filter(
            (r) => r.body.model === "mock-model",
        );
        expect(request?.rawBody).toBeString();
        return request!;
    };
    const inventory = () => {
        const host = scenario.host;
        if (!host.pid) throw new Error("host pid missing");
        const paths = [
            ...new Set(
                inspectOpenFiles(host.pid, host.root, host.env).filter((path) =>
                    /\.db(?:-wal|-shm)?$/.test(path),
                ),
            ),
        ];
        expect(paths).toContain(hostedDb);
        expect(paths).toContain(store);
        expect(paths.every((path) => path.startsWith(`${host.root}/`))).toBe(true);
        console.log(`lsof -p ${host.pid}: ${JSON.stringify(paths)}`);
    };
    const publishedHistory = () => ({
        compartments: readRows<Record<string, unknown>>(
            store,
            "SELECT * FROM compartments WHERE session_id = ? ORDER BY sequence",
            sessionId,
        ),
        cache: readRows<Record<string, unknown>>(
            store,
            `SELECT cached_m0_bytes, cached_m1_bytes, cached_m0_last_baseline_end_message_id,
			pending_compaction_marker_state FROM session_meta WHERE session_id = ?`,
            sessionId,
        ),
        checkpoint: readRows<Record<string, unknown>>(
            hostedDb,
            "SELECT * FROM session_message WHERE session_id = ? AND type = 'compaction' ORDER BY seq",
            sessionId,
        ),
    });
    try {
        inventory();
        // Replay the next turn from the same stopped host and plugin stores at the
        // same paths, so IDs, input history and request bytes need no normalization.
        await scenario.host.stopHost();
        for (const path of files) {
            const db = new Database(path, { fileMustExist: true });
            try {
                db.prepare("VACUUM INTO ?").run(`${path}.control`);
            } finally {
                db.close();
            }
        }
        await restart(scenario);
        inventory();
        const control = await capture();
        await scenario.host.stopHost();
        closeDatabase();
        for (const path of files) {
            for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
            copyFileSync(`${path}.control`, path);
        }
        await restart(scenario);
        inventory();
        const original = publishedHistory();
        expect(original.checkpoint.length).toBeGreaterThan(0);
        expect(compartments(scenario.host, sessionId).at(-1)!.endMessage).toBeGreaterThan(18);

        mode = "stop";
        await scenario.client.session.command({
            sessionID: sessionId,
            name: "ctx-recomp",
            text: "",
        });
        const stopped = await waitForLog(logPath, "recomp finished");
        const stoppedLine = stopped.split("\n").find((line) => line.includes("recomp finished"));
        console.log(stoppedLine);
        expect(stoppedLine).toContain(
            "recomp finished (published=false): ## Magic Recomp — Paused",
        );
        expect(stagedEnd).toBeGreaterThan(0);
        expect(stoppedLine).toContain(
            `Your current history is unchanged. Run /ctx-recomp again to continue from message ${stagedEnd + 1}.`,
        );
        expect(publishedHistory()).toEqual(original);
        expect(seen).toContain(stagedEnd + 1);
        expect(
            readRows(
                store,
                "SELECT end_message FROM recomp_compartments WHERE session_id = ?",
                sessionId,
            ),
        ).toEqual([{ end_message: stagedEnd }]);

        const reader = new V2StoreReader(hostedDb);
        const transcript = reader.range(sessionId, -1, reader.latestSequence(sessionId));
        reader.close();
        const logStart = readFileSync(logPath, "utf8").length;
        const after = await capture();
        expect(after.rawBody).toBe(control.rawBody!);
        const wire = JSON.stringify(after.body.input ?? after.body.messages);
        const summaryRows = original.compartments.filter((row) => wire.includes(String(row.title)));
        const sequence = new Map(transcript.map((row) => [row.id, row.seq]));
        const marked = transcript.flatMap((row) => {
            if (row.type !== "user" && row.type !== "assistant") return [];
            const text = JSON.stringify(row.data).match(
                /Turn \d+:|RECOMP-WIRE-ASSISTANT-\d+#/,
            )?.[0];
            return text ? [{ row, text }] : [];
        });
        expect(marked.length).toBeGreaterThan(46);
        expect(marked).toHaveLength(
            transcript.filter((row) => row.type === "user" || row.type === "assistant").length,
        );
        for (const { row, text } of marked) {
            const covering = summaryRows.filter(
                (summary) =>
                    row.seq >= (sequence.get(String(summary.start_message_id)) ?? Infinity) &&
                    row.seq <= (sequence.get(String(summary.end_message_id)) ?? -Infinity),
            );
            expect(wire.split(text).length - 1 + covering.length).toBe(1);
        }
        await waitFor(
            () => readFileSync(logPath, "utf8").slice(logStart),
            (log) => log.includes("reason=cache_hit"),
            "captured request cache hit",
        );

        mode = "resume";
        seen.length = 0;
        await scenario.client.session.command({
            sessionID: sessionId,
            name: "ctx-recomp",
            text: "",
        });
        const completed = await waitForLog(
            logPath,
            /recomp finished \(published=true\): ## Magic Recomp — Complete/,
        );
        const completeLine = completed
            .split("\n")
            .find((line) => line.includes("recomp finished (published=true)"));
        console.log(completeLine);
        expect(completeLine).toContain("Resumed from previous interrupted run.");
        expect(seen[0]).toBe(stagedEnd + 1);
        expect(seen.every((start) => start > stagedEnd)).toBe(true);
        expect(
            readRows(store, "SELECT 1 FROM recomp_compartments WHERE session_id = ?", sessionId),
        ).toEqual([]);
    } catch (error) {
        console.error(
            `Historian starts: ${JSON.stringify(seen)}\n${readFileSync(logPath, "utf8")
                .split("\n")
                .filter((line) => /recomp|historian.*(fail|skip)|cache_hit/.test(line))
                .slice(-24)
                .join("\n")}`,
        );
        throw error;
    } finally {
        await scenario.host.stop();
    }
}, 600_000);

test.each([
    "carry",
    "discard",
] as const)("keeps the full provider body after noise-tail %s", async (kind) => {
    const fixture = isolation();
    const logPath = join(fixture.root, "recomp-noise.log");
    fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
    const host = await spawnOpencode2({
        existingIsolation: fixture,
        modelContextLimit: WINDOW,
        modelOutputLimit: 1_024,
        compactionAuto: false,
        magicContextConfig: MAGIC_CONTEXT_CONFIG,
        historianModel: HISTORIAN_MODEL,
    });
    const client = clientFor(host);
    const session = await client.session.create({
        title: "Recomp noise tail",
        location: { directory: host.cwd },
        model: { providerID: "openai", id: "mock-model" },
    });
    const scenario: Scenario = {
        fixture,
        host,
        client,
        mock: host.mock,
        mockBaseURL: host.mockBaseURL,
        sessionId: session.id,
        logPath,
    };
    const hostDb = hostDbPath(host);
    const context = contextDbPath(host);
    const marker = "RECOMP-NOISE-WIRE-PROBE";
    const assertIsolated = () => {
        if (!scenario.host.pid) throw new Error("host pid missing");
        const paths = [
            ...new Set(inspectOpenFiles(scenario.host.pid, scenario.host.root, scenario.host.env)),
        ].filter((path) => /\.db(?:-wal|-shm)?$/.test(path));
        expect(paths).toContain(hostDb);
        expect(paths).toContain(context);
        expect(paths.every((path) => path.startsWith(`${fixture.root}/`))).toBe(true);
        console.log(`lsof -p ${scenario.host.pid}: ${JSON.stringify(paths)}`);
    };
    const capture = async () => {
        assertIsolated();
        const from = host.mock.requests().length;
        await turn(scenario.client, session.id, marker);
        const requests = servedFor(scenario, marker, from).filter(
            (request) => request.body.model === "mock-model",
        );
        expect(requests).toHaveLength(1);
        expect(requests[0]?.rawBody).toBeString();
        return requests[0]!.rawBody;
    };
    try {
        await waitForPluginActive(client, host.cwd);
        host.mock.setDefault({
            text: "Ledger recorded.",
            usage: { input_tokens: 100, output_tokens: 10 },
        });
        for (let i = 0; i < 5; i++) await turn(client, session.id, `Noise fixture ledger ${i}`);
        assertIsolated();
        await scenario.host.stopHost();
        closeDatabase();
        const reader = new V2StoreReader(hostDb);
        let rawIds: string[];
        try {
            rawIds = reader
                .messageOrdinalPage(session.id, null, 100)
                .filter((row) => row.contributesOrdinal)
                .map((row) => row.id);
        } finally {
            reader.close();
        }
        const sqlite = new Database(hostDb, { fileMustExist: true });
        try {
            const lastAssistant = rawIds.at(-1);
            const changed = sqlite
                .prepare(`UPDATE session_message SET data=json_set(data,'$.content',json('[]')), time_updated=time_updated+1
                WHERE id = ? AND type = 'assistant'`)
                .run(lastAssistant);
            expect(changed.changes).toBe(1);
            // Newer hosts keep assistant content in a separate part table.
            if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_part'").get()) {
                sqlite.prepare("DELETE FROM session_part WHERE message_id = ?").run(lastAssistant);
            }
        } finally {
            sqlite.close();
        }
        const aligned = kind === "carry";
        const seed = stageNoiseTailFixture(context, session.id, rawIds, true, aligned);
        const files = [hostDb, context];
        for (const path of files) {
            const db = new Database(path, { fileMustExist: true });
            try {
                db.prepare("VACUUM INTO ?").run(`${path}.noise-control`);
            } finally {
                db.close();
            }
        }
        await restart(scenario);
        const expected = await capture();
        await scenario.host.stopHost();
        closeDatabase();
        for (const path of files) {
            for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
            copyFileSync(`${path}.noise-control`, path);
        }
        await restart(scenario);
        const snapshot = () => ({
            compartments: readRows(
                context,
                "SELECT * FROM compartments WHERE session_id = ? ORDER BY sequence",
                session.id,
            ),
            cache: readRows(
                context,
                `SELECT cached_m0_bytes, cached_m1_bytes, cached_m0_last_baseline_end_message_id,
                pending_compaction_marker_state FROM session_meta WHERE session_id = ?`,
                session.id,
            ),
            mutations: readRows(
                context,
                "SELECT * FROM m0_mutation_log WHERE session_id = ? ORDER BY id",
                session.id,
            ),
        });
        const before = snapshot();
        const from = host.mock.requests().length;
        await scenario.client.session.command({
            sessionID: session.id,
            name: "ctx-recomp",
            text: "",
        });
        const log = await waitForLog(logPath, "recomp finished");
        const outcome = log.split("\n").find((line) => line.includes("recomp finished"));
        console.log(outcome);
        if (aligned) {
            expect(outcome).toContain(
                "recomp finished (published=true): ## Magic Recomp — Complete",
            );
            expect(outcome).toContain(
                `Kept 1 existing history block through message ${seed.tail.endMessage}.`,
            );
            expect(
                readRows(
                    context,
                    "SELECT end_message_id AS endId, episode_type AS kind, legacy FROM compartments WHERE session_id = ? ORDER BY sequence",
                    session.id,
                ),
            ).toEqual([
                { endId: seed.prefix.endMessageId, kind: null, legacy: 0 },
                { endId: seed.tail.endMessageId, kind: "filtered-noise", legacy: 0 },
            ]);
        } else {
            expect(outcome).toContain(
                "recomp finished (published=false): ## Magic Recomp — Failed",
            );
            expect(outcome).toContain(
                "The unfinished rebuild was discarded. Your current history is unchanged.",
            );
            expect(snapshot()).toEqual(before);
        }
        expect(
            host.mock
                .requests()
                .slice(from)
                .filter((request) => request.body.model === HISTORIAN_MODEL.id),
        ).toEqual([]);
        expect(
            readRows(context, "SELECT 1 FROM recomp_compartments WHERE session_id = ?", session.id),
        ).toEqual([]);
        expect(await capture()).toBe(expected);
    } finally {
        await scenario.host.stop();
    }
}, 300_000);
