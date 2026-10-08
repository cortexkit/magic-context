/** Independent request variants, all derived from the same completed conversation. */
export interface Block {
    type: string;
    [key: string]: unknown;
}
export interface Message {
    role: "user" | "assistant";
    content: Block[];
}
export interface ThinkingRequest {
    messages: Message[];
    [key: string]: unknown;
}

export const MIN_SIGNED_BLOCKS = 4;
export const MIN_COMPLETED_TURNS = 2;
export const MAX_SEED_TURNS = 8;
export const THINKING_MAX_TOKENS = 1152;

export const isThinking = (block: Block) => block.type === "thinking" || block.type === "redacted_thinking";
export const isSigned = (block: Block) => isThinking(block) &&
    ((typeof block.signature === "string" && block.signature.length > 0) ||
        (typeof block.data === "string" && block.data.length > 0));

export function signedBlockCount(request: ThinkingRequest): number {
    return request.messages.flatMap((m) => m.content).filter(isSigned).length;
}

export function shouldSeedTurn(signedBlocks: number, completedTurns: number, turn: number): boolean {
    return turn <= MAX_SEED_TURNS && (signedBlocks < MIN_SIGNED_BLOCKS || completedTurns < MIN_COMPLETED_TURNS);
}

export function shouldRetryRefusal(stopReason: string, retryUsed: boolean): boolean {
    return stopReason === "refusal" && !retryUsed;
}

export function seedThinkingConfig() {
    return {
        type: "adaptive",
        block_binding: { prefix_mismatch_behavior: "error" },
    };
}

export function buildSeedRequest(model: string, systemPrefix: string): ThinkingRequest {
    return {
        model,
        max_tokens: THINKING_MAX_TOKENS,
        stream: false,
        thinking: seedThinkingConfig(),
        output_config: { effort: "high" },
        system: [{ type: "text", text: systemPrefix }],
        tools: [{
            name: "record_note",
            description: "Record a short note exactly as provided.",
            input_schema: {
                type: "object",
                properties: { note: { type: "string" } },
                required: ["note"],
                additionalProperties: false,
            },
        }],
        messages: [],
    };
}

export type SeedPromptKind = "tool" | "tool-retry" | "final" | "final-retry";

export function seedPrompt(turn: number, kind: SeedPromptKind): string {
    switch (kind) {
        case "tool": return `Calculate this harmless three-step arithmetic result: add ${11 + turn} and ${turn + 4}, double the sum, then subtract ${turn}. Use record_note once to store the final decimal result.`;
        case "tool-retry": return `For a different harmless arithmetic check, multiply ${turn + 3} by 5 and subtract ${turn + 1}; use record_note once to store the final decimal result.`;
        case "final": return "Reply with exactly OK. Do not use a tool.";
        case "final-retry": return "This is a harmless check; reply with only the word OK.";
    }
}

export function replaceLastUserText(request: ThinkingRequest, text: string): void {
    const last = request.messages.at(-1);
    if (!last || last.role !== "user") throw new Error("Seed retry needs a trailing user message");
    const block = [...last.content].reverse().find((item) => item.type === "text");
    if (!block) throw new Error("Seed retry needs a trailing user text block");
    block.text = text;
}

export function restoreFirstSignedBlock(seed: ThinkingRequest, history: ThinkingRequest): ThinkingRequest {
    const location = seed.messages.flatMap((message, messageIndex) =>
        message.content.map((block, blockIndex) => ({ messageIndex, blockIndex, block })))
        .find(({ block }) => isSigned(block));
    if (!location) throw new Error("Seed has no signed thinking block to restore");

    const restored = structuredClone(history);
    const message = restored.messages[location.messageIndex];
    if (!message) throw new Error("History no longer contains the seed message");
    if (message.content.some((block) => isSigned(block) &&
        ((typeof location.block.signature === "string" && block.signature === location.block.signature) ||
            (typeof location.block.data === "string" && block.data === location.block.data)))) {
        throw new Error("The first signed thinking block is already present");
    }
    message.content.splice(location.blockIndex, 0, structuredClone(location.block));
    return restored;
}

