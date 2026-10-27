import { expect, it, spyOn } from "bun:test";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { recordDetectedContextLimit } from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import { createTestTempDir } from "../../shared/test-temp-dir";
import {
    clearCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
} from "./ctx-reduce-availability";
import * as hostServedRows from "./host-served-rows";
import * as injection from "./inject-compartments";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { closeReadOnlySessionDb } from "./read-session-db";
import { observeSignedThinkingFitSnapshotForTests } from "./signed-thinking-fit-snapshot";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";

// The signed-thinking fit retry restarts a held pass from a copy of its input.
// The transform takes that copy once the hold is decided, not when the pass
// starts. This differential runs one scripted session twice: once as shipped,
// and once with the copy replaced by a deep copy of the host's input taken
// before the pass began (what the copy used to be). Every served request and
// every refusal must be identical, including on passes that ran the retry.

const MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const realClone = hostServedRows.cloneKeepingCoveredInstructionMarks;

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

type PassRecord = { served: string; snapshots: number; retried: boolean };

async function runScript(
    mode: "shipped" | "copy-at-pass-start",
): Promise<{ records: PassRecord[]; cloneCalls: number }> {
    const root = createTestTempDir(`signed-fit-review-${mode}-`);
    const sessionId = `signed-fit-review-${mode}`;
    const db = openDatabase(`${root.dir}/context.db`)!;
    let now = Date.parse("2026-11-02T09:00:00Z");
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "never", lastResponseTime: now });
    recordDetectedContextLimit(db, sessionId, 16_000, `${MODEL.providerID}/${MODEL.modelID}`);
    updateSessionMeta(db, sessionId, { systemPromptTokens: 100, systemPromptHash: "review" });
    recordToolDefinition(MODEL.providerID, MODEL.modelID, undefined, "read", "Read a file", {
        type: "object",
    });
    const usage = new Map<
        string,
        {
            usage: { percentage: number; inputTokens: number };
            updatedAt: number;
            hasUsageTokens: boolean;
        }
    >();
    const control = { decision: "defer" as "execute" | "defer" };
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: { shouldExecute: () => control.decision },
        contextUsageMap: usage,
        liveModelBySession: new Map([[sessionId, MODEL]]),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        directory: root.dir,
        protectedTokens: 0,
        clearReasoningAge: 0,
        historianRunnable: false,
        // Temporal awareness edits user text parts during the pass.
        experimentalTemporalAwareness: true,
    });

    // The copy the "copy-at-pass-start" run hands the retry.
    let passStartCopy: MessageLike[] | null = null;
    const clones = spyOn(hostServedRows, "cloneKeepingCoveredInstructionMarks");
    if (mode === "copy-at-pass-start")
        clones.mockImplementation(((messages: MessageLike[]) =>
            passStartCopy ? realClone(passStartCopy) : realClone(messages)) as never);
    let snapshotsThisPass = 0;
    observeSignedThinkingFitSnapshotForTests(() => {
        snapshotsThisPass++;
    });

    const random = rng(7981);
    let counter = 0;
    // Minutes between messages, so temporal markers are due on user rows.
    let wallMs = Date.parse("2026-11-02T08:00:00Z");
    const tick = (minutes: number) => {
        wallMs += minutes * 60_000;
        return wallMs;
    };
    const user = (): MessageLike => {
        const created = tick(12);
        return {
            info: {
                id: `user-${String(counter++).padStart(4, "0")}`,
                role: "user",
                sessionID: sessionId,
                time: { created },
            },
            parts: [{ type: "text", text: `Request ${counter}: keep going.` }],
        } as MessageLike;
    };
    const step = (heavy: boolean, output: string, last = false): MessageLike => {
        const created = tick(1);
        return {
            info: {
                id: `asst-${String(counter++).padStart(4, "0")}`,
                role: "assistant",
                sessionID: sessionId,
                ...MODEL,
                time: { created, completed: tick(1) },
                finish: last ? "stop" : "tool-calls",
                tokens: {
                    input: 0,
                    output: heavy ? 1_800 : 120,
                    reasoning: heavy ? 1_800 : 120,
                },
            },
            parts: [
                {
                    type: "reasoning",
                    text: heavy ? "Heavy reasoning. ".repeat(400) : `Thought ${counter}.`,
                    metadata: { anthropic: { signature: `sig-${counter}` } },
                },
                {
                    type: "tool",
                    tool: "read",
                    callID: `call-${counter}`,
                    state: {
                        status: "completed",
                        input: { filePath: `/repo/file-${counter}.ts` },
                        output,
                        time: { start: 1, end: 2 },
                    },
                },
            ],
        } as MessageLike;
    };

    const records: PassRecord[] = [];
    let cloneCalls = 0;
    try {
        const rows: MessageLike[] = [user()];
        resolveCtxReduceAvailabilityFromMessages(sessionId, rows as never);
        for (let pass = 0; pass < 40; pass++) {
            const roll = random();
            if (roll < 0.15) rows.push(step(false, "done", true), user());
            else
                rows.push(
                    step(
                        random() < 0.75,
                        random() < 0.05
                            ? "RECLAIMABLE tool result words ".repeat(300)
                            : `Small result ${pass}`,
                    ),
                );
            control.decision = random() < 0.6 ? "execute" : "defer";
            now += 5_000;
            const percentage = [30, 55, 70, 74, 80][Math.floor(random() * 5)]!;
            usage.set(sessionId, {
                usage: { percentage, inputTokens: Math.round(160 * percentage) },
                updatedAt: now,
                hasUsageTokens: true,
            });
            const messages = structuredClone(rows);
            if (random() < 0.3) {
                const row = hostServedRows.markCoveredInstructionRow({ role: "system" });
                messages.splice(Math.floor(random() * messages.length), 0, {
                    info: row,
                    parts: [{ type: "text", text: "Instruction restored by the host hook." }],
                } as MessageLike);
            }
            passStartCopy = realClone(messages);
            snapshotsThisPass = 0;
            const output = { messages: messages as unknown[] };
            let served: string;
            try {
                await transform({}, output);
                served = JSON.stringify(output.messages);
            } catch (error) {
                served = `refused: ${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`;
            }
            records.push({
                served: served.replaceAll(sessionId, "<session>"),
                snapshots: snapshotsThisPass,
                // A retry reruns the transform, which decides the hold a second time.
                retried: snapshotsThisPass > 1,
            });
        }
        cloneCalls = clones.mock.calls.length;
    } finally {
        observeSignedThinkingFitSnapshotForTests(undefined);
        clones.mockRestore();
        clock.mockRestore();
        injection.clearInjectionCache(sessionId);
        clearCtxReduceAvailability(sessionId);
        resetLkgSlotsForTest();
        closeReadOnlySessionDb();
        closeDatabase();
        __resetToolDefinitionMeasurements();
        root.cleanup();
    }
    return { records, cloneCalls };
}

