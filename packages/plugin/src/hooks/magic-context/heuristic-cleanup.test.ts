/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getTagsBySession, insertTag } from "../../features/magic-context/storage";
import {
    clearEmergencyDropSample,
    getEmergencyInputSample,
} from "../../features/magic-context/storage-meta-persisted";
import { Database } from "../../shared/sqlite";
import { estimateMessageTokens } from "./final-wire-token-estimate";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import { estimateTokens } from "./read-session-formatting";
import type { MessageLike, TagTarget } from "./tag-messages";
import { createToolDropTarget, type ToolCallIndex, ToolMutationBatch } from "./tool-drop-target";

function makeMemoryDatabase(): Database {
    const d = new Database(":memory:");
    d.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      message_id TEXT,
      type TEXT,
      status TEXT DEFAULT 'active',
      drop_mode TEXT DEFAULT 'full',
      tool_name TEXT,
      input_byte_size INTEGER DEFAULT 0,
      byte_size INTEGER,
      tag_number INTEGER NOT NULL,
      reasoning_byte_size INTEGER NOT NULL DEFAULT 0,
      caveman_depth INTEGER NOT NULL DEFAULT 0,
            harness TEXT NOT NULL DEFAULT 'opencode',
      tool_owner_message_id TEXT DEFAULT NULL,
      entry_fingerprint TEXT,
      token_count INTEGER,
      input_token_count INTEGER,
      reasoning_token_count INTEGER,
      UNIQUE(session_id, id)
    );
    CREATE TABLE IF NOT EXISTS pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tag_id INTEGER,
      operation TEXT,
      queued_at INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      last_response_time INTEGER,
      cache_ttl TEXT,
      counter INTEGER DEFAULT 0,
      last_nudge_tokens INTEGER DEFAULT 0,
      last_nudge_band TEXT DEFAULT '',
      last_transform_error TEXT DEFAULT '',
      is_subagent INTEGER DEFAULT 0,
      last_context_percentage REAL DEFAULT 0,
      last_input_tokens INTEGER DEFAULT 0,
      observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_alert_sent INTEGER NOT NULL DEFAULT 0,
      times_execute_threshold_reached INTEGER DEFAULT 0,
      compartment_in_progress INTEGER DEFAULT 0,
      historian_failure_count INTEGER DEFAULT 0,
      historian_last_error TEXT DEFAULT NULL,
      historian_last_failure_at INTEGER DEFAULT NULL,
      system_prompt_hash INTEGER DEFAULT 0,
      system_prompt_tokens INTEGER DEFAULT 0,
      conversation_tokens INTEGER DEFAULT 0,
      tool_call_tokens INTEGER DEFAULT 0,
      cleared_reasoning_through_tag INTEGER DEFAULT 0,
      last_emergency_input_sample INTEGER DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
  `);
    return d;
}

function makeTarget(message: { parts: unknown[] }): TagTarget {
    return {
        message: message as TagTarget["message"],
        measureReclaim: (skeleton) => {
            const part = message.parts.find((p: any) => p.type === "tool") as
                | { state?: { output?: string } }
                | undefined;
            return {
                beforeTools: estimateTokens(part?.state?.output ?? ""),
                afterTools: skeleton ? estimateTokens("[dropped]") : 0,
                beforeProse: 0,
                afterProse: 0,
            };
        },
        setContent: (content: string) => {
            const textPart = message.parts.find((p: any) => p.type === "text") as any;
            if (!textPart) return false;
            if (textPart.text === content) return false;
            textPart.text = content;
            return true;
        },
        drop: () => {
            const idx = message.parts.findIndex((p: any) => p.type === "tool");
            if (idx >= 0) {
                message.parts.splice(idx, 1);
                return "removed" as const;
            }
            return "absent" as const;
        },
        // Mirrors the real target: droppable iff there's a tool part present
        // (drop() would return "removed"). The emergency planner filters on this.
        canDrop: () => message.parts.some((p: any) => p.type === "tool"),
        truncate: () => {
            const toolPart = message.parts.find((p: any) => p.type === "tool") as
                | {
                      state?: {
                          input?: Record<string, unknown>;
                          output?: unknown;
                      };
                  }
                | undefined;
            if (!toolPart?.state) return "absent" as const;

            toolPart.state.output = "[truncated]";
            const inputSize = toolPart.state.input
                ? JSON.stringify(toolPart.state.input).length
                : 0;
            if (toolPart.state.input && inputSize > 500) {
                for (const key of Object.keys(toolPart.state.input)) {
                    const value = toolPart.state.input[key];
                    if (typeof value === "string") {
                        toolPart.state.input[key] =
                            value.length > 5 ? `${value.slice(0, 5)}...[truncated]` : value;
                    } else if (Array.isArray(value)) {
                        toolPart.state.input[key] = `[${value.length} items]`;
                    } else if (value !== null && typeof value === "object") {
                        toolPart.state.input[key] = "[object]";
                    }
                }
            }

            return "truncated" as const;
        },
    };
}

function buildMessageTagNumbers(
    entries: [number, { parts: unknown[] }][],
): Map<MessageLike, number> {
    const map = new Map<MessageLike, number>();
    for (const [tagNumber, msg] of entries) {
        map.set({ info: { role: "assistant" }, parts: msg.parts } as MessageLike, tagNumber);
    }
    return map;
}

describe("applyHeuristicCleanup", () => {
    const SESSION = "ses_test";
    let db: Database;

    beforeEach(() => {
        db = makeMemoryDatabase();
    });

    afterEach(() => {
        db.close();
    });

    describe("#given reasoning with actual content", () => {
        describe("#when executing heuristic cleanup", () => {
            it("#then preserves non-cleared reasoning", () => {
                //#given
                insertTag(db, SESSION, "msg-1", "message", 500, 1);
                const msg = {
                    parts: [
                        { type: "reasoning", text: "I need to think about this carefully..." },
                        { type: "text", text: "my response" },
                    ],
                };
                const targets = new Map<number, TagTarget>();
                targets.set(1, makeTarget(msg));

                //#when
                applyHeuristicCleanup(SESSION, db, targets, buildMessageTagNumbers([[1, msg]]), {
                    protectedTagNumbers: new Set(),
                    protectedCutoff: null,
                });

                //#then — reasoning preserved because it has real content
                expect(msg.parts).toHaveLength(2);
            });
        });
    });

    describe("#given the tiered emergency drop config (>=85% pass)", () => {
        it("credits the image stripped from a recent tool skeleton at the force band", () => {
            const pngHeader = Buffer.from(
                "89504e470d0a1a0a0000000d49484452000007d0000005dc",
                "hex",
            );
            const part = {
                type: "tool",
                tool: "screenshot",
                callID: "image-call",
                state: {
                    status: "completed",
                    input: {},
                    output: "x",
                    attachments: [
                        {
                            type: "file",
                            mime: "image/png",
                            url: `data:image/png;base64,${pngHeader.toString("base64")}`,
                        },
                    ],
                },
            };
            const message: MessageLike = {
                info: { id: "assistant", role: "assistant" },
                parts: [part],
            };
            const index: ToolCallIndex = new Map([
                [
                    part.callID,
                    { hasResult: true, occurrences: [{ message, part, kind: "result" }] },
                ],
            ]);
            const target = createToolDropTarget(
                part.callID,
                [],
                index,
                new ToolMutationBatch([message]),
                1,
            );
            insertTag(db, SESSION, part.callID, "tool", 1, 1, 0, part.tool);
            const before = estimateMessageTokens(message).toolCall;

            const result = applyHeuristicCleanup(SESSION, db, new Map([[1, target]]), new Map(), {
                protectedTagNumbers: new Set(),
                protectedCutoff: null,
                emergency: {
                    currentTotalInputTokens: 9000,
                    ceilingTokens: 7000,
                    usagePercentage: 90,
                },
            });

            expect(result.emergencyDroppedTools).toBe(1);
            expect(getTagsBySession(db, SESSION)[0]?.dropMode).toBe("skeleton_stripped");
            expect(message.parts[0]).toMatchObject({
                state: { input: {}, attachments: [], output: "[dropped \u00a71\u00a7]" },
            });
            expect(result.emergencyReclaimedTokens).toBe(
                before - estimateMessageTokens(message).toolCall,
            );
        });

        it("#then drops oldest tool outputs down to the reclaim target, full-drop", () => {
            //#given a tail of large tool outputs well over the ceiling. fixedFloor is
            // derived as currentTotalInputTokens - Σ(active tag tokens), so with only
            // tool tags here, fixedFloor≈0 and the target is 30% of the ceiling.
            for (let i = 1; i <= 10; i++) {
                insertTag(db, SESSION, `call-${i}`, "tool", 4000, i, 0, "bash");
            }
            const targets = new Map<number, TagTarget>();
            for (let i = 1; i <= 10; i++) {
                targets.set(
                    i,
                    makeTarget({
                        parts: [
                            {
                                type: "tool",
                                tool: "bash",
                                state: { output: "word ".repeat(999), status: "completed" },
                            },
                        ],
                    }),
                );
            }

            //#when ten measured 1000-token outputs make 10000 tokens of tail; usage 10000,
            // ceiling 6000 → target = 0 + 0.30×6000 = 1800 → reclaim ≈ 8200 tokens.
            const result = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                protectedTagNumbers: new Set([9, 10]),
                protectedCutoff: 9,
                emergency: {
                    currentTotalInputTokens: 10_000,
                    ceilingTokens: 6_000,
                    usagePercentage: 95,
                },
            });

            //#then the >=95% backstop yields the token window and drops oldest-first until the target is met.
            expect(result.droppedTools).toBe(9);
            const tags = getTagsBySession(db, SESSION);
            const dropped = tags
                .filter((t) => t.status === "dropped")
                .map((t) => t.tagNumber)
                .sort((a, b) => a - b);
            // Nine 1k-token drops are needed to exceed the 8.2k reclaim target;
            // tag 10 survives because selection stops once that target is met.
            expect(dropped).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
            expect(tags.find((tag) => tag.tagNumber === 10)?.status).toBe("active");
            expect(
                tags.filter((t) => t.status === "dropped").every((t) => t.dropMode === "full"),
            ).toBe(true);
        });

        it("#then clears the sample latch after abort so the retry drops more", () => {
            for (let i = 1; i <= 20; i++) {
                insertTag(db, SESSION, `abort-call-${i}`, "tool", 4000, i, 0, "bash");
            }
            const targets = new Map<number, TagTarget>();
            for (let i = 1; i <= 20; i++) {
                targets.set(
                    i,
                    makeTarget({
                        parts: [
                            {
                                type: "tool",
                                tool: "bash",
                                state: { output: "word ".repeat(999), status: "completed" },
                            },
                        ],
                    }),
                );
            }
            const emergency = { currentTotalInputTokens: 20_000, ceilingTokens: 20_000 };

            const first = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                protectedTagNumbers: new Set(),
                protectedCutoff: null,
                emergency,
            });
            expect(first.emergencyDroppedTools).toBeGreaterThan(0);
            expect(getEmergencyInputSample(db, SESSION)).toBe(20_000);

            const latched = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                protectedTagNumbers: new Set(),
                protectedCutoff: null,
                emergency,
            });
            expect(latched.emergencyDroppedTools).toBe(0);

            // A confirmed fail-closed abort cannot produce the fresh provider
            // sample the latch normally waits for, so the abort path releases it.
            clearEmergencyDropSample(db, SESSION);
            const retry = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                protectedTagNumbers: new Set(),
                protectedCutoff: null,
                emergency,
            });
            expect(retry.emergencyDroppedTools).toBeGreaterThan(0);
        });

        it("#then is a no-op when already under target (reclaim <= 0)", () => {
            insertTag(db, SESSION, "call-1", "tool", 4000, 1, 0, "bash");
            insertTag(db, SESSION, "m-2", "message", 500, 2);
            const targets = new Map<number, TagTarget>([
                [
                    1,
                    makeTarget({
                        parts: [{ type: "tool", tool: "bash", state: { output: "x" } }],
                    }),
                ],
            ]);
            // usage 1000 well under ceiling 100000 → reclaim negative → no-op.
            const result = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                protectedTagNumbers: new Set(),
                protectedCutoff: null,
                emergency: { currentTotalInputTokens: 1_000, ceilingTokens: 100_000 },
            });
            expect(result.droppedTools).toBe(0);
        });

        it("#then does nothing when no emergency config is supplied (routine pass)", () => {
            for (let i = 1; i <= 5; i++) {
                insertTag(db, SESSION, `call-${i}`, "tool", 4000, i, 0, "bash");
            }
            const targets = new Map<number, TagTarget>();
            for (let i = 1; i <= 5; i++) {
                targets.set(
                    i,
                    makeTarget({ parts: [{ type: "tool", tool: "bash", state: { output: "x" } }] }),
                );
            }
            const result = applyHeuristicCleanup(SESSION, db, targets, new Map(), {
                protectedTagNumbers: new Set(),
                protectedCutoff: null,
            });
            // No routine tool drops anymore — only dedup/injection-strip run.
            expect(result.droppedTools).toBe(0);
        });
    });

    /**
     * v3.3.1 Layer C — plan §5 / Finding 1: composite-key dedup tests.
     *
     * Pre-fix the dedup pass keyed both sides (tag map + fingerprint
     * map) by bare callId and used an owner-blind fingerprint string.
     * Two assistant turns with same `(toolName, args)` and same callId
     * from different owners would share a fingerprint bucket and be
     * silently merged — even though they're semantically distinct
     * invocations. Post-fix both sides include `ownerMsgId` so cross-
     * owner pairs produce different fingerprints and are NOT merged.
     */
    describe("#given composite-key dedup (v3.3.1 Layer C)", () => {
        function buildMessageWithId(
            id: string,
            parts: unknown[],
        ): MessageLike & { info: { id: string; role: string } } {
            return { info: { id, role: "assistant" }, parts };
        }

        it("does NOT merge cross-owner pairs with same (toolName, args, callId)", () => {
            //#given — two assistant messages with same dedup-safe tool
            // call (mcp_grep, same args) AND same callId, but different
            // owners. With composite identity each turn gets its own
            // tag (Layer A row uniqueness) and the dedup pass must NOT
            // merge them.
            insertTag(db, SESSION, "read:32", "tool", 1000, 50, 0, "mcp_grep", 0, "m-asst-1");
            insertTag(db, SESSION, "read:32", "tool", 2000, 60, 0, "mcp_grep", 0, "m-asst-2");

            const msgA = buildMessageWithId("m-asst-1", [
                {
                    type: "tool",
                    tool: "mcp_grep",
                    callID: "read:32",
                    state: { input: { pattern: "x" }, output: "result-1", status: "completed" },
                },
            ]);
            const msgB = buildMessageWithId("m-asst-2", [
                {
                    type: "tool",
                    tool: "mcp_grep",
                    callID: "read:32",
                    state: { input: { pattern: "x" }, output: "result-2", status: "completed" },
                },
            ]);

            const targets = new Map<number, TagTarget>([
                [50, makeTarget(msgA)],
                [60, makeTarget(msgB)],
            ]);
            const messageTagNumbers = new Map<MessageLike, number>();
            messageTagNumbers.set(msgA, 50);
            messageTagNumbers.set(msgB, 60);

            const result = applyHeuristicCleanup(SESSION, db, targets, messageTagNumbers, {
                protectedTagNumbers: new Set(),
                protectedCutoff: null,
            });

            //#then — neither tag is deduplicated (cross-owner pair).
            expect(result.deduplicatedTools).toBe(0);
            const tags = getTagsBySession(db, SESSION);
            expect(tags.find((t) => t.tagNumber === 50)?.status).toBe("active");
            expect(tags.find((t) => t.tagNumber === 60)?.status).toBe("active");
        });

        it("DOES merge same-owner duplicates with different callIds (Pi parallel-tool-calls shape)", () => {
            //#given — two tool calls within the SAME assistant message
            // (Pi parallel tool calls): same toolName, same args,
            // different callIds. The composite keys differ (different
            // callIds) but the fingerprint matches (same owner +
            // toolName + args). Dedup pass must merge — older dropped,
            // newer kept.
            insertTag(db, SESSION, "call-A", "tool", 1000, 70, 0, "mcp_grep", 0, "m-asst");
            insertTag(db, SESSION, "call-B", "tool", 2000, 80, 0, "mcp_grep", 0, "m-asst");

            const msg = buildMessageWithId("m-asst", [
                {
                    type: "tool",
                    tool: "mcp_grep",
                    callID: "call-A",
                    state: { input: { pattern: "y" }, output: "r1", status: "completed" },
                },
                {
                    type: "tool",
                    tool: "mcp_grep",
                    callID: "call-B",
                    state: { input: { pattern: "y" }, output: "r2", status: "completed" },
                },
            ]);

            const targets = new Map<number, TagTarget>([
                [70, makeTarget(msg)],
                [80, makeTarget(msg)],
            ]);
            const messageTagNumbers = new Map<MessageLike, number>();
            messageTagNumbers.set(msg, 80); // newest

            const result = applyHeuristicCleanup(SESSION, db, targets, messageTagNumbers, {
                protectedTagNumbers: new Set(),
                protectedCutoff: null,
            });

            //#then — older tag dropped, newer kept.
            expect(result.deduplicatedTools).toBe(1);
            const tags = getTagsBySession(db, SESSION);
            expect(tags.find((t) => t.tagNumber === 70)?.status).toBe("dropped");
            expect(tags.find((t) => t.tagNumber === 80)?.status).toBe("active");
        });

        it("does not count an absent dedup target as a confirmed mutation", () => {
            insertTag(db, SESSION, "call-A", "tool", 1000, 90, 0, "mcp_grep", 0, "m-asst");
            insertTag(db, SESSION, "call-B", "tool", 2000, 100, 0, "mcp_grep", 0, "m-asst");

            const msg = buildMessageWithId("m-asst", [
                {
                    type: "tool",
                    tool: "mcp_grep",
                    callID: "call-A",
                    state: { input: { pattern: "z" }, output: "r1", status: "completed" },
                },
                {
                    type: "tool",
                    tool: "mcp_grep",
                    callID: "call-B",
                    state: { input: { pattern: "z" }, output: "r2", status: "completed" },
                },
            ]);

            const targets = new Map<number, TagTarget>([[100, makeTarget(msg)]]);
            const messageTagNumbers = new Map<MessageLike, number>();
            messageTagNumbers.set(msg, 100);

            const result = applyHeuristicCleanup(SESSION, db, targets, messageTagNumbers, {
                protectedTagNumbers: new Set(),
                protectedCutoff: null,
            });

            expect(result.deduplicatedTools).toBe(0);
            expect(getTagsBySession(db, SESSION).find((t) => t.tagNumber === 90)?.status).toBe(
                "dropped",
            );
        });
    });
});
