import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { readSessionChunk } from "../../hooks/magic-context/read-session-chunk";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import { CTX_EXPAND_DESCRIPTION, CTX_EXPAND_TOKEN_BUDGET } from "./constants";
import { renderMessageByOrdinal, renderVerboseRange } from "./render";
import type { CtxExpandArgs } from "./types";

export { CTX_EXPAND_LIGHT_DESCRIPTION } from "../light-descriptions";

export interface CtxExpandToolDeps {
    db: ContextDatabase;
}

const ctxExpandArgsShape = {
    start: tool.schema
        .number()
        .optional()
        .describe(
            'First message ordinal to expand — a compartment\'s start="N" attribute, or an ordinal from a ctx_search message hit',
        ),
    end: tool.schema
        .number()
        .optional()
        .describe(
            'Last message ordinal to expand (inclusive) — a compartment\'s end="M" attribute',
        ),
    verbose: tool.schema
        .boolean()
        .optional()
        .describe(
            "With start/end: list each message separately with its ordinal [N] and per-part preview (each tool call shown with its output size), so you can pick one to recover in full by ordinal.",
        ),
    message: tool.schema
        .number()
        .optional()
        .describe(
            "Full untruncated recovery of ONE message by its ordinal (every text part + every tool call's complete input/output). Use an ordinal from a compartment, ctx_search hit, or verbose range. Recovers a tool output you dropped with ctx_reduce.",
        ),
};
// The tool definition exposes only the documented argument shape to the model
// provider, but older callers may still send extra arguments. Parse with
// passthrough so execute() can receive those fields without advertising them.
const ctxExpandArgsSchema = tool.schema.object(ctxExpandArgsShape).passthrough();

function createCtxExpandTool(deps: CtxExpandToolDeps): ToolDefinition {
    return tool({
        description: CTX_EXPAND_DESCRIPTION,
        args: ctxExpandArgsShape,
        async execute(rawArgs: CtxExpandArgs, toolContext) {
            const parsedArgs = ctxExpandArgsSchema.safeParse(rawArgs);
            let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxExpandArgs;
            args = unwrapImitatedReducedArgs(args, ["message", "start"], {
                start: "number",
                end: "number",
                verbose: "boolean",
                message: "number",
            });
            const sessionId = toolContext.sessionID;

            // By-ordinal mode: full recovery of a single message from stored history.
            if (args.message !== undefined) {
                if (
                    typeof args.message !== "number" ||
                    !Number.isInteger(args.message) ||
                    args.message < 1
                ) {
                    return "Error: message must be a positive integer.";
                }
                return renderMessageByOrdinal(sessionId, args.message);
            }

            if (
                !args.start ||
                !args.end ||
                !Number.isInteger(args.start) ||
                !Number.isInteger(args.end) ||
                args.start < 1 ||
                args.end < args.start
            ) {
                return "Error: provide either message=<ordinal>, or start and end (positive integers, start <= end).";
            }

            // Clamp the range to the last compartment boundary, mirroring
            // ctx_search: anything after that boundary is the live tail the
            // agent already sees in context, so re-reading it just burns output
            // tokens and duplicates visible content. -1 means "no compartments
            // yet" → nothing is compacted, so don't clamp.
            const lastCompartmentEnd = getLastCompartmentEndMessage(deps.db, sessionId);
            if (lastCompartmentEnd >= 0 && args.start > lastCompartmentEnd) {
                return `Range ${args.start}-${args.end} is entirely within the live tail (after the last compacted message ${lastCompartmentEnd}); those messages are already visible in context.`;
            }
            const effectiveEnd =
                lastCompartmentEnd >= 0 ? Math.min(args.end, lastCompartmentEnd) : args.end;

            // Verbose mode: each message separate, with ids + per-part previews.
            if (args.verbose === true) {
                const v = renderVerboseRange(
                    sessionId,
                    args.start,
                    effectiveEnd,
                    CTX_EXPAND_TOKEN_BUDGET,
                );
                if (!v.text) {
                    return `No messages found in range ${args.start}-${effectiveEnd}. The range may be outside this session's history.`;
                }
                const out = [
                    `Messages ${args.start}-${v.lastOrdinal} (verbose). Recover any one in full with ctx_expand(message=<ordinal>):`,
                    "",
                    v.text,
                ];
                if (v.truncated) {
                    out.push(
                        "",
                        `Truncated at message ${v.lastOrdinal} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${v.lastOrdinal + 1} end=${effectiveEnd} verbose=true for more.`,
                    );
                }
                return out.join("\n");
            }

            const chunk = readSessionChunk(
                sessionId,
                CTX_EXPAND_TOKEN_BUDGET,
                args.start,
                effectiveEnd + 1, // readSessionChunk uses exclusive end
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

            if (chunk.endIndex < effectiveEnd) {
                lines.push("");
                lines.push(
                    `Truncated at message ${chunk.endIndex} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${chunk.endIndex + 1} end=${effectiveEnd} for more.`,
                );
            }

            return lines.join("\n");
        },
    });
}

export function createCtxExpandTools(deps: CtxExpandToolDeps): Record<string, ToolDefinition> {
    return {
        ctx_expand: createCtxExpandTool(deps),
    };
}
