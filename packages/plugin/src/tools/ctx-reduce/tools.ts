import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { parseRangeString } from "../../features/magic-context/range-parser";
import {
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { getErrorMessage } from "../../shared/error-message";
import type { Database } from "../../shared/sqlite";
import { CTX_REDUCE_DESCRIPTION } from "./constants";
import type { CtxReduceArgs } from "./types";

export interface CtxReduceToolDeps {
    db: Database;
    protectedTags: number;
    getSessionTokens?: (sessionId: string) => number;
}

function createCtxReduceTool(deps: CtxReduceToolDeps): ToolDefinition {
    return tool({
        description: CTX_REDUCE_DESCRIPTION,
        args: {
            drop: tool.schema
                .string()
                .optional()
                .describe("Tag IDs to drop entirely. Ranges: '3-5', '1,2,9'"),
        },
        async execute(args: CtxReduceArgs, toolContext) {
            const sessionId = toolContext.sessionID;

            if (!args.drop) {
                return "Error: 'drop' must be provided.";
            }

            let dropIds: number[] = [];

            try {
                dropIds = parseRangeString(args.drop);
            } catch (e) {
                return `Error: Invalid range syntax. ${(e as Error).message}`;
            }

            const allIds = [...new Set(dropIds)];

            const allTags = getTagsBySession(deps.db, sessionId);
            const foundSet = new Set(allTags.map((tag) => tag.tagNumber));
            const unknownIds = allIds.filter((id) => !foundSet.has(id));
            if (unknownIds.length > 0) {
                return `Error: Unknown tag(s) ${formatIds(unknownIds)}. Check available tags in conversation.`;
            }

            const activeTags = allTags.filter((tag) => tag.status === "active");
            const protectedTagIds = activeTags
                .map((tag) => tag.tagNumber)
                .sort((left, right) => right - left)
                .slice(0, deps.protectedTags);
            const protectedSet = new Set(protectedTagIds);

            const tagStatusMap = new Map(allTags.map((tag) => [tag.tagNumber, tag.status]));

            const pendingOps = getPendingOps(deps.db, sessionId);
            const pendingMap = new Map(pendingOps.map((op) => [op.tagId, op.operation]));

            const conflicts: string[] = [];
            for (const id of dropIds) {
                if (tagStatusMap.get(id) === "compacted") {
                    conflicts.push(`§${id}§ is from before compaction`);
                }
            }
            if (conflicts.length > 0) {
                return `Error: Conflicting operations — ${conflicts.join("; ")}.`;
            }

            const preFilterDropCount = dropIds.length;
            dropIds = dropIds.filter(
                (id) => tagStatusMap.get(id) !== "dropped" && pendingMap.get(id) !== "drop",
            );
            const skippedCount = preFilterDropCount - dropIds.length;

            if (dropIds.length === 0) {
                return "All requested tags were already queued or processed. No new action is needed.";
            }

            try {
                deps.db.transaction(() => {
                    const now = Date.now();
                    for (const id of dropIds) {
                        queuePendingOp(deps.db, sessionId, id, "drop", now);
                    }
                })();
            } catch (error) {
                const errorMessage = getErrorMessage(error);
                return `Error: Failed to queue ctx_reduce operations. ${errorMessage}`;
            }

            const currentInputTokens =
                deps.getSessionTokens?.(sessionId) ??
                getOrCreateSessionMeta(deps.db, sessionId).lastInputTokens;
            updateSessionMeta(deps.db, sessionId, { lastNudgeTokens: currentInputTokens });

            const immediateDropIds = dropIds.filter((id) => !protectedSet.has(id));
            const deferredDropIds = [...new Set(dropIds.filter((id) => protectedSet.has(id)))];
            const skippedNote =
                skippedCount > 0
                    ? ` ${skippedCount} requested tag${skippedCount === 1 ? " was" : "s were"} already queued and need no action.`
                    : "";
            const parts: string[] = [];
            if (immediateDropIds.length > 0) parts.push(`drop ${formatIds(immediateDropIds)}`);
            if (deferredDropIds.length > 0)
                parts.push(`deferred drop ${formatIds(deferredDropIds)}`);
            return `Queued: ${parts.join(", ")}.${skippedNote}`;
        },
    });
}

function formatIds(ids: number[]): string {
    return ids.map((id) => `§${id}§`).join(", ");
}

export function createCtxReduceTools(deps: CtxReduceToolDeps): Record<string, ToolDefinition> {
    return {
        ctx_reduce: createCtxReduceTool(deps),
    };
}
