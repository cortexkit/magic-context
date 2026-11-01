import "./quiet-live-log";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { computeProtectionWindow } from "../../../packages/plugin/src/features/magic-context/protection-window";
import type { TagEntry } from "../../../packages/plugin/src/features/magic-context/types";
import {
    decideChannel1,
    evaluateChannel2,
} from "../../../packages/plugin/src/hooks/magic-context/ctx-reduce-nudge";
import type { MessageLike } from "../../../packages/plugin/src/hooks/magic-context/tag-messages";
import { measureTailHygiene } from "../../../packages/plugin/src/hooks/magic-context/tail-hygiene-walk";

type TextBlock = { type: "text"; unit: string; repeat: number };
type ReasoningBlock = { type: "reasoning"; unit: string; repeat: number };
type ToolCallBlock = { type: "tool_call"; id: string; name: string; input: unknown };
type ToolResultBlock = {
    type: "tool_result";
    id: string;
    name: string;
    unit: string;
    repeat: number;
};
type FileBlock = { type: "file"; mime: string; url: string };
type Block = TextBlock | ReasoningBlock | ToolCallBlock | ToolResultBlock | FileBlock;
type FixtureMessage = {
    mid: string;
    ordinal: number;
    role: "user" | "assistant";
    synthetic?: boolean;
    blocks: Block[];
};
type FixtureTag = {
    tag_number: number;
    block_id: string;
    kind: "message" | "tool" | "file";
    token_count: number;
};
type Fixture = {
    id: string;
    /** Migration sentinel only. The generated parity contract never reads this count. */
    protected_tags: number;
    protected_tokens_effective: number;
    messages: FixtureMessage[];
    tags: FixtureTag[];
    pending_drop_tag_numbers?: number[];
};

const repeated = (unit: string, repeat: number): string => unit.repeat(repeat);

