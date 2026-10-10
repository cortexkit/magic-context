/**
 * Signed-thinking prefix audit for the OpenCode transform: OpenCode 1 TS mode
 * (v1 store) and OpenCode 2 (v2 store) both run createTransform.
 *
 * Each case drives the real transform over a realistic Opus 5.5 tool loop and
 * answers every served request from a strict-binding provider mock. It then
 * offers one mutation lane a cache-busting pass while the current assistant
 * turn holds signed thinking: mid tool loop in a primary session, or anywhere
 * in a subagent run (a subagent's whole run is one assistant turn).
 *
 * A held (deferred) lane serves the unchanged request. A lane that lands an
 * edit before a kept signed block produces the provider's 400. Every lane also
 * has a control: the same setup and bust at the start of a new user turn must
 * land the lane's own edit, which proves a held mid-loop result comes from the
 * thinking guard and not from an idle lane.
 *
 * Findings: docs/reports/signed-thinking-prefix-edits-audit.md. Run with
 * MC_AUDIT_STRICT=1 to make every exposed lane fail on its strict-binding 400.
 */
import { describe, it, spyOn } from "bun:test";
import {
    appendCompartments,
    replaceAllCompartmentState,
    replaceAllCompartments,
} from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import { isPrefixBoundThinkingModel } from "../../features/magic-context/overflow-detection";
import {
    clearCachedM0M1,
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { queueM0Mutation } from "../../features/magic-context/storage-m0-mutation-log";
import { setPersistedCompactionMarkerState } from "../../features/magic-context/storage-meta-persisted";
import { getReasoningRemovalState } from "../../features/magic-context/storage-reasoning-removal";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { assertAdmissionParity } from "./__tests__/admission-parity.test";
import {
    auditName,
    auditExpect as expect,
    GOLDEN,
    GoldenCapture,
} from "./__tests__/golden-capture.test";
import {
    type Block,
    beforeLastThinking,
    PREFIX_ERROR,
    STRICT_AUDIT,
    StrictBindingMock,
    thinkingBlocks,
    type Wire,
    withoutThinking,
} from "./__tests__/strict-binding-mock";
import { MARKER_SUMMARY_TEXT } from "./compaction-marker-manager";
import { clearInjectionCache } from "./inject-compartments";
import type { MessageLike } from "./tag-messages";
import { clearMessageTokensCache, createTransform, type TransformDeps } from "./transform";
import { hasParkedBustTrigger, resetDegradedCacheCount } from "./transform-postprocess-phase";

const MODEL = { providerID: "anthropic", modelID: process.env.MC_AUDIT_MODEL ?? "claude-opus-5-5" };

// Keep the strict thinking-identity assertion disabled until older-turn thinking is stripped
// only alongside an admitted prefix edit, rather than alongside every bust permission.
const THINKING_STRIP_GATED = false;

/**
 * What OpenCode's `@ai-sdk/anthropic` path sends for a message array: empty
 * text and empty or unsigned reasoning are dropped by the adapter, a completed
 * tool part becomes a tool_use plus a tool_result, a compacted tool keeps its
 * call and sends OpenCode's cleared-output text.
 */
function wire(messages: MessageLike[]): Wire {
    const result: Wire = [];
    for (const m of messages) {
        const content: Block[] = [];
        const results: Block[] = [];
        for (const raw of m.parts) {
            const p = raw as Record<string, any>;
            if (p.ignored === true) continue;
            if (p.type === "text") {
                if (typeof p.text === "string" && p.text.length > 0)
                    content.push({ type: "text", text: p.text });
            } else if (p.type === "reasoning") {
                const signature = p.metadata?.anthropic?.signature;
                if (
                    typeof p.text === "string" &&
                    p.text.length > 0 &&
                    typeof signature === "string"
                )
                    content.push({ type: "thinking", thinking: p.text, signature });
            } else if (p.type === "tool") {
                content.push({
                    type: "tool_use",
                    id: p.callID,
                    name: p.tool,
                    input: p.state?.input ?? {},
                });
                const output = p.state?.time?.compacted
                    ? "[Old tool result content cleared]"
                    : p.state?.status === "completed"
                      ? p.state.output
                      : "[Tool execution was interrupted]";
                results.push({ type: "tool_result", tool_use_id: p.callID, content: output });
            } else if (p.type === "file") {
                content.push({ type: "image", source: { url: p.url, mime: p.mime } });
            }
        }
        if (content.length) result.push({ role: m.info.role, content });
        if (results.length) result.push({ role: "user", content: results });
    }
    return result;
}

type Lane =
    | "ctx_reduce drop (full removal)"
    | "ctx_reduce drop (skeleton beside reasoning)"
    | "age reclaim and heuristic cleanup"
    | "supersession and dedup"
    | "emergency 85% force band"
    | "emergency 95% wall"
    | "/ctx-flush"
    | "HARD fold after historian publication"
    | "m[0]/m[1] re-render after a recomp clears the cached pair"
    | "prefix cut moved by a compartment rewrite that keeps the cached pair"
    | "compaction-marker summary retired by a bust"
    | "synthetic todo"
    | "caveman text compression"
    | "reasoning clearing (keep_reasoning_tokens)"
    | "processed image strip"
    | "stale ctx_reduce strip"
    | "frozen-sentinel first application";

/**
 * Lanes whose mid-loop bust changes the request before a signed thinking block the
 * request still carries, which a strict-binding provider rejects.
 */
const EXPOSED = new Set<Lane>([
    "m[0]/m[1] re-render after a recomp clears the cached pair",
    "synthetic todo",
    "processed image strip",
    "stale ctx_reduce strip",
    "frozen-sentinel first application",
]);

const PRIMARY_LANES: Lane[] = [
    "ctx_reduce drop (full removal)",
    "ctx_reduce drop (skeleton beside reasoning)",
    "age reclaim and heuristic cleanup",
    "supersession and dedup",
    "emergency 85% force band",
    "emergency 95% wall",
    "/ctx-flush",
    "HARD fold after historian publication",
    "m[0]/m[1] re-render after a recomp clears the cached pair",
    "synthetic todo",
    "caveman text compression",
    "reasoning clearing (keep_reasoning_tokens)",
    "processed image strip",
    "stale ctx_reduce strip",
    "frozen-sentinel first application",
];
/**
 * Obligation lanes whose held work must still be released at the next user turn when the
 * plugin restarts in between.
 */
const RESTART_LANES: Lane[] = [
    "ctx_reduce drop (full removal)",
    "emergency 85% force band",
    "/ctx-flush",
    "HARD fold after historian publication",
];

/**
 * Restart lanes whose release is lost today: the release signal lives only in process memory
 * (`pendingMaterializationSessions`, `historyRefreshSessions`).
 */
const RESTART_GAP = new Set<Lane>(["/ctx-flush"]);

// Subagents have no m[0]/m[1], synthetic todo, caveman or /ctx-flush, and no
// later user turn to anchor a processed-image watermark.
const SUBAGENT_LANES: Lane[] = [
    "ctx_reduce drop (full removal)",
    "ctx_reduce drop (skeleton beside reasoning)",
    "age reclaim and heuristic cleanup",
    "supersession and dedup",
    "emergency 85% force band",
    "emergency 95% wall",
    "reasoning clearing (keep_reasoning_tokens)",
    "stale ctx_reduce strip",
    "frozen-sentinel first application",
];

interface Fixture {
    db: Database;
    sessionId: string;
    mock: StrictBindingMock;
    served: MessageLike[];
    pass: () => Promise<{ messages: MessageLike[]; bustedThisPass: boolean }>;
    respond: (
        served: MessageLike[],
        parts?: (n: number) => unknown[],
        withThinking?: boolean,
    ) => void;
    userTurn: (id: string, text: string) => void;
    setUsage: (percentage: number) => void;
    execute: (on: boolean) => void;
    setModel: (modelID: string) => void;
    lastHeuristicsTurnId: Map<string, string>;
    pendingMaterialization: Set<string>;
    historyRefresh: Set<string>;
    /**
     * Model a plugin process restart: the database survives, while the in-memory release
     * signals (`pendingMaterializationSessions`, `historyRefreshSessions`) and per-session
     * caches start empty.
     */
    restart: () => void;
    tag: (callId: string) => number;
    tagStatus: (callId: string) => string | undefined;
}

function readPart(callID: string, filePath: string, output: string) {
    return {
        type: "tool",
        tool: "read",
        callID,
        state: { status: "completed", input: { filePath }, output, time: { start: 1, end: 2 } },
    };
}

/** A current-turn step: read one more source file. */
function defaultStepParts(n: number): unknown[] {
    return [
        readPart(
            `call-${n}`,
            `/project/src/file-${n}.ts`,
            `export const v${n} = ${n};\n`.repeat(400),
        ),
    ];
}

/** A ctx_reduce call; ctx_reduce keeps its newest 3 calls by default. */
function reducePart(callID: string, drop: string): unknown {
    return {
        type: "tool",
        tool: "ctx_reduce",
        callID,
        state: {
            status: "completed",
            input: { drop },
            output: `Queued: drop §${drop}§`,
            time: { start: 1, end: 2 },
        },
    };
}

const HISTORY_COMPARTMENT = {
    sequence: 0,
    startMessage: 1,
    endMessage: 5,
    startMessageId: "prompt-1",
    endMessageId: "step-4",
    title: "Parser inspection",
    content: "Read parser.ts, ast.ts and lexer.ts; error recovery never resynchronises.",
};

const PARSER_SOURCE = "export function parse(tokens) { /* recursive descent */ }\n".repeat(150);
const SUMMARY_TEXT =
    "I have finished reading the parser and the lexer. The parser consumes tokens from the lexer, and the error recovery path is incomplete because it never resynchronises after an unexpected token.";

async function fixture(
    generation: "v1" | "v2",
    subagent: boolean,
    lane: Lane,
    dir: string,
    scenario: string,
): Promise<Fixture> {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const sessionId = `prefix-audit-${generation}-${subagent ? "sub" : "pri"}-${lane.replace(/\W+/g, "-")}`;
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { isSubagent: subagent });
    if (lane === "synthetic todo")
        updateSessionMeta(db, sessionId, {
            lastTodoState: JSON.stringify([
                { content: "Inspect parser", status: "in_progress", priority: "high" },
            ]),
        });
    const usage: TransformDeps["contextUsageMap"] = new Map();
    const liveModel = new Map([[sessionId, { ...MODEL }]]);
    const pendingMaterialization = new Set<string>();
    const historyRefresh = new Set<string>();
    const lastHeuristicsTurnId = new Map<string, string>();
    let decision: "execute" | "defer" = "defer";
    let bustedThisPass: boolean | undefined;
    const capture = new GoldenCapture(auditName(generation, subagent, lane, scenario));
    // A new transform with fresh in-memory release signals over the same database is what
    // the plugin has after a process restart (see `Fixture.restart`).
    const makeTransform = () =>
        createTransform({
            onPostprocess: (result) => {
                bustedThisPass = result.bustedThisPass;
            },
            db,
            storeGeneration: generation,
            tagger: createTagger(),
            scheduler: { shouldExecute: () => decision } as never,
            liveModelBySession: liveModel,
            contextUsageMap: usage,
            // The smallest accepted floor; the current loop's newer steps fill it,
            // so the older work sits outside the protected tail.
            protectedTokens: 4000,
            historianRunnable: false,
            directory: dir,
            sessionDirectoryBySession: new Map([[sessionId, dir]]),
            historyRefreshSessions: historyRefresh,
            pendingMaterializationSessions: pendingMaterialization,
            lastHeuristicsTurnId,
            smartDrops: true,
            keepReasoningTokens:
                lane === "reasoning clearing (keep_reasoning_tokens)" ? 0 : 1_000_000,
            ...(lane === "caveman text compression"
                ? { cavemanTextCompression: { enabled: true, minChars: 40 } }
                : {}),
        });
    let transform = makeTransform();
    const restart = () => {
        pendingMaterialization.clear();
        historyRefresh.clear();
        lastHeuristicsTurnId.clear();
        clearInjectionCache(sessionId);
        clearMessageTokensCache(sessionId);
        resetDegradedCacheCount(sessionId);
        transform = makeTransform();
    };
    const raw: MessageLike[] = [];
    const mock = new StrictBindingMock(Boolean(GOLDEN));
    let step = 0;
    const pass = async () => {
        const messages = structuredClone(raw);
        bustedThisPass = undefined;
        await transform({}, { messages });
        if (bustedThisPass === undefined) throw new Error("audit pass did not reach postprocess");
        if (!GOLDEN)
            assertAdmissionParity(
                messages,
                isPrefixBoundThinkingModel(MODEL.providerID, MODEL.modelID),
            );
        capture.write(
            wire(messages),
            bustedThisPass,
            mock.hasCurrentTurnThinking(wire(messages)),
            hasParkedBustTrigger(sessionId),
        );
        return { messages, bustedThisPass };
    };
    const respond: Fixture["respond"] = (served, parts, withThinking = true) => {
        const block = mock.respond(wire(served), withThinking);
        step++;
        raw.push({
            info: { id: `step-${step}`, role: "assistant", sessionID: sessionId, ...MODEL },
            parts: [
                ...(block
                    ? [
                          {
                              type: "reasoning",
                              text: block.thinking,
                              metadata: { anthropic: { signature: block.signature } },
                          },
                      ]
                    : []),
                ...(parts ? parts(step) : defaultStepParts(step)),
            ],
        });
    };
    const userTurn = (id: string, text: string, extra: unknown[] = []) => {
        mock.newUserTurn();
        raw.push({
            info: { id, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text }, ...extra],
        });
    };
    const image =
        lane === "processed image strip"
            ? [
                  {
                      type: "file",
                      mime: "image/png",
                      url: `data:image/png;base64,${"iVBORw0KGgo".repeat(40)}`,
                  },
              ]
            : [];

    // Older work. In a primary session it is a completed earlier user turn; in
    // a subagent it is the first steps of the same (only) turn.
    userTurn("prompt-1", "Inspect the parser and the attached screenshot, then report.", image);
    let served = (await pass()).messages;
    respond(served, () => [readPart("old-read-a", "/project/src/parser.ts", PARSER_SOURCE)]);
    served = (await pass()).messages;
    // An interleaved step without thinking; its tool is the full-removal target.
    // Only the dedup lane rereads the same file.
    respond(
        served,
        () => [
            readPart(
                "old-read-b",
                lane === "supersession and dedup"
                    ? "/project/src/parser.ts"
                    : "/project/src/ast.ts",
                lane === "supersession and dedup"
                    ? PARSER_SOURCE
                    : "export interface Node { kind: string }\n".repeat(150),
            ),
        ],
        false,
    );
    served = (await pass()).messages;
    respond(served, () =>
        lane === "stale ctx_reduce strip"
            ? [reducePart("old-reduce", "3")]
            : [
                  readPart(
                      "old-read-c",
                      "/project/src/lexer.ts",
                      "export function lex(src) {}\n".repeat(150),
                  ),
              ],
    );
    served = (await pass()).messages;
    respond(served, () => [{ type: "text", text: SUMMARY_TEXT }]);
    if (lane === "frozen-sentinel first application") {
        // A message left holding only a drop placeholder (history written while
        // compaction was off, or by an older build) is neutralized on its first
        // cache-busting pass.
        raw.push({
            info: { id: "placeholder-only", role: "assistant", sessionID: sessionId, ...MODEL },
            parts: [{ type: "text", text: "[dropped §998§]" }],
        });
    }
    if (!subagent) {
        served = (await pass()).messages;
        expect(mock.check(wire(served))).toBeNull();
        userTurn(
            "prompt-2",
            "Now repair the error recovery in the parser; keep using tools until it is done.",
        );
    }
    served = (await pass()).messages;
    const tagRow = (callId: string) =>
        getTagsBySession(db, sessionId).find(
            (t) => t.messageId === callId || t.messageId.endsWith(callId),
        );
    const tag = (callId: string) => {
        const row = tagRow(callId);
        if (!row) throw new Error(`no tag for ${callId}`);
        return row.tagNumber;
    };
    const setUsage = (percentage: number) =>
        usage.set(sessionId, {
            usage: { percentage, inputTokens: percentage * 1000 },
            updatedAt: Date.now(),
            hasUsageTokens: true,
        } as never);
    const execute = (on: boolean) => {
        decision = on ? "execute" : "defer";
    };
    return {
        db,
        sessionId,
        mock,
        served,
        pass,
        respond,
        userTurn,
        setUsage,
        execute,
        lastHeuristicsTurnId,
        setModel: (modelID) => liveModel.set(sessionId, { ...MODEL, modelID }),
        pendingMaterialization,
        historyRefresh,
        restart,
        tag,
        tagStatus: (callId) => tagRow(callId)?.status,
    };
}

