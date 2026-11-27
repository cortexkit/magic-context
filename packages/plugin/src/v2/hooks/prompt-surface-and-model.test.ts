import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    ACTIVE_TOOL_IDS,
    createPromptSurfaceRuntime,
    LIGHT_TOOL_DESCRIPTIONS,
} from "../../shared/prompt-surface-runtime";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { applyV2PromptSurfaceTools, catalogModels, createHostSeams } from "./context";
import type { SessionContext, V2Context } from "./types";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function draft(modelID: string): SessionContext {
    return {
        sessionID: "ses-v2-surface",
        model: { providerID: "openai", id: modelID },
        agent: "build",
        messages: [],
        system: [],
        tools: Object.fromEntries(
            ACTIVE_TOOL_IDS.map((id) => [
                id,
                { description: `full-${id}`, input: { type: "object" } },
            ]),
        ),
        options: {},
    };
}

describe("v2 per-model tool surface", () => {
    it("is byte-identical across three same-model passes and follows a model switch", () => {
        const runtime = createPromptSurfaceRuntime({
            // Registered, so the test preload removes it when the suite ends.
            userConfigDirectory: createTestTempDir("mc-v2-surface-").dir,
            warn: () => undefined,
        });
        const config = {
            default: "full" as const,
            models: { "openai/mock-light": "light" as const },
        };
        const first = draft("mock-model");
        applyV2PromptSurfaceTools(first, runtime, config);
        const hashes = [sha(first.tools)];
        for (let pass = 0; pass < 2; pass++) {
            const next = draft("mock-model");
            applyV2PromptSurfaceTools(next, runtime, config);
            hashes.push(sha(next.tools));
            expect(next.tools.ctx_search?.input).toEqual({ type: "object" });
        }
        expect(new Set(hashes).size).toBe(1);
        expect(first.tools.ctx_search?.description).toBe("full-ctx_search");

        const switched = draft("mock-light");
        applyV2PromptSurfaceTools(switched, runtime, config);
        expect(sha(switched.tools)).not.toBe(hashes[0]);
        expect(switched.tools.ctx_search?.description).toBe(LIGHT_TOOL_DESCRIPTIONS.ctx_search);
        expect(switched.tools.ctx_reduce?.description).toBe(LIGHT_TOOL_DESCRIPTIONS.ctx_reduce);
        expect(switched.tools.ctx_search?.input).toEqual({ type: "object" });
    });
});

describe("v2 draft-authoritative model tracking", () => {
    it("hostModelFallback follows the draft map with no message.updated event", () => {
        const read = Object.assign(() => [], {
            readPage: () => [],
            getCount: () => 0,
        });
        const draftModels = new Map<string, { providerID: string; modelID: string }>();
        const seams = createHostSeams({} as V2Context, read, read, draftModels);
        expect(seams.hostModelFallback("ses-1")).toBeNull();
        draftModels.set("ses-1", { providerID: "openai", modelID: "mock-model" });
        expect(seams.hostModelFallback("ses-1")).toEqual({
            providerID: "openai",
            modelID: "mock-model",
        });
        draftModels.set("ses-1", { providerID: "openai", modelID: "mock-light" });
        expect(seams.hostModelFallback("ses-1")).toEqual({
            providerID: "openai",
            modelID: "mock-light",
        });
    });
});

describe("catalogModels", () => {
    const mock = {
        id: "mock-model",
        providerID: "openai",
        limit: { context: 16000 },
    };

    it("reads a raw array", () => {
        expect(catalogModels([mock])).toEqual([mock]);
    });

    it("reads a { data } payload", () => {
        expect(catalogModels({ data: [mock] })).toEqual([mock]);
    });

    it("lets the outgoing draft override a stale catalog limit", () => {
        expect(
            catalogModels(
                { data: [mock] },
                {
                    providerID: "openai",
                    id: "mock-model",
                    limit: { context: 1_048_576, output: 32_000 },
                },
            ),
        ).toEqual([
            {
                id: "mock-model",
                providerID: "openai",
                limit: { context: 1_048_576, output: 32_000 },
            },
        ]);
    });

    it("does not iterate a thenable or empty object", () => {
        expect(catalogModels({})).toEqual([]);
        expect(catalogModels(Promise.resolve([mock]))).toEqual([]);
    });
});

// The v2 context hook edits the request draft only. A `context.tool.transform`
// call from inside the hook would register a persistent host-state transform on
// every pass (eight after seven passes in the issue 492 reproduction) and let a
// light-preset session's shortened descriptions become the baseline for every
// later request on the host. This pins the call out of the hook body; the only
// permitted registration is the one-time setup in tools.ts.
describe("v2 context hook never registers a persistent tool transform", () => {
    it("has no context.tool.transform call in the context pass or its registration", () => {
        const source = readFileSync(join(import.meta.dir, "context.ts"), "utf8");
        // Include the named body as well as its scope wrapper; registration alone
        // no longer contains the actual context-pass operations.
        const bodyStart = source.indexOf("const runManagedContext =");
        const hookStart = source.indexOf('context.session.hook("context"', bodyStart);
        expect(bodyStart).toBeGreaterThan(0);
        expect(hookStart).toBeGreaterThan(bodyStart);
        expect(source.slice(hookStart)).toMatch(/await runManagedContext\(draft\b/);
        const hookBody = source.slice(bodyStart);
        expect(hookBody).not.toContain("context.tool.transform(");
        expect(hookBody).toMatch(/applyV2PromptSurfaceTools\(\s*draft/);
    });
});
