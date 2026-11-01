import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
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
import vectors from "../../../../../test-vectors/project-resolve-v1/resolve.json";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { ENTORHINAL_RESOLVE_DEADLINE_MS } from "../../features/magic-context/memory/entorhinal-resolve";
import { readGitCheckoutMetadata } from "../../features/magic-context/memory/git-common-dir";
import {
    __resetProjectIdentityForTests,
    __setProjectIdentityTestHooks,
    resolveProjectIdentityForSession,
} from "../../features/magic-context/memory/project-identity";
import {
    readRememberedProjectIdentity,
    rememberPinnedProjectIdentity,
} from "../../features/magic-context/memory/project-identity-cache";
import { __setProjectPinWriterForTests } from "../../features/magic-context/memory/project-pin-writer";
import {
    __resetSessionIdentityDecisionsForTests,
    awaitSessionIdentityDecision,
    readSessionIdentityDecision,
    type SessionIdentityDecision,
} from "../../features/magic-context/memory/session-identity-decision";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { recordSessionProjectIdentity } from "../../features/magic-context/session-project-storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import * as compartments from "../../hooks/magic-context/inject-compartments";
import { resetLkgSlotsForTest } from "../../hooks/magic-context/lkg-slot";
import { getDataDir } from "../../shared/data-path";
import * as logger from "../../shared/logger";
import { MagicContextRpcServer } from "../../shared/rpc-server";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import * as hostMedia from "../fold/host-media";
import { gaDatabasePath } from "../store-reader";
import { registerContext } from "./context";
import * as manualDream from "./dream-manual";
import * as dreamTimer from "./dream-timer";
import * as dreamTrigger from "./dream-trigger";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context } from "./types";

const originalEnv = { ...process.env };
const envKeys = [
    "MAGIC_CONTEXT_TEST_DATA_DIR",
    "MAGIC_CONTEXT_STORAGE_DIR",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
] as const;
const fallbackIdentity = `git:${"a".repeat(40)}`;
const projectId = vectors[0].reply.result!.projectId;
let temp: ReturnType<typeof createTestTempDir>;
const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(() => {
    temp = createTestTempDir("mc-v2-session-identity-");
    for (const key of envKeys) process.env[key] = join(temp.dir, key);
    __setProjectIdentityTestHooks({
        execFileSync: (() => "a".repeat(40)) as unknown as typeof execFileSync,
    });
});

afterEach(async () => {
    await __setProjectPinWriterForTests();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    closeDatabase();
    mock.restore();
    __resetSessionIdentityDecisionsForTests();
    __resetProjectIdentityForTests();
    resetCtxReduceRegisteredGloballyForTest();
    resetLkgSlotsForTest();
    for (const key of envKeys) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
    temp.cleanup();
});