export function requireSignedHistory(request: ThinkingRequest): void {
    const count = signedBlockCount(request);
    if (count < MIN_SIGNED_BLOCKS) throw new Error(`Need at least ${MIN_SIGNED_BLOCKS} signed thinking blocks; got ${count}`);
    const toolResults = request.messages.flatMap((message) => message.content).filter((block) => block.type === "tool_result").length;
    if (toolResults < MIN_COMPLETED_TURNS) {
        throw new Error(`Need at least ${MIN_COMPLETED_TURNS} completed tool rounds; got ${toolResults} tool results`);
    }
}

export function thinkingVariants(request: ThinkingRequest): Array<{ variant: string; expected: string; request: ThinkingRequest }> {
    requireSignedHistory(request);
    const signedMessages = request.messages.flatMap((m, i) => m.content.filter(isSigned).map(() => i));
    const toolIndex = request.messages.findIndex((m) => m.content.some((b) => b.type === "tool_result"));
    const toolUseIndex = request.messages.findIndex((m) => m.content.some((b) => b.type === "tool_use"));
    const variants: Array<{ variant: string; expected: string; request: ThinkingRequest }> = [];
    const add = (variant: string, expected: string, change: (copy: ThinkingRequest) => void) => {
        const copy = structuredClone(request);
        change(copy);
        variants.push({ variant, expected, request: copy });
    };
    const strip = (copy: ThinkingRequest, remove: (ordinal: number, messageIndex: number) => boolean) => {
        let ordinal = 0;
        copy.messages.forEach((m, i) => {
            m.content = m.content.filter((b) => !isSigned(b) || !remove(ordinal++, i));
        });
    };
    add("control", "200", () => {});
    add("oldest-1", "200 (#23609)", (c) => strip(c, (n) => n === 0));
    add("oldest-2", "200 (#23609)", (c) => strip(c, (n) => n < 2));
    add("middle-kept", "400/signature error (#23609)", (c) => strip(c, (n) => n === 1));
    add("middle-suffix-stripped", "200 (#23609)", (c) => strip(c, (n) => n >= 1));
    add("all-stripped", "200 (#23609)", (c) => strip(c, () => true));
    const editToolResult = (c: ThinkingRequest) => {
        const block = c.messages[toolIndex]!.content.find((b) => b.type === "tool_result")!;
        block.content = "edited earlier record note result";
    };
    add("tool-result-edit-kept", "400/signature error (#23609)", editToolResult);
    add("tool-result-edit-suffix-stripped", "200 (#23609)", (c) => {
        editToolResult(c);
        strip(c, (_, i) => i > toolIndex);
    });
    const editToolInput = (c: ThinkingRequest) => {
        const block = c.messages[toolUseIndex]!.content.find((b) => b.type === "tool_use")!;
        const input = block.input;
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("First tool use needs an object input");
        block.input = { ...input, note: "edited earlier record note input" };
    };
    add("tool-input-edit-kept", "400/signature error (#23609)", editToolInput);
    add("tool-input-edit-suffix-stripped", "200 (#23609)", (c) => {
        editToolInput(c);
        strip(c, (_, i) => i > toolUseIndex);
    });
    const editFirst = (c: ThinkingRequest) => {
        const block = c.messages[0]!.content.find((b) => b.type === "text");
        if (!block) throw new Error("First user message needs a text block");
        block.text = `${block.text}\nRendered context marker: m0 -> m1.`;
    };
    add("first-user-edit-kept", "400/signature error (#23609)", editFirst);
    add("first-user-edit-suffix-stripped", "200 (#23609)", (c) => {
        editFirst(c);
        strip(c, () => true);
    });
    add("cleared-text", "400 (Anthropic analogue of #22050)", (c) => {
        const block = c.messages[signedMessages[0]!]!.content.find((b) => b.type === "thinking" && isSigned(b));
        if (!block) throw new Error("Need a text thinking block for [cleared]");
        block.thinking = "[cleared]";
    });
    return variants;
}

