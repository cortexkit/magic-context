import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	CapturedRequest,
	MockResponse,
} from "../src/mock-provider/server";
import { PiTestHarness, type PiTestHarnessOptions } from "../src/pi-harness";
import { resolvePiHostInvocation } from "../src/pi-runner/spawn";
import { forEachHost } from "../src/scenario-hosts";
import { createE2ETempDir } from "../src/temp-dir";

// Issue 904, on real Pi and Oh My Pi hosts. Tag prefixes, the ctx_reduce
// guidance and the reduce reminders exist only while the session can call
// ctx_reduce, read from the request's tool list on every request; queued
// drops and automatic reductions run either way. Oh My Pi sessions another
// agent spawned (ctx.agent.kind "sub") are subagents: no history head.

const BASE = join(realpathSync(tmpdir()), "magic-context", "issue-904");
/** The Oh My Pi release the task-child cases run on unless the caller pins another. */
const DEFAULT_OMP_PACKAGE_JSON = resolve(
	import.meta.dir,
	"../../pi-plugin/node_modules/omp-coding-agent-18190/package.json",
);
const WINDOW = 200_000;
/**
 * Large files the pressure script reads. Oh My Pi's read tool returns less of
 * each file than Pi's, so it reads more of them to give the session the same
 * reclaimable tail, which the in-turn reminder needs to be at least 60,000
 * tokens.
 */
const BIG_FILES = 8;
const bigFilesFor = (host: "pi" | "omp") => (host === "omp" ? 18 : BIG_FILES);

type Body = CapturedRequest["body"];
type Message = { role: string; content: unknown };

function bodyText(value: unknown): string {
	return JSON.stringify(value ?? null);
}

function messagesOf(body: Body): Message[] {
	return Array.isArray(body.messages) ? (body.messages as Message[]) : [];
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const block = part as { type?: string; text?: unknown; content?: unknown };
			if (typeof block.text === "string") return block.text;
			if (block.type === "tool_result") return contentText(block.content);
			return "";
		})
		.join("\n");
}

function lastMessage(body: Body): Message | undefined {
	return messagesOf(body).at(-1);
}

function lastIsToolResult(body: Body): boolean {
	const last = lastMessage(body);
	return (
		last?.role === "user" &&
		Array.isArray(last.content) &&
		last.content.some(
			(part) => (part as { type?: string }).type === "tool_result",
		)
	);
}

function toolNames(body: Body): string[] {
	return Array.isArray(body.tools)
		? (body.tools as Array<{ name?: string }>).map((tool) => String(tool.name))
		: [];
}

/** The request's own spelling of a tool (Oh My Pi may send `_read`). */
function wireTool(body: Body, name: string): string {
	return (
		toolNames(body).find((tool) => tool === name || tool === `_${name}`) ??
		name
	);
}

function sendsCtxReduce(body: Body): boolean {
	return toolNames(body).some((tool) => /^_?ctx_reduce$/.test(tool));
}

/** Tag numbers the messages carry as prefixes. */
function prefixNumbers(body: Body): number[] {
	return [...bodyText(body.messages).matchAll(/§(\d+)§ /g)].map((match) =>
		Number(match[1]),
	);
}

/** Messages with Anthropic's moving cache breakpoints removed. */
function stableMessages(body: Body): string {
	return JSON.stringify(body.messages ?? [], (key, value) =>
		key === "cache_control" ? undefined : value,
	);
}

/** True when `later` only appends to `earlier`'s messages. */
function appendsTo(earlier: Body, later: Body): boolean {
	const before = stableMessages(earlier);
	const after = stableMessages(later);
	return after.startsWith(before.slice(0, -1));
}

function usage(percent: number) {
	return {
		input_tokens: Math.round((WINDOW * percent) / 100),
		output_tokens: 20,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
	};
}

function toolUse(
	id: string,
	name: string,
	input: Record<string, unknown>,
	percent: number,
): MockResponse {
	return {
		content: [{ type: "tool_use", id, name, input }],
		stop_reason: "tool_use",
		usage: usage(percent),
	};
}

function reply(text: string, percent: number): MockResponse {
	return { text, usage: usage(percent) };
}

/**
 * Commands that take ctx_reduce out of the session's active tools and put it
 * back, the way another extension can; and a record of every session the
 * extension instance starts in, with the agent Oh My Pi names for it.
 */
