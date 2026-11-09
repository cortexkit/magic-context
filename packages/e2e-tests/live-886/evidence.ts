import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Composition } from "./composition";

export interface UsageRow {
    id: string;
    session_id: string;
    seq: number;
    data: string;
}

export interface Usage {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
}

export function usageOf(row: UsageRow): Usage {
    return JSON.parse(row.data).tokens;
}

export function readUsage(path: string): UsageRow[] {
    if (!existsSync(path)) return [];
    const db = new Database(path, { readonly: true });
    try {
        if (!db.query("SELECT name FROM sqlite_master WHERE name = 'session_message'").get()) return [];
        return db.query(`SELECT id, session_id, seq, data FROM session_message
            WHERE type = 'assistant' AND json_extract(data, '$.tokens') IS NOT NULL
            ORDER BY time_created, seq`).all() as UsageRow[];
    } finally {
        db.close();
    }
}

export function billed(usage: Usage): number {
    return usage.input + usage.cache.read + usage.cache.write;
}

export function cost(usage: Usage): number {
    // OpenCode normalizes input to cache misses. Reasoning is separate from output.
    return ((usage.input + usage.cache.write) * 0.15 + usage.cache.read * 0.003
        + (usage.output + usage.reasoning) * 0.60) / 1_000_000;
}

export function chatUsage(raw: Record<string, unknown>): Usage {
    const prompt = Number(raw.prompt_tokens);
    const output = Number(raw.completion_tokens);
    const details = raw.prompt_tokens_details as { cached_tokens?: number } | undefined;
    const completion = raw.completion_tokens_details as { reasoning_tokens?: number } | undefined;
    const cached = Number(raw.prompt_cache_hit_tokens ?? details?.cached_tokens ?? 0);
    const reasoning = Number(completion?.reasoning_tokens ?? 0);
    if (![prompt, output, cached, reasoning].every(Number.isFinite) || Math.min(prompt - cached, output - reasoning, cached, reasoning) < 0)
        throw new Error("Invalid/missing Chat Completions provider usage");
    return { input: prompt - cached, output: output - reasoning, reasoning, cache: { read: cached, write: 0 } };
}

