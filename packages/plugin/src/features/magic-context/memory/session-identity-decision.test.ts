import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
    buildFlags,
    buildFrame,
    computeProof,
    decodeHeader,
    type EnvelopeHeader,
    encodeFrame,
    FrameType,
    HEADER_LEN,
    Priority,
    SERVER_PROOF_DOMAIN,
} from "@cortexkit/subc-client";
import vectors from "../../../../../../test-vectors/project-resolve-v1/resolve.json";
import { parsePluginConfig } from "../../../config";
import { createEventHandler } from "../../../hooks/magic-context/event-handler";
import { createTransform } from "../../../hooks/magic-context/transform";
import { createToolRegistry } from "../../../plugin/tool-registry";
import type { PluginContext } from "../../../plugin/types";
import { getHarness } from "../../../shared/harness";
import { Database } from "../../../shared/sqlite";
import { createTestTempDir } from "../../../shared/test-temp-dir";
import { recordSessionProjectIdentity } from "../session-project-storage";
import { closeDatabase, openDatabase } from "../storage";
import { readSessionMeta, updateSessionMeta } from "../storage-meta-session";
import { createTagger } from "../tagger";
import { ENTORHINAL_RESOLVE_DEADLINE_MS } from "./entorhinal-resolve";
import {
    __clearProjectIdentityResolutionCacheForTests,
    __resetProjectIdentityForTests,
    __setProjectIdentityTestHooks,
    resolveProjectIdentityForSession,
} from "./project-identity";
import {
    readRememberedProjectIdentity,
    rememberPinnedProjectIdentity,
} from "./project-identity-cache";
import {
    __resetProjectPinWriterDiagnosticsForTests,
    __setProjectPinWriterForTests,
    flushProjectPinWrites,
    PinWorker,
    ProjectPinWriter,
} from "./project-pin-writer";
import {
    __resetSessionIdentityDecisionsForTests,
    awaitSessionIdentityDecision,
    readSessionIdentityDecision,
} from "./session-identity-decision";
import { getMemoriesByProject, insertMemory } from "./storage-memory";

function registeredReply(directory: string) {
    const reply = structuredClone(vectors[0].reply);
    if (!reply.result) throw new Error("Registered root vector has no result");
    return { ...reply, result: { ...reply.result, canonicalRoot: directory } };
}

const registeredProjectId = registeredReply("").result.projectId;

function hostDatabase() {
    const db = openDatabase();
    if (!db) throw new Error("Fixture database did not open");
    return db;
}

const originalEnv = { ...process.env };
let temp: ReturnType<typeof createTestTempDir>;
let storage: string;
let gitProbes: number;
const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(() => {
    temp = createTestTempDir("mc-session-decision-");
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = temp.dir;
    process.env.XDG_DATA_HOME = temp.dir;
    process.env.XDG_CONFIG_HOME = join(temp.dir, "config");
    process.env.MAGIC_CONTEXT_STORAGE_DIR = join(temp.dir, "cortexkit", "magic-context");
    storage = process.env.MAGIC_CONTEXT_STORAGE_DIR;
    mkdirSync(storage, { recursive: true });
    gitProbes = 0;
    __setProjectIdentityTestHooks({
        execFileSync: (() => {
            gitProbes++;
            return "a".repeat(40);
        }) as unknown as typeof execFileSync,
    });
});

afterEach(async () => {
    closeDatabase();
    await __setProjectPinWriterForTests();
    __resetProjectPinWriterDiagnosticsForTests();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    __resetSessionIdentityDecisionsForTests();
    __resetProjectIdentityForTests();
    for (const key of [
        "MAGIC_CONTEXT_TEST_DATA_DIR",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "MAGIC_CONTEXT_STORAGE_DIR",
    ]) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
    temp.cleanup();
});

function folder(name: string, git = true): string {
    const directory = join(temp.dir, name);
    mkdirSync(git ? join(directory, ".git") : directory, { recursive: true });
    return directory;
}

test("a new worktree session borrows the root pin while an established session keeps git", async () => {
    const main = folder("main");
    const worktree = folder("worktree", false);
    const gitDir = join(main, ".git", "worktrees", "linked");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    const options = { connectionFile: join(temp.dir, "absent.json") };
    const first = await awaitSessionIdentityDecision("established", worktree, options);
    expect(first.identity).toBe(`git:${"a".repeat(40)}`);
    rememberPinnedProjectIdentity(main, "pj-ROOT");
    expect((await awaitSessionIdentityDecision("new", worktree, options)).identity).toBe("pj-ROOT");
    expect(readSessionIdentityDecision("established", worktree, options)?.identity).toBe(
        first.identity,
    );
    expect(resolveProjectIdentityForSession(worktree)).toBe("pj-ROOT");
    expect(await flushProjectPinWrites(2_000)).toBe(true);
    expect(readRememberedProjectIdentity(worktree)).toBeUndefined();
});

