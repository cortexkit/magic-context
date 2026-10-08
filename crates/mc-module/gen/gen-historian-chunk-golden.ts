/**
 * Generate historian chunk differential goldens from the real TS readSessionChunk.
 *
 * Run: bun crates/mc-module/gen/gen-historian-chunk-golden.ts [--check]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const resolve = (m: string) => Bun.resolveSync(m, pluginDir);
const chunkMod = await import(resolve("./src/hooks/magic-context/read-session-chunk"));
const formattingMod = await import(resolve("./src/hooks/magic-context/read-session-formatting"));

type ReadSessionChunk = (sessionId: string, tokenBudget: number, offset?: number, eligibleEndOrdinal?: number) => SessionChunk;
type WithRawMessageProvider = <T>(sessionId: string, provider: RawMessageProvider, fn: () => T) => T;

const { readSessionChunk, withRawMessageProvider } = chunkMod as {
    readSessionChunk: ReadSessionChunk;
    withRawMessageProvider: WithRawMessageProvider;
};
const { estimateTokens } = formattingMod as { estimateTokens: (text: string) => number };

interface RawMessageProvider {
    readMessages(): TsMsg[];
    getMessageCount(): number;
}
type TsMsg = { ordinal: number; id: string; role: string; parts: unknown[] };
type CkMsg = { mid: string; ordinal: number; ck: { role: string; content: unknown[]; meta?: { synthetic?: boolean } } };
interface SessionChunk {
    startIndex: number;
    endIndex: number;
    startMessageId: string;
    endMessageId: string;
    messageCount: number;
    tokenEstimate: number;
    hasMore: boolean;
    text: string;
    lines: Array<{ ordinal: number; messageId: string }>;
    commitClusterCount: number;
    toolOnlyRanges: Array<{ start: number; end: number }>;
}

function text(text: string) {
    return { type: "text", text };
}
function tool(name: string, input: Record<string, unknown>) {
    return { type: "tool", tool: name, state: { input } };
}
function ckText(text: string) {
    return { kind: { type: "text", text } };
}
function ckToolCall(id: string, name: string, input: Record<string, unknown>) {
    return { kind: { type: "tool_call", id, name, input } };
}
function ckToolResult(id: string, toolName: string) {
    return { kind: { type: "tool_result", id, tool_name: toolName, output: { kind: { type: "text", text: "ignored output" } } } };
}

const cases: Array<{
    label: string;
    budget: number;
    offset: number;
    eligibleEnd: number;
    ts: TsMsg[];
    ck: CkMsg[];
    exercises: string[];
}> = [
    {
        label: "noise-and-tool-absorb",
        budget: 10_000,
        offset: 1,
        eligibleEnd: 6,
        exercises: ["noise_absorb", "tc_merge"],
        ts: [
            { ordinal: 1, id: "u1", role: "user", parts: [text("<system-reminder>ignore</system-reminder>")] },
            { ordinal: 2, id: "a2", role: "assistant", parts: [text("I will inspect")] },
            { ordinal: 3, id: "u3", role: "user", parts: [tool("read", { path: "src/lib.rs" })] },
            { ordinal: 4, id: "u4", role: "user", parts: [text("continue")] },
        ],
        ck: [
            { mid: "u1", ordinal: 1, ck: { role: "user", content: [ckText("<system-reminder>ignore</system-reminder>")] } },
            { mid: "a2", ordinal: 2, ck: { role: "assistant", content: [ckText("I will inspect"), ckToolCall("c1", "read", { path: "src/lib.rs" })] } },
            { mid: "t3", ordinal: 3, ck: { role: "tool", content: [ckToolResult("c1", "read")] } },
            { mid: "u4", ordinal: 4, ck: { role: "user", content: [ckText("continue")] } },
        ],
    },
    {
        label: "standalone-result-at-chunk-start",
        budget: 10_000,
        offset: 2,
        eligibleEnd: 4,
        exercises: ["standalone_result"],
        ts: [
            { ordinal: 1, id: "a1", role: "assistant", parts: [tool("read", { path: "src/lib.rs" })] },
            { ordinal: 2, id: "u2", role: "user", parts: [tool("read", { path: "src/lib.rs" })] },
            { ordinal: 3, id: "u3", role: "user", parts: [text("after")] },
        ],
        ck: [
            { mid: "a1", ordinal: 1, ck: { role: "assistant", content: [ckToolCall("c1", "read", { path: "src/lib.rs" })] } },
            { mid: "t2", ordinal: 2, ck: { role: "tool", content: [ckToolResult("c1", "read")] } },
            { mid: "u3", ordinal: 3, ck: { role: "user", content: [ckText("after")] } },
        ],
    },
    {
        label: "budget-stop",
        budget: 6,
        offset: 1,
        eligibleEnd: 7,
        exercises: ["budget_stop"],
        ts: [
            { ordinal: 1, id: "u1", role: "user", parts: [text("short")] },
            { ordinal: 2, id: "a2", role: "assistant", parts: [text("first assistant block")] },
            { ordinal: 3, id: "u3", role: "user", parts: [text("this should remain unread because the budget stops before it")] },
            { ordinal: 4, id: "a4", role: "assistant", parts: [text("tail")] },
        ],
        ck: [
            { mid: "u1", ordinal: 1, ck: { role: "user", content: [ckText("short")] } },
            { mid: "a2", ordinal: 2, ck: { role: "assistant", content: [ckText("first assistant block")] } },
            { mid: "u3", ordinal: 3, ck: { role: "user", content: [ckText("this should remain unread because the budget stops before it")] } },
            { mid: "a4", ordinal: 4, ck: { role: "assistant", content: [ckText("tail")] } },
        ],
    },
    {
        label: "tool-only-range-merge",
        budget: 10_000,
        offset: 1,
        eligibleEnd: 5,
        exercises: ["tool_only_merge"],
        ts: [
            { ordinal: 1, id: "a1", role: "assistant", parts: [tool("read", { path: "one" })] },
            { ordinal: 2, id: "a2", role: "assistant", parts: [tool("read", { path: "two" })] },
            { ordinal: 3, id: "u3", role: "user", parts: [text("narrative")] },
        ],
        ck: [
            { mid: "a1", ordinal: 1, ck: { role: "assistant", content: [ckToolCall("c1", "read", { path: "one" })] } },
            { mid: "a2", ordinal: 2, ck: { role: "assistant", content: [ckToolCall("c2", "read", { path: "two" })] } },
            { mid: "u3", ordinal: 3, ck: { role: "user", content: [ckText("narrative")] } },
        ],
    },
    {
        label: "commit-cluster",
        budget: 10_000,
        offset: 1,
        eligibleEnd: 6,
        exercises: ["commit_cluster"],
        ts: [
            { ordinal: 1, id: "u1", role: "user", parts: [text("go")] },
            { ordinal: 2, id: "a2", role: "assistant", parts: [text("committed abcdef1 with fix")] },
            { ordinal: 3, id: "u3", role: "user", parts: [text("again")] },
            { ordinal: 4, id: "a4", role: "assistant", parts: [text("commit abcdef2 with more")] },
        ],
        ck: [
            { mid: "u1", ordinal: 1, ck: { role: "user", content: [ckText("go")] } },
            { mid: "a2", ordinal: 2, ck: { role: "assistant", content: [ckText("committed abcdef1 with fix")] } },
            { mid: "u3", ordinal: 3, ck: { role: "user", content: [ckText("again")] } },
            { mid: "a4", ordinal: 4, ck: { role: "assistant", content: [ckText("commit abcdef2 with more")] } },
        ],
    },
    {
        label: "system-role-skip",
        budget: 10_000,
        offset: 1,
        eligibleEnd: 4,
        exercises: ["system_skip"],
        // The TS leg never sees a wire system message (system prompts are not
        // session rows), so the oracle-equivalent of CK's system-at-ordinal-2 is
        // a zero-part message occupying the same ordinal: no summarizable
        // content, but the ordinal still rides the coverage line meta. The CK
        // builder feeds system messages through as zero-block for exactly this
        // reason — a mid-span system ordinal must not open a coverage gap.
        ts: [
            { ordinal: 1, id: "u1", role: "user", parts: [text("hello")] },
            { ordinal: 2, id: "sys2", role: "user", parts: [] },
            { ordinal: 3, id: "a3", role: "assistant", parts: [text("done")] },
        ],
        ck: [
            { mid: "u1", ordinal: 1, ck: { role: "user", content: [ckText("hello")] } },
            { mid: "sys2", ordinal: 2, ck: { role: "system", content: [ckText("identity")] } },
            { mid: "a3", ordinal: 3, ck: { role: "assistant", content: [ckText("done")] } },
        ],
    },
    {
        label: "noise-absorb-next-block",
        budget: 10_000,
        offset: 1,
        eligibleEnd: 4,
        exercises: ["noise_absorb_next"],
        ts: [
            { ordinal: 1, id: "u1", role: "user", parts: [text("<!-- OMO_INTERNAL_INITIATOR -->")] },
            { ordinal: 2, id: "u2", role: "user", parts: [text("real user text")] },
        ],
        ck: [
            { mid: "u1", ordinal: 1, ck: { role: "user", content: [ckText("<!-- OMO_INTERNAL_INITIATOR -->")] } },
            { mid: "u2", ordinal: 2, ck: { role: "user", content: [ckText("real user text")] } },
        ],
    },
    {
        label: "zero-block-noise-absorb",
        budget: 10_000,
        offset: 1,
        eligibleEnd: 4,
        exercises: ["zero_block_noise"],
        ts: [
            { ordinal: 1, id: "empty1", role: "user", parts: [] },
            { ordinal: 2, id: "u2", role: "user", parts: [text("real user text")] },
        ],
        ck: [
            { mid: "empty1", ordinal: 1, ck: { role: "user", content: [] } },
            { mid: "u2", ordinal: 2, ck: { role: "user", content: [ckText("real user text")] } },
        ],
    },
    {
        label: "omitted-background-notice-gap",
        budget: 10_000,
        offset: 1,
        eligibleEnd: 4,
        exercises: ["ordinal_gap"],
        // Background notices can be absent from the historian input while later
        // messages retain their original raw ordinals. The header names that raw
        // span rather than the number of rendered transcript lines.
        ts: [
            { ordinal: 1, id: "u1", role: "user", parts: [text("start")] },
            { ordinal: 3, id: "a3", role: "assistant", parts: [text("continued")] },
        ],
        ck: [
            { mid: "u1", ordinal: 1, ck: { role: "user", content: [ckText("start")] } },
            { mid: "a3", ordinal: 3, ck: { role: "assistant", content: [ckText("continued")] } },
        ],
    },
    {
        label: "duplicate-call-id-results-use-paired-arc",
        budget: 10_000,
        offset: 1,
        eligibleEnd: 6,
        exercises: ["duplicate_call_ids"],
        ts: [
            { ordinal: 1, id: "a1", role: "assistant", parts: [tool("read", { path: "one.rs" })] },
            { ordinal: 2, id: "u2", role: "user", parts: [tool("read", { path: "one.rs" })] },
            { ordinal: 3, id: "a3", role: "assistant", parts: [tool("read", { path: "two.rs" })] },
            { ordinal: 4, id: "u4", role: "user", parts: [tool("read", { path: "two.rs" })] },
        ],
        ck: [
            { mid: "a1", ordinal: 1, ck: { role: "assistant", content: [ckToolCall("dup", "read", { path: "one.rs" })] } },
            { mid: "t2", ordinal: 2, ck: { role: "tool", content: [ckToolResult("dup", "read")] } },
            { mid: "a3", ordinal: 3, ck: { role: "assistant", content: [ckToolCall("dup", "read", { path: "two.rs" })] } },
            { mid: "t4", ordinal: 4, ck: { role: "tool", content: [ckToolResult("dup", "read")] } },
        ],
    },
    {
        label: "max-commits-per-block-cap",
        budget: 10_000,
        offset: 1,
        eligibleEnd: 3,
        exercises: ["commit_cap"],
        ts: [
            { ordinal: 1, id: "a1", role: "assistant", parts: [text("committed 1111111 2222222 3333333 4444444 5555555 6666666 with cap")] },
        ],
        ck: [
            { mid: "a1", ordinal: 1, ck: { role: "assistant", content: [ckText("committed 1111111 2222222 3333333 4444444 5555555 6666666 with cap")] } },
        ],
    },
    {
        label: "commit-strip-cleanup-chain",
        budget: 10_000,
        offset: 1,
        eligibleEnd: 3,
        exercises: ["commit_cleanup"],
        ts: [
            { ordinal: 1, id: "a1", role: "assistant", parts: [text("committed (abcdef1) , , cleanup")] },
        ],
        ck: [
            { mid: "a1", ordinal: 1, ck: { role: "assistant", content: [ckText("committed (abcdef1) , , cleanup")] } },
        ],
    },
    {
        label: "pending-noise-budget-stop",
        budget: 6,
        offset: 1,
        eligibleEnd: 5,
        exercises: ["pending_noise_budget_stop"],
        ts: [
            { ordinal: 1, id: "u1", role: "user", parts: [text("short")] },
            { ordinal: 2, id: "noise2", role: "user", parts: [text("<!-- OMO_INTERNAL_INITIATOR -->")] },
            { ordinal: 3, id: "a3", role: "assistant", parts: [text("this assistant block is intentionally too long for the tiny chunk budget")] },
        ],
        ck: [
            { mid: "u1", ordinal: 1, ck: { role: "user", content: [ckText("short")] } },
            { mid: "noise2", ordinal: 2, ck: { role: "user", content: [ckText("<!-- OMO_INTERNAL_INITIATOR -->")] } },
            { mid: "a3", ordinal: 3, ck: { role: "assistant", content: [ckText("this assistant block is intentionally too long for the tiny chunk budget")] } },
        ],
    },
];

function assertNonVacuous(label: string, expected: SessionChunk, exercises: string[], inputCount: number) {
    for (const exercise of exercises) {
        switch (exercise) {
            case "budget_stop":
                if (!expected.hasMore || expected.messageCount >= inputCount) throw new Error(`${label}: budget stop did not fire`);
                break;
            case "commit_cluster":
                if (expected.commitClusterCount <= 0) throw new Error(`${label}: commit cluster not counted`);
                break;
            case "tool_only_merge":
                if (!expected.toolOnlyRanges.some((r) => r.start === 1 && r.end === 2)) throw new Error(`${label}: tool-only range did not merge`);
                break;
            case "noise_absorb":
            case "noise_absorb_next":
                if (!expected.text.includes("[1-")) throw new Error(`${label}: pending noise was not absorbed into following block`);
                break;
            case "zero_block_noise":
                if (expected.text !== "[1-2] U: real user text") throw new Error(`${label}: zero-block message was not absorbed as noise`);
                if (expected.lines.map((line) => line.ordinal).join(",") !== "1,2") throw new Error(`${label}: zero-block ordinal did not reach line metadata`);
                break;
            case "tc_merge":
                if (!expected.text.includes("TC: read(src/lib.rs)")) throw new Error(`${label}: TC summary did not merge`);
                break;
            case "duplicate_call_ids":
                if (expected.text !== "[1-4] A: TC: read(one.rs) / TC: read(one.rs) / TC: read(two.rs) / TC: read(two.rs)") {
                    throw new Error(`${label}: duplicate call ids did not keep distinct paired summaries`);
                }
                break;
            case "standalone_result":
                if (!expected.text.startsWith("[2] A: TC: read(src/lib.rs)")) throw new Error(`${label}: standalone result did not open a TC-only A block`);
                break;
            case "system_skip":
                if (expected.text.includes("identity")) throw new Error(`${label}: system content leaked into the chunk text`);
                if (expected.lines.map((line) => line.ordinal).join(",") !== "1,2,3") {
                    throw new Error(`${label}: system ordinal must ride coverage line meta without a gap`);
                }
                break;
            case "ordinal_gap":
                if (expected.startIndex !== 1 || expected.endIndex !== 3) {
                    throw new Error(`${label}: raw ordinal gap was not retained in the chunk range`);
                }
                break;
            case "commit_cap":
                if (!expected.text.includes("commits: 1111111, 2222222, 3333333, 4444444, 5555555")) throw new Error(`${label}: commit cap did not keep the first five hashes`);
                if (expected.text.includes("6666666")) throw new Error(`${label}: commit cap leaked the sixth hash`);
                break;
            case "commit_cleanup":
                if (!expected.text.includes("committed, cleanup") || expected.text.includes("()") || expected.text.includes(", ,")) {
                    throw new Error(`${label}: commit strip cleanup chain did not match TS`);
                }
                break;
            case "pending_noise_budget_stop":
                if (!expected.hasMore || expected.endIndex !== 1) throw new Error(`${label}: budget stop did not stop before pending noise block`);
                if (expected.lines.some((line) => line.ordinal === 2)) throw new Error(`${label}: pending noise leaked into line metadata after stop`);
                break;
            default:
                throw new Error(`${label}: unknown exercise ${exercise}`);
        }
    }
}

const TRUNCATION_MARKER = "\n[… tokens truncated by Magic Context to fit the historian window …]";
function truncateLikeTs(text: string, budget: number): string {
    if (estimateTokens(text) <= budget) return text;
    let lo = 0;
    let hi = text.length;
    let best = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (estimateTokens(text.slice(0, mid) + TRUNCATION_MARKER) <= budget) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return text.slice(0, best) + TRUNCATION_MARKER;
}

const truncationCases = [
    {
        label: "truncation-marker-ascii-prefix",
        budget: estimateTokens(TRUNCATION_MARKER) + 12,
        input: "historian input line ".repeat(120),
    },
].map((c) => {
    const expected = truncateLikeTs(c.input, c.budget);
    if (!expected.endsWith(TRUNCATION_MARKER)) throw new Error(`${c.label}: marker missing`);
    const prefix = expected.slice(0, -TRUNCATION_MARKER.length);
    if (estimateTokens(expected) > c.budget) throw new Error(`${c.label}: expected output exceeds budget`);
    if (prefix.length < c.input.length && estimateTokens(c.input.slice(0, prefix.length + 1) + TRUNCATION_MARKER) <= c.budget) {
        throw new Error(`${c.label}: expected prefix was not maximal`);
    }
    return { ...c, expected };
});

const outCases = cases.map((c) => {
    const expected = withRawMessageProvider(
        c.label,
        {
            readMessages: () => c.ts,
            getMessageCount: () => Math.max(0, ...c.ts.map((message) => message.ordinal)),
        },
        () => readSessionChunk(c.label, c.budget, c.offset, c.eligibleEnd),
    );
    assertNonVacuous(c.label, expected, c.exercises, c.ts.length);
    return {
        ...c,
        expected: {
            ...expected,
            inputSource: `Messages ${expected.startIndex}-${expected.endIndex}:\n\n${expected.text}`,
        },
    };
});

const out = JSON.stringify({ generatedBy: "gen-historian-chunk-golden.ts", cases: outCases, truncationCases }, null, 2) + "\n";
const path = join(import.meta.dir, "..", "testdata", "historian-chunk-golden.json");
if (process.argv.includes("--check")) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== out) {
        throw new Error("historian chunk golden drift; run bun crates/mc-module/gen/gen-historian-chunk-golden.ts");
    }
} else {
    writeFileSync(path, out);
}
