import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    prepareRawSessionOrdinals,
    rawMessageWorkerSource,
    readSessionChunk,
} from "../../hooks/magic-context/read-session-chunk";
import type { ToolExpansionMap } from "../../shared/historian-tool-template";
import { getSqliteDatabasePath } from "../../shared/sqlite";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import { CTX_EXPAND_DESCRIPTION, CTX_EXPAND_TOKEN_BUDGET } from "./constants";
import { resolveCtxExpandMode } from "./mode";
import {
    type RecoveryAttachments,
    renderItemByTag,
    renderMessageByOrdinal,
    renderVerboseRangeForTool,
} from "./render";
import { renderSearchArchiveOffThread } from "./search-archive";
import type { CtxExpandArgs } from "./types";
import { readV2ArchiveOffThread } from "./v2-archive-reader";

export { CTX_EXPAND_LIGHT_DESCRIPTION } from "../light-descriptions";

export interface CtxExpandToolDeps {
    db: ContextDatabase;
    expandTools?: ToolExpansionMap;
    recoveryAttachments?: RecoveryAttachments;
    /**
     * The resolved transform mode of this plugin process. In Rust mode the ck-mc
     * module numbers the §N§ tags the agent sees, in its own store (`store.db`),
     * and the TypeScript tagger never runs. The `tags` table in `context.db` then
     * holds only rows from before the session moved to Rust mode, whose numbers
     * overlap the module's, so a tag lookup there would return an unrelated old
     * item. Tag lookup is refused in Rust mode for that reason.
     */
    transformMode?: "ts" | "rust";
}

/** Reply for `ctx_expand(tag=N)` when the tag numbers belong to the Rust module. */
export const CTX_EXPAND_RUST_TAG_REFUSAL =
    "Tag lookup isn't available on this session: its §N§ tags are numbered by the Rust transform engine and ctx_expand cannot resolve those numbers, so no content was returned. Expand by message instead: ctx_expand(message=<ordinal>) or ctx_expand(start=<ordinal>, end=<ordinal>), using ordinals from a <session-history> heading or a ctx_search hit.";

const ctxExpandArgsShape = {
    tag: tool.schema
        .union([tool.schema.number(), tool.schema.string()])
        .optional()
        .describe(
            "Tag number from a §N§ tag or a [dropped §N§] placeholder, not a message ordinal. Returns that one item in full. Use alone.",
        ),
    start: tool.schema
        .number()
        .optional()
        .describe(
            "First message ordinal of the range (a <session-history> heading's start, or a ctx_search hit), not a tag number.",
        ),
    end: tool.schema
        .number()
        .optional()
        .describe("Last message ordinal of the range, inclusive, not a tag number."),
    verbose: tool.schema
        .boolean()
        .optional()
        .describe(
            "With start/end: one entry per message with ordinal and per-part preview instead of the transcript.",
        ),
    message: tool.schema
        .number()
        .optional()
        .describe(
            "Message ordinal from a <session-history> heading or a ctx_search hit, not a tag number. Returns that one message in full. Use alone.",
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
            args = unwrapImitatedReducedArgs(args, ["tag", "message", "start"], {
                start: "number",
                end: "number",
                verbose: "boolean",
                message: "number",
            });
            const sessionId = toolContext.sessionID;
            const mode = resolveCtxExpandMode(args, "positive");
            // Refuse before touching history: no host read can make a module-numbered
            // tag resolvable, so warming ordinals for it would only delay the refusal.
            if (mode.kind === "tag" && deps.transformMode === "rust") {
                return CTX_EXPAND_RUST_TAG_REFUSAL;
            }
            if (!(await prepareRawSessionOrdinals(sessionId)))
                return "Session ordinals are warming in the background. Retry ctx_expand shortly; no approximate ordinal was served.";
            if (mode.kind === "error") {
                return mode.message;
            }
            const source = rawMessageWorkerSource(sessionId);
            const path = getSqliteDatabasePath(deps.db);
            if (mode.kind === "tag") {
                if (source) {
                    if (!path)
                        throw new Error(
                            "Search archive worker unavailable: private archive has no off-thread source",
                        );
                    const text = await readV2ArchiveOffThread(path, source.path, sessionId, {
                        kind: "tag",
                        tag: mode.tag,
                    });
                    if (text === null)
                        throw new Error("Search archive worker unavailable: unexpected tag reply");
                    return text;
                }
                return renderItemByTag(
                    deps.db,
                    sessionId,
                    mode.tag,
                    "part",
                    deps.recoveryAttachments,
                );
            }
            if (mode.kind === "message") {
                if (source) {
                    if (!path)
                        throw new Error(
                            "Search archive worker unavailable: private archive has no off-thread source",
                        );
                    const text = await readV2ArchiveOffThread(path, source.path, sessionId, {
                        kind: "message",
                        message: mode.message,
                        tokenBudget: CTX_EXPAND_TOKEN_BUDGET,
                    });
                    if (text === null)
                        throw new Error(
                            "Search archive worker unavailable: unexpected message reply",
                        );
                    return text;
                }
                return (
                    (await renderSearchArchiveOffThread(
                        deps.db,
                        sessionId,
                        mode.message,
                        mode.message,
                        CTX_EXPAND_TOKEN_BUDGET,
                    )) ?? renderMessageByOrdinal(sessionId, mode.message, deps.recoveryAttachments)
                );
            }
            const { start, end, verbose } = mode;

            // Clamp the range to the last compartment boundary, mirroring
            // ctx_search: anything after that boundary is the live tail the
            // agent already sees in context, so re-reading it just burns output
            // tokens and duplicates visible content. -1 means "no compartments
            // yet" → nothing is compacted, so don't clamp.
            const lastCompartmentEnd = getLastCompartmentEndMessage(deps.db, sessionId);
            if (lastCompartmentEnd >= 0 && start > lastCompartmentEnd) {
                return `Range ${start}-${end} is entirely within the live tail (after the last compacted message ${lastCompartmentEnd}); those messages are already visible in context.`;
            }
            const effectiveEnd = lastCompartmentEnd >= 0 ? Math.min(end, lastCompartmentEnd) : end;
            if (verbose && source) {
                if (!path)
                    throw new Error(
                        "Search archive worker unavailable: private archive has no off-thread source",
                    );
                const text = await readV2ArchiveOffThread(path, source.path, sessionId, {
                    kind: "verbose",
                    start,
                    end: effectiveEnd,
                    tokenBudget: CTX_EXPAND_TOKEN_BUDGET,
                    expandTools: deps.expandTools,
                });
                if (text === null)
                    throw new Error("Search archive worker unavailable: unexpected verbose reply");
                return text;
            }
            const archived = await renderSearchArchiveOffThread(
                deps.db,
                sessionId,
                start,
                effectiveEnd,
                CTX_EXPAND_TOKEN_BUDGET,
            );
            if (archived) return archived;

            // Verbose mode: each message separate, with ids + per-part previews.
            if (verbose) {
                return renderVerboseRangeForTool(
                    sessionId,
                    start,
                    effectiveEnd,
                    CTX_EXPAND_TOKEN_BUDGET,
                    deps.expandTools,
                    deps.recoveryAttachments,
                );
            }

            const chunk = readSessionChunk(
                sessionId,
                CTX_EXPAND_TOKEN_BUDGET,
                start,
                effectiveEnd + 1, // readSessionChunk uses exclusive end
                { expand: false },
            );

            if (!chunk.text || chunk.messageCount === 0) {
                return `No messages found in range ${start}-${end}. The range may be outside this session's history.`;
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
