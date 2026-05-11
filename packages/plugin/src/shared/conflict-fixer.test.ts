/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "comment-json";
import { fixConflicts } from "./conflict-fixer";

const noOmoConflicts = {
    omoPreemptiveCompaction: false,
    omoContextWindowMonitor: false,
    omoAnthropicRecovery: false,
};

describe("fixConflicts", () => {
    let root: string;
    let projectDir: string;
    let userConfigDir: string;
    let originalEnv: Record<string, string | undefined>;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "mc-conflict-fixer-"));
        projectDir = join(root, "project");
        userConfigDir = join(root, "user-config", "opencode");
        mkdirSync(projectDir, { recursive: true });
        mkdirSync(userConfigDir, { recursive: true });
        originalEnv = {
            OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        };
        process.env.OPENCODE_CONFIG_DIR = userConfigDir;
        delete process.env.XDG_CONFIG_HOME;
    });

    afterEach(() => {
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(root, { recursive: true, force: true });
    });

    it("preserves JSONC comments and tuple plugin entries while removing canonical DCP", () => {
        const configPath = join(projectDir, "opencode.jsonc");
        writeFileSync(
            configPath,
            `{
  // keep this file-level comment
  "plugin": [
    ["@plannotator/opencode@latest", { "workflow": "plan-agent" }],
    ["@tarquinen/opencode-dcp@latest", { "enabled": true }],
    "@cortexkit/opencode-magic-context@latest"
  ],
  "compaction": {
    // keep this compaction comment
    "auto": true,
    "prune": true
  }
}
`,
        );

        const actions = fixConflicts(projectDir, {
            compactionAuto: true,
            compactionPrune: true,
            dcpPlugin: true,
            ...noOmoConflicts,
        });

        const updatedText = readFileSync(configPath, "utf-8");
        const updated = parseJsonc(updatedText) as Record<string, unknown>;
        expect(actions).toEqual(["Disabled auto-compaction", "Removed opencode-dcp plugin"]);
        expect(updatedText).toContain("keep this file-level comment");
        expect(updatedText).toContain("keep this compaction comment");
        expect(updated.compaction).toEqual({ auto: false, prune: false });
        expect(updated.plugin).toEqual([
            ["@plannotator/opencode@latest", { workflow: "plan-agent" }],
            "@cortexkit/opencode-magic-context@latest",
        ]);
    });

    it("skips non-existent target files instead of creating user config", () => {
        const actions = fixConflicts(projectDir, {
            compactionAuto: true,
            compactionPrune: true,
            dcpPlugin: true,
            ...noOmoConflicts,
        });

        expect(actions).toEqual([]);
        expect(existsSync(join(userConfigDir, "opencode.json"))).toBe(false);
        expect(existsSync(join(userConfigDir, "opencode.jsonc"))).toBe(false);
    });

    it("keeps DCP forks and substring-only names because matching is canonical", () => {
        const configPath = join(projectDir, "opencode.json");
        writeFileSync(
            configPath,
            JSON.stringify({
                plugin: [
                    "@some-fork/opencode-dcp-fork",
                    "file:///tmp/opencode-dcp-dev",
                    ["@other/opencode-dcp-slim@latest", { enabled: true }],
                ],
            }),
        );

        const actions = fixConflicts(projectDir, {
            compactionAuto: false,
            compactionPrune: false,
            dcpPlugin: true,
            ...noOmoConflicts,
        });

        const updated = parseJsonc(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
        expect(actions).toEqual([]);
        expect(updated.plugin).toEqual([
            "@some-fork/opencode-dcp-fork",
            "file:///tmp/opencode-dcp-dev",
            ["@other/opencode-dcp-slim@latest", { enabled: true }],
        ]);
    });
});
