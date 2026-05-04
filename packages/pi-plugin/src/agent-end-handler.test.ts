import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression coverage for the "historian blocks main agent" bug.
 *
 * Symptom: when historian fired during a turn, the user saw the agent
 * stuck on `Working...` with `historian` pinned in the footer until the
 * background subagent finished — the OPPOSITE of magic-context's
 * "compact in the background" invariant.
 *
 * Root cause: `pi.on("agent_end", async () => { await
 * awaitInFlightHistorians(); ... })`. Pi's
 * `extensions/runner.js` does `await handler(event, ctx)` for every
 * extension `agent_end` handler, and `agent-session.js` awaits its own
 * emit before delivering the UI-facing `agent_end` that stops the TUI
 * loader. So awaiting historian here pinned the loader for ~30s every
 * trigger turn.
 *
 * Fix: agent_end MUST return synchronously (no `await`). The drain
 * moved to `session_shutdown` with a 5s cap.
 *
 * These tests guard against regressions by reading the source
 * verbatim — string assertions on `agent_end` body shape — because the
 * bug is structural (the handler signature and what it awaits) and is
 * cheaper to pin via source inspection than a Pi runtime mock.
 */

const INDEX_PATH = join(import.meta.dir, "index.ts");
const INDEX_SRC = readFileSync(INDEX_PATH, "utf8");

function extractAgentEndHandlerBody(src: string): string {
	// Match `pi.on("agent_end", <arrow>) {` through the matching `});`.
	// Single agent_end handler is registered in this file.
	const start = src.indexOf('pi.on("agent_end"');
	if (start === -1) throw new Error("no agent_end handler found in index.ts");
	// Walk forward to the closing `});` of the registration. We assume
	// no nested `});` lines inside the handler — true for the current
	// implementation which only contains comments + a `log(...)`.
	const end = src.indexOf("});", start);
	if (end === -1) throw new Error("no closing }); for agent_end handler");
	return src.slice(start, end + 3);
}

function extractSessionShutdownHandlerBody(src: string): string {
	const start = src.indexOf('pi.on("session_shutdown"');
	if (start === -1) throw new Error("no session_shutdown handler in index.ts");
	// session_shutdown handler is the last large block; find the
	// matching brace by counting { / } from the start.
	let depth = 0;
	let i = start;
	let started = false;
	while (i < src.length) {
		const ch = src[i];
		if (ch === "{") {
			depth++;
			started = true;
		} else if (ch === "}") {
			depth--;
			if (started && depth === 0) {
				// Look for trailing `);`
				const tail = src.slice(i, i + 3);
				if (tail.startsWith("})")) return src.slice(start, i + 3);
			}
		}
		i++;
	}
	throw new Error("no closing }); for session_shutdown handler");
}

describe("agent_end handler (blocking-historian regression)", () => {
	const body = extractAgentEndHandlerBody(INDEX_SRC);
	// Strip line comments first — the documentation comments inside
	// the handler legitimately reference `awaitInFlightHistorians` and
	// `awaitInFlightDreamers` to explain WHY they're not called here.
	// Tests must look at code only.
	const codeOnly = body
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n");

	test("handler arrow function is NOT marked async", () => {
		// async arrow returns a Promise; Pi awaits it. We need a
		// synchronous arrow so Pi's await resolves immediately.
		expect(body).toContain('pi.on("agent_end", () =>');
		expect(body).not.toContain('pi.on("agent_end", async () =>');
	});

	test("handler code does NOT call awaitInFlightHistorians", () => {
		expect(codeOnly).not.toContain("awaitInFlightHistorians");
	});

	test("handler code does NOT call awaitInFlightDreamers", () => {
		expect(codeOnly).not.toContain("awaitInFlightDreamers");
	});

	test("handler contains no await keyword in code", () => {
		// Match `await ` as a keyword (followed by space/identifier).
		expect(codeOnly).not.toMatch(/\bawait\s+\w/);
	});
});

describe("session_shutdown handler (drain location)", () => {
	const body = extractSessionShutdownHandlerBody(INDEX_SRC);

	test("drains in-flight historians (Promise.race with timeout)", () => {
		expect(body).toContain("awaitInFlightHistorians");
		expect(body).toContain("Promise.race");
	});

	test("drains in-flight dreamers (Promise.race with timeout)", () => {
		expect(body).toContain("awaitInFlightDreamers");
	});

	test("drain timeout uses a setTimeout-bounded race", () => {
		// Confirms the bounded shape: `Promise.race([drain, setTimeout])`.
		// The exact ms value is intentionally NOT asserted so it can be
		// tuned without breaking this test.
		expect(body).toMatch(/setTimeout\(.*\)/);
	});
});
