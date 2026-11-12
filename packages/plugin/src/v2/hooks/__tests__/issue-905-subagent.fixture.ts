// In-process reproduction of the session in GitHub issue 905: an OpenCode 2
// subagent on a prefix-bound thinking model that works on one task message as a
// single turn of many tool steps, with signed reasoning on every step, and calls
// ctx_reduce on most of its tool outputs as it goes.
//
// The real OpenCode 2 context hook serves every request. Each assistant step is
// then stored with the provider input of the request that produced it, computed
// from what that request actually served (plus a fixed allowance for the system
// prompt and tool definitions, which the hook does not see). The next request's
// usage reading is that number, so pressure follows from what Magic Context
// served and is never set by the test.
import { spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../../../config";
import { MagicContextConfigSchema } from "../../../config/schema/magic-context";
import {
    closeDatabase,
    getTagsBySession,
    queuePendingOp,
} from "../../../features/magic-context/storage";
import { resetCtxReduceRegisteredGloballyForTest } from "../../../hooks/magic-context/ctx-reduce-availability";
import { resolveDecisionCalibration } from "../../../hooks/magic-context/decision-calibration";
import { resetLkgSlotsForTest } from "../../../hooks/magic-context/lkg-slot";
import { estimateTokens } from "../../../hooks/magic-context/read-session-formatting";
import { _resetDreamTimerForTests } from "../../../plugin/dream-timer";
import { setHarness } from "../../../shared/harness";
import * as logger from "../../../shared/logger";
import { resetOpenCodeDbPathStateForTesting } from "../../../shared/opencode-db-path";
import { openTestDatabase, openTestDb } from "../../../shared/test-db";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { resetHostMediaForTests } from "../../fold/host-media";
import { restoreRow } from "../../fold/restore";
import type { StoreRow } from "../../store-reader";
import { registerContext } from "../context";
import * as storageGate from "../storage-gate";
import type { SessionContext, V2Context, V2Message } from "../types";

/** The reporter's model and limits (issue 905). */
export const ISSUE_905_MODEL = "claude-mythos-5-2";
export const ISSUE_905_CONTEXT = 302_222;
export const ISSUE_905_EXECUTE_TOKENS = 250_000;
export const ISSUE_905_PROTECTED_TOKENS = 16_000;

export interface Issue905Scenario {
    seed: number;
    /** Assistant steps in the single turn. */
    steps: number;
    /** `limit` the host reports for the model. */
    limit?: { context: number; output?: number };
    /**
     * "visible": the stored reasoning carries its text.
     * "omitted": the text is empty and only the signature is stored (Anthropic
     * `display: "omitted"`); the provider still counts the thinking as input.
     */
    thinking?: "visible" | "omitted";
    /** Tokens the provider counts for the system prompt and tool definitions. */
    overheadTokens?: number;
    /** Steps between two ctx_reduce calls. */
    reduceEvery?: number;
    /** A read output the agent keeps active is every Nth read. */
    keepEveryNthRead?: number;
    /** How many steps old a read must be before the agent reduces it. */
    reduceAfterSteps?: number;
    /**
     * When set, the agent keeps its newest N reads active and reduces older
     * ones (instead of keeping every Nth read for good).
     */
    activeReads?: number;
    /** Relative size of the step's thinking. */
    thinkingScale?: number;
    /** Relative size of tool outputs. */
    outputScale?: number;
    /** Fraction of steps whose thinking is heavy (above the hold's 1,500 tokens). */
    heavyShare?: number;
    /** Size of the task message, in tokens. */
    taskTokens?: number;
    /**
     * false: the provider reports no input usage, so every pass reads only a
     * local count of its own request.
     */
    reportUsage?: boolean;
    /** Extra plugin settings. */
    configOverrides?: Record<string, unknown>;
}

/** Token counts of one served request, by class, in provider tokens. */
export interface Composition {
    /** Signed reasoning text the request still carries. */
    thinking: number;
    /** Thinking the provider counts for served blocks whose text is omitted. */
    hiddenThinking: number;
    /** Signed reasoning blocks still served (with or without text). */
    thinkingBlocks: number;
    assistantText: number;
    toolInputs: number;
    /** Tool results still carrying their output. */
    toolOutputs: number;
    toolOutputCount: number;
    /** `[dropped §N§]` placeholders (tool results or text). */
    placeholders: number;
    placeholderCount: number;
    /** The task message. */
    task: number;
    /** Anything else the hook served (head messages, nudges, system rows). */
    other: number;
    /** System prompt and tool definitions (the scenario's fixed allowance). */
    overhead: number;
    total: number;
}

export interface Issue905Pass {
    step: number;
    /** Provider input the pass read as its usage (the previous request's size). */
    usageInput: number;
    /** That reading as a percentage of the declared context limit. */
    usageOfDeclared: number;
    /** Magic Context's own percentage from its scheduler line. */
    mcPercentage: number | null;
    decision: string | null;
    served: Composition;
    /** SHA-256 of the messages the hook served, as JSON. */
    servedDigest: string;
    logs: string[];
    /** `signed thinking hold:` line of this pass, when it logged one. */
    holdLine: string | null;
    thinkingHold: boolean | null;
    rewriteAllowed: boolean | null;
    signedPrefixRelease: boolean | null;
    ride: string | null;
    proactiveStripFroze: number | null;
    /** Ids the proactive strip froze on this pass. */
    proactiveStripIds: string[];
    pendingApplied: boolean;
    pendingQueuedBefore: number;
    /** Queued drops still waiting after the pass. */
    pendingQueuedAfter: number;
    /** `transform: final-wire telemetry` fields of this pass. */
    finalWire: {
        estimate: number;
        conversation: number;
        tools: number;
        system: number;
        toolDefinitions: number;
    } | null;
    /** `mergedReasoningParts` of the `final representation:` line. */
    mergedReasoningParts: number | null;
    removedReasoningParts: number | null;
    emergency: string | null;
    emergencyFloor: number | null;
    threshold: number | null;
    finalRepresentation: string | null;
}

export interface Issue905Run {
    passes: Issue905Pass[];
    /** Every session log line of the run. */
    logs: string[];
    /** Channel-2 synthetic messages the hook asked the host to deliver. */
    synthetic: unknown[];
    /** Tool tags the agent queued drops for. */
    reducedTags: number;
    /** Reads the agent chose to keep. */
    keptReads: number;
    session: string;
    /** Number of assistant steps whose reasoning was frozen, by step index. */
    rows: Array<{ id: string; step: number; thinkingTokens: number }>;
}

type ToolCall = { id: string; name: string; input: Record<string, unknown>; output: string };
type Row = {
    id: string;
    type: "user" | "assistant";
    seq: number;
    created: number;
    text: string;
    reasoning?: string;
    hiddenThinkingTokens?: number;
    tools?: ToolCall[];
    inputTokens?: number;
};

function rng(seed: number) {
    let state = seed >>> 0 || 1;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const WORDS =
    "the cache prefix request signed thinking block window session tool output reduce drop placeholder historian subagent provider usage threshold planner floor ceiling budget assistant reasoning model binding signature request pass rebuild hold strip lane emergency latch pressure episode step turn message task oracle review module function variable parameter return value error branch condition loop index offset buffer stream parser schema record field column table query transaction commit rollback migration storage database".split(
        " ",
    );

/** Deterministic prose of roughly `tokens` tokens. */
function prose(random: () => number, tokens: number, tag: string): string {
    const words: string[] = [tag];
    // About 1.25 words per token for this vocabulary, measured with the
    // repository's tokenizer; exact size does not matter, only scale.
    const count = Math.max(4, Math.round(tokens * 0.8));
    for (let i = 0; i < count; i++) {
        words.push(WORDS[Math.floor(random() * WORDS.length)]!);
        if (i % 14 === 13) words.push(".\n");
    }
    return words.join(" ");
}

/** File-like tool output of roughly `tokens` tokens. */
function fileOutput(random: () => number, tokens: number, tag: string): string {
    const lines: string[] = [`<file ${tag}>`];
    let budget = tokens;
    let n = 1;
    while (budget > 0) {
        const line = `${n}: const ${WORDS[Math.floor(random() * WORDS.length)]}_${n} = ${WORDS[Math.floor(random() * WORDS.length)]}(${Math.floor(random() * 1000)}, "${WORDS[Math.floor(random() * WORDS.length)]}");`;
        lines.push(line);
        budget -= 14;
        n++;
    }
    return lines.join("\n");
}

const PLACEHOLDER = /^\[dropped §\d+§\]$/;

export async function runIssue905Session(scenario: Issue905Scenario): Promise<Issue905Run> {
    const {
        seed,
        steps,
        limit = { context: ISSUE_905_CONTEXT },
        thinking = "visible",
        overheadTokens = 27_000,
        reduceEvery = 2,
        keepEveryNthRead = 9,
        reduceAfterSteps = 2,
        activeReads,
        thinkingScale = 1,
        outputScale = 1,
        heavyShare = 0.35,
        taskTokens = 400,
        reportUsage = true,
        configOverrides = {},
    } = scenario;
    const random = rng(seed);
    setHarness("opencode2");
    const base = join(tmpdir(), "magic-context", "issue-905");
    mkdirSync(base, { recursive: true });
    const root = createTestTempDirFromPath(join(base, `seed-${seed}-`));
    const keys = [
        "HOME",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "MAGIC_CONTEXT_STORAGE_DIR",
        "MAGIC_CONTEXT_LOG_PATH",
        "OPENCODE_DB",
    ];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) process.env[key] = join(root, key);
    let nowClock = 1_790_000_000_000 + seed * 1_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => nowClock);
    for (const key of keys.filter(
        (key) => !["MAGIC_CONTEXT_LOG_PATH", "OPENCODE_DB"].includes(key),
    ))
        mkdirSync(process.env[key]!, { recursive: true });
    resetOpenCodeDbPathStateForTesting();
    const raw = openTestDb(process.env.OPENCODE_DB!);
    raw.exec("PRAGMA busy_timeout = 5000");
    raw.exec(
        "CREATE TABLE IF NOT EXISTS session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE IF NOT EXISTS session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT);",
    );
    const db = await openTestDatabase();
    if (!db) throw new Error("isolated database unavailable");
    const realRoot = realpathSync(root);
    for (const row of db.prepare("PRAGMA database_list").all() as Array<{ file: string }>)
        if (row.file && !row.file.startsWith(`${root}/`) && !row.file.startsWith(`${realRoot}/`))
            throw new Error("database escaped isolated root");
    const config = MagicContextConfigSchema.parse({
        auto_update: false,
        embedding: { provider: "off" },
        historian: { disable: true },
        dreamer: { disable: true },
        memory: { enabled: false, git_commit_indexing: { enabled: false } },
        temporal_awareness: false,
        mural: { enabled: false },
        commit_cluster_trigger: { enabled: false },
        cache_ttl: "5m",
        protected_tokens: ISSUE_905_PROTECTED_TOKENS,
        execute_threshold_tokens: { default: ISSUE_905_EXECUTE_TOKENS },
        ...configOverrides,
    });
    const configPath = join(process.env.XDG_CONFIG_HOME!, "cortexkit");
    mkdirSync(configPath, { recursive: true });
    writeFileSync(join(configPath, "magic-context.jsonc"), JSON.stringify(config));
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        config,
    } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
    const probe = spyOn(storageGate, "probeV2StorageAtBoot").mockResolvedValue(db);
    const allLogs: string[] = [];
    const logs = spyOn(logger, "sessionLog").mockImplementation((...args: unknown[]) => {
        allLogs.push(args.map(String).join(" "));
    });
    const hooks = new Map<string, (draft: SessionContext) => Promise<void>>();
    const synthetic: unknown[] = [];
    const provider = "anthropic";
    const hostContext = {
        location: { directory: root },
        agent: { transform: async () => {}, reload: async () => {} },
        model: { list: () => [{ id: ISSUE_905_MODEL, providerID: provider, limit }] },
        storage: { get: async () => undefined, set: async () => {} },
        event: { subscribe: () => (async function* () {})() },
        tool: { hook: async () => {} },
        session: {
            remove: async () => {},
            compact: async () => {},
            wait: async () => {},
            interrupt: async () => ({ interrupted: true }),
            hook: async (name: string, callback: (draft: SessionContext) => Promise<void>) => {
                hooks.set(name, callback);
            },
            get: async () => ({ location: { directory: root } }),
            // Channel-2 notices (for example a ctx_reduce reminder) are delivered
            // as host synthetic messages; the run records them and does not add
            // them to the conversation.
            synthetic: async (input: unknown) => {
                synthetic.push(input);
            },
        },
    } as unknown as V2Context;
    const session = `ses905-${seed}`;
    // The host records the parent before the child's first request: a subagent.
    raw.prepare("INSERT OR IGNORE INTO session_v2(id,directory,parent_id) VALUES (?,?,?)").run(
        session,
        root,
        "ses905-parent",
    );
    resetCtxReduceRegisteredGloballyForTest();
    resetLkgSlotsForTest();
    const duties = await registerContext(hostContext);
    if (!hooks.has("context")) throw new Error("real context hook missing");

    const rows: Row[] = [];
    let seq = 0;
    const storeData = (row: Row) =>
        row.type === "assistant"
            ? {
                  content: [
                      ...(row.reasoning !== undefined
                          ? [
                                {
                                    type: "reasoning",
                                    text: thinking === "omitted" ? "" : row.reasoning,
                                    native: { signature: `sig-${row.id}` },
                                    time: { start: row.created, completed: row.created + 500 },
                                },
                            ]
                          : []),
                      { type: "text", text: row.text },
                      ...(row.tools ?? []).map((tool) => ({
                          type: "tool",
                          id: tool.id,
                          name: tool.name,
                          state: {
                              status: "completed",
                              input: tool.input,
                              content: [{ type: "text", text: tool.output }],
                          },
                      })),
                  ],
                  model: { providerID: provider, id: ISSUE_905_MODEL },
                  time: { created: row.created, completed: row.created + 1000 },
                  finish: "tool-calls",
                  tokens: {
                      input: reportUsage ? (row.inputTokens ?? 0) : 0,
                      output: 500,
                      reasoning: row.hiddenThinkingTokens ?? 0,
                      cache: { read: 0, write: 0 },
                  },
              }
            : { text: row.text, time: { created: row.created }, metadata: {} };
    const insert = (row: Row) => {
        raw.prepare(
            "INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)",
        ).run(
            row.id,
            session,
            row.type,
            row.seq,
            row.created,
            null,
            JSON.stringify(storeData(row)),
        );
    };
    const model = { providerID: provider, id: ISSUE_905_MODEL };
    const render = (row: Row): V2Message[] =>
        restoreRow(
            {
                id: row.id,
                session_id: session,
                type: row.type,
                seq: row.seq,
                data: storeData(row),
            } as unknown as StoreRow,
            model,
        );
    const task: Row = {
        id: `r905-${seed}-task`,
        type: "user",
        seq: seq++,
        created: nowClock,
        text: `Review the cache layer and report every place where the signed thinking can be invalidated. ${prose(random, taskTokens, "TASK")}`,
    };
    rows.push(task);
    insert(task);
    nowClock += 5000;

    const tokenCache = new Map<string, number>();
    // The provider counts more tokens than the local tokenizer does; the
    // repository's measured ratios for this model family convert local counts
    // to provider counts, the same conversion Magic Context applies to its own
    // estimates. Prose (text and thinking) and tool content have separate ratios.
    const calibration = resolveDecisionCalibration(provider, ISSUE_905_MODEL);
    const localTokens = (text: string) => {
        let cached = tokenCache.get(text);
        if (cached === undefined) {
            cached = estimateTokens(text);
            tokenCache.set(text, cached);
        }
        return cached;
    };
    const tokens = (text: string) => Math.round(localTokens(text) * calibration.proseRatio);
    const toolTokens = (text: string) => Math.round(localTokens(text) * calibration.toolsRatio);
    const hiddenBySignature = new Map<string, number>();
    const compose = (messages: V2Message[]): Composition => {
        const c: Composition = {
            thinking: 0,
            hiddenThinking: 0,
            thinkingBlocks: 0,
            assistantText: 0,
            toolInputs: 0,
            toolOutputs: 0,
            toolOutputCount: 0,
            placeholders: 0,
            placeholderCount: 0,
            task: 0,
            other: 0,
            overhead: overheadTokens,
            total: 0,
        };
        for (const message of messages) {
            for (const part of message.content as Array<Record<string, unknown>>) {
                const text = typeof part.text === "string" ? part.text : "";
                if (message.role === "user") {
                    if (message.id === task.id) c.task += tokens(text);
                    else c.other += tokens(text || JSON.stringify(part));
                    continue;
                }
                if (message.role === "system") {
                    c.other += tokens(text);
                    continue;
                }
                if (part.type === "reasoning") {
                    const meta = (part.providerMetadata ?? part.native) as
                        | { anthropic?: { signature?: string } }
                        | undefined;
                    const signature = meta?.anthropic?.signature;
                    if (text !== "" || signature !== undefined) c.thinkingBlocks++;
                    c.thinking += tokens(text);
                    if (text === "" && signature !== undefined)
                        c.hiddenThinking += hiddenBySignature.get(signature) ?? 0;
                    continue;
                }
                if (part.type === "text") {
                    if (PLACEHOLDER.test(text.trim())) {
                        c.placeholders += tokens(text);
                        c.placeholderCount++;
                    } else if (message.role === "assistant") c.assistantText += tokens(text);
                    else c.other += tokens(text);
                    continue;
                }
                if (part.type === "tool-call") {
                    c.toolInputs += toolTokens(JSON.stringify(part.input ?? {}));
                    continue;
                }
                if (part.type === "tool-result") {
                    const result = part.result as { type?: string; value?: unknown } | undefined;
                    const value =
                        typeof result?.value === "string"
                            ? result.value
                            : JSON.stringify(result?.value ?? "");
                    if (PLACEHOLDER.test(value.trim())) {
                        c.placeholders += toolTokens(value);
                        c.placeholderCount++;
                    } else {
                        c.toolOutputs += toolTokens(value);
                        c.toolOutputCount++;
                    }
                    continue;
                }
                c.other += tokens(JSON.stringify(part));
            }
        }
        c.total =
            c.overhead +
            c.thinking +
            c.hiddenThinking +
            c.assistantText +
            c.toolInputs +
            c.toolOutputs +
            c.placeholders +
            c.task +
            c.other;
        return c;
    };

    const passes: Issue905Pass[] = [];
    const reads: Array<{ step: number; callId: string; keep: boolean }> = [];
    const reduced = new Set<string>();
    let readCount = 0;
    let lastInput = 0;
    const tools = {
        read: { description: "Read a file", input: { type: "object" } },
        grep: { description: "Search files", input: { type: "object" } },
        ctx_reduce: { description: "Drop tagged content", input: { type: "object" } },
    };
    try {
        for (let step = 1; step <= steps; step++) {
            const draft: SessionContext = {
                sessionID: session,
                model: { providerID: provider, id: ISSUE_905_MODEL, limit },
                agent: "oracle",
                system: [{ type: "text", text: "You are a careful code reviewer." }],
                tools: structuredClone(tools),
                options: {},
                messages: structuredClone(rows.flatMap(render)),
            } as unknown as SessionContext;
            const before = allLogs.length;
            const queued = () =>
                (
                    db
                        .prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ?")
                        .get(session) as { n: number }
                ).n;
            const pendingQueuedBefore = queued();
            await hooks.get("context")!(draft);
            const pendingQueuedAfter = queued();
            const passLogs = allLogs.slice(before);
            const served = compose(draft.messages);
            const find = (re: RegExp) => passLogs.find((line) => re.test(line)) ?? null;
            const scheduler = find(/transform scheduler: /);
            const permission = find(/rewrite permission: /);
            const strip = find(/proactive thinking strip: busting pass froze reasoning of/);
            const emergency = find(/emergency tiered drop/);
            const threshold = find(/transform threshold: /);
            const wire = find(/transform: final-wire telemetry estimate=\d/);
            const representation = find(/final representation: /);
            const wireField = (name: string) =>
                Number(new RegExp(`${name}=(\\d+)`).exec(wire ?? "")?.[1] ?? Number.NaN);
            passes.push({
                step,
                usageInput: lastInput,
                usageOfDeclared: (lastInput / limit.context) * 100,
                mcPercentage: scheduler
                    ? Number(/percentage=([\d.]+)%/.exec(scheduler)?.[1] ?? Number.NaN)
                    : null,
                decision: scheduler ? (/decision=(\w+)/.exec(scheduler)?.[1] ?? null) : null,
                served,
                servedDigest: createHash("sha256")
                    .update(JSON.stringify(draft.messages))
                    .digest("hex"),
                logs: passLogs,
                holdLine: find(/signed thinking hold: /),
                thinkingHold: permission ? /thinking_hold=true/.test(permission) : null,
                rewriteAllowed: permission ? /allowed=true/.test(permission) : null,
                signedPrefixRelease: permission
                    ? /signed_prefix_release=true/.test(permission)
                    : null,
                ride: permission ? (/allowed=\w+ ride=(\S+)/.exec(permission)?.[1] ?? null) : null,
                proactiveStripFroze: strip ? Number(/of (\d+) assistant/.exec(strip)?.[1]) : null,
                proactiveStripIds: strip ? (/\[([^\]]*)\]/.exec(strip)?.[1] ?? "").split(",") : [],
                pendingApplied: passLogs.some((line) => /pending ops WILL APPLY/.test(line)),
                pendingQueuedBefore,
                pendingQueuedAfter,
                finalWire: wire
                    ? {
                          estimate: wireField("estimate"),
                          conversation: wireField("conversation"),
                          tools: wireField("tools"),
                          system: wireField("system"),
                          toolDefinitions: wireField("toolDefinitions"),
                      }
                    : null,
                mergedReasoningParts: representation
                    ? Number(/mergedReasoningParts=(\d+)/.exec(representation)?.[1])
                    : null,
                removedReasoningParts: representation
                    ? Number(/removedReasoningParts=(\d+)/.exec(representation)?.[1])
                    : null,
                emergency,
                emergencyFloor: emergency
                    ? Number(/floor ?≈(\d+)/.exec(emergency)?.[1] ?? Number.NaN)
                    : null,
                threshold: threshold
                    ? Number(/threshold=([\d.]+)%/.exec(threshold)?.[1] ?? Number.NaN)
                    : null,
                finalRepresentation: find(/final representation: /),
            });
            // The provider answers: one assistant step whose input is what this
            // request served.
            lastInput = served.total;
            nowClock += 20_000;
            const heavy = random() < heavyShare;
            const thinkingTokens = Math.round(
                (heavy ? 1800 + random() * 3200 : 250 + random() * 1000) * thinkingScale,
            );
            const id = `r905-${seed}-s${step}`;
            const stepTools: ToolCall[] = [];
            readCount++;
            const readCall = `call-${id}-read`;
            const keep = activeReads === undefined && readCount % keepEveryNthRead === 0;
            reads.push({ step, callId: readCall, keep });
            stepTools.push({
                id: readCall,
                name: "read",
                input: { filePath: `src/module-${step}.ts` },
                output: fileOutput(random, Math.round((1500 + random() * 5500) * outputScale), id),
            });
            if (random() < 0.6)
                stepTools.push({
                    id: `call-${id}-grep`,
                    name: "grep",
                    input: { pattern: `pattern${step}` },
                    output: fileOutput(
                        random,
                        Math.round((300 + random() * 1200) * outputScale),
                        `${id}-grep`,
                    ),
                });
            // ctx_reduce: drop every read older than the window, except kept ones,
            // and every grep output older than one step.
            let reduceTargets: number[] = [];
            if (step % reduceEvery === 0) {
                const tags = getTagsBySession(db, session).filter(
                    (tag) => tag.type === "tool" && tag.status === "active",
                );
                const tagOf = (callId: string) =>
                    tags.find((tag) => tag.messageId.includes(callId))?.tagNumber;
                for (const [index, read] of reads.entries()) {
                    if (read.keep || reduced.has(read.callId)) continue;
                    if (activeReads !== undefined) {
                        if (index >= reads.length - activeReads) continue;
                    } else if (step - read.step < reduceAfterSteps) continue;
                    const tag = tagOf(read.callId);
                    if (tag === undefined) continue;
                    reduced.add(read.callId);
                    reduceTargets.push(tag);
                }
                for (const tag of tags) {
                    if (tag.toolName !== "grep" && tag.toolName !== "ctx_reduce") continue;
                    if (reduced.has(tag.messageId)) continue;
                    reduced.add(tag.messageId);
                    reduceTargets.push(tag.tagNumber);
                }
                reduceTargets = [...new Set(reduceTargets)].sort((a, b) => a - b);
                if (reduceTargets.length > 0)
                    stepTools.push({
                        id: `call-${id}-reduce`,
                        name: "ctx_reduce",
                        input: { drop: reduceTargets.join(",") },
                        output: `Queued ${reduceTargets.length} drop(s).`,
                    });
            }
            const row: Row = {
                id,
                type: "assistant",
                seq: seq++,
                created: nowClock,
                text: prose(random, 40 + Math.round(random() * 120), `STEP${step}`),
                reasoning: prose(random, thinkingTokens, `THINK${step}`),
                hiddenThinkingTokens: thinking === "omitted" ? thinkingTokens : undefined,
                tools: stepTools,
                inputTokens: lastInput,
            };
            if (thinking === "omitted")
                hiddenBySignature.set(
                    `sig-${id}`,
                    Math.round(thinkingTokens * calibration.proseRatio),
                );
            rows.push(row);
            insert(row);
            // The ctx_reduce call runs inside the step: its drops are queued
            // before the next request.
            for (const tag of reduceTargets) queuePendingOp(db, session, tag, "drop", nowClock);
            nowClock += 5_000;
        }
        return {
            passes,
            logs: allLogs,
            synthetic,
            reducedTags: reduced.size,
            keptReads: reads.filter((read) => read.keep).length,
            session,
            rows: rows
                .filter((row) => row.type === "assistant")
                .map((row, index) => ({
                    id: row.id,
                    step: index + 1,
                    thinkingTokens: localTokens(row.reasoning ?? ""),
                })),
        };
    } finally {
        await duties.dispose();
        logs.mockRestore();
        probe.mockRestore();
        load.mockRestore();
        clock.mockRestore();
        _resetDreamTimerForTests();
        closeDatabase();
        raw.close();
        resetLkgSlotsForTest();
        resetCtxReduceRegisteredGloballyForTest();
        for (const key of keys) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
        resetOpenCodeDbPathStateForTesting();
        resetHostMediaForTests();
        cleanupTestTempDir(root);
    }
}

