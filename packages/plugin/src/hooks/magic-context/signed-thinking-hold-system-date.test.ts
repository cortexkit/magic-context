/// <reference types="bun-types" />
// The sticky system date may advance only on a pass that leaves no open-turn
// signed thinking behind the system prompt. On a prefix-bound model an unheld
// mid-turn bust that edits nothing in front of the turn's thinking keeps that
// thinking, so a day rollover must not change the system prompt in front of it
// on that pass; a bust that strips the turn may advance it.
//
// A bust whose only edit lies behind every kept block is rare and hard to set
// up through real lanes, so the kept case reports the pass as busted from the
// real postprocess result (as a tail-only edit would); whether the turn's
// thinking was kept is still decided by the real pass.
import { afterEach, expect, it, spyOn } from "bun:test";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getTagsBySession,
    openDatabase,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import * as loggerModule from "../../shared/logger";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { bindSystemDateRequestIdentity, registerSystemDateRefresh } from "./system-date-refresh";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { createTransform } from "./transform";
import * as postprocess from "./transform-postprocess-phase";

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

const MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
afterEach(() => {
    resetLkgSlotsForTest();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) cleanupTestTempDir(dir);
    tempDirs.length = 0;
});

type Shape = "visible" | "opencode2-signature-only" | "opencode1-signature-only";
/**
 * A signed reasoning part as each host stores it. With the text omitted
 * (Anthropic's `display: "omitted"`), OpenCode 2 keeps the signature under
 * `providerMetadata` and sends the block with empty text; OpenCode 1 keeps it
 * under `metadata` and its Anthropic adapter drops the empty part.
 */
const reasoningPart = (shape: Shape, text: string, signature: string) =>
    shape === "visible"
        ? { type: "reasoning", text, metadata: { anthropic: { signature } } }
        : shape === "opencode2-signature-only"
          ? { type: "reasoning", text: "", providerMetadata: { anthropic: { signature } } }
          : { type: "reasoning", text: "", metadata: { anthropic: { signature } } };
/** True for a part the host sends to the provider as signed thinking. */
const servedSigned = (shape: Shape, part: Record<string, unknown>) =>
    part.type === "reasoning" &&
    (shape === "opencode2-signature-only"
        ? (part.providerMetadata as { anthropic?: unknown } | undefined)?.anthropic !== undefined
        : typeof part.text === "string" &&
          part.text !== "" &&
          (part.metadata as { anthropic?: unknown } | undefined)?.anthropic !== undefined);

const cases: Array<{ strips: boolean; shape: Shape; name: string }> = [
    {
        strips: false,
        shape: "visible",
        name: "an unheld mid-turn bust that keeps the open turn's thinking holds the system date across a rollover",
    },
    {
        strips: true,
        shape: "visible",
        name: "a mid-turn bust that strips the open turn's thinking advances the system date",
    },
    {
        strips: false,
        shape: "opencode2-signature-only",
        name: "OpenCode 2: kept thinking whose text is omitted still holds the system date, since OpenCode 2 sends those blocks",
    },
    {
        strips: false,
        shape: "opencode1-signature-only",
        name: "OpenCode 1: kept thinking whose text is omitted does not hold the system date, since OpenCode 1 never sends those blocks",
    },
];

