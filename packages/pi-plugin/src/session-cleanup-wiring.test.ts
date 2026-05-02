import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression coverage for per-session cleanup wiring.
 *
 * Pi has no `session_deleted` event. The closest analogs are:
 *   - `session_shutdown` — graceful process exit (Ctrl+C, SIGTERM)
 *   - `session_before_switch` — user switches to a different session
 *     within the same Pi process
 *
 * Both are valid moments to drain caches keyed by the outgoing session
 * id. Without this, a long-running Pi process that switches sessions
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
		expect(body).toContain("pendingMaterializationSessions.delete(sessionId)");
	});

	test("deletes from systemPromptRefreshSessions", () => {
		// Pinned: was also missing pre-audit.
		expect(body).toContain("systemPromptRefreshSessions.delete(sessionId)");
	});

	test("clears compressor cooldown state", () => {
		expect(body).toContain("clearPiCompressorState(sessionId)");
	});
});

describe("session_before_switch handler wiring", () => {
	const handler = INDEX_SRC.match(
		/pi\.on\("session_before_switch"[\s\S]*?\}\);/,
	);

	test("session_before_switch handler is registered", () => {
		expect(handler).not.toBeNull();
	});

	const body = handler?.[0] ?? "";

	test("handler resolves the OUTGOING session id (not the new target)", () => {
		// Pi fires this BEFORE the switch, so getSessionId() returns
		// the still-current session — that's exactly what we want.
		expect(body).toContain("getSessionId()");
	});

	test("handler calls clearContextHandlerSession", () => {
		expect(body).toContain("clearContextHandlerSession(");
	});

	test("handler calls clearPiSystemPromptSession", () => {
		expect(body).toContain("clearPiSystemPromptSession(");
	});
});

describe("session_shutdown handler also drains per-session maps", () => {
	const handler = INDEX_SRC.match(
		/pi\.on\("session_shutdown"[\s\S]*?\n\t\}\);/,
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
		expect(body).toContain("clearContextHandlerSession(");
	});
});
