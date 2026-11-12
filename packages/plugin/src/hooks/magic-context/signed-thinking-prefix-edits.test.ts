/// <reference types="bun-types" />
// Regression guards for signed thinking on prefix-bound models (Opus 5.5 and
// its family, which reject a signed thinking block when any byte in front of
// it changed): compaction-off folds and first renders, mode switches, forks,
// the durable record of messages a last-good replay served untagged, and the
// system date across restarts and idle expiry.
//
// Every case drives the real OpenCode transform through the production
// messages-transform wrapper on a prefix-bound model, and the strict-binding
// oracle flags a signed thinking block served behind any provider-visible
// byte, or a system date, that differs from the request that produced it (a
// gap-free run of the oldest blocks may be missing). A failing case means
// invalid signed thinking was served, unless its comment says otherwise.
//
// Cases for defects that are still open run only with
// MC_SIGNED_THINKING_OPEN_DEFECTS=1; each names its defect.
import { afterEach, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { insertMemory } from "../../features/magic-context/memory";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getTagsBySession,
    openDatabase,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { copySessionStateForClone } from "../../features/magic-context/storage-clone";
import { queueM0Mutation } from "../../features/magic-context/storage-m0-mutation-log";
import {
    armThinkingBindingRecovery,
    getThinkingBindingRecoveryTarget,
} from "../../features/magic-context/storage-meta-persisted";
import { clearCachedM0M1 } from "../../features/magic-context/storage-meta-shared";
import { bumpProjectMemoryEpoch } from "../../features/magic-context/storage-project-state";
import * as replayDocumentModule from "../../features/magic-context/storage-replay-document";
import { createTagger } from "../../features/magic-context/tagger";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import * as loggerModule from "../../shared/logger";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { forkCloneFilter } from "../../v2/fork-inheritance";
import { loadPersistedLkgSlot } from "./lkg-persist";
import { dropSlot, getInMemorySlot, resetLkgSlotsForTest } from "./lkg-slot";
import { requestPendingMaterialization } from "./pending-materialization";
import { providerVisiblePart } from "./provider-visible-parts";
import { bindSystemDateRequestIdentity, registerSystemDateRefresh } from "./system-date-refresh";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { createTransform } from "./transform";

/** Cases that witness a defect that is still open; see each case's comment. */
const OPEN_DEFECTS = process.env.MC_SIGNED_THINKING_OPEN_DEFECTS === "1";
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

const toolHeads = (messages: Message[]) =>
    messages
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "tool")
        .map((p) => String((p.state as { output?: string }).output).slice(0, 8));

interface SessionOptions {
    compactionOff?: boolean;
    memory?: boolean;
    executeThresholdPercentage?: number;
    /** Further transform dependencies, such as host callbacks a case makes fail. */
    transformDeps?: Record<string, unknown>;
}

/**
 * One OpenCode session on Opus 5.5. `pass()` serves the current source through
 * the production wrapper and, when given a date, the system-prompt hook after
 * it (OpenCode 2's order, both stages bound to one request identity). The
 * oracle also treats the system prompt as part of the prefix: a kept block
 * born under one date must not be served under another.
 */
