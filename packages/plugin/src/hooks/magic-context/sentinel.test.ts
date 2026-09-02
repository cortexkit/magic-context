/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";

import { modelAcceptsEmptyContent, setAnthropicTransportProviders } from "./sentinel";

describe("modelAcceptsEmptyContent", () => {
    afterEach(() => {
        setAnthropicTransportProviders([]);
    });

    it("accepts the canonical anthropic provider regardless of model name", () => {
        expect(modelAcceptsEmptyContent("anthropic")).toBe(true);
        expect(modelAcceptsEmptyContent("anthropic", "claude-opus-4-7")).toBe(true);
        expect(modelAcceptsEmptyContent("anthropic", "some-other-model")).toBe(true);
    });

    it("rejects unconfigured providers even for Claude-named models", () => {
        expect(modelAcceptsEmptyContent("github-copilot")).toBe(false);
        expect(modelAcceptsEmptyContent("github-copilot", "claude-sonnet-4-6")).toBe(false);
        expect(modelAcceptsEmptyContent(undefined, "claude-sonnet-4-6")).toBe(false);
        expect(modelAcceptsEmptyContent("openrouter")).toBe(false);
    });

    it("accepts Claude-named models under a configured Anthropic-transport provider", () => {
        setAnthropicTransportProviders(["github-copilot"]);
        expect(modelAcceptsEmptyContent("github-copilot", "claude-sonnet-4-6")).toBe(true);
        expect(modelAcceptsEmptyContent("github-copilot", "CLAUDE-Opus-5")).toBe(true);
        expect(modelAcceptsEmptyContent("GITHUB-COPILOT", "claude-sonnet-4-6")).toBe(true);
    });

    it("keeps non-Claude models under a configured provider fail-closed", () => {
        // Mixed-adapter providers route non-Claude models through adapters that
        // do NOT filter empty parts; the gate must stay closed for them.
        setAnthropicTransportProviders(["github-copilot"]);
        expect(modelAcceptsEmptyContent("github-copilot", "gpt-5.5")).toBe(false);
        expect(modelAcceptsEmptyContent("github-copilot")).toBe(false);
        expect(modelAcceptsEmptyContent("github-copilot", "")).toBe(false);
    });

    it("normalizes and validates configured provider entries", () => {
        setAnthropicTransportProviders(["  GitHub-Copilot  ", "", "   "]);
        expect(modelAcceptsEmptyContent("github-copilot", "claude-x")).toBe(true);
        expect(modelAcceptsEmptyContent("", "claude-x")).toBe(false);
    });

    it("resets to fail-closed when the allow-list is cleared", () => {
        setAnthropicTransportProviders(["github-copilot"]);
        setAnthropicTransportProviders([]);
        expect(modelAcceptsEmptyContent("github-copilot", "claude-x")).toBe(false);
        setAnthropicTransportProviders(["github-copilot"]);
        setAnthropicTransportProviders(undefined);
        expect(modelAcceptsEmptyContent("github-copilot", "claude-x")).toBe(false);
    });
});
