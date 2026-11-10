import { expect, test } from "bun:test";
import { openTestDb } from "../../src/test-db";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	isolation,
	readPluginLog,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

/**
 * Small local models sometimes copy Magic Context's `§N§` tag notation into
 * their own replies (issue 671: `§169§ §169§ …` from a self-hosted Qwen model).
 * OpenCode 1 (`experimental.text.complete`) and Pi (`message_end`) strip copied
 * notation before the host stores the reply. OpenCode 2 has no hook between a
 * finished text part and its store write, so the host stores the copies; the
 * adapter strips them from assistant text when it builds each request instead,
 * so later requests never hand the copies back to the model.
 *
 * Drives a real OpenCode 2 host whose mock provider replies with copied tags,
 * then checks what the host stored (unchanged: the host owns its store), what
 * the next request carried (stripped), and that later passes, which defer
 * (nothing near the execute threshold), replay those bytes unchanged.
 */

const PROMPTS = ["turn one question", "turn two question", "turn three question", "turn four question", "turn five question"];
const REPLIES = ["§12§ §12§ Done", "see §40827§ here", "plain reply three", "plain reply four", "plain reply five"];

type Item = { role?: string; content?: Array<{ type?: string; text?: string }> };

const assistantTexts = (input: Item[]) =>
	input
		.filter((item) => item.role === "assistant")
		.flatMap((item) => (item.content ?? []).map((part) => part.text ?? ""));

test("OpenCode 2 requests carry assistant replies without copied §N§ tag notation", async () => {
	const fixture = isolation();
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		magicContextConfig: { historian: { disable: true }, dreamer: { disable: true } },
	});
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "copied tag notation",
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		// One request per turn: the request that carries a turn's prompt as its last user item.
		const turnRequests: Item[][] = [];
		for (const [index, prompt] of PROMPTS.entries()) {
			const before = host.mock.requests().length;
			host.mock.setDefault({ text: REPLIES[index], usage: { input_tokens: 100, output_tokens: 10 } });
			await client.session.prompt({ sessionID: session.id, text: prompt });
			await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
			const sent = host.mock
				.requests()
				.slice(before)
				.map((request) => request.body.input as Item[] | undefined)
				.filter((input): input is Item[] => Array.isArray(input))
				.filter((input) => JSON.stringify(input.filter((item) => item.role === "user").at(-1)).includes(prompt));
			expect(sent).toHaveLength(1);
			turnRequests.push(sent[0]!);
		}

		const store = openTestDb(join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!), {
			readonly: true,
		});
		const stored = (
			store
				.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq")
				.all(session.id) as Array<{ data: string }>
		).map((row) =>
			(JSON.parse(row.data).content as Array<{ type: string; text?: string }>)
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join(""),
		);
		store.close();
		const open = spawnSync("lsof", ["-p", String(host.pid), "-Fn"], { encoding: "utf8" });
		const databases = open.stdout
			.split("\n")
			.filter((line) => line.startsWith("n") && /\.db(-wal|-shm)?$/.test(line))
			.map((line) => line.slice(1));
		console.log(`stored assistant text: ${JSON.stringify(stored)}`);
		turnRequests.forEach((input, index) =>
			console.log(`request ${index + 1} assistant text: ${JSON.stringify(assistantTexts(input))}`),
		);
		console.log(`host ${host.pid} open databases: ${JSON.stringify([...new Set(databases)])}`);

		expect(databases.length).toBeGreaterThan(0);
		for (const database of databases) expect(database.startsWith(fixture.root)).toBe(true);
		// The host owns its store, and it keeps the reply exactly as the model sent it.
		expect(stored).toEqual(REPLIES);
		// The request after each copied reply carries it stripped, under a fresh tag.
		expect(assistantTexts(turnRequests[1]!)).toEqual([expect.stringMatching(/^§\d+§ Done$/)]);
		expect(assistantTexts(turnRequests[2]!)[1]).toMatch(/^§\d+§ see {2}here$/);
		for (const input of turnRequests) expect(JSON.stringify(input)).not.toMatch(/§12§ §12§|§40827§/);
		// From the first request that carried a stripped reply on, each pass repeats
		// everything the previous request sent, byte for byte.
		for (let index = 2; index < turnRequests.length; index += 1) {
			const previous = turnRequests[index - 1]!;
			expect(JSON.stringify(turnRequests[index]!.slice(0, previous.length))).toBe(JSON.stringify(previous));
		}
		// Those later passes are defer passes: the ones allowed to change nothing
		// already sent. Only the session's first pass (its first m[0] render) is not.
		// The plugin buffers log writes for up to half a second, so the last
		// turns' lines may not be on disk when the last turn returns. Wait for
		// every turn after the first to log its pass before counting.
		const readDeferPasses = () =>
			readPluginLog(host.env)
				.split("\n")
				.filter(
					(line) =>
						line.includes(session.id) && line.includes("pending ops WILL NOT APPLY — reason=scheduler_defer"),
				);
		const logDeadline = Date.now() + 5_000;
		let deferPasses = readDeferPasses();
		while (deferPasses.length < PROMPTS.length - 1 && Date.now() < logDeadline) {
			await Bun.sleep(100);
			deferPasses = readDeferPasses();
		}
		console.log(`defer passes: ${deferPasses.length}`);
		expect(deferPasses.length).toBeGreaterThanOrEqual(3);
	} catch (error) {
		console.error(host.stderr().slice(-4000));
		throw error;
	} finally {
		await host.stop();
	}
}, 180_000);

