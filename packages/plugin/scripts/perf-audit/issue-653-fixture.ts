/**
 * Synthetic OpenCode 1 session shaped like the sessions in issue 653: about 600
 * input messages and about 56 MB of content, most of it in a few dozen large
 * tool outputs (100 KB to 2 MB) with short text turns between them.
 *
 * Messages are kept as JSON text and parsed again on every pass, because
 * OpenCode 1 loads the session from its database for each request: no string
 * or object is shared between two passes.
 */

export interface FixtureMessage {
    info: Record<string, unknown>;
    parts: Array<Record<string, unknown>>;
}

/** Deterministic xorshift so every run builds the same session. */
export function rng(seed: number): () => number {
    let state = seed >>> 0 || 1;
    return () => {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state / 0x100000000;
    };
}

const WORDS =
    "const value return function import export interface type await async if else for while switch case break continue throw try catch finally class extends new this super null undefined true false".split(
        " ",
    );

/** Source-code-like text of roughly `size` characters. */
export function codeText(random: () => number, size: number): string {
    const lines: string[] = [];
    let length = 0;
    let lineNo = 1;
    while (length < size) {
        const words = 3 + Math.floor(random() * 10);
        let line = `${String(lineNo).padStart(5, " ")}\t`;
        for (let i = 0; i < words; i += 1) {
            line += `${WORDS[Math.floor(random() * WORDS.length)]} `;
        }
        lines.push(line);
        length += line.length + 1;
        lineNo += 1;
    }
    return lines.join("\n");
}

export interface SessionFixture {
    sessionId: string;
    /** One JSON text per message, parsed again for every pass. */
    json: string[];
    totalChars: number;
}

function messageId(sessionTag: string, index: number): string {
    return `msg_${sessionTag}_${String(index).padStart(6, "0")}`;
}

export function userMessage(
    sessionId: string,
    id: string,
    created: number,
    text: string,
): FixtureMessage {
    return {
        info: {
            id,
            sessionID: sessionId,
            role: "user",
            time: { created },
            agent: "build",
            model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        },
        parts: [{ id: `${id}_p0`, sessionID: sessionId, messageID: id, type: "text", text }],
    };
}

export function assistantMessage(
    sessionId: string,
    id: string,
    parentId: string,
    created: number,
    random: () => number,
    toolOutputChars: number,
): FixtureMessage {
    const parts: Array<Record<string, unknown>> = [
        { id: `${id}_p0`, sessionID: sessionId, messageID: id, type: "step-start" },
        {
            id: `${id}_p1`,
            sessionID: sessionId,
            messageID: id,
            type: "text",
            text: codeText(random, 200 + Math.floor(random() * 1200)),
            time: { start: created, end: created + 5 },
        },
    ];
    if (toolOutputChars > 0) {
        parts.push({
            id: `${id}_p2`,
            sessionID: sessionId,
            messageID: id,
            type: "tool",
            callID: `call_${id}`,
            tool: "read",
            state: {
                status: "completed",
                input: { filePath: `/repo/src/file-${id}.ts` },
                output: codeText(random, toolOutputChars),
                title: `src/file-${id}.ts`,
                metadata: { preview: codeText(random, 400), truncated: false },
                time: { start: created + 6, end: created + 30 },
            },
        });
    }
    parts.push({
        id: `${id}_p9`,
        sessionID: sessionId,
        messageID: id,
        type: "step-finish",
        reason: toolOutputChars > 0 ? "tool-calls" : "stop",
        cost: 0.01,
        tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    return {
        info: {
            id,
            sessionID: sessionId,
            role: "assistant",
            parentID: parentId,
            time: { created, completed: created + 40 },
            modelID: "claude-sonnet-4-5",
            providerID: "anthropic",
            mode: "build",
            agent: "build",
            path: { cwd: "/repo", root: "/repo" },
            cost: 0.01,
            tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
        },
        parts,
    };
}

/**
 * Build `messageCount` messages (user/assistant pairs). About one assistant in
 * eight carries a tool output; output sizes are drawn from 100 KB to 2 MB and
 * scaled so the session lands near `targetChars`.
 */
export function buildSession(
    sessionTag: string,
    seed: number,
    messageCount = 606,
    targetChars = 56 * 1024 * 1024,
): SessionFixture {
    const random = rng(seed);
    const sessionId = `ses_${sessionTag}`;
    const pairs = Math.floor(messageCount / 2);
    const toolPairs = new Set<number>();
    while (toolPairs.size < Math.max(1, Math.round(pairs / 8))) {
        toolPairs.add(Math.floor(random() * pairs));
    }
    const rawSizes = [...toolPairs].map(() => 100 * 1024 + Math.floor(random() * 1948 * 1024));
    const rawTotal = rawSizes.reduce((sum, size) => sum + size, 0);
    const scale = (targetChars * 0.97) / rawTotal;
    const sizes = new Map<number, number>();
    [...toolPairs].forEach((pair, index) => {
        const size = Math.min(2 * 1024 * 1024, Math.max(100 * 1024, rawSizes[index] * scale));
        sizes.set(pair, Math.floor(size));
    });
    const json: string[] = [];
    let totalChars = 0;
    const base = 1_760_000_000_000;
    for (let pair = 0; pair < pairs; pair += 1) {
        const userId = messageId(sessionTag, pair * 2);
        const assistantId = messageId(sessionTag, pair * 2 + 1);
        const created = base + pair * 1000;
        const user = JSON.stringify(
            userMessage(sessionId, userId, created, codeText(random, 80 + random() * 400)),
        );
        const assistant = JSON.stringify(
            assistantMessage(
                sessionId,
                assistantId,
                userId,
                created + 1,
                random,
                sizes.get(pair) ?? 0,
            ),
        );
        json.push(user, assistant);
        totalChars += user.length + assistant.length;
    }
    return { sessionId, json, totalChars };
}

/** Append one user turn and its assistant reply, as an ordinary conversation step does. */
export function appendTurn(session: SessionFixture, random: () => number): void {
    const index = session.json.length;
    const tag = session.sessionId.slice(4);
    const userId = messageId(tag, index);
    const assistantId = messageId(tag, index + 1);
    const created = 1_760_000_000_000 + index * 500;
    const user = JSON.stringify(
        userMessage(session.sessionId, userId, created, codeText(random, 200)),
    );
    const assistant = JSON.stringify(
        assistantMessage(session.sessionId, assistantId, userId, created + 1, random, 0),
    );
    session.json.push(user, assistant);
    session.totalChars += user.length + assistant.length;
}

/** What OpenCode 1 hands the transform: freshly parsed objects every pass. */
export function loadMessages(session: SessionFixture): FixtureMessage[] {
    return session.json.map((text) => JSON.parse(text) as FixtureMessage);
}
