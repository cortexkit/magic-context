import { expect, it } from "bun:test";
import golden from "../../../../../crates/mc-module/testdata/processed-image-trim.json";
import { stripProcessedImages } from "./strip-content";
import type { MessageLike } from "./tag-messages";

it("processed images match Rust's dropped-watermark golden, independent of reasoning retention", () => {
    for (const scenario of golden.cases) {
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
            selected: scenario.selected,
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
            after: scenario.removed_after,
        });
    }
});