function database(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE session_projects (session_id TEXT, harness TEXT, project_path TEXT, updated_at INTEGER, PRIMARY KEY(session_id, harness));
        CREATE TABLE compartment_chunk_embeddings (id INTEGER PRIMARY KEY, session_id TEXT, harness TEXT, project_path TEXT);
    `);
    cleanups.push(() => {
        db.close();
    });
    return db;
}

function row(db: Database, session: string): string | undefined {
    return (
        db
            .prepare(
                "SELECT project_path FROM session_projects WHERE session_id = ? AND harness = ?",
            )
            .get(session, getHarness()) as { project_path: string } | null
    )?.project_path;
}

class PeerReader {
    private buffered = Buffer.alloc(0);
    private readonly iterator: AsyncIterator<Uint8Array>;
    constructor(socket: Socket) {
        this.iterator = socket[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
    }
    async bytes(length: number): Promise<Buffer> {
        while (this.buffered.length < length) {
            const next = await this.iterator.next();
            if (next.done) throw new Error("Fake peer closed");
            this.buffered = Buffer.concat([this.buffered, Buffer.from(next.value)]);
        }
        const bytes = this.buffered.subarray(0, length);
        this.buffered = this.buffered.subarray(length);
        return bytes;
    }
    async auth(): Promise<Record<string, unknown>> {
        return JSON.parse((await this.bytes((await this.bytes(4)).readUInt32LE())).toString());
    }
    async frame(): Promise<{ header: EnvelopeHeader; body: Record<string, unknown> }> {
        const header = decodeHeader(await this.bytes(HEADER_LEN));
        return { header, body: JSON.parse((await this.bytes(header.len)).toString()) };
    }
}

async function fakeEndpoint(directory: string) {
    const connectionFile = join(temp.dir, "non-default-subc.json");
    const key = new Uint8Array(32).fill(9);
    const daemonId = new Uint8Array(16).fill(7);
    const serverNonce = new Uint8Array(32).fill(5);
    const sockets = new Set<Socket>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const fake = {
        connectionFile,
        up: true,
        delay: 0,
        reply: registeredReply(directory),
        calls: [] as Record<string, unknown>[],
        onRoute: (_route: Record<string, unknown>) => {},
    };
    function send(socket: Socket, request: EnvelopeHeader, body: unknown) {
        socket.write(
            encodeFrame(
                buildFrame(
                    FrameType.Response,
                    buildFlags(false, Priority.Interactive, false),
                    request.channel,
                    request.epoch,
                    request.corr,
                    Buffer.from(JSON.stringify(body)),
                ),
            ),
        );
    }
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        void (async () => {
            const reader = new PeerReader(socket);
            const hello = await reader.auth();
            const bytes = Buffer.from(
                JSON.stringify({
                    server_nonce: [...serverNonce],
                    daemon_id: [...daemonId],
                    server_proof: [
                        ...computeProof(
                            key,
                            SERVER_PROOF_DOMAIN,
                            Uint8Array.from(hello.client_nonce as number[]),
                            serverNonce,
                            daemonId,
                        ),
                    ],
                }),
            );
            const size = Buffer.alloc(4);
            size.writeUInt32LE(bytes.length);
            socket.write(Buffer.concat([size, bytes]));
            await reader.auth();
            let channel = 7;
            while (!socket.destroyed) {
                const call = await reader.frame();
                if (call.body.op === "route.open") {
                    fake.onRoute(call.body);
                    send(socket, call.header, { route_channel: channel++, route_epoch: 77 });
                    continue;
                }
                if (call.body.method !== "resolve") {
                    send(socket, call.header, {});
                    continue;
                }
                fake.calls.push(call.body);
                if (!fake.up) {
                    socket.destroy();
                    return;
                }
                const reply = structuredClone(fake.reply);
                if (fake.delay)
                    await new Promise<void>((resolve) => {
                        const timer = setTimeout(() => {
                            timers.delete(timer);
                            resolve();
                        }, fake.delay);
                        timers.add(timer);
                    });
                if (!socket.destroyed) send(socket, call.header, reply);
            }
        })().catch(() => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fake endpoint address");
    writeFileSync(
        connectionFile,
        JSON.stringify({
            schema: 1,
            endpoints: [{ host: "127.0.0.1", port: address.port }],
            key: [...key],
            daemon_id: [...daemonId],
            pid: process.pid,
            daemon_ver: "fake",
        }),
    );
    chmodSync(connectionFile, 0o600);
    cleanups.push(async () => {
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return fake;
}

function sidecars(): string[] {
    try {
        return readdirSync(join(storage, "project-identities")).sort();
    } catch {
        return [];
    }
}

describe("session identity decisions", () => {
    test("session start does not await slow pin persistence", async () => {
        const directory = folder("slow-pin");
        const fake = await fakeEndpoint(directory);
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        let writes = 0;
        const writer = new ProjectPinWriter(async () => {
            writes++;
            await pending;
        });
        await __setProjectPinWriterForTests(writer);
        const db = hostDatabase();
        const handler = createEventHandler({
            ...hostDeps(db, "slow-start", directory, fake.connectionFile),
            config: { cache_ttl: "5m" },
            compactionHandler: { onCompacted: () => {} },
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const decision = await Promise.race([
                handler({
                    event: {
                        type: "session.created",
                        properties: { info: { id: "slow-start", parentID: "", directory } },
                    },
                }).then(() => readSessionIdentityDecision("slow-start", directory)),
                new Promise<"timed out">((resolve) => {
                    timer = setTimeout(() => resolve("timed out"), 250);
                }),
            ]);
            expect(decision).toEqual({ directory, identity: registeredProjectId });
            expect(row(db, "slow-start")).toBe(registeredProjectId);
            expect(writes).toBe(1);
            expect(readRememberedProjectIdentity(directory)?.identity).toBe(registeredProjectId);
            expect((await awaitSessionIdentityDecision("another-start", directory)).identity).toBe(
                registeredProjectId,
            );
            expect(fake.calls).toHaveLength(1);
            expect(sidecars()).toHaveLength(1);
            expect(
                JSON.parse(readFileSync(join(storage, "project-identities", sidecars()[0]), "utf8"))
                    .identity,
            ).toBe(`git:${"a".repeat(40)}`);
        } finally {
            clearTimeout(timer);
            release();
            await writer.flush(100);
        }
    });
    test("shares one promise and honours a configured non-default connection file", async () => {
        const directory = folder("project");
        const fake = await fakeEndpoint(directory);
        const options = { connectionFile: fake.connectionFile };
        const first = awaitSessionIdentityDecision("shared", directory, options);
        expect(awaitSessionIdentityDecision("shared", directory, options)).toBe(first);
        const decision = await first;
        expect(decision).toEqual({ directory, identity: registeredProjectId });
        expect(fake.calls).toEqual([{ method: "resolve", params: { canonicalRoot: directory } }]);
        for (let i = 0; i < 4; i++)
            expect(readSessionIdentityDecision("shared", directory)?.identity).toBe(
                decision.identity,
            );
        expect(fake.calls).toHaveLength(1);
    });

    test("same-process A stays git after B resolves pj without a second A resolve", async () => {
        const directory = folder("project");
        const fake = await fakeEndpoint(directory);
        fake.up = false;
        const options = { connectionFile: fake.connectionFile };
        const a = await awaitSessionIdentityDecision("A", directory, options);
        expect(a.identity).toBe(`git:${"a".repeat(40)}`);
        fake.up = true;
        const b = await awaitSessionIdentityDecision("B", directory, options);
        expect(b.identity).toBe(registeredProjectId);
        expect(readSessionIdentityDecision("A", directory)?.identity).toBe(a.identity);
        await awaitSessionIdentityDecision("A", directory, options);
        expect(fake.calls).toHaveLength(2);
        expect(resolveProjectIdentityForSession(directory)).toBe(b.identity);
    });

    test.each([
        "pj-OTHER",
        "implicit",
    ])("pin is total against %s and never probes git", async (answer) => {
        const directory = folder("pinned");
        rememberPinnedProjectIdentity(directory, "pj-PIN");
        await flushProjectPinWrites(2_000);
        const fake = await fakeEndpoint(directory);
        fake.reply.result.projectId = answer === "implicit" ? "pj-implicit1-fake" : answer;
        if (answer === "implicit") fake.reply.result.via = "implicit";
        const file = join(storage, "project-identities", sidecars()[0]);
        const bytes = readFileSync(file, "utf8");
        const decision = await awaitSessionIdentityDecision("pinned", directory, {
            connectionFile: fake.connectionFile,
        });
        expect(decision.identity).toBe("pj-PIN");
        expect(fake.calls).toHaveLength(0);
        expect(gitProbes).toBe(0);
        expect(readFileSync(file, "utf8")).toBe(bytes);
    });

    test("move between pins updates the host row and value with one log and no resolve", async () => {
        const a = folder("a"),
            b = folder("b");
        rememberPinnedProjectIdentity(a, "pj-A");
        rememberPinnedProjectIdentity(b, "pj-B");
        const fake = await fakeEndpoint(a);
        const db = database();
        const logs: string[] = [];
        const options = {
            db,
            connectionFile: fake.connectionFile,
            log: (line: string) => logs.push(line),
        };
        const initial = await awaitSessionIdentityDecision("move", a, options);
        recordSessionProjectIdentity(db, "move", initial.identity);
        expect(row(db, "move")).toBe("pj-A");
        const moved = readSessionIdentityDecision("move", b, options);
        recordSessionProjectIdentity(db, "move", moved?.identity);
        expect(row(db, "move")).toBe("pj-B");
        expect((await awaitSessionIdentityDecision("move", b, options)).identity).toBe("pj-B");
        expect(logs).toHaveLength(1);
        expect(fake.calls).toHaveLength(0);
        expect(gitProbes).toBe(0);
    });

    test("a pending initial decision cannot replace the moved-to pin", async () => {
        const a = folder("a"),
            b = folder("b");
        rememberPinnedProjectIdentity(b, "pj-B");
        const fake = await fakeEndpoint(a);
        fake.delay = 100;
        const pending = awaitSessionIdentityDecision("pending", a, {
            connectionFile: fake.connectionFile,
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(readSessionIdentityDecision("pending", b)?.identity).toBe("pj-B");
        expect((await pending).identity).toBe("pj-B");
        expect(readRememberedProjectIdentity(a)?.identity).toBe(registeredProjectId);
        expect(readSessionIdentityDecision("pending", b)?.identity).toBe("pj-B");
        expect(fake.calls).toHaveLength(1);
    });

    test("home guards precede resolve and registered pin reads", async () => {
        const home = folder("home");
        const child = join(home, "sub");
        mkdirSync(child);
        __setProjectIdentityTestHooks({ homeDirectory: () => home });
        for (const directory of [home, child]) {
            const fake = await fakeEndpoint(directory);
            rememberPinnedProjectIdentity(directory, "pj-DISALLOWED");
            const decision = await awaitSessionIdentityDecision(directory, directory, {
                connectionFile: fake.connectionFile,
                allowHomeProject: false,
            });
            expect(decision.identity).toBeUndefined();
            expect(fake.calls).toHaveLength(0);
        }
        expect(gitProbes).toBe(0);
    });

    test("a missing directory retains its legacy dir identity without resolve or writes", async () => {
        const directory = join(temp.dir, "missing");
        const fake = await fakeEndpoint(directory);
        const legacy = resolveProjectIdentityForSession(directory);
        expect(legacy).toStartWith("dir:");
        const before = sidecars();
        const decision = await awaitSessionIdentityDecision("missing", directory, {
            connectionFile: fake.connectionFile,
        });
        expect(decision.identity).toBe(legacy);
        expect(fake.calls).toHaveLength(0);
        expect(sidecars()).toEqual(before);
    });

    test("recordSessionProjectIdentity treats pj- as an identity, not a home path", () => {
        const db = database();
        const home = join(process.cwd(), "pj-project");
        __setProjectIdentityTestHooks({ homeDirectory: () => home });
        recordSessionProjectIdentity(db, "pj", "pj-project");
        expect(row(db, "pj")).toBe("pj-project");
        recordSessionProjectIdentity(db, "home", home);
        expect(row(db, "home")).toBeUndefined();
    });
});

function hostDeps(db: Database, session: string, directory: string, connectionFile: string) {
    return {
        db,
        tagger: createTagger(),
        scheduler: { shouldExecute: () => "defer" as const },
        contextUsageMap: new Map(),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
        historianRunnable: false,
        directory,
        sessionDirectoryBySession: new Map([[session, directory]]),
        subcConnectionFile: connectionFile,
        memoryConfig: { enabled: true, injectionBudgetTokens: 500, autoPromote: false },
    };
}

function messages(session: string) {
    return [
        {
            info: { id: "user-1", role: "user", sessionID: session },
            parts: [{ type: "text", text: "continue" }],
        },
    ];
}

function rendered(output: { messages: unknown[] }): string {
    return JSON.stringify(output.messages);
}

function sessionTools(directory: string, session: string, connectionFile: string) {
    const tools = createToolRegistry({
        ctx: { directory } as PluginContext,
        pluginConfig: parsePluginConfig({ subc: { connection_file: connectionFile } }),
    });
    const context = {
        sessionID: session,
        messageID: "user-1",
        agent: "build",
        directory,
        worktree: directory,
        abort: new AbortController().signal,
        metadata: () => {},
    } as never;
    return { tools, context };
}

describe("OpenCode session decision integration", () => {
    test.each([
        "missing row",
        "stale row",
        "pre-remap row",
        "timeout fallback",
    ])("served-owner review: a legacy held prefix retains tool visibility and write scope (%s)", async (legacyState) => {
        const a = folder("legacy-review-a"),
            b = folder("legacy-review-b");
        const oldIdentity =
            legacyState === "pre-remap row" ? resolveProjectIdentityForSession(a)! : "pj-LEGACY-A";
        if (legacyState !== "pre-remap row") rememberPinnedProjectIdentity(a, oldIdentity);
        if (legacyState !== "timeout fallback") rememberPinnedProjectIdentity(b, "pj-LEGACY-B");
        const timeout = legacyState === "timeout fallback" ? await fakeEndpoint(b) : undefined;
        if (timeout) timeout.delay = ENTORHINAL_RESOLVE_DEADLINE_MS * 2;
        const db = hostDatabase();
        const session = "legacy-review-held";
        const alpha = insertMemory(db, {
            projectPath: oldIdentity,
            category: "USER_DIRECTIVES",
            content: "legacy served alpha directive",
        });
        const model = { providerID: "anthropic", modelID: "claude-sonnet-5-5" };
        const deps = {
            ...hostDeps(
                db,
                session,
                a,
                timeout?.connectionFile ?? join(temp.dir, "absent-subc.json"),
            ),
            liveModelBySession: new Map([[session, model]]),
        };
        if (legacyState === "missing row" || timeout) {
            deps.sessionDirectoryBySession.clear();
            Object.assign(deps, {
                client: {
                    session: {
                        get: async () => {
                            throw new Error("host unavailable");
                        },
                    },
                },
            });
        }
        const first = { messages: messages(session) };
        await createTransform(deps)({}, first);
        expect(rendered(first)).toContain(alpha.content);
        // Older cached memory blocks lacked a project-owner marker, even when attribution was missing or named a newer directory.
        updateSessionMeta(db, session, { cachedM0ProjectIdentity: null });
        if (legacyState === "stale row") recordSessionProjectIdentity(db, session, "pj-LEGACY-B");
        if (legacyState === "pre-remap row") rememberPinnedProjectIdentity(a, "pj-LEGACY-REMAPPED");
        __resetSessionIdentityDecisionsForTests();
        const actualDirectory = legacyState === "pre-remap row" ? a : b;
        const { tools, context } = sessionTools(actualDirectory, session, deps.subcConnectionFile);
        const read = await tools.ctx_memory!.execute({ action: "get", ids: [alpha.id] }, context);
        if (timeout) expect(timeout.calls).toHaveLength(1);
        expect(
            await tools.ctx_memory!.execute(
                { action: "write", category: "USER_DIRECTIVES", content: "legacy held write" },
                context,
            ),
        ).toContain("Saved memory");
        expect(
            getMemoriesByProject(db, row(db, session)!).map((memory) => memory.content),
        ).toContain("legacy held write");
        deps.sessionDirectoryBySession.set(session, actualDirectory);
        deps.contextUsageMap.set(session, {
            usage: { percentage: 66, inputTokens: 66000 },
            updatedAt: Date.now(),
            hasUsageTokens: true,
        });
        const held = {
            messages: [
                ...messages(session),
                {
                    info: {
                        id: "legacy-thinking",
                        role: "assistant",
                        sessionID: session,
                        ...model,
                        tokens: { input: 0, output: 1600, reasoning: 1600 },
                    },
                    parts: [
                        { type: "reasoning", text: "signed thinking" },
                        {
                            type: "tool",
                            tool: "read",
                            callID: "legacy-call",
                            state: { status: "completed", output: "contents" },
                        },
                    ],
                },
            ],
        };
        await createTransform(deps)({}, held);
        expect(JSON.stringify(held.messages.slice(0, 2))).toBe(
            JSON.stringify(first.messages.slice(0, 2)),
        );
        expect({
            read,
            writes: getMemoriesByProject(db, oldIdentity).map((memory) => memory.content),
        }).toEqual({
            read: expect.stringContaining(alpha.content),
            writes: expect.arrayContaining(["legacy held write"]),
        });
    });

    test("served-owner review: repeated read tools do not acquire the SQLite writer", async () => {
        const directory = folder("review-read-locks");
        rememberPinnedProjectIdentity(directory, "pj-READ-LOCK");
        const db = hostDatabase();
        const session = "review-read-locks";
        const alpha = insertMemory(db, {
            projectPath: "pj-READ-LOCK",
            category: "USER_DIRECTIVES",
            content: "read lock directive",
        });
        await createTransform(hostDeps(db, session, directory, join(temp.dir, "absent-subc.json")))(
            {},
            { messages: messages(session) },
        );
        const filename = (
            db.prepare("PRAGMA database_list").all() as { name: string; file: string }[]
        ).find((entry) => entry.name === "main")!.file;
        const competingWriter = new Database(filename);
        competingWriter.exec("PRAGMA busy_timeout = 0");
        const transaction = db.transaction.bind(db);
        const holdMilliseconds: number[] = [];
        const transactionMilliseconds: number[] = [];
        let writerBlocked = false;
        const spy = spyOn(db, "transaction").mockImplementation(((
            operation: (...args: unknown[]) => unknown,
        ) => {
            const wrapped = transaction((...args: unknown[]) => {
                const start = performance.now();
                if (holdMilliseconds.length === 0) {
                    try {
                        competingWriter.exec("BEGIN IMMEDIATE");
                        competingWriter.exec("ROLLBACK");
                    } catch (error) {
                        writerBlocked = /locked|busy/i.test(String(error));
                    }
                }
                try {
                    return operation(...args);
                } finally {
                    holdMilliseconds.push(performance.now() - start);
                }
            });
            const immediate = wrapped.immediate.bind(wrapped);
            wrapped.immediate = (...args: unknown[]) => {
                const start = performance.now();
                try {
                    return immediate(...args);
                } finally {
                    transactionMilliseconds.push(performance.now() - start);
                }
            };
            return wrapped;
        }) as typeof db.transaction);
        const stamp = () =>
            db
                .prepare(
                    "SELECT updated_at FROM session_projects WHERE session_id = ? AND harness = ?",
                )
                .get(session, getHarness());
        db.prepare(
            "UPDATE session_projects SET updated_at = 1 WHERE session_id = ? AND harness = ?",
        ).run(session, getHarness());
        const before = stamp();
        try {
            const { tools, context } = sessionTools(
                directory,
                session,
                join(temp.dir, "absent-subc.json"),
            );
            for (let i = 0; i < 20; i++)
                expect(
                    await tools.ctx_memory!.execute({ action: "get", ids: [alpha.id] }, context),
                ).toContain(alpha.content);
            expect(stamp()).toEqual(before);
            console.log(
                "served-owner read burst",
                JSON.stringify({
                    calls: 20,
                    transactions: holdMilliseconds.length,
                    writerBlocked,
                    holdMilliseconds,
                    transactionMilliseconds,
                }),
            );
            expect(holdMilliseconds).toHaveLength(0);
        } finally {
            spy.mockRestore();
            competingWriter.close();
        }
    });

    test("served-owner review: another session's attribution does not add writes to a warm defer", async () => {
        const directory = folder("review-revision");
        rememberPinnedProjectIdentity(directory, "pj-REVISION-A");
        const db = hostDatabase();
        const session = "review-revision";
        const prepare = db.prepare.bind(db);
        const observed: string[] = [];
        const statementSpies: { mockRestore: () => void }[] = [];
        const spy = spyOn(db, "prepare").mockImplementation(((sql: string) => {
            const statement = prepare(sql);
            if (sql.includes("session_projects")) {
                for (const method of ["run", "get", "all"] as const) {
                    const execute = statement[method].bind(statement);
                    statementSpies.push(
                        spyOn(statement, method).mockImplementation(((...args: unknown[]) => {
                            if (args[0] === session) observed.push(`${method}: ${sql}`);
                            return execute(...args);
                        }) as never),
                    );
                }
            }
            return statement;
        }) as typeof db.prepare);
        try {
            const model = { providerID: "anthropic", modelID: "claude-sonnet-5-5" };
            const deps = {
                ...hostDeps(db, session, directory, join(temp.dir, "absent-subc.json")),
                liveModelBySession: new Map([[session, model]]),
                client: {
                    session: {
                        get: async () => {
                            throw new Error("host unavailable");
                        },
                    },
                } as unknown as PluginContext["client"],
            };
            const transform = createTransform(deps);
            const first = { messages: messages(session) };
            await transform({}, first);
            const warm = { messages: messages(session) };
            observed.length = 0;
            await transform({}, warm);
            expect(observed).toEqual([]);
            const thinking = [
                ...messages(session),
                {
                    info: {
                        id: "revision-thinking",
                        role: "assistant",
                        sessionID: session,
                        ...model,
                        tokens: { input: 0, output: 1600, reasoning: 1600 },
                    },
                    parts: [
                        { type: "reasoning", text: "signed thinking" },
                        {
                            type: "tool",
                            tool: "read",
                            callID: "revision-call",
                            state: { status: "completed", output: "contents" },
                        },
                    ],
                },
            ];
            deps.contextUsageMap.set(session, {
                usage: { percentage: 66, inputTokens: 66000 },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            });
            const held = { messages: structuredClone(thinking) };
            await transform({}, held);
            expect(JSON.stringify(held.messages.slice(0, 2))).toBe(
                JSON.stringify(first.messages.slice(0, 2)),
            );
            expect(observed).toEqual([]);
            deps.sessionDirectoryBySession.clear();
            const unresolved = { messages: structuredClone(thinking) };
            await transform({}, unresolved);
            expect(JSON.stringify(unresolved.messages.slice(0, 2))).toBe(
                JSON.stringify(first.messages.slice(0, 2)),
            );
            expect(observed).toEqual([]);
            deps.sessionDirectoryBySession.set(session, directory);
            deps.contextUsageMap.clear();
            recordSessionProjectIdentity(db, "unrelated-session", "pj-REVISION-B");
            observed.length = 0;
            const next = { messages: messages(session) };
            await transform({}, next);
            expect(JSON.stringify(next.messages.slice(0, 2))).toBe(
                JSON.stringify(first.messages.slice(0, 2)),
            );
            expect(observed).toEqual([]);
        } finally {
            for (const statementSpy of statementSpies) statementSpy.mockRestore();
            spy.mockRestore();
        }
    });

    test("a tool decision before the first prefix is not replaced by a guessed launch directory", async () => {
        const a = folder("first-prefix-launch"),
            b = folder("first-prefix-tool");
        rememberPinnedProjectIdentity(a, "pj-FIRST-LAUNCH");
        rememberPinnedProjectIdentity(b, "pj-FIRST-TOOL");
        const db = hostDatabase();
        const session = "first-prefix-tool";
        const connectionFile = join(temp.dir, "absent-subc.json");
        insertMemory(db, {
            projectPath: "pj-FIRST-LAUNCH",
            category: "USER_DIRECTIVES",
            content: "wrong first launch memory",
        });
        const beta = insertMemory(db, {
            projectPath: "pj-FIRST-TOOL",
            category: "USER_DIRECTIVES",
            content: "first tool project memory",
        });
        const { tools, context } = sessionTools(b, session, connectionFile);
        expect(
            await tools.ctx_memory!.execute(
                {
                    action: "write",
                    category: "USER_DIRECTIVES",
                    content: "before first prefix write",
                },
                context,
            ),
        ).toContain("Saved memory");
        const deps = {
            ...hostDeps(db, session, a, connectionFile),
            sessionDirectoryBySession: new Map<string, string>(),
            client: {
                session: {
                    get: async () => {
                        throw new Error("host unavailable");
                    },
                },
            } as unknown as PluginContext["client"],
        };
        const output = { messages: messages(session) };
        await createTransform(deps)({}, output);
        expect(rendered(output)).toContain(beta.content);
        expect(rendered(output)).toContain("before first prefix write");
        expect(rendered(output)).not.toContain("wrong first launch memory");
        expect(readSessionMeta(db, session).cachedM0ProjectIdentity).toBe("pj-FIRST-TOOL");
    });

    test("a legacy cached prefix recovers its exact HARD owner without rebuilding its bytes", async () => {
        const directory = folder("legacy-owner");
        rememberPinnedProjectIdentity(directory, "pj-LEGACY-OWNER");
        const db = hostDatabase();
        const session = "legacy-owner";
        const alpha = insertMemory(db, {
            projectPath: "pj-LEGACY-OWNER",
            category: "USER_DIRECTIVES",
            content: "legacy cached directive",
        });
        const deps = hostDeps(db, session, directory, join(temp.dir, "absent-subc.json"));
        const first = { messages: messages(session) };
        await createTransform(deps)({}, first);
        const materializedAt = readSessionMeta(db, session).cachedM0MaterializedAt;
        updateSessionMeta(db, session, { cachedM0ProjectIdentity: null });
        __resetSessionIdentityDecisionsForTests();
        const upgraded = { messages: messages(session) };
        await createTransform(deps)({}, upgraded);
        expect(JSON.stringify(upgraded.messages.slice(0, 2))).toBe(
            JSON.stringify(first.messages.slice(0, 2)),
        );
        expect(readSessionMeta(db, session).cachedM0MaterializedAt).toBe(materializedAt);
        expect(readSessionMeta(db, session).cachedM0ProjectIdentity).toBe("pj-LEGACY-OWNER");
        const { tools, context } = sessionTools(directory, session, deps.subcConnectionFile);
        expect(
            await tools.ctx_memory!.execute({ action: "get", ids: [alpha.id] }, context),
        ).toContain(alpha.content);
    });

    test("review witness: a tool-first move cannot replace the owner of a held fallback prefix", async () => {
        const a = folder("review-fallback-a");
        const b = folder("review-fallback-b");
        rememberPinnedProjectIdentity(a, "pj-REVIEW-A");
        rememberPinnedProjectIdentity(b, "pj-REVIEW-B");
        const db = hostDatabase();
        const session = "review-fallback-move";
        const alpha = insertMemory(db, {
            projectPath: "pj-REVIEW-A",
            category: "USER_DIRECTIVES",
            content: "review fallback alpha directive",
        });
        const model = { providerID: "anthropic", modelID: "claude-sonnet-5-5" };
        const deps = {
            ...hostDeps(db, session, a, join(temp.dir, "absent-subc.json")),
            sessionDirectoryBySession: new Map<string, string>(),
            liveModelBySession: new Map([[session, model]]),
            client: {
                session: {
                    get: async () => {
                        throw new Error("host unavailable");
                    },
                },
            } as unknown as PluginContext["client"],
        };
        const transform = createTransform(deps);
        const first = { messages: messages(session) };
        await transform({}, first);
        expect(rendered(first)).toContain(alpha.content);
        expect(row(db, session)).toBeUndefined();
        const head = JSON.stringify(first.messages.slice(0, 2));

        const { tools, context } = sessionTools(b, session, deps.subcConnectionFile);
        await tools.ctx_memory!.execute(
            { action: "write", category: "USER_DIRECTIVES", content: "review move write" },
            context,
        );
        deps.sessionDirectoryBySession.set(session, b);
        deps.contextUsageMap.set(session, {
            usage: { percentage: 66, inputTokens: 66000 },
            updatedAt: Date.now(),
            hasUsageTokens: true,
        });
        const held = {
            messages: [
                ...messages(session),
                {
                    info: {
                        id: "review-signed-step",
                        role: "assistant",
                        sessionID: session,
                        ...model,
                        tokens: { input: 0, output: 1600, reasoning: 1600 },
                    },
                    parts: [
                        { type: "reasoning", text: "signed thinking" },
                        {
                            type: "tool",
                            tool: "read",
                            callID: "review-call",
                            state: { status: "completed", output: "contents" },
                        },
                    ],
                },
            ],
        };
        await transform({}, held);
        expect(JSON.stringify(held.messages.slice(0, 2))).toBe(head);
        const read = await tools.ctx_memory!.execute({ action: "get", ids: [alpha.id] }, context);
        const writes = getMemoriesByProject(db, "pj-REVIEW-A").map((memory) => memory.content);
        expect({ read, writes, owner: row(db, session) }).toEqual({
            read: expect.stringContaining(alpha.content),
            writes: expect.arrayContaining(["review move write"]),
            owner: "pj-REVIEW-A",
        });
    });

    test("review witness: a restarted held prefix repairs a stale recorded owner before tools run", async () => {
        const a = folder("review-stale-a");
        const b = folder("review-stale-b");
        rememberPinnedProjectIdentity(a, "pj-REVIEW-STALE-A");
        rememberPinnedProjectIdentity(b, "pj-REVIEW-STALE-B");
        const db = hostDatabase();
        const session = "review-stale-owner";
        const alpha = insertMemory(db, {
            projectPath: "pj-REVIEW-STALE-A",
            category: "USER_DIRECTIVES",
            content: "review persisted alpha directive",
        });
        const model = { providerID: "anthropic", modelID: "claude-sonnet-5-5" };
        const firstDeps = {
            ...hostDeps(db, session, a, join(temp.dir, "absent-subc.json")),
            liveModelBySession: new Map([[session, model]]),
        };
        const first = { messages: messages(session) };
        await createTransform(firstDeps)({}, first);
        // Older transforms recorded the moved owner while replaying the old project's message prefix.
        recordSessionProjectIdentity(db, session, "pj-REVIEW-STALE-B");
        __resetSessionIdentityDecisionsForTests();
        const deps = {
            ...hostDeps(db, session, b, firstDeps.subcConnectionFile),
            liveModelBySession: new Map([[session, model]]),
        };
        deps.contextUsageMap.set(session, {
            usage: { percentage: 66, inputTokens: 66000 },
            updatedAt: Date.now(),
            hasUsageTokens: true,
        });
        const held = {
            messages: [
                ...messages(session),
                {
                    info: {
                        id: "review-resumed-step",
                        role: "assistant",
                        sessionID: session,
                        ...model,
                        tokens: { input: 0, output: 1600, reasoning: 1600 },
                    },
                    parts: [
                        { type: "reasoning", text: "signed thinking" },
                        {
                            type: "tool",
                            tool: "read",
                            callID: "review-resumed-call",
                            state: { status: "completed", output: "contents" },
                        },
                    ],
                },
            ],
        };
        await createTransform(deps)({}, held);
        expect(JSON.stringify(held.messages.slice(0, 2))).toBe(
            JSON.stringify(first.messages.slice(0, 2)),
        );
        const { tools, context } = sessionTools(b, session, deps.subcConnectionFile);
        expect(
            await tools.ctx_memory!.execute({ action: "get", ids: [alpha.id] }, context),
        ).toContain(alpha.content);
    });

    test("review witness: a warm ordinary defer adds no session owner reads", async () => {
        const directory = folder("review-hot-path");
        rememberPinnedProjectIdentity(directory, "pj-REVIEW-HOT");
        const db = hostDatabase();
        const session = "review-hot-path";
        const deps = hostDeps(db, session, directory, join(temp.dir, "absent-subc.json"));
        const transform = createTransform(deps);
        const first = { messages: messages(session) };
        await transform({}, first);
        const prepare = db.prepare.bind(db);
        const ownerReads: string[] = [];
        const spy = spyOn(db, "prepare").mockImplementation(((sql: string) => {
            if (
                sql ===
                "SELECT project_path FROM session_projects WHERE session_id = ? AND harness = ?"
            )
                ownerReads.push(sql);
            return prepare(sql);
        }) as typeof db.prepare);
        try {
            const next = { messages: messages(session) };
            await transform({}, next);
            expect(JSON.stringify(next.messages.slice(0, 2))).toBe(
                JSON.stringify(first.messages.slice(0, 2)),
            );
            expect(ownerReads).toHaveLength(0);
        } finally {
            spy.mockRestore();
        }
    });

    test("a 250 ms session.created, transform and tools agree after caching git", async () => {
        const directory = folder("slow");
        const fake = await fakeEndpoint(directory);
        // Leave half the end-to-end deadline for connection setup and scheduling under load.
        fake.delay = ENTORHINAL_RESOLVE_DEADLINE_MS / 2;
        const db = hostDatabase();
        const session = "slow-created";
        const fallback = resolveProjectIdentityForSession(directory);
        const registered = insertMemory(db, {
            projectPath: registeredProjectId,
            category: "USER_DIRECTIVES",
            content: "registered memory",
        });
        insertMemory(db, {
            projectPath: fallback!,
            category: "USER_DIRECTIVES",
            content: "fallback memory",
        });
        const deps = hostDeps(db, session, directory, fake.connectionFile);
        const handler = createEventHandler({
            ...deps,
            config: { cache_ttl: "5m" },
            compactionHandler: { onCompacted: () => {} },
        });
        const transform = createTransform(deps);
        const output = { messages: messages(session) };
        const created = handler({
            event: {
                type: "session.created",
                properties: { info: { id: session, parentID: "", directory } },
            },
        });
        const firstPass = transform({}, output);
        expect(row(db, session)).toBeUndefined();
        await Promise.all([created, firstPass]);
        expect(row(db, session)).toBe(registeredProjectId);
        expect(rendered(output)).toContain("registered memory");
        expect(rendered(output)).not.toContain("fallback memory");
        expect(resolveProjectIdentityForSession(directory)).toBe(registeredProjectId);
        const { tools, context } = sessionTools(directory, session, fake.connectionFile);
        expect(
            await tools.ctx_memory!.execute({ action: "get", ids: [registered.id] }, context),
        ).toContain("registered memory");
        expect(fake.calls).toHaveLength(1);
    });

    test.each([
        false,
        true,
    ])("tool-first get and write use the shared pj decision (linked=%s)", async (linked) => {
        const root = folder("tool-root");
        const directory = linked ? folder("tool-linked", false) : root;
        if (linked) {
            const gitdir = join(root, ".git", "worktrees", "tool-linked");
            mkdirSync(gitdir, { recursive: true });
            writeFileSync(join(gitdir, "commondir"), "../..\n");
            writeFileSync(join(directory, ".git"), `gitdir: ${gitdir}\n`);
        }
        const fallback = resolveProjectIdentityForSession(directory);
        expect(fallback).toStartWith("git:");
        const fake = await fakeEndpoint(directory);
        const db = hostDatabase();
        const session = `tool-first-${linked}`;
        const existing = insertMemory(db, {
            projectPath: registeredProjectId,
            category: "USER_DIRECTIVES",
            content: "tool-first registered memory",
        });
        const { tools, context } = sessionTools(directory, session, fake.connectionFile);
        const [read, write] = await Promise.all([
            tools.ctx_memory!.execute({ action: "get", ids: [existing.id] }, context),
            tools.ctx_memory!.execute(
                { action: "write", category: "USER_DIRECTIVES", content: "tool-written directive" },
                context,
            ),
        ]);
        expect(read).toContain("tool-first registered memory");
        expect(write).toContain("Saved memory");
        expect(await tools.ctx_search!.execute({ query: `#${existing.id}` }, context)).toContain(
            "tool-first registered memory",
        );
        expect(row(db, session)).toBe(registeredProjectId);
        expect(
            getMemoriesByProject(db, registeredProjectId).map((memory) => memory.content),
        ).toContain("tool-written directive");
        expect(getMemoriesByProject(db, fallback!)).toHaveLength(0);
        if (linked) {
            // The fake registry explicitly registers this folder as a root, not as a borrowed worktree.
            expect(readRememberedProjectIdentity(directory)?.identity).toBe(registeredProjectId);
            expect(readRememberedProjectIdentity(directory)?.via).toBe("root");
        }
        const output = { messages: messages(session) };
        await createTransform(hostDeps(db, session, directory, fake.connectionFile))({}, output);
        expect(rendered(output)).toContain("tool-written directive");
        expect(rendered(output)).toContain("tool-first registered memory");
        expect(fake.calls).toHaveLength(1);
        // The stored session owner survives process-local decision eviction without a pin.
        __resetSessionIdentityDecisionsForTests();
        expect(
            await tools.ctx_memory!.execute({ action: "get", ids: [existing.id] }, context),
        ).toContain("tool-first registered memory");
    });

    test("a tool and injection share the first Entorhinal timeout fallback", async () => {
        const directory = folder("tool-timeout");
        const fake = await fakeEndpoint(directory);
        fake.delay = ENTORHINAL_RESOLVE_DEADLINE_MS * 2;
        const db = hostDatabase();
        const session = "tool-timeout";
        const fallback = resolveProjectIdentityForSession(directory)!;
        insertMemory(db, {
            projectPath: fallback,
            category: "USER_DIRECTIVES",
            content: "first timeout fallback memory",
        });
        const { tools, context } = sessionTools(directory, session, fake.connectionFile);
        const output = { messages: messages(session) };
        await Promise.all([
            tools.ctx_memory!.execute(
                { action: "write", category: "USER_DIRECTIVES", content: "timeout directive" },
                context,
            ),
            createTransform(hostDeps(db, session, directory, fake.connectionFile))({}, output),
        ]);
        expect(row(db, session)).toBe(fallback);
        expect(rendered(output)).toContain("first timeout fallback memory");
        expect(getMemoriesByProject(db, fallback).map((memory) => memory.content)).toContain(
            "timeout directive",
        );
        expect(readSessionIdentityDecision(session, directory)?.identity).toBe(fallback);
        expect(fake.calls).toHaveLength(1);
        const visible = insertMemory(db, {
            projectPath: fallback,
            category: "USER_DIRECTIVES",
            content: "timeout fallback memory",
        });
        const resumed = "timeout-resumed";
        recordSessionProjectIdentity(db, resumed, fallback);
        const next = { messages: messages(resumed) };
        await createTransform(hostDeps(db, resumed, directory, fake.connectionFile))({}, next);
        expect(rendered(next)).toContain(visible.content);
        expect(fake.calls).toHaveLength(1);
    });

    test("a resumed TS transform creates and records its decision before reading memory", async () => {
        const directory = folder("resumed");
        const fake = await fakeEndpoint(directory);
        const db = hostDatabase();
        const session = "resumed";
        insertMemory(db, {
            projectPath: registeredProjectId,
            category: "USER_DIRECTIVES",
            content: "resumed registered memory",
        });
        const transform = createTransform(hostDeps(db, session, directory, fake.connectionFile));
        const output = { messages: messages(session) };
        await transform({}, output);
        expect(row(db, session)).toBe(registeredProjectId);
        expect(rendered(output)).toContain("resumed registered memory");
        const next = { messages: messages(session) };
        await transform({}, next);
        expect(fake.calls).toHaveLength(1);
        expect(rendered(next)).toContain("resumed registered memory");
    });

    test("a newer stored session decision replaces an in-process fallback for injection and tools", async () => {
        const directory = folder("newer-recorded");
        const fake = await fakeEndpoint(directory);
        fake.up = false;
        const db = hostDatabase();
        const session = "newer-recorded";
        expect(
            (
                await awaitSessionIdentityDecision(session, directory, {
                    db,
                    connectionFile: fake.connectionFile,
                })
            ).identity,
        ).toStartWith("git:");
        recordSessionProjectIdentity(db, session, registeredProjectId);
        const memory = insertMemory(db, {
            projectPath: registeredProjectId,
            category: "USER_DIRECTIVES",
            content: "newer stored decision memory",
        });
        const output = { messages: messages(session) };
        await createTransform(hostDeps(db, session, directory, fake.connectionFile))({}, output);
        expect(rendered(output)).toContain(memory.content);
        const { tools, context } = sessionTools(directory, session, fake.connectionFile);
        expect(
            await tools.ctx_memory!.execute({ action: "get", ids: [memory.id] }, context),
        ).toContain(memory.content);
        expect(fake.calls).toHaveLength(1);
    });

    test("a recorded fallback initializes the decision for synchronous session consumers", async () => {
        const directory = folder("recorded-fallback");
        const db = hostDatabase();
        const session = "recorded-fallback";
        recordSessionProjectIdentity(db, session, registeredProjectId);
        const observed: (string | undefined)[] = [];
        const deps = {
            ...hostDeps(db, session, directory, join(temp.dir, "absent-subc.json")),
            sessionDirectoryBySession: new Map<string, string>(),
            client: {
                session: {
                    get: async () => {
                        throw new Error("host unavailable");
                    },
                },
            } as unknown as PluginContext["client"],
            maybeAutoEmbedSession: () =>
                observed.push(readSessionIdentityDecision(session, directory)?.identity),
        };
        await createTransform(deps)({}, { messages: messages(session) });
        expect(observed).toEqual([registeredProjectId]);
        expect(row(db, session)).toBe(registeredProjectId);
    });

    test("a TS directory move renders the new pin and updates session_projects without resolve", async () => {
        const a = folder("root-a"),
            b = folder("root-b");
        rememberPinnedProjectIdentity(a, "pj-A");
        rememberPinnedProjectIdentity(b, "pj-B");
        const fake = await fakeEndpoint(a);
        const db = hostDatabase();
        insertMemory(db, {
            projectPath: "pj-A",
            category: "USER_DIRECTIVES",
            content: "project alpha memory",
        });
        insertMemory(db, {
            projectPath: "pj-B",
            category: "USER_DIRECTIVES",
            content: "project beta memory",
        });
        const session = "moving-transform";
        const deps = hostDeps(db, session, a, fake.connectionFile);
        const transform = createTransform(deps);
        const first = { messages: messages(session) };
        await transform({}, first);
        expect(row(db, session)).toBe("pj-A");
        expect(rendered(first)).toContain("project alpha memory");
        deps.sessionDirectoryBySession.set(session, b);
        const moved = { messages: messages(session) };
        await transform({}, moved);
        expect(row(db, session)).toBe("pj-B");
        expect(rendered(moved)).toContain("project beta memory");
        expect(rendered(moved)).not.toContain("project alpha memory");
        expect(fake.calls).toHaveLength(0);
    });

    test("a directory move keeps tools on the frozen block owner until the signed-thinking hold releases", async () => {
        const a = folder("frozen-a"),
            b = folder("frozen-b");
        rememberPinnedProjectIdentity(a, "pj-FROZEN-A");
        rememberPinnedProjectIdentity(b, "pj-FROZEN-B");
        const db = hostDatabase();
        const session = "frozen-move";
        const alpha = insertMemory(db, {
            projectPath: "pj-FROZEN-A",
            category: "USER_DIRECTIVES",
            content: "frozen project alpha memory",
        });
        const beta = insertMemory(db, {
            projectPath: "pj-FROZEN-B",
            category: "USER_DIRECTIVES",
            content: "released project beta memory",
        });
        const model = { providerID: "anthropic", modelID: "claude-sonnet-5-5" };
        const deps = {
            ...hostDeps(db, session, a, join(temp.dir, "absent-subc.json")),
            liveModelBySession: new Map([[session, model]]),
        };
        const transform = createTransform(deps);
        const first = { messages: messages(session) };
        await transform({}, first);
        expect(rendered(first)).toContain(alpha.content);
        const head = JSON.stringify(first.messages.slice(0, 2));
        const raw = [
            ...messages(session),
            {
                info: {
                    id: "signed-step",
                    role: "assistant",
                    sessionID: session,
                    ...model,
                    tokens: { input: 0, output: 1600, reasoning: 1600 },
                },
                parts: [
                    { type: "reasoning", text: "signed thinking" },
                    {
                        type: "tool",
                        tool: "read",
                        callID: "signed-call",
                        state: { status: "completed", output: "project contents" },
                    },
                ],
            },
        ];
        deps.contextUsageMap.set(session, {
            usage: { percentage: 66, inputTokens: 66000 },
            updatedAt: Date.now(),
            hasUsageTokens: true,
        });
        deps.sessionDirectoryBySession.set(session, b);
        const held = { messages: structuredClone(raw) };
        await transform({}, held);
        expect(JSON.stringify(held.messages.slice(0, 2))).toBe(head);
        expect(row(db, session)).toBe("pj-FROZEN-A");
        const { tools, context } = sessionTools(b, session, deps.subcConnectionFile);
        expect(
            await tools.ctx_memory!.execute({ action: "get", ids: [alpha.id] }, context),
        ).toContain(alpha.content);
        expect(
            await tools.ctx_memory!.execute({ action: "get", ids: [beta.id] }, context),
        ).not.toContain(beta.content);
        const released = {
            messages: [
                ...structuredClone(raw),
                {
                    info: { id: "next-user", role: "user", sessionID: session },
                    parts: [{ type: "text", text: "continue in the new project" }],
                },
            ],
        };
        await transform({}, released);
        expect(rendered(released)).toContain(beta.content);
        expect(rendered(released)).not.toContain(alpha.content);
        expect(row(db, session)).toBe("pj-FROZEN-B");
        expect(
            await tools.ctx_memory!.execute({ action: "get", ids: [beta.id] }, context),
        ).toContain(beta.content);
        expect(
            await tools.ctx_memory!.execute({ action: "get", ids: [alpha.id] }, context),
        ).not.toContain(alpha.content);
    });
});