export function csvCell(value: unknown): string {
    return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function telemetry(log: string) {
    const all = [...log.matchAll(/final-wire telemetry estimate=(\d+).*?conversation=(\d+) tools=(\d+) system=(\d+) toolDefinitions=(\d+)/g)];
    const last = all.at(-1);
    return last ? { estimate: Number(last[1]), conversation: Number(last[2]), tools: Number(last[3]),
        system: Number(last[4]), definitions: Number(last[5]) } : null;
}

export function toolOutputBytes(value: unknown): number {
    if (Array.isArray(value)) return value.reduce((sum, child) => sum + toolOutputBytes(child), 0);
    if (!value || typeof value !== "object") return 0;
    const object = value as Record<string, unknown>;
    if (object.role === "tool" || object.type === "tool-result") return Buffer.byteLength(JSON.stringify(object));
    if (object.type === "tool" && object.state) {
        const state = object.state as Record<string, unknown>;
        return Buffer.byteLength(JSON.stringify(state.content ?? state.output ?? ""));
    }
    return Object.values(object).reduce<number>((sum, child) => sum + toolOutputBytes(child), 0);
}

export interface Pass {
    number: number;
    sessionID: string;
    usageBefore: number;
    at: number;
    file: string;
    logFile: string;
    log: string;
    bytes: number;
    toolBytes: number;
    prefixRewrite: boolean;
    wireFile?: string;
    draft?: Record<string, unknown>;
    composition?: Composition;
}

export function writeEvidence(root: string, passes: Pass[], rows: UsageRow[], mainID: string,
    stopReason: string, metadata: Record<string, unknown>, redact: (text: string) => string) {
    const mainRows = rows.filter((row) => row.session_id === mainID);
    const mainPasses = passes.filter((pass) => pass.sessionID === mainID);
    const headers = ["step", "message_id", "session_id", "pass_time", "billed_input", "uncached_input",
        "cached_input", "cache_write", "output", "reasoning", "cost_usd", "over_250000", "wire_estimate",
        "estimate_to_billed", "tool_output_byte_share", "prefix_rewrite", "draft_file", "wire_file", "mc_log_file",
        "system_tokens", "tool_definition_tokens", "history_head_count", "history_head_tokens",
        "idless_instruction_count", "idless_instruction_tokens", "raw_tail_count", "raw_tail_tokens",
        "db_instruction_rows", "db_instruction_text_bytes", "db_instruction_tokens", "db_revision_rows",
        "db_codemode_rows", "db_mcp_guidance_rows", "served_codemode_count", "served_codemode_tokens",
        "served_mcp_guidance_count", "served_mcp_guidance_tokens", "db_snapshot", "mc_lines"];
    const lines = [headers.map(csvCell).join(",")];
    let input = 0;
    let cached = 0;
    let estimates = 0;
    let estimatedBilled = 0;
    let above = 0;
    let tools = 0;
    let bytes = 0;
    for (const [index, row] of mainRows.entries()) {
        const usage = usageOf(row);
        const total = billed(usage);
        const pass = mainPasses.find((candidate) => candidate.usageBefore === index && candidate.wireFile);
        const wire = pass ? telemetry(pass.log) : null;
        input += total;
        cached += usage.cache.read;
        if (wire) { estimates += wire.estimate; estimatedBilled += total; }
        if (total > 250000) above++;
        tools += pass?.toolBytes ?? 0;
        bytes += pass?.bytes ?? 0;
        lines.push([index + 1, row.id, row.session_id, pass ? new Date(pass.at).toISOString() : "",
            total, usage.input, usage.cache.read, usage.cache.write, usage.output, usage.reasoning,
            cost(usage), total > 250000, wire?.estimate, wire && total ? wire.estimate / total : "",
            pass?.bytes ? pass.toolBytes / pass.bytes : "", pass?.prefixRewrite, pass?.file,
            pass?.wireFile, pass?.logFile, ...Object.values(pass?.composition ?? {}), pass?.log].map(csvCell).join(","));
    }
    writeFileSync(join(root, "steps.csv"), redact(`${lines.join("\n")}\n`), { mode: 0o600 });
    const summary = {
        ...metadata, sessionID: mainID, stopReason, completedSteps: mainRows.length,
        authorizedMainPasses: metadata.authorizedHeadRequests,
        observedMainDrafts: mainPasses.length, stepsAboveThreshold: above,
        observedPrefixRewrites: mainRows.filter((_, index) => mainPasses.find((pass) => pass.usageBefore === index && pass.wireFile)?.prefixRewrite).length,
        cacheHitRate: input ? cached / input : null,
        estimateToBilledRatio: estimatedBilled ? estimates / estimatedBilled : null,
        toolOutputByteShare: bytes ? tools / bytes : null,
        totalEstimatedCostUSD: rows.reduce((sum, row) => sum + cost(usageOf(row)), 0) + Number(metadata.unpersistedProviderCostUSD ?? 0),
        usageRowsAllSessions: rows.length,
        maxInstructionRows: Math.max(0, ...mainPasses.map((pass) => pass.composition?.dbInstructionRows ?? 0)),
        maxInstructionRevisionRows: Math.max(0, ...mainPasses.map((pass) => pass.composition?.dbRevisionRows ?? 0)),
        maxServedInstructionRows: Math.max(0, ...mainPasses.map((pass) => pass.composition?.instructionCount ?? 0)),
        maxServedInstructionTokens: Math.max(0, ...mainPasses.map((pass) => pass.composition?.instructionTokens ?? 0)),
        maxHistoryHeadMessages: Math.max(0, ...mainPasses.map((pass) => pass.composition?.historyCount ?? 0)),
        maxDbCodemodeRows: Math.max(0, ...mainPasses.map((pass) => pass.composition?.dbCodemodeRows ?? 0)),
        maxDbMcpGuidanceRows: Math.max(0, ...mainPasses.map((pass) => pass.composition?.dbMcpGuidanceRows ?? 0)),
        maxServedCodemodeCount: Math.max(0, ...mainPasses.map((pass) => pass.composition?.servedCodemodeCount ?? 0)),
        maxServedMcpGuidanceCount: Math.max(0, ...mainPasses.map((pass) => pass.composition?.servedMcpGuidanceCount ?? 0)),
        compositionSteps: mainRows.filter((_, index) => mainPasses.some((pass) => pass.usageBefore === index && pass.composition)).length,
        unmatchedUsageRows: mainRows.filter((_, index) => !mainPasses.some((pass) => pass.usageBefore === index)).length,
    };
    writeFileSync(join(root, "usage.json"), redact(JSON.stringify(rows, null, 2)), { mode: 0o600 });
    writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
    writeFileSync(join(root, "summary.md"), `# Issue 886 live session\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n\n`
        + "CSV usage comes from OpenCode's stored assistant rows, including cache reads/writes. Cost includes all sessions, not just the head. "
        + "Prefix rewrites compare successive post-MC drafts (not a claim about provider cache eviction). Tool share is serialized UTF-8 bytes, not billed tokens. "
        + "Each pass's log file contains the preceding observation window, including interleaved historian logs; magic-context.log is the complete timeline. "
        + "Context snapshots are not provider HTTP request bodies. wire/*.json captures exact HTTP bodies through the native http.request hook, without headers.\n", { mode: 0o600 });
    return summary;
}