/** One line per pass, for reading a run by eye. */
export function describePass(pass: Issue905Pass): string {
    const s = pass.served;
    return [
        `step=${pass.step}`,
        `usage=${pass.usageInput}(${pass.usageOfDeclared.toFixed(1)}%/mc ${pass.mcPercentage?.toFixed(1) ?? "?"}%)`,
        `dec=${pass.decision}`,
        `hold=${pass.thinkingHold}`,
        `allowed=${pass.rewriteAllowed}`,
        `ride=${pass.ride}`,
        `release=${pass.signedPrefixRelease}`,
        `strip=${pass.proactiveStripFroze ?? "-"}`,
        `pend=${pass.pendingQueuedBefore}->${pass.pendingQueuedAfter}`,
        `served=${s.total}`,
        `think=${s.thinking}/${s.thinkingBlocks}b${s.hiddenThinking ? `+hidden${s.hiddenThinking}` : ""}`,
        `out=${s.toolOutputs}/${s.toolOutputCount}`,
        `in=${s.toolInputs}`,
        `txt=${s.assistantText}`,
        `ph=${s.placeholders}/${s.placeholderCount}`,
        `task=${s.task}`,
        `other=${s.other}`,
        pass.finalWire
            ? `wire[est=${pass.finalWire.estimate} conv=${pass.finalWire.conversation} tools=${pass.finalWire.tools}]`
            : "",
        `merged=${pass.mergedReasoningParts ?? "-"}`,
        pass.emergency ? `EMERG[${pass.emergency.replace(/^.*emergency tiered drop/, "")}]` : "",
        pass.holdLine ? `HOLD[${pass.holdLine.replace(/^.*signed thinking hold: /, "")}]` : "",
    ].join(" ");
}
