import { expect, spyOn, test } from "bun:test";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import * as logger from "../../shared/logger";
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
