import { afterEach, describe, expect, it } from "bun:test";
import type { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    __resetRpcIdentityTestHooks,
    __setRpcIdentityTestHooks,
} from "@magic-context/core/shared/rpc-utils";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import {
    getOpenCodeV2PluginCacheSlot,
    OPENCODE_PLUGIN_NAME,
    readOpenCodeV2CachedPluginVersion,
    readReferencedOpenCodePluginSpecs,
} from "../lib/opencode-plugin-cache";
import {
    checkOpenCodeV2PluginCache,
    configuredOpenCodeV2DistTag,
    type HostUseProbe,
    probeHostProcessesUsing,
    reportOpenCodeV2PluginCache,
} from "./doctor-opencode2-cache";

const tempDirs: string[] = [];
afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-oc2-cache-"));
    tempDirs.push(dir);
    return dir;
}

/** Write one OpenCode 2 install generation: `<slot>/<generation>/node_modules/<name>/package.json`. */
function writeGeneration(slot: string, generation: string, name: string, version: string): void {
    const packageDir = join(slot, generation, "node_modules", ...name.split("/"));
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name, version }));
    writeFileSync(join(slot, generation, "package.json"), JSON.stringify({ dependencies: {} }));
}

/** An OpenCode 2 `npm/` cache with our `@latest` slot and neighbours that must survive. */
function makeNpmCache(cachedVersion: string) {
    const npm = join(tempDir(), "opencode", "npm");
    const slot = getOpenCodeV2PluginCacheSlot(npm);
    // Two generations: the host loads the numerically highest one.
    writeGeneration(slot, "1790000000000", OPENCODE_PLUGIN_NAME, "0.40.0");
    writeGeneration(slot, "1790000000001", OPENCODE_PLUGIN_NAME, cachedVersion);
    const neighbours = [
        join(npm, "@cortexkit", "opencode-magic-context@0.42.6"),
        join(npm, "@cortexkit", "other-plugin@latest"),
        join(npm, "unscoped-plugin@latest"),
    ];
    for (const neighbour of neighbours) {
        writeGeneration(neighbour, "1790000000000", "x", "1.0.0");
    }
    return { npm, slot, neighbours };
}

const free = (): HostUseProbe => ({ status: "free" });

describe("OpenCode 2 plugin cache slot", () => {
    it("lives under npm/<scope>/<name>@latest and reads the newest generation", () => {
        const { npm, slot } = makeNpmCache("0.42.6");
        expect(slot).toBe(join(npm, "@cortexkit", "opencode-magic-context@latest"));
        expect(readOpenCodeV2CachedPluginVersion(slot)).toBe("0.42.6");
    });
});

describe("doctor OpenCode 2 plugin cache check against the config", () => {
    const references = (config: Record<string, unknown>) =>
        readReferencedOpenCodePluginSpecs(config, "opencode2");

    function collect(result: ReturnType<typeof checkOpenCodeV2PluginCache>, loadedFrom?: string) {
        const lines: Array<{ kind: "pass" | "warn" | "info"; message: string }> = [];
        const outcome = reportOpenCodeV2PluginCache(
            result,
            {
                pass: (message) => lines.push({ kind: "pass", message }),
                warn: (message) => lines.push({ kind: "warn", message }),
                info: (message) => lines.push({ kind: "info", message }),
            },
            { reportMissing: true, loadedFrom },
        );
        return { lines, outcome };
    }

    it("reports a stale @latest slot as one info line when the config loads a local path", () => {
        const { slot } = makeNpmCache("0.31.2");
        const removed: string[] = [];
        const result = checkOpenCodeV2PluginCache(
            {
                fix: true,
                force: true,
                latestVersion: "0.47.0",
                hostFiles: [],
                referencedSpecs: references({
                    plugin: ["file:///dev/magic-context/packages/plugin"],
                }),
            },
            {
                slot,
                probe: () => ({ status: "in_use", pids: [4242] }),
                remove: (path) => removed.push(path),
            },
        );
        expect(result).toEqual({ action: "unused", slot, cached: "0.31.2" });
        expect(removed).toEqual([]);
        expect(existsSync(slot)).toBe(true);

        const { lines, outcome } = collect(result, "file:///dev/magic-context/packages/plugin");
        expect(outcome).toEqual({ fixed: false, issue: false });
        expect(lines).toHaveLength(1);
        expect(lines[0]?.kind).toBe("info");
        expect(lines[0]?.message).toContain("unused cached copy");
        expect(lines[0]?.message).toContain("safe to delete");
        expect(lines[0]?.message).toContain("file:///dev/magic-context/packages/plugin");
        expect(lines[0]?.message).toContain(slot);
    });

    it("still warns about a stale @latest slot an @latest entry loads", () => {
        const { slot } = makeNpmCache("0.31.2");
        const result = checkOpenCodeV2PluginCache(
            {
                latestVersion: "0.47.0",
                hostFiles: [],
                referencedSpecs: references({ plugins: [`${OPENCODE_PLUGIN_NAME}@latest`] }),
            },
            { slot, probe: free },
        );
        expect(result).toEqual({ action: "stale", slot, cached: "0.31.2", latest: "0.47.0" });
        expect(collect(result).lines.map((line) => line.kind)).toContain("warn");
    });

    it("treats the @latest slot as unused when the entry pins a version", () => {
        const { slot } = makeNpmCache("0.31.2");
        const result = checkOpenCodeV2PluginCache(
            {
                latestVersion: "0.47.0",
                hostFiles: [],
                referencedSpecs: references({ plugin: [`${OPENCODE_PLUGIN_NAME}@0.45.0`] }),
            },
            { slot, probe: free },
        );
        expect(result.action).toBe("unused");
        const { lines } = collect(result);
        expect(lines.map((line) => line.kind)).toEqual(["info"]);
        expect(lines[0]?.message).toContain(
            "no OpenCode 2 plugin entry in the config references it",
        );
    });

    it("says nothing about a missing slot the config does not load", () => {
        const slot = getOpenCodeV2PluginCacheSlot(join(tempDir(), "npm"));
        const result = checkOpenCodeV2PluginCache(
            { latestVersion: "0.47.0", hostFiles: [], referencedSpecs: new Set() },
            { slot, probe: free },
        );
        expect(result).toEqual({ action: "not_found", slot, unused: true });
        expect(collect(result).lines).toEqual([]);
    });
});

