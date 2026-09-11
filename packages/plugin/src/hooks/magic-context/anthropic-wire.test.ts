/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext } from "../../plugin/types";
import {
    anthropicWireRegistryLoaded,
    ensureAnthropicWireModelsLoaded,
    isAnthropicWireModel,
    resetAnthropicWireModelsForTest,
    resolveEmptySentinelCapability,
} from "./anthropic-wire";
import { modelAcceptsEmptyContent } from "./sentinel";
import {
    findMergedReasoningStripDecisions,
    stripReasoningFromMergedAssistants,
} from "./strip-content";
import type { MessageLike } from "./tag-messages";

type ProviderListModel = { id?: string; api?: unknown };

function message(id: string, role: string, parts: unknown[]): MessageLike {
    return { info: { id, role, sessionID: "ses-1" }, parts };
}

function fakeClient(
    all: unknown,
    onCall?: () => void,
): { client: PluginContext["client"]; calls: () => number } {
    let calls = 0;
    const client = {
        provider: {
            list: async () => {
                calls += 1;
                onCall?.();
                return { data: all === undefined ? undefined : { all } };
            },
        },
    };
    return { client: client as unknown as PluginContext["client"], calls: () => calls };
}

function provider(id: string, models: Record<string, ProviderListModel>) {
    return { id, models };
}

const anthropicWire = { npm: "@ai-sdk/anthropic" };

afterEach(() => {
    resetAnthropicWireModelsForTest();
});