describe("offline registered identity continuity", () => {
    test.each([
        "down",
        "implicit",
    ])("a worktree and root/sub borrow a common-dir pin with the fake %s and write nothing", async (mode) => {
        const root = folder("root");
        const sub = join(root, "sub");
        mkdirSync(sub);
        const linked = folder("linked", false);
        const gitdir = join(root, ".git", "worktrees", "linked");
        mkdirSync(gitdir, { recursive: true });
        writeFileSync(join(gitdir, "commondir"), "../..\n");
        writeFileSync(join(linked, ".git"), `gitdir: ${gitdir}\n`);
        rememberPinnedProjectIdentity(root, "pj-ROOT", join(root, ".git"));
        await flushProjectPinWrites(2_000);
        const before = sidecars().map((file) =>
            readFileSync(join(storage, "project-identities", file), "utf8"),
        );
        const fake = await fakeEndpoint(root);
        fake.up = mode !== "down";
        if (mode === "implicit")
            fake.reply = structuredClone(vectors[3].reply) as typeof fake.reply;
        for (const directory of [sub, linked]) {
            const decision = await awaitSessionIdentityDecision(directory, directory, {
                connectionFile: fake.connectionFile,
            });
            expect(decision.identity).toBe("pj-ROOT");
            expect(readRememberedProjectIdentity(directory)).toBeUndefined();
        }
        expect(
            sidecars().map((file) =>
                readFileSync(join(storage, "project-identities", file), "utf8"),
            ),
        ).toEqual(before);
        expect(gitProbes).toBe(0);
    });

    test("a re-clone keeps its pin while offline and a never-pinned subfolder leaves the root pin intact", async () => {
        const root = folder("reclone");
        rememberPinnedProjectIdentity(root, "pj-RECLONE", join(root, ".git"));
        await flushProjectPinWrites(2_000);
        const fake = await fakeEndpoint(root);
        fake.up = false;
        const file = join(storage, "project-identities", sidecars()[0]);
        const bytes = readFileSync(file, "utf8");
        rmSync(join(root, ".git"), { recursive: true });
        mkdirSync(join(root, ".git"));
        const sub = join(root, "sub");
        mkdirSync(sub);
        expect(
            (
                await awaitSessionIdentityDecision("reclone", root, {
                    connectionFile: fake.connectionFile,
                })
            ).identity,
        ).toBe("pj-RECLONE");
        expect(
            (
                await awaitSessionIdentityDecision("sub", sub, {
                    connectionFile: fake.connectionFile,
                })
            ).identity,
        ).toBe("pj-RECLONE");
        expect(readFileSync(file, "utf8")).toBe(bytes);
        expect(sidecars()).toHaveLength(1);
        expect(fake.calls).toHaveLength(1);
        expect(gitProbes).toBe(0);
    });

    test("a Rust-managed identity defers a registered answer until its row is cleared", async () => {
        const directory = folder("managed");
        const fake = await fakeEndpoint(directory);
        const db = database();
        const fallback = resolveProjectIdentityForSession(directory);
        db.exec("CREATE TABLE authority_managed (project_path TEXT PRIMARY KEY)");
        db.prepare("INSERT INTO authority_managed VALUES (?)").run(fallback);
        const logs: string[] = [];
        const options = {
            db,
            connectionFile: fake.connectionFile,
            log: (line: string) => logs.push(line),
        };
        expect((await awaitSessionIdentityDecision("managed", directory, options)).identity).toBe(
            fallback,
        );
        expect(readRememberedProjectIdentity(directory)?.identity).toBe(fallback);
        expect(logs).toHaveLength(1);
        await awaitSessionIdentityDecision("managed", directory, options);
        for (let i = 0; i < 3; i++)
            expect(readSessionIdentityDecision("managed", directory, options)?.identity).toBe(
                fallback,
            );
        expect(logs).toHaveLength(1);
        db.exec("DELETE FROM authority_managed");
        expect((await awaitSessionIdentityDecision("migrated", directory, options)).identity).toBe(
            registeredProjectId,
        );
        expect(readRememberedProjectIdentity(directory)?.identity).toBe(registeredProjectId);
        expect(readSessionIdentityDecision("managed", directory, options)?.identity).toBe(fallback);
        expect(fake.calls).toHaveLength(2);
    });

    test("a populated Rust-managed project keeps its identity and data in a fresh session", async () => {
        const directory = folder("populated-managed");
        const fake = await fakeEndpoint(directory);
        const db = hostDatabase();
        const fallback = resolveProjectIdentityForSession(directory)!;
        insertMemory(db, {
            projectPath: fallback,
            category: "USER_DIRECTIVES",
            content: "managed project fact",
        });
        db.prepare(
            "INSERT INTO authority_managed (project_path, context_store_uuid, marked_at) VALUES (?, 'fixture', 1)",
        ).run(fallback);
        const logs: string[] = [];
        const options = {
            db,
            connectionFile: fake.connectionFile,
            log: (line: string) => logs.push(line),
        };
        const decision = await awaitSessionIdentityDecision(
            "populated-managed",
            directory,
            options,
        );
        recordSessionProjectIdentity(db, "populated-managed", decision.identity);
        expect(decision.identity).toBe(fallback);
        expect(row(db, "populated-managed")).toBe(fallback);
        expect(readRememberedProjectIdentity(directory)?.identity).toBe(fallback);
        for (let i = 0; i < 3; i++)
            expect(
                (await awaitSessionIdentityDecision("populated-managed", directory, options))
                    .identity,
            ).toBe(fallback);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain("single-store migration required");
        expect(fake.calls).toHaveLength(1);
        expect(
            db
                .prepare("SELECT COUNT(*) AS count FROM memories WHERE project_path = ?")
                .get(fallback),
        ).toEqual({ count: 1 });
    });

    test("an authority query failure keeps the fallback without pinning", async () => {
        const directory = folder("unreadable-authority");
        const fake = await fakeEndpoint(directory);
        const db = database();
        db.exec("CREATE TABLE authority_managed (wrong_column TEXT)");
        const fallback = resolveProjectIdentityForSession(directory);
        const logs: string[] = [];
        const options = {
            db,
            connectionFile: fake.connectionFile,
            log: (line: string) => logs.push(line),
        };
        const decision = await awaitSessionIdentityDecision("authority-error", directory, options);
        expect(decision.identity).toBe(fallback);
        expect(readRememberedProjectIdentity(directory)?.identity).toBe(fallback);
        await awaitSessionIdentityDecision("authority-error", directory, options);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain("authority check failed");
        expect(fake.calls).toHaveLength(1);
    });

    test.each([
        false,
        true,
    ])("a store with authority table=%s and no matching row accepts and pins pj", async (hasTable) => {
        const directory = folder("unmanaged");
        const fake = await fakeEndpoint(directory);
        const db = database();
        if (hasTable) {
            db.exec(
                "CREATE TABLE authority_managed (project_path TEXT PRIMARY KEY); INSERT INTO authority_managed VALUES ('git:other')",
            );
        }
        const logs: string[] = [];
        const decision = await awaitSessionIdentityDecision("unmanaged", directory, {
            db,
            connectionFile: fake.connectionFile,
            log: (line: string) => logs.push(line),
        });
        expect(decision.identity).toBe(registeredProjectId);
        expect(readRememberedProjectIdentity(directory)?.identity).toBe(registeredProjectId);
        expect(logs).toHaveLength(0);
        expect(fake.calls).toHaveLength(1);
    });
});

