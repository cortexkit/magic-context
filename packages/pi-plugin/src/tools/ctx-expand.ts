/**
 * Pi-side wrapper for the `ctx_expand` tool.
 *
 * Mirrors OpenCode's `packages/plugin/src/tools/ctx-expand/tools.ts`:
 * given a `<compartment start="N" end="M">` range, return the original
 * compacted U:/A: transcript so the agent can see the raw discussion
 * behind a summarized region.
 *
 * Implementation: shared `readSessionChunk` reads via the per-session
 * `RawMessageProvider` registry. We register Pi's `readPiSessionMessages`
 * for the duration of this single tool call (and unregister in `finally`)
 * so we never accidentally leak the provider into other transform passes
 * which might race against this call.
 *
 * Token budget mirrors OpenCode's `CTX_EXPAND_TOKEN_BUDGET = 15_000` —
 * shared constant imported from the OpenCode tool's constants module so
 * both harnesses produce equivalent slices for the same range.
 */

import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	readSessionChunk,
	setRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import {
	CTX_EXPAND_DESCRIPTION,
	CTX_EXPAND_TOKEN_BUDGET,
} from "@magic-context/core/tools/ctx-expand/constants";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";
import { readPiSessionMessages } from "../read-session-pi";

const ParamsSchema = Type.Object({
	start: Type.Number({
		description: "Start message ordinal (from compartment start attribute)",
	}),
	end: Type.Number({
		description: "End message ordinal (from compartment end attribute)",
	}),
});

type CtxExpandParams = Static<typeof ParamsSchema>;

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function err(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
		isError: true,
	};
}

export interface CtxExpandToolDeps {
	db: ContextDatabase;
}

export function createCtxExpandTool(
	_deps: CtxExpandToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	return {
		name: "ctx_expand",
		label: "Magic Context: Expand",
		description: CTX_EXPAND_DESCRIPTION,
		parameters: ParamsSchema,
		async execute(
			_toolCallId,
			params: CtxExpandParams,
			_signal,
			_onUpdate,
			ctx,
		) {
			if (
				typeof params.start !== "number" ||
				typeof params.end !== "number" ||
				params.start < 1 ||
				params.end < params.start
			) {
				return err(
					"Error: start and end must be positive integers with start <= end.",
				);
			}

			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) {
				return err("Error: no active Pi session.");
			}

			// Register the Pi raw-message provider for THIS sessionId
			// for the duration of the single readSessionChunk call.
			// `setRawMessageProvider` returns an unregister function so
			// we don't leak the binding into the transform pipeline's
			// concurrent passes.
			const unregister = setRawMessageProvider(sessionId, {
				readMessages: () => readPiSessionMessages(ctx),
			});

			try {
				const chunk = readSessionChunk(
					sessionId,
					CTX_EXPAND_TOKEN_BUDGET,
					params.start,
					params.end + 1, // readSessionChunk uses exclusive end
				);

				if (!chunk.text || chunk.messageCount === 0) {
					return ok(
						`No messages found in range ${params.start}-${params.end}. The range may be outside this session's history.`,
					);
				}

				const lines: string[] = [];
				lines.push(
					`Messages ${chunk.startIndex}-${chunk.endIndex} (${chunk.messageCount} messages, ~${chunk.tokenEstimate} tokens):`,
				);
				lines.push("");
				lines.push(chunk.text);

				if (chunk.endIndex < params.end) {
					lines.push("");
					lines.push(
						`Truncated at message ${chunk.endIndex} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${chunk.endIndex + 1} end=${params.end} for more.`,
					);
				}

				return ok(lines.join("\n"));
			} finally {
				unregister();
			}
		},
	};
}
