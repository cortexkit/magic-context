import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import * as embedding from "../../features/magic-context/memory/embedding";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import {
    closeDatabase,
    getTagsBySession,
    openDatabase,
} from "../../features/magic-context/storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import { getAutoSearchHintDecisions } from "../../features/magic-context/storage-meta-persisted";
import { replayHint } from "../../hooks/magic-context/auto-search-replay.fixture";
import { autoSearchTestSnapshot } from "../../hooks/magic-context/auto-search-snapshot.fixture";
import * as search from "../../hooks/magic-context/auto-search-worker-client";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import { resetLkgSlotsForTest } from "../../hooks/magic-context/lkg-slot";
import { collectTemporalCandidates } from "../../hooks/magic-context/temporal-awareness";
import { _resetDreamTimerForTests } from "../../plugin/dream-timer";
import { setHarness } from "../../shared/harness";
import * as logger from "../../shared/logger";
import * as models from "../../shared/models-dev-cache";
import { resetOpenCodeDbPathStateForTesting } from "../../shared/opencode-db-path";
import { scaleTest } from "../../shared/slow-test";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { rememberHostMedia, resetHostMediaForTests } from "../fold/host-media";
import { registerContext } from "./context";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context, V2Message } from "./types";

class ReviewAsset {
    constructor(readonly sourceRecord: { source: Record<string, unknown> }) {
        Object.assign(this, sourceRecord);
    }
}
class ReviewMessage {
    constructor(readonly content: Array<Record<string, unknown>>) {}
}

const prose =
    "Please review the implementation and verify the results carefully before we continue with the next deployment cache invalidation step. ";

