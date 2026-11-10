import { expect, test } from "bun:test";
import { resolveUsageReading, usageReadingMatchesDraft } from "./usage-reading";

const windows: Record<string, number> = { old: 200_000, new: 1_000_000 };
const limitFor = (_providerID: string, modelID: string) => windows[modelID] ?? 0;

for (const location of ["native", "state"]) {
    for (const cache of [true, false]) {
        test(`reads the last fallback iteration from ${location} with cache=${cache}`, () => {
            const tokens = { input: 963_300, output: 100, cache: { read: 1, write: 2 } };
            const reading = resolveUsageReading({
                draftModel: { providerID: "p", id: "new" },
                tokens,
                completed: 123,
                content: [
                    {
                        type: "reasoning",
                        [location]: {
                            signature: `cortexkit-server-fallback-usage-v1:${JSON.stringify({
                                iterations: [
                                    {
                                        type: "message",
                                        model: "primary",
                                        input_tokens: 400_000,
                                        output_tokens: 10,
                                    },
                                    {
                                        type: "fallback_message",
                                        model: "fallback",
                                        input_tokens: 500_000,
                                        output_tokens: 20,
                                    },
                                    {
                                        type: "fallback_message",
                                        model: "fallback",
                                        input_tokens: 100_000,
                                        output_tokens: 30,
                                        ...(cache
                                            ? {
                                                  cache_read_input_tokens: 400_000,
                                                  cache_creation_input_tokens: 10_000,
                                              }
                                            : {}),
                                    },
                                    {
                                        type: "message",
                                        model: "primary",
                                        input_tokens: 900_000,
                                        output_tokens: 40,
                                    },
                                ],
                            })}`,
                        },
                    },
                ],
                limitFor,
            });
            expect(reading?.inputTokens).toBe(cache ? 510_000 : 100_000);
            expect(reading?.serverFallback).not.toBe(true);
            expect(tokens).toEqual({ input: 963_300, output: 100, cache: { read: 1, write: 2 } });
        });
    }
}

for (const payload of [
    "{",
    "null",
    '{"iterations":[]}',
    '{"iterations":[{"type":"message"}]}',
    '{"iterations":[{"type":"fallback_message","input_tokens":"bad"}]}',
]) {
    test(`invalid usage marker keeps the boundary-only path: ${payload}`, () => {
        const reading = resolveUsageReading({
            draftModel: { providerID: "p", id: "new" },
            tokens: { input: 963_300 },
            completed: 123,
            content: [
                {
                    type: "reasoning",
                    state: { signature: `cortexkit-server-fallback-usage-v1:${payload}` },
                },
            ],
            limitFor,
        });
        expect(reading?.inputTokens).toBe(963_300);
        expect(reading?.serverFallback).toBe(true);
    });
}

test("a same-model reading uses one window for attribution and admission", () => {
    const reading = resolveUsageReading({
        rowModel: { providerID: "p", id: "old" },
        draftModel: { providerID: "p", id: "old" },
        tokens: { input: 195_000, cache: { read: 0, write: 0 } },
        completed: 123,
        limitFor,
    });
    expect(reading).toEqual({
        inputTokens: 195_000,
        limit: 200_000,
        admissionLimit: 200_000,
        modelKey: "p/old",
        completed: 123,
    });
    expect(reading!.inputTokens / reading!.admissionLimit).toBeGreaterThanOrEqual(0.95);
});

test("a switch to a larger model admits on the outgoing window", () => {
    const reading = resolveUsageReading({
        rowModel: { providerID: "p", id: "old" },
        draftModel: { providerID: "p", id: "new" },
        tokens: { input: 195_000, cache: { read: 0, write: 0 } },
        limitFor,
    });
    expect(reading?.limit).toBe(200_000);
    expect(reading?.modelKey).toBe("p/old");
    expect(reading?.admissionLimit).toBe(1_000_000);
    expect(reading!.inputTokens / reading!.admissionLimit).toBeLessThan(0.95);
    expect(usageReadingMatchesDraft(reading!, { providerID: "p", id: "new" })).toBe(false);
});

test("same-model and legacy readings can drive outgoing pressure", () => {
    const same = resolveUsageReading({
        rowModel: { providerID: "p", id: "new" },
        draftModel: { providerID: "p", id: "new" },
        tokens: { input: 10 },
        limitFor,
    });
    const legacy = resolveUsageReading({
        draftModel: { providerID: "p", id: "new" },
        tokens: { input: 10 },
        limitFor,
    });
    expect(usageReadingMatchesDraft(same!, { providerID: "p", id: "new" })).toBe(true);
    expect(usageReadingMatchesDraft(legacy!, { providerID: "p", id: "new" })).toBe(true);
});

test("a row without model metadata records no modelKey and admits on the draft window", () => {
    const reading = resolveUsageReading({
        draftModel: { providerID: "p", id: "new" },
        tokens: { input: 10 },
        limitFor,
    });
    expect(reading).toEqual({
        inputTokens: 10,
        limit: 1_000_000,
        admissionLimit: 1_000_000,
    });
});

test("partial cache objects and missing token fields count as zero", () => {
    const reading = resolveUsageReading({
        rowModel: { providerID: "p", id: "old" },
        draftModel: { providerID: "p", id: "old" },
        tokens: { input: 5 },
        limitFor,
    });
    expect(reading?.inputTokens).toBe(5);
});

test("a switch to a smaller model still refuses on the outgoing window", () => {
    const reading = resolveUsageReading({
        rowModel: { providerID: "p", id: "new" },
        draftModel: { providerID: "p", id: "old" },
        tokens: { input: 195_000, cache: { read: 0, write: 0 } },
        limitFor,
    });
    expect(reading?.admissionLimit).toBe(200_000);
    expect(reading!.inputTokens / reading!.admissionLimit).toBeGreaterThanOrEqual(0.95);
});

test("non-numeric token fields and a null completion are treated as absent", () => {
    const reading = resolveUsageReading({
        rowModel: { providerID: "p", id: "old" },
        draftModel: { providerID: "p", id: "old" },
        tokens: { input: "nope", cache: { read: null, write: undefined } } as never,
        completed: null as never,
        limitFor,
    });
    expect(reading?.inputTokens).toBe(0);
    expect(reading?.completed).toBeUndefined();
});

test("returns undefined without tokens or with a non-positive window", () => {
    expect(
        resolveUsageReading({
            rowModel: { providerID: "p", id: "old" },
            draftModel: { providerID: "p", id: "old" },
            limitFor,
        }),
    ).toBeUndefined();
    expect(
        resolveUsageReading({
            rowModel: { providerID: "p", id: "missing" },
            draftModel: { providerID: "p", id: "missing" },
            tokens: { input: 1 },
            limitFor,
        }),
    ).toBeUndefined();
});
