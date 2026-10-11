import { describe, expect, it } from "bun:test";
import { configHasPluginEntry } from "../lib/diagnostics-opencode";
import {
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION,
    OPENCODE_PLUGIN_NAME,
} from "../lib/opencode-plugin-cache";
import {
    checkOpenCodePluginEntry,
    isOpenCodePluginRegistered,
} from "./doctor-opencode-plugin-entry";

function run(config: Record<string, unknown>, force = false) {
    const lines: Array<{ level: string; message: string }> = [];
    const changed = checkOpenCodePluginEntry(
        config,
        "opencode.json",
        { force, registrationKey: "plugins", configDir: "/config" },
        {
            pass: (message) => lines.push({ level: "pass", message }),
            warn: (message) => lines.push({ level: "warn", message }),
            fixed: (message) => lines.push({ level: "fixed", message }),
            autoUpdateStall: (message) => lines.push({ level: "stall", message }),
        },
    );
    return { changed, lines, config };
}

const OPTIONS = { debug: true, nested: { level: 2 } };

describe("doctor OpenCode plugin entry", () => {
    it("distinguishes an unregistered host from one with a Magic Context entry", () => {
        expect(isOpenCodePluginRegistered({ plugins: ["other-plugin"] }, "/config")).toBe(false);
        expect(
            isOpenCodePluginRegistered(
                { plugins: [OPENCODE_PLUGIN_ENTRY_WITH_VERSION] },
                "/config",
            ),
        ).toBe(true);
    });

    it("accepts an OpenCode 2 object entry on @latest without rewriting it", () => {
        const config = {
            plugins: [{ package: OPENCODE_PLUGIN_ENTRY_WITH_VERSION, options: OPTIONS }],
        };
        const result = run(config);
        expect(result.changed).toBe(false);
        expect(result.lines).toEqual([
            { level: "pass", message: "Plugin registered in opencode.json" },
        ]);
        expect(config.plugins).toEqual([
            { package: OPENCODE_PLUGIN_ENTRY_WITH_VERSION, options: OPTIONS },
        ]);
    });

    it("reports a pinned object entry without --force and leaves it alone", () => {
        const entry = { package: `${OPENCODE_PLUGIN_NAME}@0.42.6`, options: OPTIONS };
        const config = { plugins: [entry] };
        const result = run(config);
        expect(result.changed).toBe(false);
        expect(result.lines).toContainEqual({
            level: "warn",
            message: `Plugin pinned to ${OPENCODE_PLUGIN_NAME}@0.42.6 in opencode.json — use 'doctor --force' to upgrade`,
        });
        expect(result.lines).toContainEqual({
            level: "stall",
            message: `${OPENCODE_PLUGIN_NAME}@0.42.6`,
        });
        expect(config.plugins).toEqual([entry]);
    });

    it("upgrades a pinned object entry under --force and keeps its options", () => {
        const config = {
            plugins: [
                "other-plugin",
                { package: `${OPENCODE_PLUGIN_NAME}@0.42.6`, options: OPTIONS },
            ],
        };
        const result = run(config, true);
        expect(result.changed).toBe(true);
        expect(config.plugins).toEqual([
            "other-plugin",
            { package: OPENCODE_PLUGIN_ENTRY_WITH_VERSION, options: OPTIONS },
        ]);
        expect(result.lines).toEqual([
            {
                level: "fixed",
                message: `Upgraded plugin entry in opencode.json: ${OPENCODE_PLUGIN_NAME}@0.42.6 → ${OPENCODE_PLUGIN_ENTRY_WITH_VERSION}`,
            },
        ]);
    });

    it("moves a bare object entry to @latest and keeps its options", () => {
        const config = { plugins: [{ package: OPENCODE_PLUGIN_NAME, options: OPTIONS }] };
        expect(run(config).changed).toBe(true);
        expect(config.plugins).toEqual([
            { package: OPENCODE_PLUGIN_ENTRY_WITH_VERSION, options: OPTIONS },
        ]);
    });

    it("keeps tuple options and string entries working as before", () => {
        const tuple = { plugin: [[`${OPENCODE_PLUGIN_NAME}@0.42.6`, OPTIONS]] };
        expect(run(tuple, true).changed).toBe(true);
        expect(tuple.plugin).toEqual([[OPENCODE_PLUGIN_ENTRY_WITH_VERSION, OPTIONS]]);

        const string = { plugin: [`${OPENCODE_PLUGIN_NAME}@0.42.6`] };
        expect(run(string, true).changed).toBe(true);
        expect(string.plugin).toEqual([OPENCODE_PLUGIN_ENTRY_WITH_VERSION]);
    });

    it("adds a missing entry under the host generation's key", () => {
        const config: Record<string, unknown> = { plugin: ["other-plugin"] };
        const result = run(config);
        expect(result.changed).toBe(true);
        expect(config).toEqual({
            plugin: ["other-plugin"],
            plugins: [OPENCODE_PLUGIN_ENTRY_WITH_VERSION],
        });
    });
});

describe("diagnostics plugin registration detection", () => {
    it("counts tuple and OpenCode 2 object entries as registrations", () => {
        expect(
            configHasPluginEntry({
                plugins: [{ package: OPENCODE_PLUGIN_ENTRY_WITH_VERSION, options: OPTIONS }],
            }),
        ).toBe(true);
        expect(configHasPluginEntry({ plugin: [[OPENCODE_PLUGIN_NAME, OPTIONS]] })).toBe(true);
        expect(configHasPluginEntry({ plugins: [{ package: "other-plugin" }] })).toBe(false);
    });
});
