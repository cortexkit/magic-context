import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedRequest, MockResponse } from "../src/mock-provider/server";
import { PiTestHarness } from "../src/pi-harness";
import { resolvePiHostInvocation } from "../src/pi-runner/spawn";
import { forEachHost } from "../src/scenario-hosts";
import { createE2ETempDir } from "../src/temp-dir";

// Issue 948, on real Pi and Oh My Pi hosts. Gemini's stream leaves an empty
// text block after a function call, so a reply that says something before
// calling a tool is stored as [text, toolCall, text("")]. Magic Context never
// tags that blank block. Its text identity check used to count it anyway, so
// on the next request the reply looked changed, got a new tag number, and the
// rewritten prefix broke the provider's prompt cache on every tool turn. The
// mock provider here streams that same shape over the Anthropic wire. Pi keeps
// the empty block; Oh My Pi removes it before the reply reaches its context
// handlers, so on Oh My Pi this scenario is a control that must also only
// append.

const BASE = join(realpathSync(tmpdir()), "magic-context", "issue-948");
const MARKER = "ISSUE948";
const FILES = 4;

type Body = CapturedRequest["body"];
type Message = { role: string; content: unknown };

const bodyText = (value: unknown): string => JSON.stringify(value ?? null);

function messagesOf(body: Body): Message[] {
	return Array.isArray(body.messages) ? (body.messages as Message[]) : [];
}

function toolNames(body: Body): string[] {
	return Array.isArray(body.tools)
		? (body.tools as Array<{ name?: string }>).map((tool) => String(tool.name))
		: [];
}

/** The request's own spelling of a tool (Oh My Pi may send `_read`). */
function wireTool(body: Body, name: string): string {
	return (
		toolNames(body).find((tool) => tool === name || tool === `_${name}`) ?? name
	);
}

/** A request of the scenario's session; Magic Context's own child runners have no ctx_search. */
function isScenarioRequest(body: Body): boolean {
	return (
		bodyText(body.messages).includes(MARKER) &&
		toolNames(body).some((name) => /^_?ctx_search$/.test(name))
	);
}

/** How many tool results the conversation already holds. */
function toolResults(body: Body): number {
	return messagesOf(body)
		.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
		.filter((part) => (part as { type?: string }).type === "tool_result").length;
}

/**
 * Messages with Anthropic's moving cache breakpoint removed. The breakpoint
 * sits on the newest message, and Oh My Pi writes that message's text as a
 * one-block array (to carry the breakpoint) and every older one as a plain
 * string, so a single text block is written as its string here.
 */
function stableMessages(body: Body): string {
	const messages = messagesOf(body).map((message) => {
		const content = message.content;
		if (
			Array.isArray(content) &&
			content.length === 1 &&
			(content[0] as { type?: string }).type === "text"
		)
			return { ...message, content: (content[0] as { text: string }).text };
		return message;
	});
	return JSON.stringify(messages, (key, value) =>
		key === "cache_control" ? undefined : value,
	);
}

/** Characters the two requests' messages share from the start. */
function sharedPrefix(earlier: string, later: string): number {
	let at = 0;
	while (at < earlier.length && earlier[at] === later[at]) at++;
	return at;
}

/** Tag numbers on the assistant replies' text, in order. */
function replyPrefixes(body: Body): number[] {
	return messagesOf(body)
		.filter((message) => message.role === "assistant")
		.map((message) => /§(\d+)§ Reading file-/.exec(bodyText(message.content)))
		.filter((match) => match !== null)
		.map((match) => Number(match[1]));
}

function usage(): MockResponse["usage"] {
	return {
		input_tokens: 2_000,
		output_tokens: 20,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
	};
}

/**
 * An extension loaded before Magic Context that records the parts of each
 * assistant message the host hands over: on every context event (where the
 * identity check runs) and on each finished reply (`message_end`). A part is
 * written as its type, or `blank text` for text with nothing but whitespace.
 */
function writeShapeProbe(dir: string, out: string): string {
	const path = join(dir, "issue-948-shape-probe.mjs");
	writeFileSync(
		path,
		`
import { appendFileSync } from "node:fs";
const shape = (message) => message.content.map((part) =>
	part.type === "text" && String(part.text ?? "").trim() === "" ? "blank text" : String(part.type));
export default function (pi) {
	pi.on("context", (event) => {
		const shapes = (event.messages ?? [])
			.filter((message) => message.role === "assistant" && Array.isArray(message.content))
			.map(shape);
		appendFileSync(${JSON.stringify(out)}, JSON.stringify({ event: "context", shapes }) + "\\n");
		return undefined;
	});
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
		appendFileSync(${JSON.stringify(out)}, JSON.stringify({ event: "message_end", shapes: [shape(message)] }) + "\\n");
	});
}
`,
	);
	return path;
}

