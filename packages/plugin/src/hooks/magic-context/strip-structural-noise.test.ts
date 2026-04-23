/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { stripStructuralNoise } from "./strip-structural-noise";
import type { MessageLike } from "./tag-messages";

function message(id: string, role: string, parts: unknown[]): MessageLike {
    return {
        info: { id, role, sessionID: "ses-1" },
        parts,
    };
}

describe("stripStructuralNoise", () => {
    it("replaces meta, step markers, and cleared reasoning with empty-text sentinels (length preserved)", () => {
        const msg = message("m-1", "assistant", [
            { type: "meta", data: { trace: true } },
            { type: "step-start", snapshot: "abc" },
            { type: "text", text: "visible response" },
            { type: "reasoning", text: "[cleared]" },
            { type: "step-finish", reason: "done" },
        ]);
        const originalLength = msg.parts.length;

        const stripped = stripStructuralNoise([msg]);

        expect(stripped).toBe(4);
        expect(msg.parts).toHaveLength(originalLength);
        expect(msg.parts).toEqual([
            { type: "text", text: "" },
            { type: "text", text: "" },
            { type: "text", text: "visible response" },
            { type: "text", text: "" },
            { type: "text", text: "" },
        ]);
    });

    it("preserves reasoning with live content", () => {
        const msg = message("m-1", "assistant", [
            { type: "reasoning", text: "live reasoning" },
            { type: "text", text: "visible response" },
        ]);

        const stripped = stripStructuralNoise([msg]);

        expect(stripped).toBe(0);
        expect(msg.parts).toHaveLength(2);
        expect(msg.parts).toEqual([
            { type: "reasoning", text: "live reasoning" },
            { type: "text", text: "visible response" },
        ]);
    });

    it("is idempotent — running twice produces the same array and same mutation count on first run only", () => {
        const msg = message("m-1", "assistant", [
            { type: "meta", data: { trace: true } },
            { type: "step-start", snapshot: "abc" },
            { type: "text", text: "visible response" },
            { type: "reasoning", text: "[cleared]" },
            { type: "step-finish", reason: "done" },
        ]);
        const originalLength = msg.parts.length;

        const strippedFirst = stripStructuralNoise([msg]);
        const firstPass = JSON.parse(JSON.stringify(msg.parts));
        const strippedSecond = stripStructuralNoise([msg]);
        const secondPass = JSON.parse(JSON.stringify(msg.parts));

        expect(strippedFirst).toBe(4);
        expect(strippedSecond).toBe(0);
        expect(msg.parts).toHaveLength(originalLength);
        expect(secondPass).toEqual(firstPass);
    });

    it("inherits cache_control onto the sentinel when the original part had one", () => {
        const msg = message("m-1", "assistant", [
            { type: "meta", data: { trace: true }, cache_control: { type: "ephemeral" } },
            { type: "text", text: "visible response" },
        ]);

        const stripped = stripStructuralNoise([msg]);

        expect(stripped).toBe(1);
        expect(msg.parts[0]).toEqual({
            type: "text",
            text: "",
            cache_control: { type: "ephemeral" },
        });
    });

    it("keeps messages that would otherwise become all-sentinel", () => {
        const msg = message("m-1", "assistant", [
            { type: "meta", data: { trace: true } },
            { type: "step-start", snapshot: "abc" },
        ]);

        const stripped = stripStructuralNoise([msg]);

        // We now replace parts with sentinels regardless — message isn't emptied.
        // Length stays 2 so array position hashing is stable across passes.
        expect(stripped).toBe(2);
        expect(msg.parts).toHaveLength(2);
        expect(msg.parts).toEqual([
            { type: "text", text: "" },
            { type: "text", text: "" },
        ]);
    });
});
