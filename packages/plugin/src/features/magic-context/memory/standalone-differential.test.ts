import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    buildFlags,
    buildFrame,
    computeProof,
    decodeHeader,
    encodeFrame,
    FrameType,
    HEADER_LEN,
    Priority,
    SERVER_PROOF_DOMAIN,
} from "@cortexkit/subc-client";

import { cleanupTestTempDir, createTestTempDirFromPath } from "../../../shared/test-temp-dir";

// Release v0.49.2 supplies the standalone behavior from before registered-project lookup.
const repo = resolve(import.meta.dir, "../../../../../..");
const BASE = readFileSync(resolve(repo, ".github/standalone-differential-base"), "utf8")
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0 && !line.trim().startsWith("#"))!
    .trim();
let scratch: string;
let baseline: string;
let host: string;
let foldHost: string;

// Run both revisions through the real OpenCode transform in separate processes. The same
// checkout paths and fixed clock make directory hashes and cached-prefix bytes comparable.
const hostSource = `
const [root, fixture, connectionFile, mode, storage, runtime] = process.argv.slice(2);
const { execFileSync } = await import("node:child_process");
const { mkdirSync, readdirSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const load = (file) => import(join(root, "packages/plugin/src", file));
const identity = await load("features/magic-context/memory/project-identity.ts");
const { createTransform } = await load("hooks/magic-context/transform.ts");
const { createTagger } = await load("features/magic-context/tagger.ts");
const { openDatabase, closeDatabase } = await load("features/magic-context/storage.ts");
const { insertMemory } = await load("features/magic-context/memory/storage-memory.ts");
const { getHarness } = await load("shared/harness.ts");
const { setHarness } = await load("shared/harness.ts");
if (runtime.startsWith("opencode2")) setHarness("opencode2");
const v2 = runtime.startsWith("opencode2") ? await load("v2/hooks/context.ts") : null;
const pi = runtime === "pi" ? await import(join(root, "packages/pi-plugin/src/context-handler.ts")) : null;
const piUtils = runtime === "pi" ? await import(join(root, "packages/pi-plugin/src/test-utils.test.ts")) : null;
if (pi) setHarness("pi");
let now = 1800000000000;
Date.now = () => now;
let failing = false;
let failedProbes = 0;
identity.__setProjectIdentityTestHooks({
    nowMs: () => now,
    execFileSync: (...args) => {
        if (failing) { failedProbes++; throw new Error("transient git failure"); }
        return execFileSync(...args);
    },
});
const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, windowsHide: true, env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
}, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const db = openDatabase();
if (!db) throw new Error("throwaway host database did not open");
console.log("READY " + process.pid);
// Keep the database open until the parent has inspected the host's file descriptors.
for await (const line of console) { if (line === "continue") break; }
const transcript = [];
const seeded = new Set();
for (const scenario of ["stable", "plain", "unborn", "recovering"]) {
    const directory = join(fixture, scenario);
    const session = "standalone-" + scenario;
    const commit = scenario !== "plain" && scenario !== "unborn"
        ? git(directory, "rev-list", "--max-parents=0", "HEAD") : null;
    const dirIdentity = "dir:" + (await import("node:crypto")).createHash("md5")
        .update(directory).digest("hex").slice(0, 12);
    const expectedGit = scenario === "unborn"
        ? git(directory, "rev-parse", "refs/fixture/first") : commit;
    for (const key of [dirIdentity, expectedGit && "git:" + expectedGit].filter(Boolean)) {
        if (seeded.has(key)) continue;
        seeded.add(key);
        insertMemory(db, { projectPath: key, category: "USER_DIRECTIVES",
            content: "standalone memory for " + key });
    }
    const directories = new Map();
    if (runtime !== "opencode2") directories.set(session, directory);
    const read = Object.assign(() => [], { readPage: () => [], getCount: () => 0 });
    const transform = createTransform({
        ...(v2 ? v2.createHostSeams({}, read, read, new Map()) : {}),
        db, tagger: createTagger(), scheduler: { shouldExecute: () => "defer" },
        contextUsageMap: new Map([[session, {
            usage: { percentage: 70, inputTokens: 140000 },
            updatedAt: Date.now(), hasUsageTokens: true,
        }]]), historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(), lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 50, protectedTokens: 0, historianRunnable: false,
        directory, sessionDirectoryBySession: directories,
        subcConnectionFile: connectionFile,
        memoryConfig: { enabled: true, injectionBudgetTokens: 1000, autoPromote: false },
    });
    const fake = piUtils?.createFakePi();
    if (pi) pi.registerPiContextHandler(fake.pi, { db, protectedTags: 0,
        subcConnectionFile: connectionFile,
        injection: { memoryEnabled: true, injectionBudgetTokens: 1000, injectDocs: false },
    });
    failing = scenario === "recovering";
    for (let phase = 0; phase < 4; phase++) {
        if (phase === 1) {
            failing = false;
            now += 301000;
            if (scenario === "unborn") git(directory, "update-ref", "refs/heads/main", expectedGit);
        }
        let output = { messages: [{ info: { id: "user-1", role: "user", sessionID: session },
            parts: [{ type: "text", text: "continue" }] }] };
        if (v2?.cacheV2SessionDirectory) await v2.cacheV2SessionDirectory({
            get: async () => ({ location: { directory } }),
        }, session, directories);
        if (pi) {
            const messages = [piUtils.userMessage("continue", 1800000000000)];
            output = await fake.handlers.get("context")({ messages },
                piUtils.fakeContext(session, directory, ["user-1"], messages));
        } else await transform({}, output);
        const row = db.prepare("SELECT project_path FROM session_projects WHERE session_id = ? AND harness = ?")
            .get(session, getHarness());
        transcript.push({ scenario, phase, identity: row?.project_path ?? null,
            prefix: JSON.stringify(output.messages) });
    }
    if (pi) pi.clearContextHandlerSession(session);
}
const sidecars = (() => { try { return readdirSync(join(storage, "project-identities"))
    .filter(f => f.endsWith(".json")).map(f => JSON.parse(readFileSync(join(storage, "project-identities", f), "utf8"))); }
    catch { return []; } })();
if (sidecars.length === 0) throw new Error("did not observe the resolver's legacy git records");
if (sidecars.some(record => record.identity.startsWith("pj-"))) throw new Error("standalone wrote a pin");
closeDatabase();
console.log("RESULT " + JSON.stringify({ transcript, failedProbes, mode }));
`;

