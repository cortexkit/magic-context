/// <reference types="bun-types" />
// Witnesses for two ways a prefix-bound model (Opus 5.5) can be served signed
// thinking behind bytes it was not produced after, around a pass that fails
// late: a compaction-off first render whose thinking strip cannot be saved, and
// a restart while the last-good replay of a refused fold is still being served.
//
// Each case drives the real OpenCode transform through the production
// messages-transform wrapper. A signed thinking block on this model is valid
// only while every byte in front of it, the system prompt included, is
// unchanged. The oracle below is the one signed-thinking-prefix-edits.test.ts
// uses: it flags a signed block served behind provider-visible bytes, or a
// system date, that differ from the request the block was produced after (a
// gap-free run of the oldest blocks may be missing). Each case states the
// defect it covers and failed while that defect was present.
import { afterEach, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertMemory } from "../../features/magic-context/memory";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { clearCachedM0M1 } from "../../features/magic-context/storage-meta-shared";
import { bumpProjectMemoryEpoch } from "../../features/magic-context/storage-project-state";
import { createTagger } from "../../features/magic-context/tagger";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import * as loggerModule from "../../shared/logger";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { createDbLkgPersistence } from "./lkg-persist";
import * as lkgRecoveryPrefix from "./lkg-recovery-prefix";
import { registerLkgPersistence, resetLkgSlotsForTest } from "./lkg-slot";
import { providerVisiblePart } from "./provider-visible-parts";
import { bindSystemDateRequestIdentity, registerSystemDateRefresh } from "./system-date-refresh";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { createTransform } from "./transform";

const VERBOSE = process.env.MC_SIGNED_THINKING_VERBOSE === "1";
const MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const BULK = "ROW value = compute(input, options); // generated line\n".repeat(40);

type Part = Record<string, unknown>;
type Message = { info: Record<string, unknown>; parts: Part[] };
type View = { role: unknown; parts: string[] };

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

const isThinking = (part: Part) =>
    part.type === "reasoning" &&
    typeof part.text === "string" &&
    part.text !== "" &&
    (part.metadata as { anthropic?: unknown } | undefined)?.anthropic !== undefined;
const signatureOf = (part: Part) =>
    String(
        (part.metadata as { anthropic?: { signature?: unknown } } | undefined)?.anthropic
            ?.signature,
    );

function view(message: Message): View {
    return {
        role: message.info.role,
        parts: message.parts
            .filter((p) => !((p.type === "text" || p.type === "reasoning") && p.text === ""))
            .filter((p) => p.ignored !== true)
            .map((p) =>
                isThinking(p)
                    ? `THINK:${signatureOf(p)}:${String(p.text)}`
                    : JSON.stringify(providerVisiblePart(p as never)),
            ),
    };
}

function firstDiff(a: string[], b: string[]): string {
    for (let i = 0; i < Math.max(a.length, b.length); i++)
        if (a[i] !== b[i])
            return `part ${i}: ${String(a[i]).slice(0, 90)} -> ${String(b[i]).slice(0, 90)}`;
    return "same";
}

/**
 * Null when `now` (the bytes now served in front of a signed block) still
 * matches `birth` (the bytes in front of it when it was produced), allowing
 * only a gap-free run of the oldest thinking blocks to be missing.
 */
function bindingProblem(birth: View[], now: View[]): string | null {
    if (birth.length !== now.length)
        return `prefix has ${now.length} messages, birth had ${birth.length}`;
    const born: string[] = [];
    const kept: string[] = [];
    for (let i = 0; i < birth.length; i++) {
        const a = birth[i]!;
        const b = now[i]!;
        if (a.role !== b.role) return `message ${i} role changed`;
        const ao = a.parts.filter((p) => !p.startsWith("THINK:"));
        const bo = b.parts.filter((p) => !p.startsWith("THINK:"));
        if (JSON.stringify(ao) !== JSON.stringify(bo))
            return `message ${i} bytes changed (${firstDiff(ao, bo)})`;
        born.push(...a.parts.filter((p) => p.startsWith("THINK:")));
        kept.push(...b.parts.filter((p) => p.startsWith("THINK:")));
    }
    const offset = born.length - kept.length;
    if (offset < 0) return "prefix gained thinking blocks";
    for (let i = 0; i < kept.length; i++)
        if (born[offset + i] !== kept[i]) return "thinking removed from the middle or edited";
    return null;
}

