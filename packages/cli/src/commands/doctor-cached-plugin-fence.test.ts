/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_SUPPORTED_VERSION } from "@magic-context/core/features/magic-context/storage-db";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import {
    getOpenCodePluginPackageJsonPath,
    getOpenCodeV2PluginCacheSlot,
    OPENCODE_PLUGIN_NAME,
    readReferencedOpenCodePluginSpecs,
} from "../lib/opencode-plugin-cache";
import {
    type CachedPluginFenceFinding,
    compareCachedPluginFences,
    listCachedOpenCodePluginFences,
    readContextDbSchemaVersion,
    reportCachedPluginFences,
} from "./doctor-cached-plugin-fence";

const tempDirs: string[] = [];
afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-cached-fence-"));
    tempDirs.push(dir);
    return dir;
}

/**
 * Write an installed plugin package whose dist carries `fence` the way published
 * builds do: a `var` in a split chunk, a multi-declarator `var` in the OpenCode 2
 * server bundle, and the emitted declaration file.
 */
function writePluginPackage(packageDir: string, version: string, fence: number): void {
    mkdirSync(join(packageDir, "dist", "v2"), { recursive: true });
    mkdirSync(join(packageDir, "dist", "features", "magic-context"), { recursive: true });
    writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({ name: OPENCODE_PLUGIN_NAME, version }),
    );
    writeFileSync(
        join(packageDir, "dist", "index-abc123.js"),
        `var LATEST_SUPPORTED_VERSION = ${fence};\n`,
    );
    writeFileSync(
        join(packageDir, "dist", "v2", "server.js"),
        `var databases, lastSchemaFenceRejection = null, LATEST_SUPPORTED_VERSION = ${fence}, other;\n`,
    );
    writeFileSync(
        join(packageDir, "dist", "features", "magic-context", "storage-db.d.ts"),
        `export declare const LATEST_SUPPORTED_VERSION = ${fence};\n`,
    );
}

/** An OpenCode 1 `packages/<name>@latest` root holding `version` with `fence`. */
function writeOpenCodeV1Root(cacheDir: string, version: string, fence: number): string {
    const root = join(cacheDir, `${OPENCODE_PLUGIN_NAME}@latest`);
    writePluginPackage(join(getOpenCodePluginPackageJsonPath(root), ".."), version, fence);
    return root;
}

/** An OpenCode 2 `npm/<name>@<spec>/<generation>/` install holding `version` with `fence`. */
function writeOpenCodeV2Generation(
    npmDir: string,
    spec: string,
    generation: string,
    version: string,
    fence: number,
): string {
    const slot = getOpenCodeV2PluginCacheSlot(npmDir, spec);
    writePluginPackage(
        join(getOpenCodePluginPackageJsonPath(join(slot, generation)), ".."),
        version,
        fence,
    );
    return slot;
}

/** A throwaway context.db whose upstream migration lane stops at `version`. */
function writeContextDb(dir: string, version: number): string {
    const path = join(dir, "context.db");
    const db = new Database(path);
    try {
        db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
        for (const applied of [version - 1, version]) {
            db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(applied);
        }
    } finally {
        db.close();
    }
    return path;
}

function collectReport(findings: CachedPluginFenceFinding[]) {
    const lines: Array<{ kind: "pass" | "fail" | "info"; message: string }> = [];
    const result = reportCachedPluginFences(findings, {
        pass: (message) => lines.push({ kind: "pass", message }),
        fail: (message) => lines.push({ kind: "fail", message }),
        info: (message) => lines.push({ kind: "info", message }),
    });
    return { lines, result };
}

