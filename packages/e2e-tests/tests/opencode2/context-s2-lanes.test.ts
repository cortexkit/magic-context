import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { queuePendingOp } from "../../../plugin/src/features/magic-context/storage";
import {
	applyEditMarkerToInput,
	EDIT_REGION_HINT_LEN,
} from "../../../plugin/src/hooks/magic-context/edit-marker";
import { buildEditSupersessionReclaim } from "../../../plugin/src/hooks/magic-context/supersession-reclaim";
import type { TagTarget } from "../../../plugin/src/hooks/magic-context/tag-messages";
import { adaptPayload, HEAD_IDS } from "../../../plugin/src/v2/hooks/payload";
import type { SessionContext } from "../../../plugin/src/v2/hooks/types";
import {
	gaDatabasePath,
	V2StoreReader,
} from "../../../plugin/src/v2/store-reader";
import { spawnOpencode2, waitForPluginActive, waitForPluginLog } from '../../src/opencode2-runner/spawn';

const sha = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clientFor = (host: Awaited<ReturnType<typeof spawnOpencode2>>) =>
	OpenCode.make({
		baseUrl: host.url,
		headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
	});

function observer(
	poison = false,
	tools = false,
	largeTool = false,
	fixedMessages?: unknown[],
) {
	const root = mkdtempSync(join(tmpdir(), "mc-s2-observer-"));
	const plugin = join(root, "observer");
	mkdirSync(plugin);
	const trace = join(root, "trace.jsonl");
	writeFileSync(trace, "");
	writeFileSync(
		join(plugin, "server.js"),
		`import { appendFileSync } from 'node:fs';
export default { id: 's2-observer', async setup(context) {
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify({kind:'surface',sessionID:'',messages:[],eventMethods:Object.keys(context.event)})+'\\n');
    if (${tools}) await context.tool.transform(editor => {
        editor.remove('edit');
        editor.add({ name: 'edit', description: 'Fixture edit', options: {codemode:false},
            input: {type:'object', properties:{path:{type:'string'},filePath:{type:'string'},oldString:{type:'string'}},additionalProperties:false},
            async execute(input) { return { content: 'fixture edit completed' }; }
        });
    });
    if (${largeTool}) {
        await context.tool.transform(editor => {
            editor.remove('read');
            editor.add({id:'read',name:'read',description:'Read fixture',options:{codemode:false},input:{type:'object',properties:{path:{type:'string'}},required:['path']},
                async execute() { return {content:Array.from({length:1500},(_,i)=>'word'+i).join(' ')}; }
            });
        });

    }
    for (const kind of ['context', 'title', 'compaction']) await context.session.hook(kind, draft => {
        if (kind === 'context' && ${Boolean(fixedMessages)}) draft.messages.splice(0, draft.messages.length, ...${JSON.stringify(fixedMessages ?? [])});
        appendFileSync(${JSON.stringify(trace)}, JSON.stringify({kind, sessionID:draft.sessionID, messages:draft.messages})+'\\n');
        if (${poison} && kind === 'context') Object.freeze(draft.messages);
    });
}};`,
	);
	return {
		plugin,
		frames: () =>
			readFileSync(trace, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
	};
}

test("I3 context_hook_once_per_round_trip; I5 m1_sentinel_id_recognized; I6 soft_plus_byte_identity_v2", async () => {
	const capture = observer();
	const host = await spawnOpencode2({ probePlugin: capture.plugin });
	try {
		writeFileSync(join(host.cwd, "fixture.txt"), "tool result fixture\n");
		const client = clientFor(host);
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		let steps = 0;
		host.mock.addMatcher((body) => {
			if (body.model !== "mock-model")
				return {
					text: "Fixture title",
					usage: { input_tokens: 100, output_tokens: 10 },
				};
			steps++;
			return steps <= 2
				? {
						openaiOutput: [
							{
								type: "function_call",
								id: `fc_${steps}`,
								call_id: `call_${steps}`,
								name: "read",
								arguments: JSON.stringify({
									path: join(host.cwd, "fixture.txt"),
								}),
							},
						],
						usage: { input_tokens: 100 + steps, output_tokens: 10 },
					}
				: { text: "finished", usage: { input_tokens: 103, output_tokens: 10 } };
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "Read fixture twice",
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20000) },
		);
		const frames = capture.frames().filter((frame) => frame.kind === "context");
		expect(steps).toBe(3);
		expect(frames).toHaveLength(3);
		const contributions = frames.map((frame) =>
			frame.messages.filter((message: { id?: string }) =>
				HEAD_IDS.includes(message.id as (typeof HEAD_IDS)[number]),
			),
		);
		for (const contribution of contributions)
			expect(contribution.map((message: { id: string }) => message.id)).toEqual(
				[...HEAD_IDS],
			);
		expect(new Set(contributions.map(sha)).size).toBe(1);
		expect(frames[1].messages.length).toBeGreaterThan(
			frames[0].messages.length,
		);
		expect(frames[2].messages.length).toBeGreaterThan(
			frames[1].messages.length,
		);
		const wires = host.mock
			.requests()
			.filter((request) => request.body.model === "mock-model");
		for (const wire of wires) {
			expect(JSON.stringify(wire.body)).toContain("<session-history>");
			expect(JSON.stringify(wire.body)).toContain("<session-history-since>");
		}
		for (const wire of wires.slice(1)) {
			const outputs = (
				wire.body.input as Array<{ type: string; output?: string }>
			).filter((item) => item.type === "function_call_output");
			expect(outputs.length).toBeGreaterThan(0);
			for (const output of outputs) {
				expect(output.output).toMatch(/^§\d+§ /);
				expect(output.output).toContain("tool result fixture");
			}
		}
		const titles = capture.frames().filter((frame) => frame.kind === "title");
		expect(titles.length).toBeGreaterThan(0);
		expect(JSON.stringify(titles)).not.toContain(HEAD_IDS[0]);
	} catch (error) {
		console.error(
			host.stdout(),
			host.stderr(),
			JSON.stringify(capture.frames()),
		);
		throw error;
	} finally {
		await host.stop();
	}
}, 60000);