function session(
    host: "opencode1" | "opencode2",
    initialSessionId: string,
    options: SessionOptions = {},
) {
    let sessionId = initialSessionId;
    const dataHome = createTestTempDir("mc-spe-data-").dir;
    const directory = createTestTempDir("mc-spe-session-").dir;
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
    const liveModels = new Map([[sessionId, MODEL]]);
    const directories = new Map([[sessionId, directory]]);
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
            liveModelBySession: liveModels,
            protectedTokens: 2000,
            protectedTools: { bash: 0 },
            historianRunnable: false,
            directory,
            sessionDirectoryBySession: directories,
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
            ...options.transformDeps,
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
        /** How many passes have run so far; problems name their pass by this number. */
        get passNumber() {
            return passNumber;
        },
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
        /**
         * Queue a structural change of the history head, which makes the next
         * pass that may fold rebuild m[0] with the memory as it is then. A
         * memory edit alone never folds m[0]: it reaches the head only at a
         * fold that something else triggers.
         */
        queueHeadRebuild() {
            queueM0Mutation(db, { sessionId, mutationType: "compartment_upgrade" });
        },
        editDocs(version: string) {
            writeFileSync(join(directory, "ARCHITECTURE.md"), `# Architecture\n\n${version}\n`);
        },
        clearHead() {
            clearCachedM0M1(db, sessionId);
        },
        /** Publish a history compartment covering the source up to `endIndex`. */
        compartment(endIndex: number) {
            appendCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: endIndex + 1,
                    startMessageId: String(source[0]!.info.id),
                    endMessageId: String(source[endIndex]!.info.id),
                    title: "history",
                    content: "U: summarized the start of the task",
                },
            ]);
            historyRefreshSessions.add(sessionId);
        },
        cachedM0() {
            return getOrCreateSessionMeta(db, sessionId).cachedM0Bytes?.toString() ?? null;
        },
        /** Switch between managed and compaction-off mode (a restart, as a config change is). */
        switchMode(compactionOff: boolean) {
            options.compactionOff = compactionOff;
            resetLkgSlotsForTest();
            closeDatabase();
            db = openDatabase();
            build();
        },
        /**
         * Fork the session the way OpenCode 2 does (new message ids, tool call
         * ids kept) through the production clone copier, and continue on the
         * fork under `childId`.
         */
        fork(childId: string) {
            const idMap = new Map<string, string>();
            const forkOrdinals = new Map<string, number>();
            const parentOrdinals = new Map<number, string>();
            source.forEach((message, index) => {
                const parentMessageId = String(message.info.id);
                const forkMessageId = `fk_${parentMessageId}`;
                idMap.set(parentMessageId, forkMessageId);
                forkOrdinals.set(forkMessageId, index + 1);
                parentOrdinals.set(index + 1, parentMessageId);
            });
            const toolTags = db
                .prepare(
                    "SELECT message_id, tool_owner_message_id FROM tags WHERE session_id = ? AND type = 'tool'",
                )
                .all(sessionId) as Array<{
                message_id: string;
                tool_owner_message_id: string | null;
            }>;
            copySessionStateForClone(
                db,
                sessionId,
                childId,
                forkCloneFilter(
                    {
                        parentToFork: idMap,
                        forkOrdinals,
                        parentOrdinals,
                        throughSeq: source.length,
                    },
                    new Set(
                        toolTags
                            .filter(
                                (r) =>
                                    r.tool_owner_message_id && idMap.has(r.tool_owner_message_id),
                            )
                            .map((r) => r.message_id),
                    ),
                ),
            );
            for (const message of source) {
                message.info.id = idMap.get(String(message.info.id));
                message.info.sessionID = childId;
            }
            getOrCreateSessionMeta(db, childId);
            updateSessionMeta(db, childId, { cacheTtl: "5m", lastResponseTime: Date.now() });
            usage.set(childId, usage.get(sessionId)!);
            liveModels.set(childId, MODEL);
            directories.set(childId, directory);
            sessionId = childId;
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
            if (VERBOSE) return logs.filter((l) => !l.startsWith("transform stage:"));
            return logs.filter((l) =>
                /hold|frozen|WILL|strip|fold decision|lkg|LKG|REFUSED|date|release|normaliz/i.test(
                    l,
                ),
            );
        },
    };
}

