import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MagicContextRpcServer } from "../../shared/rpc-server";
import type { SidebarSnapshot } from "../../shared/rpc-types";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    closeRpc,
    getCompartmentCount,
    initRpcClient,
    loadSidebarSnapshot,
    loadStatusDetail,
} from "./context-db";

const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
const originalStorageDir = process.env.MAGIC_CONTEXT_STORAGE_DIR;
const tempDirs: string[] = [];
const servers: MagicContextRpcServer[] = [];

afterEach(() => {
    closeRpc();
    for (const server of servers.splice(0)) server.stop();
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
    if (originalStorageDir === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    else process.env.MAGIC_CONTEXT_STORAGE_DIR = originalStorageDir;
});

function makeDataHome(): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-context-db-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    // The shared resolver gives test isolation priority. Keep both values
    // aligned so the RPC client and fixture server exercise one directory.
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dir;
    return dir;
}

function snapshot(sessionId: string, inputTokens: number): SidebarSnapshot {
    return {
        sessionId,
        usagePercentage: inputTokens > 0 ? 25 : 0,
        inputTokens,
        contextLimit: 1000,
        systemPromptTokens: 0,
        compartmentCount: inputTokens > 0 ? 2 : 0,
        memoryCount: 0,
        memoryBlockCount: 0,
        pendingOpsCount: 0,
        historianRunning: false,
        compartmentInProgress: false,
        sessionNoteCount: 0,
        readySmartNoteCount: 0,
        cacheTtl: "5m",
        lastDreamerRunAt: null,
        projectIdentity: null,
        compartmentTokens: 0,
        factTokens: 0,
        memoryTokens: 0,
        docsTokens: 0,
        profileTokens: 0,
        conversationTokens: inputTokens,
        toolCallTokens: 0,
        toolDefinitionTokens: 0,
        executeThreshold: 65,
        newWorkTokens: null,
        totalInputTokens: inputTokens,
    };
}

async function startServer(
    dataHome: string,
    directory: string,
    sidebar: () => Record<string, unknown>,
): Promise<MagicContextRpcServer> {
    const server = new MagicContextRpcServer(
        join(dataHome, "cortexkit", "magic-context"),
        directory,
    );
    server.handle("sidebar-snapshot", async () => sidebar());
    await server.start();
    servers.push(server);
    return server;
}

