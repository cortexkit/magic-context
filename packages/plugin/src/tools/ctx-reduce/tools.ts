import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import type { ProtectionWindowResult } from "../../features/magic-context/protection-window";
import { parseRangeString } from "../../features/magic-context/range-parser";
import {
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsByNumbers,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { getInertWhitespaceAssistantTagsByNumbers } from "../../features/magic-context/storage-tags";
import { isLegacyForeignTextTag } from "../../hooks/magic-context/foreign-text-parts";
import { getErrorMessage } from "../../shared/error-message";
import type { Database } from "../../shared/sqlite";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import { CTX_REDUCE_DESCRIPTION, formatCtxReduceReply } from "./constants";
import type { CtxReduceArgs } from "./types";

export { CTX_REDUCE_LIGHT_DESCRIPTION } from "../light-descriptions";

export interface CtxReduceToolDeps {
    db: Database;
    /**
     * Tag numbers protected by the current token window. An empty set means no
     * results are held by that window; per-tool keep counts still hold queued
     * drops until newer calls displace the result and a rebuilding pass applies them.
     */
    protectedSet?: ReadonlySet<number> | ((sessionId: string) => ReadonlySet<number>);
    protectedTools?: Readonly<Record<string, number>>;
    getProtectionWindow?: (sessionId: string) => ProtectionWindowResult;
    floor?: number;
    getSessionTokens?: (sessionId: string) => number;
}

const ctxReduceArgsShape = {
    drop: tool.schema
        .string()
        .optional()
        .describe('Tag IDs to drop: "3-5", "1,2,9", "1-5,8,12-15".'),
};
// The tool definition exposes only the documented argument shape to the model
// provider, but older callers may still send extra arguments. Parse with
// passthrough so execute() can receive those fields without advertising them.
const ctxReduceArgsSchema = tool.schema.object(ctxReduceArgsShape).passthrough();

function createCtxReduceTool(deps: CtxReduceToolDeps): ToolDefinition {
    return tool({
        description: CTX_REDUCE_DESCRIPTION,
        args: ctxReduceArgsShape,
        async execute(rawArgs: CtxReduceArgs, toolContext) {
            const parsedArgs = ctxReduceArgsSchema.safeParse(rawArgs);
            let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxReduceArgs;
            args = unwrapImitatedReducedArgs(args, ["drop"], { drop: "string" });
            const sessionId = toolContext.sessionID;

            if (!args.drop) {
                return `Error: 'drop' must be provided as a string of tag numbers, for example {"drop": "3-5,8"}.`;
            }

            let dropIds: number[] = [];

            try {
                dropIds = parseRangeString(args.drop);
            } catch (e) {
                return `Error: Invalid range syntax. ${(e as Error).message}`;
            }

            const allIds = [...new Set(dropIds)];

            const allTags = getTagsByNumbers(deps.db, sessionId, allIds);
            const foundSet = new Set(allTags.map((tag) => tag.tagNumber));
            const unknownIds = allIds.filter((id) => !foundSet.has(id));
            if (unknownIds.length > 0) {
                return `Error: Unknown tag(s) ${formatIds(unknownIds)}. Check available tags in conversation.`;
            }

            const ctxReduceSelfStampIds = new Set(
                allTags
                    .filter((tag) => tag.toolName?.toLowerCase() === "ctx_reduce")
                    .map((tag) => tag.tagNumber),
            );
            const ctxReduceSelfStampCount = new Set(
                dropIds.filter((id) => ctxReduceSelfStampIds.has(id)),
            ).size;
            dropIds = dropIds.filter((id) => !ctxReduceSelfStampIds.has(id));

            const tagStatusMap = new Map(allTags.map((tag) => [tag.tagNumber, tag.status]));
            // Only membership of the requested tags is consulted below, so look
            // up just those instead of every inert tag in the session.
            const inertWhitespaceTagNumbers = new Set(
                getInertWhitespaceAssistantTagsByNumbers(deps.db, sessionId, dropIds).map(
                    (tag) => tag.tagNumber,
                ),
            );
            // A tag an older release put on another plugin's text part (OpenCode 1)
            // can't reclaim anything: that text belongs to the other plugin, and a
            // new drop on it is never applied. Skip it per id like provider
            // framing; never fail the call.
            const foreignTextTagNumbers = new Set(
                dropIds.filter((id) => isLegacyForeignTextTag(sessionId, id)),
            );
            const skippedTagNumbers = new Set([
                ...inertWhitespaceTagNumbers,
                ...foreignTextTagNumbers,
            ]);
            const skippedDropIds = [...new Set(dropIds.filter((id) => skippedTagNumbers.has(id)))];
            const inertNote =
                skippedDropIds.length > 0
                    ? `Skipped: ${skippedDropIds
                          .map((id) =>
                              inertWhitespaceTagNumbers.has(id)
                                  ? `§${id}§ is provider framing, nothing to reclaim`
                                  : `§${id}§ is another plugin's text, nothing to reclaim`,
                          )
                          .join("; ")}.`
                    : "";

            const pendingOps = getPendingOps(deps.db, sessionId);
            const pendingMap = new Map(pendingOps.map((op) => [op.tagId, op.operation]));

            const conflicts: string[] = [];
            for (const id of dropIds) {
                if (tagStatusMap.get(id) === "compacted" && !skippedTagNumbers.has(id)) {
                    conflicts.push(`§${id}§ is from before compaction`);
                }
            }
            if (conflicts.length > 0) {
                return `Error: Conflicting operations — ${conflicts.join("; ")}.`;
            }

            const stampedCount = new Set(dropIds.filter((id) => !skippedTagNumbers.has(id))).size;
            dropIds = dropIds.filter(
                (id) =>
                    !skippedTagNumbers.has(id) &&
                    tagStatusMap.get(id) !== "dropped" &&
                    pendingMap.get(id) !== "drop",
            );
            if (dropIds.length === 0) {
                const reply = formatCtxReduceReply(stampedCount, ctxReduceSelfStampCount);
                if (reply) return `${reply}${inertNote ? ` ${inertNote}` : ""}`;
                if (inertNote) return inertNote;
                return "All requested tags were already queued or processed. No new action is needed.";
            }

            try {
                deps.db
                    .transaction(() => {
                        const now = Date.now();
                        for (const id of dropIds) {
                            queuePendingOp(deps.db, sessionId, id, "drop", now);
                        }
                    })
                    .immediate();
            } catch (error) {
                const errorMessage = getErrorMessage(error);
                return `Error: Failed to queue ctx_reduce operations. ${errorMessage}`;
            }

            const currentInputTokens =
                deps.getSessionTokens?.(sessionId) ??
                getOrCreateSessionMeta(deps.db, sessionId).lastInputTokens;
            updateSessionMeta(deps.db, sessionId, { lastNudgeTokens: currentInputTokens });

            const reply = formatCtxReduceReply(stampedCount, ctxReduceSelfStampCount);
            return `${reply}${inertNote ? ` ${inertNote}` : ""}`;
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
