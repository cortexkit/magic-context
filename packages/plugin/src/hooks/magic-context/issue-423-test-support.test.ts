import { describe, expect, test } from "bun:test";
import { acquireCompartmentLease } from "../../features/magic-context/compartment-lease";
import {
    appendCompartments,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import { getTagsBySession } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getEmergencyInputSample } from "../../features/magic-context/storage-meta-persisted";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { issue423Fixture, issue423ReasoningFixture } from "./issue-423-fixture";
import { resolveProtectedTailBoundary } from "./protected-tail-boundary";
import { setRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";
import { buildToolArcs, completedToolArcCrossesBoundary } from "./read-session-true-raw-tokens";
import type { MessageLike } from "./tag-messages";

type AnthropicWireMessage = { role?: string; content: Array<Record<string, unknown>> };

function serializeAnthropicWireWithAdjacentAssistantMerge(messages: MessageLike[]): string {
    const merged: MessageLike[] = [];
    for (const message of messages) {
        const previous = merged.at(-1);
        if (previous?.info.role === "assistant" && message.info.role === "assistant") {
            previous.parts.push(...message.parts);
        } else {
            merged.push(structuredClone(message));
        }
    }
    return JSON.stringify(
        merged.map((message) => ({
            role: message.info.role,
            content: message.parts.filter((part) => {
                if (part === null || typeof part !== "object") return true;
                const candidate = part as { type?: unknown; text?: unknown };
                return candidate.type !== "text" || candidate.text !== "";
            }),
        })),
    );
}

function isReasoningBlock(block: Record<string, unknown>): boolean {
    return ["thinking", "reasoning", "redacted_thinking"].includes(String(block.type));
}

export function issue423Boundary(
    sessionId: string,
    raw: RawMessage[],
    harness: "pi" | "opencode",
    percentage = 312,
) {
    const dispose = setRawMessageProvider(sessionId, { readMessages: () => raw });
    try {
        return resolveProtectedTailBoundary({
            sessionId,
            mode: harness === "pi" ? "pi-runner" : "incremental-runner",
            contextLimit: 204000,
            executeThresholdPercentage: 65,
            triggerBudget: 20000,
            usage: { percentage, inputTokens: 2040 * percentage },
            usageSource: "live",
            lastCompartmentEndOrdinal: 1,
            priorBoundaryOrdinal: 1,
            protectedTailPolicyVersion: 3,
            migrationFloorActive: false,
            providerShapeVersion: harness === "pi" ? "pi-folded-v1" : "opencode-v1",
            cacheNamespace: sessionId,
        });
    } finally {
        dispose();
    }
}

export function registerIssue423Tests(
    harness: "pi" | "opencode",
    adapter: {
        cleanup: (
            db: Database,
            sessionId: string,
            fixture: ReturnType<typeof issue423Fixture>,
            percentage: number,
        ) => number;
        raw: (fixture: ReturnType<typeof issue423Fixture>) => RawMessage[];
        anthropicMessages: (fixture: ReturnType<typeof issue423Fixture>) => MessageLike[];
    },
) {
    describe(`issue 423 ${harness} single-turn marathon`, () => {
        test("zero-drop pass stays armed and a later candidate batch reclaims", () => {
            const db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `issue423-zero-${harness}`;
            try {
                const growing = issue423Fixture();
                const initial = {
                    ...growing,
                    pi: structuredClone(growing.pi.slice(0, 32)),
                    opencode: structuredClone(growing.opencode.slice(0, 32)),
                };
                expect(adapter.cleanup(db, sessionId, initial, 85)).toBe(0);
                expect(getEmergencyInputSample(db, sessionId)).toBe(0);
                expect(adapter.cleanup(db, sessionId, growing, 312)).toBeGreaterThan(0);
                expect(getEmergencyInputSample(db, sessionId)).toBeGreaterThan(0);
                expect(adapter.cleanup(db, sessionId, issue423Fixture(), 90)).toBe(0);
                // A later absolute-emergency sample includes a fresh batch of outputs;
                // do not reuse the pre-drop input count as fixed overhead.
                expect(adapter.cleanup(db, sessionId, issue423Fixture(150), 95)).toBeGreaterThan(0);
            } finally {
                closeQuietly(db);
            }
        });
        test("95 percent yields recency protection but retains open arc and three exemplars", () => {
            const db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `issue423-protection-${harness}`;
            try {
                const fixture = issue423Fixture(15);
                expect(adapter.cleanup(db, sessionId, fixture, 95)).toBeGreaterThan(0);
                // Pi tags open invocations, but neither harness may remove them before a result exists.
                expect(JSON.stringify(harness === "pi" ? fixture.pi : fixture.opencode)).toContain(
                    "call-15",
                );
                const tools = getTagsBySession(db, sessionId).filter((tag) => tag.type === "tool");
                expect(
                    tools.filter((tag) => tag.status === "active").map((tag) => tag.messageId),
                ).toEqual(
                    harness === "pi"
                        ? ["call-12", "call-13", "call-14", "call-15"]
                        : ["call-12", "call-13", "call-14"],
                );
                expect(
                    tools
                        .filter((tag) => tag.status === "dropped")
                        .every((tag) => tag.dropMode === "full"),
                ).toBe(true);
            } finally {
                closeQuietly(db);
            }
        });
        test("95 percent skeletonizes reasoning-bearing arcs before Anthropic same-role merge", () => {
            const db = new Database(":memory:");
            initializeDatabase(db);
            const sessionId = `issue423-reasoning-seam-${harness}`;
            try {
                const fixture = issue423ReasoningFixture();
                expect(adapter.cleanup(db, sessionId, fixture, 95)).toBeGreaterThan(0);
                const droppedTools = getTagsBySession(db, sessionId).filter(
                    (tag) => tag.type === "tool" && tag.status === "dropped",
                );
                expect(droppedTools.length).toBeGreaterThan(0);
                expect(droppedTools.every((tag) => tag.dropMode === "skeleton_real")).toBe(true);

                const wire = JSON.parse(
                    serializeAnthropicWireWithAdjacentAssistantMerge(
                        adapter.anthropicMessages(fixture),
                    ),
                ) as AnthropicWireMessage[];
                const toolUses = new Set<string>();
                const toolResults = new Set<string>();
                let reasoningBlocks = 0;
                let hasAdjacentReasoning = false;
                for (const message of wire) {
                    for (let index = 0; index < message.content.length; index += 1) {
                        const block = message.content[index];
                        if (isReasoningBlock(block)) reasoningBlocks += 1;
                        if (block.type === "tool_use" && typeof block.id === "string") {
                            toolUses.add(block.id);
                        }
                        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
                            toolResults.add(block.tool_use_id);
                        }
                        if (
                            message.role === "assistant" &&
                            index > 0 &&
                            isReasoningBlock(message.content[index - 1]!) &&
                            isReasoningBlock(block)
                        ) {
                            hasAdjacentReasoning = true;
                        }
                    }
                }
                expect(toolUses.size).toBeGreaterThan(0);
                expect([...toolUses].every((callId) => toolResults.has(callId))).toBe(true);
                expect(reasoningBlocks).toBeGreaterThan(1);
                expect(hasAdjacentReasoning).toBe(false);
            } finally {
                closeQuietly(db);
            }
        });
        test("uniform 120-tool single turn already has a force-band head", () => {
            const raw = adapter.raw(issue423Fixture());
            const boundary = issue423Boundary(`issue423-uniform-${harness}`, raw, harness, 85);
            expect(boundary.eligibleEndOrdinal).toBeGreaterThan(boundary.offset);
            expect(
                buildToolArcs(raw).some(
                    (arc) =>
                        arc.resOrdinal !== null &&
                        completedToolArcCrossesBoundary(
                            arc.invOrdinal,
                            arc.resOrdinal,
                            boundary.eligibleEndOrdinal,
                        ),
                ),
            ).toBe(false);
        });
        test("oversized first completed arc cannot collapse the force-band head to offset", () => {
            // Only text and tool inputs count toward the cap; a large write
            // keeps this an oversized arc even though its result is ordinary.
            const raw = adapter.raw(issue423Fixture(120, 1, 30));
            const boundary = issue423Boundary(`issue423-atomic-${harness}`, raw, harness);
            expect(boundary.protectedTailStart).toBeGreaterThan(3);
            expect(boundary.eligibleEndOrdinal).toBe(4);
            expect(boundary.oversizeAtomicUnit).toBe(true);
            expect(
                buildToolArcs(raw).some(
                    (arc) =>
                        arc.resOrdinal !== null &&
                        completedToolArcCrossesBoundary(
                            arc.invOrdinal,
                            arc.resOrdinal,
                            boundary.eligibleEndOrdinal,
                        ),
                ),
            ).toBe(false);
        });
    });
}

