/**
 * Pi-side wrapper for the `ctx_reduce` tool.
 *
 * Mirrors OpenCode's `packages/plugin/src/tools/ctx-reduce/tools.ts`.
 * The agent uses this tool to mark tag IDs (`§N§`) as "drop" — those
 * tags get removed from the live message array on the next execute pass
 * (via `applyPendingOperations` in the runPipeline). Used to keep
 * historian noise out of the working context window without paying for
 * a full historian round.
 *
 * Only registered when `magic_context.ctx_reduce_enabled === true`. When
 * the flag is false, the prompt guidance also drops all `ctx_reduce`
 * mentions, so the agent never sees the tool name or the §N§ syntax.
 */

import { parseRangeString } from "@magic-context/core/features/magic-context/range-parser";
import {
	type ContextDatabase,
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getErrorMessage } from "@magic-context/core/shared/error-message";
import { CTX_REDUCE_DESCRIPTION } from "@magic-context/core/tools/ctx-reduce/constants";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";

const ParamsSchema = Type.Object({
	drop: Type.Optional(
		Type.String({
			description: "Tag IDs to drop entirely. Ranges: '3-5', '1,2,9'",
		}),
	),
});

type CtxReduceParams = Static<typeof ParamsSchema>;

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

function formatIds(ids: number[]): string {
	return ids.map((id) => `§${id}§`).join(", ");
}

export interface CtxReduceToolDeps {
	db: ContextDatabase;
	protectedTags: number;
	/** Optional callback to read live session input tokens; falls back to
	 *  `getOrCreateSessionMeta(...).lastInputTokens`. Mirrors OpenCode's
	 *  `getSessionTokens` deps field. */
	getSessionTokens?: (sessionId: string) => number;
}

export function createCtxReduceTool(
	deps: CtxReduceToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	return {
		name: "ctx_reduce",
		label: "Magic Context: Reduce",
		description: CTX_REDUCE_DESCRIPTION,
		parameters: ParamsSchema,
		async execute(
			_toolCallId,
			params: CtxReduceParams,
			_signal,
			_onUpdate,
			ctx,
		) {
			const sessionId = ctx.sessionManager.getSessionId();

			if (!params.drop) {
				return err("Error: 'drop' must be provided.");
			}

			let dropIds: number[] = [];
			try {
				dropIds = parseRangeString(params.drop);
			} catch (e) {
				return err(`Error: Invalid range syntax. ${(e as Error).message}`);
			}

			const allIds = [...new Set(dropIds)];

			const allTags = getTagsBySession(deps.db, sessionId);
			const foundSet = new Set(allTags.map((tag) => tag.tagNumber));
			const unknownIds = allIds.filter((id) => !foundSet.has(id));
			if (unknownIds.length > 0) {
				return err(
					`Error: Unknown tag(s) ${formatIds(unknownIds)}. Check available tags in conversation.`,
				);
			}

			const activeTags = allTags.filter((tag) => tag.status === "active");
			const protectedTagIds = activeTags
				.map((tag) => tag.tagNumber)
				.sort((left, right) => right - left)
				.slice(0, deps.protectedTags);
			const protectedSet = new Set(protectedTagIds);

			const tagStatusMap = new Map(
				allTags.map((tag) => [tag.tagNumber, tag.status]),
			);

			const pendingOps = getPendingOps(deps.db, sessionId);
			const pendingMap = new Map(
				pendingOps.map((op) => [op.tagId, op.operation]),
			);

			// Reject drops on compaction-survivor tags. Mirrors OpenCode's
			// `tagStatusMap.get(id) === "compacted"` guard — those tags are
			// the synthesized survivors of an OpenCode compaction marker and
			// can't be dropped without confusing downstream readers.
			const conflicts: string[] = [];
			for (const id of dropIds) {
				if (tagStatusMap.get(id) === "compacted") {
					conflicts.push(`§${id}§ is from before compaction`);
				}
			}
			if (conflicts.length > 0) {
				return err(`Error: Conflicting operations — ${conflicts.join("; ")}.`);
			}

			const preFilterDropCount = dropIds.length;
			dropIds = dropIds.filter(
				(id) =>
					tagStatusMap.get(id) !== "dropped" && pendingMap.get(id) !== "drop",
			);
			const skippedCount = preFilterDropCount - dropIds.length;

			if (dropIds.length === 0) {
				return ok(
					"All requested tags were already queued or processed. No new action is needed.",
				);
			}

			try {
				deps.db.transaction(() => {
					const now = Date.now();
					for (const id of dropIds) {
						queuePendingOp(deps.db, sessionId, id, "drop", now);
					}
				})();
			} catch (error) {
				return err(
					`Error: Failed to queue ctx_reduce operations. ${getErrorMessage(error)}`,
				);
			}

			const currentInputTokens =
				deps.getSessionTokens?.(sessionId) ??
				getOrCreateSessionMeta(deps.db, sessionId).lastInputTokens;
			updateSessionMeta(deps.db, sessionId, {
				lastNudgeTokens: currentInputTokens,
			});

			const immediateDropIds = dropIds.filter((id) => !protectedSet.has(id));
			const deferredDropIds = [
				...new Set(dropIds.filter((id) => protectedSet.has(id))),
			];
			const skippedNote =
				skippedCount > 0
					? ` ${skippedCount} requested tag${skippedCount === 1 ? " was" : "s were"} already queued and need no action.`
					: "";
			const parts: string[] = [];
			if (immediateDropIds.length > 0)
				parts.push(`drop ${formatIds(immediateDropIds)}`);
			if (deferredDropIds.length > 0)
				parts.push(`deferred drop ${formatIds(deferredDropIds)}`);
			return ok(`Queued: ${parts.join(", ")}.${skippedNote}`);
		},
	};
}
