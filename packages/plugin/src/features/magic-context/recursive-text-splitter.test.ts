import { describe, expect, test } from "bun:test";
import { recursiveCharacterSplit } from "./recursive-text-splitter";

const charLen = (t: string) => t.length;

describe("recursiveCharacterSplit", () => {
    test("returns empty for empty input", () => {
        expect(recursiveCharacterSplit("", { chunkSize: 10, lengthFunction: charLen })).toEqual([]);
    });

    test("keeps text that already fits as a single chunk", () => {
        const out = recursiveCharacterSplit("short", { chunkSize: 100, lengthFunction: charLen });
        expect(out).toEqual(["short"]);
    });

    test("splits on the coarsest separator that keeps chunks under budget", () => {
        const text = "para one\n\npara two\n\npara three";
        const out = recursiveCharacterSplit(text, { chunkSize: 10, lengthFunction: charLen });
        expect(out.length).toBeGreaterThan(1);
        for (const chunk of out) {
            expect(chunk.length).toBeLessThanOrEqual(10);
        }
        // Round-trips the content (modulo separator trimming).
        expect(out.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
    });

    test("falls through the separator hierarchy down to words", () => {
        const text = "alpha beta gamma delta epsilon zeta eta theta";
        const out = recursiveCharacterSplit(text, { chunkSize: 12, lengthFunction: charLen });
        expect(out.length).toBeGreaterThan(1);
        for (const chunk of out) {
            expect(chunk.length).toBeLessThanOrEqual(12);
        }
    });

    test("splits a single long word into character chunks (no separators)", () => {
        const text = "a".repeat(50);
        const out = recursiveCharacterSplit(text, { chunkSize: 10, lengthFunction: charLen });
        expect(out.length).toBeGreaterThan(1);
        for (const chunk of out) {
            expect(chunk.length).toBeLessThanOrEqual(10);
        }
        expect(out.join("")).toBe(text);
    });

    test("honors a custom (token-like) length function", () => {
        // Count "tokens" as whitespace-separated words.
        const tokenLen = (t: string) => t.split(/\s+/).filter(Boolean).length;
        const text = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
        const out = recursiveCharacterSplit(text, { chunkSize: 5, lengthFunction: tokenLen });
        expect(out.length).toBeGreaterThan(1);
        for (const chunk of out) {
            expect(tokenLen(chunk)).toBeLessThanOrEqual(5);
        }
    });

    test("defaults lengthFunction to character count", () => {
        const out = recursiveCharacterSplit("alpha beta gamma", { chunkSize: 6 });
        for (const chunk of out) {
            expect(chunk.length).toBeLessThanOrEqual(6);
        }
    });
});
