/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
    classifyRequestToolsChange,
    type RequestTool,
    requestToolSchemaDigest,
    requestToolsFingerprint,
    v2RequestToolsFingerprint,
} from "./request-tool-definitions";

const tool = (name: string, description = `${name} tool`, schema: unknown = {}): RequestTool => ({
    name,
    description,
    schemaDigest: requestToolSchemaDigest(schema),
});

describe("requestToolSchemaDigest", () => {
    test("ignores object key order but not values", () => {
        const a = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
        const b = { required: ["path"], properties: { path: { type: "string" } }, type: "object" };
        expect(requestToolSchemaDigest(a)).toBe(requestToolSchemaDigest(b));
        expect(requestToolSchemaDigest(a)).not.toBe(
            requestToolSchemaDigest({ ...a, required: [] }),
        );
    });

    test("writes values JSON cannot carry as the wire would", () => {
        expect(requestToolSchemaDigest({ a: 1, b: undefined })).toBe(
            requestToolSchemaDigest({ a: 1 }),
        );
        expect(requestToolSchemaDigest([1, undefined])).toBe(requestToolSchemaDigest([1, null]));
    });

    test("writes a value shared by two branches in full in both", () => {
        const shared = { type: "string" };
        const changed = { type: "number" };
        expect(requestToolSchemaDigest({ a: shared, b: shared })).not.toBe(
            requestToolSchemaDigest({ a: shared, b: changed }),
        );
    });

    test("terminates on a schema that contains itself", () => {
        const cyclic: Record<string, unknown> = { type: "object" };
        cyclic.self = cyclic;
        expect(requestToolSchemaDigest(cyclic)).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("requestToolsFingerprint", () => {
    test("does not depend on tool order", () => {
        expect(requestToolsFingerprint([tool("a"), tool("b")])).toEqual(
            requestToolsFingerprint([tool("b"), tool("a")]),
        );
    });

    test("names what changed, outermost first", () => {
        const base = requestToolsFingerprint([tool("read", "Read", { type: "object" })]);
        expect(classifyRequestToolsChange(base, base)).toBeNull();
        expect(
            classifyRequestToolsChange(
                base,
                requestToolsFingerprint([tool("read", "Read", { type: "object", required: [] })]),
            ),
        ).toBe("schemas");
        expect(
            classifyRequestToolsChange(
                base,
                requestToolsFingerprint([tool("read", "Read a file", { type: "object" })]),
            ),
        ).toBe("descriptions");
        expect(
            classifyRequestToolsChange(
                base,
                requestToolsFingerprint([tool("read", "Read", { type: "object" }), tool("search")]),
            ),
        ).toBe("names");
    });

    test("skips a deferred tool until the conversation references it", () => {
        const plain = requestToolsFingerprint([tool("read")]);
        const deferred = { ...tool("search"), deferLoading: true };
        expect(requestToolsFingerprint([tool("read"), deferred], () => new Set())).toEqual(plain);
        expect(
            requestToolsFingerprint([tool("read"), deferred], () => new Set(["search"])),
        ).not.toEqual(plain);
        // Once counted, a deferred tool differs from the same tool sent immediate
        // only by its defer_loading flag, at the schemas level.
        expect(
            classifyRequestToolsChange(
                requestToolsFingerprint([tool("read"), tool("search")]),
                requestToolsFingerprint([tool("read"), deferred], () => new Set(["search"])),
            ),
        ).toBe("schemas");
    });

    test("OpenCode 2: reads names, descriptions and schemas from the draft's tool map", () => {
        const tools = {
            read: { description: "Read", input: { type: "object" } },
            search: { description: "Search", input: { type: "object" }, defer_loading: true },
        };
        const unreferenced = v2RequestToolsFingerprint(tools, []);
        expect(unreferenced).toEqual(
            requestToolsFingerprint([tool("read", "Read", { type: "object" })]),
        );
        expect(
            v2RequestToolsFingerprint(tools, [
                { content: [{ type: "tool-call", name: "search" }] },
            ]),
        ).not.toEqual(unreferenced);
    });
});
