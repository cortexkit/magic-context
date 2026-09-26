import { describe, expect, it } from "bun:test";
import { disableNativeAutoCompaction } from "./native-compaction-guard";

describe("disableNativeAutoCompaction", () => {
    it("turns auto-compaction off when no layer set it", () => {
        const config: Record<string, unknown> = {};
        expect(disableNativeAutoCompaction(config)).toBe(true);
        expect(config.compaction).toEqual({ auto: false });
    });

    it("keeps the user's other compaction settings", () => {
        const config: Record<string, unknown> = { compaction: { prune: true, reserved: 10_000 } };
        expect(disableNativeAutoCompaction(config)).toBe(true);
        expect(config.compaction).toEqual({ prune: true, reserved: 10_000, auto: false });
    });

    it("leaves a config that already disables auto-compaction untouched", () => {
        const compaction = { auto: false, prune: false };
        const config: Record<string, unknown> = { compaction };
        expect(disableNativeAutoCompaction(config)).toBe(false);
        expect(config.compaction).toBe(compaction);
    });
});