// Host/config/model probes, embedding availability and search results are synthetic.
// The registered context callback, transform, fold owner, rendering and SQLite run normally.
async function fixture(
    seed: number,
    overrides: Record<string, unknown> = {},
    initial = registerContext,
) {
    setHarness("opencode2");
    const base = join(tmpdir(), "magic-context/oc2-render-review");
    mkdirSync(base, { recursive: true });
    const restoring = process.env.REVIEW709_RESTART_PHASE === "read";
    const root =
        process.env.REVIEW709_RESTART_ROOT ??
        createTestTempDirFromPath(join(base, `seed-${seed}-`));
    const keys = [
        "HOME",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "MAGIC_CONTEXT_STORAGE_DIR",
        "MAGIC_CONTEXT_LOG_PATH",
        "OPENCODE_DB",
    ];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) process.env[key] = join(root, key);
    let nowClock = 1770000000000 + seed * 10000000;
    const clock = spyOn(Date, "now").mockImplementation(() => nowClock);
    for (const key of keys.filter(
        (key) => !["MAGIC_CONTEXT_LOG_PATH", "OPENCODE_DB"].includes(key),
    ))
        mkdirSync(process.env[key]!, { recursive: true });
    resetOpenCodeDbPathStateForTesting();
    const raw = new Database(process.env.OPENCODE_DB!);
    raw.exec(
        "CREATE TABLE IF NOT EXISTS session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE IF NOT EXISTS session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT);",
    );
    const db = openDatabase();
    if (!db) throw new Error("isolated review database unavailable");
    const opened = db.prepare("PRAGMA database_list").all() as Array<{ file: string }>;
    // SQLite reports the resolved path, so on macOS a root under /var reads back
    // as /private/var. Compare against both spellings of the same folder.
    const realRoot = realpathSync(root);
    if (
        opened.some(
            (row) =>
                row.file &&
                !row.file.startsWith(`${root}/`) &&
                !row.file.startsWith(`${realRoot}/`),
        )
    )
        throw new Error("review database escaped isolated root");
    const config = MagicContextConfigSchema.parse({
        auto_update: false,
        embedding: { provider: "off" },
        historian: { disable: true },
        dreamer: {
            disable: true,
            inject_docs: true,
            tasks: { "review-user-memories": { schedule: "0 0 * * *" } },
        },
        memory: {
            enabled: true,
            injection_budget_tokens: 1000,
            auto_search: { enabled: true, score_threshold: 0.3 },
            git_commit_indexing: { enabled: false },
        },
        temporal_awareness: true,
        mural: { enabled: true },
        history_budget_percentage: 0.17 + (seed % 13) / 100,
        caveman_text_compression: { enabled: true, min_chars: 100 },
        protected_tokens: 4000,
        keep_reasoning_tokens: 100000,
        commit_cluster_trigger: { enabled: false },
        ...overrides,
    });
    const configPath = join(process.env.XDG_CONFIG_HOME!, "cortexkit");
    mkdirSync(configPath, { recursive: true });
    writeFileSync(join(configPath, "magic-context.jsonc"), JSON.stringify(config));
    const project = resolveProjectIdentityForSession(root)!;
    const now = Date.now();
    if (!restoring) {
        for (let i = 0; i < 18; i++) {
            const content = `Project constraint ${seed}/${i}: ${prose.repeat(8)}`;
            db.prepare(
                "INSERT INTO memories (project_path,category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at,mural_cue,mural_cue_hash,mural_cue_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ).run(
                project,
                "CONSTRAINTS",
                content,
                `review-${i}`,
                now,
                now,
                now,
                now,
                `Deployment constraint ${i}`,
                createHash("sha256").update(content).digest("hex"),
                now,
            );
        }
        db.prepare(
            "INSERT INTO user_memories(content,status,promoted_at,created_at,updated_at) VALUES (?,'active',?,?,?)",
        ).run("Review preference: explain cache risks precisely.", now, now, now);
        writeFileSync(
            join(root, "ARCHITECTURE.md"),
            "# Isolated architecture\nReview-only deployment cache.",
        );
    }
    const vision = spyOn(models, "modelSupportsVision").mockReturnValue(true);
    resetHostMediaForTests();
    rememberHostMedia([
        new ReviewMessage([
            {
                type: "media",
                media: new ReviewAsset({
                    source: { type: "base64", data: "aGVsbG8=", mediaType: "image/png" },
                }),
            },
        ]),
    ]);
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        config,
    } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
    const probe = spyOn(storageGate, "probeV2StorageAtBoot").mockResolvedValue(db);
    const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockImplementation((project) =>
        autoSearchTestSnapshot(project),
    );
    const lookup = spyOn(search, "searchAutoHint").mockResolvedValue([replayHint]);
    const logs = spyOn(logger, "sessionLog");
    const storage = new Map<string, unknown>();
    let hooks = new Map<string, (draft: SessionContext) => Promise<void>>();
    let duties: Awaited<ReturnType<typeof registerContext>>;
    const host = {
        location: { directory: root },
        agent: { transform: async () => {}, reload: async () => {} },
        model: {
            list: () =>
                ["gpt-4.1", "gpt-4.1-mini"].map((id) => ({
                    id,
                    providerID: "openai",
                    limit: { context: 1000000 },
                })),
        },
        storage: {
            get: async (key: string) => storage.get(key),
            set: async (key: string, value: unknown) => {
                storage.set(key, structuredClone(value));
            },
        },
        event: { subscribe: async function* () {} },
        tool: { hook: async () => {} },
        session: {
            remove: async () => {},
            compact: async () => {},
            interrupt: async () => ({ interrupted: true }),
            hook: async (name: string, callback: (draft: SessionContext) => Promise<void>) => {
                hooks.set(name, callback);
            },
            get: async () => ({ location: { directory: root } }),
        },
    } as unknown as V2Context;
    let session = `ses709review-${seed}`;
    raw.prepare("INSERT OR IGNORE INTO session_v2(id,directory) VALUES (?,?)").run(session, root);
    const source: V2Message[] = Array.from({ length: 24 + (seed % 8) }, (_, n) => ({
        id: `s${seed}-${n}`,
        role: n % 2 ? "assistant" : "user",
        content: [{ type: "text", text: `${seed}/${n}: ${prose.repeat(2 + ((seed + n) % 7))}` }],
    }));
    if (source.at(-1)?.role !== "user") source.pop();
    let model = "gpt-4.1";
    let system = "Review the isolated project.";
    let checkpoint: V2Message | undefined;
    let lastDraft: SessionContext | undefined;
    let folds = 0;
    function persist() {
        raw.prepare("DELETE FROM session_message WHERE session_id = ?").run(session);
        for (const [seq, message] of source.entries()) {
            raw.prepare(
                "INSERT INTO session_message(id,session_id,type,seq,time_created,data) VALUES (?,?,?,?,?,?)",
            ).run(
                message.id!,
                session,
                message.role,
                seq,
                Date.now() - 2000000 + seq * 1000,
                JSON.stringify({
                    content: message.content,
                    model: { providerID: "openai", id: model },
                    time: { completed: Date.now() },
                    tokens: {
                        input: 10000,
                        output: 50,
                        reasoning: 0,
                        cache: { read: 0, write: 0 },
                    },
                }),
            );
        }
    }
    async function start(register = registerContext) {
        await duties?.dispose();
        resetCtxReduceRegisteredGloballyForTest();
        resetLkgSlotsForTest();
        hooks = new Map();
        duties = await register(host);
        if (!hooks.has("context")) throw new Error("real context hook missing");
    }
    function inputDraft(): SessionContext {
        return {
            sessionID: session,
            model: { providerID: "openai", id: model, limit: { context: 1000000 } },
            agent: "build",
            system: [{ type: "text", text: system }],
            tools: { read: { description: "Read a file", input: { type: "object" } } },
            options: {},
            messages: structuredClone(checkpoint ? [checkpoint, ...source.slice(-3)] : source),
        };
    }
    async function pass() {
        const draft = inputDraft();
        const before = logs.mock.calls.length;
        await hooks.get("context")!(draft);
        lastDraft = structuredClone(draft);
        return {
            bytes: JSON.stringify({
                system: draft.system,
                tools: draft.tools,
                messages: draft.messages,
            }),
            draft,
            logs: logs.mock.calls.slice(before).map((args) => args.map(String).join(" ")),
        };
    }
    if (restoring) {
        const row = raw
            .prepare(
                "SELECT id,data FROM session_message WHERE session_id = ? AND type = 'compaction' ORDER BY seq DESC LIMIT 1",
            )
            .get(session) as { id: string; data: string } | undefined;
        if (row)
            checkpoint = {
                id: row.id,
                role: "user",
                content: [
                    {
                        type: "text",
                        text: `<summary>\n${JSON.parse(row.data).summary}\n</summary>`,
                    },
                ],
            };
    } else persist();
    await start(initial);
    return {
        root,
        db,
        raw,
        config,
        get session() {
            return session;
        },
        pass,
        start,
        lookup,
        tags: () => getTagsBySession(db, session),
        decisions: () => getAutoSearchHintDecisions(db, session),
        meta: () => getOrCreateSessionMeta(db, session),
        seedHistory() {
            appendCompartments(
                db,
                session,
                Array.from({ length: 3 }, (_, n) => ({
                    sequence: n,
                    startMessage: n * 4 + 1,
                    endMessage: n * 4 + 4,
                    startMessageId: source[n * 4]!.id!,
                    endMessageId: source[n * 4 + 3]!.id!,
                    title: `Persisted review history ${n}`,
                    content: prose.repeat(4),
                    p1: prose.repeat(4),
                    p2: prose.repeat(2),
                    p3: "Reviewed the cache policy.",
                    p4: "Cache policy reviewed.",
                    legacy: 0,
                })),
            );
        },
        switchModel() {
            model = model === "gpt-4.1" ? "gpt-4.1-mini" : "gpt-4.1";
        },
        fork(ordinaryChild = false) {
            const parent = session;
            const rows = raw
                .prepare("SELECT * FROM session_message WHERE session_id = ? ORDER BY seq")
                .all(parent) as Array<{
                id: string;
                type: string;
                seq: number;
                time_created: number;
                time_updated: number | null;
                data: string;
            }>;
            const boundary = rows.at(-1)!.id;
            session = `${parent}-fork`;
            raw.prepare(
                "INSERT INTO session_v2(id,directory,parent_id,fork_session_id,fork_boundary) VALUES (?,?,?,?,?)",
            ).run(
                session,
                root,
                ordinaryChild ? parent : null,
                ordinaryChild ? null : parent,
                ordinaryChild ? null : JSON.stringify({ type: "through", messageID: boundary }),
            );
            const ids = new Map(rows.map((row) => [row.id, `${session}_${row.seq}`]));
            for (const row of rows)
                raw.prepare(
                    "INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)",
                ).run(
                    ids.get(row.id)!,
                    session,
                    row.type,
                    row.seq,
                    row.time_created,
                    row.time_updated,
                    row.data,
                );
            for (const message of source) message.id = ids.get(message.id!)!;
            if (checkpoint) checkpoint.id = ids.get(checkpoint.id!)!;
            return new Map(
                getTagsBySession(db, parent).map((tag) => [
                    ids.get(tag.messageId) ??
                        (() => {
                            const owner = rows.find((row) =>
                                tag.messageId.startsWith(`${row.id}:`),
                            );
                            return owner
                                ? `${ids.get(owner.id)}${tag.messageId.slice(owner.id.length)}`
                                : tag.messageId;
                        })(),
                    tag.cavemanDepth ?? 0,
                ]),
            );
        },
        changeSystem() {
            system += " Verify the new system instruction.";
        },
        async idle() {
            nowClock += 3600000;
        },
        changeExternalFeatures() {
            db.prepare("UPDATE user_memories SET content = content || ?").run(
                ` Updated preference ${seed}.`,
            );
            const memory = db
                .prepare("SELECT id,content FROM memories ORDER BY id DESC LIMIT 1")
                .get() as { id: number; content: string };
            const content = `${memory.content} Updated constraint ${seed}.`;
            db.prepare(
                "UPDATE memories SET content = ?,mural_cue = ?,mural_cue_hash = ? WHERE id = ?",
            ).run(
                content,
                `Updated cue ${seed}`,
                createHash("sha256").update(content).digest("hex"),
                memory.id,
            );
            writeFileSync(
                join(root, "ARCHITECTURE.md"),
                `# Isolated architecture\nReview-only deployment cache. Updated architecture ${seed}.`,
            );
        },
        completeResponse() {
            nowClock += 1000;
            const row = raw
                .prepare(
                    "SELECT id,data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 1",
                )
                .get(session) as { id: string; data: string };
            const data = JSON.parse(row.data);
            data.time.completed = nowClock;
            raw.prepare("UPDATE session_message SET data = ? WHERE id = ?").run(
                JSON.stringify(data),
                row.id,
            );
        },
        async fold(beforeContext = false) {
            const draft = beforeContext ? inputDraft() : structuredClone(lastDraft!);
            await hooks.get("compaction")!(draft);
            if (!draft.result) throw new Error("compaction hook supplied no summary");
            // The compaction hook used to reject a request that arrived while the
            // durable store was still opening, so tests that retried a cold fold
            // only ever wrote one fold row. It now waits for the store and both
            // attempts succeed, so each fold row needs its own id and a seq after
            // the source rows and any earlier fold.
            const { last } = raw
                .prepare("SELECT MAX(seq) AS last FROM session_message WHERE session_id = ?")
                .get(session) as { last: number | null };
            const seq = Math.max(source.length, (last ?? -1) + 1);
            const id = folds === 0 ? `fold-${seed}` : `fold-${seed}-${folds}`;
            folds++;
            raw.prepare(
                "INSERT INTO session_message(id,session_id,type,seq,time_created,data) VALUES (?,?,?,?,?,?)",
            ).run(
                id,
                session,
                "compaction",
                seq,
                Date.now(),
                JSON.stringify({
                    status: "completed",
                    summary: draft.result.summary,
                    time: { completed: Date.now() },
                }),
            );
            checkpoint = {
                id,
                role: "user",
                content: [{ type: "text", text: `<summary>\n${draft.result.summary}\n</summary>` }],
            };
            return draft.result.summary;
        },
        freshTurn() {
            const n = source.length;
            source.push(
                {
                    id: `s${seed}-${n}`,
                    role: "assistant",
                    content: [{ type: "text", text: prose.repeat(3) }],
                },
                {
                    id: `s${seed}-${n + 1}`,
                    role: "user",
                    content: [{ type: "text", text: `deployment widget ${seed}: ${prose}` }],
                },
            );
            persist();
        },
        async cleanup() {
            await duties?.dispose();
            logs.mockRestore();
            lookup.mockRestore();
            snapshot.mockRestore();
            probe.mockRestore();
            load.mockRestore();
            vision.mockRestore();
            clock.mockRestore();
            _resetDreamTimerForTests();
            closeDatabase();
            raw.close();
            resetLkgSlotsForTest();
            resetCtxReduceRegisteredGloballyForTest();
            for (const key of keys) {
                if (saved[key] === undefined) delete process.env[key];
                else process.env[key] = saved[key];
            }
            resetOpenCodeDbPathStateForTesting();
            resetHostMediaForTests();
            if (!process.env.REVIEW709_RESTART_ROOT) cleanupTestTempDir(root);
        },
    };
}

