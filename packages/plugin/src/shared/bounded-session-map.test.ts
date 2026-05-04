import { describe, expect, it } from "bun:test";
import { BoundedSessionMap } from "./bounded-session-map";

describe("BoundedSessionMap", () => {
    it("rejects non-positive caps", () => {
        expect(() => new BoundedSessionMap(0)).toThrow();
        expect(() => new BoundedSessionMap(-5)).toThrow();
        expect(() => new BoundedSessionMap(Number.NaN)).toThrow();
    });

    it("stores and retrieves values", () => {
        const map = new BoundedSessionMap<number>(3);
        map.set("a", 1);
        map.set("b", 2);
        expect(map.get("a")).toBe(1);
        expect(map.get("b")).toBe(2);
        expect(map.get("missing")).toBeUndefined();
        expect(map.size).toBe(2);
    });

    it("evicts the oldest entry when cap is exceeded", () => {
        const map = new BoundedSessionMap<string>(3);
        map.set("a", "alpha");
        map.set("b", "bravo");
        map.set("c", "charlie");
        map.set("d", "delta"); // evicts "a"
        expect(map.has("a")).toBe(false);
        expect(map.has("b")).toBe(true);
        expect(map.has("c")).toBe(true);
        expect(map.has("d")).toBe(true);
        expect(map.size).toBe(3);
    });

    it("treats get() as a touch for LRU ordering", () => {
        const map = new BoundedSessionMap<string>(3);
        map.set("a", "alpha");
        map.set("b", "bravo");
        map.set("c", "charlie");
        // Touch "a" — now "b" is the oldest.
        expect(map.get("a")).toBe("alpha");
        map.set("d", "delta");
        expect(map.has("b")).toBe(false);
        expect(map.has("a")).toBe(true);
        expect(map.has("c")).toBe(true);
        expect(map.has("d")).toBe(true);
    });

    it("peek() does NOT touch recency", () => {
        const map = new BoundedSessionMap<number>(3);
        map.set("a", 1);
        map.set("b", 2);
        map.set("c", 3);
        expect(map.peek("a")).toBe(1);
        // Adding a fourth entry should still evict "a" since peek didn't touch it.
        map.set("d", 4);
        expect(map.has("a")).toBe(false);
    });

    it("set() on existing key refreshes recency without growing size", () => {
        const map = new BoundedSessionMap<number>(3);
        map.set("a", 1);
        map.set("b", 2);
        map.set("c", 3);
        map.set("a", 100); // refresh "a" to most-recent with new value
        expect(map.size).toBe(3);
        expect(map.get("a")).toBe(100);
        map.set("d", 4); // evicts "b" (now oldest)
        expect(map.has("b")).toBe(false);
        expect(map.has("a")).toBe(true);
    });

    it("delete() removes entries and returns true when present", () => {
        const map = new BoundedSessionMap<number>(3);
        map.set("a", 1);
        expect(map.delete("a")).toBe(true);
        expect(map.delete("a")).toBe(false);
        expect(map.size).toBe(0);
    });

    it("clear() drops all entries", () => {
        const map = new BoundedSessionMap<number>(3);
        map.set("a", 1);
        map.set("b", 2);
        map.clear();
        expect(map.size).toBe(0);
        expect(map.get("a")).toBeUndefined();
    });

    it("tolerates cap=1 edge case (every set evicts previous)", () => {
        const map = new BoundedSessionMap<number>(1);
        map.set("a", 1);
        map.set("b", 2);
        expect(map.has("a")).toBe(false);
        expect(map.get("b")).toBe(2);
        expect(map.size).toBe(1);
    });
});
