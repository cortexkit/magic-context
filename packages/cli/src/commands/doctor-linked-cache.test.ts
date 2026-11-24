import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { OmpAdapter, OpenCodeAdapter, PiAdapter } from "../adapters";
import {
    getOpenCodePluginCacheRoots,
    getOpenCodePluginPackageJsonPath,
    getOpenCodeV2PluginCacheSlot,
} from "../lib/opencode-plugin-cache";
import { getOmpPluginsDir, getOpenCodePluginCacheDir } from "../lib/paths";
import * as prompts from "../lib/prompts";
import { runDoctor } from "./doctor";
import { clearPluginCache } from "./doctor-opencode-cache";
import { checkOpenCodeV2PluginCache, reportOpenCodeV2PluginCache } from "./doctor-opencode2-cache";

let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
    root = createTestTempDirFromPath(join(tmpdir(), "mc-doctor-linked-cache-"));
    env = { ...process.env };
    Object.assign(process.env, {
        HOME: root,
        PI_CODING_AGENT_DIR: join(root, ".omp", "agent"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
    });
    delete process.env.PI_CONFIG_DIR;
    delete process.env.PI_PROFILE;
    delete process.env.OMP_PROFILE;
});
afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(root, { recursive: true, force: true });
});

function writeCachedVersion(install: string): void {
    const manifest = getOpenCodePluginPackageJsonPath(install);
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ version: "0.49.66" }));
}

test("OpenCode 1 leaves a linked cache candidate in place and clears its real sibling", async () => {
    const [linked, real] = getOpenCodePluginCacheRoots();
    if (!linked || !real) throw new Error("Expected both OpenCode 1 cache paths");
    const source = join(root, "source");
    writeCachedVersion(source);
    writeCachedVersion(real);
    symlinkSync(source, linked, "junction");

    const result = await clearPluginCache(
        { latestVersion: "0.49.74" },
        { probe: () => ({ status: "free" }) },
    );

    expect(existsSync(linked)).toBe(true);
    expect(existsSync(getOpenCodePluginPackageJsonPath(source))).toBe(true);
    expect(existsSync(real)).toBe(false);
    expect(result.action).toBe("cleared");
    expect(result.skippedWarnings).toEqual([expect.stringContaining(`Left ${linked} alone`)]);
});

test("OpenCode 2 rechecks the slot after a probe replaces its scope with a link", () => {
    const slot = getOpenCodeV2PluginCacheSlot();
    const scope = dirname(slot);
    const source = join(root, "source");
    writeCachedVersion(join(slot, "1234"));

    const result = checkOpenCodeV2PluginCache(
        { fix: true, latestVersion: "0.49.74", hostFiles: [] },
        {
            probe: () => {
                renameSync(scope, source);
                symlinkSync(source, scope, "junction");
                return { status: "free" };
            },
        },
    );

    expect(
        existsSync(
            getOpenCodePluginPackageJsonPath(join(source, "opencode-magic-context@latest", "1234")),
        ),
    ).toBe(true);
    const warnings: string[] = [];
    expect(
        reportOpenCodeV2PluginCache(
            result,
            { pass: () => {}, info: () => {}, warn: (message) => warnings.push(message) },
            { reportMissing: true },
        ).fixed,
    ).toBe(false);
    expect(warnings.join("\n")).toContain(`Left ${slot} alone`);
});

test("doctor --clear leaves an OMP cache behind a newly linked folder and clears OpenCode packages", async () => {
    const plugins = getOmpPluginsDir();
    const ompCache = join(plugins, "cache");
    const openCodeCache = getOpenCodePluginCacheDir();
    const source = join(root, "source");
    mkdirSync(openCodeCache, { recursive: true });
    mkdirSync(ompCache, { recursive: true });
    writeFileSync(join(ompCache, "marker"), "keep");
    const stubs = [
        spyOn(OpenCodeAdapter.prototype, "isInstalled").mockReturnValue(true),
        spyOn(OmpAdapter.prototype, "isInstalled").mockReturnValue(true),
        spyOn(PiAdapter.prototype, "isInstalled").mockReturnValue(false),
        spyOn(prompts, "selectMany").mockImplementation(async (_message, options) =>
            options.map((option) => option.value).reverse(),
        ),
        spyOn(prompts, "confirm").mockImplementation(async () => {
            renameSync(plugins, source);
            symlinkSync(source, plugins, "junction");
            return true;
        }),
        spyOn(prompts.log, "warn").mockImplementation(() => {}),
    ];
    try {
        await runDoctor({ clear: true });
        expect(existsSync(join(source, "cache", "marker"))).toBe(true);
        expect(existsSync(openCodeCache)).toBe(false);
        expect(prompts.log.warn).toHaveBeenCalledWith(
            expect.stringContaining(`Left ${ompCache} alone`),
        );
    } finally {
        for (const stub of stubs) stub.mockRestore();
    }
});
