/**
 * Time whole OpenCode 1 transform passes for two large sessions served
 * alternately by one process, as in issue 653, and print the per-stage timings
 * the transform logs (`lkg.entryProjection`, `compartmentTrigger`,
 * `pp.tailMeasure`, `pp.tailBaseline`, ...).
 *
 *   bun scripts/perf-audit/issue-653-transform-stages.ts --root <throwaway dir> [--src <plugin src>] [--passes N]
 *
 * Every store the run opens lives under `--root`: the driver points
 * XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_STATE_HOME, XDG_RUNTIME_DIR, HOME,
 * OPENCODE_DB and MAGIC_CONTEXT_STORAGE_DIR there before importing the plugin,
 * and refuses to start without it. No OpenCode host is started.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendTurn, buildSession, loadMessages, rng, SHAPES, type Shape } from "./issue-653-fixture";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 && args[at + 1] ? (args[at + 1] as string) : fallback;
};
const root = flag("--root");
if (!root) throw new Error("--root <throwaway directory> is required");
for (const [key, dir] of [
    ["XDG_DATA_HOME", "data"],
    ["XDG_CONFIG_HOME", "config"],
    ["XDG_STATE_HOME", "state"],
    ["XDG_RUNTIME_DIR", "run"],
    ["HOME", "home"],
    ["MAGIC_CONTEXT_STORAGE_DIR", "mc"],
] as const) {
    const path = join(root, dir);
    mkdirSync(path, { recursive: true });
    process.env[key] = path;
}
process.env.OPENCODE_DB = join(root, "opencode.db");

const src = resolve(flag("--src", resolve(import.meta.dir, "../../src")) as string);
const passes = Number(flag("--passes", "6"));
const megabytes = Number(flag("--mb", "56"));
const messageCount = Number(flag("--messages", "606"));

const imp = async <T>(path: string): Promise<T> => (await import(`${src}/${path}`)) as T;
const { openDatabase, closeDatabase } = await imp<
    typeof import("../../src/features/magic-context/storage")
>("features/magic-context/storage.ts");
const { createTagger } = await imp<typeof import("../../src/features/magic-context/tagger")>(
    "features/magic-context/tagger.ts",
);
const { createMessagesTransformHandler } = await imp<
    typeof import("../../src/plugin/messages-transform")
>("plugin/messages-transform.ts");
const { refreshModelLimitsFromApi } = await imp<
    typeof import("../../src/shared/models-dev-cache")
>("shared/models-dev-cache.ts");
const { setLogLineForwarder } = await imp<typeof import("../../src/shared/logger")>(
    "shared/logger.ts",
);
const { getInMemorySlot } = await imp<typeof import("../../src/hooks/magic-context/lkg-slot")>(
    "hooks/magic-context/lkg-slot.ts",
);
const { createTransform } = await imp<typeof import("../../src/hooks/magic-context/transform")>(
    "hooks/magic-context/transform.ts",
);

const PROVIDER = "anthropic";
const MODEL = "claude-sonnet-4-5";
// Large enough that the fixture is not refused as an unmanaged over-window
// history: the reported sessions were at about a quarter of their window.
const WINDOW = Number(flag("--window", "64000000"));
// The last provider-measured usage each session starts from. The reported
// sessions sat at about a quarter of their window.
const usagePercent = Number(flag("--usage", "25"));

const stageLines: string[] = [];
setLogLineForwarder((line) => {
    if (/transform stage:|transform completed|compartment trigger|historian|protected tail/.test(line)) {
        stageLines.push(line);
    }
});

await refreshModelLimitsFromApi({
    config: {
        providers: async () => ({
            data: {
                providers: [
                    {
                        id: PROVIDER,
                        models: { [MODEL]: { limit: { context: WINDOW, output: 32_000 } } },
                    },
                ],
            },
        }),
    },
} as never);

const sessionCount = Number(flag("--sessions", "2"));
const shape = flag("--shape", "text") as Shape;
if (!SHAPES.includes(shape)) throw new Error(`--shape must be one of ${SHAPES.join(", ")}`);
const sessions = Array.from({ length: sessionCount }, (_, index) =>
    buildSession(
        String.fromCharCode(65 + index),
        index + 1,
        messageCount,
        megabytes * 1024 * 1024,
        shape,
    ),
);
// OpenCode 1's own store, which the raw-history readers (compartment trigger,
// protected-tail boundary) query. It is created fresh under the root.
const { Database: SqliteDatabase } = await imp<typeof import("../../src/shared/sqlite")>(
    "shared/sqlite.ts",
);
const { OPENCODE1_MESSAGE_PART_SCHEMA } = await imp<
    typeof import("../../src/features/magic-context/__tests__/opencode1-query-fixture")
>("features/magic-context/__tests__/opencode1-query-fixture.ts");
const opencodeDb = new SqliteDatabase(process.env.OPENCODE_DB as string);
opencodeDb.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
const insertMessage = opencodeDb.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
const insertPart = opencodeDb.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
const stored = new Map<string, number>();
function storeNewMessages(session: (typeof sessions)[number]): void {
    const from = stored.get(session.sessionId) ?? 0;
    opencodeDb.transaction(() => {
        for (let index = from; index < session.json.length; index += 1) {
            const message = JSON.parse(session.json[index] as string) as {
                info: { id: string; time: { created: number } } & Record<string, unknown>;
                parts: Array<{ id: string } & Record<string, unknown>>;
            };
            const { id, sessionID: _session, ...info } = message.info;
            const created = message.info.time.created;
            insertMessage.run(id, session.sessionId, created, created, JSON.stringify(info));
            for (const part of message.parts) {
                const { id: partId, sessionID: _s, messageID: _m, ...data } = part;
                insertPart.run(partId, id, session.sessionId, created, created, JSON.stringify(data));
            }
        }
    })();
    stored.set(session.sessionId, session.json.length);
}

const db = openDatabase();
const transform = createTransform({
    tagger: createTagger(),
    scheduler: { shouldExecute: () => "defer" as const },
    contextUsageMap: new Map(
        sessions.map((session) => [
            session.sessionId,
            {
                usage: { percentage: usagePercent, inputTokens: (WINDOW * usagePercent) / 100 },
                updatedAt: Date.now(),
            },
        ]),
    ),
    db,
    historyRefreshSessions: new Set<string>(),
    pendingMaterializationSessions: new Set<string>(),
    lastHeuristicsTurnId: new Map<string, string>(),
    clearReasoningAge: 50,
    protectedTokens: 0,
    historianRunnable: true,
    channel1StateBySession: new Map(),
    liveModelBySession: new Map(
        sessions.map((session) => [session.sessionId, { providerID: PROVIDER, modelID: MODEL }]),
    ),
} as never);
const handler = createMessagesTransformHandler({
    magicContext: { "experimental.chat.messages.transform": transform },
} as never);

// With --slow-ms N, every logged stage of at least N ms is listed under its pass.
const slowMsFlag = flag("--slow-ms");
const slowMs = slowMsFlag === undefined ? undefined : Number(slowMsFlag);
const WATCHED = [
    "lkg.entryProjection",
    "compartmentTrigger",
    "pp.tailMeasure",
    "pp.tailBaseline",
    "postTransformPhase",
];
const random = rng(7);
console.log(`src=${src} shape=${shape}`);
console.log(["pass", "session", "messages", "handler_ms", ...WATCHED, "lkg_slot_bytes"].join("\t"));
for (let pass = 0; pass < passes; pass += 1) {
    for (const session of sessions) {
        if (pass > 0) appendTurn(session, random);
        storeNewMessages(session);
        const messages = loadMessages(session);
        stageLines.length = 0;
        const started = performance.now();
        try {
            await handler({} as never, { messages } as never);
        } catch (error) {
            console.log(`pass ${pass} ${session.sessionId} threw: ${String(error).slice(0, 200)}`);
        }
        const elapsed = performance.now() - started;
        const stages = WATCHED.map((stage) => {
            const line = stageLines.find(
                (entry) =>
                    entry.includes(`[${session.sessionId}]`) && entry.includes(`stage=${stage} `),
            );
            const match = line?.match(/elapsed=([\d.]+)ms/);
            return match ? match[1] : "-";
        });
        // The last-known-good snapshot this pass left: its stored JSON length, or
        // "none" when no capture fit.
        const slot = getInMemorySlot(session.sessionId);
        if (args.includes("--stringify")) {
            // What serializing the served prefix costs whole and reduced to what
            // the provider receives (the fixture serves its whole input).
            const { providerVisibleMessage } = await import(
                "../../src/hooks/magic-context/provider-visible-parts"
            );
            const fresh = loadMessages(session);
            let started = performance.now();
            const whole = JSON.stringify(fresh).length;
            const wholeMs = performance.now() - started;
            started = performance.now();
            const reduced = JSON.stringify(fresh.map(providerVisibleMessage)).length;
            const reducedMs = performance.now() - started;
            console.log(
                `    stringify whole=${wholeMs.toFixed(1)}ms (${whole} chars) reduced=${reducedMs.toFixed(1)}ms (${reduced} chars)`,
            );
        }
        console.log(
            [
                pass,
                session.sessionId,
                messages.length,
                elapsed.toFixed(1),
                ...stages,
                slot ? slot.jsonPrefix.length : "none",
            ].join("\t"),
        );
        if (slowMs !== undefined) {
            for (const line of stageLines) {
                const match = line.match(/stage=(\S+) elapsed=([\d.]+)ms/);
                if (match && Number(match[2]) >= slowMs) console.log(`    slow: ${match[1]} ${match[2]}ms`);
            }
        }
    }
}
if (args.includes("--stages")) console.log(stageLines.join(""));

// Isolation proof: every SQLite file this process holds open, as lsof reports it.
const lsof = Bun.spawnSync(["lsof", "-p", String(process.pid)]).stdout.toString();
const dbFiles = [
    ...new Set(
        lsof
            .split("\n")
            .map((line) => line.split(/\s+/).slice(8).join(" "))
            .filter((path) => /\.db(-wal|-shm)?$/.test(path)),
    ),
];
console.log(`lsof .db files: ${dbFiles.join(", ") || "(none)"}`);
closeDatabase();
