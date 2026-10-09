/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    createPassOutcome,
    degradationChangesRequest,
    PASS_DEGRADATION_EFFECTS,
} from "./pass-outcome";

// The sources that record pass degradations, through `passOutcome.record`,
// `args.passOutcome?.record` or the transform's `failPass`.
const RECORDING_SOURCES = ["transform.ts", "transform-postprocess-phase.ts"];

function source(name: string): string {
    return readFileSync(join(import.meta.dir, name), "utf8");
}

/** Every site name the recording sources pass to a recorder, as written. */
function recordedSites(): string[] {
    const sites: string[] = [];
    for (const name of RECORDING_SOURCES) {
        const text = source(name);
        // The site is the first argument; it may sit on the next line.
        for (const match of text.matchAll(/(?:\.record|\bfailPass)\(\s*(["`])([^"`]+)\1/g)) {
            sites.push(match[2] ?? "");
        }
    }
    return sites;
}

/** Expand `auto-search-${autoSearchOutcome.kind}` into one site per failure kind. */
function expandAutoSearchSite(site: string): string[] {
    if (!site.includes("${")) return [site];
    expect(site).toBe("auto-search-${autoSearchOutcome.kind}");
    const runner = source("auto-search-runner.ts");
    const kinds = runner.match(/\{\s*ok:\s*false;\s*kind:\s*([^}]+)\}/)?.[1] ?? "";
    const names = [...kinds.matchAll(/"([^"]+)"/g)].map((match) => `auto-search-${match[1]}`);
    expect(names.length).toBeGreaterThan(0);
    return names;
}

describe("pass degradation sites", () => {
    it("classifies every site a pass records, and lists no site nothing records", () => {
        const recorded = new Set(recordedSites().flatMap(expandAutoSearchSite));
        expect(recorded.size).toBeGreaterThan(20);
        expect([...recorded].filter((site) => !(site in PASS_DEGRADATION_EFFECTS))).toEqual([]);
        expect(Object.keys(PASS_DEGRADATION_EFFECTS).filter((site) => !recorded.has(site))).toEqual(
            [],
        );
    });

    it("lets only outcomes that leave the request as a healthy pass's be served over the limit", () => {
        const served = Object.keys(PASS_DEGRADATION_EFFECTS)
            .filter(
                (site) => !degradationChangesRequest(site as keyof typeof PASS_DEGRADATION_EFFECTS),
            )
            .sort();
        expect(served).toEqual([
            "auto-search-cas-exhaustion",
            "auto-search-internal-failure",
            "auto-search-search-failure",
            "auto-search-timeout",
            "compartment-trigger-failure",
            "invalid-cache-ttl-fallback",
            "note-nudge-cas-failure",
            "session-directory-fallback",
        ]);
    });
});

it("captures a finalized optional auto-search timeout skip, but not other failures", () => {
    const outcome = createPassOutcome();
    outcome.record("auto-search-timeout");
    expect(outcome.captureEligible).toBe(false);
    outcome.markFinalized();
    expect(outcome.captureEligible).toBe(true);
    expect(outcome.isCaptureEligible()).toBe(true);
    outcome.record("pending-operation-failure");
    expect(outcome.captureEligible).toBe(false);
    const fatal = createPassOutcome();
    fatal.record("auto-search-timeout", "fatal");
    fatal.markFinalized();
    expect(fatal.captureEligible).toBe(false);
});
