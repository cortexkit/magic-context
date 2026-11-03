import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { estimateTokens } from "../../../plugin/src/hooks/magic-context/read-session-formatting";
import { Database } from "../../../plugin/src/shared/sqlite";
import type { MockProvider } from "../../src/mock-provider/server";
import {
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

// The history boundary is the end message of the newest compartment. When the
// host store loses that row (a store conversion or an /undo deletes it), the
// transform used to look for it on every pass, never find it, and send the
// whole conversation. After a host compaction that is worse than the host's own
// request: the plugin restores the rows the host cut from the store, starting
// after the boundary, and a boundary the store no longer has makes that start
// at the very first row.
//
// These tests build that state on a real OpenCode 2 host: compartments, a host
// compaction, then the boundary row deleted from the throwaway store while the
// host is stopped. The mock provider enforces a context window the way a real
// provider does, answering an oversized request with HTTP 400.

const WINDOW = 60_000;
const TURN_TEXT = "durable history ".repeat(2500);
// The historian's own prompt is larger than the session window, as it is for
// real users with a small session model, so it runs on a second model whose
// window the enforcer below does not apply to.
const HISTORIAN_MODEL = { id: "historian-model", contextLimit: 200_000 };

type Client = ReturnType<typeof OpenCode.make>;
type Host = Awaited<ReturnType<typeof spawnOpencode2>>;

function clientFor(host: Host): Client {
	return OpenCode.make({
		baseUrl: host.url,
		headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
	});
}

function requestTokens(body: Record<string, unknown>): number {
	return estimateTokens(
		JSON.stringify({
			input: body.input ?? body.messages,
			instructions: body.instructions ?? body.system,
			tools: body.tools,
		}),
	);
}

function contextDbPath(host: { env: NodeJS.ProcessEnv }): string {
	return join(host.env.XDG_DATA_HOME!, "cortexkit", "magic-context", "context.db");
}

function hostDbPath(host: { env: NodeJS.ProcessEnv }): string {
	return join(host.env.XDG_DATA_HOME!, "opencode", host.env.OPENCODE_DB!);
}

function readRows<T>(path: string, sql: string, ...params: unknown[]): T[] {
	const db = openTestDb(path, { readonly: true, fileMustExist: true }, Database);
	try {
		return db.prepare(sql).all(...params) as T[];
	} finally {
		db.close();
	}
}

function writeRows(path: string, sql: string, ...params: unknown[]): number {
	if (!existsSync(path)) throw new Error(`missing store ${path}`);
	const db = openTestDb(path, undefined, Database);
	try {
		db.prepare(sql).run(...params);
		// Count the target rows, not the history-version trigger's additional writes.
		return (db.prepare("SELECT changes() AS changed").get() as { changed: number }).changed;
	} finally {
		db.close();
	}
}

interface CompartmentRow {
	sequence: number;
	endMessage: number;
	endMessageId: string;
}

function compartments(host: Host, sessionId: string): CompartmentRow[] {
	return readRows<CompartmentRow>(
		contextDbPath(host),
		"SELECT sequence, end_message AS endMessage, end_message_id AS endMessageId FROM compartments WHERE session_id = ? ORDER BY sequence",
		sessionId,
	);
}

function baselineBoundary(host: Host, sessionId: string): string | null {
	return (
		readRows<{ id: string | null }>(
			contextDbPath(host),
			"SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id = ?",
			sessionId,
		)[0]?.id ?? null
	);
}

async function turn(client: Client, sessionId: string, text: string): Promise<void> {
	await client.session.prompt({ sessionID: sessionId, text });
	await client.session.wait({ sessionID: sessionId }, { signal: AbortSignal.timeout(60_000) });
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, label: string): Promise<T> {
	const deadline = Date.now() + 60_000;
	let value = read();
	while (!done(value)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(100);
		value = read();
	}
	return value;
}

/** The plugin buffers its log; poll until a line appears. */
async function waitForLog(path: string, needle: string | RegExp): Promise<string> {
	return waitFor(
		() => (existsSync(path) ? readFileSync(path, "utf8") : ""),
		(text) => (typeof needle === "string" ? text.includes(needle) : needle.test(text)),
		`log line ${needle}`,
	);
}

/**
 * Every open file of the host must sit under its throwaway root or be a
 * read-only system library. Written next to the store so a reader can check it.
 */
function recordOpenFiles(host: Host, label: string): string[] {
	if (!host.pid) return [];
	const result = spawnSync("lsof", ["-Fn", "-p", String(host.pid)], {
		encoding: "utf8",
		windowsHide: true,
	});
	const paths = (result.stdout ?? "")
		.split("\n")
		.filter((line) => line.startsWith("n/"))
		.map((line) => line.slice(1));
	writeFileSync(join(host.root, `lsof-${label}.txt`), `${paths.join("\n")}\n`);
	const home = process.env.HOME ?? "";
	const forbidden = [
		join(home, ".local/share/opencode"),
		join(home, ".local/share/cortexkit/magic-context"),
		join(home, ".config"),
	];
	return paths.filter((path) => forbidden.some((root) => path.startsWith(root)));
}

interface Scenario {
	fixture: ReturnType<typeof isolation>;
	host: Host;
	client: Client;
	mock: MockProvider;
	mockBaseURL: string;
	sessionId: string;
	logPath: string;
	oversized: number[];
	setEnforced(value: boolean): void;
}

const MAGIC_CONTEXT_CONFIG = {
	memory: { enabled: false },
	dreamer: { disable: true },
	historian: { two_pass: false },
};

/**
 * Two compartments, a baseline on the second one's end, then a host compaction.
 * The mock reports tiny usage throughout so the plugin never starts a historian
 * on its own; the compartments come only from the two /ctx-wrapup runs.
 */
async function buildSession(label: string): Promise<Scenario> {
	const fixture = isolation();
	const logPath = join(fixture.root, `${label}.log`);
	fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		modelContextLimit: WINDOW,
		modelOutputLimit: 1_024,
		compactionAuto: false,
		magicContextConfig: MAGIC_CONTEXT_CONFIG,
		historianModel: HISTORIAN_MODEL,
	});
	const mock = host.mock;
	let enforced = false;
	const oversized: number[] = [];
	// Registered first so it sees every request, the way a provider does.
	mock.addMatcher((body) => {
		if (body.model === HISTORIAN_MODEL.id) return null;
		const tokens = requestTokens(body);
		if (tokens <= WINDOW) return null;
		oversized.push(tokens);
		if (!enforced) return null;
		return {
			error: {
				status: 400,
				type: "invalid_request_error",
				message: `prompt is too long: ${tokens} tokens > ${WINDOW} maximum`,
			},
		};
	});
	mock.addMatcher((body) => {
		const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
		if (!range) return null;
		return {
			text: `<compartment start="${range[1]}" end="${range[2]}" title="History ${range[1]}-${range[2]}"><p1>Turns ${range[1]} to ${range[2]} recorded durable history.</p1></compartment>`,
			usage: { input_tokens: 100, output_tokens: 40 },
		};
	});
	mock.setDefault({ text: "ordinary turn", usage: { input_tokens: 100, output_tokens: 10 } });
	const client = clientFor(host);
	const session = await client.session.create({
		title: label,
		location: { directory: host.cwd },
		model: { providerID: "openai", id: "mock-model" },
	});
	await waitForPluginActive(client, host.cwd);
	const scenario: Scenario = {
		fixture,
		host,
		client,
		mock,
		mockBaseURL: host.mockBaseURL,
		sessionId: session.id,
		logPath,
		oversized,
		setEnforced(value) {
			enforced = value;
		},
	};

	for (let index = 0; index < 12; index++) await turn(client, session.id, `Turn ${index}: ${TURN_TEXT}`);
	await client.session.command({ sessionID: session.id, name: "ctx-wrapup", text: "2" });
	await waitFor(() => compartments(host, session.id), (rows) => rows.length >= 1, "first wrapup");
	for (let index = 12; index < 24; index++) await turn(client, session.id, `Turn ${index}: ${TURN_TEXT}`);
	const before = compartments(host, session.id).length;
	await client.session.command({ sessionID: session.id, name: "ctx-wrapup", text: "2" });
	await waitFor(() => compartments(host, session.id), (rows) => rows.length > before, "second wrapup");
	// Flush makes the next turn a priced pass, which moves the baseline to the
	// newest compartment end.
	await client.session.command({ sessionID: session.id, name: "ctx-flush", text: "" });
	await turn(client, session.id, "Turn 24: settle the baseline");

	await client.session.compact({ sessionID: session.id });
	await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) });
	const cuts = readRows<{ count: number }>(
		hostDbPath(host),
		"SELECT COUNT(*) AS count FROM session_message WHERE session_id = ? AND type = 'compaction'",
		session.id,
	)[0]?.count;
	expect(cuts).toBeGreaterThan(0);
	await turn(client, session.id, "Turn 25: after the host compaction");
	// A historian run started by the turns above may still publish; wait until
	// the compartment count holds, then fold once more so the baseline sits on
	// the newest compartment end.
	let count = -1;
	for (;;) {
		const next = compartments(host, session.id).length;
		if (next === count) break;
		count = next;
		await Bun.sleep(1_500);
	}
	await client.session.command({ sessionID: session.id, name: "ctx-flush", text: "" });
	await turn(client, session.id, "Turn 26: settle the baseline after the compaction");
	const latest = compartments(host, session.id).at(-1);
	expect(latest?.endMessageId).toBeTruthy();
	expect(baselineBoundary(host, session.id)).toBe(latest!.endMessageId);
	return scenario;
}

