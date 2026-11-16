// Oh My Pi tells an extension which agent a session runs: `ctx.agent.kind` is
// "main" for a top-level session and "sub" for any session another agent
// spawned (task children, eval agents, and clones of a session). A spawned session runs in
// the parent's process with its own extension instance and session id, so
// without this record Magic Context would treat it as a primary session and
// give it a history head with the project's docs and memories, a summarizer
// and the primary-only nudges. Pi has no such field and no built-in child
// sessions; its sessions are left as they are.

import {
	type ContextDatabase,
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { BoundedSessionMap } from "@magic-context/core/shared/bounded-session-map";
import { sessionLog } from "@magic-context/core/shared/logger";

/** Sessions whose first event this process has already checked. */
const checkedSessions = new BoundedSessionMap<true>(1000);

function readAgentKind(ctx: unknown): unknown {
	try {
		return (ctx as { agent?: { kind?: unknown } } | null)?.agent?.kind;
	} catch {
		return undefined;
	}
}

/**
 * Record an Oh My Pi spawned session as a subagent, from the first event this
 * process sees for it (session_start, or before_agent_start when the extension
 * was loaded after the session started). Later events are not consulted: Oh My
 * Pi also reports an advisor's tool calls to the advising session's handlers
 * with kind "sub", and those must not reclassify the advising session.
 */
export function recordPiSpawnedSession(
	db: ContextDatabase,
	sessionId: string,
	ctx: unknown,
): void {
	if (checkedSessions.has(sessionId)) return;
	checkedSessions.set(sessionId, true);
	if (readAgentKind(ctx) !== "sub") return;
	if (getOrCreateSessionMeta(db, sessionId).isSubagent) return;
	updateSessionMeta(db, sessionId, { isSubagent: true });
	sessionLog(
		sessionId,
		"Oh My Pi spawned session (agent kind sub): recorded as a subagent",
	);
}

export function clearPiSpawnedSessionCheck(sessionId: string): void {
	checkedSessions.delete(sessionId);
}
