// Oh My Pi tells an extension which agent a session runs: `ctx.agent.kind` is
// "main" for a top-level session and "sub" for any session another agent
// spawned (task children, eval agents, and forks of a session). A spawned session runs in
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
 *
 * Oh My Pi also runs forks of a session as "sub": a `/tan` clone of the
 * current session, and a task child forked from an earlier session (Oh My
 * Pi's "seance" agent). When the
 * session_start handler's clone inheritance (which runs before this record)
 * copied the source session's compartments into the new session, the session
 * continues that one and stays primary, keeping the history head that renders
 * those compartments, as a fork does on OpenCode. The compartments are what
 * decides it, not the session header's parent: an ordinary task child names
 * its parent there too, and inherits no compartments.
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
	if (hasCompartments(db, sessionId)) {
		sessionLog(
			sessionId,
			"Oh My Pi spawned session (agent kind sub) has compartments from its source session: kept primary",
		);
		return;
	}
	updateSessionMeta(db, sessionId, { isSubagent: true });
	sessionLog(
		sessionId,
		"Oh My Pi spawned session (agent kind sub): recorded as a subagent",
	);
}

function hasCompartments(db: ContextDatabase, sessionId: string): boolean {
	return (
		db
			.prepare(
				"SELECT 1 AS present FROM compartments WHERE session_id = ? LIMIT 1",
			)
			.get(sessionId) != null
	);
}

export function clearPiSpawnedSessionCheck(sessionId: string): void {
	checkedSessions.delete(sessionId);
}