/** Grow the current turn's tool loop by `steps` signed responses. */
async function toolLoop(
    f: Fixture,
    steps: number,
    parts?: (n: number, i: number) => unknown[] | undefined,
): Promise<MessageLike[]> {
    for (let i = 0; i < steps; i++) {
        f.respond(f.served, parts ? (n) => parts(n, i) ?? defaultStepParts(n) : undefined);
        f.served = (await f.pass()).messages;
        expect(f.mock.check(wire(f.served))).toBeNull();
    }
    return f.served;
}

/** In the stale ctx_reduce lane the agent calls ctx_reduce three more times, so its first call is no longer among the newest three that ctx_reduce keeps. */
function loopParts(lane: Lane) {
    return lane === "stale ctx_reduce strip"
        ? (n: number, i: number) => (i < 3 ? [reducePart(`loop-reduce-${n}`, "1")] : undefined)
        : undefined;
}

/** Finish the current turn with a text answer and start the next real user turn. */
async function nextUserTurn(f: Fixture, id: string): Promise<void> {
    f.respond(f.served, (n) => [
        { type: "text", text: `Step ${n}: this part of the work is done and verified.` },
    ]);
    f.served = (await f.pass()).messages;
    expect(f.mock.check(wire(f.served))).toBeNull();
    f.userTurn(id, "Continue with the next part of the parser work; keep using tools until done.");
    f.served = (await f.pass()).messages;
    expect(f.mock.check(wire(f.served))).toBeNull();
}

