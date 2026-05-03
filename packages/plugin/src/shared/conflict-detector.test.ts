/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectConflicts } from "./conflict-detector";

/**
 * Regression tests for plugin-conflict detection. The previous substring-
 * based matcher misclassified `oh-my-opencode-slim` and `opencode-dcp-fork`
 * as the canonical plugins, causing magic-context to disable itself with
 * a false-positive conflict warning. See issue #43.
 */
describe("detectConflicts", () => {
    let projectDir: string;
    let userConfigDir: string;
    let originalEnv: Record<string, string | undefined>;

    beforeEach(() => {
        const root = mkdtempSync(join(tmpdir(), "mc-conflict-"));
        projectDir = join(root, "project");
        mkdirSync(projectDir, { recursive: true });
        userConfigDir = join(root, "user-config", "opencode");
        mkdirSync(userConfigDir, { recursive: true });

        // Save and override every env var that affects config-path resolution.
        // OPENCODE_CONFIG_DIR takes precedence over XDG_CONFIG_HOME, so we set
        // it directly and clear XDG to fully isolate from any inherited or
        // test-leaked state.
        originalEnv = {
            OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            OPENCODE_DISABLE_AUTOCOMPACT: process.env.OPENCODE_DISABLE_AUTOCOMPACT,
        };
        process.env.OPENCODE_CONFIG_DIR = userConfigDir;
        delete process.env.XDG_CONFIG_HOME;
        // Disable auto-compaction default during tests so we isolate plugin
        // detection from compaction detection.
        process.env.OPENCODE_DISABLE_AUTOCOMPACT = "1";
    });

    afterEach(() => {
        for (const [k, v] of Object.entries(originalEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        // Test directories live under tmpdir(); cleanup is best-effort.
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(userConfigDir, { recursive: true, force: true });
    });

    function writeProjectConfig(plugins: Array<string | [string, unknown]>): void {
        writeFileSync(join(projectDir, "opencode.json"), JSON.stringify({ plugin: plugins }));
    }

    // --- DCP detection ---

    describe("DCP detection", () => {
        it("matches the canonical @tarquinen/opencode-dcp package", () => {
            writeProjectConfig(["@tarquinen/opencode-dcp"]);
            const result = detectConflicts(projectDir);
            expect(result.conflicts.dcpPlugin).toBe(true);
        });

        it("matches the canonical package with a version suffix", () => {
            writeProjectConfig(["@tarquinen/opencode-dcp@latest"]);
            const result = detectConflicts(projectDir);
            expect(result.conflicts.dcpPlugin).toBe(true);
        });

        it("matches with a semver range suffix", () => {
            writeProjectConfig(["@tarquinen/opencode-dcp@^3.1.0"]);
            const result = detectConflicts(projectDir);
            expect(result.conflicts.dcpPlugin).toBe(true);
        });

        it("does NOT match a fork with a different package name", () => {
            writeProjectConfig(["@some-fork/opencode-dcp-fork"]);
            const result = detectConflicts(projectDir);
            expect(result.conflicts.dcpPlugin).toBe(false);
        });

        it("does NOT match a file:// path that contains 'opencode-dcp'", () => {
            writeProjectConfig(["file:///home/user/work/opencode-dcp-fork"]);
            const result = detectConflicts(projectDir);
            expect(result.conflicts.dcpPlugin).toBe(false);
        });
    });

    // --- OMO detection (the issue #43 case) ---

    describe("OMO detection", () => {
        it("matches the canonical oh-my-opencode package", () => {
            writeProjectConfig(["oh-my-opencode"]);
            const result = detectConflicts(projectDir);
            // No OMO config = hooks default ACTIVE = all three flagged
            expect(result.conflicts.omoPreemptiveCompaction).toBe(true);
            expect(result.conflicts.omoContextWindowMonitor).toBe(true);
            expect(result.conflicts.omoAnthropicRecovery).toBe(true);
        });

        it("matches the canonical oh-my-openagent package alias", () => {
            writeProjectConfig(["oh-my-openagent"]);
            const result = detectConflicts(projectDir);
            expect(result.conflicts.omoPreemptiveCompaction).toBe(true);
        });

        it("matches a canonical OMO with a version suffix", () => {
            writeProjectConfig(["oh-my-opencode@3.17.5", "oh-my-openagent@latest"]);
            const result = detectConflicts(projectDir);
            expect(result.conflicts.omoPreemptiveCompaction).toBe(true);
            expect(result.conflicts.omoContextWindowMonitor).toBe(true);
            expect(result.conflicts.omoAnthropicRecovery).toBe(true);
        });

        it("does NOT match oh-my-opencode-slim (issue #43)", () => {
            writeProjectConfig(["oh-my-opencode-slim"]);
            const result = detectConflicts(projectDir);
            expect(result.hasConflict).toBe(false);
            expect(result.conflicts.omoPreemptiveCompaction).toBe(false);
            expect(result.conflicts.omoContextWindowMonitor).toBe(false);
            expect(result.conflicts.omoAnthropicRecovery).toBe(false);
        });

        it("does NOT match oh-my-opencode-slim with a version suffix (issue #43)", () => {
            writeProjectConfig(["oh-my-opencode-slim@latest", "oh-my-opencode-slim@1.0.3"]);
            const result = detectConflicts(projectDir);
            expect(result.hasConflict).toBe(false);
        });

        it("does NOT match a file:// path containing 'oh-my-opencode' (issue #43)", () => {
            writeProjectConfig(["file:///home/user/workspace/oh-my-opencode-slim-dev"]);
            const result = detectConflicts(projectDir);
            expect(result.hasConflict).toBe(false);
        });

        it("does NOT match other forks under different package names", () => {
            writeProjectConfig([
                "oh-my-opencode-cli",
                "@some-org/oh-my-opencode-fork",
                "my-oh-my-opencode-customizations",
            ]);
            const result = detectConflicts(projectDir);
            expect(result.hasConflict).toBe(false);
        });

        it("still detects canonical OMO when slim is also installed", () => {
            // A user running both slim and the real OMO should still get
            // the conflict warning for the real one.
            writeProjectConfig(["oh-my-opencode-slim", "oh-my-opencode@latest"]);
            const result = detectConflicts(projectDir);
            expect(result.conflicts.omoPreemptiveCompaction).toBe(true);
        });

        it("respects disabled_hooks in project-level OMO config", () => {
            writeProjectConfig(["oh-my-opencode"]);
            // Use project-scoped OMO config to avoid relying on user
            // config-path resolution, which can be leaked across files
            // by `spyOn(getOpenCodeConfigPaths)` mocks in sibling tests.
            writeFileSync(
                join(projectDir, "oh-my-opencode.json"),
                JSON.stringify({
                    disabled_hooks: [
                        "preemptive-compaction",
                        "context-window-monitor",
                        "anthropic-context-window-limit-recovery",
                    ],
                }),
            );
            const result = detectConflicts(projectDir);
            expect(result.hasConflict).toBe(false);
        });
    });

    // --- Combined / control cases ---

    it("returns no conflicts for an empty plugin list", () => {
        writeProjectConfig([]);
        const result = detectConflicts(projectDir);
        expect(result.hasConflict).toBe(false);
    });

    it("returns no conflicts for unrelated plugins", () => {
        writeProjectConfig(["@cortexkit/opencode-magic-context@latest", "some-other-plugin"]);
        const result = detectConflicts(projectDir);
        expect(result.hasConflict).toBe(false);
    });

    // --- Tuple plugin entries (issue #49) ---
    // OpenCode supports ["pkg@version", { ...options }] tuple form.
    // The old code spread the raw array into the plugin list, causing
    // matchesPackageName to receive an array instead of a string → crash.

    describe("tuple plugin entries (issue #49)", () => {
        it("does not crash when a plugin is defined as a [name, options] tuple", () => {
            writeProjectConfig([
                "@cortexkit/opencode-magic-context@latest",
                ["@plannotator/opencode@latest", { workflow: "plan-agent" }],
            ]);
            expect(() => detectConflicts(projectDir)).not.toThrow();
        });

        it("detects DCP conflict when DCP is expressed as a tuple", () => {
            writeProjectConfig([
                "@cortexkit/opencode-magic-context@latest",
                ["@tarquinen/opencode-dcp@latest", {}],
            ]);
            const result = detectConflicts(projectDir);
            expect(result.conflicts.dcpPlugin).toBe(true);
        });

        it("detects OMO conflict when OMO is expressed as a tuple", () => {
            writeProjectConfig([["oh-my-opencode@latest", {}]]);
            const result = detectConflicts(projectDir);
            expect(result.conflicts.omoPreemptiveCompaction).toBe(true);
        });

        it("does not crash on mixed string and tuple entries with unrelated packages", () => {
            writeProjectConfig([
                "oh-my-opencode-slim",
                ["@plannotator/opencode@latest", { workflow: "plan-agent", planningAgents: ["plan"] }],
                "@cortexkit/opencode-magic-context@latest",
            ]);
            const result = detectConflicts(projectDir);
            expect(result.hasConflict).toBe(false);
        });
    });
});
