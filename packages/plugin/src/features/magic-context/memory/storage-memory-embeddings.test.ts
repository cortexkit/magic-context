import { describe, expect, test } from "bun:test";
import { float32ArrayToBlob, toFloat32Array } from "./storage-memory-embeddings";

describe("vector serde round-trip", () => {
    test("Float32Array → blob → Float32Array preserves values", () => {
        const vec = new Float32Array([0.1, -0.5, 0.99, 0.0]);
        const blob = float32ArrayToBlob(vec);
        const back = toFloat32Array(blob);
        expect(Array.from(back)).toEqual(Array.from(vec));
    });
});