function writeProbeExtension(dir: string, events: string): string {
	const path = join(dir, "issue-904-probe.mjs");
	writeFileSync(
		path,
		`
import { appendFileSync } from "node:fs";
export default function (pi) {
	const record = (event, ctx) => {
		let agent = null;
		try { agent = ctx.agent ?? null; } catch {}
		appendFileSync(${JSON.stringify(events)}, JSON.stringify({
			event,
			sessionId: ctx.sessionManager.getSessionId(),
			agent,
			active: pi.getActiveTools(),
		}) + "\\n");
	};
	pi.on("session_start", (_event, ctx) => record("session_start", ctx));
	pi.on("before_agent_start", (_event, ctx) => record("before_agent_start", ctx));
	pi.registerCommand("e2e904-off", {
		description: "Remove ctx_reduce from the active tools",
		async handler() {
			await pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "ctx_reduce"));
		},
	});
	pi.registerCommand("e2e904-on", {
		description: "Restore ctx_reduce to the active tools",
		async handler() {
			const active = pi.getActiveTools();
			if (!active.includes("ctx_reduce")) await pi.setActiveTools([...active, "ctx_reduce"]);
		},
	});
}
`,
	);
	return path;
}

interface ProbeEvent {
	event: string;
	sessionId: string;
	agent: { kind?: string; name?: string; depth?: number } | null;
	active: string[];
}

function readEvents(path: string): ProbeEvent[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ProbeEvent);
}

interface Run {
	h: PiTestHarness;
	fixture: string;
	events: string;
	version: string;
	/** Every database file the host process has open lies under the run's root. */
	assertIsolation(label: string): string[];
	isSubagent(sessionId: string): boolean | undefined;
	countDropped(sessionId: string): number;
	tagStatus(sessionId: string, tagNumber: number): string | undefined;
}