const signedSignatures = (messages: Message[]) =>
    messages.flatMap((m) => m.parts.filter(isThinking).map(signatureOf));

interface SessionOptions {
    compactionOff?: boolean;
    memory?: boolean;
}

/**
 * One OpenCode session on Opus 5.5, as in signed-thinking-prefix-edits.test.ts.
 * `pass()` serves the current source through the production wrapper and, when
 * given a date, the system-prompt hook after it (OpenCode 2's order, both
 * stages bound to one request identity).
 */
function session(host: "opencode1" | "opencode2", sessionId: string, options: SessionOptions = {}) {
    const dataHome = createTestTempDirFromPath(join(tmpdir(), "mc-review-refused-rebuild-data-"));
    const directory = createTestTempDirFromPath(
        join(tmpdir(), "mc-review-refused-rebuild-session-"),
    );
    tempDirs.push(dataHome, directory);
    process.env.XDG_DATA_HOME = dataHome;
    writeFileSync(join(directory, "ARCHITECTURE.md"), "# Architecture\n\nv1\n");
    let db = openDatabase();
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "5m", lastResponseTime: Date.now() });
    const usage = new Map([
        [
            sessionId,
            {
                usage: { percentage: 30, inputTokens: 30_000 },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            },
        ],
    ]);
    const pending = new Set<string>();
    const historyRefreshSessions = new Set<string>();
    const systemPromptRefreshSessions = new Set<string>();
    registerSystemDateRefresh(historyRefreshSessions);
    const logs: string[] = [];
    let handler!: (input: unknown, output: unknown) => Promise<unknown>;
    let systemHandler!: (input: unknown, output: unknown) => Promise<unknown>;
    const build = () => {
        // As the plugin's start-up does (hook.ts): the last-good request is saved
        // in the database, so after a restart the transform can still read it,
        // along with the record of whether a replay of it was still being served.
        registerLkgPersistence(createDbLkgPersistence(db));
        const transform = createTransform({
            db,
            tagger: createTagger(),
            scheduler: createScheduler({ executeThresholdPercentage: 65 }),
            contextUsageMap: usage,
            historyRefreshSessions,
            pendingMaterializationSessions: pending,
            lastHeuristicsTurnId: new Map(),
            liveModelBySession: new Map([[sessionId, MODEL]]),
            protectedTokens: 2000,
            protectedTools: { bash: 0 },
            historianRunnable: false,
            directory,
            sessionDirectoryBySession: new Map([[sessionId, directory]]),
            ...(options.compactionOff ? { compactionOff: true, injectDocs: true } : {}),
            ...(options.memory
                ? { memoryConfig: { enabled: true, injectionBudgetTokens: 500, autoPromote: true } }
                : {}),
            ...(host === "opencode2"
                ? {
                      storeGeneration: "v2" as const,
                      hostCleanupCompactionMarkers: () => ({
                          verified: true,
                          removedLineages: 0,
                          removedRows: 0,
                          retainedLineages: 0,
                      }),
                  }
                : {}),
        } as never);
        handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async (input: unknown, output: unknown) => {
                    await transform(input as never, output as never);
                },
            },
        } as never) as never;
        systemHandler = createSystemPromptHashHandler({
            db,
            dreamerEnabled: false,
            resolveModel: () => MODEL,
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions: pending,
            lastHeuristicsTurnId: new Map(),
        } as never).handler as never;
    };
    build();
    const source: Message[] = [];
    const births = new Map<string, { views: View[]; date: string | undefined }>();
    const problems: string[] = [];
    let served: Message[] = [];
    let servedDate: string | undefined;
    let clock = 1;
    let passNumber = 0;
    const projectIdentity = resolveProjectIdentity(directory);
    return {
        get db() {
            return db;
        },
        logs,
        problems,
        /** How many passes have run so far; problems name their pass by this number. */
        get passNumber() {
            return passNumber;
        },
        setUsage(percentage: number) {
            usage.set(sessionId, {
                usage: { percentage, inputTokens: percentage * 1000 },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            });
        },
        /** A process restart: in-memory last-good state is lost, the database reopens. */
        restart() {
            resetLkgSlotsForTest();
            closeDatabase();
            db = openDatabase();
            build();
        },
        user(text: string) {
            source.push({
                info: {
                    id: `u${clock}`,
                    role: "user",
                    sessionID: sessionId,
                    time: { created: clock++ },
                },
                parts: [{ type: "text", text }],
            });
        },
        /** One tool-loop step, with signed thinking of `reasoning` tokens. */
        step(n: number, reasoning: number) {
            source.push({
                info: {
                    id: `step-${n}`,
                    role: "assistant",
                    sessionID: sessionId,
                    time: { created: clock++ },
                    finish: "tool-calls",
                    ...MODEL,
                    tokens: { input: 0, output: 300, reasoning },
                },
                parts: [
                    {
                        type: "reasoning",
                        text: `step ${n}: run the next command`,
                        metadata: { anthropic: { signature: `sig-${n}` } },
                    },
                    {
                        type: "tool",
                        callID: `call-${n}`,
                        tool: "bash",
                        state: {
                            status: "completed",
                            input: { command: `seq ${n}` },
                            output: `${n}\n${BULK}`,
                        },
                    },
                ],
            });
            births.set(`sig-${n}`, { views: served.map(view), date: servedDate });
        },
        /** A final answer without thinking, which ends the turn. */
        reply(text: string) {
            source.push({
                info: {
                    id: `reply-${clock}`,
                    role: "assistant",
                    sessionID: sessionId,
                    time: { created: clock++ },
                    finish: "stop",
                    ...MODEL,
                    tokens: { input: 0, output: 50, reasoning: 0 },
                },
                parts: [{ type: "text", text }],
            });
        },
        editMemory(content: string) {
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "USER_DIRECTIVES",
                content,
            });
            bumpProjectMemoryEpoch(db, projectIdentity);
        },
        clearHead() {
            clearCachedM0M1(db, sessionId);
        },
        cachedM0() {
            return getOrCreateSessionMeta(db, sessionId).cachedM0Bytes?.toString() ?? null;
        },
        /** Serves one request; returns null messages when the turn was refused. */
        async pass(date?: string): Promise<{ messages: Message[] | null; prompt?: string }> {
            passNumber++;
            logs.length = 0;
            const log = spyOn(loggerModule, "sessionLog").mockImplementation(
                (...args: unknown[]) => {
                    logs.push(args.slice(1).map(String).join(" "));
                },
            );
            try {
                const messages = structuredClone(source);
                const output = { messages };
                const identity = {};
                bindSystemDateRequestIdentity(output, identity);
                const system =
                    date === undefined
                        ? undefined
                        : {
                              system: [
                                  `Base instructions\n<plugin-env>\n  Date: ${date}\n</plugin-env>`,
                              ],
                          };
                try {
                    await handler({}, output);
                } catch (error) {
                    logs.push(`REFUSED ${(error as Error).message}`);
                    return { messages: null };
                }
                if (system)
                    await systemHandler(
                        { sessionID: sessionId, dateRefreshRequest: identity },
                        system,
                    );
                let prompt: string | undefined;
                if (system) {
                    prompt = system.system.join("\n");
                    servedDate = /Date: (\S+)/.exec(prompt)?.[1];
                }
                const views = output.messages.map(view);
                for (let i = 0; i < output.messages.length; i++)
                    for (const part of output.messages[i]!.parts) {
                        if (!isThinking(part)) continue;
                        const birth = births.get(signatureOf(part));
                        if (!birth) continue;
                        const problem = bindingProblem(birth.views, views.slice(0, i));
                        if (problem)
                            problems.push(`pass ${passNumber}: ${signatureOf(part)}: ${problem}`);
                        else if (
                            date !== undefined &&
                            birth.date !== undefined &&
                            birth.date !== servedDate
                        )
                            problems.push(
                                `pass ${passNumber}: ${signatureOf(part)}: system date ${birth.date} -> ${servedDate}`,
                            );
                    }
                served = output.messages;
                updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
                return { messages: output.messages, prompt };
            } finally {
                log.mockRestore();
                // A healthy pass saves its last-good request from a deferred
                // callback; let it run before the next pass, as on a real host.
                await new Promise<void>((resolve) => setTimeout(resolve, 10));
            }
        },
        relevantLogs() {
            if (VERBOSE) return logs.filter((l) => !l.startsWith("transform stage:"));
            return logs.filter((l) =>
                /hold|frozen|strip|fold decision|lkg|LKG|REFUSED|date|release|rewrite permission|recovery/i.test(
                    l,
                ),
            );
        },
    };
}