test("I4 context_hook_never_fires_for_title_or_compaction_agents", async () => {
	const capture = observer();
	const host = await spawnOpencode2({ probePlugin: capture.plugin });
	try {
		const client = clientFor(host);
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		host.mock.setDefault({
			text: "A completed conversation with sufficient summary material.",
			usage: { input_tokens: 1000, output_tokens: 100 },
		});
		for (let i = 0; i < 3; i++) {
			await client.session.prompt({
				sessionID: session.id,
				text: `Explain topic ${i}`,
			});
			await client.session.wait(
				{ sessionID: session.id },
				{ signal: AbortSignal.timeout(20000) },
			);
		}
		const before = capture
			.frames()
			.filter((frame) => frame.kind === "context").length;
		await client.session.compact({ sessionID: session.id });
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20000) },
		);
		const frames = capture.frames();
		expect(frames.filter((frame) => frame.kind === "context")).toHaveLength(
			before,
		);
		expect(frames.some((frame) => frame.kind === "title")).toBe(true);
		expect(frames.some((frame) => frame.kind === "compaction")).toBe(true);
		for (const frame of frames.filter((frame) => frame.kind !== "context")) {
			expect(JSON.stringify(frame.messages)).not.toContain(HEAD_IDS[0]);
			expect(JSON.stringify(frame.messages)).not.toContain(
				"<session-history-since>",
			);
		}
	} catch (error) {
		console.error(host.stderr(), JSON.stringify(capture.frames()));
		throw error;
	} finally {
		await host.stop();
	}
}, 60000);