it("serves the same bytes and refusals as a copy taken when the pass starts, including on retried passes", async () => {
    const shippedRun = await runScript("shipped");
    const passStartRun = await runScript("copy-at-pass-start");
    const shipped = shippedRun.records;
    const passStart = passStartRun.records;
    console.log(
        `signed-fit review: passes=${shipped.length} retried=${shipped.filter((r) => r.retried).length} retriedServed=${shipped.filter((r) => r.retried && !r.served.startsWith("refused")).length} refused=${shipped.filter((r) => r.served.startsWith("refused")).length} cloneCalls shipped=${shippedRun.cloneCalls} passStart=${passStartRun.cloneCalls}`,
    );
    // Temporal awareness edits user text during the pass. Require a retried
    // pass that serves a gap marker, so the byte comparison covers a retry
    // whose input that stage edits.
    expect(shipped.some((record) => record.retried && record.served.includes("<!-- +"))).toBe(true);
    // The pass-start run really replaced the copy.
    expect(passStartRun.cloneCalls).toBeGreaterThan(0);
    // The script must exercise the retry and temporal markers, or the
    // comparison below proves nothing about them.
    expect(shipped.filter((record) => record.retried).length).toBeGreaterThan(0);
    // At least one retry must have been served rather than refused, so the
    // comparison covers bytes built from the copy, not only refusal text.
    expect(shipped.some((record) => record.retried && !record.served.startsWith("refused"))).toBe(
        true,
    );
    expect(shipped.some((record) => record.served.includes("<!-- +"))).toBe(true);
    expect(passStart.map((record) => record.retried)).toEqual(
        shipped.map((record) => record.retried),
    );
    for (let index = 0; index < shipped.length; index++)
        expect({ pass: index, served: passStart[index]!.served }).toEqual({
            pass: index,
            served: shipped[index]!.served,
        });
}, 120_000);
