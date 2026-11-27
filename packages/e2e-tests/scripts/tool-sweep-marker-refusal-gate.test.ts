import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("marker trim refusal preserves the pending cut until /ctx-flush moves it once", () => {
    const output = mkdtempSync(join(tmpdir(), "marker-refusal-gate-"));
    try {
        execFileSync(process.execPath, [join(import.meta.dir, "ckios-reasoning-only-probe.ts"), output], {
            env: {
                ...process.env,
                MC_PROBE_LANE: "marker-dropped-boundary",
                MC_PROBE_REFUSE_TRIM: "1",
                MC_PROBE_FLUSH_PENDING_MARKER: "1",
                MC_PROBE_UPGRADE_FROM: "",
                MC_SPECIMEN_DIR: "",
            },
            timeout: 180_000, stdio: "pipe",
        });
        const state = (label: string) => JSON.parse(readFileSync(join(output, `marker-dropped-boundary-${label}-state.json`), "utf8"));
        const before = state("before-refusal");
        const refused = state("after-refusal");
        const retry = state("after-retry");
        const defer = state("after-defer");
        const flushed = state("after-flush");
        const afterFlushDefer = state("after-flush-defer");
        const log = readFileSync(join(output, "marker-dropped-boundary.log"), "utf8");
        const bodies = JSON.parse(readFileSync(join(output, "marker-dropped-boundary-bodies.json"), "utf8")) as Array<{ messages: unknown[] }>;

        expect(refused).toEqual(before);
        const pending = JSON.parse(before.pending_compaction_marker_state);
        expect(pending.ordinal).toBe(6);
        expect(pending.endMessageId).toBeTruthy();
        expect(log).toContain("compaction-marker drain: refusing ordinal 6 because prefix trim");
        expect(log).toContain("was not proven; preserving deferred history refresh signal");
        expect(log).toContain("appears more than once");

        // Replaying the refreshed history trims what the provider sees without moving the host marker.
        expect(retry).toEqual(before);
        expect(defer).toEqual(before);
        const serialize = (value: unknown) => JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item);
        const request = (lastPrompt: string) => {
            const matches = bodies.filter(({ messages }) => serialize(messages.at(-1)).includes(lastPrompt));
            expect(matches).toHaveLength(1);
            return matches[0]!.messages;
        };
        const retryMessages = request("retry with provable source order");
        expect(serialize(retryMessages)).toContain("Older fixture history.");
        expect(serialize(retryMessages)).not.toContain("older history to compact");
        expect(serialize(retryMessages)).not.toContain("boundary user before retained tail");
        expect(serialize(retryMessages)).not.toContain("Run the fixture");
        const expectAppendOnly = (previous: unknown[], current: unknown[]) => {
            expect(current.length).toBeGreaterThan(previous.length);
            expect(serialize(current.slice(0, previous.length))).toBe(serialize(previous));
        };
        expectAppendOnly(retryMessages, request("verify marker does not advance twice"));

        expect(flushed.pending_compaction_marker_state).toBeNull();
        expect(JSON.parse(flushed.compaction_marker_state)).toMatchObject({
            boundaryOrdinal: 6,
            targetEndMessageId: pending.endMessageId,
        });
        expect(flushed.compaction_marker_state).not.toBe(before.compaction_marker_state);
        const applied = "compaction-marker drain: applied at ordinal 6";
        expect(log.split(applied)).toHaveLength(2);
        const permission = log.indexOf("rewrite permission: allowed=true ride=explicitFlush");
        expect(permission).toBeGreaterThan(-1);
        expect(log.indexOf(applied)).toBeGreaterThan(permission);
        expect(afterFlushDefer).toEqual(flushed);
        expectAppendOnly(request("carry explicit marker flush"), request("verify flushed marker stays fixed"));
    } finally {
        if (process.env.MC_E2E_KEEP !== "1") rmSync(output, { recursive: true, force: true });
    }
}, 240_000);