describe("cached plugin schema fence vs shared context.db", () => {
    it("names the OpenCode 1 cache whose fence is behind a database OpenCode 2 migrated", () => {
        const root = tempDir();
        const v1Root = writeOpenCodeV1Root(join(root, "opencode", "packages"), "0.42.6", 89);
        const npm = join(root, "opencode", "npm");
        // An older generation behind the one the host loads must not be the one read.
        writeOpenCodeV2Generation(npm, "latest", "1790000000000", "0.42.6", 89);
        const v2Slot = writeOpenCodeV2Generation(npm, "latest", "1790000000001", "0.43.1", 91);
        const databaseVersion = readContextDbSchemaVersion(writeContextDb(root, 91));
        expect(databaseVersion).toBe(91);

        const findings = compareCachedPluginFences(
            listCachedOpenCodePluginFences({
                openCodeV1Roots: [v1Root, join(root, "opencode", "packages", "missing")],
                openCodeV2NpmCacheDir: npm,
            }),
            databaseVersion ?? 0,
        );

        expect(findings).toEqual([
            {
                host: "opencode1",
                directory: v1Root,
                version: "0.42.6",
                supportedVersion: 89,
                databaseVersion: 91,
                status: "behind",
            },
            {
                host: "opencode2",
                directory: v2Slot,
                spec: "latest",
                version: "0.43.1",
                supportedVersion: 91,
                databaseVersion: 91,
                status: "supported",
            },
        ]);

        const { lines, result } = collectReport(findings);
        expect(result).toEqual({ behind: 1 });
        const failures = lines.filter((line) => line.kind === "fail");
        expect(failures).toHaveLength(1);
        expect(failures[0]?.message).toContain("OpenCode 1 has Magic Context 0.42.6 cached");
        expect(failures[0]?.message).toContain("through schema v89");
        expect(failures[0]?.message).toContain("context.db is at v91");
        expect(lines).toContainEqual({ kind: "info", message: `  ${v1Root}` });
        expect(lines).toContainEqual({
            kind: "info",
            message:
                "  To fix: quit OpenCode 1 and delete that directory; OpenCode 1 installs the current release on its next start.",
        });
        expect(lines).toContainEqual({
            kind: "pass",
            message:
                "Cached Magic Context copies support context.db v91: OpenCode 2 0.43.1 (fence v91)",
        });
    });

    it("tells OpenCode 2 users to update from the host when its slot is behind", () => {
        const root = tempDir();
        const npm = join(root, "opencode", "npm");
        const latestSlot = writeOpenCodeV2Generation(npm, "latest", "1", "0.42.6", 89);
        const betaSlot = writeOpenCodeV2Generation(npm, "beta", "1", "0.44.0-beta.1", 92);
        // A version-pinned slot is the pinned-entry check's concern, not this one's.
        writeOpenCodeV2Generation(npm, "0.40.0", "1", "0.40.0", 80);
        const databaseVersion = readContextDbSchemaVersion(writeContextDb(root, 91)) ?? 0;

        const findings = compareCachedPluginFences(
            listCachedOpenCodePluginFences({ openCodeV1Roots: [], openCodeV2NpmCacheDir: npm }),
            databaseVersion,
        );
        expect(findings.map((finding) => [finding.directory, finding.status])).toEqual([
            [latestSlot, "behind"],
            [betaSlot, "supported"],
        ]);

        const { lines } = collectReport(findings);
        expect(lines.find((line) => line.kind === "fail")?.message).toContain(
            "OpenCode 2 has Magic Context 0.42.6 cached",
        );
        expect(lines).toContainEqual({ kind: "info", message: `  ${latestSlot}` });
        const hint = lines.find((line) => line.message.startsWith("  To fix"))?.message ?? "";
        expect(hint).toContain("ctrl+u");
        expect(hint).toContain("opencode plugin update");
        expect(lines).toContainEqual({
            kind: "pass",
            message:
                "Cached Magic Context copies support context.db v91: OpenCode 2 (@beta) 0.44.0-beta.1 (fence v92)",
        });
    });

    it("reports a copy without a readable fence as unknown, not behind or healthy", () => {
        const root = tempDir();
        const v1Root = join(root, "opencode", "packages", `${OPENCODE_PLUGIN_NAME}@latest`);
        const packageDir = join(getOpenCodePluginPackageJsonPath(v1Root), "..");
        mkdirSync(join(packageDir, "dist"), { recursive: true });
        writeFileSync(
            join(packageDir, "package.json"),
            JSON.stringify({ name: OPENCODE_PLUGIN_NAME, version: "0.30.0" }),
        );
        writeFileSync(join(packageDir, "dist", "index.js"), "export {};\n");

        const findings = compareCachedPluginFences(
            listCachedOpenCodePluginFences({
                openCodeV1Roots: [v1Root],
                openCodeV2NpmCacheDir: root,
            }),
            91,
        );
        expect(findings.map((finding) => finding.status)).toEqual(["unknown"]);
        const { lines, result } = collectReport(findings);
        expect(result).toEqual({ behind: 0 });
        expect(lines.map((line) => line.kind)).toEqual(["info", "info"]);
    });

    it("measures a database newer than this CLI's own fence", () => {
        const root = tempDir();
        const path = writeContextDb(root, LATEST_SUPPORTED_VERSION + 1);
        expect(readContextDbSchemaVersion(path)).toBe(LATEST_SUPPORTED_VERSION + 1);
        expect(readContextDbSchemaVersion(join(root, "absent.db"))).toBeNull();
    });
});

