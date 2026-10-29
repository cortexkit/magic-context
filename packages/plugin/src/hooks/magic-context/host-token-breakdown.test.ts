import { describe, expect, spyOn, test } from "bun:test";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import {
    recordToolDefinition,
    recordToolDefinitionSet,
} from "../../features/magic-context/tool-definition-tokens";
import { Database } from "../../shared/sqlite";
import {
    HOST_BREAKDOWN_KEY,
    HostTokenMeasurementCache,
    persistHostTokenBreakdown,
    scheduleHostTokenBreakdown,
} from "./host-token-breakdown";
import { computeM0BlockTokens } from "./m0-token-breakdown";
import * as tokenCount from "./token-count-exact";

export const drainHostBreakdown = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("host pass token breakdown", () => {
    for (const generation of ["OpenCode 1", "OpenCode 2"]) {
        test(`${generation} reuses request tool counts, persists once, and accumulates threshold changes`, async () => {
            const db = new Database(":memory:");
            initializeDatabase(db);
            const session = `host-breakdown-${generation}`;
            getOrCreateSessionMeta(db, session);
            const schema = {
                id: "read",
                description: `Read a file ${generation}`,
                parameters: { type: "object" },
            };
            if (generation === "OpenCode 1")
                recordToolDefinition(
                    "anthropic",
                    "opus",
                    "build",
                    schema.id,
                    schema.description,
                    schema.parameters,
                    session,
                );
            else recordToolDefinitionSet("anthropic", "opus", "build", [schema], session);
            const m0 = `<project-docs>host pass docs ${generation}</project-docs><user-profile>host pass profile ${generation}</user-profile><project-memory>host pass memory ${generation}</project-memory><session-history>host pass history ${generation}</session-history>`;
            updateSessionMeta(db, session, {
                cachedM0Bytes: Buffer.from(m0),
                conversationTokens: 50_000,
                toolCallTokens: 80_000,
            });
            const saved = () =>
                db
                    .prepare(
                        "SELECT value FROM session_render_cache WHERE session_id=? AND cache_key=?",
                    )
                    .get(session, HOST_BREAKDOWN_KEY) as { value: string } | null;
            const writes = () =>
                (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
            const pass = { measuredAt: 123, conversationTokens: 50_000, toolCallTokens: 80_000 };
            const encode = spyOn(tokenCount, "countTokensExactly");
            try {
                scheduleHostTokenBreakdown(db, session, pass);
                expect(saved()).toBeNull();
                expect(encode).not.toHaveBeenCalled();
                await drainHostBreakdown();
                expect(encode).toHaveBeenCalledTimes(4);
                const first = saved()!.value;
                const parts = JSON.parse(first).parts;
                expect(parts.tool_definitions).toBeGreaterThan(0);
                expect(parts.project_docs).toBeGreaterThan(0);
                expect(parts.user_profile).toBeGreaterThan(0);
                expect(parts.history_raw).toBeLessThan(50_000);
                expect(parts.tool_calls_results).toBe(80_000);
                expect(parts.last_user_message).toBe(0);
                encode.mockClear();
                const before = writes();
                scheduleHostTokenBreakdown(db, session, { ...pass, measuredAt: 124 });
                await drainHostBreakdown();
                expect(saved()!.value).toBe(first);
                expect(writes()).toBe(before);
                expect(encode).not.toHaveBeenCalled();
                computeM0BlockTokens(db, session, {
                    m0Text: m0,
                    projectIdentity: undefined,
                    injectionBudgetTokens: undefined,
                    memoryBlockCount: 0,
                });
                expect(encode).not.toHaveBeenCalled();
                expect(
                    persistHostTokenBreakdown(db, session, {
                        ...pass,
                        measuredAt: 125,
                        toolDefinitionTokens: parts.tool_definitions,
                        toolCallTokens: 80_500,
                    }),
                ).toBe(false);
                expect(writes()).toBe(before);
                expect(
                    persistHostTokenBreakdown(db, session, {
                        ...pass,
                        measuredAt: 126,
                        toolDefinitionTokens: parts.tool_definitions,
                        toolCallTokens: 80_501,
                    }),
                ).toBe(true);
                expect(JSON.parse(saved()!.value).measured_at).toBe(126);
            } finally {
                encode.mockRestore();
                db.close();
            }
        });
    }

    test("one percent can trigger before 500 tokens and missing measurements remain null", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        getOrCreateSessionMeta(db, "small");
        try {
            const pass = { measuredAt: 1, conversationTokens: 1000, toolCallTokens: 1000 };
            expect(persistHostTokenBreakdown(db, "small", pass)).toBe(true);
            expect(
                persistHostTokenBreakdown(db, "small", {
                    ...pass,
                    measuredAt: 2,
                    conversationTokens: 1010,
                }),
            ).toBe(false);
            expect(
                persistHostTokenBreakdown(db, "small", {
                    ...pass,
                    measuredAt: 3,
                    conversationTokens: 1011,
                }),
            ).toBe(true);
            const row = db
                .prepare(
                    "SELECT value FROM session_render_cache WHERE session_id='small' AND cache_key=?",
                )
                .get(HOST_BREAKDOWN_KEY) as { value: string };
            expect(JSON.parse(row.value).parts.tool_definitions).toBeNull();
            expect(persistHostTokenBreakdown(db, "small", { ...pass, measuredAt: 2 })).toBe(false);
        } finally {
            db.close();
        }
    });

    test("hash cache measures a changed block or tool set once", () => {
        let calls = 0;
        const cache = new HostTokenMeasurementCache((text) => {
            calls++;
            return text.length;
        });
        expect(cache.text("docs")).toBe(4);
        expect(cache.text("docs")).toBe(4);
        expect(cache.tools(["schema"])).toBe(6);
        expect(cache.tools(["schema"])).toBe(6);
        expect(calls).toBe(2);
        expect(cache.text("new docs")).toBe(8);
        expect(cache.tools(["schema", "new schema"])).toBe(16);
        expect(calls).toBe(4);
    });
});