/**
 * Lane setup that must happen before the current turn's loop: anchors and
 * watermarks that exist in a real session by the time a later bust comes.
 */
async function prepareLane(f: Fixture, lane: Lane): Promise<void> {
    if (lane === "synthetic todo") {
        // The todo pair is anchored on a turn-start bust (here a /ctx-flush).
        f.pendingMaterialization.add(f.sessionId);
        f.served = (await f.pass()).messages;
        expect(f.mock.check(wire(f.served))).toBeNull();
    }
    if (lane === "processed image strip") {
        // A drop applied at the start of a later turn advances the drop
        // watermark past the answered screenshot message; that same pass reads
        // the old watermark, so the image itself is not stripped yet.
        await toolLoop(f, 4);
        await nextUserTurn(f, "prompt-3");
        queuePendingOp(f.db, f.sessionId, f.tag("old-read-b"), "drop");
        f.pendingMaterialization.add(f.sessionId);
        f.served = (await f.pass()).messages;
        expect(f.mock.check(wire(f.served))).toBeNull();
        expect(f.tagStatus("old-read-b")).toBe("dropped");
        expect(JSON.stringify(wire(f.served))).toContain('"type":"image"');
    }
    if (lane === "prefix cut moved by a compartment rewrite that keeps the cached pair") {
        // The first turn is folded at the start of this turn, so the cached m[0]/m[1] pair is
        // served with an inclusive cut through its last message (step-4, the summary text).
        appendCompartments(f.db, f.sessionId, [HISTORY_COMPARTMENT]);
        f.historyRefresh.add(f.sessionId);
        f.served = (await f.pass()).messages;
        expect(f.mock.check(wire(f.served))).toBeNull();
        expect(JSON.stringify(wire(f.served))).toContain(HISTORY_COMPARTMENT.title);
        expect(JSON.stringify(wire(f.served))).not.toContain(SUMMARY_TEXT);
    }
}

