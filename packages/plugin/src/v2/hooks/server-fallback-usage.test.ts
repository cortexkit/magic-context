import { expect, test } from "bun:test";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

for (const marked of [true, false]) {
    test(`OC2 newest ${marked ? "server-fallback" : "normal control"} reply ${marked ? "keeps pressure and admits without execute" : "enters the force band"}`, async () => {
        const f = await oc2ContextFixture(marked ? 801 : 802, {
            area: "server-fallback-usage",
            provider: "anthropic",
            model: "claude-opus-5-5",
            cacheTtl: "1h",
        });
        try {
            await f.pass();
            f.respond(1, 507_000);
            await f.pass();
            const before = getOrCreateSessionMeta(f.db, f.session);
            expect(before.lastInputTokens).toBe(507_000);
            f.respond(1, 963_300);
            const latest = f.rows.at(-1)!;
            const row = f.raw
                .prepare("SELECT data FROM session_message WHERE id=?")
                .get(latest.id) as { data: string };
            const data = JSON.parse(row.data);
            data.content.unshift({
                type: "reasoning",
                text: " ",
                native: {
                    signature: marked
                        ? "cortexkit-server-fallback-v1:claude-opus-5-5|claude-opus-4-8"
                        : "real-signature",
                },
            });
            f.raw
                .prepare("UPDATE session_message SET data=? WHERE id=?")
                .run(JSON.stringify(data), latest.id);
            const result = await f.attempt();
            const logs = result.logs.join("\n");
            const meta = getOrCreateSessionMeta(f.db, f.session);
            if (marked) {
                expect(result.error).toBeUndefined();
                expect(meta.lastInputTokens).toBe(507_000);
                expect(meta.lastContextPercentage).toBe(before.lastContextPercentage);
                expect(meta.lastUsageContextLimit).toBe(before.lastUsageContextLimit);
                expect(meta.lastResponseTime).toBe(latest.created + 1000);
                expect(logs).toMatch(/transform scheduler: .*decision=defer/);
                expect(logs).not.toMatch(/transform scheduler: .*decision=execute/);
                expect(logs).toContain("ignored server-fallback reply inputTokens=963300");
            } else {
                expect(meta.lastInputTokens).toBe(963_300);
                expect(meta.lastContextPercentage).toBeGreaterThan(95);
                expect(logs).toMatch(/transform scheduler: .*decision=execute/);
            }
        } finally {
            await f.cleanup();
        }
    });
}