const featuresOnReplay =
    "issue 709 review: features-on real OC2 hook replays defer bytes over seeded passes";
scaleTest(
    featuresOnReplay,
    async (slow) => {
        const changes: Array<{ seed: number; step: number; logs: string[] }> = [];
        const compactions: Array<{ seed: number; hard: string[] }> = [];
        let passes = 0;
        const coverage: unknown[] = [];
        for (let seed = 709; seed < (slow ? 729 : 713); seed++) {
            const f = await fixture(seed);
            try {
                f.seedHistory();
                let random = seed;
                let previous: Awaited<ReturnType<typeof f.pass>> | undefined;
                const next = () => {
                    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
                    return random;
                };
                for (let step = 0; step < 12; step++) {
                    // Storage changes alone must not authorize edits to a served prefix.
                    if (step === 2) f.changeExternalFeatures();
                    if (step === 3) await f.start();
                    if (step === 5) f.switchModel();
                    if (step === 9) await f.fold();
                    if (step === 7) await f.idle();
                    const inheritedDepths = step === 11 ? f.fork() : undefined;
                    const fresh = step > 0 && step < 9 && step !== 7 && next() % 3 === 0;
                    if (fresh) f.freshTurn();
                    const depthsBefore =
                        inheritedDepths ??
                        new Map(f.tags().map((t) => [t.messageId, t.cavemanDepth ?? 0]));
                    const first = await f.pass();
                    if (step === 9)
                        compactions.push({
                            seed,
                            hard: first.logs.filter((line) => /HARD.*executed=true/.test(line)),
                        });
                    // An idle expiry (step 7) replays the previous bytes like any
                    // warm pass: only the provider forgot the cache.
                    if (previous && ![5, 9, 11].includes(step)) {
                        if (!fresh)
                            expect(first.bytes, `same input seed ${seed} step ${step}`).toBe(
                                previous.bytes,
                            );
                        else {
                            expect(
                                first.draft.messages.slice(0, previous.draft.messages.length),
                                `old prefix seed ${seed} step ${step}`,
                            ).toEqual(previous.draft.messages);
                            expect(first.draft.system).toEqual(previous.draft.system);
                            expect(first.draft.tools).toEqual(previous.draft.tools);
                        }
                    }
                    passes++;
                    const newCompression = f
                        .tags()
                        .filter(
                            (t) => (t.cavemanDepth ?? 0) > (depthsBefore.get(t.messageId) ?? 0),
                        );
                    if (newCompression.length)
                        expect(
                            first.logs.some(
                                (line) =>
                                    /first_render|bustsServedPrefix=true/.test(line) ||
                                    (step === 11 && line.includes("HARD reason=boot_recovery")),
                            ),
                            `compression first-apply seed ${seed} step ${step}: ${JSON.stringify({ newCompression, hard: first.logs.filter((line) => line.includes("HARD")) })}`,
                        ).toBe(true);
                    expect(first.bytes).toContain("Review preference");
                    expect(first.bytes).toContain("Isolated architecture");
                    expect(first.bytes).toContain("Persisted review history");
                    expect(first.bytes).toContain("mediaType");
                    expect(first.bytes).toContain("image/png");
                    expect(first.bytes.includes(`Updated preference ${seed}.`)).toBe(step >= 5);
                    expect(first.bytes.includes(`Updated architecture ${seed}.`)).toBe(step >= 5);
                    expect(f.meta().cachedM0UpgradeState).toContain("mural-enabled:1");
                    expect(f.meta().cachedM0UpgradeState).toContain(
                        `hp${f.config.history_budget_percentage}:percentage:65`,
                    );
                    const decisionsBeforeReplay = f.decisions().length;
                    const depthsBeforeReplay = f
                        .tags()
                        .map((t) => [t.messageId, t.cavemanDepth ?? 0]);
                    const second = await f.pass();
                    passes++;
                    expect(f.decisions().length).toBe(decisionsBeforeReplay);
                    expect(f.tags().map((t) => [t.messageId, t.cavemanDepth ?? 0])).toEqual(
                        depthsBeforeReplay,
                    );
                    expect(
                        second.logs.some((line) =>
                            /transform scheduler: .*decision=defer/.test(line),
                        ),
                        `seed ${seed} step ${step}: ${second.logs.join("\n")}`,
                    ).toBe(true);
                    if (step === 7) expect(first.logs.join("\n")).not.toContain("ttl_idle");
                    if (second.bytes !== first.bytes)
                        changes.push({ seed, step, logs: second.logs });
                    previous = second;
                    f.completeResponse();
                }
                expect(f.tags().some((t) => (t.cavemanDepth ?? 0) > 0)).toBe(true);
                expect(f.decisions().some((d) => d.decision === "hint")).toBe(true);
                coverage.push({
                    seed,
                    compressed: f.tags().filter((t) => (t.cavemanDepth ?? 0) > 0).length,
                    hintDecisions: f.decisions().length,
                    meta: f.db
                        .prepare(
                            "SELECT cached_m0_upgrade_state, cached_m0_mural_hash FROM session_meta WHERE session_id = ?",
                        )
                        .get(f.session),
                });
            } finally {
                await f.cleanup();
            }
        }
        console.log(JSON.stringify({ passes, deferChanges: changes, compactions, coverage }));
        expect(passes).toBe(slow ? 480 : 96);
        expect(changes).toEqual([]);
        expect(compactions.every((row) => row.hard.length === 0)).toBe(true);
    },
    120000,
);

