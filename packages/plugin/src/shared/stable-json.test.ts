import { describe, expect, test } from "bun:test";
import { stableStringify } from "./stable-json";

describe("stableStringify", () => {
    test("primitive values match JSON.stringify", () => {
        expect(stableStringify("hello")).toBe('"hello"');
        expect(stableStringify(42)).toBe("42");
        expect(stableStringify(true)).toBe("true");
        expect(stableStringify(false)).toBe("false");
        expect(stableStringify(null)).toBe("null");
    });

    test("undefined renders as literal string", () => {
        expect(stableStringify(undefined)).toBe("undefined");
    });

    test("object keys sort by code-point order, not locale", () => {
        // 'Z' (0x5a) sorts before 'a' (0x61) by code-point.
        // localeCompare would sort 'a' before 'Z' in many locales.
        // We want code-point semantics.
        const input = { Z: 1, a: 2 };
        expect(stableStringify(input)).toBe('{"Z":1,"a":2}');
    });

    test("nested objects sort recursively", () => {
        const input = { b: { y: 1, x: 2 }, a: { z: 3, w: 4 } };
        expect(stableStringify(input)).toBe('{"a":{"w":4,"z":3},"b":{"x":2,"y":1}}');
    });

    test("arrays preserve order", () => {
        const input = [3, 1, 2];
        expect(stableStringify(input)).toBe("[3,1,2]");
    });

    test("arrays of objects sort keys per element", () => {
        const input = [
            { b: 1, a: 2 },
            { d: 3, c: 4 },
        ];
        expect(stableStringify(input)).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
    });

    test("identical objects with different key insertion order produce same string", () => {
        const a = { foo: 1, bar: 2 };
        const b = { bar: 2, foo: 1 };
        expect(stableStringify(a)).toBe(stableStringify(b));
    });

    test("circular references render as marker, do not throw", () => {
        const a: Record<string, unknown> = { x: 1 };
        a.self = a;
        expect(stableStringify(a)).toBe('{"self":"[Circular]","x":1}');
    });

    test("mixed cycle through array does not crash", () => {
        const arr: unknown[] = [];
        arr.push(arr);
        expect(stableStringify(arr)).toBe('["[Circular]"]');
    });

    test("empty object and array", () => {
        expect(stableStringify({})).toBe("{}");
        expect(stableStringify([])).toBe("[]");
    });

    test("special string characters JSON-escaped in keys", () => {
        const input = { 'with "quotes"': 1 };
        expect(stableStringify(input)).toBe('{"with \\"quotes\\"":1}');
    });

    test("Unicode key sort by code-point, not by collation", () => {
        // 'ä' (U+00E4) sorts AFTER 'z' (U+007A) by code-point.
        // localeCompare in many locales would put 'ä' near 'a'.
        const input = { z: 1, ä: 2 };
        const result = stableStringify(input);
        expect(result).toBe('{"z":1,"ä":2}');
    });

    test("deterministic across multiple calls", () => {
        const input = { c: 3, a: 1, b: 2 };
        const first = stableStringify(input);
        const second = stableStringify(input);
        const third = stableStringify(input);
        expect(first).toBe(second);
        expect(second).toBe(third);
    });
});
