/// <reference types="bun-types" />
// Cache-safety witnesses for the bounded signed-thinking hold (issue 729):
// whether signed thinking is ever served behind provider-visible bytes that
// changed since it was produced. Cases that guard a fixed gap always run; the
// others are skipped unless MC_REREVIEW_729=1.
//
// Every scenario drives the real OpenCode transform, through the production
// messages-transform wrapper (so a failed pass replays the last good request),
// on a prefix-bound model (Opus 5.5). The strict-binding oracle is the one of
// the first review (review-729-cache-safety.test.ts): a signed thinking block
// is valid only while every provider-visible byte in front of it equals the
// request that produced it, except that a gap-free run of the oldest thinking
// blocks may be removed. Each case asserts the oracle finds nothing, so a red
// case means invalid signed thinking was served. Each case prints a one-line
// summary of what was served and logged.
//
// Always run, because each guards a case that once served invalid signed
// thinking: the compaction-off first renders with no cached m[0]/m[1], the
// restart together with a new real user after a last-good replay, and the date
// rollover on a held idle-expiry pass.
//
// To compare with another revision, copy this file into that checkout and run
// it there with the same environment variable.
import { afterEach, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { insertMemory } from "../../features/magic-context/memory";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getTagsBySession,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    addMergedReasoningStrippedIds,
    getMergedReasoningStrippedIds,
} from "../../features/magic-context/storage-meta-persisted";
import { clearCachedM0M1 } from "../../features/magic-context/storage-meta-shared";
import { bumpProjectMemoryEpoch } from "../../features/magic-context/storage-project-state";
import { createTagger } from "../../features/magic-context/tagger";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import * as loggerModule from "../../shared/logger";
import { openTestDatabase } from "../../shared/test-db";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { readPersistedLkgUntaggedInputIds } from "./lkg-recovery-prefix";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { requestPendingMaterialization } from "./pending-materialization";
import { providerVisiblePart } from "./provider-visible-parts";
import { bindSystemDateRequestIdentity, registerSystemDateRefresh } from "./system-date-refresh";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { createTransform } from "./transform";

const ENABLED = process.env.MC_REREVIEW_729 === "1";
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

const toolHeads = (messages: Message[]) =>
    messages
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "tool")
        .map((p) => String((p.state as { output?: string }).output).slice(0, 8));

interface SessionOptions {
    compactionOff?: boolean;
    memory?: boolean;
    executeThresholdPercentage?: number;
}

/**
 * One OpenCode session on Opus 5.5. `pass()` serves the current source through
 * the production wrapper and, when given a date, the system-prompt hook after
 * it (OpenCode 2's order, both stages bound to one request identity). The
 * oracle also treats the system prompt as part of the prefix: a kept block
 * born under one date must not be served under another.
 */
