import { describe, expect, it } from "bun:test";
import { parseRangeString } from "./range-parser";

describe("parseRangeString", () => {
    it("parses a single number", () => {
        //#given
        const input = "5";
        //#when
        const result = parseRangeString(input);
        //#then
        expect(result).toEqual([5]);
    });

    it("parses a range", () => {
        //#given
        const input = "3-5";
        //#when
        const result = parseRangeString(input);
        //#then
        expect(result).toEqual([3, 4, 5]);
    });

    it("parses comma-separated numbers", () => {
        //#given
        const input = "1,2,9";
        //#when
        const result = parseRangeString(input);
        //#then
        expect(result).toEqual([1, 2, 9]);
    });

    it("parses mixed ranges and individual numbers", () => {
        //#given
        const input = "1-5,8,12-15";
        //#when
        const result = parseRangeString(input);
        //#then
        expect(result).toEqual([1, 2, 3, 4, 5, 8, 12, 13, 14, 15]);
    });

    it("deduplicates repeated numbers", () => {
        //#given
        const input = "1,1,2,3,3";
        //#when
        const result = parseRangeString(input);
        //#then
        expect(result).toEqual([1, 2, 3]);
    });

    it("handles whitespace around separators", () => {
        //#given
        const input = " 3 - 5 , 8 ";
        //#when
        const result = parseRangeString(input);
        //#then
        expect(result).toEqual([3, 4, 5, 8]);
    });

    it("throws on empty string", () => {
        //#given
        const input = "";
        //#when + #then
        expect(() => parseRangeString(input)).toThrow();
    });

    it("throws on non-numeric input", () => {
        //#given
        const input = "abc";
        //#when + #then
        expect(() => parseRangeString(input)).toThrow();
    });

    it("throws on reversed range", () => {
        //#given
        const input = "5-3";
        //#when + #then
        expect(() => parseRangeString(input)).toThrow();
    });

    it("throws on range exceeding 1000 elements", () => {
        //#given
        const input = "1-10000";
        //#when + #then
        expect(() => parseRangeString(input)).toThrow(
            'Range "1-10000" exceeds maximum size of 1000 elements (got 10000)',
        );
    });

    it("throws on range of 1001 elements", () => {
        //#given
        const input = "1-1001";
        //#when + #then
        expect(() => parseRangeString(input)).toThrow();
    });

    it("allows max valid range of 1000 elements", () => {
        //#given
        const input = "1-1000";
        //#when
        const result = parseRangeString(input);
        //#then
        expect(result).toHaveLength(1000);
        expect(result[0]).toBe(1);
        expect(result[999]).toBe(1000);
    });
});
