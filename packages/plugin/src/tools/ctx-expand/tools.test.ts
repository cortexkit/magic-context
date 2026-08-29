import { describe, expect, it } from "bun:test";

import { createCtxExpandTools } from "./tools";

const toolContext = { sessionID: "ses-expand-validation" } as never;
const tools = createCtxExpandTools({ db: {} as never });

describe("ctx_expand ordinal validation", () => {
    it("rejects zero and fractional message ordinals", async () => {
        expect(await tools.ctx_expand.execute({ message: 0 }, toolContext)).toBe(
            "Error: message must be a positive integer.",
        );
        expect(await tools.ctx_expand.execute({ message: 1.5 }, toolContext)).toBe(
            "Error: message must be a positive integer.",
        );
    });

    it("rejects zero and fractional range ordinals", async () => {
        const error =
            "Error: provide either message=<ordinal>, or start and end (positive integers, start <= end).";
        expect(await tools.ctx_expand.execute({ start: 0, end: 1 }, toolContext)).toBe(error);
        expect(await tools.ctx_expand.execute({ start: 1.5, end: 2 }, toolContext)).toBe(error);
        expect(await tools.ctx_expand.execute({ start: 1, end: 2.5 }, toolContext)).toBe(error);
    });
});