describe("local access before registered identity", () => {
    test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
        "an unreadable folder ignores its pj sidecar and keeps the legacy fallback (requires enforced permissions; skipped as root)",
        async () => {
            const directory = folder("unreadable");
            chmodSync(directory, 0);
            cleanups.push(() => chmodSync(directory, 0o700));
            const fallback = resolveProjectIdentityForSession(directory);
            expect(fallback).toStartWith("dir:");
            rememberPinnedProjectIdentity(directory, "pj-UNREADABLE");
            await flushProjectPinWrites(2_000);
            const file = join(storage, "project-identities", sidecars()[0]);
            const bytes = readFileSync(file, "utf8");
            __clearProjectIdentityResolutionCacheForTests();
            const fake = await fakeEndpoint(directory);
            const decision = await awaitSessionIdentityDecision("unreadable", directory, {
                connectionFile: fake.connectionFile,
            });
            expect(decision.identity).toBe(fallback);
            expect(fake.calls).toHaveLength(0);
            expect(readFileSync(file, "utf8")).toBe(bytes);
            expect(sidecars()).toHaveLength(1);
        },
    );
});

describe("session-scoped registry attempts", () => {
    test("fallback transforms never resolve per pass after Entorhinal recovers", async () => {
        const directory = folder("fallback-session");
        const fake = await fakeEndpoint(directory);
        fake.up = false;
        const db = hostDatabase();
        const session = "no-per-pass";
        const deps = hostDeps(db, session, directory, fake.connectionFile);
        const transform = createTransform(deps);
        await transform({}, { messages: messages(session) });
        expect(row(db, session)).toBe(`git:${"a".repeat(40)}`);
        expect(fake.calls).toHaveLength(1);
        fake.up = true;
        await transform({}, { messages: messages(session) });
        expect(fake.calls).toHaveLength(1);
        expect(row(db, session)).toBe(`git:${"a".repeat(40)}`);
        expect(readSessionIdentityDecision(session, directory)?.identity).toBe(
            `git:${"a".repeat(40)}`,
        );
    });
});

