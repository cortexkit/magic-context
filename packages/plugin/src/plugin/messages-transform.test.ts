/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { createMessagesTransformHandler } from "./messages-transform";

// Minimal fake message shape — just needs info + parts.
function makeOutput(): any {
    return {
        messages: [
            {
                info: { id: "m1", role: "user", sessionID: "ses_test" },
                parts: [{ type: "text", text: "hello" }],
            },
        ],
    };
}

describe("createMessagesTransformHandler — error boundary (issue #23)", () => {
    it("swallows SQLITE_BUSY from inner transform so prompt loop proceeds", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    const err = new Error("database is locked") as Error & {
                        code: string;
                        errno: number;
                    };
                    err.code = "SQLITE_BUSY";
                    err.errno = 5;
                    throw err;
                },
            },
        });

        const output = makeOutput();
        // Should NOT throw — wrapper catches all errors.
        await expect(handler({}, output)).resolves.toBeUndefined();

        // Messages are left untouched when transform fails.
        expect(output.messages).toHaveLength(1);
        expect(output.messages[0].info.id).toBe("m1");
    });

    it("swallows unexpected non-SQLITE errors too", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    throw new TypeError("unexpected undefined access");
                },
            },
        });

        const output = makeOutput();
        await expect(handler({}, output)).resolves.toBeUndefined();
    });

    it("passes through non-error transforms normally", async () => {
        let called = false;
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async (_input, out) => {
                    called = true;
                    (out.messages as any).push({
                        info: { id: "injected", role: "user", sessionID: "ses_test" },
                        parts: [{ type: "text", text: "injected" }],
                    });
                },
            },
        });

        const output = makeOutput();
        await handler({}, output);
        expect(called).toBe(true);
        expect(output.messages).toHaveLength(2);
    });

    it("no-ops when magicContext is null (disabled plugin path)", async () => {
        const handler = createMessagesTransformHandler({ magicContext: null });
        const output = makeOutput();
        await expect(handler({}, output)).resolves.toBeUndefined();
        expect(output.messages).toHaveLength(1);
    });
});