async function withRun(
	host: "pi" | "omp",
	name: string,
	options: Partial<PiTestHarnessOptions>,
	body: (run: Run) => Promise<void>,
): Promise<void> {
	mkdirSync(BASE, { recursive: true });
	const previousTmp = process.env.TMPDIR;
	const previousOmp = process.env.MC_E2E_OMP_PACKAGE_JSON;
	process.env.TMPDIR = BASE;
	if (host === "omp")
		process.env.MC_E2E_OMP_PACKAGE_JSON =
			previousOmp ?? DEFAULT_OMP_PACKAGE_JSON;
	const fixture = createE2ETempDir(`${host}-${name}-`);
	const events = join(fixture, "events.jsonl");
	const extension = writeProbeExtension(fixture, events);
	let h: PiTestHarness | undefined;
	try {
		const version = JSON.parse(
			readFileSync(resolvePiHostInvocation(host).packageJson, "utf8"),
		).version as string;
		h = await PiTestHarness.create({
			host,
			extensionsAfterMagicContext: [extension],
			magicContextConfig: {
				execute_threshold_percentage: 80,
				dreamer: { disable: true },
				compressor: { enabled: false },
			},
			...options,
		});
		const harness = h;
		const run: Run = {
			h: harness,
			fixture,
			events,
			version,
			assertIsolation(label) {
				for (const path of [
					harness.env.baseDir,
					harness.env.configDir,
					harness.env.dataDir,
					harness.env.cacheDir,
					harness.env.agentDir,
				])
					expect(path.startsWith(`${BASE}/`)).toBe(true);
				const opened = execFileSync(
					"lsof",
					["-Fn", "-p", String(harness.hostPid)],
					{ encoding: "utf8" },
				);
				writeFileSync(join(fixture, `lsof-${label}.txt`), opened);
				const stores = opened
					.split("\n")
					.filter(
						(line) =>
							line.startsWith("n/") && /\.db(?:-wal|-shm)?$/.test(line),
					)
					.map((line) => line.slice(1));
				expect(stores.length).toBeGreaterThan(0);
				expect(stores.every((path) => path.startsWith(`${BASE}/`))).toBe(
					true,
				);
				return stores;
			},
			isSubagent(sessionId) {
				const row = harness
					.contextDb()
					.prepare("SELECT is_subagent FROM session_meta WHERE session_id = ?")
					.get(sessionId) as { is_subagent: number } | null;
				return row ? row.is_subagent === 1 : undefined;
			},
			countDropped(sessionId) {
				return harness.countDroppedTags(sessionId);
			},
			tagStatus(sessionId, tagNumber) {
				const row = harness
					.contextDb()
					.prepare(
						"SELECT status FROM tags WHERE session_id = ? AND tag_number = ?",
					)
					.get(sessionId, tagNumber) as { status: string } | null;
				return row?.status;
			},
		};
		await body(run);
	} finally {
		await h?.dispose();
		if (previousTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmp;
		if (previousOmp === undefined) delete process.env.MC_E2E_OMP_PACKAGE_JSON;
		else process.env.MC_E2E_OMP_PACKAGE_JSON = previousOmp;
	}
}

/** Varied prose, about four characters per token. */
function prose(seed: string, characters: number): string {
	const words = [
		"boundary", "historian", "compartment", "schedule", "pressure",
		"window", "publish", "transform", "session", "marker", "budget",
		"eligible", "protected", "ordinal", "snapshot", "replay", "threshold",
	];
	const lines: string[] = [];
	let length = 0;
	for (let line = 0; length < characters; line++) {
		const text = `${seed} ${line}: ${words
			.map((word, index) => words[(index + line) % words.length] ?? word)
			.join(" ")}`;
		lines.push(text);
		length += text.length + 1;
	}
	return lines.join("\n");
}

/** The newest user message that is a prompt rather than a tool result. */
function promptText(body: Body): string {
	const prompt = [...messagesOf(body)]
		.reverse()
		.find(
			(message) =>
				message.role === "user" &&
				!(
					Array.isArray(message.content) &&
					message.content.some(
						(part) => (part as { type?: string }).type === "tool_result",
					)
				),
		);
	return prompt ? contentText(prompt.content) : "";
}

/** A request of the scenario's own session: its prompts name the scenario, and Magic Context's tools are registered there (its own child runners have none). */
function isScenarioRequest(body: Body, marker: string): boolean {
	return (
		bodyText(body.messages).includes(marker) &&
		toolNames(body).some((name) => /^_?ctx_search$/.test(name))
	);
}

function scenarioRequests(h: PiTestHarness, marker: string): Body[] {
	return h.mock
		.requests()
		.map((request) => request.body)
		.filter((body) => isScenarioRequest(body, marker));
}

/**
 * The pressure script: the large reads, then one small read at 70% and one
 * at 90% of the window. The small reads' results are where the in-turn
 * reminder lands when it fires; 90% is in the force band, where the tiered
 * emergency drop removes old tool output on its own.
 */
function scriptPressure(
	h: PiTestHarness,
	marker: string,
	bigFiles: number,
): void {
	h.mock.addMatcher((body) => {
		if (!isScenarioRequest(body, marker)) return null;
		const prompt = promptText(body);
		const done = lastIsToolResult(body);
		const read = wireTool(body, "read");
		// At most six reads per prompt: a real Oh My Pi turn with a dozen
		// parallel reads did not report its end to the harness.
		const part = /read logs part (\d+)/.exec(prompt);
		if (part) {
			const first = (Number(part[1]) - 1) * 6 + 1;
			const last = Math.min(bigFiles, first + 5);
			if (done) return reply(`part ${part[1]} read`, 30);
			return {
				content: Array.from({ length: last - first + 1 }, (_, index) => ({
					type: "tool_use",
					id: `toolu_${marker}_big_${first + index}`,
					name: read,
					input: { path: `big-${first + index}.log` },
				})),
				stop_reason: "tool_use",
				usage: usage(20),
			};
		}
		for (const [step, percent] of [
			["pressure one", 70],
			["pressure two", 90],
		] as const) {
			if (!prompt.includes(step)) continue;
			if (done) return reply(`${step} noted`, percent);
			return toolUse(
				`toolu_${marker}_${step.replace(" ", "_")}`,
				read,
				{ path: "small.log" },
				percent,
			);
		}
		return null;
	});
}

async function runPressure(
	run: Run,
	marker: string,
	bigFiles: number,
): Promise<string> {
	const { h } = run;
	const sessionId = await h.createSession();
	for (let part = 1; (part - 1) * 6 < bigFiles; part++)
		await h.sendPrompt(sessionId, `${marker} read logs part ${part}`);
	await h.sendPrompt(sessionId, `${marker} pressure one`);
	await h.sendPrompt(sessionId, `${marker} pressure two`);
	await h.waitForMockQuiescence({ label: `${marker} settled` });
	return sessionId;
}

function writeLogs(workdir: string, bigFiles = BIG_FILES): void {
	for (let index = 1; index <= bigFiles; index++)
		writeFileSync(
			join(workdir, `big-${index}.log`),
			prose(`big-${index}`, 45_000),
		);
	writeFileSync(join(workdir, "small.log"), prose("small", 400));
}

forEachHost(import.meta.url, null, (host) => {
	if (host !== "pi" && host !== "omp")
		throw new Error(`issue 904 runs on Pi hosts only, not ${host}`);

	it(`${host}: without ctx_reduce from the start, no tags, guidance or reminders at any pressure; automatic drops still land`, async () => {
		await withRun(host, "absent", {}, async (run) => {
			const { h } = run;
			writeLogs(h.workdir, bigFilesFor(host));
			scriptPressure(h, "ABSENT904", bigFilesFor(host));
			scriptPressure(h, "CONTROL904", bigFilesFor(host));

			await h.invokeExtensionCommand("e2e904-off");
			const absent = await runPressure(run, "ABSENT904", bigFilesFor(host));
			run.assertIsolation("absent");
			const absentRequests = scenarioRequests(h, "ABSENT904");
			expect(absentRequests.length).toBeGreaterThanOrEqual(8);
			for (const body of absentRequests) {
				expect(sendsCtxReduce(body)).toBe(false);
				expect(prefixNumbers(body)).toEqual([]);
				expect(bodyText(body.system)).not.toContain("ctx_reduce");
				// Both reminders name ctx_reduce; neither reached the session.
				expect(bodyText(body.messages)).not.toContain("ctx_reduce");
			}
			expect(h.countTags(absent)).toBeGreaterThan(0);
			expect(run.countDropped(absent)).toBeGreaterThan(0);

			// Control: the same script with the tool, in a new session.
			await h.invokeExtensionCommand("e2e904-on");
			await h.newSession();
			const control = await runPressure(run, "CONTROL904", bigFilesFor(host));
			const controlRequests = scenarioRequests(h, "CONTROL904");
			console.log(
				`ISSUE904_ABSENT ${JSON.stringify({ host, version: run.version, absentRequests: absentRequests.length, absentDropped: run.countDropped(absent), controlRequests: controlRequests.length, controlDropped: run.countDropped(control), controlLastBytes: bodyText(controlRequests.at(-1)?.messages).length, controlReminded: controlRequests.filter((body) => bodyText(body.messages).includes("ctx_reduce")).length, fixture: run.fixture })}`,
			);
			expect(controlRequests.every(sendsCtxReduce)).toBe(true);
			expect(
				controlRequests.every((body) => prefixNumbers(body).length > 0),
			).toBe(true);
			expect(bodyText(controlRequests[0]?.system)).toContain("ctx_reduce");
			expect(
				controlRequests.some((body) =>
					bodyText(body.messages).includes("ctx_reduce"),
				),
			).toBe(true);
			expect(run.countDropped(control)).toBeGreaterThan(0);
		});
	}, 300_000);

	it(`${host}: ctx_reduce removed and restored: one rebuild at each change, the queued drop lands, the same tag numbers return`, async () => {
		await withRun(host, "flip", {}, async (run) => {
			const { h } = run;
			writeLogs(h.workdir);
			const marker = "FLIP904";
			let target: number | undefined;
			h.mock.addMatcher((body) => {
				if (!isScenarioRequest(body, marker)) return null;
				const prompt = promptText(body);
				const done = lastIsToolResult(body);
				if (prompt.includes("step one")) {
					// big-1 first, then seven more reads, so big-1 ends up outside
					// the protected window of newest tool output.
					const last = bodyText(lastMessage(body)?.content);
					if (done && last.includes("toolu_flip_more")) return reply("read", 10);
					if (done)
						return {
							content: Array.from({ length: BIG_FILES - 1 }, (_, index) => ({
								type: "tool_use",
								id: `toolu_flip_more_${index + 2}`,
								name: wireTool(body, "read"),
								input: { path: `big-${index + 2}.log` },
							})),
							stop_reason: "tool_use",
							usage: usage(10),
						};
					return toolUse(
						"toolu_flip_read",
						wireTool(body, "read"),
						{ path: "big-1.log" },
						10,
					);
				}
				if (prompt.includes("step two")) {
					if (done) return reply("queued", 10);
					const tagged = bodyText(body.messages).match(
						/§(\d+)§ (?:\[big-1\.log|big-1 0:)/,
					);
					if (!tagged) throw new Error("the read result carries no tag");
					target = Number(tagged[1]);
					return toolUse(
						"toolu_flip_reduce",
						wireTool(body, "ctx_reduce"),
						{ drop: String(target) },
						10,
					);
				}
				return reply("noted", 10);
			});
			const sessionId = await h.createSession();
			const served = () => scenarioRequests(h, marker);
			await h.sendPrompt(sessionId, `${marker} step one`);
			await h.sendPrompt(sessionId, `${marker} step two`);
			const callable = served();
			if (target === undefined) throw new Error("no drop was queued");
			expect(callable.every(sendsCtxReduce)).toBe(true);
			expect(bodyText(callable.at(-1)?.messages)).toContain("big-1 0:");

			await h.invokeExtensionCommand("e2e904-off");
			await h.sendPrompt(sessionId, `${marker} step three`);
			await h.sendPrompt(sessionId, `${marker} step four`);
			const removed = served().slice(callable.length);
			expect(removed).toHaveLength(2);
			for (const body of removed) {
				expect(sendsCtxReduce(body)).toBe(false);
				expect(prefixNumbers(body)).toEqual([]);
				expect(bodyText(body.system)).not.toContain("ctx_reduce");
				// The drop queued while the tool was callable landed.
				expect(bodyText(body.messages)).not.toContain("big-1 0:");
			}
			expect(run.tagStatus(sessionId, target)).toBe("dropped");

			await h.invokeExtensionCommand("e2e904-on");
			await h.sendPrompt(sessionId, `${marker} step five`);
			await h.sendPrompt(sessionId, `${marker} step six`);
			const restored = served().slice(callable.length + removed.length);
			expect(restored).toHaveLength(2);
			for (const body of restored) expect(sendsCtxReduce(body)).toBe(true);
			run.assertIsolation("flip");

			// One rebuild at each change and none between: within each stretch
			// every request only appends to the one before it, and the first
			// request after each change rewrites what was served.
			const all = [...callable, ...removed, ...restored];
			const changes = new Set([callable.length, callable.length + removed.length]);
			const rewrites: number[] = [];
			for (let index = 1; index < all.length; index++) {
				const earlier = all[index - 1];
				const later = all[index];
				if (!earlier || !later) continue;
				if (!appendsTo(earlier, later)) rewrites.push(index);
			}
			expect(rewrites).toEqual([...changes]);
			// The tags that come back carry the numbers they had before.
			const before = new Set(prefixNumbers(callable.at(-1) as Body));
			const after = prefixNumbers(restored[0] as Body);
			expect(after.length).toBeGreaterThan(0);
			expect(after.filter((number) => number <= Math.max(...before))).toEqual(
				[...before].filter((number) => number !== target),
			);
			console.log(
				`ISSUE904_FLIP ${JSON.stringify({ host, version: run.version, requests: all.length, rewrites, target, before: [...before], after })}`,
			);
		});
	}, 300_000);
});

// Oh My Pi task children. A child runs in the parent's process with its own
// extension instance; Oh My Pi names it with ctx.agent.kind "sub". A child the
// parent spawns while in native plan mode gets Oh My Pi's stronger tool
// restriction: no extension tools, so no ctx_reduce, while Magic Context's
// hooks still run for it.
forEachHost(import.meta.url, null, (host) => {
	if (host !== "omp") return;
	for (const [mode, hostArgs] of [
		["an ordinary turn", []],
		["plan mode", ["--plan-yolo", "--plan-yolo-into", "mock/mock-model"]],
	] as const) {
		const planMode = mode === "plan mode";
		it(`omp: a task child spawned in ${mode} is a subagent with no history head${planMode ? ", and gets no tags, guidance or reminders without ctx_reduce" : ", and keeps ctx_reduce with its tags"}`, async () => {
			await withRun(
				"omp",
				planMode ? "task-plan" : "task",
				{ hostArgs: [...hostArgs] },
				async (run) => {
					const { h } = run;
					writeFileSync(
						join(h.workdir, "payload.txt"),
						"PAYLOAD904 child fixture\n",
					);
					const parentMarker = "PARENT904";
					const childMarker = "CHILD904";
					const isChild = (body: Body) => {
						const text = bodyText(body.messages);
						return text.includes(childMarker) && !text.includes(parentMarker);
					};
					h.mock.addMatcher((body) => {
						if (isChild(body)) {
							if (lastIsToolResult(body)) return reply("CHILD904 done", 10);
							return toolUse(
								"toolu_child_read",
								wireTool(body, "read"),
								{ path: "payload.txt" },
								10,
							);
						}
						if (!bodyText(body.messages).includes(parentMarker)) return null;
						if (
							lastIsToolResult(body) ||
							!promptText(body).includes(parentMarker)
						)
							return reply("parent done", 10);
						return toolUse(
							"toolu_parent_task",
							wireTool(body, "task"),
							{
								agent: "task",
								task: `${childMarker}: read payload.txt and report what it says.`,
								solutionSpace: "Report the payload text.",
							},
							10,
						);
					});
					const parent = await h.createSession();
					await h.sendPrompt(parent, `${parentMarker} delegate the read`);
					// The child can still be running after the parent's turn ends.
					const childRequests = await h.waitFor(
						() => {
							const requests = h.mock
								.requests()
								.map((request) => request.body)
								.filter(isChild);
							return requests.some(lastIsToolResult) ? requests : null;
						},
						{ timeoutMs: 120_000, label: "task child finished its read" },
					);
					await h.waitForMockQuiescence({ label: "task child settled" });
					const children = readEvents(run.events).filter(
						(event) => event.agent?.kind === "sub",
					);
					const childId = children[0]?.sessionId;
					if (!childId) throw new Error("no spawned session was recorded");
					const childFirst = childRequests[0] as Body;
					const childActive = children[0]?.active ?? [];
					writeFileSync(
						join(run.fixture, "child-requests.json"),
						JSON.stringify(childRequests, null, 2),
					);
					// What the child was sent, before any assertion, so a failing run
					// still reports it.
					console.log(
						`ISSUE904_TASK ${JSON.stringify({
							mode,
							version: run.version,
							parent,
							childId,
							agent: children[0]?.agent,
							childIsSubagent: run.isSubagent(childId),
							childActive,
							childTools: toolNames(childFirst),
							childRequests: childRequests.map((body) => ({
								prefixes: prefixNumbers(body),
								systemNamesCtxReduce: bodyText(body.system).includes(
									"ctx_reduce",
								),
								messagesNameCtxReduce: bodyText(body.messages).includes(
									"ctx_reduce",
								),
								historyHead: bodyText(body.messages).includes(
									"<session-history",
								),
							})),
							fixture: run.fixture,
						})}`,
					);
					expect(childId).not.toBe(parent);
					expect(run.isSubagent(childId)).toBe(true);
					expect(run.isSubagent(parent)).toBe(false);
					const stores = run.assertIsolation(planMode ? "task-plan" : "task");
					console.log(`ISSUE904_STORES ${JSON.stringify(stores)}`);

					const parentFirst = h.mock
						.requests()
						.map((request) => request.body)
						.find((body) => bodyText(body.messages).includes(parentMarker));
					expect(bodyText(parentFirst?.messages)).toContain(
						"<session-history",
					);
					// A subagent has no history head.
					expect(bodyText(childFirst.messages)).not.toContain(
						"<session-history",
					);
					if (planMode) {
						// The restriction is real: the child cannot call ctx_reduce.
						expect(childActive).not.toContain("ctx_reduce");
						for (const body of childRequests) {
							expect(sendsCtxReduce(body)).toBe(false);
							expect(prefixNumbers(body)).toEqual([]);
							expect(bodyText(body.system)).not.toContain("ctx_reduce");
							expect(bodyText(body.messages)).not.toContain("ctx_reduce");
						}
					} else {
						expect(childActive).toContain("ctx_reduce");
						for (const body of childRequests) {
							expect(sendsCtxReduce(body)).toBe(true);
							expect(prefixNumbers(body).length).toBeGreaterThan(0);
						}
						expect(bodyText(childFirst.system)).toContain("ctx_reduce");
					}
				},
			);
		}, 300_000);
	}
});