const HOSTS = ["opencode1", "opencode2"] as const;
const report = (label: string, s: ReturnType<typeof session>, extra: Record<string, unknown>) => {
    if (!VERBOSE && s.problems.length === 0) return;
    console.log(
        `[refused-rebuild-review] ${label} problems=${JSON.stringify(s.problems)} ${Object.entries(
            extra,
        )
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(" ")}`,
    );
};

/** Every write of the thinking-strip set fails, as a full disk or a broken page would. */
function failThinkingStripWrites(db: ReturnType<typeof openDatabase>): () => void {
    db.exec(
        "CREATE TEMP TRIGGER review_fail_thinking_strip BEFORE UPDATE OF merged_reasoning_stripped_ids ON session_meta BEGIN SELECT RAISE(ABORT, 'thinking strip write failed'); END",
    );
    return () => db.exec("DROP TRIGGER IF EXISTS temp.review_fail_thinking_strip");
}

// ── Compaction-off, OpenCode: a compaction-off fold saves the strip of the
// thinking it invalidates inside the fold's own commit hook, so a failed strip
// write rolls the fold back and the next pass folds and strips together. A
// first render is a fold too: here the head was cleared (a history repair or
// store rebase does that), the earlier turn's thinking is kept, no open signed
// turn holds the head, and memory changed, so the new head differs from the one
// the thinking was produced behind. The preparation's first render runs through
// the hook and rolls back when the strip cannot be saved, but the final
// injection of the same pass finds no saved head, renders and saves a first
// render of its own without the hook, and nothing strips. Every later pass then
// serves the earlier turn's thinking behind a head it was not produced after,
// and no later pass strips it (the head is no longer new). This differs from
// the gated "first render under a hold" case in signed-thinking-prefix-edits:
// no hold applies, and the strip that fails is the one in the commit hook.
for (const host of HOSTS)
    it(`${host}: compaction-off, a first render at a new turn whose thinking strip cannot be saved is not saved either, and the retry renders and strips`, async () => {
        const s = session(host, `review-off-first-render-${host}`, {
            compactionOff: true,
            memory: true,
        });
        s.editMemory("Prefer small commits");
        s.user("run some bash commands");
        await s.pass();
        for (let n = 1; n <= 3; n++) {
            s.step(n, 200);
            await s.pass();
        }
        s.user("next task");
        s.editMemory("Always use Bun");
        s.clearHead();
        const restore = failThinkingStripWrites(s.db);
        try {
            await s.pass();
        } finally {
            restore();
        }
        const failingPass = s.passNumber;
        report(`${host} off first render strip fails`, s, { logs: s.relevantLogs() });
        // Like a fold, the first render is not saved without its strip.
        const savedAfterFailure = s.cachedM0();
        await s.pass();
        await s.pass();
        report(`${host} off first render retry`, s, { logs: s.relevantLogs() });
        const later = s.problems.filter((problem) => !problem.startsWith(`pass ${failingPass}:`));
        expect({ savedAfterFailure, laterProblems: later }).toEqual({
            savedAfterFailure: null,
            laterProblems: [],
        });
    }, 60_000);