function folder(name: string): string {
    const directory = join(temp.dir, name);
    mkdirSync(join(directory, ".git"), { recursive: true });
    return directory;
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
    const reply = structuredClone(vectors[0].reply);
    reply.result!.canonicalRoot = directory;
    let release: (() => void) | undefined;
    // Once released, later resolve receipts reply at once: the move is recorded
    // in microtasks while the resolve receipt needs a full handshake, so the
    // release normally latches before the receipt and the hold only engages
    // when scheduling inverts that order.
    let released = false;
    const fake = {
        connectionFile,
        up: true,
        hold: false,
        // Server-side reply delay in ms, applied after any hold. Lets one test
        // force a post-deadline reply without depending on machine timing.
        delay: 0,
        calls: [] as Record<string, unknown>[],
        onResolve: () => {},
        release: () => {
            released = true;
            release?.();
        },
    };
    const send = (socket: Socket, request: EnvelopeHeader, body: unknown) =>
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
            while (!socket.destroyed) {
                const call = await reader.frame();
                if (call.body.op === "route.open") {
                    send(socket, call.header, { route_channel: 7, route_epoch: 77 });
                } else if (call.body.method === "resolve") {
                    fake.calls.push(call.body);
                    if (!fake.up) {
                        socket.destroy();
                        return;
                    }
                    const held =
                        fake.hold && !released
                            ? new Promise<void>((resolve) => {
                                  release = resolve;
                              })
                            : undefined;
                    fake.onResolve();
                    await held;
                    if (fake.delay > 0)
                        await new Promise<void>((resolve) => {
                            const timer = setTimeout(() => {
                                timers.delete(timer);
                                resolve();
                            }, fake.delay);
                            timers.add(timer);
                        });
                    if (!socket.destroyed) send(socket, call.header, reply);
                } else send(socket, call.header, {});
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
        fake.release();
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return fake;
}

async function harness(
    directory: string,
    observedDirectory: string,
    connectionFile: string,
    dreamerEnabled = false,
) {
    const hostPath = gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest");
    mkdirSync(dirname(hostPath), { recursive: true });
    const store = new Database(hostPath);
    store.exec(`
        CREATE TABLE IF NOT EXISTS session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER NOT NULL, data TEXT);
        CREATE TABLE IF NOT EXISTS session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL);
    `);
    store.close();
    const db = openDatabase(join(process.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
    if (!db) throw new Error("Throwaway context store unavailable");
    const config = MagicContextConfigSchema.parse({
        historian: { disable: true },
        dreamer: { disable: !dreamerEnabled },
        memory: { enabled: true, auto_promote: false },
        subc: { connection_file: connectionFile },
    });
    spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({ config } as ReturnType<
        typeof configLoader.loadPluginConfigDetailed
    >);
    const createGate = storageGate.createV2StorageGate;
    spyOn(storageGate, "createV2StorageGate").mockImplementation((options) =>
        createGate({ ...options, open: async () => db }),
    );
    const hooks = new Map<string, (draft: SessionContext) => Promise<void>>();
    const get = mock(async () => ({ location: { directory: observedDirectory } }));
    const host = {
        location: { directory },
        agent: { transform: async () => {}, reload: async () => {} },
        model: { list: () => [] },
        storage: { get: async () => undefined, set: async () => {} },
        event: { subscribe: async function* () {} },
        tool: { hook: async () => {} },
        session: {
            remove: async () => {},
            compact: async () => {},
            interrupt: async () => ({ interrupted: true }),
            hook: async (name: string, callback: (draft: SessionContext) => Promise<void>) => {
                hooks.set(name, callback);
            },
            get,
        },
    } as unknown as V2Context;
    const duties = await registerContext(host);
    cleanups.push(async () => {
        await duties?.dispose();
    });
    return {
        db,
        get,
        context: (draft: SessionContext) => hooks.get("context")!(draft),
        compaction: (draft: SessionContext) => hooks.get("compaction")!(draft),
        row: (session: string) =>
            (
                db
                    .prepare("SELECT project_path FROM session_projects WHERE session_id = ?")
                    .get(session) as { project_path: string } | null
            )?.project_path,
        memory: (identity: string, content: string) =>
            insertMemory(db, { projectPath: identity, category: "USER_DIRECTIVES", content }),
    };
}

function draft(sessionID: string): SessionContext {
    return {
        sessionID,
        model: { providerID: "openai", id: "gpt-4.1", limit: { context: 1000000 } },
        agent: "build",
        system: [],
        options: {},
        tools: { read: { description: "read file", input: { type: "object" } } },
        messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "continue" }] }],
    };
}

