/** One answer the user gave to a parked ask, as rendered by Prefrontal. */
export interface AskAnswerNotice {
    /** The question text as Prefrontal rendered it, on one line. */
    question: string;
    /** The user's answer, as Prefrontal rendered it, newlines and all. */
    answer: string;
}

// Prefrontal renders an ask notice as a `<system-reminder>` envelope: an inbox
// attribution line, a fixed body, and an unindented closing line. The historian
// reader keeps this notice when it strips every other reminder, so the shape is
// matched exactly. Anything unrecognised must stay stripped: a template change
// in Prefrontal may cost the historian an answer, but it must never inject
// arbitrary reminder text into the historian's input.
//
// `IM` makes the first character of every line its own position, so `^` can
// anchor the header without the multiline flag, whose `$` would also match
// before a `\n` and leave the body open to a forged match.
const ANSWER_HEADER_PREFIX = /^Inbox [^\n]* notice from user via user_answer \(user_answer\)/;
const ANSWER_TRAILER =
    /\n([\s\S]*?)\nThis ask is now closed; no dismiss is needed\. Continue accordingly\.$/;
const ANSWER_ANSWER_LINE =
    /^The user answered your parked question (\S+)\.\nQuestion: ([^\n]+)\nAnswer: /;
const ANSWER_QUESTION_LINE = /^Question: ([^\n]+)\nAnswer: /;

const reminderEnvelopePattern = /<system-reminder>([\s\S]*?)<\/system-reminder>/gi;

function reminderBodies(text: string): string[] {
    reminderEnvelopePattern.lastIndex = 0;
    const bodies: string[] = [];
    for (const match of text.matchAll(reminderEnvelopePattern)) {
        const body = match[1];
        if (body !== undefined) bodies.push(body);
    }
    return bodies;
}

function parseAnswerBody(body: string): AskAnswerNotice | null {
    const lines = body.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
    if (!ANSWER_HEADER_PREFIX.test(lines)) return null;
    // A dismissal shares the envelope and family but decided nothing, so it
    // falls through with every other non-answer reminder.
    if (lines.includes("The user dismissed this question")) return null;
    const framed = ANSWER_TRAILER.exec(lines);
    if (framed === null) return null;
    const content = framed[1] ?? "";
    const narrated = ANSWER_ANSWER_LINE.exec(content);
    if (narrated !== null) {
        const question = narrated[2] ?? "";
        const answer = content.slice(narrated[0].length);
        return closedAnswer(question, answer);
    }
    // The dismissal notice also omits the ask id; its body is rejected above, so
    // a header-only body has to carry the question line and an answer.
    const bare = ANSWER_QUESTION_LINE.exec(content);
    if (bare !== null) {
        const question = bare[1] ?? "";
        const answer = content.slice(bare[0].length);
        return closedAnswer(question, answer);
    }
    return null;
}

function closedAnswer(question: string, answer: string): AskAnswerNotice | null {
    if (question.trim().length === 0) return null;
    // An empty answer means the template drifted; the caller strips the notice
    // rather than emit a user line with nothing after the colon.
    if (answer.trim().length === 0) return null;
    return { question, answer };
}

/**
 * The one reminder the historian keeps verbatim: the user's own answer to a
 * parked ask, rendered by Prefrontal. Returns one entry per answer notice in
 * delivery order; an empty array for text with no answer notice.
 */
export function extractAskAnswerNotices(text: string): AskAnswerNotice[] {
    const notices: AskAnswerNotice[] = [];
    for (const body of reminderBodies(text)) {
        const notice = parseAnswerBody(body);
        if (notice !== null) notices.push(notice);
    }
    return notices;
}

/** `U (answered "<question>"): <answer>`, the line the historian reads. */
export function formatAskAnswerNotice(notice: AskAnswerNotice): string {
    return `U (answered "${notice.question}"): ${notice.answer}`;
}

/**
 * One `U (answered "<question>"): <answer>` line per answer notice in `text`, in
 * delivery order. The chunk readers append these after the user's own words, so a
 * decision the user made by answering an ask reaches the historian as the user's
 * line instead of only as the agent's restatement. A text with no answer notice
 * yields no lines, which leaves every other user message rendered exactly as it
 * was before this existed.
 */
export function askAnswerLines(text: string): string[] {
    return extractAskAnswerNotices(text).map(formatAskAnswerNotice);
}