test.skipIf(!process.env.REVIEW709_BASELINE_MODULE)(
    "issue 709 review: upgrade from exact cb9ba1d1 OC2 callback",
    async () => {
        const baseline = (await import(process.env.REVIEW709_BASELINE_MODULE!)) as {
            registerContext: typeof registerContext;
        };
        const off = {
            dreamer: { disable: true, inject_docs: true },
            memory: {
                enabled: true,
                injection_budget_tokens: 1000,
                auto_search: { enabled: false },
                git_commit_indexing: { enabled: false },
            },
            temporal_awareness: false,
            mural: { enabled: false },
            caveman_text_compression: { enabled: false },
            history_budget_percentage: 0.15,
        };
        const cases: Array<[string, Record<string, unknown>]> = [
            ["control", {}],
            ["autoSearch", { memory: { ...off.memory, auto_search: { enabled: true } } }],
            ["caveman", { caveman_text_compression: { enabled: true, min_chars: 100 } }],
            [
                "userMemoryCollection",
                {
                    dreamer: {
                        ...off.dreamer,
                        tasks: { "review-user-memories": { schedule: "0 0 * * *" } },
                    },
                },
            ],
            ["temporal", { temporal_awareness: true }],
            ["mural", { mural: { enabled: true } }],
            ["historyBudget", { history_budget_percentage: 0.23 }],
            ["injectDocsOff", { dreamer: { ...off.dreamer, inject_docs: false } }],
            [
                "allOn",
                {
                    dreamer: {
                        disable: true,
                        inject_docs: true,
                        tasks: { "review-user-memories": { schedule: "0 0 * * *" } },
                    },
                    memory: { ...off.memory, auto_search: { enabled: true } },
                    caveman_text_compression: { enabled: true, min_chars: 100 },
                    temporal_awareness: true,
                    mural: { enabled: true },
                    history_budget_percentage: 0.23,
                },
            ],
        ];
        const results = [];
        for (const [index, [feature, options]] of cases.entries()) {
            const f = await fixture(1709 + index, { ...off, ...options }, baseline.registerContext);
            try {
                const old = await f.pass();
                f.completeResponse();
                const cachedOld = f.meta().cachedM0UpgradeState;
                await f.start();
                const upgraded = await f.pass();
                const upgradedIdentity = f.meta().cachedM0UpgradeState;
                const hintsOnUpgrade = f.decisions().filter((d) => d.decision === "hint").length;
                const compressedOnUpgrade = f
                    .tags()
                    .filter((t) => (t.cavemanDepth ?? 0) > 0).length;
                const replay = await f.pass();
                expect(
                    upgraded.logs.filter((line) => /HARD.*executed=true/.test(line)).length,
                    `${feature}: first upgrade pass`,
                ).toBe(1);
                expect(replay.logs.filter((line) => /HARD.*executed=true/.test(line))).toEqual([]);
                expect(replay.bytes, `${feature}: upgrade replay`).toBe(upgraded.bytes);
                expect(cachedOld).toContain("hpdefault");
                expect(upgradedIdentity).toContain(
                    `hp${f.config.history_budget_percentage}:percentage:65`,
                );
                expect(upgradedIdentity).toContain(
                    `mural-enabled:${feature === "mural" || feature === "allOn" ? 1 : 0}`,
                );
                expect(hintsOnUpgrade > 0).toBe(feature === "autoSearch" || feature === "allOn");
                expect(old.bytes.includes("Review preference")).toBe(true);
                expect(upgraded.bytes.includes("Isolated architecture")).toBe(
                    feature !== "injectDocsOff",
                );
                expect(compressedOnUpgrade > 0).toBe(feature === "allOn");
                f.switchModel();
                const natural = await f.pass();
                const naturalReplay = await f.pass();
                if (feature === "caveman")
                    expect(
                        f.tags().filter((t) => (t.cavemanDepth ?? 0) > 0).length,
                    ).toBeGreaterThan(0);
                results.push({
                    feature,
                    hintsOnUpgrade,
                    compressedOnUpgrade,
                    compressedAfterNatural: f.tags().filter((t) => (t.cavemanDepth ?? 0) > 0)
                        .length,
                    naturalReplayChanged: natural.bytes !== naturalReplay.bytes,
                    changed: old.bytes !== upgraded.bytes,
                    secondChanged: upgraded.bytes !== replay.bytes,
                    oldIdentity: cachedOld,
                    newIdentity: upgradedIdentity,
                    userMemoryOnBase: old.bytes.includes("Review preference"),
                    userMemoryOnUpgrade: upgraded.bytes.includes("Review preference"),
                    docsOnUpgrade: upgraded.bytes.includes("Isolated architecture"),
                    naturalChanged: upgraded.bytes !== natural.bytes,
                    firstLogs: upgraded.logs.filter((line) =>
                        /HARD|decision=|auto-search:|heuristics WILL/.test(line),
                    ),
                    secondLogs: replay.logs.filter((line) => /HARD.*executed=true/.test(line)),
                });
            } finally {
                await f.cleanup();
            }
        }
        console.log(`UPGRADE709 ${JSON.stringify(results, null, 2)}`);
        expect(
            results.every(
                (result) =>
                    !result.secondChanged &&
                    !result.naturalReplayChanged &&
                    result.secondLogs.length === 0 &&
                    result.firstLogs.filter((line) => /HARD.*executed=true/.test(line)).length <= 1,
            ),
        ).toBe(true);
    },
    120000,
);

