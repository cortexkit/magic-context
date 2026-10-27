import {
    type ProviderPassMeters,
    withProviderMeters,
} from "../../features/magic-context/provider-meters";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { SingleStoreMigrationRequiredError } from "./single-store-refusal";
/// <reference types="bun-types" />

import { describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type BindIdentity,
    buildFlags,
    buildFrame,
    CLIENT_AUTH_DOMAIN,
    computeProof,
    decodeHeader,
    type EnvelopeHeader,
    encodeFrame,
    FrameType,
    HEADER_LEN,
    PROTOCOL_VERSION,
    Priority,
    type RouteHandle,
    type RouteTarget,
    SERVER_PROOF_DOMAIN,
    StaleRouteHandleError,
    SubcCallError,
    type SubcClient,
    SubcError,
} from "@cortexkit/subc-client";

import { __moduleTransportTest, SubcModuleTransport } from "./module-transport";
import { StoreAheadOfBinaryError } from "./store-ahead-refusal";

function decodedBody(body: unknown): unknown {
    return body instanceof Uint8Array ? JSON.parse(Buffer.from(body).toString("utf8")) : body;
}

class FakeServerReader {
    private buffered = Buffer.alloc(0);
    private readonly iterator: AsyncIterator<Uint8Array>;

    constructor(socket: Socket) {
        this.iterator = socket[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
    }

    async readExact(length: number): Promise<Buffer> {
        while (this.buffered.length < length) {
            const next = await this.iterator.next();
            if (next.done)
                throw new Error("fake subc peer closed before the expected bytes arrived");
            this.buffered = Buffer.concat([this.buffered, Buffer.from(next.value)]);
        }
        const value = this.buffered.subarray(0, length);
        this.buffered = this.buffered.subarray(length);
        return value;
    }
}

async function readAuthMessage(reader: FakeServerReader): Promise<Record<string, unknown>> {
    const length = (await reader.readExact(4)).readUInt32LE(0);
    return JSON.parse((await reader.readExact(length)).toString("utf8")) as Record<string, unknown>;
}

function writeAuthMessage(socket: Socket, value: unknown): void {
    const body = Buffer.from(JSON.stringify(value));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length, 0);
    socket.write(Buffer.concat([length, body]));
}

async function readFrame(
    reader: FakeServerReader,
): Promise<{ header: EnvelopeHeader; body: Uint8Array }> {
    const header = decodeHeader(await reader.readExact(HEADER_LEN));
    const body = header.len === 0 ? new Uint8Array(0) : await reader.readExact(header.len);
    return { header, body };
}

function writeJsonResponse(socket: Socket, request: EnvelopeHeader, body: unknown): void {
    const bytes = Buffer.from(JSON.stringify(body));
    socket.write(
        encodeFrame(
            buildFrame(
                FrameType.Response,
                buildFlags(false, Priority.Interactive, false),
                request.channel,
                request.epoch,
                request.corr,
                bytes,
            ),
        ),
    );
}

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("fake subc server has no TCP port");
    return address.port;
}

function deferred<T = void>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

