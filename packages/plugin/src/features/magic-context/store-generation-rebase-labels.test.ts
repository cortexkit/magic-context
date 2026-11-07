import { expect, test } from "bun:test";
import { rewriteMessageLabels } from "./store-generation-rebase-labels";

test("counts canonical labels whose identity or uniform delta cannot be resolved", () => {
    expect(rewriteMessageLabels("[1] [2-3] [4] [04] [4-2]", () => undefined)).toEqual({
        text: "[1] [2-3] [4] [04] [4-2]",
        unchanged: 3,
    });
});