const foldSource =
    hostSource.slice(0, hostSource.indexOf("const transcript")) +
    `
const { createHash } = await import("node:crypto");
const decisions = (await load("features/magic-context/transform-decision-log.ts")).__test;
const transcript = [];
const seeded = new Set();
for (const scenario of ["outside", "resolved-outside", "revalidate", "move"]) {
    const session = "fold-" + scenario;
    const launch = join(fixture, "plain");
    let directory = scenario === "revalidate" ? join(fixture, "unborn")
        : scenario.endsWith("outside") ? join(fixture, "stable") : launch;
    const target = join(fixture, "stable");
    const key = path => "dir:" + createHash("md5").update(path).digest("hex").slice(0, 12);
    const expectedGit = git(target, "rev-list", "--max-parents=0", "HEAD");
    for (const identity of [key(launch), key(directory), "git:" + expectedGit]) {
        if (seeded.has(identity)) continue;
        seeded.add(identity);
        insertMemory(db, { projectPath: identity, category: "USER_DIRECTIVES",
            content: "fold memory for " + identity });
    }
    const directories = new Map();
    let lookups = 0;
    let unavailable = scenario === "outside";
    const lookup = { get: async () => { lookups++; if (unavailable) throw new Error("retry");
        return { location: { directory } }; } };
    let requests = 0;
    const pending = new class extends Set { add(value) { requests++; return super.add(value); } }();
    const read = Object.assign(() => [], { readPage: () => [], getCount: () => 0 });
    const models = new Map([[session, { providerID: "anthropic", modelID: "claude-fable-5-1" }]]);
    const transform = createTransform({
        ...v2.createHostSeams({}, read, read, models),
        db, tagger: createTagger(), scheduler: { shouldExecute: () => "defer" },
        contextUsageMap: new Map(), historyRefreshSessions: new Set(),
        pendingMaterializationSessions: pending, lastHeuristicsTurnId: new Map(),
        liveModelBySession: models,
        clearReasoningAge: 50, protectedTokens: 0, historianRunnable: false,
        directory: launch, sessionDirectoryBySession: directories,
        subcConnectionFile: connectionFile,
        memoryConfig: { enabled: true, injectionBudgetTokens: 1000, autoPromote: false },
    });
    for (let phase = 0; phase < 6; phase++) {
        if (phase === 1) unavailable = false;
        if (phase === 2) {
            if (scenario === "outside") pending.add(session);
            else if (scenario === "resolved-outside") {}
            else if (scenario === "revalidate") {
                git(directory, "update-ref", "refs/heads/main", git(directory, "rev-parse", "refs/fixture/first"));
                now += 301000;
            } else {
                directory = target;
                directories.delete(session);
            }
        }
        const messages = [{ info: { id: "user-1", role: "user", sessionID: session },
            parts: [{ type: "text", text: "continue" }] }];
        if (!scenario.endsWith("outside") && phase >= 1) messages.push({
            info: { id: "assistant-2", role: "assistant", sessionID: session, finish: "tool-calls",
                tokens: { reasoning: 1600 } },
            parts: [{ type: "reasoning", text: "signed thought", metadata: { anthropic: { signature: "signed-loop" } } },
                { type: "tool", callID: "read-call", tool: "read", state: { status: "completed", input: {}, output: "small result" } }],
        });
        if (!scenario.endsWith("outside") && phase >= 4) messages.push({
            info: { id: "user-3", role: "user", sessionID: session }, parts: [{ type: "text", text: "next turn" }],
        });
        await v2.cacheV2SessionDirectory(lookup, session, directories);
        await transform({}, { messages });
        const decision = decisions.getPending(session);
        transcript.push({ scenario, phase, pending: pending.has(session), lookups, requests,
            materialized: decision?.materialized ?? false, reason: decision?.materializeReason ?? null,
            identity: db.prepare("SELECT project_path FROM session_projects WHERE session_id = ? AND harness = ?")
                .get(session, getHarness())?.project_path ?? null,
            head: JSON.stringify(messages[0]) });
    }
}
closeDatabase();
console.log("RESULT " + JSON.stringify({ transcript }));
    `;

