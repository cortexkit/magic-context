import { Database } from "bun:sqlite";

export function textOf(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(textOf).join("\n");
    if (!value || typeof value !== "object") return "";
    const object = value as Record<string, unknown>;
    return textOf(object.text ?? object.content ?? "");
}

export interface Composition {
    systemTokens: number;
    definitionTokens: number;
    historyCount: number;
    historyTokens: number;
    instructionCount: number;
    instructionTokens: number;
    rawCount: number;
    rawTokens: number;
    dbInstructionRows: number;
    dbInstructionBytes: number;
    dbInstructionTokens: number;
    dbRevisionRows: number;
    dbCodemodeRows: number;
    dbMcpGuidanceRows: number;
    servedCodemodeCount: number;
    servedCodemodeTokens: number;
    servedMcpGuidanceCount: number;
    servedMcpGuidanceTokens: number;
    dbSnapshot: string;
}

export function instructionRows(path: string, sessionID: string) {
    const db = new Database(path, { readonly: true });
    try {
        return db.query("SELECT id, seq, type, data FROM session_message WHERE session_id = ? AND type = 'system' ORDER BY seq")
            .all(sessionID) as Array<{ id: string; seq: number; type: string; data: string }>;
    } finally { db.close(); }
}

export function instructionSchema(path: string) {
    const db = new Database(path, { readonly: true });
    try {
        return { table: db.query("SELECT sql FROM sqlite_master WHERE name = 'session_message'").get(),
            types: db.query("SELECT type, COUNT(*) AS count FROM session_message GROUP BY type").all() };
    } finally { db.close(); }
}

/** Count provider-visible text with the same estimateTokens function used by
 * final-wire telemetry. Buckets omit protocol framing and calibration multipliers. */
export function composition(body: Record<string, unknown>, draft: Record<string, unknown>,
    rows: ReturnType<typeof instructionRows>, count: (text: string) => number): Composition {
    const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
    const native = (draft.messages ?? []) as Array<Record<string, unknown>>;
    const instructions = native.filter((message) => message.role === "system" && !message.id).map((message) => textOf(message.content));
    const result: Composition = { systemTokens: 0, definitionTokens: count(JSON.stringify(body.tools ?? [])),
        historyCount: 0, historyTokens: 0, instructionCount: 0, instructionTokens: 0,
        rawCount: 0, rawTokens: 0, dbInstructionRows: rows.length, dbInstructionBytes: 0,
        dbInstructionTokens: 0, dbRevisionRows: 0, dbCodemodeRows: 0, dbMcpGuidanceRows: 0,
        servedCodemodeCount: 0, servedCodemodeTokens: 0, servedMcpGuidanceCount: 0, servedMcpGuidanceTokens: 0, dbSnapshot: "" };
    const stored = rows.map((row) => JSON.parse(row.data) as { text: string; metadata?: { instructionSources?: string[] } });
    const attributeInstruction = (text: string, tokens: number) => {
        const sources = stored.filter((row) => text.includes(row.text.trim())).flatMap((row) => row.metadata?.instructionSources ?? []);
        if (sources.includes("core/codemode")) { result.servedCodemodeCount++; result.servedCodemodeTokens += tokens; }
        if (sources.includes("core/mcp-guidance")) { result.servedMcpGuidanceCount++; result.servedMcpGuidanceTokens += tokens; }
    };
    const remaining = [...instructions];
    for (const [messageIndex, message] of messages.entries()) {
        let text = textOf(message.content);
        const tools = message.tool_calls ? JSON.stringify(message.tool_calls) : "";
        // OC2's DeepSeek driver wraps id-less system rows in <system-update>
        // and may merge them with an adjacent user/history message on the wire.
        text = text.replace(/<system-update>[\s\S]*?<\/system-update>/g, (block) => {
            const index = remaining.findIndex((instruction) => block.includes(instruction.trim()));
            if (index < 0) return block;
            remaining.splice(index, 1);
            result.instructionCount++;
            result.instructionTokens += count(block);
            attributeInstruction(block, count(block));
            return "";
        });
        if (message.role === "system" || message.role === "developer") {
            for (let index = remaining.length - 1; index >= 0; index--) {
                const instruction = remaining[index]!;
                if (instruction && text.includes(instruction)) {
                    result.instructionCount++;
                    result.instructionTokens += count(instruction);
                    attributeInstruction(instruction, count(instruction));
                    text = text.replace(instruction, "");
                    remaining.splice(index, 1);
                }
            }
            result.systemTokens += count(text);
        } else if (messageIndex < 4 && message.role === "user" && /<session-history(?:-since)?>|<project-memory>|<conversation-checkpoint>/.test(text)) {
            result.historyCount++;
            result.historyTokens += count(text);
        } else if (text.trim() || tools) {
            result.rawCount++;
            result.rawTokens += count(text) + count(tools);
        }
    }
    for (const row of rows) {
        const text = textOf(JSON.parse(row.data));
        result.dbInstructionBytes += Buffer.byteLength(text);
        result.dbInstructionTokens += count(text);
        if (row.data.includes("Issue886 instruction revision")) result.dbRevisionRows++;
        const sources = JSON.parse(row.data).metadata?.instructionSources ?? [];
        if (sources.includes("core/codemode")) result.dbCodemodeRows++;
        if (sources.includes("core/mcp-guidance")) result.dbMcpGuidanceRows++;
    }
    return result;
}
