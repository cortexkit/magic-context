import { afterEach, expect, it, spyOn } from "bun:test";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    getMergedReasoningStrippedIds,
    recordDetectedContextLimit,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import * as logger from "../../shared/logger";
import { createTestTempDir } from "../../shared/test-temp-dir";
import {
    clearCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
} from "./ctx-reduce-availability";
import * as hostServedRows from "./host-served-rows";
import * as injection from "./inject-compartments";
import { closeReadOnlySessionDb } from "./read-session-db";
import { observeSignedThinkingFitSnapshotForTests } from "./signed-thinking-fit-snapshot";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";

const REFUSAL =
    "The request remains over the model window after stripping signed thinking and reclaiming context";

afterEach(() => observeSignedThinkingFitSnapshotForTests(undefined));

function rng(seed: number) {
    let state = (seed * 2654435761) >>> 0 || 1;
    return () => {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state / 4294967296;
    };
}

type Usage = { percentage: number; inputTokens: number };

/** A real transform over an isolated store, with a 16K window so large tool output overflows it. */
function session(
    name: string,
    model: { providerID: string; modelID: string },
    compactionOff = false,
) {
    const root = createTestTempDir("signed-fit-snapshot-");
    const sessionId = `signed-fit-snapshot-${name}`;
    const db = openDatabase(`${root.dir}/context.db`)!;
    let now = Date.parse("2026-10-27T10:00:00Z");
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "never", lastResponseTime: now });
    recordDetectedContextLimit(db, sessionId, 16_000, `${model.providerID}/${model.modelID}`);
    updateSessionMeta(db, sessionId, { systemPromptTokens: 100, systemPromptHash: "fit-system" });
    recordToolDefinition(model.providerID, model.modelID, undefined, "read", "Read a file", {
        type: "object",
    });
    const usage = new Map<string, { usage: Usage; updatedAt: number; hasUsageTokens: boolean }>();
    const control = { decision: "defer" as "execute" | "defer" };
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: { shouldExecute: () => control.decision },
        contextUsageMap: usage,
        liveModelBySession: new Map([[sessionId, model]]),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        directory: root.dir,
        protectedTokens: 0,
        clearReasoningAge: 0,
        historianRunnable: false,
        compactionOff,
    });
    let counter = 0;
    const user = (): MessageLike => ({
        info: {
            id: `user-${String(counter++).padStart(4, "0")}`,
            role: "user",
            sessionID: sessionId,
        },
        parts: [{ type: "text", text: `Request ${counter}: continue.` }],
    });
    const step = (options: { heavy: boolean; output: string; last?: boolean }): MessageLike =>
        ({
            info: {
                id: `asst-${String(counter++).padStart(4, "0")}`,
                role: "assistant",
                sessionID: sessionId,
                ...model,
                finish: options.last ? "stop" : "tool-calls",
                tokens: {
                    input: 0,
                    output: options.heavy ? 1_800 : 120,
                    reasoning: options.heavy ? 1_800 : 120,
                },
            },
            parts: [
                {
                    type: "reasoning",
                    text: options.heavy ? "Heavy reasoning. ".repeat(400) : `Thought ${counter}.`,
                    metadata: { anthropic: { signature: `sig-${counter}` } },
                },
                {
                    type: "tool",
                    tool: "read",
                    callID: `call-${counter}`,
                    state: {
                        status: "completed",
                        input: { filePath: `/repo/file-${counter}.ts` },
                        output: options.output,
                        time: { start: 1, end: 2 },
                    },
                },
            ],
        }) as MessageLike;
    return {
        sessionId,
        db,
        transform,
        control,
        user,
        step,
        setUsage(percentage: number) {
            now += 5_000;
            usage.set(sessionId, {
                usage: { percentage, inputTokens: Math.round(160 * percentage) },
                updatedAt: now,
                hasUsageTokens: true,
            });
        },
        cleanup() {
            clock.mockRestore();
            injection.clearInjectionCache(sessionId);
            clearCtxReduceAvailability(sessionId);
            closeReadOnlySessionDb();
            closeDatabase();
            __resetToolDefinitionMeasurements();
            root.cleanup();
        },
    };
}

/** Plain JSON plus each message's covered-instruction mark, which JSON leaves out. */
function inputImage(messages: readonly MessageLike[]): string {
    return JSON.stringify(
        messages.map((message) => ({
            message,
            covered: hostServedRows.isCoveredInstructionRow(message.info),
        })),
    );
}