test("I17 high-pressure v2 refuses or folds before another model request", async () => {
	const host = await spawnOpencode2({
		modelContextLimit: 16_000,
		modelOutputLimit: 1024,
	});
	try {
		const client = clientFor(host);
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		host.mock.addMatcher((body) => ({
			text: "large completed response",
			usage: {
				input_tokens: body.model === "mock-model" ? 15500 : 100,
				output_tokens: 10,
			},
		}));
		await client.session.prompt({ sessionID: session.id, text: "First turn" });
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20000) },
		);
		const before = host.mock.requests().length;
		await client.session.prompt({
			sessionID: session.id,
			text: "Refuse this turn",
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20000) },
		);
		if (host.mock.requests().length > before) {
			// The host can compact the session after recording usage but before
			// the next request. Its completed fold makes the older reading stale.
			const reader = new V2StoreReader(gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env));
			try {
				expect(reader.latestCompaction(session.id)?.data.status).toBe("completed");
			} finally { reader.close(); }
		} else {
			const reader = new V2StoreReader(gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env));
			try {
				expect(reader.idleRows(session.id).at(-1)?.data.outcome).toBe("interrupted");
			} finally { reader.close(); }
		}
		expect(host.mock.requests().length).toBeLessThanOrEqual(before + 1);
	} catch (error) {
		console.error(host.stdout());
		throw error;
	} finally {
		await host.stop();
	}
}, 60000);

test("I9b hook_never_throws on deterministic storage failure; interrupt returns normally", async () => {
	const host = await spawnOpencode2();
	try {
		const client = clientFor(host);
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		host.mock.setDefault({
			text: "healthy",
			usage: { input_tokens: 100, output_tokens: 10 },
		});
		await client.session.prompt({ sessionID: session.id, text: "First turn" });
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20000) },
		);
		const db = openTestDb(
			join(host.env.XDG_DATA_HOME!, "cortexkit/magic-context/context.db"),
		);
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec("ALTER TABLE session_meta RENAME TO broken_session_meta");
		db.close();
		const before = host.mock.requests().length;
		await client.session.prompt({
			sessionID: session.id,
			text: "Storage is unavailable",
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20000) },
		);
		expect(host.mock.requests()).toHaveLength(before);
		const reader = new V2StoreReader(
			gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env),
		);
		try {
			expect(reader.idleRows(session.id).at(-1)?.data.outcome).toBe(
				"interrupted",
			);
		} finally {
			reader.close();
		}
		expect(host.stderr()).not.toContain("V2ContextRefusal");
	} finally {
		await host.stop();
	}
}, 60000);

test("I9b hook_never_throws on a poisoned shared draft", async () => {
	const capture = observer(true);
	const host = await spawnOpencode2({ probePlugin: capture.plugin });
	try {
		// Location plugins are first activated by session.create. Put the poisoner
		// first so MC, not the observer, has to survive the frozen shared array.
		const path = join(host.cwd, "opencode.json");
		const config = JSON.parse(readFileSync(path, "utf8"));
		config.plugins.reverse();
		writeFileSync(path, JSON.stringify(config));
		const client = clientFor(host);
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		host.mock.setDefault({
			text: "poison survived",
			usage: { input_tokens: 100, output_tokens: 10 },
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "Poisoned draft turn",
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20000) },
		);
		const frames = capture.frames().filter((frame) => frame.kind === "context");
		expect(frames).toHaveLength(1);
		expect(JSON.stringify(frames)).not.toContain(HEAD_IDS[0]);
		expect(
			host.mock
				.requests()
				.filter((request) => request.body.model === "mock-model"),
		).toHaveLength(1);
		expect(host.stderr()).not.toContain("Failed to drain Session");
		expect(await waitForPluginLog(host.env, "v2 context unavailable")).toContain(
			"v2 context unavailable",
		);
	} finally {
		await host.stop();
	}
}, 60000);

