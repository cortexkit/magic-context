import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { buildMockHistorianPayload, findHistorianOrdinalRange } from "../../src/mock-historian";
import {
	isolation,
	spawnOpencode2,
	waitForPluginActive,
	waitForPluginLog,
} from "../../src/opencode2-runner/spawn";

async function eventually<T>(
	read: () => T | undefined,
	what: string,
	timeoutMs = 15_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(50);
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

test("retains rejection-derived input tokens across context pass until a new reply completes", async () => {
	const fixture = isolation();
	const logPath = join(fixture.root, "magic-context-overflow-retention.log");
	fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		modelContextLimit: 100_000,
		modelOutputLimit: 1_024,
		compactionAuto: false,
		magicContextConfig: {
			dreamer: { disable: true },
			memory: { enabled: false },
		},
	});
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "overflow reading retention",
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);

		host.mock.addMatcher((body) => {
			if (!JSON.stringify(body).includes("<new_messages>")) return null;
			const range = findHistorianOrdinalRange({
				messages:
					(body as { input?: unknown; messages?: unknown }).input ??
					(body as { messages?: unknown }).messages,
			});
			return {
				text: buildMockHistorianPayload({
					start: range?.start ?? 1,
					end: range?.end ?? 1,
					title: "Overflow recovery",
					body: "Overflow recovery summary.",
				}),
				usage: { input_tokens: 500, output_tokens: 200 },
			};
		});

		const dataHome = host.env.XDG_DATA_HOME;
		if (!dataHome) throw new Error("isolated store path is unavailable");
		const storageDir = join(dataHome, "cortexkit", "magic-context");
		const readSessionMeta = () => {
			const databasePath = join(storageDir, "context.db");
			if (!existsSync(databasePath)) return undefined;
			const db = openTestDb(databasePath, { readonly: true });
			try {
				const row = db
				.prepare(
					"SELECT last_input_tokens, last_response_time FROM session_meta WHERE session_id = ?",
				)
				.get(session.id) as { last_input_tokens: number; last_response_time: number } | undefined;
			return row && row.last_input_tokens > 0 ? row : undefined;
			} finally {
				db.close();
			}
		};

		// Turn 1: normal accepted response (40,000 tokens)
		host.mock.enqueue({
			text: "turn 1 ok",
			usage: { input_tokens: 40_000, output_tokens: 10 },
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "turn 1 prompt",
		});
		await client.session
			.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) })
			.catch(() => undefined);

		const meta1 = await eventually(readSessionMeta, "turn 1 usage persisted");
		expect(meta1.last_input_tokens).toBe(40_000);

		// Turn 2: provider overflow 400 rejection with 123,456 tokens
		host.mock.enqueue({
			error: {
				status: 400,
				type: "invalid_request_error",
				message: "prompt is too long: 123456 tokens > 100000 maximum",
			},
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "turn 2 overflow prompt",
		});
		await client.session
			.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) })
			.catch(() => undefined);

		const metaOverflow = await eventually(() => {
			const row = readSessionMeta();
			return row?.last_input_tokens === 123_456 ? row : undefined;
		}, "rejection input tokens recorded");
		expect(metaOverflow.last_input_tokens).toBe(123_456);

		// Disarm recovery flag so Turn 3 can reach the provider after the context pass
		const db = openTestDb(join(storageDir, "context.db"));
		db.prepare("UPDATE session_meta SET needs_emergency_recovery = 0 WHERE session_id = ?").run(session.id);
		db.close();

		// Turn 3: follow-up prompt accepted.
		// On the context pass before this prompt reaches the provider,
		// recordUsage must NOT overwrite 123,456 with Turn 1's 40,000.
		host.mock.enqueue({
			text: "turn 3 ok",
			usage: { input_tokens: 60_000, output_tokens: 10 },
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "turn 3 follow-up",
		});
		await client.session
			.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) })
			.catch(() => undefined);

		const metaTurn3 = await eventually(() => {
			const row = readSessionMeta();
			return row?.last_input_tokens === 60_000 ? row : undefined;
		}, "turn 3 new usage persisted");
		expect(metaTurn3.last_input_tokens).toBe(60_000);

		// Confirm log showed the stale reading was skipped on the context pass
		await waitForPluginLog(host.env, "v2 usage: skipped stale reading");
	} finally {
		await host.stop();
	}
}, 120_000);
