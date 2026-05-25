import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checkerMocks = {
    extractChannel: mock(() => "latest"),
    findPluginEntry: mock(() => null),
    getCachedVersion: mock(() => null),
    getCurrentRuntimePackageJsonPath: mock(() => null),
    getLatestVersion: mock(async () => null),
    getLocalDevVersion: mock(() => null),
};

const cacheMocks = {
    preparePackageUpdate: mock(() => "/tmp/opencode"),
    resolveInstallContext: mock(() => ({ installDir: "/tmp/opencode" })),
    runNpmInstallSafe: mock(async () => true),
};

mock.module("./checker", () => checkerMocks);
mock.module("./cache", () => cacheMocks);

let importCounter = 0;

function freshIndexImport() {
    return import(`./index.ts?test=${importCounter++}`);
}

function createCtx() {
    const showToast = mock(() => Promise.resolve(undefined));
    return {
        ctx: {
            directory: "/test",
            client: { tui: { showToast } },
        },
        showToast,
    };
}

async function waitForCalls(fn: { mock: { calls: unknown[] } }, minCalls = 1): Promise<void> {
    const deadline = Date.now() + 1000;

    while (fn.mock.calls.length < minCalls) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for async hook work");
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

const tempDirs: string[] = [];

function makeTempStorageDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-auto-update-test-"));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    mock.restore();
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (!dir) continue;
        try {
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                /* Ignore EBUSY on Windows */
            }
        } catch {
            // Best-effort cleanup
        }
    }
});