test("OpenCode 2 recovers a stored whole copied tag followed by failed turns without editing its store", async () => {
	const fixture = isolation();
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		magicContextConfig: { historian: { disable: true }, dreamer: { disable: true } },
	});
	try {
		const client = OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
		const session = await client.session.create({ title: "strict copied tag recovery", location: { directory: host.cwd }, model: { providerID: "openai", id: "mock-model" } });
		await waitForPluginActive(client, host.cwd);
		const violations: string[] = [];
		host.mock.addMatcher((body) => {
			const input = body.input as Item[] | undefined;
			if (!Array.isArray(input)) return null;
			for (const item of input) {
				if (item.role !== "assistant") continue;
				for (const part of item.content ?? []) {
					if (part.type === "output_text" && !part.text?.trim()) {
						violations.push(JSON.stringify(part));
						return { error: { status: 400, type: "invalid_request_error", message: "missing input.content.text" } };
					}
				}
			}
			return null;
		});
		const requests: Item[][] = [];
		for (let turn = 0; turn < 5; turn++) {
			const prompt = `strict recovery ${turn}`;
			host.mock.setDefault(turn === 1 || turn === 2
				? { error: { status: 400, type: "invalid_request_error", message: "record a failed turn" } }
				: { text: turn === 0 ? "§58§" : "recovered", usage: { input_tokens: 100, output_tokens: 10 } });
			const before = host.mock.requests().length;
			await client.session.prompt({ sessionID: session.id, text: prompt });
			await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
			const request = host.mock.requests().slice(before).find((request) => JSON.stringify(request.body.input).includes(prompt));
			expect(request).toBeDefined();
			requests.push(request!.body.input as Item[]);
		}
		expect(violations).toEqual([]);
		for (const input of requests.slice(1)) expect(assistantTexts(input)).toContain("§58§");
		for (let turn = 2; turn < requests.length; turn++) {
			const oldTag = requests[turn - 1]!.filter((item) => item.role === "assistant")[0];
			expect(JSON.stringify(requests[turn]!.filter((item) => item.role === "assistant")[0])).toBe(JSON.stringify(oldTag));
		}
		const store = openTestDb(join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!), { readonly: true });
		const rows = store.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq").all(session.id) as Array<{ data: string }>;
		store.close();
		expect(rows.some((row) => row.data.includes("§58§"))).toBe(true);
		expect(rows.filter((row) => row.data.includes("record a failed turn")).length).toBeGreaterThanOrEqual(2);
		expect(rows.at(-1)!.data).toContain("recovered");
		const open = spawnSync("lsof", ["-p", String(host.pid), "-Fn"], { encoding: "utf8" });
		expect(open.status).toBe(0);
		const databases = open.stdout.split("\n").filter((line) => line.startsWith("n") && /\.db(-wal|-shm)?$/.test(line)).map((line) => line.slice(1));
		expect(databases.length).toBeGreaterThan(0);
		for (const database of databases) expect(database.startsWith(fixture.root)).toBe(true);
		console.log(`strict recovery host ${host.pid} isolated databases: ${JSON.stringify(databases)}`);
	} finally {
		await host.stop();
	}
}, 180_000);