test("I16 dropped_input_guard_v2 refuses both argument surfaces with a real Error", async () => {
	const capture = observer(false, true);
	const host = await spawnOpencode2({ probePlugin: capture.plugin });
	try {
		const client = clientFor(host);
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		let step = 0;
		host.mock.addMatcher((body) => {
			if (body.model !== "mock-model")
				return {
					text: "Guard fixture",
					usage: { input_tokens: 100, output_tokens: 10 },
				};
			if (step++ > 0)
				return {
					text: "Recovered",
					usage: { input_tokens: 100, output_tokens: 10 },
				};
			return {
				openaiOutput: ["path", "filePath"].map((key, i) => ({
					type: "function_call",
					id: `fc_guard_${i}`,
					call_id: `call_guard_${i}`,
					name: "edit",
					arguments: JSON.stringify({ [key]: "[dropped §42§]" }),
				})),
				usage: { input_tokens: 100, output_tokens: 10 },
			};
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "Exercise both copied argument surfaces",
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20000) },
		);
		const wires = host.mock
			.requests()
			.filter((request) => request.body.model === "mock-model");
		expect(wires).toHaveLength(2);
		const second = JSON.stringify(wires[1].body.input);
		expect(
			second.match(
				/Not executed: your arguments/g,
			),
		).toHaveLength(2);
		expect(second).not.toContain("[object Object]");
		expect(second).not.toContain("fixture edit completed");
	} finally {
		await host.stop();
	}
}, 60000);

test("I15 channel2_via_synthetic uses a recorded admission id at the tool batch boundary", async () => {
	const capture = observer(false, false, true);
	const host = await spawnOpencode2({
		probePlugin: capture.plugin,
		modelContextLimit: 16_000,
		modelOutputLimit: 1024,
	});
	try {
		const client = clientFor(host);
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		let step = 0;
		let seeded = false;
		host.mock.addMatcher((body) => {
			if (body.model !== "mock-model")
				return {
					text: "Read fixture title",
					usage: { input_tokens: 100, output_tokens: 10 },
				};
			const nudged = JSON.stringify(body.input).includes(
				"Your next step: call ctx_reduce",
			);
			if (nudged || ++step > (seeded ? 3 : 24))
				return {
					text: "Finished after nudge",
					usage: { input_tokens: 11000, output_tokens: 10 },
				};
			return {
				openaiOutput: [
					{
						type: "function_call",
						id: `fc_large_${step}`,
						call_id: `call_large_${step}`,
						name: "read",
						arguments: '{"path":"fixture"}',
					},
				],
				usage: { input_tokens: 11000, output_tokens: 10 },
			};
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "Read fixture for Channel 2",
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(45000) },
		);
		const mc = openTestDb(
			join(host.env.XDG_DATA_HOME!, "cortexkit/magic-context/context.db"),
		);
        mc.exec("PRAGMA busy_timeout = 5000");
		// A real queued drop gives the TS pipeline its single permitted cache
		// mutation, refreshing the now-unprotected completed-output baseline.
		queuePendingOp(mc as never, session.id, 2, "drop");
		mc.close();
		seeded = true;
		step = 0;
		await client.session.prompt({
			sessionID: session.id,
			text: "Continue after the queued reduction",
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(45000) },
		);
		const reader = new V2StoreReader(
			gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env),
		);
		try {
			const rows = reader.page(session.id, { limit: 1000 }).rows;
			const synthetic = rows.filter((row) => row.type === "synthetic");
			expect(synthetic).toHaveLength(1);
			expect(synthetic[0].id).toMatch(/^msg_/);
			expect(HEAD_IDS).not.toContain(
				synthetic[0].id as (typeof HEAD_IDS)[number],
			);
			expect(synthetic[0].data.text).toContain("Your next step: call ctx_reduce");
			const laterFrame = capture
				.frames()
				.find(
					(frame) =>
						frame.kind === "context" &&
						frame.messages.some(
							(message: { id?: string }) => message.id === synthetic[0].id,
						),
				);
			expect(laterFrame).toBeDefined();
			const served = laterFrame.messages.find(
				(message: { id?: string }) => message.id === synthetic[0].id,
			);
			expect(served.role).toBe("user");
			expect(served.content[0].text.replace(/^§\d+§ /, "")).toBe(
				synthetic[0].data.text,
			);
			const titleWires = host.mock
				.requests()
				.filter((request) => request.body.model !== "mock-model");
			expect(titleWires.length).toBeGreaterThan(0);
			expect(JSON.stringify(titleWires)).not.toContain("Your next step: call ctx_reduce");
		} finally {
			reader.close();
		}
	} catch (error) {
		console.error(
			host.stdout(),
			host
				.stderr()
				.split("\n")
				.filter((line) => line.includes("magic-context")),
		);
		throw error;
	} finally {
		await host.stop();
	}
}, 90000);

