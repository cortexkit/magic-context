import { expect, test } from "bun:test";
import { assertNoMaterial } from "./credential-protocol";

// The Mac controller pipes real Docker metadata to this offline Linux validator.
if (process.env.TWO_PASS_INSPECT_CONTROL === "1") {
    test("Docker inspect contains no credential material", async () => {
        const inspect = await Bun.stdin.text();
        expect(Array.isArray(JSON.parse(inspect))).toBe(true);
        assertNoMaterial("inspect", inspect, "mock-docker-env-control-key");
    });
}
