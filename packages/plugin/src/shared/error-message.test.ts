import { describe, expect, it } from "bun:test";
import { describeError, getErrorMessage } from "./error-message";

describe("describeError", () => {
    it("extracts name and message from standard Error", () => {
        const err = new TypeError("boom");
        const desc = describeError(err);
        expect(desc.name).toBe("TypeError");
        expect(desc.message).toBe("boom");
        expect(desc.brief).toContain("TypeError");
        expect(desc.brief).toContain('message="boom"');
    });

    it("surfaces class name when message is empty (NotFoundError case)", () => {
        class NotFoundError extends Error {
            constructor() {
                super("");
                this.name = "NotFoundError";
            }
        }
        const err = new NotFoundError();
        const desc = describeError(err);
        expect(desc.name).toBe("NotFoundError");
        expect(desc.message).toBe("");
        // brief must still carry a useful signal even with empty message
        expect(desc.brief).toContain("NotFoundError");
    });

    it("falls back to constructor.name when .name is missing", () => {
        // Simulate an SDK-shaped object where .name is an empty string
        const err = Object.assign(new Error("x"), { name: "" });
        const desc = describeError(err);
        // Falls back to constructor.name ("Error")
        expect(desc.name).toBe("Error");
    });

    it("extracts status/code fields from HTTP-style errors", () => {
        const err = Object.assign(new Error("not found"), {
            status: 404,
            code: "ENOTFOUND",
        });
        const desc = describeError(err);
        expect(desc.status).toBe("404");
        expect(desc.code).toBe("ENOTFOUND");
        expect(desc.brief).toContain("status=404");
        expect(desc.brief).toContain("code=ENOTFOUND");
    });

    it("captures first stack frames in stackHead", () => {
        const err = new Error("with stack");
        const desc = describeError(err);
        expect(desc.stackHead).toBeDefined();
        expect(desc.stackHead?.length).toBeGreaterThan(0);
    });

    it("handles non-Error thrown values", () => {
        const desc = describeError("plain string");
        expect(desc.brief).toContain("plain string");
        expect(desc.stringForm).toContain("plain string");
    });

    it("handles objects without .message", () => {
        const desc = describeError({ name: "WeirdError" });
        expect(desc.name).toBe("WeirdError");
        expect(desc.message).toBe("");
        expect(desc.brief).toContain("WeirdError");
    });

    it("handles undefined/null", () => {
        expect(describeError(undefined).brief).toBeTruthy();
        expect(describeError(null).brief).toBeTruthy();
    });

    it("surfaces cause name when present", () => {
        const cause = new TypeError("inner");
        const outer = new Error("outer");
        (outer as unknown as { cause: unknown }).cause = cause;
        const desc = describeError(outer);
        expect(desc.causeName).toBe("TypeError");
        expect(desc.brief).toContain("cause=TypeError");
    });

    it("clips very long messages in brief", () => {
        const long = "x".repeat(1000);
        const err = new Error(long);
        const desc = describeError(err);
        expect(desc.brief.length).toBeLessThan(500);
    });

    it("getErrorMessage still works as before", () => {
        expect(getErrorMessage(new Error("foo"))).toBe("foo");
        expect(getErrorMessage("bar")).toBe("bar");
    });
});
