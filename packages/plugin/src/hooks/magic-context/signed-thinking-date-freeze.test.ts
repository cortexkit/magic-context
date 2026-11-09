/// <reference types="bun-types" />
// Regression guards for the system date in front of signed thinking on
// prefix-bound models (Opus 5.5 and its family, which reject a signed thinking
// block when any byte in front of it changed, the system prompt included). The
// cases cover a held idle-expired pass on the Anthropic API and on Bedrock, a
// compaction-off session over several days and restarts, and a simulated
// store-generation rebase. A failing case means invalid signed thinking was
// served, or (the multi-day case) that the served date did not follow its
// intended rule: frozen in compaction-off, current in managed mode; each case's
// comment says why.
//
// The harness matches the one in signed-thinking-prefix-edits.test.ts with two
// additions: the session can run on another route of a prefix-bound model
// (Bedrock, whose reasoning parts carry `metadata.bedrock` rather than
// `metadata.anthropic`), and the strict-binding oracle recognises signed
// reasoning under either metadata key. The oracle flags a signed thinking
// block served behind any provider-visible byte, or a system date, that
// differs from the request that produced it (a gap-free run of the oldest
// blocks may be missing).
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
import { clearCachedM0M1 } from "../../features/magic-context/storage-meta-shared";
import { bumpProjectMemoryEpoch } from "../../features/magic-context/storage-project-state";
import { createTagger } from "../../features/magic-context/tagger";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import * as loggerModule from "../../shared/logger";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { forkCloneFilter } from "../../v2/fork-inheritance";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { requestPendingMaterialization } from "./pending-materialization";
import { providerVisiblePart } from "./provider-visible-parts";
import { bindSystemDateRequestIdentity, registerSystemDateRefresh } from "./system-date-refresh";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { createTransform } from "./transform";

const VERBOSE = process.env.MC_SIGNED_THINKING_VERBOSE === "1";
const ANTHROPIC_OPUS = { providerID: "anthropic", modelID: "claude-opus-5-5" };
/** Opus 5.5 on Bedrock: prefix-bound as well (isPrefixBoundThinkingModel ignores the provider). */
const BEDROCK_OPUS = { providerID: "amazon-bedrock", modelID: "us.anthropic.claude-opus-5-5-v1:0" };
type Model = typeof ANTHROPIC_OPUS;
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

/** The provider-specific metadata record of a signed reasoning part (Anthropic or Bedrock). */
const signedMetadata = (part: Part) => {
    const metadata = part.metadata as
        | { anthropic?: { signature?: unknown }; bedrock?: { signature?: unknown } }
        | undefined;
    return metadata?.anthropic ?? metadata?.bedrock;
};
const isThinking = (part: Part) =>
    part.type === "reasoning" &&
    typeof part.text === "string" &&
    part.text !== "" &&
    signedMetadata(part) !== undefined;
const signatureOf = (part: Part) => String(signedMetadata(part)?.signature);

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
    executeThresholdPercentage?: number;
    /** The route and model (default: Opus 5.5 on the Anthropic API). */
    model?: Model;
}

/**
 * One OpenCode session on a prefix-bound model (Opus 5.5 on the Anthropic API
 * unless `options.model` names another route). `pass()` serves the current
 * source through the production wrapper and, when given a date, the
 * system-prompt hook after it (OpenCode 1's usual order; OpenCode 2 runs the
 * hook first, see `systemFirst`), both stages bound to one request identity. The
 * oracle also treats the system prompt as part of the prefix: a kept block
 * born under one date must not be served under another.
 */
