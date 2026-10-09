/**
 * The provider rejection of edited latest-turn thinking, on a real OpenCode 2
 * host against a mock that enforces Anthropic's latest-turn rule from the
 * responses it emitted.
 *
 * The session carries an accepted-legacy omission (`binding_mismatch:<id>`) for
 * two assistants of its active tool loop. Replaying it omits their signed
 * thinking and the mock rejects the request with the provider's 400. OpenCode 2
 * reports that only through its session event stream, where Magic Context arms
 * recovery bound to the real user message that started the rejected turn.
 * OpenCode 2.0.22 has no same-turn resubmission; its resume path is a new
 * user-role message, which ends the rejected turn, so recovery disarms without
 * restoring anything and the provider accepts the continued session.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { MockProvider } from "../../src/mock-provider/server";
import {
	CLI,
	inspectOpenFiles,
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";
import { cleanupE2ETempDir } from "../../src/temp-dir";

const MARKER = "ISSUE-630-OC2-RECOVERY";
const bytes = (value: unknown) =>
	JSON.stringify(value, (key, item) => (key === "cache_control" ? undefined : item));
const thinking = (n: number) => ({
	type: "thinking",
	thinking: `Reason ${n}`,
	signature: `signed-${n}`,
});
const thinkingBlocks = (messages: unknown[]) =>
	messages
		.filter((message) => (message as { role: string }).role === "assistant")
		.flatMap((message) => {
			const content = (message as { content: unknown }).content;
			return Array.isArray(content) ? content : [];
		})
		.filter((block) => (block as { type?: string }).type === "thinking");

test("OC2 arms thinking recovery for the rejected turn from its event stream and its resume ends that turn without a restore", async () => {
	const isolated = isolation();
	const mock = new MockProvider();
	const provider = await mock.start({
		thinkingScope: (body) =>
			Array.isArray(body.tools) &&
			(body.tools as Array<{ name?: string }>).some((tool) => tool.name === "shell") &&
			bytes(body.messages).includes(MARKER)
				? "oc2-recovery"
				: undefined,
	});
	mock.setDefault({ text: "fixture reply", usage: { input_tokens: 100, output_tokens: 10 } });
	const host = await spawnOpencode2({
		existingIsolation: isolated,
		existingMock: { mock, baseURL: provider.baseURL },
		providerID: "anthropic",
		defaultModelID: "mock-sonnet",
		modelContextLimit: 100_000,
		modelOutputLimit: 1024,
		compactionAuto: false,
		magicContextConfig: {
			protected_tokens: 4000,
			dreamer: { disable: true },
			memory: { enabled: false },
		},
	});
	const client = OpenCode.make({
		baseUrl: host.url,
		headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
	});
	const contextDb = () => {
		const db = new Database(join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
		db.exec("PRAGMA busy_timeout = 10000");
		return db;
	};
	const target = (sessionID: string) => {
		const db = contextDb();
		try {
			return (
				db
					.query(
						"SELECT thinking_binding_recovery_target AS target FROM session_meta WHERE session_id = ?",
					)
					.get(sessionID) as { target: string } | null
			)?.target;
		} finally {
			db.close();
		}
	};
	try {
		const version = JSON.parse(
			readFileSync(join(realpathSync(CLI), "..", "..", "package.json"), "utf8"),
		).version;
		expect(version).toBe("2.0.22");
		const session = await client.session.create({
			title: "issue 630 recovery",
			location: { directory: host.cwd },
			model: { providerID: "anthropic", id: "mock-sonnet" },
		});
		await waitForPluginActive(client, host.cwd);
		const openDatabases = inspectOpenFiles(host.pid!, host.root, host.env).filter((path) =>
			/\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(path),
		);
		console.log(JSON.stringify({ cliVersion: version, hostPid: host.pid, root: host.root, openDatabases }));
		expect(openDatabases.length).toBeGreaterThan(0);
		expect(openDatabases.every((path) => path.startsWith(host.root))).toBe(true);

		let step = 0;
		let seeded: string[] = [];
		mock.addMatcher((body) => {
			if (!bytes(body.messages).includes(MARKER)) return null;
			if (!(body.tools as Array<{ name?: string }> | undefined)?.some((tool) => tool.name === "shell"))
				return null;
			step++;
			const usage = { input_tokens: 100, output_tokens: 10 };
			if (step === 3) {
				// Two completed assistants of this tool loop now carry an accepted
				// legacy omission, as a session from before the active-turn rule would.
				const db = contextDb();
				try {
					seeded = (
						db
							.query(
								"SELECT tool_owner_message_id AS id FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number",
							)
							.all(session.id) as Array<{ id: string }>
					)
						.map((row) => row.id)
						.slice(0, 2);
					db.query(
						"UPDATE session_meta SET merged_reasoning_stripped_ids = ? WHERE session_id = ?",
					).run(JSON.stringify(seeded.map((id) => `binding_mismatch:${id}`)), session.id);
				} finally {
					db.close();
				}
			}
			if (step <= 4)
				return {
					content: [
						thinking(step),
						{
							type: "tool_use",
							id: `call-${step}`,
							name: "shell",
							input: { command: `printf step-${step}`, description: `Step ${step}` },
						},
					],
					stop_reason: "tool_use" as const,
					usage,
				};
			return { text: "Loop done", usage };
		});
		const loop = () =>
			mock.requests().filter((request) => bytes(request.body.messages).includes(MARKER));
		const settle = () =>
			client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) });
		const prompt = `${MARKER} run the loop`;
		await client.session.prompt({ sessionID: session.id, text: prompt });
		await settle();

		// The fourth request replays the omission inside the active tool loop and
		// the provider rejects it; the host does not retry a 400 on its own.
		expect(seeded).toHaveLength(2);
		expect(step).toBe(3);
		expect(loop().map((request) => request.thinkingViolation !== undefined)).toEqual([
			false,
			false,
			false,
			true,
		]);
		const rejected = loop()[3]!.body.messages as unknown[];
		expect(bytes(thinkingBlocks(rejected))).toBe(bytes([thinking(3)]));

		// OpenCode 2 reports the failure only on its event stream; recovery is armed
		// there, bound to the real user message that started the rejected turn.
		const store = new Database(join(host.env.XDG_DATA_HOME!, "opencode", "opencode2.db"), {
			readonly: true,
		});
		let userID: string;
		try {
			userID = (
				store
					.query(
						"SELECT id FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq",
					)
					.all(session.id) as Array<{ id: string }>
			).map((row) => row.id)[0]!;
		} finally {
			store.close();
		}
		expect(target(session.id)).toBe(`latest_thinking_original_armed:${userID}`);

		// OpenCode 2.0.22 has no same-turn resubmission: re-sending the rejected
		// turn's own user message is deduplicated by the inbox and reaches no
		// provider. Should a later host add one, its retry must restore the
		// original thinking, and this assertion is where to extend the test.
		await client.session.prompt({ sessionID: session.id, id: userID, text: prompt });
		await settle();
		expect(loop()).toHaveLength(4);
		expect(target(session.id)).toBe(`latest_thinking_original_armed:${userID}`);

		// The host's resume path is a new user-role message, which ends the
		// rejected turn for the provider too. Recovery disarms without restoring
		// anything, the accepted omission applies to what is now an older turn,
		// and the provider accepts the request.
		await client.session.synthetic({ sessionID: session.id, text: "Continue.", resume: true });
		await settle();
		expect(step).toBe(5);
		expect(loop().filter((request) => request.thinkingViolation)).toHaveLength(1);
		expect(target(session.id) ?? "").toBe("");
		const resumed = loop()[4]!.body.messages as unknown[];
		expect(bytes(resumed)).toContain("Continue.");
		expect(bytes(thinkingBlocks(resumed))).toBe(bytes([thinking(3)]));
		// The new turn's own signed thinking then replays unchanged.
		const last = loop()[5]!.body.messages as unknown[];
		expect(bytes(thinkingBlocks(last))).toBe(bytes([thinking(3), thinking(4)]));
		expect(host.pluginLog()).not.toContain("ANTHROPIC_LATEST_TURN_EDIT_UNSAFE");
		const after = inspectOpenFiles(host.pid!, host.root, host.env).filter((path) =>
			/\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(path),
		);
		expect(after.every((path) => path.startsWith(host.root))).toBe(true);
		console.log(
			JSON.stringify({
				requests: loop().length,
				violations: loop().map((request) => request.thinkingViolation !== undefined),
				armedFor: userID,
				openDatabases: after,
			}),
		);
	} catch (error) {
		console.error(host.stderr().slice(-3000), host.pluginLog().slice(-5000));
		throw error;
	} finally {
		await host.stop();
		cleanupE2ETempDir(isolated.root);
	}
}, 180_000);
