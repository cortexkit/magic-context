import { expect, test } from "bun:test";
import { expectedSelection, slowPattern, slowUnits } from "./run-slow-unit-tests";

test("slow lane selects every moved host and provider variant exactly once", () => {
    const selected = slowUnits.flatMap(([, , names]) => expectedSelection(names, true));
    expect(selected).toHaveLength(22);
    expect(new Set(selected).size).toBe(22);
    expect(selected.every((name) => new RegExp(slowPattern).test(name))).toBe(true);
    expect(selected.filter((name) => name.includes("OC2 replay differential"))).toHaveLength(2);
    expect(selected.filter((name) => name.includes("issue 750 differential"))).toHaveLength(2);
    expect(selected.filter((name) => name.includes("queued batch"))).toHaveLength(3);
    expect(selected.filter((name) => name.includes("v2 disabled features preserve baseline bytes"))).toHaveLength(4);
    expect(slowUnits.filter(([, file]) => file.includes("auto-embed-session"))).toHaveLength(1);
});

test("normal lane keeps behavioral versions but excludes slow names and calibrations", () => {
    const selected = slowUnits.flatMap(([, , names]) => expectedSelection(names, false));
    expect(selected).toHaveLength(20);
    expect(selected.some((name) => new RegExp(slowPattern).test(name))).toBe(false);
    expect(selected.some((name) => name.includes("heartbeat"))).toBe(false);
    expect(selected.filter((name) => name.includes("ordinal differential"))).toHaveLength(3);
});