function requireBaselineCommit(): void {
    try {
        execFileSync("git", ["cat-file", "-e", `${BASE}^{commit}`], {
            cwd: repo,
            stdio: "ignore",
            windowsHide: true,
        });
    } catch {
        throw new Error(
            `Standalone differential baseline ${BASE} is missing. Fetch it with: git fetch --no-tags --depth=1 origin ${BASE}`,
        );
    }
}

beforeAll(() => {
    mkdirSync(join(tmpdir(), "magic-context"), { recursive: true });
    scratch = createTestTempDirFromPath(join(tmpdir(), "magic-context", "standalone-"));
    requireBaselineCommit();
    baseline = join(scratch, "base");
    mkdirSync(baseline);
    const archive = execFileSync(
        "git",
        [
            "-c",
            `safe.directory=${repo}`,
            "archive",
            BASE,
            "packages/plugin",
            "packages/pi-plugin",
            "packages/retina-local-fs",
        ],
        {
            cwd: repo,
            windowsHide: true,
            maxBuffer: 64 * 1024 * 1024,
        },
    );
    execFileSync("tar", ["-x", "-C", baseline], { input: archive, windowsHide: true });
    symlinkSync(join(repo, "node_modules"), join(baseline, "node_modules"), "dir");
    for (const pkg of ["plugin", "pi-plugin", "retina-local-fs"]) {
        symlinkSync(
            join(repo, "packages", pkg, "node_modules"),
            join(baseline, "packages", pkg, "node_modules"),
            "dir",
        );
    }
    host = join(scratch, "host.ts");
    writeFileSync(host, hostSource);
    foldHost = join(scratch, "fold-host.ts");
    writeFileSync(foldHost, foldSource);
});