test("resumed v2 context awaits its decision before managed readers and renders the session project", async () => {
    const launch = folder("launch");
    rememberPinnedProjectIdentity(launch, "pj-LAUNCH");
    const directory = folder("resumed");
    const fake = await fakeEndpoint(directory);
    fake.hold = true;
    const host = await harness(launch, directory, fake.connectionFile);
    const session = "ses-v2-resumed";
    expect(resolveProjectIdentityForSession(directory)).toBe(fallbackIdentity);
    host.memory(projectId, "registered session memory");
    host.memory(fallbackIdentity, "wrong fallback memory");
    const entries: (SessionIdentityDecision | undefined)[] = [];
    const remember = hostMedia.rememberHostMedia;
    spyOn(hostMedia, "rememberHostMedia").mockImplementation((messages) => {
        entries.push(readSessionIdentityDecision(session, directory));
        remember(messages);
    });
    const first = draft(session);
    const pending = host.context(first);
    // The held reply cannot complete before this release, so the pass is
    // provably still waiting on its decision here without first serializing
    // behind the multi-hop handshake inside the 500ms resolve deadline.
    expect(entries).toEqual([]);
    expect(host.row(session)).toBeUndefined();
    fake.release();
    await pending;
    expect(entries[0]).toEqual({ directory, identity: projectId });
    expect(host.row(session)).toBe(projectId);
    expect(JSON.stringify(first.messages)).toContain("registered session memory");
    expect(JSON.stringify(first.messages)).not.toContain("wrong fallback memory");
    const next = draft(session);
    await host.context(next);
    expect(JSON.stringify(next.messages)).toContain("registered session memory");
    expect(fake.calls).toEqual([{ method: "resolve", params: { canonicalRoot: directory } }]);
    expect(host.get).toHaveBeenCalledTimes(1);
    expect(resolveProjectIdentityForSession(directory)).toBe(projectId);
});

test("v2 sessions in one directory keep independent decisions without per-pass resolve", async () => {
    const directory = folder("shared");
    const fake = await fakeEndpoint(directory);
    fake.up = false;
    const host = await harness(directory, directory, fake.connectionFile);
    await host.context(draft("ses-v2-A"));
    expect(host.row("ses-v2-A")).toBe(fallbackIdentity);
    fake.up = true;
    await host.context(draft("ses-v2-B"));
    expect(host.row("ses-v2-B")).toBe(projectId);
    for (let i = 0; i < 3; i++) await host.context(draft("ses-v2-A"));
    expect(host.row("ses-v2-A")).toBe(fallbackIdentity);
    // One launch attempt and two independent session attempts; warm passes add none.
    expect(fake.calls).toHaveLength(3);
});

test.each([
    "pin",
    "common-dir",
    "fallback",
] as const)("v2 observed move uses %s without resolve and logs once", async (kind) => {
    const before = folder("before");
    const root = folder("after");
    const directory = join(root, "subfolder");
    mkdirSync(directory);
    rememberPinnedProjectIdentity(before, "pj-BEFORE");
    const commonDir = readGitCheckoutMetadata(root)!.gitCommonDir;
    if (kind !== "fallback") rememberPinnedProjectIdentity(root, "pj-COMMON", commonDir);
    if (kind === "pin") rememberPinnedProjectIdentity(directory, "pj-PIN", commonDir);
    const expected =
        kind === "pin" ? "pj-PIN" : kind === "common-dir" ? "pj-COMMON" : fallbackIdentity;
    const session = `ses-v2-move-${kind}`;
    await awaitSessionIdentityDecision(session, before);
    const fake = await fakeEndpoint(before);
    const host = await harness(before, directory, fake.connectionFile);
    recordSessionProjectIdentity(host.db, session, "pj-BEFORE");
    expect(host.row(session)).toBe("pj-BEFORE");
    host.memory(expected, "moved project memory");
    host.memory("pj-BEFORE", "old project memory");
    const messages: string[] = [];
    spyOn(logger, "log").mockImplementation((message) => {
        messages.push(message);
    });
    const moved = draft(session);
    await host.context(moved);
    await host.context(draft(session));
    expect(readSessionIdentityDecision(session, directory)).toEqual({
        directory,
        identity: expected,
    });
    expect(host.row(session)).toBe(expected);
    expect(JSON.stringify(moved.messages)).toContain("moved project memory");
    expect(JSON.stringify(moved.messages)).not.toContain("old project memory");
    expect(fake.calls).toHaveLength(0);
    expect(messages.filter((message) => message.includes("directory moved"))).toHaveLength(1);
    if (kind !== "pin")
        expect(readRememberedProjectIdentity(directory)?.identity).not.toStartWith("pj-");
});