// The source store has timestamps separated by 10 minutes, so the fresh render
// must include a temporal marker even though the provider draft omits timestamps.
test("issue 709 witness: OC2 temporal awareness survives host payload projection", async () => {
    const f = await fixture(2709);
    try {
        const rows = f.raw
            .prepare("SELECT id,time_created,data FROM session_message ORDER BY seq")
            .all() as Array<{ id: string; time_created: number; data: string }>;
        for (const [n, row] of rows.entries()) {
            const data = JSON.parse(row.data);
            data.time.created = 1700000000000 + n * 600000;
            data.time.completed = data.time.created + 1000;
            f.raw
                .prepare("UPDATE session_message SET time_created = ?,data = ? WHERE id = ?")
                .run(data.time.created, JSON.stringify(data), row.id);
        }
        const candidates = collectTemporalCandidates(
            rows.map((row, n) => ({
                info: {
                    id: row.id,
                    role: n % 2 ? "assistant" : "user",
                    time: {
                        created: 1700000000000 + n * 600000,
                        completed: 1700000001000 + n * 600000,
                    },
                },
                parts: [{ type: "text", text: prose }],
            })),
        );
        expect(
            [...candidates.values()].filter((value) => value === "<!-- +9m -->\n").length,
        ).toBeGreaterThan(0);
        const output = await f.pass();
        expect(output.logs.join("\n")).toContain("first_render");
        expect(output.bytes.includes("<!-- +9m -->")).toBe(true);
    } finally {
        await f.cleanup();
    }
});

test("issue 709 witness: OC2 compaction honors inject_docs=false", async () => {
    const f = await fixture(3709, { dreamer: { disable: true, inject_docs: false } });
    try {
        const before = await f.pass();
        expect(before.bytes.includes("Isolated architecture")).toBe(false);
        const summary = await f.fold();
        expect(summary.includes("Isolated architecture")).toBe(false);
    } finally {
        await f.cleanup();
    }
});