const fixtures: Fixture[] = [
    {
        id: "live-incident-mixed-tail",
        protected_tags: 0,
        protected_tokens_effective: 16_000,
        messages: [
            { mid: "conversation", ordinal: 1, role: "user", blocks: [{ type: "text", unit: "prose ", repeat: 302_195 }] },
            { mid: "tool-owner", ordinal: 2, role: "assistant", blocks: [{ type: "tool_call", id: "call-live", name: "read", input: { path: "fixture" } }] },
            { mid: "tool-result", ordinal: 3, role: "user", blocks: [{ type: "tool_result", id: "call-live", name: "read", unit: "result ", repeat: 162_000 }] },
        ],
        tags: [
            { tag_number: 0, block_id: "conversation#0", kind: "message", token_count: 302_197 },
            { tag_number: 1, block_id: "tool-result#0", kind: "tool", token_count: 162_006 },
        ],
    },
    {
        id: "queued-tool-arc-full-mass",
        protected_tags: 0,
        protected_tokens_effective: 16_000,
        messages: [
            { mid: "queued-owner", ordinal: 1, role: "assistant", blocks: [{ type: "tool_call", id: "queued-call", name: "read", input: { payload: "queued input has attributed mass" } }] },
            { mid: "queued-result", ordinal: 2, role: "user", blocks: [{ type: "tool_result", id: "queued-call", name: "read", unit: "queued output ", repeat: 4_000 }] },
            { mid: "kept-owner-1", ordinal: 3, role: "assistant", blocks: [{ type: "tool_call", id: "kept-call-1", name: "read", input: { path: "one" } }] },
            { mid: "kept-result-1", ordinal: 4, role: "user", blocks: [{ type: "tool_result", id: "kept-call-1", name: "read", unit: "kept one ", repeat: 2_000 }] },
            { mid: "kept-owner-2", ordinal: 5, role: "assistant", blocks: [{ type: "tool_call", id: "kept-call-2", name: "read", input: { path: "two" } }] },
            { mid: "kept-result-2", ordinal: 6, role: "user", blocks: [{ type: "tool_result", id: "kept-call-2", name: "read", unit: "kept two ", repeat: 2_000 }] },
            { mid: "kept-owner-3", ordinal: 7, role: "assistant", blocks: [{ type: "tool_call", id: "kept-call-3", name: "read", input: { path: "three" } }] },
            { mid: "kept-result-3", ordinal: 8, role: "user", blocks: [{ type: "tool_result", id: "kept-call-3", name: "read", unit: "kept three ", repeat: 2_000 }] },
        ],
        tags: [
            { tag_number: 7, block_id: "queued-result#0", kind: "tool", token_count: 8_000 },
            { tag_number: 8, block_id: "kept-result-1#0", kind: "tool", token_count: 6_000 },
            { tag_number: 9, block_id: "kept-result-2#0", kind: "tool", token_count: 6_000 },
            { tag_number: 10, block_id: "kept-result-3#0", kind: "tool", token_count: 6_000 },
        ],
        pending_drop_tag_numbers: [7],
    },
    {
        id: "protected-recency-reserve",
        protected_tags: 1,
        protected_tokens_effective: 16_000,
        messages: [
            { mid: "old", ordinal: 1, role: "user", blocks: [{ type: "text", unit: "old reclaimable ", repeat: 24_000 }] },
            { mid: "recent-owner", ordinal: 2, role: "assistant", blocks: [{ type: "tool_call", id: "recent-call", name: "read", input: { path: "recent" } }] },
            { mid: "recent-result", ordinal: 3, role: "user", blocks: [{ type: "tool_result", id: "recent-call", name: "read", unit: "recent protected ", repeat: 24_000 }] },
        ],
        tags: [
            { tag_number: 1, block_id: "old#0", kind: "message", token_count: 96_001 },
            { tag_number: 2, block_id: "recent-result#0", kind: "tool", token_count: 48_001 },
        ],
    },
    {
        id: "protected-token-window-spans-more-than-one-tag",
        protected_tags: 1,
        protected_tokens_effective: 16_000,
        messages: [
            { mid: "older-visible", ordinal: 1, role: "user", blocks: [{ type: "text", unit: "visible backlog ", repeat: 20_000 }] },
            { mid: "owner-1", ordinal: 2, role: "assistant", blocks: [{ type: "tool_call", id: "window-1", name: "read", input: { path: "one" } }] },
            { mid: "result-1", ordinal: 3, role: "user", blocks: [{ type: "tool_result", id: "window-1", name: "read", unit: "window one ", repeat: 2_000 }] },
            { mid: "owner-2", ordinal: 4, role: "assistant", blocks: [{ type: "tool_call", id: "window-2", name: "read", input: { path: "two" } }] },
            { mid: "result-2", ordinal: 5, role: "user", blocks: [{ type: "tool_result", id: "window-2", name: "read", unit: "window two ", repeat: 2_000 }] },
            { mid: "owner-3", ordinal: 6, role: "assistant", blocks: [{ type: "tool_call", id: "window-3", name: "read", input: { path: "three" } }] },
            { mid: "result-3", ordinal: 7, role: "user", blocks: [{ type: "tool_result", id: "window-3", name: "read", unit: "window three ", repeat: 2_000 }] },
            { mid: "owner-4", ordinal: 8, role: "assistant", blocks: [{ type: "tool_call", id: "window-4", name: "read", input: { path: "four" } }] },
            { mid: "result-4", ordinal: 9, role: "user", blocks: [{ type: "tool_result", id: "window-4", name: "read", unit: "window four ", repeat: 2_000 }] },
        ],
        tags: [
            { tag_number: 0, block_id: "older-visible#0", kind: "message", token_count: 40_001 },
            { tag_number: 1, block_id: "result-1#0", kind: "tool", token_count: 4_000 },
            { tag_number: 2, block_id: "result-2#0", kind: "tool", token_count: 4_000 },
            { tag_number: 3, block_id: "result-3#0", kind: "tool", token_count: 4_000 },
            { tag_number: 4, block_id: "result-4#0", kind: "tool", token_count: 4_000 },
        ],
    },
    {
        id: "empty-protected-token-window",
        protected_tags: 99,
        protected_tokens_effective: 16_000,
        messages: [
            { mid: "message-only", ordinal: 1, role: "user", blocks: [{ type: "text", unit: "message only ", repeat: 4_000 }] },
        ],
        tags: [
            { tag_number: 1, block_id: "message-only#0", kind: "message", token_count: 8_001 },
        ],
    },
    {
        id: "reasoning-excluded-both-terms",
        protected_tags: 0,
        protected_tokens_effective: 16_000,
        messages: [
            { mid: "visible", ordinal: 1, role: "user", blocks: [{ type: "text", unit: "visible work ", repeat: 30_000 }] },
            { mid: "thinking", ordinal: 2, role: "assistant", blocks: [{ type: "reasoning", unit: "private chain ", repeat: 80_000 }] },
            { mid: "answer", ordinal: 3, role: "assistant", blocks: [{ type: "text", unit: "answer prose ", repeat: 30_000 }] },
        ],
        tags: [
            { tag_number: 1, block_id: "visible#0", kind: "message", token_count: 8_000 },
            { tag_number: 2, block_id: "answer#0", kind: "message", token_count: 8_000 },
        ],
    },
    {
        id: "synthetic-carrier-excluded",
        protected_tags: 0,
        protected_tokens_effective: 16_000,
        messages: [
            { mid: "m0", ordinal: 1, role: "user", synthetic: true, blocks: [{ type: "text", unit: "synthetic memory ", repeat: 100_000 }] },
            { mid: "real", ordinal: 2, role: "user", blocks: [{ type: "text", unit: "small real tail ", repeat: 500 }] },
        ],
        tags: [{ tag_number: 1, block_id: "m0#0", kind: "message", token_count: 8_000 }],
    },
    {
        id: "dropped-tool-arc-excluded",
        protected_tags: 0,
        protected_tokens_effective: 16_000,
        messages: [
            { mid: "owner", ordinal: 1, role: "assistant", blocks: [{ type: "tool_call", id: "call-drop", name: "read", input: { payload: "original-large-input" } }] },
            { mid: "result", ordinal: 2, role: "user", blocks: [{ type: "tool_result", id: "call-drop", name: "read", unit: "[truncated §2§]", repeat: 1 }] },
            { mid: "kept", ordinal: 3, role: "user", blocks: [{ type: "text", unit: "kept prose ", repeat: 2_000 }] },
        ],
        tags: [
            { tag_number: 1, block_id: "result#0", kind: "tool", token_count: 8_000 },
            { tag_number: 2, block_id: "kept#0", kind: "message", token_count: 8_000 },
        ],
    },
    {
        id: "caveman-rendered-not-original-weight",
        protected_tags: 0,
        protected_tokens_effective: 16_000,
        messages: [
            { mid: "caveman", ordinal: 1, role: "assistant", blocks: [{ type: "text", unit: "[caveman depth=2] compacted sentence. ", repeat: 4_000 }] },
            { mid: "untagged-context", ordinal: 2, role: "user", blocks: [{ type: "text", unit: "visible context ", repeat: 2_000 }] },
        ],
        tags: [{ tag_number: 1, block_id: "caveman#0", kind: "message", token_count: 8_000 }],
    },
    {
        id: "channel1-reminder-span-excluded",
        protected_tags: 0,
        protected_tokens_effective: 16_000,
        messages: [
            { mid: "reminder-owner", ordinal: 1, role: "assistant", blocks: [{ type: "tool_call", id: "call-reminder", name: "read", input: { path: "reminder" } }] },
            { mid: "reminder-result", ordinal: 2, role: "user", blocks: [{ type: "tool_result", id: "call-reminder", name: "read", unit: "kept output\n\n<system-reminder>\nreasoning-sized reminder bytes must not count\n</system-reminder>", repeat: 1 }] },
        ],
        tags: [{ tag_number: 1, block_id: "reminder-result#0", kind: "tool", token_count: 8_000 }],
    },
    {
        id: "user-reminder-span-excluded-from-both-terms",
        protected_tags: 0,
        protected_tokens_effective: 16_000,
        messages: [
            {
                mid: "user-reminder",
                ordinal: 1,
                role: "user",
                blocks: [
                    {
                        type: "text",
                        unit: "kept prompt\n\n<system-reminder>\nreminder bytes are excluded on ordinary text\n</system-reminder>",
                        repeat: 1,
                    },
                ],
            },
        ],
        tags: [{ tag_number: 1, block_id: "user-reminder#0", kind: "message", token_count: 8_000 }],
    },
    {
        id: "post-fold-fresh-tail",
        protected_tags: 0,
        protected_tokens_effective: 16_000,
        messages: [
            { mid: "fold-summary", ordinal: 1, role: "user", synthetic: true, blocks: [{ type: "text", unit: "compacted history ", repeat: 100_000 }] },
            { mid: "fresh-tail", ordinal: 2, role: "user", blocks: [{ type: "text", unit: "fresh visible tail ", repeat: 10_000 }] },
        ],
        tags: [{ tag_number: 1, block_id: "fresh-tail#0", kind: "message", token_count: 8_000 }],
    },
    {
        id: "tiny-t-minimum-guard",
        protected_tags: 0,
        protected_tokens_effective: 16_000,
        messages: [
            { mid: "tiny", ordinal: 1, role: "user", blocks: [{ type: "text", unit: "x ", repeat: 59_000 }] },
        ],
        tags: [{ tag_number: 1, block_id: "tiny#0", kind: "message", token_count: 8_000 }],
    },
    {
        id: "image-and-file-total",
        protected_tags: 0,
        protected_tokens_effective: 16_000,
        messages: [
            { mid: "image", ordinal: 1, role: "user", blocks: [{ type: "file", mime: "image/png", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" }] },
            { mid: "file", ordinal: 2, role: "user", blocks: [{ type: "file", mime: "text/plain", url: "file content" }] },
        ],
        tags: [
            { tag_number: 1, block_id: "image#0", kind: "file", token_count: 8_000 },
            { tag_number: 2, block_id: "file#0", kind: "file", token_count: 8_000 },
        ],
    },
    {
        id: "unambiguous-legacy-orphan",
        protected_tags: 0,
        protected_tokens_effective: 16_000,
        messages: [
            { mid: "before", ordinal: 1, role: "user", blocks: [{ type: "text", unit: "before ", repeat: 500 }] },
            { mid: "orphan-owner", ordinal: 2, role: "assistant", blocks: [{ type: "tool_call", id: "legacy-call", name: "read", input: { path: "legacy" } }] },
            { mid: "orphan-result", ordinal: 3, role: "user", blocks: [{ type: "tool_result", id: "legacy-call", name: "read", unit: "legacy output ", repeat: 4_000 }] },
            { mid: "after", ordinal: 4, role: "user", blocks: [{ type: "text", unit: "after ", repeat: 500 }] },
        ],
        tags: [
            { tag_number: 1, block_id: "before#0", kind: "message", token_count: 8_000 },
            { tag_number: 2, block_id: "legacy-call", kind: "tool", token_count: 8_000 },
            { tag_number: 3, block_id: "after#0", kind: "message", token_count: 8_000 },
        ],
    },
    {
        id: "recurring-call-id-ambiguous",
        protected_tags: 0,
        protected_tokens_effective: 16_000,
        messages: [
            { mid: "before", ordinal: 1, role: "user", blocks: [{ type: "text", unit: "before ", repeat: 500 }] },
            { mid: "owner-a", ordinal: 2, role: "assistant", blocks: [{ type: "tool_call", id: "repeat", name: "read", input: { path: "a" } }] },
            { mid: "result-a", ordinal: 3, role: "user", blocks: [{ type: "tool_result", id: "repeat", name: "read", unit: "first output ", repeat: 2_000 }] },
            { mid: "owner-b", ordinal: 4, role: "assistant", blocks: [{ type: "tool_call", id: "repeat", name: "read", input: { path: "b" } }] },
            { mid: "result-b", ordinal: 5, role: "user", blocks: [{ type: "tool_result", id: "repeat", name: "read", unit: "second output ", repeat: 2_000 }] },
            { mid: "after", ordinal: 6, role: "user", blocks: [{ type: "text", unit: "after ", repeat: 500 }] },
        ],
        tags: [
            { tag_number: 1, block_id: "before#0", kind: "message", token_count: 8_000 },
            { tag_number: 2, block_id: "repeat", kind: "tool", token_count: 8_000 },
            { tag_number: 3, block_id: "after#0", kind: "message", token_count: 8_000 },
        ],
    },
];

function toMessages(fixture: Fixture): MessageLike[] {
    return fixture.messages.map((message) => ({
        info: {
            ...(message.synthetic ? {} : { id: message.mid }),
            role: message.role,
        },
        parts: message.blocks.map((block) => {
            switch (block.type) {
                case "text":
                    return { type: "text", text: repeated(block.unit, block.repeat), synthetic: message.synthetic === true };
                case "reasoning":
                    return { type: "thinking", thinking: repeated(block.unit, block.repeat) };
                case "tool_call":
                    return { type: "tool-invocation", callID: block.id, tool: block.name, args: block.input };
                case "tool_result":
                    return { type: "tool_result", tool_use_id: block.id, content: repeated(block.unit, block.repeat) };
                case "file":
                    return { type: "file", mime: block.mime, url: block.url };
            }
            throw new Error("unsupported hygiene fixture block");
        }),
    })) as MessageLike[];
}

function toTags(fixture: Fixture): TagEntry[] {
    const messagesByMid = new Map(fixture.messages.map((message) => [message.mid, message]));
    const ownerByCall = new Map<string, string>();
    for (const message of fixture.messages) {
        for (const block of message.blocks) {
            if (block.type === "tool_call" && !ownerByCall.has(block.id)) ownerByCall.set(block.id, message.mid);
        }
    }
    return fixture.tags.map((tag) => {
        const [mid, rawIndex] = tag.block_id.split("#");
        const index = Number(rawIndex);
        const message = messagesByMid.get(mid ?? "");
        const block = message?.blocks[index];
        const legacyCallId = !message && tag.kind === "tool" ? tag.block_id : null;
        const callId = block?.type === "tool_result" || block?.type === "tool_call" ? block.id : legacyCallId;
        const toolOwnerMessageId = legacyCallId ? null : callId ? ownerByCall.get(callId) ?? null : null;
        const messageId =
            tag.kind === "tool"
                ? callId ?? tag.block_id
                : `${mid}:${tag.kind === "file" ? "file" : "p"}${index}`;
        return {
            tagNumber: tag.tag_number,
            messageId,
            type: tag.kind === "tool" ? "tool" : tag.kind === "file" ? "file" : "message",
            status: "active",
            dropMode: "full",
            toolName: tag.kind === "tool" ? "read" : null,
            inputByteSize: 0,
            byteSize: 1,
            reasoningByteSize: 0,
            sessionId: "module-parity",
            cavemanDepth: 0,
            toolOwnerMessageId,
        } satisfies TagEntry;
    });
}

function band(u: number, t: number): string {
    const baseline = {
        baselineU: u,
        baselineT: t,
        turnDeltaU: 0,
        turnDeltaT: 0,
        evaluable: true,
        generationInvalidated: false,
    };
    if (evaluateChannel2(baseline).shouldTrigger) return "channel2";
    const decision = decideChannel1({
        ...baseline,
        lastNudgeUndropped: 0,
        lastNudgeLevel: "",
        hasRecentReduce: false,
    });
    return decision.fire ? decision.level : "quiet";
}

const cases = fixtures.map((fixture) => {
    // Goldens carry persisted-row mass plus the snapshotted floor. This is the same
    // projection production passes to the hygiene walk; protected_tags stays inert.
    const protectedTagNumbers = computeProtectionWindow(
        fixture.tags,
        fixture.protected_tokens_effective,
    ).tagNumberSet.tagNumbers;
    const measured = measureTailHygiene({
        messages: toMessages(fixture),
        tags: toTags(fixture),
        protectedTagNumbers,
        pendingDropTagNumbers: fixture.pending_drop_tag_numbers
            ? new Set(fixture.pending_drop_tag_numbers)
            : undefined,
    });
    return {
        ...fixture,
        expected: { u: measured.u, t: measured.t, band: band(measured.u, measured.t) },
    };
});
if (cases.length < 12) throw new Error(`nudge hygiene parity corpus has only ${cases.length} fixtures`);
const flagship = cases.find((fixture) => fixture.id === "live-incident-mixed-tail");
if (!flagship) throw new Error("missing flagship live-incident fixture");
const flagshipSeverity = flagship.expected.u / Math.max(flagship.expected.t, 1);
if (flagship.expected.band !== "urgent" || Math.abs(flagshipSeverity - 0.651) > 0.002) {
    throw new Error(
        `flagship positive control drifted: severity=${flagshipSeverity.toFixed(3)} band=${flagship.expected.band}`,
    );
}

const canonical = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const inputSha256 = createHash("sha256").update(canonical(fixtures)).digest("hex");
const golden = {
    schema: 2,
    provenance: {
        generator: "crates/mc-module/gen/gen-nudge-hygiene-golden.ts",
        generator_version: "nudge-hygiene-ts-v3",
        input_sha256: inputSha256,
    },
    cases,
};
const outPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../testdata/nudge-hygiene-golden.json",
);
await writeFile(outPath, canonical(golden));
console.log(`wrote ${outPath} (${cases.length} nudge hygiene cases, input ${inputSha256})`);