const HOSTS = ["opencode1", "opencode2"] as const;
/** Prints a case's details when it found a problem, or always with MC_SIGNED_THINKING_VERBOSE=1. */
const report = (label: string, s: ReturnType<typeof session>, extra: Record<string, unknown>) => {
    if (!VERBOSE && s.problems.length === 0) return;
    console.log(
        `[signed-thinking] ${label} problems=${JSON.stringify(s.problems)} ${Object.entries(extra)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(" ")}`,
    );
};
// ── Compaction-off: a fold on a pass that holds nothing (no open signed turn)
// re-renders m[0] in front of the earlier turns' signed thinking, which stays
// on the wire. Anthropic binds every kept block to the whole prefix in front
// of it, earlier turns included ("Re-render the context you put in the first
// user message with a changed value: invalid for every thinking block").
for (const host of HOSTS) {
    it(`${host}: compaction-off, a dashboard memory edit folds m[0] at the next turn in front of the earlier turn's kept thinking`, async () => {
        const s = session(host, `spe-off-oldturn-${host}`, {
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
        // Held through the open turn: the edit waits for the turn to end.
        s.editMemory("Always use Bun");
        s.step(4, 200);
        await s.pass();
        const before = s.cachedM0();
        s.user("next task");
        const out = await s.pass();
        report(`${host} off old-turn fold`, s, {
            m0Changed: before !== s.cachedM0(),
            kept: signedSignatures(out.messages ?? []),
            logs: s.relevantLogs(),
        });
        expect(s.problems).toEqual([]);
    }, 60_000);
}

// ── Compaction-off: a fold that changes the head in front of kept signed
// thinking saves the strip of that thinking in its own transaction. Saved
// after the commit, a failed strip write would leave the new head saved and
// the thinking it invalidates on the wire. Compaction-off strips only on the
// pass whose fold changed the head, so no later pass would strip it.
function failThinkingStripWrites(db: ReturnType<typeof openDatabase>): () => void {
    db.exec(
        "CREATE TEMP TRIGGER fail_thinking_strip BEFORE UPDATE OF merged_reasoning_stripped_ids ON session_meta BEGIN SELECT RAISE(ABORT, 'thinking strip write failed'); END",
    );
    // The record is a session-meta collection, which a chunked store keeps in
    // session_meta_chunks rows: every write to those rows fails as well.
    for (const event of ["INSERT", "UPDATE", "DELETE"])
        db.exec(
            `CREATE TEMP TRIGGER fail_thinking_strip_${event.toLowerCase()} BEFORE ${event} ON session_meta_chunks WHEN ${event === "DELETE" ? "OLD" : "NEW"}.column_name='merged_reasoning_stripped_ids' BEGIN SELECT RAISE(ABORT, 'thinking strip write failed'); END`,
        );
    return () => {
        db.exec("DROP TRIGGER IF EXISTS temp.fail_thinking_strip");
        for (const event of ["insert", "update", "delete"])
            db.exec(`DROP TRIGGER IF EXISTS temp.fail_thinking_strip_${event}`);
    };
}
for (const host of HOSTS) {
    it(`${host}: compaction-off, a fold at a new turn whose thinking strip cannot be saved is not saved either, and the retry folds and strips`, async () => {
        const s = session(host, `spe-off-strip-fail-${host}`, {
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
        s.editMemory("Always use Bun");
        s.queueHeadRebuild();
        s.step(4, 200);
        await s.pass();
        const before = s.cachedM0();
        s.user("next task");
        const restore = failThinkingStripWrites(s.db);
        try {
            await s.pass();
        } finally {
            restore();
        }
        report(`${host} off fold strip fails`, s, { logs: s.relevantLogs() });
        expect(s.cachedM0()).toBe(before);
        // The host sends the same request again: the fold and its strip land together.
        await s.pass();
        report(`${host} off fold strip retry`, s, { logs: s.relevantLogs() });
        expect(s.cachedM0()).not.toBe(before);
        expect(s.problems).toEqual([]);
    }, 60_000);
}

// ── Compaction-off, first render under a hold (compaction-off holds every open
// signed turn): the head is gone, the docs it renders changed, and the strip
// of the open turn's thinking cannot be saved. A render saves that strip in its
// own transaction, the preparation's and the final injection's alike, so the
// failed write rolls the new head back, nothing is saved, and the next pass
// renders and strips together. The failing pass itself cannot serve a valid
// request: the old head is no longer saved, and the strip cannot be saved
// either, so it is served without a head (compaction-off never refuses), with
// its thinking. Only later passes are checked.
for (const host of HOSTS)
    it(`${host}: compaction-off, a first render under a hold whose thinking strip cannot be saved is not saved either, and the retry renders and strips`, async () => {
        const s = session(host, `spe-off-first-render-strip-fail-${host}`, {
            compactionOff: true,
        });
        s.user("long task");
        await s.pass();
        for (let n = 1; n <= 3; n++) {
            s.step(n, 200);
            await s.pass();
        }
        s.editDocs("v2");
        s.clearHead();
        s.step(4, 200);
        const restore = failThinkingStripWrites(s.db);
        try {
            await s.pass();
        } finally {
            restore();
        }
        const failingPass = s.passNumber;
        report(`${host} off first render strip fails`, s, { logs: s.relevantLogs() });
        expect(s.cachedM0()).toBeNull();
        await s.pass();
        report(`${host} off first render strip retry`, s, { logs: s.relevantLogs() });
        expect(s.cachedM0()).toContain("v2");
        expect(s.problems.filter((problem) => !problem.startsWith(`pass ${failingPass}:`))).toEqual(
            [],
        );
    }, 60_000);

// ── The failing pass of the case above, on its own: the kept thinking must be
// served behind the prefix it was produced behind. That pass serves no head
// (the old one is no longer saved, and the new one cannot be saved without its
// strip), so the thinking sits behind a different prefix on that one request.
// Open defect: serving that request validly needs a per-process record of the
// request this process last served, to replay its head.
for (const host of HOSTS)
    it.skipIf(!OPEN_DEFECTS)(
        `${host}: compaction-off, the pass whose first-render strip cannot be saved serves its kept thinking behind the prefix it was produced behind`,
        async () => {
            const s = session(host, `spe-off-first-render-failing-pass-${host}`, {
                compactionOff: true,
            });
            s.user("long task");
            await s.pass();
            for (let n = 1; n <= 3; n++) {
                s.step(n, 200);
                await s.pass();
            }
            s.editDocs("v2");
            s.clearHead();
            s.step(4, 200);
            const restore = failThinkingStripWrites(s.db);
            try {
                await s.pass();
            } finally {
                restore();
            }
            report(`${host} off first render failing pass`, s, { logs: s.relevantLogs() });
            expect(s.problems).toEqual([]);
        },
        60_000,
    );

// ── Managed mode: the provider rejected a request for its signed thinking,
// which arms the binding recovery, and the next pass strips every bound block
// and captures that request as the last good one. Only then does it clear the
// recovery target. When that last write fails, the pass must still be served:
// refusing it after the capture leaves the refused output saved as the last
// good request while the turn is refused or replaced. The target stays armed;
// while the clear keeps failing every pass replays the saved strips and is
// served, and the first pass whose retried clear succeeds clears it.
for (const host of HOSTS)
    it(`${host}: a binding recovery whose target cannot be cleared still serves its pass, and the next pass clears it`, async () => {
        const sessionId = `spe-recovery-clear-fails-${host}`;
        const s = session(host, sessionId);
        s.user("long task");
        await s.pass();
        for (let n = 1; n <= 2; n++) {
            s.step(n, 200);
            await s.pass();
        }
        s.user("next task");
        await s.pass();
        // What the event handler does when the provider rejects bound thinking.
        armThinkingBindingRecovery(s.db, sessionId);
        dropSlot(sessionId, "thinking_binding_recovery");
        s.db.exec(
            "CREATE TEMP TRIGGER fail_recovery_clear BEFORE UPDATE OF thinking_binding_recovery_target ON session_meta WHEN NEW.thinking_binding_recovery_target = '' BEGIN SELECT RAISE(ABORT, 'recovery clear failed'); END",
        );
        let recovered: Awaited<ReturnType<typeof s.pass>>;
        let repeated: Awaited<ReturnType<typeof s.pass>>;
        try {
            recovered = await s.pass();
            repeated = await s.pass();
        } finally {
            s.db.exec("DROP TRIGGER IF EXISTS temp.fail_recovery_clear");
        }
        report(`${host} recovery clear fails`, s, { logs: s.relevantLogs() });
        expect(recovered.messages).not.toBeNull();
        expect(signedSignatures(recovered.messages ?? [])).toEqual([]);
        expect(JSON.stringify(repeated.messages)).toBe(JSON.stringify(recovered.messages));
        expect(getThinkingBindingRecoveryTarget(s.db, sessionId)).not.toBe("");

        const next = await s.pass();
        expect(JSON.stringify(next.messages)).toBe(JSON.stringify(recovered.messages));
        expect(getThinkingBindingRecoveryTarget(s.db, sessionId) ?? "").toBe("");
        expect(s.problems).toEqual([]);
    }, 60_000);

// ── Managed mode: a binding recovery whose clear fails leaves its target armed.
// The flag is one value for every rejection, so a later pass that reads it would
// strip every block again, including thinking produced after the recovery. A
// failed clear is retried at the start of every later pass until it succeeds,
// and while it keeps failing the recovery this process already applied is not
// applied again (its strips are saved and replay on every pass).
for (const host of HOSTS)
    it(`${host}: an uncleared binding recovery target never strips thinking produced after the recovery`, async () => {
        const sessionId = `spe-recovery-stale-target-${host}`;
        const s = session(host, sessionId);
        s.user("long task");
        await s.pass();
        for (let n = 1; n <= 2; n++) {
            s.step(n, 200);
            await s.pass();
        }
        s.user("next task");
        await s.pass();
        armThinkingBindingRecovery(s.db, sessionId);
        dropSlot(sessionId, "thinking_binding_recovery");
        s.db.exec(
            "CREATE TEMP TRIGGER fail_recovery_clear BEFORE UPDATE OF thinking_binding_recovery_target ON session_meta WHEN NEW.thinking_binding_recovery_target = '' BEGIN SELECT RAISE(ABORT, 'recovery clear failed'); END",
        );
        let later: Awaited<ReturnType<typeof s.pass>>;
        try {
            const recovered = await s.pass();
            expect(signedSignatures(recovered.messages ?? [])).toEqual([]);
            // The next turn thinks after the recovery went out.
            for (let n = 3; n <= 4; n++) {
                s.step(n, 200);
                await s.pass();
            }
            // That turn ends; no open turn protects its thinking any more.
            s.user("one more thing");
            later = await s.pass();
        } finally {
            s.db.exec("DROP TRIGGER IF EXISTS temp.fail_recovery_clear");
        }
        report(`${host} stale recovery target`, s, { logs: s.relevantLogs() });
        expect(getThinkingBindingRecoveryTarget(s.db, sessionId)).not.toBeNull();
        expect(signedSignatures(later.messages ?? [])).toEqual(["sig-3", "sig-4"]);
        // The first pass whose retried clear succeeds clears it, and keeps the thinking.
        const after = await s.pass();
        expect(getThinkingBindingRecoveryTarget(s.db, sessionId)).toBeNull();
        expect(signedSignatures(after.messages ?? [])).toEqual(["sig-3", "sig-4"]);
        expect(s.problems).toEqual([]);
    }, 60_000);

// ── Managed mode: host callbacks the transform calls after it captured its
// request (auto-embed scheduling, the pass-permission report) can fail. The
// request is decided by then: the pass is served, it is the request saved as
// the last good one in memory and on disk, and the statements after the
// failing one still run.
for (const host of HOSTS)
    for (const failing of ["maybeAutoEmbedSession", "onPassPermission"] as const)
        it(`${host}: a failing ${failing} after the capture still serves the pass and saves it`, async () => {
            const sessionId = `spe-after-capture-${failing}-${host}`;
            const calls: string[] = [];
            const callback = (name: typeof failing) => () => {
                calls.push(name);
                if (name === failing) throw new Error(`${name} failed`);
            };
            const s = session(host, sessionId, {
                transformDeps: {
                    maybeAutoEmbedSession: callback("maybeAutoEmbedSession"),
                    onPassPermission: callback("onPassPermission"),
                },
            });
            s.user("long task");
            await s.pass();
            s.step(1, 200);
            calls.length = 0;
            const out = await s.pass();
            expect(out.messages).not.toBeNull();
            expect(calls).toEqual(["maybeAutoEmbedSession", "onPassPermission"]);
            expect(
                s.logs.some((line) =>
                    line.includes("failed after the request was decided; serving the pass"),
                ),
            ).toBe(true);
            const served = JSON.parse(JSON.stringify(out.messages));
            expect(JSON.parse(getInMemorySlot(sessionId)?.jsonPrefix ?? "null")).toEqual(served);
            // The deferred save runs after the pass returns.
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(JSON.parse(loadPersistedLkgSlot(s.db, sessionId)?.jsonPrefix ?? "null")).toEqual(
                served,
            );
        }, 60_000);

// ── Managed mode: an idle-expired request at the start of a new turn may
// advance the system date (the open turn has no signed thinking yet), but the
// earlier turn's signed thinking is still on the wire behind the system prompt.
for (const host of HOSTS)
    for (const systemFirst of [false, true])
        it(`${host}: an idle-expired first request of a new turn with a day rollover keeps the earlier turn's thinking behind the date (system ${systemFirst ? "first" : "after messages"})`, async () => {
            const s = session(host, `spe-date-oldturn-${host}-${systemFirst}`);
            s.user("long task");
            await s.pass("2026-10-21", { systemFirst });
            for (let n = 1; n <= 3; n++) {
                s.step(n, 200);
                await s.pass("2026-10-21", { systemFirst });
            }
            s.user("next task");
            s.idle();
            const out = await s.pass("2026-10-22", { systemFirst });
            report(`${host} date old-turn idle systemFirst=${systemFirst}`, s, {
                prompt: out.prompt?.match(/Date: \S+/)?.[0],
                kept: signedSignatures(out.messages ?? []),
                logs: s.relevantLogs(),
            });
            expect(s.problems).toEqual([]);
        }, 60_000);

// ── Managed mode: an idle-expired pass that holds the open signed turn (heavy
// reasoning a step back) keeps the turn's thinking on the wire, so the system
// date in front of it must stay frozen after a day rollover until a pass strips
// the thinking or the turn ends. The turn's opening user message is first
// summarized into history and trimmed from the array, as in a long turn; the
// thinking the hold keeps then follows no real user message in the array.
for (const host of HOSTS)
    for (const systemFirst of [true, false])
        it(`${host}: a held idle-expired pass of a signed turn keeps the date frozen after a day rollover (system ${systemFirst ? "first" : "after messages"})`, async () => {
            const s = session(host, `spe-date-held-idle-${host}-${systemFirst}`);
            s.user("long task");
            await s.pass("2026-10-21", { systemFirst });
            for (let n = 1; n <= 2; n++) {
                s.step(n, 200);
                await s.pass("2026-10-21", { systemFirst });
            }
            // History covers the user message and the first step; a flush
            // publishes it and trims them from the array.
            s.compartment(1);
            s.flush();
            s.step(3, 200);
            await s.pass("2026-10-21", { systemFirst });
            s.step(4, 2_400);
            await s.pass("2026-10-21", { systemFirst });
            s.step(5, 200);
            await s.pass("2026-10-22", { systemFirst });
            s.idle();
            s.step(6, 200);
            const out = await s.pass("2026-10-22", { systemFirst });
            report(`${host} date held idle systemFirst=${systemFirst}`, s, {
                prompt: out.prompt?.match(/Date: \S+/)?.[0],
                kept: signedSignatures(out.messages ?? []),
                roles: (out.messages ?? []).map((m) => `${String(m.info.id)}`),
                logs: s.relevantLogs().filter((l) => /date|hold|frozen|strip/i.test(l)),
            });
            expect(s.problems).toEqual([]);
            // The case only means something if the thinking is still served.
            expect(signedSignatures(out.messages ?? []).length).toBeGreaterThan(0);
        }, 60_000);

// ── Forks: a fork made while the parent serves a last-good replay's tail
// untagged. The durable record keeps the parent's message ids, which the fork
// does not have.
for (const host of HOSTS)
    for (const nextIsUser of [true, false])
        it(`${host}: a fork after a last-good replay, then ${nextIsUser ? "a new real user" : "another step of the open turn"} on the fork`, async () => {
            const s = session(host, `spe-fork-lkg-${host}-${nextIsUser}`);
            s.user("long task");
            await s.pass();
            s.step(1, 2_400);
            await s.pass();
            s.failNextPass();
            s.step(2, 200);
            await s.pass();
            s.step(3, 200);
            await s.pass();
            s.fork(`spe-fork-lkg-${host}-${nextIsUser}-child`);
            if (nextIsUser) s.user("next task");
            else s.step(4, 200);
            const out = await s.pass();
            report(`${host} fork after lkg user=${nextIsUser}`, s, {
                kept: signedSignatures(out.messages ?? []),
                tools: toolHeads(out.messages ?? []),
                logs: s.relevantLogs(),
            });
            expect(s.problems).toEqual([]);
        }, 60_000);

// ── A session whose replay document the strict parser refuses (an invalid
// trailing-blank decision), then a last-good replay on a held turn. The case
// asserts that the following defer passes are served by the transform; it is
// red when they are all replaced by last-good replays instead.
// Open defect: a replay document the strict parser refuses turns every later pass into a last-good replay.
for (const host of HOSTS)
    it.skipIf(!OPEN_DEFECTS)(
        `${host}: a replay document the strict parser refuses, then a last-good replay on a held turn`,
        async () => {
            const sessionId = `spe-baddoc-${host}`;
            const s = session(host, sessionId);
            s.user("long task");
            await s.pass();
            s.step(1, 2_400);
            await s.pass();
            s.db
                .prepare(
                    "UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?",
                )
                .run(JSON.stringify({ version: 2, trailingBlank: { ghost: "keep:1" } }), sessionId);
            s.failNextPass();
            s.step(2, 200);
            await s.pass();
            let replays = 0;
            let refused = 0;
            const trail: string[] = [];
            for (let n = 3; n <= 8; n++) {
                s.step(n, 200);
                const out = await s.pass();
                const replayed = s.logs.some((l) => l.includes("lkg_replay_served"));
                if (replayed) replays++;
                if (!out.messages) refused++;
                trail.push(
                    `${n}:${out.messages ? (replayed ? "replay" : "served") : "refused"}${s.logs.some((l) => l.includes("untagged")) ? "+untagged-log" : ""}`,
                );
            }
            report(`${host} bad replay doc`, s, { replays, refused, trail });
            expect(s.problems).toEqual([]);
            // Defer passes of a held turn should be served by the transform,
            // not replaced by last-good replays one after another.
            expect(replays).toBe(0);
        },
        60_000,
    );

// ── The durable untagged-message record when its writes fail (a busy
// database). Only writes of that record fail; every other replay-document
// write goes through. Base has no record, so there the same stream shows what
// the record is meant to prevent.
function failUntaggedRecordWrites(): { stop: () => void; failures: () => number } {
    let failures = 0;
    const original = replayDocumentModule.updateReplayDocument;
    const spy = spyOn(replayDocumentModule, "updateReplayDocument").mockImplementation(
        (db, sessionId, mutate) => {
            if (String(mutate).includes("lkgUntaggedInputIds")) {
                failures++;
                return false;
            }
            return original(db, sessionId, mutate);
        },
    );
    return { stop: () => spy.mockRestore(), failures: () => failures };
}

for (const host of HOSTS) {
    it(`${host}: the untagged-message record cannot be written for four passes after a last-good replay on a held turn`, async () => {
        const s = session(host, `spe-recordfail-loop-${host}`);
        s.user("long task");
        await s.pass();
        s.step(1, 2_400);
        await s.pass();
        const failing = failUntaggedRecordWrites();
        s.failNextPass();
        s.step(2, 200);
        await s.pass();
        const trail: string[] = [];
        for (let n = 3; n <= 6; n++) {
            s.step(n, 200);
            const out = await s.pass();
            trail.push(
                `${n}:${out.messages ? (s.logs.some((l) => l.includes("lkg_replay_served")) ? "replay" : "served") : "refused"}`,
            );
        }
        failing.stop();
        s.step(7, 200);
        const after = await s.pass();
        trail.push(
            `7:${after.messages ? (s.logs.some((l) => l.includes("lkg_replay_served")) ? "replay" : "served") : "refused"}`,
        );
        report(`${host} record write failing x4`, s, {
            trail,
            failures: failing.failures(),
            tools: toolHeads(after.messages ?? []),
        });
        expect(s.problems).toEqual([]);
    }, 60_000);

    // Open defect: a failed untagged-record write before a restart lets the next real user re-tag the replayed tail.
    it.skipIf(!OPEN_DEFECTS)(
        `${host}: the untagged-message record cannot be written at a last-good replay, then the process restarts and a new real user arrives`,
        async () => {
            const s = session(host, `spe-recordfail-restart-${host}`);
            s.user("long task");
            await s.pass();
            s.step(1, 2_400);
            await s.pass();
            const failing = failUntaggedRecordWrites();
            s.failNextPass();
            s.step(2, 200);
            await s.pass();
            s.step(3, 200);
            await s.pass();
            failing.stop();
            // Both writes of the record failed (at the replay and on the next
            // pass), so after the restart nothing says the replayed result was
            // served untagged; the new real user makes the next pass a defer pass.
            s.user("next task");
            s.restart();
            const out = await s.pass();
            report(`${host} record write failed, restart + user`, s, {
                failures: failing.failures(),
                kept: signedSignatures(out.messages ?? []),
                tools: toolHeads(out.messages ?? []),
                logs: s.relevantLogs(),
            });
            expect(s.problems).toEqual([]);
        },
        60_000,
    );
}

// ── Compaction-off first render with nothing changed in the head: the strip
// is needed only when the new head differs from the one served. This measures
// whether an unchanged head keeps the turn's thinking, warm and after a restart.
// Open defect (restart without a saved last-good slot): a compaction-off first render strips thinking even when its head is unchanged.
for (const host of HOSTS)
    for (const [restart, settle] of [
        [false, false],
        [true, false],
        [true, true],
    ] as const)
        it.skipIf(restart && !settle && !OPEN_DEFECTS)(
            `${host}: compaction-off, a first render with an unchanged head ${restart ? "after a restart" : "in the same process"}${settle ? " (each last-good save landed)" : ""} keeps the turn's thinking`,
            async () => {
                const s = session(host, `spe-off-same-head-${host}-${restart}-${settle}`, {
                    compactionOff: true,
                });
                // The last-good slot is saved to disk on a later tick; let it land.
                const pass = async () => {
                    await s.pass();
                    if (settle)
                        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
                };
                s.user("run some bash commands");
                await pass();
                for (let n = 1; n <= 3; n++) {
                    s.step(n, 200);
                    await pass();
                }
                s.clearHead();
                if (restart) s.restart();
                s.step(4, 200);
                const out = await s.pass();
                report(`${host} off same-head restart=${restart}`, s, {
                    kept: signedSignatures(out.messages ?? []),
                    logs: s.relevantLogs().filter((l) => /strip|first_render|frozen/.test(l)),
                });
                expect(s.problems).toEqual([]);
                expect(signedSignatures(out.messages ?? [])).toEqual([
                    "sig-1",
                    "sig-2",
                    "sig-3",
                    "sig-4",
                ]);
            },
            60_000,
        );

// ── A switch between managed and compaction-off mode inside a signed turn.
// Compaction-off writes no tags, so a switch to it removes every §N§ prefix
// the managed passes served, and a switch back adds them, in front of the
// turn's thinking, even when the rendered head is the same. Each pass lets the
// last-good save land, as a real session does between requests.
for (const host of HOSTS)
    for (const toCompactionOff of [true, false])
        it(`${host}: a switch from ${toCompactionOff ? "managed to compaction-off" : "compaction-off to managed"} mode inside a signed turn`, async () => {
            const s = session(host, `spe-switch-${host}-${toCompactionOff}`, {
                compactionOff: !toCompactionOff,
            });
            const pass = async () => {
                const out = await s.pass();
                for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
                return out;
            };
            s.user("run some bash commands");
            await pass();
            s.step(1, 2_400);
            await pass();
            for (let n = 2; n <= 3; n++) {
                s.step(n, 200);
                await pass();
            }
            s.switchMode(toCompactionOff);
            s.step(4, 200);
            const out = await pass();
            report(`${host} switch toCompactionOff=${toCompactionOff} mid-turn`, s, {
                kept: signedSignatures(out.messages ?? []),
                logs: s.relevantLogs().filter((l) => /strip|first_render|frozen|mode/i.test(l)),
            });
            expect(s.problems).toEqual([]);
        }, 60_000);

// ── A restart after a day rollover: the sticky system date must survive the
// restart, or the first request after it carries the new date in front of
// whatever signed thinking that request keeps.
for (const host of HOSTS)
    for (const compactionOff of [true, false])
        it(`${host}: a restart after a day rollover inside a signed turn (${compactionOff ? "compaction-off" : "managed"})`, async () => {
            const s = session(host, `spe-date-restart-${host}-${compactionOff}`, {
                compactionOff,
            });
            s.user("run some bash commands");
            await s.pass("2026-10-21");
            s.step(1, 2_400);
            await s.pass("2026-10-21");
            s.step(2, 200);
            await s.pass("2026-10-22");
            s.restart();
            s.step(3, 200);
            const out = await s.pass("2026-10-22");
            report(`${host} date restart off=${compactionOff}`, s, {
                prompt: out.prompt?.match(/Date: \S+/)?.[0],
                kept: signedSignatures(out.messages ?? []),
                logs: s.relevantLogs().filter((l) => /date|strip|hash/i.test(l)),
            });
            expect(s.problems).toEqual([]);
        }, 60_000);