test("I6 real-host contributions match the v1 e2e fixture golden across three defer passes", async () => {
	const capture = observer(false, false, false, [
		{
			id: "msg_probe_a",
			role: "user",
			content: [{ type: "text", text: "probe text" }],
		},
		{
			id: "msg_probe_b",
			role: "assistant",
			content: [
				{
					type: "tool-call",
					id: "call_probe",
					name: "read",
					input: { path: "probe.txt" },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					id: "call_probe",
					name: "read",
					result: { type: "text", value: "probe result" },
				},
			],
		},
		{
			id: "msg_probe_c",
			role: "user",
			content: [{ type: "text", text: "continue probe" }],
		},
	]);
	const host = await spawnOpencode2({ probePlugin: capture.plugin });
	try {
		const path = join(host.cwd, "opencode.json");
		const config = JSON.parse(readFileSync(path, "utf8"));
		config.plugins.reverse();
		writeFileSync(path, JSON.stringify(config));
		const client = clientFor(host);
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		host.mock.setDefault({
			text: "done",
			usage: { input_tokens: 100, output_tokens: 10 },
		});
		for (let pass = 0; pass < 3; pass++) {
			await client.session.prompt({
				sessionID: session.id,
				text: `Fixture pass ${pass}`,
			});
			await client.session.wait(
				{ sessionID: session.id },
				{ signal: AbortSignal.timeout(20000) },
			);
		}
		const hashes = host.mock
			.requests()
			.filter((request) => request.body.model === "mock-model")
			.map((request) => {
				const items = request.body.input as Array<{
					type?: string;
					output?: string;
					content?: Array<{ type: string; text: string }>;
				}>;
				return sha(
					items.flatMap((item) =>
						item.type === "function_call_output"
							? [item.output]
							: (item.content ?? [])
									.filter((part) => part.type === "input_text")
									.map((part) => part.text),
					),
				);
			});
		expect(hashes).toEqual(
			Array(3).fill(
				"32fbdb1bffdc5eee04e6108bd801262bbd5c7a323191811b54fd717739b89e0a",
			),
		);
	} finally {
		await host.stop();
	}
}, 60000);

// GA promise/session.d.ts:105-106 omits remove/compact from Context.session;
// promise/plugin.d.ts:24-50 supplies no raw client. Only the isolated runner's
// authenticated HTTP client can probe these routes; product wiring needs a host carrier.
test("I14 host-capability probe: remove and compact exist on the runner-owned client", async () => {
	const capture = observer();
	const host = await spawnOpencode2({ probePlugin: capture.plugin });
	try {
		const client = clientFor(host);
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		expect(
			capture.frames().find((frame) => frame.kind === "surface")?.eventMethods,
		).toEqual(["subscribe"]);
		const inbox = await client.session.compact({ sessionID: session.id });
		expect(inbox.type).toBe("compaction");
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20000) },
		);
		await client.session.remove({ sessionID: session.id });
		await expect(
			client.session.get({ sessionID: session.id }),
		).rejects.toThrow();
	} finally {
		await host.stop();
	}
}, 60000);

