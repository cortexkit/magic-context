import {
    RETROSPECTIVE_MAX_USER_MESSAGE_CHARS,
    RETROSPECTIVE_MESSAGE_TRUNCATION_MARKER,
    type RetrospectiveProjectSession,
    type RetrospectiveRawMessage,
    type RetrospectiveRawProvider,
    type RetrospectiveSinceRead,
} from "../features/magic-context/dreamer/retrospective-raw-provider";
import { cleanUserText } from "../hooks/magic-context/read-session-chunk";
import { hasMeaningfulUserText } from "../hooks/magic-context/read-session-formatting";
import { dreamIncludesChildren } from "../plugin/subagent-policy";
import { getDataDir } from "../shared/data-path";
import type { Database } from "../shared/sqlite";
import { gaDatabasePath, V2StoreReader } from "./store-reader";

/** Uses only native OC2 projections, never converted legacy message/part rows.
 * Like Pi, emits user-only history: private assistant text and tool output from
 * other sessions are not retrospective input. The shared scan bounds sessions,
 * messages and prompt tokens; the reader also bounds text before hydration. */
export class V2RetrospectiveRawProvider implements RetrospectiveRawProvider {
    private reader?: V2StoreReader;
    constructor(
        private readonly contextDb: Database,
        private readonly openReader = () =>
            new V2StoreReader(
                gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
            ),
    ) {}

    private store(): V2StoreReader {
        return (this.reader ??= this.openReader());
    }

    listProjectSessions(projectIdentity: string): RetrospectiveProjectSession[] {
        const subagentFilter = dreamIncludesChildren() ? "" : "AND COALESCE(m.is_subagent, 0) = 0";
        const sessions = this.contextDb
            .prepare<[string], { session_id: string }>(`
            SELECT sp.session_id FROM session_projects sp
            LEFT JOIN session_meta m ON m.session_id = sp.session_id
            WHERE sp.project_path = ? AND sp.harness = 'opencode2'
                ${subagentFilter}
            ORDER BY sp.session_id`)
            .all(projectIdentity);
        const roots = this.store().rootSessionActivity(sessions.map((row) => row.session_id));
        return sessions
            .filter((row) => roots.has(row.session_id))
            .map((row) => ({ sessionId: row.session_id, updatedAt: roots.get(row.session_id) }));
    }

    readOldestMessageTimesSince(
        sessionIds: readonly string[],
        sinceMs: number,
    ): Map<string, number> {
        return this.store().oldestUserMessageTimesSince(sessionIds, sinceMs);
    }

    private read(
        sessionId: string,
        boundaryMs: number,
        limit: number,
        before = false,
    ): RetrospectiveRawMessage[] {
        return this.store()
            .retrospectiveUserPage(sessionId, {
                boundaryMs,
                before,
                limit,
                maxChars: RETROSPECTIVE_MAX_USER_MESSAGE_CHARS,
                truncationMarker: RETROSPECTIVE_MESSAGE_TRUNCATION_MARKER,
            })
            .map((row) => ({
                sessionId,
                ordinal: row.seq,
                role: "user" as const,
                text: cleanUserText(row.text),
                ts: row.time_created,
                ...(row.follows_assistant_reply === 1 ? { followsAssistantReply: true } : {}),
            }));
    }

    readUserMessagesSince(
        sessionId: string,
        sinceMs: number,
        capPerSession: number,
    ): RetrospectiveSinceRead {
        const cap = Math.max(1, Math.min(9999, Math.floor(capPerSession)));
        const rows = this.read(sessionId, sinceMs, cap + 1);
        // Keep empty rows until the shared scan computes its frontier. Dropping
        // them here could lose the timestamp of a saturated read's last row.
        return { messages: rows.slice(0, cap), truncated: rows.length > cap };
    }

    readUserMessagesBefore(
        sessionId: string,
        beforeMs: number,
        count: number,
    ): RetrospectiveRawMessage[] {
        return this.read(sessionId, beforeMs, Math.max(1, Math.min(10000, Math.floor(count))), true)
            .reverse()
            .filter((row) => hasMeaningfulUserText([{ type: "text", text: row.text }]));
    }

    dispose(): void {
        this.reader?.close();
        this.reader = undefined;
    }
}