async function session(
    host: "opencode1" | "opencode2",
    sessionId: string,
    options: SessionOptions = {},
) {
    const dataHome = createTestTempDir("mc-rr729-data-").dir;
    const directory = createTestTempDir("mc-rr729-session-").dir;
    tempDirs.push(dataHome, directory);
    process.env.XDG_DATA_HOME = dataHome;
    writeFileSync(join(directory, "ARCHITECTURE.md"), "# Architecture\n\nv1\n");
    let db = await openTestDatabase();
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
    let failNext = false;
    let handler!: (input: unknown, output: unknown) => Promise<unknown>;
    let systemHandler!: (input: unknown, output: unknown) => Promise<unknown>;
    const build = () => {
        const transform = createTransform({
            db,
            tagger: createTagger(),
            scheduler: createScheduler({
                executeThresholdPercentage: options.executeThresholdPercentage ?? 65,
            }),
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
                    if (failNext) {
                        failNext = false;
                        throw Object.assign(new Error("database is locked"), {
                            code: "SQLITE_BUSY",
                        });
                    }
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
        directory,
        logs,
        pending,
        problems,
        systemPromptRefreshSessions,
        projectIdentity,
        served: () => served,
        setUsage(percentage: number) {
            usage.set(sessionId, {
                usage: { percentage, inputTokens: percentage * 1000 },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            });
        },
        failNextPass() {
            failNext = true;
        },
        /**
         * Simulates a process restart: clears the in-memory last-good slots,
         * reopens the database and rebuilds every handler.
         */
        async restart() {
            resetLkgSlotsForTest();
            await closeDatabase();
            db = await openTestDatabase();
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
        idle() {
            db.prepare(
                "UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?",
            ).run(Date.now() - 3 * 60 * 60 * 1000, sessionId);
            updateSessionMeta(db, sessionId, {
                lastResponseTime: Date.now() - 2 * 60 * 60 * 1000,
            });
        },
        dropOldestTool() {
            const tool = getTagsBySession(db, sessionId)
                .filter((tag) => tag.type === "tool" && tag.status === "active")
                .sort((a, b) => a.tagNumber - b.tagNumber)[0];
            if (tool) queuePendingOp(db, sessionId, tool.tagNumber, "drop");
            return tool?.tagNumber;
        },
        flush() {
            requestPendingMaterialization(pending, sessionId, "user_flush");
        },
        editMemory(content: string) {
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "USER_DIRECTIVES",
                content,
            });
            bumpProjectMemoryEpoch(db, projectIdentity);
        },
        editDocs(version: string) {
            writeFileSync(join(directory, "ARCHITECTURE.md"), `# Architecture\n\n${version}\n`);
        },
        clearHead() {
            clearCachedM0M1(db, sessionId);
        },
        cachedM0() {
            return getOrCreateSessionMeta(db, sessionId).cachedM0Bytes?.toString() ?? null;
        },
        /**
         * Serves one request. With a date the system-prompt hook runs after the
         * messages transform (OpenCode 2's order), or before it with
         * `systemFirst`; both stages share one request identity.
         */
        async pass(
            date?: string,
            order: { systemFirst?: boolean } = {},
        ): Promise<{ messages: Message[] | null; prompt?: string }> {
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
                const runSystem = async () => {
                    if (system)
                        await systemHandler(
                            { sessionID: sessionId, dateRefreshRequest: identity },
                            system,
                        );
                };
                if (order.systemFirst) await runSystem();
                try {
                    await handler({}, output);
                } catch (error) {
                    logs.push(`REFUSED ${(error as Error).message}`);
                    return { messages: null };
                }
                if (!order.systemFirst) await runSystem();
                let prompt: string | undefined;
                if (system) {
                    prompt = system.system.join("\n");
                    servedDate = /Date: (\S+)/.exec(prompt)?.[1];
                }
                const views = messages.map(view);
                for (let i = 0; i < messages.length; i++)
                    for (const part of messages[i]!.parts) {
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
                served = messages;
                updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
                return { messages, prompt };
            } finally {
                log.mockRestore();
            }
        },
        relevantLogs() {
            if (process.env.MC_REREVIEW_729_VERBOSE === "1")
                return logs.filter((l) => !l.startsWith("transform stage:"));
            return logs.filter((l) =>
                /hold|frozen|WILL|strip|fold decision|lkg|LKG|REFUSED|date|release|normaliz/i.test(
                    l,
                ),
            );
        },
    };
}

const HOSTS = ["opencode1", "opencode2"] as const;
const report = (label: string, s: ReturnType<typeof session>, extra: Record<string, unknown>) =>
    console.log(
        `[rereview-729] ${label} problems=${JSON.stringify(s.problems)} ${Object.entries(extra)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(" ")}`,
    );

// ── Compaction-off: the blanket hold must keep every head change away from an
// open signed turn. Light steps only, so without compaction-off the turn would
// not be held (no step above 1,500 reasoning tokens).
for (const host of HOSTS) {
    it.skipIf(!ENABLED)(
        `${host}: compaction-off, a dashboard memory edit mid-turn keeps m[0] in front of kept thinking`,
        async () => {
            const s = await session(host, `rr729-off-mem-${host}`, {
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
            const before = s.cachedM0();
            s.editMemory("Always use Bun");
            s.step(4, 200);
            const out = await s.pass();
            const m0Changed = before !== s.cachedM0();
            report(`${host} off memory-edit`, s, {
                m0Changed,
                kept: signedSignatures(out.messages ?? []),
                logs: s.relevantLogs(),
            });
            expect(s.problems).toEqual([]);
        },
        60_000,
    );

    it.skipIf(!ENABLED)(
        `${host}: compaction-off, a project-docs change mid-turn keeps m[0] in front of kept thinking`,
        async () => {
            const s = await session(host, `rr729-off-docs-${host}`, { compactionOff: true });
            s.user("run some bash commands");
            await s.pass();
            for (let n = 1; n <= 3; n++) {
                s.step(n, 200);
                await s.pass();
            }
            s.editDocs("v2");
            s.step(4, 200);
            const out = await s.pass();
            // The same change across a restart.
            await s.restart();
            s.editDocs("v3");
            s.step(5, 200);
            const after = await s.pass();
            report(`${host} off docs`, s, {
                kept4: signedSignatures(out.messages ?? []),
                kept5: signedSignatures(after.messages ?? []),
                logs: s.relevantLogs(),
            });
            expect(s.problems).toEqual([]);
        },
        60_000,
    );

    it(`${host}: compaction-off, the first render after a restart (no cached m[0]/m[1]) with changed docs`, async () => {
        const s = await session(host, `rr729-off-first-${host}`, { compactionOff: true });
        s.user("run some bash commands");
        await s.pass();
        for (let n = 1; n <= 3; n++) {
            s.step(n, 200);
            await s.pass();
        }
        // The cached pair is gone (a store rebase, a history repair or a
        // migration clears it) and the process restarts; the docs changed.
        s.clearHead();
        s.editDocs("v2");
        await s.restart();
        s.step(4, 200);
        const out = await s.pass();
        report(`${host} off first-render-after-restart`, s, {
            kept: signedSignatures(out.messages ?? []),
            head: String(out.messages?.[0]?.parts?.[0]?.text ?? "").slice(0, 160),
            logs: s.relevantLogs(),
        });
        expect(s.problems).toEqual([]);
    }, 60_000);

    it(`${host}: compaction-off, a first render in the same process (no cached m[0]/m[1]) with changed docs`, async () => {
        const s = await session(host, `rr729-off-first-warm-${host}`, { compactionOff: true });
        s.user("run some bash commands");
        await s.pass();
        for (let n = 1; n <= 3; n++) {
            s.step(n, 200);
            await s.pass();
        }
        s.clearHead();
        s.editDocs("v2");
        s.step(4, 200);
        const out = await s.pass();
        report(`${host} off first-render-warm`, s, {
            kept: signedSignatures(out.messages ?? []),
            logs: s.relevantLogs(),
        });
        expect(s.problems).toEqual([]);
    }, 60_000);
}

// ── Last-good replays and the deferred tail normalization.
async function heldAfterReplay(s: ReturnType<typeof session>, replays: number): Promise<void> {
    s.user("long task");
    await s.pass();
    // A heavy-reasoning step, so the turn is held below 75%.
    s.step(1, 2_400);
    await s.pass();
    let n = 2;
    for (let r = 0; r < replays; r++) {
        s.failNextPass();
        s.step(n++, 200);
        await s.pass();
    }
    s.step(n++, 200);
    await s.pass();
    // A held pass admitted by idle expiry: normalization is deferred.
    s.idle();
    s.step(n, 200);
    await s.pass();
}

for (const host of HOSTS) {
    for (const replays of [1, 2])
        for (const withDrop of [true, false]) {
            it.skipIf(!ENABLED)(
                `${host}: ${replays} last-good replay(s), a deferring held idle pass, then an unheld flush ${withDrop ? "with a queued drop" : "with nothing queued"}`,
                async () => {
                    const s = await session(
                        host,
                        `rr729-lkg-unheld-${replays}-${withDrop}-${host}`,
                    );
                    await heldAfterReplay(s, replays);
                    const deferred = s.relevantLogs();
                    // Above the cap (75%): unheld. A user flush busts the cache
                    // without changing the cached head, which lifts latest-turn
                    // protection only. With nothing queued, the deferred tail
                    // normalization is the pass's only edit in front of the thinking.
                    s.setUsage(80);
                    s.flush();
                    if (withDrop) s.dropOldestTool();
                    s.step(10, 200);
                    const out = await s.pass();
                    const busted = s.relevantLogs();
                    s.step(11, 200);
                    await s.pass();
                    report(
                        `${host} lkg x${replays} -> held idle -> unheld flush drop=${withDrop}`,
                        s,
                        {
                            kept: signedSignatures(out.messages ?? []),
                            tools: toolHeads(out.messages ?? []),
                            deferred,
                            busted,
                        },
                    );
                    expect(s.problems).toEqual([]);
                },
                60_000,
            );
        }

    it.skipIf(!ENABLED)(
        `${host}: a restart between the deferring held pass and the next pass`,
        async () => {
            const s = await session(host, `rr729-lkg-restart-${host}`);
            await heldAfterReplay(s, 1);
            await s.restart();
            // Still held (heavy step 1 is within 15 steps, usage 30%).
            s.step(10, 200);
            const held = await s.pass();
            const heldLogs = s.relevantLogs();
            s.setUsage(80);
            s.flush();
            s.step(11, 200);
            const out = await s.pass();
            report(`${host} lkg -> held idle -> restart`, s, {
                keptHeld: signedSignatures(held.messages ?? []),
                toolsHeld: toolHeads(held.messages ?? []),
                kept: signedSignatures(out.messages ?? []),
                heldLogs,
            });
            expect(s.problems).toEqual([]);
        },
        60_000,
    );

    it.skipIf(!ENABLED)(
        `${host}: a restart right after a last-good replay, on a held turn`,
        async () => {
            const s = await session(host, `rr729-lkg-restart-direct-${host}`);
            s.user("long task");
            await s.pass();
            s.step(1, 2_400);
            await s.pass();
            s.failNextPass();
            s.step(2, 200);
            await s.pass();
            s.step(3, 200);
            await s.pass();
            await s.restart();
            s.step(4, 200);
            const out = await s.pass();
            report(`${host} lkg -> restart (held)`, s, {
                kept: signedSignatures(out.messages ?? []),
                tools: toolHeads(out.messages ?? []),
                logs: s.relevantLogs(),
            });
            expect(s.problems).toEqual([]);
        },
        60_000,
    );
}

for (const host of HOSTS) {
    it(`${host}: a restart together with a new real user after a last-good replay re-tags the replayed result in front of kept thinking`, async () => {
        const s = await session(host, `rr729-lkg-restart-user-${host}`);
        s.user("long task");
        await s.pass();
        s.step(1, 2_400);
        await s.pass();
        s.failNextPass();
        s.step(2, 200);
        await s.pass();
        s.step(3, 200);
        await s.pass();
        // The turn ends with a new real user, and the process restarts before
        // the next request. The randomized driver (review-729-driver.test.ts,
        // MC_REVIEW_729_SEED=5150) reaches the same shape.
        s.user("next task");
        await s.restart();
        const out = await s.pass();
        report(`${host} lkg -> user+restart`, s, {
            kept: signedSignatures(out.messages ?? []),
            tools: toolHeads(out.messages ?? []),
            logs: s.relevantLogs(),
        });
        expect(s.problems).toEqual([]);
    }, 60_000);
}

// ── System date across a day rollover.
for (const host of HOSTS) {
    it.skipIf(!ENABLED)(
        `${host}: a date rollover on a held pass, then on an unheld lift-only bust`,
        async () => {
            const s = await session(host, `rr729-date-${host}`);
            s.user("long task");
            await s.pass("2026-10-21");
            s.step(1, 2_400);
            await s.pass("2026-10-21");
            s.step(2, 200);
            await s.pass("2026-10-21");
            // The day rolls over on a held pass.
            s.systemPromptRefreshSessions.add(`rr729-date-${host}`);
            s.step(3, 200);
            const held = await s.pass("2026-10-22");
            const heldLogs = s.relevantLogs();
            // Unheld (above the cap) and a user flush with nothing queued: the bust
            // lifts protection but edits nothing in front of the turn's thinking.
            s.setUsage(80);
            s.flush();
            s.step(4, 200);
            const lift = await s.pass("2026-10-22");
            const liftLogs = s.relevantLogs();
            report(`${host} date held -> unheld lift-only`, s, {
                heldPrompt: held.prompt?.match(/Date: \S+/)?.[0],
                liftPrompt: lift.prompt?.match(/Date: \S+/)?.[0],
                keptLift: signedSignatures(lift.messages ?? []),
                heldLogs,
                liftLogs,
            });
            expect(s.problems).toEqual([]);
        },
        60_000,
    );

    it(`${host}: a date rollover on a held idle-expiry pass`, async () => {
        const s = await session(host, `rr729-date-idle-${host}`);
        s.user("long task");
        await s.pass("2026-10-21");
        s.step(1, 2_400);
        await s.pass("2026-10-21");
        s.step(2, 200);
        await s.pass("2026-10-21");
        // A tool call runs past the TTL and past midnight.
        s.systemPromptRefreshSessions.add(`rr729-date-idle-${host}`);
        s.idle();
        s.step(3, 200);
        const out = await s.pass("2026-10-22");
        report(`${host} date held idle`, s, {
            prompt: out.prompt?.match(/Date: \S+/)?.[0],
            kept: signedSignatures(out.messages ?? []),
            logs: s.relevantLogs(),
        });
        expect(s.problems).toEqual([]);
    }, 60_000);

    it.skipIf(!ENABLED)(
        `${host}: a date rollover on an unheld idle-expiry bust that keeps the turn's thinking`,
        async () => {
            const s = await session(host, `rr729-date-idle-unheld-${host}`);
            s.user("long task");
            await s.pass("2026-10-21");
            // Light steps only: never held.
            s.step(1, 200);
            await s.pass("2026-10-21");
            s.step(2, 200);
            await s.pass("2026-10-21");
            s.systemPromptRefreshSessions.add(`rr729-date-idle-unheld-${host}`);
            s.idle();
            s.step(3, 200);
            const out = await s.pass("2026-10-22");
            report(`${host} date unheld idle`, s, {
                prompt: out.prompt?.match(/Date: \S+/)?.[0],
                kept: signedSignatures(out.messages ?? []),
                logs: s.relevantLogs(),
            });
            expect(s.problems).toEqual([]);
        },
        60_000,
    );
}

// ── Guards for the fixes of the gaps above. Always run.
const ledger = (s: ReturnType<typeof session>, sessionId: string) =>
    [...getMergedReasoningStrippedIds(s.db, sessionId)].sort();

for (const host of HOSTS) {
    it(`${host}: compaction-off keeps replaying the strip of a first render on later passes and after a restart`, async () => {
        const sessionId = `rr729-off-first-replay-${host}`;
        const s = await session(host, sessionId, { compactionOff: true });
        s.user("run some bash commands");
        await s.pass();
        for (let n = 1; n <= 3; n++) {
            s.step(n, 200);
            await s.pass();
        }
        s.clearHead();
        s.editDocs("v2");
        s.step(4, 200);
        const stripped = await s.pass();
        expect(signedSignatures(stripped.messages ?? [])).toEqual([]);
        // The strip is recorded for compaction-off itself and for managed mode.
        expect(ledger(s, sessionId)).toEqual(
            expect.arrayContaining([
                "binding_mismatch:step-1",
                "compaction_off_thinking:step-1",
                "compaction_off_thinking:step-4",
            ]),
        );
        // Later steps keep their own thinking; the stripped blocks never return,
        // also after a restart (the oracle reports a block coming back).
        s.step(5, 200);
        const later = await s.pass();
        expect(signedSignatures(later.messages ?? [])).toEqual(["sig-5"]);
        await s.restart();
        s.step(6, 200);
        const restarted = await s.pass();
        expect(signedSignatures(restarted.messages ?? [])).toEqual(["sig-5", "sig-6"]);
        report(`${host} off first-render strip replay`, s, { logs: s.relevantLogs() });
        expect(s.problems).toEqual([]);
    }, 60_000);

    it(`${host}: compaction-off never applies the binding strips managed mode recorded`, async () => {
        const sessionId = `rr729-off-managed-ledger-${host}`;
        const s = await session(host, sessionId, { compactionOff: true });
        s.user("run some bash commands");
        await s.pass();
        s.step(1, 200);
        await s.pass();
        // Seed the ledger with a binding-mismatch entry, as managed mode would
        // write it. Compaction-off never applied it, so it must keep serving sig-1.
        addMergedReasoningStrippedIds(s.db, sessionId, ["binding_mismatch:step-1"]);
        s.step(2, 200);
        const out = await s.pass();
        expect(signedSignatures(out.messages ?? [])).toEqual(["sig-1", "sig-2"]);
        expect(s.problems).toEqual([]);
    }, 60_000);

    it(`${host}: after a restart and a new real user the replayed result stays untagged until a bust strips`, async () => {
        const sessionId = `rr729-lkg-restart-user-flush-${host}`;
        const s = await session(host, sessionId, { memory: true });
        s.user("long task");
        await s.pass();
        s.step(1, 2_400);
        await s.pass();
        s.failNextPass();
        s.step(2, 200);
        await s.pass();
        s.step(3, 200);
        await s.pass();
        // The pass after the replay recorded which messages it served untagged.
        expect(readPersistedLkgUntaggedInputIds(s.db, sessionId).length).toBeGreaterThan(0);
        s.user("next task");
        await s.restart();
        await s.pass();
        // Defer passes of the new turn keep call-2 untagged.
        s.step(4, 200);
        const deferred = await s.pass();
        expect(toolHeads(deferred.messages ?? [])[1]?.startsWith("2\n")).toBe(true);
        // The cached memory/history messages are byte-identical on this flush.
        // Adding a tag would also change the older reply's text, invalidating
        // cached history that the provider could otherwise reuse.
        const headBefore = getOrCreateSessionMeta(s.db, sessionId);
        const headBytesBefore = [
            headBefore.cachedM0Bytes?.toString(),
            headBefore.cachedM1Bytes?.toString(),
        ];
        s.flush();
        s.step(5, 200);
        const conversationOnly = await s.pass();
        const headAfter = getOrCreateSessionMeta(s.db, sessionId);
        expect([headAfter.cachedM0Bytes?.toString(), headAfter.cachedM1Bytes?.toString()]).toEqual(
            headBytesBefore,
        );
        expect(toolHeads(conversationOnly.messages ?? [])[1]?.startsWith("2\n")).toBe(true);
        expect(readPersistedLkgUntaggedInputIds(s.db, sessionId).length).toBeGreaterThan(0);
        // A real memory-head change already rewrites the whole conversation, so
        // recovery tags can land on it and the untagged record can be cleared.
        s.editMemory("Remember the user's preferred verification command.");
        const flushed = await s.pass();
        expect(s.cachedM0()).not.toBe(headBytesBefore[0]);
        expect(toolHeads(flushed.messages ?? [])[1]?.startsWith("§")).toBe(true);
        expect(readPersistedLkgUntaggedInputIds(s.db, sessionId)).toEqual([]);
        s.step(6, 200);
        await s.pass();
        report(`${host} lkg -> user+restart -> flush`, s, {
            tools: toolHeads(flushed.messages ?? []),
            kept: signedSignatures(flushed.messages ?? []),
        });
        expect(s.problems).toEqual([]);
    }, 60_000);

    for (const held of [true, false])
        it(`${host}: a date rollover on ${held ? "a held" : "an unheld"} idle-expiry pass when the system hook runs first`, async () => {
            const sessionId = `rr729-date-idle-first-${held}-${host}`;
            const s = await session(host, sessionId);
            s.user("long task");
            await s.pass("2026-10-21", { systemFirst: true });
            s.step(1, held ? 2_400 : 200);
            await s.pass("2026-10-21", { systemFirst: true });
            s.step(2, 200);
            await s.pass("2026-10-21", { systemFirst: true });
            s.systemPromptRefreshSessions.add(sessionId);
            s.idle();
            s.step(3, 200);
            const out = await s.pass("2026-10-22", { systemFirst: true });
            report(`${host} date idle system-first held=${held}`, s, {
                prompt: out.prompt?.match(/Date: \S+/)?.[0],
                kept: signedSignatures(out.messages ?? []),
                logs: s.relevantLogs(),
            });
            // An idle expiry only means the provider forgot its cache: held or
            // not, the pass replays the same bytes and keeps the turn's
            // thinking, so the date holds.
            expect(out.prompt).toContain("Date: 2026-10-21");
            if (!held) {
                // On an unheld turn the next real rebuild strips the thinking
                // and lets the date move.
                s.flush();
                s.step(4, 200);
                const rebuilt = await s.pass("2026-10-22", { systemFirst: true });
                expect(rebuilt.prompt).toContain("Date: 2026-10-22");
            }
            expect(s.problems).toEqual([]);
        }, 60_000);
}