/**
 * A converted store gives the history rows new part identities, so the drops
 * the plugin recorded for them no longer apply and the rows come back at full
 * size (issue 590's session had thousands of tags and none of them dropped).
 * Undo the drops here so the restored history is served at that full size.
 */
function forgetDrops(scenario: Scenario): void {
	const path = contextDbPath(scenario.host);
	writeRows(path, "UPDATE tags SET status = 'active' WHERE session_id = ? AND status != 'active'", scenario.sessionId);
	writeRows(path, "DELETE FROM pending_ops WHERE session_id = ?", scenario.sessionId);
}

async function restart(scenario: Scenario): Promise<void> {
	scenario.host = await spawnOpencode2({
		existingIsolation: scenario.fixture,
		existingMock: { mock: scenario.mock, baseURL: scenario.mockBaseURL },
		modelContextLimit: WINDOW,
		modelOutputLimit: 1_024,
		compactionAuto: false,
		magicContextConfig: MAGIC_CONTEXT_CONFIG,
		historianModel: HISTORIAN_MODEL,
	});
	scenario.client = clientFor(scenario.host);
	await waitForPluginActive(scenario.client, scenario.host.cwd);
}

function servedFor(scenario: Scenario, marker: string, from: number) {
	return scenario.mock
		.requests()
		.slice(from)
		.filter((request) => JSON.stringify(request.body).includes(marker));
}