describe("TUI context RPC data", () => {
    test("scheduled reads expose RPC failures instead of hiding them behind a cached snapshot", async () => {
        const dataHome = makeDataHome();
        const directory = "/repo-scheduled";
        const sessionId = "ses_scheduled";
        let response: Record<string, unknown> = snapshot(sessionId, 250) as unknown as Record<
            string,
            unknown
        >;
        await startServer(dataHome, directory, () => response);
        initRpcClient(directory);
        expect(
            (await loadSidebarSnapshot(sessionId, directory, { throwOnFailure: true })).inputTokens,
        ).toBe(250);
        response = { error: "database busy" };
        await expect(
            loadSidebarSnapshot(sessionId, directory, { throwOnFailure: true }),
        ).rejects.toThrow("database busy");
        expect((await loadSidebarSnapshot(sessionId, directory)).inputTokens).toBe(250);
    });
    test("uses an unexpired sticky snapshot only for failed responses", async () => {
        const dataHome = makeDataHome();
        const directory = "/repo-sticky";
        const sessionId = "ses_sticky";
        let response: Record<string, unknown> = snapshot(sessionId, 250) as unknown as Record<
            string,
            unknown
        >;
        await startServer(dataHome, directory, () => response);
        initRpcClient(directory);

        expect((await loadSidebarSnapshot(sessionId, directory)).inputTokens).toBe(250);
        response = { error: "database busy" };
        expect((await loadSidebarSnapshot(sessionId, directory)).inputTokens).toBe(250);

        response = snapshot(sessionId, 0) as unknown as Record<string, unknown>;
        expect((await loadSidebarSnapshot(sessionId, directory)).inputTokens).toBe(0);
        response = { error: "database busy again" };
        expect((await loadSidebarSnapshot(sessionId, directory)).inputTokens).toBe(0);
    });

    test("does not turn a status authority failure into an empty session", async () => {
        const dataHome = makeDataHome();
        const directory = "/repo-status-error";
        const server = await startServer(dataHome, directory, () => ({}));
        server.handle("status-detail", async () => ({
            error: "Rust module status unavailable; canonical session state was not read",
        }));
        initRpcClient(directory);

        // The error reaches the dialog as a named reason, never as a snapshot.
        expect(await loadStatusDetail("ses_rust", directory)).toEqual({
            state: "unavailable",
            reason: {
                kind: "rpc_error",
                message: "Rust module status unavailable; canonical session state was not read",
            },
            versions: null,
        });
    });

    test("session calls go to the server of the session's directory, not the startup one", async () => {
        // The TUI started in the home directory; the session it shows belongs
        // to a project directory with its own Magic Context server instance.
        const dataHome = makeDataHome();
        const home = "/home-startup";
        const project = "/home-startup/Pictures/project";
        const homeServer = await startServer(dataHome, home, () => ({
            sessionId: "ses_project",
            disabled: true,
        }));
        homeServer.handle("status-detail", async () => ({
            sessionId: "ses_project",
            disabled: true,
        }));
        homeServer.handle("compartment-count", async () => ({ count: 0 }));
        const projectServer = await startServer(
            dataHome,
            project,
            () => snapshot("ses_project", 400) as unknown as Record<string, unknown>,
        );
        projectServer.handle("status-detail", async () => ({ error: "from the project server" }));
        projectServer.handle("compartment-count", async () => ({ count: 72 }));
        initRpcClient(home);

        expect((await loadSidebarSnapshot("ses_project", project)).compartmentCount).toBe(2);
        const status = await loadStatusDetail("ses_project", project);
        expect(status.state === "unavailable" && status.reason).toEqual({
            kind: "rpc_error",
            message: "from the project server",
        });
        expect(await getCompartmentCount("ses_project", project)).toEqual({ ok: true, count: 72 });
        // The startup directory still reaches the startup server.
        const homeStatus = await loadStatusDetail("ses_project", home);
        expect(homeStatus.state === "unavailable" && homeStatus.reason).toEqual({
            kind: "not_tracked",
            cause: "home_directory",
        });
    });

    test("finds the session's server when the host spells its directory differently", async () => {
        // The server files its discovery record under the directory it was
        // started with (here through a symlink, as macOS /var is to
        // /private/var); the TUI asks with the resolved spelling.
        const dataHome = makeDataHome();
        const root = realpathSync(createTestTempDirFromPath(join(tmpdir(), "mc-spelling-")));
        tempDirs.push(root);
        const real = join(root, "Pictures", "project");
        mkdirSync(real, { recursive: true });
        const link = join(root, "project-link");
        symlinkSync(real, link);
        await startServer(
            dataHome,
            `${link}/`,
            () => snapshot("ses_spelled", 300) as unknown as Record<string, unknown>,
        );
        initRpcClient("/home-startup");
        expect((await loadSidebarSnapshot("ses_spelled", real)).inputTokens).toBe(300);
    });

    test("asks every local server for the session's owner when no directory matches", async () => {
        const dataHome = makeDataHome();
        const home = await startServer(dataHome, "/home-startup", () => ({
            sessionId: "ses_owned",
            disabled: true,
        }));
        home.handle("session-owner", async () => ({ owner: false }));
        const project = await startServer(
            dataHome,
            "/filed/under/this/spelling",
            () => snapshot("ses_owned", 500) as unknown as Record<string, unknown>,
        );
        project.handle("session-owner", async (params) => ({
            owner: params.sessionId === "ses_owned",
        }));
        initRpcClient("/home-startup");

        // A spelling no canonical form maps to the filed one.
        const snapshotSeen = await loadSidebarSnapshot("ses_owned", "/asked/with/another/spelling");
        expect(snapshotSeen.inputTokens).toBe(500);
        expect(snapshotSeen.compartmentCount).toBe(2);
    });

    test("distinguishes a real zero compartment count from an RPC failure", async () => {
        const dataHome = makeDataHome();
        const directory = "/repo-count";
        const server = await startServer(dataHome, directory, () => ({}));
        server.handle("compartment-count", async () => ({ count: 0 }));
        initRpcClient(directory);

        expect(await getCompartmentCount("ses_zero")).toEqual({ ok: true, count: 0 });
        server.handle("compartment-count", async () => {
            throw new Error("database unavailable");
        });
        const failed = await getCompartmentCount("ses_zero");
        expect(failed.ok).toBe(false);
    });
});