forEachHost(import.meta.url, null, (host) => {
	if (host !== "pi" && host !== "omp")
		throw new Error(`issue 948 runs on Pi hosts only, not ${host}`);

	it(`${host}: a reply with visible text and a trailing empty text block keeps its tag, so every tool turn only appends`, async () => {
		mkdirSync(BASE, { recursive: true });
		const previousTmp = process.env.TMPDIR;
		process.env.TMPDIR = BASE;
		let h: PiTestHarness | undefined;
		try {
			const fixture = createE2ETempDir(`${host}-blank-text-`);
			const shapesFile = join(fixture, "context-shapes.jsonl");
			const version = JSON.parse(
				readFileSync(resolvePiHostInvocation(host).packageJson, "utf8"),
			).version as string;
			h = await PiTestHarness.create({
				host,
				extensionsBeforeMagicContext: [writeShapeProbe(fixture, shapesFile)],
				magicContextConfig: {
					dreamer: { disable: true },
					compressor: { enabled: false },
				},
			});
			const harness = h;
			for (const path of [
				harness.env.baseDir,
				harness.env.configDir,
				harness.env.dataDir,
				harness.env.cacheDir,
				harness.env.agentDir,
			])
				expect(path.startsWith(`${BASE}/`)).toBe(true);
			for (let file = 1; file <= FILES; file++)
				writeFileSync(
					join(harness.workdir, `file-${file}.txt`),
					`file-${file} line\n`.repeat(400),
				);

			// Each step: visible text, the read, then the empty block Gemini
			// streams after a function call. The last step answers.
			harness.mock.addMatcher((body) => {
				if (!isScenarioRequest(body)) return null;
				const done = toolResults(body);
				if (done >= FILES)
					return { text: "All files read.", usage: usage() };
				const file = done + 1;
				return {
					content: [
						{ type: "text", text: `Reading file-${file} next.` },
						{
							type: "tool_use",
							id: `toolu_${MARKER}_${file}`,
							name: wireTool(body, "read"),
							input: { path: `file-${file}.txt` },
						},
						{ type: "text", text: "" },
					],
					stop_reason: "tool_use",
					usage: usage(),
				};
			});

			const sessionId = await harness.createSession();
			await harness.sendPrompt(sessionId, `${MARKER} read every file in order`);
			await harness.waitForMockQuiescence({ label: `${MARKER} settled` });

			const opened = execFileSync(
				"lsof",
				["-Fn", "-p", String(harness.hostPid)],
				{ encoding: "utf8" },
			);
			writeFileSync(join(fixture, "lsof.txt"), opened);
			const stores = opened
				.split("\n")
				.filter(
					(line) => line.startsWith("n/") && /\.db(?:-wal|-shm)?$/.test(line),
				)
				.map((line) => line.slice(1));
			expect(stores.length).toBeGreaterThan(0);
			expect(stores.every((path) => path.startsWith(`${BASE}/`))).toBe(true);

			const requests = harness.mock
				.requests()
				.map((request) => request.body)
				.filter(isScenarioRequest);
			// What the host handed Magic Context: each finished reply, and the
			// assistant messages of the session's last context pass.
			const probed = readFileSync(shapesFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { event: string; shapes: string[][] });
			const finished = probed
				.filter((entry) => entry.event === "message_end")
				.flatMap((entry) => entry.shapes)
				.filter((shape) => shape.includes("toolCall"));
			const shapes = probed
				.filter(
					(entry) => entry.event === "context" && entry.shapes.length === FILES,
				)
				.at(-1)?.shapes;
			const textRows = (
				harness
					.contextDb()
					.prepare(
						"SELECT message_id AS messageId FROM tags WHERE session_id = ? AND type = 'message'",
					)
					.all(sessionId) as Array<{ messageId: string }>
			).map((row) => row.messageId);
			const steps = requests.slice(1).map((later, index) => {
				const before = stableMessages(requests[index] as Body);
				const after = stableMessages(later);
				const shared = sharedPrefix(before, after);
				return {
					appends: after.startsWith(before.slice(0, -1)),
					// The share of this request's message bytes the previous request
					// already sent: what a prompt cache can serve.
					reusedPercent: Math.round((shared / after.length) * 1000) / 10,
					firstDifference:
						shared >= before.length - 1
							? null
							: JSON.stringify(before.slice(Math.max(0, shared - 40), shared + 40)),
				};
			});
			const versioned = textRows.filter((id) => id.includes(":mc-text-v1:"));
			console.log(
				`ISSUE948 ${JSON.stringify({
					host,
					version,
					sessionId,
					requests: requests.length,
					steps,
					replyPrefixes: requests.map(replyPrefixes),
					versionedTextRows: versioned.length,
					finishedReplyShapes: finished,
					contextShapes: shapes,
					stores,
					fixture,
				})}`,
			);

			expect(requests).toHaveLength(FILES + 1);
			// Pi hands Magic Context the shape under test: text, the call, then
			// the blank. Oh My Pi removes the empty block before the reply reaches
			// its context handlers on this (Anthropic) wire, so its lane is a
			// control: the same requests must still only append. The identity
			// check itself is covered host-independently by the Pi plugin's unit
			// tests.
			const received =
				host === "omp" ? ["text", "toolCall"] : ["text", "toolCall", "blank text"];
			expect(shapes).toEqual(Array.from({ length: FILES }, () => received));
			for (const step of steps) expect(step).toMatchObject({ appends: true });
			expect(versioned).toEqual([]);
			// Each reply keeps the tag number it was first sent with.
			const final = replyPrefixes(requests.at(-1) as Body);
			expect(final).toHaveLength(FILES);
			for (const body of requests)
				expect(replyPrefixes(body)).toEqual(
					final.slice(0, replyPrefixes(body).length),
				);
		} finally {
			await h?.dispose();
			if (previousTmp === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previousTmp;
		}
	}, 300_000);
});
