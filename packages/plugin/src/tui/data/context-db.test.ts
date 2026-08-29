import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MagicContextRpcServer } from "../../shared/rpc-server";
import type { SidebarSnapshot } from "../../shared/rpc-types";
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
    const dir = mkdtempSync(join(tmpdir(), "mc-context-db-"));
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

        expect(await loadStatusDetail("ses_rust", directory)).toEqual({
            ok: false,
            error: "Rust module status unavailable; canonical session state was not read",
        });
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
