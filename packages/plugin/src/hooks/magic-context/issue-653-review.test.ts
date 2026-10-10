import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { openDatabase } from "../../features/magic-context/storage-db";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import { clearPersistedLkgSlot, loadPersistedLkgSlot, saveLkgSlotToDb } from "./lkg-persist";
import { captureLkgSlot, replayLkg } from "./lkg-replay";
import {
    getSlot,
    isLegacyLkgDigest,
    lkgContentDigest,
    registerLkgPersistence,
    resetLkgSlotsForTest,
} from "./lkg-slot";
import {
    opencode1SyntheticAttachmentPrompt,
    opencode1ToModelMessages,
} from "./opencode1-to-model-messages.fixture";
import { providerVisibleMessage } from "./provider-visible-parts";
import { estimateTokens } from "./read-session-formatting";
import { STORAGE_BUSY_MESSAGE } from "./storage-busy-refusal";
import type { MessageLike } from "./transform-operations";

// Reproduce the pre-upgrade digest: walk arrays in order and object keys in
// insertion order, emit typed scalar/container markers, then SHA-256 the UTF-8
// text `<type>:<length>:<value>\0` for every token. This matches lkg-slot.ts at
// 2a40c58e. Calling today's projection or encoder would instead manufacture a
// new-format slot and hide whether an actual old durable slot can replay.
function legacyDigest(value: unknown): string {
    let key = "";
    const field = (value: string | number | boolean | symbol) => {
        const text = typeof value === "symbol" ? (value.description ?? "") : String(value);
        key += `${typeof value}:${text.length}:${text}\0`;
    };
    const tag = (name: string) => field(Symbol(name));
    const visit = (value: unknown): void => {
        if (value === null) tag("null");
        else if (typeof value === "string") {
            tag("string");
            field(value);
        } else if (typeof value === "number") {
            tag("number");
            field(value);
        } else if (typeof value === "boolean") {
            tag("boolean");
            field(value);
        } else if (Array.isArray(value)) {
            tag("array");
            field(value.length);
            for (const item of value) visit(item);
        } else if (value && typeof value === "object") {
            const entries = Object.entries(value).filter(
                ([, child]) =>
                    child !== undefined && typeof child !== "function" && typeof child !== "symbol",
            );
            tag("object");
            field(entries.length);
            for (const [name, child] of entries) {
                tag("key");
                field(name);
                visit(child);
            }
        } else tag("undefined");
    };
    visit(value);
    return createHash("sha256").update(key).digest("base64url");
}

const SESSION = "ses-653-upgrade-review";
function history(): MessageLike[] {
    return [
        {
            info: {
                id: "u1",
                sessionID: SESSION,
                role: "user",
                time: { created: 1 },
                model: { providerID: "test", modelID: "model" },
            } as never,
            parts: [{ type: "text", text: "Fix the TypeScript build." }],
        },
        {
            info: {
                id: "a1",
                sessionID: SESSION,
                role: "assistant",
                time: { created: 2 },
                providerID: "test",
                modelID: "model",
                finish: "tool-calls",
            } as never,
            parts: [
                {
                    type: "tool",
                    callID: "call-edit",
                    tool: "edit",
                    state: {
                        status: "completed",
                        input: { filePath: "/repo/a.ts", oldString: "a", newString: "b" },
                        output: "Edit applied successfully.",
                        time: { start: 2, end: 3 },
                        title: "a.ts",
                        metadata: {
                            diagnostics: {
                                "/repo/a.ts": [{ severity: 1, message: "Cannot find name 'a'." }],
                            },
                        },
                    },
                },
            ],
        },
        {
            info: {
                id: "u2",
                sessionID: SESSION,
                role: "user",
                time: { created: 4 },
                model: { providerID: "test", modelID: "model" },
            } as never,
            parts: [{ type: "text", text: "Run the tests." }],
        },
    ];
}
function served(): MessageLike[] {
    const messages = history();
    (messages[0]!.parts[0] as { text: string }).text = "§1§ Fix the TypeScript build.";
    return messages;
}
function restartFromDurableSlot(format: "legacy" | "current"): void {
    const db = openDatabase()!;
    expect(db).not.toBeNull();
    const input = history();
    const output = served();
    if (format === "legacy") {
        expect(
            saveLkgSlotToDb(db, SESSION, {
                jsonPrefix: JSON.stringify(output),
                inputIdSeq: input.map((m) => m.info.id!),
                inputContentDigests: input.map(legacyDigest),
                lastInputMessageId: "u2",
                providerKey: "test",
                modelKey: "test/model",
                capturedAt: Date.now(),
            }),
        ).toBe(true);
    } else {
        expect(
            captureLkgSlot({
                sessionId: SESSION,
                input,
                output,
                providerKey: "test",
                modelKey: "test/model",
            }),
        ).toBe(true);
        expect(saveLkgSlotToDb(db, SESSION, getSlot(SESSION)!)).toBe(true);
    }
    resetLkgSlotsForTest();
    registerLkgPersistence({
        load: (id) => loadPersistedLkgSlot(db, id),
        clear: (id) => clearPersistedLkgSlot(db, id),
    });
    expect(getSlot(SESSION)).toBeDefined();
}
function busyHandler(onRefusal?: () => void) {
    return createMessagesTransformHandler({
        onStorageBusyRefusal: async (_id, message) => {
            expect(message).toBe(STORAGE_BUSY_MESSAGE);
            onRefusal?.();
        },
        magicContext: {
            "experimental.chat.messages.transform": async () => {
                throw Object.assign(new Error("lock after acquisition"), { code: "SQLITE_BUSY" });
            },
        },
        rustReplayParticipant: () => null,
    });
}