describe("auto-update-checker/index", () => {
    beforeEach(() => {
        checkerMocks.extractChannel.mockReset();
        checkerMocks.extractChannel.mockImplementation(() => "latest");
        checkerMocks.findPluginEntry.mockReset();
        checkerMocks.findPluginEntry.mockImplementation(() => null);
        checkerMocks.getCachedVersion.mockReset();
        checkerMocks.getCachedVersion.mockImplementation(() => null);
        checkerMocks.getCurrentRuntimePackageJsonPath.mockReset();
        checkerMocks.getCurrentRuntimePackageJsonPath.mockImplementation(() => null);
        checkerMocks.getLatestVersion.mockReset();
        checkerMocks.getLatestVersion.mockImplementation(async () => null);
        checkerMocks.getLocalDevVersion.mockReset();
        checkerMocks.getLocalDevVersion.mockImplementation(() => null);

        cacheMocks.preparePackageUpdate.mockReset();
        cacheMocks.preparePackageUpdate.mockImplementation(() => "/tmp/opencode");
        cacheMocks.resolveInstallContext.mockReset();
        cacheMocks.resolveInstallContext.mockImplementation(() => ({
            installDir: "/tmp/opencode",
        }));
        cacheMocks.runNpmInstallSafe.mockReset();
        cacheMocks.runNpmInstallSafe.mockImplementation(async () => true);
    });

    test("uses resolved install root for auto-update installs", async () => {
        const { getAutoUpdateInstallDir } = await freshIndexImport();

        expect(getAutoUpdateInstallDir()).toBe("/tmp/opencode");
    });

    test("shows development toast and skips background update for local dev installs", async () => {
        checkerMocks.getLocalDevVersion.mockImplementation(() => "0.15.6-dev");
        const { createAutoUpdateCheckerHook } = await freshIndexImport();
        const { ctx, showToast } = createCtx();

        // initDelayMs: 0 fires the check immediately so the test doesn't wait 5s.
        // storageDir is provided so the dedup file isn't written into the test
        // process's home dir.
        createAutoUpdateCheckerHook(ctx as Parameters<typeof createAutoUpdateCheckerHook>[0], {
            initDelayMs: 0,
            storageDir: makeTempStorageDir(),
        });
        await waitForCalls(showToast);

        expect(showToast).toHaveBeenCalledWith({
            body: {
                title: "Magic Context 0.15.6-dev (dev)",
                message: "Running in local development mode.",
                variant: "info",
                duration: 3000,
            },
        });
        expect(checkerMocks.findPluginEntry).not.toHaveBeenCalled();
        expect(checkerMocks.getLatestVersion).not.toHaveBeenCalled();
    });

    test("event hook is a no-op", async () => {
        checkerMocks.getLocalDevVersion.mockImplementation(() => "0.15.6-dev");
        const { createAutoUpdateCheckerHook } = await freshIndexImport();
        const { ctx, showToast } = createCtx();

        const hook = createAutoUpdateCheckerHook(
            ctx as Parameters<typeof createAutoUpdateCheckerHook>[0],
            {
                initDelayMs: 0,
                storageDir: makeTempStorageDir(),
            },
        );
        // Wait for init-timer check to fire
        await waitForCalls(showToast);
        const callsAfterInit = showToast.mock.calls.length;

        // Firing synthetic events must not trigger more checks
        await hook({ event: { type: "session.created", properties: {} } });
        await hook({ event: { type: "session.created", properties: { info: {} } } });
        await hook({ event: { type: "message.updated", properties: {} } });

        // Give any rogue async work a tick to flush
        await new Promise((r) => setTimeout(r, 10));

        expect(showToast.mock.calls.length).toBe(callsAfterInit);
    });

    test("disabled hook never schedules a check", async () => {
        checkerMocks.getLocalDevVersion.mockImplementation(() => "0.15.6-dev");
        const { createAutoUpdateCheckerHook } = await freshIndexImport();
        const { ctx, showToast } = createCtx();

        createAutoUpdateCheckerHook(ctx as Parameters<typeof createAutoUpdateCheckerHook>[0], {
            enabled: false,
            initDelayMs: 0,
            storageDir: makeTempStorageDir(),
        });

        // Even after waiting longer than initDelayMs would be, no check fires
        await new Promise((r) => setTimeout(r, 50));
        expect(showToast).not.toHaveBeenCalled();
    });

    test("on-disk timestamp dedupes concurrent plugin instances", async () => {
        checkerMocks.getLocalDevVersion.mockImplementation(() => "0.15.6-dev");
        const { createAutoUpdateCheckerHook } = await freshIndexImport();
        const sharedDir = makeTempStorageDir();

        const ctxA = createCtx();
        const ctxB = createCtx();

        // First instance claims the slot
        createAutoUpdateCheckerHook(ctxA.ctx as Parameters<typeof createAutoUpdateCheckerHook>[0], {
            initDelayMs: 0,
            storageDir: sharedDir,
        });
        await waitForCalls(ctxA.showToast);

        // Second instance starts after the first wrote the timestamp;
        // a 1-hour interval (default) means it must skip.
        createAutoUpdateCheckerHook(ctxB.ctx as Parameters<typeof createAutoUpdateCheckerHook>[0], {
            initDelayMs: 0,
            storageDir: sharedDir,
        });
        await new Promise((r) => setTimeout(r, 50));

        expect(ctxA.showToast).toHaveBeenCalledTimes(1);
        expect(ctxB.showToast).not.toHaveBeenCalled();
    });

    test("expired timestamp allows a new check to run", async () => {
        checkerMocks.getLocalDevVersion.mockImplementation(() => "0.15.6-dev");
        const { createAutoUpdateCheckerHook } = await freshIndexImport();
        const dir = makeTempStorageDir();

        // Pre-write a stale timestamp (2 hours ago, well past the 1-hour default)
        const stale = Date.now() - 2 * 60 * 60 * 1000;
        writeFileSync(
            join(dir, "last-update-check.json"),
            JSON.stringify({ lastCheckedMs: stale }),
            "utf-8",
        );

        const { ctx, showToast } = createCtx();
        createAutoUpdateCheckerHook(ctx as Parameters<typeof createAutoUpdateCheckerHook>[0], {
            initDelayMs: 0,
            storageDir: dir,
        });
        await waitForCalls(showToast);

        expect(showToast).toHaveBeenCalledTimes(1);

        // The new instance should have refreshed the timestamp
        const updated = JSON.parse(readFileSync(join(dir, "last-update-check.json"), "utf-8")) as {
            lastCheckedMs: number;
        };
        expect(updated.lastCheckedMs).toBeGreaterThan(stale);
    });

    test("fails open when storageDir is null (no dedup, check still runs)", async () => {
        checkerMocks.getLocalDevVersion.mockImplementation(() => "0.15.6-dev");
        const { createAutoUpdateCheckerHook } = await freshIndexImport();
        const { ctx, showToast } = createCtx();

        createAutoUpdateCheckerHook(ctx as Parameters<typeof createAutoUpdateCheckerHook>[0], {
            initDelayMs: 0,
            // No storageDir — fail-open path
        });
        await waitForCalls(showToast);

        expect(showToast).toHaveBeenCalledTimes(1);
    });

    test("corrupt timestamp file is overwritten and check runs", async () => {
        checkerMocks.getLocalDevVersion.mockImplementation(() => "0.15.6-dev");
        const { createAutoUpdateCheckerHook } = await freshIndexImport();
        const dir = makeTempStorageDir();

        // Write garbage that JSON.parse can't handle
        writeFileSync(join(dir, "last-update-check.json"), "{not-json", "utf-8");

        const { ctx, showToast } = createCtx();
        createAutoUpdateCheckerHook(ctx as Parameters<typeof createAutoUpdateCheckerHook>[0], {
            initDelayMs: 0,
            storageDir: dir,
        });
        await waitForCalls(showToast);

        expect(showToast).toHaveBeenCalledTimes(1);
        // File should now be valid JSON
        const written = JSON.parse(readFileSync(join(dir, "last-update-check.json"), "utf-8")) as {
            lastCheckedMs: number;
        };
        expect(typeof written.lastCheckedMs).toBe("number");
    });

    test("aborted signal cancels the pending check", async () => {
        checkerMocks.getLocalDevVersion.mockImplementation(() => "0.15.6-dev");
        const { createAutoUpdateCheckerHook } = await freshIndexImport();
        const { ctx, showToast } = createCtx();

        const abort = new AbortController();
        // Use a long initDelayMs so we have time to abort before the check fires
        createAutoUpdateCheckerHook(ctx as Parameters<typeof createAutoUpdateCheckerHook>[0], {
            initDelayMs: 1000,
            storageDir: makeTempStorageDir(),
            signal: abort.signal,
        });

        // Abort immediately
        abort.abort();
        await new Promise((r) => setTimeout(r, 50));

        expect(showToast).not.toHaveBeenCalled();
    });

    test("shows success toast after updating the active install root", async () => {
        checkerMocks.findPluginEntry.mockImplementation(() => ({
            entry: "@cortexkit/opencode-magic-context@latest",
            pinnedVersion: null,
            isPinned: false,
            configPath: "/config/opencode.jsonc",
        }));
        checkerMocks.getCachedVersion.mockImplementation(() => "0.15.5");
        checkerMocks.getLatestVersion.mockImplementation(async () => "0.15.6");

        const { createAutoUpdateCheckerHook } = await freshIndexImport();
        const { ctx, showToast } = createCtx();
        createAutoUpdateCheckerHook(ctx as Parameters<typeof createAutoUpdateCheckerHook>[0], {
            showStartupToast: false,
            initDelayMs: 0,
            storageDir: makeTempStorageDir(),
        });
        await waitForCalls(showToast);

        expect(cacheMocks.preparePackageUpdate).toHaveBeenCalledWith(
            "0.15.6",
            "@cortexkit/opencode-magic-context",
        );
        expect(cacheMocks.runNpmInstallSafe).toHaveBeenCalledWith(
            "/tmp/opencode",
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(showToast).toHaveBeenCalledWith({
            body: {
                title: "Magic Context Updated!",
                message: "v0.15.5 → v0.15.6\nRestart OpenCode to apply.",
                variant: "success",
                duration: 8000,
            },
        });
    });

    test("shows notification-only toast when auto-update is disabled", async () => {
        checkerMocks.findPluginEntry.mockImplementation(() => ({
            entry: "@cortexkit/opencode-magic-context@latest",
            pinnedVersion: null,
            isPinned: false,
            configPath: "/config/opencode.jsonc",
        }));
        checkerMocks.getCachedVersion.mockImplementation(() => "0.15.5");
        checkerMocks.getLatestVersion.mockImplementation(async () => "0.15.6");
        const { createAutoUpdateCheckerHook } = await freshIndexImport();
        const { ctx, showToast } = createCtx();

        createAutoUpdateCheckerHook(ctx as Parameters<typeof createAutoUpdateCheckerHook>[0], {
            showStartupToast: false,
            autoUpdate: false,
            initDelayMs: 0,
            storageDir: makeTempStorageDir(),
        });
        await waitForCalls(showToast);

        expect(showToast).toHaveBeenCalledWith({
            body: {
                title: "Magic Context 0.15.6",
                message: "v0.15.6 available. Auto-update is disabled.",
                variant: "info",
                duration: 8000,
            },
        });
        expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
        expect(cacheMocks.runNpmInstallSafe).not.toHaveBeenCalled();
    });

    test("shows pinned-version notification without installing", async () => {
        checkerMocks.findPluginEntry.mockImplementation(() => ({
            entry: "@cortexkit/opencode-magic-context@0.15.5",
            pinnedVersion: "0.15.5",
            isPinned: true,
            configPath: "/config/opencode.jsonc",
        }));
        checkerMocks.getCachedVersion.mockImplementation(() => "0.15.5");
        checkerMocks.getLatestVersion.mockImplementation(async () => "0.15.6");
        const { createAutoUpdateCheckerHook } = await freshIndexImport();
        const { ctx, showToast } = createCtx();

        createAutoUpdateCheckerHook(ctx as Parameters<typeof createAutoUpdateCheckerHook>[0], {
            showStartupToast: false,
            initDelayMs: 0,
            storageDir: makeTempStorageDir(),
        });
        await waitForCalls(showToast);

        expect(showToast).toHaveBeenCalledWith({
            body: {
                title: "Magic Context 0.15.6",
                message:
                    "v0.15.6 available. Version is pinned; update your OpenCode plugin config to upgrade.",
                variant: "info",
                duration: 8000,
            },
        });
        expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
    });

    test("shows warning toast when latest version fetch fails", async () => {
        checkerMocks.findPluginEntry.mockImplementation(() => ({
            entry: "@cortexkit/opencode-magic-context@latest",
            pinnedVersion: null,
            isPinned: false,
            configPath: "/config/opencode.jsonc",
        }));
        checkerMocks.getCachedVersion.mockImplementation(() => "0.15.5");
        checkerMocks.getLatestVersion.mockImplementation(async () => null);
        const { createAutoUpdateCheckerHook } = await freshIndexImport();
        const { ctx, showToast } = createCtx();

        createAutoUpdateCheckerHook(ctx as Parameters<typeof createAutoUpdateCheckerHook>[0], {
            showStartupToast: false,
            initDelayMs: 0,
            storageDir: makeTempStorageDir(),
        });
        await waitForCalls(showToast);

        expect(showToast).toHaveBeenCalledWith({
            body: {
                title: "Magic Context update check failed",
                message:
                    "Could not check npm for @cortexkit/opencode-magic-context updates. Continuing with the cached version.",
                variant: "warning",
                duration: 8000,
            },
        });
    });

    test("shows install failure toast without telling users to restart", async () => {
        checkerMocks.findPluginEntry.mockImplementation(() => ({
            entry: "@cortexkit/opencode-magic-context@latest",
            pinnedVersion: null,
            isPinned: false,
            configPath: "/config/opencode.jsonc",
        }));
        checkerMocks.getCachedVersion.mockImplementation(() => "0.15.5");
        checkerMocks.getLatestVersion.mockImplementation(async () => "0.15.6");
        cacheMocks.runNpmInstallSafe.mockImplementation(async () => false);
        const { createAutoUpdateCheckerHook } = await freshIndexImport();
        const { ctx, showToast } = createCtx();

        createAutoUpdateCheckerHook(ctx as Parameters<typeof createAutoUpdateCheckerHook>[0], {
            showStartupToast: false,
            initDelayMs: 0,
            storageDir: makeTempStorageDir(),
        });
        await waitForCalls(showToast);

        expect(showToast).toHaveBeenCalledWith({
            body: {
                title: "Magic Context 0.15.6",
                message:
                    "v0.15.6 available, but auto-update failed to install it. Check logs or retry manually.",
                variant: "error",
                duration: 8000,
            },
        });
    });

    test("timestamp file is created in the configured storageDir", async () => {
        checkerMocks.getLocalDevVersion.mockImplementation(() => "0.15.6-dev");
        const { createAutoUpdateCheckerHook } = await freshIndexImport();
        const dir = makeTempStorageDir();
        const { ctx, showToast } = createCtx();

        createAutoUpdateCheckerHook(ctx as Parameters<typeof createAutoUpdateCheckerHook>[0], {
            initDelayMs: 0,
            storageDir: dir,
        });
        await waitForCalls(showToast);

        const file = join(dir, "last-update-check.json");
        expect(existsSync(file)).toBe(true);
        const written = JSON.parse(readFileSync(file, "utf-8")) as { lastCheckedMs: number };
        expect(typeof written.lastCheckedMs).toBe("number");
        expect(Date.now() - written.lastCheckedMs).toBeLessThan(5000);
    });
});
