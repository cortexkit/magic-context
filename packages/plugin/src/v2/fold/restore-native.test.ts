import { expect, test } from "bun:test";
import type { StoreRow } from "../store-reader";
import { restoreRow } from "./restore";

const model = { providerID: "p", id: "m" };
const row = (content: Record<string, unknown>[], error?: unknown): StoreRow<"assistant"> => ({
    id: "a",
    session_id: "s",
    seq: 1,
    type: "assistant",
    data: { model, content, error },
});
const tool = (extra: Record<string, unknown> = {}) => ({
    type: "tool",
    id: "call",
    name: "read",
    state: {
        status: "completed",
        input: { path: "fixture" },
        content: [{ type: "text", text: "result" }],
    },
    ...extra,
});
const parts = (source: StoreRow, target = model) =>
    restoreRow(source, target).flatMap((m) => m.content);

test("raw replay marks stored synthetic rows without marking ordinary user or skill rows", () => {
    const stored = { id: "u", session_id: "s", seq: 1, data: { text: "input" } };
    expect(parts({ ...stored, type: "user" })).toEqual([{ type: "text", text: "input" }]);
    expect(parts({ ...stored, type: "skill" })).toEqual([{ type: "text", text: "input" }]);
    expect(parts({ ...stored, type: "synthetic" })).toEqual([
        { type: "text", text: "input", synthetic: true },
    ]);
});

test("raw replay normalizes native and legacy fields with upstream precedence", () => {
    const source = row([
        {
            type: "text",
            text: "current",
            native: { signature: "new", itemId: "msg_native" },
            state: { signature: "old" },
        },
        {
            type: "reasoning",
            text: "native replay thought",
            native: { signature: "oc21-native-signature" },
        },
        { type: "reasoning", text: "legacy", state: { signature: "legacy" } },
        { type: "text", text: "present undefined", native: undefined, state: { stale: true } },
        tool({
            native: { call: true, collision: "current" },
            providerState: { stale: true },
            providerResultState: { collision: "result", result: true },
        }),
    ]);
    const restored = parts(source);
    expect(restored.map((p) => p.providerMetadata)).toEqual([
        { p: { signature: "new", itemId: "msg_native" } },
        { p: { signature: "oc21-native-signature" } },
        { p: { signature: "legacy" } },
        undefined,
        { p: { call: true, collision: "result", result: true } },
        { p: { call: true, collision: "result", result: true } },
    ]);
    for (const result of [undefined, null, [], "invalid"]) {
        const restored = parts(
            row([tool({ providerState: { call: true }, providerResultState: result })]),
        );
        expect(restored.map((p) => p.providerMetadata)).toEqual([
            { p: { call: true } },
            { p: { call: true } },
        ]);
    }
    const merged = parts(
        row([
            tool({
                providerState: { call: true, nested: { old: true } },
                providerResultState: { nested: { new: true } },
            }),
        ]),
    );
    expect(merged.map((p) => p.providerMetadata)).toEqual([
        { p: { call: true, nested: { new: true } } },
        { p: { call: true, nested: { new: true } } },
    ]);
    expect(source.data.content?.[4]?.state).toEqual(tool().state);
});

test("replay eligibility matches provider model error and hosted-result rules", () => {
    const native = { signature: "proof" };
    for (const target of [
        model,
        { providerID: "p", id: "other" },
        { providerID: "other", id: "m" },
    ]) {
        for (const error of [undefined, { message: "failed step" }]) {
            const reuse = target.providerID === "p" && target.id === "m" && error === undefined;
            const sameModel = target.providerID === "p" && target.id === "m";
            const metadata = { p: native };
            const result = parts(
                row(
                    [
                        { type: "text", text: "answer", state: native },
                        {
                            type: "reasoning",
                            text: "thought",
                            state: native,
                            time: { completed: 1 },
                        },
                        tool({ providerState: native }),
                        tool({ providerState: native, executed: true }),
                    ],
                    error,
                ),
                target,
            );
            expect(result[0]?.providerMetadata).toEqual(reuse ? metadata : undefined);
            expect(result[1]?.providerMetadata).toEqual(reuse ? metadata : undefined);
            expect(result[2]?.providerMetadata).toEqual(reuse ? metadata : undefined);
            expect(result[3]?.providerMetadata).toEqual(sameModel ? metadata : undefined);
            expect(result[4]?.providerMetadata).toEqual(
                target.providerID === "p" ? metadata : undefined,
            );
            expect(result[5]?.providerMetadata).toEqual(reuse ? metadata : undefined);
        }
    }
    const interrupted = parts(
        row([
            { type: "reasoning", text: "partial", native, time: { created: 1 } },
            { type: "reasoning", text: "", native, time: { completed: 2 } },
        ]),
    );
    expect(interrupted).toEqual([{ type: "text", text: "partial", providerMetadata: undefined }]);
    const streaming = parts(
        row([tool({ executed: true, native, state: { status: "streaming", input: "{}" } })], {
            message: "error",
        }),
    );
    expect(streaming[0]?.providerMetadata).toBeUndefined();
});