describe("doctor OpenCode 2 plugin cache check", () => {
    it("reports a cached install older than latest without --fix and leaves it", () => {
        const { slot } = makeNpmCache("0.42.6");
        const result = checkOpenCodeV2PluginCache(
            { latestVersion: "0.43.1", hostFiles: [] },
            { slot, probe: free },
        );
        expect(result).toEqual({ action: "stale", slot, cached: "0.42.6", latest: "0.43.1" });
        expect(existsSync(slot)).toBe(true);
    });

    it("clears only Magic Context's @latest slot under --fix", () => {
        const { slot, neighbours } = makeNpmCache("0.42.6");
        const probed: unknown[] = [];
        const result = checkOpenCodeV2PluginCache(
            { fix: true, latestVersion: "0.43.1", hostFiles: ["/x/opencode.db"] },
            {
                slot,
                probe: (targets) => {
                    probed.push(targets);
                    return { status: "free" };
                },
            },
        );
        expect(result).toMatchObject({ action: "cleared", forced: false });
        expect(existsSync(slot)).toBe(false);
        for (const neighbour of neighbours) expect(existsSync(neighbour)).toBe(true);
        // The host database and the slot itself are what the in-use probe checks.
        expect(probed).toEqual([{ files: ["/x/opencode.db"], directories: [slot] }]);
    });

    it("never clears while an OpenCode process holds the database or slot", () => {
        const { slot } = makeNpmCache("0.42.6");
        const result = checkOpenCodeV2PluginCache(
            { fix: true, latestVersion: "0.43.1", hostFiles: [] },
            { slot, probe: () => ({ status: "in_use", pids: [4242] }) },
        );
        expect(result).toEqual({
            action: "in_use",
            slot,
            cached: "0.42.6",
            latest: "0.43.1",
            pids: [4242],
        });
        expect(existsSync(slot)).toBe(true);
    });

    it("never clears when use cannot be ruled out", () => {
        const { slot } = makeNpmCache("0.42.6");
        const result = checkOpenCodeV2PluginCache(
            { fix: true, latestVersion: "0.43.1", hostFiles: [] },
            { slot, probe: () => ({ status: "unknown", reason: "could not run lsof (ENOENT)" }) },
        );
        expect(result.action).toBe("in_use_unknown");
        expect(existsSync(slot)).toBe(true);
    });

    it("leaves a current or newer install alone, even under --fix", () => {
        for (const cached of ["0.43.1", "0.44.0-beta.1"]) {
            const { slot } = makeNpmCache(cached);
            const result = checkOpenCodeV2PluginCache(
                { fix: true, latestVersion: "0.43.1", hostFiles: [] },
                { slot, probe: free },
            );
            expect(result.action).toBe("up_to_date");
            expect(existsSync(slot)).toBe(true);
        }
    });

    it("preserves the slot when latest is unknown unless --force", () => {
        const { slot } = makeNpmCache("0.42.6");
        expect(
            checkOpenCodeV2PluginCache(
                { fix: true, latestVersion: null, hostFiles: [] },
                { slot, probe: free },
            ).action,
        ).toBe("check_unavailable");
        expect(existsSync(slot)).toBe(true);
        expect(
            checkOpenCodeV2PluginCache(
                { force: true, latestVersion: null, hostFiles: [] },
                { slot, probe: free },
            ),
        ).toMatchObject({ action: "cleared", forced: true });
        expect(existsSync(slot)).toBe(false);
    });

    it("reports no install when the slot is missing", () => {
        const slot = getOpenCodeV2PluginCacheSlot(join(tempDir(), "npm"));
        expect(
            checkOpenCodeV2PluginCache(
                { fix: true, latestVersion: "0.43.1", hostFiles: [] },
                { slot },
            ).action,
        ).toBe("not_found");
    });

    it("tells the user to update from OpenCode when stale", () => {
        const lines: string[] = [];
        const outcome = reportOpenCodeV2PluginCache(
            { action: "stale", slot: "/s", cached: "0.42.6", latest: "0.43.1" },
            {
                pass: (m) => lines.push(`pass ${m}`),
                warn: (m) => lines.push(`warn ${m}`),
                info: (m) => lines.push(`info ${m}`),
            },
            { reportMissing: true },
        );
        // An available update warns but doesn't fail doctor: it isn't a broken install.
        expect(outcome).toEqual({ fixed: false, issue: false });
        expect(lines.some((line) => line.startsWith("warn "))).toBe(true);
        expect(lines.join("\n")).toContain("cached: 0.42.6, latest: 0.43.1");
        expect(lines.join("\n")).toContain("ctrl+u");
        expect(lines.join("\n")).toContain("`opencode plugin update`");
        expect(lines.join("\n")).toContain("doctor --fix");
    });
});