test("I16a tool_argument_surfaces_v2 preserve edit regions and share supersession keys", async () => {
	const capture = observer(false, true);
	const host = await spawnOpencode2({ probePlugin: capture.plugin });
	try {
		const client = clientFor(host);
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		let step = 0;
		const diff = "region ".repeat(30);
		host.mock.addMatcher((body) => {
			if (body.model !== "mock-model" || step++ > 0)
				return {
					text: "Done",
					usage: { input_tokens: 100, output_tokens: 10 },
				};
			return {
				openaiOutput: ["path", "filePath"].map((key, i) => ({
					type: "function_call",
					id: `fc_edit_${i}`,
					call_id: `call_edit_${i}`,
					name: "edit",
					arguments: JSON.stringify({ [key]: "same.ts", oldString: diff }),
				})),
				usage: { input_tokens: 100, output_tokens: 10 },
			};
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "Edit the same region through both host argument surfaces",
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20000) },
		);
		const frame = capture
			.frames()
			.filter((entry) => entry.kind === "context")
			.at(-1);
		const mapped = adaptPayload({
			...frame,
			model: { providerID: "openai", id: "mock-model" },
			agent: "build",
			tools: {},
			system: [],
			options: {},
		} as SessionContext);
		const parts = mapped.messages
			.flatMap((message) => message.parts)
			.filter((part) => (part as { type: string }).type === "tool") as Array<{
			callID: string;
			state: { input: Record<string, unknown> };
		}>;
		expect(parts).toHaveLength(2);
		const db = openTestDb(
			join(host.env.XDG_DATA_HOME!, "cortexkit/magic-context/context.db"),
		);
		try {
			const tags = db
				.query(
					"SELECT tag_number, message_id FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number",
				)
				.all(session.id) as Array<{ tag_number: number; message_id: string }>;
			expect(tags).toHaveLength(2);
			const targets = new Map<number, TagTarget>(
				tags.map((tag) => [
					tag.tag_number,
					{
						setContent: () => true,
						canDrop: () => true,
						readInput: () =>
							parts.find((part) => part.callID === tag.message_id)!.state.input,
					},
				]),
			);
			const selected = buildEditSupersessionReclaim({ watermark: Number.MAX_SAFE_INTEGER, db: db as never,
				sessionId: session.id,
				targets,
				recentMessageIds: new Set(), });
			expect([...selected.editMarkerTagIds]).toEqual([tags[0].tag_number]);
			for (const [index, part] of parts.entries()) {
				applyEditMarkerToInput(part.state.input);
				expect(part.state.input[index === 0 ? "path" : "filePath"]).toBe(
					"same.ts",
				);
				expect(part.state.input.oldString).toBe(
					`${diff.slice(0, EDIT_REGION_HINT_LEN)}...[truncated]`,
				);
			}
		} finally {
			db.close();
		}
	} finally {
		await host.stop();
	}
}, 60000);

test("I17 compaction-off mode preserves additive memory heads without tags or refusals", async () => {
	const capture = observer();
	const host = await spawnOpencode2({ probePlugin: capture.plugin });
	try {
		const configDir = join(host.env.XDG_CONFIG_HOME!, "cortexkit");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "magic-context.jsonc"),
			JSON.stringify({ compaction: { enabled: false }, auto_update: false }),
		);
		const client = clientFor(host);
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		host.mock.setDefault({
			text: "native response",
			usage: { input_tokens: 15500, output_tokens: 10 },
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "Native first turn",
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20000) },
		);
		const before = host.mock.requests().length;
		await client.session.prompt({
			sessionID: session.id,
			text: "Native second turn",
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20000) },
		);
		expect(host.mock.requests().length).toBeGreaterThan(before);
		expect(JSON.stringify(capture.frames())).toContain(HEAD_IDS[0]);
        expect(JSON.stringify(capture.frames())).not.toMatch(/§\d+§/);
		expect(JSON.stringify(host.mock.requests())).toContain(
			"<session-history>",
		);
		expect(host.stderr()).not.toContain("V2ContextRefusal");
	} finally {
		await host.stop();
	}
}, 60000);