for (const { strips, shape, name } of cases) {
    it(name, async () => {
        const logs: string[] = [];
        const log = spyOn(loggerModule, "sessionLog").mockImplementation((...args) => {
            logs.push(args.slice(1).map(String).join(" "));
        });
        const sessionId = `system-date-${strips ? "strip" : "kept"}-${shape}`;
        const dataHome = createTestTempDir("mc-system-date-data-").dir;
        const directory = createTestTempDir("mc-system-date-dir-").dir;
        tempDirs.push(dataHome, directory);
        process.env.XDG_DATA_HOME = dataHome;
        const db = openDatabase();
        try {
            getOrCreateSessionMeta(db, sessionId);
            // A task (subagent) session: every execute pass is its own ride.
            updateSessionMeta(db, sessionId, {
                cacheTtl: "never",
                lastResponseTime: Date.now(),
                isSubagent: true,
            });
            const usage = new Map([
                [
                    sessionId,
                    {
                        usage: { percentage: 20, inputTokens: 20_000 },
                        updatedAt: Date.now(),
                        hasUsageTokens: true,
                    },
                ],
            ]);
            const historyRefreshSessions = new Set<string>();
            const systemPromptRefreshSessions = new Set<string>();
            const pendingMaterializationSessions = new Set<string>();
            registerSystemDateRefresh(historyRefreshSessions);
            const { handler } = createSystemPromptHashHandler({
                db,
                dreamerEnabled: false,
                resolveModel: () => MODEL,
                historyRefreshSessions,
                systemPromptRefreshSessions,
                pendingMaterializationSessions,
                lastHeuristicsTurnId: new Map(),
            });
            const transform = createTransform({
                db,
                tagger: createTagger(),
                scheduler: createScheduler({ executeThresholdPercentage: 65 }),
                contextUsageMap: usage,
                historyRefreshSessions,
                pendingMaterializationSessions,
                lastHeuristicsTurnId: new Map(),
                liveModelBySession: new Map([[sessionId, MODEL]]),
                protectedTokens: 0,
                historianRunnable: false,
                directory,
                sessionDirectoryBySession: new Map([[sessionId, directory]]),
            });
            const step = (n: number): Message => ({
                info: {
                    id: `step-${n}`,
                    role: "assistant",
                    sessionID: sessionId,
                    finish: "tool-calls",
                    ...MODEL,
                },
                parts: [
                    reasoningPart(shape, `light thought ${n}`, `sig-${n}`),
                    {
                        type: "tool",
                        callID: `call-${n}`,
                        tool: "read",
                        state: {
                            status: "completed",
                            input: { path: `${n}.ts` },
                            output: `result ${n} `.repeat(strips ? 1_500 : 200),
                        },
                    },
                ],
            });
            const source: Message[] = [
                {
                    info: { id: "old-task", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "an earlier task" }],
                },
                {
                    info: {
                        id: "old-answer",
                        role: "assistant",
                        sessionID: sessionId,
                        finish: "stop",
                        ...MODEL,
                    },
                    parts: [
                        reasoningPart(shape, "earlier reasoning ".repeat(400), "sig-old"),
                        { type: "text", text: "earlier answer" },
                    ],
                },
                {
                    info: { id: "task", role: "user", sessionID: sessionId },
                    parts: [{ type: "text", text: "do the task" }],
                },
            ];
            const system = (date: string) => ({
                system: [`Base instructions\n<plugin-env>\n  Date: ${date}\n</plugin-env>`],
            });
            // Both hook stages of one request share an identity, as OpenCode 2's
            // draft provides. The messages transform runs first and records whether
            // the date may advance; the system hook then applies that decision.
            const pass = async (date: string) => {
                const identity = {};
                const messages = structuredClone(source);
                const output = { messages };
                bindSystemDateRequestIdentity(output, identity);
                await transform({}, output as never);
                const prompt = system(date);
                await handler({ sessionID: sessionId, dateRefreshRequest: identity }, prompt);
                return { prompt: prompt.system.join("\n"), messages };
            };
            // Warm: first render and a light signed tool loop at 20% (defer).
            await pass("2026-10-21");
            // In the stripping case, enough later output that the first step's
            // result leaves the protected tail and its queued drop can apply; in
            // the other, every result stays protected, so nothing else edits.
            const steps = strips ? 4 : 2;
            for (let n = 1; n <= steps; n++) source.push(step(n));
            await pass("2026-10-21");
            const before = await pass("2026-10-21");
            expect(before.prompt).toContain("Date: 2026-10-21");
            // The next pass rides the task's execute at 66% (unheld: light
            // thinking). The second case applies a queued drop in front of the
            // turn's later thinking, so that pass strips the turn.
            if (strips) {
                const tool = getTagsBySession(db, sessionId)
                    .filter((tag) => tag.type === "tool")
                    .sort((a, b) => a.tagNumber - b.tagNumber)[0]!;
                expect(tool).toBeDefined();
                queuePendingOp(db, sessionId, tool.tagNumber, "drop");
            }
            usage.set(sessionId, {
                usage: { percentage: 66, inputTokens: 66_000 },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            });
            // The day rolls over and the host asks for the new date.
            systemPromptRefreshSessions.add(sessionId);
            logs.length = 0;
            const original = postprocess.runPostTransformPhase;
            const tailOnly = spyOn(postprocess, "runPostTransformPhase").mockImplementation(
                async (...args) => {
                    const result = await original(...args);
                    return strips ? result : { ...result, bustedThisPass: true };
                },
            );
            let rolled: Awaited<ReturnType<typeof pass>>;
            try {
                rolled = await pass("2026-10-22");
            } finally {
                tailOnly.mockRestore();
            }
            const signed = rolled.messages
                .flatMap((m) => m.parts)
                .filter((p) => servedSigned(shape, p));
            // The pass did bust (the task's execute ride), and only the stripping
            // case stripped.
            expect(logs.some((line) => /pending ops WILL APPLY/.test(line))).toBe(true);
            expect(logs.some((line) => line.includes("proactive thinking strip"))).toBe(strips);
            if (strips) {
                expect(signed).toHaveLength(0);
                expect(rolled.prompt).toContain("Date: 2026-10-22");
            } else if (shape === "opencode1-signature-only") {
                // Nothing the request sends is bound to the system prompt.
                expect(signed).toHaveLength(0);
                expect(rolled.prompt).toContain("Date: 2026-10-22");
            } else {
                expect(signed.length).toBeGreaterThan(0);
                expect(rolled.prompt).toContain("Date: 2026-10-21");
            }
        } finally {
            log.mockRestore();
        }
    }, 60_000);
}
