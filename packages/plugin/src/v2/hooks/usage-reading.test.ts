import { expect, test } from "bun:test";
import { resolveUsageReading } from "./usage-reading";

const windows: Record<string, number> = { old: 200_000, new: 1_000_000 };
const limitFor = (_providerID: string, modelID: string) => windows[modelID] ?? 0;

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

test("a switch to a larger model admits on the new window instead of refusing on the old", () => {
    const reading = resolveUsageReading({
        rowModel: { providerID: "p", id: "old" },
        draftModel: { providerID: "p", id: "new" },
        tokens: { input: 195_000, cache: { read: 0, write: 0 } },
        limitFor,
    });
    // The reading stays attributed to the producing model...
    expect(reading?.limit).toBe(200_000);
    expect(reading?.modelKey).toBe("p/old");
    // ...but the admission ratio is measured against the outgoing window.
    expect(reading?.admissionLimit).toBe(1_000_000);
    expect(reading!.inputTokens / reading!.admissionLimit).toBeLessThan(0.95);
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
