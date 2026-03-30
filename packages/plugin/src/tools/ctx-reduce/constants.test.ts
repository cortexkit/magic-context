import { describe, expect, it } from "bun:test";
import { CTX_REDUCE_DESCRIPTION } from "./constants";

describe("ctx-reduce constants", () => {
    //#given
    describe("CTX_REDUCE_DESCRIPTION", () => {
        //#then
        it("should be non-empty", () => {
            expect(CTX_REDUCE_DESCRIPTION.length).toBeGreaterThan(0);
        });

        it("should describe drop-only reduction", () => {
            expect(CTX_REDUCE_DESCRIPTION).toContain("dropping tagged content");
            expect(CTX_REDUCE_DESCRIPTION).toContain("drop");
            expect(CTX_REDUCE_DESCRIPTION).not.toContain("summarize instead of drop");
        });
    });
});
