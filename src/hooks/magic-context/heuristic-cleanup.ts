import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    getTagsBySession,
    replaceSourceContent,
    updateTagStatus,
} from "../../features/magic-context/storage";
import type { TagEntry } from "../../features/magic-context/types";
import { log } from "../../shared";
import { stripSystemInjection } from "./system-injection-stripper";
import type { MessageLike, TagTarget } from "./tag-messages";
import { stripTagPrefix } from "./tag-part-guards";

const DEDUP_SAFE_TOOLS = new Set([
    "mcp_grep",
    "mcp_read",
    "mcp_glob",
    "mcp_ast_grep_search",
    "mcp_lsp_diagnostics",
    "mcp_lsp_symbols",
    "mcp_lsp_find_references",
    "mcp_lsp_goto_definition",
    "mcp_lsp_prepare_rename",
]);

export function applyHeuristicCleanup(
    sessionId: string,
    db: ContextDatabase,
    targets: Map<number, TagTarget>,
    messageTagNumbers: Map<MessageLike, number>,
    config: { autoDropToolAge: number; protectedTags: number; dropAllTools?: boolean },
    preloadedTags?: TagEntry[],
): { droppedTools: number; deduplicatedTools: number; droppedInjections: number } {
    const tags = preloadedTags ?? getTagsBySession(db, sessionId);
    const maxTag = tags.reduce((max, t) => Math.max(max, t.tagNumber), 0);
    const toolAgeCutoff = maxTag - config.autoDropToolAge;
    const protectedCutoff = maxTag - config.protectedTags;

    let droppedTools = 0;
    let deduplicatedTools = 0;
    let droppedInjections = 0;

    db.transaction(() => {
        for (const tag of tags) {
            if (tag.status !== "active") continue;
            if (tag.tagNumber > protectedCutoff) continue;

            const shouldDropTool =
                tag.type === "tool" &&
                (config.dropAllTools === true || tag.tagNumber <= toolAgeCutoff);
            if (shouldDropTool) {
                const target = targets.get(tag.tagNumber);
                const dropResult = target?.drop?.() ?? "absent";
                if (dropResult === "removed" || dropResult === "absent") {
                    updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
                    droppedTools++;
                }
            }
        }
    })();

    db.transaction(() => {
        // Strip or drop system injections (todo continuation, skill reminders, etc.)
        for (const tag of tags) {
            if (tag.status !== "active") continue;
            if (tag.tagNumber > protectedCutoff) continue;
            if (tag.type !== "message") continue;

            const target = targets.get(tag.tagNumber);
            if (!target) continue;

            const content = target.getContent?.();
            if (!content) continue;

            const stripped = stripSystemInjection(content);
            if (stripped === null) continue;
            const strippedSource = stripTagPrefix(stripped);

            if (strippedSource.trim().length === 0) {
                const dropResult = target.drop?.() ?? "absent";
                const didReplace =
                    dropResult === "absent"
                        ? target.setContent(`[dropped §${tag.tagNumber}§]`)
                        : false;
                if (dropResult === "removed" || dropResult === "absent") {
                    replaceSourceContent(db, sessionId, tag.tagNumber, "");
                    updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
                    if (dropResult === "removed" || didReplace) {
                        droppedInjections++;
                    }
                }
            } else {
                const didSet = target.setContent(stripped);
                if (didSet) {
                    replaceSourceContent(db, sessionId, tag.tagNumber, strippedSource);
                    droppedInjections++;
                }
            }
        }
    })();

    // Deduplication: auto-drop older identical tool calls (same tool + same params)
    const allMessages = Array.from(messageTagNumbers.keys());
    const toolFingerprints = buildToolFingerprints(allMessages);
    if (toolFingerprints.size > 0) {
        const tagsByMessageId = new Map<string, TagEntry>();
        for (const tag of tags) {
            if (tag.type === "tool" && tag.status === "active" && tag.messageId) {
                tagsByMessageId.set(tag.messageId, tag);
            }
        }

        // Group tags by fingerprint
        const fingerprintGroups = new Map<string, TagEntry[]>();
        for (const [messageId, fingerprint] of toolFingerprints) {
            const tag = tagsByMessageId.get(messageId);
            if (!tag || tag.tagNumber > protectedCutoff) continue;
            const group = fingerprintGroups.get(fingerprint) ?? [];
            group.push(tag);
            fingerprintGroups.set(fingerprint, group);
        }

        // For each group with duplicates, drop all but the newest
        db.transaction(() => {
            for (const [, group] of fingerprintGroups) {
                if (group.length <= 1) continue;
                group.sort((a, b) => a.tagNumber - b.tagNumber);
                // Keep the newest (last), drop the rest
                for (let i = 0; i < group.length - 1; i++) {
                    const tag = group[i];
                    const target = targets.get(tag.tagNumber);
                    target?.drop?.();
                    updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
                    deduplicatedTools++;
                }
            }
        })();
    }

    if (droppedTools > 0 || deduplicatedTools > 0 || droppedInjections > 0) {
        log(
            `[magic-context] heuristic cleanup: dropped ${droppedTools} tool tags, deduplicated ${deduplicatedTools} tool calls, dropped ${droppedInjections} system injections`,
        );
    }

    return { droppedTools, deduplicatedTools, droppedInjections };
}

function extractToolInfo(
    part: Record<string, unknown>,
): { toolName: string; args: unknown } | null {
    // OpenCode format: { type: "tool", state: { tool: "name", input: {...} } }
    if (part.type === "tool" && typeof part.state === "object" && part.state !== null) {
        const state = part.state as Record<string, unknown>;
        if (typeof state.tool === "string" && DEDUP_SAFE_TOOLS.has(state.tool)) {
            return { toolName: state.tool, args: state.input ?? {} };
        }
    }
    // Tool-invocation format: { type: "tool-invocation", toolName: "name", args: {...} }
    if (
        part.type === "tool-invocation" &&
        typeof part.toolName === "string" &&
        DEDUP_SAFE_TOOLS.has(part.toolName)
    ) {
        return { toolName: part.toolName, args: part.args ?? {} };
    }
    // Tool-use format: { type: "tool_use", name: "name", input: {...} }
    if (
        part.type === "tool_use" &&
        typeof part.name === "string" &&
        DEDUP_SAFE_TOOLS.has(part.name)
    ) {
        return { toolName: part.name, args: part.input ?? {} };
    }
    return null;
}

function buildToolFingerprints(messages: MessageLike[]): Map<string, string> {
    const fingerprints = new Map<string, string>();
    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        for (const part of message.parts) {
            const record = part as Record<string, unknown>;
            const info = extractToolInfo(record);
            if (!info) continue;
            // Use callId (matches tool tag messageId in DB), not message.info.id
            const callId = extractCallId(record);
            if (!callId) continue;
            try {
                const fingerprint = `${info.toolName}:${JSON.stringify(info.args)}`;
                fingerprints.set(callId, fingerprint);
            } catch {
                // Skip if args can't be stringified
            }
        }
    }
    return fingerprints;
}

function extractCallId(part: Record<string, unknown>): string | null {
    // OpenCode format: { type: "tool", callID: "call_xxx" }
    if (part.type === "tool" && typeof part.callID === "string") return part.callID;
    // tool-invocation format: { type: "tool-invocation", callID: "call_xxx" }
    if (part.type === "tool-invocation" && typeof part.callID === "string") return part.callID;
    // tool_use format: { type: "tool_use", id: "call_xxx" }
    if (part.type === "tool_use" && typeof part.id === "string") return part.id;
    return null;
}