afterAll(() => cleanupTestTempDir(scratch));

function git(directory: string, ...args: string[]): string {
    return execFileSync("git", args, {
        cwd: directory,
        windowsHide: true,
        env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.invalid",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.invalid",
            GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
            GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
        },
    })
        .toString()
        .trim();
}

function fixtures(directory: string): void {
    rmSync(directory, { recursive: true, force: true });
    for (const name of ["stable", "plain", "unborn", "recovering"]) {
        const folder = join(directory, name);
        mkdirSync(folder, { recursive: true });
        if (name === "plain") continue;
        git(folder, "init", "-b", "main");
        git(folder, "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "fixture");
        if (name === "unborn") {
            git(folder, "update-ref", "refs/fixture/first", "HEAD");
            git(folder, "update-ref", "-d", "refs/heads/main");
        }
    }
}

// This peer uses the authenticated subc protocol and reports an unloaded module.
async function absentModule(connectionFile: string) {
    const sockets = new Set<Socket>();
    let calls = 0;
    const key = new Uint8Array(32).fill(9);
    const daemonId = new Uint8Array(16).fill(7);
    const serverNonce = new Uint8Array(32).fill(5);
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        void (async () => {
            const iterator = socket[Symbol.asyncIterator]();
            let buffered = Buffer.alloc(0);
            const bytes = async (length: number) => {
                while (buffered.length < length) {
                    const next = await iterator.next();
                    if (next.done) throw new Error("peer closed");
                    buffered = Buffer.concat([buffered, next.value]);
                }
                const result = buffered.subarray(0, length);
                buffered = buffered.subarray(length);
                return result;
            };
            const auth = async () =>
                JSON.parse((await bytes((await bytes(4)).readUInt32LE())).toString());
            const hello = await auth();
            const proof = Buffer.from(
                JSON.stringify({
                    server_nonce: [...serverNonce],
                    daemon_id: [...daemonId],
                    server_proof: [
                        ...computeProof(
                            key,
                            SERVER_PROOF_DOMAIN,
                            Uint8Array.from(hello.client_nonce),
                            serverNonce,
                            daemonId,
                        ),
                    ],
                }),
            );
            const size = Buffer.alloc(4);
            size.writeUInt32LE(proof.length);
            socket.write(Buffer.concat([size, proof]));
            await auth();
            while (!socket.destroyed) {
                const header = decodeHeader(await bytes(HEADER_LEN));
                const body = JSON.parse((await bytes(header.len)).toString());
                const opening = body.op === "route.open";
                if (!opening) {
                    expect(body.method).toBe("resolve");
                    calls++;
                }
                socket.write(
                    encodeFrame(
                        buildFrame(
                            opening ? FrameType.Response : FrameType.Error,
                            buildFlags(false, Priority.Interactive, false),
                            header.channel,
                            header.epoch,
                            header.corr,
                            Buffer.from(
                                JSON.stringify(
                                    opening
                                        ? { route_channel: 7, route_epoch: 1 }
                                        : {
                                              code: "unknown_module",
                                              message: "Entorhinal is not loaded",
                                              detail: null,
                                          },
                                ),
                            ),
                        ),
                    ),
                );
            }
        })().catch(() => {});
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fake address");
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
    return {
        calls: () => calls,
        close: async () => {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((done) => server.close(() => done()));
        },
    };
}

interface Sample {
    scenario: string;
    phase: number;
    identity: string | null;
    prefix: string;
    head: string;
    pending: boolean;
    materialized: boolean;
    reason: string | null;
    lookups: number;
    requests: number;
}
async function runHost(
    root: string,
    fixture: string,
    connection: string,
    mode: string,
    runtime = "opencode",
) {
    const isolation = join(scratch, `${runtime}-${mode}-${root === repo ? "head" : "base"}`);
    mkdirSync(isolation, { recursive: true });
    const storage = join(isolation, "cortexkit", "magic-context");
    const env = {
        ...process.env,
        XDG_DATA_HOME: isolation,
        XDG_CONFIG_HOME: join(isolation, "config"),
        XDG_STATE_HOME: join(isolation, "state"),
        XDG_RUNTIME_DIR: join(isolation, "run"),
        OPENCODE_DB: join(isolation, "opencode.db"),
        MAGIC_CONTEXT_STORAGE_DIR: storage,
        MAGIC_CONTEXT_TEST_DATA_DIR: isolation,
    };
    const child = Bun.spawn(
        [
            process.execPath,
            runtime === "opencode2-fold" ? foldHost : host,
            root,
            fixture,
            connection,
            mode,
            storage,
            runtime,
        ],
        {
            cwd: repo,
            windowsHide: true,
            env,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        },
    );
    const stderr = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    let output = "";
    try {
        while (!output.includes("READY ")) {
            const next = await reader.read();
            if (next.done) throw new Error(`host failed before isolation check: ${await stderr}`);
            output += new TextDecoder().decode(next.value);
        }
        const descriptors = execFileSync("lsof", ["-p", String(child.pid), "-Fn"], {
            encoding: "utf8",
            windowsHide: true,
        });
        const databases = descriptors
            .split("\n")
            .filter((line) => line.startsWith("n") && /\.db(?:-|$)/.test(line));
        expect(databases.length).toBeGreaterThan(0);
        for (const database of databases) expect(database.slice(1)).toStartWith(isolation);
        console.log(`lsof -p ${child.pid}: ${databases.map((line) => line.slice(1)).join(", ")}`);
        child.stdin.write("continue\n");
        child.stdin.end();
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            output += new TextDecoder().decode(next.value);
        }
        expect(await child.exited, await stderr).toBe(0);
        const result = output.split("\n").find((line) => line.startsWith("RESULT "));
        if (!result) throw new Error(`missing host transcript: ${output}`);
        return JSON.parse(result.slice(7)) as { transcript: Sample[]; failedProbes: number };
    } finally {
        child.kill();
        await child.exited;
    }
}

