/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { computeNormalizedHash, normalizeMemoryContent } from "./normalize-hash";

describe("normalize-hash", () => {
    describe("#given normalizeMemoryContent", () => {
        it("#when content has mixed case and uneven whitespace #then normalizes deterministically", () => {
            const normalized = normalizeMemoryContent("  Keep   This\nVALUE\tStable  ");

            expect(normalized).toBe("keep this value stable");
        });
    });

    describe("#given computeNormalizedHash", () => {
        it("#when semantically equivalent content is hashed #then hashes match", () => {
            const hashA = computeNormalizedHash("User prefers Bun builds");
            const hashB = computeNormalizedHash("  user\n prefers   bun builds  ");

            expect(hashA).toBe(hashB);
        });

        it("#when distinct content is hashed #then hashes differ", () => {
            const hashA = computeNormalizedHash("Prefer Bun");
            const hashB = computeNormalizedHash("Prefer Node");

            expect(hashA).not.toBe(hashB);
        });
    });
});
