import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { MockProvider } from "../../src/mock-provider/server";
import { sessionMetaFieldSelect } from "../../src/session-meta-fields";
import {
	inspectOpenFiles,
	isolation,
	readPluginLog,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

const MODEL = "claude-sonnet-5-5";
const MARKER = "SIGNED-DROP-REBUILD";
const bytes = (value: unknown) =>
	JSON.stringify(value, (key, item) =>
		key === "cache_control" ? undefined : item,
	);
const thinking = (step: number, heavy = false) => ({
	type: "thinking",
	thinking: heavy && step === 1
		? `Reason ${step} ${"weighing the next step carefully ".repeat(400)}`
		: `Reason ${step}`,
	signature: `signed-${step}`,
});
type WireMessage = { role: string; content: Array<{ type: string }> };

async function runSignedReclaimScenario(held: boolean) {
	const fixture = isolation();
	const mock = new MockProvider();
	const provider = await mock.start({
		thinkingScope: (body) =>
			bytes(body.messages).includes(MARKER) ? MARKER : undefined,
	});
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		existingMock: { mock, baseURL: provider.baseURL },
		providerID: "anthropic",
		defaultModelID: MODEL,
		modelContextLimit: 100_000,
		modelOutputLimit: 1024,
		compactionAuto: false,
		magicContextConfig: {
			execute_threshold_tokens: { default: held ? 65_000 : 5000 },
			protected_tokens: 4000,
			dreamer: { disable: true },
			memory: { enabled: false },
		},
	});
	const client = OpenCode.make({
		baseUrl: host.url,
		headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
	});
	const db = openTestDb(
		join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"),
	);
	db.exec("PRAGMA busy_timeout = 10000");
	let step = 0;
	let tag = 0;
	const wire: WireMessage[][] = [];
	try {
		const session = await client.session.create({
			title: "signed drop rebuild",
			location: { directory: host.cwd },
			model: { providerID: "anthropic", id: MODEL },
		});
		await waitForPluginActive(client, host.cwd);
		const databases = inspectOpenFiles(host.pid!, host.root, host.env).filter(
			(path) => /\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(path),
		);
		expect(databases.length).toBeGreaterThan(0);
		expect(databases.every((path) => path.startsWith(host.root + "/"))).toBe(
			true,
		);
		for (const name of ["a", "b", "c"])
			writeFileSync(
				join(host.cwd, `${name}.txt`),
				`SPENT-${name}\n` +
					Array.from(
						{ length: 2000 },
						(_, n) => `${n * 7919}:${n * 3571}!`,
					).join(" "),
			);
		mock.addMatcher((body) => {
			if (
				!bytes(body.messages).includes(MARKER) ||
				!(body.tools as Array<{ name: string }> | undefined)?.some(
					(tool) => tool.name === "shell",
				)
			)
				return null;
			step++;
			wire.push(structuredClone(body.messages as WireMessage[]));
			const usage = {
				input_tokens: 0,
				output_tokens: 20,
				cache_read_input_tokens:
					step >= 4 ? Math.ceil((held ? 0.70 : 0.76) * (100_000 - 1024)) : 100,
				cache_creation_input_tokens: 0,
			};
			const tool = (name: string, input: unknown) => ({
				content: [
					thinking(step, held),
					{ type: "tool_use", id: `call-${step}`, name, input },
				],
				stop_reason: "tool_use" as const,
				usage,
			});
			if (step <= 3)
				return tool("shell", {
					command: `cat ${["a", "b", "c"][step - 1]}.txt`,
					description: "Read spent output",
				});
			if (step === 6) {
				const tags = db
					.query(
						"SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' AND status = 'active' ORDER BY tag_number",
					)
					.all(session.id) as Array<{ tag_number: number }>;
				tag = tags[1]!.tag_number;
				return tool("ctx_reduce", { drop: String(tag) });
			}
			if (step < 9)
				return tool("shell", {
					command: "printf continue",
					description: "Continue the signed tool loop",
				});
			return { text: "Loop done", usage };
		});
		mock.setDefault({
			text: "fixture reply",
			usage: { input_tokens: 100, output_tokens: 10 },
		});
		const prompt = async (text: string) => {
			await client.session.prompt({ sessionID: session.id, text });
			await client.session.wait(
				{ sessionID: session.id },
				{ signal: AbortSignal.timeout(90_000) },
			);
		};
		const pending = () =>
			db
				.query("SELECT tag_id FROM pending_ops WHERE session_id = ?")
				.all(session.id);
		await prompt(`${MARKER} run the tool loop`);
		expect(step).toBe(9);
		expect(mock.requests().some((request) => request.thinkingViolation)).toBe(
			false,
		);
		expect(pending()).toContainEqual({ tag_id: tag });
		const previous = wire.at(-1)!;
		if (held) {
			const hold = readPluginLog(host.env).match(/signed thinking hold: held=true reason=heavy_reasoning heavyStepsBack=(\d+) heavyStepTokens=(\d+) usage=([\d.]+)% cap=([\d.]+)%/);
			expect(hold).not.toBeNull();
			expect(Number(hold![1])).toBeLessThanOrEqual(15);
			expect(Number(hold![2])).toBeGreaterThan(1500);
			expect(Number(hold![3])).toBeLessThan(Number(hold![4]));
			// Heavy reasoning remains inside the 15-step window at 70% usage,
			// below this route's 65% execute threshold plus the ten-point hold cap.
			for (const request of wire.slice(6)) expect(bytes(request)).toContain("SPENT-b");
			expect(previous.flatMap((message) => message.content).filter((part) => part.type === "thinking"))
				.toEqual(Array.from({ length: 8 }, (_, n) => thinking(n + 1, true)));
			await client.session.command({ sessionID: session.id, name: "ctx-flush", text: "" });
			await prompt("End the held turn and apply the explicitly requested rebuild; finish.");
			expect(bytes(wire.at(-1))).not.toContain("SPENT-b");
			expect(pending()).toHaveLength(0);
			return;
		}
		const lastRequest = () =>
			mock
				.requests()
				.filter(
					(request) =>
						bytes(request.body.messages).includes(MARKER) &&
						(request.body.tools as Array<{ name: string }> | undefined)?.some(
							(tool) => tool.name === "shell",
						),
				)
				.at(-1)!.body;
		await prompt("Next real user turn; finish.");
		const rebuilt = wire.at(-1)!;
		const rebuiltBody = lastRequest();
		// The short reasoning never grants a hold. A worthwhile execute reclaim
		// is a permitted bust and removes signatures bound to the dropped output.
		expect(bytes(rebuilt)).not.toContain("SPENT-b");
		expect(
			rebuilt
				.flatMap((message) => message.content)
				.filter((part) => part.type === "thinking"),
		).toEqual([]);
		expect(pending()).toHaveLength(0);
		const frozen = () => db.query(`SELECT ${sessionMetaFieldSelect("merged_reasoning_stripped_ids")} FROM session_meta WHERE session_id = ?`).get(session.id);
		const stripped = frozen();
		expect(JSON.stringify(stripped)).not.toMatch(/null|\[\]/);
		await prompt("Defer with no newly queued reductions; finish.");
		expect(bytes(wire.at(-1)!.slice(0, rebuilt.length))).toBe(bytes(rebuilt));
		expect(bytes(lastRequest().system)).toBe(bytes(rebuiltBody.system));
		expect(bytes(lastRequest().tools)).toBe(bytes(rebuiltBody.tools));
		expect(frozen()).toEqual(stripped);
	} finally {
		db.close();
		await host.stop();
	}
}

for (const held of [false, true])
	test(
		`OC2 ${held ? "heavy reasoning holds queued drops below the hold cap until a permitted bust" : "unheld execute reclaim strips thinking once and replays the rebuilt prefix"}`,
		() => runSignedReclaimScenario(held),
		180_000,
	);
