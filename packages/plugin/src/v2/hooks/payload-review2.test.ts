import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import { createScheduler } from "../../features/magic-context/scheduler";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import { createTagger } from "../../features/magic-context/tagger";
import { resetLkgSlotsForTest } from "../../hooks/magic-context/lkg-slot";
import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import { createTransform, type TransformDeps } from "../../hooks/magic-context/transform";
import type { MessageLike } from "../../hooks/magic-context/transform-operations";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { createV2RustCompactionMarkerStrategy, trimToRecordedBoundary } from "../fold/boundary";
import { rememberHostMedia, resetHostMediaForTests } from "../fold/host-media";
import { V2StoreReaderPool } from "../store-reader";
import { registerContext } from "./context";
import { adaptPayload } from "./payload";
import * as rustMode from "./rust-mode";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context } from "./types";

const BASE = "b604dfe92cc8^";
type Capture = { request: string; writes: string[]; methods: string[] };
const root = resolve(import.meta.dir, "../../../../..");
const packageRoot = join(root, "packages/plugin");

// Run the same fixture in separate Bun processes. git archive extracts BASE,
// the revision before the provider adapter was added, so expected outputs come
// from the historical implementation rather than a rewritten model or a hash.
function childCapture(
    directory: string,
    output: string,
    host: "v1" | "v2",
    setting: "absent" | "full_request",
    lane: string,
): Capture[] {
    const child = spawnSync(process.execPath, ["test", "src/v2/hooks/payload-review2.test.ts"], {
        windowsHide: true,
        cwd: directory,
        env: {
            ...process.env,
            H4_REVIEW2_CAPTURE: output,
            H4_REVIEW2_HOST: host,
            H4_REVIEW2_SETTING: setting,
            H4_REVIEW2_LANE: lane,
        },
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
    });
    if (child.status !== 0)
        throw new Error(`capture fixture failed: ${child.stdout}\n${child.stderr}`);
    return JSON.parse(readFileSync(output, "utf8"));
}
function revisedCapture(
    host: "v1" | "v2",
    setting: "absent" | "full_request",
    lane: string,
): Capture[] {
    const temp = createTestTempDirFromPath(join(root, ".h4-review2-"));
    try {
        return childCapture(packageRoot, join(temp, "capture.json"), host, setting, lane);
    } finally {
        cleanupTestTempDir(temp);
    }
}

function historicalCapture(
    host: "v1" | "v2",
    setting: "absent" | "full_request",
    lane: string,
): Capture[] {
    const temp = createTestTempDirFromPath(join(root, ".h4-review2-"));
    try {
        const archive = spawnSync(
            "git",
            [
                "archive",
                BASE,
                "packages/plugin",
                "packages/retina-local-fs",
                "scripts",
                "package.json",
            ],
            { cwd: root, maxBuffer: 128 * 1024 * 1024, windowsHide: true },
        );
        if (archive.status !== 0) throw new Error(archive.stderr.toString());
        let extendedPath: string | undefined;
        for (let offset = 0; offset + 512 <= archive.stdout.length; ) {
            const header = archive.stdout.subarray(offset, offset + 512);
            if (header.every((byte) => byte === 0)) break;
            const field = (from: number, to: number) =>
                header.subarray(from, to).toString("utf8").replace(/\0.*$/s, "");
            const size = Number.parseInt(field(124, 136).trim() || "0", 8),
                type = field(156, 157);
            const body = archive.stdout.subarray(offset + 512, offset + 512 + size);
            const name = extendedPath ?? [field(345, 500), field(0, 100)].filter(Boolean).join("/");
            if (type === "x") extendedPath = /\d+ path=([^\n]+)\n/.exec(body.toString("utf8"))?.[1];
            else {
                extendedPath = undefined;
                if (type === "0" || type === "") {
                    const destination = join(temp, name);
                    mkdirSync(dirname(destination), { recursive: true });
                    writeFileSync(destination, body);
                }
            }
            offset += 512 + Math.ceil(size / 512) * 512;
        }
        symlinkSync(join(root, "node_modules"), join(temp, "node_modules"), "dir");
        const historicalPackage = join(temp, "packages/plugin");
        symlinkSync(
            join(packageRoot, "node_modules"),
            join(historicalPackage, "node_modules"),
            "dir",
        );
        writeFileSync(
            join(historicalPackage, "src/v2/hooks/payload-review2.test.ts"),
            readFileSync(import.meta.path),
        );
        return childCapture(historicalPackage, join(temp, "capture.json"), host, setting, lane);
    } finally {
        cleanupTestTempDir(temp);
    }
}

