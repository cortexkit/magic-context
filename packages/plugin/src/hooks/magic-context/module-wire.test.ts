/// <reference types="bun-types" />

import { describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    __moduleWireTest,
    buildPagedModuleTransformPayloads,
    encodeOpenCodeMessagesToCk,
    MODULE_ORDINAL_PAGE_SIZE,
    MODULE_PAGE_MAX_BYTES,
    type OrdinalMemoCheckpoint,
    resolveOrdinalsForModule,
    SUBC_MAX_FRAME_BODY_BYTES,
} from "./module-wire";
import { setRawMessageProvider } from "./read-session-chunk";
import type { MessageLike } from "./transform-operations";

describe("encodeOpenCodeMessagesToCk", () => {
    it("projects tool attachments beside text for both completed and error results", () => {
        for (const status of ["completed", "error"]) {
            const attachments = [
                {
                    type: "file",
                    id: "image-id",
                    mime: "image/jpeg",
                    url: "data:image/jpeg;base64,aW1n",
                    filename: "screen.jpg",
                    vendor: { keep: true },
                },
                {
                    type: "file",
                    mime: "application/pdf",
                    url: "data:application/pdf;base64,cGRm",
                    filename: "read.pdf",
                },
                { type: "vendor-file", id: "opaque-id", payload: [1, 2] },
                { type: "text", text: "attached text", vendor: "keep" },
            ];
            const raw = {
                info: { id: "msg", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        callID: "call",
                        tool: "read",
                        state: {
                            status,
                            input: {},
                            [status === "error" ? "error" : "output"]: "Read result",
                            attachments,
                        },
                    },
                ],
            };
            const encoded = encodeOpenCodeMessagesToCk([raw]);
            const output = (encoded[0]!.ck.content[1] as any).kind.output.kind;
            expect(output.type).toBe(status === "error" ? "error_content" : "content");
            expect(output.blocks[0]).toEqual({ kind: { type: "text", text: "Read result" } });
            expect(output.blocks[1].kind.media).toEqual({
                kind: "image",
                media_type: "image/jpeg",
                filename: "screen.jpg",
                source: { type: "data_base64", data: "aW1n" },
            });
            expect(output.blocks[2].kind.media.kind).toBe("document");
            expect(output.blocks[3].kind.opaque.raw).toEqual(attachments[2]);
            expect(output.blocks[4].kind).toEqual({ type: "text", text: "attached text" });
            expect(
                output.blocks.slice(1).map((block: any) => {
                    if (block.kind.type === "opaque") return block.kind.opaque.raw;
                    const ns = block.provider_extras.opencode;
                    const raw = { ...ns.rawAttachment };
                    for (const field of ns.rawAttachmentSourceFields ?? []) {
                        const media = block.kind.media;
                        raw[field] =
                            field === "data"
                                ? media.source.data
                                : media.source.type === "data_base64"
                                  ? `data:${media.media_type};base64,${media.source.data}`
                                  : media.source.url;
                    }
                    return raw;
                }),
            ).toEqual(attachments);
            expect(JSON.stringify(encodeOpenCodeMessagesToCk([raw]))).toBe(JSON.stringify(encoded));
        }
    });

    it("keeps media-only results taggable and carries each screenshot payload once", () => {
        for (const status of ["completed", "error"]) {
            const payload = "A".repeat(768 * 1024);
            const [encoded] = encodeOpenCodeMessagesToCk([
                {
                    info: { id: "media-only", role: "assistant" },
                    parts: [
                        {
                            type: "tool",
                            callID: "screen",
                            tool: "read",
                            state: {
                                status,
                                input: {},
                                output: "",
                                error: "",
                                attachments: [
                                    {
                                        type: "file",
                                        mime: "image/png",
                                        url: `data:image/png;base64,${payload}`,
                                    },
                                ],
                            },
                        },
                    ],
                },
            ]);
            const output = (encoded!.ck.content[1] as any).kind.output.kind;
            expect(output.blocks[0]).toEqual({ kind: { type: "text", text: "" } });
            expect(output.blocks[1].provider_extras.opencode.rawAttachmentSourceFields).toEqual([
                "url",
            ]);
            expect(JSON.stringify(encoded).split(payload)).toHaveLength(2);
        }
    });

    it("keeps no-attachment tool projection byte-identical to the old adapter", () => {
        for (const status of ["completed", "error"]) {
            const state = {
                status,
                input: { a: 1 },
                [status === "error" ? "error" : "output"]: "line\n\u0000§raw§",
            };
            const raw = {
                info: { id: "msg", role: "assistant" },
                parts: [{ type: "tool", callID: "call", tool: "read", state }],
            };
            const before = encodeOpenCodeMessagesToCk([raw]);
            // The pre-repair adapter's complete wire shape, not a copy of current output.
            const expected = [
                {
                    mid: "msg",
                    ordinal: 1,
                    ck: {
                        role: "assistant",
                        content: [
                            {
                                kind: {
                                    type: "tool_call",
                                    id: "call",
                                    name: "read",
                                    input: { a: 1 },
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
                                            text: "line\n\u0000§raw§",
                                        },
                                    },
                                },
                            },
                        ],
                        meta: {
                            harness_id: "msg",
                            ordinal: 1,
                            synthetic: false,
                            summary: false,
                            errored: false,
                        },
                    },
                },
            ];
            expect(JSON.stringify(before)).toBe(JSON.stringify(expected));
            expect(
                JSON.stringify(
                    encodeOpenCodeMessagesToCk([
                        {
                            ...raw,
                            parts: [{ ...raw.parts[0], state: { ...state, attachments: [] } }],
                        },
                    ]),
                ),
            ).toBe(JSON.stringify(expected));
        }
    });

    it("keeps a synthetic-only row synthetic when an existing compaction marker is attached", () => {
        const row = {
            info: { id: "msg_synthetic_gap", role: "user" },
            parts: [{ type: "text", text: "notice", synthetic: true }],
        };
        const [before] = encodeOpenCodeMessagesToCk([row]);
        const [after] = encodeOpenCodeMessagesToCk([
            { ...row, parts: [...row.parts, { type: "compaction", auto: true }] },
        ]);
        expect(before.ck.meta).toMatchObject({ synthetic: true });
        expect(after.ck.meta).toMatchObject({ synthetic: true });
        expect(after.ck.content).toEqual(before.ck.content);
        expect(JSON.stringify(after.ck)).toBe(JSON.stringify(before.ck));
        const append = {
            info: { id: "msg_next", role: "user" },
            parts: [{ type: "text", text: "next" }],
        };
        const priced = encodeOpenCodeMessagesToCk([row, append]);
        const deferred = encodeOpenCodeMessagesToCk([
            { ...row, parts: [...row.parts, { type: "compaction", auto: true }] },
            append,
        ]);
        expect(JSON.stringify(deferred)).toBe(JSON.stringify(priced));
    });
    it("marks a collapsed synthetic todo pair as synthetic CK ingress", () => {
        const [encoded] = encodeOpenCodeMessagesToCk([
            {
                info: { id: "msg_synthetic_todo", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        tool: "todowrite",
                        callID: "mc_synthetic_todo_deadbeefdeadbeef",
                        syntheticTodoMarker: true,
                        state: {
                            status: "completed",
                            input: { todos: [] },
                            output: "[]",
                        },
                    },
                ],
            },
        ]);

        expect(encoded.ck.meta).toMatchObject({
            harness_id: "msg_synthetic_todo",
            synthetic: true,
        });
    });

    it("carries completed-tool titles only in the non-decision-bearing recovery sidecar", () => {
        const [encoded] = encodeOpenCodeMessagesToCk([
            {
                info: { id: "msg_titled_tool", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        tool: "read",
                        callID: "read:titled",
                        state: {
                            status: "completed",
                            input: { filePath: "src/title.ts" },
                            output: "contents",
                            metadata: { title: "Read title-bearing fixture" },
                        },
                    },
                ],
            },
        ]);

        expect(encoded.ck.provider_extras).toEqual({
            opencode: {
                ctx_expand_tool_titles: {
                    "read:titled": "Read title-bearing fixture",
                },
            },
        });
        expect(encoded.ck.content[0]).toEqual({
            kind: {
                type: "tool_call",
                id: "read:titled",
                name: "read",
                input: { filePath: "src/title.ts" },
            },
        });

        const [pending] = encodeOpenCodeMessagesToCk([
            {
                info: { id: "msg_pending_tool", role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        tool: "read",
                        callID: "read:pending",
                        state: { status: "pending", title: "Not recoverable yet" },
                    },
                ],
            },
        ]);
        expect(pending.ck.provider_extras).toBeUndefined();
    });

    it("carries nested OpenCode timestamps from the generated temporal parity fixture", () => {
        const golden = JSON.parse(
            readFileSync(
                join(
                    import.meta.dir,
                    "../../../../../crates/mc-module/testdata/temporal-parity-golden.json",
                ),
                "utf8",
            ),
        ) as {
            schema: number;
            generator_version: number;
            cases: Array<{ raw_messages: unknown[]; encoded_input: unknown[] }>;
        };

        expect(golden.schema).toBe(1);
        expect(golden.generator_version).toBe(1);
        for (const fixture of golden.cases) {
            const encoded = encodeOpenCodeMessagesToCk(fixture.raw_messages);
            expect(encoded).toEqual(fixture.encoded_input);
            expect(encoded[1]?.ck.meta).toMatchObject({
                created_at_ms: 10_000,
                completed_at_ms: 70_000,
            });
        }
    });

    it("matches the module golden generated from raw OpenCode reasoning parts", () => {
        const golden = JSON.parse(
            readFileSync(
                join(
                    import.meta.dir,
                    "../../../../../crates/mc-module/testdata/merged-reasoning-adapter-golden.json",
                ),
                "utf8",
            ),
        ) as {
            generator_version: number;
            cases: Array<{
                name: string;
                raw_messages: unknown[];
                encoded_input: unknown[];
            }>;
        };

        expect(golden.generator_version).toBe(6);
        expect(golden.cases.map((fixture) => fixture.name)).toEqual([
            "reasoning",
            "thinking",
            "redacted_thinking",
            "reasoning_cache_control",
            "live_tool_continuation_request_shell",
            "incident_astro_signed_reasoning_tool_without_text",
            "incident_engram_text_after_tool_recurrence",
            "incident_337_text_before_tool",
        ]);
        for (const fixture of golden.cases) {
            expect(encodeOpenCodeMessagesToCk(fixture.raw_messages)).toEqual(fixture.encoded_input);
        }
    });
});

