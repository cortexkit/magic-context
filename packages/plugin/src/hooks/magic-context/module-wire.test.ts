/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    buildPagedModuleTransformPayloads,
    encodeOpenCodeMessagesToCk,
    MODULE_PAGE_MAX_BYTES,
    resolveOrdinalsForModule,
} from "./module-wire";
import { setRawMessageProvider } from "./read-session-chunk";
import type { MessageLike } from "./transform-operations";

describe("encodeOpenCodeMessagesToCk", () => {
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

    it("reconciles provisional ordinals when the appended rows persist", async () => {
        const result = await resolveTail(2);
        try {
            result.persistedTail.push(
                { id: "m-501", timeCreated: 501, contributesOrdinal: true, hasValidInfo: true },
                { id: "m-502", timeCreated: 502, contributesOrdinal: true, hasValidInfo: true },
            );
            const reconciled = await resolveOrdinalsForModule({
                sessionId: result.sessionId,
                messages: result.messages,
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

describe("buildPagedModuleTransformPayloads byte reuse", () => {
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
        expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(MODULE_PAGE_MAX_BYTES);
        const pages = buildPagedModuleTransformPayloads(body);
        expect(pages.length).toBeGreaterThan(1);
        for (const { page, bytes } of pages) {
            expect(bytes).toBe(Buffer.byteLength(JSON.stringify(page)));
        }
    });
});
