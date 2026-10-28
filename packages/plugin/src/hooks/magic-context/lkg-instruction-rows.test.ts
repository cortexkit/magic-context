import { expect, test } from "bun:test";
import { markCoveredInstructionRow } from "./host-served-rows";
import {
    lkgRecoveryEntryUnproven,
    noteLkgHealthyPrefix,
    noteLkgRecoveryPrefix,
    readLkgRecoveryPrefix,
} from "./lkg-recovery-prefix";
import { buildLkgPrefix, captureLkgSlot, projectLkgEntry, replayLkg } from "./lkg-replay";
import { getSlot, noteEntry, resetLkgSlotsForTest } from "./lkg-slot";
import type { MessageLike } from "./transform-operations";

const user = (id: string): MessageLike => ({
    info: {
        id,
        role: "user",
        model: { providerID: "test", modelID: "model" },
    } as MessageLike["info"],
    parts: [{ type: "text", text: id }],
});
const system = (text: string): MessageLike => ({
    info: { role: "system" } as MessageLike["info"],
    parts: [{ type: "text", text }],
});
const update =
    'The context under "k" changed and supersedes the previous value:\n<context key="k">\nv2\n</context>';
const removal = 'The context under "k" no longer applies. Disregard it.';

test("LKG instruction rows: repeated notices across the anchor replay once in order", () => {
    resetLkgSlotsForTest();
    const input = [user("u0"), system(update), user("u1"), system(update), system(removal)];
    const output = structuredClone(input);
    (output[0]!.parts[0] as { text: string }).text = "§1§ served user text";
    markCoveredInstructionRow(output[1]!.info);
    expect(
        captureLkgSlot({
            sessionId: "instructions",
            input,
            output,
            modelKey: "test/model",
            providerKey: "test",
        }),
    ).toBe(true);
    const slot = getSlot("instructions")!;
    expect(JSON.parse(slot.jsonPrefix)).toEqual(output.slice(0, 3));
    const replay = replayLkg({
        sessionId: "instructions",
        messages: [...structuredClone(input), user("u2")],
        modelKey: "test/model",
        providerKey: "test",
    });
    expect(replay.ok).toBe(true);
    if (replay.ok)
        expect(JSON.stringify(replay.messages)).toBe(JSON.stringify([...output, user("u2")]));
    const messages = [...structuredClone(input), user("u2")];
    const entry = noteEntry("instructions", messages)!;
    expect(
        noteLkgRecoveryPrefix({
            sessionId: "instructions",
            entry,
            messages: replay.ok ? replay.messages : [],
            modelKey: "test/model",
            providerKey: "test",
        }),
    ).toBe(true);
    expect(lkgRecoveryEntryUnproven("instructions", entry, messages)).toBe(false);
    const projected = projectLkgEntry(messages);
    expect(readLkgRecoveryPrefix("instructions", projected, messages).prefix).toBeDefined();
    noteLkgHealthyPrefix("instructions", projected, replay.ok ? replay.messages : [], false);
    expect(lkgRecoveryEntryUnproven("instructions", entry, messages)).toBe(false);
    expect(input[1]!.info.id).toBeUndefined();
    expect(projectLkgEntry(input)[1]!.id).toBeNull();
});

test("LKG instruction rows: edited, inserted, removed or reordered rows invalidate replay", () => {
    const input = [user("u0"), system(update), system(removal), system(update), user("u1")];
    for (const change of [
        (messages: MessageLike[]) => {
            (messages[1]!.parts[0] as { text: string }).text += " edited";
        },
        (messages: MessageLike[]) => {
            messages.splice(1, 0, system(update));
        },
        (messages: MessageLike[]) => {
            messages.splice(1, 1);
        },
        (messages: MessageLike[]) => {
            [messages[1], messages[2]] = [messages[2]!, messages[1]!];
        },
    ]) {
        resetLkgSlotsForTest();
        expect(
            captureLkgSlot({
                sessionId: "instructions",
                input,
                output: structuredClone(input),
                modelKey: "test/model",
                providerKey: "test",
            }),
        ).toBe(true);
        const messages = structuredClone(input);
        change(messages);
        expect(
            replayLkg({
                sessionId: "instructions",
                messages,
                modelKey: "test/model",
                providerKey: "test",
            }).ok,
        ).toBe(false);
    }
});

test("LKG instruction rows: complete capture can end on an id-less system row", () => {
    resetLkgSlotsForTest();
    const input = [user("u0"), system(update), system(removal)];
    expect(
        captureLkgSlot({
            sessionId: "instructions",
            input,
            output: input,
            completeOutput: true,
            modelKey: "test/model",
            providerKey: "test",
        }),
    ).toBe(true);
    const replay = replayLkg({
        sessionId: "instructions",
        messages: [...structuredClone(input), user("u1")],
        modelKey: "test/model",
        providerKey: "test",
    });
    expect(replay.ok).toBe(true);
    if (replay.ok)
        expect(JSON.stringify(replay.messages)).toBe(JSON.stringify([...input, user("u1")]));
    // Without all occurrences there is no safe way to tell which duplicate
    // survived on either side of the saved prefix's anchor.
    expect(
        buildLkgPrefix(
            [user("u0"), system(update), user("u1"), system(update)],
            [user("u0"), user("u1"), system(update)],
        ),
    ).toBeNull();
    const restored = system(update);
    markCoveredInstructionRow(restored.info);
    const partialInput = [user("u0"), system(update), user("u1"), system(removal)];
    const partialOutput = [restored, ...structuredClone(partialInput)];
    markCoveredInstructionRow(partialOutput[2]!.info);
    expect(buildLkgPrefix(partialInput, partialOutput)?.jsonPrefix).toBe(
        JSON.stringify(partialOutput.slice(0, 4)),
    );
    expect(buildLkgPrefix([user("u0"), system(update)], [restored, user("u0")])).toBeNull();
});