afterEach(() => {
    const db = openDatabase();
    if (db) clearPersistedLkgSlot(db, SESSION);
    resetLkgSlotsForTest();
});

describe("issue 653 independent upgrade review", () => {
    test("metadata-only updates deliberately change the legacy replay decision", () => {
        const before = history()[1]!;
        const after = structuredClone(before);
        const state = (after.parts[0] as { state: Record<string, unknown> }).state;
        state.metadata = {
            diagnostics: { "/repo/b.ts": [{ severity: 2, message: "New diagnostics." }] },
        };
        expect(legacyDigest(after)).not.toBe(legacyDigest(before));
        expect(lkgContentDigest(after)).toBe(lkgContentDigest(before));
    });

    test("current-format restart partner serves the managed prefix on BUSY", async () => {
        restartFromDurableSlot("current");
        const output = { messages: history() };
        await busyHandler()({}, output as never);
        expect((output.messages[0]!.parts[0] as { text: string }).text).toBe(
            "§1§ Fix the TypeScript build.",
        );
    });

    test("a legacy-format slot that genuinely mismatches is still refused on BUSY", async () => {
        // The input changed after the legacy slot was written: the legacy digest
        // check must reject it (fail closed), exactly as before the upgrade.
        const changed = () => {
            const messages = history();
            (messages[0]!.parts[0] as { text: string }).text = "Fix the JavaScript build.";
            return messages;
        };
        restartFromDurableSlot("legacy");
        expect(
            replayLkg({
                sessionId: SESSION,
                messages: changed(),
                modelKey: "test/model",
                providerKey: "test",
            }),
        ).toEqual({ ok: false, reason: "lkg_content_mismatch" });
        restartFromDurableSlot("legacy");
        let refusals = 0;
        await expect(
            busyHandler(() => refusals++)({}, { messages: changed() } as never),
        ).rejects.toThrow(STORAGE_BUSY_MESSAGE);
        expect(refusals).toBe(1);
        expect(loadPersistedLkgSlot(openDatabase()!, SESSION)).toBeUndefined();
    });

    test("legacy-format upgrade retains managed replay availability on BUSY", async () => {
        restartFromDurableSlot("legacy");
        const output = { messages: history() };
        await busyHandler()({}, output as never);
        expect((output.messages[0]!.parts[0] as { text: string }).text).toBe(
            "§1§ Fix the TypeScript build.",
        );
    });

    test("a healthy post-upgrade pass can replace the legacy slot", async () => {
        restartFromDurableSlot("legacy");
        const output = { messages: history() };
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async (_input, hostOutput) => {
                    const input = structuredClone(hostOutput.messages) as MessageLike[];
                    (hostOutput.messages[0]!.parts[0] as { text: string }).text =
                        "§1§ Fix the TypeScript build.";
                    expect(
                        captureLkgSlot({
                            sessionId: SESSION,
                            input,
                            output: hostOutput.messages as MessageLike[],
                            providerKey: "test",
                            modelKey: "test/model",
                        }),
                    ).toBe(true);
                },
            },
            rustReplayParticipant: () => null,
        });
        await handler({}, output as never);
        // The healthy pass wrote the slot in the current format.
        const upgraded = getSlot(SESSION)!;
        expect(upgraded.inputContentDigests.every((digest) => !isLegacyLkgDigest(digest))).toBe(
            true,
        );
        expect(saveLkgSlotToDb(openDatabase()!, SESSION, upgraded)).toBe(true);
        expect(loadPersistedLkgSlot(openDatabase()!, SESSION)?.inputContentDigests).toEqual(
            upgraded.inputContentDigests,
        );
        expect(
            replayLkg({
                sessionId: SESSION,
                messages: history(),
                modelKey: "test/model",
                providerKey: "test",
            }).ok,
        ).toBe(true);
    });
});

