import { expect, test } from "bun:test";
import { releaseRecoveryPrefix, snapshotRecoveryMessages } from "./release-recovery-prefix";
import { stripStructuralNoise } from "./strip-structural-noise";
import type { MessageLike } from "./tag-messages";

test("a conversation-only recovery release preserves frozen bytes before its own first edit", () => {
    const message = (id: string, text: string): MessageLike => ({
        info: { id, role: "assistant" },
        parts: [{ type: "text", text }],
    });
    const frozen = [
        message("earlier", "untagged reply\n\n<frozen-note>keep me</frozen-note>"),
        message("edited", "§5§ obsolete result"),
        message("later", "untagged later reply"),
    ];
    const after = [
        message("earlier", "untagged reply"),
        message("edited", "§5§ obsolete result"),
        message("later", "untagged later reply"),
    ];
    after[0].parts.unshift({ type: "step-start" });
    stripStructuralNoise(after);
    const before = snapshotRecoveryMessages(after);
    after[0].parts.shift();
    after[0].info.time = { created: 999 };
    after[1].parts = [{ type: "text", text: "[dropped §5§]" }];
    const released = releaseRecoveryPrefix({ frozen, before, after });
    expect(JSON.stringify(released.slice(0, 1))).toBe(JSON.stringify(frozen.slice(0, 1)));
    expect(released[1].parts).toEqual([{ type: "text", text: "[dropped §5§]" }]);
    expect(released[2]).toBe(frozen[2]);
    expect(JSON.stringify(releaseRecoveryPrefix({ frozen: released, before, after }))).toBe(
        JSON.stringify(released),
    );
});
