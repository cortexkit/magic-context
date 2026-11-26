/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Media } from "@opencode/ai/media";
import { Message } from "@opencode/ai/schema/messages";
import type { StoreRow } from "../store-reader";
import { hostMediaAsset, rememberHostMedia, resetHostMediaForTests } from "./host-media";
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

// Stand-ins for the host's classes. The host's `Asset` takes `{ source }`.
class HostAsset {
    readonly source: { mediaType: string };
    readonly mediaType: string;
    constructor(input: { source: { mediaType: string } }) {
        this.source = input.source;
        this.mediaType = input.source.mediaType;
    }
}
class HostMessage {
    constructor(readonly content: unknown[]) {}
}

afterEach(() => resetHostMediaForTests());

describe("restoreRow attachments", () => {
    // Every supported OpenCode 2 host (2.0.22 and later) needs its own asset instance in a
    // media part; the plain `{ mediaType, data }` part makes 2.3.x fail the whole request
    // before any provider call. It must never be produced, with or without a builder.
    it("never produces the plain media part: with nothing learned from the host, the attachment becomes the note", () => {
        const [message] = restoreRow(imageRow(), MODEL);
        expect(message?.content).toEqual([
            { type: "text", text: "what is in this image?" },
            { type: "text", text: unavailableAttachmentNote("pixel.png", "image/png") },
        ]);
    });

    it("rebuilds the attachment in the host's own asset class by default once a host message was seen", () => {
        // The host's own message class, as the context hook sees it in a draft without any
        // attachment: the asset is decoded through the host's message schema.
        rememberHostMedia([
            Message.make({ role: "user", content: [{ type: "text", text: "hi" }] }),
        ]);
        const part = restoreRow(imageRow(), MODEL)[0]?.content[1];
        expect(part?.media).toBeInstanceOf(Media.Asset);
        expect(part?.media).toEqual(Media.base64("iVBORw0KGgo=", "image/png"));
        expect(Object.keys(part ?? {})).toEqual(["type", "media", "filename", "metadata"]);
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
    });

    it("reports why no asset could be built when the host's message classes show no media member", () => {
        rememberHostMedia([new HostMessage([{ type: "text", text: "hello" }])]);
        // No host asset was seen and this stand-in has no content schema, so the reason
        // names why each of the two rebuild methods failed.
        expect(hostMediaAsset("AAAA", "image/png")).toBe(
            "no Media.Asset seen in this process; no host message schema with a media member seen",
        );
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

    // OpenCode 2.3 has one class per role, and its system and tool classes have no media
    // member. A draft can start with a system message (the effort message a reasoning
    // variant switch renders), and that may be the first draft a fresh process sees.
    it("finds the schema on a later message class when the draft starts with a system message that has no media member", () => {
        const textMember = { fields: { type: { ast: { literal: "text" } } } };
        const effortMember = { fields: { type: { ast: { literal: "effort" } } } };
        class SystemMessage extends HostMessage {
            static ast = { annotations: { identifier: "LLM.SystemMessage" } };
            static fields = { content: { value: { members: [textMember, effortMember] } } };
        }
        // Effect schemas can be callable: the media field schema here is a function.
        const assetSchema = Object.assign(() => undefined, {
            ast: {
                encoding: [
                    {
                        transformation: {
                            decode: {
                                _tag: "Transform",
                                transform: (encoded: { source: { mediaType: string } }) =>
                                    new HostAsset(encoded),
                            },
                        },
                    },
                ],
            },
        });
        class UserMessage extends HostMessage {
            static fields = {
                content: {
                    value: {
                        members: [
                            textMember,
                            {
                                fields: {
                                    type: { ast: { literal: "media" } },
                                    media: assetSchema,
                                },
                            },
                        ],
                    },
                },
            };
        }
        rememberHostMedia([
            new SystemMessage([{ type: "effort", effort: "high" }]),
            new UserMessage([{ type: "text", text: "hello" }]),
        ]);
        expectImageAsset();
        const part = restoreRow(imageRow(), MODEL)[0]?.content[1];
        expect(part?.type).toBe("media");
        expect(part?.media).toBeInstanceOf(HostAsset);
    });

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
