import { expect, test } from "bun:test";
import zenModels from "../../test-fixtures/runtime/historian-zen-models.json";
import {
    needsBlockedRead,
    rememberV1HiddenRun,
    shapeV1HiddenMessage,
    withBlockedReadInstruction,
} from "./hidden-zen-read";

test("historian Zen model eligibility matches the Rust shared fixture", () => {
    for (const { model, blockedRead } of zenModels) {
        expect(needsBlockedRead("historian", model.split("/")[0])).toBe(blockedRead);
    }
});

for (const [agent, task, sentence] of [
    [
        "historian",
        "initial",
        "Summarize only the supplied conversation and memory context. Do not call tools.",
    ],
    [
        "historian-recomp",
        "repair",
        "Summarize only the supplied conversation and memory context. Do not call tools.",
    ],
    [
        "historian-editor",
        "fallback",
        "Summarize only the supplied conversation and memory context. Do not call tools.",
    ],
    [
        "dreamer-classifier",
        "classify-memories",
        "Classify only the supplied memory context. Do not call tools.",
    ],
    [
        "dreamer-classifier",
        "compress-cues",
        "Compress only the supplied memory cues. Do not call tools.",
    ],
    [
        "smart-note-compiler",
        "compile",
        "Compile only the supplied conditions and memory context. Do not call tools.",
    ],
    [
        "dreamer-reviewer",
        "review-user-memories",
        "Review only the supplied observations and memory context. Do not call tools.",
    ],
]) {
    test(`Zen compatibility is provider-scoped and prompt-guided for ${agent}/${task}`, () => {
        expect(needsBlockedRead(agent!, "opencode")).toBe(true);
        for (const provider of ["anthropic", "openai", "opencode-zen", undefined])
            expect(needsBlockedRead(agent!, provider)).toBe(false);
        expect(
            withBlockedReadInstruction("original prompt\n", { agent: agent!, metadata: { task } }),
        ).toBe(`original prompt\n\n\n${sentence}`);
        expect(withBlockedReadInstruction(sentence!, { agent: agent!, metadata: { task } })).toBe(
            sentence!,
        );
    });
}

test("genuine-tool agents and user agents never receive the compatibility read", () => {
    for (const agent of [
        "dreamer",
        "dreamer-docs",
        "dreamer-memory-mapper",
        "dreamer-primer-investigator",
        "dreamer-retrospective",
        "build",
        "custom",
    ])
        expect(needsBlockedRead(agent, "opencode")).toBe(false);
});

test("v1 uses the host-resolved default model only on a registered hidden session", () => {
    const message = { agent: "historian", model: { providerID: "opencode" }, system: "original" };
    shapeV1HiddenMessage("user", message);
    expect(message).toEqual({
        agent: "historian",
        model: { providerID: "opencode" },
        system: "original",
    });
    rememberV1HiddenRun("child", {
        agent: "historian",
        kind: "historian",
        system: "original",
        title: "test",
        directory: "/project",
        timeoutMs: 1000,
    });
    try {
        shapeV1HiddenMessage("child", message);
        expect(message.agent).toBe("historian-zen-blocked-read");
        expect(message.system).toBe(
            "original\n\nSummarize only the supplied conversation and memory context. Do not call tools.",
        );
        shapeV1HiddenMessage("child", message);
        expect(message.system.match(/Do not call tools\./g)).toHaveLength(1);
    } finally {
        rememberV1HiddenRun("child", undefined);
    }
});