test("v2 observed move supersedes an initial pending decision", async () => {
    const before = folder("pending");
    const directory = folder("destination");
    rememberPinnedProjectIdentity(directory, "pj-DESTINATION");
    const fake = await fakeEndpoint(before);
    fake.up = false;
    const host = await harness(before, directory, fake.connectionFile);
    fake.up = true;
    fake.hold = true;
    const called = new Promise<void>((resolve) => {
        fake.onResolve = resolve;
    });
    const session = "ses-v2-pending-move";
    const pending = awaitSessionIdentityDecision(session, before, {
        connectionFile: fake.connectionFile,
    });
    // Wait for the receipt before starting the move: the handshake finishes
    // while nothing else competes for the loop, so the concurrent transform
    // below cannot starve the in-flight resolve before it is even sent.
    // Release the old reply when the move is recorded, not after the full
    // transform: cold rendering may outlast the independent 500ms RPC deadline.
    // The latched hold still guarantees the reply lands after the move is
    // recorded, and the pending promise resolves to the moved-to decision
    // whether the late reply beats the deadline or falls back (a post-deadline
    // reply is covered by the timeout control below, not asserted here).
    await called;
    spyOn(logger, "log").mockImplementation((message) => {
        if (message.includes("directory moved")) fake.release();
    });
    const moved = host.context(draft(session));
    // Await the pass first: it records the move (and the release above), so a
    // pass that dies before the move fails here with its real error instead of
    // hanging below on the still-held reply. The late `before` answer then
    // resolves the pending promise to the moved-to decision whether it beats
    // the 500ms deadline or falls back, so this test asserts only that
    // supersession and never the race between the reply and the deadline
    // (a post-deadline reply is covered by the timeout control below).
    await moved;
    expect(await pending).toEqual({ directory, identity: "pj-DESTINATION" });
    expect(host.row(session)).toBe("pj-DESTINATION");
    await host.context(draft(session));
    expect(host.row(session)).toBe("pj-DESTINATION");
    expect(fake.calls).toHaveLength(2);
});

test("a resolve slower than the Entorhinal deadline falls back without pinning pj", async () => {
    const directory = folder("slow-resolve");
    const fake = await fakeEndpoint(directory);
    // The receipt causally postdates the attempt start, so any overshoot past
    // the deadline deterministically takes the timeout path. This control proves
    // a real timeout still falls back instead of pinning the registered identity.
    fake.delay = ENTORHINAL_RESOLVE_DEADLINE_MS + 1;
    const session = "ses-v2-slow-resolve";
    const decision = await awaitSessionIdentityDecision(session, directory, {
        connectionFile: fake.connectionFile,
    });
    expect(decision).toEqual({ directory, identity: fallbackIdentity });
    expect(readRememberedProjectIdentity(directory)?.identity).toBe(fallbackIdentity);
    expect(fake.calls).toHaveLength(1);
});

test("v2 compaction materializes the session decision instead of the launch directory cache", async () => {
    const launch = folder("launch");
    rememberPinnedProjectIdentity(launch, "pj-LAUNCH");
    const directory = folder("folded-session");
    rememberPinnedProjectIdentity(directory, "pj-FOLD");
    const fake = await fakeEndpoint(directory);
    const host = await harness(launch, directory, fake.connectionFile);
    const materialize = spyOn(compartments, "materializeM0").mockReturnValue({
        m0Text: "session checkpoint",
    } as ReturnType<typeof compartments.materializeM0>);
    const input = draft("ses-v2-fold");
    await host.compaction(input);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize.mock.calls[0][0]).toMatchObject({
        projectPath: "pj-FOLD",
        projectDirectory: directory,
        memoryEnabled: true,
    });
    expect(input.result).toEqual({
        summary: "session checkpoint",
        metadata: { keepID: undefined },
    });
    expect(fake.calls).toHaveLength(0);
});

