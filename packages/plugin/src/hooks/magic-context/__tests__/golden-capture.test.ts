import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STRICT_AUDIT, type Wire } from "./strict-binding-mock";

export const GOLDEN = process.env.MC_AUDIT_GOLDEN;

/** Capture mode still runs transforms inside assertion arguments, but skips checks so every pass is recorded. */
export function auditExpect<T>(actual: T) {
    return {
        toBe(expected: unknown) {
            if (!GOLDEN) expect(actual).toBe(expected);
        },
        toEqual(expected: unknown) {
            if (!GOLDEN) expect(actual).toEqual(expected);
        },
        toBeNull() {
            if (!GOLDEN) expect(actual).toBeNull();
        },
        toBeGreaterThan(expected: number) {
            if (!GOLDEN) expect(actual).toBeGreaterThan(expected);
        },
        toContain(expected: string) {
            if (!GOLDEN) expect(actual).toContain(expected);
        },
        not: {
            toBe(expected: unknown) {
                if (!GOLDEN) expect(actual).not.toBe(expected);
            },
            toContain(expected: string) {
                if (!GOLDEN) expect(actual).not.toContain(expected);
            },
        },
    };
}

export class GoldenCapture {
    private passNumber = 0;
    constructor(private readonly name: string) {}

    write(wire: Wire, bustedThisPass: boolean, hasBoundary: boolean): void {
        if (!GOLDEN) return;
        const dir = join(GOLDEN, this.name);
        mkdirSync(dir, { recursive: true });
        const eligibility = {
            defer: !bustedThisPass,
            noBoundary: !hasBoundary,
            // No trigger parking or served-prefix validation is implemented yet, so these two conditions are vacuously true.
            noParkedTrigger: true,
            validatingRecord: true,
        };
        const file = `pass-${String(++this.passNumber).padStart(4, "0")}.${STRICT_AUDIT ? "strict" : "default"}.json`;
        writeFileSync(
            join(dir, file),
            `${JSON.stringify({
                wire,
                wireBytes: JSON.stringify(wire),
                bustedThisPass,
                eligibility,
                identityEligible: Object.values(eligibility).every(Boolean),
            })}\n`,
            { flag: "wx" },
        );
    }
}

export function auditName(host: string, subagent: boolean, lane: string, scenario: string): string {
    return [host, subagent ? "subagent" : "primary", scenario, lane.replace(/\W+/g, "-")].join("/");
}