/** Queue or arm whatever the lane needs, then offer the bust it rides. */
function armAndBust(f: Fixture, lane: Lane, subagent: boolean): void {
    switch (lane) {
        case "ctx_reduce drop (full removal)":
        case "/ctx-flush":
            queuePendingOp(f.db, f.sessionId, f.tag("old-read-b"), "drop");
            break;
        case "ctx_reduce drop (skeleton beside reasoning)":
            queuePendingOp(f.db, f.sessionId, f.tag("old-read-a"), "drop");
            break;
        case "age reclaim and heuristic cleanup":
            updateSessionMeta(f.db, f.sessionId, { toolReclaimWatermark: f.tag("old-read-c") });
            break;
        case "HARD fold after historian publication":
            // The historian appended a compartment covering the first turn and
            // asked for a history refresh, as its incremental publication does.
            appendCompartments(f.db, f.sessionId, [HISTORY_COMPARTMENT]);
            f.historyRefresh.add(f.sessionId);
            break;
        case "m[0]/m[1] re-render after a recomp clears the cached pair":
            // A recomp promotion (or a history-boundary repair) rewrites the
            // compartments and clears the cached m[0]/m[1] pair in the same
            // transaction. No bust is offered: the next pass is a defer pass.
            replaceAllCompartmentState(f.db, f.sessionId, [HISTORY_COMPARTMENT], []);
            return;
        case "prefix cut moved by a compartment rewrite that keeps the cached pair":
            // A compartment writer that does not clear the cached pair (here
            // replaceAllCompartments; the Rust fold upsert behaves the same) rewrites the
            // served boundary row so that it now ends part-way through step-4. The pair stays
            // complete, and replay re-reads the partial-end decision from the live row. No
            // bust is offered: the next pass is a defer pass.
            replaceAllCompartments(f.db, f.sessionId, [
                { ...HISTORY_COMPARTMENT, endBlockIndex: 0 },
            ]);
            return;
        case "synthetic todo":
            updateSessionMeta(f.db, f.sessionId, {
                lastTodoState: JSON.stringify([
                    { content: "Inspect parser", status: "completed", priority: "high" },
                    { content: "Repair error recovery", status: "in_progress", priority: "high" },
                ]),
            });
            break;
        default:
            break;
    }
    if (lane === "/ctx-flush") {
        f.pendingMaterialization.add(f.sessionId);
        return;
    }
    // A primary busts through the force band (its first pass at 85% may
    // rewrite); a subagent through an ordinary execute decision, which is how
    // issue 630 reached its tool loop.
    f.execute(true);
    f.setUsage(lane === "emergency 95% wall" ? 95 : subagent ? 76 : 85);
}

/** First differing non-thinking block, for diagnosing an unexpected edit (MC_AUDIT_DEBUG=1). */
function debugDiff(label: string, before: Wire, after: Wire): void {
    if (process.env.MC_AUDIT_DEBUG !== "1") return;
    const flat = (w: Wire) =>
        w.flatMap((m) =>
            m.content
                .filter((b) => b.type !== "thinking")
                .map((b) => JSON.stringify([m.role, b]).slice(0, 160)),
        );
    const a = flat(before);
    const b = flat(after);
    const i = a.findIndex((x, k) => x !== b[k]);
    console.log(
        `DIFF ${label} at=${i} lens=${a.length}/${b.length}\n  before: ${a[i]}\n  after:  ${b[i]}`,
    );
}

/** Whether the lane's own edit is in the served request. */
function landed(f: Fixture, lane: Lane, after: Wire): boolean {
    const text = JSON.stringify(after);
    const old = ["old-read-a", "old-read-b", "old-read-c"];
    switch (lane) {
        case "ctx_reduce drop (full removal)":
        case "/ctx-flush":
            return f.tagStatus("old-read-b") === "dropped";
        case "ctx_reduce drop (skeleton beside reasoning)":
            return f.tagStatus("old-read-a") === "dropped";
        case "age reclaim and heuristic cleanup":
        case "emergency 85% force band":
        case "emergency 95% wall":
        case "supersession and dedup":
            return old.some((id) => f.tagStatus(id) === "dropped");
        case "HARD fold after historian publication":
        case "m[0]/m[1] re-render after a recomp clears the cached pair":
            return text.includes(HISTORY_COMPARTMENT.title);
        case "prefix cut moved by a compartment rewrite that keeps the cached pair":
            // The inclusive cut removed step-4; the partial cut serves it again.
            return text.includes(SUMMARY_TEXT);
        case "compaction-marker summary retired by a bust":
            return !text.includes(MARKER_SUMMARY_TEXT);
        case "synthetic todo":
            return text.includes("Repair error recovery");
        case "caveman text compression":
            return !text.includes(SUMMARY_TEXT);
        case "reasoning clearing (keep_reasoning_tokens)":
            return getReasoningRemovalState(f.db, f.sessionId).messageIds.size > 0;
        case "processed image strip":
            return !text.includes('"type":"image"');
        case "stale ctx_reduce strip":
            return !text.includes('"id":"old-reduce"');
        case "frozen-sentinel first application":
            // The raw history always carries the placeholder message.
            return !text.includes("[dropped §998§]");
    }
}

function withFixture(
    generation: "v1" | "v2",
    subagent: boolean,
    lane: Lane,
    body: (f: Fixture) => Promise<void>,
    scenario = "mid-loop",
) {
    return async () => {
        const { dir, cleanup } = createTestTempDir("signed-prefix-audit-");
        let f: Fixture | undefined;
        try {
            f = await fixture(generation, subagent, lane, dir, scenario);
            await body(f);
        } finally {
            if (f) closeQuietly(f.db);
            cleanup();
        }
    };
}