test("a deleted history boundary re-anchors on one rebuild pass and the request fits the window", async () => {
	const scenario = await buildSession("deleted-boundary");
	try {
		const { sessionId } = scenario;
		const rows = compartments(scenario.host, sessionId);
		expect(rows.length).toBeGreaterThanOrEqual(2);
		const deleted = rows.at(-1)!.endMessageId;
		const anchor = rows.at(-2)!;
		expect(recordOpenFiles(scenario.host, "before-delete")).toEqual([]);
		await scenario.host.stopHost();

		// The store loses the boundary row, as a conversion or an /undo leaves it.
		expect(
			writeRows(hostDbPath(scenario.host), "DELETE FROM session_message WHERE id = ?", deleted),
		).toBe(1);
		forgetDrops(scenario);

		await restart(scenario);
		expect(recordOpenFiles(scenario.host, "after-delete")).toEqual([]);
		scenario.setEnforced(true);
		scenario.oversized.length = 0;
		const start = scenario.mock.requests().length;
		const marker = "first turn after the boundary row was deleted";
		await turn(scenario.client, sessionId, marker);
		const served = servedFor(scenario, marker, start);
		const sizes = served.map((request) => requestTokens(request.body));
		console.log(`[missing-boundary] deleted=${deleted} anchor=${anchor.endMessageId} served=${JSON.stringify(sizes)} oversized=${JSON.stringify(scenario.oversized)}`);
		expect(served).toHaveLength(1);
		expect(sizes[0]).toBeLessThan(WINDOW);

		// Compartments whose end the store no longer has are gone; the newest
		// one left ends on a row the store still has.
		const after = compartments(scenario.host, sessionId);
		expect(after.at(-1)?.endMessageId).toBe(anchor.endMessageId);
		expect(after.some((row) => row.endMessageId === deleted)).toBe(false);
		expect(baselineBoundary(scenario.host, sessionId)).toBe(anchor.endMessageId);
		const log = await waitForLog(scenario.logPath, "history boundary repair");
		expect(log).toContain(`history boundary repair: newest compartment end ${deleted} is not in the host store`);

		// The pass after the repair is ordinary replay: the same prefix, and no
		// second repair.
		const nextStart = scenario.mock.requests().length;
		const nextMarker = "second turn after the repair";
		await turn(scenario.client, sessionId, nextMarker);
		const next = servedFor(scenario, nextMarker, nextStart);
		expect(next).toHaveLength(1);
		expect(requestTokens(next[0]!.body)).toBeLessThan(WINDOW);
		const firstHead = JSON.stringify((served[0]!.body.input as unknown[])?.slice(0, 2));
		const nextHead = JSON.stringify((next[0]!.body.input as unknown[])?.slice(0, 2));
		expect(nextHead).toBe(firstHead);
		const finalLog = readFileSync(scenario.logPath, "utf8");
		expect(finalLog.split("history boundary repair:").length - 1).toBe(1);
		expect(scenario.oversized).toEqual([]);
	} catch (error) {
		console.error(
			scenario.host.stderr(),
			existsSync(scenario.logPath) ? readFileSync(scenario.logPath, "utf8").slice(-20_000) : "(no plugin log)",
		);
		throw error;
	} finally {
		await scenario.host.stop();
	}
}, 600_000);