describe("issue 653 upstream conversion proof review", () => {
    // These run OpenCode 1.18.35's MessageV2.toModelMessages, executed from a
    // verbatim, hash-pinned copy of its source (opencode1-to-model-messages.fixture.ts),
    // AI SDK convertToModelMessages step included.
    const png = "data:image/png;base64,iVBORw0KGgo=";
    function mediaHistory(): MessageLike[] {
        const messages = history();
        const state = (messages[1]!.parts[0] as { state: Record<string, unknown> }).state;
        state.attachments = [{ type: "file", mime: "image/png", url: png, filename: "a.png" }];
        return messages;
    }
    const google = {
        providerID: "google",
        id: "gemini-3-pro",
        api: { npm: "@ai-sdk/google", id: "gemini-3-pro" },
    };
    const text = (messages: unknown) => JSON.stringify(messages);

    test("attachment partner: a provider without tool-result media gets the synthetic user message", async () => {
        const compatible = {
            providerID: "local",
            id: "model",
            api: { npm: "@ai-sdk/openai-compatible", id: "model" },
        };
        const input = mediaHistory();
        const converted = await opencode1ToModelMessages(input, compatible);
        expect(text(converted)).toContain(opencode1SyntheticAttachmentPrompt());
        expect(opencode1SyntheticAttachmentPrompt()).toBe("Attached media from tool result:");
        expect(
            await opencode1ToModelMessages(input.map(providerVisibleMessage), compatible),
        ).toEqual(converted);
    });

    // OpenCode 1.18.35 keeps Gemini 3 image attachments inside tool output
    // rather than extracting them into a synthetic user message (message-v2.ts:
    // 137-163); providerVisibleMessage keeps the attachment unchanged.
    test("OC1 conversion keeps Gemini 3 attachments inside tool results", async () => {
        const input = mediaHistory();
        const converted = await opencode1ToModelMessages(input, google);
        expect(text(converted)).not.toContain(opencode1SyntheticAttachmentPrompt());
        const tool = converted.find((message) => message.role === "tool");
        expect(text(tool)).toContain("iVBORw0KGgo=");
        expect(await opencode1ToModelMessages(input.map(providerVisibleMessage), google)).toEqual(
            converted,
        );
    });

    test("aborted-assistant partner: an aborted assistant with only reasoning is skipped", async () => {
        const input = history();
        (input[1]!.info as Record<string, unknown>).error = {
            name: "MessageAbortedError",
            data: { message: "aborted" },
        };
        input[1]!.parts = [{ type: "step-start" }, { type: "reasoning", text: "thinking" }];
        const model = {
            providerID: "test",
            id: "model",
            api: { npm: "@ai-sdk/anthropic", id: "model" },
        };
        const converted = await opencode1ToModelMessages(input, model);
        expect(converted.map((message) => message.role)).toEqual(["user", "user"]);
    });

    // OpenCode 1.18.35 keeps an aborted assistant's text and tool output in the
    // request (message-v2.ts:258-266).
    test("OC1 conversion retains tool output from an aborted assistant", async () => {
        const input = history();
        (input[1]!.info as Record<string, unknown>).error = {
            name: "MessageAbortedError",
            data: { message: "aborted" },
        };
        const model = {
            providerID: "test",
            id: "model",
            api: { npm: "@ai-sdk/anthropic", id: "model" },
        };
        const converted = await opencode1ToModelMessages(input, model);
        expect(converted.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "tool",
            "user",
        ]);
        expect(text(converted)).toContain("Edit applied successfully.");
        expect(await opencode1ToModelMessages(input.map(providerVisibleMessage), model)).toEqual(
            converted,
        );
    });
});

const require = createRequire(import.meta.url);
const tokenizerModule = require("ai-tokenizer");
const Tokenizer = tokenizerModule.default ?? tokenizerModule.Tokenizer;
const library = new Tokenizer(require("ai-tokenizer/encoding/claude"));

test("pressure text counts retain the pre-upgrade whole-text tokenizer result", () => {
    const texts = [
        "Edit applied successfully.\nLSP diagnostics: Cannot find name 'foo'.\n".repeat(150),
        "日本語 😀 signature café <EOT>\n".repeat(200),
        "aZxyPQR".repeat(800),
        " ".repeat(4096),
        `data:image/png;base64,${Buffer.from("image bytes αβ 😀".repeat(500)).toString("base64")}`,
    ];
    for (const text of texts) expect(estimateTokens(text)).toBe(library.encode(text, "all").length);
});