for (const generation of ["v1", "v2"] as const) {
    const host = generation === "v1" ? "OpenCode 1 TS mode" : "OpenCode 2";
    for (const subagent of [false, true]) {
        const scope = subagent ? "subagent run" : "primary mid tool loop";
        describe(`signed prefix audit: ${host}, ${scope}`, () => {
            for (const lane of subagent ? SUBAGENT_LANES : PRIMARY_LANES) {
                it(
                    lane,
                    withFixture(generation, subagent, lane, async (f) => {
                        await prepareLane(f, lane);
                        const before = wire(await toolLoop(f, 4, loopParts(lane)));
                        armAndBust(f, lane, subagent);
                        const afterMessages = (await f.pass()).messages;
                        const after = wire(afterMessages);
                        const error = f.mock.check(after);
                        const edit = landed(f, lane, after);
                        debugDiff(lane, before, after);
                        const nonThinkingEdit = withoutThinking(after) !== withoutThinking(before);
                        console.log(
                            `AUDIT ${host} | ${scope} | ${lane}: ${error ?? "accepted"}; laneLanded=${edit}; nonThinkingEdit=${nonThinkingEdit}; pendingOps=${getPendingOps(f.db, f.sessionId).length}`,
                        );
                        // Under MC_AUDIT_STRICT=1 every lane must behave as held,
                        // which is the acceptance bar of docs/designs/signed-thinking-hold.md.
                        if (!GOLDEN && !STRICT_AUDIT && EXPOSED.has(lane)) {
                            expect(edit).toBe(true);
                            expect(error).toBe(PREFIX_ERROR);
                            return;
                        }
                        // Held: valid, no byte outside thinking changed, the lane's
                        // edit is not served, and any queued drop stays queued for
                        // the next real user turn. Reasoning clearing is valid by
                        // construction: it removes an oldest contiguous run.
                        expect(error).toBeNull();
                        // At the 95% wall a reduction after the last kept thinking block (the
                        // newest tool results) is admitted; nothing before that block may change.
                        if (lane === "emergency 95% wall")
                            expect(beforeLastThinking(after)).toBe(beforeLastThinking(before));
                        else expect(nonThinkingEdit).toBe(false);
                        // A pass that applies nothing changes no thinking either. The strip of
                        // older-turn thinking is the companion of an admitted edit before kept
                        // older-turn thinking, which a pass with kept current-turn thinking never
                        // has. Today the strip rides every bust permission of a primary session
                        // (prefixEditBesidesReasoningTrim), so in a primary session every lane
                        // that reaches this check strips the previous turn's blocks; a subagent
                        // has no previous turn.
                        if (lane !== "reasoning clearing (keep_reasoning_tokens)") {
                            const thinkingChanged =
                                thinkingBlocks(after) !== thinkingBlocks(before);
                            if (STRICT_AUDIT && THINKING_STRIP_GATED)
                                expect(thinkingChanged).toBe(false);
                            else if (!STRICT_AUDIT) expect(thinkingChanged).toBe(!subagent);
                        }
                        if (lane !== "reasoning clearing (keep_reasoning_tokens)")
                            expect(edit).toBe(false);
                        if (lane.startsWith("ctx_reduce") || lane === "/ctx-flush")
                            expect(getPendingOps(f.db, f.sessionId).length).toBeGreaterThan(0);
                        // A held edit is never recorded as served: repeating the pass
                        // with no new response serves exactly the same bytes.
                        expect(wire((await f.pass()).messages)).toEqual(after);
                        // The loop continues validly on the held pass's bytes.
                        f.served = afterMessages;
                        await toolLoop(f, 2);
                        if (subagent) return;
                        // The held edit is released, not lost: once the turn ends and a
                        // real user message starts the next one, the same state (still
                        // armed, nothing re-queued) lands the lane's edit validly.
                        await nextUserTurn(f, "prompt-release");
                        const released = wire(f.served);
                        console.log(
                            `AUDIT-RELEASE ${host} | next user turn | ${lane}: ${f.mock.check(released) ?? "accepted"}; laneLanded=${landed(f, lane, released)}`,
                        );
                        expect(f.mock.check(released)).toBeNull();
                        expect(landed(f, lane, released)).toBe(true);
                    }),
                );
            }
            if (subagent) return;
            it(
                "pass returns the postprocess bust verdict",
                withFixture(
                    generation,
                    false,
                    "/ctx-flush",
                    async (f) => {
                        expect((await f.pass()).bustedThisPass).toBe(false);
                        armAndBust(f, "/ctx-flush", false);
                        expect((await f.pass()).bustedThisPass).toBe(true);
                    },
                    "bust-signal",
                ),
            );
            for (const lane of PRIMARY_LANES) {
                it(
                    `control: ${lane} lands validly at a new user turn`,
                    withFixture(
                        generation,
                        false,
                        lane,
                        async (f) => {
                            await prepareLane(f, lane);
                            await toolLoop(f, 4, loopParts(lane));
                            await nextUserTurn(f, "prompt-next");
                            const before = wire(f.served);
                            armAndBust(f, lane, false);
                            const afterMessages = (await f.pass()).messages;
                            const after = wire(afterMessages);
                            const error = f.mock.check(after);
                            const edit = landed(f, lane, after);
                            debugDiff(`control ${lane}`, before, after);
                            const thinkingLeft = after.some((m) =>
                                m.content.some((b) => b.type === "thinking"),
                            );
                            console.log(
                                `AUDIT-CONTROL ${host} | new user turn | ${lane}: ${error ?? "accepted"}; laneLanded=${edit}; thinkingLeft=${thinkingLeft}`,
                            );
                            expect(edit).toBe(true);
                            expect(error).toBeNull();
                            // Every older signed block is gone, so no kept block was bound to the edited bytes.
                            expect(thinkingLeft).toBe(false);
                            f.served = afterMessages;
                            await toolLoop(f, 3);
                        },
                        "control",
                    ),
                );
            }
            for (const lane of RESTART_LANES) {
                it(
                    `release survives a restart: ${lane}`,
                    withFixture(
                        generation,
                        false,
                        lane,
                        async (f) => {
                            await prepareLane(f, lane);
                            await toolLoop(f, 4, loopParts(lane));
                            armAndBust(f, lane, false);
                            const afterMessages = (await f.pass()).messages;
                            const after = wire(afterMessages);
                            expect(f.mock.check(after)).toBeNull();
                            expect(landed(f, lane, after)).toBe(false);
                            f.served = afterMessages;
                            await toolLoop(f, 2);
                            // The plugin restarts while the work is held. Only what the database
                            // holds survives; the next real user turn must still release the work.
                            f.restart();
                            await nextUserTurn(f, "prompt-release");
                            const released = wire(f.served);
                            const edit = landed(f, lane, released);
                            console.log(
                                `AUDIT-RESTART ${host} | next user turn after a restart | ${lane}: ${f.mock.check(released) ?? "accepted"}; laneLanded=${edit}`,
                            );
                            expect(f.mock.check(released)).toBeNull();
                            if (!GOLDEN && !STRICT_AUDIT && RESTART_GAP.has(lane)) {
                                expect(edit).toBe(false);
                                return;
                            }
                            expect(edit).toBe(true);
                        },
                        "restart",
                    ),
                );
            }
            it(
                "mixed pass: a 95% tail reduction on a parallel tool arc lands while an older drop stays held",
                withFixture(
                    generation,
                    false,
                    "emergency 95% wall",
                    async (f) => {
                        await toolLoop(f, 3);
                        // The newest step calls two tools at once.
                        await toolLoop(f, 1, (n) => [
                            readPart(
                                `call-${n}-a`,
                                `/project/src/file-${n}a.ts`,
                                `export const a${n} = ${n};\n`.repeat(400),
                            ),
                            readPart(
                                `call-${n}-b`,
                                `/project/src/file-${n}b.ts`,
                                `export const b${n} = ${n};\n`.repeat(400),
                            ),
                        ]);
                        const before = wire(f.served);
                        const older = f.tag("old-read-b");
                        queuePendingOp(f.db, f.sessionId, older, "drop");
                        f.execute(true);
                        f.setUsage(95);
                        const afterMessages = (await f.pass()).messages;
                        const after = wire(afterMessages);
                        const tailLanded = withoutThinking(after) !== withoutThinking(before);
                        console.log(
                            `AUDIT-MIXED ${host} | 95% wall beside a held drop: ${f.mock.check(after) ?? "accepted"}; tailLanded=${tailLanded}; olderDropped=${f.tagStatus("old-read-b") === "dropped"}`,
                        );
                        // Valid, including tool pairing on both sides of the parallel arc.
                        expect(f.mock.check(after)).toBeNull();
                        expect(beforeLastThinking(after)).toBe(beforeLastThinking(before));
                        // The older drop sits before kept thinking: held and still queued.
                        expect(f.tagStatus("old-read-b")).not.toBe("dropped");
                        expect(
                            getPendingOps(f.db, f.sessionId).some((op) => op.tagId === older),
                        ).toBe(true);
                        // The admitted tail reduction lands in every runtime (Pi does it today), so
                        // the pass really is mixed: something landed and something stayed held.
                        if (STRICT_AUDIT) expect(tailLanded).toBe(true);
                        expect(wire((await f.pass()).messages)).toEqual(after);
                        f.served = afterMessages;
                        await toolLoop(f, 2);
                        // Landing the tail reduction did not spend the older drop's release.
                        await nextUserTurn(f, "prompt-release");
                        expect(f.mock.check(wire(f.served))).toBeNull();
                        expect(f.tagStatus("old-read-b")).toBe("dropped");
                    },
                    "mixed",
                ),
            );
            // A replayed m[0]/m[1] pair must be replayed with the cut it was served with. Today
            // the replay re-reads the partial-end decision from the live compartment row, so a
            // writer that rewrites that row without clearing the pair moves the cut on a defer
            // pass. The design replays head and cut as one unit (section 7).
            const CUT_LANE: Lane =
                "prefix cut moved by a compartment rewrite that keeps the cached pair";
            it(
                `${CUT_LANE}: mid tool loop`,
                withFixture(
                    generation,
                    false,
                    CUT_LANE,
                    async (f) => {
                        await prepareLane(f, CUT_LANE);
                        const before = wire(await toolLoop(f, 4));
                        armAndBust(f, CUT_LANE, false);
                        const afterMessages = (await f.pass()).messages;
                        const after = wire(afterMessages);
                        const error = f.mock.check(after);
                        const moved = landed(f, CUT_LANE, after);
                        debugDiff(CUT_LANE, before, after);
                        console.log(
                            `AUDIT-CUT ${host} | mid tool loop: ${error ?? "accepted"}; cutMoved=${moved}`,
                        );
                        if (!GOLDEN && !STRICT_AUDIT) {
                            expect(moved).toBe(true);
                            expect(error).toBe(PREFIX_ERROR);
                            return;
                        }
                        expect(error).toBeNull();
                        expect(moved).toBe(false);
                        expect(withoutThinking(after)).toBe(withoutThinking(before));
                        expect(wire((await f.pass()).messages)).toEqual(after);
                        f.served = afterMessages;
                        await toolLoop(f, 2);
                        // The rewrite is ride-only: it lands with the next prefix render, which this
                        // fixture does not offer, so the next turn must only stay valid.
                        await nextUserTurn(f, "prompt-release");
                        expect(f.mock.check(wire(f.served))).toBeNull();
                    },
                    "cut-mid-loop",
                ),
            );
            it(
                `${CUT_LANE}: defer pass at a new user turn`,
                withFixture(
                    generation,
                    false,
                    CUT_LANE,
                    async (f) => {
                        await prepareLane(f, CUT_LANE);
                        await toolLoop(f, 4);
                        await nextUserTurn(f, "prompt-next");
                        const before = wire(f.served);
                        armAndBust(f, CUT_LANE, false);
                        const afterMessages = (await f.pass()).messages;
                        const after = wire(afterMessages);
                        const error = f.mock.check(after);
                        const moved = landed(f, CUT_LANE, after);
                        console.log(
                            `AUDIT-CUT ${host} | defer pass at a new user turn: ${error ?? "accepted"}; cutMoved=${moved}`,
                        );
                        // No current-turn thinking yet, but the previous turn's signed blocks are
                        // still sent, and a defer pass strips none of them.
                        if (!GOLDEN && !STRICT_AUDIT) {
                            expect(moved).toBe(true);
                            expect(error).toBe(PREFIX_ERROR);
                            return;
                        }
                        expect(error).toBeNull();
                        expect(moved).toBe(false);
                        expect(withoutThinking(after)).toBe(withoutThinking(before));
                        f.served = afterMessages;
                        await toolLoop(f, 2);
                    },
                    "cut-new-turn",
                ),
            );
            // The compaction-marker summary is served between the m[0]/m[1] head and the first raw
            // message, so it is part of the prefix. After a logical clear (for example the
            // marker's summary message is removed) defer passes keep serving it, and the next
            // busting pass retires it (reconcileMarkerRepresentation). Removing it then edits
            // the request before every kept thinking block. The fix records the served summary
            // with the head and holds its retirement until the turn keeps no signed thinking
            // (docs/designs/signed-thinking-hold.md, section 7).
            const MARKER_LANE: Lane = "compaction-marker summary retired by a bust";
            it(
                `${MARKER_LANE}: mid tool loop`,
                withFixture(
                    generation,
                    false,
                    MARKER_LANE,
                    async (f) => {
                        // The marker is set at the start of this turn and served on a /ctx-flush,
                        // which strips the previous turn's thinking, so the summary lands validly.
                        setPersistedCompactionMarkerState(f.db, f.sessionId, {
                            boundaryMessageId: "prompt-2",
                            summaryMessageId: "marker-summary",
                            compactionPartId: "marker-compaction-part",
                            summaryPartId: "marker-summary-part",
                            boundaryOrdinal: 6,
                            targetEndMessageId: null,
                        });
                        f.pendingMaterialization.add(f.sessionId);
                        f.served = (await f.pass()).messages;
                        expect(f.mock.check(wire(f.served))).toBeNull();
                        expect(landed(f, MARKER_LANE, wire(f.served))).toBe(false);
                        await toolLoop(f, 4);
                        // A logical clear keeps the summary on the wire until a busting pass.
                        setPersistedCompactionMarkerState(f.db, f.sessionId, null);
                        f.served = (await f.pass()).messages;
                        const before = wire(f.served);
                        expect(f.mock.check(before)).toBeNull();
                        expect(landed(f, MARKER_LANE, before)).toBe(false);
                        // Offer a bust whose own work is all before the kept thinking.
                        f.pendingMaterialization.add(f.sessionId);
                        const afterMessages = (await f.pass()).messages;
                        const after = wire(afterMessages);
                        const error = f.mock.check(after);
                        const retired = landed(f, MARKER_LANE, after);
                        debugDiff(MARKER_LANE, before, after);
                        console.log(
                            `AUDIT-MARKER ${host} | mid tool loop: ${error ?? "accepted"}; summaryRetired=${retired}`,
                        );
                        if (!GOLDEN && !STRICT_AUDIT) {
                            expect(retired).toBe(true);
                            expect(error).toBe(PREFIX_ERROR);
                            return;
                        }
                        expect(error).toBeNull();
                        expect(retired).toBe(false);
                        expect(withoutThinking(after)).toBe(withoutThinking(before));
                        expect(wire((await f.pass()).messages)).toEqual(after);
                        f.served = afterMessages;
                        await toolLoop(f, 2);
                        // The retirement is held, not lost: the first pass of the next turn may
                        // retire the summary, and must stay valid either way.
                        await nextUserTurn(f, "prompt-release");
                        expect(f.mock.check(wire(f.served))).toBeNull();
                    },
                    "marker-mid-loop",
                ),
            );
        });
    }
}

