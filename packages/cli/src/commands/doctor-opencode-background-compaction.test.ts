import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readJsoncFile } from "@magic-context/core/shared/jsonc-parser";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { checkOpenCodeBackgroundCompaction } from "./doctor-opencode-background-compaction";

const envKeys = [
    "HOME",
    "XDG_CONFIG_HOME",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
] as const;
let env: Record<string, string | undefined>;
let root: string;
let project: string;
let user: string;

beforeEach(() => {
    env = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    root = createTestTempDirFromPath(join(tmpdir(), "mc-doctor-background-"));
    process.env.HOME = join(root, "home");
    process.env.XDG_CONFIG_HOME = join(root, "config");
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG;
    delete process.env.OPENCODE_CONFIG_CONTENT;
    project = join(root, "project");
    user = join(
        root,
        process.platform === "win32" ? "home/.config" : "config",
        "opencode",
        "opencode.jsonc",
    );
});

afterEach(() => {
    for (const key of envKeys) {
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
    }
    rmSync(root, { recursive: true, force: true });
});

function put(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
}

function check({ version = "2.4.2", fix = false, compactionEnabled = true } = {}) {
    const warnings: string[] = [];
    const writes: string[] = [];
    const info: string[] = [];
    checkOpenCodeBackgroundCompaction(
        project,
        version,
        { fix, compactionEnabled },
        {
            warn: (text) => warnings.push(text),
            wrote: (text) => writes.push(text),
            info: (text) => info.push(text),
        },
    );
    return { warnings, writes, info };
}

test("reports background preparation with default host settings at 2.3.1 without writing", () => {
    const result = check({ version: "2.3.1" });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("compaction.background");
    expect(result.warnings[0]).toContain(
        "If /compact uses a prepared answer, Magic Context does not shrink the next request",
    );
    expect(result.writes).toEqual([]);
    expect(existsSync(user)).toBe(false);
});

test("doctor --fix adds only background: false in a fresh user file and needs no restart", () => {
    const result = check({ fix: true });
    expect(readJsoncFile(user)).toEqual({ compaction: { background: false } });
    expect(result.writes).toEqual([`Set compaction.background: false in ${user}`]);
    expect(result.info.join(" ")).toContain("No OpenCode restart is needed");
    expect(check({ fix: true })).toEqual({ warnings: [], writes: [], info: [] });
});

test.each([
    "1.18.31",
    "2.0.22",
    "2.1.0",
    "2.3.0",
    "2.3.1-preview.1",
])("reports nothing on OpenCode %s", (version) => {
    expect(check({ version, fix: true })).toEqual({ warnings: [], writes: [], info: [] });
    expect(existsSync(user)).toBe(false);
});

test("reports nothing when Magic Context compaction is off", () => {
    put(user, '{"compaction":{"background":true}}');
    expect(check({ fix: true, compactionEnabled: false })).toEqual({
        warnings: [],
        writes: [],
        info: [],
    });
    expect(readFileSync(user, "utf-8")).toBe('{"compaction":{"background":true}}');
});

test.each(['"auto": false', '"background": false'])("reports nothing with %s", (setting) => {
    const original = `{ "compaction": { ${setting} } }\n`;
    put(user, original);
    expect(check({ fix: true })).toEqual({ warnings: [], writes: [], info: [] });
    expect(readFileSync(user, "utf-8")).toBe(original);
});

test("adds the setting to the existing global JSON target without replacing other keys", () => {
    const json = user.slice(0, -1);
    put(json, '{ "model": "provider/model" }\n');
    const result = check({ fix: true });
    expect(readJsoncFile(json)).toEqual({
        model: "provider/model",
        compaction: { background: false },
    });
    expect(result.writes).toEqual([`Set compaction.background: false in ${json}`]);
    expect(existsSync(user)).toBe(false);
});

test("updates explicit project overrides and preserves comments and project files with no override", () => {
    const direct = join(project, "opencode.jsonc");
    const dot = join(project, ".opencode", "opencode.jsonc");
    const untouched = join(project, ".opencode", "opencode.json");
    const original = `{
  // existing project behavior
  "compaction": {
    "background": true, // update only this setting
    "auto": true,
    "keep": { "tokens": 42 }
  }
}\n`;
    put(user, `\uFEFF${original}`);
    put(direct, original);
    put(dot, original);
    put(untouched, '{ "compaction": { "buffer": 1000 } }');
    expect(check().warnings).toHaveLength(1);
    expect(readFileSync(user, "utf-8")).toBe(`\uFEFF${original}`);
    expect(readFileSync(dot, "utf-8")).toBe(original);

    const result = check({ fix: true });
    for (const path of [user, direct, dot]) {
        const expected = original.replace('"background": true', '"background": false');
        expect(readFileSync(path, "utf-8")).toBe(path === user ? `\uFEFF${expected}` : expected);
        expect(result.writes).toContain(`Set compaction.background: false in ${path}`);
    }
    expect(result.writes).toHaveLength(3);
    expect(result.warnings).toHaveLength(1);
    expect(readFileSync(untouched, "utf-8")).toBe('{ "compaction": { "buffer": 1000 } }');
});

test("uses OpenCode 2 precedence when the explicit file overrides a supplementary global value", () => {
    const supplementary = join(root, "supplementary");
    const explicit = join(root, "explicit.jsonc");
    process.env.OPENCODE_CONFIG_DIR = supplementary;
    process.env.OPENCODE_CONFIG = explicit;
    put(join(supplementary, "opencode.jsonc"), '{ "compaction": { "background": false } }');
    const override = '{ "compaction": { "background": true } }';
    put(explicit, override);

    const result = check({ fix: true });
    expect(result.writes).toEqual([]);
    expect(result.warnings.at(-1)).toContain(`Check compaction.background in: ${explicit}`);
    expect(result.info.join(" ")).not.toContain("is disabled");
    expect(readFileSync(explicit, "utf-8")).toBe(override);

    put(join(project, ".opencode", "opencode.jsonc"), '{ "compaction": { "auto": false } }');
    expect(check({ fix: true })).toEqual({ warnings: [], writes: [], info: [] });
});

test("reports malformed files and leaves them alone rather than claiming the setting is disabled", () => {
    const malformed = '{ "compaction":';
    put(user, malformed);
    const dot = join(project, ".opencode", "opencode.jsonc");
    put(dot, malformed);
    process.env.OPENCODE_CONFIG_CONTENT = '{ "compaction": { "background": true } }';

    const result = check({ fix: true });
    expect(result.writes).toEqual([]);
    for (const path of [user, dot]) {
        expect(readFileSync(path, "utf-8")).toBe(malformed);
        expect(
            result.warnings.some((warning) =>
                warning.startsWith(`Could not set compaction.background in ${path}:`),
            ),
        ).toBe(true);
        expect(result.warnings.at(-1)).toContain(path);
    }
    expect(result.warnings.at(-1)).toContain("OPENCODE_CONFIG_CONTENT");
    expect(result.info.join(" ")).not.toContain("is disabled");
});