class Asset {
    source: Record<string, unknown>;
    constructor(input: { source: Record<string, unknown> }) {
        this.source = input.source;
    }
}
class HostMessage {
    id: string;
    role: string;
    content: Record<string, any>[];
    constructor(id: string, role: string, content: Record<string, any>[]) {
        this.id = id;
        this.role = role;
        this.content = content;
    }
}
function native(
    id: string,
    role = "user",
    parts: unknown[] = [{ type: "text", text: id }],
): MessageLike {
    return {
        info: { id, sessionID: "session", role, model: { providerID: "review", modelID: "model" } },
        parts,
    } as MessageLike;
}
function draft(): SessionContext {
    return {
        sessionID: "session",
        agent: "build",
        model: { providerID: "review", id: "model", limit: { context: 200000 } },
        system: [{ type: "text", text: "host system" }],
        options: { temperature: 0.5 },
        tools: {},
        messages: [
            new HostMessage("A", "user", [
                { type: "text", text: "A" },
                {
                    type: "media",
                    media: new Asset({
                        source: { type: "bytes", mime: "image/png", bytes: "AQID" },
                    }),
                },
            ]),
            {
                id: "T",
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        id: "call",
                        name: "read",
                        input: { path: "fixture" },
                        providerMetadata: { signature: "call" },
                    },
                ],
            },
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: "call",
                        name: "read",
                        result: {
                            type: "content",
                            value: [
                                { type: "text", text: "result" },
                                {
                                    type: "file",
                                    uri: "data:image/png;base64,AQID",
                                    mime: "image/png",
                                    name: "fixture.png",
                                },
                            ],
                        },
                    },
                ],
            },
            { id: "C", role: "user", content: [{ type: "text", text: "C" }] },
        ],
    } as SessionContext;
}

