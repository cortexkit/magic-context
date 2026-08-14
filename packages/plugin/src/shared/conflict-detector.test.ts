/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectConflicts, resolveCompactionForBoot } from "./conflict-detector";

/**
 * Regression tests for plugin-conflict detection. The previous substring-
 * based matcher misclassified `oh-my-opencode-slim` and `opencode-dcp-fork`
 * as the canonical plugins, causing magic-context to disable itself with
 * a false-positive conflict warning. See issue #43.
 */
describe("detectConflicts", () => {
    let projectDir: string;
    let userConfigDir: string;
    let homeDir: string;
    let originalEnv: Record<string, string | undefined>;

    beforeEach(() => {
        const root = mkdtempSync(join(tmpdir(), "mc-conflict-"));
        projectDir = join(root, "project");
        mkdirSync(projectDir, { recursive: true });
        userConfigDir = join(root, "user-config", "opencode");
        mkdirSync(userConfigDir, { recursive: true });
        homeDir = join(root, "home");
        mkdirSync(homeDir, { recursive: true });

        // Save and override every env var that affects config-path resolution.
        // OPENCODE_CONFIG_DIR takes precedence over XDG_CONFIG_HOME, so we set
        // it directly and clear XDG to fully isolate from any inherited or
        // test-leaked state.
        originalEnv = {
            OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            OPENCODE_DISABLE_AUTOCOMPACT: process.env.OPENCODE_DISABLE_AUTOCOMPACT,
            HOME: process.env.HOME,
        };
        process.env.OPENCODE_CONFIG_DIR = userConfigDir;
        process.env.HOME = homeDir;
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
        try {
            rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
        try {
            rmSync(userConfigDir, {
                recursive: true,
                force: true,
                maxRetries: 10,
                retryDelay: 100,
            });
        } catch {
            /* Ignore EBUSY on Windows */
        }
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

        it("respects disabled_hooks in project-level OMO config (old format)", () => {
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

        // --- New unified omo.jsonc (oh-my-openagent >= 4.19.0) ---

        it("detects disabled_hooks in new ~/.omo/omo.jsonc (user-level)", () => {
            writeProjectConfig(["oh-my-opencode"]);
            const omoDir = join(homeDir, ".omo");
            mkdirSync(omoDir, { recursive: true });
            writeFileSync(
                join(omoDir, "omo.jsonc"),
                JSON.stringify({
                    "[opencode]": {
                        disabled_hooks: [
                            "preemptive-compaction",
                            "context-window-monitor",
                            "anthropic-context-window-limit-recovery",
                        ],
                    },
                }),
            );
            const result = detectConflicts(projectDir);
            expect(result.hasConflict).toBe(false);
        });

        it("detects disabled_hooks in new .omo/omo.jsonc (project-level)", () => {
            writeProjectConfig(["oh-my-opencode"]);
            const omoDir = join(projectDir, ".omo");
            mkdirSync(omoDir, { recursive: true });
            writeFileSync(
                join(omoDir, "omo.jsonc"),
                JSON.stringify({
                    "[opencode]": {
                        disabled_hooks: [
                            "preemptive-compaction",
                            "context-window-monitor",
                            "anthropic-context-window-limit-recovery",
                        ],
                    },
                }),
            );
            const result = detectConflicts(projectDir);
            expect(result.hasConflict).toBe(false);
        });

        it("detects hooks as active when new omo.jsonc has no disabled_hooks", () => {
            writeProjectConfig(["oh-my-opencode"]);
            const omoDir = join(homeDir, ".omo");
            mkdirSync(omoDir, { recursive: true });
            writeFileSync(
                join(omoDir, "omo.jsonc"),
                JSON.stringify({
                    "[opencode]": {
                        // No disabled_hooks — hooks default ACTIVE
                    },
                }),
            );
            const result = detectConflicts(projectDir);
            expect(result.conflicts.omoPreemptiveCompaction).toBe(true);
            expect(result.conflicts.omoContextWindowMonitor).toBe(true);
            expect(result.conflicts.omoAnthropicRecovery).toBe(true);
        });

        it("reads disabled_hooks from both old and new config paths", () => {
            writeProjectConfig(["oh-my-opencode"]);
            // Old path: only disables preemptive-compaction
            writeFileSync(
                join(projectDir, "oh-my-opencode.json"),
                JSON.stringify({
                    disabled_hooks: ["preemptive-compaction"],
                }),
            );
            // New path: disables the other two
            const omoDir = join(homeDir, ".omo");
            mkdirSync(omoDir, { recursive: true });
            writeFileSync(
                join(omoDir, "omo.jsonc"),
                JSON.stringify({
                    "[opencode]": {
                        disabled_hooks: [
                            "context-window-monitor",
                            "anthropic-context-window-limit-recovery",
                        ],
                    },
                }),
            );
            const result = detectConflicts(projectDir);
            // All three are disabled across both configs
            expect(result.hasConflict).toBe(false);
        });

        it("reads omo.json (fallback) when omo.jsonc does not exist", () => {
            writeProjectConfig(["oh-my-opencode"]);
            const omoDir = join(homeDir, ".omo");
            mkdirSync(omoDir, { recursive: true });
            writeFileSync(
                join(omoDir, "omo.json"),
                JSON.stringify({
                    "[opencode]": {
                        disabled_hooks: [
                            "preemptive-compaction",
                            "context-window-monitor",
                            "anthropic-context-window-limit-recovery",
                        ],
                    },
                }),
            );
            const result = detectConflicts(projectDir);
            expect(result.hasConflict).toBe(false);
        });

        it("ignores new omo.jsonc when OMO is not installed", () => {
            writeProjectConfig([]);
            const omoDir = join(homeDir, ".omo");
            mkdirSync(omoDir, { recursive: true });
            writeFileSync(
                join(omoDir, "omo.jsonc"),
                JSON.stringify({
                    "[opencode]": {
                        disabled_hooks: ["preemptive-compaction"],
                    },
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
                [
                    "@plannotator/opencode@latest",
                    { workflow: "plan-agent", planningAgents: ["plan"] },
                ],
                "@cortexkit/opencode-magic-context@latest",
            ]);
            const result = detectConflicts(projectDir);
            expect(result.hasConflict).toBe(false);
        });
    });

    // --- Compaction-off mode matrix (issue #266 S2) ---
    // The detector must NOT flag OpenCode compaction.auto=true / prune=true as
    // a plugin-disabling conflict when MC compaction is OFF (compaction-off
    // mode), or compaction-off users get a DISABLED plugin — the exact inverse
    // of intent. With MC compaction ON, today's conflict behavior is unchanged.
    //
    // The 2x2 matrix: MC mode (on/off) x native compaction.auto (true/false).
    // Each case asserts BOTH the conflict verdict AND the plugin-enabled
    // outcome (the boot path disables the plugin when hasConflict).
    describe("compaction-off mode matrix (issue #266)", () => {
        // The suite beforeEach sets OPENCODE_DISABLE_AUTOCOMPACT=1 to isolate
        // plugin detection from compaction detection. These matrix tests
        // exercise compaction detection directly, so they clear that env var
        // and write an explicit compaction block to control the native state.
        function writeCompactionConfig(auto: boolean, prune = false): void {
            const prev = process.env.OPENCODE_DISABLE_AUTOCOMPACT;
            delete process.env.OPENCODE_DISABLE_AUTOCOMPACT;
            writeFileSync(
                join(projectDir, "opencode.json"),
                JSON.stringify({ compaction: { auto, prune } }),
            );
            if (prev !== undefined) process.env.OPENCODE_DISABLE_AUTOCOMPACT = prev;
        }

        function detectWithMode(compactionEnabled: boolean) {
            const prev = process.env.OPENCODE_DISABLE_AUTOCOMPACT;
            delete process.env.OPENCODE_DISABLE_AUTOCOMPACT;
            try {
                return detectConflicts(projectDir, { compactionEnabled });
            } finally {
                if (prev !== undefined) process.env.OPENCODE_DISABLE_AUTOCOMPACT = prev;
            }
        }

        it("MC ON + auto=true → conflict fires, plugin would be disabled", () => {
            writeCompactionConfig(true);
            const result = detectWithMode(true);
            expect(result.hasConflict).toBe(true);
            expect(result.conflicts.compactionAuto).toBe(true);
        });

        it("MC ON + auto=false → no compaction conflict, plugin stays enabled", () => {
            writeCompactionConfig(false);
            const result = detectWithMode(true);
            expect(result.conflicts.compactionAuto).toBe(false);
            expect(result.hasConflict).toBe(false);
        });

        it("MC OFF + auto=true → NO conflict, plugin stays enabled (native compaction active)", () => {
            writeCompactionConfig(true);
            const result = detectWithMode(false);
            expect(result.conflicts.compactionAuto).toBe(false);
            expect(result.conflicts.compactionPrune).toBe(false);
            expect(result.hasConflict).toBe(false);
            // Native compaction state is still reported honestly.
            expect(result.nativeCompaction.auto).toBe(true);
        });

        it("MC OFF + auto=false → NO conflict, no-manager configuration reported honestly", () => {
            writeCompactionConfig(false);
            const result = detectWithMode(false);
            expect(result.conflicts.compactionAuto).toBe(false);
            expect(result.hasConflict).toBe(false);
            // No-manager: neither MC nor native compaction owns the window.
            expect(result.nativeCompaction.auto).toBe(false);
            expect(result.nativeCompaction.prune).toBe(false);
        });

        // Mutation direction: force mode-on in the detector with auto=true →
        // conflict fires. This proves the off-gate isn't just always-pass —
        // the same native config that was NOT a conflict in the off case
        // becomes a conflict when the mode is forced on.
        it("mutation direction: same auto=true config DOES conflict when mode forced on", () => {
            writeCompactionConfig(true);
            const offResult = detectWithMode(false);
            const onResult = detectWithMode(true);
            expect(offResult.hasConflict).toBe(false);
            expect(onResult.hasConflict).toBe(true);
            expect(onResult.conflicts.compactionAuto).toBe(true);
        });

        // prune=true follows the same gate as auto=true.
        it("MC OFF + prune=true → NO conflict (prune is not a conflict in compaction-off mode)", () => {
            writeCompactionConfig(false, true);
            const result = detectWithMode(false);
            expect(result.conflicts.compactionPrune).toBe(false);
            expect(result.hasConflict).toBe(false);
            expect(result.nativeCompaction.prune).toBe(true);
        });

        // DCP and OMO conflicts keep their existing policy in BOTH modes.
        it("MC OFF + DCP plugin → DCP conflict still fires (compaction-off does not broaden compatibility)", () => {
            writeProjectConfig(["@tarquinen/opencode-dcp"]);
            const result = detectWithMode(false);
            expect(result.conflicts.dcpPlugin).toBe(true);
            expect(result.hasConflict).toBe(true);
        });

        it("MC OFF + OMO hooks → OMO conflicts still fire in both modes", () => {
            writeProjectConfig(["oh-my-opencode"]);
            const result = detectWithMode(false);
            expect(result.conflicts.omoPreemptiveCompaction).toBe(true);
            expect(result.hasConflict).toBe(true);
        });

        // Default (no options) preserves today's mode-on behavior — a call
        // site that cannot supply the resolved mode fails toward mode-on.
        it("default (no options) treats compaction.auto=true as a conflict (fail toward mode-on)", () => {
            writeCompactionConfig(true);
            const prev = process.env.OPENCODE_DISABLE_AUTOCOMPACT;
            delete process.env.OPENCODE_DISABLE_AUTOCOMPACT;
            try {
                const result = detectConflicts(projectDir);
                expect(result.conflicts.compactionAuto).toBe(true);
                expect(result.hasConflict).toBe(true);
            } finally {
                if (prev !== undefined) process.env.OPENCODE_DISABLE_AUTOCOMPACT = prev;
            }
        });
    });

    // --- Resolved-config arm (issue #309) ---
    // The plugin boot now consumes the host's RESOLVED config
    // (ctx.client.config.get()) instead of re-deriving compaction from files.
    // These tests exercise the resolved arm directly via the
    // `resolvedCompaction` option and the `resolveCompactionForBoot` helper.
    describe("resolved-config arm (issue #309)", () => {
        // The suite beforeEach sets OPENCODE_DISABLE_AUTOCOMPACT=1 to isolate
        // plugin detection from compaction detection. These tests exercise the
        // resolved arm, so they clear it and restore it per-case.
        function withoutAutoCompactEnv<T>(fn: () => T): T {
            const prev = process.env.OPENCODE_DISABLE_AUTOCOMPACT;
            delete process.env.OPENCODE_DISABLE_AUTOCOMPACT;
            try {
                return fn();
            } finally {
                if (prev !== undefined) process.env.OPENCODE_DISABLE_AUTOCOMPACT = prev;
            }
        }

        it("resolved auto=false + file layer that would default true → NO conflict (#309)", () => {
            // No compaction block in any file + no env override → the file-based
            // arm would default to auto=true and wrongly disable the plugin.
            // The resolved arm says auto=false, which must win.
            withoutAutoCompactEnv(() => {
                const result = detectConflicts(projectDir, {
                    compactionEnabled: true,
                    resolvedCompaction: { auto: false, prune: false },
                });
                expect(result.conflicts.compactionAuto).toBe(false);
                expect(result.hasConflict).toBe(false);
                expect(result.nativeCompaction.auto).toBe(false);
            });
        });

        it("resolved auto=true → conflict, message carries '(resolved config)'", () => {
            withoutAutoCompactEnv(() => {
                const result = detectConflicts(projectDir, {
                    compactionEnabled: true,
                    resolvedCompaction: { auto: true, prune: false },
                });
                expect(result.conflicts.compactionAuto).toBe(true);
                expect(result.hasConflict).toBe(true);
                expect(result.reasons.join("; ")).toContain("(resolved config)");
            });
        });

        it("resolved prune=true → conflict, message carries '(resolved config)'", () => {
            withoutAutoCompactEnv(() => {
                const result = detectConflicts(projectDir, {
                    compactionEnabled: true,
                    resolvedCompaction: { auto: false, prune: true },
                });
                expect(result.conflicts.compactionPrune).toBe(true);
                expect(result.hasConflict).toBe(true);
                expect(result.reasons.join("; ")).toContain("(resolved config)");
            });
        });

        it("resolved arm is skipped when resolvedCompaction is absent (file-based fallback unchanged)", () => {
            // No resolvedCompaction → the file-based check runs. With no
            // compaction block and no env override, it defaults to auto=true.
            withoutAutoCompactEnv(() => {
                const result = detectConflicts(projectDir, { compactionEnabled: true });
                expect(result.conflicts.compactionAuto).toBe(true);
                expect(result.hasConflict).toBe(true);
                // File-based arm does NOT carry the resolved-config label.
                expect(result.reasons.join("; ")).not.toContain("(resolved config)");
            });
        });

        it("OPENCODE_DISABLE_AUTOCOMPACT short-circuits the resolved arm", () => {
            // Resolved says auto=true, but the env override must win.
            process.env.OPENCODE_DISABLE_AUTOCOMPACT = "1";
            try {
                const result = detectConflicts(projectDir, {
                    compactionEnabled: true,
                    resolvedCompaction: { auto: true, prune: true },
                });
                expect(result.conflicts.compactionAuto).toBe(false);
                expect(result.conflicts.compactionPrune).toBe(false);
                expect(result.hasConflict).toBe(false);
                expect(result.nativeCompaction.auto).toBe(false);
                expect(result.nativeCompaction.prune).toBe(false);
            } finally {
                delete process.env.OPENCODE_DISABLE_AUTOCOMPACT;
            }
        });

        it("compaction-off mode: resolved auto=true is NOT a conflict (native compaction active)", () => {
            withoutAutoCompactEnv(() => {
                const result = detectConflicts(projectDir, {
                    compactionEnabled: false,
                    resolvedCompaction: { auto: true, prune: false },
                });
                expect(result.conflicts.compactionAuto).toBe(false);
                expect(result.hasConflict).toBe(false);
                // Native compaction state is still reported honestly.
                expect(result.nativeCompaction.auto).toBe(true);
            });
        });
    });

    // --- resolveCompactionForBoot (the resolved-config fetch helper) ---
    describe("resolveCompactionForBoot", () => {
        it("returns the resolved compaction block from the client", async () => {
            const client = {
                config: {
                    get: async () => ({
                        data: { compaction: { auto: false, prune: true } },
                    }),
                },
            };
            const result = await resolveCompactionForBoot(client);
            expect(result).toEqual({ auto: false, prune: true });
        });

        it("returns null when the response carries NO compaction block (absent is not a value)", async () => {
            // REGRESSION (live 2026-08-14): this previously returned
            // { auto: true, prune: false }, treating "the host did not report this
            // field" as "the host resolved the default". Those are different
            // claims. The SDK's generated Config type has no compaction key at
            // all, so on such an SDK the block is ALWAYS absent -- the old default
            // made Magic Context disable itself on every boot regardless of the
            // user's actual config, which is the very bug #309 set out to fix.
            // Absent => we learned nothing => fall back to the file-based check.
            const client = {
                config: {
                    get: async () => ({ data: {} }),
                },
            };
            const result = await resolveCompactionForBoot(client);
            expect(result).toBeNull();
        });

        it("reproduces the live failure: an SDK whose Config omits compaction must not disable the plugin", async () => {
            // Exactly what opencode 1.18.15 + @opencode-ai/sdk 1.15.13 returns:
            // a fully-populated resolved config with every key EXCEPT compaction,
            // because the SDK schema does not declare one. The user's real
            // opencode.jsonc has compaction.auto=false.
            const client = {
                config: {
                    get: async () => ({
                        data: {
                            $schema: "https://opencode.ai/config.json",
                            model: "anthropic/claude-opus-5",
                            instructions: ["AGENTS.md"],
                            plugin: ["file:///home/user/magic-context/packages/plugin"],
                        },
                    }),
                },
            };
            const result = await resolveCompactionForBoot(client);
            // null routes the caller to the file-based check, which reads the
            // user's actual auto=false. Returning { auto: true } here is what
            // disabled the plugin on every boot.
            expect(result).toBeNull();
        });

        it("a PRESENT block is authoritative and keeps the host's per-field defaults", async () => {
            // Partial block: the host really is reporting a resolved object, so
            // per-field defaults (auto true, prune false) still apply within it.
            const client = {
                config: {
                    get: async () => ({ data: { compaction: { prune: true } } }),
                },
            };
            const result = await resolveCompactionForBoot(client);
            expect(result).toEqual({ auto: true, prune: true });
        });

        it("an explicit auto=false in a present block is honored", async () => {
            const client = {
                config: {
                    get: async () => ({ data: { compaction: { auto: false } } }),
                },
            };
            const result = await resolveCompactionForBoot(client);
            expect(result).toEqual({ auto: false, prune: false });
        });

        it("returns null when the client throws (file-based fallback used)", async () => {
            const client = {
                config: {
                    get: async () => {
                        throw new Error("boom");
                    },
                },
            };
            const result = await resolveCompactionForBoot(client);
            expect(result).toBeNull();
        });

        it("returns null when the client times out (boot never hangs)", async () => {
            const client = {
                config: {
                    get: () => new Promise<never>(() => {}), // never resolves
                },
            };
            const result = await resolveCompactionForBoot(client, 20);
            expect(result).toBeNull();
        });
    });
});
