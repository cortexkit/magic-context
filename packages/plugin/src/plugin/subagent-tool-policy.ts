import type { ToolDefinition } from "@opencode-ai/plugin";
import { getOrCreateSessionMeta } from "../features/magic-context/storage";
import type { Database } from "../shared/sqlite";
import { hidesMemoryTools } from "./subagent-policy";

const PRIMARY_ONLY_TOOLS = new Set(["ctx_memory", "ctx_note"]);

/** OC1's task tool turns primary_tools into child-session permission denies. */
export function primaryOnlyToolIds(existing: readonly string[] = []): string[] {
    return [...new Set([...existing, ...PRIMARY_ONLY_TOOLS])];
}

/** Use the transform's persisted mode, not an agent name that a caller can change. */
export function subagentToolRefusal(
    db: Database,
    toolId: string,
    sessionId: string,
    isInternalChild: (sessionId: string) => boolean = () => false,
): string | undefined {
    if (
        PRIMARY_ONLY_TOOLS.has(toolId) &&
        !isInternalChild(sessionId) &&
        hidesMemoryTools(storedSubagentMode(db, sessionId) ?? getOrCreateSessionMeta(db, sessionId).isSubagent)
    ) {
        return `Error: ${toolId} is unavailable in subagent sessions. Use the primary session instead.`;
    }
    return undefined;
}

/** Protect reduced sessions not created through task, without changing definitions. */
export function guardSubagentTools(
    tools: Record<string, ToolDefinition>,
    db: Database,
    isInternalChild?: (sessionId: string) => boolean,
): Record<string, ToolDefinition> {
    return Object.fromEntries(
        Object.entries(tools).map(([id, definition]) => [
            id,
            PRIMARY_ONLY_TOOLS.has(id)
                ? {
                      ...definition,
                      async execute(args, context) {
                          const refusal = subagentToolRefusal(
                              db,
                              id,
                              context.sessionID,
                              isInternalChild,
                          );
                          return refusal ?? definition.execute(args, context);
                      },
                  }
                : definition,
        ]),
    );
}

/** OC2 hands each request its own tool map; never mutate global registrations. */
export function hideSubagentTools(
    draft: { sessionID: string; tools: Record<string, unknown> },
    db: Database,
): void {
    const stored =
        storedSubagentMode(db, draft.sessionID) ??
        getOrCreateSessionMeta(db, draft.sessionID).isSubagent;
    if (!hidesMemoryTools(stored)) return;
    removePrimaryOnlyTools(draft.tools);
}

/** Remove the tools a subagent session may not call from one request's tool map. */
export function removePrimaryOnlyTools(tools: Record<string, unknown>): void {
    for (const id of PRIMARY_ONLY_TOOLS) delete tools[id];
}

/**
 * Whether the session's stored metadata already records it as a subagent,
 * read without writing anything (a busy database can still be read). Undefined
 * when the row is missing or does not record it yet; the next healthy pass
 * then works it out and stores it.
 */
export function storedSubagentMode(db: Database, sessionId: string): boolean | undefined {
    const row = db
        .prepare("SELECT is_subagent FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { is_subagent: number | null } | null | undefined;
    if (!row || typeof row.is_subagent !== "number") return undefined;
    return row.is_subagent === 1;
}