describe("resolveOrdinalsForModule provisional tails", () => {
    it("records the exact compaction-summary normalization removed from module input", async () => {
        const sessionId = "module-wire-summary-normalization";
        const unregister = setRawMessageProvider(sessionId, {
            readMessages: () => [],
            readMessageOrdinalPage: () => [],
            getStoredMessageCount: () => 0,
        });
        const summary = {
            info: {
                id: "summary-1",
                role: "assistant",
                sessionID: sessionId,
                summary: true,
                finish: "stop",
            },
            parts: [{ type: "text", text: "redacted summary fixture" }],
        } as MessageLike;
        const tail = {
            info: { id: "tail-1", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "continue" }],
        } as MessageLike;

        try {
            const resolved = await resolveOrdinalsForModule({
                sessionId,
                messages: [summary, tail],
                generation: 1,
                memoGeneration: 1,
                memo: new Map(),
                memoStoredCount: 0,
                memoCanonicalCount: 0,
            });

            expect(resolved.ok).toBe(true);
            if (!resolved.ok) throw new Error(resolved.reason);
            expect(resolved.annotatedInput).toEqual([
                expect.objectContaining({ absolute_ordinal: 1, info: tail.info }),
            ]);
            expect(resolved.normalizations).toEqual([
                {
                    kind: "summary_message",
                    message_id: "summary-1",
                    part_index: -1,
                    field: "input",
                    removed: JSON.stringify(summary),
                },
            ]);
        } finally {
            unregister();
        }
    });

    async function resolveTail(count: number) {
        const sessionId = `module-wire-provisional-${count}`;
        const persistedTail: Array<{
            id: string;
            timeCreated: number;
            contributesOrdinal: boolean;
            hasValidInfo: boolean;
        }> = [];
        const unregister = setRawMessageProvider(sessionId, {
            readMessages: () => persistedTail,
            readMessageOrdinalPage: (after, limit) =>
                persistedTail
                    .filter(
                        (row) =>
                            !after ||
                            row.timeCreated > after.timeCreated ||
                            (row.timeCreated === after.timeCreated && row.id > after.id),
                    )
                    .slice(0, limit),
            getStoredMessageCount: () => 500 + persistedTail.length,
        });
        const messages = Array.from({ length: count }, (_, index) => ({
            info: {
                id: `m-${501 + index}`,
                role: "user",
                sessionID: sessionId,
            },
            parts: [{ type: "text", text: `unpersisted ${index + 1}` }],
        })) as MessageLike[];
        const memo = new Map<string, number>([["m-500", 500]]);
        try {
            const first = await resolveOrdinalsForModule({
                sessionId,
                messages,
                generation: 1,
                memoGeneration: 1,
                memo,
                memoAnchor: { timeCreated: 500, id: "m-500" },
                memoStoredCount: 500,
                memoCanonicalCount: 500,
                provisionalBase: 500,
            });
            expect(first.ok).toBe(true);
            if (!first.ok) throw new Error(first.reason);
            return { first, messages, memo, persistedTail, unregister, sessionId };
        } catch (error) {
            unregister();
            throw error;
        }
    }

    it("continues wholly fresh post-descent arrays from the durable provisional base", async () => {
        const sessionId = "module-wire-wholly-fresh-descent";
        const unregister = setRawMessageProvider(sessionId, {
            readMessages: () => [],
            readMessageOrdinalPage: () => [],
            getStoredMessageCount: () => 0,
        });
        const messages = [
            {
                info: { id: "summary", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "continuation summary" }],
            },
            {
                info: { id: "tail", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: "continued answer" }],
            },
        ] as MessageLike[];
        try {
            const resolved = await resolveOrdinalsForModule({
                sessionId,
                messages,
                generation: 1,
                memoGeneration: 1,
                memo: new Map(),
                memoAnchor: null,
                memoStoredCount: 0,
                memoCanonicalCount: 0,
                provisionalBase: 97,
            });
            expect(resolved.ok).toBe(true);
            if (!resolved.ok) throw new Error(resolved.reason);
            expect(
                encodeOpenCodeMessagesToCk(resolved.annotatedInput as MessageLike[]).map(
                    (message) => message.ck.meta.ordinal,
                ),
            ).toEqual([98, 99]);
        } finally {
            unregister();
        }
    });

    it("assigns one unpersisted append the next absolute ordinal", async () => {
        const result = await resolveTail(1);
        try {
            expect(result.first.annotatedInput).toEqual([
                expect.objectContaining({ absolute_ordinal: 501 }),
            ]);
            expect(
                encodeOpenCodeMessagesToCk(result.first.annotatedInput as MessageLike[])[0]?.ck
                    .meta,
            ).toEqual(expect.objectContaining({ ordinal: 501 }));
        } finally {
            result.unregister();
        }
    });

    it("assigns two unpersisted appends distinct absolute ordinals", async () => {
        const result = await resolveTail(2);
        try {
            expect(
                (result.first.annotatedInput as Array<{ absolute_ordinal: number }>).map(
                    (message) => message.absolute_ordinal,
                ),
            ).toEqual([501, 502]);
            expect(
                encodeOpenCodeMessagesToCk(result.first.annotatedInput as MessageLike[]).map(
                    (message) => message.ck.meta.ordinal,
                ),
            ).toEqual([501, 502]);
        } finally {
            result.unregister();
        }
    });

    it("serves a warm memo byte-identically without ordinal I/O and re-probes named invalidations", async () => {
        const sessionId = "module-wire-hot-memo";
        const rows = [
            { id: "m1", timeCreated: 1, contributesOrdinal: true, hasValidInfo: true },
            { id: "m2", timeCreated: 2, contributesOrdinal: true, hasValidInfo: true },
            { id: "m3", timeCreated: 3, contributesOrdinal: true, hasValidInfo: true },
        ];
        let pageReads = 0;
        let countReads = 0;
        const unregister = setRawMessageProvider(sessionId, {
            readMessages: () => rows,
            readMessageOrdinalPage: (after, limit) => {
                pageReads += 1;
                return rows
                    .filter(
                        (row) =>
                            !after ||
                            row.timeCreated > after.timeCreated ||
                            (row.timeCreated === after.timeCreated && row.id > after.id),
                    )
                    .slice(0, limit);
            },
            getStoredMessageCount: () => {
                countReads += 1;
                return rows.length;
            },
        });
        const wire = (ids: string[]) =>
            ids.map((id) => ({
                info: { id, role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: id }],
            })) as MessageLike[];
        const digest = (messages: unknown[]) =>
            createHash("sha256").update(JSON.stringify(messages)).digest("hex");
        const memo = new Map<string, number>();
        try {
            const first = await resolveOrdinalsForModule({
                sessionId,
                messages: wire(["m1", "m2", "m3"]),
                generation: 1,
                memoGeneration: 1,
                memo,
            });
            expect(first.ok).toBe(true);
            if (!first.ok) throw new Error(first.reason);
            const readsAfterPrime = { pageReads, countReads };
            const second = await resolveOrdinalsForModule({
                sessionId,
                messages: wire(["m1", "m2", "m3"]),
                generation: 1,
                memoGeneration: first.memoGeneration,
                memo,
                memoAnchor: first.memoAnchor,
                memoStoredCount: first.memoStoredCount,
                memoCanonicalCount: first.memoCanonicalCount,
            });
            expect(second.ok).toBe(true);
            if (!second.ok) throw new Error(second.reason);
            expect({ pageReads, countReads }).toEqual(readsAfterPrime);
            expect(digest(second.annotatedInput)).toBe(digest(first.annotatedInput));

            const unseen = await resolveOrdinalsForModule({
                sessionId,
                messages: wire(["m1", "m2", "m3", "m4"]),
                generation: 1,
                memoGeneration: second.memoGeneration,
                memo,
                memoAnchor: second.memoAnchor,
                memoStoredCount: second.memoStoredCount,
                memoCanonicalCount: second.memoCanonicalCount,
            });
            expect(unseen.ok).toBe(true);
            expect(pageReads).toBeGreaterThan(readsAfterPrime.pageReads);
            expect(countReads).toBeGreaterThan(readsAfterPrime.countReads);

            rows.splice(1, 1);
            const reset = await resolveOrdinalsForModule({
                sessionId,
                messages: wire(["m1", "m3"]),
                generation: 2,
                memoGeneration: 1,
                memo,
                memoAnchor: second.memoAnchor,
                memoStoredCount: second.memoStoredCount,
                memoCanonicalCount: second.memoCanonicalCount,
            });
            expect(reset.ok).toBe(true);
            if (!reset.ok) throw new Error(reset.reason);
            expect(
                (reset.annotatedInput as Array<{ absolute_ordinal: number }>).map(
                    (message) => message.absolute_ordinal,
                ),
            ).toEqual([1, 2]);
        } finally {
            unregister();
        }
    });

    it("reconciles provisional ordinals when an unseen wire id triggers a probe", async () => {
        const result = await resolveTail(2);
        try {
            result.persistedTail.push(
                { id: "m-501", timeCreated: 501, contributesOrdinal: true, hasValidInfo: true },
                { id: "m-502", timeCreated: 502, contributesOrdinal: true, hasValidInfo: true },
            );
            const reconciled = await resolveOrdinalsForModule({
                sessionId: result.sessionId,
                messages: [
                    ...result.messages,
                    {
                        info: {
                            id: "m-503",
                            role: "user",
                            sessionID: result.sessionId,
                        },
                        parts: [{ type: "text", text: "unpersisted 3" }],
                    } as MessageLike,
                ],
                generation: 1,
                memoGeneration: result.first.memoGeneration,
                memo: result.memo,
                memoAnchor: result.first.memoAnchor,
                memoStoredCount: result.first.memoStoredCount,
                memoCanonicalCount: result.first.memoCanonicalCount,
            });
            expect(reconciled.ok).toBe(true);
            if (reconciled.ok) {
                expect(reconciled.memoCanonicalCount).toBe(502);
                expect(result.memo.get("m-501")).toBe(501);
                expect(result.memo.get("m-502")).toBe(502);
            }
        } finally {
            result.unregister();
        }
    });
});

