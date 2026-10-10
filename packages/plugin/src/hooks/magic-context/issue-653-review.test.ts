import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { openDatabase } from "../../features/magic-context/storage-db";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import { clearPersistedLkgSlot, loadPersistedLkgSlot, saveLkgSlotToDb } from "./lkg-persist";
import { captureLkgSlot, replayLkg } from "./lkg-replay";
import {
    getSlot,
    lkgContentDigest,
    registerLkgPersistence,
    resetLkgSlotsForTest,
} from "./lkg-slot";
import { opencode1UiMessages } from "./opencode1-to-model-messages.fixture";
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

    test("legacy-format restart diagnoses content mismatch and the exact BUSY refusal", async () => {
        restartFromDurableSlot("legacy");
        expect(
            replayLkg({
                sessionId: SESSION,
                messages: history(),
                modelKey: "test/model",
                providerKey: "test",
            }),
        ).toEqual({ ok: false, reason: "lkg_content_mismatch" });
        restartFromDurableSlot("legacy");
        let refusals = 0;
        await expect(
            busyHandler(() => refusals++)({}, { messages: history() } as never),
        ).rejects.toThrow(STORAGE_BUSY_MESSAGE);
        expect(refusals).toBe(1);
        expect(loadPersistedLkgSlot(openDatabase()!, SESSION)).toBeUndefined();
    });

    test.failing("legacy-format upgrade should retain managed replay availability on BUSY", async () => {
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

    test("Google attachment fixture partner exposes its synthetic-user routing", () => {
        const input = mediaHistory();
        const converted = opencode1UiMessages(input, google);
        expect(converted).toHaveLength(4);
        expect(converted[2]!.parts[0].text).toBe("Attached image(s) from tool result:");
        expect(opencode1UiMessages(input.map(providerVisibleMessage), google)).toEqual(converted);
    });

    // OpenCode 1.18.35 keeps Gemini 3 image attachments inside tool output,
    // rather than extracting them into a synthetic user message (message-v2.ts:
    // 137-163). Check that the vendored conversion implements that routing rule;
    // providerVisibleMessage itself retains the attachment unchanged.
    test.failing("vendored OC1 conversion should keep Gemini 3 attachments inside tool results", () => {
        const converted = opencode1UiMessages(mediaHistory(), google);
        expect(converted).toHaveLength(3);
        expect(converted[1]!.parts[0].output.attachments[0].url).toBe(png);
    });

    test("aborted assistant fixture partner confirms the entire message is skipped", () => {
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
        expect(opencode1UiMessages(input, model).map((m) => m.id)).toEqual(["u1", "u2"]);
    });

    // OpenCode 1.18.35 preserves an aborted assistant's tool/text output in
    // the model request (message-v2.ts:258-266). The fixture should not omit
    // that whole message just because the assistant has an abort error.
    test.failing("vendored OC1 conversion should retain tool output from an aborted assistant", () => {
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
        expect(opencode1UiMessages(input, model).map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
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