async function capture(
    host: "v1" | "v2",
    setting: "absent" | "full_request",
    lane: string,
): Promise<Capture[]> {
    const clock = spyOn(Date, "now").mockReturnValue(1800000000000);
    const timer = spyOn(performance, "now").mockReturnValue(1000);
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    getOrCreateSessionMeta(db, "session");
    const writes: string[] = [],
        methods: string[] = [],
        snapshots: Capture[] = [];
    const prepare = db.prepare.bind(db),
        exec = db.exec.bind(db);
    const tracedPrepare = (sql: string) => {
        const statement = prepare(sql);
        if (!/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) return statement;
        return new Proxy(statement, {
            get(target, key) {
                const value = Reflect.get(target, key, target);
                if (typeof value !== "function") return value;
                return (...args: unknown[]) => {
                    if (["run", "get", "all"].includes(String(key)))
                        writes.push(JSON.stringify({ sql, args }));
                    return value.apply(target, args);
                };
            },
        });
    };
    const prepareSpy = spyOn(db, "prepare").mockImplementation(tracedPrepare as typeof db.prepare);
    const execSpy = spyOn(db, "exec").mockImplementation((sql: string) => {
        if (!/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) writes.push(JSON.stringify({ sql }));
        return exec(sql);
    });
    const canonical = [
        native("A"),
        native("T", "assistant"),
        native("C"),
        native("X"),
        native("D"),
    ];
    const rows = canonical.map((m, i) => ({
        id: m.info.id!,
        role: m.info.role!,
        parts: m.parts,
        timeCreated: i + 1,
        createdAt: i + 1,
        ordinal: i + 1,
        contributesOrdinal: true,
        hasValidInfo: true,
    }));
    const unregister = setRawMessageProvider("session", {
        readMessages: () => rows,
        readMessageOrdinalPage: (after, limit) =>
            rows
                .filter(
                    (r) =>
                        !after ||
                        r.timeCreated > after.timeCreated ||
                        (r.timeCreated === after.timeCreated && r.id > after.id),
                )
                .slice(0, limit),
        getStoredMessageCount: () => rows.length,
        readMessageOrdinalById: (id) => rows.findIndex((r) => r.id === id) + 1 || null,
        readMessageIdOrdinalsForRange: (from, to) =>
            new Map(
                rows.map((r, i) => [r.id, i + 1] as const).filter(([, i]) => i >= from && i <= to),
            ),
        readMessagePartsById: (id) => {
            const m = canonical.find((m) => m.info.id === id);
            return m
                ? {
                      id,
                      role: m.info.role!,
                      parts: m.parts,
                      createdAt: rows.find((r) => r.id === id)!.timeCreated,
                  }
                : null;
        },
    });
    let response: MessageLike[] = [];
    const deps: TransformDeps = {
        db,
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 90 }),
        contextUsageMap: new Map(),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 50,
        protectedTokens: 4,
        directory: "/hermetic-h4-differential",
        projectPath: "/hermetic-h4-differential",
        memoryConfig: { enabled: false, injectionBudgetTokens: 1000, autoPromote: false },
        historianRunner: "broca",
        storeGeneration: host,
        transformMode: "rust",
        liveModelBySession: new Map([["session", { providerID: "review", modelID: "model" }]]),
        rustModeModuleClient: {
            async call(args) {
                const w = (
                    args.body instanceof Uint8Array
                        ? JSON.parse(new TextDecoder().decode(args.body))
                        : args.body
                ) as { method: string };
                methods.push(w.method);
                return w.method === "transform"
                    ? { decision: "HARD", prefix_bust_permitted: true, native_messages: response }
                    : { ok: true };
            },
        },
    };
    if (setting === "full_request")
        (deps as TransformDeps & { rustPipeline?: string }).rustPipeline = "full_request";
    const transform = createTransform(deps);
    let duties: Awaited<ReturnType<typeof registerContext>> | undefined;
    let contextHook: ((draft: SessionContext) => Promise<void>) | undefined;
    const restores: (() => void)[] = [];
    let storeDirectory: string | undefined;
    let storeWriter: Database | undefined;
    if (lane.startsWith("context")) {
        storeDirectory = createTestTempDirFromPath(join(process.env.XDG_DATA_HOME!, "h4-review2-store-"));
        const path = join(storeDirectory, "fixture.db");
        const store = (storeWriter = new Database(path));
        store.exec(
            "CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,time_updated INTEGER DEFAULT 1,data TEXT); CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
        );
        store
            .prepare(
                "INSERT INTO session VALUES ('session','/hermetic-h4-differential',NULL,1,1,'{}')",
            )
            .run();
        const add = store.prepare(
            "INSERT INTO session_message(id,session_id,type,seq,time_created,data) VALUES (?,'session',?,?,?,?)",
        );
        add.run("A", "user", 1, 1, JSON.stringify({ text: "A" }));
        add.run("X", "user", 2, 2, JSON.stringify({ text: "middle race" }));
        add.run(
            "T",
            "assistant",
            3,
            3,
            JSON.stringify({ text: "reply", model: { providerID: "review", modelID: "model" } }),
        );
        add.run("C", "user", 5, 5, JSON.stringify({ text: "C" }));
        if (lane === "context-checkpoint")
            add.run(
                "checkpoint",
                "compaction",
                4,
                4,
                JSON.stringify({
                    status: "completed",
                    summary: "checkpoint summary",
                    recent: "checkpoint recent",
                }),
            );
        const config = MagicContextConfigSchema.parse({
            transform_mode: "rust",
            ...(setting === "full_request" ? { rust_pipeline: "full_request" } : {}),
            historian: { disable: true, runner: "broca" },
            dreamer: { disable: true },
            memory: { enabled: false },
        });
        const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
            config,
        } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
        const probe = spyOn(storageGate, "probeV2StorageAtBoot").mockResolvedValue(db);
        const module = spyOn(rustMode, "resolveV2RustModeModuleClient").mockReturnValue(
            deps.rustModeModuleClient,
        );
        const open = V2StoreReaderPool.prototype.open;
        const reader = spyOn(V2StoreReaderPool.prototype, "open").mockImplementation(function (
            this: V2StoreReaderPool,
        ) {
            return open.call(this, path);
        });
        restores.push(() => {
            reader.mockRestore();
            module.mockRestore();
            probe.mockRestore();
            load.mockRestore();
        });
        const context = {
            location: { directory: "/hermetic-h4-differential" },
            agent: { transform: async () => {}, reload: async () => {} },
            model: { list: () => [] },
            storage: {
                get: async () => undefined,
                set: async (...args: unknown[]) => {
                    writes.push(JSON.stringify({ host: "storage.set", args }));
                },
            },
            event: { subscribe: async function* () {} },
            tool: { hook: async () => {} },
            session: {
                remove: async () => {},
                compact: async () => {},
                interrupt: async () => ({ interrupted: true }),
                hook: async (name: string, hook: (draft: SessionContext) => Promise<void>) => {
                    if (name === "context") contextHook = hook;
                },
                get: async () => ({ location: { directory: "/hermetic-h4-differential" } }),
            },
        } as unknown as V2Context;
        duties = await registerContext(context);
        if (!contextHook) throw new Error("context hook was not registered");
    }
    try {
        for (let pass = 0; pass < 3; pass++) {
            const hostDraft = draft();
            if (lane === "context-checkpoint")
                hostDraft.messages.splice(hostDraft.messages.length - 1, 0, {
                    id: "checkpoint",
                    role: "user",
                    content: [{ type: "text", text: "checkpoint summary\ncheckpoint recent" }],
                });
            if (pass === 1)
                hostDraft.messages.splice(1, 0, {
                    id: "X",
                    role: "user",
                    content: [{ type: "text", text: "middle race" }],
                });
            if (pass === 2) {
                hostDraft.messages = hostDraft.messages.slice(0, 1);
                storeWriter?.prepare("DELETE FROM session_message WHERE id != 'A'").run();
            }
            if (lane === "checkpoint") {
                if (pass === 0) {
                    appendCompartments(db, "session", [
                        {
                            sequence: 0,
                            startMessage: 1,
                            endMessage: 2,
                            startMessageId: "A",
                            endMessageId: "T",
                            title: "history",
                            content: "history",
                            p1: "history",
                        },
                    ]);
                    createV2RustCompactionMarkerStrategy(() => ({
                        id: "T",
                        role: "assistant",
                        ordinal: 2,
                        parts: [],
                    })).applyDeferred(db, "session", {
                        ordinal: 2,
                        endMessageId: "T",
                        publishedAt: 1800000000000,
                    });
                }
                if (host === "v2") trimToRecordedBoundary(db, "session", hostDraft.messages);
            }
            writes.length = 0;
            methods.length = 0;
            if (host === "v2") {
                rememberHostMedia(hostDraft.messages, "session");
                const mapped = adaptPayload(hostDraft);
                response = structuredClone(mapped.messages);
                if (lane === "restored")
                    response.unshift(
                        native("RESTORED", "assistant", [
                            { type: "text", text: "restored checkpoint row" },
                        ]),
                    );
                if (contextHook) await contextHook(hostDraft);
                else {
                    await transform({}, mapped);
                    mapped.commit();
                }
                await new Promise<void>((done) => setImmediate(done));
                snapshots.push({
                    request: JSON.stringify(hostDraft),
                    writes: [...writes],
                    methods: [...methods],
                });
            } else {
                const input = hostDraft.messages
                    .filter((m) => m.id)
                    .map((m) =>
                        native(
                            m.id!,
                            m.role,
                            m.content.map((p) =>
                                p.type === "text" ? { type: "text", text: p.text } : p,
                            ),
                        ),
                    );
                input.push(
                    native("TOOL", "assistant", [
                        {
                            id: "tool-part",
                            type: "tool",
                            tool: "read",
                            callID: "call-v1",
                            state: {
                                status: "completed",
                                input: { path: "fixture" },
                                output: "result",
                                attachments: [
                                    {
                                        type: "file",
                                        mime: "image/png",
                                        url: "data:image/png;base64,AQID",
                                    },
                                ],
                            },
                        },
                    ]),
                );
                response = structuredClone(input);
                if (lane === "restored") response.unshift(native("RESTORED", "assistant"));
                const out = { messages: input };
                await transform({}, out);
                await new Promise<void>((done) => setImmediate(done));
                snapshots.push({
                    request: JSON.stringify(out),
                    writes: [...writes],
                    methods: [...methods],
                });
            }
        }
        return snapshots;
    } finally {
        await duties?.dispose();
        for (const restore of restores.reverse()) restore();
        storeWriter?.close();
        if (storeDirectory) cleanupTestTempDir(storeDirectory);
        transform.disposeRust();
        unregister();
        prepareSpy.mockRestore();
        execSpy.mockRestore();
        db.close();
        clock.mockRestore();
        timer.mockRestore();
        resetLkgSlotsForTest();
        resetHostMediaForTests();
    }
}

