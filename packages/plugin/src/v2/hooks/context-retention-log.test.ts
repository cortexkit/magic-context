import { expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import * as logger from "../../shared/logger";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { registerContext } from "./context";
import type { V2Context } from "./types";

test("registerContext logs the effective keep_subagents once at startup", async () => {
    const messages: string[] = [];
    const load = spyOn(configLoader, "loadPluginConfigDetailed");
    const log = spyOn(logger, "log").mockImplementation((message) => {
        messages.push(message);
    });
    try {
        for (const keep_subagents of [true, false]) {
            const config = MagicContextConfigSchema.parse({ enabled: false, keep_subagents });
            load.mockReturnValue({
                config,
            } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);

            const before = messages.length;
            await registerContext({
                location: { directory: "/unused" },
            } as unknown as V2Context);

            expect(messages.slice(before)).toEqual([
                `[magic-context] OpenCode 2 keep_subagents=${keep_subagents}`,
            ]);
        }
    } finally {
        log.mockRestore();
        load.mockRestore();
    }
});

test.each([
    [
        "unknown nightly task",
        { dreamer: { tasks: { "refresh-prmiers": { schedule: "" } } } },
        "dreamer.tasks.refresh-prmiers",
    ],
    [
        "strict nested leaf",
        { historian: { opencode: { thinking_level: "high" } } },
        "historian.opencode.thinking_level",
    ],
    ["clean settings", { dreamer: { tasks: { "refresh-primers": { schedule: "" } } } }, undefined],
] as const)("OpenCode 2 startup logs loader warnings: %s", async (_label, settings, expectedField) => {
    const root = createTestTempDir("mc-v2-config-log-").dir;
    const home = process.env.XDG_CONFIG_HOME;
    const messages: string[] = [];
    const log = spyOn(logger, "log").mockImplementation((message) => {
        messages.push(message);
    });
    try {
        process.env.XDG_CONFIG_HOME = root;
        const dir = join(root, "cortexkit");
        mkdirSync(dir);
        writeFileSync(
            join(dir, "magic-context.jsonc"),
            JSON.stringify({ enabled: false, ...settings }),
        );
        const loaded = configLoader.loadPluginConfigDetailed(root, false).config;
        await registerContext({ location: { directory: root } } as unknown as V2Context);

        const startupWarnings = messages.filter((message) =>
            message.startsWith("[magic-context] config warning: "),
        );
        expect(startupWarnings).toHaveLength(expectedField ? 1 : 0);
        if (expectedField) expect(startupWarnings[0]).toContain(expectedField);
        expect(startupWarnings).toEqual(
            (loaded.configWarnings ?? []).map(
                (warning) => `[magic-context] config warning: ${warning}`,
            ),
        );
    } finally {
        if (home === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = home;
        log.mockRestore();
        cleanupTestTempDir(root);
    }
});