describe("cached plugin schema fence vs what the config loads", () => {
    /** The operator's layout: an old OpenCode 1 `@latest` cache and an old OpenCode 2 `@latest` slot. */
    function staleCaches() {
        const root = tempDir();
        const v1Root = writeOpenCodeV1Root(join(root, "opencode", "packages"), "0.31.2", 50);
        const npm = join(root, "opencode", "npm");
        const v2Slot = writeOpenCodeV2Generation(npm, "latest", "1", "0.31.2", 50);
        return { v1Root, npm, v2Slot };
    }

    function findingsFor(config: Record<string, unknown>) {
        const { v1Root, npm, v2Slot } = staleCaches();
        const findings = compareCachedPluginFences(
            listCachedOpenCodePluginFences({
                openCodeV1Roots: [v1Root],
                openCodeV2NpmCacheDir: npm,
                referencedSpecs: {
                    opencode1: readReferencedOpenCodePluginSpecs(config, "opencode1"),
                    opencode2: readReferencedOpenCodePluginSpecs(config, "opencode2"),
                },
            }),
            95,
        );
        return { findings, v1Root, v2Slot };
    }

    it("does not fail a host whose config loads Magic Context from a file:// path", () => {
        const { findings } = findingsFor({
            plugin: ["file:///dev/magic-context/packages/plugin", "other-plugin@latest"],
        });
        expect(findings).toEqual([]);
        const { lines, result } = collectReport(findings);
        expect(result).toEqual({ behind: 0 });
        expect(lines).toEqual([]);
    });

    it("still fails a stale cache that an @latest entry loads", () => {
        const { findings, v1Root, v2Slot } = findingsFor({
            plugin: [`${OPENCODE_PLUGIN_NAME}@latest`],
        });
        expect(findings.map((finding) => [finding.directory, finding.status])).toEqual([
            [v1Root, "behind"],
            [v2Slot, "behind"],
        ]);
        const { lines, result } = collectReport(findings);
        expect(result).toEqual({ behind: 2 });
        expect(lines.filter((line) => line.kind === "fail")[0]?.message).toContain(
            "OpenCode 1 has Magic Context 0.31.2 cached, which supports context.db only through schema v50, but the shared context.db is at v95",
        );
    });

    it("leaves the @latest caches out when the entry pins a version", () => {
        const { findings } = findingsFor({ plugin: [`${OPENCODE_PLUGIN_NAME}@0.45.0`] });
        expect(findings).toEqual([]);
    });

    it("judges each host by the arrays it reads", () => {
        // OpenCode 1 ignores the native `plugins` array; OpenCode 2 reads it.
        const { findings, v2Slot } = findingsFor({
            plugin: ["file:///dev/magic-context/packages/plugin"],
            plugins: [`${OPENCODE_PLUGIN_NAME}@latest`],
        });
        expect(findings.map((finding) => [finding.host, finding.directory])).toEqual([
            ["opencode2", v2Slot],
        ]);
    });
});
