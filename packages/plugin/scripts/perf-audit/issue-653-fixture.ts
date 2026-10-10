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
 * Where a session's bulk content sits. `text` is the original fixture (code-like
 * tool output). The others keep the same total size but move the bulk into the
 * shapes a real coding session also carries, to look for a cost that depends on
 * shape rather than size.
 */
export const SHAPES = [
    "text",
    "base64-text",
    "file-parts",
    "tiny-parts",
    "wide-json",
    "edit-args",
    "deep-json",
    "long-lines",
    "unicode",
    "reasoning",
    "metadata",
] as const;
export type Shape = (typeof SHAPES)[number];

function base64(random: () => number, chars: number): string {
    const bytes = Buffer.alloc(Math.ceil((chars * 3) / 4));
    for (let index = 0; index < bytes.length; index += 4) {
        bytes.writeUInt32LE(Math.floor(random() * 0x100000000), Math.min(index, bytes.length - 4));
    }
    return bytes.toString("base64").slice(0, chars);
}

const UNICODE_WORDS = ["日本語の文章", "Ünïcödé", "😀🚀✨", "Ελληνικά", "русский текст", "中文字符", "🧪🔧"];

function unicodeText(random: () => number, chars: number): string {
    const pieces: string[] = [];
    let length = 0;
    while (length < chars) {
        const word = UNICODE_WORDS[Math.floor(random() * UNICODE_WORDS.length)] as string;
        pieces.push(word, random() < 0.1 ? "\n" : " ");
        length += word.length + 1;
    }
    return pieces.join("");
}

function letters(random: () => number, chars: number): string {
    // One line of letters with no spaces, digits or newlines.
    const block = Array.from({ length: 4096 }, () =>
        String.fromCharCode(97 + Math.floor(random() * 26)),
    ).join("");
    return block.repeat(Math.ceil(chars / block.length)).slice(0, chars);
}

/** Put `chars` characters of bulk into the turn in the given shape. */
function addBulk(
    shape: Shape,
    user: FixtureMessage,
    assistant: FixtureMessage,
    random: () => number,
    chars: number,
): void {
    const id = assistant.info.id as string;
    const sessionID = assistant.info.sessionID;
    const created = (assistant.info.time as { created: number }).created;
    const toolPart = (state: Record<string, unknown>, tool = "read") => ({
        id: `${id}_p2`,
        sessionID,
        messageID: id,
        type: "tool",
        callID: `call_${id}`,
        tool,
        state: {
            status: "completed",
            title: `src/file-${id}.ts`,
            time: { start: created + 6, end: created + 30 },
            ...state,
        },
    });
    const at = assistant.parts.length - 1;
    const insert = (...parts: Array<Record<string, unknown>>) => assistant.parts.splice(at, 0, ...parts);
    switch (shape) {
        case "text":
            insert(
                toolPart({
                    input: { filePath: `/repo/src/file-${id}.ts` },
                    output: codeText(random, chars),
                    metadata: { preview: codeText(random, 400), truncated: false },
                }),
            );
            return;
        case "base64-text":
            insert(
                toolPart({
                    input: { url: "https://example.test/shot.png" },
                    output: `![screenshot](data:image/png;base64,${base64(random, chars)})`,
                    metadata: {},
                }),
            );
            return;
        case "file-parts":
            user.parts.push({
                id: `${user.info.id}_f1`,
                sessionID,
                messageID: user.info.id,
                type: "file",
                mime: "image/png",
                filename: "screenshot.png",
                url: `data:image/png;base64,${base64(random, chars)}`,
            });
            return;
        case "tiny-parts": {
            const count = Math.max(1, Math.floor(chars / 110));
            for (let index = 0; index < count; index += 1) {
                insert({
                    id: `${id}_t${index}`,
                    sessionID,
                    messageID: id,
                    type: "text",
                    text: `chunk ${index} ${random().toString(36).slice(2, 12)}`,
                });
            }
            return;
        }
        case "wide-json": {
            const input: Record<string, string> = {};
            for (let index = 0; index < Math.floor(chars / 40); index += 1) {
                input[`key_${index}_${random().toString(36).slice(2, 8)}`] = `value ${index}`;
            }
            insert(toolPart({ input, output: "ok", metadata: {} }, "batch"));
            return;
        }
        case "edit-args":
            insert(
                toolPart(
                    {
                        input: {
                            filePath: `/repo/src/file-${id}.ts`,
                            oldString: codeText(random, chars / 2),
                            newString: codeText(random, chars / 2),
                        },
                        output: "Edit applied successfully.",
                        metadata: { diagnostics: {} },
                    },
                    "edit",
                ),
            );
            return;
        case "deep-json": {
            // A chain 2,000 objects deep with the bulk at the bottom.
            let node: Record<string, unknown> = { body: codeText(random, chars) };
            for (let depth = 0; depth < 2_000; depth += 1) node = { child: node, depth };
            insert(toolPart({ input: node, output: "ok", metadata: {} }, "mcp"));
            return;
        }
        case "long-lines":
            insert(
                toolPart({
                    input: { filePath: `/repo/dist/bundle-${id}.min.js` },
                    output: letters(random, chars),
                    metadata: {},
                }),
            );
            return;
        case "unicode":
            insert(
                toolPart({
                    input: { filePath: `/repo/docs/${id}.md` },
                    output: unicodeText(random, chars),
                    metadata: {},
                }),
            );
            return;
        case "reasoning":
            insert({
                id: `${id}_r1`,
                sessionID,
                messageID: id,
                type: "reasoning",
                text: codeText(random, chars / 2),
                metadata: { anthropic: { signature: base64(random, chars / 2) } },
                time: { start: created, end: created + 5 },
            });
            return;
        case "metadata": {
            const third = Math.floor(chars / 3);
            insert(
                toolPart(
                    {
                        input: { filePath: `/repo/src/file-${id}.ts`, content: "x" },
                        output: "Wrote file successfully.",
                        metadata: {
                            diff: codeText(random, third),
                            filediff: {
                                file: `/repo/src/file-${id}.ts`,
                                before: codeText(random, third),
                                after: codeText(random, third),
                                additions: 10,
                                deletions: 2,
                            },
                            diagnostics: {
                                [`/repo/src/file-${id}.ts`]: Array.from({ length: 200 }, (_, line) => ({
                                    range: { start: { line, character: 0 }, end: { line, character: 5 } },
                                    message: "unused variable",
                                    severity: 2,
                                })),
                            },
                        },
                    },
                    "write",
                ),
            );
            return;
        }
    }
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
    shape: Shape = "text",
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
        const userValue = userMessage(
            sessionId,
            userId,
            created,
            codeText(random, 80 + random() * 400),
        );
        const assistantValue = assistantMessage(
            sessionId,
            assistantId,
            userId,
            created + 1,
            random,
            0,
        );
        const bulk = sizes.get(pair);
        if (bulk) {
            addBulk(shape, userValue, assistantValue, random, bulk);
            (assistantValue.parts.at(-1) as { reason: string }).reason = "tool-calls";
        }
        const user = JSON.stringify(userValue);
        const assistant = JSON.stringify(assistantValue);
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