if (process.env.H4_REVIEW2_CAPTURE) {
    test("capture pre-H4 setting-off differential", async () => {
        const result = await capture(
            process.env.H4_REVIEW2_HOST as "v1" | "v2",
            process.env.H4_REVIEW2_SETTING as "absent" | "full_request",
            process.env.H4_REVIEW2_LANE!,
        );
        writeFileSync(process.env.H4_REVIEW2_CAPTURE!, JSON.stringify(result));
        expect(result).toHaveLength(3);
    });
} else {
    for (const host of ["v1", "v2"] as const)
        for (const setting of ["absent", "full_request"] as const)
            for (const lane of host === "v2"
                ? ["ordinary", "checkpoint", "restored", "context", "context-checkpoint"]
                : ["ordinary", "checkpoint", "restored"]) {
                test(`setting-off differential ${host} ${setting} ${lane}: outgoing request and all store writes equal pre-H4`, async () => {
                    const before = historicalCapture(host, setting, lane);
                    const after = revisedCapture(host, setting, lane);
                    expect(before.every((p) => p.methods.includes("transform"))).toBe(true);
                    expect(after.every((p) => p.methods.includes("transform"))).toBe(true);
                    expect(after.map((p) => p.writes)).toEqual(before.map((p) => p.writes));
                    expect(after.map((p) => p.request)).toEqual(before.map((p) => p.request));
                }, 60000);
            }
}