test("a newest compartment with no end_message_id (the fork shape) bounds at the newest end id", async () => {
	const scenario = await buildSession("no-end-id");
	try {
		const { sessionId } = scenario;
		const rows = compartments(scenario.host, sessionId);
		const latest = rows.at(-1)!;
		const anchor = rows.at(-2)!;
		await scenario.host.stopHost();
		// The row is still in the host store; only the compartment lost its end id,
		// as in the forked session of issue 590.
		expect(
			writeRows(
				contextDbPath(scenario.host),
				"UPDATE compartments SET end_message_id = '' WHERE session_id = ? AND sequence = ?",
				sessionId,
				latest.sequence,
			),
		).toBe(1);
		forgetDrops(scenario);
		await restart(scenario);
		expect(recordOpenFiles(scenario.host, "no-end-id")).toEqual([]);
		scenario.setEnforced(true);
		scenario.oversized.length = 0;
		// A priced pass recomputes the cached boundary from the compartments. It
		// used to come out empty here, so every row the host compacted away was
		// restored and served uncut.
		await scenario.client.session.command({ sessionID: sessionId, name: "ctx-flush", text: "" });
		const sizes: number[] = [];
		for (const marker of [
			"priced turn after the newest compartment lost its end id",
			"replayed turn after the newest compartment lost its end id",
		]) {
			const start = scenario.mock.requests().length;
			await turn(scenario.client, sessionId, marker);
			const served = servedFor(scenario, marker, start);
			expect(served).toHaveLength(1);
			sizes.push(requestTokens(served[0]!.body));
		}
		console.log(`[missing-boundary] no-end-id served=${JSON.stringify(sizes)} oversized=${JSON.stringify(scenario.oversized)}`);
		for (const size of sizes) expect(size).toBeLessThan(WINDOW);
		expect(scenario.oversized).toEqual([]);
		// Nothing is removed: the id-less compartment keeps rendering, and the
		// boundary is the newest compartment that has an end id.
		const after = compartments(scenario.host, sessionId);
		expect(after).toHaveLength(rows.length);
		expect(after.at(-1)?.endMessageId).toBe("");
		expect(baselineBoundary(scenario.host, sessionId)).toBe(anchor.endMessageId);
	} catch (error) {
		console.error(
			scenario.host.stderr(),
			existsSync(scenario.logPath) ? readFileSync(scenario.logPath, "utf8").slice(-20_000) : "(no plugin log)",
		);
		throw error;
	} finally {
		await scenario.host.stop();
	}
}, 600_000);

test("a boundary with no surviving anchor is never served as the whole window", async () => {
	const scenario = await buildSession("no-anchor");
	try {
		const { sessionId } = scenario;
		const rows = compartments(scenario.host, sessionId);
		await scenario.host.stopHost();
		// Every compartment end is gone from the store, so nothing is left to
		// re-anchor on.
		for (const row of rows) {
			writeRows(hostDbPath(scenario.host), "DELETE FROM session_message WHERE id = ?", row.endMessageId);
		}
		forgetDrops(scenario);
		await restart(scenario);
		expect(recordOpenFiles(scenario.host, "no-anchor")).toEqual([]);
		scenario.setEnforced(true);
		scenario.oversized.length = 0;
		const start = scenario.mock.requests().length;
		const marker = "turn with no anchor left";
		await turn(scenario.client, sessionId, marker);
		const served = servedFor(scenario, marker, start);
		const sizes = served.map((request) => requestTokens(request.body));
		console.log(`[missing-boundary] no-anchor served=${JSON.stringify(sizes)} oversized=${JSON.stringify(scenario.oversized)}`);
		// Either the last good request is replayed (under the window) or the turn
		// is refused before any provider request. Never the whole window.
		expect(scenario.oversized).toEqual([]);
		for (const size of sizes) expect(size).toBeLessThan(WINDOW);
		const log = await waitForLog(scenario.logPath, /lkg_replay_served|prefix trim refused and the untrimmed request/);
		expect(log).toMatch(/lkg_replay_served|prefix trim refused and the untrimmed request/);
	} catch (error) {
		console.error(
			scenario.host.stderr(),
			existsSync(scenario.logPath) ? readFileSync(scenario.logPath, "utf8").slice(-20_000) : "(no plugin log)",
		);
		throw error;
	} finally {
		await scenario.host.stop();
	}
}, 600_000);