for (const generation of ["v1", "v2"] as const) {
    describe(`signed prefix parking: ${generation}`, () => {
        it(
            "parked flush and force release together without standing permission",
            withFixture(
                generation,
                false,
                "/ctx-flush",
                async (f) => {
                    await toolLoop(f, 4);
                    queuePendingOp(f.db, f.sessionId, f.tag("old-read-b"), "drop");
                    f.pendingMaterialization.add(f.sessionId);
                    f.setUsage(85);
                    f.served = (await f.pass()).messages;
                    expect(f.mock.check(wire(f.served))).toBeNull();
                    expect(hasParkedBustTrigger(f.sessionId)).toBe(true);
                    // A repeated /ctx-flush shares the pending request; it must not authorize
                    // removal of a newly appended placeholder in this same signed turn.
                    f.pendingMaterialization.add(f.sessionId);
                    f.respond(f.served, () => [{ type: "text", text: "[dropped §998§]" }], false);
                    const held = await f.pass();
                    expect(held.bustedThisPass).toBe(false);
                    expect(JSON.stringify(wire(held.messages))).toContain("[dropped §998§]");
                    expect(f.mock.check(wire(held.messages))).toBeNull();
                    f.served = held.messages;
                    expect(wire((await f.pass()).messages)).toEqual(wire(f.served));
                    expect(getPendingOps(f.db, f.sessionId).length).toBe(1);
                    f.userTurn("parking-release", "Continue the parser work.");
                    const release = await f.pass();
                    expect(release.bustedThisPass).toBe(true);
                    expect(f.mock.check(wire(release.messages))).toBeNull();
                    expect(getPendingOps(f.db, f.sessionId).length).toBe(0);
                    expect(f.pendingMaterialization.has(f.sessionId)).toBe(false);
                    expect(hasParkedBustTrigger(f.sessionId)).toBe(false);
                    expect((await f.pass()).bustedThisPass).toBe(false);
                },
                "parking-combined",
            ),
        );

        it(
            "held execute signal is not a standing permission",
            withFixture(
                generation,
                false,
                "ctx_reduce drop (full removal)",
                async (f) => {
                    await toolLoop(f, 4);
                    queuePendingOp(f.db, f.sessionId, f.tag("old-read-b"), "drop");
                    f.execute(true);
                    f.served = (await f.pass()).messages;
                    f.execute(false);
                    expect(f.pendingMaterialization.has(f.sessionId)).toBe(true);
                    f.respond(f.served, () => [{ type: "text", text: "[dropped §998§]" }], false);
                    const held = await f.pass();
                    expect(held.bustedThisPass).toBe(false);
                    expect(JSON.stringify(wire(held.messages))).toContain("[dropped §998§]");
                    expect(f.mock.check(wire(held.messages))).toBeNull();
                    f.userTurn("execute-release", "Continue the parser work.");
                    const release = await f.pass();
                    expect(release.bustedThisPass).toBe(true);
                    expect(f.mock.check(wire(release.messages))).toBeNull();
                    expect(getPendingOps(f.db, f.sessionId).length).toBe(0);
                    expect((await f.pass()).bustedThisPass).toBe(false);
                },
                "parking-execute",
            ),
        );

        it(
            "first render is not a standing permission under kept thinking",
            withFixture(
                generation,
                false,
                "/ctx-flush",
                async (f) => {
                    await toolLoop(f, 4);
                    clearCachedM0M1(f.db, f.sessionId);
                    f.respond(f.served, () => [{ type: "text", text: "[dropped §998§]" }], false);
                    const held = await f.pass();
                    expect(JSON.stringify(wire(held.messages))).toContain("[dropped §998§]");
                    expect(f.pendingMaterialization.has(f.sessionId)).toBe(true);
                    expect(f.historyRefresh.has(f.sessionId)).toBe(false);
                    f.userTurn("render-release", "Continue the parser work.");
                    const release = await f.pass();
                    expect(release.bustedThisPass).toBe(true);
                    expect(f.mock.check(wire(release.messages))).toBeNull();
                    expect((await f.pass()).bustedThisPass).toBe(false);
                },
                "parking-first-render",
            ),
        );

        it(
            "m0 drift watcher does not signal under kept thinking",
            withFixture(
                generation,
                false,
                "/ctx-flush",
                async (f) => {
                    await toolLoop(f, 4);
                    appendCompartments(f.db, f.sessionId, [HISTORY_COMPARTMENT]);
                    const mutation = queueM0Mutation(f.db, {
                        sessionId: f.sessionId,
                        mutationType: "compartment_delete",
                    });
                    expect(mutation.id).toBeGreaterThan(
                        getOrCreateSessionMeta(f.db, f.sessionId).cachedM0MaxMutationId ?? 0,
                    );
                    f.setUsage(85);
                    f.served = (await f.pass()).messages;
                    expect(f.pendingMaterialization.has(f.sessionId)).toBe(false);
                    expect(f.historyRefresh.has(f.sessionId)).toBe(false);
                    const held = await f.pass();
                    expect(held.bustedThisPass).toBe(false);
                    expect(f.pendingMaterialization.has(f.sessionId)).toBe(false);
                    expect(f.historyRefresh.has(f.sessionId)).toBe(false);
                    f.userTurn("drift-release", "Continue the parser work.");
                    const release = await f.pass();
                    expect(release.bustedThisPass).toBe(true);
                    expect(f.mock.check(wire(release.messages))).toBeNull();
                },
                "parking-drift",
            ),
        );

        it(
            "parked force cancels when pressure ends with no bust",
            withFixture(
                generation,
                false,
                "ctx_reduce drop (full removal)",
                async (f) => {
                    await toolLoop(f, 4);
                    queuePendingOp(f.db, f.sessionId, f.tag("old-read-b"), "drop");
                    f.setUsage(85);
                    f.served = (await f.pass()).messages;
                    expect(hasParkedBustTrigger(f.sessionId)).toBe(true);
                    f.setUsage(20);
                    const cancelled = await f.pass();
                    expect(cancelled.bustedThisPass).toBe(false);
                    expect(hasParkedBustTrigger(f.sessionId)).toBe(false);
                    expect(f.mock.check(wire(cancelled.messages))).toBeNull();
                    f.userTurn("cancelled-release", "Continue the parser work.");
                    const next = await f.pass();
                    expect(next.bustedThisPass).toBe(false);
                    expect(f.mock.check(wire(next.messages))).toBeNull();
                    expect(getPendingOps(f.db, f.sessionId).length).toBe(1);
                },
                "parking-cancelled",
            ),
        );
    });
}

