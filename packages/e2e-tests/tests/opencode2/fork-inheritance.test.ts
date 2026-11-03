import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { estimateTokens } from "../../../plugin/src/hooks/magic-context/read-session-formatting";
import { Database } from "../../../plugin/src/shared/sqlite";
import type { MockProvider } from "../../src/mock-provider/server";
import { isolation, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

// Issue 608. OpenCode 2 forks a session by copying its rows into a new session
// id (session_v2.fork_session_id / fork_boundary) and re-minting every copied
// message id. Magic Context keyed nothing to the new id, so the fork's first
// request carried the whole raw history, far over the model's window.
//
// These tests drive a real OpenCode 2 host with a mock provider that enforces
// a context window the way a real provider does (HTTP 400 over the window):
// - a fork of a compacted session must inherit its history and be served
//   managed, with the history head rendered from the inherited compartments;
// - a session Magic Context has never seen, whose raw history is over the
//   window, must never reach the provider unmanaged;
// - an ordinary small first pass is still served.
//
// Set MC_E2E_FORK_CAPTURE_DIR to write the captured request bodies there, so
// two builds can be compared byte for byte.

const WINDOW = 60_000;
const TURN_TEXT = "durable history ".repeat(2500);
const TOOL_TEXT = "inherited tool output payload ".repeat(900);
const HISTORIAN_MODEL = { id: "historian-model", contextLimit: 400_000 };
const MAGIC_CONTEXT_CONFIG = {
	memory: { enabled: false },
	dreamer: { disable: true },
	historian: { two_pass: false },
};

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

function stateCounts(host: Host, sessionId: string) {
	const count = (table: string) =>
		readRows<{ count: number }>(
			contextDbPath(host),
			`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`,
			sessionId,
		)[0]?.count ?? 0;
	return { compartments: count("compartments"), tags: count("tags") };
}

function tagStatuses(host: Host, sessionId: string): Record<string, number> {
	return Object.fromEntries(
		readRows<{ status: string; count: number }>(
			contextDbPath(host),
			"SELECT status, COUNT(*) AS count FROM tags WHERE session_id = ? GROUP BY status",
			sessionId,
		).map((row) => [row.status, row.count]),
	);
}

async function turn(client: Client, sessionId: string, text: string): Promise<void> {
	await client.session.prompt({ sessionID: sessionId, text });
	await client.session.wait({ sessionID: sessionId }, { signal: AbortSignal.timeout(90_000) });
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, label: string): Promise<T> {
	const deadline = Date.now() + 90_000;
	let value = read();
	while (!done(value)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(100);
		value = read();
	}
	return value;
}

/**
 * Every open file of the host must sit under its throwaway root or be a
 * read-only system library. The list is written next to the store.
 */
function forbiddenOpenFiles(host: Host, label: string): string[] {
	if (!host.pid) return [];
	const result = spawnSync("lsof", ["-Fn", "-p", String(host.pid)], { encoding: "utf8" });
	const paths = (result.stdout ?? "")
		.split("\n")
		.filter((line) => line.startsWith("n/"))
		.map((line) => line.slice(1));
	writeFileSync(join(host.root, `lsof-${label}.txt`), `${paths.join("\n")}\n`);
	const home = process.env.HOME ?? "";
	const forbidden = [
		join(home, ".local/share/opencode"),
		join(home, ".local/share/cortexkit/magic-context"),
		join(home, ".config/opencode"),
		join(home, ".config/cortexkit"),
	];
	const dbPaths = paths.filter((path) => /\.db(-wal|-shm)?$/.test(path));
	writeFileSync(join(host.root, `lsof-${label}-db.txt`), `${dbPaths.join("\n")}\n`);
	return paths.filter((path) => forbidden.some((root) => path.startsWith(root)));
}

function capture(name: string, value: unknown): void {
	const dir = process.env.MC_E2E_FORK_CAPTURE_DIR;
	if (!dir) return;
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

/** The text of the first input item, which carries the rendered history head. */
function historyHead(body: Record<string, unknown>): string {
	const input = (body.input ?? body.messages) as unknown[] | undefined;
	const text = JSON.stringify(input?.slice(0, 2) ?? []);
	const start = text.indexOf("<session-history>");
	return start < 0 ? "" : text.slice(start, start + 600);
}

/** The rendered history block titles (`## 1-4 · History 1-4`), in order. */
function compartmentTitles(body: Record<string, unknown>): string[] {
	return [...JSON.stringify(body.input ?? body.messages).matchAll(/## \d+-\d+ · History \d+-\d+/g)].map(
		(match) => match[0],
	);
}

interface Scenario {
	host: Host;
	client: Client;
	mock: MockProvider;
	logPath: string;
	oversized: number[];
	setEnforced(value: boolean): void;
}

async function startHost(label: string, includeMagicContext = true): Promise<Scenario> {
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
		includeMagicContext,
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
	if (includeMagicContext) await waitForPluginActive(client, host.cwd);
	return {
		host,
		client,
		mock,
		logPath,
		oversized,
		setEnforced(value) {
			enforced = value;
		},
	};
}

function dumpOnFailure(scenario: Scenario): void {
	console.error(
		scenario.host.stderr().slice(-10_000),
		existsSync(scenario.logPath)
			? readFileSync(scenario.logPath, "utf8").slice(-30_000)
			: "(no plugin log)",
	);
}

async function createSession(scenario: Scenario, title: string): Promise<string> {
	const session = await scenario.client.session.create({
		title,
		location: { directory: scenario.host.cwd },
		model: { providerID: "openai", id: "mock-model" },
	});
	return session.id;
}

/** A tool call whose output the agent later drops through ctx_reduce. */
async function toolTurnAndDrop(scenario: Scenario, sessionId: string): Promise<number> {
	const note = join(scenario.host.cwd, "inherited-note.txt");
	writeFileSync(note, `${TOOL_TEXT}\n`);
	let readIssued = false;
	scenario.mock.addMatcher((body) => {
		if (readIssued || body.model !== "mock-model") return null;
		if (!JSON.stringify(body).includes("read the inherited note")) return null;
		readIssued = true;
		return {
			openaiOutput: [
				{
					type: "function_call",
					id: "fc_inherited_read",
					call_id: "call_inherited_read",
					name: "read",
					arguments: JSON.stringify({ path: note }),
				},
			],
			usage: { input_tokens: 100, output_tokens: 10 },
		};
	});
	await turn(scenario.client, sessionId, "read the inherited note");
	expect(readIssued).toBe(true);
	const toolTag = await waitFor(
		() =>
			readRows<{ tag_number: number }>(
				contextDbPath(scenario.host),
				"SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' AND message_id = 'call_inherited_read'",
				sessionId,
			)[0],
		(row) => row !== undefined,
		"tool tag",
	);
	let reduceIssued = false;
	scenario.mock.addMatcher((body) => {
		if (reduceIssued || body.model !== "mock-model") return null;
		const text = JSON.stringify(body);
		if (!text.includes("drop the inherited note") || !text.includes('"name":"ctx_reduce"')) return null;
		reduceIssued = true;
		return {
			openaiOutput: [
				{
					type: "function_call",
					id: "fc_inherited_reduce",
					call_id: "call_inherited_reduce",
					name: "ctx_reduce",
					arguments: JSON.stringify({ drop: String(toolTag.tag_number) }),
				},
			],
			usage: { input_tokens: 100, output_tokens: 10 },
		};
	});
	await turn(scenario.client, sessionId, "drop the inherited note");
	expect(reduceIssued).toBe(true);
	await scenario.client.session.command({ sessionID: sessionId, name: "ctx-flush", text: "" });
	await turn(scenario.client, sessionId, "apply the queued drop");
	await waitFor(
		() =>
			readRows<{ status: string }>(
				contextDbPath(scenario.host),
				"SELECT status FROM tags WHERE session_id = ? AND tag_number = ?",
				sessionId,
				toolTag.tag_number,
			)[0]?.status,
		(status) => status === "dropped",
		"dropped tool tag",
	);
	return toolTag.tag_number;
}

async function settleCompartments(scenario: Scenario, sessionId: string): Promise<void> {
	let count = -1;
	for (;;) {
		const next = stateCounts(scenario.host, sessionId).compartments;
		if (next === count) return;
		count = next;
		await Bun.sleep(1_500);
	}
}

function servedFor(scenario: Scenario, marker: string, from: number) {
	return scenario.mock
		.requests()
		.slice(from)
		.filter(
			(request) =>
				request.body.model === "mock-model" && JSON.stringify(request.body).includes(marker),
		);
}

test("a fork of a compacted session inherits its history and is served managed", async () => {
	const scenario = await startHost("fork-inherits");
	try {
		const parent = await createSession(scenario, "fork parent");
		for (let index = 0; index < 12; index++)
			await turn(scenario.client, parent, `Turn ${index}: ${TURN_TEXT}`);
		await scenario.client.session.command({ sessionID: parent, name: "ctx-wrapup", text: "2" });
		await waitFor(() => stateCounts(scenario.host, parent).compartments, (n) => n >= 1, "first wrapup");
		for (let index = 12; index < 24; index++)
			await turn(scenario.client, parent, `Turn ${index}: ${TURN_TEXT}`);
		const before = stateCounts(scenario.host, parent).compartments;
		await scenario.client.session.command({ sessionID: parent, name: "ctx-wrapup", text: "2" });
		await waitFor(() => stateCounts(scenario.host, parent).compartments, (n) => n > before, "second wrapup");
		await settleCompartments(scenario, parent);
		const droppedTag = await toolTurnAndDrop(scenario, parent);
		await settleCompartments(scenario, parent);

		// The parent's steady state, served under the window.
		scenario.setEnforced(true);
		scenario.oversized.length = 0;
		const parentStart = scenario.mock.requests().length;
		const parentMarker = "parent turn before the fork";
		await turn(scenario.client, parent, parentMarker);
		const parentServed = servedFor(scenario, parentMarker, parentStart);
		expect(parentServed).toHaveLength(1);
		const parentSize = requestTokens(parentServed[0]!.body);
		expect(parentSize).toBeLessThan(WINDOW);
		expect(scenario.oversized).toEqual([]);
		const parentState = stateCounts(scenario.host, parent);
		const parentStatuses = tagStatuses(scenario.host, parent);
		expect(parentStatuses.dropped ?? 0).toBeGreaterThan(0);

		const fork = await scenario.client.session.fork({ sessionID: parent });
		const link = readRows<{ fork_session_id: string | null; fork_boundary: string | null }>(
			hostDbPath(scenario.host),
			"SELECT fork_session_id, fork_boundary FROM session_v2 WHERE id = ?",
			fork.id,
		)[0];
		expect(link?.fork_session_id).toBe(parent);
		// Forking sends nothing, so the fork has no Magic Context state yet.
		expect(stateCounts(scenario.host, fork.id)).toEqual({ compartments: 0, tags: 0 });
		expect(forbiddenOpenFiles(scenario.host, "fork")).toEqual([]);

		const forkStart = scenario.mock.requests().length;
		const forkMarker = "first message in the fork";
		await turn(scenario.client, fork.id, forkMarker);
		const forkServed = servedFor(scenario, forkMarker, forkStart);
		const sizes = forkServed.map((request) => requestTokens(request.body));
		const forkState = stateCounts(scenario.host, fork.id);
		const forkStatuses = tagStatuses(scenario.host, fork.id);
		const parentHead = historyHead(parentServed[0]!.body);
		const forkHead = forkServed[0] ? historyHead(forkServed[0].body) : "";
		const summary = {
			parentSize,
			parentState,
			parentStatuses,
			forkBoundary: link?.fork_boundary,
			forkServedSizes: sizes,
			oversized: scenario.oversized,
			forkState,
			forkStatuses,
			parentHead: parentHead.slice(0, 300),
			forkHead: forkHead.slice(0, 300),
			parentTitles: compartmentTitles(parentServed[0]!.body),
			forkTitles: forkServed[0] ? compartmentTitles(forkServed[0].body) : [],
		};
		console.log(`[fork-inheritance] ${JSON.stringify(summary)}`);
		capture("fork-summary.json", summary);
		capture("fork-parent-request.json", parentServed[0]!.body);
		if (forkServed[0]) capture("fork-first-request.json", forkServed[0].body);

		expect(scenario.oversized).toEqual([]);
		expect(forkServed).toHaveLength(1);
		expect(sizes[0]).toBeLessThan(WINDOW);
		// The history head comes from the inherited compartments: the same
		// compartment titles the parent renders.
		expect(forkState.compartments).toBe(parentState.compartments);
		expect(forkHead).toContain("History 1-");
		const parentTitles = compartmentTitles(parentServed[0]!.body);
		expect(parentTitles.length).toBe(parentState.compartments);
		expect(compartmentTitles(forkServed[0]!.body)).toEqual(parentTitles);
		// The parent's drop decision is carried over: the dropped tool output
		// is not served in the fork either.
		expect(JSON.stringify(forkServed[0]!.body)).not.toContain(TOOL_TEXT.slice(0, 200));
		const forkDropped = readRows<{ status: string }>(
			contextDbPath(scenario.host),
			"SELECT status FROM tags WHERE session_id = ? AND tag_number = ?",
			fork.id,
			droppedTag,
		)[0];
		expect(forkDropped?.status).toBe("dropped");
		expect(forbiddenOpenFiles(scenario.host, "fork-after")).toEqual([]);
	} catch (error) {
		dumpOnFailure(scenario);
		throw error;
	} finally {
		await scenario.host.stop();
	}
}, 900_000);

test("a session with no Magic Context state and an over-window history never reaches the provider unmanaged", async () => {
	// The history is written by a host without Magic Context, so the plugin
	// meets a long session it has no state for, as it would a fork whose
	// parent left nothing to inherit.
	const plain = await startHost("fresh-over-window-build", false);
	let scenario: Scenario | undefined;
	let sessionId = "";
	const fixture = { root: plain.host.root, env: plain.host.env, cwd: plain.host.cwd };
	try {
		sessionId = await createSession(plain, "fresh over-window");
		for (let index = 0; index < 24; index++)
			await turn(plain.client, sessionId, `Turn ${index}: ${TURN_TEXT}`);
		expect(plain.oversized.length).toBeGreaterThan(0);
	} finally {
		await plain.host.stopHost();
	}
	const logPath = join(fixture.root, "fresh-over-window.log");
	fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		existingMock: { mock: plain.mock, baseURL: plain.host.mockBaseURL },
		modelContextLimit: WINDOW,
		modelOutputLimit: 1_024,
		compactionAuto: false,
		magicContextConfig: MAGIC_CONTEXT_CONFIG,
		historianModel: HISTORIAN_MODEL,
	});
	scenario = { ...plain, host, client: clientFor(host), logPath };
	try {
		await waitForPluginActive(scenario.client, host.cwd);
		expect(stateCounts(host, sessionId)).toEqual({ compartments: 0, tags: 0 });
		expect(forbiddenOpenFiles(host, "fresh")).toEqual([]);
		plain.setEnforced(true);
		plain.oversized.length = 0;
		const start = scenario.mock.requests().length;
		const marker = "first turn Magic Context sees in this long session";
		await turn(scenario.client, sessionId, marker).catch((error: unknown) => {
			console.log(`[fork-inheritance] fresh turn ended with ${String(error)}`);
		});
		await Bun.sleep(1_000);
		const served = servedFor(scenario, marker, start);
		const sizes = served.map((request) => requestTokens(request.body));
		const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
		const summary = {
			servedSizes: sizes,
			oversized: plain.oversized,
			overWindowLines: log
				.split("\n")
				.filter((line) => /over-window first pass|MC-H06|EMERGENCY|historian did not complete|lkg_/.test(line))
				.slice(0, 20),
		};
		console.log(`[fork-inheritance] fresh ${JSON.stringify(summary)}`);
		capture("fresh-summary.json", summary);
		// Either a managed request under the window or no request at all.
		expect(plain.oversized).toEqual([]);
		for (const size of sizes) expect(size).toBeLessThan(WINDOW);
		expect(log).toContain("over-window first pass");
		// Each later attempt runs the historian further. None of them may go out
		// over the window, including the passes after the first one in this
		// process, and once enough history is summarized the session is served.
		const attempts: Array<{ attempt: number; served: number[] }> = [];
		for (let attempt = 0; attempt < 15; attempt++) {
			const retryStart = scenario.mock.requests().length;
			const retryMarker = `retry ${attempt} after the over-window refusal`;
			await turn(scenario.client, sessionId, retryMarker).catch(() => undefined);
			await Bun.sleep(500);
			const retried = servedFor(scenario, retryMarker, retryStart).map((request) =>
				requestTokens(request.body),
			);
			attempts.push({ attempt, served: retried });
			if (retried.length > 0) break;
		}
		console.log(`[fork-inheritance] fresh retries ${JSON.stringify(attempts)} oversized=${JSON.stringify(plain.oversized)}`);
		capture("fresh-retries.json", { attempts, oversized: plain.oversized });
		expect(plain.oversized).toEqual([]);
		const first = attempts.find((entry) => entry.served.length > 0);
		expect(first).toBeDefined();
		for (const size of first!.served) expect(size).toBeLessThan(WINDOW);
	} catch (error) {
		dumpOnFailure(scenario);
		throw error;
	} finally {
		await host.stop();
	}
}, 900_000);

test("an ordinary small first pass is served and carries no over-window handling", async () => {
	const scenario = await startHost("small-first-pass");
	try {
		const sessionId = await createSession(scenario, "small first pass");
		scenario.setEnforced(true);
		const start = scenario.mock.requests().length;
		const marker = "a short first message";
		await turn(scenario.client, sessionId, marker);
		const served = servedFor(scenario, marker, start);
		expect(served).toHaveLength(1);
		expect(scenario.oversized).toEqual([]);
		// Volatile identifiers are replaced so two builds can be compared.
		const normalized = JSON.stringify(served[0]!.body, null, 2)
			.replaceAll(sessionId, "<session>")
			.replace(/msg_[0-9A-Za-z_]+/g, "<msg>")
			.replace(/prt_[0-9A-Za-z_]+/g, "<prt>")
			.replace(/\d{4}-\d{2}-\d{2}[T ][0-9:.]+Z?/g, "<time>")
			.replaceAll(scenario.host.root, "<root>");
		capture("small-first-request.json", normalized);
		const log = existsSync(scenario.logPath) ? readFileSync(scenario.logPath, "utf8") : "";
		expect(log).not.toContain("over-window first pass");
		expect(forbiddenOpenFiles(scenario.host, "small")).toEqual([]);
	} catch (error) {
		dumpOnFailure(scenario);
		throw error;
	} finally {
		await scenario.host.stop();
	}
}, 300_000);