test("issue 709 witness: OC2 compaction preserves mural and history render identity", async () => {
    const f = await fixture(4709);
    try {
        await f.pass();
        const before = f.meta().cachedM0UpgradeState;
        expect(before).toContain("mural-enabled:1");
        await f.fold();
        const after = f.meta().cachedM0UpgradeState;
        const correction = await f.pass();
        const replay = await f.pass();
        console.log(
            `FOLD709 ${JSON.stringify({ before, after, correction: correction.logs.filter((line) => /HARD.*executed=true/.test(line)), replayChanged: correction.bytes !== replay.bytes })}`,
        );
        expect(after).toBe(before);
        expect(correction.logs.filter((line) => /HARD.*executed=true/.test(line))).toEqual([]);
    } finally {
        await f.cleanup();
    }
});

const foldFeaturesOff = {
    dreamer: { disable: true, inject_docs: true },
    memory: {
        enabled: true,
        auto_search: { enabled: false },
        git_commit_indexing: { enabled: false },
    },
    temporal_awareness: false,
    mural: { enabled: false },
    caveman_text_compression: { enabled: false },
    history_budget_percentage: 0.15,
};

test.skipIf(!process.env.OC2_FOLD_BASELINE_MODULE)(
    "OC2 fold system identity: features-off baseline comparison",
    async () => {
        const baseline = (await import(process.env.OC2_FOLD_BASELINE_MODULE!)) as {
            registerContext: typeof registerContext;
        };
        const results = [];
        let comparisons = 0;
        const memoryEnabled = process.env.OC2_FOLD_MEMORY_ON === "1";
        for (const seed of [4709, ...Array.from({ length: 20 }, (_, n) => 709 + n)]) {
            const runs = [];
            for (const register of [baseline.registerContext, registerContext]) {
                const f = await fixture(
                    seed,
                    {
                        ...foldFeaturesOff,
                        memory: { ...foldFeaturesOff.memory, enabled: memoryEnabled },
                    },
                    register,
                );
                try {
                    let random = seed;
                    const bytes: string[] = [];
                    const hard: string[] = [];
                    let summary = "";
                    for (let step = 0; step < 12; step++) {
                        if (step === 2) f.changeExternalFeatures();
                        if (step === 3) await f.start(register);
                        if (step === 5) f.switchModel();
                        if (step === 7) await f.idle();
                        if (step === 9) summary = await f.fold();
                        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
                        if (step > 0 && step < 9 && step !== 7 && random % 3 === 0) f.freshTurn();
                        const first = await f.pass();
                        const replay = await f.pass();
                        if (step === 9)
                            hard.push(
                                ...first.logs.filter((line) => /HARD.*executed=true/.test(line)),
                            );
                        expect(replay.bytes).toBe(first.bytes);
                        bytes.push(first.bytes, replay.bytes);
                        f.completeResponse();
                    }
                    runs.push({ bytes, hard, summary });
                } finally {
                    await f.cleanup();
                }
            }
            comparisons += runs[0]!.bytes.length;
            results.push({
                seed,
                differences: runs[0]!.bytes.flatMap((bytes, n) =>
                    bytes === runs[1]!.bytes[n] ? [] : [n],
                ),
                baselineHard: runs[0]!.hard,
                currentHard: runs[1]!.hard,
                sameFold: runs[0]!.summary === runs[1]!.summary,
            });
            if (memoryEnabled)
                expect(runs[1]!.summary, `memory-on fold seed ${seed}`).toBe(runs[0]!.summary);
            else {
                expect(runs[0]!.summary).toContain("<project-memory>");
                expect(runs[1]!.summary).not.toContain("<project-memory>");
            }
        }
        console.log(
            `FOLD_SYSTEM_COMPARISON ${JSON.stringify({ memoryEnabled, comparisons, results })}`,
        );
        expect(results.every((row) => row.differences.length === 0)).toBe(true);
        expect(results.every((row) => row.currentHard.length === 0)).toBe(true);
    },
    120000,
);

test("OC2 fold system identity: seed 4709 compaction needs no corrective HARD", async () => {
    const f = await fixture(4709, foldFeaturesOff);
    try {
        await f.pass();
        await f.fold();
        expect(f.meta().cachedM0SystemHash).toBe(f.meta().systemPromptHash);
        const after = await f.pass();
        const replay = await f.pass();
        expect(after.logs.filter((line) => /HARD.*executed=true/.test(line))).toEqual([]);
        expect(replay.logs.filter((line) => /HARD.*executed=true/.test(line))).toEqual([]);
        expect(replay.bytes).toBe(after.bytes);
    } finally {
        await f.cleanup();
    }
});

test("OC2 fold system identity: real system change after compaction causes exactly one HARD", async () => {
    const f = await fixture(4709, foldFeaturesOff);
    try {
        await f.pass();
        await f.fold();
        f.changeSystem();
        const changed = await f.pass();
        const replay = await f.pass();
        const hard = changed.logs.filter((line) => /HARD.*executed=true/.test(line));
        expect(hard).toHaveLength(1);
        expect(hard[0]).toContain("reason=system_hash");
        expect(replay.logs.filter((line) => /HARD.*executed=true/.test(line))).toEqual([]);
        expect(replay.bytes).toBe(changed.bytes);
    } finally {
        await f.cleanup();
    }
});

test("render review: first compaction before context initializes durable storage", async () => {
    const f = await fixture(4910, foldFeaturesOff);
    try {
        expect(f.meta().systemPromptHash ?? "").toBe("");
        await f.fold(true);
        expect(f.meta().cachedM0SystemHash ?? "").toBe("");
        const first = await f.pass();
        const replay = await f.pass();
        console.log(
            `FIRST_FOLD ${JSON.stringify({ systemHash: f.meta().systemPromptHash, cachedHash: f.meta().cachedM0SystemHash, logs: first.logs })}`,
        );
        expect(replay.bytes).toBe(first.bytes);
        expect(first.logs.filter((line) => /HARD.*executed=true/.test(line))).toEqual([]);
        expect(replay.logs.filter((line) => /HARD.*executed=true/.test(line))).toEqual([]);
    } finally {
        await f.cleanup();
    }
});