/** Preserve recorded history verbatim; only transport caps and strict binding differ. */
export function prepareRecordedSeed(request: ThinkingRequest, model: string): ThinkingRequest {
    if (request.model !== model) throw new Error("Recorded seed model does not match the selected model");
    if (!Array.isArray(request.messages) || request.messages.some((message) =>
        !["user", "assistant"].includes(message.role) || !Array.isArray(message.content))) {
        throw new Error("Recorded seed needs native Messages content arrays");
    }
    const locations = request.messages.flatMap((message, i) =>
        message.role === "assistant" ? message.content.filter(isSigned).map(() => i) : []);
    if (locations.length < 6 || new Set(locations).size < 3) {
        throw new Error("Recorded seed needs six signed blocks across at least three assistant messages");
    }
    requireSignedHistory(request);
    if (!request.messages.some((message, i) => i >= locations[0]! && i < locations.at(-1)! &&
        message.content.some((block) => block.type === "tool_use"))) {
        throw new Error("Recorded seed needs tool calls between signed assistant messages");
    }
    const thinking = request.thinking as Record<string, unknown> | undefined;
    const outputConfig = request.output_config as Record<string, unknown> | undefined;
    if (thinking?.type !== "adaptive" || typeof outputConfig?.effort !== "string") {
        throw new Error("Recorded 5.5 seed must already use adaptive thinking and output_config.effort");
    }
    const copy = structuredClone(request);
    copy.max_tokens = 64;
    copy.stream = false;
    copy.thinking = { ...thinking, block_binding: { prefix_mismatch_behavior: "error" } };
    return copy;
}

export function recordedThinkingVariants(request: ThinkingRequest) {
    const all = thinkingVariants(request);
    return ["control", "oldest-1", "middle-suffix-stripped", "all-stripped", "middle-kept",
        "tool-result-edit-kept", "first-user-edit-kept", "cleared-text"]
        .map((name) => all.find((row) => row.variant === name)!);
}

export interface RecordedReply {
    status: number;
    accepted: boolean;
    content: Block[] | null;
    error: string | null;
}

export interface RecordedCell {
    variant: string;
    expected: string;
    status: number | null;
    accepted: boolean | null;
    note?: string;
}

export const isQuotaError = (status: number, error: string | null) => status === 429 ||
    /quota|rate_limit_error|exceed[^\n]*rate limit|usage limit|credit balance|billing_error/i.test(error ?? "");

/** Nine cells maximum, reusing only the prefix-trim response for the restore probe. */
export async function runRecordedCells(request: ThinkingRequest,
    send: (variant: string, request: ThinkingRequest) => Promise<RecordedReply>): Promise<{
        cells: RecordedCell[]; calls: number; reason: string | null; completed: boolean;
    }> {
    const cells: RecordedCell[] = [];
    let prefix: { request: ThinkingRequest; reply: RecordedReply } | undefined;
    let reason: string | null = null;
    let calls = 0;
    const probe = async (variant: string, expected: string, body: ThinkingRequest) => {
        if (calls >= 9) throw new Error("Recorded matrix exhausted its nine-request model cap");
        calls++;
        const reply = await send(variant, body);
        cells.push({ variant, expected, status: reply.status, accepted: reply.accepted });
        if (isQuotaError(reply.status, reply.error) || [401, 403].includes(reply.status) || reply.status >= 500) {
            reason = `${variant}: provider interruption (HTTP ${reply.status})`;
        } else if (variant === "control" && !reply.accepted) {
            reason = "Unchanged control rejected; variants would be inconclusive";
        }
        return reply;
    };
    for (const row of recordedThinkingVariants(request)) {
        if (row.variant === "tool-result-edit-kept") {
            const expected = "400/signature error after restoring a removed prefix (#23609)";
            if (prefix?.reply.accepted && prefix.reply.content?.some(isSigned)) {
                const history = structuredClone(prefix.request);
                const content = prefix.reply.content;
                history.messages.push({ role: "assistant", content });
                // No recorded tool is executed. Close any newly generated tool calls locally.
                const results = content.filter((block) => block.type === "tool_use").map((block) =>
                    ({ type: "tool_result", tool_use_id: block.id, content: "Tool not executed by the signature-validation harness.", is_error: true }));
                history.messages.push({ role: "user", content: [...results, { type: "text", text: "Reply OK." }] });
                await probe("restore-removed-prefix", expected, restoreFirstSignedBlock(request, history));
                if (reason) break;
            } else {
                cells.push({ variant: "restore-removed-prefix", expected, status: null, accepted: null,
                    note: "Not reached: prefix-trim response contained no signed block generated while the prefix was absent" });
            }
        }
        const reply = await probe(row.variant, row.expected, row.request);
        if (reason) break;
        if (row.variant === "oldest-1") prefix = { request: row.request, reply };
    }
    return { cells, calls, reason, completed: !reason && cells.length === 9 && cells.every((cell) => cell.status !== null) };
}
