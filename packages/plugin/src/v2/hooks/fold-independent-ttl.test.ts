import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPluginConfigDetailed } from "../../config";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

for (const restart of [false, true]) {
    test(`review: shortening TTL must not rebuild a still-warm prefix${restart ? " after restart" : ""}`, async () => {
        const f = await oc2ContextFixture(restart ? 9635 : 9634, {
            area: "independent-fold-review",
            instructions: false,
            temporal: false,
            cacheTtl: "1h",
        });
        try {
            f.respond();
            const before = await f.pass();
            f.compartment(10);
            f.idle(2 / 60);
            const { config } = loadPluginConfigDetailed(".");
            config.cache_ttl = "1m";
            writeFileSync(
                join(process.env.XDG_CONFIG_HOME!, "cortexkit", "magic-context.jsonc"),
                JSON.stringify(config),
            );
            if (restart) await f.restart();
            const after = await f.pass();
            expect(after.bytes).toBe(before.bytes);
        } finally {
            await f.cleanup();
        }
    }, 60000);
}