test("cold fold adopts the initialized MD5 system identity without a corrective HARD", async () => {
    const f = await fixture(4911, foldFeaturesOff);
    try {
        await f.fold(true);
        expect(f.meta().cachedM0SystemHash ?? "").toBe("");
        const first = await f.pass();
        expect(f.meta().systemPromptHash).toMatch(/^[a-f0-9]{32}$/);
        expect(f.meta().cachedM0SystemHash).toBe(f.meta().systemPromptHash);
        const replay = await f.pass();
        expect(replay.bytes).toBe(first.bytes);
        expect(
            [...first.logs, ...replay.logs].filter((line) =>
                /HARD.*executed=true|HARD reason=boot_recovery/.test(line),
            ),
        ).toEqual([]);
    } finally {
        await f.cleanup();
    }
});
test("render review: absent system identity after storage probe needs no corrective HARD", async () => {
    const f = await fixture(4913, foldFeaturesOff);
    try {
        // The first compaction starts opening durable storage but rejects its own request.
        // A retry can then render before any system hook has run.
        await f.fold(true).catch(() => undefined);
        expect(f.meta().systemPromptHash ?? "").toBe("");
        await f.fold(true);
        expect(f.meta().cachedM0SystemHash ?? "").toBe("");
        const first = await f.pass();
        const replay = await f.pass();
        expect(f.meta().cachedM0SystemHash).toBe(f.meta().systemPromptHash);
        expect(first.logs.filter((line) => /HARD.*executed=true/.test(line))).toEqual([]);
        expect(replay.logs.filter((line) => /HARD.*executed=true/.test(line))).toEqual([]);
        expect(replay.bytes).toBe(first.bytes);
    } finally {
        await f.cleanup();
    }
});

test("render review: resumed, fork and ordinary-child compaction identities settle once", async () => {
    for (const kind of ["resumed", "fork", "child"]) {
        const f = await fixture(4920, foldFeaturesOff);
        try {
            await f.pass();
            const originalHash = f.meta().systemPromptHash;
            if (kind === "resumed") {
                await f.start();
                await f.fold(true).catch(() => undefined);
                expect(f.meta().systemPromptHash).toBe(originalHash);
            } else {
                f.fork(kind === "child");
                expect(f.meta().systemPromptHash ?? "").toBe("");
            }
            await f.fold(true);
            expect(f.meta().cachedM0SystemHash ?? "").toBe(kind === "resumed" ? originalHash! : "");
            const first = await f.pass();
            const replay = await f.pass();
            expect(f.meta().cachedM0SystemHash).toBe(f.meta().systemPromptHash);
            const hard = first.logs.filter((line) => /HARD.*executed=true/.test(line));
            // Fork inheritance discards the parent's cached m[0]/m[1] message bytes.
            // The child must render its own prefix once before it can replay.
            expect(hard).toHaveLength(kind === "fork" ? 1 : 0);
            if (kind === "fork") expect(hard[0]).toContain("reason=first_render");
            expect(replay.logs.filter((line) => /HARD.*executed=true/.test(line))).toEqual([]);
            expect(replay.bytes).toBe(first.bytes);
        } finally {
            await f.cleanup();
        }
    }
});

test("render review: prompt changed between context hook and fold rebuilds once", async () => {
    const f = await fixture(4911, foldFeaturesOff);
    try {
        await f.pass();
        const previous = f.meta().systemPromptHash;
        f.changeSystem();
        await f.fold(true);
        expect(f.meta().cachedM0SystemHash).toBe(previous);
        const first = await f.pass();
        const replay = await f.pass();
        expect(f.meta().systemPromptHash).not.toBe(previous);
        expect(first.logs.filter((line) => /HARD.*executed=true/.test(line))).toHaveLength(1);
        expect(first.logs.join("\n")).toContain("reason=system_hash");
        expect(replay.logs.filter((line) => /HARD.*executed=true/.test(line))).toEqual([]);
        expect(replay.bytes).toBe(first.bytes);
    } finally {
        await f.cleanup();
    }
});

test("render review: memory disabled excludes project memory and mural from the main request", async () => {
    const f = await fixture(4912, {
        memory: {
            enabled: false,
            auto_search: { enabled: true },
            git_commit_indexing: { enabled: false },
        },
    });
    try {
        await f.pass();
        f.freshTurn();
        const fresh = await f.pass();
        const replay = await f.pass();
        expect(replay.bytes).toBe(fresh.bytes);
        expect(fresh.bytes).not.toContain("Project constraint");
        expect(fresh.bytes).not.toContain("<memory-mural>");
    } finally {
        await f.cleanup();
    }
});

test.skipIf(!process.env.RENDER_REVIEW_UPGRADE_PHASE)(
    "render review: memory-off upgrade requires exactly one rebuild",
    async () => {
        const f = await fixture(4914, {
            ...foldFeaturesOff,
            memory: { ...foldFeaturesOff.memory, enabled: false },
        });
        try {
            const first = await f.pass();
            if (process.env.RENDER_REVIEW_UPGRADE_PHASE === "write") {
                f.completeResponse();
                const summary = process.env.RENDER_REVIEW_UPGRADE_NO_FOLD ? "" : await f.fold();
                if (summary) expect(summary).toContain("Project constraint");
                writeFileSync(
                    join(f.root, "upgrade-before.json"),
                    JSON.stringify({
                        systemHash: f.meta().systemPromptHash,
                        cachedHash: f.meta().cachedM0SystemHash,
                        bytes: first.bytes,
                        foldedProjectMemory: summary.includes("<project-memory>"),
                    }),
                );
            } else {
                const before = JSON.parse(
                    readFileSync(join(f.root, "upgrade-before.json"), "utf8"),
                );
                const replay = await f.pass();
                const isRebuild = (line: string) =>
                    /HARD.*executed=true|HARD reason=boot_recovery/.test(line);
                const hard = first.logs.filter(isRebuild);
                console.log(
                    `MEMORY_OFF_UPGRADE ${JSON.stringify({ previousSystemHash: before.systemHash, systemHash: f.meta().systemPromptHash, previousCachedHash: before.cachedHash, cachedHash: f.meta().cachedM0SystemHash, hard, bytesChanged: before.bytes !== first.bytes, foldedProjectMemory: before.foldedProjectMemory })}`,
                );
                expect(before.systemHash).toBe(f.meta().systemPromptHash);
                expect(hard).toHaveLength(1);
                expect(replay.logs.filter(isRebuild)).toEqual([]);
                expect(replay.bytes).toBe(first.bytes);
                expect(first.bytes).not.toContain("Review preference");
                expect(first.bytes).not.toContain("Project constraint");
            }
        } finally {
            await f.cleanup();
        }
    },
);

