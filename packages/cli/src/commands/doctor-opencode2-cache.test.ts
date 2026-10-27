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
import { checkLocalEmbeddingRuntime } from "../lib/embedding-runtime";
import {
    getOpenCodeLoadedPluginInstallRoots,
    getOpenCodePluginCacheRoots,
    getOpenCodePluginInstallRoots,
    getOpenCodeV2PluginCacheSlot,
    OPENCODE_PLUGIN_NAME,
    openCodeV2SlotSpec,
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

describe("doctor local embedding runtime on OpenCode 2", () => {
    /** An XDG cache root with OpenCode 2 slots `@latest` (two generations) and `@beta`. */
    function withCache(run: (cache: string, npm: string) => void): void {
        const cache = tempDir();
        const npm = join(cache, "opencode", "npm");
        const latest = getOpenCodeV2PluginCacheSlot(npm);
        writeGeneration(latest, "1790000000000", OPENCODE_PLUGIN_NAME, "0.48.0");
        writeGeneration(latest, "1790000000001", OPENCODE_PLUGIN_NAME, "0.49.24");
        writeGeneration(
            getOpenCodeV2PluginCacheSlot(npm, "beta"),
            "1790000000002",
            OPENCODE_PLUGIN_NAME,
            "0.50.0-beta.1",
        );
        const previous = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cache;
        try {
            run(cache, npm);
        } finally {
            if (previous === undefined) delete process.env.XDG_CACHE_HOME;
            else process.env.XDG_CACHE_HOME = previous;
        }
    }

    it("inspects the newest generation of the configured slot first, then the other copies", () => {
        withCache((cache, npm) => {
            const latest = join(getOpenCodeV2PluginCacheSlot(npm), "1790000000001");
            const beta = join(getOpenCodeV2PluginCacheSlot(npm, "beta"), "1790000000002");
            const v1 = [
                join(cache, "opencode", "packages", `${OPENCODE_PLUGIN_NAME}@latest`),
                join(cache, "opencode", "packages", OPENCODE_PLUGIN_NAME),
            ];
            expect(getOpenCodePluginInstallRoots("v2", { plugin: [OPENCODE_PLUGIN_NAME] })).toEqual(
                [latest, beta, ...v1],
            );
            expect(
                getOpenCodePluginInstallRoots("v2", {
                    plugins: [{ package: `${OPENCODE_PLUGIN_NAME}@beta` }],
                }),
            ).toEqual([beta, latest, ...v1]);
            // OpenCode 1 keeps its own `packages/` roots first.
            expect(getOpenCodePluginInstallRoots("v1", null)).toEqual([...v1, latest, beta]);
        });
    });

    it("finds the installed OpenCode 2 copy that OpenCode 1's cache roots never see", () => {
        withCache((_cache, npm) => {
            const newest = join(getOpenCodeV2PluginCacheSlot(npm), "1790000000001");
            // Before, doctor looked only in OpenCode 1's `packages/` roots, found
            // nothing and reported the runtime as unverified.
            expect(checkLocalEmbeddingRuntime(getOpenCodePluginCacheRoots()).state).toBe("unknown");
            const status = checkLocalEmbeddingRuntime(
                getOpenCodePluginInstallRoots("v2", null),
                "linux",
                "x64",
                "native",
            );
            expect(status.state).not.toBe("unknown");
            expect(JSON.stringify(status)).toContain(
                JSON.stringify(join(newest, "node_modules", "onnxruntime-node")).slice(1, -1),
            );
        });
    });

    it("names a range spec's slot the way OpenCode 2 does on Windows", () => {
        expect(openCodeV2SlotSpec(">=0.49 <1", "win32")).toBe("_=0.49 _1");
        expect(openCodeV2SlotSpec(">=0.49 <1", "linux")).toBe(">=0.49 <1");
        expect(openCodeV2SlotSpec("latest", "win32")).toBe("latest");
        const npm = join(tempDir(), "opencode", "npm");
        const ranged = join(npm, "@cortexkit", "opencode-magic-context@_=0.49");
        writeGeneration(ranged, "1790000000003", OPENCODE_PLUGIN_NAME, "0.49.24");
        writeGeneration(getOpenCodeV2PluginCacheSlot(npm), "1", OPENCODE_PLUGIN_NAME, "0.49.24");
        const roots = getOpenCodePluginInstallRoots(
            "v2",
            { plugin: [`${OPENCODE_PLUGIN_NAME}@>=0.49`] },
            npm,
            "win32",
        );
        expect(roots[0]).toBe(join(ranged, "1790000000003"));
    });

    it("checks only the copy the host loads, so a healthy unused copy cannot hide a broken one", () => {
        withCache((cache, npm) => {
            const latest = join(getOpenCodeV2PluginCacheSlot(npm), "1790000000001");
            const beta = join(getOpenCodeV2PluginCacheSlot(npm, "beta"), "1790000000002");
            const v1 = join(cache, "opencode", "packages", OPENCODE_PLUGIN_NAME);
            // The unused `@beta` slot and an OpenCode 1 copy have a working
            // native runtime; the loaded `@latest` copy has none.
            for (const root of [beta, v1]) {
                const binDir = join(
                    root,
                    "node_modules",
                    "onnxruntime-node",
                    "bin",
                    "napi-v6",
                    "win32",
                    "x64",
                );
                mkdirSync(binDir, { recursive: true });
                writeFileSync(
                    join(root, "node_modules", "onnxruntime-node", "package.json"),
                    JSON.stringify({
                        name: "onnxruntime-node",
                        version: "1.23.0",
                        main: "index.js",
                    }),
                );
                writeFileSync(
                    join(root, "node_modules", "onnxruntime-node", "index.js"),
                    "module.exports = {};\n",
                );
                writeFileSync(join(binDir, "onnxruntime_binding.node"), "stub");
            }
            const check = (roots: string[]) =>
                checkLocalEmbeddingRuntime(roots, "win32", "x64", "native").state;
            // Every copy at once: the first healthy one wins (the false green).
            expect(check(getOpenCodePluginInstallRoots("v2", null))).toBe("ok");
            const installs = getOpenCodeLoadedPluginInstallRoots("v2", {
                plugin: [OPENCODE_PLUGIN_NAME],
            });
            expect(installs.loaded).toEqual([latest]);
            expect(installs.others).toContain(beta);
            expect(installs.others).toContain(v1);
            expect(check(installs.loaded)).not.toBe("ok");
            // With `@beta` configured, the host loads that slot instead.
            const onBeta = getOpenCodeLoadedPluginInstallRoots("v2", {
                plugin: [`${OPENCODE_PLUGIN_NAME}@beta`],
            });
            expect(onBeta.loaded).toEqual([beta]);
            expect(check(onBeta.loaded)).toBe("ok");
            // A configured slot that is not installed is unverified, not ok.
            const missing = getOpenCodeLoadedPluginInstallRoots("v2", {
                plugin: [`${OPENCODE_PLUGIN_NAME}@0.1.0`],
            });
            expect(missing.loaded).toEqual([]);
            expect(check(missing.loaded)).toBe("unknown");
            // On OpenCode 1 the `packages/` tree is what loads.
            const onV1 = getOpenCodeLoadedPluginInstallRoots("v1", null);
            expect(onV1.loaded).toEqual(getOpenCodePluginCacheRoots());
            expect(onV1.others).toEqual([latest, beta]);
            expect(check(onV1.loaded)).toBe("ok");
        });
    });
});
