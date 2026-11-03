import { expect, it } from "bun:test";
import golden from "../../../test-fixtures/runtime/processed-image-trim.json";
import { createEditAdmission, isAdmissionUser, thinkingAnchor } from "./edit-admission";
import { stripProcessedImages } from "./strip-content";
import type { MessageLike } from "./tag-messages";

it("processed images preserve dropped-watermark golden cases except superseded age-zero eligibility", () => {
    for (const scenario of golden.cases) {
        // This historical case assigned untagged images age zero. Their next
        // tagged message is 200, so a dropped watermark of 1 must now retain them.
        const changedAgeCase =
            scenario.name === "an untagged answered image retires when a drop watermark exists";
        const messages = scenario.steps.map((step) => ({
            info: { id: step.id, role: step.role },
            parts: step.image
                ? [
                      {
                          type: "file",
                          mime: "image/png",
                          url: `data:image/png;base64,${"x".repeat(300)}`,
                      },
                  ]
                : [{ type: "text", text: "reply" }],
        })) as unknown as MessageLike[];
        const watermark = Math.max(0, ...scenario.dropped_tags);
        const outcome = stripProcessedImages(messages, new Set(scenario.frozen), {
            detect: scenario.detect && watermark > 0,
            watermark,
            messageTagNumbers: new Map(
                messages.map((message, i) => [message, scenario.steps[i].tag]),
            ),
        });
        expect({ name: scenario.name, selected: outcome.newlyStrippedIds }).toEqual({
            name: scenario.name,
            selected: changedAgeCase ? [] : scenario.selected,
        });
        const after = messages
            .filter(
                (message, i) =>
                    scenario.steps[i].image &&
                    !message.parts.some((part) => (part as { type?: string }).type === "file"),
            )
            .map((message) => message.info.id);
        expect({ name: scenario.name, after }).toEqual({
            name: scenario.name,
            after: changedAgeCase ? [] : scenario.removed_after,
        });
    }
});

it("processed image admission holds all parts without freezing an id, admits the tail and releases on a later bust", () => {
    const image = () => ({
        type: "file",
        mime: "image/png",
        url: `data:image/png;base64,${"x".repeat(300)}`,
    });
    const raw: MessageLike[] = [
        {
            info: { id: "old", role: "user" },
            parts: [{ type: "text", text: "screenshot" }, image(), image()],
        },
        { info: { id: "prompt", role: "user" }, parts: [{ type: "text", text: "task" }] },
        {
            info: { id: "boundary", role: "assistant" },
            parts: [{ type: "reasoning", text: "kept", signature: "signed" }],
        },
        { info: { id: "tail", role: "user", synthetic: true }, parts: [image(), image()] },
        { info: { id: "reply", role: "assistant" }, parts: [{ type: "text", text: "processed" }] },
    ];
    const frozen = new Set<string>();
    const frozenMarkers = new Map<string, "" | "[image stripped]">();
    const applied: string[] = [];
    const pass = (detect: boolean, enabled = true) => {
        const messages = structuredClone(raw);
        const admission = createEditAdmission({
            messages,
            stableId: (m) => m.info.id,
            partsOf: (m) => m.parts,
            isRealUser: isAdmissionUser,
            prefixBound: true,
            isRetainedThinking: (_m, p) => (p as { type?: string }).type === "reasoning",
            anchorOf: thinkingAnchor,
        });
        const coords: string[] = [];
        const result = stripProcessedImages(messages, frozen, {
            detect,
            watermark: 5,
            messageTagNumbers: new Map(messages.map((message) => [message, 1])),
            frozenMarkers,
            persistNewIds: (_ids, markers) => {
                for (const [id, marker] of markers) frozenMarkers.set(id, marker);
                return true;
            },
            admitFirstApplication: enabled
                ? (m, block) => {
                      coords.push(`${m.info.id}:${block}`);
                      return admission.admit({ kind: "message", id: m.info.id, block });
                  }
                : undefined,
            onFirstApplication: (m, block) => {
                applied.push(`${m.info.id}:${block}`);
            },
        });
        for (const id of result.newlyStrippedIds) frozen.add(id);
        return { messages, result, coords };
    };
    const held = pass(true);
    expect(held.coords).toEqual(["tail:0", "old:1"]);
    expect(held.result).toEqual({ stripped: 2, newlyStrippedIds: ["tail"] });
    expect(held.messages[0]).toEqual(raw[0]);
    expect(frozen.has("old")).toBe(false);
    expect(applied).toEqual(["tail:0", "tail:1"]);
    const repeat = pass(false);
    expect(repeat.coords).toEqual([]);
    expect(repeat.messages).toEqual(held.messages);
    expect(pass(true).messages).toEqual(held.messages);
    const disabled = pass(true, false);
    expect(disabled.result.newlyStrippedIds).toEqual(["old"]);
    expect(disabled.coords).toEqual([]);
    frozen.delete("old");
    raw.push({ info: { id: "next", role: "user" }, parts: [{ type: "text", text: "next task" }] });
    expect(pass(false).result.newlyStrippedIds).toEqual([]);
    const release = pass(true);
    expect(release.result.newlyStrippedIds).toEqual(["old"]);
    expect(pass(false).messages).toEqual(release.messages);
});

it("processed image admission precedes persistence and a refused commit leaves bytes intact", () => {
    for (const commit of [false, true]) {
        const image = () => ({
            type: "file",
            mime: "image/png",
            url: `data:image/png;base64,${"x".repeat(300)}`,
        });
        const messages = [
            { info: { id: "old", role: "user" }, parts: [image()] },
            { info: { id: "tail", role: "user" }, parts: [image()] },
            { info: { id: "reply", role: "assistant" }, parts: [{ type: "text", text: "done" }] },
        ] as unknown as MessageLike[];
        const before = structuredClone(messages);
        const events: string[] = [];
        const result = stripProcessedImages(messages, new Set(), {
            detect: true,
            watermark: 2,
            messageTagNumbers: new Map(messages.map((message) => [message, 1])),
            admitFirstApplication: (message) => {
                events.push(`admit:${message.info.id}`);
                return message.info.id === "tail";
            },
            persistNewIds: (ids) => {
                events.push(`persist:${ids.join(",")}`);
                expect(messages).toEqual(before);
                expect(ids).toEqual(["tail"]);
                return commit;
            },
            onFirstApplication: (message) => events.push(`apply:${message.info.id}`),
        });
        expect(events).toEqual([
            "admit:tail",
            "admit:old",
            "persist:tail",
            ...(commit ? ["apply:tail"] : []),
        ]);
        expect(messages[0]).toEqual(before[0]);
        expect(result).toEqual({
            stripped: commit ? 1 : 0,
            newlyStrippedIds: commit ? ["tail"] : [],
        });
        if (!commit) expect(messages).toEqual(before);
    }
});