test("session decision persists its pin in process when the worker file is missing", async () => {
    const directory = folder("missing-pin-worker");
    const fake = await fakeEndpoint(directory);
    const logs: string[] = [];
    let spawnAttempts = 0;
    const pinWorker = new PinWorker(
        pathToFileURL(join(temp.dir, "missing-project-pin-worker.js")),
        (url) => {
            spawnAttempts++;
            return new Worker(url);
        },
        (message) => logs.push(message),
    );
    const writer = new ProjectPinWriter(pinWorker.write, 256, (message) => logs.push(message));
    await __setProjectPinWriterForTests(writer);

    const decision = await awaitSessionIdentityDecision("missing-worker", directory, {
        connectionFile: fake.connectionFile,
        log: (message) => logs.push(message),
    });
    expect(decision.identity).toBe(registeredProjectId);
    expect(await flushProjectPinWrites(2_000)).toBe(true);

    expect(spawnAttempts).toBe(1);
    expect(readRememberedProjectIdentity(directory)?.identity).toBe(registeredProjectId);
    expect(sidecars()).toHaveLength(1);
    expect(
        JSON.parse(readFileSync(join(storage, "project-identities", sidecars()[0]), "utf8"))
            .identity,
    ).toBe(registeredProjectId);
    expect(logs).toEqual(["[magic-context] pin worker unavailable; writing pins in process"]);
});