describe("SubcModuleTransport", () => {
    it("provider RPC meters observe initial and reply-page requests without changing returned bytes", async () => {
        const transport = new SubcModuleTransport("unused-connection-file", "magic-context", 1000);
        const original = JSON.stringify({ messages: ["café 🦀", "x".repeat(100_000)] });
        const id = createHash("sha256").update(original).digest("hex");
        const requests: Uint8Array[] = [];
        const responses: unknown[] = [];
        const client = {
            routeOpen: async () => ({ channel: 7, epoch: 77 }),
            request: async (_route: RouteHandle, body: Uint8Array) => {
                requests.push(new Uint8Array(body));
                const wire = decodedBody(body) as { method: string };
                const index = wire.method === "reply.page" ? 1 : 0;
                const reply = {
                    reply_page: {
                        id,
                        index,
                        total: 2,
                        bytes: Buffer.byteLength(original),
                        data: index === 0 ? original.slice(0, 50_000) : original.slice(50_000),
                    },
                };
                responses.push(reply);
                return reply;
            },
            closeRoute: async () => undefined,
            close: () => undefined,
        } as unknown as SubcClient;
        const internals = transport as unknown as {
            client: SubcClient | null;
            ensureConnected(): Promise<SubcClient>;
        };
        internals.ensureConnected = async () => {
            internals.client = client;
            return client;
        };
        const args = {
            sessionId: "meter",
            projectRoot: "/fixture",
            method: "transform" as const,
            body: { method: "transform", text: "café 🦀" },
        };
        const unmetered = await transport.call(args);
        const outsideRequests = requests
            .splice(0)
            .map((bytes) => Buffer.from(bytes).toString("hex"));
        responses.length = 0;
        let meters!: ProviderPassMeters;
        let metered: unknown;
        await withProviderMeters(
            "meter",
            "OpenCode1",
            "fixture",
            async () => {
                metered = await transport.call(args);
            },
            (row) => {
                meters = row;
            },
        );
        expect(JSON.stringify(metered)).toBe(JSON.stringify(unmetered));
        expect(requests.map((bytes) => Buffer.from(bytes).toString("hex"))).toEqual(
            outsideRequests,
        );
        expect(meters.rpc_count).toBe(2);
        expect(meters.requests.map((row) => row.method)).toEqual(["transform", "reply.page"]);
        expect(meters.rpc_request_bytes).toBe(
            requests.reduce((sum, bytes) => sum + bytes.byteLength, 0),
        );
        expect(meters.rpc_response_json_bytes).toBe(
            responses.reduce(
                (sum, response) => sum + Buffer.byteLength(JSON.stringify(response)),
                0,
            ),
        );
        transport.closeSession("meter");
    });
    it("serializes management dispatch from the call method over the real socket and preserves facade envelopes", async () => {
        const tempDir = createTestTempDirFromPath(join(tmpdir(), "module-dispatch-wire-"));
        const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
        const daemonId = Uint8Array.from({ length: 16 }, (_, index) => 100 + index);
        const serverNonce = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
        const requests: unknown[] = [];
        const finished = deferred();
        let acceptedSocket: Socket | undefined;
        const server = createServer((socket) => {
            acceptedSocket = socket;
            void (async () => {
                const reader = new FakeServerReader(socket);
                const hello = await readAuthMessage(reader);
                const clientNonce = Uint8Array.from(hello.client_nonce as number[]);
                writeAuthMessage(socket, {
                    server_nonce: [...serverNonce],
                    daemon_id: [...daemonId],
                    server_proof: [
                        ...computeProof(
                            key,
                            SERVER_PROOF_DOMAIN,
                            clientNonce,
                            serverNonce,
                            daemonId,
                        ),
                    ],
                });
                await readAuthMessage(reader);
                const route = await readFrame(reader);
                writeJsonResponse(socket, route.header, { route_channel: 7, route_epoch: 77 });
                for (let index = 0; index < 3; index++) {
                    const request = await readFrame(reader);
                    requests.push(JSON.parse(Buffer.from(request.body).toString("utf8")));
                    writeJsonResponse(socket, request.header, { ok: true });
                }
                finished.resolve();
            })().catch(finished.reject);
        });
        finished.promise.catch(() => {});
        let transport: SubcModuleTransport | undefined;
        try {
            const port = await listen(server);
            const connectionFile = join(tempDir, "subc-connection.json");
            writeFileSync(
                connectionFile,
                JSON.stringify({
                    schema: 1,
                    endpoints: [{ host: "127.0.0.1", port }],
                    key: [...key],
                    daemon_id: [...daemonId],
                    pid: process.pid,
                    daemon_ver: "fake-v2",
                }),
            );
            chmodSync(connectionFile, 0o600);
            transport = new SubcModuleTransport(connectionFile, "magic-context", 1_000);
            const route = { sessionId: "session-1", projectRoot: "/workspace/project" };
            await transport.call({
                ...route,
                method: "session.flush",
                body: { v: 1, session_id: "session-1" },
            });
            await transport.call({
                ...route,
                method: "session.status",
                body: { method: "session.flush", v: 1 },
            });
            await transport.call({
                ...route,
                method: "ctx_memory",
                body: { name: "ctx_memory", arguments: { action: "list" } },
            });
            await finished.promise;
            expect(requests).toEqual([
                {
                    method: "session.flush",
                    v: 1,
                    session_id: "session-1",
                    accept_reply_pages: true,
                },
                { method: "session.status", v: 1, accept_reply_pages: true },
                { name: "ctx_memory", arguments: { action: "list" }, accept_reply_pages: true },
            ]);
        } finally {
            transport?.closeSession("session-1");
            acceptedSocket?.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("omits an ambient supervised identity while preserving route identity and flat request bytes", async () => {
        const tempDir = createTestTempDirFromPath(join(tmpdir(), "module-subc-v2-"));
        const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
        const daemonId = Uint8Array.from({ length: 16 }, (_, index) => 100 + index);
        const serverNonce = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
        let acceptedSocket: Socket | null = null;
        let routeOpenBody: unknown;
        let requestBody: unknown;
        let routeHeader: EnvelopeHeader | null = null;
        let requestHeader: EnvelopeHeader | null = null;
        let goodbyeHeader: EnvelopeHeader | null = null;
        let resolveServer: (() => void) | undefined;
        let rejectServer: ((error: unknown) => void) | undefined;
        const serverWork = new Promise<void>((resolve, reject) => {
            resolveServer = resolve;
            rejectServer = reject;
        });
        const previousModuleId = process.env.SUBC_MODULE_ID;
        const previousLaunchNonce = process.env.SUBC_LAUNCH_NONCE;
        process.env.SUBC_MODULE_ID = "other-supervised-module";
        process.env.SUBC_LAUNCH_NONCE = "a".repeat(64);
        const server = createServer((socket) => {
            acceptedSocket = socket;
            void (async () => {
                const reader = new FakeServerReader(socket);
                const hello = await readAuthMessage(reader);
                const clientNonce = Uint8Array.from(hello.client_nonce as number[]);
                writeAuthMessage(socket, {
                    server_nonce: [...serverNonce],
                    daemon_id: [...daemonId],
                    server_proof: [
                        ...computeProof(
                            key,
                            SERVER_PROOF_DOMAIN,
                            clientNonce,
                            serverNonce,
                            daemonId,
                        ),
                    ],
                });
                const auth = await readAuthMessage(reader);
                expect(auth.client_auth).toEqual([
                    ...computeProof(key, CLIENT_AUTH_DOMAIN, clientNonce, serverNonce, daemonId),
                ]);

                const routeOpen = await readFrame(reader);
                routeHeader = routeOpen.header;
                routeOpenBody = JSON.parse(Buffer.from(routeOpen.body).toString("utf8"));
                writeJsonResponse(socket, routeOpen.header, {
                    route_channel: 7,
                    route_epoch: 77,
                });

                const request = await readFrame(reader);
                requestHeader = request.header;
                requestBody = JSON.parse(Buffer.from(request.body).toString("utf8"));
                writeJsonResponse(socket, request.header, { result: { ok: true } });

                const goodbye = await readFrame(reader);
                goodbyeHeader = goodbye.header;
                socket.destroy();
                resolveServer?.();
            })().catch((error: unknown) => rejectServer?.(error));
        });

        try {
            const port = await listen(server);
            const connectionFile = join(tempDir, "subc-connection.json");
            writeFileSync(
                connectionFile,
                JSON.stringify({
                    schema: 1,
                    endpoints: [{ host: "127.0.0.1", port }],
                    key: [...key],
                    daemon_id: [...daemonId],
                    pid: process.pid,
                    daemon_ver: "fake-v2",
                }),
            );
            chmodSync(connectionFile, 0o600);

            const transport = new SubcModuleTransport(connectionFile, "magic-context", 1_000);
            const flatBody = {
                method: "transform",
                v: 1,
                input: [{ id: "m1" }],
            };
            await expect(
                transport.call({
                    sessionId: "session-1",
                    projectRoot: "/workspace/project",
                    method: "transform",
                    body: flatBody,
                }),
            ).resolves.toEqual({ result: { ok: true } });
            transport.closeSession("session-1");
            await serverWork;

            expect(routeOpenBody).toEqual({
                op: "route.open",
                target: { kind: "tool_provider", module_id: "magic-context" },
                identity: {
                    project_root: "/workspace/project",
                    harness: "opencode",
                    session: "session-1",
                },
            });
            expect(requestBody).toEqual({ ...flatBody, accept_reply_pages: true });
            expect(flatBody).not.toHaveProperty("accept_reply_pages");
            expect(routeHeader).toEqual(
                expect.objectContaining({
                    ver: PROTOCOL_VERSION,
                    ty: FrameType.Request,
                    channel: 0,
                    epoch: 0,
                }),
            );
            expect(requestHeader).toEqual(
                expect.objectContaining({
                    ver: PROTOCOL_VERSION,
                    ty: FrameType.Request,
                    channel: 7,
                    epoch: 77,
                }),
            );
            expect(goodbyeHeader).toEqual(
                expect.objectContaining({
                    ver: PROTOCOL_VERSION,
                    ty: FrameType.Goodbye,
                    channel: 7,
                    epoch: 77,
                }),
            );
        } finally {
            acceptedSocket?.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            rmSync(tempDir, { recursive: true, force: true });
            if (previousModuleId === undefined) delete process.env.SUBC_MODULE_ID;
            else process.env.SUBC_MODULE_ID = previousModuleId;
            if (previousLaunchNonce === undefined) delete process.env.SUBC_LAUNCH_NONCE;
            else process.env.SUBC_LAUNCH_NONCE = previousLaunchNonce;
        }
    });

    it("recognizes a stale route error from a foreign subc-client prototype", () => {
        const foreignStaleRouteError = Object.assign(Object.create(null), {
            name: "StaleRouteHandleError",
            message: "route handle (1, 1) is not live on the current connection",
        });

        expect(foreignStaleRouteError).not.toBeInstanceOf(StaleRouteHandleError);
        expect(__moduleTransportTest.isConnectionFailure(foreignStaleRouteError)).toBe(true);
    });

    it("turns a store-ahead error frame into one typed refusal and does not retry it", async () => {
        const transport = new SubcModuleTransport("unused-connection-file", "magic-context", 100);
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        let requestCount = 0;
        const client = {
            routeOpen: async () => route,
            request: async () => {
                requestCount += 1;
                throw new SubcCallError(
                    "terminal",
                    "storage open refused",
                    "store_ahead_of_binary",
                    new SubcError("storage open refused", "store_ahead_of_binary", {
                        reason_code: "store_ahead_of_binary",
                        db_version: 63,
                        binary_max: 62,
                    }),
                );
            },
            close: () => undefined,
        } as unknown as SubcClient;
        const internals = transport as unknown as {
            client: SubcClient | null;
            ensureConnected(): Promise<SubcClient>;
        };
        internals.ensureConnected = async () => {
            internals.client = client;
            return client;
        };

        const failure = await transport
            .call({
                sessionId: "session-store-ahead",
                projectRoot: "/workspace/project",
                method: "transform",
                body: { method: "transform", v: 1 },
            })
            .then(
                () => null,
                (error: unknown) => error,
            );
        expect(failure).toBeInstanceOf(StoreAheadOfBinaryError);
        expect((failure as StoreAheadOfBinaryError).versions).toEqual({
            dbVersion: 63,
            binaryMax: 62,
        });
        expect(requestCount).toBe(1);
    });

    it("maps required and split store frames to MC-C14 without retrying", async () => {
        for (const code of ["single_store_migration_required", "single_store_state_split"]) {
            const transport = new SubcModuleTransport(
                "unused-connection-file",
                "magic-context",
                100,
            );
            const route = { channel: 7, epoch: 77 } as RouteHandle;
            let requestCount = 0;
            const client = {
                routeOpen: async () => route,
                request: async () => {
                    requestCount += 1;
                    throw new SubcCallError(
                        "terminal",
                        "storage open refused",
                        code,
                        new SubcError("storage open refused", code, {
                            reason_code: code,
                            db_version: 63,
                            binary_max: 62,
                        }),
                    );
                },
                close: () => undefined,
            } as unknown as SubcClient;
            const internals = transport as unknown as {
                client: SubcClient | null;
                ensureConnected(): Promise<SubcClient>;
            };
            internals.ensureConnected = async () => {
                internals.client = client;
                return client;
            };

            const failure = await transport
                .call({
                    sessionId: "session-store-ahead",
                    projectRoot: "/workspace/project",
                    method: "transform",
                    body: { method: "transform", v: 1 },
                })
                .then(
                    () => null,
                    (error: unknown) => error,
                );
            expect(failure).toBeInstanceOf(SingleStoreMigrationRequiredError);
            expect((failure as Error).message).toBe(
                "Magic Context needs a one-time migration of its store. Quit OpenCode and every ck-mc process, then run `magic-context doctor single-store migrate`. (MC-C14)",
            );
            expect(requestCount).toBe(1);
        }
    });

    it("returns a typed generation change instead of retrying a sensitive body", async () => {
        const transport = new SubcModuleTransport("unused-connection-file", "magic-context", 100);
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        let connectionCount = 0;
        const client = {
            routeOpen: async () => route,
            request: async () => {
                throw new Error("client closed");
            },
            close: () => undefined,
        } as unknown as SubcClient;
        const internals = transport as unknown as {
            client: SubcClient | null;
            ensureConnected(): Promise<SubcClient>;
        };
        internals.ensureConnected = async () => {
            connectionCount += 1;
            internals.client = client;
            return client;
        };

        await expect(
            transport.call({
                sessionId: "session-generation-sensitive",
                projectRoot: "/workspace/project",
                method: "state_sync",
                body: { method: "state_sync", v: 1 },
                generationSensitive: true,
            }),
        ).resolves.toEqual({
            transport_status: "connection_generation_changed",
            previous_generation: 0,
            current_generation: 1,
        });
        expect(connectionCount).toBe(1);
    });

    it.each([
        "session.status",
        "transform",
    ] as const)("rebinds an unsent %s when a restarted module leaves a stale route token", async (method) => {
        const tempDir = createTestTempDirFromPath(join(tmpdir(), "module-subc-restart-"));
        const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
        const daemonId = Uint8Array.from({ length: 16 }, (_, index) => 100 + index);
        const serverNonce = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
        const sockets = new Set<Socket>();
        let routeOpenCount = 0;
        let requestCount = 0;
        let serverError: unknown;
        let transport: SubcModuleTransport | null = null;
        const server = createServer((socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            void (async () => {
                const reader = new FakeServerReader(socket);
                const hello = await readAuthMessage(reader);
                const clientNonce = Uint8Array.from(hello.client_nonce as number[]);
                writeAuthMessage(socket, {
                    server_nonce: [...serverNonce],
                    daemon_id: [...daemonId],
                    server_proof: [
                        ...computeProof(
                            key,
                            SERVER_PROOF_DOMAIN,
                            clientNonce,
                            serverNonce,
                            daemonId,
                        ),
                    ],
                });
                const auth = await readAuthMessage(reader);
                expect(auth.client_auth).toEqual([
                    ...computeProof(key, CLIENT_AUTH_DOMAIN, clientNonce, serverNonce, daemonId),
                ]);

                const routeOpen = await readFrame(reader);
                routeOpenCount += 1;
                writeJsonResponse(socket, routeOpen.header, {
                    route_channel: 6 + routeOpenCount,
                    route_epoch: 76 + routeOpenCount,
                });

                const request = await readFrame(reader);
                requestCount += 1;
                writeJsonResponse(socket, request.header, { result: { requestCount } });
            })().catch((error: unknown) => {
                serverError = error;
                socket.destroy();
            });
        });

        try {
            const port = await listen(server);
            const connectionFile = join(tempDir, "subc-connection.json");
            writeFileSync(
                connectionFile,
                JSON.stringify({
                    schema: 1,
                    endpoints: [{ host: "127.0.0.1", port }],
                    key: [...key],
                    daemon_id: [...daemonId],
                    pid: process.pid,
                    daemon_ver: "fake-v2",
                }),
            );
            chmodSync(connectionFile, 0o600);

            transport = new SubcModuleTransport(connectionFile, "magic-context", 1_000);
            const args = {
                sessionId: "session-restart",
                projectRoot: "/workspace/project",
                method,
                body: { method, v: 1 },
            };
            await expect(transport.call(args)).resolves.toEqual({ result: { requestCount: 1 } });

            const internals = transport as unknown as {
                client: { connectionToken: object } | null;
            };
            if (!internals.client) throw new Error("transport did not retain its first connection");
            // Replacing the token emulates a module restart that invalidated the daemon route.
            internals.client.connectionToken = Object.freeze({});

            await expect(transport.call(args)).resolves.toEqual({ result: { requestCount: 2 } });
            expect(routeOpenCount).toBe(2);
            // Only the two intended requests reached the peer; the stale handle
            // rejection never emitted a frame or executed a transform.
            expect(requestCount).toBe(2);
            expect(serverError).toBeUndefined();
        } finally {
            transport?.closeSession("session-restart");
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("bounds canonical-root entries with least-recently-used eviction", () => {
        const transport = new SubcModuleTransport("unused-connection-file");
        const internals = transport as unknown as {
            canonicalRoot(root: string): string;
            canonicalRootCache: Map<string, string>;
        };
        for (let index = 0; index < 256; index += 1) {
            internals.canonicalRoot(`/missing-canonical-root-${index}`);
        }
        // A cache hit refreshes its recency before the next insert evicts an entry.
        internals.canonicalRoot("/missing-canonical-root-0");
        internals.canonicalRoot("/missing-canonical-root-256");

        expect(internals.canonicalRootCache.size).toBe(256);
        expect(internals.canonicalRootCache.has("/missing-canonical-root-0")).toBe(true);
        expect(internals.canonicalRootCache.has("/missing-canonical-root-1")).toBe(false);
    });

    it("allows another session to start while a long wrapup is still in flight", async () => {
        const transport = new SubcModuleTransport("unused-connection-file");
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        const wrapupStarted = deferred();
        const statusStarted = deferred();
        const releaseWrapup = deferred();
        let wrapupSettled = false;
        const client = {
            request: async (_route: RouteHandle, body: unknown) => {
                const method = (decodedBody(body) as { method: string }).method;
                if (method === "session.wrapup") {
                    wrapupStarted.resolve();
                    await releaseWrapup.promise;
                } else {
                    statusStarted.resolve();
                }
                return { result: { ok: true } };
            },
        } as unknown as SubcClient;
        const internals = transport as unknown as {
            client: SubcClient | null;
            ensureRoute: (sessionId: string) => Promise<{
                client: SubcClient;
                route: RouteHandle;
                routeKey: string;
                generation: number;
            }>;
        };
        internals.client = client;
        internals.ensureRoute = async (sessionId) => ({
            client,
            route,
            routeKey: `${sessionId}\0/workspace/project`,
            generation: 0,
        });

        const wrapup = transport
            .call({
                sessionId: "session-a",
                projectRoot: "/workspace/project",
                method: "session.wrapup",
                body: { method: "session.wrapup", v: 1 },
            })
            .finally(() => {
                wrapupSettled = true;
            });
        await wrapupStarted.promise;
        const status = transport.call({
            sessionId: "session-b",
            projectRoot: "/workspace/project",
            method: "session.status",
            body: { method: "session.status", v: 1 },
        });

        await statusStarted.promise;
        expect(wrapupSettled).toBe(false);
        await expect(status).resolves.toEqual({ result: { ok: true } });
        releaseWrapup.resolve();
        await expect(wrapup).resolves.toEqual({ result: { ok: true } });
    });

    it("executes one session's state sync, transform, and status strictly in submission order", async () => {
        const transport = new SubcModuleTransport("unused-connection-file");
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        const stateSyncStarted = deferred();
        const transformStarted = deferred();
        const releaseStateSync = deferred();
        const releaseTransform = deferred();
        const starts: string[] = [];
        const client = {
            request: async (_route: RouteHandle, body: unknown) => {
                const method = (decodedBody(body) as { method: string }).method;
                starts.push(method);
                if (method === "state_sync") {
                    stateSyncStarted.resolve();
                    await releaseStateSync.promise;
                } else if (method === "transform") {
                    transformStarted.resolve();
                    await releaseTransform.promise;
                }
                return { result: { method } };
            },
        } as unknown as SubcClient;
        const internals = transport as unknown as {
            client: SubcClient | null;
            ensureRoute: () => Promise<{
                client: SubcClient;
                route: RouteHandle;
                routeKey: string;
                generation: number;
            }>;
        };
        internals.client = client;
        internals.ensureRoute = async () => ({
            client,
            route,
            routeKey: "ordered-session\0/workspace/project",
            generation: 0,
        });
        const base = { sessionId: "ordered-session", projectRoot: "/workspace/project" };

        const stateSync = transport.call({
            ...base,
            method: "state_sync",
            body: { method: "state_sync" },
        });
        const transform = transport.call({
            ...base,
            method: "transform",
            body: { method: "transform" },
        });
        const status = transport.call({
            ...base,
            method: "session.status",
            body: { method: "session.status" },
        });

        await stateSyncStarted.promise;
        expect(starts).toEqual(["state_sync"]);
        releaseStateSync.resolve();
        await transformStarted.promise;
        expect(starts).toEqual(["state_sync", "transform"]);
        releaseTransform.resolve();
        await Promise.all([stateSync, transform, status]);
        expect(starts).toEqual(["state_sync", "transform", "session.status"]);
    });

    it("queues session.delete behind an in-flight transform on the same route", async () => {
        const transport = new SubcModuleTransport("unused-connection-file");
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        const transformStarted = deferred();
        const releaseTransform = deferred();
        const starts: string[] = [];
        const client = {
            request: async (_route: RouteHandle, body: unknown) => {
                const method = (decodedBody(body) as { method: string }).method;
                starts.push(method);
                if (method === "transform") {
                    transformStarted.resolve();
                    await releaseTransform.promise;
                }
                return { result: { method } };
            },
        } as unknown as SubcClient;
        const internals = transport as unknown as {
            client: SubcClient | null;
            ensureRoute: () => Promise<{
                client: SubcClient;
                route: RouteHandle;
                routeKey: string;
                generation: number;
            }>;
        };
        internals.client = client;
        internals.ensureRoute = async () => ({
            client,
            route,
            routeKey: "delete-race-session\0/workspace/project",
            generation: 0,
        });
        const transform = transport.call({
            sessionId: "delete-race-session",
            projectRoot: "/workspace/project",
            method: "transform",
            body: { method: "transform" },
        });
        await transformStarted.promise;

        const deletion = transport.deleteSession("delete-race-session", "/workspace/project");
        await Promise.resolve();
        expect(starts).toEqual(["transform"]);
        releaseTransform.resolve();
        await Promise.all([transform, deletion]);
        expect(starts).toEqual(["transform", "session.delete"]);
    });

    it("coalesces concurrent connection recovery and retries two sessions on one fresh generation", async () => {
        const transport = new SubcModuleTransport("unused-connection-file", "magic-context", 1_000);
        const oldRouteA = { channel: 7, epoch: 70 } as RouteHandle;
        const oldRouteB = { channel: 8, epoch: 80 } as RouteHandle;
        const oldRequestsStarted = deferred();
        let oldRequestCount = 0;
        let oldCloseCount = 0;
        const oldClient = {
            request: async () => {
                oldRequestCount += 1;
                if (oldRequestCount === 2) oldRequestsStarted.resolve();
                await oldRequestsStarted.promise;
                throw new Error("client closed");
            },
            close: () => {
                oldCloseCount += 1;
            },
        } as unknown as SubcClient;
        let routeOpenCount = 0;
        const freshRequestSessions: string[] = [];
        const freshClient = {
            routeOpen: async (_target: RouteTarget, identity: BindIdentity) => {
                routeOpenCount += 1;
                return {
                    channel: 20 + routeOpenCount,
                    epoch: 100,
                    session: identity.session,
                } as unknown as RouteHandle;
            },
            request: async (_route: RouteHandle, body: unknown) => {
                const sessionId = (decodedBody(body) as { session_id: string }).session_id;
                freshRequestSessions.push(sessionId);
                return { result: { sessionId } };
            },
            close: () => undefined,
        } as unknown as SubcClient;
        let connectCount = 0;
        const internals = transport as unknown as {
            client: SubcClient | null;
            connectionGeneration: number;
            routes: Map<string, { route: RouteHandle; generation: number }>;
            connectClient(): Promise<SubcClient>;
        };
        internals.client = oldClient;
        internals.routes.set("session-a\0/invalidation-a", { route: oldRouteA, generation: 0 });
        internals.routes.set("session-b\0/invalidation-b", { route: oldRouteB, generation: 0 });
        internals.connectClient = async () => {
            connectCount += 1;
            await Bun.sleep(10);
            return freshClient;
        };

        const [responseA, responseB] = await Promise.all([
            transport.call({
                sessionId: "session-a",
                projectRoot: "/invalidation-a",
                method: "session.status",
                body: { method: "session.status", session_id: "session-a" },
            }),
            transport.call({
                sessionId: "session-b",
                projectRoot: "/invalidation-b",
                method: "session.status",
                body: { method: "session.status", session_id: "session-b" },
            }),
        ]);

        expect(responseA).toEqual({ result: { sessionId: "session-a" } });
        expect(responseB).toEqual({ result: { sessionId: "session-b" } });
        expect(oldCloseCount).toBe(1);
        expect(connectCount).toBe(1);
        expect(internals.connectionGeneration).toBe(1);
        expect(routeOpenCount).toBe(2);
        expect(freshRequestSessions.sort()).toEqual(["session-a", "session-b"]);
    });

    it("coalesces concurrent route opens for the same session and project", async () => {
        const transport = new SubcModuleTransport("unused-connection-file");
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        const routeOpenStarted = deferred();
        const releaseRouteOpen = deferred();
        let routeOpenCount = 0;
        const client = {
            routeOpen: async () => {
                routeOpenCount += 1;
                routeOpenStarted.resolve();
                await releaseRouteOpen.promise;
                return route;
            },
            closeRoute: async () => undefined,
        } as unknown as SubcClient;
        const internals = transport as unknown as {
            client: SubcClient | null;
            ensureRoute: (
                sessionId: string,
                projectRoot: string,
            ) => Promise<{ route: RouteHandle }>;
        };
        internals.client = client;

        const first = internals.ensureRoute("route-session", "/route-project");
        const second = internals.ensureRoute("route-session", "/route-project");
        await routeOpenStarted.promise;
        expect(routeOpenCount).toBe(1);
        releaseRouteOpen.resolve();

        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult.route).toBe(route);
        expect(secondResult.route).toBe(route);
        expect(routeOpenCount).toBe(1);
    });

    it("keeps the aggregate queued-call ceiling across independent session lanes", async () => {
        const transport = new SubcModuleTransport("unused-connection-file");
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        const releaseActiveCalls = deferred();
        const allActiveCallsStarted = deferred();
        let activeCallsStarted = 0;
        const client = {
            request: async (_route: RouteHandle, body: unknown) => {
                if ((decodedBody(body) as { active?: boolean }).active) {
                    activeCallsStarted += 1;
                    if (activeCallsStarted === 4) allActiveCallsStarted.resolve();
                    await releaseActiveCalls.promise;
                }
                return { result: { ok: true } };
            },
        } as unknown as SubcClient;
        const internals = transport as unknown as {
            client: SubcClient | null;
            ensureRoute: (sessionId: string) => Promise<{
                client: SubcClient;
                route: RouteHandle;
                routeKey: string;
                generation: number;
            }>;
        };
        internals.client = client;
        internals.ensureRoute = async (sessionId) => ({
            client,
            route,
            routeKey: `${sessionId}\0/workspace/project`,
            generation: 0,
        });
        const sessions = ["cap-a", "cap-b", "cap-c", "cap-d"];
        const activeCalls = sessions.map((sessionId) =>
            transport.call({
                sessionId,
                projectRoot: "/workspace/project",
                method: "session.status",
                body: { method: "session.status", active: true },
            }),
        );
        await allActiveCallsStarted.promise;
        const queuedCalls = sessions.flatMap((sessionId) =>
            Array.from({ length: 4 }, (_, index) =>
                transport.call({
                    sessionId,
                    projectRoot: "/workspace/project",
                    method: "session.status",
                    body: { method: "session.status", index },
                }),
            ),
        );

        await expect(
            transport.call({
                sessionId: sessions[0],
                projectRoot: "/workspace/project",
                method: "session.status",
                body: { method: "session.status", overflow: true },
            }),
        ).rejects.toMatchObject({ code: "EBUSY" });

        releaseActiveCalls.resolve();
        await Promise.all([...activeCalls, ...queuedCalls]);
    });

    it("keeps wrapup and live status calls beyond a 20-second round without raising the generic deadline", async () => {
        const transport = new SubcModuleTransport("unused-connection-file");
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        let releaseWrapup: (() => void) | undefined;
        let markWrapupStarted: (() => void) | undefined;
        const wrapupStarted = new Promise<void>((resolve) => {
            markWrapupStarted = resolve;
        });
        const observedTimeouts = new Map<string, number>();
        const client = {
            request: async (_route: RouteHandle, body: unknown, options: { timeoutMs: number }) => {
                const method = (decodedBody(body) as { method: string }).method;
                observedTimeouts.set(method, options.timeoutMs);
                if (method === "session.wrapup") {
                    markWrapupStarted?.();
                    await new Promise<void>((resolve) => {
                        releaseWrapup = resolve;
                    });
                }
                return { result: { ok: true } };
            },
        } as unknown as SubcClient;
        const internals = transport as unknown as {
            client: SubcClient | null;
            ensureRoute: () => Promise<{
                client: SubcClient;
                route: RouteHandle;
                routeKey: string;
                generation: number;
            }>;
        };
        internals.client = client;
        internals.ensureRoute = async () => ({
            client,
            route,
            routeKey: "session-wrapup\0/workspace/project",
            generation: 0,
        });

        const wrapup = transport.call({
            sessionId: "session-wrapup",
            projectRoot: "/workspace/project",
            method: "session.wrapup",
            body: { method: "session.wrapup", v: 1 },
        });
        await wrapupStarted;
        const status = transport.call({
            sessionId: "session-wrapup",
            projectRoot: "/workspace/project",
            method: "session.status",
            body: { method: "session.status", v: 1 },
        });
        releaseWrapup?.();
        await expect(wrapup).resolves.toEqual({ result: { ok: true } });
        await expect(status).resolves.toEqual({ result: { ok: true } });
        await transport.call({
            sessionId: "session-generic",
            projectRoot: "/workspace/project",
            method: "session.flush",
            body: { method: "session.flush", v: 1 },
        });

        expect(observedTimeouts.get("session.wrapup")).toBeGreaterThan(20_000);
        expect(observedTimeouts.get("session.status")).toBeGreaterThan(20_000);
        expect(observedTimeouts.get("session.flush")).toBeLessThanOrEqual(15_000);
    });

    it("does not reuse a route cached under an earlier connection generation", async () => {
        const transport = new SubcModuleTransport("unused-connection-file");
        const oldRoute = { channel: 7, epoch: 77 } as RouteHandle;
        const newRoute = { channel: 8, epoch: 88 } as RouteHandle;
        let routeOpenCount = 0;
        const client = {
            routeOpen: async () => {
                routeOpenCount += 1;
                return newRoute;
            },
        } as unknown as SubcClient;
        const projectRoot = "/module-transport-generation-test-root";
        const routeKey = `session-generation\0${projectRoot}`;
        const internals = transport as unknown as {
            client: SubcClient | null;
            connectionGeneration: number;
            routes: Map<string, { route: RouteHandle; generation: number }>;
            ensureRoute: (
                sessionId: string,
                rawProjectRoot: string,
            ) => Promise<{ route: RouteHandle; generation: number }>;
        };
        internals.client = client;
        internals.connectionGeneration = 1;
        internals.routes.set(routeKey, { route: oldRoute, generation: 0 });

        const ensured = await internals.ensureRoute("session-generation", projectRoot);

        expect(routeOpenCount).toBe(1);
        expect(ensured.route).toBe(newRoute);
        expect(ensured.generation).toBe(1);
        expect(internals.routes.get(routeKey)).toEqual({ route: newRoute, generation: 1 });
    });
});

describe("connection backoff in-pass wait", () => {
    function makeBackoffTransport(): {
        transport: SubcModuleTransport;
        internals: {
            nextProbeMs: number;
            connectClient(): Promise<SubcClient>;
        };
        client: SubcClient;
        connectCount: () => number;
    } {
        const transport = new SubcModuleTransport("unused-connection-file", "magic-context", 1_000);
        const route = { channel: 7, epoch: 77 } as RouteHandle;
        let connects = 0;
        const client = {
            routeOpen: async () => route,
            request: async (_route: RouteHandle, body: unknown) => ({
                result: {
                    sessionId: (decodedBody(body) as { session_id?: string }).session_id ?? "ok",
                },
            }),
            close: () => undefined,
        } as unknown as SubcClient;
        const internals = transport as unknown as {
            nextProbeMs: number;
            connectClient(): Promise<SubcClient>;
        };
        internals.connectClient = async () => {
            connects += 1;
            return client;
        };
        return { transport, internals, client, connectCount: () => connects };
    }

    it("waits out an under-budget backoff remainder and serves the pass", async () => {
        const { transport, internals, connectCount } = makeBackoffTransport();
        // A latch armed by an earlier failure with only 300ms left — far under
        // the wait budget. The pass must wait and connect, not fail.
        internals.nextProbeMs = Date.now() + 300;
        const startedAt = performance.now();

        await expect(
            transport.call({
                sessionId: "session-backoff-wait",
                projectRoot: "/workspace/project",
                method: "transform",
                body: { method: "transform", v: 1, session_id: "session-backoff-wait" },
            }),
        ).resolves.toEqual({ result: { sessionId: "session-backoff-wait" } });

        const elapsedMs = performance.now() - startedAt;
        expect(elapsedMs).toBeGreaterThanOrEqual(280);
        // Remainder plus jitter only — no retry ladder, no budget overrun.
        expect(elapsedMs).toBeLessThan(1_000);
        expect(connectCount()).toBe(1);
    });

    it("fails fast when the backoff remainder exceeds the wait budget", async () => {
        const { transport, internals, connectCount } = makeBackoffTransport();
        internals.nextProbeMs = Date.now() + 20_000;
        const startedAt = performance.now();

        await expect(
            transport.call({
                sessionId: "session-backoff-over-budget",
                projectRoot: "/workspace/project",
                method: "transform",
                body: { method: "transform", v: 1 },
            }),
        ).rejects.toMatchObject({ code: "SUBC_CONNECTION_BACKOFF" });

        expect(performance.now() - startedAt).toBeLessThan(1_000);
        expect(connectCount()).toBe(0);
    });

    it("does not serialize sibling sessions behind one session's backoff wait", async () => {
        const { transport, internals, connectCount } = makeBackoffTransport();
        internals.nextProbeMs = Date.now() + 500;
        const startedAt = performance.now();

        const [responseA, responseB] = await Promise.all([
            transport.call({
                sessionId: "session-backoff-a",
                projectRoot: "/workspace/project",
                method: "transform",
                body: { method: "transform", v: 1, session_id: "session-backoff-a" },
            }),
            transport.call({
                sessionId: "session-backoff-b",
                projectRoot: "/workspace/project",
                method: "transform",
                body: { method: "transform", v: 1, session_id: "session-backoff-b" },
            }),
        ]);

        const wallMs = performance.now() - startedAt;
        expect(responseA).toEqual({ result: { sessionId: "session-backoff-a" } });
        expect(responseB).toEqual({ result: { sessionId: "session-backoff-b" } });
        // Each pass waits on its own timer; a serialized (global) wait would pay
        // the ~500ms remainder twice. The connection itself coalesces once.
        expect(wallMs).toBeGreaterThanOrEqual(450);
        expect(wallMs).toBeLessThan(900);
        expect(connectCount()).toBe(1);
    });

    it("stops waiting when the pass is aborted mid-backoff", async () => {
        const { transport, internals, connectCount } = makeBackoffTransport();
        internals.nextProbeMs = Date.now() + 2_000;
        const controller = new AbortController();
        const startedAt = performance.now();
        const call = transport.call({
            sessionId: "session-backoff-abort",
            projectRoot: "/workspace/project",
            method: "transform",
            body: { method: "transform", v: 1 },
            signal: controller.signal,
        });
        setTimeout(() => controller.abort(new Error("turn cancelled")), 50);

        await expect(call).rejects.toThrow("turn cancelled");
        expect(performance.now() - startedAt).toBeLessThan(1_000);
        expect(connectCount()).toBe(0);
    });
});

describe("beforeDeadline orphan safety", () => {
    it("a request rejecting after the deadline lost the race never raises an unhandled rejection", async () => {
        const transport = new SubcModuleTransport("/nonexistent-connection-file");
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown) => {
            unhandled.push(error);
        };
        process.on("unhandledRejection", onUnhandled);
        try {
            let rejectLater: ((error: Error) => void) | undefined;
            const operation = new Promise<never>((_resolve, reject) => {
                rejectLater = reject;
            });
            const beforeDeadline = (
                transport as unknown as {
                    beforeDeadline(
                        op: Promise<never>,
                        deadline: number,
                        detail: string,
                    ): Promise<never>;
                }
            ).beforeDeadline.bind(transport);
            // Deadline already passed relative to the operation: the race loses immediately.
            await expect(beforeDeadline(operation, Date.now() + 5, "test")).rejects.toThrow();
            // The abandoned operation now rejects — exactly what close() does to
            // every pending request when a connection is invalidated.
            rejectLater?.(new Error("client closed"));
            // Give the runtime a macrotask to surface an unhandled rejection if any.
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(unhandled).toHaveLength(0);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });
});

it("a per-call abort preserves the shared client for another session", async () => {
    const transport = new SubcModuleTransport("unused");
    const started = deferred();
    const pending = deferred<unknown>();
    let closed = 0;
    const client = {
        request: async (_route: RouteHandle, body: unknown) => {
            if ((decodedBody(body) as { method: string }).method === "state_sync") {
                started.resolve();
                return pending.promise;
            }
            return { ok: true };
        },
        close: () => {
            closed++;
            pending.reject(new Error("client closed"));
        },
    } as unknown as SubcClient;
    const internals = transport as unknown as {
        client: SubcClient | null;
        ensureRoute: () => Promise<{
            client: SubcClient;
            route: RouteHandle;
            routeKey: string;
            generation: number;
        }>;
    };
    internals.client = client;
    internals.ensureRoute = async () => ({
        client,
        route: { channel: 7, epoch: 77 } as RouteHandle,
        routeKey: "abort",
        generation: 0,
    });
    const controller = new AbortController();
    const reason = Object.assign(new Error("state_sync transport timeout"), {
        code: "state_sync_timeout",
    });
    const call = transport.call({
        sessionId: "slow",
        projectRoot: "/tmp/project",
        method: "state_sync",
        body: { method: "state_sync" },
        signal: controller.signal,
    });
    call.catch(() => {});
    await started.promise;
    controller.abort(reason);
    await expect(call).rejects.toBe(reason);
    expect(closed).toBe(0);
    await expect(
        transport.call({
            sessionId: "other",
            projectRoot: "/tmp/project",
            method: "session.status",
            body: { method: "session.status" },
        }),
    ).resolves.toEqual({ ok: true });
    pending.resolve({ ok: true });
});

it("attributes encode, route, request issue, response wait and settlement on one call", async () => {
    const transport = new SubcModuleTransport("unused");
    const route = { channel: 7, epoch: 77 } as RouteHandle;
    const samples: import("./module-transport").ModuleCallTimings[] = [];
    let now = 0;
    let resolveResponse!: (response: { ok: boolean }) => void;
    let signalRequestIssued!: () => void;
    const requestIssued = new Promise<void>((resolve) => {
        signalRequestIssued = resolve;
    });
    const client = {
        request: (_route: RouteHandle, body: unknown, options: { binary?: boolean }) => {
            const response = new Promise<{ ok: boolean }>((resolve) => {
                resolveResponse = resolve;
            });
            signalRequestIssued();
            expect(body).toBeInstanceOf(Uint8Array);
            expect(options.binary).not.toBe(true);
            expect(decodedBody(body)).toEqual({
                method: "transform",
                text: "🚀",
                accept_reply_pages: true,
            });
            return response;
        },
    } as unknown as SubcClient;
    const internals = transport as unknown as {
        client: SubcClient;
        ensureRoute: () => Promise<{
            client: SubcClient;
            route: RouteHandle;
            routeKey: string;
            generation: number;
        }>;
    };
    internals.client = client;
    internals.ensureRoute = async () => {
        now += 10;
        return { client, route, routeKey: "timing", generation: 0 };
    };
    __moduleTransportTest.setMonotonicClockForTests(() => now);
    const startedAt = now;
    try {
        const pending = transport.call({
            sessionId: "timing",
            projectRoot: ".",
            method: "transform",
            body: { method: "transform", text: "🚀" },
            onTimings: (timings) => samples.push(timings),
        });
        await requestIssued;
        now += 20;
        resolveResponse({ ok: true });
        expect(await pending).toEqual({ ok: true });

        const elapsed = now - startedAt;
        expect(samples).toHaveLength(1);
        expect(samples[0]).toEqual({
            lane: 0,
            route: 10,
            encode: 0,
            issue: 0,
            responseWait: 20,
            settle: 0,
        });
        const sum = Object.values(samples[0]).reduce((a, b) => a + b, 0);
        expect(sum).toBe(elapsed);
    } finally {
        __moduleTransportTest.setMonotonicClockForTests(null);
    }
});
