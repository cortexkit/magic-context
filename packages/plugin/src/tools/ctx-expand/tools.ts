import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { readSessionChunk } from "../../hooks/magic-context/read-session-chunk";
import { CTX_EXPAND_DESCRIPTION, CTX_EXPAND_TOKEN_BUDGET } from "./constants";
import type { CtxExpandArgs } from "./types";

function createCtxExpandTool(): ToolDefinition {
    return tool({
        description: CTX_EXPAND_DESCRIPTION,
        args: {
            start: tool.schema
                .number()
                .describe("Start message ordinal (from compartment start attribute)"),
            end: tool.schema
                .number()
                .describe("End message ordinal (from compartment end attribute)"),
        },
        async execute(args: CtxExpandArgs, toolContext) {
            const sessionId = toolContext.sessionID;

            if (!args.start || !args.end || args.start < 1 || args.end < args.start) {
                return "Error: start and end must be positive integers with start <= end.";
            }

            const chunk = readSessionChunk(
                sessionId,
                CTX_EXPAND_TOKEN_BUDGET,
                args.start,
                args.end + 1, // readSessionChunk uses exclusive end
            );

            if (!chunk.text || chunk.messageCount === 0) {
                return `No messages found in range ${args.start}-${args.end}. The range may be outside this session's history.`;
            }

            const lines: string[] = [];
            lines.push(
                `Messages ${chunk.startIndex}-${chunk.endIndex} (${chunk.messageCount} messages, ~${chunk.tokenEstimate} tokens):`,
            );
            lines.push("");
            lines.push(chunk.text);

            if (chunk.endIndex < args.end) {
                lines.push("");
                lines.push(
                    `Truncated at message ${chunk.endIndex} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${chunk.endIndex + 1} end=${args.end} for more.`,
                );
            }

            return lines.join("\n");
        },
    });
}

export function createCtxExpandTools(): Record<string, ToolDefinition> {
    return {
        ctx_expand: createCtxExpandTool(),
    };
}
