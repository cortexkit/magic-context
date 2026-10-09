/// <reference types="bun-types" />
import { expect, test } from "bun:test";
import {
    buildPagedModuleTransformPayloads,
    encodeOpenCodeMessagesToCk,
    MODULE_ITEM_CONTINUATION_KEY,
} from "./module-wire";

test("attachment review: attachment-free error/completed and empty-list aliases keep old bytes", () => {
    for (const status of ["completed", "error"]) {
        for (const text of ["", "line\n\u0000§raw§"]) {
            for (const aliases of [
                {},
                { attachments: [] },
                { stateAttachments: [] },
                { attachments: [], stateAttachments: [] },
            ]) {
                const state = {
                    status,
                    input: {},
                    [status === "error" ? "error" : "output"]: text,
                    ...("stateAttachments" in aliases
                        ? { attachments: aliases.stateAttachments }
                        : {}),
                };
                const raw = {
                    info: { id: "m", role: "assistant" },
                    parts: [
                        {
                            type: "tool",
                            tool: "read",
                            callID: "call",
                            state,
                            ...("attachments" in aliases
                                ? { attachments: aliases.attachments }
                                : {}),
                        },
                    ],
                };
                const old = [
                    {
                        mid: "m",
                        ordinal: 1,
                        ck: {
                            role: "assistant",
                            content: [
                                {
                                    kind: {
                                        type: "tool_call",
                                        id: "call",
                                        name: "read",
                                        input: {},
                                    },
                                },
                                {
                                    kind: {
                                        type: "tool_result",
                                        id: "call",
                                        tool_name: "read",
                                        output: {
                                            kind: {
                                                type: status === "error" ? "error_text" : "text",
                                                text,
                                            },
                                        },
                                    },
                                },
                            ],
                            meta: {
                                harness_id: "m",
                                ordinal: 1,
                                synthetic: false,
                                summary: false,
                                errored: false,
                            },
                        },
                    },
                ];
                expect(JSON.stringify(encodeOpenCodeMessagesToCk([raw]))).toBe(JSON.stringify(old));
            }
        }
    }
});

test("attachment review: state list wins over part alias and an absent state list falls back", () => {
    const attachment = { type: "file", mime: "image/png", url: "data:image/png;base64,aW1n" };
    for (const stateAttachments of [undefined, []]) {
        const raw = {
            info: { id: "m", role: "assistant" },
            parts: [
                {
                    type: "tool",
                    tool: "read",
                    callID: "call",
                    attachments: [attachment],
                    state: {
                        status: "completed",
                        input: {},
                        output: "Read",
                        ...(stateAttachments === undefined
                            ? {}
                            : { attachments: stateAttachments }),
                    },
                },
            ],
        };
        const kind = (
            encodeOpenCodeMessagesToCk([raw])[0]!.ck.content[1] as {
                kind: { output: { kind: { type: string; blocks?: unknown[] } } };
            }
        ).kind.output.kind;
        expect(kind.type).toBe(stateAttachments === undefined ? "content" : "text");
        if (stateAttachments === undefined) expect(kind.blocks).toHaveLength(2);
    }
});

test("attachment review: oversized media carrier is paged losslessly within the configured limit", () => {
    const attachment = {
        type: "file",
        mime: "image/png",
        url: `data:image/png;base64,${"A".repeat(96 * 1024)}`,
    };
    const native = [
        {
            info: { id: "m", role: "assistant" },
            parts: [
                {
                    type: "tool",
                    tool: "read",
                    callID: "call",
                    state: {
                        status: "completed",
                        input: {},
                        output: "Screenshot",
                        attachments: [attachment],
                    },
                },
            ],
        },
    ];
    const input = encodeOpenCodeMessagesToCk(native);
    const cap = 80 * 1024;
    const pages = buildPagedModuleTransformPayloads(
        {
            method: "transform",
            session_id: "attachment-review-pages",
            input,
            native_messages: native,
        },
        cap,
    );
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages)
        expect(
            Buffer.byteLength(JSON.stringify(page.page)) +
                Buffer.byteLength(',"accept_reply_pages":true'),
        ).toBeLessThanOrEqual(cap);
    // Independently reconstruct the continuation carriers, not a hash of the input itself.
    for (const field of ["input", "native_messages"]) {
        const chunks = pages.flatMap(
            (page) =>
                page.page[field] as Array<{
                    chunk: string;
                    [MODULE_ITEM_CONTINUATION_KEY]: { item_index: number; chunk_index: number };
                }>,
        );
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((chunk) => chunk[MODULE_ITEM_CONTINUATION_KEY].item_index === 0)).toBe(
            true,
        );
        chunks.sort(
            (a, b) =>
                a[MODULE_ITEM_CONTINUATION_KEY].chunk_index -
                b[MODULE_ITEM_CONTINUATION_KEY].chunk_index,
        );
        expect(JSON.parse(chunks.map((chunk) => chunk.chunk).join(""))).toEqual(
            field === "input" ? input[0] : native[0],
        );
    }
});