export function registerIssue423HistorianTest(
    harness: "pi" | "opencode",
    run: (args: {
        db: Database;
        sessionId: string;
        raw: RawMessage[];
        boundary: ReturnType<typeof issue423Boundary>;
        xml: string;
        holderId: string;
    }) => Promise<void>,
    rawForFixture: (fixture: ReturnType<typeof issue423Fixture>) => RawMessage[],
) {
    test(`issue 423 ${harness} historian publishes the first completed arc of a single turn`, async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = `issue423-publish-${harness}`;
        const raw = rawForFixture(issue423Fixture(120, 1, 30));
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 1,
                startMessageId: "m1",
                endMessageId: "m1",
                title: "Request",
                content: "The user requested an autonomous investigation.",
            },
        ]);
        const boundary = issue423Boundary(sessionId, raw, harness);
        const dispose = setRawMessageProvider(sessionId, { readMessages: () => raw });
        const holderId = `holder-${harness}`;
        expect(acquireCompartmentLease(db, sessionId, holderId)).not.toBeNull();
        try {
            await run({
                db,
                sessionId,
                raw,
                boundary,
                holderId,
                xml: '<compartment start="2" end="3" title="First completed inspection"><p1>Inspected the first file and received the complete output.</p1></compartment>',
            });
            expect(
                getCompartments(db, sessionId).map((c) => [c.startMessage, c.endMessage]),
            ).toEqual([
                [1, 1],
                [2, 3],
            ]);
        } finally {
            dispose();
            closeQuietly(db);
        }
    });
}
