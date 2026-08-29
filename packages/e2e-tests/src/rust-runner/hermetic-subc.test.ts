/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { __hermeticSubcTest } from "./hermetic-subc";

describe("hermetic Rust process isolation", () => {
    it("uses an e2e-owned Cargo target directory", () => {
        expect(__hermeticSubcTest.rustE2eCargoTargetDir).toBe(
            join(import.meta.dir, "../../.cache/rust-e2e-cargo-target"),
        );
        expect(__hermeticSubcTest.rustE2eCargoTargetDir).not.toContain("subconscious/target");
        expect(__hermeticSubcTest.rustE2eCargoEnv().CARGO_TARGET_DIR).toBe(
            __hermeticSubcTest.rustE2eCargoTargetDir,
        );
    });

    it("ignores a prebuilt module override when selecting the hermetic binary", () => {
        expect(__hermeticSubcTest.currentTreeCkMcBinary("/tmp/stale/ck-mc")).toBe(
            join(__hermeticSubcTest.rustE2eCargoTargetDir, "release/ck-mc"),
        );
    });

    it("reaps only stale PID records", () => {
        const nowMs = 10 * __hermeticSubcTest.stalePidAgeMs;

        expect(
            __hermeticSubcTest.isStaleRustE2ePidRecord(
                nowMs - __hermeticSubcTest.stalePidAgeMs + 1,
                nowMs,
            ),
        ).toBe(false);
        expect(
            __hermeticSubcTest.isStaleRustE2ePidRecord(
                nowMs - __hermeticSubcTest.stalePidAgeMs,
                nowMs,
            ),
        ).toBe(true);
        expect(__hermeticSubcTest.isStaleRustE2ePidRecord(nowMs + 1, nowMs)).toBe(false);
        expect(__hermeticSubcTest.isStaleRustE2ePidRecord(Number.NaN, nowMs)).toBe(false);
    });
});