it("a held Anthropic signed-thinking pass always has a snapshot equal to its input as handed over", async () => {
    const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };
    const s = session("superset", model);
    const random = rng(798);
    let expected = "";
    const observations: Array<{
        held: boolean;
        activeAnthropicThinkingTurn: boolean;
        compactionOff: boolean;
        snapshot: string | null;
        expected: string;
    }> = [];
    observeSignedThinkingFitSnapshotForTests((observation) => {
        observations.push({
            held: observation.held,
            activeAnthropicThinkingTurn: observation.activeAnthropicThinkingTurn,
            compactionOff: observation.compactionOff,
            snapshot:
                observation.snapshot === null
                    ? null
                    : inputImage(observation.snapshot as MessageLike[]),
            expected,
        });
    });
    try {
        resolveCtxReduceAvailabilityFromMessages(s.sessionId, [s.user()] as never);
        const rows: MessageLike[] = [s.user()];
        for (let pass = 0; pass < 60; pass++) {
            const roll = random();
            if (roll < 0.15)
                rows.push(s.step({ heavy: false, output: "done", last: true }), s.user());
            else
                rows.push(
                    s.step({
                        heavy: random() < 0.6,
                        output:
                            random() < 0.25
                                ? "RECLAIMABLE tool result words ".repeat(8_000)
                                : `Small result ${pass}`,
                    }),
                );
            s.control.decision = random() < 0.5 ? "execute" : "defer";
            s.setUsage([20, 50, 70, 74.9, 80, 96][Math.floor(random() * 6)]!);
            const messages = structuredClone(rows);
            // A restored instruction row (as OpenCode 2's hook adds them) at a
            // random position: the transform sets it aside before any stage,
            // and the snapshot must still hold it, marked, where it came in.
            if (random() < 0.3) {
                const row = hostServedRows.markCoveredInstructionRow({ role: "system" });
                messages.splice(Math.floor(random() * messages.length), 0, {
                    info: row,
                    parts: [{ type: "text", text: "Instruction restored by the host hook." }],
                } as MessageLike);
            }
            expected = inputImage(messages);
            // Over-window passes may be refused; the snapshot is taken before that.
            await s.transform({}, { messages }).catch(() => undefined);
        }
        const held = observations.filter(
            (o) => o.held && o.activeAnthropicThinkingTurn && !o.compactionOff,
        );
        // The property is about held passes; make sure the run produced them,
        // and unheld ones too.
        expect(held.length).toBeGreaterThan(5);
        expect(observations.length - held.length).toBeGreaterThan(5);
        for (const observation of held) {
            expect(observation.snapshot).not.toBeNull();
            expect(observation.snapshot).toBe(observation.expected);
        }
        // A pass that cannot retry takes no copy.
        for (const observation of observations.filter((o) => !o.held))
            expect(observation.snapshot).toBeNull();
    } finally {
        s.cleanup();
    }
}, 60_000);

it("a thinking session that is not held takes no copy of its input", async () => {
    // Claude Sonnet 4.5 is not prefix-bound, so its signed thinking is never held.
    const s = session("unheld", { providerID: "anthropic", modelID: "claude-sonnet-4-5" });
    const clones = spyOn(hostServedRows, "cloneKeepingCoveredInstructionMarks");
    try {
        const rows: MessageLike[] = [s.user()];
        resolveCtxReduceAvailabilityFromMessages(s.sessionId, rows as never);
        for (let pass = 0; pass < 10; pass++) {
            rows.push(s.step({ heavy: true, output: `Result ${pass}` }));
            s.control.decision = pass % 2 === 0 ? "execute" : "defer";
            s.setUsage(40);
            await s.transform({}, { messages: structuredClone(rows) });
        }
        expect(clones).toHaveBeenCalledTimes(0);
    } finally {
        clones.mockRestore();
        s.cleanup();
    }
}, 30_000);

it("compaction-off never retries, so it takes no copy even while every open signed turn is held", async () => {
    const s = session(
        "compaction-off",
        { providerID: "anthropic", modelID: "claude-opus-5-5" },
        true,
    );
    const clones = spyOn(hostServedRows, "cloneKeepingCoveredInstructionMarks");
    const held: boolean[] = [];
    observeSignedThinkingFitSnapshotForTests((observation) => held.push(observation.held));
    try {
        const rows: MessageLike[] = [s.user()];
        resolveCtxReduceAvailabilityFromMessages(s.sessionId, rows as never);
        for (let pass = 0; pass < 4; pass++) {
            rows.push(s.step({ heavy: true, output: `Result ${pass}` }));
            s.setUsage(40);
            await s.transform({}, { messages: structuredClone(rows) });
        }
        expect(held).toEqual([true, true, true, true]);
        expect(clones).toHaveBeenCalledTimes(0);
    } finally {
        clones.mockRestore();
        s.cleanup();
    }
}, 30_000);

it("a held over-window pass with no copy of its input is refused, logged once, and never retried or sent", async () => {
    const s = session("no-snapshot", { providerID: "anthropic", modelID: "claude-opus-5-5" });
    const logs = spyOn(logger, "sessionLog");
    const clones = spyOn(hostServedRows, "cloneKeepingCoveredInstructionMarks").mockImplementation(
        () => {
            throw new DOMException("could not be cloned", "DataCloneError");
        },
    );
    try {
        const rows: MessageLike[] = [s.user()];
        resolveCtxReduceAvailabilityFromMessages(s.sessionId, rows as never);
        rows.push(s.step({ heavy: true, output: "Small result" }));
        s.setUsage(40);
        await s.transform({}, { messages: structuredClone(rows) });
        // A heavy newest step with a result far over the 16K window, below the
        // 75% hold cap, on an executing pass: the hold stays on, the request is
        // over the window, and only the retry could have reclaimed it.
        rows.push(s.step({ heavy: true, output: "RECLAIMABLE tool result words ".repeat(30_000) }));
        s.control.decision = "execute";
        s.setUsage(70);
        logs.mockClear();
        const output = { messages: structuredClone(rows) as unknown[] };
        const failure = await s.transform({}, output).then(
            () => undefined,
            (error: unknown) => error as Error,
        );
        expect(failure?.name).toBe("EmergencyFailClosedError");
        expect(failure?.message).toContain(REFUSAL);
        const lines = logs.mock.calls.map((call) => call.slice(1).map(String).join(" "));
        expect(
            lines.filter((line) =>
                line.includes("no copy of the pass input exists to retry from; refusing it"),
            ),
        ).toHaveLength(1);
        expect(lines.some((line) => line.includes("origin=fit_retry"))).toBe(false);
        // The copy was attempted on this held pass and failed.
        expect(clones).toHaveBeenCalled();
        // Remembered as refused, as a retry that still did not fit is.
        expect(getMergedReasoningStrippedIds(s.db, s.sessionId).has("signed_fit:refused:v1")).toBe(
            true,
        );
    } finally {
        clones.mockRestore();
        logs.mockRestore();
        s.cleanup();
    }
}, 30_000);
