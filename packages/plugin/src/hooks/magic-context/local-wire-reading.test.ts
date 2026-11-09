/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { ContextUsage } from "../../features/magic-context/types";
import { createLocalWireReadings } from "./local-wire-reading";

const SESSION = "local-reading";
const MODEL = "usageless/model-a";
const WINDOW = 72_000;
const NO_PROVIDER_READING: ContextUsage = { percentage: 0, inputTokens: 0 };

/** Records one served request of `tokens` while the provider reports no usage. */
function recorded(tokens: number, overrides: { modelKey?: string; usableWindow?: number } = {}) {
    const readings = createLocalWireReadings();
    readings.record({
        sessionId: SESSION,
        providerReadingMissing: true,
        modelKey: MODEL,
        usableWindow: WINDOW,
        pressureTokens: tokens,
        ...overrides,
    });
    return readings;
}

/** What the scheduler reads on the next pass, which still has no provider reading. */
function nextPass(
    readings: ReturnType<typeof createLocalWireReadings>,
    overrides: { modelKey?: string; usableWindow?: number; sessionId?: string } = {},
) {
    return readings.schedulerUsage({
        sessionId: SESSION,
        providerUsage: NO_PROVIDER_READING,
        providerReadingMissing: true,
        modelKey: MODEL,
        usableWindow: WINDOW,
        ...overrides,
    });
}

describe("local wire readings", () => {
    it("gives the next pass the served count as a percentage of the recorded window", () => {
        expect(nextPass(recorded(54_000))).toEqual({ inputTokens: 54_000, percentage: 75 });
        // Another session never reads it.
        expect(nextPass(recorded(54_000), { sessionId: "another-session" })).toBe(
            NO_PROVIDER_READING,
        );
    });

    it("ignores a reading taken on another model", () => {
        const readings = recorded(54_000);
        expect(nextPass(readings, { modelKey: "usageless/model-b" })).toBe(NO_PROVIDER_READING);
        expect(nextPass(readings, { modelKey: undefined })).toBe(NO_PROVIDER_READING);
        // Switching back finds the reading again: it was ignored, not cleared.
        expect(nextPass(readings).percentage).toBe(75);
    });

    it("ignores a reading taken against another usable window", () => {
        const readings = recorded(54_000);
        // The same count over a larger window is a different percentage, so the
        // old one is not reused, and an unknown window has no percentage at all.
        expect(nextPass(readings, { usableWindow: 150_000 })).toBe(NO_PROVIDER_READING);
        expect(nextPass(readings, { usableWindow: undefined })).toBe(NO_PROVIDER_READING);
        expect(nextPass(readings, { usableWindow: 0 })).toBe(NO_PROVIDER_READING);
        expect(nextPass(readings, { usableWindow: Number.NaN })).toBe(NO_PROVIDER_READING);
    });

    it("lets a provider reading win and clears the local one", () => {
        const readings = recorded(54_000);
        const provider: ContextUsage = { percentage: 40, inputTokens: 28_800 };
        // A pass with a provider reading reads the provider, however much
        // higher the local count is.
        expect(
            readings.schedulerUsage({
                sessionId: SESSION,
                providerUsage: provider,
                providerReadingMissing: false,
                modelKey: MODEL,
                usableWindow: WINDOW,
            }),
        ).toBe(provider);
        // That pass records with a provider reading, which clears the local
        // count, so a later pass whose provider reading was reset reads 0%
        // rather than the old count.
        readings.record({
            sessionId: SESSION,
            providerReadingMissing: false,
            modelKey: MODEL,
            usableWindow: WINDOW,
            pressureTokens: 54_000,
        });
        expect(nextPass(readings)).toBe(NO_PROVIDER_READING);
    });

    it("never lowers the reading the pass already has", () => {
        const readings = recorded(36_000);
        // The overflow-recovery bump or a host over-window mark can put the
        // pass above the local count; the higher reading stands.
        const raised: ContextUsage = { percentage: 95, inputTokens: 0 };
        expect(
            readings.schedulerUsage({
                sessionId: SESSION,
                providerUsage: raised,
                providerReadingMissing: true,
                modelKey: MODEL,
                usableWindow: WINDOW,
            }),
        ).toBe(raised);
    });

    for (const [label, tokens] of [
        ["zero", 0],
        ["negative", -1],
        ["NaN", Number.NaN],
        ["infinite", Number.POSITIVE_INFINITY],
        ["missing", undefined],
    ] as const) {
        it(`records no reading from a ${label} count and clears an earlier one`, () => {
            expect(nextPass(recorded(tokens as number))).toBe(NO_PROVIDER_READING);
            const readings = recorded(54_000);
            readings.record({
                sessionId: SESSION,
                providerReadingMissing: true,
                modelKey: MODEL,
                usableWindow: WINDOW,
                pressureTokens: tokens,
            });
            expect(nextPass(readings)).toBe(NO_PROVIDER_READING);
        });
    }

    it("records nothing without a model or a usable window", () => {
        expect(nextPass(recorded(54_000, { modelKey: undefined }))).toBe(NO_PROVIDER_READING);
        expect(nextPass(recorded(54_000, { usableWindow: undefined }))).toBe(NO_PROVIDER_READING);
        expect(nextPass(recorded(54_000, { usableWindow: 0 }))).toBe(NO_PROVIDER_READING);
        expect(nextPass(recorded(54_000, { usableWindow: Number.POSITIVE_INFINITY }))).toBe(
            NO_PROVIDER_READING,
        );
    });
});
