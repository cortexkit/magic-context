import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression coverage for per-session cleanup wiring.
 *
 * Pi has no `session_deleted` event. The closest analogs are:
 *   - `session_shutdown` — graceful process exit (Ctrl+C, SIGTERM)
 *   - a completed switch to a different session within the same Pi
 *     process (`session_shutdown` on stock Pi, `session_switch` on OMP)
 *
 * Both are valid moments to drain caches keyed by the outgoing session
 * id; `session_before_switch` is not, because the switch can still be
 * cancelled. Without this, a long-running Pi process that switches sessions
 * many times leaks one entry per per-session map per switch.
 *
 * Counterpart to OpenCode `session.deleted` cleanup in
 * `event-handler.ts:262-276`.
 */

const INDEX_SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
const HANDLER_SRC = readFileSync(
	join(import.meta.dir, "context-handler.ts"),
	"utf8",
);

describe("clearContextHandlerSession internals", () => {
	// The function body must drain all three signal sets — historian
	// or compressor publish (or hash change in before_agent_start) can
	// add to all three, and a stale session id would keep an entry in
	// any of them indefinitely without this cleanup.
	const fn = HANDLER_SRC.match(
		/export function clearContextHandlerSession\([^{]*\{([\s\S]*?)\n\}/,
	);

	test("function exists and is exported", () => {
		expect(fn).not.toBeNull();
	});

	const body = fn?.[1] ?? "";

	test("deletes from historyRefreshSessions", () => {
		expect(body).toContain("historyRefreshSessions.delete(sessionId)");
	});

	test("deletes from pendingMaterializationSessions", () => {
		// Pinned: this was missing before the parity audit. Without it,
		// a stale pendingMaterializationSessions entry would force the
		// pipeline to materialize pending ops on a session that no
		// longer exists.
		expect(body).toContain(
			"clearPendingMaterialization(pendingMaterializationSessions, sessionId)",
		);
	});

	test("deletes from systemPromptRefreshSessions", () => {
		// Pinned: was also missing pre-audit.
		expect(body).toContain("systemPromptRefreshSessions.delete(sessionId)");
	});
});

describe("session switch handler wiring", () => {
	// session_before_switch can be cancelled (or the switch can fail after
	// it), so it must not drain the still-current session. The drain runs
	// once the switch has happened: session_shutdown on stock Pi, and
	// session_switch on OMP. The behaviour is exercised in
	// index-in-process-latch.test.ts; this pins the wiring.
	const beforeSwitch = INDEX_SRC.match(
		/pi\.on\("session_before_switch"[\s\S]*?\}\);/,
	);
	const afterSwitch = INDEX_SRC.match(/\)\("session_switch"[\s\S]*?\n\t\}\);/);

	test("session_before_switch only records the OUTGOING session id", () => {
		const body = beforeSwitch?.[0] ?? "";
		expect(body).toContain("switchOutgoingSessionId = readSessionId(ctx)");
		expect(body).not.toContain("clearContextHandlerSession(");
		expect(body).not.toContain("clearPiSystemPromptSession(");
	});

	test("session_switch drains the recorded outgoing session", () => {
		const body = afterSwitch?.[0] ?? "";
		expect(body).toContain("clearContextHandlerSession(outgoingSessionId, db)");
		expect(body).toContain("clearPiSystemPromptSession(outgoingSessionId)");
	});
});

describe("session_shutdown handler also drains per-session maps", () => {
	const handler = INDEX_SRC.match(
		/pi\.on\("session_shutdown"[\s\S]*?\n\t\}\);(?=\n\n\t\/\/ Pi has no `session_deleted` event)/,
	);

	test("session_shutdown handler exists", () => {
		expect(handler).not.toBeNull();
	});

	const body = handler?.[0] ?? "";

	test("calls clearContextHandlerSession on shutdown", () => {
		// Pre-audit: only clearPiSystemPromptSession was called. The
		// context-handler caches were never drained on shutdown, so a
		// long-lived process re-running the extension between shutdowns
		// (e.g. via /reload) would leak.
		expect(body).toContain("clearContextHandlerSession(sessionId, db)");
	});
});
