import { afterEach, describe, expect, it, spyOn } from "bun:test";

import * as logger from "../shared/logger";
import {
    hasDeprecatedTransformKeys,
    resetTransformModeDeprecationWarningForTest,
    resolveTransformMode,
    warnTransformModeDeprecatedOnce,
} from "./transform-mode";

describe("resolveTransformMode", () => {
    // These inputs used to activate the full-array Rust transform. Every host now
    // runs the TypeScript transform whatever the config says.
    it("resolves rust with user-level subc and compaction on to ts", () => {
        expect(
            resolveTransformMode({
                configured: "rust",
                userTierHasSubc: true,
                compactionEnabled: true,
            }),
        ).toEqual({ mode: "ts" });
    });

    it("resolves every other combination to ts", () => {
        for (const configured of ["ts", "rust"] as const)
            for (const userTierHasSubc of [true, false])
                for (const compactionEnabled of [true, false])
                    expect(
                        resolveTransformMode({ configured, userTierHasSubc, compactionEnabled })
                            .mode,
                    ).toBe("ts");
        expect(resolveTransformMode().mode).toBe("ts");
    });
});

describe("transform_mode deprecation", () => {
    afterEach(() => resetTransformModeDeprecationWarningForTest());

    it("detects either retired key in a raw config layer", () => {
        expect(hasDeprecatedTransformKeys({ transform_mode: "ts" })).toBe(true);
        expect(hasDeprecatedTransformKeys({ rust_pipeline: "provider" })).toBe(true);
        expect(hasDeprecatedTransformKeys({ subc: { connection_file: "/s" } })).toBe(false);
        expect(hasDeprecatedTransformKeys(undefined)).toBe(false);
    });

    it("logs the warning once per process", () => {
        const log = spyOn(logger, "log").mockImplementation(() => {});
        try {
            warnTransformModeDeprecatedOnce();
            warnTransformModeDeprecatedOnce();
            warnTransformModeDeprecatedOnce();
            expect(log.mock.calls).toEqual([
                [
                    "[magic-context] transform_mode is no longer used; Magic Context runs its TypeScript transform. Sessions that moved to CortexKit are managed there.",
                ],
            ]);
        } finally {
            log.mockRestore();
        }
    });
});
