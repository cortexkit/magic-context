import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("marker refusal preserves persisted row until next provable pass advances once", () => {
    const output = mkdtempSync(join(tmpdir(), "marker-refusal-gate-"));
    execFileSync(process.execPath, [join(import.meta.dir, "ckios-reasoning-only-probe.ts"), output], {
        env: { ...process.env, MC_PROBE_LANE: "marker-dropped-boundary", MC_PROBE_REFUSE_TRIM: "1", MC_PROBE_UPGRADE_FROM: "", MC_SPECIMEN_DIR: "" },
        timeout: 180_000, stdio: "pipe",
    });
    const state = (label: string) => JSON.parse(readFileSync(join(output, `marker-dropped-boundary-${label}-state.json`), "utf8"));
    const before = state("before-refusal");
    const refused = state("after-refusal");
    const retry = state("after-retry");
    const defer = state("after-defer");
    const log = readFileSync(join(output, "marker-dropped-boundary.log"), "utf8");
    const bodies = JSON.parse(readFileSync(join(output, "marker-dropped-boundary-bodies.json"), "utf8"));
    let previous: unknown[] | undefined;
    for (const [index, body] of bodies.entries()) {
        const messages = body.messages as unknown[];
        const serialize = (value: unknown) => JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item);
        const firstDivergence = previous ? Array.from({ length: previous.length }, (_, i) => i).find(i => serialize(previous![i]) !== serialize(messages[i])) ?? -1 : -1;
        console.log(`MARKER_GATE pass=${index} sha256=${createHash("sha256").update(serialize(messages)).digest("hex")} first_divergence=${firstDivergence}`);
        previous = messages;
    }
    console.log(`MARKER_GATE states ${JSON.stringify({ output, before, refused, retry, defer })}`);
    expect(refused).toEqual(before);
    expect(refused.pending_compaction_marker_state).not.toBeNull();
    expect(log).toContain("compaction-marker drain: refusing ordinal 6 because prefix trim");
    expect(log).toContain("was not proven; preserving deferred history refresh signal");
    expect(log).toContain("appears more than once");
    expect(retry.pending_compaction_marker_state).toBeNull();
    expect(JSON.parse(retry.compaction_marker_state).boundaryOrdinal).toBe(6);
    expect(retry.compaction_marker_state).not.toBe(before.compaction_marker_state);
    expect(defer).toEqual(retry);
    expect(log.split("compaction-marker drain: applied at ordinal 6").length - 1).toBe(1);
}, 240_000);