describe("doctor OpenCode 2 plugin cache check for dist-tag entries", () => {
    it("reads which dist-tag a config entry follows", () => {
        const tagOf = (entry: unknown) => configuredOpenCodeV2DistTag({ plugins: [entry] });
        expect(tagOf(`${OPENCODE_PLUGIN_NAME}@beta`)).toBe("beta");
        expect(tagOf([`${OPENCODE_PLUGIN_NAME}@next`, {}])).toBe("next");
        expect(tagOf({ package: `${OPENCODE_PLUGIN_NAME}@beta` })).toBe("beta");
        expect(tagOf(`${OPENCODE_PLUGIN_NAME}@latest`)).toBeUndefined();
        expect(tagOf(OPENCODE_PLUGIN_NAME)).toBeUndefined();
        expect(tagOf(`${OPENCODE_PLUGIN_NAME}@0.42.6`)).toBeUndefined();
        expect(tagOf(`${OPENCODE_PLUGIN_NAME}@^0.42.0`)).toBeUndefined();
        expect(configuredOpenCodeV2DistTag({ plugin: ["other-plugin@beta"] })).toBeUndefined();
    });

    it("checks the @beta slot against beta's version, not latest's", () => {
        const { npm } = makeNpmCache("0.43.1");
        const betaSlot = getOpenCodeV2PluginCacheSlot(npm, "beta");
        writeGeneration(betaSlot, "1790000000000", OPENCODE_PLUGIN_NAME, "0.44.0-beta.1");
        const previous = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = join(npm, "..", "..");
        try {
            // Older than beta's current version: stale, even though it is ahead of latest.
            expect(
                checkOpenCodeV2PluginCache({
                    latestVersion: "0.44.0-beta.3",
                    distTag: "beta",
                    hostFiles: [],
                }),
            ).toEqual({
                action: "stale",
                slot: betaSlot,
                cached: "0.44.0-beta.1",
                latest: "0.44.0-beta.3",
                distTag: "beta",
            });
            expect(
                checkOpenCodeV2PluginCache({
                    latestVersion: "0.44.0-beta.1",
                    distTag: "beta",
                    hostFiles: [],
                }).action,
            ).toBe("up_to_date");
        } finally {
            if (previous === undefined) delete process.env.XDG_CACHE_HOME;
            else process.env.XDG_CACHE_HOME = previous;
        }
    });

    it("clears only the @beta slot under --fix and names the tag", () => {
        const { npm, slot: latestSlot } = makeNpmCache("0.43.1");
        const betaSlot = getOpenCodeV2PluginCacheSlot(npm, "beta");
        writeGeneration(betaSlot, "1790000000000", OPENCODE_PLUGIN_NAME, "0.44.0-beta.1");
        const result = checkOpenCodeV2PluginCache(
            { fix: true, latestVersion: "0.44.0-beta.3", distTag: "beta", hostFiles: [] },
            { slot: betaSlot, probe: free },
        );
        expect(result).toMatchObject({ action: "cleared", distTag: "beta" });
        expect(existsSync(betaSlot)).toBe(false);
        expect(existsSync(latestSlot)).toBe(true);

        const lines: string[] = [];
        reportOpenCodeV2PluginCache(
            result,
            { pass: (m) => lines.push(m), warn: (m) => lines.push(m), info: (m) => lines.push(m) },
            { reportMissing: true },
        );
        expect(lines.join("\n")).toContain("cached: 0.44.0-beta.1, beta: 0.44.0-beta.3");
        expect(lines.join("\n")).toContain("@beta");
    });
});

