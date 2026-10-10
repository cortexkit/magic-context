/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { stableStringify } from "./stable-json";

/** stableStringify as it was before it collected pieces: joins at every level. */
function frozenStableStringify(value: unknown, seen = new WeakSet<object>()): string {
    if (value === undefined) return "undefined";
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    if (Array.isArray(value)) {
        return `[${value.map((item) => frozenStableStringify(item, seen)).join(",")}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
    });
    return `{${entries
        .map(([key, child]) => `${JSON.stringify(key)}:${frozenStableStringify(child, seen)}`)
        .join(",")}}`;
}

function rng(seed: number): () => number {
    let state = seed >>> 0 || 1;
    return () => {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state / 0x100000000;
    };
}

function randomValue(random: () => number, depth: number, shared: object[]): unknown {
    const roll = random();
    if (depth > 4 || roll < 0.35) {
        const leaves: unknown[] = [
            "plain",
            'quote " and \\ backslash',
            "ünï 日本 😀 \u2028",
            0,
            -0,
            1.5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            true,
            false,
            null,
            undefined,
            () => 1,
            Symbol("s"),
        ];
        return leaves[Math.floor(random() * leaves.length)];
    }
    if (roll < 0.45 && shared.length > 0) return shared[Math.floor(random() * shared.length)];
    if (roll < 0.7) {
        const array: unknown[] = [];
        const length = Math.floor(random() * 5);
        for (let index = 0; index < length; index += 1) {
            if (random() < 0.15) continue; // leaves a hole
            array[index] = randomValue(random, depth + 1, shared);
        }
        array.length = length;
        if (random() < 0.2) shared.push(array);
        return array;
    }
    const object: Record<string, unknown> = {};
    for (let index = Math.floor(random() * 5); index > 0; index -= 1) {
        const key = ["b", "a", "10", "2", "é", "Z", "key with space"][
            Math.floor(random() * 7)
        ] as string;
        object[key] = randomValue(random, depth + 1, shared);
    }
    if (random() < 0.2) shared.push(object);
    if (random() < 0.1) object.self = object;
    return object;
}

describe("stableStringify", () => {
    it("writes exactly what it wrote when it joined at every level", () => {
        const random = rng(653);
        let circular = 0;
        let holes = 0;
        for (let sample = 0; sample < 2_000; sample += 1) {
            const value = randomValue(random, 0, []);
            const text = stableStringify(value);
            expect(text).toBe(frozenStableStringify(value));
            if (text.includes('"[Circular]"')) circular += 1;
            if (/\[,|,,|,\]/.test(text)) holes += 1;
        }
        // Shared and cyclic references and array holes were among the samples.
        expect(circular).toBeGreaterThan(50);
        expect(holes).toBeGreaterThan(50);
    });

    it("copies a deeply nested value once, not once per level", () => {
        // 3,000 levels around a 1 MB string: joining at every level copied about
        // 3 GB of text.
        let node: unknown = { body: "x".repeat(1_000_000) };
        for (let depth = 0; depth < 3_000; depth += 1) node = { child: node, depth };
        const started = performance.now();
        const text = stableStringify(node);
        expect(text.length).toBeGreaterThan(1_000_000);
        expect(performance.now() - started).toBeLessThan(1_000);
    }, 30_000);
});