function session(
    host: "opencode1" | "opencode2",
    initialSessionId: string,
    options: SessionOptions = {},
) {
    let sessionId = initialSessionId;
    const MODEL = options.model ?? ANTHROPIC_OPUS;
    // Bedrock reasoning parts carry their signature under `metadata.bedrock`.
    const metadataKey = MODEL.providerID === "amazon-bedrock" ? "bedrock" : "anthropic";
    const dataHome = createTestTempDir("mc-sdf-data-").dir;
    const directory = createTestTempDir("mc-sdf-session-").dir;
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
                        metadata: { [metadataKey]: { signature: `sig-${n}` } },
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
        /**
         * What a store-generation rebase that moved coordinates does to the
         * session's prompt state (store-generation-rebase.ts): it clears the
         * cached m[0]/m[1] and the persisted system-prompt hash.
         */
        rebaseClearsPromptState() {
            clearCachedM0M1(db, sessionId);
            db.prepare("UPDATE session_meta SET system_prompt_hash = '' WHERE session_id = ?").run(
                sessionId,
            );
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
         * messages transform, or before it with `systemFirst` (OpenCode 2's
         * order); both stages share one request identity.
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
                /hold|frozen|WILL|strip|fold decision|lkg|LKG|REFUSED|date|release|normaliz|rebase|hash/i.test(
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

// ── Signed thinking on every Anthropic-family route. The system date waits
// while the served array carries signed thinking (servesThinkingBlock in
// transform-postprocess-phase.ts). Opus 5.5 is prefix-bound on Bedrock too,
// where OpenCode stores the signature under `metadata.bedrock` rather than
// `metadata.anthropic`, so the check must count thinking by route, not by one
// metadata key. Otherwise on Bedrock an idle-expired request that holds the
// open signed turn (heavy reasoning a step back) moves the date in front of the
// thinking it keeps.
for (const host of HOSTS)
    for (const model of [ANTHROPIC_OPUS, BEDROCK_OPUS])
        for (const systemFirst of [true, false])
            it(`${host}: ${model.providerID}: a held idle-expired pass keeps the open turn's thinking and the date frozen after a day rollover (system ${systemFirst ? "first" : "after messages"})`, async () => {
                const s = session(
                    host,
                    `sdf-date-held-${host}-${model.providerID}-${systemFirst}`,
                    {
                        model,
                    },
                );
                s.user("long task");
                await s.pass("2026-10-21", { systemFirst });
                for (let n = 1; n <= 2; n++) {
                    s.step(n, 200);
                    await s.pass("2026-10-21", { systemFirst });
                }
                // Heavy reasoning on the newest step: the next pass holds the turn.
                s.step(3, 2_400);
                await s.pass("2026-10-21", { systemFirst });
                s.step(4, 200);
                s.idle();
                const out = await s.pass("2026-10-22", { systemFirst });
                report(`${host} ${model.providerID} held idle systemFirst=${systemFirst}`, s, {
                    prompt: out.prompt?.match(/Date: \S+/)?.[0],
                    kept: signedSignatures(out.messages ?? []),
                    logs: s.relevantLogs().filter((l) => /date|hold|frozen|strip/i.test(l)),
                });
                // The case only means something if the turn's thinking is still served.
                expect(signedSignatures(out.messages ?? []).length).toBeGreaterThan(0);
                expect(s.problems).toEqual([]);
            }, 60_000);

// ── The system date can stay frozen for days. With the prompt otherwise
// unchanged, it moves only on a request that serves no signed thinking at all.
// Compaction-off never strips earlier turns'
// thinking on its own (only a fold that changes m[0]/m[1], or a mode switch,
// does), and the date is restored after a restart, so a compaction-off session
// on a prefix-bound model whose docs and memory do not change keeps the date
// of its first request: here five days of one idle-expired turn per day. That
// is the intended trade: a stale date only costs the model accuracy about
// today, while a moved date in front of served signed thinking invalidates
// that thinking and the provider rejects the request. So compaction-off
// asserts the first day's date on every day. Managed mode is run alongside: an
// idle expiry only means the provider forgot its cache, so the pass replays
// the same bytes and keeps the earlier thinking, and the date stays frozen
// through every idle day as well. It moves on the next real rebuild (here a
// /ctx-flush that lands a queued drop on the last day), which changes bytes in
// front of the signed thinking, strips it, and so frees the date.
for (const host of HOSTS)
    for (const compactionOff of [true, false])
        it(`${host}: ${compactionOff ? "compaction-off" : "managed"}: one idle-expired turn a day for five days serves the first day's frozen date throughout${compactionOff ? "" : ", then the current date after a real rebuild"}`, async () => {
            const sessionId = `sdf-date-days-${host}-${compactionOff}`;
            const s = session(host, sessionId, { compactionOff, memory: true });
            const days = ["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
            const served: string[] = [];
            let n = 0;
            for (const [index, day] of days.entries()) {
                if (index > 0) {
                    s.idle();
                    // A restart overnight, as when the machine sleeps or the host updates.
                    if (index === 2) s.restart();
                }
                s.user(`task of ${day}`);
                await s.pass(day);
                for (let k = 0; k < 3; k++) {
                    s.step(++n, 200);
                    const out = await s.pass(day);
                    if (k === 2) served.push(out.prompt?.match(/Date: (\S+)/)?.[1] ?? "?");
                }
            }
            expect(served).toEqual(days.map(() => days[0]));
            if (!compactionOff) {
                const today = days.at(-1)!;
                s.dropOldestTool();
                // /ctx-flush queues two things: a forced rebuild of m[0]/m[1],
                // which lands the queued drop and strips the earlier signed
                // thinking, and a system-prompt refresh, which lets that
                // rebuilding pass move the date.
                s.flush();
                s.systemPromptRefreshSessions.add(sessionId);
                s.step(++n, 200);
                const rebuilt = await s.pass(today);
                served.push(rebuilt.prompt?.match(/Date: (\S+)/)?.[1] ?? "?");
                expect(served.at(-1)).toBe(today);
            }
            report(`${host} off=${compactionOff} five days`, s, { served });
            expect(s.problems).toEqual([]);
        }, 60_000);

// ── A store-generation rebase clears the saved prompt hash before the system
// hook runs. The date must stay frozen through that reset while signed
// thinking is still served; it matters most in compaction-off, which keeps a
// frozen date for days (case above). OpenCode 2 rebases a
// converted session before the system hook (v2/hooks/context.ts,
// "Rebase before it so a converted session initializes the new host's prompt
// hash"), and a rebase that moved coordinates clears system_prompt_hash and
// the cached m[0]/m[1]. The system hook then finds no hash; it must keep the
// previous date and move it only through the same rule as any other date
// change, which checks the signed thinking the request keeps. Here the date was frozen by a
// rollover inside a signed turn, so the adopted date differs from the one that
// thinking was born under. Red means the rebase request served kept thinking
// behind a changed date.
for (const host of HOSTS)
    for (const compactionOff of [true, false])
        it(`${host}: ${compactionOff ? "compaction-off" : "managed"}: a rebase that clears the prompt hash before the system hook keeps a frozen date in front of kept thinking`, async () => {
            const systemFirst = true;
            const s = session(host, `sdf-rebase-date-${host}-${compactionOff}`, {
                compactionOff,
                memory: true,
            });
            s.user("long task");
            await s.pass("2026-10-21", { systemFirst });
            for (let n = 1; n <= 3; n++) {
                s.step(n, 200);
                await s.pass("2026-10-21", { systemFirst });
            }
            // Midnight inside the turn: the date stays frozen.
            s.step(4, 200);
            const frozen = await s.pass("2026-10-22", { systemFirst });
            s.step(5, 200);
            s.rebaseClearsPromptState();
            const out = await s.pass("2026-10-22", { systemFirst });
            report(`${host} off=${compactionOff} rebase clears hash`, s, {
                frozenPrompt: frozen.prompt?.match(/Date: \S+/)?.[0],
                prompt: out.prompt?.match(/Date: \S+/)?.[0],
                kept: signedSignatures(out.messages ?? []),
                logs: s.relevantLogs().filter((l) => /date|hash|strip|first_render/i.test(l)),
            });
            expect(frozen.prompt).toContain("Date: 2026-10-21");
            expect(s.problems).toEqual([]);
        }, 60_000);
