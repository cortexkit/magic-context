import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as configLoader from "./config";
import * as configMigration from "./config/migrate-config-location";
import { MagicContextConfigSchema } from "./config/schema/magic-context";
import * as dreamScheduler from "./features/magic-context/dreamer/task-scheduler";
import * as entorhinal from "./features/magic-context/memory/entorhinal-resolve";
import {
    __resetProjectIdentityForTests,
    __setProjectIdentityTestHooks,
    resolveProjectIdentityForSession,
} from "./features/magic-context/memory/project-identity";
import { readRememberedProjectIdentity } from "./features/magic-context/memory/project-identity-cache";
import * as identityDecisions from "./features/magic-context/memory/session-identity-decision";
import { closeDatabase, openDatabase } from "./features/magic-context/storage-db";
import type { createMagicContextHook } from "./hooks/magic-context/hook";
import * as bootQuiet from "./plugin/boot-quiet";
import * as dreamTimer from "./plugin/dream-timer";
import * as sessionHooks from "./plugin/hooks/create-session-hooks";
import * as stallProfiler from "./plugin/host-stall-profiler";
import { _resetHarnessForTesting } from "./shared/harness";
import * as logger from "./shared/logger";
import * as models from "./shared/models-dev-cache";
import { MagicContextRpcServer } from "./shared/rpc-server";
import { createTestTempDir } from "./shared/test-temp-dir";

const envKeys = [
    "MAGIC_CONTEXT_TEST_DATA_DIR",
    "MAGIC_CONTEXT_STORAGE_DIR",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
] as const;
let temp: ReturnType<typeof createTestTempDir>;
let originalEnv: Record<string, string | undefined>;
const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(() => {
    _resetHarnessForTesting();
    originalEnv = { ...process.env };
    temp = createTestTempDir("mc-v1-launch-dreamer-");
    for (const key of envKeys) process.env[key] = join(temp.dir, key);
    __setProjectIdentityTestHooks({
        execFileSync: (() => "a".repeat(40)) as unknown as typeof execFileSync,
    });
    spyOn(configMigration, "migrateMagicContextConfigLocations").mockReturnValue([]);
    spyOn(bootQuiet, "scheduleAfterBootQuiet").mockImplementation(() => {});
    spyOn(bootQuiet, "bootQuietRemainingMs").mockReturnValue(0);
    spyOn(logger, "log").mockImplementation(() => {});
    spyOn(logger, "flushLogger").mockImplementation(() => {});
    spyOn(stallProfiler, "startHostStallProfilerSwitch").mockImplementation(() => {});
    spyOn(models, "refreshModelLimitsFromApi").mockImplementation(async () => {});
    spyOn(MagicContextRpcServer.prototype, "start").mockImplementation(async () => {});
});

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    closeDatabase();
    mock.restore();
    identityDecisions.__resetSessionIdentityDecisionsForTests();
    __resetProjectIdentityForTests();
    _resetHarnessForTesting();
    for (const key of envKeys) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
    temp.cleanup();
});

function linkedLaunch(): string {
    const mainGit = join(temp.dir, "main", ".git");
    const gitdir = join(mainGit, "worktrees", "linked");
    const directory = join(temp.dir, "linked");
    mkdirSync(gitdir, { recursive: true });
    mkdirSync(directory);
    writeFileSync(join(gitdir, "commondir"), "../..\n");
    writeFileSync(join(directory, ".git"), `gitdir: ${gitdir}\n`);
    return directory;
}

async function boot(directory: string) {
    const connectionFile = join(temp.dir, "subc.json");
    writeFileSync(connectionFile, "{}");
    const config = MagicContextConfigSchema.parse({
        historian: { disable: true },
        dreamer: { disable: false },
        auto_update: false,
        subc: { connection_file: connectionFile },
    });
    spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({ config } as ReturnType<
        typeof configLoader.loadPluginConfigDetailed
    >);
    openDatabase(join(process.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
    let runtime: ReturnType<typeof createMagicContextHook>;
    const create = sessionHooks.createSessionHooksAsync;
    spyOn(sessionHooks, "createSessionHooksAsync").mockImplementation(async (args) => {
        const hooks = await create(args);
        runtime = hooks.magicContext;
        return hooks;
    });
    const timer = spyOn(dreamTimer, "startDreamScheduleTimer").mockImplementation(
        async () => () => {},
    );
    const scheduled = spyOn(dreamScheduler, "runDueTasksForProject").mockImplementation(
        async () => undefined as never,
    );
    const client = {
        config: { get: async () => ({ data: {} }) },
        session: { list: async () => ({ data: [] }), get: async () => ({ data: {} }) },
        tui: { showToast: async () => {} },
    };
    const { default: plugin } = await import("./index");
    const hooks = await plugin.server({ directory, client } as never);
    cleanups.push(async () => {
        await hooks.event?.({
            event: { type: "server.instance.disposed", properties: { directory } },
        } as never);
    });
    // Timer registration is queued independently of the boot response.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { runtime: runtime!, timer, scheduled };
}

test("the v1 timer and event Dreamer share the unpinnable linked launch decision", async () => {
    const directory = linkedLaunch();
    const projectIdentity = "pj-V1-LAUNCH";
    expect(resolveProjectIdentityForSession(directory)).toBe(`git:${"a".repeat(40)}`);
    const resolve = spyOn(entorhinal, "resolveEntorhinalProject").mockResolvedValue({
        status: "resolved",
        projectId: projectIdentity,
        via: "worktree",
        canonicalRoot: directory,
    });
    const host = await boot(directory);
    expect(host.runtime).not.toBeNull();
    expect(host.runtime!.launchIdentityDecision).toEqual({ directory, identity: projectIdentity });
    expect(Object.keys(host.runtime!)).not.toContain("launchIdentityDecision");
    expect(host.timer).toHaveBeenCalledTimes(1);
    expect(host.timer.mock.calls[0][0]).toMatchObject({ directory, projectIdentity });
    await host.runtime!.event({ event: { type: "message.updated", properties: {} } });
    expect(host.scheduled).toHaveBeenCalledTimes(1);
    expect(host.timer.mock.calls[0][0].projectIdentity).toBe(
        host.scheduled.mock.calls[0][0].projectIdentity,
    );
    expect(host.scheduled.mock.calls[0][0].projectIdentity).toBe(projectIdentity);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(readRememberedProjectIdentity(directory)?.identity).not.toBe(projectIdentity);
});

test("an explicitly unbound v1 launch cannot start a timer from its cached Git identity", async () => {
    const directory = linkedLaunch();
    expect(resolveProjectIdentityForSession(directory)).toBe(`git:${"a".repeat(40)}`);
    const decision = spyOn(identityDecisions, "awaitSessionIdentityDecision").mockResolvedValue({
        directory,
        identity: undefined,
    });
    const host = await boot(directory);
    expect(host.runtime).toBeNull();
    expect(host.timer).not.toHaveBeenCalled();
    expect(host.scheduled).not.toHaveBeenCalled();
    expect(decision).toHaveBeenCalledTimes(1);
});
