// Whether a Pi or Oh My Pi session can call ctx_reduce, and the answer each
// session's last served request was built with.
//
// Tag prefixes (§N§), the ctx_reduce guidance in the system prompt and both
// reduce reminders exist only while the session can call the tool
// (ARCHITECTURE.md, Session modes). Another extension can remove the tool
// from the session's active tools or put it back at any time, and an Oh My
// Pi task child spawned from plan mode never has it, so the answer is read
// again for every request, never fixed for the session.

import {
	readReplayEnvelope,
	updateReplayDocument,
} from "@magic-context/core/features/magic-context/storage-replay-document";
import { BoundedSessionMap } from "@magic-context/core/shared/bounded-session-map";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";
import { readPiRequestSendsTool } from "./pi-request-tools";

const CTX_REDUCE = "ctx_reduce";

/**
 * True when the session's next request can call ctx_reduce: compaction is on
 * and the request sends the tool. When the host's tool lists cannot be read
 * the answer is unknown, and the session keeps the answer its last served
 * request was built with, so a failed read never adds or removes tag
 * prefixes. A session with no served request yet counts as callable, as every
 * session did before this check existed.
 */
export function piCtxReduceCallable(
	pi: { getAllTools?: () => unknown; getActiveTools?: () => unknown },
	compactionOff: boolean,
	session?: { db: Database; sessionId: string },
): boolean {
	if (compactionOff) return false;
	const sent = readPiRequestSendsTool(pi, CTX_REDUCE);
	if (sent !== undefined) return sent;
	return session
		? readServedPiCtxReduceCallable(session.db, session.sessionId)
		: true;
}

/**
 * The replay-document namespace holding the answer the session's last served
 * request was built with. Absent means true: every request served before this
 * record existed carried tags whenever compaction was on, and a session that
 * keeps the tool never writes the record.
 */
const NAMESPACE = "piCtxReduceCallable";

const servedBySession = new BoundedSessionMap<boolean>(1000);

/**
 * Whether the request this session last served was built for a session that
 * could call ctx_reduce. Read from storage on the session's first pass in this
 * process, so a change of the tool list across a restart is still seen.
 */
export function readServedPiCtxReduceCallable(
	db: Database,
	sessionId: string,
): boolean {
	const cached = servedBySession.get(sessionId);
	if (cached !== undefined) return cached;
	let served = true;
	try {
		const stored = readReplayEnvelope(db, sessionId, "read")[NAMESPACE];
		if (typeof stored === "boolean") served = stored;
	} catch (error) {
		sessionLog(sessionId, "ctx_reduce served record unreadable:", error);
	}
	servedBySession.set(sessionId, served);
	return served;
}

/**
 * Record the answer a served request was built with. Writes storage only when
 * the answer changes, which happens when ctx_reduce enters or leaves the
 * session's tool list.
 */
export function recordServedPiCtxReduceCallable(
	db: Database,
	sessionId: string,
	callable: boolean,
): void {
	if (readServedPiCtxReduceCallable(db, sessionId) === callable) return;
	// The request was served either way, so the in-memory answer advances
	// before the write, whether the write then succeeds, declines or throws.
	// Only a restart before a later successful write reads the older stored
	// answer, which costs one extra rebuild.
	servedBySession.set(sessionId, callable);
	const written = updateReplayDocument(db, sessionId, (doc) => {
		const stored = doc[NAMESPACE];
		if ((typeof stored === "boolean" ? stored : true) === callable)
			return false;
		doc.version = 2;
		doc[NAMESPACE] = callable;
		return true;
	});
	if (!written) sessionLog(sessionId, "ctx_reduce served record not written");
}

export function clearPiCtxReduceCallableSession(sessionId: string): void {
	servedBySession.delete(sessionId);
}