for (const generation of ["v1", "v2"] as const) {
    describe(`step2b review: ${generation}`, () => {
        for (const subagent of [false, true]) {
            it(
                `model switch keeps the issuer boundary but a new user releases (${subagent ? "subagent" : "primary"})`,
                withFixture(
                    generation,
                    subagent,
                    "/ctx-flush",
                    async (f) => {
                        await toolLoop(f, 4);
                        queuePendingOp(f.db, f.sessionId, f.tag("old-read-b"), "drop");
                        f.execute(true);
                        f.served = (await f.pass()).messages;
                        f.execute(false);
                        expect(getPendingOps(f.db, f.sessionId).length).toBe(1);
                        expect(hasParkedBustTrigger(f.sessionId)).toBe(true);
                        for (let i = 0; i < 3; i++) {
                            const held = await f.pass();
                            expect(held.bustedThisPass).toBe(false);
                            expect(wire(held.messages)).toEqual(wire(f.served));
                        }
                        f.setModel("claude-opus-4-6");
                        const switched = await f.pass();
                        // OpenCode still uses the last assistant's model to protect its
                        // kept signatures; changing the live route alone does not end that turn.
                        expect(switched.bustedThisPass).toBe(false);
                        expect(getPendingOps(f.db, f.sessionId).length).toBe(1);
                        f.userTurn("review-model-release", "Continue on the new model.");
                        const release = await f.pass();
                        expect(release.bustedThisPass).toBe(true);
                        expect(getPendingOps(f.db, f.sessionId).length).toBe(0);
                        expect(f.pendingMaterialization.has(f.sessionId)).toBe(false);
                        expect(hasParkedBustTrigger(f.sessionId)).toBe(false);
                        expect((await f.pass()).bustedThisPass).toBe(false);
                    },
                    `review-model-${subagent}`,
                ),
            );
        }
        it(
            "85 parking does not disable the live 95 wall",
            withFixture(
                generation,
                false,
                "/ctx-flush",
                async (f) => {
                    await toolLoop(f, 4);
                    queuePendingOp(f.db, f.sessionId, f.tag("old-read-b"), "drop");
                    f.pendingMaterialization.add(f.sessionId);
                    f.setUsage(85);
                    f.served = (await f.pass()).messages;
                    expect(hasParkedBustTrigger(f.sessionId)).toBe(true);
                    f.setUsage(90);
                    const held = await f.pass();
                    expect(held.bustedThisPass).toBe(false);
                    expect(wire(held.messages)).toEqual(wire(f.served));
                    f.setUsage(95);
                    const observeHeuristics = spyOn(f.lastHeuristicsTurnId, "set");
                    const wall = await f.pass();
                    // The wall must open the live cleanup gate even if admission holds
                    // every edit and the wire therefore reports no actual cache bust.
                    expect(observeHeuristics.mock.calls.length).toBe(1);
                    observeHeuristics.mockRestore();
                    expect(f.mock.check(wire(wall.messages))).toBeNull();
                    expect(getPendingOps(f.db, f.sessionId).length).toBe(1);
                    expect(hasParkedBustTrigger(f.sessionId)).toBe(true);
                    f.userTurn("review-wall-release", "Continue.");
                    const release = await f.pass();
                    expect(getPendingOps(f.db, f.sessionId).length).toBe(0);
                    expect(f.mock.check(wire(release.messages))).toBeNull();
                    f.setUsage(20);
                    expect((await f.pass()).bustedThisPass).toBe(false);
                },
                "review-wall",
            ),
        );
        it(
            "pending signal with no held work drains normally",
            withFixture(
                generation,
                false,
                "/ctx-flush",
                async (f) => {
                    expect(getPendingOps(f.db, f.sessionId).length).toBe(0);
                    f.pendingMaterialization.add(f.sessionId);
                    const result = await f.pass();
                    expect(f.mock.hasCurrentTurnThinking(wire(result.messages))).toBe(false);
                    expect(f.pendingMaterialization.has(f.sessionId)).toBe(false);
                    expect(hasParkedBustTrigger(f.sessionId)).toBe(false);
                    expect((await f.pass()).bustedThisPass).toBe(false);
                },
                "review-empty-signal",
            ),
        );
    });
}

for (const generation of ["v1", "v2"] as const) {
    it(
        `step2b review: ${generation} empty subagent flush leaves no standing signal under thinking`,
        withFixture(
            generation,
            true,
            "/ctx-flush",
            async (f) => {
                await toolLoop(f, 4);
                expect(getPendingOps(f.db, f.sessionId).length).toBe(0);
                f.pendingMaterialization.add(f.sessionId);
                const pass = await f.pass();
                expect(f.mock.check(wire(pass.messages))).toBeNull();
                // This child renders no synthetic history head and has no queued
                // message drops, so its flush has no blocked operation to retry.
                expect(f.pendingMaterialization.has(f.sessionId)).toBe(false);
                expect(hasParkedBustTrigger(f.sessionId)).toBe(false);
                expect((await f.pass()).bustedThisPass).toBe(false);
            },
            "review-empty-subagent",
        ),
    );
}