describe("anthropic-wire", () => {
    describe("#given a custom provider serving Claude on the Anthropic adapter", () => {
        it("#then reports the model as Anthropic wire under its own provider id", async () => {
            const { client } = fakeClient([
                provider("my_gateway", {
                    "bedrock/claude-opus-5": { id: "bedrock/claude-opus-5", api: anthropicWire },
                }),
            ]);

            await ensureAnthropicWireModelsLoaded(client);

            expect(isAnthropicWireModel("my_gateway", "bedrock/claude-opus-5")).toBe(true);
            expect(modelAcceptsEmptyContent("my_gateway", "bedrock/claude-opus-5")).toBe(true);
        });
    });

    describe("#given one provider that mixes adapters across its models", () => {
        it("#then answers per model rather than per provider", async () => {
            const { client } = fakeClient([
                provider("proxy", {
                    "claude-sonnet-5": { id: "claude-sonnet-5", api: anthropicWire },
                    "gpt-5.5": { id: "gpt-5.5", api: { npm: "@ai-sdk/openai-compatible" } },
                }),
            ]);

            await ensureAnthropicWireModelsLoaded(client);

            expect(isAnthropicWireModel("proxy", "claude-sonnet-5")).toBe(true);
            expect(isAnthropicWireModel("proxy", "gpt-5.5")).toBe(false);
        });
    });

    describe("#given adapters that run their own transforms", () => {
        it("#then excludes Bedrock Converse and Vertex Anthropic", async () => {
            const { client } = fakeClient([
                provider("bedrock", {
                    "claude-opus-5": {
                        id: "claude-opus-5",
                        api: { npm: "@ai-sdk/amazon-bedrock" },
                    },
                }),
                provider("google-vertex-anthropic", {
                    "claude-opus-5": {
                        id: "claude-opus-5",
                        api: { npm: "@ai-sdk/google-vertex/anthropic" },
                    },
                }),
            ]);

            await ensureAnthropicWireModelsLoaded(client);

            expect(isAnthropicWireModel("bedrock", "claude-opus-5")).toBe(false);
            expect(isAnthropicWireModel("google-vertex-anthropic", "claude-opus-5")).toBe(false);
        });
    });

    describe("#given a model keyed differently from its id", () => {
        it("#then matches on either identifier", async () => {
            const { client } = fakeClient([
                provider("gateway", { "record-key": { id: "model-id", api: anthropicWire } }),
            ]);

            await ensureAnthropicWireModelsLoaded(client);

            expect(isAnthropicWireModel("gateway", "record-key")).toBe(true);
            expect(isAnthropicWireModel("gateway", "model-id")).toBe(true);
        });
    });

    describe("#given a lookup that cannot be resolved", () => {
        it("#then fails closed before the registry loads", () => {
            expect(isAnthropicWireModel("my_gateway", "claude-opus-5")).toBe(false);
            expect(modelAcceptsEmptyContent("my_gateway", "claude-opus-5")).toBe(false);
        });

        it("#then fails closed without a model id", async () => {
            const { client } = fakeClient([
                provider("my_gateway", {
                    "claude-opus-5": { id: "claude-opus-5", api: anthropicWire },
                }),
            ]);
            await ensureAnthropicWireModelsLoaded(client);

            expect(isAnthropicWireModel("my_gateway", undefined)).toBe(false);
            expect(modelAcceptsEmptyContent("my_gateway")).toBe(false);
        });

        it("#then fails closed on a malformed response", async () => {
            const { client } = fakeClient(undefined);
            await ensureAnthropicWireModelsLoaded(client);

            expect(isAnthropicWireModel("my_gateway", "claude-opus-5")).toBe(false);
        });

        it("#then fails closed when the lookup throws", async () => {
            const client = {
                provider: {
                    list: async () => {
                        throw new Error("no server");
                    },
                },
            } as unknown as PluginContext["client"];

            await ensureAnthropicWireModelsLoaded(client);

            expect(isAnthropicWireModel("my_gateway", "claude-opus-5")).toBe(false);
        });
    });

    describe("#given canonical Anthropic", () => {
        it("#then keeps its answer without any registry entry", () => {
            expect(modelAcceptsEmptyContent("anthropic")).toBe(true);
            expect(modelAcceptsEmptyContent("anthropic", "claude-opus-5")).toBe(true);
        });
    });

    describe("#given a widened provider across an execute pass then a defer pass", () => {
        // The regression this guards: the capability must resolve identically on
        // every pass of a session. If an execute pass strips merged reasoning and a
        // later defer pass answers differently, the defer pass restores the native
        // reasoning bytes and collapses the cached prefix.
        const buildFixture = () => {
            const newest = message("m-newest", "assistant", [
                { type: "reasoning", text: "newest stays exempt" },
            ]);
            return {
                newest,
                messages: [
                    message("m-u", "user", [{ type: "text", text: "continue" }]),
                    message("m-a1", "assistant", [
                        { type: "reasoning", text: "plan" },
                        { type: "text", text: "first" },
                    ]),
                    message("m-a2", "assistant", [
                        { type: "reasoning", text: "interleaved" },
                        { type: "text", text: "second" },
                    ]),
                    newest,
                ],
            };
        };

        it("#then strips on the execute pass and replays byte-identically on defer", async () => {
            const { client } = fakeClient([
                provider("my_gateway", {
                    "claude-opus-5": { id: "claude-opus-5", api: anthropicWire },
                }),
            ]);
            await ensureAnthropicWireModelsLoaded(client);
            const capability = modelAcceptsEmptyContent("my_gateway", "claude-opus-5");
            expect(capability).toBe(true);

            const executePass = buildFixture();
            const frozen = new Set(
                findMergedReasoningStripDecisions(executePass.messages, capability, new Set(), {
                    mutationExemptMessage: executePass.newest,
                }),
            );
            expect(frozen.size).toBeGreaterThan(0);
            expect(
                stripReasoningFromMergedAssistants(executePass.messages, capability, {
                    frozenMessageIds: frozen,
                    mutationExemptMessage: executePass.newest,
                }),
            ).toBe(1);
            const executeBytes = JSON.stringify(executePass.messages);

            // Defer pass: OpenCode rebuilds the array from its own DB, so replay runs
            // against fresh objects and must detect nothing new.
            const deferPass = buildFixture();
            expect(
                findMergedReasoningStripDecisions(deferPass.messages, capability, frozen, {
                    mutationExemptMessage: deferPass.newest,
                }),
            ).toEqual([]);
            stripReasoningFromMergedAssistants(deferPass.messages, capability, {
                frozenMessageIds: frozen,
                mutationExemptMessage: deferPass.newest,
            });

            expect(JSON.stringify(deferPass.messages)).toBe(executeBytes);
            expect(deferPass.newest.parts[0]).toEqual({
                type: "reasoning",
                text: "newest stays exempt",
            });
        });

        it("#then leaves an unregistered provider's reasoning native on both passes", () => {
            const capability = modelAcceptsEmptyContent("unlisted_gateway", "claude-opus-5");
            expect(capability).toBe(false);

            const executePass = buildFixture();
            const native = JSON.stringify(executePass.messages);
            expect(
                findMergedReasoningStripDecisions(executePass.messages, capability, new Set()),
            ).toEqual([]);
            expect(
                stripReasoningFromMergedAssistants(executePass.messages, capability, {
                    frozenMessageIds: new Set(),
                }),
            ).toBe(0);
            expect(JSON.stringify(executePass.messages)).toBe(native);
        });
    });

    describe("#given a caller that must tell 'not widened' from 'not known yet'", () => {
        // Reading unresolved as `false` would narrow a session that already served
        // widened bytes, which stops replaying persisted merged-reasoning strips and
        // puts the rejected thinking layout back on the wire. Callers therefore ask
        // whether the registry resolved at all.
        it("#then reports unresolved before a successful load and resolved after", async () => {
            expect(anthropicWireRegistryLoaded()).toBe(false);
            const { client } = fakeClient([
                provider("gateway", {
                    "claude-opus-5": { id: "claude-opus-5", api: anthropicWire },
                }),
            ]);

            await ensureAnthropicWireModelsLoaded(client);

            expect(anthropicWireRegistryLoaded()).toBe(true);
        });

        it("#then stays unresolved after a failure, and holds off a retry for the cooldown", async () => {
            let calls = 0;
            const client = {
                provider: {
                    list: async () => {
                        calls += 1;
                        throw new Error("no server");
                    },
                },
            } as unknown as PluginContext["client"];

            await ensureAnthropicWireModelsLoaded(client);
            expect(anthropicWireRegistryLoaded()).toBe(false);
            expect(calls).toBe(1);

            // Not latched forever, but not hammered either: the next attempt waits
            // out the cooldown instead of retrying on every transform pass.
            await ensureAnthropicWireModelsLoaded(client);
            expect(calls).toBe(1);
            expect(anthropicWireRegistryLoaded()).toBe(false);
        });
    });

    describe("#given resolveEmptySentinelCapability", () => {
        const GATEWAY = { providerID: "my_gateway", modelID: "claude-opus-5" };
        const GATEWAY_KEY = "my_gateway/claude-opus-5";

        async function loadGateway() {
            const { client } = fakeClient([
                provider("my_gateway", {
                    "claude-opus-5": { id: "claude-opus-5", api: anthropicWire },
                }),
            ]);
            await ensureAnthropicWireModelsLoaded(client);
        }

        it("#then reports widened for a registry-resolved custom provider", async () => {
            await loadGateway();
            expect(
                resolveEmptySentinelCapability({
                    ...GATEWAY,
                    modelKey: GATEWAY_KEY,
                    cachedModelKey: null,
                    cachedWidenedByCustomProvider: false,
                }),
            ).toEqual({ acceptsEmptySentinels: true, widenedByCustomProvider: true });
        });

        it("#then keeps canonical Anthropic out of the widened flag", async () => {
            await loadGateway();
            expect(
                resolveEmptySentinelCapability({
                    providerID: "anthropic",
                    modelID: "claude-opus-5",
                    modelKey: "anthropic/claude-opus-5",
                    cachedModelKey: null,
                    cachedWidenedByCustomProvider: false,
                }),
            ).toEqual({ acceptsEmptySentinels: true, widenedByCustomProvider: false });
        });

        it("#then reports neither for a resolved non-Anthropic model", async () => {
            await loadGateway();
            expect(
                resolveEmptySentinelCapability({
                    providerID: "openai",
                    modelID: "gpt-6",
                    modelKey: "openai/gpt-6",
                    cachedModelKey: null,
                    cachedWidenedByCustomProvider: false,
                }),
            ).toEqual({ acceptsEmptySentinels: false, widenedByCustomProvider: false });
        });

        it("#then carries a widened session forward while the registry is unresolved", () => {
            // The dangerous direction: narrowing here would stop replaying strips this
            // session already persisted and put signed thinking back on the wire.
            expect(anthropicWireRegistryLoaded()).toBe(false);
            expect(
                resolveEmptySentinelCapability({
                    ...GATEWAY,
                    modelKey: GATEWAY_KEY,
                    cachedModelKey: GATEWAY_KEY,
                    cachedWidenedByCustomProvider: true,
                }),
            ).toEqual({ acceptsEmptySentinels: true, widenedByCustomProvider: true });
        });

        it("#then refuses to carry a widened answer onto a different model", () => {
            // Gateway → Kimi with an unresolved registry. Carrying the session's
            // answer here would put empty parts on a wire that forwards them as
            // real content (issue #135).
            expect(
                resolveEmptySentinelCapability({
                    providerID: "moonshot",
                    modelID: "kimi-k2",
                    modelKey: "moonshot/kimi-k2",
                    cachedModelKey: GATEWAY_KEY,
                    cachedWidenedByCustomProvider: true,
                }),
            ).toEqual({ acceptsEmptySentinels: false, widenedByCustomProvider: false });
        });

        it("#then claims nothing when no model is observable", () => {
            expect(
                resolveEmptySentinelCapability({
                    modelKey: "",
                    cachedModelKey: GATEWAY_KEY,
                    cachedWidenedByCustomProvider: true,
                }),
            ).toEqual({ acceptsEmptySentinels: false, widenedByCustomProvider: false });
        });

        it("#then still serves canonical Anthropic with no registry and no cache", () => {
            expect(
                resolveEmptySentinelCapability({
                    providerID: "anthropic",
                    modelKey: "",
                    cachedModelKey: null,
                    cachedWidenedByCustomProvider: false,
                }),
            ).toEqual({ acceptsEmptySentinels: true, widenedByCustomProvider: false });
        });
    });

    describe("#given repeated and concurrent load requests", () => {
        it("#then reads the provider list exactly once per process", async () => {
            const { client, calls } = fakeClient([
                provider("gateway", {
                    "claude-opus-5": { id: "claude-opus-5", api: anthropicWire },
                }),
            ]);

            await Promise.all([
                ensureAnthropicWireModelsLoaded(client),
                ensureAnthropicWireModelsLoaded(client),
            ]);
            await ensureAnthropicWireModelsLoaded(client);

            expect(calls()).toBe(1);
            expect(isAnthropicWireModel("gateway", "claude-opus-5")).toBe(true);
        });

        it("#then does not memoize the no-client case", async () => {
            await ensureAnthropicWireModelsLoaded(undefined);
            const { client, calls } = fakeClient([
                provider("gateway", {
                    "claude-opus-5": { id: "claude-opus-5", api: anthropicWire },
                }),
            ]);

            await ensureAnthropicWireModelsLoaded(client);

            expect(calls()).toBe(1);
            expect(isAnthropicWireModel("gateway", "claude-opus-5")).toBe(true);
        });
    });
});