describe("resolveOrdinalsForModule bounded rebuild", () => {
    const ROWS = 10_000;
    const installCountingStore = (sessionId: string) => {
        const rows = Array.from({ length: ROWS }, (_, index) => ({
            id: `m-${String(index + 1).padStart(6, "0")}`,
            timeCreated: index + 1,
            contributesOrdinal: true,
            hasValidInfo: true,
        }));
        const counters = { rowsRead: 0, fullReads: 0 };
        const unregister = setRawMessageProvider(sessionId, {
            readMessages: () => {
                counters.fullReads += 1;
                return [];
            },
            readMessageOrdinalPage: (after, limit) => {
                const page = rows
                    .filter(
                        (row) =>
                            !after ||
                            row.timeCreated > after.timeCreated ||
                            (row.timeCreated === after.timeCreated && row.id > after.id),
                    )
                    .slice(0, limit);
                counters.rowsRead += page.length;
                return page;
            },
            getStoredMessageCount: () => rows.length,
        });
        return { rows, counters, unregister };
    };
    const wire = (sessionId: string, ids: string[]) =>
        ids.map((id) => ({
            info: { id, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: id }],
        })) as MessageLike[];
    const ordinals = (input: unknown[]) =>
        (input as Array<{ absolute_ordinal: number }>).map((message) => message.absolute_ordinal);

    it("rewinds to the newest intact page after a tail removal instead of re-reading the session", async () => {
        const sessionId = "module-wire-bounded-rewind";
        const store = installCountingStore(sessionId);
        const memo = new Map<string, number>();
        const checkpoints: OrdinalMemoCheckpoint[] = [];
        try {
            const tailIds = store.rows.slice(-3).map((row) => row.id);
            const primed = await resolveOrdinalsForModule({
                sessionId,
                messages: wire(sessionId, tailIds),
                generation: 0,
                memoGeneration: 0,
                memo,
                memoCheckpoints: checkpoints,
            });
            if (!primed.ok) throw new Error(primed.reason);
            expect(primed.stats).toMatchObject({ mode: "prime", rowsRead: ROWS });
            expect(checkpoints.length).toBe(ROWS / MODULE_ORDINAL_PAGE_SIZE);

            // Revert-style removal of one message near the tail. The wire no longer
            // carries it, so every id left on the wire is still in the memo.
            const [removed] = store.rows.splice(ROWS - 2, 1);
            store.counters.rowsRead = 0;
            const survivors = [tailIds[0], tailIds[2]] as string[];
            const verified = await resolveOrdinalsForModule({
                sessionId,
                messages: wire(sessionId, survivors),
                generation: 0,
                memoGeneration: primed.memoGeneration,
                memo,
                memoAnchor: primed.memoAnchor,
                memoStoredCount: primed.memoStoredCount,
                memoCanonicalCount: primed.memoCanonicalCount,
                memoCheckpoints: checkpoints,
                verifyStore: true,
            });
            if (!verified.ok) throw new Error(verified.reason);
            expect(verified.stats.mode).toBe("rewind");
            expect(store.counters.rowsRead).toBeLessThanOrEqual(2 * MODULE_ORDINAL_PAGE_SIZE);
            expect(store.counters.fullReads).toBe(0);
            expect(ordinals(verified.annotatedInput)).toEqual([ROWS - 2, ROWS - 1]);
            expect(memo.has(removed!.id)).toBe(false);
            expect(verified.memoStoredCount).toBe(ROWS - 1);
            expect(verified.memoCanonicalCount).toBe(ROWS - 1);
        } finally {
            store.unregister();
        }
    });

    it("keeps a count drift fail-loud when the caller keeps no checkpoints", async () => {
        const sessionId = "module-wire-bounded-no-checkpoints";
        const store = installCountingStore(sessionId);
        const memo = new Map<string, number>();
        try {
            const tailId = store.rows.at(-1)!.id;
            const primed = await resolveOrdinalsForModule({
                sessionId,
                messages: wire(sessionId, [tailId]),
                generation: 0,
                memoGeneration: 0,
                memo,
            });
            if (!primed.ok) throw new Error(primed.reason);
            store.rows.splice(ROWS - 2, 1);
            const drifted = await resolveOrdinalsForModule({
                sessionId,
                messages: wire(sessionId, [tailId]),
                generation: 0,
                memoGeneration: primed.memoGeneration,
                memo,
                memoAnchor: primed.memoAnchor,
                memoStoredCount: primed.memoStoredCount,
                memoCanonicalCount: primed.memoCanonicalCount,
                verifyStore: true,
            });
            expect(drifted).toMatchObject({ ok: false, reason: "mismatch" });
        } finally {
            store.unregister();
        }
    });
});
const TEST_PAGE_MAX_BYTES = 512 * 1024;