// ── A restart while the last-good replay of a refused fold is frozen. A
// replay stays frozen, byte for byte, until a pass that may rewrite the whole
// prefix releases it, and that release strips thinking produced since the
// replay when the head it serves differs from the replay's. The frozen state
// lives only in this process: after a restart the first pass is an ordinary
// defer pass (rewrite permission allowed=false) that serves the head the
// refused pass saved, never served before, in front of thinking produced
// behind the replay's head. That is a prompt rewrite without permission, and on
// a prefix-bound model the kept thinking is invalid behind it. The same
// sequence without the restart keeps serving the replay and has no problem.
// The first pass after the restart compares the head it serves with the saved
// last-good request's and strips the kept thinking when they differ.
for (const host of HOSTS)
    it(`${host}: a restart while a refused fold's replay is frozen does not serve the fold's head in front of thinking produced behind the replay`, async () => {
        const problems: Record<string, string[]> = {};
        for (const restart of [false, true]) {
            const sessionId = `review-restart-frozen-${host}-${restart}`;
            const s = session(host, sessionId, { memory: true });
            s.editMemory("Prefer small commits");
            s.user("long task");
            await s.pass();
            for (let n = 1; n <= 2; n++) {
                s.step(n, 200);
                await s.pass();
            }
            // A memory change folds m[0] on the next pass, which then fails at
            // the last refusal site before the capture (the untagged-record
            // write), so the wrapper replays the previous request while the
            // fold's new head is already saved.
            s.user("next task");
            s.editMemory("Always use Bun");
            const before = s.cachedM0();
            const spies = [
                spyOn(lkgRecoveryPrefix, "readPersistedLkgUntaggedInputIds").mockReturnValue([
                    "untagged-row-no-longer-served",
                ]),
                spyOn(lkgRecoveryPrefix, "persistLkgUntaggedInputIds").mockReturnValue(false),
            ];
            let replay: Awaited<ReturnType<typeof s.pass>>;
            try {
                replay = await s.pass();
            } finally {
                for (const spy of spies) spy.mockRestore();
            }
            expect(replay.messages).not.toBeNull();
            expect(s.logs.some((line) => line.endsWith("lkg_replay_served"))).toBe(true);
            expect(s.cachedM0()).not.toBe(before);
            // Step 3 thinks behind the replay's head; the frozen replay goes out again.
            s.step(3, 200);
            const frozen = await s.pass();
            expect(signedSignatures(frozen.messages ?? [])).toContain("sig-3");
            // The turn ends and the next one opens without thinking of its own,
            // so no strip of the open turn's thinking is due.
            s.reply("done");
            s.user("one more thing");
            if (restart) s.restart();
            const after = await s.pass();
            expect(after.messages).not.toBeNull();
            report(`${host} frozen replay restart=${restart}`, s, {
                kept: signedSignatures(after.messages ?? []),
                logs: s.relevantLogs(),
            });
            problems[restart ? "afterRestart" : "sameProcess"] = [...s.problems];
            resetLkgSlotsForTest();
            closeDatabase();
        }
        expect(problems).toEqual({ sameProcess: [], afterRestart: [] });
    }, 60_000);
