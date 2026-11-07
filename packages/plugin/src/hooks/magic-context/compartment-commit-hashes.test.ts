import { expect, test } from "bun:test";
import { removeUnsupportedCommitHashes } from "./compartment-commit-hashes";

test("unsupported summary numbers survive while mixed hashes are range-checked", () => {
    const summary =
        "1000000 tokens at 1720000000000; `1234567` bytes; unsupported `a1b2c3d`; supported `D3714D6`.";
    expect(removeUnsupportedCommitHashes(summary, new Set(["d3714d6a9b"]))).toBe(
        "1000000 tokens at 1720000000000; `1234567` bytes; unsupported ; supported `D3714D6`.",
    );
});
