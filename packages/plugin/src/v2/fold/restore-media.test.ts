/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { StoreRow } from "../store-reader";
import {
    hostMediaAsset,
    hostUsesMediaAssets,
    rememberHostMedia,
    resetHostMediaForTests,
} from "./host-media";
import { type RestoreMedia, restoreRow, unavailableAttachmentNote } from "./restore";

const MODEL = { providerID: "openai", id: "mock-model" };
const imageRow = (): StoreRow =>
    ({
        id: "msg-image",
        session_id: "ses-1",
        type: "user",
        seq: 3,
        data: {
            text: "what is in this image?",
            files: [
                {
                    mime: "image/png",
                    data: "iVBORw0KGgo=",
                    name: "pixel.png",
                    source: { type: "inline" },
                },
            ],
        },
    }) as unknown as StoreRow;

// Stand-ins for the host's classes. The host's `Asset` takes `{ source }`; its message
// class is an Effect Schema class whose AST names "Media.Asset" on 2.0.15 and later.
class HostAsset {
    readonly source: { mediaType: string };
    readonly mediaType: string;
    constructor(input: { source: { mediaType: string } }) {
        this.source = input.source;
        this.mediaType = input.source.mediaType;
    }
}
class HostMessage {
    static ast = { annotations: { expected: "Media.Asset" } };
    constructor(readonly content: unknown[]) {}
}

afterEach(() => resetHostMediaForTests());

describe("restoreRow attachments", () => {
    it("keeps the plain media shape when no host media builder is given (hosts before 2.0.15)", () => {
        const [message] = restoreRow(imageRow(), MODEL);
        expect(message?.content[1]).toEqual({
            type: "media",
            mediaType: "image/png",
            data: "iVBORw0KGgo=",
            filename: "pixel.png",
            metadata: undefined,
        });
    });

    it("builds the part around the host's asset, in the host's own key order", () => {
        const asset = new HostAsset({ source: { mediaType: "image/png" } });
        const media: RestoreMedia = {
            asset: () => asset,
            unavailable: () => {
                throw new Error("must not fall back");
            },
        };
        const part = restoreRow(imageRow(), MODEL, media)[0]?.content[1];
        expect(part?.media).toBe(asset);
        expect(Object.keys(part ?? {})).toEqual(["type", "media", "filename", "metadata"]);
    });

    it("replaces an attachment it cannot rebuild with a note that depends only on the row, and reports it once", () => {
        const reports: unknown[] = [];
        const media: RestoreMedia = {
            asset: () =>
                "no Media.Asset seen in this process; host media schema has no union members",
            unavailable: (detail) => reports.push(detail),
        };
        const first = restoreRow(imageRow(), MODEL, media);
        const second = restoreRow(imageRow(), MODEL, media);

        expect(first).toEqual(second);
        expect(first[0]?.content).toEqual([
            { type: "text", text: "what is in this image?" },
            { type: "text", text: unavailableAttachmentNote("pixel.png", "image/png") },
        ]);
        expect(unavailableAttachmentNote("pixel.png", "image/png")).toBe(
            '[Attachment "pixel.png" (image/png) is not available in this restored history]',
        );
        expect(reports).toEqual([
            {
                rowID: "msg-image",
                name: "pixel.png",
                mediaType: "image/png",
                reason: "no Media.Asset seen in this process; host media schema has no union members",
            },
            {
                rowID: "msg-image",
                name: "pixel.png",
                mediaType: "image/png",
                reason: "no Media.Asset seen in this process; host media schema has no union members",
            },
        ]);
    });
});

describe("host media classes", () => {
    it("rebuilds an asset with the class of one the host put in a draft", () => {
        rememberHostMedia([
            new HostMessage([
                { type: "media", media: new HostAsset({ source: { mediaType: "image/jpeg" } }) },
            ]),
        ]);
        const asset = hostMediaAsset("AAAA", "image/png");
        expect(asset).toBeInstanceOf(HostAsset);
        expect((asset as HostAsset).source).toEqual({
            type: "base64",
            data: "AAAA",
            mediaType: "image/png",
        });
        expect(hostUsesMediaAssets()).toBe(true);
    });

    it("detects an asset-shaped host from its message schema before any attachment is seen", () => {
        rememberHostMedia([new HostMessage([{ type: "text", text: "hello" }])]);
        expect(hostUsesMediaAssets()).toBe(true);
        // No host asset was seen and this stand-in schema has no decode path, so the reason
        // names why each of the two rebuild methods failed.
        expect(hostMediaAsset("AAAA", "image/png")).toBe(
            "no Media.Asset seen in this process; host content schema has no union members",
        );
    });

    it("treats a host whose message schema never names Media.Asset as the plain-shape host", () => {
        class OlderHostMessage {
            static ast = { annotations: { identifier: "LLM.Message" } };
            readonly content: unknown[] = [];
        }
        rememberHostMedia([new OlderHostMessage()]);
        expect(hostUsesMediaAssets()).toBe(false);
    });
});

describe("host media schema decoding", () => {
    function rememberSchema(decode: unknown): void {
        class SchemaMessage extends HostMessage {
            static fields = {
                content: {
                    value: {
                        members: [
                            {
                                fields: {
                                    type: { ast: { literal: "media" } },
                                    media: { ast: { encoding: [{ transformation: { decode } }] } },
                                },
                            },
                        ],
                    },
                },
            };
        }
        rememberHostMedia([new SchemaMessage([{ type: "text", text: "hello" }])]);
    }

    function expectImageAsset(): void {
        const asset = hostMediaAsset("iVBORw0KGgo=", "image/png");
        expect(asset).toBeInstanceOf(HostAsset);
        expect((asset as HostAsset).source).toEqual({
            type: "base64",
            data: "iVBORw0KGgo=",
            mediaType: "image/png",
        });
    }

    it("rebuilds an asset through the legacy run getter without a live image", () => {
        rememberSchema({
            run(
                input: { _tag: string; value: { source: { mediaType: string } } },
                options: unknown,
            ) {
                expect(input._tag).toBe("Some");
                expect(options).toEqual({});
                return {
                    _tag: "Success",
                    value: { _tag: "Some", value: new HostAsset(input.value) },
                };
            },
        });
        expectImageAsset();
    });

    it("rebuilds an asset through the Effect 4.0.x Transform getter without a live image", () => {
        rememberSchema({
            _tag: "Transform",
            transform: (encoded: { source: { mediaType: string } }) => new HostAsset(encoded),
        });
        expectImageAsset();
    });

    it.each([
        "TransformOptional",
        "TransformEffect",
        "Unknown",
    ])("reports the unsupported %s getter without invoking it", (tag) => {
        const unexpected = () => {
            throw new Error("unsupported getters must not run");
        };
        rememberSchema({ _tag: tag, transform: unexpected, run: unexpected });
        expect(hostMediaAsset("iVBORw0KGgo=", "image/png")).toBe(
            `no Media.Asset seen in this process; host media schema has unsupported decode transformation: ${tag}`,
        );
    });

    it.each([
        [
            "plain record",
            (encoded: { source: { mediaType: string } }) => ({ source: encoded.source }),
        ],
        [
            "copied source",
            (encoded: { source: { mediaType: string } }) =>
                new HostAsset({ source: { ...encoded.source } }),
        ],
    ])("rejects a Transform getter returning a %s", (_name, transform) => {
        rememberSchema({ _tag: "Transform", transform });
        expect(hostMediaAsset("iVBORw0KGgo=", "image/png")).toBe(
            "no Media.Asset seen in this process; host media schema decode did not return an asset",
        );
    });
});