test("v2 manual dream prepares a resumed session decision before selecting its project", async () => {
    const launch = folder("launch");
    rememberPinnedProjectIdentity(launch, "pj-LAUNCH");
    const directory = folder("manual-session");
    rememberPinnedProjectIdentity(directory, "pj-MANUAL");
    const fake = await fakeEndpoint(directory);
    const handlers = spyOn(MagicContextRpcServer.prototype, "handle");
    const run = spyOn(manualDream, "runManualDreamNow").mockResolvedValue({
        summary: {
            ran: [],
            failed: [],
            skippedNoWork: [],
            skipped: [],
            deferredBusy: [],
            backlogBefore: {},
            backlogAfter: {},
        },
        unsupportedTasks: [],
    });
    await harness(launch, directory, fake.connectionFile, true);
    const handler = handlers.mock.calls.find(([method]) => method === "dream")?.[1];
    expect(handler).toBeDefined();
    expect(await handler!({ sessionId: "ses-v2-manual" })).toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({
        projectIdentity: "pj-MANUAL",
        directory,
        sessionId: "ses-v2-manual",
    });
    expect(fake.calls).toHaveLength(0);
});

for (const timeout of [false, true]) {
    test(`v2 Dreamer shares the linked launch decision and never follows a resumed project (timeout=${timeout})`, async () => {
        const root = folder("dream-main");
        const launch = join(temp.dir, "dream-linked");
        const gitdir = join(root, ".git", "worktrees", "dream-linked");
        mkdirSync(launch);
        mkdirSync(gitdir, { recursive: true });
        writeFileSync(join(gitdir, "commondir"), "../..\n");
        writeFileSync(join(launch, ".git"), `gitdir: ${gitdir}\n`);
        expect(resolveProjectIdentityForSession(launch)).toBe(fallbackIdentity);
        const fake = await fakeEndpoint(launch);
        if (timeout) fake.delay = ENTORHINAL_RESOLVE_DEADLINE_MS + 1;
        const timer = spyOn(dreamTimer, "registerV2DreamScheduleTimer").mockReturnValue({
            dispose: async () => {},
        });
        const trigger = spyOn(dreamTrigger, "startDreamTrigger").mockReturnValue({
            dispose: async () => {},
        });
        const expectedIdentity = timeout ? fallbackIdentity : projectId;
        const host = await harness(launch, launch, fake.connectionFile, true);
        expect(timer).toHaveBeenCalledTimes(1);
        expect(timer.mock.calls[0][0]).toMatchObject({
            directory: launch,
            projectIdentity: expectedIdentity,
        });
        expect(trigger).toHaveBeenCalledTimes(1);
        const triggeredProject = trigger.mock.calls[0][1].projectIdentity;
        expect(triggeredProject()).toBe(expectedIdentity);

        const session = `ses-v2-dream-launch-${timeout}`;
        host.memory(expectedIdentity, "launch-scoped Dreamer memory");
        const first = draft(session);
        await host.context(first);
        expect(host.row(session)).toBe(expectedIdentity);
        expect(timer.mock.calls[0][0].projectIdentity).toBe(host.row(session));
        expect(JSON.stringify(first.messages)).toContain("launch-scoped Dreamer memory");
        if (timeout) {
            // No registry answer arrived in time, so nothing proves an owner to pin.
            expect(readRememberedProjectIdentity(launch)?.identity).not.toBe(projectId);
        } else {
            // The fake registry answers via=root with this linked folder as the
            // canonical root, which proves it is registered as its own project, so the
            // worktree keeps its own pin, marked via=root.
            expect(readRememberedProjectIdentity(launch)).toMatchObject({
                identity: projectId,
                via: "root",
            });
        }
        // With a proven root pin saved by the launch decision, the session's own
        // decision reads that pin instead of asking the registry again. Without an
        // answer in time there is no pin, so the session asks once more.
        const resolve = { method: "resolve", params: { canonicalRoot: launch } };
        expect(fake.calls).toEqual(timeout ? [resolve, resolve] : [resolve]);

        const resumed = folder("dream-resumed");
        rememberPinnedProjectIdentity(resumed, "pj-DREAM-RESUMED");
        host.get.mockResolvedValue({ location: { directory: resumed } });
        await host.context(draft(`ses-v2-dream-resumed-${timeout}`));
        expect(host.row(`ses-v2-dream-resumed-${timeout}`)).toBe("pj-DREAM-RESUMED");
        expect(triggeredProject()).toBe(expectedIdentity);
        expect(timer).toHaveBeenCalledTimes(1);
        expect(timer.mock.calls[0][0].projectIdentity).toBe(expectedIdentity);
    });
}
