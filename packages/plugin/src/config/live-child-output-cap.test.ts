import { expect, test } from "bun:test";
import type { HiddenCompletionExecutor } from "../hooks/magic-context/compartment-runner-types";

import { producerInputTokenLimit } from "../hooks/magic-context/producer-window-guard";
import {
    createDreamerOutputCapSampler,
    rememberHistorianOutputCap,
    withLiveDreamerOutputCap,
} from "./live-child-output-cap";
import { MagicContextConfigSchema } from "./schema/magic-context";

test("OpenCode 1 dreamer keeps its run cap while the next child receives the live cap", () => {
    const boot = MagicContextConfigSchema.parse({ dreamer: { maxTokens: 2048 } });
    let current = MagicContextConfigSchema.parse({ dreamer: { maxTokens: 4096 } });
    const sampler = createDreamerOutputCapSampler(boot, () => current);
    const output = { maxOutputTokens: undefined as number | undefined };
    sampler.apply({ sessionID: "child-a", agent: "dreamer-classifier" }, output);
    expect(output.maxOutputTokens).toBe(4096);
    current = MagicContextConfigSchema.parse({ dreamer: { maxTokens: 8192 } });
    sampler.apply({ sessionID: "child-a", agent: "dreamer-classifier" }, output);
    expect(output.maxOutputTokens).toBe(4096);
    sampler.apply({ sessionID: "child-b", agent: "dreamer-classifier" }, output);
    expect(output.maxOutputTokens).toBe(8192);
    sampler.apply({ sessionID: "user", agent: "assistant" }, output);
    expect(output.maxOutputTokens).toBe(8192);
});

test("OpenCode 2 dreamer passes a fresh output cap to each hidden child", async () => {
    const boot = MagicContextConfigSchema.parse({ dreamer: { maxTokens: 2048 } });
    let current = MagicContextConfigSchema.parse({ dreamer: { maxTokens: 4096 } });
    const received: Array<number | undefined> = [];
    const executor = withLiveDreamerOutputCap(
        {
            capabilities: { tools: true, harness: "opencode" },
            open: async (run: { maxOutputTokens?: number }) => {
                received.push(run.maxOutputTokens);
                return { id: `child-${received.length}` };
            },
        } as never,
        boot,
        () => current,
    );
    const run = {
        agent: "dreamer-classifier",
        kind: "dreamer-task" as const,
        system: "",
        timeoutMs: 10,
        title: "dream",
        directory: "/project",
    };
    await executor.open(run);
    current = MagicContextConfigSchema.parse({ dreamer: { maxTokens: 8192 } });
    await executor.open(run);
    expect(received).toEqual([4096, 8192]);
});

test("OpenCode 2 dreamer output-cap wrapper forwards partial output reads", async () => {
    const boot = MagicContextConfigSchema.parse({});
    const reads: Array<{ id: string; limit: number }> = [];
    const executor: HiddenCompletionExecutor = {
        capabilities: { tools: true, harness: "opencode2" },
        open: async () => ({ id: "child" }),
        attempt: async () => {},
        collect: async () => {
            throw new Error("no settled completion");
        },
        collectPartial: async (handle, limit) => {
            reads.push({ id: handle.id, limit });
            return {
                text: "unfinished manifest",
                usage: { input: 101, output: 11, cacheRead: 7, cacheWrite: 5 },
                lengthCapped: false,
            };
        },
        close: async () => {},
    };
    const wrapped = withLiveDreamerOutputCap(executor, boot, () => boot);
    expect((await wrapped.collectPartial?.({ id: "child" }, 200))?.text).toBe(
        "unfinished manifest",
    );
    expect(reads).toEqual([{ id: "child", limit: 200 }]);
});

test("OpenCode 1 historian keeps the sampled reserve and child output cap", () => {
    const boot = MagicContextConfigSchema.parse({ historian: { maxTokens: 2048 } });
    let current = MagicContextConfigSchema.parse({ historian: { maxTokens: 4096 } });
    const sampler = createDreamerOutputCapSampler(boot, () => current);
    const output = { maxOutputTokens: undefined as number | undefined };
    const firstCap = current.historian?.maxTokens;
    rememberHistorianOutputCap("hist-a", firstCap);
    sampler.apply({ sessionID: "hist-a", agent: "historian" }, output);
    expect(output.maxOutputTokens).toBe(4096);
    current = MagicContextConfigSchema.parse({ historian: { maxTokens: 8192 } });
    sampler.apply({ sessionID: "hist-a", agent: "historian" }, output);
    expect(output.maxOutputTokens).toBe(firstCap);
    const secondCap = current.historian?.maxTokens;
    rememberHistorianOutputCap("hist-b", secondCap);
    sampler.apply({ sessionID: "hist-b", agent: "historian" }, output);
    expect(output.maxOutputTokens).toBe(8192);
    expect(producerInputTokenLimit(32_000, secondCap ?? 0)).toBe(23_093);
    sampler.delete("hist-a");
    sampler.delete("hist-b");
});

test("an unset cap leaves the host's own output limit untouched", () => {
    // OpenCode computes maxOutputTokens from the model before chat.params runs.
    // With no historian.maxTokens or dreamer.maxTokens configured, the hook must
    // not overwrite that value with undefined.
    const config = MagicContextConfigSchema.parse({});
    const sampler = createDreamerOutputCapSampler(config, () => config);

    const historianOutput = { maxOutputTokens: 32_000 as number | undefined };
    rememberHistorianOutputCap("hist-unset", config.historian?.maxTokens);
    sampler.apply({ sessionID: "hist-unset", agent: "historian" }, historianOutput);
    expect(historianOutput.maxOutputTokens).toBe(32_000);

    const editorOutput = { maxOutputTokens: 32_000 as number | undefined };
    rememberHistorianOutputCap("editor-unset", undefined);
    sampler.apply({ sessionID: "editor-unset", agent: "historian-editor" }, editorOutput);
    expect(editorOutput.maxOutputTokens).toBe(32_000);

    const dreamerOutput = { maxOutputTokens: 16_000 as number | undefined };
    sampler.apply({ sessionID: "dream-unset", agent: "dreamer-classifier" }, dreamerOutput);
    expect(dreamerOutput.maxOutputTokens).toBe(16_000);

    sampler.delete("hist-unset");
    sampler.delete("editor-unset");
    sampler.delete("dream-unset");
});