describe("host process probe", () => {
    it("treats a failed lsof as unknown, never as free", () => {
        const dir = tempDir();
        const file = join(dir, "opencode.db");
        writeFileSync(file, "");
        const missing = probeHostProcessesUsing({ files: [file], directories: [] }, () => ({
            status: null,
            error: new Error("spawnSync lsof ENOENT"),
        }));
        expect(missing).toEqual({
            status: "unknown",
            reason: "could not run lsof (spawnSync lsof ENOENT)",
        });
        const crashed = probeHostProcessesUsing({ files: [file], directories: [] }, () => ({
            status: 2,
            stdout: "",
        }));
        expect(crashed.status).toBe("unknown");
    });

    it.skipIf(process.platform === "win32")(
        "finds a real process holding the database open and not after it exits",
        async () => {
            const dir = tempDir();
            const database = join(dir, "opencode.db");
            const slot = join(dir, "slot");
            writeFileSync(database, "");
            mkdirSync(slot);
            expect(probeHostProcessesUsing({ files: [database], directories: [slot] })).toEqual({
                status: "free",
            });

            const holder = Bun.spawn(
                [
                    process.execPath,
                    "-e",
                    "require('node:fs').openSync(process.env.HOLD_FILE, 'r'); console.log('ready'); setInterval(() => {}, 1000);",
                ],
                { windowsHide: true, env: { ...process.env, HOLD_FILE: database }, stdout: "pipe" },
            );
            try {
                const reader = holder.stdout.getReader();
                const { value } = await reader.read();
                expect(new TextDecoder().decode(value)).toContain("ready");
                expect(probeHostProcessesUsing({ files: [database], directories: [slot] })).toEqual(
                    {
                        status: "in_use",
                        pids: [holder.pid],
                    },
                );
            } finally {
                holder.kill();
                await holder.exited;
            }
            expect(probeHostProcessesUsing({ files: [database], directories: [slot] })).toEqual({
                status: "free",
            });
        },
    );
});

it("Windows host probe never spawns lsof and uses process and exclusive lock evidence", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const dbPath = join(tempDir(), "context.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE fixture (id INTEGER)");
    let processes: unknown[] = [
        {
            ProcessId: process.pid,
            ParentProcessId: 0,
            Name: "bun.exe",
            CommandLine: "bun test",
            CreationDate: null,
        },
    ];
    __setRpcIdentityTestHooks({
        platform: "win32",
        processListExecFileSync: (() => JSON.stringify(processes)) as typeof execFileSync,
    });
    const commands: string[] = [];
    const spawn = (command: string) => {
        commands.push(command);
        return { status: 1, stdout: "" };
    };
    try {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        expect(
            probeHostProcessesUsing({ files: [dbPath, `${dbPath}-wal`], directories: [] }, spawn),
        ).toEqual({ status: "free" });
        db.exec("BEGIN EXCLUSIVE");
        const locked = probeHostProcessesUsing({ files: [dbPath], directories: [] }, spawn);
        expect(locked.status).toBe("unknown");
        if (locked.status === "unknown") expect(locked.reason).toContain(dbPath);
        db.exec("ROLLBACK");
        processes = [
            {
                ProcessId: 54321,
                ParentProcessId: 0,
                Name: "opencode.exe",
                CommandLine: "opencode serve",
                CreationDate: null,
            },
        ];
        const held = probeHostProcessesUsing({ files: [dbPath], directories: [] }, spawn);
        expect(held.status).toBe("unknown");
        if (held.status === "unknown") expect(held.reason).toContain("PID 54321");
        expect(commands).toEqual([]);
    } finally {
        Object.defineProperty(process, "platform", descriptor);
        __resetRpcIdentityTestHooks();
        db.close();
    }
});