for (const runtime of ["opencode", "opencode2", "pi"]) {
    for (const mode of ["no-connection", "daemon-down", "module-absent"]) {
        // lsof observes the open host databases; Windows has no lsof file-descriptor interface.
        test.skipIf(process.platform === "win32")(
            `${runtime} standalone differential against ${BASE.slice(0, 12)}: ${mode}`,
            async () => {
                const fixture = join(scratch, runtime, mode, "fixture");
                mkdirSync(join(scratch, runtime, mode), { recursive: true });
                const connection = join(scratch, runtime, mode, "connection.json");
                const fake = mode === "module-absent" ? await absentModule(connection) : undefined;
                if (mode === "daemon-down") {
                    // A valid connection file whose listener has closed, rather than a malformed file.
                    const stopped = await absentModule(connection);
                    await stopped.close();
                }
                try {
                    fixtures(fixture);
                    const base = await runHost(baseline, fixture, connection, mode, runtime);
                    fixtures(fixture);
                    const head = await runHost(repo, fixture, connection, mode, runtime);
                    expect(head.transcript.map(({ prefix }) => prefix)).toEqual(
                        base.transcript.map(({ prefix }) => prefix),
                    );
                    if (runtime === "opencode") expect(head.transcript).toEqual(base.transcript);
                    expect(head.transcript).toHaveLength(16);
                    expect(head.failedProbes).toBeGreaterThan(0);
                    const unborn = head.transcript.filter((sample) => sample.scenario === "unborn");
                    expect(unborn[0].identity).toStartWith("dir:");
                    expect(unborn[1].identity).toStartWith("git:");
                    const recovering = head.transcript.filter(
                        (sample) => sample.scenario === "recovering",
                    );
                    expect(recovering[0].prefix).not.toContain("standalone memory for");
                    expect(recovering[1].identity).toStartWith("git:");
                    // Pi already rebuilds the rendered memory block after git recovery
                    // in v0.49.2. OpenCode keeps the block served before recovery, so
                    // compare each runtime to its own baseline recovery behavior.
                    if (runtime !== "pi") expect(recovering[1].prefix).toBe(recovering[0].prefix);
                    for (const scenario of ["stable", "plain", "unborn", "recovering"]) {
                        const rows = head.transcript.filter(
                            (sample) => sample.scenario === scenario,
                        );
                        expect(rows[2].prefix).toBe(rows[1].prefix);
                        expect(rows[3].prefix).toBe(rows[2].prefix);
                    }
                    for (const sample of head.transcript.filter(
                        (sample) => sample.scenario !== "recovering",
                    )) {
                        expect(sample.prefix).toContain("standalone memory for");
                    }
                    if (fake) expect(fake.calls()).toBe(4);
                } finally {
                    await fake?.close();
                }
            },
            60000,
        );
    }
}

