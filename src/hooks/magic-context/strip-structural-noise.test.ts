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
    it("removes meta and step markers plus cleared reasoning shells", () => {
        const msg = message("m-1", "assistant", [
            { type: "meta", data: { trace: true } },
            { type: "step-start", snapshot: "abc" },
            { type: "text", text: "visible response" },
            { type: "reasoning", text: "[cleared]" },
            { type: "step-finish", reason: "done" },
        ]);

        const stripped = stripStructuralNoise([msg]);

        expect(stripped).toBe(4);
        expect(msg.parts).toEqual([{ type: "text", text: "visible response" }]);
    });

    it("preserves reasoning with live content", () => {
        const msg = message("m-1", "assistant", [
            { type: "reasoning", text: "live reasoning" },
            { type: "text", text: "visible response" },
        ]);

        const stripped = stripStructuralNoise([msg]);

        expect(stripped).toBe(0);
        expect(msg.parts).toHaveLength(2);
    });

    it("keeps messages that would otherwise become empty", () => {
        const msg = message("m-1", "assistant", [
            { type: "meta", data: { trace: true } },
            { type: "step-start", snapshot: "abc" },
        ]);

        const stripped = stripStructuralNoise([msg]);

        expect(stripped).toBe(0);
        expect(msg.parts).toHaveLength(2);
    });
});
