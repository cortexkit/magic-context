import { describe, expect, it } from "bun:test";
import {
    ompModelRefToCanonical,
    piModelRefToCanonical,
    resolveModelRefForOmp,
    resolveModelRefForPi,
} from "./harness-provider-map";

describe("harness-provider-map", () => {
    describe("resolveModelRefForPi (canonical -> Pi, used when spawning)", () => {
        it("maps the diverging auth-plugin providers, preserving the model id", () => {
            expect(resolveModelRefForPi("openai/gpt-5.5")).toBe("openai-codex/gpt-5.5");
            expect(resolveModelRefForPi("google/antigravity-gemini-3.5-flash")).toBe(
                "google-antigravity/antigravity-gemini-3.5-flash",
            );
        });

        it("leaves anthropic and every other provider unchanged", () => {
            expect(resolveModelRefForPi("anthropic/claude-opus-4-8")).toBe(
                "anthropic/claude-opus-4-8",
            );
            expect(resolveModelRefForPi("cerebras/gpt-oss-120b")).toBe("cerebras/gpt-oss-120b");
            expect(resolveModelRefForPi("openrouter/openai/gpt-5.5")).toBe(
                "openrouter/openai/gpt-5.5",
            );
        });

        it("is idempotent: a config already in Pi form still resolves to Pi form", () => {
            expect(resolveModelRefForPi("openai-codex/gpt-5.5")).toBe("openai-codex/gpt-5.5");
            expect(resolveModelRefForPi("google-antigravity/antigravity-gemini-3.1-pro")).toBe(
                "google-antigravity/antigravity-gemini-3.1-pro",
            );
        });

        it("preserves model ids that themselves contain slashes", () => {
            expect(resolveModelRefForPi("openai/some/nested/id")).toBe(
                "openai-codex/some/nested/id",
            );
        });

        it("passes through malformed refs (no slash, empty provider) unchanged", () => {
            expect(resolveModelRefForPi("gpt-5.5")).toBe("gpt-5.5");
            expect(resolveModelRefForPi("/gpt-5.5")).toBe("/gpt-5.5");
            expect(resolveModelRefForPi("")).toBe("");
        });
    });

    describe("piModelRefToCanonical (Pi -> canonical, used by Pi setup write)", () => {
        it("normalizes Pi-native provider ids to the OpenCode form", () => {
            expect(piModelRefToCanonical("openai-codex/gpt-5.5")).toBe("openai/gpt-5.5");
            expect(piModelRefToCanonical("google-antigravity/antigravity-gemini-3.5-flash")).toBe(
                "google/antigravity-gemini-3.5-flash",
            );
        });

        it("leaves already-canonical and unmapped providers unchanged", () => {
            expect(piModelRefToCanonical("anthropic/claude-opus-4-8")).toBe(
                "anthropic/claude-opus-4-8",
            );
            expect(piModelRefToCanonical("openai/gpt-5.5")).toBe("openai/gpt-5.5");
        });

        it("round-trips with resolveModelRefForPi", () => {
            const piForm = "openai-codex/gpt-5.5";
            expect(resolveModelRefForPi(piModelRefToCanonical(piForm))).toBe(piForm);
        });
    });
});

describe("OMP provider boundary", () => {
    const representativeRefs = [
        ["openai/gpt-5.5", "openai-codex/gpt-5.5"],
        ["google/antigravity/gemini-3.5-flash", "google-antigravity/antigravity/gemini-3.5-flash"],
        ["anthropic/claude-opus-4-8", "anthropic/claude-opus-4-8"],
        ["@scope/provider/nested/model", "@scope/provider/nested/model"],
    ] as const;

    it.each(
        representativeRefs,
    )("round-trips canonical %s through OMP selector %s", (canonical, omp) => {
        expect(resolveModelRefForOmp(canonical)).toBe(omp);
        expect(ompModelRefToCanonical(omp)).toBe(canonical);
    });

    it("normalizes an already-native OMP selector idempotently", () => {
        const selector = "openai-codex/team/nested/gpt-5.5";
        expect(resolveModelRefForOmp(selector)).toBe(selector);
        expect(resolveModelRefForOmp(ompModelRefToCanonical(selector))).toBe(selector);
    });

    it("passes through provider ids that collide with Object.prototype members", () => {
        for (const ref of [
            "constructor/model",
            "toString/model",
            "__proto__/model",
            "hasOwnProperty/model",
        ]) {
            expect(resolveModelRefForOmp(ref)).toBe(ref);
            expect(ompModelRefToCanonical(ref)).toBe(ref);
            expect(resolveModelRefForPi(ref)).toBe(ref);
            expect(piModelRefToCanonical(ref)).toBe(ref);
        }
    });
});