test.skipIf(process.platform === "win32")(
    "OpenCode 2 identity folds wait for signed thinking and have a named reason",
    async () => {
        const fixture = join(scratch, "fold", "fixture");
        fixtures(fixture);
        const { transcript } = await runHost(
            repo,
            fixture,
            join(scratch, "missing.json"),
            "fold",
            "opencode2-fold",
        );
        const outside = transcript.filter((row) => row.scenario === "resolved-outside");
        expect(outside[0].head).toContain("fold memory for git:");
        expect(outside[0].reason).toBe("first_render");
        expect(
            outside
                .slice(1)
                .every(
                    (row) =>
                        row.head === outside[0].head && !row.materialized && row.requests === 0,
                ),
        ).toBe(true);
        for (const scenario of ["revalidate", "move"]) {
            const rows = transcript.filter((row) => row.scenario === scenario);
            expect(rows[1].materialized).toBe(false);
            for (const phase of [2, 3]) {
                expect(rows[phase].identity).toBe(rows[1].identity);
                expect(rows[phase].pending).toBe(true);
                expect(rows[phase].materialized).toBe(false);
                expect(rows[phase].head).toBe(rows[1].head);
                expect(rows[phase].requests).toBe(1);
            }
            expect(rows[4].materialized).toBe(true);
            expect(rows[4].pending).toBe(false);
            expect(rows[4].reason).toBe("project_change");
            expect(rows[4].identity).toStartWith("git:");
            expect(rows[4].head).toContain("fold memory for git:");
            expect(rows[5].materialized).toBe(false);
            expect(rows[5].head).toBe(rows[4].head);
            expect(rows[5].requests).toBe(rows[4].requests);
        }
    },
    60000,
);

if (process.platform !== "win32")
    test.failing("lookup recovery must not rebuild an outside session on an ordinary defer pass (pre-existing shared fold policy)", async () => {
        const fixture = join(scratch, "lookup", "fixture");
        fixtures(fixture);
        const base = await runHost(
            baseline,
            fixture,
            join(scratch, "missing.json"),
            "lookup",
            "opencode2-fold",
        );
        fixtures(fixture);
        const head = await runHost(
            repo,
            fixture,
            join(scratch, "missing.json"),
            "lookup",
            "opencode2-fold",
        );
        for (const [revision, result] of [
            ["v0.49.2", base],
            ["HEAD", head],
        ] as const) {
            const rows = result.transcript.filter((row) => row.scenario === "outside");
            console.log(
                `${revision} outside lookup recovery: ${JSON.stringify(rows.map(({ phase, reason, materialized, lookups, identity }) => ({ phase, reason, materialized, lookups, identity })))}`,
            );
            expect(rows[0].head).toContain("fold memory for dir:");
            if (revision === "v0.49.2") {
                expect(rows[1].reason).toBe("project_change");
                expect(rows[1].materialized).toBe(true);
            }
            expect(rows[1].lookups).toBe(2);
            expect(
                rows.slice(3).every((row) => row.head === rows[2].head && !row.materialized),
            ).toBe(true);
        }
        expect(head.transcript.filter((row) => row.scenario === "outside")[1].head).toBe(
            head.transcript.filter((row) => row.scenario === "outside")[0].head,
        );
    }, 60000);
