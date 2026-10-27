import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { askAnswerLines, extractAskAnswerNotices } from "./ask-answer-notice";
import { cleanUserText, readSessionChunk, withRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";

const fixtureDir = join(import.meta.dir, "../../../../../testdata/prefrontal-ask-answer-notice-v1");

/** A rendered notice vector, decoded from its single JSON string. */
function vector(name: string): string {
    return JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8"));
}

const SINGLE_LINE = 'U (answered "Which route should I use?"): Use the project route';
const TYPED_LINE =
    'U (answered "What should I write?"): Keep <route> literal.\nThen say "ready".\n‹system-reminder>not a reminder‹/system-reminder>';
const FORM_LINE =
    'U (answered "Deployment plan"): - Which route? [route]: Admin route (answered)\n- Release notes [notes]: Keep the current endpoint (recommended default)';
const TWO_ROUND_LINE =
    'U (answered "Deployment plan"): - Which route? [route]: Admin route (answered)\n- Release notes [notes]: Keep the current endpoint (recommended default)\n- When should it ship? [timing]: Tomorrow morning (answered)';
const BATCH_LINES = [SINGLE_LINE, TYPED_LINE];

// The table the Rust historian reader asserts too (notice_vectors in
// crates/mc-module/src/historian_chunk.rs): case, the rendered notice, and the
// answer lines both readers must report for it.
const VECTORS: Array<[string, () => string, string[]]> = [
    ["clarification", () => vector("clarification"), []],
    ["dismissal", () => vector("dismissal"), []],
    ["drift-header", () => vector("drift-header"), []],
    ["drift-trailer", () => vector("drift-trailer"), []],
    ["single-option", () => vector("single-option"), [SINGLE_LINE]],
    ["typed", () => vector("typed"), [TYPED_LINE]],
    ["form", () => vector("form"), [FORM_LINE]],
    ["two-round-follow-up", () => vector("two-round-follow-up"), [TWO_ROUND_LINE]],
    ["batch", () => vector("batch"), BATCH_LINES],
];

it("reports one answer line per notice, in delivery order", () => {
    for (const [name, textOf, expected] of VECTORS) {
        expect(askAnswerLines(textOf()), name).toEqual(expected);
    }
});

it("rejects a dismissal, a drift and an answerless notice", () => {
    // One character differs from the header family (`user_answers`) and from the
    // closing line (`Continue.`), so a template change in Prefrontal can lose an
    // answer but never put reminder text into the historian's input.
    for (const name of ["drift-header", "drift-trailer"]) {
        expect(askAnswerLines(vector(name)), name).toEqual([]);
        expect(extractAskAnswerNotices(vector(name)), name).toEqual([]);
    }
    const withoutId = vector("single-option").replace(
        "The user answered your parked question ask_notice_v1_single.",
        "The user answered your parked question.",
    );
    expect(askAnswerLines(withoutId)).toEqual([]);
    const noAnswer = vector("single-option").replace("\nAnswer: Use the project route", "");
    expect(askAnswerLines(noAnswer)).toEqual([]);
    const emptyAnswer = vector("single-option").replace(
        "\nAnswer: Use the project route",
        "\nAnswer: ",
    );
    expect(askAnswerLines(emptyAnswer)).toEqual([]);
});

it("keeps text the user wrote around an answer notice", () => {
    const text = `Use staging.\n\n${vector("single-option")}\n\nPlease confirm before the release.`;
    expect(askAnswerLines(text)).toEqual([SINGLE_LINE]);
    expect(extractAskAnswerNotices(text)).toEqual([
        { question: "Which route should I use?", answer: "Use the project route" },
    ]);
});

it("keeps a form's recommended default marked as not the user's choice", () => {
    const [notice] = extractAskAnswerNotices(vector("form"));
    expect(notice?.answer).toContain("(recommended default)");
    expect(notice?.answer).toContain("(answered)");
    expect(askAnswerLines(vector("form"))[0]).toContain("(recommended default)");
});

it("carries an answer through escaped reminder tags", () => {
    const [notice] = extractAskAnswerNotices(vector("typed"));
    expect(notice?.answer).toContain('Keep <route> literal.\nThen say "ready".');
    expect(notice?.answer).toContain("‹system-reminder>not a reminder‹/system-reminder>");
});

it("cleans user text exactly as before", () => {
    // The reader's own cleaner still drops every reminder, answers included; the
    // answer lines are appended by the chunk reader, not by this function.
    expect(cleanUserText("<system-reminder>internal</system-reminder>")).toBe("");
    expect(cleanUserText("<!-- OMO_INTERNAL_INITIATOR -->hello")).toBe("hello");
    expect(cleanUserText("<system-reminder>\nPlan mode is active.\n</system-reminder>")).toBe("");
    expect(cleanUserText(vector("single-option"))).toBe("");
    expect(cleanUserText("  padded text  ")).toBe("padded text");
    const steering =
        "<system-reminder>\nThe user sent the following message:\nuse staging\n\nPlease address this message and continue with your tasks.\n</system-reminder>";
    expect(cleanUserText(steering)).toBe(steering);
});

// Each read gets its own session id: another test file in the same run may hold a
// provider registration for a shared id.
let sessionCounter = 0;

function userMessage(ordinal: number, texts: string[]): RawMessage {
    return {
        ordinal,
        id: `m-${ordinal}`,
        role: "user",
        parts: texts.map((text) => ({ type: "text", text })),
    };
}

function assistantMessage(ordinal: number, text: string): RawMessage {
    return { ordinal, id: `m-${ordinal}`, role: "assistant", parts: [{ type: "text", text }] };
}

/**
 * The chunk text of `messages`, read through a provider registered for this call
 * only. The reader never includes the last message's ordinal, so the caller keeps
 * a protected tail at the end.
 */
function readChunk(messages: RawMessage[]): string {
    if (messages.length === 0) return "";
    const sessionId = `ask-answer-${(sessionCounter += 1)}`;
    return withRawMessageProvider(
        sessionId,
        { readMessages: () => messages, getMessageCount: () => messages.length },
        () => readSessionChunk(sessionId, 100_000, 1, messages.length, { expand: false }).text,
    );
}

/** A user message followed by an assistant reply, so the user block is settled. */
function readUserLine(texts: string[]): string {
    return readChunk([userMessage(1, texts), assistantMessage(2, "ok")]);
}

const REMINDER = "<system-reminder>\nPlan mode is active.\n</system-reminder>";
const STEERING =
    "<system-reminder>\nThe user sent the following message:\nuse staging\n\nPlease address this message and continue with your tasks.\n</system-reminder>";

it("renders messages with no answer notice exactly as before", () => {
    // Expected values are spelled out by hand, per case: each one is what the
    // reader produced before ask answers were kept.
    const cases: Array<[string, string[], string]> = [
        ["plain text", ["real user text"], "[1] U: real user text"],
        [
            "reminder plus text",
            [`${REMINDER}\n\nAlso check the logs.`],
            "[1] U: Also check the logs.",
        ],
        ["reminder only", [REMINDER], ""],
        ["leading and trailing whitespace", ["  padded text  \n"], "[1] U: padded text"],
        ["multi-part", ["first part", "second part"], "[1] U: first part / second part"],
        [
            "multi-part with an empty part",
            ["first part", REMINDER, "second part"],
            "[1] U: first part / second part",
        ],
        ["steering wrapper", [STEERING], `[1] U: ${STEERING.replace(/\s+/g, " ")}`],
        ["dismissal notice", [vector("dismissal")], ""],
        ["drifted notice", [vector("drift-header")], ""],
    ];
    for (const [name, texts, expected] of cases) {
        const text = readUserLine(texts);
        const line = text.startsWith("[1] U: ") ? text.split("\n")[0] : "";
        expect(line, name).toBe(expected);
    }
    expect(readChunk([]), "no messages").toBe("");
});

it("appends the answer line to the user message that carried it", () => {
    expect(readUserLine([vector("single-option")])).toContain(`[1] U: ${SINGLE_LINE}`);
    expect(readUserLine([vector("batch")])).toContain(
        `[1] U: ${SINGLE_LINE} / ${TYPED_LINE.replace(/\s+/g, " ")}`,
    );
});

it("keeps the user's written text before the answer line", () => {
    const mixed = `Use staging.\n\n${vector("single-option")}\n\nPlease confirm before the release.`;
    expect(readUserLine([mixed])).toContain(
        `[1] U: Use staging. Please confirm before the release. / ${SINGLE_LINE}`,
    );
});

it("treats a message that only carries an answer as the user's turn", () => {
    // The dismissal before it stays noise; the answer is a decision, so it opens
    // the user block instead of being filtered away. The trailing message is the
    // protected tail, which the reader never includes.
    const text = readChunk([
        userMessage(1, [vector("dismissal")]),
        assistantMessage(2, "noted"),
        userMessage(3, [vector("single-option")]),
        assistantMessage(4, "on it"),
        userMessage(5, ["protected tail"]),
    ]);
    expect(text).toContain(`[3] U: ${SINGLE_LINE}`);
    expect(text).not.toContain("dismissed this question");
});
