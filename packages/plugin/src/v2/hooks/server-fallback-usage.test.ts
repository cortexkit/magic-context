import { expect, test } from "bun:test";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

const markers = [
    "boundary",
    "usage-native",
    "usage-state",
    "invalid-json",
    "missing-fallback",
    "none",
];
for (const marker of markers) {
    const marked = marker !== "none";
    const usage = marker.startsWith("usage");
    test(`OC2 newest ${marker} reply ${marked ? "admits at per-run pressure without execute" : "enters the force band"}`, async () => {
        const f = await oc2ContextFixture(801 + markers.indexOf(marker), {
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
                [marker === "usage-state" ? "state" : "native"]: {
                    signature: usage
                        ? `cortexkit-server-fallback-usage-v1:${JSON.stringify({
                              iterations: [
                                  {
                                      type: "message",
                                      model: "primary",
                                      input_tokens: 453_300,
                                      output_tokens: 50,
                                  },
                                  {
                                      type: "fallback_message",
                                      model: "fallback",
                                      input_tokens: 100_000,
                                      output_tokens: 50,
                                      cache_read_input_tokens: 400_000,
                                      cache_creation_input_tokens: 10_000,
                                  },
                              ],
                          })}`
                        : marker === "invalid-json"
                          ? "cortexkit-server-fallback-usage-v1:{"
                          : marker === "missing-fallback"
                            ? 'cortexkit-server-fallback-usage-v1:{"iterations":[]}'
                            : marked
                              ? "cortexkit-server-fallback-v1:claude-opus-5-5|claude-opus-4-8"
                              : "real-signature",
                },
            });
            if (usage)
                data.content.unshift({
                    type: "reasoning",
                    native: {
                        signature: "cortexkit-server-fallback-v1:primary|fallback",
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
                expect(meta.lastInputTokens).toBe(usage ? 510_000 : 507_000);
                expect(meta.lastContextPercentage).toBeCloseTo(
                    usage
                        ? (510_000 / before.lastUsageContextLimit) * 100
                        : before.lastContextPercentage,
                    5,
                );
                expect(meta.lastUsageContextLimit).toBe(before.lastUsageContextLimit);
                expect(meta.lastResponseTime).toBe(latest.created + 1000);
                expect(logs).toMatch(/transform scheduler: .*decision=defer/);
                expect(logs).not.toMatch(/transform scheduler: .*decision=execute/);
                if (!usage)
                    expect(logs).toContain("ignored server-fallback reply inputTokens=963300");
                if (marker === "invalid-json" || marker === "missing-fallback") {
                    expect(
                        result.logs.filter((line) =>
                            line.includes("invalid server-fallback usage marker"),
                        ),
                    ).toHaveLength(1);
                    const repeat = await f.attempt();
                    expect(repeat.logs.join("\n")).not.toContain(
                        "invalid server-fallback usage marker",
                    );
                }
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