describe("buildPagedModuleTransformPayloads byte reuse", () => {
    it("hashes only stabilized pages while preserving canonical digests and wire sizes", () => {
        const body = {
            method: "transform",
            session_id: "stabilized-digest",
            native_messages: Array.from({ length: 80 }, (_, i) => ({
                z: "α😀".repeat(1_500),
                a: i,
            })),
        };
        const parse = spyOn(JSON, "parse");
        try {
            const pages = buildPagedModuleTransformPayloads(body, TEST_PAGE_MAX_BYTES, true);
            expect(pages.length).toBeGreaterThan(1);
            expect(parse).toHaveBeenCalledTimes(pages.length);
            for (const { page, bytes } of pages) {
                const values = page.native_messages as { a: number; z: string }[];
                // Explicit canonical key order for this fixture is independent
                // of the production canonicalizer and its timing instrumentation.
                const canonical = JSON.stringify({
                    native_messages: values.map(({ a, z }) => ({ a, z })),
                });
                expect(page.transform_page_digest).toBe(
                    createHash("sha256").update(canonical).digest("hex"),
                );
                expect(bytes).toBe(Buffer.byteLength(JSON.stringify(page)));
            }
            expect(pages.flatMap(({ page }) => page.native_messages)).toEqual(body.native_messages);
        } finally {
            parse.mockRestore();
        }
    });

    it("bounds a forced one-page envelope including the transport reply capability", () => {
        const body = { method: "transform", session_id: "boundary", input: [{ text: "" }] };
        body.input[0]!.text = "x".repeat(
            TEST_PAGE_MAX_BYTES - Buffer.byteLength(JSON.stringify(body)),
        );
        const pages = buildPagedModuleTransformPayloads(body, TEST_PAGE_MAX_BYTES, true);
        expect(pages.length).toBeGreaterThan(1);
        for (const { page, bytes } of pages) {
            expect(bytes).toBe(Buffer.byteLength(JSON.stringify(page)));
            expect(
                Buffer.byteLength(JSON.stringify({ ...page, accept_reply_pages: true })),
            ).toBeLessThanOrEqual(TEST_PAGE_MAX_BYTES);
        }
    });

    it("reserves the late transport capability on a full non-final page", () => {
        const body = {
            method: "transform",
            session_id: "boundary",
            input: [
                { text: "x".repeat(TEST_PAGE_MAX_BYTES - 2_000) },
                { text: "x".repeat(TEST_PAGE_MAX_BYTES) },
            ],
        };
        const initial = buildPagedModuleTransformPayloads(body, TEST_PAGE_MAX_BYTES, true);
        // Fill the first page to ten bytes below the caller's cap, before the
        // transport adds its 26-byte reply capability. This used to overrun it.
        body.input[0]!.text += "x".repeat(TEST_PAGE_MAX_BYTES - initial[0]!.bytes - 10);
        const pages = buildPagedModuleTransformPayloads(body, TEST_PAGE_MAX_BYTES, true);
        expect(pages.length).toBeGreaterThan(1);
        for (const { page } of pages) {
            expect(
                Buffer.byteLength(JSON.stringify({ ...page, accept_reply_pages: true })),
            ).toBeLessThanOrEqual(TEST_PAGE_MAX_BYTES);
        }
    });

    it("pins the application page budget to the shared SUBC frame fixture", async () => {
        const fixture = (await Bun.file(
            new URL(
                "../../../../../crates/mc-module/testdata/subc-frame-limits.json",
                import.meta.url,
            ),
        ).json()) as { max_frame_body_bytes: number; application_body_bytes: number };
        expect(SUBC_MAX_FRAME_BODY_BYTES).toBe(fixture.max_frame_body_bytes);
        expect(MODULE_PAGE_MAX_BYTES).toBe(fixture.application_body_bytes);
    });
    it("returns the first stringify length on the unpaged path", () => {
        const body = {
            method: "transform",
            session_id: "ses-unpaged",
            input: [{ mid: "m1", ordinal: 1, ck: { text: "hi" } }],
        };
        const pages = buildPagedModuleTransformPayloads(body);
        expect(pages).toHaveLength(1);
        expect(pages[0]?.page).toBe(body);
        expect(pages[0]?.bytes).toBe(Buffer.byteLength(JSON.stringify(body)));
    });

    it("returns paging sizes that match a later stringify of each page", () => {
        const body = {
            method: "transform",
            session_id: "ses-paged",
            input: Array.from({ length: 80 }, (_, index) => ({
                mid: `m${index}`,
                ordinal: index + 1,
                ck: { text: "x".repeat(8_000) },
            })),
        };
        expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(TEST_PAGE_MAX_BYTES);
        const pages = buildPagedModuleTransformPayloads(body, TEST_PAGE_MAX_BYTES);
        expect(pages.length).toBeGreaterThan(1);
        for (const { page, bytes } of pages) {
            expect(bytes).toBe(Buffer.byteLength(JSON.stringify(page)));
        }
    });

    it("content-addresses a cold page series so a completed result is adoptable", () => {
        const body = {
            method: "transform",
            session_id: "ses-adopt-completed",
            input: Array.from({ length: 80 }, (_, index) => ({
                mid: `m${index}`,
                ordinal: index + 1,
                ck: { text: "x".repeat(8_000) },
            })),
        };

        const first = buildPagedModuleTransformPayloads(body, TEST_PAGE_MAX_BYTES);
        const retry = buildPagedModuleTransformPayloads(structuredClone(body), TEST_PAGE_MAX_BYTES);
        const changed = buildPagedModuleTransformPayloads(
            {
                ...body,
                input: [...body.input, { mid: "changed", ordinal: 81, ck: { text: "changed" } }],
            },
            TEST_PAGE_MAX_BYTES,
        );
        const id = first[0]?.page.transform_page_id;

        expect(first.length).toBeGreaterThan(1);
        expect(retry.map(({ page }) => page.transform_page_id)).toEqual(
            first.map(({ page }) => page.transform_page_id),
        );
        expect(changed[0]?.page.transform_page_id).not.toBe(id);
    });

    it("pages a 30,000-entry tool-input key-order map and bounds the scalar tail", () => {
        const toolInputKeyOrders = Object.fromEntries(
            Array.from({ length: 30_000 }, (_, index) => [
                `msg_${index.toString(16).padStart(24, "0")}#0`,
                ["filePath", "oldString", "newString"],
            ]),
        );
        const body = {
            method: "transform",
            kind: "transform",
            v: 2,
            session_id: "ses-key-order-map",
            input: [],
            tool_input_key_orders: toolInputKeyOrders,
            usage: { current_total_input_tokens: 1, context_limit_tokens: 200_000 },
        };

        expect(Buffer.byteLength(JSON.stringify(toolInputKeyOrders))).toBeGreaterThan(
            TEST_PAGE_MAX_BYTES,
        );
        const pages = buildPagedModuleTransformPayloads(body, TEST_PAGE_MAX_BYTES);
        expect(pages.length).toBeGreaterThan(1);
        expect(pages.every(({ bytes }) => bytes <= TEST_PAGE_MAX_BYTES)).toBe(true);

        const reassembled = Object.assign(
            {},
            ...pages.map(({ page }) => page.tool_input_key_orders as Record<string, string[]>),
        );
        expect(reassembled).toEqual(toolInputKeyOrders);

        const complete = { ...pages.at(-1)?.page };
        for (const field of [
            "input",
            "messages",
            "native_messages",
            "ts_output",
            "ts_ck_messages",
            "normalizations",
            "tool_input_key_orders",
        ]) {
            delete complete[field];
        }
        expect(Buffer.byteLength(JSON.stringify(complete))).toBeLessThan(64 * 1024);
    });

    it("hashes map slices with the Rust canonical page digest", () => {
        expect(
            __moduleWireTest.transformPageDigest({
                messages: [{ mid: "m1", text: "hello" }],
                tool_input_key_orders: {
                    "m1#2": ["newString", "filePath"],
                    "m1#0": ["path", "content"],
                },
            }),
        ).toBe("db28d9596edc518ebe4131403a892c60868ee683f80c248e6c1c1a6f0e9bbf17");
    });

    it("names the five largest scalar fields when the tail cannot fit", () => {
        const body = {
            method: "transform",
            session_id: "ses-scalar-diagnostic",
            input: [],
            largest: "a".repeat(180_000),
            second: "b".repeat(160_000),
            third: "c".repeat(140_000),
            fourth: "d".repeat(120_000),
            fifth: "e".repeat(100_000),
            sixth: "f".repeat(80_000),
        };

        expect(() => buildPagedModuleTransformPayloads(body, TEST_PAGE_MAX_BYTES)).toThrow(
            "largest scalar fields: largest=180002 bytes, second=160002 bytes, third=140002 bytes, fourth=120002 bytes, fifth=100002 bytes",
        );
    });
});