test("OC2 fold memory policy: memory-off summaries omit project memory without a corrective HARD", async () => {
    const counts = [];
    for (const memoryEnabled of [true, false]) {
        for (const seed of [4709, ...Array.from({ length: 20 }, (_, n) => 709 + n)]) {
            const f = await fixture(seed, {
                ...foldFeaturesOff,
                memory: { ...foldFeaturesOff.memory, enabled: memoryEnabled },
            });
            try {
                await f.pass();
                const summary = await f.fold();
                const after = await f.pass();
                const replay = await f.pass();
                const hard = after.logs.filter((line) => /HARD.*executed=true/.test(line));
                counts.push({ seed, memoryEnabled, hard });
                expect(
                    summary.includes("<project-memory>"),
                    `seed ${seed} memory=${memoryEnabled}`,
                ).toBe(memoryEnabled);
                if (!memoryEnabled) {
                    expect(summary).not.toContain("Project constraint");
                    expect(summary).not.toContain("<user-profile>");
                }
                expect(hard, `seed ${seed} memory=${memoryEnabled}`).toEqual([]);
                expect(replay.logs.filter((line) => /HARD.*executed=true/.test(line))).toEqual([]);
                expect(replay.bytes).toBe(after.bytes);
            } finally {
                await f.cleanup();
            }
        }
    }
    console.log(`FOLD_MEMORY_COUNTS ${JSON.stringify(counts)}`);
}, 120000);

test("OC2 fold memory policy: a real memory setting change after compaction causes exactly one HARD", async () => {
    for (const memoryEnabled of [true, false]) {
        const f = await fixture(4709, {
            ...foldFeaturesOff,
            memory: { ...foldFeaturesOff.memory, enabled: memoryEnabled },
        });
        try {
            await f.pass();
            await f.fold();
            f.config.memory.enabled = !memoryEnabled;
            await f.start();
            const changed = await f.pass();
            const replay = await f.pass();
            expect(changed.logs.filter((line) => /HARD.*executed=true/.test(line))).toHaveLength(1);
            expect(f.meta().cachedM0Bytes?.toString().includes("<project-memory>")).toBe(
                !memoryEnabled,
            );
            expect(replay.logs.filter((line) => /HARD.*executed=true/.test(line))).toEqual([]);
            expect(replay.bytes).toBe(changed.bytes);
        } finally {
            await f.cleanup();
        }
    }
});

test.skipIf(!process.env.REVIEW709_RESTART_PHASE)("issue 709 restart child", async () => {
    const f = await fixture(5709);
    try {
        const output = await f.pass();
        const wire = join(f.root, "before-restart.json");
        if (process.env.REVIEW709_RESTART_PHASE === "write") {
            writeFileSync(wire, output.bytes);
            f.completeResponse();
        } else {
            expect(
                output.logs.some((line) => /transform scheduler: .*decision=defer/.test(line)),
            ).toBe(true);
            expect(output.bytes).toBe(readFileSync(wire, "utf8"));
        }
    } finally {
        await f.cleanup();
    }
});

test("issue 709 review: persisted OC2 bytes survive full process restart", async () => {
    const base = join(tmpdir(), "magic-context/oc2-fold-system-hash");
    mkdirSync(base, { recursive: true });
    const root = createTestTempDirFromPath(join(base, "restart-"));
    try {
        for (const phase of ["write", "read"]) {
            const child = Bun.spawn(
                [process.execPath, "test", import.meta.path, "-t", "^issue 709 restart child$"],
                {
                    cwd: process.cwd(),
                    windowsHide: true,
                    env: {
                        ...process.env,
                        REVIEW709_RESTART_PHASE: phase,
                        REVIEW709_RESTART_ROOT: root,
                    },
                    stdout: "pipe",
                    stderr: "pipe",
                },
            );
            const [code, stdout, stderr] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            expect(code, `${phase}: ${stdout}\n${stderr}`).toBe(0);
        }
        console.log(
            "RESTART709 two OS processes, two complete real-hook passes, byte-identical persisted replay",
        );
    } finally {
        cleanupTestTempDir(root);
    }
}, 60000);

test("issue 709 fixes: temporal first application waits for a rebuilding pass and replays", async () => {
    const f = await fixture(7709, { temporal_awareness: false });
    try {
        const before = await f.pass();
        expect(before.bytes).not.toContain("<!-- +9m -->");
        const rows = f.raw
            .prepare("SELECT id,data FROM session_message ORDER BY seq")
            .all() as Array<{ id: string; data: string }>;
        for (const [n, row] of rows.entries()) {
            const data = JSON.parse(row.data);
            data.time.created = 1700000000000 + n * 600000;
            data.time.completed = data.time.created + 1000;
            f.raw
                .prepare("UPDATE session_message SET time_created = ?,data = ? WHERE id = ?")
                .run(data.time.created, JSON.stringify(data), row.id);
        }
        // Enabling temporal awareness after a restart must not rewrite the warm prefix.
        f.config.temporal_awareness = true;
        await f.start();
        const defer = await f.pass();
        expect(defer.bytes).toBe(before.bytes);
        expect(defer.logs.join("\n")).toContain("decision=defer");
        f.switchModel();
        const rebuild = await f.pass();
        expect(rebuild.bytes).toContain("<!-- +9m -->");
        expect(rebuild.logs.join("\n")).toContain("bustsServedPrefix=true");
        const replay = await f.pass();
        expect(replay.bytes).toBe(rebuild.bytes);
        expect(replay.logs.join("\n")).toContain("decision=defer");
    } finally {
        await f.cleanup();
    }
});
